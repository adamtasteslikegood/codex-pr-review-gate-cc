import { expect, test } from 'claude-code/testing'

import { mergeNotes, patch } from '../hooks/round'

test('R81: a note merges into a prompt of the same batch and record only', async () => {
  const a = { root: '/repo', branch: 'feat/x' }
  const b = { root: '/repo', branch: 'feat/y' }
  const out = mergeNotes([
    { text: 'pr-gate: the person allowed 1 more round: x.\n\nmore', key: a, batch: 1, isNote: true },
    { text: 'pr-gate: round prompt', key: a, batch: 1 },
    { text: 'pr-gate: the person stopped the gate.', key: b, batch: 1, isNote: true },
    { text: 'pr-gate: the person reset the lifecycle of feat/x.', key: a, batch: 2, isNote: true },
  ])
  expect(out.map(one => one.text)).toEqual([
    'pr-gate: the person allowed 1 more round: x.\n\npr-gate: round prompt\n\nmore',
    'pr-gate: the person stopped the gate.',
    'pr-gate: the person reset the lifecycle of feat/x.',
  ])
})

test('gate R2-4: a ready prompt merged with a waiver note keeps what still holds the merge, not the note\'s next step', async () => {
  const a = { root: '/repo', branch: 'feat/x' }
  const note = 'pr-gate: the person waived G2-1: fine.\n\nEverything between abc1234 and the merge:\n- check ci failing (yours: fix it)\n\nYour next step: answer what is yours.'
  const out = mergeNotes([
    { text: note, key: a, batch: 1, isNote: true },
    { text: 'pr-gate: ready for the merge decision.', key: a, batch: 1 },
  ])
  expect(out.map(one => one.text)).toEqual([
    'pr-gate: the person waived G2-1: fine.\n\npr-gate: ready for the merge decision.\n\nEverything between abc1234 and the merge:\n- check ci failing (yours: fix it)',
  ])
})

/** An engine with only the run's state, in memory: what `patch` reads and writes. */
const holding = (value: object) => {
  let held = { value, version: 1 }
  const state = {
    get: async () => held,
    set: async (_ref: unknown, next: object, options?: { ifVersion?: number }) => {
      if (options?.ifVersion !== undefined && options.ifVersion !== held.version) return { isSet: false, version: held.version }
      held = { value: next, version: held.version + 1 }
      return { isSet: true, version: held.version }
    },
  }
  return { $: { state } as never, read: () => held.value as { activity?: string } }
}

test('M2: patch changes only the running run it names, and returns null for any other (final review)', async () => {
  const running = holding({ id: 'r1', status: 'running', activity: 'a' })
  expect((await patch(running.$, 'r1', one => ({ ...one, activity: 'b' })))?.activity).toBe('b')
  expect(running.read().activity).toBe('b')
  const stopped = holding({ id: 'r1', status: 'stopped', activity: 'a' })
  expect(await patch(stopped.$, 'r1', one => ({ ...one, activity: 'b' }))).toBeNull()
  expect(stopped.read().activity).toBe('a')
  const other = holding({ id: 'r2', status: 'running', activity: 'a' })
  expect(await patch(other.$, 'r1', one => ({ ...one, activity: 'b' }))).toBeNull()
  expect(other.read().activity).toBe('a')
})
