import { expect, test } from 'claude-code/testing'

import { mergeNotes } from '../hooks/round'

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
    'pr-gate: the person allowed 1 more round: x.\n\npr-gate: round prompt',
    'pr-gate: the person stopped the gate.',
    'pr-gate: the person reset the lifecycle of feat/x.',
  ])
})
