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

/** The next free id under a prefix (`R3-`, `G3-`): after the highest one in any of the lists, so an id is never reused (R23). */
export function nextIds(prefix: string, lists: readonly (readonly Pick<Finding, 'id'>[])[]): (n: number) => string {
  const taken = Math.max(0, ...lists.flat().filter(one => one.id.startsWith(prefix)).map(one => Number(one.id.slice(prefix.length)) || 0))
  return n => `${prefix}${taken + n}`
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

/** When a finding was last rebutted, or undefined. */
const rebuttedAt = (f: Finding): number | undefined => f.history.filter(one => one.status === 'rebutted').at(-1)?.at

/**
 * Where incoming feedback stands against the ledger. Prior review can make it a duplicate, never dismiss a new claim.
 * Feedback posted after a rebuttal answers that rebuttal: it is never its duplicate (R33).
 */
export function triage(
  item: { file?: string; line?: number; title: string; at?: number },
  findings: readonly Finding[],
  changedFiles: ReadonlySet<string>,
): { cls: TriageClass; matchId?: string } {
  if (item.file !== undefined && changedFiles.has(item.file)) return { cls: 'new-on-changed' }
  const isAnswerTo = (one: Finding): boolean => {
    const when = one.status === 'rebutted' ? rebuttedAt(one) : undefined
    return item.at !== undefined && when !== undefined && item.at > when
  }
  const match = findings.find(one => ANSWERED.includes(one.status) && one.needsRecheck !== true && !isAnswerTo(one) && isSame(one, item))
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

/** A rebuttal Codex ruled on and accepted, with its file unchanged since. */
export const isAcceptedRebuttal = (f: Finding): boolean => {
  const last = f.history.at(-1)
  return f.status === 'rebutted' && f.needsRecheck !== true && last?.status === 'rebutted' && last.by === 'codex'
}

/** Codex accepts a rebuttal: the finding stays rebutted, with Codex's entry last (what `isAcceptedRebuttal` reads), in either phase. */
export const acceptRebuttal = (f: Finding, round: number, at: number, note = 'Codex: the rebuttal holds'): Finding => ({
  ...f,
  needsRecheck: undefined,
  history: [...f.history, { round, status: 'rebutted', note, by: 'codex', at }],
})

/** How many times Codex rejected a rebuttal of this finding: a Codex `open` entry right after a `rebutted` one. */
export const rejections = (f: Pick<Finding, 'history'>): number =>
  f.history.filter((one, i) => one.by === 'codex' && one.status === 'open' && f.history[i - 1]?.status === 'rebutted').length

/** Rebutted again after Codex rejected a rebuttal: a dispute only the person settles; it never goes to Codex again (R40). */
export const isDisputed = (f: Finding): boolean => f.status === 'rebutted' && !isAcceptedRebuttal(f) && rejections(f) > 0

/** The dispute in words: the agent's last argument and Codex's last rejection. */
const disputeOf = (f: Finding): string => {
  const argued = f.history.filter(one => one.status === 'rebutted' && one.by !== 'codex').at(-1)?.note ?? 'no argument recorded'
  const codex = f.history.filter(one => one.status === 'open' && one.by === 'codex').at(-1)?.note ?? 'no reason given'
  return `${f.id} is disputed: the agent says "${argued}"; Codex said "${codex}"`
}

/**
 * What keeps a PR from merging (R39): every finding of either phase, at any severity, that is open, deferred,
 * reported fixed without verification, or rebutted without Codex accepting it, unless the person waived it.
 * The controller's ready and the merge guard both read this, so they never disagree.
 */
export function mergeHolds(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => !waived.has(one.id) && one.status !== 'verified-fixed' && !isAcceptedRebuttal(one))
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
  /** answer: the findings the agent can settle on the same head (R37); a resume re-opens triage for them. */
  | { kind: 'blocked'; why: string; nextStep: string; answer?: string[]; recheck?: string[] }
  /** Only deferrals stand between the PR and the merge: the person decides (R39). */
  | { kind: 'awaiting-decision'; why: string; nextStep: string }

const ids = (findings: readonly Finding[]): string => findings.map(one => one.id).join(', ')

function decidePre(rec: LifecycleRecord): Next {
  const last = rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).at(-1)
  // Never a pass while any blocker in the ledger is unresolved, whichever round raised it. Before the PR opens,
  // a security fix only reported fixed counts as unresolved too, until a check confirms it.
  const unresolved = [...unresolvedBlockers(rec), ...verificationOwed(rec).filter(one => one.isSecurity === true)]
  const passOr = (): Next => {
    if (unresolved.length === 0) return { kind: 'open-pr', status: 'passed' }
    if (unresolved.every(one => one.status === 'deferred')) {
      return {
        kind: 'blocked',
        why: `${ids(unresolved)} deferred, and a security P1 needs your decision`,
        nextStep: `/pr-gate waive ${unresolved[0]?.id} <reason>`,
      }
    }
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'open-pr', status: 'exhausted' }
  }
  if (last === undefined) {
    return rec.allowance + rec.grants.reduce((sum, one) => sum + one.n, 0) > 0
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : passOr()
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
    if (unresolved.length > 0) return passOr()
    // Advisories go back to Codex only for new commits, and only while a round stays in reserve.
    return last.raised.advisory > 0 && isChanged && mayStartRound(rec, true)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: true, scope: 'full' }
      : passOr()
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
  // The merge test (R39): every finding of either phase, at any severity, verified fixed or rebutted with Codex accepting.
  const holding = mergeHolds(rec)
  const owed = holding.filter(one => one.status === 'reported-fixed')
  // A dispute is the person's (R40); every other rebuttal Codex has not accepted is Codex's to check.
  const disputed = holding.filter(isDisputed)
  const unchecked = holding.filter(one => one.status === 'rebutted' && !isDisputed(one))
  const open = holding.filter(one => one.status === 'open')
  const deferred = holding.filter(one => one.status === 'deferred')
  // The protected baseline: a second round whenever the first one changed the head, by anyone. A later push does not spend the allowance on it.
  if (done.length === 1 && isChanged) return { kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' }
  // A push after the last completed round (a fix after ready or exhaustion, someone else's commit): review that head.
  if (rec.head !== last.endHead) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'round', phase: 'post', roundKind: 'final-head-check', isAdvisory: false, scope: 'delta' }
  }
  // On an unchanged head, what the agent can answer, and Codex's free rebuttal check, come before the final-head check's verdict (R43).
  // The pre-PR backstop (R32), at any severity (R39): findings left open on an unchanged head; another round would say the same.
  if (!isChanged && open.length > 0) {
    // A rebuttal Codex did not accept is said as such (M2), not as an unanswered finding; it may be fixed or deferred, not rebutted again (R40).
    const rejected = open.filter(one => rejections(one) > 0)
    const ignored = open.filter(one => !rejected.includes(one))
    const isFeedbackOnly = ignored.length > 0 && rejected.length === 0 && open.every(one => one.source === 'github' && !isBlocking(one))
    const codexSaid = (one: Finding): string => one.history.filter(each => each.by === 'codex').at(-1)?.note ?? 'no reason given'
    const said = [
      ...rejected.map(one => `Codex did not accept the rebuttal of ${one.id}: ${codexSaid(one)}`),
      ...(ignored.length === 0
        ? []
        : isFeedbackOnly
          ? [`${ids(ignored)} from reviewers ${ignored.length === 1 ? 'has' : 'have'} no answer`]
          : [`${ids(ignored)} left open at ${last.endHead.slice(0, 7)} with no fix or rebuttal, so another round would say the same`]),
    ]
    const steps = isFeedbackOnly
      ? [`answer ${ids(open)} in ${open.length === 1 ? 'its thread' : 'their threads'} (fix, rebut or defer)`]
      : [...(ignored.length === 0 ? [] : [`fix or rebut ${ids(ignored)}`]), ...(rejected.length === 0 ? [] : [`fix or defer ${ids(rejected)}`])]
    return { kind: 'blocked', why: said.join('; '), nextStep: `${steps.join('; ')}, then /pr-gate resume`, answer: open.map(one => one.id) }
  }
  // A rebuttal Codex has not ruled on (its check was held, or it came from before the PR): Codex checks it on this head, free.
  const recheck = (): Next => ({
    kind: 'blocked',
    why: `Codex has not checked the rebuttal of ${ids(unchecked)} on ${last.endHead.slice(0, 7)}`,
    nextStep: 'run /pr-gate resume: Codex checks the rebuttal on this head, using no review round',
    recheck: unchecked.map(one => one.id),
  })
  if (!isChanged && unchecked.length > 0) return recheck()
  if (last.kind === 'final-head-check') {
    if (!isChanged && holding.length === 0) return { kind: 'ready' }
    if (!isChanged && deferred.length + disputed.length === holding.length) return awaiting(deferred, disputed)
    return {
      kind: 'exhausted',
      why: unresolved.length > 0 ? `${ids(unresolved)} unresolved at ${last.endHead.slice(0, 7)}` : `${last.endHead.slice(0, 7)} is not reviewed clean`,
      nextStep:
        unresolved.length > 0
          ? `fix ${ids(unresolved)} and push, then /pr-gate resume`
          : 'tell the person the final head is not reviewed clean; a new round needs their allowance',
    }
  }
  if (isChanged || owed.length > 0) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'round', phase: 'post', roundKind: 'final-head-check', isAdvisory: false, scope: 'delta' }
  }
  if (unchecked.length > 0) return recheck()
  if (holding.length === 0) return { kind: 'ready' }
  return awaiting(deferred, disputed)
}

/** Deferrals are honest answers, and a dispute is the agent's word against Codex's: only the person's waiver lets either into the merge (R39, R40). */
function awaiting(deferred: readonly Finding[], disputed: readonly Finding[] = []): Next {
  const all = [...deferred, ...disputed]
  const one = all.length === 1
  const are = (list: readonly Finding[], word: string): string[] => (list.length === 0 ? [] : [`${ids(list)} ${list.length === 1 ? 'is' : 'are'} ${word}`])
  const what = [...are(deferred, 'deferred'), ...disputed.map(disputeOf)].join('; ')
  const told = [...are(deferred, 'deferred'), ...are(disputed, 'disputed')]
  return {
    kind: 'awaiting-decision',
    why: `${what}; only the person's waiver lets ${one ? 'it' : 'them'} into the merge`,
    nextStep: `tell the person ${told.join(' and ')} and why, then stop: only their waiver settles ${one ? 'it' : 'them'}`,
  }
}

/** What the controller does after a round, from the record alone. Exhaustion is never a pass. */
export function decideNext(rec: LifecycleRecord): Next {
  // Ready holds only for the head it was reached at: a later push continues the lifecycle.
  // It never holds over an unresolved blocker or a fix still owed its check, whatever wrote them after ready.
  if (rec.phase === 'ready' && rec.head === lastReviewedHead(rec) && mergeHolds(rec).length === 0) return { kind: 'ready' }
  return rec.phase === 'pre' ? decidePre(rec) : decidePost(rec)
}
