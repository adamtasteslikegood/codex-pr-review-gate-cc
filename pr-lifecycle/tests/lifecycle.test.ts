import { expect, test } from 'claude-code/testing'

import type { Finding } from '../types'
import {
  allowanceFor,
  applyAnswer,
  decideNext,
  invalidate,
  lastReviewedHead,
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

test('a fixer cannot lower a finding: a P3 answer to a P1 keeps P1', async () => {
  const rebutted = applyAnswer(finding(), { id: 'R1-1', action: 'rebutted', severity: 'P3' }, 1, 'main', 5)
  expect(rebutted.severity).toBe('P1')
})

test('a fixer may raise a finding: a P1 answer to a P3 becomes P1', async () => {
  const fixed = applyAnswer(finding({ severity: 'P3' }), { id: 'R1-1', action: 'fixed', severity: 'P1' }, 1, 'main', 5)
  expect(fixed.severity).toBe('P1')
  expect('isSecurity' in fixed).toBe(false)
})

test('a fixer cannot clear isSecurity: a false answer keeps a security finding security', async () => {
  const kept = applyAnswer(finding({ isSecurity: true }), { id: 'R1-1', action: 'rebutted', isSecurity: false }, 1, 'main', 5)
  expect(kept.isSecurity).toBe(true)
})

test('a fixer may mark a finding security: a true answer sets isSecurity', async () => {
  const marked = applyAnswer(finding(), { id: 'R1-1', action: 'fixed', isSecurity: true }, 1, 'main', 5)
  expect(marked.isSecurity).toBe(true)
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

const pre = (over: Partial<Parameters<typeof roundOf>[0]> = {}) => roundOf({ phase: 'pre', kind: 'discretionary', ...over })
const post = (over: Partial<Parameters<typeof roundOf>[0]> = {}) => roundOf({ phase: 'post', kind: 'baseline', ...over })
const at = (rounds: ReturnType<typeof roundOf>[], over: object = {}) => ({ ...fresh(), rounds, head: rounds.at(-1)?.endHead ?? 'a', ...over })

test('pre-PR: nothing raised opens the PR; a blocker with allowance left runs another round', async () => {
  expect(decideNext(at([]))).toEqual({ kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' })
  expect(decideNext(at([pre()]))).toEqual({ kind: 'open-pr', status: 'passed' })
  // A commit after the pass is a new head: it is reviewed again.
  expect(decideNext(at([pre()], { head: 'z' }))).toMatchObject({ kind: 'round', phase: 'pre' })
  const blocked = pre({ raised: { blocking: 1, advisory: 0 }, endHead: 'b' })
  expect(decideNext(at([blocked]))).toMatchObject({ kind: 'round', phase: 'pre', isAdvisory: false })
  expect(decideNext(at([blocked, blocked, blocked, blocked]))).toEqual({ kind: 'open-pr', status: 'exhausted' })
})

test('pre-PR: a pass-through with no allowance opens the PR without a round', async () => {
  expect(decideNext(at([], { allowance: 0, tier: 'trivial', passThrough: 'docs only' }))).toEqual({ kind: 'open-pr', status: 'passed' })
})

test('pre-PR: advisories go back to Codex only after new commits and while the reserve holds', async () => {
  const fixedAdvisories = pre({ raised: { blocking: 0, advisory: 2 }, endHead: 'b' })
  expect(decideNext(at([fixedAdvisories]))).toMatchObject({ kind: 'round', isAdvisory: true })
  const rebuttedOnly = pre({ raised: { blocking: 0, advisory: 2 }, rebutted: 2 })
  expect(decideNext(at([rebuttedOnly]))).toEqual({ kind: 'open-pr', status: 'passed' })
  expect(decideNext(at([pre(), pre(), pre(), fixedAdvisories]))).toEqual({ kind: 'open-pr', status: 'passed' })
})

test('pre-PR: a deferred blocker or a fixer who did nothing blocks for a decision', async () => {
  expect(decideNext(at([pre({ raised: { blocking: 1, advisory: 0 }, deferredBlocking: 1, endHead: 'b' })])).kind).toBe('blocked')
  expect(decideNext(at([pre({ raised: { blocking: 1, advisory: 0 } })])).kind).toBe('blocked')
})

test('post-PR baseline: round 1 always, round 2 only when round 1 changed the head', async () => {
  const opened = { phase: 'post' as const }
  expect(decideNext(at([pre()], opened))).toEqual({ kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' })
  expect(decideNext(at([pre(), post()], opened))).toEqual({ kind: 'ready' })
  expect(decideNext(at([pre(), post({ endHead: 'b' })], opened))).toMatchObject({ kind: 'round', roundKind: 'baseline' })
})

test('post-PR: the baseline runs even with the allowance spent', async () => {
  const spent = [pre(), pre(), pre(), pre({ raised: { blocking: 1, advisory: 0 }, endHead: 'b' })]
  expect(decideNext(at(spent, { phase: 'post' }))).toMatchObject({ kind: 'round', roundKind: 'baseline' })
})

test('post-PR: an unreviewed head after the baseline gets a discretionary round, or the final-head check when spent', async () => {
  const baseline = [post({ endHead: 'b' }), post({ n: 2, startHead: 'b', endHead: 'c' })]
  expect(decideNext(at(baseline, { phase: 'post' }))).toMatchObject({ kind: 'round', roundKind: 'discretionary', scope: 'full' })
  expect(decideNext(at(baseline, { phase: 'post', allowance: 0 }))).toMatchObject({ kind: 'round', roundKind: 'final-head-check', scope: 'delta' })
})

test('post-PR: the final-head check never certifies a head it did not review clean', async () => {
  const check = post({ n: 3, kind: 'final-head-check', startHead: 'c', endHead: 'c', raised: { blocking: 1, advisory: 0 } })
  const rec = at([post({ endHead: 'b' }), post({ n: 2, startHead: 'b', endHead: 'c' }), check], {
    phase: 'post',
    allowance: 0,
    findings: [finding({ id: 'R3-1', round: 3, status: 'open' })],
  })
  expect(decideNext(rec).kind).toBe('exhausted')
})

test('post-PR: a push after ready or exhaustion continues the lifecycle on the new head', async () => {
  const done = [post({ endHead: 'b' }), post({ n: 2, startHead: 'b', endHead: 'b' })]
  expect(decideNext(at(done, { phase: 'ready', head: 'b' }))).toEqual({ kind: 'ready' })
  expect(decideNext(at(done, { phase: 'ready', head: 'c' }))).toMatchObject({ kind: 'round', phase: 'post', roundKind: 'discretionary' })
  expect(decideNext(at(done, { phase: 'post', postStatus: 'exhausted', head: 'c', allowance: 0 }))).toMatchObject({ kind: 'round', roundKind: 'final-head-check' })
})

test('post-PR: a reported fix owed verification keeps the lifecycle from ready', async () => {
  const rec = at([post()], { phase: 'post', findings: [finding({ status: 'reported-fixed' })] })
  expect(decideNext(rec)).toMatchObject({ kind: 'round', roundKind: 'discretionary' })
  expect(decideNext({ ...rec, allowance: 0 })).toMatchObject({ kind: 'round', roundKind: 'final-head-check' })
})

test('post-PR: the second baseline round survives a later push, free of the allowance', async () => {
  const rec = at([pre(), post({ endHead: 'b' })], { phase: 'post', head: 'c', allowance: 0 })
  expect(decideNext(rec)).toEqual({ kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' })
})

test('coverage: a change touching a file flags only the answered findings in it', async () => {
  const findings = [finding({ status: 'rebutted' }), finding({ id: 'R1-2', file: 'src/other.ts', status: 'rebutted' }), finding({ id: 'R1-3', status: 'open' })]
  expect(invalidate(findings, new Set(['src/app.ts'])).map(one => one.needsRecheck === true)).toEqual([true, false, false])
  // A rebase that lost the reviewed commit: every answered finding is rechecked.
  expect(invalidate(findings, 'all').map(one => one.needsRecheck === true)).toEqual([true, true, false])
  expect(lastReviewedHead({ rounds: [pre({ endHead: 'b' }), pre({ isCompleted: false, endHead: 'z' })] })).toBe('b')
})
