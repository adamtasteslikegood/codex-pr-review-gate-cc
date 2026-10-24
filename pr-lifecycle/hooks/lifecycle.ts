// The lifecycle's pure half: the budget, the finding ledger, coverage, and
// the controller's choice of what comes next. No `$` here.

import type {
  Blocker, CheckState, Finding, FindingEvent, FindingStatus, Grant, Lane, LifecycleRecord, RoundKind, RoundRecord, Severity, Standing, Tier, Waiver,
} from '../types'

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

/**
 * Rounds that drew on the allowance: completed discretionary ones. A post round from 1.5.0 counts only when it was charged (R88);
 * a pre round, and a round from an older record, always count. Baseline rounds, final-head checks and incomplete attempts use nothing.
 */
export const usedRounds = (rec: Pick<LifecycleRecord, 'rounds'>): number =>
  rec.rounds.filter(one => one.isCompleted && one.kind === 'discretionary' && (one.phase === 'pre' || one.isCharged !== false)).length

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

/** A fresh lifecycle id (#29): random, so no two checkouts or lifecycles share one. */
export const newLifecycleId = (): string => crypto.randomUUID()

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
    lifecycleId: newLifecycleId(),
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

/**
 * A finding's history without a link's severity raise (A9): the answers, rulings and holds every status reader reads. The raise
 * copies the status, so read as an entry it would put a new gate 'rebutted' last and move Codex's acceptance, the rebuttal's time
 * (R33) and the acknowledgement off the end.
 */
export const answersOf = (f: Pick<Finding, 'history'>): FindingEvent[] => f.history.filter(one => one.raisedBy === undefined)

/**
 * The link's raise a rebuttal's, or an agreed deferral's (R92 M2), re-check is owed for (6b fix 1): the newest raise entry, when it
 * comes after Codex's last ruling. Otherwise the re-check, if any, is for a file change (R58).
 */
export function raiseOf(f: Pick<Finding, 'history' | 'status' | 'needsRecheck'>): FindingEvent | undefined {
  if (f.needsRecheck !== true || (f.status !== 'rebutted' && f.status !== 'deferred')) return undefined
  let raise = -1
  let ruled = -1
  f.history.forEach((one, i) => {
    if (one.raisedBy !== undefined) raise = i
    else if (one.by === 'codex') ruled = i
  })
  return raise > ruled ? f.history[raise] : undefined
}

/** The agent's answers Codex can reject. */
const REJECTABLE: readonly FindingStatus[] = ['reported-fixed', 'verified-fixed', 'rebutted', 'deferred']

/**
 * Whether a post round costs one (R88): a blocking finding first raised in it, or Codex reopening, in it, a finding the agent had
 * answered (a fix, a rebuttal, an acknowledgement, a deferral). A rejected fix still uses a round, because it does. Or the agent
 * reported a fix in it, of any finding at any severity, raised in it or earlier (A8: "charge the push that fixes last round's
 * findings"); a triage answer is stamped with the round that asked, which the push then ends. A linked duplicate's fix charges
 * nothing. A rebuttal, deferral or acknowledgement of a non-blocking finding stays free, and a round is charged once, whatever the reasons.
 */
export function isChargedRound(findings: readonly Finding[], round: number): boolean {
  // A linked duplicate is not new (R90): it holds through its original.
  const isNewBlocker = findings.some(one => one.round === round && isBlocking(one) && one.duplicateOf === undefined)
  // The agent's fix (main's, or the fixer's) of any finding, whenever raised; never a gate or Codex entry, nor a linked duplicate's fix.
  const isFixed = findings.some(one =>
    one.duplicateOf === undefined &&
    answersOf(one).some(each => each.round === round && each.status === 'reported-fixed' && each.by !== 'codex' && each.by !== 'gate'),
  )
  // Codex refusing the agent's link rejects no answer (R90): the item was never answered.
  const isRejected = findings.some(one =>
    answersOf(one).some((each, i, all) =>
      each.round === round && each.by === 'codex' && each.status === 'open' && each.refusedLink === undefined &&
      i > 0 && REJECTABLE.includes(all[i - 1]?.status ?? 'open'),
    ),
  )
  return isNewBlocker || isRejected || isFixed
}

const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

const higher = (a: Severity, b: Severity): Severity => (RANK[a] <= RANK[b] ? a : b)

/**
 * The highest severity a finding had during the gate (R85, P0 highest): what its follow-up issue is labelled with. A record from
 * before peakSeverity existed reads it from its severity and every severity its history names.
 */
export const peakOf = (f: Pick<Finding, 'severity' | 'peakSeverity' | 'history'>): Severity =>
  f.history.reduce<Severity>(
    (top, one) => [one.severity, one.from].reduce<Severity>((at, each) => (each === undefined ? at : higher(at, each)), top),
    higher(f.peakSeverity ?? f.severity, f.severity),
  )

/**
 * A record from before peakSeverity whose first severity entry the agent set, naming none before it: the severity the finding was
 * raised at is lost, so its peak, and the label its issue would carry, are unknown (gate R7-6). It waits for the person, and no
 * later answer makes it known (gate R8-1).
 */
export const isPeakUnknown = (f: Pick<Finding, 'peakSeverity' | 'history'>): boolean => {
  const first = f.history.find(one => one.severity !== undefined)
  return f.peakSeverity === undefined && first !== undefined && first.by !== 'codex' && first.from === undefined
}

/** A GitHub item the agent may answer "no change requested" (R82): no security flag, and no explicit P0-P2 from the reviewer. */
export const mayAcknowledge = (f: Finding): boolean =>
  f.source === 'github' && f.isSecurity !== true && !(f.severitySource === 'tag' && RANK[f.severity] <= 2) &&
  !(f.severityFloor !== undefined && RANK[f.severityFloor] <= 2)

/** Raised in this round, or held open again by this round's reviewer: what the round's fix step answers. */
export const raisedIn = (finding: Pick<Finding, 'round' | 'history'>, round: number): boolean =>
  finding.round === round || answersOf(finding).some(one => one.round === round && one.status === 'open')

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
  const wanted = a.severity === undefined ? f.severity : isGuessed || RANK[a.severity] < RANK[f.severity] ? a.severity : f.severity
  // A guess goes down only as far as the rating a linked tag or Codex gave (`severityFloor`): a guessed P0 linked to a tagged P1 is
  // answered to P1 at the lowest.
  const floor = f.severityFloor
  const isClamped = floor !== undefined && RANK[wanted] > RANK[floor]
  const severity = isClamped ? floor : wanted
  const security = f.isSecurity === true || a.isSecurity === true
  // A changed severity is recorded with the one before it, so a lowering is known for what it was (R85).
  const last = next.history.length - 1
  const kept = `answered ${a.severity ?? wanted}, kept at ${floor ?? wanted}: a linked reviewer tag or Codex rated it so`
  const history = next.history.map((one, i) =>
    i !== last
      ? one
      : {
          ...one,
          ...(severity === f.severity ? {} : { severity, from: f.severity }),
          ...(isClamped ? { note: one.note === undefined ? kept : `${one.note} (${kept})` } : {}),
          ...(a.action === 'acknowledged' ? { answer: 'acknowledged' as const } : {}),
        },
  )
  // Another follow-up, or none, was never labelled: the label was the old issue's.
  const isNewFollowUp = a.action === 'deferred' && a.followUp !== f.followUp
  // A lost peak stays unknown: a peak read from the incomplete history would let a lowered legacy finding settle (gate R8-1).
  const peak = isPeakUnknown(f) ? {} : { peakSeverity: higher(peakOf(f), severity) }
  return { ...next, severity, history, ...peak, ...(security ? { isSecurity: true } : {}),
    // A deferral without a follow-up clears an earlier one: an old follow-up never settles a later deferral (final review T4).
    ...(a.action === 'deferred' ? { followUp: a.followUp } : {}),
    ...(isNewFollowUp ? { followUpLabel: undefined } : {}),
    // A new answer makes an earlier filing failure stale: the next filing pass tries again and says what it finds (R92).
    issueError: undefined, followUpLabelError: undefined }
}

/** A rebuttal that is the agent's acknowledgement of a comment asking for no change (R82): named as such in every text (R94). */
export const isAcknowledged = (f: Finding): boolean =>
  f.status === 'rebutted' && answersOf(f).filter(one => one.by !== 'codex').at(-1)?.answer === 'acknowledged'

/** A check confirmed the fix: the verify step, a reviewer saying so, or Codex conceding it. */
export const markVerified = (f: Finding, round: number, by: string, at: number, note?: string): Finding =>
  moved(f, 'verified-fixed', round, by, at, note)

/** A reviewer holds the finding against the fix or rebuttal: it is unresolved again. */
export const markHeld = (f: Finding, round: number, by: string, at: number, note?: string): Finding => moved(f, 'open', round, by, at, note)

/** A linked finding that stands for its original (R90): the gate's link, or the agent's once Codex agreed. */
export const isLinked = (f: Finding): boolean => f.duplicateOf !== undefined && (f.linkBy !== 'agent' || f.isLinkChecked === true)

/** The agent's link Codex has not ruled on: Codex checks it in the round's free check (R90). */
export const isLinkOwed = (f: Finding): boolean => f.duplicateOf !== undefined && f.linkBy === 'agent' && f.isLinkChecked !== true

/** Links a finding to its original, never to a linked one (no chains, R90). Its status is its own; its holds are the original's. */
export function linkTo(f: Finding, original: Finding, by: 'gate' | 'agent', round: number, at: number): Finding {
  // Never through the agent's link Codex has not checked (A9): a later refusal would leave this one on the wrong original.
  const to = isLinked(original) ? (original.duplicateOf ?? original.id) : original.id
  return { ...f, duplicateOf: to, linkBy: by, isLinkChecked: undefined, history: [...f.history, { round, status: f.status, note: `linked to ${to}`, by: by === 'gate' ? 'gate' : 'main', at }] }
}

/** The finding standing alone again: the agent answered it on its own, or Codex found it a different problem. Its security stays. */
export const dropLink = (f: Finding): Finding => ({ ...f, duplicateOf: undefined, linkBy: undefined, isLinkChecked: undefined })

/**
 * Codex found the agent's link a different problem (R90): the item stands alone, open, and is asked about again. The refusal names
 * the original, so linking the item there again is no answer (the gate can't get stuck), and it charges no round.
 */
export function refuseLink(f: Finding, round: number, at: number, note: string): Finding {
  const held = markHeld(dropLink(f), round, 'codex', at, note)
  const last = held.history.length - 1
  return { ...held, history: held.history.map((one, i) => (i === last && f.duplicateOf !== undefined ? { ...one, refusedLink: f.duplicateOf } : one)) }
}

/**
 * A link never lowers anything (R90): the original's peak becomes the higher of the two, so its issue carries it (R85), and it is
 * security when either one is (PR #25 review A1), even when a peak is unknown, so a link never lets a security problem past the person.
 * Its severity rises the same way (A9), since every hold reads it, recorded as the gate's change with the one before it (R85); only
 * the agent's lowering, which Codex checks with its deferral (R92 M2), takes it down again. A reviewer's tag on the link keeps it
 * from being re-guessed lower (R84).
 */
export function withLinkedPeak(original: Finding, linked: Finding): Finding {
  const security = original.isSecurity === true || linked.isSecurity === true ? { isSecurity: true } : {}
  const severity = higher(original.severity, linked.severity)
  // A tag or Codex rating supplying the chosen severity is authoritative even when it equals the original's guess (R84).
  // Keep an existing tag; a lower linked rating does not supply the chosen severity and leaves its provenance unchanged.
  const provenance = linked.severity === severity && (linked.severitySource === 'tag' || linked.source !== 'github')
    ? { severitySource: original.severitySource === 'tag' ? 'tag' as const : linked.severitySource }
    : {}
  // A lower tag or Codex rating does not supply the severity, but no answer may take a guess below it (`severityFloor`).
  const rated = linked.severitySource === 'tag' || linked.source !== 'github' ? [linked.severity] : []
  const floors = [original.severityFloor, linked.severityFloor, ...rated].filter((one): one is Severity => one !== undefined)
  const floor = floors.length === 0 ? {} : { severityFloor: floors.reduce(higher) }
  const when = linked.history.at(-1)
  // Raised into blocking range, or made security, an accepted rebuttal or acknowledgement goes back to Codex at the new severity, at
  // no round's cost (ruling on 6b concern 1): the flag Codex's check reads and clears, so its time (R33) and its wording stay. Once per
  // raise: Codex's ruling clears it, and only a further raise sets it again. The raise entry says why (`raiseOf`), even for security alone.
  // A deferral Codex agreed with goes back the same way (R92 M2): its "cannot be fixed in this PR" was given at the lower severity.
  const isRaisedToBlocking = severity !== original.severity && isBlocking({ severity })
  const isMadeSecurity = linked.isSecurity === true && original.isSecurity !== true
  const isRecheck = (isRaisedToBlocking || isMadeSecurity) && (isAcceptedRebuttal(original) || isDeferralAgreed(original))
  const recheck = isRecheck ? { needsRecheck: true } : {}
  const raised =
    severity === original.severity && !isRecheck
      ? {}
      : {
          severity,
          history: [
            ...original.history,
            // Marked as the link's raise, so no status reader takes it for an answer or a ruling (`answersOf`).
            { round: when?.round ?? linked.round, status: original.status, severity, from: original.severity,
              note: severity === original.severity ? `made security by its link ${linked.id}` : `raised by its link ${linked.id}`,
              raisedBy: linked.id, by: 'gate', at: when?.at ?? 0 },
          ],
        }
  // A lost peak counts as Critical [P1] (`filingPeak`): linked with a known one, the higher of the two is kept, so neither the floor
  // nor a known P0 is lost (wave 2b gate R1-2). An original whose peak is lost stays lost when its link would not raise it past that floor.
  const peak = higher(filingPeak(original), filingPeak(linked))
  return isPeakUnknown(original) && peak === 'P1'
    ? { ...original, ...security, ...provenance, ...floor, ...raised, ...recheck }
    : { ...original, ...security, ...provenance, ...floor, ...raised, ...recheck, peakSeverity: peak }
}

/** The ids linked to a finding, for "G2-1 (also G2-2)". */
export const alsoOf = (findings: readonly Finding[], id: string): string[] => findings.filter(one => one.duplicateOf === id && isLinked(one)).map(one => one.id)

/** The agent's word that an item names the same problem as another finding (R90). */
export type LinkProposal = { id: string; duplicateOf: string }

/**
 * The agent's links of one answer, applied to the ledger (R90; PR #25 review A2), checked on canonical ids over the whole batch. A
 * link from or to an id not on the list, to itself, on a cycle, or to an original Codex already found a different problem is no
 * answer: its finding is left as it was. Every other link points at its final original, and a newly linked original's own links
 * move with it, as the agent's, so nothing chains. Each original's peak and security rise to its links'. `linked`: the ids whose
 * link stands as their answer.
 */
export function applyLinks(
  findings: readonly Finding[],
  proposed: readonly LinkProposal[],
  round: number,
  at: number,
): { findings: Finding[]; linked: string[] } {
  const byId = new Map(findings.map(one => [one.id, one]))
  const canon = (id: string): string => byId.get(id)?.duplicateOf ?? id
  const accepted = new Map<string, string>()
  for (const one of proposed) {
    const f = byId.get(one.id)
    if (f === undefined || !byId.has(one.duplicateOf) || accepted.has(one.id)) continue
    // Codex refused this link before: asking again is no answer, so the item goes back to the agent, never round and round.
    if (f.history.some(each => each.refusedLink !== undefined && canon(each.refusedLink) === canon(one.duplicateOf))) continue
    accepted.set(one.id, one.duplicateOf)
  }
  const existing = new Map(findings.flatMap(one => (one.duplicateOf === undefined ? [] : [[one.id, one.duplicateOf] as const])))
  const edgeOf = (id: string): string | undefined => accepted.get(id) ?? existing.get(id)
  // Every proposed link on a cycle (a self-link is one) is refused together; again with what is left, until none is.
  for (;;) {
    const cyclic = [...accepted.keys()].filter(id => {
      const seen = new Set([id])
      let next = edgeOf(id)
      while (next !== undefined && !seen.has(next)) {
        seen.add(next)
        next = edgeOf(next)
      }
      return next === id
    })
    if (cyclic.length === 0) break
    for (const id of cyclic) accepted.delete(id)
  }
  const rootOf = (id: string): string => {
    const seen = new Set([id])
    let here = id
    for (let next = edgeOf(here); next !== undefined && !seen.has(next); next = edgeOf(here)) {
      seen.add(next)
      here = next
    }
    return here
  }
  const out = findings.map(f => {
    const to = accepted.has(f.id) || f.duplicateOf !== undefined ? rootOf(f.id) : undefined
    if (to === undefined || to === f.duplicateOf) return f
    // The agent's link, or a link moving with its original to the agent's: Codex checks either (R90).
    return { ...f, duplicateOf: to, linkBy: 'agent' as const, isLinkChecked: undefined, history: [...f.history, { round, status: f.status, note: `linked to ${to}`, by: 'main', at }] }
  })
  // A link raised its original when it was made: only the links made here raise theirs now.
  const made = out.filter((f, i) => f !== findings[i])
  return { findings: out.map(f => made.filter(one => one.duplicateOf === f.id).reduce(withLinkedPeak, f)), linked: [...accepted.keys()] }
}

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

/** When a finding was last rebutted, or undefined. */
export const rebuttedAt = (f: Finding): number | undefined => answersOf(f).filter(one => one.status === 'rebutted').at(-1)?.at

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
  // Every finding on the list, open ones included (R90). A linked one stands for its original, so the link goes there, and R33 and
  // a recheck are read on both: an open alias never reopens a settled rebuttal (PR #25 review A3).
  const byId = new Map(findings.map(one => [one.id, one]))
  // Never through the agent's link Codex has not checked (A9): the new item stands alone, so a refusal cannot leave it on the wrong original.
  const isCandidate = (one: Finding): boolean => {
    if (isLinkOwed(one)) return false
    const original = one.duplicateOf === undefined ? one : (byId.get(one.duplicateOf) ?? one)
    return [one, original].every(each => each.needsRecheck !== true && !isAnswerTo(each)) && isSame(one, item)
  }
  const match = findings.find(isCandidate)
  return match === undefined ? { cls: 'new-on-reviewed' } : { cls: 'duplicate', matchId: match.duplicateOf ?? match.id }
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
 * Only finding waivers, on purpose: a finding the person waived is never filed, not even at a merge (§5.13.1); a post waiver covers
 * the head, not its findings, and what it let merge is filed.
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
    one =>
      isBlocking(one) &&
      !waived.has(one.id) &&
      !isLinked(one) &&
      (one.status === 'open' || (one.status === 'deferred' && one.isSecurity === true)) &&
      !isSettledByIssue(one),
  )
}

/** A verified fix whose file changed since: Codex re-verifies it on the current head before it settles anything again (R58). */
export const isReverifyOwed = (f: Pick<Finding, 'status' | 'needsRecheck'>): boolean => f.status === 'verified-fixed' && f.needsRecheck === true

/** Blockers the fixer reported fixed that no check has confirmed yet, and verified fixes whose file changed since (R58). */
export function verificationOwed(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => isBlocking(one) && !waived.has(one.id) && !isLinked(one) && (one.status === 'reported-fixed' || isReverifyOwed(one)))
}

/** A rebuttal Codex ruled on and accepted, with its file unchanged since. */
export const isAcceptedRebuttal = (f: Finding): boolean => {
  const last = answersOf(f).at(-1)
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
  // Codex refusing the agent's link (R90) rejects no rebuttal.
  answersOf(f).filter((one, i, all) => one.by === 'codex' && one.status === 'open' && one.refusedLink === undefined && all[i - 1]?.status === 'rebutted').length

/** Rebutted again after Codex rejected a rebuttal: a dispute only the person settles; it never goes to Codex again (R40). */
export const isDisputed = (f: Finding): boolean => f.status === 'rebutted' && !isAcceptedRebuttal(f) && rejections(f) > 0

/**
 * What the gate's own Codex check rules on (Adam, decision A; R36, R58, R72): rebuttals Codex has not accepted, short of a dispute
 * (R40); verified fixes whose file changed since (R58); fixes only reported, at any severity, advisories included; the agent's links
 * (R90); and every deferral, at any severity, that Codex has not ruled on (R92 M2, Adam 2026-10-21; it replaces R85's lowering check).
 */
export const checksOwed = (findings: readonly Finding[]): Finding[] =>
  findings.filter(
    one =>
      (one.status === 'rebutted' && !isAcceptedRebuttal(one) && !isDisputed(one)) ||
      isReverifyOwed(one) ||
      one.status === 'reported-fixed' ||
      isDeferralOwed(one) ||
      isLinkOwed(one),
  )

/** The dispute in words: the agent's last argument and Codex's last rejection. */
const disputeOf = (f: Finding): string => {
  const argued = answersOf(f).filter(one => one.status === 'rebutted' && one.by !== 'codex').at(-1)?.note ?? 'no argument recorded'
  const codex = f.history.filter(one => one.status === 'open' && one.by === 'codex').at(-1)?.note ?? 'no reason given'
  return `${f.id} is disputed: the agent says "${argued}"; Codex said "${codex}"`
}

const ISSUE_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)(?![\w/])/
const ISSUE_REF = /(?:^|[\s([,;:])([\w.-]+)\/([\w.-]+)#(\d+)(?!\w)/
const ISSUE_BARE = /(?:^|[\s([,;:])#(\d+)(?!\w)/

/** The GitHub issue a follow-up names (R85): its URL, `owner/repo#<n>`, or `#<n>` in the record's own repository; other text may surround it. */
export function issueOf(text: string | undefined, slug: string | undefined): { repo: string; number: number } | undefined {
  if (text === undefined) return undefined
  const url = text.match(ISSUE_URL) ?? text.match(ISSUE_REF)
  if (url !== null) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) }
  const bare = text.match(ISSUE_BARE)
  return bare === null || slug === undefined || slug === '' ? undefined : { repo: slug, number: Number(bare[1]) }
}

/** Whether a follow-up names a GitHub issue (R85; Adam, 2026-10-20). A ticket key beside it is not checked; a PR or other URL alone is no follow-up. */
export const isFollowUpRef = (text: string | undefined): boolean => issueOf(text, 'repo/of-record') !== undefined

/**
 * The agent's last lowering of a finding's severity (Adam, 2026-10-20): an answer that set a severity below the one before it, at
 * any starting level. An answer from before `from` was recorded, with no severity before it in the history, counts as a lowering.
 */
export function loweringOf(f: Pick<Finding, 'history' | 'severity' | 'peakSeverity'>): { at: number; from: Severity; to: Severity; note?: string } | undefined {
  let before: Severity | undefined
  let found: { at: number; from: Severity; to: Severity; note?: string } | undefined
  f.history.forEach((one, i) => {
    if (one.severity === undefined) return
    const from = one.from ?? before
    if (one.by !== 'codex' && (from === undefined || RANK[one.severity] > RANK[from])) {
      found = { at: i, from: from ?? peakOf(f), to: one.severity, ...(one.note === undefined ? {} : { note: one.note }) }
    }
    before = one.severity
  })
  return found
}

/**
 * Codex's ruling on the agent's last deferral (R92 M2), if it gave one since. A 1.4.0 lowering ruling is not one. Read from the
 * answers (`answersOf`), so a link's raise, which copies the status, is never taken for a new deferral.
 */
const deferralRuling = (f: Pick<Finding, 'history'>): FindingEvent | undefined => {
  const answers = answersOf(f)
  const last = answers.reduce((found, one, i) => (one.status === 'deferred' && one.by !== 'codex' ? i : found), -1)
  return answers.slice(last + 1).filter(one => one.by === 'codex' && one.deferral !== undefined).at(-1)
}

/**
 * A deferral Codex has not ruled on (R92 M2, Adam 2026-10-21): at any severity, security included, or one Codex agreed with that a
 * link has since raised into P0/P1 or security (`raiseOf`, as for an accepted rebuttal). The round's free check rules on it, as on a
 * rebuttal; nothing settles by an issue, or waits for the person, before it.
 */
export const isDeferralOwed = (f: Finding): boolean => f.status === 'deferred' && (deferralRuling(f) === undefined || raiseOf(f) !== undefined)

/** A deferral Codex agreed cannot reasonably be fixed in this PR (R92 M2), with no re-check owed since: it waits. */
export const isDeferralAgreed = (f: Finding): boolean =>
  f.status === 'deferred' && deferralRuling(f)?.deferral === 'agreed' && raiseOf(f) === undefined

/**
 * Codex's ruling on a deferral (R92 M2): agreed, it stays deferred and waits; refused, it is open again with Codex's reason and goes
 * back to the agent. The refusal is a Codex `open` right after a deferral, so `isChargedRound` charges the round it is in (R88).
 */
export function ruleDeferral(f: Finding, holds: boolean, round: number, at: number, note?: string): Finding {
  if (holds) {
    const said = note ?? 'Codex: it cannot reasonably be fixed in this PR'
    // The ruling clears a raise's re-check, as `acceptRebuttal` does.
    return { ...f, needsRecheck: undefined, history: [...f.history, { round, status: 'deferred', note: said, deferral: 'agreed', by: 'codex', at }] }
  }
  const held = markHeld(f, round, 'codex', at, note ?? 'Codex: it can be fixed in this PR')
  const last = held.history.at(-1)
  return last === undefined ? held : { ...held, history: [...held.history.slice(0, -1), { ...last, deferral: 'refused' }] }
}

/** Severity names in an issue's title (spec §5.6). */
export const SEVERITY_NAMES: Record<Severity, string> = { P0: 'Blocker', P1: 'Critical', P2: 'Major', P3: 'Minor' }

/**
 * The severity the gate files and labels a finding's issue with (R92): its peak, or Critical [P1] when the record lost the peak
 * (gate R7-6). Adam, 2026-10-21: "lost severity critical, not held for me".
 */
export const filingPeak = (f: Finding): Severity => (isPeakUnknown(f) ? 'P1' : peakOf(f))

/** The most rounds the gate adds for late blockers in one lifecycle (R92, spec §5.3). */
export const GATE_ROUNDS = 2

/** The Jira key in a branch name, if any: its first `[A-Z][A-Z0-9]+-\d+`. */
export const jiraKeyOf = (branch: string): string | undefined => branch.match(/[A-Z][A-Z0-9]+-\d+/)?.[0]

/**
 * What the filing pass files (R92, spec §5.2): a held finding that is not security, not a linked duplicate (it holds with its
 * original), and is open, deferred with Codex's agreement, or disputed. A fix only reported, a rebuttal, link or deferral Codex has
 * not checked are Codex's first. A record that lost the finding's peak (gate R7-6) is filed as P1 (`filingPeak`).
 */
export const isFileable = (f: Finding): boolean =>
  f.isSecurity !== true && !isLinked(f) && !isLinkOwed(f) && (f.status === 'open' || isDeferralAgreed(f) || isDisputed(f))

/**
 * A finding settled by its GitHub issue (R92, spec §5.7): not security, open, deferred with Codex's agreement or rebutted, its
 * follow-up names an issue, and that issue carries the label of the highest severity the finding had. Its file changing does not
 * unsettle it (unlike a waiver, R55): the issue stays open for the person.
 */
export const isSettledByIssue = (f: Finding): boolean =>
  f.isSecurity !== true &&
  (f.status === 'open' || f.status === 'rebutted' || (f.status === 'deferred' && !isDeferralOwed(f))) &&
  isFollowUpRef(f.followUp) &&
  f.followUpLabel === filingPeak(f)

/**
 * A security finding whose Jira ticket the filing pass owes where the base sets `jiraProject` (spec §5.13.7): one the review left
 * waiting for the person, as `isFileable` names the rest (open, deferred with Codex's agreement, or disputed; not a linked duplicate).
 */
export const isTicketable = (f: Finding): boolean =>
  f.isSecurity === true && !isLinked(f) && !isLinkOwed(f) && (f.status === 'open' || isDeferralAgreed(f) || isDisputed(f))

/** A security finding's Jira ticket as the hold list and status name it: "S2-1 → KAN-512 Critical [P1]" (spec §5.13.7). */
export const ticketLine = (f: Finding): string => `${f.id} → ${f.jiraTicket ?? '?'} ${SEVERITY_NAMES[filingPeak(f)]} [${filingPeak(f)}]`

/** The words acli's call gives when its spawn threw: acli could not be started, most often because it is not installed. */
export const ACLI_NOT_STARTED = 'acli could not be started'
/** The start of a ticket's error when its description file could not be written: no advice about acli fits it. */
export const WRITE_FAILED = "could not write the ticket's description"

/** Whether acli's words say acli itself is missing: a spawn that threw, ENOENT, or the shell's or Go's not-found words. */
export const isAcliMissing = (words: string): boolean =>
  words.includes(ACLI_NOT_STARTED) || /ENOENT|executable file not found|no such file or directory|command not found/i.test(words)

/**
 * What to tell the person of a Jira ticket the gate could not file (ruling (b)), as a sentence ending in a space, or empty: install
 * acli when it is missing, log in when acli says unauthorized, and nothing beyond acli's own words otherwise.
 */
export function jiraAdvice(error: string): string {
  if (error.startsWith(WRITE_FAILED)) return ''
  if (isAcliMissing(error)) return 'Install acli (the Atlassian CLI), then run acli jira auth login. '
  if (/unauthorized/i.test(error)) return 'Run acli jira auth login. '
  return ''
}

/** A settled finding as status and the ready prompt name it: "R4-3 → #21 Major [P2]". */
export const issueLine = (f: Finding): string => `${f.id} → ${f.followUp ?? '?'} ${SEVERITY_NAMES[filingPeak(f)]} [${filingPeak(f)}]`

/** The longest issue title the gate sends: Jira's summary limit, one under GitHub's 256. */
const TITLE_MAX = 255

/** A filed issue's title (spec §5.6): `<id> <Name> [P<n>] <title> (#<pr>, <branch><, Jira key><, spec>)`. */
export function issueTitle(f: Finding, rec: Pick<LifecycleRecord, 'pr' | 'branch'>, spec?: string, repo?: string): string {
  const peak = filingPeak(f)
  const jira = jiraKeyOf(rec.branch)
  const where = [`#${rec.pr ?? '?'}`, ...(repo === undefined ? [] : [repo]), rec.branch, ...(jira === undefined ? [] : [jira]), ...(spec === undefined || spec === '' ? [] : [spec])]
  const title = `${f.id} ${SEVERITY_NAMES[peak]} [${peak}] ${f.title.replace(/\s+/g, ' ').trim().slice(0, 120)} (${where.join(', ')})`
  // The whole title is bounded (wave 2b gate R2-1): GitHub refuses one over 256 characters and Jira a summary over 255, whatever a
  // long branch or spec handle adds. The filing and the retry's match both use this value, so they stay the same.
  return [...title].slice(0, TITLE_MAX).join('')
}

/**
 * A Jira ticket's summary: the issue title with the repository after the PR (wave 2b gate R4-4). Repositories sharing a Jira project
 * reuse PR numbers and finding ids, so the lost-answer search, which takes only an exact summary, never adopts another's ticket.
 */
export const ticketTitle = (f: Finding, rec: Pick<LifecycleRecord, 'pr' | 'branch' | 'slug'>, spec?: string): string => issueTitle(f, rec, spec, rec.slug)

/**
 * Every title a finding's issue or ticket may carry from an earlier attempt: one per peak, the only part of it that moves between
 * attempts. A lost POST's issue, filed at a lower peak, is still found after the peak rises (PR #28 review, round.ts:3629).
 */
export const titlesAtAnyPeak = (f: Finding, title: (one: Finding) => string): string[] =>
  // These are presentation-only copies: peakOf would otherwise reapply a later severity from the real finding's history.
  (['P0', 'P1', 'P2', 'P3'] as const).map(peak => title({ ...f, severity: peak, peakSeverity: peak, history: [] }))

/** How every filing mark starts: an issue whose body has none was filed before marks, and only it is matched by title. */
export const FILING_MARK = '<!-- pr-gate filing:'

/**
 * The hidden last line of a GitHub issue the gate files: the finding, its PR and the lifecycle's own id, the same at every attempt
 * whatever the peak or the spec handle in the title, so the lost-answer search knows the issue by it (PR #28 review, round.ts:3629).
 * The id keeps a reset lifecycle, or another checkout's record of the same PR, whose finding ids start again, from taking this one's
 * issue (#29). Earlier marks, by generation or with neither, are never matched: a POST lost just before the upgrade may file its
 * issue once more, never take another lifecycle's.
 */
export const filingMark = (id: string, rec: Pick<LifecycleRecord, 'pr' | 'lifecycleId'>): string =>
  `${FILING_MARK} ${id} of #${rec.pr ?? '?'} lc ${rec.lifecycleId ?? '?'} -->`

/** A GitHub issue's body: the shared body (`issueBody`), then its filing mark. A Jira ticket's description is the body without it. */
export const githubBody = (f: Finding, rec: Pick<LifecycleRecord, 'pr' | 'findings' | 'lifecycleId'>, merged?: MergeKind): string =>
  `${issueBody(f, rec, merged)}\n\n${filingMark(f.id, rec)}`

/**
 * How a PR merged while findings still held (spec §5.13.1): outside the gate (GitHub's website, a connector), or under the person's
 * post waiver of its head (§5.4), whose reason the issue then carries. Either way the gate files what held at the merge.
 */
export type MergeKind = { kind: 'outside' } | { kind: 'post-waiver'; reason: string }

/** The line a finding's issue carries when its PR merged while it held (spec §5.13, A9): only the body says it, never the title. */
export const mergedLine = (pr: number | undefined, merged: MergeKind = { kind: 'outside' }): string =>
  merged.kind === 'post-waiver'
    ? `PR #${pr ?? '?'} merged under the person's post waiver (/pr-gate waive post): ${merged.reason.replace(/\s+/g, ' ').trim().slice(0, 300)}. ` +
      'No fix round ran on this finding.'
    : `PR #${pr ?? '?'} merged before the gate finished: no fix round ran on this finding.`

/**
 * A filed issue's body (spec §5.6; issues #21-#23 are the model): who raised it and where, its peak severity, the problem, why it
 * was not fixed in the PR, and the findings linked to it. `merged`: the PR merged while the finding held (spec §5.13), whatever its
 * status, outside the gate or under a post waiver, and the body says how and that no fix round ran on it.
 */
export function issueBody(f: Finding, rec: Pick<LifecycleRecord, 'pr' | 'findings'>, merged?: MergeKind): string {
  const isMerged = merged !== undefined
  const peak = filingPeak(f)
  const at = f.file === undefined ? '' : `, at \`${f.file}${f.line === undefined ? '' : `:${f.line}`}\``
  const thread = f.url === undefined ? '' : ` ([thread](${f.url}))`
  const codex = f.history.filter(one => one.by === 'codex').at(-1)?.note
  const last = codex === undefined ? '' : ` Codex's last word: ${codex}.`
  const why = isDisputed(f)
    ? `${disputeOf(f)}.`
    : f.status === 'deferred'
      ? `Deferred by the agent: ${f.note ?? 'no reason given'}.${isDeferralAgreed(f) ? ' Codex agreed it cannot reasonably be fixed in this PR.' : ' Codex had not ruled on the deferral.'}`
      : !isMerged
        ? `Still open when the review rounds ran out.${last}`
        : f.status === 'reported-fixed'
          ? `Reported fixed by the agent; Codex had not verified the fix.${last}`
          : f.status === 'verified-fixed'
            ? `Verified fixed once, but its file changed since and the fix was not verified again.${last}`
            : f.status === 'rebutted'
              ? `Rebutted by the agent: ${f.note ?? 'no reason given'}; Codex had not accepted the rebuttal.${last}`
              : `Still open.${last}`
  const named = f.followUp !== undefined && !isFollowUpRef(f.followUp) ? [`Follow-up named by the agent: ${f.followUp}.`] : []
  const linked = alsoOf(rec.findings, f.id)
  return [
    `Raised by ${f.reviewer} in round ${f.round} of #${rec.pr ?? '?'}${at}${thread}.`,
    isPeakUnknown(f)
      ? `Severity: ${SEVERITY_NAMES[peak]} [${peak}], assigned because the gate lost this finding's severity (answered as ${f.severity}).`
      : `Severity: ${SEVERITY_NAMES[peak]} [${peak}]${f.severity === peak ? '' : `, answered as ${f.severity}`}${f.isSecurity === true ? ', security' : ''}.`,
    '',
    '## Problem',
    '',
    f.detail ?? f.title,
    '',
    '## Impact, and why it was not fixed in this PR',
    '',
    why,
    ...named,
    ...(merged === undefined ? [] : ['', mergedLine(rec.pr, merged)]),
    ...(linked.length === 0 ? [] : ['', '## Linked findings', '', ...linked.map(id => `- ${id}: the same problem, raised again`)]),
    '',
    isMerged ? `Filed by pr-gate when #${rec.pr ?? '?'} merged.` : `Filed by pr-gate when the review of #${rec.pr ?? '?'} could do no more.`,
  ].join('\n')
}

/**
 * What keeps a PR from merging (R39): every finding of either phase, at any severity, that is open, deferred,
 * reported fixed without verification, verified fixed but its file changed since (R58), or rebutted without Codex
 * accepting it, unless the person waived it. The controller's ready and the merge guard both read this, so they never disagree.
 * A linked duplicate holds through its original (R90). A finding settled by its issue no longer holds it (R92).
 */
export function mergeHolds(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(
    one => !waived.has(one.id) && (one.status !== 'verified-fixed' || isReverifyOwed(one)) && !isAcceptedRebuttal(one) && !isSettledByIssue(one) && !isLinked(one),
  )
}

/**
 * Security findings that hold the merge with nothing tracking them (spec §5.13.2): a merge outside the gate leaves the record blocked
 * on each until the person's waiver. One with a Jira ticket is tracked (§5.13.7): it still holds, but no longer blocks the archive.
 */
export const untrackedSecurity = (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] =>
  mergeHolds(rec).filter(one => one.isSecurity === true && one.jiraTicket === undefined)

/**
 * What a merge outside the gate files (spec §5.13.1): every finding still holding the merge, whatever its status, but security and
 * any that already names an issue. That one is the post-merge check's (`checkIssuesAfterMerge`): it labels, reopens or files it again.
 */
export const isMergeFileable = (f: Finding): boolean => f.isSecurity !== true && !isFollowUpRef(f.followUp)

/** A held verified fix in words, as the merge refusal and the texts name it (R58). */
export const reverifyOwed = (f: Pick<Finding, 'id' | 'severity'>): string => `${f.id} [${f.severity}] fixed, re-verify owed (file changed)`

/** Security P1s that hold the merge: only a waiver naming each one releases it, never `waive post` (spec §3). */
export const securityHolds = (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] =>
  mergeHolds(rec).filter(one => isBlocking(one) && one.isSecurity === true)

const short = (sha: string): string => sha.slice(0, 7)

/** A finding's name in agent-facing text: a reviewer's comment is named by who wrote it, since its title is the reviewer's own first line. */
export const titleOf = (one: Pick<Finding, 'source' | 'reviewer' | 'title'>): string => (one.source === 'github' ? `comment from ${one.reviewer}` : one.title)

/** A failed filing's release: the gate retries, and the person can always end it with a waiver, so it is never stuck (R92). */
const labelRelease = (id = '<findingId>'): string =>
  `check the issue exists and gh can edit it; the gate retries on the next pass, or the person can /pr-gate waive ${id} <reason>`

/** A failed label on a finding's issue, in words (R85, R92). */
const labelFailure = (f: Finding): string =>
  `could not label issue #${issueOf(f.followUp, 'repo/of-record')?.number ?? '?'} severity:${filingPeak(f)} (${f.followUpLabelError ?? 'no error recorded'})`

const issueRelease = (id = '<findingId>'): string =>
  `check that gh can create issues in the repository (gh auth status); the gate retries on the next pass, or the person can /pr-gate waive ${id} <reason>`

/** A failed filing in words (R92). */
const issueFailure = (f: Finding): string => `could not file an issue for ${f.id} (${f.issueError ?? 'no error recorded'})`

/** One finding that holds the merge, as a blocker with its owner and the step that clears it (R79). Never the reviewer's own words (gate R2-3). */
function blockerOf(f: Finding, also: readonly string[] = []): Blocker {
  // A security finding's Jira ticket tracks it, never settles it (spec §5.13.7): named, and so is a filing that failed.
  const jira = f.isSecurity !== true ? '' : f.jiraTicket !== undefined ? ` → ${f.jiraTicket}` : f.jiraError !== undefined ? ` (Jira ticket not filed: ${f.jiraError})` : ''
  const tag = `${f.id}${also.length === 0 ? '' : ` (also ${also.join(', ')})`}${jira} [${f.severity}]${f.isSecurity === true ? ' security' : ''} ${titleOf(f)}`
  const waive = `/pr-gate waive ${f.id} <reason>`
  const theirs = (kind: 'disputed' | 'deferred' | 'security-p1', what: string): Blocker =>
    ({ kind, id: f.id, said: f.jiraTicket !== undefined && f.isSecurity === true ? `${ticketLine(f)}, waiting for your waiver` : `${tag}: ${what}`, owner: 'person', release: waive })
  const isSecurityP1 = isBlocking(f) && f.isSecurity === true
  // The filing pass failed for it (R92): the agent checks gh; the gate retries on its next pass.
  if (isFileable(f) && f.issueError !== undefined) return { kind: 'issue-failed', id: f.id, said: issueFailure(f), owner: 'agent', release: issueRelease(f.id) }
  if (isFileable(f) && f.followUpLabelError !== undefined) return { kind: 'label-failed', id: f.id, said: labelFailure(f), owner: 'agent', release: labelRelease(f.id) }
  const issueOwed = (what: string): Blocker =>
    ({ kind: 'issue-owed', id: f.id, said: `${tag}: ${what}; the gate files its GitHub issue when the review can do no more`, owner: 'gate', release: 'nothing: the gate files it' })
  if (isLinkOwed(f)) {
    return { kind: 'link-unchecked', id: f.id, said: `${tag}: linked to ${f.duplicateOf ?? '?'}, Codex has not checked the link`, owner: 'codex', release: "the gate's Codex check rules on it" }
  }
  if (isDisputed(f)) return isFileable(f) ? issueOwed('disputed') : theirs('disputed', 'disputed')
  if (f.status === 'deferred') {
    if (isDeferralOwed(f)) {
      return { kind: 'deferral-unchecked', id: f.id, said: `${tag}: deferred, Codex has not checked the deferral`, owner: 'codex', release: "the gate's Codex check rules on it" }
    }
    if (isFileable(f)) return issueOwed('deferred, and Codex agreed it cannot reasonably be fixed in this PR')
  }
  if (f.status === 'deferred') return theirs(isSecurityP1 ? 'security-p1' : 'deferred', 'deferred')
  if (isReverifyOwed(f)) {
    return { kind: 'reverify-owed', id: f.id, said: `${tag}: fixed, re-verify owed (file changed)`, owner: 'codex', release: "the gate's Codex check re-verifies it" }
  }
  if (f.status === 'reported-fixed') {
    return { kind: 'verify-owed', id: f.id, said: `${tag}: fixed, verification owed`, owner: 'codex', release: "the gate's Codex check verifies it" }
  }
  if (f.status === 'rebutted') {
    const what = isAcknowledged(f) ? 'acknowledgement not yet confirmed' : 'rebuttal not yet accepted'
    return { kind: 'rebuttal-unchecked', id: f.id, said: `${tag}: ${what}`, owner: 'codex', release: "the gate's Codex check rules on it" }
  }
  return { kind: isSecurityP1 ? 'security-p1' : 'open', id: f.id, said: `${tag}: open`, owner: 'agent', release: 'fix it, or rebut it with file:line evidence' }
}

/**
 * Everything between this head and its merge (R79): findings, the head's own review, and CI, with nothing short-circuited. A post
 * waiver for this head and base leaves only a security P1 and CI; CI a waiver covers is only what GitHub does not require (R86).
 */
export function standingOf(
  rec: LifecycleRecord,
  at: { head: string; base: string },
  ci?: readonly CheckState[] | 'unreadable' | { unreadable: string; checks?: readonly CheckState[] },
): Standing {
  // A post waiver for this head means a PR exists, even on a record never adopted into post review (a waiver-only or a hand-opened
  // PR's record): its standing is the merge's, as judgeMerge already reads it (gate R1-2).
  const isPostNamed = rec.waivers.some(one => one.scope === 'post' && one.head === at.head)
  const phase = rec.phase === 'pre' && !isPostNamed ? 'pre' : 'post'
  const isOnBase = rec.base === at.base
  const waiver = isOnBase ? rec.waivers.find(one => one.scope === phase && one.head === at.head && (phase === 'post' || one.base === at.base)) : undefined
  const security = securityHolds(rec)
  const isWaived = waiver !== undefined && security.length === 0
  const blockers: Blocker[] = (isWaived ? [] : mergeHolds(rec)).map(one => blockerOf(one, alsoOf(rec.findings, one.id)))
  if (!isOnBase && phase === 'post') {
    blockers.push({ kind: 'retargeted', said: `reviewed for ${rec.base}, but the PR now targets ${at.base}`, owner: 'person', release: `point it back at ${rec.base}, or /pr-gate reset` })
  }
  if (!isWaived && phase === 'post') {
    const next = decideNext(rec)
    if (next.kind === 'round') blockers.push({ kind: 'round-owed', said: `a review round is owed on ${short(at.head)}`, owner: 'gate', release: 'the gate runs it; leave the branch alone' })
    if (next.kind === 'exhausted') {
      // Its id lets a text that already gives this reason as its own leave it out (holdText's `named`).
      blockers.push({ kind: 'head-unreviewed', id: 'head', said: next.why, owner: 'person', release: '/pr-gate allow 1 <reason>, or /pr-gate waive post <reason>' })
    } else if (next.kind !== 'round' && waiver === undefined && at.head !== rec.head) {
      // A push no round has seen (final review I1): the record's verdict is for its own head, never the live one. An owed round or
      // an exhausted review already holds this head, with its own step, so this is said only when neither is.
      blockers.push({ kind: 'head-unreviewed', id: 'head', said: `${short(at.head)} was pushed after the review completed at ${short(rec.head)}`, owner: 'gate', release: '/pr-gate resume reviews it' })
    }
  }
  const setAside: string[] = []
  if (ci === 'unreadable' || (ci !== undefined && 'unreadable' in ci)) {
    const why = typeof ci === 'object' && 'unreadable' in ci ? ci.unreadable : ''
    blockers.push({ kind: 'ci-unreadable', ...(why === '' ? {} : { detail: why }), said: `the CI checks on ${short(at.head)} could not be read${why === '' ? '' : ` (${why})`}`, owner: 'agent', release: 'check gh auth status and the network, then try again' })
  }
  // Checks read while what the base requires could not be: each still holds as if required (R86, gate R3-1).
  const listed = ci === 'unreadable' ? [] : ci === undefined || !('unreadable' in ci) ? (ci ?? []) : (ci.checks ?? [])
  for (const one of listed) {
    const isBad = one.bucket === 'fail' || one.bucket === 'cancel'
    if (!isBad && (one.bucket === 'pass' || one.bucket === 'skipping')) continue
    if (isWaived && !one.isRequired) {
      setAside.push(one.name)
      continue
    }
    blockers.push(
      isBad
        ? { kind: 'ci-failing', id: one.name, said: `check ${one.name} ${one.bucket === 'cancel' ? 'cancelled' : 'failing'}`, owner: 'agent', release: 'fix what it reports and push, or rerun it (gh run rerun <run-id> --failed)' }
        : one.bucket === 'missing'
          ? { kind: 'ci-running', id: one.name, said: `required check ${one.name} has not reported`, owner: 'gate', release: 'wait for it to start, or check why it does not run on this head' }
          : { kind: 'ci-running', id: one.name, said: `check ${one.name} running`, owner: 'gate', release: `wait for it (gh pr checks ${rec.pr ?? ''} --watch)` },
    )
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
  /**
   * answer: the findings the agent can settle on the same head (R37, R63); a resume re-opens triage, or the pre-PR fix step, for them.
   * issues: findings the filing pass still owes an issue (R92); the next pass files them.
   */
  | { kind: 'blocked'; why: string; nextStep: string; answer?: string[]; recheck?: string[]; issues?: string[] }
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
  // A verified fix whose file changed is Codex's to re-verify on this head, as free as a rebuttal check (R58); so is every deferral
  // Codex has not ruled on (R92 M2).
  // The agent's link is Codex's to check too (R90): answered, so never an open finding the agent left.
  const unchecked = holding.filter(one => (one.status === 'rebutted' && !isDisputed(one)) || isReverifyOwed(one) || isDeferralOwed(one) || isLinkOwed(one))
  const open = holding.filter(one => one.status === 'open' && !isLinkOwed(one))
  // Deferrals Codex agreed with: the filing pass files each but security (R92); only a security one waits for the person.
  const deferred = holding.filter(one => one.status === 'deferred' && !isDeferralOwed(one) && !isLinkOwed(one))
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
    // A deferral Codex says can be fixed in this PR (R92 M2): the agent's to fix, or to rebut with evidence. Said as such, even after
    // an earlier rebuttal Codex rejected: Codex's last word is on the deferral.
    const undeferred = open.filter(one => {
      const last = answersOf(one).at(-1)
      return last?.by === 'codex' && last.deferral === 'refused'
    })
    // A rebuttal Codex did not accept is said as such (M2), not as an unanswered finding; it may be fixed or deferred, not rebutted again (R40).
    const rejected = open.filter(one => rejections(one) > 0 && !undeferred.includes(one))
    // A fix Codex re-verified after its file changed and found no longer holds (R58): the agent's to fix or rebut again.
    const refuted = open.filter(one => {
      const answers = answersOf(one)
      return answers.at(-1)?.by === 'codex' && answers.at(-2)?.status === 'verified-fixed'
    })
    const ignored = open.filter(one => !rejected.includes(one) && !refuted.includes(one) && !undeferred.includes(one))
    const isFeedbackOnly =
      ignored.length > 0 && rejected.length + refuted.length + undeferred.length === 0 && open.every(one => one.source === 'github' && !isBlocking(one))
    const codexSaid = (one: Finding): string => one.history.filter(each => each.by === 'codex').at(-1)?.note ?? 'no reason given'
    const said = [
      ...rejected.map(one => `Codex did not accept the rebuttal of ${one.id}: ${codexSaid(one)}`),
      ...refuted.map(one => `Codex re-verified ${one.id} after its file changed, and the fix no longer holds: ${codexSaid(one)}`),
      ...undeferred.map(one => `Codex says ${one.id} can be fixed in this PR: ${codexSaid(one)}`),
      ...(ignored.length === 0
        ? []
        : isFeedbackOnly
          ? [`${ids(ignored)} from reviewers ${ignored.length === 1 ? 'has' : 'have'} no answer`]
          : [`${ids(ignored)} left open at ${last.endHead.slice(0, 7)} with no fix or rebuttal, so another round would say the same`]),
    ]
    const steps = isFeedbackOnly
      ? [`answer ${ids(open)} in ${open.length === 1 ? 'its thread' : 'their threads'} (fix, rebut or defer)`]
      : [
          ...(ignored.length + refuted.length + undeferred.length === 0 ? [] : [`fix or rebut ${ids([...refuted, ...undeferred, ...ignored])}`]),
          ...(rejected.length === 0 ? [] : [`fix or defer ${ids(rejected)}`]),
        ]
    return { kind: 'blocked', why: said.join('; '), nextStep: `${steps.join('; ')}, then /pr-gate resume`, answer: open.map(one => one.id) }
  }
  // A rebuttal Codex has not ruled on (its check was held, or it came from before the PR): Codex checks it on this head, free.
  const recheck = (): Next => {
    const links = unchecked.filter(isLinkOwed)
    const deferrals = unchecked.filter(one => isDeferralOwed(one) && !isLinkOwed(one))
    const answered = unchecked.filter(one => !isReverifyOwed(one) && !isDeferralOwed(one) && !isLinkOwed(one))
    const acks = answered.filter(isAcknowledged)
    const rebuttals = answered.filter(one => !isAcknowledged(one))
    const reverify = unchecked.filter(one => isReverifyOwed(one) && !isLinkOwed(one))
    const said = [
      ...(links.length === 0 ? [] : [`Codex has not checked the link of ${ids(links)}`]),
      ...(rebuttals.length === 0 ? [] : [`Codex has not checked the rebuttal of ${ids(rebuttals)} on ${last.endHead.slice(0, 7)}`]),
      ...(acks.length === 0 ? [] : [`Codex has not checked the acknowledgement of ${ids(acks)} on ${last.endHead.slice(0, 7)}`]),
      ...(deferrals.length === 0 ? [] : [`Codex has not checked the deferral of ${ids(deferrals)}`]),
      ...reverify.map(reverifyOwed),
    ]
    const kinds = [rebuttals, acks, deferrals, reverify, links].filter(one => one.length > 0)
    const what =
      kinds.length !== 1
        ? 'them'
        : rebuttals.length > 0
          ? 'the rebuttal'
          : acks.length > 0
            ? 'the acknowledgement'
            : links.length > 0
              ? 'the link'
              : deferrals.length === 1
                ? 'the deferral'
                : 'them'
    return {
      kind: 'blocked',
      why: said.join('; '),
      nextStep: `run /pr-gate resume: Codex checks ${what} on this head, using no review round`,
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
    // A filing that failed for a finding here is said, not hidden behind the fix step (R92).
    const unfiled = holding
      .filter(one => isFileable(one) && (one.issueError !== undefined || one.followUpLabelError !== undefined))
      .map(one => `; ${one.issueError !== undefined ? issueFailure(one) : labelFailure(one)}`)
      .join('')
    return {
      kind: 'exhausted',
      why: `${unresolved.length > 0 ? `${ids(unresolved)} unresolved at ${last.endHead.slice(0, 7)}` : `${last.endHead.slice(0, 7)} is not reviewed clean`}${unfiled}`,
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

/**
 * Only deferrals and disputes hold the merge. Each that is not security gets a GitHub issue from the filing pass (R92): until it has
 * one, the gate retries, and a failure is the agent's to check. Security ones wait for the person's waiver (R39, R40); a finding
 * whose peak was lost is filed as P1 (gate R7-6, Adam 2026-10-21).
 */
function awaiting(deferred: readonly Finding[], disputed: readonly Finding[] = []): Next {
  const all = [...deferred, ...disputed]
  const toFile = all.filter(isFileable)
  if (toFile.length > 0) {
    const failed = toFile.filter(each => each.issueError !== undefined || each.followUpLabelError !== undefined)
    const waiting = toFile.filter(each => !failed.includes(each))
    const said = [
      ...failed.map(each => (each.issueError !== undefined ? issueFailure(each) : labelFailure(each))),
      ...(waiting.length === 0 ? [] : [`${ids(waiting)} ${waiting.length === 1 ? 'waits for its' : 'wait for their'} GitHub issue`]),
    ]
    const releases = failed.map(each => (each.issueError !== undefined ? issueRelease(each.id) : labelRelease(each.id)))
    return {
      kind: 'blocked',
      why: said.join('; '),
      nextStep: `${releases.length === 0 ? 'nothing to change: the gate files them' : releases.join('; ')} (/pr-gate resume)`,
      issues: toFile.map(each => each.id),
    }
  }
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

/**
 * Blockers the gate may add a round for at exhaustion (R92, spec §5.3): held, blocking, first raised in the last completed post round
 * or in the last charged discretionary round, the one that spent the allowance.
 */
export function lateBlockers(rec: LifecycleRecord): Finding[] {
  const done = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)
  const late = new Set([done.at(-1)?.n, done.filter(one => one.kind === 'discretionary' && one.isCharged !== false).at(-1)?.n])
  return mergeHolds(rec).filter(one => isBlocking(one) && late.has(one.round))
}

/**
 * The round the gate adds for late blockers at exhaustion (R92): under GATE_ROUNDS per lifecycle, and only when it starts a round.
 * Each one is a sign to the person that the PR's scope is too wide; `scopeNote` says so.
 */
export function gateGrant(rec: LifecycleRecord, at: number): Grant | undefined {
  if (decideNext(rec).kind !== 'exhausted') return undefined
  if (rec.grants.filter(one => one.by === 'gate').length >= GATE_ROUNDS) return undefined
  const late = lateBlockers(rec)
  if (late.length === 0) return undefined
  const grant: Grant = { n: 1, reason: `late blocker${late.length === 1 ? '' : 's'} ${ids(late)}: the PR's scope may be too wide`, head: rec.head, at, by: 'gate' }
  return decideNext({ ...rec, grants: [...rec.grants, grant] }).kind === 'round' ? grant : undefined
}

/** The rounds the gate added, in words for the person (R92); undefined when it added none. */
export function scopeNote(rec: Pick<LifecycleRecord, 'grants'>): string | undefined {
  const added = rec.grants.filter(one => one.by === 'gate')
  if (added.length === 0) return undefined
  const rounds = `${added.length} round${added.length === 1 ? '' : 's'}`
  const why = added.map(one => one.reason.replace(/: the PR's scope may be too wide$/, '')).join('; ')
  return `The gate added ${rounds} for blockers first raised after the allowance was spent (${why}): tell the person the PR's scope may be too wide.`
}

/** Where the filing pass runs (R92): where 1.4.0 ended exhausted or awaiting the person, and while an issue is still owed. */
export const isFilingPoint = (next: Next): boolean =>
  next.kind === 'exhausted' || next.kind === 'awaiting-decision' || (next.kind === 'blocked' && (next.issues ?? []).length > 0)

/** One issue the filing pass owes: a new one, or the one the agent named (`reuse`), labelled `severity:<peak>`. */
export type IssueItem = {
  id: string
  peak: Severity
  followUp?: string
  reuse?: { repo: string; number: number }
  title: string
  /** The titles an earlier attempt may have filed it under (`titlesAtAnyPeak`). */
  titles: string[]
  body: string
}

/**
 * One Jira ticket the filing pass owes a security finding (spec §5.13.7): its summary and description are the issue's title and body.
 * `isRetry`: the last attempt failed, perhaps after Jira filed it, so Jira is searched for it before another is filed.
 */
export type TicketItem = { id: string; peak: Severity; title: string; titles: string[]; sent: string[]; body: string; isRetry: boolean }

/** `tickets` only where the base sets `jiraProject` and a security finding still owes its ticket. */
export type IssuePlan = { kind: 'none' } | { kind: 'grant'; grant: Grant; late: string[] } | { kind: 'file'; items: IssueItem[]; tickets?: TicketItem[] }

/**
 * What the filing pass does (R92, spec §5): nothing before the PR or short of a filing point; else a round for a late blocker
 * (`gateGrant`); else an issue for each held finding it files (`isFileable`). `isJira`: the base sets `jiraProject`, and each security
 * finding left waiting for the person (`isTicketable`), or every one still holding at a merge, that has no ticket gets one (§5.13.7).
 */
export function planIssues(rec: LifecycleRecord, at: number, spec?: string, merged?: MergeKind, isJira = false): IssuePlan {
  const isMerged = merged !== undefined
  if (isMerged) {
    // The PR merged outside the gate (spec §5.13.1): no round can run, so no grant; every finding still holding is filed now.
    if (rec.pr === undefined) return { kind: 'none' }
  } else {
    if (rec.phase === 'pre' || rec.pr === undefined || !isFilingPoint(decideNext(rec))) return { kind: 'none' }
    const grant = gateGrant(rec, at)
    if (grant !== undefined) return { kind: 'grant', grant, late: lateBlockers(rec).map(one => one.id) }
  }
  const items = mergeHolds(rec)
    .filter(isMerged ? isMergeFileable : isFileable)
    .map((f): IssueItem => {
      const reuse = issueOf(f.followUp, rec.slug)
      return {
        id: f.id,
        peak: filingPeak(f),
        ...(f.followUp === undefined ? {} : { followUp: f.followUp }),
        ...(reuse === undefined ? {} : { reuse }),
        title: issueTitle(f, rec, spec),
        titles: titlesAtAnyPeak(f, one => issueTitle(one, rec, spec)),
        body: githubBody(f, rec, merged),
      }
    })
  const tickets = !isJira
    ? []
    : mergeHolds(rec)
      .filter(f => (isMerged ? f.isSecurity === true : isTicketable(f)) && f.jiraTicket === undefined)
      .map((f): TicketItem => ({
        id: f.id, peak: filingPeak(f), title: ticketTitle(f, rec, spec), titles: titlesAtAnyPeak(f, one => ticketTitle(one, rec, spec)),
        sent: f.jiraSummaries ?? [], body: issueBody(f, rec, merged), isRetry: f.jiraError !== undefined,
      }))
  if (items.length === 0 && tickets.length === 0) return { kind: 'none' }
  return { kind: 'file', items, ...(tickets.length === 0 ? {} : { tickets }) }
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

