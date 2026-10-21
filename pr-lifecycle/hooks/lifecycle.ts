// The lifecycle's pure half: the budget, the finding ledger, coverage, and
// the controller's choice of what comes next. No `$` here.

import type { Blocker, CheckState, Finding, FindingStatus, Lane, LifecycleRecord, RoundKind, RoundRecord, Severity, Standing, Tier, Waiver } from '../types'

// ----------------------------------------------------------------- budget

export type Allowances = { standard: number; high: number; light: number }

const TIERS: readonly Tier[] = ['trivial', 'standard', 'high']

/**
 * Discretionary rounds a lifecycle may complete: by tier, the light lane's own (Adam, decision C), none for a pass-through. A high
 * blast radius always gets its own allowance: the branch name never lowers it (finding 4).
 */
export function allowanceFor(tier: Tier, lane: Lane, a: Allowances): number {
  if (tier === 'trivial') return 0
  if (lane === 'light' && tier !== 'high') return a.light
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
  // A high blast radius takes the full lane whatever the branch is called (R75).
  const lane = tier === 'high' ? 'full' : rec.lane
  return { ...rec, tier, tierWhy: why, lane, allowance: Math.max(rec.allowance, allowanceFor(tier, lane, a)) }
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

const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** A GitHub item the agent may answer "no change requested" (R82): no security flag, and no explicit P0-P2 from the reviewer. */
export const mayAcknowledge = (f: Finding): boolean =>
  f.source === 'github' && f.isSecurity !== true && !(f.severitySource === 'tag' && RANK[f.severity] <= 2)

/** Raised in this round, or held open again by this round's reviewer: what the round's fix step answers. */
export const raisedIn = (finding: Pick<Finding, 'round' | 'history'>, round: number): boolean =>
  finding.round === round || finding.history.some(one => one.round === round && one.status === 'open')

// ----------------------------------------------------------------- ledger

export type Answer = {
  id: string
  action: 'fixed' | 'rebutted' | 'deferred' | 'acknowledged'
  note?: string
  evidence?: string
  severity?: Severity
  isSecurity?: boolean
  followUp?: string
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

/**
 * The fixer's word: fixed is only reported until a check confirms it. A fixer cannot lower a severity a reviewer or Codex set;
 * disagreement is a rebuttal. A severity only guessed from a GitHub comment's words takes the triaged one, up or down (R84).
 */
export function applyAnswer(f: Finding, a: Answer, round: number, by: string, at: number): Finding {
  const status: FindingStatus = a.action === 'fixed' ? 'reported-fixed' : a.action === 'acknowledged' ? 'rebutted' : a.action
  const next = moved(f, status, round, by, at, a.note, a.evidence)
  const isGuessed = f.severitySource === 'hint'
  const severity = a.severity === undefined ? f.severity : isGuessed || RANK[a.severity] < RANK[f.severity] ? a.severity : f.severity
  const security = f.isSecurity === true || a.isSecurity === true
  const history = severity === f.severity ? next.history : next.history.map((one, i) => (i === next.history.length - 1 ? { ...one, severity } : one))
  return { ...next, severity, history, ...(security ? { isSecurity: true } : {}),
    ...(a.action === 'deferred' && a.followUp !== undefined ? { followUp: a.followUp } : {}) }
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

/** The lines a change touched, per file: each hunk's old and new ranges, both, since a finding's line may predate either side. */
export type ChangedLines = ReadonlyMap<string, readonly (readonly [number, number])[]>

/** How far from a finding's line a change still reopens it (R58, narrowed by R73): lines drift as a file is edited around them. */
export const RECHECK_WINDOW = 20

/**
 * `git diff --unified=0` as the lines it touched, per file (R73). A binary file gets the whole file: what cannot be read as lines
 * is not narrowed. A mode-only change touches no line, so it reopens nothing.
 */
export function changedLines(diff: string): Map<string, [number, number][]> {
  return readDiff(diff).lines
}

/** Per file, each hunk's old start, old length and the lines it adds or removes: what shifts the lines below it (R73). */
export type LineMoves = ReadonlyMap<string, readonly (readonly [number, number, number])[]>

/** `git diff --unified=0` read once: the lines it touched (`changedLines`) and how it moved the lines it did not touch. */
export function readDiff(diff: string): { lines: Map<string, [number, number][]>; moves: Map<string, [number, number, number][]> } {
  const out = new Map<string, [number, number][]>()
  const moves = new Map<string, [number, number, number][]>()
  let file: string | undefined
  let from: string | undefined
  // File headers come between `diff --git` and the first hunk: inside a hunk, a removed `-- comment` line reads as `--- comment`.
  let isHeader = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = undefined
      from = undefined
      isHeader = true
      continue
    }
    if (line.startsWith('@@')) isHeader = false
    if (isHeader && line.startsWith('--- ')) from = line === '--- /dev/null' ? undefined : line.replace(/^--- (a\/)?/, '')
    if (isHeader && line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? from : line.replace(/^\+\+\+ (b\/)?/, '')
      if (file !== undefined && !out.has(file)) out.set(file, [])
      continue
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk === null || file === undefined) {
      const binary = line.match(/^Binary files (?:a\/)?(\S+) and (?:b\/)?(\S+) differ$/)
      if (binary !== null) out.set(binary[2] === '/dev/null' ? (binary[1] ?? '') : (binary[2] ?? ''), [[1, Number.MAX_SAFE_INTEGER]])
      continue
    }
    const span = (start: string | undefined, count: string | undefined): [number, number] => {
      const a = Number(start)
      const n = count === undefined ? 1 : Number(count)
      return [a, a + Math.max(n, 1) - 1]
    }
    out.get(file)?.push(span(hunk[1], hunk[2]), span(hunk[3], hunk[4]))
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2])
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4])
    moves.set(file, [...(moves.get(file) ?? []), [Number(hunk[1]), oldCount, newCount - oldCount]])
  }
  return { lines: out, moves }
}

/** Where an old line is after a change: shifted by every hunk wholly above it. An insertion (`-n,0`) comes after line n. */
export function moveLine(line: number, moves: readonly (readonly [number, number, number])[]): number {
  return moves.reduce((at, [start, count, delta]) => ((count === 0 ? start < line : start + count - 1 < line) ? at + delta : at), line)
}

/**
 * The head moved to `to` (R73): each finding is read against the head its line was last placed at (`lineHead`, else `from`), so
 * shifts from earlier commits carry over. A change near it reopens it (`invalidate`); otherwise its line moves with the code, and
 * `lineHead` becomes `to`. A diff git could not give reopens the finding and leaves its line where it was.
 */
export function relocate(
  findings: readonly Finding[],
  from: string | undefined,
  to: string,
  diffs: ReadonlyMap<string, { lines: ChangedLines; moves: LineMoves } | 'all'>,
): Finding[] {
  return findings.map(one => {
    const base = one.lineHead ?? from
    if (base === to) return one
    const diff = base === undefined ? 'all' : (diffs.get(base) ?? 'all')
    if (diff === 'all') return invalidate([one], 'all')[0] ?? one
    const flagged = invalidate([one], diff.lines)[0] ?? one
    const line = flagged.line === undefined || flagged.file === undefined ? undefined : moveLine(flagged.line, diff.moves.get(flagged.file) ?? [])
    return { ...flagged, ...(line === undefined ? {} : { line }), lineHead: to }
  })
}

const touches = (one: Finding, changed: ReadonlySet<string> | ChangedLines | 'all'): boolean => {
  if (changed === 'all') return true
  if (one.file === undefined) return false
  if (changed instanceof Set) return changed.has(one.file)
  const ranges = (changed as ChangedLines).get(one.file)
  if (ranges === undefined) return false
  // A finding with no line, or a file git showed no hunk for, is reopened by any change to its file (R58).
  if (one.line === undefined || ranges.length === 0) return true
  const line = one.line
  return ranges.some(([a, b]) => a <= line + RECHECK_WINDOW && b >= line - RECHECK_WINDOW)
}

/**
 * The findings the person waived. A waiver lapses when its finding's file changed after it was given (R50, R55): the lapse is
 * recorded on the waiver itself, so no later round brings it back. The finding holds again until the person waives it anew.
 */
export const waivedIds = (rec: Pick<LifecycleRecord, 'waivers'>): Set<string> =>
  new Set(rec.waivers.flatMap(one => (one.scope === 'finding' && one.findingId !== undefined && one.lapsedAt === undefined ? [one.findingId] : [])))

/**
 * Finding waivers whose finding's file changed between the waiver's head and `head` are marked lapsed (R55). `changedSince` gives
 * the files changed from a waiver's head, or 'all' when git could not say.
 */
export function lapseWaivers(
  waivers: readonly Waiver[],
  findings: readonly Finding[],
  changedSince: (from: string) => ReadonlySet<string> | 'all',
  head: string,
  at: number,
): Waiver[] {
  return waivers.map(one => {
    if (one.scope !== 'finding' || one.lapsedAt !== undefined || one.head === head) return one
    const finding = findings.find(each => each.id === one.findingId)
    return finding !== undefined && touches(finding, changedSince(one.head)) ? { ...one, lapsedAt: at, lapsedHead: head } : one
  })
}

/** Blocking findings deferred and not waived: before the PR, a deferral past the branch waits on the person's waiver of it. */
const deferredBlockers = (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] => {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => isBlocking(one) && one.status === 'deferred' && !waived.has(one.id))
}

/** Blockers nobody settled: open ones, and a deferred security P1, which only the person's waiver settles. */
export function unresolvedBlockers(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(
    one => isBlocking(one) && !waived.has(one.id) && (one.status === 'open' || (one.status === 'deferred' && one.isSecurity === true)),
  )
}

/** A verified fix whose file changed since: Codex re-verifies it on the current head before it settles anything again (R58). */
export const isReverifyOwed = (f: Pick<Finding, 'status' | 'needsRecheck'>): boolean => f.status === 'verified-fixed' && f.needsRecheck === true

/** Blockers the fixer reported fixed that no check has confirmed yet, and verified fixes whose file changed since (R58). */
export function verificationOwed(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => isBlocking(one) && !waived.has(one.id) && (one.status === 'reported-fixed' || isReverifyOwed(one)))
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

/**
 * What the gate's own Codex check rules on (Adam, decision A; R36, R58, R72): rebuttals Codex has not accepted, short of a dispute
 * (R40); verified fixes whose file changed since (R58); and fixes only reported, at any severity, advisories included. A deferral is
 * the person's to release (R45), never Codex's.
 */
export const checksOwed = (findings: readonly Finding[]): Finding[] =>
  findings.filter(one => (one.status === 'rebutted' && !isAcceptedRebuttal(one) && !isDisputed(one)) || isReverifyOwed(one) || one.status === 'reported-fixed')

/** The dispute in words: the agent's last argument and Codex's last rejection. */
const disputeOf = (f: Finding): string => {
  const argued = f.history.filter(one => one.status === 'rebutted' && one.by !== 'codex').at(-1)?.note ?? 'no argument recorded'
  const codex = f.history.filter(one => one.status === 'open' && one.by === 'codex').at(-1)?.note ?? 'no reason given'
  return `${f.id} is disputed: the agent says "${argued}"; Codex said "${codex}"`
}

/** A P3 deferred with its follow-up recorded, not security: settled without the person's waiver (R85, decision I). */
export const isSettledDeferral = (f: Finding): boolean =>
  f.status === 'deferred' && f.severity === 'P3' && f.isSecurity !== true && f.followUp !== undefined && f.followUp.trim() !== ''

/**
 * What keeps a PR from merging (R39): every finding of either phase, at any severity, that is open, deferred,
 * reported fixed without verification, verified fixed but its file changed since (R58), or rebutted without Codex
 * accepting it, unless the person waived it. The controller's ready and the merge guard both read this, so they never disagree.
 */
export function mergeHolds(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => !waived.has(one.id) && (one.status !== 'verified-fixed' || isReverifyOwed(one)) && !isAcceptedRebuttal(one) && !isSettledDeferral(one))
}

/** A held verified fix in words, as the merge refusal and the texts name it (R58). */
export const reverifyOwed = (f: Pick<Finding, 'id' | 'severity'>): string => `${f.id} [${f.severity}] fixed, re-verify owed (file changed)`

/** Security P1s that hold the merge: only a waiver naming each one releases it, never `waive post` (spec §3). */
export const securityHolds = (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] =>
  mergeHolds(rec).filter(one => isBlocking(one) && one.isSecurity === true)

const short = (sha: string): string => sha.slice(0, 7)

/** One finding that holds the merge, as a blocker with its owner and the step that clears it (R79). */
function blockerOf(f: Finding): Blocker {
  const tag = `${f.id} [${f.severity}]${f.isSecurity === true ? ' security' : ''} ${f.title}`
  const waive = `/pr-gate waive ${f.id} <reason>`
  const isSecurityP1 = isBlocking(f) && f.isSecurity === true
  if (isDisputed(f)) return { kind: 'disputed', id: f.id, said: `${tag}: disputed`, owner: 'person', release: waive }
  if (f.status === 'deferred') return { kind: isSecurityP1 ? 'security-p1' : 'deferred', id: f.id, said: `${tag}: deferred`, owner: 'person', release: waive }
  if (isReverifyOwed(f)) {
    return { kind: 'reverify-owed', id: f.id, said: `${tag}: fixed, re-verify owed (file changed)`, owner: 'codex', release: "the gate's Codex check re-verifies it" }
  }
  if (f.status === 'reported-fixed') {
    return { kind: 'verify-owed', id: f.id, said: `${tag}: fixed, verification owed`, owner: 'codex', release: "the gate's Codex check verifies it" }
  }
  if (f.status === 'rebutted') {
    return { kind: 'rebuttal-unchecked', id: f.id, said: `${tag}: rebuttal not yet accepted`, owner: 'codex', release: "the gate's Codex check rules on it" }
  }
  return { kind: isSecurityP1 ? 'security-p1' : 'open', id: f.id, said: `${tag}: open`, owner: 'agent', release: 'fix it, or rebut it with file:line evidence' }
}

/**
 * Everything between this head and its merge (R79): findings, the head's own review, and CI, with nothing short-circuited. A post
 * waiver for this head and base leaves only a security P1 and CI; CI a waiver covers is only what GitHub does not require (R86).
 */
export function standingOf(rec: LifecycleRecord, at: { head: string; base: string }, ci?: readonly CheckState[] | 'unreadable' | { unreadable: string }): Standing {
  const phase = rec.phase === 'pre' ? 'pre' : 'post'
  const isOnBase = rec.base === at.base
  const waiver = isOnBase ? rec.waivers.find(one => one.scope === phase && one.head === at.head && (phase === 'post' || one.base === at.base)) : undefined
  const security = securityHolds(rec)
  const isWaived = waiver !== undefined && security.length === 0
  const blockers: Blocker[] = (isWaived ? [] : mergeHolds(rec)).map(blockerOf)
  if (!isOnBase && phase === 'post') {
    blockers.push({ kind: 'retargeted', said: `reviewed for ${rec.base}, but the PR now targets ${at.base}`, owner: 'person', release: `point it back at ${rec.base}, or /pr-gate reset` })
  }
  if (!isWaived && phase === 'post') {
    const next = decideNext(rec)
    if (next.kind === 'round') blockers.push({ kind: 'round-owed', said: `a review round is owed on ${short(at.head)}`, owner: 'gate', release: 'the gate runs it; leave the branch alone' })
    if (next.kind === 'exhausted') {
      // Its id lets a text that already gives this reason as its own leave it out (holdText's `named`).
      blockers.push({ kind: 'head-unreviewed', id: 'head', said: next.why, owner: 'person', release: '/pr-gate allow 1 <reason>, or /pr-gate waive post <reason>' })
    }
  }
  const setAside: string[] = []
  if (ci === 'unreadable' || (ci !== undefined && 'unreadable' in ci)) {
    const why = typeof ci === 'object' && 'unreadable' in ci ? ci.unreadable : ''
    blockers.push({ kind: 'ci-unreadable', ...(why === '' ? {} : { detail: why }), said: `the CI checks on ${short(at.head)} could not be read${why === '' ? '' : ` (${why})`}`, owner: 'agent', release: 'check gh auth status and the network, then try again' })
  } else {
    for (const one of ci ?? []) {
      const isBad = one.bucket === 'fail' || one.bucket === 'cancel'
      if (!isBad && (one.bucket === 'pass' || one.bucket === 'skipping')) continue
      if (isWaived && !one.isRequired) {
        setAside.push(one.name)
        continue
      }
      blockers.push(
        isBad
          ? { kind: 'ci-failing', id: one.name, said: `check ${one.name} ${one.bucket === 'cancel' ? 'cancelled' : 'failing'}`, owner: 'agent', release: 'fix what it reports and push, or rerun it (gh run rerun <run-id> --failed)' }
          : { kind: 'ci-running', id: one.name, said: `check ${one.name} running`, owner: 'gate', release: `wait for it (gh pr checks ${rec.pr ?? ''} --watch)` },
      )
    }
  }
  return { phase, head: at.head, ...(waiver === undefined ? {} : { waiver }), setAside, mayProceed: blockers.length === 0, blockers }
}

const OWNERS: Record<Blocker['owner'], string> = { agent: 'yours', codex: 'the gate (Codex)', person: "the person's", gate: 'the gate' }

/** The standing in words (R79): every blocker once, skipping ids the text around it already named, with who acts and how. */
export function holdText(s: Standing, named: ReadonlySet<string> = new Set()): string {
  const what = s.phase === 'pre' ? 'pull request' : 'merge'
  const aside = s.setAside.length === 0 ? [] : [`Set aside by the post waiver (GitHub does not require them): ${s.setAside.join(', ')}.`]
  if (s.blockers.length === 0) return [...aside, `Nothing else holds the ${what} of ${short(s.head)}.`].join('\n')
  const rest = s.blockers.filter(one => one.id === undefined || !named.has(one.id))
  if (rest.length === 0) return aside.join('\n')
  const heading = named.size > 0 ? 'Also holding:' : `Everything between ${short(s.head)} and the ${what}:`
  return [...aside, heading, ...rest.map(one => `- ${one.said} (${OWNERS[one.owner]}: ${one.release})`)].join('\n')
}

// --------------------------------------------------------------- coverage

/** The head the last completed round left behind: what review evidence covers. */
export const lastReviewedHead = (rec: Pick<LifecycleRecord, 'rounds'>): string | undefined =>
  rec.rounds.filter(one => one.isCompleted).at(-1)?.endHead

/**
 * The last head a reviewer read in full: the latest complete evidence of a completed round (R60). A round's end head can hold
 * commits pushed while it was answered, which nobody reviewed, so a Codex review's base is this head, not `lastReviewedHead`.
 */
export const lastCoveredHead = (rec: Pick<LifecycleRecord, 'rounds'>): string | undefined =>
  rec.rounds.filter(one => one.isCompleted).flatMap(one => one.evidence.filter(each => each.isComplete)).at(-1)?.head

/**
 * Answered findings a change touched: their evidence must be checked again. With line ranges (R73), only a change within
 * RECHECK_WINDOW lines of the finding counts; with file names, any change to its file. History stays. (A waiver's lapse is
 * `lapseWaivers`, by file.)
 */
export function invalidate(findings: readonly Finding[], changedFiles: ReadonlySet<string> | ChangedLines | 'all'): Finding[] {
  return findings.map(one => (one.status !== 'open' && touches(one, changedFiles) ? { ...one, needsRecheck: true } : one))
}

// --------------------------------------------------------------- the next step

export type Next =
  | { kind: 'round'; phase: 'pre' | 'post'; roundKind: RoundKind; isAdvisory: boolean; scope: 'full' | 'delta' }
  | { kind: 'open-pr'; status: 'passed' | 'exhausted' }
  | { kind: 'ready' }
  | { kind: 'exhausted'; why: string; nextStep: string }
  /** answer: the findings the agent can settle on the same head (R37, R63); a resume re-opens triage, or the pre-PR fix step, for them. */
  | { kind: 'blocked'; why: string; nextStep: string; answer?: string[]; recheck?: string[] }
  /** Only deferrals stand between the PR and the merge: the person decides (R39). */
  | { kind: 'awaiting-decision'; why: string; nextStep: string }

const ids = (findings: readonly Finding[]): string => findings.map(one => one.id).join(', ')

function decidePre(rec: LifecycleRecord): Next {
  const last = rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).at(-1)
  // Never a pass while any blocker in the ledger is unresolved, whichever round raised it. Before the PR opens,
  // a security fix only reported fixed counts as unresolved too, until a check confirms it.
  // A verified fix whose file changed since is owed its re-verification too (R58): the next Codex review carries the note.
  const unresolved = [...unresolvedBlockers(rec), ...verificationOwed(rec).filter(one => one.isSecurity === true || isReverifyOwed(one))]
  const passOr = (): Next => {
    if (unresolved.length === 0) return { kind: 'open-pr', status: 'passed' }
    if (unresolved.every(one => one.status === 'deferred')) {
      // The person's decision (R49): the agent's step is to tell them and stop, never to type their command.
      const one = unresolved.length === 1
      return {
        kind: 'blocked',
        why: `${ids(unresolved)} ${one ? 'is a deferred security P1' : 'are deferred security P1s'}, which only the person's waiver settles`,
        nextStep: `tell the person ${ids(unresolved)} ${one ? 'is a deferred security P1' : 'are deferred security P1s'} and why, then stop`,
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
  // Commits since the last completed round, or another base since: the new scope needs its own review.
  if (rec.head !== last.endHead || (last.base !== undefined && last.base !== rec.base)) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'open-pr', status: 'exhausted' }
  }
  const isChanged = last.endHead !== last.startHead
  const waived = waivedIds(rec)
  // The round's blockers are each waived by the person, and nothing else is unresolved or owed: no round is left to run (R48).
  const raised = rec.findings.filter(one => isBlocking(one) && raisedIn(one, last.n))
  // New commits since the round started still get their own review while a round is left (R52).
  if (raised.length > 0 && raised.every(one => waived.has(one.id)) && unresolved.length === 0 && verificationOwed(rec).length === 0) {
    return isChanged && mayStartRound(rec, false) ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' } : passOr()
  }
  // Released only when the ledger holds the deferred blockers and the person waived every one.
  const deferred = deferredBlockers(rec)
  const isAllWaived = deferred.length === 0 && rec.findings.some(one => isBlocking(one) && one.status === 'deferred')
  if (last.deferredBlocking > 0 && !isAllWaived) {
    const named = deferred.length === 0 ? 'the deferred finding' : ids(deferred)
    const one = deferred.length <= 1
    return {
      kind: 'blocked',
      why: `${named} ${one ? 'was' : 'were'} deferred: ${one ? 'its' : 'their'} fix reaches past this branch`,
      nextStep: `tell the person ${named} ${one ? 'is' : 'are'} deferred and why, then stop: only their waiver settles ${one ? 'it' : 'them'}`,
    }
  }
  if (last.raised.blocking === 0) {
    if (unresolved.length > 0) return passOr()
    // Advisories go back to Codex only for new commits, and only while a round stays in reserve.
    return last.raised.advisory > 0 && isChanged && mayStartRound(rec, true)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: true, scope: 'full' }
      : passOr()
  }
  // A rebuttal of the round's findings given since, in a resumed fix step (R63), goes to Codex in the next round, as any rebuttal does.
  const isRebutted = rec.findings.some(one => raisedIn(one, last.n) && one.status === 'rebutted' && !isAcceptedRebuttal(one))
  if (!isChanged && last.rebutted === 0 && !isRebutted) {
    const open = rec.findings.filter(one => isBlocking(one) && one.status === 'open' && !waived.has(one.id))
    // Only fixes reported with no commit since (an answer run, R63): there is nothing new to review until the fix is committed (R66).
    const owed = verificationOwed(rec).filter(one => one.status === 'reported-fixed')
    if (open.length === 0 && owed.length > 0) {
      const one = owed.length === 1
      return {
        kind: 'blocked',
        why: `${ids(owed)} ${one ? 'is' : 'are'} reported fixed with no commit since the last round, so there is nothing new to review`,
        nextStep: `commit the fix for ${ids(owed)}, then /pr-gate resume`,
      }
    }
    return {
      kind: 'blocked',
      why: 'the fixer changed nothing and rebutted nothing, so another round would say the same',
      nextStep: `fix or rebut ${open.length === 0 ? 'the open findings' : ids(open)}, then /pr-gate resume`,
      // A resume re-opens the fix step for them on this head, using no round (R63, the pre-PR twin of R37).
      ...(open.length === 0 ? {} : { answer: open.map(one => one.id) }),
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
  // A verified fix whose file changed is Codex's to re-verify on this head, as free as a rebuttal check (R58).
  const unchecked = holding.filter(one => (one.status === 'rebutted' && !isDisputed(one)) || isReverifyOwed(one))
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
    // A fix Codex re-verified after its file changed and found no longer holds (R58): the agent's to fix or rebut again.
    const refuted = open.filter(one => one.history.at(-1)?.by === 'codex' && one.history.at(-2)?.status === 'verified-fixed')
    const ignored = open.filter(one => !rejected.includes(one) && !refuted.includes(one))
    const isFeedbackOnly =
      ignored.length > 0 && rejected.length + refuted.length === 0 && open.every(one => one.source === 'github' && !isBlocking(one))
    const codexSaid = (one: Finding): string => one.history.filter(each => each.by === 'codex').at(-1)?.note ?? 'no reason given'
    const said = [
      ...rejected.map(one => `Codex did not accept the rebuttal of ${one.id}: ${codexSaid(one)}`),
      ...refuted.map(one => `Codex re-verified ${one.id} after its file changed, and the fix no longer holds: ${codexSaid(one)}`),
      ...(ignored.length === 0
        ? []
        : isFeedbackOnly
          ? [`${ids(ignored)} from reviewers ${ignored.length === 1 ? 'has' : 'have'} no answer`]
          : [`${ids(ignored)} left open at ${last.endHead.slice(0, 7)} with no fix or rebuttal, so another round would say the same`]),
    ]
    const steps = isFeedbackOnly
      ? [`answer ${ids(open)} in ${open.length === 1 ? 'its thread' : 'their threads'} (fix, rebut or defer)`]
      : [
          ...(ignored.length + refuted.length === 0 ? [] : [`fix or rebut ${ids([...refuted, ...ignored])}`]),
          ...(rejected.length === 0 ? [] : [`fix or defer ${ids(rejected)}`]),
        ]
    return { kind: 'blocked', why: said.join('; '), nextStep: `${steps.join('; ')}, then /pr-gate resume`, answer: open.map(one => one.id) }
  }
  // A rebuttal Codex has not ruled on (its check was held, or it came from before the PR): Codex checks it on this head, free.
  const recheck = (): Next => {
    const rebuttals = unchecked.filter(one => !isReverifyOwed(one))
    const reverify = unchecked.filter(isReverifyOwed)
    const said = [
      ...(rebuttals.length === 0 ? [] : [`Codex has not checked the rebuttal of ${ids(rebuttals)} on ${last.endHead.slice(0, 7)}`]),
      ...reverify.map(reverifyOwed),
    ]
    return {
      kind: 'blocked',
      why: said.join('; '),
      nextStep: `run /pr-gate resume: Codex checks ${reverify.length === 0 ? 'the rebuttal' : 'them'} on this head, using no review round`,
      recheck: unchecked.map(one => one.id),
    }
  }
  if (!isChanged && unchecked.length > 0) return recheck()
  if (last.kind === 'final-head-check') {
    if (!isChanged && holding.length === 0) return { kind: 'ready' }
    // The person allowed more rounds after it: the head it left unreviewed, or a fix only reported, gets a real round.
    if ((isChanged || owed.length > 0) && mayStartRound(rec, false)) {
      return { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
    }
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

// -------------------------------------------------------------------- log

const clockOf = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`
const minutesOf = (ms: number): string => `${Math.round(ms / 60_000)}m`
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** `/pr-gate log`: how a lifecycle went, in a few lines: its rounds and time, the person's steps, the stops, the last events. */
export function logSummary(rec: LifecycleRecord, isArchived: boolean, last = 15): string {
  const log = rec.log ?? []
  const done = rec.rounds.filter(one => one.isCompleted)
  const pre = done.filter(one => one.phase === 'pre').length
  const person = log.filter(one => one.kind === 'person')
  const verbs = new Map<string, number>()
  for (const one of person) {
    const verb = one.text.split(/\s+/)[1] ?? '?'
    verbs.set(verb, (verbs.get(verb) ?? 0) + 1)
  }
  const stops = log.filter(one => one.kind === 'stop')
  const lines = [
    `${rec.branch}${rec.pr === undefined ? '' : ` (PR #${rec.pr})`} → ${rec.base}: ${isArchived ? 'archived' : rec.phase}.`,
    `Rounds: ${done.length} completed (${pre} pre-PR, ${done.length - pre} post-PR), ${plural(rec.attempts, 'incomplete attempt')}. ` +
      `Active ${minutesOf(rec.activeMs)}, waiting ${minutesOf(rec.waitMs)}.`,
    person.length === 0
      ? 'The person stepped in 0 times.'
      : `The person stepped in ${plural(person.length, 'time')}: ${[...verbs].map(([verb, n]) => `${verb} ${n}`).join(', ')}.`,
    `Stops: ${stops.length}${stops.length === 0 ? '' : `; the last: ${stops.at(-1)?.text ?? ''}`}.`,
  ]
  if (log.length === 0) lines.push('No events logged: the record is from before 1.3.0.')
  else lines.push('Last events:', ...log.slice(-last).map(one => `  ${clockOf(one.at)} ${one.kind.padEnd(7)} ${one.text}`))
  return lines.join('\n')
}
