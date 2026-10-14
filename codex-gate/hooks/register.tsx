// codex-gate: rounds of adversarial Codex review and agent fixes, run locally
// before a pull request to a gated base is opened.
//
// The rounds are a state machine the host keeps in `$.state`. Each step is
// an agent; its `turn.complete` moves the machine on. Nothing here waits on
// a step inside one dispatch.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Effort, Finding, PassRecord, Pending, Role, Run, RunStatus, Step } from '../types'
import {
  activityOf,
  classify,
  compileRisk,
  fixPrompt,
  isBlocking,
  isVersionOnly,
  lowerOf,
  prPrompt,
  readGitlinks,
  readDispositions,
  readPrCreate,
  readReview,
  readTrailer,
  readVerify,
  reviewPrompt,
  slugOf,
  stepDown,
  stepOf,
  verifyPrompt,
} from './core'
import type { PrCreate } from './core'

const PANE = 'codex-gate'
const COMMAND = 'pr-gate'
const RUN = { plugin: 'codex-gate', key: 'run' } as const
const runAtom = atom(RUN, null)
const tickAtom = atom({ plugin: 'codex-gate', key: 'tick' } as const, 0)
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const GITHUB_CREATE_PR = 'mcp__plugin_github_github__create_pull_request'

type Engine = EngineInterface

type Config = {
  maxRounds: number
  advisoryMin: number
  advisoryMax: number
  bases: string[]
  enforce: boolean
  fixer: 'main' | 'subagent'
  fixReview: 'auto' | 'always' | 'never'
  onExhausted: 'open-pr' | 'stop'
  openPr: boolean
  highRisk: RegExp | undefined
  stepTimeoutMs: number
  /** Effort for a standard change; a high blast-radius change always starts at high. */
  effort: Effort
  /** Effort for a light-lane (chore/) branch that is not high blast radius. */
  lightEffort: Effort
  light: RegExp | undefined
}

const effortOf = (value: unknown, fallback: Effort): Effort =>
  value === 'high' || value === 'medium' || value === 'low' ? value : fallback

function configOf(options: PluginOptions): Config {
  const number = (key: string, fallback: number): number => {
    const value = Number(options[key])
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
  }
  const bases = String(options.bases ?? 'dev,main')
    .split(',')
    .map(one => one.trim())
    .filter(one => one !== '')
  const advisoryMaxRaw = Number(options.advisoryMaxRounds ?? 3)
  const advisoryMax = Number.isFinite(advisoryMaxRaw) && advisoryMaxRaw >= 0 ? Math.min(Math.floor(advisoryMaxRaw), 10) : 3
  return {
    maxRounds: Math.min(number('maxRounds', 5), 10),
    advisoryMin: Math.min(number('advisoryMinRounds', 1), advisoryMax),
    advisoryMax,
    bases: bases.length > 0 ? bases : ['dev', 'main'],
    enforce: options.enforce !== false,
    fixer: options.fixer === 'subagent' ? 'subagent' : 'main',
    fixReview: options.fixReview === 'always' || options.fixReview === 'never' ? options.fixReview : 'auto',
    onExhausted: options.onExhausted === 'stop' ? 'stop' : 'open-pr',
    openPr: options.openPr !== false,
    highRisk: compileRisk(String(options.highRiskPaths ?? '')),
    stepTimeoutMs: number('stepTimeoutMinutes', 30) * 60_000,
    effort: effortOf(options.reviewEffort, 'medium'),
    lightEffort: effortOf(options.lightEffort, 'low'),
    light: compileRisk(String(options.lightBranches ?? '^chore/')),
  }
}

const storeKey = (root: string, branch: string): string => `gate:${root}:${branch}`

const opensPr = (status: RunStatus, config: Config): boolean =>
  status === 'passed' || status === 'waived' || (status === 'exhausted' && config.onExhausted === 'open-pr')

const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Sets a step, adding it ahead of the closing "open PR" step when it is new. */
function withStep(steps: readonly Step[], step: Step): Step[] {
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

  const getRun = async ($: Engine): Promise<Run | null> => (await $.state.get(RUN)).value ?? null

  /** Applies a change to the run in flight; a run that ended or was replaced is left alone. */
  const patch = async ($: Engine, id: string, change: (run: Run) => Run): Promise<Run | null> => {
    let after: Run | null = null
    await update($, runAtom, run => {
      after = run !== null && run !== undefined && run.id === id && run.status === 'running' ? change(run) : (run ?? null)
      return after
    })
    return after
  }

  const git = async ($: Engine, cwd: string | undefined, args: string[], timeoutMs = 30_000) => {
    const ran = await $.process.run(['git', ...args], { cwd, timeoutMs })
    return { isOk: ran.exitCode === 0, out: ran.stdout.trim(), err: ran.stderr.trim() }
  }

  const stopTicker = (): void => {
    ticker?.cancel()
    ticker = undefined
  }

  const startTicker = ($: Engine): void => {
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
        if (now - run.phaseStartedAt > config.stepTimeoutMs) {
          const why = `The ${run.phase} step ran past ${elapsed(config.stepTimeoutMs)}.`
          if (run.phase === 'review') await retryLower($, run, why)
          else await finish($, run.id, 'error', why, true, true)
        }
      })().catch(() => undefined)
    })
  }

  // ------------------------------------------------------------- the end

  const finish = async (
    $: Engine,
    id: string,
    status: RunStatus,
    message: string,
    shouldPrompt = true,
    hasTimedOut = false,
  ): Promise<void> => {
    const now = await $.clock.now()
    const willOpen = shouldPrompt && config.openPr && opensPr(status, config)
    const run = await patch($, id, one => ({
      ...one,
      status,
      phase: 'done',
      message,
      endedAt: now,
      pending: [],
      activity: '',
      steps: one.steps.map(step =>
        step.id === 'pr'
          ? { ...step, state: willOpen ? 'running' : opensPr(status, config) ? 'pending' : 'skipped', detail: willOpen ? 'handed to the main agent' : undefined }
          : step.state === 'running'
            ? { ...step, state: status === 'error' || status === 'stopped' ? 'failed' : 'done' }
            : step,
      ),
    }))
    stopTicker()
    isLive = false
    if (run === null) return
    const head = await git($, run.root, ['rev-parse', 'HEAD'])
    // A review that completed below the branch's default sets where the next run starts; a run that never completed one keeps the last.
    const hasReviewed = status === 'passed' || status === 'exhausted' || status === 'blocked'
    const prior = (await $.store.get(storeKey(run.root, run.branch))) as PassRecord | undefined | null
    const passedEffort = hasReviewed ? run.effort : prior?.passedEffort
    const start = run.startEffort ?? 'high'
    const isBelow = passedEffort !== undefined && passedEffort !== start && lowerOf(passedEffort, start) === passedEffort
    const record: PassRecord = {
      sha: head.isOk ? head.out : run.headSha,
      base: run.base,
      status,
      at: now,
      rounds: run.round,
      note: message,
      effort: run.effort,
      ...(hasTimedOut ? { hasTimedOut: true } : {}),
      ...(isBelow ? { passedEffort } : {}),
    }
    await $.store.set(storeKey(run.root, run.branch), record)
    $.ui.status(undefined)
    $.ui.toast(`codex-gate ${status}: ${message}`.slice(0, 300))
    if (willOpen) void $.prompt.submit({ text: prPrompt(run, status !== 'exhausted') }).catch(() => undefined)
  }

  // ----------------------------------------------------------- the steps

  const spawn = async (
  $: Engine,
  run: Run,
  role: Role,
  prompt: string,
): Promise<{ isStarted: boolean; agentId?: string }> => {
    const started = await $.agent.spawn({
      prompt,
      description: `codex-gate r${run.round} ${role}`,
      subagentType: 'general-purpose',
      cwd: run.root,
    })
    return 'deny' in started && typeof started.deny === 'string' ? { isStarted: false } : { isStarted: true, agentId: started.agentId }
  }

  const beginReview = async ($: Engine, id: string): Promise<void> => {
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
    $.ui.status(`codex-gate r${opened.round}: codex reviewing (${opened.effort})`)
    // Parallel sub-agents: on a high blast-radius change the review and the challenge run side by side.
    const started = await Promise.all(roles.map(role => spawn($, opened, role, reviewPrompt(opened, role))))
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

  const beginFix = async ($: Engine, id: string, notes: string | undefined, kind: Run['fixKind'] = 'blocking'): Promise<void> => {
    const now = await $.clock.now()
    const isMain = config.fixer === 'main'
    const opened = await patch($, id, run => ({
      ...run,
      fixKind: kind,
      advisoryRound: kind === 'advisory' ? run.advisoryRound + 1 : run.advisoryRound,
      phase: 'fix',
      phaseStartedAt: now,
      pending: isMain ? [{ role: 'fix', step: stepOf(run, 'fix'), isMain: true }] : [],
      activity: isMain ? 'waiting on the main agent to fix…' : 'starting the fixer…',
      steps: withStep(run.steps, {
        id: `r${run.round}-fix${notes === undefined ? '' : '-again'}`,
        label:
          kind === 'advisory'
            ? `Round ${run.round} · advisories ${run.advisoryRound + 1}/${run.advisoryMax} (${isMain ? 'main agent' : 'sub-agent'})`
            : `Round ${run.round} · ${notes === undefined ? 'fix' : 'fix again'} (${isMain ? 'main agent' : 'sub-agent'})`,
        state: 'running',
      }),
    }))
    if (opened === null) return
    $.ui.status(`codex-gate r${opened.round}: ${kind === 'advisory' ? `advisories ${opened.advisoryRound}/${opened.advisoryMax}` : 'fixing'}`)
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
        await patch($, id, run =>
          run.phase === 'fix' ? { ...run, pending: run.pending.map(one => ({ ...one, isArmed: true })) } : run,
        )
        // The step's clock starts with the turn, not with the wait for the session to go idle.
        const startedAt = await $.clock.now()
        await patch($, id, run => (run.phase === 'fix' ? { ...run, phaseStartedAt: startedAt } : run))
      })
      .catch(() => undefined)
  }

  const beginVerify = async ($: Engine, id: string, fromSha: string): Promise<void> => {
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
    $.ui.status(`codex-gate r${opened.round}: reviewing the fix`)
    const { isStarted, agentId } = await spawn($, opened, 'verify', verifyPrompt(opened, fromSha))
    if (!isStarted) {
      await finish($, id, 'error', 'The fix reviewer sub-agent could not be started.')
      return
    }
    await patch($, id, run => ({ ...run, pending: [{ role: 'verify', step: stepOf(run, 'verify'), agentId }], activity: 'waiting on the fix reviewer…' }))
  }

  /**
   * Codex timed out: rerun the same round one effort lower, spending no round. At low it
   * fails closed. A reviewer still running is not stopped (there is no way to); its late
   * answer is ignored, as `isMine` knows a sub-agent by the id it was given.
   */
  const retryLower = async ($: Engine, run: Run, why: string): Promise<void> => {
    const lower = stepDown(run.effort)
    if (lower === undefined) {
      await finish($, run.id, 'error', `${why} Codex timed out at low effort, the lowest the gate uses.`, true, true)
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
    $.ui.toast(`codex-gate: Codex timed out at ${run.effort}; rerunning round ${run.round} at ${lower}.`)
    await beginReview($, run.id)
  }

  const nextRound = async ($: Engine, id: string): Promise<void> => {
    const moved = await patch($, id, run => ({ ...run, round: run.round + 1, hasRefixed: false }))
    if (moved !== null) await beginReview($, id)
  }

  // ------------------------------------------------- what each answer does

  const afterReview = async ($: Engine, run: Run): Promise<void> => {
    const results = run.pending.map(one => ({ role: one.role, result: readReview(one.answer ?? '') }))
    const fresh: Finding[] = []
    for (const { role, result } of results) {
      for (const one of result.findings) {
        fresh.push({
          ...one,
          id: `R${run.round}-${fresh.length + 1}`,
          round: run.round,
          source: role === 'challenge' ? 'challenge' : 'review',
          status: 'open',
        })
      }
    }
    const blocking = fresh.filter(isBlocking)
    const failed = results.find(one => one.result.gate === 'ERROR')
    if (failed !== undefined && failed.result.failure === 'timeout') {
      // Nothing of this round is kept, a parallel reviewer's findings included: it reruns whole.
      await retryLower($, run, `Codex ${failed.role} timed out at ${run.effort}: ${failed.result.note ?? 'no verdict'}.`)
      return
    }
    const after = await patch($, run.id, one => ({
      ...one,
      pending: [],
      // What an earlier round left open and Codex no longer raises is settled.
      findings: [...one.findings.map(old => (old.status === 'open' ? { ...old, status: 'fixed' as const } : old)), ...fresh],
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
      await finish($, run.id, 'error', `Codex ${failed.role} did not complete: ${failed.result.note ?? 'no verdict'}`)
      return
    }
    if (blocking.length === 0) {
      // Nothing blocks the PR. What Codex still raised goes to the fixer, a bounded number of times.
      if (fresh.length > 0 && after.advisoryRound < after.advisoryMax) {
        await beginFix($, run.id, undefined, 'advisory')
        return
      }
      const isUnverified = results.every(one => one.result.gate === 'UNVERIFIED')
      const left = fresh.length === 0 ? '' : ` ${fresh.length} advisory finding${fresh.length === 1 ? '' : 's'} left after ${after.advisoryRound} advisory round${after.advisoryRound === 1 ? '' : 's'}.`
      await finish(
        $,
        run.id,
        'passed',
        `No high/critical finding after ${after.round} round${after.round === 1 ? '' : 's'}${isUnverified ? ' (Codex tagged nothing; its prose was read as clean)' : ''}.${left}`,
      )
      return
    }
    // Advisory rounds are on top of the blocking budget.
    if (after.round >= after.maxRounds + after.advisoryRound) {
      await finish($, run.id, 'exhausted', `${blocking.length} high/critical finding${blocking.length === 1 ? '' : 's'} still open after ${after.round} rounds.`)
      return
    }
    await beginFix($, run.id, undefined)
  }

  const afterFix = async ($: Engine, run: Run): Promise<void> => {
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
        return answer === undefined ? finding : { ...finding, status: answer.action, note: answer.note }
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
    if (dirty.isOk && dirty.out !== '') {
      await finish($, run.id, 'error', 'The fixer left uncommitted changes. Codex reads committed code only: commit them and run /pr-gate again.')
      return
    }
    if (after.fixKind === 'advisory') {
      const advisories = after.findings.filter(one => one.round === after.round && !isBlocking(one))
      const hasRebuttal = advisories.some(one => one.status === 'rebutted')
      // New commits always go back to Codex. With none, Codex is asked again only to answer
      // a rebuttal, and only until the minimum number of advisory rounds has run.
      if (newSha === fromSha && !(hasRebuttal && after.advisoryRound < after.advisoryMin)) {
        const open = advisories.filter(one => one.status !== 'fixed').length
        await finish($, run.id, 'passed', `No high/critical finding after ${after.round} round${after.round === 1 ? '' : 's'}. ${open} advisory finding${open === 1 ? '' : 's'} left as ${open === 1 ? 'it is' : 'they are'} after ${after.advisoryRound} advisory round${after.advisoryRound === 1 ? '' : 's'}.`)
        return
      }
      await nextRound($, run.id)
      return
    }
    const current = after.findings.filter(one => one.round === after.round && isBlocking(one))
    const deferred = current.filter(one => one.status === 'deferred')
    if (deferred.length > 0) {
      await finish($, run.id, 'blocked', `${deferred.map(one => one.id).join(', ')} need${deferred.length === 1 ? 's' : ''} a decision from you: the fix reaches past this branch's scope.`)
      return
    }
    if (newSha === fromSha && !current.some(one => one.status === 'rebutted')) {
      await finish($, run.id, 'blocked', 'The fixer changed nothing and rebutted nothing, so another Codex round would say the same.')
      return
    }
    const wantsVerify = config.fixReview === 'always' || (config.fixReview === 'auto' && after.tier === 'high')
    if (wantsVerify && !after.hasRefixed && newSha !== fromSha) {
      await beginVerify($, run.id, fromSha)
      return
    }
    await nextRound($, run.id)
  }

  const afterVerify = async ($: Engine, run: Run): Promise<void> => {
    const verdict = readVerify(run.pending[0]?.answer ?? '')
    const after = await patch($, run.id, one => ({
      ...one,
      pending: [],
      hasRefixed: !verdict.isOk,
      steps: withStep(one.steps, {
        id: `r${one.round}-verify`,
        label: `Round ${one.round} · review the fix`,
        state: 'done',
        detail: verdict.isOk ? 'fix holds' : 'sent back to the fixer',
      }),
    }))
    if (after === null) return
    if (verdict.isOk) await nextRound($, run.id)
    else await beginFix($, run.id, verdict.notes ?? 'The fix does not settle the findings.')
  }

  /** One agent's turn ended: record its answer, and move on once the step's agents are all in. */
  const onAnswer = async ($: Engine, agentId: string | undefined, answer: string, reason: string): Promise<void> => {
    const run = await getRun($)
    if (run === null || run.status !== 'running') {
      isLive = false
      return
    }
    // A sub-agent is known by the id the engine gave it, or by the step it names in its
    // trailer; the main agent by the turn that began once its prompt had entered.
    const named = readTrailer(answer)?.step
    const isMine = (one: Pending): boolean =>
      one.isMain === true
        ? agentId === undefined && one.isArmed === true
        : one.agentId !== undefined
          ? one.agentId === agentId
          : named === one.step
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
  }

  // ------------------------------------------------------------ starting

  const startGate = async ($: Engine, want: { base?: string; cwd?: string; isHeldCall?: boolean }): Promise<string> => {
    const existing = await getRun($)
    if (existing !== null && existing.status === 'running') {
      return `The gate is already running for ${existing.branch} (round ${existing.round}).`
    }
    const top = await git($, want.cwd, ['rev-parse', '--show-toplevel'])
    if (!top.isOk) return 'Not started: this is not a git repository.'
    const root = top.out
    const base = want.base ?? config.bases[0] ?? 'dev'
    const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
    if (branch === '' || branch === 'HEAD') return 'Not started: HEAD is detached, so there is no branch to open a PR from.'
    if (branch === base) return `Not started: you are on ${base} itself. Check out the branch the PR will come from.`
    await git($, root, ['fetch', 'origin', base], 120_000)
    if (!(await git($, root, ['rev-parse', '--verify', '--quiet', `origin/${base}`])).isOk) {
      return `Not started: origin/${base} does not exist here.`
    }
    const dirty = await git($, root, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty.out !== '') return 'Not started: there are uncommitted changes. Codex reviews committed code only; commit them first.'
    const head = (await git($, root, ['rev-parse', 'HEAD'])).out
    const stat = await git($, root, ['diff', '--numstat', `origin/${base}...HEAD`])
    if (!stat.isOk) return `Not started: git could not diff against origin/${base}: ${stat.err.slice(0, 200)}`
    const rows = stat.out === '' ? [] : stat.out.split('\n').map(line => line.split('\t'))
    const files = rows.map(row => row[2] ?? '').filter(file => file !== '')
    const lines = rows.reduce((sum, row) => sum + (Number(row[0]) || 0) + (Number(row[1]) || 0), 0)
    if (files.length === 0) return `Not started: ${branch} has no changes against origin/${base}.`
    const settled = await settledFiles($, root, base, files)
    const landedOn = await isAlreadyOnBase($, root, base)
    const scope =
      landedOn !== undefined
        ? { tier: 'trivial' as const, why: `already reviewed: every commit is on ${landedOn}` }
        : classify(files, lines, config.highRisk, settled)
    const lane = config.light !== undefined && config.light.test(branch) ? ('light' as const) : ('full' as const)
    // High blast radius starts at high; the rest at the configured effort, lower on a light-lane branch.
    const startEffort: Effort = scope.tier === 'high' ? 'high' : lane === 'light' ? config.lightEffort : config.effort
    const last = (await $.store.get(storeKey(root, branch))) as PassRecord | undefined | null
    // The branch's last run timed out at its lowest step: this one starts a level below where that one ended.
    // Otherwise it starts no higher than the effort a review last completed at on this branch.
    const afterTimeout = last?.hasTimedOut === true && last.effort !== undefined ? (stepDown(last.effort) ?? 'low') : startEffort
    const effort = lowerOf(lowerOf(startEffort, afterTimeout), last?.passedEffort ?? startEffort)
    const now = await $.clock.now()
    const run: Run = {
      id: `${now}`,
      cwd: want.cwd ?? root,
      root,
      branch,
      base,
      headSha: head,
      tier: scope.tier,
      tierWhy: scope.why,
      lane,
      effort,
      startEffort,
      round: 1,
      maxRounds: lane === 'light' ? 1 : config.maxRounds,
      status: 'running',
      phase: 'scope',
      hasRefixed: false,
      fixKind: 'blocking',
      advisoryRound: 0,
      advisoryMin: lane === 'light' ? 0 : config.advisoryMin,
      advisoryMax: lane === 'light' ? 0 : config.advisoryMax,
      steps: [
        {
          id: 'scope',
          label: 'Scope & blast radius',
          state: 'done',
          detail: `${scope.tier}${lane === 'light' ? ', light lane' : ''}: ${scope.why}`,
        },
        { id: 'pr', label: `Open PR → ${base}`, state: 'pending' },
      ],
      findings: [],
      pending: [],
      activity: '',
      startedAt: now,
      phaseStartedAt: now,
    }
    await update($, runAtom, () => run)
    await update($, tickAtom, () => now)
    isLive = true
    startTicker($)
    void $.ui.open({ id: PANE, title: 'Codex gate' }).catch(() => undefined)
    if (scope.tier === 'trivial') {
      await patch($, run.id, one => ({
        ...one,
        steps: withStep(one.steps, { id: 'r1-review', label: 'Codex review', state: 'skipped', detail: scope.why }),
      }))
      await finish($, run.id, 'passed', `Codex skipped: ${scope.why}.`, want.isHeldCall !== true)
      return `Gate passed without Codex: ${scope.why}.`
    }
    await beginReview($, run.id)
    const tierNote = scope.tier === 'high' ? ' Review and challenge run in parallel, and fixes are reviewed before each new round.' : ''
    const budget =
      lane === 'light'
        ? `one Codex round (light lane: ${branch} matches lightBranches); what it raises goes to the pull request`
        : `up to ${run.maxRounds} rounds on high/critical findings, then up to ${run.advisoryMax} on the rest`
    return `Gate started for ${branch} → ${base}: ${scope.tier} blast radius (${scope.why}), Codex at ${effort} effort, ${budget}.${tierNote}`
  }

  /**
   * Changed files whose content was reviewed elsewhere: a submodule pointer to a commit
   * already on that submodule's origin/main or origin/dev, and a package.json or lock change
   * that touches only "version" lines. A pointer to an unlanded commit is not settled.
   */
  const settledFiles = async ($: Engine, root: string, base: string, files: readonly string[]): Promise<string[]> => {
    const out: string[] = []
    const raw = await git($, root, ['diff', '--raw', `origin/${base}...HEAD`])
    for (const link of raw.isOk ? readGitlinks(raw.out) : []) {
      const at = `${root}/${link.path}`
      await git($, at, ['fetch', 'origin', 'main', 'dev'], 120_000)
      for (const ref of ['origin/main', 'origin/dev']) {
        if ((await git($, at, ['merge-base', '--is-ancestor', link.sha, ref])).isOk) {
          out.push(link.path)
          break
        }
      }
    }
    for (const file of files.filter(one => /(^|\/)package(-lock)?\.json$/.test(one))) {
      const diff = await git($, root, ['diff', '-U0', `origin/${base}...HEAD`, '--', file])
      if (diff.isOk && isVersionOnly(diff.out)) out.push(file)
    }
    return out
  }

  /**
   * The other gated base whose origin already holds every commit this branch adds (a
   * back-sync of main into dev), with no merge commit carrying edits of its own; else undefined.
   */
  const isAlreadyOnBase = async ($: Engine, root: string, base: string): Promise<string | undefined> => {
    const merges = await git($, root, ['rev-list', '--merges', `origin/${base}..HEAD`])
    const isCleanMerges =
      merges.isOk &&
      (
        await Promise.all(
          (merges.out === '' ? [] : merges.out.split('\n')).map(async sha => {
            const own = await git($, root, ['show', '--cc', '--format=', sha])
            return own.isOk && own.out === ''
          }),
        )
      ).every(Boolean)
    for (const other of isCleanMerges ? config.bases.filter(one => one !== base) : []) {
      await git($, root, ['fetch', 'origin', other], 120_000)
      // A back-sync can be one clean merge and nothing else: every commit it brings is on the other base.
      const left = await git($, root, ['rev-list', '--no-merges', `origin/${base}..HEAD`, `^origin/${other}`])
      if (left.isOk && left.out === '') return `origin/${other}`
    }
    return undefined
  }

  // ----------------------------------------------------------- the guard

  /** Whether a PR to a gated base may be opened now; a refusal starts the gate. */
  const judge = async ($: Engine, pr: PrCreate & { head?: string }): Promise<string | undefined> => {
    const base = pr.base ?? config.bases[0] ?? 'dev'
    if (!config.bases.includes(base)) return undefined
    const top = await git($, pr.cwd, ['rev-parse', '--show-toplevel'])
    if (!top.isOk) return undefined
    const root = top.out
    if (pr.repo !== undefined) {
      const origin = await git($, root, ['remote', 'get-url', 'origin'])
      if (origin.isOk && slugOf(origin.out) !== slugOf(pr.repo)) return undefined
    }
    const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
    // A PR from a branch that is not checked out here (a release PR, dev into main) is not this gate's to review.
    if (pr.head !== undefined && pr.head.replace(/^[^:]+:/, '') !== branch) return undefined
    // A promotion between gated bases (dev into main) carries only what was gated on its way in.
    if (config.bases.includes(branch)) return undefined
    const head = (await git($, root, ['rev-parse', 'HEAD'])).out
    const key = storeKey(root, branch)
    const covers = (record: PassRecord | undefined | null): record is PassRecord =>
      !!record && (record.base === base || record.base === '*') && opensPr(record.status, config)
    const record = (await $.store.get(key)) as PassRecord | undefined | null
    if (covers(record) && record.sha === head) return undefined
    if (covers(record)) {
      // Commits since the gate finished: docs alone (a CHANGELOG line) ride on its verdict; code does not.
      const since = await git($, root, ['diff', '--numstat', record.sha, 'HEAD'])
      const files = since.out === '' ? [] : since.out.split('\n').map(line => line.split('\t')[2] ?? '')
      if (since.isOk && files.length > 0 && classify(files, 0, config.highRisk).tier === 'trivial') {
        await $.store.set(key, { ...record, sha: head })
        return undefined
      }
    }
    const started = await startGate($, { base, cwd: root, isHeldCall: true })
    // A change Codex is not needed for passes at once: the held call goes straight through.
    const now = (await $.store.get(key)) as PassRecord | undefined | null
    if (covers(now) && now.sha === head) return undefined
    return [
      `codex-gate: a pull request to ${base} waits for the pre-PR Codex gate to finish for ${branch} at ${head.slice(0, 7)}.`,
      started,
      'Do not retry this command and do not open the pull request another way. End your turn: the gate reviews the branch, sends back any findings to fix, and prompts you to open the pull request when it is done.',
      `(The person can type /${COMMAND} status, or /${COMMAND} waive <reason> to open it without the gate.)`,
    ].join('\n')
  }

  const markOpened = async ($: Engine): Promise<void> => {
    await update($, runAtom, run =>
      run === null || run === undefined
        ? null
        : { ...run, steps: run.steps.map(step => (step.id === 'pr' ? { ...step, state: 'done' as const, detail: 'opened' } : step)) },
    )
  }

export const register: Register = (on, options) => {
  config = configOf(options)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pr = config.enforce ? readPrCreate(e.command) : undefined
    if (pr === undefined) return next(e)
    const head = e.command.match(/(?:^|\s)(?:--head|-H)(?:=|\s+)["']?([^\s"']+)/)?.[1]
    const refusal = await judge($, { ...pr, head })
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await markOpened($)
    return ran
  }).catch(($, e, next) =>
    next.called || readPrCreate(e.command) === undefined
      ? next(e)
      : { deny: `codex-gate: its guard failed, so this pull request is held. The person can type /${COMMAND} waive <reason>.` },
  )

  on('tool.call', { tool: GITHUB_CREATE_PR }, async ($, e, next) => {
    if (!config.enforce) return next(e)
    const input = e as unknown as Record<string, unknown>
    const refusal = await judge($, {
      base: typeof input.base === 'string' ? input.base : undefined,
      head: typeof input.head === 'string' ? input.head : undefined,
      repo: typeof input.owner === 'string' && typeof input.repo === 'string' ? `${input.owner}/${input.repo}` : undefined,
      cwd: undefined,
    })
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await markOpened($)
    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `codex-gate: its guard failed, so this pull request is held. The person can type /${COMMAND} waive <reason>.` },
  )

  // -------------------------------------------- the line that changes in place

  on('tool.call', ($, e, next) => {
    if (isLive) {
      void (async () => {
        const run = await getRun($)
        if (run === null || run.status !== 'running') {
          isLive = false
          return
        }
        const who = run.pending.find(one =>
          one.isMain === true ? e.agentId === undefined && one.isArmed === true : one.agentId !== undefined && one.agentId === e.agentId,
        )
        if (who === undefined) return
        const activity = activityOf(who.role, String(e.tool), e as unknown as Record<string, unknown>)
        if (activity !== run.activity) await patch($, run.id, one => ({ ...one, activity }))
      })().catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isLive) {
      try {
        await onAnswer($, e.agentId, e.answer, e.reason)
      } catch (error) {
        const run = await getRun($)
        if (run !== null && run.status === 'running') {
          await finish($, run.id, 'error', `The gate itself failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
        }
      }
    }
    return done
  })

  // --------------------------------------------------- command and session

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-gate',
      description: 'Run the pre-PR Codex review gate on this branch (start, status, stop, waive)',
      argumentHint: '[base] | status | stop | waive <reason>',
      immediate: true,
    })
    const run = await getRun($)
    if (run !== null && run.status === 'running') {
      // A reload dropped the module's timer, not the run: the host kept it.
      startTicker($)
      void $.ui.open({ id: PANE, title: 'Codex gate' }).catch(() => undefined)
    } else {
      isLive = false
    }
    return next(e)
  })

  on('command.run', { command: 'pr-gate' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const run = await getRun($)
    if (verb === 'status') {
      // Says where the pane stands too: a surface that places no panes gives its reason here.
      const pane = await $.ui
        .open({ id: PANE, title: 'Codex gate' })
        .then(opened => (opened.isPlaced ? ' The pane is open.' : ` The pane is not drawn here: ${opened.reason}`))
        .catch(() => ' The pane could not be opened.')
      if (run === null) return { text: `codex-gate has not run in this session.${pane}` }
      const open = run.findings.filter(one => one.round === run.round && isBlocking(one) && one.status === 'open').length
      return {
        text: `codex-gate ${run.status} for ${run.branch} → ${run.base}: round ${run.round}${run.advisoryRound > 0 ? ` (advisory ${run.advisoryRound}/${run.advisoryMax})` : ''}, codex at ${run.effort}, ${run.findings.length} findings raised, ${open} high/critical open.${run.message === undefined ? '' : ` ${run.message}`}${pane}`,
      }
    }
    if (verb === 'stop') {
      if (run === null || run.status !== 'running') return { text: 'codex-gate is not running.' }
      await finish($, run.id, 'stopped', 'Stopped by the person.')
      return { text: 'codex-gate stopped. Pull requests to a gated base stay held until it passes or is waived.' }
    }
    if (verb === 'waive') {
      const reason = rest.join(' ').trim()
      // A waiver is the person's alone: an agent's or a plugin's command run never grants one.
      if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: 'Only the person can waive the gate.' }
      if (reason === '') return { text: `Give a reason: /${COMMAND} waive <reason>` }
      if (run !== null && run.status === 'running') await finish($, run.id, 'waived', `Waived: ${reason}`)
      const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
      if (!top.isOk) return { text: 'Not a git repository.' }
      const branch = (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
      const head = (await git($, top.out, ['rev-parse', 'HEAD'])).out
      const now = await $.clock.now()
      // A waiver covers this commit for every gated base.
      const record: PassRecord = { sha: head, base: '*', status: 'waived', at: now, rounds: run?.round ?? 0, note: reason }
      await $.store.set(storeKey(top.out, branch), record)
      return { text: `codex-gate waived for ${branch} at ${head.slice(0, 7)}: ${reason}. A new commit needs a new gate or waiver.` }
    }
    const base = verb === '' || verb === 'start' ? rest[0] : verb
    return { text: `codex-gate: ${await startGate($, { base })}` }
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const run = await read($, runAtom)
    const now = await read($, tickAtom)

    if (run === null) {
      return (
        <Box flexDirection="column">
          <Text bold>Codex gate</Text>
          <Text dimColor>Not run yet. /{COMMAND} starts it; opening a PR to a gated base starts it too.</Text>
        </Box>
      )
    }

    const isRunning = run.status === 'running'
    const frame = SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '⠋'
    const waiting = run.pending.filter(one => one.answer === undefined).length
    const headline =
      run.phase === 'review'
        ? `codex round ${run.round}`
        : run.phase === 'fix'
          ? run.fixKind === 'advisory'
            ? `addressing advisories ${run.advisoryRound}/${run.advisoryMax}`
            : `fixing round ${run.round}`
          : run.phase === 'verify'
            ? `reviewing the fix, round ${run.round}`
            : 'sizing the change'
    const mark = (step: Step): string =>
      step.state === 'done' ? '✔' : step.state === 'failed' ? '✖' : step.state === 'skipped' ? '–' : step.state === 'running' ? (isRunning ? frame : '◐') : '○'
    const current = run.findings.filter(one => one.round === run.round)
    const earlier = run.findings.filter(one => one.round !== run.round)
    const room = Math.max(4, (e.viewport?.rows ?? 30) - run.steps.length - 12)
    const shown = [...current, ...earlier].slice(0, room)
    const hidden = run.findings.length - shown.length
    const statusColor = run.status === 'passed' ? 'success' : run.status === 'running' ? 'claude' : run.status === 'waived' ? 'warning' : 'error'

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {run.branch} → {run.base}
        </Text>
        <Text dimColor wrap="truncate-end">
          round {run.round}
          {run.advisoryRound > 0 ? ` · advisory ${run.advisoryRound}/${run.advisoryMax}` : ` of ${run.maxRounds}`} · {run.tier} blast radius{run.lane === 'light' ? ' · light lane' : ''} · codex {run.effort} · {elapsed((run.endedAt ?? now) - run.startedAt)}
        </Text>

        <Box marginTop={1} flexDirection="column">
          {isRunning ? (
            <Text color="claude" wrap="truncate-end">
              {frame} in progress: {headline}
              {waiting > 0 ? ` · waiting on ${waiting} agent${waiting === 1 ? '' : 's'}` : ''} · {elapsed(now - run.phaseStartedAt)}
            </Text>
          ) : (
            <Text color={statusColor} bold wrap="truncate-end">
              {run.status.toUpperCase()}
            </Text>
          )}
          {isRunning && run.activity !== '' && (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {run.activity}
            </Text>
          )}
          {!isRunning && run.message !== undefined && <Text wrap="wrap">{run.message}</Text>}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>To do</Text>
          {run.steps.map(step => (
            <Text
              key={`step-${step.id}`}
              wrap="truncate-end"
              dimColor={step.state === 'pending' || step.state === 'skipped'}
              color={step.state === 'failed' ? 'error' : step.state === 'running' ? 'claude' : undefined}
            >
              {mark(step)} {step.label}
              {step.detail === undefined ? '' : ` — ${step.detail}`}
            </Text>
          ))}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>
            Codex findings ({run.findings.length}
            {current.some(isBlocking) ? `, ${current.filter(one => isBlocking(one) && one.status === 'open').length} blocking open` : ''})
          </Text>
          {run.findings.length === 0 && <Text dimColor>None yet.</Text>}
          {shown.map(one => (
            <Text
              key={`finding-${one.id}`}
              wrap="truncate-end"
              dimColor={one.round !== run.round || !isBlocking(one)}
              color={one.round === run.round && isBlocking(one) && one.status === 'open' ? 'error' : undefined}
              strikethrough={one.status === 'fixed'}
            >
              {one.status === 'fixed' ? '✔' : one.status === 'rebutted' ? '↩' : one.status === 'deferred' ? '⏸' : isBlocking(one) ? '●' : '·'} {one.id} [
              {one.severity}] {one.title}
              {one.file === undefined ? '' : ` (${one.file}${one.line === undefined ? '' : `:${one.line}`})`}
              {one.status === 'open' ? '' : ` — ${one.status}`}
            </Text>
          ))}
          {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
        </Box>

        {isRunning && (
          <Box marginTop={1}>
            <Button key="stop" label="Stop the gate" onPress={() => void finish($, run.id, 'stopped', 'Stopped by the person.')} />
          </Box>
        )}
      </Box>
    )
  })
}
