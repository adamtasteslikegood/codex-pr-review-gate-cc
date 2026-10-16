// pr-lifecycle's rounds: each step is an agent, and its `turn.complete` moves the
// round on. A round that ends goes into the lifecycle record, and the controller
// (`advance`) chooses what comes next from the record alone. Nothing here waits
// on a step inside one dispatch. `advance` lives here, not in register.tsx: the
// engine follows `$` across files only into function declarations it can see.

import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Effort, Evidence, Finding, LifecycleRecord, Pending, Role, RoundRecord, Run, RunStatus, Step, Waiver } from '../types'
import {
  compileRisk,
  fixPrompt,
  lowerOf,
  heldPrompt,
  prPrompt,
  readDispositions,
  readReview,
  readTrailer,
  readTriage,
  readVerdicts,
  readVerify,
  readyPrompt,
  replyIdOf,
  reportPrompt,
  reviewPrompt,
  stepDown,
  stepOf,
  TRAILER,
  triagePrompt,
  verifyPrompt,
} from './core'
import { collectionDone, isTrusted, readCheckRuns, readInlineComments, readIssueComments, readReviews, readRoster, severityHint } from './github'
import type { Check, Feedback, Roster } from './github'
import {
  acceptRebuttal,
  applyAnswer,
  decideNext,
  invalidate,
  lapseWaivers,
  isAcceptedRebuttal,
  isBlocking,
  isDisputed,
  isReverifyOwed,
  lastCoveredHead,
  markHeld,
  markVerified,
  mergeFindings,
  mergeHolds,
  newRecord,
  nextIds,
  raisedIn,
  rejections,
  roundOf,
  triage,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
  waivedIds,
  withRound,
} from './lifecycle'
import type { Allowances, Next, TriageClass } from './lifecycle'
import { archiveRecord, loadRecord, lockRecord, saveRecord, updateRecord } from './store'

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
  queued = []
}

export const isLiveNow = (): boolean => isLive
export const setLive = (v: boolean): void => {
  isLive = v
}

/** The effort a branch's tier and lane call for, before any carried or timeout step-down. */
export const defaultEffort = (rec: Pick<LifecycleRecord, 'tier' | 'lane'>): Effort =>
  rec.tier === 'high' ? 'high' : rec.lane === 'light' ? config.lightEffort : config.effort

// Prompts decided while a /pr-gate command (or the session start) holds the turn: the host refuses a submit then, so they wait here.
let holdDepth = 0
let queued: string[] = []

/** Runs `body` with the prompts it decides held back; once it has returned, they are sent one second later, in order. */
export async function holdingPrompts<T>($: Engine, body: () => Promise<T>): Promise<T> {
  holdDepth += 1
  try {
    return await body()
  } finally {
    holdDepth -= 1
    if (holdDepth === 0 && queued.length > 0) {
      $.clock.after(1000, () => {
        const texts = queued
        queued = []
        for (const text of texts) void $.prompt.submit({ text }).catch(() => undefined)
      })
    }
  }
}

/** Sends a prompt to the main agent now, or after the command that holds the turn has returned. */
export function say($: Engine, text: string): void {
  if (holdDepth > 0) {
    queued.push(text)
    return
  }
  void $.prompt.submit({ text }).catch(() => undefined)
}

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

/**
 * A `git fetch` tried once more when it fails (R1-10), so nothing is reviewed against a stale base. A ref the remote does not have is
 * no failure: there is nothing to fetch, and the caller finds the ref missing itself. `err` is git's own words, cut short.
 */
export async function fetchTwice($: Engine, cwd: string | undefined, args: string[], timeoutMs: number): Promise<{ isOk: boolean; err: string }> {
  let err = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const ran = await git($, cwd, ['fetch', ...args], timeoutMs)
    if (ran.isOk || /couldn't find remote ref/i.test(ran.err)) return { isOk: true, err: '' }
    err = ran.err.split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? ''
  }
  return { isOk: false, err: err === '' ? 'git fetch failed' : err }
}

/** The record's waivers at `head`, with each finding waiver whose finding's file changed since it was given marked lapsed (R55). */
export async function lapsedAt($: Engine, rec: Pick<LifecycleRecord, 'root' | 'waivers' | 'findings'>, head: string, now: number): Promise<Waiver[]> {
  const froms = [...new Set(rec.waivers.filter(one => one.scope === 'finding' && one.lapsedAt === undefined && one.head !== head).map(one => one.head))]
  const changed = new Map<string, ReadonlySet<string> | 'all'>()
  for (const from of froms) {
    const diff = await git($, rec.root, ['diff', '--name-only', from, head])
    changed.set(from, diff.isOk ? new Set(diff.out.split('\n').filter(Boolean)) : 'all')
  }
  return lapseWaivers(rec.waivers, rec.findings, from => changed.get(from) ?? 'all', head, now)
}

/**
 * The head moved from `from` to `to` (R56): each answered finding whose file changed needs a re-check (`invalidate`), and each
 * finding waiver whose finding's file changed since it was given lapses (R55). Git failing flags and lapses everything.
 */
export async function headMoved(
  $: Engine,
  root: string,
  rec: Pick<LifecycleRecord, 'waivers' | 'findings'>,
  from: string | undefined,
  to: string,
  now: number,
): Promise<{ findings: Finding[]; waivers: Waiver[] }> {
  const diff = from === undefined ? undefined : await git($, root, ['diff', '--name-only', from, to])
  const files = diff?.isOk === true ? new Set(diff.out.split('\n').filter(Boolean)) : ('all' as const)
  const findings = invalidate(rec.findings, files)
  return { findings, waivers: await lapsedAt($, { root, waivers: rec.waivers, findings }, to, now) }
}

/**
 * A run saw a new head: `headMoved` over its ledger, written to the record at once (`endCollect` and `beginTriage` read the record)
 * and to the run's own copy, which wins over the record's when the two are merged.
 */
export async function onNewHead($: Engine, run: Run, from: string, to: string, now: number): Promise<void> {
  const live = await getRun($)
  const own = live?.id === run.id ? live.findings : run.findings
  let flagged = new Set<string>()
  const flag = (findings: readonly Finding[]): Finding[] => findings.map(one => (flagged.has(one.id) ? { ...one, needsRecheck: true } : one))
  const move = async (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Promise<Waiver[]> => {
    const moved = await headMoved($, run.root, { findings: mergeFindings(rec.findings, own), waivers: rec.waivers }, from, to, now)
    flagged = new Set(moved.findings.filter(one => one.needsRecheck === true).map(one => one.id))
    return moved.waivers
  }
  // Read and written under the record's lock (R1-6): a waiver the person gives meanwhile is not overwritten.
  const saved = await updateRecord($, run.root, run.branch, async one => {
    const waivers = await move(one)
    return { ...one, findings: flag(one.findings), waivers }
  })
  if (saved === undefined) await move({ findings: [], waivers: [] })
  await patch($, run.id, one => ({ ...one, findings: flag(one.findings) }))
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
      if (run.outbox !== undefined) {
        const text = run.outbox
        await patch($, run.id, one => ({ ...one, outbox: undefined }))
        await askTriage($, run.id, text)
        return
      }
      if (run.phase === 'collect') {
        await poll($, run)
        return // waiting on reviewers is not a step: no step timeout while collecting
      }
      if (now - run.phaseStartedAt > config.stepTimeoutMs) {
        // A main-agent step whose prompt's turn never started could not have been answered: say so, not only that it ran long.
        const isUnseen = run.pending.some(one => one.isMain === true && one.answer === undefined && one.turnId === undefined)
        const why =
          `The ${run.phase} step ran past ${elapsed(config.stepTimeoutMs)}.` +
          (isUnseen ? ' Its prompt\'s turn was never seen: the main agent never started on it, so no answer could count.' : '')
        if (run.phase === 'review') {
          await noteAttempt($, run, why)
          await retryLower($, run, why)
        } else if (run.phase === 'verify' && run.lifecycle === 'post') {
          await holdPost($, run, `the Codex check of a rebuttal did not finish: ${why}`)
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
        // After the PR opened, its step stays done.
        step.id === 'pr' && one.lifecycle !== 'post'
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

/**
 * Archives the branch's record (R47): the whole record under its own key, and on the branch's key a seed that keeps only what a
 * fresh start must not repeat (processed feedback and recorded replies). False when there was no live record.
 */
export async function archiveLifecycle($: Engine, root: string, branch: string, now: number): Promise<boolean> {
  return lockRecord(root, branch, async () => {
    const last = await loadRecord($, root, branch)
    if (last === undefined || last.phase === 'archived') return false
    await archiveRecord($, last, now)
    const { base, head, tier, tierWhy, lane, allowance } = last
    const seed = newRecord({ root, branch, base, head, tier, tierWhy, lane, allowance, at: now })
    await saveRecord($, { ...seed, processed: last.processed, replies: last.replies, phase: 'archived' })
    return true
  })
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

/** Reads a PR's state from gh's JSON; undefined when it is not there. */
export const prStateIn = (json: unknown): PrState | undefined => {
  const state = (json as { state?: unknown } | null)?.state
  return state === 'OPEN' || state === 'MERGED' || state === 'CLOSED' ? state : undefined
}

/** The state of PR `pr`, as gh reports it; undefined when gh cannot say. */
export async function prStateOf($: Engine, root: string, pr: number): Promise<PrState | undefined> {
  const view = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'state'], { cwd: root, timeoutMs: 30_000 })
  if (view.exitCode !== 0) return undefined
  try {
    return prStateIn(JSON.parse(view.stdout))
  } catch {
    return undefined
  }
}

/** The PR was merged or closed (R62): the branch's live run ends with a short message, and its record is archived. */
export async function closeLifecycle($: Engine, root: string, branch: string, pr: number | undefined, state: 'MERGED' | 'CLOSED'): Promise<string> {
  const said = `PR #${pr ?? '?'} from ${branch} was ${state === 'MERGED' ? 'merged' : 'closed'}: its lifecycle is archived, its history kept`
  const run = await getRun($)
  if (run !== null && run.status === 'running' && run.root === root && run.branch === branch) await finish($, run.id, 'stopped', `${said}.`)
  await archiveLifecycle($, root, branch, await $.clock.now())
  return said
}

// ----------------------------------------------------------- the steps

async function spawn($: Engine, run: Run, role: Role, prompt: string): Promise<{ isStarted: boolean; agentId?: string }> {
  const started = await $.agent.spawn({
    prompt,
    description: `pr-lifecycle r${run.round} ${role}`,
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
  // The prompt waits for the session to go idle. The step is armed by the main-loop turn that starts with this prompt
  // (`onTurnStart`, R51), so a turn already running when the findings came in is never read as the fix.
  void $.prompt
    .submit({ text: prompt })
    .then(async entered => {
      if ('drop' in entered && typeof entered.drop === 'string') {
        await finish($, id, 'error', `The findings could not be sent to the main agent: ${entered.drop}`)
      }
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

type Fetched = {
  isOk: boolean
  why?: string
  /** The PR was merged or closed (R62): nothing more to collect. */
  closed?: 'MERGED' | 'CLOSED'
  feedback: Feedback[]
  /** Feedback from others: only theirs covers a head; this machine's login never reviews its own PR. */
  cover?: Feedback[]
  checks: Check[]
  prHead: string
  /** Feedback id to the id of this machine's own reply in its thread, posted after it (R35). */
  ownReplies?: Record<string, string>
}

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
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr), '--json', 'headRefOid,state'], { cwd: rec.root, timeoutMs: 30_000 })
  if (pr.exitCode !== 0) {
    return fail(`gh could not read PR #${rec.pr} (${pr.stderr.trim().slice(0, 160) || `exit ${pr.exitCode}`}); check gh auth login and the network`)
  }
  let prHead: string | undefined
  let state: PrState | undefined
  try {
    const read = JSON.parse(pr.stdout) as { headRefOid?: unknown } | null
    prHead = read?.headRefOid as string | undefined
    state = prStateIn(read)
  } catch {
    prHead = undefined
  }
  if (state === 'MERGED' || state === 'CLOSED') return { ...fail(`PR #${rec.pr} was ${state.toLowerCase()}`), closed: state }
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
    // Only feedback from someone with write access, or on the roster, is read (R1-8); this machine's own rows are sorted out below.
    const roster = await rosterOf($, rec.root)
    const all = [...readReviews(reviews.out), ...readInlineComments(inline.out), ...readIssueComments(comments.out)].filter(
      one => one.reviewer === self || isTrusted(one, roster),
    )
    // Of this machine's own comments, only the mod's replies are not feedback (R64): an inline reply in a thread, or a comment
    // whose id is a recorded reply. The person's other top-level and review comments reach triage. Its inline replies are
    // its replies, which no turn may post twice (R35).
    // A reply recorded as the URL gh printed (before R66) is read as its comment number too.
    const replied = new Set(Object.values(rec.replies).map(replyIdOf))
    const isReply = (one: Feedback): boolean =>
      one.kind === 'inline' ? one.threadId !== one.id.slice('inline:'.length) : replied.has(one.id.slice(one.id.indexOf(':') + 1))
    const feedback = all.filter(one => one.reviewer !== self || !isReply(one))
    const own = all.filter(one => one.reviewer === self && one.kind === 'inline' && isReply(one))
    const others = feedback.filter(one => one.reviewer !== self)
    // One to one (R38): each own reply answers the latest reviewer comment in its thread posted before it that no reply answered yet.
    const ownReplies: Record<string, string> = {}
    for (const mine of [...own].sort((a, b) => a.at - b.at)) {
      const answered = others
        .filter(one => one.kind === 'inline' && one.threadId === mine.threadId && one.at <= mine.at && ownReplies[one.id] === undefined)
        .sort((a, b) => a.at - b.at)
        .at(-1)
      if (answered !== undefined) ownReplies[answered.id] = mine.id.slice('inline:'.length)
    }
    return { isOk: true, feedback, cover: others, checks: readCheckRuns(checks.out), prHead, ownReplies }
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
  if (got.closed !== undefined) {
    await closeLifecycle($, run.root, run.branch, rec.pr, got.closed)
    return
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
  // Judged from the head the round had before this one replaces it (R56).
  if (isNewHead) await onNewHead($, run, run.roundStartHead, got.prHead, now)
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
    feedback: got.cover ?? got.feedback,
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
  // Any fix only reported, at any severity (R39), needs Codex to verify it before the merge.
  const owesVerification = mergeHolds(rec).some(one => one.status === 'reported-fixed')
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
      const why = `the local checkout ${here} is not the PR head ${got.prHead.slice(0, 7)}: pull (or push), then run /pr-gate resume`
      await noteAttempt($, after, why)
      await finish($, run.id, 'error', `Post-PR round ${run.round} needs a Codex review, but ${why}.`)
      return
    }
    await beginReview($, run.id) // the Codex fallback: reviewPrompt reads run.diffBase (the last head a review covered, R60)
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
  say($, `pr-gate: post-PR round ${run.round} on ${run.branch} stopped: ${why}.`)
}

/**
 * Triage: the round's fresh GitHub feedback, Codex's open findings when it ran, and blockers still open from earlier
 * rounds (R32) go to the main agent in one turn. Nothing to answer and no unreviewed commits end the round clean (R3).
 */
async function beginTriage($: Engine, id: string): Promise<void> {
  const now = await $.clock.now()
  const run = await getRun($)
  if (run === null || run.id !== id || run.status !== 'running') return
  const prior = await loadRecord($, run.root, run.branch)
  if (prior === undefined) {
    const why = `The lifecycle record of ${run.branch} is gone, so post-PR round ${run.round} cannot go on. Run /pr-gate to start it again.`
    await finish($, run.id, 'error', why)
    return
  }
  let got: Fetched
  try {
    got = await fetchFeedback($, prior)
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    const why = `gh failed (${said.slice(0, 160)}); check gh auth login, rate limits and the network`
    got = { isOk: false, why, feedback: [], checks: [], prHead: prior.head }
  }
  if (got.closed !== undefined) {
    await closeLifecycle($, run.root, run.branch, prior.pr, got.closed)
    return
  }
  if (!got.isOk) {
    await failPost($, run, `GitHub could not be read: ${got.why ?? 'gh failed'}; fix that, then run /pr-gate resume`)
    return
  }
  // Replies this machine already posted in a thread count as replies (R35), whatever an earlier turn reported.
  const own = got.ownReplies ?? {}
  const rec = Object.keys(own).some(key => prior.replies[key] === undefined)
    ? ((await updateRecord($, run.root, run.branch, one => ({ ...one, replies: { ...own, ...one.replies } }))) ?? prior)
    : prior
  const items = got.feedback.filter(one => one.isFinding && !rec.processed.includes(one.id))
  const ledger = mergeFindings(rec.findings, run.findings)
  // Changed files are read from a finding's own head (or the previous post round's start) to this round's head (R33).
  const prevStart = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted).at(-1)?.startHead
  const diffs = new Map<string, Set<string> | 'all'>()
  const changedSince = async (base: string): Promise<Set<string> | 'all'> => {
    const seen = diffs.get(base)
    if (seen !== undefined) return seen
    const diff = await git($, run.root, ['diff', '--name-only', base, run.headSha])
    const files = diff.isOk ? new Set(diff.out.split('\n').filter(Boolean)) : ('all' as const)
    diffs.set(base, files)
    return files
  }
  // Fresh ids number after every G{round}-k already in the run or the record (R23).
  const idOf = nextIds(`G${run.round}-`, [run.findings, rec.findings])
  const fresh: Finding[] = []
  const listed: { feedback: Feedback; cls: TriageClass; matchId?: string; findingId: string }[] = []
  for (const feedback of items) {
    const title = feedback.body.split('\n')[0]?.replace(/[*_`#>]/g, '').trim().slice(0, 200) || `${feedback.reviewer} ${feedback.kind}`
    const others = ledger.filter(one => one.externalId !== feedback.id)
    const placed = triage({ file: feedback.file, line: feedback.line, title, at: feedback.at }, others, new Set())
    let cls = placed.cls
    let matchId = placed.matchId
    const base = matchId === undefined ? prevStart : (others.find(one => one.id === matchId)?.headSeen ?? prevStart)
    if (feedback.file !== undefined && base !== undefined && base !== run.headSha) {
      const files = await changedSince(base)
      if (files === 'all' || files.has(feedback.file)) {
        cls = 'new-on-changed'
        matchId = undefined
      }
    }
    // Feedback an interrupted attempt already numbered keeps its finding: one id per piece of feedback.
    const known = ledger.find(one => one.externalId === feedback.id)
    if (known !== undefined) {
      listed.push({ feedback, cls, ...(matchId === undefined ? {} : { matchId }), findingId: known.id })
      continue
    }
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
    listed.push({ feedback, cls, ...(matchId === undefined ? {} : { matchId }), findingId: finding.id })
  }
  // Codex's findings of this round still open (the fallback or the final-head check): answered in the same turn.
  const codex = run.findings.filter(one => one.source !== 'github' && raisedIn(one, run.round) && one.status === 'open')
  // Findings still open from earlier rounds, of either phase and any severity, come back until answered (R32, R39).
  const listedIds = new Set([...listed.map(one => one.findingId), ...codex.map(one => one.id)])
  const carried = mergeHolds({ findings: mergeFindings(ledger, fresh), waivers: rec.waivers }).filter(
    one => one.status === 'open' && !raisedIn(one, run.round) && !listedIds.has(one.id),
  )
  // Commits on the PR since the record's head, not yet reviewed: fetched first, so the log can read them.
  let others: string[] = []
  if (got.prHead !== rec.head) {
    // A failed fetch, twice, stops the round here (R1-10): the log would read a stale origin.
    const fetched = await fetchTwice($, run.root, ['--quiet', 'origin'], 60_000)
    if (!fetched.isOk) {
      await failPost($, run, `git could not fetch origin, twice (${fetched.err}); check the network and the remote, then run /pr-gate resume`)
      return
    }
    const log = await git($, run.root, ['log', '--format=%h %an %s', `${rec.head}..${got.prHead}`])
    others = log.isOk ? log.out.split('\n').filter(Boolean) : []
  }
  const asked = [...listedIds, ...carried.map(one => one.id)]
  if (asked.length === 0 && others.length === 0) {
    const rebuttals = rebuttalsOwed(run)
    if (rebuttals.length > 0) await checkRebuttals($, run, rebuttals)
    else await endRound($, run, true)
    return
  }
  const count = asked.length
  const opened = await patch($, id, one => ({
    ...one,
    phase: 'triage',
    phaseStartedAt: now,
    findings: mergeFindings(one.findings, fresh),
    triaged: items.map(each => each.id),
    asked,
    pending: [{ role: 'triage', step: stepOf(one, 'triage'), isMain: true }],
    activity: 'waiting on the main agent to answer the reviews…',
    steps: withStep(one.steps, {
      id: `r${one.round}-triage`,
      label:
        count === 0
          ? `Round ${one.round} · check the new commits (main agent)`
          : `Round ${one.round} · answer ${count} review item${count === 1 ? '' : 's'} (main agent)`,
      state: 'running',
    }),
  }))
  if (opened === null) return
  $.ui.status(`pr-gate r${opened.round}: answering the reviews`)
  const codexRange = `${opened.diffBase.slice(0, 7)}..${opened.headSha.slice(0, 7)}`
  await askTriage($, id, triagePrompt(opened, rec, listed, others, { carried, codex, codexRange }))
}

/**
 * Sends the triage prompt. The step is armed by the main-loop turn that starts with it (`onTurnStart`, R51), so a turn
 * already running is never read as the answer.
 */
async function askTriage($: Engine, id: string, text: string): Promise<void> {
  void $.prompt
    .submit({ text })
    .then(async entered => {
      if ('drop' in entered && typeof entered.drop === 'string') {
        await finish($, id, 'error', `The reviews could not be sent to the main agent: ${entered.drop}`)
      }
    })
    .catch(() => undefined)
}

/**
 * Rebuttals Codex has not accepted, of any severity and from either phase: after the PR opens, Codex checks every one
 * on the same head (R36, widened by R39). A check that was held, then resumed, finds them again here. A rebuttal of a
 * finding Codex already rejected once is a dispute for the person, never sent to Codex again (R40). A verified fix whose
 * file changed since goes to the same check, to be re-verified on this head (R58).
 */
const rebuttalsOwed = (run: Run): Finding[] =>
  run.findings.filter(one => (one.status === 'rebutted' && !isAcceptedRebuttal(one) && !isDisputed(one)) || isReverifyOwed(one))

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
  // Before anything can end the round: answered feedback is processed and its replies are known, so no reply is asked for twice.
  // Feedback still without an answer is not processed (R34): a later round asks again.
  const answered = (feedbackId: string): boolean => after.findings.some(f => f.externalId === feedbackId && f.status !== 'open')
  const triaged = (run.triaged ?? []).filter(answered)
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
  // An item left without an answer is asked about once more, as the fix step does (R34); one the person waived meanwhile is not.
  const waived = waivedIds(rec)
  const unanswered = (after.asked ?? []).filter(
    id => after.findings.some(f => f.id === id && f.status === 'open') && !said.some(each => each.id === id) && !waived.has(id),
  )
  if (unanswered.length > 0 && after.hasReprompted !== true) {
    const step = stepOf(after, 'triage')
    const asked = await patch($, run.id, one => ({
      ...one,
      hasReprompted: true,
      phaseStartedAt: now,
      pending: [{ role: 'triage', step, isMain: true }],
      steps: withStep(one.steps, { id: `r${one.round}-triage`, label: `Round ${one.round} · answer the reviews again (main agent)`, state: 'running' }),
    }))
    if (asked === null) return
    const ids = unanswered.join(', ')
    await askTriage(
      $,
      run.id,
      `pr-gate: These review items have no answer yet: ${ids}. Answer each one: fix it, rebut it with file:line evidence, or defer it with the reason, ` +
        `replying in its thread where it came from GitHub. Commit and push any fix. End your final message with ${TRAILER} on its own line, then ` +
        `{"step":"${step}","dispositions":[{"id":"${unanswered[0]}","action":"fixed|rebutted|deferred","severity":"P2","note":"...","replyId":"123"}]}`,
    )
    return
  }
  const dirty = await git($, run.root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.isOk && dirty.out !== '') {
    await failPost($, after, 'the reviews were answered with uncommitted changes left: commit and push them, then run /pr-gate resume')
    return
  }
  // The round ends on the PR head as GitHub reports it now (R28): this machine's push, or another agent's on top of it.
  const local = await git($, run.root, ['rev-parse', 'HEAD'])
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr ?? ''), '--json', 'headRefOid,state'], { cwd: run.root, timeoutMs: 30_000 })
  let prHead: string | undefined
  let state: PrState | undefined
  try {
    const json = pr.exitCode === 0 ? (JSON.parse(pr.stdout) as { headRefOid?: unknown } | null) : undefined
    const read = json?.headRefOid
    prHead = typeof read === 'string' && read !== '' ? read : undefined
    state = prStateIn(json)
  } catch {
    prHead = undefined
  }
  if (state === 'MERGED' || state === 'CLOSED') {
    await closeLifecycle($, run.root, run.branch, rec.pr, state)
    return
  }
  if (!local.isOk || prHead === undefined) {
    const what = !local.isOk ? 'the local HEAD could not be read' : `gh could not read the head of PR #${rec.pr}; check gh auth login and the network`
    await failPost($, after, `${what}, then run /pr-gate resume`)
    return
  }
  const isContained = prHead === local.out || (await git($, run.root, ['merge-base', '--is-ancestor', local.out, prHead])).isOk
  if (!isContained) {
    await failPost($, after, `commits on ${run.branch} are not on the PR: pull or push, then /pr-gate resume`)
    return
  }
  const endHead = prHead
  if (endHead !== run.roundStartHead) {
    await onNewHead($, run, run.roundStartHead, endHead, await $.clock.now())
    // The answers given in this run are about the new head already, except a fix only reported: its file changed, so it is checked
    // again (R33). Nothing else is exempt: an answer run reuses its round's number, and its push can touch an accepted rebuttal's file.
    const answeredNow = new Set(said.map(each => each.id))
    const exempt = (findings: readonly Finding[]): Finding[] =>
      findings.map(f => (run.isAnswer !== true && answeredNow.has(f.id) && f.status !== 'reported-fixed' ? { ...f, needsRecheck: undefined } : f))
    await updateRecord($, run.root, run.branch, one => ({ ...one, findings: exempt(one.findings) }))
    await patch($, run.id, one => ({ ...one, findings: exempt(one.findings) }))
  }
  const ended = await getRun($)
  if (ended === null || ended.id !== run.id || ended.status !== 'running') return
  // Only on the head the rebuttals were made about; a new head goes to its own round, which checks them there.
  const rebuttals = endHead === run.roundStartHead ? rebuttalsOwed(ended) : []
  if (rebuttals.length > 0) {
    await checkRebuttals($, { ...ended, headSha: endHead }, rebuttals)
    return
  }
  await endRound($, { ...ended, headSha: endHead }, true)
}

/** Codex checks the round's rebuttals (R36), and re-verifies fixes whose file changed (R58), on the same head; it spends no round. */
async function checkRebuttals($: Engine, run: Run, rebuttals: readonly Finding[]): Promise<void> {
  const now = await $.clock.now()
  // Codex reads the checkout: it must be the head the rebuttal is about.
  const local = await git($, run.root, ['rev-parse', 'HEAD'])
  if (!local.isOk || local.out !== run.headSha) {
    await failPost($, run, `the local checkout is not the PR head ${run.headSha.slice(0, 7)}: pull, then /pr-gate resume`)
    return
  }
  const opened = await patch($, run.id, one => ({
    ...one,
    headSha: run.headSha,
    rechecks: rebuttals.map(each => each.id),
    phase: 'verify',
    phaseStartedAt: now,
    pending: [],
    activity: 'starting the rebuttal check…',
    steps: withStep(one.steps, { id: `r${one.round}-verify`, label: checkLabel(one.round, rebuttals), state: 'running' }),
  }))
  if (opened === null) return
  $.ui.status(`pr-gate r${opened.round}: checking the rebuttals`)
  const { isStarted, agentId } = await spawn($, opened, 'verify', verifyPrompt(opened, opened.roundStartHead, rebuttals))
  if (!isStarted) {
    await holdPost($, opened, 'the Codex check of a rebuttal could not be started')
    return
  }
  await patch($, run.id, one => ({ ...one, pending: [{ role: 'verify', step: stepOf(one, 'verify'), agentId }], activity: 'waiting on the rebuttal check…' }))
}

/** The check step's label: rebuttals, re-verifications (R58), or both. */
const checkLabel = (round: number, checked: readonly Pick<Finding, 'status' | 'needsRecheck'>[]): string => {
  const reverify = checked.filter(isReverifyOwed).length
  const what = reverify === 0 ? 'checks the rebuttals' : reverify === checked.length ? 're-verifies the fixes' : 'checks the rebuttals and fixes'
  return `Round ${round} · codex ${what}`
}

/** Codex could not check a rebuttal or re-verify a fix: the merge is held, never ready on the agent's word alone (R36, R58). */
async function holdPost($: Engine, run: Run, why: string): Promise<void> {
  const ids = (run.rechecks ?? []).join(', ') || 'the rebutted findings'
  const isReverify = run.findings.some(one => (run.rechecks ?? []).includes(one.id) && isReverifyOwed(one))
  const what = isReverify ? `check ${ids} again` : `check the rebuttal of ${ids} again`
  const nextStep = `run /pr-gate resume to have Codex ${what}, or fix ${ids} and push`
  await noteAttempt($, run, why)
  await finish($, run.id, 'blocked', `${why}. Next: ${nextStep}`)
  const saved = await updateRecord($, run.root, run.branch, one => ({ ...one, postStatus: 'blocked', message: why }))
  if (saved !== undefined) say($, heldPrompt(saved, why, nextStep))
}

/**
 * Codex's verdict on each rebuttal, read per finding id (R41): one that holds stays rebutted with Codex's entry; one that does
 * not is open again and goes back to the agent. An id with no readable verdict stays unruled, so it alone is held for a recheck.
 */
async function afterRebuttalCheck($: Engine, run: Run): Promise<void> {
  const now = await $.clock.now()
  const answer = run.pending[0]?.answer ?? ''
  const verdicts = readVerdicts(answer)
  // Fail closed: no readable verdict at all is no check.
  if (verdicts.size === 0) {
    await holdPost($, run, 'Codex gave no readable verdict on a rebuttal')
    return
  }
  const checked = new Set(run.rechecks ?? [])
  const missing = [...checked].filter(id => !verdicts.has(id))
  const ruled = [...checked].filter(id => verdicts.has(id))
  const held = ruled.filter(id => verdicts.get(id)?.holds === true).length
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    findings: one.findings.map(f => {
      const verdict = checked.has(f.id) ? verdicts.get(f.id) : undefined
      if (verdict === undefined) return f
      // A re-verified fix (R58): confirmed, it is verified again on this head; refuted, it is open again and goes back to the agent.
      if (isReverifyOwed(f)) {
        return verdict.holds
          ? markVerified(f, one.round, 'codex', now, 'Codex: the fix still holds after its file changed')
          : markHeld(f, one.round, 'codex', now, verdict.note ?? 'Codex: the fix no longer holds')
      }
      // Codex's acceptance is the history entry { status: 'rebutted', by: 'codex' } (isAcceptedRebuttal).
      return verdict.holds ? acceptRebuttal(f, one.round, now) : markHeld(f, one.round, 'codex', now, verdict.note ?? 'Codex did not accept the rebuttal')
    }),
    steps: withStep(one.steps, {
      id: `r${one.round}-verify`,
      label: checkLabel(one.round, one.findings.filter(f => checked.has(f.id))),
      state: 'done',
      detail: [
        `${held} hold${held === 1 ? 's' : ''}`,
        `${ruled.length - held} not accepted`,
        ...(missing.length === 0 ? [] : [`no verdict for ${missing.join(', ')}`]),
      ].join(' · '),
    }),
  }))
  if (after !== null) await endRound($, after, true)
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
  // A post-PR or delta review starts from the last head a reviewer read in full, never from commits nobody read (R60).
  const lastHead = lastCoveredHead(rec)
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

/** Re-opens triage on the same head for findings a post-PR block left to the agent (R37). It records no round. */
async function startAnswer($: Engine, rec: LifecycleRecord, ids: readonly string[], why: string): Promise<void> {
  const now = await $.clock.now()
  const run = answerRun(rec, ids, now)
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  $.ui.status(`pr-gate r${run.round}: answering the open items`)
  const findings = rec.findings.filter(one => ids.includes(one.id))
  const intro = `The review was resumed on the same head: ${why}. Answer each item below; this uses no review round.`
  const rejected = findings.filter(one => rejections(one) > 0).map(one => one.id)
  const except = rejected.length === 0 ? '' : `; ${rejected.join(', ')}: fix or defer only, Codex already rejected its rebuttal`
  const heading = `Still open (fix, rebut or defer each; a security blocker is fixed or rebutted, and it blocks the merge until then${except}):`
  // A command cannot submit a prompt while it holds the turn: the ticker sends it once the command has returned.
  await patch($, run.id, one => ({ ...one, outbox: triagePrompt(run, rec, [], [], { carried: findings, intro, carriedHeading: heading }) }))
}

/**
 * Re-opens the fix step on the same head for findings a pre-PR block left to the agent (R63, the pre-PR twin of `startAnswer`). It
 * records no round: a fix or a rebuttal goes to Codex in the controller's next round, which is what a rebuttal costs before the PR (R40).
 */
async function startFixAnswer($: Engine, rec: LifecycleRecord, ids: readonly string[], why: string): Promise<void> {
  const now = await $.clock.now()
  const last = rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).at(-1)
  const round = last?.n ?? 1
  const isMain = config.fixer === 'main'
  const step = `r${round}-fix`
  const run: Run = {
    ...answerRun(rec, ids, now),
    round,
    phase: 'fix',
    lifecycle: 'pre',
    roundKind: last?.kind ?? 'discretionary',
    diffBase: `origin/${rec.base}`,
    triaged: undefined,
    steps: [
      { id: 'scope', label: 'Scope & blast radius', state: 'done', detail: `${rec.tier}${rec.lane === 'light' ? ', light lane' : ''}: ${rec.tierWhy}` },
      { id: step, label: `Round ${round} · answer ${ids.join(', ')} (${isMain ? 'main agent' : 'sub-agent'})`, state: 'running' },
      { id: 'pr', label: `Open PR → ${rec.base}`, state: 'pending' },
    ],
    pending: isMain ? [{ role: 'fix', step, isMain: true }] : [],
    activity: isMain ? 'waiting on the main agent to answer the open findings…' : 'starting the fixer…',
  }
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  $.ui.status(`pr-gate r${round}: answering the open findings`)
  const intro = `pr-gate: the pre-PR review was resumed on the same head: ${why}. Answer ${ids.join(', ')} below; this uses no review round.`
  const prompt = `${intro}\n\n${fixPrompt(run, undefined, isMain)}`
  if (isMain) {
    // A command cannot submit a prompt while it holds the turn: the ticker sends it once the command has returned.
    await patch($, run.id, one => ({ ...one, outbox: prompt }))
    return
  }
  const { isStarted, agentId } = await spawn($, run, 'fix', prompt)
  if (!isStarted) {
    await finish($, run.id, 'error', 'The fixer sub-agent could not be started.')
    return
  }
  await patch($, run.id, one => ({ ...one, pending: [{ role: 'fix', step, agentId }], activity: 'waiting on the fixer…' }))
}

/** Codex checks rebuttals it never ruled on, on the same head, as an answer run: no round, no allowance (R39). */
async function startRecheck($: Engine, rec: LifecycleRecord, ids: readonly string[]): Promise<void> {
  const now = await $.clock.now()
  const run = answerRun(rec, ids, now)
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  await checkRebuttals($, run, rec.findings.filter(one => ids.includes(one.id)))
}

/** A run on the same head that records no round: an answer to a block, or a rebuttal check (R37, R39). */
function answerRun(rec: LifecycleRecord, ids: readonly string[], now: number): Run {
  const last = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted).at(-1)
  const round = last?.n ?? 1
  const findings = rec.findings.filter(one => ids.includes(one.id))
  const run: Run = {
    id: `${now}`,
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
    phase: 'triage',
    hasRefixed: false,
    hasReprompted: false,
    fixKind: 'blocking',
    steps: [
      { id: 'scope', label: 'Scope & blast radius', state: 'done', detail: `${rec.tier}${rec.lane === 'light' ? ', light lane' : ''}: ${rec.tierWhy}` },
      { id: `r${round}-triage`, label: `Round ${round} · answer ${ids.length} open item${ids.length === 1 ? '' : 's'} (main agent)`, state: 'running' },
      { id: 'pr', label: `Open PR → ${rec.base}`, state: 'done' },
    ],
    findings: rec.findings,
    pending: [{ role: 'triage', step: `r${round}-triage`, isMain: true }],
    activity: 'waiting on the main agent to answer the open items…',
    startedAt: now,
    phaseStartedAt: now,
    lifecycle: 'post',
    roundKind: last?.kind ?? 'baseline',
    roundStartHead: rec.head,
    roundStartedAt: now,
    diffBase: rec.head,
    evidence: [],
    activeMs: 0,
    waitMs: 0,
    triaged: findings.flatMap(one => (one.source === 'github' && one.externalId !== undefined ? [one.externalId] : [])),
    asked: [...ids],
    isAnswer: true,
  }
  return run
}

/** The round in flight ended, complete or not: append it to the record, then let the controller choose. */
async function endRound($: Engine, run: Run, isCompleted: boolean, outstanding?: string): Promise<void> {
  const now = await $.clock.now()
  // After the PR: the head GitHub last reported for it, whatever is checked out here (an adopted PR, a push from elsewhere).
  const head = run.lifecycle === 'post' ? undefined : await git($, run.root, ['rev-parse', 'HEAD'])
  const endHead = head?.isOk === true ? head.out : run.headSha
  if (run.isAnswer === true) {
    // A fix committed in a resumed pre-PR fix step is a new head (R63, R55, R56): flagged findings and lapsed waivers, as a round's
    // own commits get. `onNewHead` patches the live run, so its findings are read again before they are merged.
    if (run.lifecycle === 'pre' && endHead !== run.roundStartHead) await onNewHead($, run, run.roundStartHead, endHead, now)
    const live = await getRun($)
    const findings = live !== null && live.id === run.id ? live.findings : run.findings
    // An answer on the same head (R37): the ledger and the head move on, no round is recorded.
    await updateRecord($, run.root, run.branch, rec => ({ ...rec, head: endHead, findings: mergeFindings(rec.findings, findings), effort: run.effort }))
    if (isCompleted) await advance($, run.root, run.branch)
    return
  }
  const current = run.findings.filter(one => raisedIn(one, run.round))
  const round: RoundRecord = {
    n: run.round,
    phase: run.lifecycle,
    kind: run.roundKind,
    isAdvisory: run.fixKind === 'advisory',
    startHead: run.roundStartHead,
    endHead,
    base: run.base,
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
  // Before the PR, this round's own commits are a new head (R52, R55, R56); after it, `pollOnce` and `afterTriage` see each one.
  const isMoved = run.lifecycle === 'pre' && endHead !== run.roundStartHead
  // A fix the fix reviewer verified in this round owes no re-verify for the round's own commits only if the reviewer read the end
  // head: a commit that landed while it ran (`run.headSha` is the head it read, not `endHead`) leaves the fix owed (R58, R59).
  const isVerifiedAtEnd = (one: Finding): boolean => {
    const last = one.history.at(-1)
    return one.status === 'verified-fixed' && last?.round === run.round && last.by === 'fix-reviewer' && run.headSha === endHead
  }
  // The head move is read from the record under its lock (R1-6), so a waiver given meanwhile is lapsed or kept, never lost.
  await updateRecord($, run.root, run.branch, async rec => {
    const moved = isMoved
      ? await headMoved($, run.root, { ...rec, findings: mergeFindings(rec.findings, run.findings) }, run.roundStartHead, endHead, now)
      : undefined
    const flagged = new Set(moved?.findings.filter(one => one.needsRecheck === true && !isVerifiedAtEnd(one)).map(one => one.id) ?? [])
    return {
      ...withRound(rec, round),
      head: endHead,
      findings: mergeFindings(rec.findings, run.findings).map(one => (flagged.has(one.id) ? { ...one, needsRecheck: true } : one)),
      ...(moved === undefined ? {} : { waivers: moved.waivers }),
      effort: run.effort,
    }
  })
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

/**
 * After a round, or at start: the controller reads the record and does what `decideNext` says. `isResume`: the person or agent ran
 * /pr-gate or resume, which alone re-opens a pre-PR fix step on the same head (R63); a held create or a grant does not.
 */
export async function advance($: Engine, root: string, branch: string, isResume = false): Promise<void> {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined) return
  const next = decideNext(rec)
  // A ready record the controller no longer finds ready is back in post-PR review.
  if (next.kind !== 'ready' && rec.phase === 'ready') await updateRecord($, root, branch, one => ({ ...one, phase: 'post' }))
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
      if (held !== undefined) say($, heldPrompt(saved, held.why, held.nextStep))
      return
    }
    if (config.openPr) {
      await markPr($, 'running', 'handed to the main agent')
      say($, prPrompt(ended, saved, next.status))
    }
    return
  }
  if (next.kind === 'ready') {
    const saved = await updateRecord($, root, branch, one => ({ ...one, phase: 'ready', postStatus: undefined, message: undefined }))
    if (id !== undefined) await finish($, id, 'passed', `Lifecycle review complete at ${rec.head.slice(0, 7)}: ready for the merge decision.`)
    if (saved !== undefined) say($, readyPrompt(saved))
    return
  }
  const isPre = rec.phase === 'pre'
  // A resume of a pre-PR block the agent can answer on the same head re-opens the fix step for it: no round, no allowance (R63).
  if (isPre && isResume && id === undefined && next.kind === 'blocked' && (next.answer ?? []).length > 0) {
    await startFixAnswer($, rec, next.answer ?? [], next.why)
    return
  }
  // A resume of a post-PR block the agent can answer on the same head re-opens triage for it: no round, no allowance (R37).
  if (!isPre && id === undefined && next.kind === 'blocked' && (next.answer ?? []).length > 0) {
    await startAnswer($, rec, next.answer ?? [], next.why)
    return
  }
  // A rebuttal Codex never ruled on: Codex checks it on this head, using no round (R39).
  if (!isPre && id === undefined && next.kind === 'blocked' && (next.recheck ?? []).length > 0) {
    await startRecheck($, rec, next.recheck ?? [])
    return
  }
  // Only the post-PR side waits on the person's decision; the run itself ends blocked.
  const runStatus = next.kind === 'awaiting-decision' ? 'blocked' : next.kind
  const saved = await updateRecord($, root, branch, one =>
    isPre ? { ...one, preStatus: runStatus, preHead: one.head, message: next.why } : { ...one, postStatus: next.kind, message: next.why },
  )
  if (id !== undefined) await finish($, id, runStatus, `${next.why}. Next: ${next.nextStep}`)
  if (saved === undefined) return
  // Before the PR: only the round that just ended says so; a rerun on the same record says nothing new.
  if (isPre) {
    if (id !== undefined) say($, heldPrompt(saved, next.why, next.nextStep))
    return
  }
  say($, reportPrompt(saved, next))
}

/** Blockers that hold an exhausted gate: unresolved, or only reported fixed. */
const heldFindings = (rec: LifecycleRecord): Finding[] => [...unresolvedBlockers(rec), ...verificationOwed(rec)]

/** Why the pre-PR gate holds the PR, and the next step; undefined when it does not hold it for a settled reason. */
export function heldReason(rec: LifecycleRecord): { why: string; nextStep: string } | undefined {
  if (rec.preStatus === 'blocked') {
    // The controller's own next step for this block (R49): a deferral is never "fix or rebut".
    const next = decideNext(rec)
    if (next.kind === 'blocked') return { why: next.why, nextStep: next.nextStep }
    return { why: rec.message ?? 'a decision is needed', nextStep: 'run /pr-gate resume, which decides again from the record' }
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
    // With the allowance spent, a new round or a release is the person's: the agent tells them, it never types their command (R49).
    nextStep: `tell the person why ${holding.map(one => one.id).join(', ') || 'the open findings'} still ${n === 1 ? 'holds' : 'hold'} the PR, then stop`,
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
        // A rebuttal Codex accepts stays rebutted, with Codex's entry (R44); a fix it confirms is verified.
        const confirmed = old.status === 'rebutted' ? acceptRebuttal(old, one.round, now) : markVerified(old, one.round, 'codex', now)
        // After the PR opens, a dispute is the person's (R40): a review's ruling does not move it.
        // Only a fix or a rebuttal is Codex's to rule on (R45): a deferral is released by the person's waiver alone.
        // A verified fix whose file changed is Codex's to re-verify (R58): verified clears the flag, held reopens it.
        const isTheirs = (one.lifecycle === 'post' && isDisputed(old)) || (old.status !== 'reported-fixed' && old.status !== 'rebutted' && !isReverifyOwed(old))
        const ruled = isTheirs ? old : verified.has(old.id) ? confirmed : held.has(old.id) ? markHeld(old, one.round, 'codex', now) : old
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
  // One the person waived while the round ran is not asked about again.
  const waived = waivedIds((await loadRecord($, run.root, run.branch)) ?? { waivers: [] })
  const unanswered = after.findings.filter(
    one => raisedIn(one, after.round) && one.status === 'open' && !said.some(each => each.id === one.id) && !waived.has(one.id),
  )
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
  if (run.lifecycle === 'post') {
    await afterRebuttalCheck($, run)
    return
  }
  const now = await $.clock.now()
  const verdict = readVerify(run.pending[0]?.answer ?? '')
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    hasRefixed: verdict.isRead && !verdict.isOk,
    // The fix reviewer confirmed the round's blocking fixes.
    findings: verdict.isOk
      ? one.findings.map(f => (raisedIn(f, one.round) && isBlocking(f) && f.status === 'reported-fixed' ? markVerified(f, one.round, 'fix-reviewer', now) : f))
      : one.findings,
    steps: withStep(one.steps, {
      id: `r${one.round}-verify`,
      label: `Round ${one.round} · review the fix`,
      state: 'done',
      detail: verdict.isOk ? 'fix holds' : verdict.isRead ? 'sent back to the fixer' : 'no readable verdict: the fixes stay unverified',
    }),
  }))
  if (after === null) return
  // No readable verdict: the round ends with its fixes still owed verification, which the next Codex round or exhaustion holds.
  if (verdict.isOk || !verdict.isRead) await endRound($, after, true)
  else await beginFix($, run.id, verdict.notes ?? 'The fix does not settle the findings.')
}

// The main loop's turn in progress, from its `turn.start` to its `turn.complete`: what a main-agent tool call belongs to.
let mainTurn: string | undefined

/** Whether a pending step is the one this event's loop and turn answer: a sub-agent by its id, the main agent by its own turn (R51). */
export const isTurnOf = (one: Pending, agentId: string | undefined, turnId: string | undefined = mainTurn): boolean =>
  one.isMain === true ? agentId === undefined && one.turnId !== undefined && one.turnId === turnId : one.agentId !== undefined && one.agentId === agentId

/**
 * A main-loop turn started. When its text carries the step marker of a main-agent step still waiting (the `"step":"…"` every
 * step prompt embeds), that turn is the step's own: only its completion is the answer, and the step's clock starts now (R51).
 */
export async function onTurnStart($: Engine, agentId: string | undefined, turnId: string, text: string): Promise<void> {
  if (agentId !== undefined) return
  mainTurn = turnId
  const run = await getRun($)
  if (run === null || run.status !== 'running') return
  // Armed once: a later turn carrying the same text (the prompt pasted again) does not take the step from its own turn.
  const isStep = (one: Pending): boolean =>
    one.isMain === true && one.answer === undefined && one.turnId === undefined && text.includes(`"step":"${one.step}"`)
  if (!run.pending.some(isStep)) return
  const now = await $.clock.now()
  await patch($, run.id, one => ({ ...one, phaseStartedAt: now, pending: one.pending.map(each => (isStep(each) ? { ...each, turnId } : each)) }))
}

/** One agent's turn ended: record its answer, and move on once the step's agents are all in. */
export async function onAnswer($: Engine, agentId: string | undefined, answer: string, reason: string, turnId?: string): Promise<void> {
  if (agentId === undefined && turnId === mainTurn) mainTurn = undefined
  const run = await getRun($)
  if (run === null || run.status !== 'running') {
    isLive = false
    return
  }
  // A sub-agent is known by the id the engine gave it, or by the step it names in its
  // trailer; the main agent by the turn that began with its step's prompt (R51).
  const named = readTrailer(answer)?.step
  const isMine = (one: Pending): boolean =>
    one.isMain === true ? isTurnOf(one, agentId, turnId) : one.agentId !== undefined ? one.agentId === agentId : named === one.step
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
