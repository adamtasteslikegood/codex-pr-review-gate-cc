// The lifecycle record, kept in the plugin's store so a restart resumes it.
//
// The functions this module exports are the seam (#29 Part B): every read and write of a record, its owner and its archives goes
// through them, and a change of a live record goes through `transact`. Today's backend is the plugin's own store, with a lock per
// branch held in this process; a shared store per PR plugs in behind the same functions. (They stay function declarations: the
// engine follows $ only into those.)

import type { EngineInterface } from 'claude-code'

import type { LifecycleRecord, LogEntry } from '../types'

type Engine = EngineInterface

/** The steps a `transact` may take on one branch's record, all inside its atomic boundary. */
export interface RecordTx {
  load(): Promise<LifecycleRecord | undefined>
  save(rec: LifecycleRecord): Promise<void>
  /** Keeps `rec` whole as an archive taken at `at` (R47); the branch's own key is left to `save`. */
  archive(rec: LifecycleRecord, at: number): Promise<void>
}

export const recordKey = (root: string, branch: string): string => `lifecycle:${root}:${branch}`

/** The lock per branch (R1-6): a promise chain per root and branch, held in this process. */
const locks = new Map<string, Promise<void>>()

async function lockRecord<T>(root: string, branch: string, work: () => Promise<T>): Promise<T> {
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

export async function loadRecord($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const value = (await $.store.get(recordKey(root, branch))) as LifecycleRecord | undefined | null
  return value !== null && value !== undefined && value.version === 1 ? value : undefined
}

/**
 * Every live lifecycle record under the repository's `root` (spec §5.13.4), whichever branch is checked out: the keys
 * `lifecycle:<root>:<branch>`, never an owner or an archive key (a branch name holds no ':'), and never an archived seed.
 */
export async function liveRecords($: Engine, root: string): Promise<LifecycleRecord[]> {
  const prefix = recordKey(root, '')
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes(':'))
  const found: LifecycleRecord[] = []
  for (const key of keys) {
    const value = (await $.store.get(key)) as LifecycleRecord | undefined | null
    if (value !== null && value !== undefined && value.version === 1 && value.phase !== 'archived' && recordKey(value.root, value.branch) === key) found.push(value)
  }
  return found
}

async function writeRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, updatedAt: Math.max(rec.updatedAt, await $.clock.now()) })
}

/**
 * Keeps a reset record whole under its own key (R47): `lifecycle:<root>:<branch>:archived:<at>`. `loadRecord` reads only the
 * branch's own key, so an archive is never read as the live record.
 */
async function writeArchive($: Engine, rec: LifecycleRecord, at: number): Promise<void> {
  await $.store.set(`${recordKey(rec.root, rec.branch)}:archived:${at}`, { ...rec, phase: 'archived' })
}

/** Writes the record in a transaction of its own: a seed or a test. A change that reads the record first goes through `transact`. */
export async function saveRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await transact($, rec.root, rec.branch, tx => tx.save(rec))
}

/**
 * Runs `work` as one atomic change of the branch's record (R1-6): no other transaction on it interleaves, and the record is released
 * whether `work` returns or throws. Not re-entrant: `work` must not open another transaction on the same record (no `updateRecord`,
 * `advance` or `finish` inside it).
 */
export async function transact<T>($: Engine, root: string, branch: string, work: (tx: RecordTx) => Promise<T>): Promise<T> {
  return lockRecord(root, branch, () =>
    work({
      load: () => loadRecord($, root, branch),
      save: rec => writeRecord($, rec),
      archive: (rec, at) => writeArchive($, rec, at),
    }),
  )
}

/** Reads, changes and writes the record atomically; undefined when there is none. A change that returns the record it was given writes nothing. */
export async function updateRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord) => LifecycleRecord | Promise<LifecycleRecord>,
): Promise<LifecycleRecord | undefined> {
  return transact($, root, branch, async tx => {
    const rec = await tx.load()
    if (rec === undefined) return undefined
    const next = await change(rec)
    if (next !== rec) await tx.save(next)
    return next
  })
}

/**
 * As `updateRecord`, for a change that may start the record: `change` sees undefined when there is none, and returns what to write,
 * or undefined to write nothing (a check on the read inside the transaction refused it).
 */
export async function upsertRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord | undefined) => LifecycleRecord | undefined | Promise<LifecycleRecord | undefined>,
): Promise<LifecycleRecord | undefined> {
  return transact($, root, branch, async tx => {
    const next = await change(await tx.load())
    if (next !== undefined) await tx.save(next)
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
