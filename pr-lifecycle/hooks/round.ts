// pr-lifecycle's rounds: each step is an agent, and its `turn.complete` moves the
// round on. A round that ends goes into the lifecycle record, and the controller
// (`advance`) chooses what comes next from the record alone. Nothing here waits
// on a step inside one dispatch. `advance` lives here, not in register.tsx: the
// engine follows `$` across files only into function declarations it can see.

import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Effort, Evidence, Finding, LifecycleRecord, Pending, RanModels, Role, RoundRecord, Run, RunStatus, Step, Waiver } from '../types'
import {
  compileRisk,
  fixPrompt,
  lowerOf,
  heldPrompt,
  isModelId,
  prPrompt,
  readDispositions,
  readReview,
  readTrailer,
  readTriage,
  readCheck,
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
  changedLines,
  checksOwed,
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
import { archiveRecord, isHeldByOther, loadRecord, lockRecord, logEvent, ownerOf, saveRecord, setOwner, updateRecord } from './store'

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
  /** Effort for a standard change (reviewEffort). */
  effort: Effort
  /** Effort for a light-lane (chore/) branch that is not high blast radius. */
  lightEffort: Effort
  /** Effort a high blast-radius change starts at (R69). */
  highEffort: Effort
  /** Effort of every Codex dispatch after a lifecycle's first review round, never above the tier's own start (R69). */
  rereviewEffort: Effort
  light: RegExp | undefined
  /** The Claude model of the sub-agents that run Codex (R68); undefined inherits the session's model. */
  runnerModel: string | undefined
  /** The Claude model of the fix sub-agent and the fix reviewer (R68); undefined inherits the session's model. */
  fixAgentModel: string | undefined
  /** The Codex model for standard and light-lane changes (R69); undefined names none, so gstack's own order picks it. */
  codexModel: string | undefined
  /** The Codex model for high blast-radius changes (R69); undefined names none. */
  codexModelHigh: string | undefined
  /** Plugin options whose value was invalid, each with why: the default applies to them. */
  badOptions: string[]
}

const isEffort = (value: unknown): value is Effort => value === 'high' || value === 'medium' || value === 'low'

const effortOf = (value: unknown, fallback: Effort): Effort => (isEffort(value) ? value : fallback)

/** What the plugin and a repository's file default each model to. One place, so a model rename is one change. */
export const MODELS = { runnerModel: 'sonnet', fixAgentModel: 'opus', codexModel: 'gpt-6-luna', codexModelHigh: 'gpt-6-astra' } as const

type ModelKey = keyof typeof MODELS

/** A model setting: { model } when valid (undefined for an empty string, which names none), undefined when invalid. */
const modelOf = (value: unknown): { model: string | undefined } | undefined => {
  if (typeof value !== 'string') return undefined
  const said = value.trim()
  if (said === '') return { model: undefined }
  return isModelId(said) ? { model: said } : undefined
}

/** The most rounds an allowance may be set to, by the options or by a repository's file. */
const CAPS = { standard: 10, high: 12, light: 10 } as const

/** A whole count of at least 1, or undefined. */
const countOf = (value: unknown): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

export function configOf(options: PluginOptions): Config {
  const number = (key: string, fallback: number): number => countOf(options[key]) ?? fallback
  const badOptions: string[] = []
  // Unset is the default; an empty string names no model; anything else invalid is the default, and reported.
  const model = (key: ModelKey): string | undefined => {
    if (options[key] === undefined) return MODELS[key]
    const read = modelOf(options[key])
    if (read !== undefined) return read.model
    badOptions.push(`${key} (not a model id)`)
    return MODELS[key]
  }
  const effort = (key: string, fallback: Effort): Effort => {
    if (options[key] !== undefined && !isEffort(options[key])) badOptions.push(`${key} (not low, medium or high)`)
    return effortOf(options[key], fallback)
  }
  const bases = String(options.bases ?? 'dev,main')
    .split(',')
    .map(one => one.trim())
    .filter(one => one !== '')
  return {
    // 0.3.1's maxRounds is read when allowanceStandard is unset (a hand-written options file).
    allowances: {
      standard: Math.min(number('allowanceStandard', number('maxRounds', 4)), CAPS.standard),
      high: Math.min(number('allowanceHigh', 6), CAPS.high),
      light: Math.min(number('allowanceLight', 3), CAPS.light),
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
    effort: effort('reviewEffort', 'medium'),
    lightEffort: effort('lightEffort', 'low'),
    highEffort: effort('highEffort', 'medium'),
    rereviewEffort: effort('rereviewEffort', 'low'),
    light: compileRisk(String(options.lightBranches ?? '^chore/')),
    runnerModel: model('runnerModel'),
    fixAgentModel: model('fixAgentModel'),
    codexModel: model('codexModel'),
    codexModelHigh: model('codexModelHigh'),
    badOptions,
  }
}

/** What the plugin options got wrong, said where the person sees it, as R67 says a repository file's. */
export const badOptionsNote = (bad: readonly string[]): string => `Plugin options: ignored ${bad.join(', ')}; the defaults apply instead.`

/**
 * A repository's own round settings over the plugin options (R67): `.github/pr-gate.json` on the base may set allowanceStandard,
 * allowanceHigh, allowanceLight, lightBranches, onExhausted and highRiskPaths, and the models and efforts (R68, R69), each read as configOf reads
 * the option. A key whose value is invalid is left to the option and named in `ignored`; an empty regular expression turns its
 * match off, and an empty model names none, as the option does.
 */
export function overrideConfig(c: Config, text: string | undefined): { config: Config; ignored: string[] } {
  if (text === undefined || text.trim() === '') return { config: c, ignored: [] }
  let row: unknown
  try {
    row = JSON.parse(text)
  } catch {
    return { config: c, ignored: ['the file (not valid JSON)'] }
  }
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return { config: c, ignored: ['the file (not a JSON object)'] }
  const r = row as Record<string, unknown>
  const ignored: string[] = []
  const bad = (key: string, why: string): undefined => {
    ignored.push(`${key} (${why})`)
    return undefined
  }
  const count = (key: 'allowanceStandard' | 'allowanceHigh' | 'allowanceLight', cap: number): number | undefined => {
    const value = r[key]
    if (value === undefined) return undefined
    const n = typeof value === 'number' || typeof value === 'string' ? countOf(value) : undefined
    return n === undefined ? bad(key, 'not a number of at least 1') : Math.min(n, cap)
  }
  // Set or not, and what to: an empty string sets "no match", which compileRisk alone cannot tell from an invalid pattern.
  const pattern = (key: 'lightBranches' | 'highRiskPaths'): { re: RegExp | undefined } | undefined => {
    const value = r[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') return bad(key, 'not a string')
    if (value.trim() === '') return { re: undefined }
    const re = compileRisk(value)
    return re === undefined ? bad(key, 'not a valid regular expression') : { re }
  }
  const standard = count('allowanceStandard', CAPS.standard)
  const high = count('allowanceHigh', CAPS.high)
  const lightRounds = count('allowanceLight', CAPS.light)
  const light = pattern('lightBranches')
  const onExhausted =
    r.onExhausted === undefined || r.onExhausted === 'open-pr' || r.onExhausted === 'stop' ? r.onExhausted : bad('onExhausted', 'not open-pr or stop')
  const highRisk = pattern('highRiskPaths')
  // Set or not, and to what: an empty string sets "no model", which undefined alone cannot tell from unset.
  const model = (key: ModelKey): { model: string | undefined } | undefined =>
    r[key] === undefined ? undefined : (modelOf(r[key]) ?? bad(key, 'not a model id'))
  const models = {
    runnerModel: model('runnerModel'),
    fixAgentModel: model('fixAgentModel'),
    codexModel: model('codexModel'),
    codexModelHigh: model('codexModelHigh'),
  }
  const effort = (key: string): Effort | undefined => {
    const value = r[key]
    return value === undefined ? undefined : isEffort(value) ? value : bad(key, 'not low, medium or high')
  }
  const efforts = { effort: effort('reviewEffort'), lightEffort: effort('lightEffort'), highEffort: effort('highEffort'), rereviewEffort: effort('rereviewEffort') }
  // The collection waits are the roster's to read (readRoster drops a bad one); they are reported here with the rest.
  for (const key of ['quietMinutes', 'waitCapMinutes']) {
    const value = r[key]
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 1)) bad(key, 'not a number of minutes of at least 1')
  }
  return {
    config: {
      ...c,
      allowances: { standard: standard ?? c.allowances.standard, high: high ?? c.allowances.high, light: lightRounds ?? c.allowances.light },
      onExhausted: onExhausted ?? c.onExhausted,
      highRisk: highRisk === undefined ? c.highRisk : highRisk.re,
      light: light === undefined ? c.light : light.re,
      effort: efforts.effort ?? c.effort,
      lightEffort: efforts.lightEffort ?? c.lightEffort,
      highEffort: efforts.highEffort ?? c.highEffort,
      rereviewEffort: efforts.rereviewEffort ?? c.rereviewEffort,
      runnerModel: models.runnerModel === undefined ? c.runnerModel : models.runnerModel.model,
      fixAgentModel: models.fixAgentModel === undefined ? c.fixAgentModel : models.fixAgentModel.model,
      codexModel: models.codexModel === undefined ? c.codexModel : models.codexModel.model,
      codexModelHigh: models.codexModelHigh === undefined ? c.codexModelHigh : models.codexModelHigh.model,
    },
    ignored,
  }
}

/** What a repository's file got wrong, said once where the person sees it (R67). */
export const ignoredNote = (base: string, ignored: readonly string[]): string =>
  `The base's .github/pr-gate.json (origin/${base}): ignored ${ignored.join(', ')}; the plugin options apply instead.`

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

// This session (#13): its id, read once, and whether a person is at its prompt (session.start says; a reload keeps the default).
let me: string | undefined
let isInteractive = true
// When this session last beat for its run's record; 0 makes the next tick claim it.
let beatAt = 0
const BEAT_MS = 30_000

export function setSession(interactive: boolean): void {
  isInteractive = interactive
  me = undefined
}

export async function sessionIdOf($: Engine): Promise<string> {
  me ??= await $.session.id()
  return me
}

/**
 * Makes this session the record's owner (#13): a run it starts or a person's command takes the record. A headless session
 * (`-p`, the SDK) never takes one another session holds; false then.
 */
export async function claimRecord($: Engine, root: string, branch: string): Promise<boolean> {
  const now = await $.clock.now()
  const id = await sessionIdOf($)
  const before = await ownerOf($, root, branch)
  if (!isInteractive && isHeldByOther(before, id, now)) return false
  await setOwner($, root, branch, { sessionId: id, beatAt: now })
  beatAt = now
  if (before !== undefined && before.sessionId !== id) {
    await logEvent($, root, branch, 'session', `session ${id.slice(0, 8)} took the record over from ${before.sessionId.slice(0, 8)}`)
  }
  return true
}

/** Whether another session holds the record now: this one then sends its agent nothing and stands down. */
export async function isOwnedElsewhere($: Engine, root: string, branch: string): Promise<boolean> {
  return isHeldByOther(await ownerOf($, root, branch), await sessionIdOf($), await $.clock.now())
}

/** The ticker's beat, every 30 s: false when another session took the record since. */
async function beat($: Engine, run: Run, now: number): Promise<boolean> {
  if (beatAt === 0) return claimRecord($, run.root, run.branch)
  if (now - beatAt < BEAT_MS) return true
  if (await isOwnedElsewhere($, run.root, run.branch)) return false
  await setOwner($, run.root, run.branch, { sessionId: await sessionIdOf($), beatAt: now })
  beatAt = now
  return true
}

/** Another session runs this record's lifecycle: this one drops its copy of the run, unfinished, and leaves the record alone. */
async function standDown($: Engine, run: Pick<Run, 'root' | 'branch'>): Promise<void> {
  stopTicker()
  isLive = false
  await update($, runAtom, () => null)
  $.ui.status('pr-gate: another session runs this lifecycle')
  await logEvent($, run.root, run.branch, 'session', `session ${(await sessionIdOf($)).slice(0, 8)} stood down: another session runs the record`)
}

export const isLiveNow = (): boolean => isLive
export const setLive = (v: boolean): void => {
  isLive = v
}

/** The effort a branch's tier and lane call for, before any carried or timeout step-down: `c` is the base's settings (configFor). */
export const defaultEffort = (rec: Pick<LifecycleRecord, 'tier' | 'lane'>, c: Config): Effort =>
  rec.tier === 'high' ? c.highEffort : rec.lane === 'light' ? c.lightEffort : c.effort

/** The Codex model the gate names for a tier (R69); undefined names none, so gstack's own order picks it. */
export const codexModelFor = (tier: LifecycleRecord['tier'], c: Config): string | undefined => (tier === 'high' ? c.codexModelHigh : c.codexModel)

/**
 * The Claude model of a sub-agent (R68): the fixer and the pre-PR fix reviewer get fixAgentModel; the Codex runners (review,
 * challenge, and the post-PR rebuttal check) get runnerModel. Undefined inherits the session's model.
 */
export const agentModelFor = (role: Role, lifecycle: Run['lifecycle'], c: Config): string | undefined =>
  role === 'fix' || (role === 'verify' && lifecycle === 'pre') ? c.fixAgentModel : c.runnerModel

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

/**
 * Brings a clean local checkout up to the PR head (R71): a fetch, then a merge that only fast-forwards. True when HEAD is the PR
 * head after it. A dirty checkout, or one with commits the PR lacks, is left as it is: that is the person's to sort out.
 */
export async function syncToHead($: Engine, root: string, branch: string, prHead: string): Promise<boolean> {
  const local = await git($, root, ['rev-parse', 'HEAD'])
  if (!local.isOk) return false
  if (local.out === prHead) return true
  const dirty = await git($, root, ['status', '--porcelain', '--untracked-files=no'])
  if (!dirty.isOk || dirty.out !== '') return false
  if (!(await fetchTwice($, root, ['--quiet', 'origin', branch], 60_000)).isOk) return false
  if (!(await git($, root, ['merge-base', '--is-ancestor', local.out, prHead])).isOk) return false
  if (!(await git($, root, ['merge', '--ff-only', '--quiet', prHead], 60_000)).isOk) return false
  const after = await git($, root, ['rev-parse', 'HEAD'])
  if (!after.isOk || after.out !== prHead) return false
  await logEvent($, root, branch, 'head', `caught the checkout up from ${local.out.slice(0, 7)} to the PR head ${prHead.slice(0, 7)}`)
  return true
}

/** gh can report the PR head from before a push that just landed (R71): origin's branch is the truth when it is the local HEAD. */
export async function isPushed($: Engine, root: string, branch: string, local: string): Promise<boolean> {
  const remote = await git($, root, ['ls-remote', 'origin', `refs/heads/${branch}`])
  return remote.isOk && remote.out.split(/\s/)[0] === local
}

/** Who wrote the local commits no origin branch has, for a stop that names them (R71): "abc1234 by Ann, def5678 by Bob". */
export async function unpushedBy($: Engine, root: string): Promise<string> {
  const log = await git($, root, ['log', '--format=%h by %an', 'HEAD', '--not', '--remotes=origin'])
  const lines = log.isOk ? log.out.split('\n').filter(Boolean) : []
  return lines.length === 0 ? '' : ` (${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', ...' : ''})`
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
 * The head moved from `from` to `to` (R56): each answered finding a change came near needs a re-check (`invalidate`, R73), and each
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
  // Only a change near a finding reopens it (R73); git failing reopens everything.
  const diff = from === undefined ? undefined : await git($, root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', from, to], 60_000)
  const lines = diff?.isOk === true ? changedLines(diff.out) : ('all' as const)
  const findings = invalidate(rec.findings, lines)
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
  // The first tick claims the record for this session (#13).
  beatAt = 0
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const now = await $.clock.now()
      const run = await getRun($)
      if (run === null || run.status !== 'running') {
        stopTicker()
        isLive = false
        return
      }
      if (!(await beat($, run, now))) {
        await standDown($, run)
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
  const isDone = status === 'passed' || status === 'waived'
  await logEvent($, ended.root, ended.branch, isDone ? 'end' : 'stop', `${ended.lifecycle}-PR round ${ended.round} ${status}: ${message}`)
  // A review that completed below the branch's default sets where the next run starts; a run that never completed one keeps the last.
  const hasReviewed = status === 'passed' || status === 'exhausted' || status === 'blocked'
  // What carries is the start lowered by timeouts, never a re-review's own capped effort.
  const carries = ended.carriedEffort ?? ended.effort
  await updateRecord($, ended.root, ended.branch, rec => {
    const passedEffort = hasReviewed ? carries : rec.passedEffort
    const start = ended.startEffort ?? 'high'
    const isBelow = passedEffort !== undefined && passedEffort !== start && lowerOf(passedEffort, start) === passedEffort
    return {
      ...rec,
      effort: carries,
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
  // The base's own setting, if it has one (R67, R68); no model inherits the session's.
  const model = agentModelFor(role, run.lifecycle, (await configFor($, run.root, run.base)).config)
  const started = await $.agent.spawn({
    prompt,
    description: `pr-lifecycle r${run.round} ${role}`,
    subagentType: 'general-purpose',
    cwd: run.root,
    ...(model === undefined ? {} : { model }),
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
  // Another session runs this record (#13): this one sends its agent nothing.
  if (await isOwnedElsewhere($, opened.root, opened.branch)) {
    await standDown($, opened)
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
    const roster = await rosterOf($, opened.root, opened.base)
    for (const who of roster?.requestReview ?? []) {
      await $.process.run(['gh', 'api', '-X', 'POST', `repos/${rec.slug}/pulls/${rec.pr}/requested_reviewers`, '-f', `reviewers[]=${who}`], {
        cwd: opened.root,
        timeoutMs: 30_000,
      })
    }
  }
  $.ui.status(`pr-gate r${opened.round}: waiting on reviewers`)
}

/**
 * `.github/pr-gate.json` as the base has it (R67, `refs/remotes/origin/<base>`), never as the branch's own HEAD has it: a PR must not
 * loosen its own gate, add a bot to the trusted roster (R1-8) or lower its allowance. Read from the ref the last fetch left, with no
 * fetch of its own; a base with no such file, or no fetched ref, has none.
 */
async function baseFileOf($: Engine, root: string, base: string): Promise<string | undefined> {
  if (base === '') return undefined
  // The remote-tracking ref by its full name (M4): a local tag or branch called origin/<base> would win over a bare origin/<base>.
  const file = await git($, root, ['show', `refs/remotes/origin/${base}:.github/pr-gate.json`])
  return file.isOk ? file.out : undefined
}

/** The round settings for a branch to `base` (R67): the base's file over the plugin options, over the defaults. */
export async function configFor($: Engine, root: string, base: string): Promise<{ config: Config; ignored: string[] }> {
  return overrideConfig(config, await baseFileOf($, root, base))
}

async function rosterOf($: Engine, root: string, base: string): Promise<Roster | undefined> {
  const file = await baseFileOf($, root, base)
  return file === undefined ? undefined : readRoster(file)
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
    const roster = await rosterOf($, rec.root, rec.base)
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
  const roster = await rosterOf($, run.root, run.base)
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
  const roster = await rosterOf($, run.root, run.base)
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
  // A fix only reported no longer calls for a full Codex review: the round's own Codex check verifies it (R72).
  if (run.roundKind === 'final-head-check' || (!isCovered && !isPassThroughRound1)) {
    // Codex reads the local checkout: it must be the PR head, or it would review something else.
    // A clean checkout behind the PR head (a reviewer's or a bot's push) catches up on its own (R71).
    const isSynced = await syncToHead($, run.root, run.branch, got.prHead)
    const local = await git($, run.root, ['rev-parse', 'HEAD'])
    if (!isSynced || !local.isOk || local.out !== got.prHead) {
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
  // Another session runs this record (#13): this one sends its agent nothing.
  const run = await getRun($)
  if (run !== null && run.id === id && (await isOwnedElsewhere($, run.root, run.branch))) {
    await standDown($, run)
    return
  }
  void $.prompt
    .submit({ text })
    .then(async entered => {
      if ('drop' in entered && typeof entered.drop === 'string') {
        await finish($, id, 'error', `The reviews could not be sent to the main agent: ${entered.drop}`)
      }
    })
    .catch(() => undefined)
}

/** What Codex checks at the end of a post-PR round, on the head the round ends on (`checksOwed`; R36, R58, R72). */
const rebuttalsOwed = (run: Run): Finding[] => checksOwed(run.findings)

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
  // gh may not have seen a push that just landed: origin's branch at the local HEAD is the PR head (R71).
  if (prHead !== local.out && (await isPushed($, run.root, run.branch, local.out))) {
    await logEvent($, run.root, run.branch, 'head', `gh still reported ${prHead.slice(0, 7)}; origin has the push ${local.out.slice(0, 7)}`)
    prHead = local.out
  } else if (prHead !== local.out) {
    // Someone pushed during the answer: fetch the PR head, so the ancestry check and the unpushed list read it (R71). A failed fetch
    // leaves the check to fail closed.
    await fetchTwice($, run.root, ['--quiet', 'origin', run.branch], 60_000)
  }
  const isContained = prHead === local.out || (await git($, run.root, ['merge-base', '--is-ancestor', local.out, prHead])).isOk
  if (!isContained) {
    const by = await unpushedBy($, run.root)
    await failPost($, after, `commits on ${run.branch} are not on the PR${by}: pull or push, then /pr-gate resume`)
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
  // Codex checks the fixes and rebuttals on the head the round ends on (R72): a reported fix is about that head, and syncToHead
  // brings a clean checkout to it. No round is spent, and no full Codex review is needed only to verify a fix.
  const rebuttals = rebuttalsOwed(ended)
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
  // A clean checkout behind the PR head catches up on its own (R71).
  if (!(await syncToHead($, run.root, run.branch, run.headSha))) {
    await failPost($, run, `the local checkout is not the PR head ${run.headSha.slice(0, 7)}: pull, then /pr-gate resume`)
    return
  }
  // Once Codex has looked at the branch, the check is a re-review (R69): rereviewEffort, never above where the round started. Its
  // first look in the lifecycle starts at the tier's effort (M2), as a round would.
  const c = (await configFor($, run.root, run.base)).config
  const rec = await loadRecord($, run.root, run.branch)
  const isRereview = (rec !== undefined && hasCodexLooked(rec)) || run.evidence.some(one => one.source === 'codex')
  const opened = await patch($, run.id, one => ({
    ...one,
    effort: isRereview ? lowerOf(one.carriedEffort ?? one.effort, c.rereviewEffort) : (one.carriedEffort ?? one.effort),
    carriedEffort: one.carriedEffort ?? one.effort,
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
  const fixes = checked.filter(one => isReverifyOwed(one) || one.status === 'reported-fixed').length
  const what = fixes === 0 ? 'checks the rebuttals' : fixes === checked.length ? 'verifies the fixes' : 'checks the rebuttals and fixes'
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
  // Codex is the judge (R69): an unusable model, or another than the one named, rules on nothing.
  const said = readCheck(answer)
  const named = run.codexModel
  const marked =
    said.model === undefined ? run : ((await patch($, run.id, one => ({ ...one, ranModels: { ...one.ranModels, verify: said.model } }))) ?? run)
  if (said.failure === 'model') {
    await noteAttempt($, marked, `Codex could not use its model in the rebuttal check: ${said.note ?? 'no repair message'}`)
    await finish($, run.id, 'error', await unusableModel($, marked, said.note))
    return
  }
  if (named !== undefined && said.model !== undefined && said.model !== named) {
    await noteAttempt($, marked, `Codex rebuttal check ran ${said.model}, not ${named}`)
    await finish($, run.id, 'error', await strayModel($, marked, 'rebuttal check', said.model, named))
    return
  }
  const verdicts = readVerdicts(answer)
  // Fail closed: no readable verdict at all is no check. Fixes only reported stay owed, for the next check to rule on (R72): only a
  // rebuttal or a re-verification, which has no other path, holds the lifecycle for it.
  const mustRule = run.findings.filter(f => (run.rechecks ?? []).includes(f.id) && f.status !== 'reported-fixed')
  if (verdicts.size === 0 && mustRule.length === 0) {
    // Once more at once (R72): an owed fix left after the check would cost a whole round.
    const owed = checksOwed(run.findings).filter(f => (run.rechecks ?? []).includes(f.id))
    if (run.hasRetriedCheck !== true && owed.length > 0) {
      const again = await patch($, run.id, one => ({ ...one, hasRetriedCheck: true }))
      if (again !== null) await checkRebuttals($, again, owed)
      return
    }
    await noteAttempt($, run, 'Codex gave no readable verdict on the reported fixes, twice; they stay owed')
    await endRound($, run, true)
    return
  }
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
      // A fix only reported (R72): confirmed, it is verified; refuted, it is open again, with Codex's reason for the agent.
      if (f.status === 'reported-fixed') {
        return verdict.holds
          ? markVerified(f, one.round, 'codex', now, 'Codex: the fix holds')
          : markHeld(f, one.round, 'codex', now, verdict.note ?? 'Codex: the fix does not hold')
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
    // The effort that timed out is the carry, not a higher start a re-review ran under: the next run starts no higher than it.
    await patch($, run.id, one => ({ ...one, carriedEffort: lowerOf(one.carriedEffort ?? one.effort, run.effort) }))
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
      // A timeout at an effort means the branch cannot finish there either: the carry steps down with it.
      carriedEffort: lowerOf(one.carriedEffort ?? one.effort, lower),
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

/** Codex completed a round in this lifecycle: it records its effort, and a pre-PR round from before 1.2.0, which has none, ran Codex too. */
const hasCodexLooked = (rec: LifecycleRecord): boolean => rec.rounds.some(one => one.isCompleted && (one.effort !== undefined || one.phase === 'pre'))

/** Starts the round the controller chose, on the run in flight or a new one. */
export async function startRound($: Engine, rec: LifecycleRecord, next: Extract<Next, { kind: 'round' }>): Promise<void> {
  const now = await $.clock.now()
  const existing = await getRun($)
  const isOn = existing !== null && existing.status === 'running'
  // An attempt that did not complete is run again under its own number.
  const round = rec.rounds.length === 0 ? 1 : Math.max(...rec.rounds.map(one => one.n)) + (rec.rounds.at(-1)?.isCompleted === false ? 0 : 1)
  // A post-PR or delta review starts from the last head a reviewer read in full, never from commits nobody read (R60).
  const lastHead = lastCoveredHead(rec)
  // The base's own settings (R67): its efforts and Codex models (R69).
  const { config: c } = await configFor($, rec.root, rec.base)
  const start = defaultEffort(rec, c)
  const carried = lowerOf(rec.effort ?? start, start)
  // After the lifecycle's first completed round Codex ran in, every Codex dispatch is a re-review: rereviewEffort, never above the
  // tier's start. A round Codex ran in records its effort; a pre-PR round from before 1.2.0 has none, but Codex ran in every one.
  const isRereview = hasCodexLooked(rec)
  const codexModel = codexModelFor(rec.tier, c)
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
    effort: isRereview ? lowerOf(carried, c.rereviewEffort) : carried,
    carriedEffort: carried,
    startEffort: start,
    ...(codexModel === undefined ? {} : { codexModel }),
    round,
    status: 'running',
    phase: 'scope',
    hasRefixed: false,
    hasReprompted: false,
    hasRetriedCheck: false,
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
  const run = answerRun(rec, ids, now, (await configFor($, rec.root, rec.base)).config)
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
    ...answerRun(rec, ids, now, (await configFor($, rec.root, rec.base)).config),
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
  const run = answerRun(rec, ids, now, (await configFor($, rec.root, rec.base)).config)
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  await checkRebuttals($, run, rec.findings.filter(one => ids.includes(one.id)))
}

/** A run on the same head that records no round: an answer to a block, or a rebuttal check (R37, R39). */
export function answerRun(rec: LifecycleRecord, ids: readonly string[], now: number, c: Config): Run {
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
    // The carried effort, never above the tier's start as the base's settings have it now (a lowered reviewEffort applies at once).
    effort: lowerOf(rec.effort ?? defaultEffort(rec, c), defaultEffort(rec, c)),
    startEffort: defaultEffort(rec, c),
    ...(codexModelFor(rec.tier, c) === undefined ? {} : { codexModel: codexModelFor(rec.tier, c) }),
    round,
    status: 'running',
    phase: 'triage',
    hasRefixed: false,
    hasReprompted: false,
    hasRetriedCheck: false,
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
    // The carry, never the check's capped effort: advance may start a round at once, before finish could restore it.
    await updateRecord($, run.root, run.branch, rec => ({
      ...rec,
      head: endHead,
      findings: mergeFindings(rec.findings, findings),
      effort: run.carriedEffort ?? run.effort,
    }))
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
    ...codexOf(run),
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
      effort: run.carriedEffort ?? run.effort,
    }
  })
  if (isCompleted) await advance($, run.root, run.branch)
}

/** The effort and Codex model a round ran at (R69), when Codex ran in it: what the reviewers reported, else what the gate named. */
const codexOf = (run: Run): Pick<RoundRecord, 'effort' | 'codexModel' | 'ranModels'> => {
  const ran = run.ranModels ?? {}
  if (run.phase !== 'review' && !run.evidence.some(one => one.source === 'codex') && Object.keys(ran).length === 0) return {}
  const model = ran.review ?? Object.values(ran)[0] ?? run.codexModel
  return { effort: run.effort, ...(model === undefined ? {} : { codexModel: model }), ...(Object.keys(ran).length === 0 ? {} : { ranModels: ran }) }
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
        ...codexOf(run),
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
  // Each write checks its decision again on the read taken under the record's lock (F5); a record changed since this read is
  // decided afresh instead of written from a stale decision.
  const isStill = (one: LifecycleRecord): boolean => JSON.stringify(decideNext(one)) === JSON.stringify(next)
  let isStale = false
  const ifStill = (write: (one: LifecycleRecord) => LifecycleRecord) => (one: LifecycleRecord): LifecycleRecord => {
    if (isStill(one)) return write(one)
    isStale = true
    return one
  }
  // A ready record the controller no longer finds ready is back in post-PR review.
  if (next.kind !== 'ready' && rec.phase === 'ready') {
    await updateRecord($, root, branch, one => (one.phase === 'ready' && decideNext(one).kind !== 'ready' ? { ...one, phase: 'post' } : one))
  }
  const run = await getRun($)
  const id = run !== null && run.status === 'running' ? run.id : undefined
  if (next.kind === 'round') {
    await startRound($, rec, next)
    return
  }
  if (next.kind === 'open-pr') {
    const saved = await updateRecord($, root, branch, ifStill(one => ({ ...one, preStatus: next.status, preHead: one.head })))
    if (isStale) return advance($, root, branch, isResume)
    const seen = saved ?? rec
    const hasSecurity = hasSecurityBlocker(seen)
    // The base's own setting, if it has one (R67).
    const { onExhausted } = (await configFor($, root, seen.base)).config
    const opens = next.status === 'passed' || (onExhausted === 'open-pr' && !hasSecurity)
    const used = usedRounds(seen)
    const message =
      next.status === 'passed'
        ? seen.passThrough !== undefined
          ? `Codex skipped: ${seen.passThrough}.`
          : `No high/critical finding after ${used} round${used === 1 ? '' : 's'}.`
        : `${heldFindings(seen).length} high/critical finding(s) unresolved or unverified with the allowance spent` +
          `${hasSecurity ? ', one of them security: the PR stays held' : ''}.`
    const ended = id === undefined ? null : await finish($, id, next.status, message)
    if (ended === null || saved === undefined) return
    if (!opens) {
      // The round that just ended leaves the PR held: say so once, with why and what can move it.
      const held = heldReason(saved, onExhausted)
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
    const saved = await updateRecord($, root, branch, ifStill(one => ({ ...one, phase: 'ready', postStatus: undefined, message: undefined })))
    if (isStale) return advance($, root, branch, isResume)
    const at = (saved ?? rec).head.slice(0, 7)
    if (id !== undefined) await finish($, id, 'passed', `Lifecycle review complete at ${at}: ready for the merge decision.`)
    else if (saved !== undefined) await logEvent($, root, branch, 'end', `ready for the merge decision at ${at}`)
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
  const saved = await updateRecord(
    $,
    root,
    branch,
    ifStill(one => (isPre ? { ...one, preStatus: runStatus, preHead: one.head, message: next.why } : { ...one, postStatus: next.kind, message: next.why })),
  )
  if (isStale) return advance($, root, branch, isResume)
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

/**
 * Why the pre-PR gate holds the PR, and the next step; undefined when it does not hold it for a settled reason. `onExhausted` is the
 * effective setting for the record's base (configFor, R67).
 */
export function heldReason(rec: LifecycleRecord, onExhausted: Config['onExhausted']): { why: string; nextStep: string } | undefined {
  if (rec.preStatus === 'blocked') {
    // The controller's own next step for this block (R49): a deferral is never "fix or rebut".
    const next = decideNext(rec)
    if (next.kind === 'blocked') return { why: next.why, nextStep: next.nextStep }
    return { why: rec.message ?? 'a decision is needed', nextStep: 'run /pr-gate resume, which decides again from the record' }
  }
  if (rec.preStatus !== 'exhausted') return undefined
  const holding = heldFindings(rec)
  const isSecurity = hasSecurityBlocker(rec)
  if (!isSecurity && onExhausted === 'open-pr') return undefined
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
  // What each role ran (R69). A model failure or another model than the one named, in any role, is checked before anything of the
  // attempt is used: a timeout retry, a finding, a verified or accepted ruling. The attempt is discarded whole, as a timeout's is.
  const ran: RanModels = Object.fromEntries(results.flatMap(one => (one.result.model === undefined ? [] : [[one.role, one.result.model]])))
  const named = run.codexModel
  // An unusable model's own stop, with gstack's repair message, comes first, as in the rebuttal check.
  const unusable = results.find(one => one.result.failure === 'model')
  const stray = named === undefined ? undefined : results.find(one => one.result.model !== undefined && one.result.model !== named)
  if (unusable !== undefined || stray !== undefined) {
    const marked = (await patch($, run.id, one => ({ ...one, ...(Object.keys(ran).length === 0 ? {} : { ranModels: ran }) }))) ?? run
    if (unusable !== undefined) {
      await noteAttempt($, marked, `Codex ${unusable.role} could not use its model`)
      await finish($, run.id, 'error', await unusableModel($, marked, unusable.result.note))
    } else if (stray !== undefined && named !== undefined) {
      await noteAttempt($, marked, `Codex ${stray.role} ran ${stray.result.model ?? '?'}, not ${named}`)
      await finish($, run.id, 'error', await strayModel($, marked, stray.role, stray.result.model ?? '?', named))
    }
    return
  }
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
    ...(Object.keys(ran).length === 0 ? {} : { ranModels: ran }),
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
        // A hold names no reason in a review's trailer: say so, rather than leave the agent's own fix note to read as the open item.
        const heldNote = `Codex held it in the round ${one.round} review, without a reason`
        const ruled = isTheirs ? old : verified.has(old.id) ? confirmed : held.has(old.id) ? markHeld(old, one.round, 'codex', now, heldNote) : old
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
    // Fail closed: a review that did not complete is never a pass, and no round is spent on it. A model failure stopped above (R69).
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

/** Whether a repository's file sets `key` at all, valid or not: the stop then names the file, not the option. */
const fileSets = (file: string | undefined, key: string): boolean => {
  try {
    const row: unknown = JSON.parse(file ?? '')
    return typeof row === 'object' && row !== null && !Array.isArray(row) && (row as Record<string, unknown>)[key] !== undefined
  } catch {
    return false
  }
}

/** The setting that names a run's Codex model (R69), and where to change it: the base's file when it sets the key, else the option. */
async function modelSetting($: Engine, run: Run): Promise<{ key: string; named: string | undefined; fix: string }> {
  const key = run.tier === 'high' ? 'codexModelHigh' : 'codexModel'
  const isFile = fileSets(await baseFileOf($, run.root, run.base), key)
  const named = codexModelFor(run.tier, (await configFor($, run.root, run.base)).config)
  const fix = isFile
    ? `change ${key} in .github/pr-gate.json on origin/${run.base}`
    : named === undefined
      ? `set the plugin option ${key} to a model this account can use (or fix GSTACK_CODEX_MODEL or Codex config.toml)`
      : `change the plugin option ${key}, or set ${key} in the base's .github/pr-gate.json`
  return { key, named, fix }
}

/** gstack stopped on the Codex model (R69): what the person reads, with its repair message and the one setting that names the model. */
async function unusableModel($: Engine, run: Run, note: string | undefined): Promise<string> {
  const { named, fix } = await modelSetting($, run)
  // What the reviewer saw run, else what the gate named; gstack may have picked it itself.
  const which = Object.values(run.ranModels ?? {})[0] ?? run.codexModel ?? named ?? 'the model gstack picked'
  return (
    `Codex could not use ${which}: ${note ?? 'gstack gave no repair message'}. No other model was tried and no review round was used. ` +
    `Next: ${fix}, then run /pr-gate resume.`
  )
}

/** A reviewer ran another model than the gate named (R69): never accepted, as a silent fallback would be. */
async function strayModel($: Engine, run: Run, role: string, ran: string, named: string): Promise<string> {
  const { key, fix } = await modelSetting($, run)
  return (
    `Codex ${role} ran ${ran}, not ${named}, the model ${key} names: the gate never accepts another model, and no review round was used. ` +
    `Next: run /pr-gate resume to review on ${named} again, or ${fix}.`
  )
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
