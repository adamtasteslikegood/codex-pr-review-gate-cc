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
import {
  fixPrompt, heldPrompt, priorRounds, prPrompt, readDispositions, readReview, readTriage, readyPrompt, reportPrompt, reviewPrompt, TRAILER, triagePrompt, verifyPrompt,
} from '../hooks/core'

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

test('pre-PR: an open blocker anywhere in the ledger never passes, even when the last round raised nothing', async () => {
  const r1 = pre({ raised: { blocking: 1, advisory: 0 }, endHead: 'b' })
  const r2 = pre({ startHead: 'b', endHead: 'b' })
  const open = { findings: [finding({ status: 'open' })] }
  expect(decideNext(at([r1, r2], open))).toMatchObject({ kind: 'round', phase: 'pre', isAdvisory: false })
  // With the allowance spent it is exhausted, never passed.
  expect(decideNext(at([r1, r1, r1, r2], open))).toEqual({ kind: 'open-pr', status: 'exhausted' })
  // A blocker only deferred as security needs the person, not another round.
  expect(decideNext(at([r1, r2], { findings: [finding({ status: 'deferred', isSecurity: true })] })).kind).toBe('blocked')
})

test('pre-PR: a security fix only reported fixed is not a pass until a check confirms it', async () => {
  const r1 = pre({ raised: { blocking: 1, advisory: 0 }, endHead: 'b' })
  const r2 = pre({ startHead: 'b', endHead: 'b' })
  const owed = { findings: [finding({ status: 'reported-fixed', isSecurity: true })] }
  expect(decideNext(at([r1, r2], owed))).toMatchObject({ kind: 'round', phase: 'pre', isAdvisory: false })
  expect(decideNext(at([r1, r1, r1, r2], owed))).toEqual({ kind: 'open-pr', status: 'exhausted' })
  // A non-security fix still owed verification does not hold the pre-PR gate.
  expect(decideNext(at([r1, r2], { findings: [finding({ status: 'reported-fixed' })] }))).toEqual({ kind: 'open-pr', status: 'passed' })
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

test('a review answer can confirm fixes and hold rebuttals by id', async () => {
  const answer = `ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-review', gate: 'PASS', findings: [], verified: ['R1-1'], held: ['R1-2'] })}`
  expect(readReview(answer)).toMatchObject({ gate: 'PASS', verified: ['R1-1'], held: ['R1-2'] })
})

test('the triage answer carries dispositions, severities, reply ids and duplicates', async () => {
  const answer = `${TRAILER}\n${JSON.stringify({
    step: 'r3-triage',
    dispositions: [
      { id: 'G3-1', action: 'fixed', note: 'parameterised', severity: 'P1', isSecurity: true, replyId: '991' },
      { id: 'G3-2', action: 'rebutted', note: 'see R1-1', duplicateOf: 'R1-1', replyId: '992' },
    ],
  })}`
  expect(readTriage(answer)).toEqual([
    { id: 'G3-1', action: 'fixed', note: 'parameterised', severity: 'P1', isSecurity: true, replyId: '991' },
    { id: 'G3-2', action: 'rebutted', note: 'see R1-1', duplicateOf: 'R1-1', replyId: '992' },
  ])
})

test('prior rounds list the answered findings that still apply, with their evidence and what is owed', async () => {
  const text = priorRounds([
    finding({ status: 'rebutted', note: 'checked at src/app.ts:9' }),
    finding({ id: 'R1-2', status: 'reported-fixed', note: 'allow-list' }),
    finding({ id: 'R1-3', file: 'src/other.ts', status: 'verified-fixed' }),
  ], new Set(['src/app.ts']))
  expect(text).toContain('R1-1 [P1] Unvalidated redirect in login (src/app.ts:12)\n    rebutted: checked at src/app.ts:9')
  expect(text).toContain('R1-2 [P1] Unvalidated redirect in login (src/app.ts:12)\n    reported-fixed, verification owed: allow-list')
  expect(text).not.toContain('R1-3')
  expect(priorRounds([])).toBe('')
})

const runOf = (over: Record<string, unknown> = {}): any => ({
  id: 'x', cwd: '/repo', root: '/repo', branch: 'feat/x', base: 'dev', headSha: 'abcdef123',
  tier: 'standard', tierWhy: '10 lines', lane: 'full', effort: 'high', round: 1, lifecycle: 'pre', roundKind: 'discretionary',
  roundStartHead: 'abcdef123', diffBase: 'origin/dev', fixKind: 'blocking', findings: [finding()], ...over,
})

test('no prompt opens with a slash, which would be read as a command', async () => {
  const rec = { ...fresh(), pr: 7, slug: 'me/repo', findings: [finding()] }
  const fb: any = { id: 'inline:1', kind: 'inline', reviewer: 'bot', body: 'x', threadId: '5', at: 1, isFinding: true }
  const items = [{ feedback: fb, cls: 'new-on-reviewed' as const, findingId: 'G1-1' }]
  const prompts = [
    prPrompt(runOf(), rec, 'passed'),
    prPrompt(runOf(), rec, 'exhausted'),
    prPrompt(runOf(), rec, 'waived'),
    prPrompt(runOf({ tier: 'trivial', tierWhy: 'docs only' }), rec, 'passed'),
    fixPrompt(runOf(), undefined, true),
    fixPrompt(runOf({ fixKind: 'advisory', findings: [finding({ severity: 'P2' })] }), undefined, true),
    triagePrompt(runOf({ lifecycle: 'post', roundKind: 'baseline' }), rec, items, []),
    readyPrompt(rec),
    reportPrompt(rec, { why: 'budget spent', nextStep: 'ask for more rounds' }),
    reviewPrompt(runOf(), 'review', []),
    reviewPrompt(runOf(), 'challenge', []),
    verifyPrompt(runOf(), 'abcdef0'),
    heldPrompt(rec, 'the allowance is spent', 'fix R1-1, commit, then /pr-gate resume'),
  ]
  for (const one of prompts) expect(one.startsWith('/')).toBe(false)
})

test('a triage prompt tells the agent to answer a new claim on its merits', async () => {
  const rec = { ...fresh(), pr: 7, slug: 'me/repo' }
  const fb: any = { id: 'comment:1', kind: 'comment', reviewer: 'bot', body: 'x', at: 1, isFinding: true }
  const text = triagePrompt(runOf({ lifecycle: 'post' }), rec, [{ feedback: fb, cls: 'new-on-reviewed', findingId: 'G1-1' }], [])
  expect(text).toContain('An earlier review is not a reason to rebut a new claim: answer it on its merits.')
})

test('history marks the entries whose file changed since', async () => {
  const text = priorRounds([finding({ status: 'rebutted', note: 'ok', needsRecheck: true }), finding({ id: 'R1-2', status: 'rebutted', note: 'ok' })])
  expect(text).toContain('R1-1 [P1] Unvalidated redirect in login (src/app.ts:12) (file changed since: re-verify)\n    rebutted: ok')
  expect(text.match(/re-verify/g)).toHaveLength(1)
  expect(reviewPrompt(runOf(), 'review', [finding({ status: 'rebutted', note: 'ok', needsRecheck: true })])).toContain('(file changed since: re-verify)')
})

const trailerOf = (body: unknown): string => `${TRAILER}\n${JSON.stringify(body)}`

test('readers drop only the malformed parts of a dispositions list', async () => {
  for (const read of [readTriage, readDispositions]) {
    expect(read(trailerOf({ dispositions: 'nope' }))).toEqual([])
    expect(read(trailerOf({ dispositions: { id: 'R1-1' } }))).toEqual([])
    expect(read(trailerOf({ dispositions: [null, 3, 'x', { id: 'R1-1', action: 'fixed' }] }))).toEqual([{ id: 'R1-1', action: 'fixed' }])
    expect(read(trailerOf({ dispositions: [{ id: 'R1-1', action: 'maybe' }, { id: 'R1-2', action: 'FIXED' }] }))).toEqual([{ id: 'R1-2', action: 'fixed' }])
    expect(read(trailerOf({ dispositions: [{ id: 'R1-1', action: 'fixed', severity: 'P9' }] }))).toEqual([{ id: 'R1-1', action: 'fixed' }])
  }
})

test('a reply id is a non-empty string or a finite number; anything else is dropped', async () => {
  const ids = (replyId: unknown) => readTriage(trailerOf({ dispositions: [{ id: 'G1-1', action: 'fixed', replyId }] }))[0]
  expect(ids('991')).toEqual({ id: 'G1-1', action: 'fixed', replyId: '991' })
  expect(ids(991)).toEqual({ id: 'G1-1', action: 'fixed', replyId: '991' })
  for (const bad of ['', '  ', null, true, {}, [1], Number.NaN, { toString: 1 }]) expect(ids(bad)).toEqual({ id: 'G1-1', action: 'fixed' })
})

test('verified and held that are not lists of strings read as empty or lose the bad entries', async () => {
  const read = (extra: object) => readReview(trailerOf({ step: 'r1-review', gate: 'PASS', findings: [], ...extra }))
  expect(read({ verified: 'R1-1', held: { a: 1 } })).toMatchObject({ gate: 'PASS', verified: [], held: [] })
  expect(read({ verified: ['R1-1', 3, null, {}, ''], held: [['x'], 'R1-2'] })).toMatchObject({ verified: ['R1-1'], held: ['R1-2'] })
})

test('post-PR: a ready record is ready no longer once its ledger holds a blocker or an owed security fix', async () => {
  const done = [post({ endHead: 'b' }), post({ n: 2, startHead: 'b', endHead: 'b' })]
  expect(decideNext(at(done, { phase: 'ready', head: 'b', findings: [finding()] })).kind).not.toBe('ready')
  const owed = [finding({ status: 'reported-fixed', isSecurity: true })]
  expect(decideNext(at(done, { phase: 'ready', head: 'b', findings: owed })).kind).not.toBe('ready')
  expect(decideNext(at(done, { phase: 'ready', head: 'b', findings: [finding({ status: 'rebutted' })] }))).toEqual({ kind: 'ready' })
})

// ------------------------------------------------------------- task 12 fix round 1

test('R33: a comment posted after the rebuttal is not a duplicate of it', async () => {
  const answered = [finding({ status: 'rebutted', history: [{ round: 2, status: 'rebutted', by: 'main', at: 100 }] })]
  const same = { file: 'src/app.ts', line: 14, title: 'Unvalidated redirect in the login handler' }
  expect(triage({ ...same, at: 50 }, answered, new Set())).toEqual({ cls: 'duplicate', matchId: 'R1-1' })
  expect(triage({ ...same, at: 150 }, answered, new Set()).cls).toBe('new-on-reviewed')
})

test('R32: post-PR, a round that left a blocker open on the same head without a rebuttal blocks instead of spending a round', async () => {
  const round = post({ n: 2, startHead: 'b', endHead: 'b', raised: { blocking: 1, advisory: 0 } })
  const rec = at([pre({ endHead: 'b' }), round], { phase: 'post', findings: [finding({ id: 'G2-1', round: 2 })] })
  expect(decideNext(rec)).toMatchObject({ kind: 'blocked', nextStep: 'fix or rebut G2-1, then pr-gate resume' })
  // A rebuttal in the round: another round may settle it.
  expect(decideNext({ ...rec, rounds: [rec.rounds[0]!, { ...round, rebutted: 1 }] })).toMatchObject({ kind: 'round', roundKind: 'discretionary' })
})

test('R34: post-PR, reviewer feedback left unanswered never reaches ready', async () => {
  const rec = at([pre(), post({ n: 2 })], { phase: 'post', findings: [finding({ id: 'G2-1', round: 2, source: 'github', severity: 'P2' })] })
  expect(decideNext(rec)).toMatchObject({ kind: 'blocked', nextStep: 'answer G2-1 in its thread (fix, rebut or defer), then pr-gate resume' })
})

test('the post-PR report names the agent\'s next step and the person\'s options apart, with what is owed', async () => {
  const rec = { ...fresh(), pr: 7, phase: 'post' as const, findings: [finding(), finding({ id: 'R1-2', status: 'reported-fixed' })] }
  const text = reportPrompt(rec, { why: 'R1-1 unresolved and the review allowance is spent', nextStep: 'fix R1-1 and push, then pr-gate resume' })
  expect(text).toContain('Your next step: fix R1-1 and push, then pr-gate resume.')
  expect(text).toContain('Their options:')
  expect(text).toContain('R1-2 [P1]')
  expect(text).toContain('waive post')
})

test('the triage prompt calls new commits unreviewed, not someone else\'s, and leaves out an empty feedback list', async () => {
  const rec = { ...fresh(), pr: 7, slug: 'me/repo' }
  const text = triagePrompt(runOf({ lifecycle: 'post' }), rec, [], ['abc1234 bob fix typo'])
  expect(text).toContain('Commits on the PR since a, not yet reviewed: abc1234 bob fix typo')
  expect(text).not.toContain('someone else')
  expect(text).not.toContain('New review feedback:')
})

// ------------------------------------------------------------- task 12 fix round 2

test('M1: a deferred security P1 post-PR: the agent tells the person, the waiver is the person\'s option', async () => {
  const rec = at([pre(), post({ n: 2, rebutted: 1 })], { phase: 'post', findings: [finding({ id: 'G2-1', status: 'deferred', isSecurity: true })] })
  const next = decideNext(rec)
  expect(next).toMatchObject({ kind: 'blocked', nextStep: 'tell the person G2-1 is a deferred security P1 that only their waiver settles' })
  const text = reportPrompt(rec, next as { why: string; nextStep: string })
  expect(text).toContain('Their options:')
  expect(text).toContain('/pr-gate waive G2-1 <reason>')
  expect(text.split('Your next step:')[1]?.split('\n')[0]).not.toContain('/pr-gate')
})

test('R37: the post-PR blocks an agent can answer say which findings to answer', async () => {
  const round = post({ n: 2, startHead: 'b', endHead: 'b', raised: { blocking: 1, advisory: 0 } })
  const rec = at([pre({ endHead: 'b' }), round], { phase: 'post', findings: [finding({ id: 'G2-1', round: 2 })] })
  expect(decideNext(rec)).toMatchObject({ kind: 'blocked', answer: ['G2-1'] })
})

test('M4: the triage prompt names replied feedback by finding id', async () => {
  const rec = { ...fresh(), pr: 7, slug: 'me/repo', replies: { 'inline:11': '991' }, findings: [finding({ id: 'G2-1', externalId: 'inline:11' })] }
  const fb: any = { id: 'comment:1', kind: 'comment', reviewer: 'bot', body: 'x', at: 1, isFinding: true }
  const text = triagePrompt(runOf({ lifecycle: 'post' }), rec, [{ feedback: fb, cls: 'new-on-reviewed', findingId: 'G2-2' }], [])
  expect(text).toContain('Already replied to: G2-1;')
  expect(text).not.toContain('inline:11')
})
