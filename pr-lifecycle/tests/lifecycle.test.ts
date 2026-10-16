import { expect, test } from 'claude-code/testing'

import type { Finding } from '../types'
import {
  allowanceFor,
  applyAnswer,
  markHeld,
  markVerified,
  mayStartRound,
  mergeFindings,
  newRecord,
  remaining,
  rescope,
  roundOf,
  triage,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
  withRound,
} from '../hooks/lifecycle'

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

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'R1-1',
  round: 1,
  source: 'codex-review',
  reviewer: 'codex',
  severity: 'P1',
  title: 'Unvalidated redirect in login',
  file: 'src/app.ts',
  line: 12,
  headSeen: 'a',
  status: 'open',
  history: [],
  ...over,
})

test('the fixer reports a fix; only a check verifies it', async () => {
  const reported = applyAnswer(finding(), { id: 'R1-1', action: 'fixed', note: 'allow-list' }, 1, 'main', 5)
  expect(reported.status).toBe('reported-fixed')
  expect(reported.history.at(-1)).toEqual({ round: 1, status: 'reported-fixed', note: 'allow-list', by: 'main', at: 5 })
  expect(markVerified(reported, 2, 'codex', 6).status).toBe('verified-fixed')
  expect(markHeld(reported, 2, 'codex', 6, 'still reachable').status).toBe('open')
})

test('merging a later review never changes a finding it left out', async () => {
  const old = [finding({ status: 'reported-fixed' }), finding({ id: 'R1-2', status: 'open', severity: 'P2' })]
  const merged = mergeFindings(old, [finding({ id: 'R2-1', round: 2, title: 'Something else' })])
  expect(merged.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'reported-fixed'],
    ['R1-2', 'open'],
    ['R2-1', 'open'],
  ])
})

test('triage tells a duplicate of an answered finding from new claims', async () => {
  const answered = [finding({ status: 'rebutted', note: 'the redirect is checked at src/app.ts:9' })]
  const same = { file: 'src/app.ts', line: 14, title: 'Unvalidated redirect in the login handler' }
  expect(triage(same, answered, new Set())).toEqual({ cls: 'duplicate', matchId: 'R1-1' })
  // The file changed since the answer: the evidence may not hold, so it is a new claim on changed code.
  expect(triage(same, answered, new Set(['src/app.ts'])).cls).toBe('new-on-changed')
  // A different claim about reviewed code is handled on its merits.
  expect(triage({ file: 'src/app.ts', line: 40, title: 'SQL built by string concatenation' }, answered, new Set()).cls).toBe('new-on-reviewed')
  // A finding needing a recheck is never a duplicate.
  expect(triage(same, [{ ...answered[0]!, needsRecheck: true }], new Set()).cls).toBe('new-on-reviewed')
})

test('unresolved blockers: open ones, and a deferred security P1, unless the person waived it', async () => {
  const findings = [
    finding({ id: 'A', status: 'open' }),
    finding({ id: 'B', status: 'deferred', isSecurity: true }),
    finding({ id: 'C', status: 'deferred' }),
    finding({ id: 'D', status: 'open', severity: 'P3' }),
    finding({ id: 'E', status: 'reported-fixed' }),
  ]
  expect(unresolvedBlockers({ findings, waivers: [] }).map(one => one.id)).toEqual(['A', 'B'])
  const waivers = [{ scope: 'finding' as const, findingId: 'B', head: 'a', reason: 'accepted', by: 'person', at: 1 }]
  expect(unresolvedBlockers({ findings, waivers }).map(one => one.id)).toEqual(['A'])
  expect(verificationOwed({ findings, waivers: [] }).map(one => one.id)).toEqual(['E'])
})
