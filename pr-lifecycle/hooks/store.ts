// The lifecycle record, kept in the plugin's store so a restart resumes it.

import type { EngineInterface } from 'claude-code'

import type { LifecycleRecord, LogEntry } from '../types'

type Engine = EngineInterface

export const recordKey = (root: string, branch: string): string => `lifecycle:${root}:${branch}`

export async function loadRecord($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const value = (await $.store.get(recordKey(root, branch))) as LifecycleRecord | undefined | null
  return value !== null && value !== undefined && value.version === 1 ? value : undefined
}

/**
 * Keeps a reset record whole under its own key (R47): `lifecycle:<root>:<branch>:archived:<at>`. `loadRecord` reads only the
 * branch's own key, so an archive is never read as the live record.
 */
export async function archiveRecord($: Engine, rec: LifecycleRecord, at: number): Promise<void> {
  await $.store.set(`${recordKey(rec.root, rec.branch)}:archived:${at}`, { ...rec, phase: 'archived' })
}

export async function saveRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, updatedAt: Math.max(rec.updatedAt, await $.clock.now()) })
}

// Each branch's record is changed one read-modify-write at a time (R1-6): a promise chain per root and branch, held in this process.
const locks = new Map<string, Promise<void>>()

/**
 * Runs `work` once every earlier holder of the branch's record is done, and releases the record whether `work` returns or throws.
 * Not re-entrant: `work` must not lock the same record again (no `updateRecord`, `advance` or `finish` inside it).
 */
export async function lockRecord<T>(root: string, branch: string, work: () => Promise<T>): Promise<T> {
  const key = recordKey(root, branch)
  const held = (locks.get(key) ?? Promise.resolve()).then(work)
  const tail = held.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, tail)
  try {
    return await held
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

/** Reads, changes and writes the record under its lock; undefined when there is none. A change that returns the record it was given writes nothing. */
export async function updateRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord) => LifecycleRecord | Promise<LifecycleRecord>,
): Promise<LifecycleRecord | undefined> {
  return lockRecord(root, branch, async () => {
    const rec = await loadRecord($, root, branch)
    if (rec === undefined) return undefined
    const next = await change(rec)
    if (next !== rec) await saveRecord($, next)
    return next
  })
}

/**
 * As `updateRecord`, for a change that may start the record: `change` sees undefined when there is none, and returns what to write,
 * or undefined to write nothing (a check on the locked read refused it).
 */
export async function upsertRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord | undefined) => LifecycleRecord | undefined | Promise<LifecycleRecord | undefined>,
): Promise<LifecycleRecord | undefined> {
  return lockRecord(root, branch, async () => {
    const next = await change(await loadRecord($, root, branch))
    if (next !== undefined) await saveRecord($, next)
    return next
  })
}

// ----------------------------------------------------------------- owner

/** The session that runs a record's lifecycle (#13), and when it last said so. Kept under its own key, so a beat never rewrites the record. */
export type Owner = { sessionId: string; beatAt: number }

/** How long an owner's last beat holds the record: after this, an interactive session may take it over (Adam, decision D). */
export const OWNER_STALE_MS = 120_000

const ownerKey = (root: string, branch: string): string => `${recordKey(root, branch)}:owner`

export async function ownerOf($: Engine, root: string, branch: string): Promise<Owner | undefined> {
  const value = (await $.store.get(ownerKey(root, branch))) as Owner | undefined | null
  return value !== null && value !== undefined && typeof value.sessionId === 'string' ? value : undefined
}

export async function setOwner($: Engine, root: string, branch: string, owner: Owner): Promise<void> {
  await $.store.set(ownerKey(root, branch), owner)
}

/** Another session beat for the record within `OWNER_STALE_MS` of `now`: it runs the lifecycle, not `me`. */
export const isHeldByOther = (owner: Owner | undefined, me: string, now: number): boolean =>
  owner !== undefined && owner.sessionId !== me && now - owner.beatAt < OWNER_STALE_MS

// ------------------------------------------------------------------- log

/** How many run-log lines a record keeps: the oldest go first. */
export const LOG_CAP = 200

/** Adds a line to the record's run log (`/pr-gate log`). Takes the record's lock: never call it from inside `updateRecord`. */
export async function logEvent($: Engine, root: string, branch: string, kind: LogEntry['kind'], text: string): Promise<void> {
  const at = await $.clock.now()
  await updateRecord($, root, branch, rec => ({ ...rec, log: [...(rec.log ?? []), { at, kind, text: text.slice(0, 300) }].slice(-LOG_CAP) }))
}

/** The branch's newest archived record (R47), for a log asked for after the lifecycle closed. */
export async function latestArchive($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const prefix = `${recordKey(root, branch)}:archived:`
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix))
  const newest = keys.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))).at(-1)
  return newest === undefined ? undefined : ((await $.store.get(newest)) as LifecycleRecord | undefined)
}
