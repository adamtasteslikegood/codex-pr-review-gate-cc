// The lifecycle record, kept in the plugin's store so a restart resumes it.

import type { EngineInterface } from 'claude-code'

import type { LifecycleRecord } from '../types'

type Engine = EngineInterface

export const recordKey = (root: string, branch: string): string => `lifecycle:${root}:${branch}`

export async function loadRecord($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const value = (await $.store.get(recordKey(root, branch))) as LifecycleRecord | undefined | null
  return value !== null && value !== undefined && value.version === 1 ? value : undefined
}

export async function saveRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, updatedAt: Math.max(rec.updatedAt, await $.clock.now()) })
}

/** Reads, changes and writes the record; undefined when there is none. */
export async function updateRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord) => LifecycleRecord,
): Promise<LifecycleRecord | undefined> {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined) return undefined
  const next = change(rec)
  await saveRecord($, next)
  return next
}
