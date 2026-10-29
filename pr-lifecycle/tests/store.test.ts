import { expect, test } from 'claude-code/testing'

import { newRecord } from '../hooks/lifecycle'
import { latestArchive, loadRecord, saveRecord, transact, updateRecord } from '../hooks/store'
import type { LifecycleRecord } from '../types'

/** A store whose every read and write yields first, as the host's does, so two read-modify-writes can interleave. */
const engine = () => {
  const kept = new Map<string, unknown>()
  const tick = async () => {
    for (let hop = 0; hop < 3; hop++) await Promise.resolve()
  }
  return {
    store: {
      get: async (key: string) => {
        await tick()
        return kept.get(key)
      },
      set: async (key: string, value: unknown) => {
        await tick()
        kept.set(key, value)
      },
      keys: async () => [...kept.keys()],
    },
    clock: { now: async () => 1 },
  } as never
}

const seed = (): LifecycleRecord =>
  newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 })

const grant = (reason: string) => (rec: LifecycleRecord): LifecycleRecord => ({ ...rec, grants: [...rec.grants, { n: 1, reason, head: rec.head, at: 1 }] })

test('R1-6: two concurrent updates of one record both land', async () => {
  const $ = engine()
  await saveRecord($, seed())
  await Promise.all([updateRecord($, '/repo', 'feat/x', grant('one')), updateRecord($, '/repo', 'feat/x', grant('two'))])
  expect((await loadRecord($, '/repo', 'feat/x'))?.grants.map(one => one.reason)).toEqual(['one', 'two'])
})

test('R1-6: an async change holds the record until it is written', async () => {
  const $ = engine()
  await saveRecord($, seed())
  const slow = updateRecord($, '/repo', 'feat/x', async rec => {
    for (let hop = 0; hop < 20; hop++) await Promise.resolve()
    return grant('slow')(rec)
  })
  await Promise.all([slow, updateRecord($, '/repo', 'feat/x', grant('fast'))])
  expect((await loadRecord($, '/repo', 'feat/x'))?.grants.map(one => one.reason)).toEqual(['slow', 'fast'])
})

test('R1-6: a change that throws releases the lock', async () => {
  const $ = engine()
  await saveRecord($, seed())
  const failing = updateRecord($, '/repo', 'feat/x', () => {
    throw new Error('boom')
  })
  await expect(failing).rejects.toThrow('boom')
  await updateRecord($, '/repo', 'feat/x', grant('after'))
  expect((await loadRecord($, '/repo', 'feat/x'))?.grants.map(one => one.reason)).toEqual(['after'])
})

test('#29 seam: a transaction that archives and reseeds is one change; an update queued meanwhile lands on the seed', async () => {
  const $ = engine()
  await saveRecord($, seed())
  const reset = transact($, '/repo', 'feat/x', async tx => {
    const last = await tx.load()
    if (last === undefined) return
    await tx.archive(last, 5)
    await tx.save({ ...seed(), generation: 1 })
  })
  await Promise.all([reset, updateRecord($, '/repo', 'feat/x', grant('later'))])
  const live = await loadRecord($, '/repo', 'feat/x')
  expect(live?.generation).toBe(1)
  expect(live?.grants.map(one => one.reason)).toEqual(['later'])
  expect((await latestArchive($, '/repo', 'feat/x'))?.phase).toBe('archived')
})
