// The lifecycle record, kept in the plugin's store so a restart resumes it.

import type { EngineInterface } from 'claude-code'

import type { LifecycleRecord } from '../types'

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

/** Reads, changes and writes the record under its lock; undefined when there is none. */
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
    await saveRecord($, next)
    return next
  })
}

/** As `updateRecord`, for a change that may start the record: `change` sees undefined when there is none, and returns what to write. */
export async function upsertRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord | undefined) => LifecycleRecord | Promise<LifecycleRecord>,
): Promise<LifecycleRecord> {
  return lockRecord(root, branch, async () => {
    const next = await change(await loadRecord($, root, branch))
    await saveRecord($, next)
    return next
  })
}
