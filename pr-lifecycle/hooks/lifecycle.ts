// The lifecycle's pure half: the budget, the finding ledger, coverage, and
// the controller's choice of what comes next. No `$` here.

import type { Finding, FindingStatus, Lane, LifecycleRecord, RoundKind, RoundRecord, Severity, Tier } from '../types'

// ----------------------------------------------------------------- budget

export type Allowances = { standard: number; high: number }

const TIERS: readonly Tier[] = ['trivial', 'standard', 'high']

/** Discretionary rounds a lifecycle may complete: by tier, one on the light lane, none for a pass-through. */
export function allowanceFor(tier: Tier, lane: Lane, a: Allowances): number {
  if (tier === 'trivial') return 0
  if (lane === 'light') return 1
  return tier === 'high' ? a.high : a.standard
}

/** Completed discretionary rounds: baseline rounds, final-head checks and incomplete attempts use nothing. */
export const usedRounds = (rec: Pick<LifecycleRecord, 'rounds'>): number =>
  rec.rounds.filter(one => one.isCompleted && one.kind === 'discretionary').length

type Budgeted = Pick<LifecycleRecord, 'rounds' | 'allowance' | 'grants'>

export const remaining = (rec: Budgeted): number =>
  Math.max(0, rec.allowance + rec.grants.reduce((sum, one) => sum + one.n, 0) - usedRounds(rec))

/** A blocking round needs one round left; an advisory-only one needs one more after itself (the reserve rule). */
export const mayStartRound = (rec: Budgeted, isAdvisory: boolean): boolean => remaining(rec) >= (isAdvisory ? 2 : 1)

/** Records a round or an incomplete attempt, with its effort; history is only ever appended. */
export function withRound(rec: LifecycleRecord, round: RoundRecord): LifecycleRecord {
  return {
    ...rec,
    rounds: [...rec.rounds, round],
    attempts: rec.attempts + (round.isCompleted ? 0 : 1),
    activeMs: rec.activeMs + round.activeMs,
    waitMs: rec.waitMs + round.waitMs,
    updatedAt: Math.max(rec.updatedAt, round.endedAt),
  }
}

/** A materially wider change: the tier and allowance only go up, and the rounds already run still count. */
export function rescope(rec: LifecycleRecord, tier: Tier, why: string, a: Allowances): LifecycleRecord {
  if (TIERS.indexOf(tier) <= TIERS.indexOf(rec.tier)) return rec
  return { ...rec, tier, tierWhy: why, allowance: Math.max(rec.allowance, allowanceFor(tier, rec.lane, a)) }
}

export function newRecord(init: {
  root: string
  branch: string
  base: string
  head: string
  tier: Tier
  tierWhy: string
  lane: Lane
  allowance: number
  at: number
}): LifecycleRecord {
  const { at, ...rest } = init
  return {
    version: 1,
    ...rest,
    grants: [],
    attempts: 0,
    activeMs: 0,
    waitMs: 0,
    rounds: [],
    findings: [],
    processed: [],
    replies: {},
    waivers: [],
    phase: 'pre',
    updatedAt: at,
  }
}

export const roundOf = (over: Partial<RoundRecord>): RoundRecord => ({
  n: 1,
  phase: 'pre',
  kind: 'discretionary',
  isAdvisory: false,
  startHead: 'a',
  endHead: 'a',
  isCompleted: true,
  evidence: [],
  raised: { blocking: 0, advisory: 0 },
  rebutted: 0,
  deferredBlocking: 0,
  activeMs: 0,
  waitMs: 0,
  startedAt: 0,
  endedAt: 0,
  ...over,
})

export const isBlocking = (finding: Pick<Finding, 'severity'>): boolean => finding.severity === 'P0' || finding.severity === 'P1'

/** Raised in this round, or held open again by this round's reviewer: what the round's fix step answers. */
export const raisedIn = (finding: Pick<Finding, 'round' | 'history'>, round: number): boolean =>
  finding.round === round || finding.history.some(one => one.round === round && one.status === 'open')

// ----------------------------------------------------------------- ledger

export type Answer = {
  id: string
  action: 'fixed' | 'rebutted' | 'deferred'
  note?: string
  evidence?: string
  severity?: Severity
  isSecurity?: boolean
}

const moved = (f: Finding, status: FindingStatus, round: number, by: string, at: number, note?: string, evidence?: string): Finding => ({
  ...f,
  status,
  note: note ?? f.note,
  needsRecheck: undefined,
  history: [
    ...f.history,
    { round, status, ...(note === undefined ? {} : { note }), ...(evidence === undefined ? {} : { evidence }), by, at },
  ],
})

const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** The fixer's word: fixed is only reported until a check confirms it. A fixer cannot downgrade its own finding; disagreement is a rebuttal. */
export function applyAnswer(f: Finding, a: Answer, round: number, by: string, at: number): Finding {
  const status: FindingStatus = a.action === 'fixed' ? 'reported-fixed' : a.action
  const next = moved(f, status, round, by, at, a.note, a.evidence)
  const severity = a.severity !== undefined && RANK[a.severity] < RANK[f.severity] ? a.severity : f.severity
  const security = f.isSecurity === true || a.isSecurity === true
  return { ...next, severity, ...(security ? { isSecurity: true } : {}) }
}

/** A check confirmed the fix: the verify step, a reviewer saying so, or Codex conceding it. */
export const markVerified = (f: Finding, round: number, by: string, at: number, note?: string): Finding =>
  moved(f, 'verified-fixed', round, by, at, note)

/** A reviewer holds the finding against the fix or rebuttal: it is unresolved again. */
export const markHeld = (f: Finding, round: number, by: string, at: number, note?: string): Finding => moved(f, 'open', round, by, at, note)

/** The ledger after a round: changed findings replace theirs by id, new ones are appended, nothing else moves. */
export function mergeFindings(kept: readonly Finding[], changed: readonly Finding[]): Finding[] {
  const byId = new Map(changed.map(one => [one.id, one]))
  const out = kept.map(one => byId.get(one.id) ?? one)
  for (const one of changed) if (!kept.some(each => each.id === one.id)) out.push(one)
  return out
}

export type TriageClass = 'duplicate' | 'new-on-reviewed' | 'new-on-changed'

const words = (title: string): Set<string> => new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(one => one.length > 2))

/** Whether two findings name the same problem: same file, nearby line, mostly the same words. */
function isSame(a: { file?: string; line?: number; title: string }, b: { file?: string; line?: number; title: string }): boolean {
  if (a.file !== b.file) return false
  if (a.line !== undefined && b.line !== undefined && Math.abs(a.line - b.line) > 5) return false
  const x = words(a.title)
  const y = words(b.title)
  const shared = [...x].filter(one => y.has(one)).length
  return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.5
}

const ANSWERED: readonly FindingStatus[] = ['reported-fixed', 'verified-fixed', 'rebutted', 'deferred']

/** Where incoming feedback stands against the ledger. Prior review can make it a duplicate, never dismiss a new claim. */
export function triage(
  item: { file?: string; line?: number; title: string },
  findings: readonly Finding[],
  changedFiles: ReadonlySet<string>,
): { cls: TriageClass; matchId?: string } {
  if (item.file !== undefined && changedFiles.has(item.file)) return { cls: 'new-on-changed' }
  const match = findings.find(one => ANSWERED.includes(one.status) && one.needsRecheck !== true && isSame(one, item))
  return match === undefined ? { cls: 'new-on-reviewed' } : { cls: 'duplicate', matchId: match.id }
}

const waivedIds = (rec: Pick<LifecycleRecord, 'waivers'>): Set<string> =>
  new Set(rec.waivers.filter(one => one.scope === 'finding' && one.findingId !== undefined).map(one => one.findingId as string))

/** Blockers nobody settled: open ones, and a deferred security P1, which only the person's waiver settles. */
export function unresolvedBlockers(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(
    one => isBlocking(one) && !waived.has(one.id) && (one.status === 'open' || (one.status === 'deferred' && one.isSecurity === true)),
  )
}

/** Blockers the fixer reported fixed that no check has confirmed yet. */
export function verificationOwed(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => isBlocking(one) && !waived.has(one.id) && one.status === 'reported-fixed')
}

// --------------------------------------------------------------- coverage

/** The head the last completed round left behind: what review evidence covers. */
export const lastReviewedHead = (rec: Pick<LifecycleRecord, 'rounds'>): string | undefined =>
  rec.rounds.filter(one => one.isCompleted).at(-1)?.endHead

/** Answered findings whose file changed: their evidence must be checked again. History stays. */
export function invalidate(findings: readonly Finding[], changedFiles: ReadonlySet<string> | 'all'): Finding[] {
  return findings.map(one =>
    one.status !== 'open' && (changedFiles === 'all' || (one.file !== undefined && changedFiles.has(one.file))) ? { ...one, needsRecheck: true } : one,
  )
}

// --------------------------------------------------------------- the next step

export type Next =
  | { kind: 'round'; phase: 'pre' | 'post'; roundKind: RoundKind; isAdvisory: boolean; scope: 'full' | 'delta' }
  | { kind: 'open-pr'; status: 'passed' | 'exhausted' }
  | { kind: 'ready' }
  | { kind: 'exhausted'; why: string; nextStep: string }
  | { kind: 'blocked'; why: string; nextStep: string }

const ids = (findings: readonly Finding[]): string => findings.map(one => one.id).join(', ')

function decidePre(rec: LifecycleRecord): Next {
  const last = rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).at(-1)
  if (last === undefined) {
    return rec.allowance + rec.grants.reduce((sum, one) => sum + one.n, 0) > 0
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'open-pr', status: 'passed' }
  }
  // Commits since the last completed round: the new head needs its own review.
  if (rec.head !== last.endHead) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'open-pr', status: 'exhausted' }
  }
  const isChanged = last.endHead !== last.startHead
  if (last.deferredBlocking > 0) {
    return {
      kind: 'blocked',
      why: 'a blocking finding was deferred: its fix reaches past this branch',
      nextStep: '/pr-gate waive <findingId> <reason>, or widen the branch and run /pr-gate',
    }
  }
  if (last.raised.blocking === 0) {
    // Advisories go back to Codex only for new commits, and only while a round stays in reserve.
    return last.raised.advisory > 0 && isChanged && mayStartRound(rec, true)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: true, scope: 'full' }
      : { kind: 'open-pr', status: 'passed' }
  }
  if (!isChanged && last.rebutted === 0) {
    return {
      kind: 'blocked',
      why: 'the fixer changed nothing and rebutted nothing, so another round would say the same',
      nextStep: 'fix or rebut the open findings, then /pr-gate resume',
    }
  }
  return mayStartRound(rec, false)
    ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
    : { kind: 'open-pr', status: 'exhausted' }
}

function decidePost(rec: LifecycleRecord): Next {
  const done = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)
  const last = done.at(-1)
  if (last === undefined) return { kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' }
  const isChanged = last.endHead !== last.startHead
  const unresolved = unresolvedBlockers(rec)
  const owed = verificationOwed(rec)
  // The protected baseline: a second round whenever the first one changed the head, by anyone. A later push does not spend the allowance on it.
  if (done.length === 1 && isChanged) return { kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' }
  // A push after the last completed round (a fix after ready or exhaustion, someone else's commit): review that head.
  if (rec.head !== last.endHead) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'round', phase: 'post', roundKind: 'final-head-check', isAdvisory: false, scope: 'delta' }
  }
  if (last.kind === 'final-head-check') {
    if (!isChanged && unresolved.length === 0 && owed.length === 0) return { kind: 'ready' }
    return {
      kind: 'exhausted',
      why: unresolved.length > 0 ? `${ids(unresolved)} unresolved at ${last.endHead.slice(0, 7)}` : `${last.endHead.slice(0, 7)} is not reviewed clean`,
      nextStep:
        unresolved.length > 0
          ? `fix ${unresolved[0]?.id} and push, /pr-gate waive ${unresolved[0]?.id} <reason>, or /pr-gate allow 1 <reason>`
          : '/pr-gate allow 1 <reason>',
    }
  }
  if (isChanged || owed.length > 0) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'round', phase: 'post', roundKind: 'final-head-check', isAdvisory: false, scope: 'delta' }
  }
  if (unresolved.length === 0) return { kind: 'ready' }
  if (unresolved.some(one => one.status === 'deferred')) {
    return {
      kind: 'blocked',
      why: `${ids(unresolved)} deferred, and a security P1 needs your decision`,
      nextStep: `/pr-gate waive ${unresolved[0]?.id} <reason>`,
    }
  }
  return mayStartRound(rec, false)
    ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
    : {
        kind: 'exhausted',
        why: `${ids(unresolved)} unresolved and the review allowance is spent`,
        nextStep: `fix ${unresolved[0]?.id} and push, /pr-gate waive ${unresolved[0]?.id} <reason>, or /pr-gate allow 1 <reason>`,
      }
}

/** What the controller does after a round, from the record alone. Exhaustion is never a pass. */
export function decideNext(rec: LifecycleRecord): Next {
  // Ready holds only for the head it was reached at: a later push continues the lifecycle.
  if (rec.phase === 'ready' && rec.head === lastReviewedHead(rec)) return { kind: 'ready' }
  return rec.phase === 'pre' ? decidePre(rec) : decidePost(rec)
}
