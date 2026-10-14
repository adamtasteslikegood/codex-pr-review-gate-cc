export type Severity = 'P0' | 'P1' | 'P2' | 'P3'

export type FindingStatus = 'open' | 'fixed' | 'rebutted' | 'deferred'

export type Finding = {
  id: string
  round: number
  source: 'review' | 'challenge'
  severity: Severity
  title: string
  file?: string
  line?: number
  detail?: string
  status: FindingStatus
  note?: string
}

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type Step = { id: string; label: string; state: StepState; detail?: string }

export type Role = 'review' | 'challenge' | 'fix' | 'verify'

export type Pending = {
  role: Role
  /** The step's name, which the agent repeats in its trailer. */
  step: string
  /** A sub-agent's id, as the engine gave it. */
  agentId?: string
  /** True for the main agent, which has no id. */
  isMain?: true
  /** Main agent only: true once its turn has started. */
  isArmed?: boolean
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
  round: number
  maxRounds: number
  status: RunStatus
  phase: 'scope' | 'review' | 'fix' | 'verify' | 'done'
  hasRefixed: boolean
  /** What the fix step in flight (or the last one) was sent: blocking findings, or advisories alone. */
  fixKind: 'blocking' | 'advisory'
  /** Advisory rounds started so far; they do not count against maxRounds. */
  advisoryRound: number
  advisoryMin: number
  advisoryMax: number
  steps: Step[]
  findings: Finding[]
  pending: Pending[]
  activity: string
  startedAt: number
  phaseStartedAt: number
  endedAt?: number
  message?: string
}

export type PassRecord = {
  sha: string
  base: string
  status: RunStatus
  at: number
  rounds: number
  note?: string
  /** The effort Codex last ran at for this branch. */
  effort?: Effort
  /** The run ended because Codex timed out at its lowest effort, or on the step timeout. */
  hasTimedOut?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'codex-gate': { run: Run | null; tick: number }
  }
}
