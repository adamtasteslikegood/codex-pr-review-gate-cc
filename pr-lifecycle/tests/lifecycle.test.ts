import { expect, test } from 'claude-code/testing'

import { allowanceFor, mayStartRound, newRecord, remaining, rescope, roundOf, usedRounds, withRound } from '../hooks/lifecycle'

const A = { standard: 4, high: 6 }
const fresh = () =>
  newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a', tier: 'standard', tierWhy: '10 lines', lane: 'full', allowance: 4, at: 1 })

test('the allowance follows the tier and the lane', async () => {
  expect(allowanceFor('trivial', 'full', A)).toBe(0)
  expect(allowanceFor('standard', 'full', A)).toBe(4)
  expect(allowanceFor('high', 'full', A)).toBe(6)
  expect(allowanceFor('high', 'light', A)).toBe(1)
})

test('only completed discretionary rounds use the allowance', async () => {
  let rec = fresh()
  rec = withRound(rec, roundOf({ n: 1, kind: 'discretionary', isCompleted: true }))
  rec = withRound(rec, roundOf({ n: 2, kind: 'discretionary', isCompleted: false, activeMs: 60_000 }))
  rec = withRound(rec, roundOf({ n: 3, kind: 'baseline', phase: 'post', isCompleted: true }))
  rec = withRound(rec, roundOf({ n: 4, kind: 'final-head-check', phase: 'post', isCompleted: true }))
  expect(usedRounds(rec)).toBe(1)
  expect(remaining(rec)).toBe(3)
  // The incomplete attempt is recorded with its effort.
  expect(rec.attempts).toBe(1)
  expect(rec.activeMs).toBe(60_000)
})

test('an advisory-only round needs a round left over afterwards; a blocking one needs one', async () => {
  let rec = { ...fresh(), allowance: 2 }
  expect(mayStartRound(rec, true)).toBe(true)
  rec = withRound(rec, roundOf({ n: 1, kind: 'discretionary', isCompleted: true }))
  expect(mayStartRound(rec, true)).toBe(false)
  expect(mayStartRound(rec, false)).toBe(true)
})

test('grants from the person add rounds', async () => {
  const rec = { ...fresh(), allowance: 0, grants: [{ n: 2, reason: 'odd change', head: 'a', at: 2 }] }
  expect(remaining(rec)).toBe(2)
})

test('a rescope raises the allowance to the new tier and keeps history; it never lowers it', async () => {
  let rec = withRound(fresh(), roundOf({ n: 1, kind: 'discretionary', isCompleted: true }))
  rec = rescope(rec, 'high', 'touches auth/', A)
  expect(rec.tier).toBe('high')
  expect(rec.allowance).toBe(6)
  expect(rec.rounds).toHaveLength(1)
  expect(remaining(rec)).toBe(5)
  rec = rescope(rec, 'standard', 'smaller now', A)
  expect(rec.tier).toBe('high')
  expect(rec.allowance).toBe(6)
})
