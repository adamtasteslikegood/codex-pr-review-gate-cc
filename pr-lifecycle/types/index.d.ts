export type Severity = 'P0' | 'P1' | 'P2' | 'P3'

/** open is the spec's "still unresolved". fixed is split: what the fixer reported, and what a check confirmed. */
export type FindingStatus = 'open' | 'reported-fixed' | 'verified-fixed' | 'rebutted' | 'deferred'

export type FindingSource = 'codex-review' | 'codex-challenge' | 'github'

export type FindingEvent = { round: number; status: FindingStatus; note?: string; evidence?: string; by: string; at: number }

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
  title: string
  file?: string
  line?: number
  detail?: string
  /** The head it was raised on. */
  headSeen: string
  status: FindingStatus
  note?: string
  /** A later change touched its file: the evidence behind its status needs checking again. */
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

export type Grant = { n: number; reason: string; head: string; at: number }

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
  waivers: Waiver[]
  phase: LifecyclePhase
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
  /** Post-PR: the feedback ids handed to the main agent this round. */
  triaged?: string[]
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

declare module 'claude-code' {
  interface PluginState {
    'pr-lifecycle': { run: Run | null; tick: number }
  }
}
