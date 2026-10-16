// pr-lifecycle's rounds: each step is an agent, and its `turn.complete` moves the
// round on. A round that ends goes into the lifecycle record, and the controller
// (`advance`) chooses what comes next from the record alone. Nothing here waits
// on a step inside one dispatch. `advance` lives here, not in register.tsx: the
// engine follows `$` across files only into function declarations it can see.

import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Effort, Evidence, Finding, LifecycleRecord, Pending, Role, RoundRecord, Run, RunStatus, Step } from '../types'
import {
  compileRisk,
  fixPrompt,
  lowerOf,
  heldPrompt,
  listFindingsOf,
  prPrompt,
  readDispositions,
  readReview,
  readTrailer,
  readTriage,
  readVerify,
  readyPrompt,
  reportPrompt,
  reviewPrompt,
  stepDown,
  stepOf,
  TRAILER,
  triagePrompt,
  verifyPrompt,
} from './core'
import { collectionDone, readCheckRuns, readInlineComments, readIssueComments, readReviews, readRoster, severityHint } from './github'
import type { Check, Feedback, Roster } from './github'
import {
  applyAnswer,
  decideNext,
  invalidate,
  isBlocking,
  lastReviewedHead,
  markHeld,
  markVerified,
  mergeFindings,
  nextIds,
  raisedIn,
  roundOf,
  triage,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
  withRound,
} from './lifecycle'
import type { Allowances, Next } from './lifecycle'
import { loadRecord, updateRecord } from './store'

export const PANE = 'pr-lifecycle'
const RUN = { plugin: 'pr-lifecycle', key: 'run' } as const
const runAtom = atom(RUN, null)
const tickAtom = atom({ plugin: 'pr-lifecycle', key: 'tick' } as const, 0)
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type Engine = EngineInterface

export type Config = {
  allowances: Allowances
  bases: string[]
  enforce: boolean
  enforceMerge: boolean
  fixer: 'main' | 'subagent'
  fixReview: 'auto' | 'always' | 'never'
  onExhausted: 'open-pr' | 'stop'
  openPr: boolean
  highRisk: RegExp | undefined
  stepTimeoutMs: number
  routineRoundMs: number
  waitCapMs: number
  quietMs: number
  /** Effort for a standard change; a high blast-radius change always starts at high. */
  effort: Effort
  /** Effort for a light-lane (chore/) branch that is not high blast radius. */
  lightEffort: Effort
  light: RegExp | undefined
}

const effortOf = (value: unknown, fallback: Effort): Effort =>
  value === 'high' || value === 'medium' || value === 'low' ? value : fallback

export function configOf(options: PluginOptions): Config {
  const number = (key: string, fallback: number): number => {
    const value = Number(options[key])
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
  }
  const bases = String(options.bases ?? 'dev,main')
    .split(',')
    .map(one => one.trim())
    .filter(one => one !== '')
  return {
    // 0.3.1's maxRounds is read when allowanceStandard is unset (a hand-written options file).
    allowances: {
      standard: Math.min(number('allowanceStandard', number('maxRounds', 4)), 10),
      high: Math.min(number('allowanceHigh', 6), 12),
    },
    bases: bases.length > 0 ? bases : ['dev', 'main'],
    enforce: options.enforce !== false,
    enforceMerge: options.enforceMerge !== false,
    fixer: options.fixer === 'subagent' ? 'subagent' : 'main',
    fixReview: options.fixReview === 'always' || options.fixReview === 'never' ? options.fixReview : 'auto',
    onExhausted: options.onExhausted === 'stop' ? 'stop' : 'open-pr',
    openPr: options.openPr !== false,
    highRisk: compileRisk(String(options.highRiskPaths ?? '')),
    stepTimeoutMs: number('stepTimeoutMinutes', 30) * 60_000,
    routineRoundMs: number('routineRoundMinutes', 3) * 60_000,
    waitCapMs: number('waitCapMinutes', 20) * 60_000,
    quietMs: number('quietMinutes', 3) * 60_000,
    effort: effortOf(options.reviewEffort, 'medium'),
    lightEffort: effortOf(options.lightEffort, 'low'),
    light: compileRisk(String(options.lightBranches ?? '^chore/')),
  }
}

export const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Sets a step, adding it ahead of the closing "open PR" step when it is new. */
export function withStep(steps: readonly Step[], step: Step): Step[] {
  if (steps.some(one => one.id === step.id)) {
    return steps.map(one => (one.id === step.id ? { ...one, ...step } : one))
  }
  const last = steps.findIndex(one => one.id === 'pr')
  return last < 0 ? [...steps, step] : [...steps.slice(0, last), step, ...steps.slice(last)]
}

// The module's own: what `register` was last given, and what a reload resets.
let config: Config = configOf({})
// Unknown after a reload, so the first event looks; false once no run is on.
let isLive = true
let ticker: { cancel: () => void } | undefined
// One poll at a time: ticks overlap while gh is slow.
let isPolling = false

export function setup(c: Config): void {
  config = c
}

export const isLiveNow = (): boolean => isLive
export const setLive = (v: boolean): void => {
  isLive = v
}

/** The effort a branch's tier and lane call for, before any carried or timeout step-down. */
export const defaultEffort = (rec: Pick<LifecycleRecord, 'tier' | 'lane'>): Effort =>
  rec.tier === 'high' ? 'high' : rec.lane === 'light' ? config.lightEffort : config.effort

export async function getRun($: Engine): Promise<Run | null> {
  return (await $.state.get(RUN)).value ?? null
}

/** Applies a change to the run in flight; a run that ended or was replaced is left alone. */
export async function patch($: Engine, id: string, change: (run: Run) => Run): Promise<Run | null> {
  let after: Run | null = null
  await update($, runAtom, run => {
    after = run !== null && run !== undefined && run.id === id && run.status === 'running' ? change(run) : (run ?? null)
    return after
  })
  return after
}

/** Sets the closing "open PR" step of the run shown, running or not. */
export async function markPr($: Engine, state: Step['state'], detail: string | undefined): Promise<void> {
  await update($, runAtom, run =>
    run === null || run === undefined ? null : { ...run, steps: run.steps.map(step => (step.id === 'pr' ? { ...step, state, detail } : step)) },
  )
}

export async function git($: Engine, cwd: string | undefined, args: string[], timeoutMs = 30_000): Promise<{ isOk: boolean; out: string; err: string }> {
  const ran = await $.process.run(['git', ...args], { cwd, timeoutMs })
  return { isOk: ran.exitCode === 0, out: ran.stdout.trim(), err: ran.stderr.trim() }
}

const stopTicker = (): void => {
  ticker?.cancel()
  ticker = undefined
}

export function startTicker($: Engine): void {
  stopTicker()
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const now = await $.clock.now()
      const run = await getRun($)
      if (run === null || run.status !== 'running') {
        stopTicker()
        isLive = false
        return
      }
      await update($, tickAtom, () => now)
      if (run.phase === 'collect') {
        await poll($, run)
        return // waiting on reviewers is not a step: no step timeout while collecting
      }
      if (now - run.phaseStartedAt > config.stepTimeoutMs) {
        const why = `The ${run.phase} step ran past ${elapsed(config.stepTimeoutMs)}.`
        if (run.phase === 'review') {
          await noteAttempt($, run, why)
          await retryLower($, run, why)
        } else {
          await noteAttempt($, run, why)
          await finish($, run.id, 'error', why, true)
        }
      }
    })().catch(() => undefined)
  })
}

// ------------------------------------------------------------- the end

/**
 * Ends the run in flight. It opens no pull request (the controller decides that); it writes
 * where the branch's next Codex effort starts onto the record. Returns the ended run, or null.
 */
export async function finish($: Engine, id: string, status: RunStatus, message: string, hasTimedOut = false): Promise<Run | null> {
  const now = await $.clock.now()
  const isOpenable = status === 'passed' || status === 'exhausted' || status === 'waived'
  // A stop mid-round is an attempt: its effort and its findings are kept.
  const before = status === 'stopped' ? await getRun($) : null
  if (before !== null && before.id === id && before.status === 'running') await noteAttempt($, before, message)
  let isEnded = false
  const run = await patch($, id, one => {
    isEnded = true
    return {
      ...one,
      status,
      phase: 'done',
      message,
      endedAt: now,
      pending: [],
      activity: '',
      steps: one.steps.map(step =>
        step.id === 'pr'
          ? { ...step, state: isOpenable ? 'pending' : 'skipped', detail: undefined }
          : step.state === 'running'
            ? { ...step, state: status === 'error' || status === 'stopped' ? 'failed' : 'done' }
            : step,
      ),
    }
  })
  stopTicker()
  isLive = false
  if (!isEnded || run === null) return null
  const ended: Run = run
  // A review that completed below the branch's default sets where the next run starts; a run that never completed one keeps the last.
  const hasReviewed = status === 'passed' || status === 'exhausted' || status === 'blocked'
  await updateRecord($, ended.root, ended.branch, rec => {
    const passedEffort = hasReviewed ? ended.effort : rec.passedEffort
    const start = ended.startEffort ?? 'high'
    const isBelow = passedEffort !== undefined && passedEffort !== start && lowerOf(passedEffort, start) === passedEffort
    return {
      ...rec,
      effort: ended.effort,
      hasTimedOut: hasTimedOut ? true : undefined,
      passedEffort: isBelow ? passedEffort : undefined,
      ...(ended.lifecycle === 'post' && (status === 'error' || status === 'stopped') ? { postStatus: status } : {}),
    }
  })
  $.ui.status(undefined)
  $.ui.toast(`pr-gate ${status}: ${message}`.slice(0, 300))
  return ended
}

// ----------------------------------------------------------- the steps

async function spawn($: Engine, run: Run, role: Role, prompt: string): Promise<{ isStarted: boolean; agentId?: string }> {
  const started = await $.agent.spawn({
    prompt,
    description: `codex-gate r${run.round} ${role}`,
    subagentType: 'general-purpose',
    cwd: run.root,
  })
  return 'deny' in started && typeof started.deny === 'string' ? { isStarted: false } : { isStarted: true, agentId: started.agentId }
}

async function beginReview($: Engine, id: string): Promise<void> {
  const now = await $.clock.now()
  const opened = await patch($, id, run => {
    const roles: Role[] = run.tier === 'high' ? ['review', 'challenge'] : ['review']
    return {
      ...run,
      phase: 'review',
      phaseStartedAt: now,
      pending: [],
      activity: 'starting the Codex reviewer…',
      steps: roles.reduce(
        (steps, role) =>
          withStep(steps, {
            id: `r${run.round}-${role}`,
            label: `Round ${run.round} · codex ${role} (${run.effort})`,
            state: 'running',
            detail: undefined,
          }),
        run.steps,
      ),
    }
  })
  if (opened === null) return
  const roles = opened.tier === 'high' ? (['review', 'challenge'] as const) : (['review'] as const)
  $.ui.status(`pr-gate r${opened.round}: codex reviewing (${opened.effort})`)
  // Parallel sub-agents: on a high blast-radius change the review and the challenge run side by side.
  // The review gets the whole ledger; reviewPrompt lists the answered findings it should check.
  const started = await Promise.all(roles.map(role => spawn($, opened, role, reviewPrompt(opened, role, opened.findings))))
  if (started.some(one => !one.isStarted)) {
    await finish($, id, 'error', 'A Codex reviewer sub-agent could not be started.')
    return
  }
  await patch($, id, run => ({
    ...run,
    pending: roles.map((role, at) => ({ role, step: stepOf(run, role), agentId: started[at]?.agentId })),
    activity: 'waiting on the Codex reviewer…',
  }))
}

async function beginFix($: Engine, id: string, notes: string | undefined, kind: Run['fixKind'] = 'blocking'): Promise<void> {
  const now = await $.clock.now()
  const isMain = config.fixer === 'main'
  const opened = await patch($, id, run => ({
    ...run,
    fixKind: kind,
    phase: 'fix',
    phaseStartedAt: now,
    pending: isMain ? [{ role: 'fix', step: stepOf(run, 'fix'), isMain: true }] : [],
    activity: isMain ? 'waiting on the main agent to fix…' : 'starting the fixer…',
    steps: withStep(run.steps, {
      id: `r${run.round}-fix${notes === undefined ? '' : '-again'}`,
      label:
        kind === 'advisory'
          ? `Round ${run.round} · advisories (${isMain ? 'main agent' : 'sub-agent'})`
          : `Round ${run.round} · ${notes === undefined ? 'fix' : 'fix again'} (${isMain ? 'main agent' : 'sub-agent'})`,
      state: 'running',
    }),
  }))
  if (opened === null) return
  $.ui.status(`pr-gate r${opened.round}: ${kind === 'advisory' ? 'addressing advisories' : 'fixing'}`)
  const prompt = fixPrompt(opened, notes, isMain)
  if (!isMain) {
    const { isStarted, agentId } = await spawn($, opened, 'fix', prompt)
    if (!isStarted) {
      await finish($, id, 'error', 'The fixer sub-agent could not be started.')
      return
    }
    await patch($, id, run => ({ ...run, pending: [{ role: 'fix', step: stepOf(run, 'fix'), agentId }], activity: 'waiting on the fixer…' }))
    return
  }
  // The prompt waits for the session to go idle; it is armed once its turn starts,
  // so a turn already running when the findings came in is never read as the fix.
  void $.prompt
    .submit({ text: prompt })
    .then(async entered => {
      if ('drop' in entered && typeof entered.drop === 'string') {
        await finish($, id, 'error', `The findings could not be sent to the main agent: ${entered.drop}`)
        return
      }
      await patch($, id, run => (run.phase === 'fix' ? { ...run, pending: run.pending.map(one => ({ ...one, isArmed: true })) } : run))
      // The step's clock starts with the turn, not with the wait for the session to go idle.
      const startedAt = await $.clock.now()
      await patch($, id, run => (run.phase === 'fix' ? { ...run, phaseStartedAt: startedAt } : run))
    })
    .catch(() => undefined)
}

async function beginVerify($: Engine, id: string, fromSha: string): Promise<void> {
  const now = await $.clock.now()
  const opened = await patch($, id, run => ({
    ...run,
    phase: 'verify',
    phaseStartedAt: now,
    pending: [],
    activity: 'starting the fix reviewer…',
    steps: withStep(run.steps, { id: `r${run.round}-verify`, label: `Round ${run.round} · review the fix`, state: 'running' }),
  }))
  if (opened === null) return
  $.ui.status(`pr-gate r${opened.round}: reviewing the fix`)
  const { isStarted, agentId } = await spawn($, opened, 'verify', verifyPrompt(opened, fromSha))
  if (!isStarted) {
    await finish($, id, 'error', 'The fix reviewer sub-agent could not be started.')
    return
  }
  await patch($, id, run => ({ ...run, pending: [{ role: 'verify', step: stepOf(run, 'verify'), agentId }], activity: 'waiting on the fix reviewer…' }))
}

const POLL_MS = 30_000

/** Post-PR collection: the ticker polls GitHub every 30 s until the roster, the checks and a quiet spell say it is over, or the wait cap. */
async function beginCollect($: Engine, id: string): Promise<void> {
  const now = await $.clock.now()
  const opened = await patch($, id, run => ({
    ...run,
    phase: 'collect',
    phaseStartedAt: now,
    collect: { startedAt: now, lastArrivalAt: now, polledAt: 0, headAt: now },
    activity: 'waiting on reviewers…',
    steps: withStep(run.steps, { id: `r${run.round}-collect`, label: `Round ${run.round} · collect reviews (${run.roundKind})`, state: 'running' }),
  }))
  if (opened === null) return
  const rec = await loadRecord($, opened.root, opened.branch)
  // A later post-PR round, on a new head: ask the roster's reviewers to look again.
  if (rec !== undefined && rec.rounds.some(one => one.phase === 'post' && one.isCompleted) && rec.pr !== undefined && rec.slug !== undefined) {
    const roster = await rosterOf($, opened.root)
    for (const who of roster?.requestReview ?? []) {
      await $.process.run(['gh', 'api', '-X', 'POST', `repos/${rec.slug}/pulls/${rec.pr}/requested_reviewers`, '-f', `reviewers[]=${who}`], {
        cwd: opened.root,
        timeoutMs: 30_000,
      })
    }
  }
  $.ui.status(`pr-gate r${opened.round}: waiting on reviewers`)
}

async function rosterOf($: Engine, root: string): Promise<Roster | undefined> {
  const file = await git($, root, ['show', 'HEAD:.github/pr-gate.json'])
  return file.isOk ? readRoster(file.out) : undefined
}

async function ghJson($: Engine, root: string, path: string): Promise<{ isOk: boolean; out: string; err: string }> {
  const ran = await $.process.run(['gh', 'api', '--paginate', path], { cwd: root, timeoutMs: 60_000 })
  return { isOk: ran.exitCode === 0, out: ran.stdout, err: ran.stderr.trim() || `exit ${ran.exitCode}` }
}

type Fetched = { isOk: boolean; why?: string; feedback: Feedback[]; checks: Check[]; prHead: string }

/** Everything GitHub holds for the PR now. Only these polls establish that feedback arrived. */
async function fetchFeedback($: Engine, rec: LifecycleRecord): Promise<Fetched> {
  const fail = (why: string): Fetched => ({ isOk: false, why, feedback: [], checks: [], prHead: rec.head })
  if (rec.pr === undefined || rec.slug === undefined) return fail('the PR number or repository is not known')
  // Without this machine's login its own replies would read as reviewer coverage: look it up again, else fail closed.
  let self = rec.self
  if (self === undefined || self === '') {
    const who = await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { cwd: rec.root, timeoutMs: 30_000 })
    self = who.exitCode === 0 ? who.stdout.trim() : ''
    if (self === '') return fail('gh did not say which gh login this machine uses, so its own replies cannot be told from reviews; check gh auth login')
    const found = self
    await updateRecord($, rec.root, rec.branch, one => ({ ...one, self: found }))
  }
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr), '--json', 'headRefOid'], { cwd: rec.root, timeoutMs: 30_000 })
  if (pr.exitCode !== 0) {
    return fail(`gh could not read PR #${rec.pr} (${pr.stderr.trim().slice(0, 160) || `exit ${pr.exitCode}`}); check gh auth login and the network`)
  }
  let prHead: string | undefined
  try {
    prHead = (JSON.parse(pr.stdout) as { headRefOid?: unknown } | null)?.headRefOid as string | undefined
  } catch {
    prHead = undefined
  }
  if (typeof prHead !== 'string' || prHead === '') {
    return fail(`gh returned unreadable output for PR #${rec.pr} (${pr.stdout.trim().slice(0, 80)}); check gh auth login, rate limits and the network`)
  }
  const at = `repos/${rec.slug}`
  const [reviews, inline, comments, checks] = await Promise.all([
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/reviews`),
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/issues/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/commits/${prHead}/check-runs`),
  ])
  const bad = [reviews, inline, comments, checks].find(one => !one.isOk)
  if (bad !== undefined) return fail(`gh api failed (${bad.err.slice(0, 160)}); check gh auth login, rate limits and the network`)
  // A proxy's error page or a cut-off page is not "no feedback" (R12): the poll fails closed.
  try {
    const feedback = [...readReviews(reviews.out), ...readInlineComments(inline.out), ...readIssueComments(comments.out)].filter(
      one => one.reviewer !== self,
    )
    return { isOk: true, feedback, checks: readCheckRuns(checks.out), prHead }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    return fail(`gh returned unreadable output (${said}); check gh auth login, rate limits and the network`)
  }
}

/** One poll of a collecting round: fail closed on gh trouble, else end collection when it is done. */
async function poll($: Engine, seen: Run): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    await pollOnce($, seen)
  } finally {
    isPolling = false
  }
}

async function pollOnce($: Engine, seen: Run): Promise<void> {
  const now = await $.clock.now()
  // Read again: another tick may have polled since this one read the run.
  const run = await getRun($)
  const collect = run?.collect
  if (run === null || run.id !== seen.id || run.status !== 'running' || run.phase !== 'collect' || collect === undefined) return
  if (now - collect.polledAt < POLL_MS) return
  await patch($, run.id, one => ({ ...one, collect: one.collect === undefined ? one.collect : { ...one.collect, polledAt: now } }))
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) {
    await finish($, run.id, 'error', `The lifecycle record of ${run.branch} is gone, so post-PR round ${run.round} cannot go on. Run /pr-gate to start it again.`)
    return
  }
  let got: Fetched
  try {
    got = await fetchFeedback($, rec)
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    got = { isOk: false, why: `gh failed (${said.slice(0, 160)}); check gh auth login, rate limits and the network`, feedback: [], checks: [], prHead: rec.head }
  }
  if (!got.isOk) {
    await noteAttempt($, run, got.why ?? 'gh failed')
    await finish($, run.id, 'error', `Post-PR round ${run.round} could not read GitHub: ${got.why ?? 'gh failed'}. Fix that, then /pr-gate resume.`)
    return
  }
  const fresh = got.feedback.filter(one => !rec.processed.includes(one.id))
  const lastArrivalAt = Math.max(collect.lastArrivalAt, ...fresh.map(one => Math.min(one.at, now)))
  // The PR's head, not the local one, is what the round covers (an adopted PR, another agent's push).
  const isNewHead = got.prHead !== run.roundStartHead
  const headAt = isNewHead ? now : collect.headAt
  // A new head restarts the quiet period: its checks may not be registered yet.
  const arrived = isNewHead || fresh.length > (run.triaged?.length ?? 0)
  const after = await patch($, run.id, one => ({
    ...one,
    roundStartHead: got.prHead,
    collect: { ...collect, polledAt: now, lastArrivalAt: arrived ? now : lastArrivalAt, headAt },
    triaged: fresh.map(each => each.id),
  }))
  if (after === null) return
  const roster = await rosterOf($, run.root)
  const done = collectionDone({
    roster,
    feedback: got.feedback,
    checks: got.checks,
    head: got.prHead,
    headAt,
    startedAt: collect.startedAt,
    lastArrivalAt: after.collect?.lastArrivalAt ?? now,
    now,
    quietMs: (roster?.quietMinutes ?? config.quietMs / 60_000) * 60_000,
    capMs: (roster?.waitCapMinutes ?? config.waitCapMs / 60_000) * 60_000,
  })
  if (!done.isDone) {
    const waiting = done.missing.length > 0 ? `waiting on ${done.missing.join(', ')}` : 'waiting for feedback to go quiet'
    if (waiting !== after.activity) await patch($, run.id, one => ({ ...one, activity: waiting }))
    return
  }
  await endCollect($, after, got, done)
}

/** Collection is over: Codex covers a head nobody reviewed (or verification owed); then the feedback goes to triage. */
async function endCollect($: Engine, run: Run, got: Fetched, done: ReturnType<typeof collectionDone>): Promise<void> {
  const now = await $.clock.now()
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
  const waitMs = now - (run.collect?.startedAt ?? now)
  // Each reviewer who covered the head; each roster reviewer who never did, as missing evidence.
  const roster = await rosterOf($, run.root)
  const evidence: Evidence[] = [
    ...done.covered.map(reviewer => ({ source: 'github' as const, reviewer, head: got.prHead, isComplete: true })),
    ...(roster?.reviewers ?? [])
      .filter(one => done.missing.includes(one))
      .map(reviewer => ({ source: 'github' as const, reviewer, head: got.prHead, isComplete: false })),
  ]
  // Covered: complete evidence for this very head, now or in an earlier completed round (the pre-PR Codex review of it, say).
  const isCovered = [...evidence, ...rec.rounds.filter(one => one.isCompleted).flatMap(one => one.evidence)].some(
    each => each.isComplete && each.head === got.prHead,
  )
  const owesVerification = verificationOwed(rec).length > 0
  const isPassThroughRound1 = rec.passThrough !== undefined && rec.rounds.every(one => one.phase !== 'post' || !one.isCompleted)
  const hasFindings = got.feedback.some(one => one.isFinding && !rec.processed.includes(one.id))
  const after = await patch($, run.id, one => ({
    ...one,
    waitMs: one.waitMs + waitMs,
    evidence,
    headSha: got.prHead,
    collect: undefined,
    steps: withStep(one.steps, {
      id: `r${one.round}-collect`,
      label: `Round ${one.round} · collect reviews (${one.roundKind})`,
      state: 'done',
      detail: `${done.covered.length} reviewer${done.covered.length === 1 ? '' : 's'}${done.isComplete ? '' : `, missing ${done.missing.join(', ')}`}`,
    }),
  }))
  if (after === null) return
  if (run.roundKind === 'final-head-check' || ((!isCovered || owesVerification) && !isPassThroughRound1)) {
    // Codex reads the local checkout: it must be the PR head, or it would review something else.
    const local = await git($, run.root, ['rev-parse', 'HEAD'])
    if (!local.isOk || local.out !== got.prHead) {
      const here = local.isOk ? local.out.slice(0, 7) : 'unknown'
      const why = `the local checkout ${here} is not the PR head ${got.prHead.slice(0, 7)}: pull (or push), then run pr-gate resume`
      await noteAttempt($, after, why)
      await finish($, run.id, 'error', `Post-PR round ${run.round} needs a Codex review, but ${why}.`)
      return
    }
    await beginReview($, run.id) // the Codex fallback: reviewPrompt reads run.diffBase (the last reviewed head)
    return
  }
  // Nobody covered the head and Codex was skipped (a pass-through's round 1): fresh findings still go to triage;
  // only a round with nothing to triage ends here.
  if (!isCovered && !hasFindings) {
    await noteAttempt($, after, `no reviewer covered ${got.prHead.slice(0, 7)} within the wait cap`)
    await finish($, run.id, 'error', `No reviewer covered ${got.prHead.slice(0, 7)} within the wait cap. Run /pr-gate resume to wait again.`)
    return
  }
  await beginTriage($, after.id)
}

/** A post-PR step could not read GitHub or the checkout: an attempt, no round used, and the agent is told its next step. */
async function failPost($: Engine, run: Run, why: string): Promise<void> {
  await noteAttempt($, run, why)
  await finish($, run.id, 'error', `Post-PR round ${run.round} stopped: ${why}.`)
  void $.prompt.submit({ text: `pr-gate: post-PR round ${run.round} on ${run.branch} stopped: ${why}.` }).catch(() => undefined)
}

/**
 * Triage: the round's fresh GitHub feedback, and Codex's open findings when it ran, go to the main agent in one turn.
 * Feedback that raises nothing (approvals, empty reviews) and no commits from elsewhere end the round clean (R3).
 */
async function beginTriage($: Engine, id: string): Promise<void> {
  const now = await $.clock.now()
  const run = await getRun($)
  if (run === null || run.id !== id || run.status !== 'running') return
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) {
    await finish($, run.id, 'error', `The lifecycle record of ${run.branch} is gone, so post-PR round ${run.round} cannot go on. Run /pr-gate to start it again.`)
    return
  }
  let got: Fetched
  try {
    got = await fetchFeedback($, rec)
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    got = { isOk: false, why: `gh failed (${said.slice(0, 160)}); check gh auth login, rate limits and the network`, feedback: [], checks: [], prHead: rec.head }
  }
  if (!got.isOk) {
    await failPost($, run, `GitHub could not be read: ${got.why ?? 'gh failed'}; fix that, then run pr-gate resume`)
    return
  }
  const items = got.feedback.filter(one => one.isFinding && !rec.processed.includes(one.id))
  const lastHead = lastReviewedHead(rec)
  // What changed since the last reviewed head; nothing when this round reviews that same head.
  const changed = lastHead === undefined || lastHead === run.headSha ? undefined : await git($, run.root, ['diff', '--name-only', lastHead, run.headSha])
  const changedFiles = new Set(changed?.isOk === true ? changed.out.split('\n').filter(Boolean) : [])
  const ledger = mergeFindings(rec.findings, run.findings)
  // Fresh ids number after every G{round}-k already in the run or the record (R23).
  const idOf = nextIds(`G${run.round}-`, [run.findings, rec.findings])
  const fresh: Finding[] = []
  const listed = items.map(feedback => {
    const title = feedback.body.split('\n')[0]?.replace(/[*_`#>]/g, '').trim().slice(0, 200) || `${feedback.reviewer} ${feedback.kind}`
    // Feedback an interrupted attempt already numbered keeps its finding: one id per piece of feedback.
    const known = ledger.find(one => one.externalId === feedback.id)
    const placed = triage({ file: feedback.file, line: feedback.line, title }, ledger.filter(one => one.externalId !== feedback.id), changedFiles)
    if (known !== undefined) return { feedback, cls: placed.cls, matchId: placed.matchId, findingId: known.id }
    const hint = severityHint(feedback.body)
    const finding: Finding = {
      id: idOf(fresh.length + 1),
      round: run.round,
      source: 'github',
      reviewer: feedback.reviewer,
      externalId: feedback.id,
      ...(feedback.threadId === undefined ? {} : { threadId: feedback.threadId }),
      ...(feedback.url === undefined ? {} : { url: feedback.url }),
      severity: hint.severity,
      ...(hint.isSecurity ? { isSecurity: true } : {}),
      title,
      ...(feedback.file === undefined ? {} : { file: feedback.file }),
      ...(feedback.line === undefined ? {} : { line: feedback.line }),
      detail: feedback.body.slice(0, 4000),
      headSeen: run.headSha,
      status: 'open',
      history: [{ round: run.round, status: 'open', by: feedback.reviewer, at: now }],
    }
    fresh.push(finding)
    return { feedback, cls: placed.cls, matchId: placed.matchId, findingId: finding.id }
  })
  // Codex's findings of this round still open (the fallback or the final-head check): answered in the same turn.
  const codex = run.findings.filter(one => one.source !== 'github' && raisedIn(one, run.round) && one.status === 'open')
  // Commits on the PR that this machine did not make.
  const log = got.prHead === rec.head ? undefined : await git($, run.root, ['log', '--format=%h %an %s', `${rec.head}..${got.prHead}`])
  const others = log?.isOk === true ? log.out.split('\n').filter(Boolean) : []
  if (listed.length === 0 && codex.length === 0 && others.length === 0) {
    await endRound($, run, true)
    return
  }
  const count = listed.length + codex.length
  const opened = await patch($, id, one => ({
    ...one,
    phase: 'triage',
    phaseStartedAt: now,
    findings: mergeFindings(one.findings, fresh),
    triaged: items.map(each => each.id),
    pending: [{ role: 'triage', step: stepOf(one, 'triage'), isMain: true }],
    activity: 'waiting on the main agent to answer the reviews…',
    steps: withStep(one.steps, {
      id: `r${one.round}-triage`,
      label: `Round ${one.round} · answer ${count} review item${count === 1 ? '' : 's'} (main agent)`,
      state: 'running',
    }),
  }))
  if (opened === null) return
  $.ui.status(`pr-gate r${opened.round}: answering the reviews`)
  const text = triagePrompt(opened, rec, listed, others)
  const range = `${opened.diffBase.slice(0, 7)}..${opened.headSha.slice(0, 7)}`
  const prompt = codex.length === 0 ? text : `${text}\n\nCodex also reviewed ${range}; answer these too:\n${listFindingsOf(codex)}`
  // As with the fix step: armed once its turn starts, so a turn already running is never read as the answer.
  void $.prompt
    .submit({ text: prompt })
    .then(async entered => {
      if ('drop' in entered && typeof entered.drop === 'string') {
        await finish($, id, 'error', `The reviews could not be sent to the main agent: ${entered.drop}`)
        return
      }
      const startedAt = await $.clock.now()
      await patch($, id, one =>
        one.phase === 'triage' ? { ...one, phaseStartedAt: startedAt, pending: one.pending.map(each => ({ ...each, isArmed: true })) } : one,
      )
    })
    .catch(() => undefined)
}

/** The main agent answered the reviews: record the answers and replies at once, then end the round on the PR head GitHub now reports. */
async function afterTriage($: Engine, run: Run): Promise<void> {
  const now = await $.clock.now()
  const said = readTriage(run.pending[0]?.answer ?? '')
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    findings: one.findings.map(finding => {
      const answer = said.find(each => each.id === finding.id)
      return answer === undefined ? finding : applyAnswer(finding, answer, one.round, 'main', now)
    }),
    steps: withStep(one.steps, {
      id: `r${one.round}-triage`,
      label: `Round ${one.round} · answer the reviews (main agent)`,
      state: 'done',
      detail: `${said.length} answered`,
    }),
  }))
  if (after === null) return
  // Before anything can end the round: the feedback is processed and its replies are known, so no reply is ever asked for twice.
  const triaged = run.triaged ?? []
  const rec = await updateRecord($, run.root, run.branch, one => ({
    ...one,
    findings: mergeFindings(one.findings, after.findings),
    processed: [...new Set([...one.processed, ...triaged])],
    replies: {
      ...one.replies,
      ...Object.fromEntries(
        said.flatMap(each => {
          const externalId = after.findings.find(f => f.id === each.id)?.externalId
          return each.replyId === undefined || externalId === undefined ? [] : [[externalId, each.replyId]]
        }),
      ),
    },
  }))
  if (rec === undefined) return
  const dirty = await git($, run.root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.isOk && dirty.out !== '') {
    await failPost($, after, 'the reviews were answered with uncommitted changes left: commit and push them, then run pr-gate resume')
    return
  }
  // The round ends on the PR head as GitHub reports it now (R28): this machine's push, or another agent's on top of it.
  const local = await git($, run.root, ['rev-parse', 'HEAD'])
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr ?? ''), '--json', 'headRefOid'], { cwd: run.root, timeoutMs: 30_000 })
  let prHead: string | undefined
  try {
    const read = pr.exitCode === 0 ? (JSON.parse(pr.stdout) as { headRefOid?: unknown } | null)?.headRefOid : undefined
    prHead = typeof read === 'string' && read !== '' ? read : undefined
  } catch {
    prHead = undefined
  }
  if (!local.isOk || prHead === undefined) {
    const what = !local.isOk ? 'the local HEAD could not be read' : `gh could not read the head of PR #${rec.pr}; check gh auth login and the network`
    await failPost($, after, `${what}, then run pr-gate resume`)
    return
  }
  const isContained = prHead === local.out || (await git($, run.root, ['merge-base', '--is-ancestor', local.out, prHead])).isOk
  if (!isContained) {
    await failPost($, after, `commits on ${run.branch} are not pushed: push, then pr-gate resume`)
    return
  }
  const endHead = prHead
  if (endHead !== run.roundStartHead) {
    const changed = await git($, run.root, ['diff', '--name-only', run.roundStartHead, endHead])
    const files = changed.isOk ? new Set(changed.out.split('\n').filter(Boolean)) : ('all' as const)
    // This round's answers are about the new head already; earlier answers on touched files need checking again.
    await patch($, run.id, one => ({
      ...one,
      findings: invalidate(one.findings, files).map(f => (f.round === one.round ? { ...f, needsRecheck: undefined } : f)),
    }))
  }
  const ended = await getRun($)
  if (ended !== null && ended.id === run.id && ended.status === 'running') await endRound($, { ...ended, headSha: endHead }, true)
}

/**
 * Codex timed out: rerun the same round one effort lower, spending no round. At low it
 * fails closed. A reviewer still running is not stopped (there is no way to); its late
 * answer is ignored, as `isMine` knows a sub-agent by the id it was given.
 */
async function retryLower($: Engine, run: Run, why: string): Promise<void> {
  const lower = stepDown(run.effort)
  if (lower === undefined) {
    await finish($, run.id, 'error', `${why} Codex timed out at low effort, the lowest the gate uses.`, true)
    return
  }
  const now = await $.clock.now()
  let isMoved = false
  const moved = await patch($, run.id, one => {
    // Once per timeout: a second tick, or a late answer, finds the effort already lowered.
    if (one.effort !== run.effort || one.phase !== 'review') return one
    isMoved = true
    return {
      ...one,
      effort: lower,
      phaseStartedAt: now,
      pending: [],
      steps: withStep(one.steps, {
        id: `r${one.round}-timeout-${one.effort}`,
        label: `Round ${one.round} · codex timed out at ${one.effort}`,
        state: 'failed',
        detail: `rerunning at ${lower}`,
      }),
    }
  })
  if (moved === null || !isMoved) return
  $.ui.toast(`pr-gate: Codex timed out at ${run.effort}; rerunning round ${run.round} at ${lower}.`)
  await beginReview($, run.id)
}

/** Starts the round the controller chose, on the run in flight or a new one. */
export async function startRound($: Engine, rec: LifecycleRecord, next: Extract<Next, { kind: 'round' }>): Promise<void> {
  const now = await $.clock.now()
  const existing = await getRun($)
  const isOn = existing !== null && existing.status === 'running'
  // An attempt that did not complete is run again under its own number.
  const round = rec.rounds.length === 0 ? 1 : Math.max(...rec.rounds.map(one => one.n)) + (rec.rounds.at(-1)?.isCompleted === false ? 0 : 1)
  const lastHead = lastReviewedHead(rec)
  const run: Run = {
    id: isOn ? existing.id : `${now}`,
    cwd: rec.root,
    root: rec.root,
    branch: rec.branch,
    base: rec.base,
    headSha: rec.head,
    tier: rec.tier,
    tierWhy: rec.tierWhy,
    lane: rec.lane,
    effort: rec.effort ?? config.effort,
    startEffort: defaultEffort(rec),
    round,
    status: 'running',
    phase: 'scope',
    hasRefixed: false,
    hasReprompted: false,
    fixKind: next.isAdvisory ? 'advisory' : 'blocking',
    steps: isOn
      ? existing.steps
      : [
          { id: 'scope', label: 'Scope & blast radius', state: 'done', detail: `${rec.tier}${rec.lane === 'light' ? ', light lane' : ''}: ${rec.tierWhy}` },
          { id: 'pr', label: `Open PR → ${rec.base}`, state: next.phase === 'pre' ? 'pending' : 'done' },
        ],
    findings: rec.findings,
    pending: [],
    activity: '',
    startedAt: isOn ? existing.startedAt : now,
    phaseStartedAt: now,
    lifecycle: next.phase,
    roundKind: next.roundKind,
    roundStartHead: rec.head,
    roundStartedAt: now,
    diffBase: next.scope === 'delta' && lastHead !== undefined ? lastHead : next.phase === 'post' && lastHead !== undefined ? lastHead : `origin/${rec.base}`,
    evidence: [],
    activeMs: 0,
    waitMs: 0,
  }
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  if (next.phase === 'pre') await beginReview($, run.id)
  else await beginCollect($, run.id)
}

/** The round in flight ended, complete or not: append it to the record, then let the controller choose. */
async function endRound($: Engine, run: Run, isCompleted: boolean, outstanding?: string): Promise<void> {
  const now = await $.clock.now()
  // After the PR: the head GitHub last reported for it, whatever is checked out here (an adopted PR, a push from elsewhere).
  const head = run.lifecycle === 'post' ? undefined : await git($, run.root, ['rev-parse', 'HEAD'])
  const endHead = head?.isOk === true ? head.out : run.headSha
  const current = run.findings.filter(one => raisedIn(one, run.round))
  const round: RoundRecord = {
    n: run.round,
    phase: run.lifecycle,
    kind: run.roundKind,
    isAdvisory: run.fixKind === 'advisory',
    startHead: run.roundStartHead,
    endHead,
    isCompleted,
    evidence: run.evidence,
    raised: { blocking: current.filter(isBlocking).length, advisory: current.filter(one => !isBlocking(one)).length },
    rebutted: current.filter(one => one.status === 'rebutted').length,
    deferredBlocking: current.filter(one => isBlocking(one) && one.status === 'deferred').length,
    activeMs: run.activeMs + (now - run.phaseStartedAt) * (run.phase === 'collect' ? 0 : 1),
    waitMs: run.waitMs,
    ...(outstanding === undefined ? {} : { outstanding }),
    startedAt: run.roundStartedAt,
    endedAt: now,
  }
  await updateRecord($, run.root, run.branch, rec => ({
    ...withRound(rec, round),
    head: endHead,
    findings: mergeFindings(rec.findings, run.findings),
    effort: run.effort,
  }))
  if (isCompleted) await advance($, run.root, run.branch)
}

/** An attempt that did not complete: its effort is recorded, no round is used. */
async function noteAttempt($: Engine, run: Run, why: string): Promise<void> {
  const now = await $.clock.now()
  // The attempt's findings and answers stay in the ledger, so a rerun of the round numbers its own after them.
  await updateRecord($, run.root, run.branch, rec =>
    withRound(
      { ...rec, findings: mergeFindings(rec.findings, run.findings) },
      roundOf({
        n: run.round,
        phase: run.lifecycle,
        kind: run.roundKind,
        startHead: run.roundStartHead,
        endHead: run.headSha,
        isCompleted: false,
        activeMs: run.phase === 'collect' ? 0 : now - run.phaseStartedAt,
        waitMs: run.waitMs + (run.phase === 'collect' && run.collect !== undefined ? now - run.collect.startedAt : 0),
        outstanding: why,
        startedAt: run.roundStartedAt,
        endedAt: now,
      }),
    ),
  )
}

// ------------------------------------------------------ the controller

/** A security P1 that is open, or only reported fixed, never rides on exhaustion. */
export const hasSecurityBlocker = (rec: LifecycleRecord): boolean => [...unresolvedBlockers(rec), ...verificationOwed(rec)].some(one => one.isSecurity === true)

/** After a round, or at start: the controller reads the record and does what `decideNext` says. */
export async function advance($: Engine, root: string, branch: string): Promise<void> {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined) return
  const next = decideNext(rec)
  const run = await getRun($)
  const id = run !== null && run.status === 'running' ? run.id : undefined
  if (next.kind === 'round') {
    await startRound($, rec, next)
    return
  }
  if (next.kind === 'open-pr') {
    const hasSecurity = hasSecurityBlocker(rec)
    const opens = next.status === 'passed' || (config.onExhausted === 'open-pr' && !hasSecurity)
    const saved = await updateRecord($, root, branch, one => ({ ...one, preStatus: next.status, preHead: one.head }))
    const used = usedRounds(rec)
    const message =
      next.status === 'passed'
        ? rec.passThrough !== undefined
          ? `Codex skipped: ${rec.passThrough}.`
          : `No high/critical finding after ${used} round${used === 1 ? '' : 's'}.`
        : `${heldFindings(rec).length} high/critical finding(s) unresolved or unverified with the allowance spent` +
          `${hasSecurity ? ', one of them security: the PR stays held' : ''}.`
    const ended = id === undefined ? null : await finish($, id, next.status, message)
    if (ended === null || saved === undefined) return
    if (!opens) {
      // The round that just ended leaves the PR held: say so once, with why and what can move it.
      const held = heldReason(saved)
      await markPr($, 'skipped', 'held')
      if (held !== undefined) void $.prompt.submit({ text: heldPrompt(saved, held.why, held.nextStep) }).catch(() => undefined)
      return
    }
    if (config.openPr) {
      await markPr($, 'running', 'handed to the main agent')
      void $.prompt.submit({ text: prPrompt(ended, saved, next.status) }).catch(() => undefined)
    }
    return
  }
  if (next.kind === 'ready') {
    const saved = await updateRecord($, root, branch, one => ({ ...one, phase: 'ready', postStatus: undefined }))
    if (id !== undefined) await finish($, id, 'passed', `Lifecycle review complete at ${rec.head.slice(0, 7)}: ready for the merge decision.`)
    if (saved !== undefined) void $.prompt.submit({ text: readyPrompt(saved) }).catch(() => undefined)
    return
  }
  const isPre = rec.phase === 'pre'
  const saved = await updateRecord($, root, branch, one =>
    isPre ? { ...one, preStatus: next.kind, preHead: one.head, message: next.why } : { ...one, postStatus: next.kind, message: next.why },
  )
  if (id !== undefined) await finish($, id, next.kind, `${next.why}. Next: ${next.nextStep}`)
  if (saved === undefined) return
  // Before the PR: only the round that just ended says so; a rerun on the same record says nothing new.
  if (isPre) {
    if (id !== undefined) void $.prompt.submit({ text: heldPrompt(saved, next.why, next.nextStep) }).catch(() => undefined)
    return
  }
  void $.prompt.submit({ text: reportPrompt(saved, next) }).catch(() => undefined)
}

/** Blockers that hold an exhausted gate: unresolved, or only reported fixed. */
const heldFindings = (rec: LifecycleRecord): Finding[] => [...unresolvedBlockers(rec), ...verificationOwed(rec)]

/** Why the pre-PR gate holds the PR, and the next step; undefined when it does not hold it for a settled reason. */
export function heldReason(rec: LifecycleRecord): { why: string; nextStep: string } | undefined {
  if (rec.preStatus === 'blocked') {
    return { why: rec.message ?? 'a decision is needed', nextStep: 'fix or rebut the open findings and commit, then /pr-gate resume' }
  }
  if (rec.preStatus !== 'exhausted') return undefined
  const holding = heldFindings(rec)
  const isSecurity = hasSecurityBlocker(rec)
  if (!isSecurity && config.onExhausted === 'open-pr') return undefined
  const n = holding.length
  const unverified = verificationOwed(rec).filter(one => one.isSecurity === true)
  const security =
    unverified.length > 0
      ? `, and a security fix not yet verified (${unverified.map(one => one.id).join(', ')}) never rides on an exhausted review`
      : ', one of them security, which never rides on an exhausted review'
  return {
    why:
      `the pre-PR review allowance is spent with ${n} high/critical finding${n === 1 ? '' : 's'} unresolved or unverified` +
      (isSecurity ? security : ', and onExhausted is stop'),
    nextStep:
      `fix ${holding.map(one => one.id).join(', ') || 'the open findings'} and commit, then /pr-gate resume; ` +
      "with the allowance spent, a new round also needs the person's /pr-gate allow 1 <reason>",
  }
}

// ------------------------------------------------- what each answer does

async function afterReview($: Engine, run: Run): Promise<void> {
  const now = await $.clock.now()
  const results = run.pending.map(one => ({ role: one.role, result: readReview(one.answer ?? '') }))
  const failed = results.find(one => one.result.gate === 'ERROR')
  if (failed !== undefined && failed.result.failure === 'timeout') {
    // Nothing of this attempt is kept, a parallel reviewer's findings included: it reruns whole.
    await noteAttempt($, run, `Codex ${failed.role} timed out at ${run.effort}`)
    await retryLower($, run, `Codex ${failed.role} timed out at ${run.effort}: ${failed.result.note ?? 'no verdict'}.`)
    return
  }
  const prior = await loadRecord($, run.root, run.branch)
  // A rerun of round N (after a stop, an error or uncommitted changes) numbers after what that round already raised.
  const idOf = nextIds(`R${run.round}-`, [run.findings, prior?.findings ?? []])
  // Blockers still open from earlier rounds go to this round's fix step too; the fixer can still rebut a stale one.
  const carried = new Set(prior === undefined ? [] : unresolvedBlockers(prior).filter(one => one.status === 'open').map(one => one.id))
  const fresh: Finding[] = []
  for (const { role, result } of results) {
    for (const one of result.findings) {
      fresh.push({
        ...one,
        id: idOf(fresh.length + 1),
        round: run.round,
        source: role === 'challenge' ? 'codex-challenge' : 'codex-review',
        reviewer: 'codex',
        ...(severityHint(`${one.title} ${one.detail ?? ''}`).isSecurity ? { isSecurity: true } : {}),
        headSeen: run.headSha,
        status: 'open',
        history: [{ round: run.round, status: 'open', by: role === 'challenge' ? 'codex-challenge' : 'codex', at: now }],
      })
    }
  }
  const verified = new Set(results.flatMap(one => one.result.verified))
  const held = new Set(results.flatMap(one => one.result.held))
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    // A finding this review left out keeps its status: only an explicit verified or held moves it.
    findings: [
      ...one.findings.map(old => {
        const ruled = verified.has(old.id) ? markVerified(old, one.round, 'codex', now) : held.has(old.id) ? markHeld(old, one.round, 'codex', now) : old
        return carried.has(ruled.id) && ruled.status === 'open' && !raisedIn(ruled, one.round) ? markHeld(ruled, one.round, 'pr-gate', now) : ruled
      }),
      ...fresh,
    ],
    // After the PR, the GitHub evidence collected this round stays beside Codex's.
    evidence: [
      ...(one.lifecycle === 'post' ? one.evidence.filter(each => each.source === 'github') : []),
      ...results
        .filter(each => each.result.gate !== 'ERROR')
        .map(each => ({ source: 'codex' as const, reviewer: each.role === 'challenge' ? 'codex-challenge' : 'codex', head: one.headSha, isComplete: true })),
    ],
    steps: results.reduce(
      (steps, { role, result }) =>
        withStep(steps, {
          id: `r${one.round}-${role}`,
          label: `Round ${one.round} · codex ${role}`,
          state: result.gate === 'ERROR' ? 'failed' : 'done',
          detail:
            result.gate === 'ERROR'
              ? (result.note ?? 'did not complete')
              : `${result.gate} · ${result.findings.filter(isBlocking).length} blocking, ${result.findings.filter(f => !isBlocking(f)).length} advisory`,
        }),
      one.steps,
    ),
  }))
  if (after === null) return
  if (failed !== undefined) {
    // Fail closed: a review that did not complete is never a pass, and no round is spent on it.
    await noteAttempt($, after, `Codex ${failed.role} did not complete`)
    await finish($, run.id, 'error', `Codex ${failed.role} did not complete: ${failed.result.note ?? 'no verdict'}`)
    return
  }
  // Codex's ruling goes into the record's ledger at once, not only when the round ends.
  const rec = await updateRecord($, run.root, run.branch, one => ({ ...one, findings: mergeFindings(one.findings, after.findings) }))
  if (rec === undefined) return
  // Every finding is answered inside its round, blocking and advisory alike (R17): fixing costs no review round.
  // A rebuttal or fix Codex held is open again, and goes back to the fixer with the round's new findings.
  // Whether Codex re-reviews an advisory fix before the PR opens is the controller's call (reserve rule);
  // otherwise the free post-PR baseline round reviews that head.
  const toFix = after.findings.filter(one => raisedIn(one, after.round) && one.status === 'open')
  if (after.lifecycle === 'post') {
    // The main agent answers Codex and GitHub together in triage. A final-head check goes there too, so the
    // reviewers' feedback on it enters the ledger and gets its reply; a fix it makes changes the head, which
    // the controller never certifies (exhausted, not ready).
    await beginTriage($, after.id)
    return
  }
  if (toFix.length > 0) {
    await beginFix($, run.id, undefined, toFix.some(isBlocking) ? 'blocking' : 'advisory')
    return
  }
  await endRound($, after, true)
}

async function afterFix($: Engine, run: Run): Promise<void> {
  const now = await $.clock.now()
  const said = readDispositions(run.pending[0]?.answer ?? '')
  const head = await git($, run.root, ['rev-parse', 'HEAD'])
  const dirty = await git($, run.root, ['status', '--porcelain', '--untracked-files=no'])
  const fromSha = run.headSha
  const newSha = head.isOk ? head.out : fromSha
  const count = (action: string): number => said.filter(one => one.action === action).length
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    headSha: newSha,
    findings: one.findings.map(finding => {
      const answer = said.find(each => each.id === finding.id)
      return answer === undefined ? finding : applyAnswer(finding, answer, one.round, config.fixer === 'main' ? 'main' : 'fixer', now)
    }),
    steps: one.steps.map(step =>
      step.state === 'running' && step.id.startsWith(`r${one.round}-fix`)
        ? {
            ...step,
            state: 'done',
            detail:
              said.length === 0
                ? newSha === fromSha
                  ? 'no change, no report'
                  : 'committed, no report'
                : `${count('fixed')} fixed · ${count('rebutted')} rebutted${count('deferred') > 0 ? ` · ${count('deferred')} deferred` : ''}`,
          }
        : step,
    ),
  }))
  if (after === null) return
  // A finding of this round left without an answer gets the fix step once more (no round consumed); then it stays open.
  const unanswered = after.findings.filter(one => raisedIn(one, after.round) && one.status === 'open' && !said.some(each => each.id === one.id))
  if (unanswered.length > 0 && after.hasReprompted !== true) {
    await patch($, run.id, one => ({ ...one, hasReprompted: true }))
    const ids = unanswered.map(one => one.id).join(', ')
    await beginFix(
      $,
      run.id,
      `These findings have no answer yet: ${ids}. Answer each one: fix it, rebut it with a reason, or defer it with a reason, in the same ${TRAILER} block.`,
      after.fixKind,
    )
    return
  }
  if (dirty.isOk && dirty.out !== '') {
    await noteAttempt($, after, 'the fixer left uncommitted changes')
    await finish($, run.id, 'error', 'The fixer left uncommitted changes. Reviews read committed code only: commit them and run /pr-gate resume.')
    return
  }
  const wantsVerify = config.fixReview === 'always' || (config.fixReview === 'auto' && after.tier === 'high')
  if (after.fixKind === 'blocking' && wantsVerify && !after.hasRefixed && newSha !== fromSha) {
    await beginVerify($, run.id, fromSha)
    return
  }
  await endRound($, after, true)
}

async function afterVerify($: Engine, run: Run): Promise<void> {
  const now = await $.clock.now()
  const verdict = readVerify(run.pending[0]?.answer ?? '')
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    hasRefixed: !verdict.isOk,
    // The fix reviewer confirmed the round's blocking fixes.
    findings: verdict.isOk
      ? one.findings.map(f => (raisedIn(f, one.round) && isBlocking(f) && f.status === 'reported-fixed' ? markVerified(f, one.round, 'fix-reviewer', now) : f))
      : one.findings,
    steps: withStep(one.steps, {
      id: `r${one.round}-verify`,
      label: `Round ${one.round} · review the fix`,
      state: 'done',
      detail: verdict.isOk ? 'fix holds' : 'sent back to the fixer',
    }),
  }))
  if (after === null) return
  if (verdict.isOk) await endRound($, after, true)
  else await beginFix($, run.id, verdict.notes ?? 'The fix does not settle the findings.')
}

/** One agent's turn ended: record its answer, and move on once the step's agents are all in. */
export async function onAnswer($: Engine, agentId: string | undefined, answer: string, reason: string): Promise<void> {
  const run = await getRun($)
  if (run === null || run.status !== 'running') {
    isLive = false
    return
  }
  // A sub-agent is known by the id the engine gave it, or by the step it names in its
  // trailer; the main agent by the turn that began once its prompt had entered.
  const named = readTrailer(answer)?.step
  const isMine = (one: Pending): boolean =>
    one.isMain === true ? agentId === undefined && one.isArmed === true : one.agentId !== undefined ? one.agentId === agentId : named === one.step
  if (!run.pending.some(isMine)) return
  if (reason === 'aborted') {
    await finish($, run.id, 'stopped', `The ${run.phase} step was interrupted.`)
    return
  }
  if (reason !== 'answer') {
    await finish($, run.id, 'error', `The ${run.phase} step ended on ${reason === 'refusal' ? 'a refusal' : 'an API error'}.`)
    return
  }
  const after = await patch($, run.id, one => ({
    ...one,
    pending: one.pending.map(each => (isMine(each) ? { ...each, answer } : each)),
  }))
  if (after === null || after.pending.some(one => one.answer === undefined)) return
  if (after.phase === 'review') await afterReview($, after)
  else if (after.phase === 'fix') await afterFix($, after)
  else if (after.phase === 'verify') await afterVerify($, after)
  else if (after.phase === 'triage') await afterTriage($, after)
}
