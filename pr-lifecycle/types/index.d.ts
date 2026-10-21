export type Severity = 'P0' | 'P1' | 'P2' | 'P3'

/** open is the spec's "still unresolved". fixed is split: what the fixer reported, and what a check confirmed. */
export type FindingStatus = 'open' | 'reported-fixed' | 'verified-fixed' | 'rebutted' | 'deferred'

export type FindingSource = 'codex-review' | 'codex-challenge' | 'github'

/**
 * `answer`: an acknowledgement, stored as a rebuttal (R94). `severity`: the severity an answer set, with `from` the one before it (R85).
 * `lowering`: Codex's ruling on the agent's lowering of the severity before it, on a record from 1.4.0 (R85, replaced by `deferral`).
 * `deferral`: Codex's ruling on the agent's deferral (R92 M2): agreed, it cannot reasonably be fixed in this PR; refused, it can, and
 * the finding is open again.
 */
export type FindingEvent = {
  round: number
  status: FindingStatus
  note?: string
  evidence?: string
  severity?: Severity
  from?: Severity
  lowering?: 'agreed' | 'refused'
  deferral?: 'agreed' | 'refused'
  /** The answer as the agent gave it, when the status alone does not say: an acknowledgement is stored as a rebuttal (R82, R94). */
  answer?: 'acknowledged'
  /** Codex's refusal of the agent's link (R90): the original it found a different problem. A link to it again is no answer. */
  refusedLink?: string
  /**
   * The id of the link that raised the severity (A9): a record of the raise, not an answer or a ruling. The status it carries is
   * the finding's own, copied; readers of the answers and rulings skip it (`answersOf`), and `loweringOf` reads its severity.
   */
  raisedBy?: string
  by: string
  at: number
}

export type Finding = {
  id: string
  /** The round that first raised it (the spec's firstRound). */
  round: number
  source: FindingSource
  /** A GitHub login, or 'codex'. */
  reviewer: string
  /** The GitHub id of the review or comment it came from: `review:<id>`, `inline:<id>`, `comment:<id>`. */
  externalId?: string
  threadId?: string
  url?: string
  severity: Severity
  isSecurity?: boolean
  /** GitHub: the reviewer's own words ('tag') or a guess from them ('hint', R84). */
  severitySource?: 'tag' | 'hint'
  title: string
  file?: string
  line?: number
  detail?: string
  /** The head it was raised on. */
  headSeen: string
  status: FindingStatus
  note?: string
  /**
   * The GitHub issue that tracks it: named by the agent's answer (R85) or filed by the gate (R92). `#<n>`, `owner/repo#<n>` or its
   * URL, other text around it.
   */
  followUp?: string
  /** The highest severity the finding had during the gate (R85): what its issue is labelled with. */
  peakSeverity?: Severity
  /** The `severity:<P>` label the gate put on that issue; the finding settles once it is the peak's (R92). */
  followUpLabel?: Severity
  /** gh's error when the gate last failed to label the issue the agent named: the finding holds until a pass labels it. */
  followUpLabelError?: string
  /** gh's error when the gate last failed to file the finding's issue (R92): the finding holds until a pass files it. */
  issueError?: string
  /** The finding this one names again (R90): it holds, and settles, with its original. Never a linked finding's id. */
  duplicateOf?: string
  /** Who linked it: the gate's match (`isSame`), or the agent's answer, which Codex checks (R90). */
  linkBy?: 'gate' | 'agent'
  /** Codex agreed the agent's link names the same problem. */
  isLinkChecked?: boolean
  /**
   * A later change touched its file, or a link raised it into blocking range or made it security (A9): the evidence behind its
   * status needs checking again. Codex's check clears it.
   */
  needsRecheck?: boolean
  /** The head `line` was last placed at (R73): a head move reads the diff from here and shifts `line` along with the code. */
  lineHead?: string
  history: FindingEvent[]
}

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type Step = { id: string; label: string; state: StepState; detail?: string }

export type Role = 'review' | 'challenge' | 'fix' | 'verify' | 'triage'

export type Pending = {
  role: Role
  /** The step's name, which the agent repeats in its trailer. */
  step: string
  /** A sub-agent's id, as the engine gave it. */
  agentId?: string
  /** True for the main agent, which has no id. */
  isMain?: true
  /** Main agent only: the main-loop turn that began with this step's prompt (its step marker in the turn's text, R51). */
  turnId?: string
  answer?: string
}

export type RunStatus =
  | 'running'
  | 'passed'
  | 'exhausted'
  | 'blocked'
  | 'error'
  | 'stopped'
  | 'waived'

export type Tier = 'trivial' | 'standard' | 'high'

/** Codex reasoning effort. Never xhigh: those reviews timed out. */
export type Effort = 'high' | 'medium' | 'low'

/** full: the whole gate. light: a branch named by `lightBranches` (chore/), one round and no advisories. */
export type Lane = 'full' | 'light'

/** How the agent merges a PR the gate let through (R93): `gh pr merge --merge`, `--squash` or `--rebase`. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

export type LifecyclePhase = 'pre' | 'post' | 'ready' | 'archived'

/** baseline rounds and the final-head check are free; discretionary ones draw on the allowance. */
export type RoundKind = 'baseline' | 'discretionary' | 'final-head-check'

/** The Codex model each role reported from gstack's `CODEX_MODEL:` line (R69): the review, the challenge, the rebuttal check. */
export type RanModels = { review?: string; challenge?: string; verify?: string }

export type Evidence = { source: 'codex' | 'github'; reviewer: string; head: string; isComplete: boolean }

export type RoundRecord = {
  /** The iteration label (`Run.round`); not a count of rounds consumed. */
  n: number
  phase: 'pre' | 'post'
  kind: RoundKind
  /** An advisory-only round: it draws under the reserve rule. */
  isAdvisory: boolean
  startHead: string
  endHead: string
  /** The PR base the round reviewed against; a pre-PR round's verdict covers that base only. */
  base?: string
  isCompleted: boolean
  /**
   * A completed discretionary post round only (R88): whether it drew on the allowance, because a new blocker was raised in it, Codex
   * rejected a fix, rebuttal or acknowledgement in it, or the agent reported a fix in it, of any finding at any severity, raised in it
   * or earlier (A8; never a linked duplicate's). Absent on a pre
   * round and on a record from before 1.5.0, which count as charged, and on a baseline round, a final-head check or an attempt.
   */
  isCharged?: boolean
  /** The Codex effort the round, or the attempt, ran at. Absent on a record from before 1.2.0. */
  effort?: Effort
  /** The Codex model that reviewed it, from the reviewer's `CODEX_MODEL:` line, else the model the gate named (R69). */
  codexModel?: string
  /** Every role's reported model, kept apart when they differ (R69). */
  ranModels?: RanModels
  evidence: Evidence[]
  raised: { blocking: number; advisory: number }
  rebutted: number
  deferredBlocking: number
  activeMs: number
  waitMs: number
  outstanding?: string
  startedAt: number
  endedAt: number
}

/** A finding waiver lapses when its finding's file changes after it was given (R55): `lapsedHead` is the head that changed it. */
export type Waiver = {
  scope: 'pre' | 'post' | 'finding'
  findingId?: string
  head: string
  /** A pre waiver's base: it lets a PR open only to that base (R1-1). One without it matches none. */
  base?: string
  reason: string
  by: string
  at: number
  lapsedAt?: number
  lapsedHead?: string
}

/** A round added to the allowance: the person's `/pr-gate allow`, or the gate's own for a late blocker (`by: 'gate'`, R92, at most two). */
export type Grant = { n: number; reason: string; head: string; at: number; by?: 'gate' }

/**
 * One line of the run log (`/pr-gate log`): what cost time or needed the person. stop: a run ended short of done (error, blocked,
 * stopped, exhausted); end: a run ended done; person: a /pr-gate command; head: the gate caught up to a head itself; session: a
 * session took the record over, or stood down.
 */
export type LogEntry = { at: number; kind: 'stop' | 'end' | 'person' | 'head' | 'session' | 'check' | 'approval'; text: string }

export type LifecycleRecord = {
  version: 1
  root: string
  branch: string
  base: string
  /** owner/repo, lowercased. */
  slug?: string
  pr?: number
  /** The gh login of this machine, so its own replies are not read as feedback. */
  self?: string
  head: string
  tier: Tier
  tierWhy: string
  lane: Lane
  /** Set when a pass-through skipped pre-PR Codex: why. */
  passThrough?: string
  allowance: number
  grants: Grant[]
  attempts: number
  activeMs: number
  waitMs: number
  /** The run log, oldest first, capped at LOG_CAP entries. Absent on a record from before 1.3.0. */
  log?: LogEntry[]
  rounds: RoundRecord[]
  findings: Finding[]
  /** Feedback ids already triaged. */
  processed: string[]
  /** Feedback id to the id of the reply posted to it. */
  replies: Record<string, string>
  /** Every reply id the agent reported, in any step and for any answer, accepted or not (R91): never read back as feedback. */
  ownReplies?: string[]
  /**
   * When the PR's head reached the PR (#24), kept across stop, resume and another session: GitHub's push time (the latest push into
   * the head, from the repository activity log), else when the gate first saw it. `asked`: the requestReview names asked again for
   * this head because a comment may predate it; `counted`: comments counted for it on a guess while GitHub gave no push time.
   * `since`: a time the head had surely not reached the PR yet (the last time the gate saw the head before it as the PR's), the
   * lower bound of that guess with `committedAt`, the head commit's committer date once read. `seenAt`: the last poll that saw
   * this head as the PR's.
   */
  headArrival?: {
    head: string
    at: number
    isPushTime: boolean
    asked?: string[]
    counted?: string[]
    since?: number
    committedAt?: number
    seenAt?: number
  }
  /** Where the PR's head branch lives, as gh last said (#24): a fork's repository for a PR from one, and its branch name. */
  headPlace?: { repo?: string; branch?: string; isCrossRepository?: boolean }
  waivers: Waiver[]
  phase: LifecyclePhase
  /**
   * Which lifecycle of the branch this is: a reset raises it, and a fresh start keeps the raised one, so work begun before a reset
   * can tell the record replaced even when the new one has no rounds yet (gate G7-7). Absent means 0.
   */
  generation?: number
  /** The pre-PR verdict, and the head it is for. */
  preStatus?: RunStatus
  preHead?: string
  /** Why the post-PR phase stopped short of ready. */
  /** awaiting-decision: only deferrals hold the merge, and only the person's waiver releases them (R39). */
  postStatus?: 'exhausted' | 'blocked' | 'awaiting-decision' | 'error' | 'stopped'
  message?: string
  effort?: Effort
  hasTimedOut?: boolean
  passedEffort?: Effort
  updatedAt: number
}

export type Run = {
  id: string
  cwd: string
  root: string
  branch: string
  base: string
  headSha: string
  tier: Tier
  tierWhy: string
  lane: Lane
  /** The effort Codex runs at now; a timeout steps it down and reruns the round. */
  effort: Effort
  /** The effort this branch's tier and lane call for, before any carried or timeout step-down. */
  startEffort?: Effort
  /**
   * The effort the branch carries into later runs: the start, lowered only by timeouts. A re-review's capped effort (rereviewEffort)
   * is this run's alone and never carries. Absent on a run from before 1.2.0, which carries `effort`.
   */
  carriedEffort?: Effort
  /** The Codex model the gate names for this run's tier (codexModel or codexModelHigh, R69); undefined names none, so gstack's own order picks it. */
  codexModel?: string
  /** What each role reported running, from its `CODEX_MODEL:` line. A model other than the named one stops the round (R69). */
  ranModels?: RanModels
  round: number
  status: RunStatus
  phase: 'scope' | 'review' | 'fix' | 'verify' | 'collect' | 'triage' | 'done'
  /** Which side of the PR this round is on. */
  lifecycle: 'pre' | 'post'
  roundKind: RoundKind
  roundStartHead: string
  roundStartedAt: number
  /** The diff base the Codex review reads: origin/<base> before the PR, the last reviewed head after it. */
  diffBase: string
  evidence: Evidence[]
  /** Agent-step time and reviewer-wait time spent in this round so far. */
  activeMs: number
  waitMs: number
  /** Post-PR collection: when it started, when feedback last arrived, when gh was last polled. */
  collect?: { startedAt: number; lastArrivalAt: number; polledAt: number; headAt: number }
  /** Post-PR: the feedback ids handed to the main agent in the triage turn in flight (or the last one). */
  triaged?: string[]
  /** Post-PR: the feedback ids every triage turn of this round was handed (R88); a turn while collecting asks only what is not in it. */
  handed?: string[]
  /** Post-PR: the fresh feedback ids the last poll saw, so the next poll can tell what arrived since. */
  polled?: string[]
  /**
   * afterTriage is between clearing a turn taken while collecting and its last write (R88, A4): when it began, so polls only note
   * arrivals; a flag older than the step timeout is stale, and a poll clears it.
   */
  isSettling?: number
  /** Post-PR: how many triage turns taken while collecting timed out this round (R88). The first goes back to collecting; a second stops the run. */
  midTurnTimeouts?: number
  /** Post-PR: the finding ids the triage step was asked to answer (fresh, Codex's, carried). */
  asked?: string[]
  /** Post-PR: the security rebuttals Codex is checking (R36). */
  rechecks?: string[]
  /** Post-PR: a triage re-opened on resume for a block the agent can answer on the same head (R37); it records no round. */
  isAnswer?: true
  /** A prompt the ticker submits once the command that queued it has returned. */
  outbox?: string
  hasRefixed: boolean
  /** The fix step was asked once more about findings it left without an answer (it costs no round). */
  hasReprompted?: boolean
  /** The Codex check gave no verdict on reported fixes and ran once more (R72); a second miss leaves them owed. */
  hasRetriedCheck?: boolean
  /** What the fix step in flight (or the last one) was sent: blocking findings, or advisories alone. */
  fixKind: 'blocking' | 'advisory'
  steps: Step[]
  findings: Finding[]
  pending: Pending[]
  activity: string
  startedAt: number
  phaseStartedAt: number
  endedAt?: number
  message?: string
}

/** A CI check on a PR head, by gh's bucket (pass, fail, cancel, pending, skipping), and whether the base requires it (R86). */
export type CheckState = { name: string; bucket: string; isRequired: boolean }

export type Blocker = {
  kind:
    | 'open' | 'verify-owed' | 'reverify-owed' | 'rebuttal-unchecked' | 'disputed' | 'deferred' | 'security-p1'
    | 'deferral-unchecked' | 'issue-owed' | 'issue-failed' | 'label-failed' | 'link-unchecked'
    | 'head-unreviewed' | 'round-owed' | 'retargeted' | 'ci-failing' | 'ci-running' | 'ci-unreadable'
  /** A finding id, or a check name. */
  id?: string
  /** gh's own words for a ci-unreadable blocker. */
  detail?: string
  /** One line, with the stored (triaged) severity. */
  said: string
  owner: 'agent' | 'codex' | 'person' | 'gate'
  /** The exact step that clears it. */
  release: string
}

/** Everything between a head and its merge (R79): one list, none short-circuited. */
export type Standing = {
  phase: 'pre' | 'post'
  head: string
  waiver?: Waiver
  /** Checks GitHub doesn't require that a post waiver set aside (R86). */
  setAside: string[]
  mayProceed: boolean
  blockers: Blocker[]
}

declare module 'claude-code' {
  interface PluginState {
    'pr-lifecycle': { run: Run | null; tick: number }
  }
}
