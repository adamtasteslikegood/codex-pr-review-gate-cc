// pr-lifecycle's rounds: each step is an agent, and its `turn.complete` moves the
// round on. A round that ends goes into the lifecycle record, and the controller
// (`advance`) chooses what comes next from the record alone. Nothing here waits
// on a step inside one dispatch. `advance` lives here, not in register.tsx: the
// engine follows `$` across files only into function declarations it can see.

import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { CheckState, Effort, Evidence, Finding, LifecycleRecord, LogEntry, Pending, RanModels, Role, RoundRecord, Run, RunStatus, Severity, Standing, Step, Waiver } from '../types'
import {
  compileRisk,
  fixPrompt,
  lowerOf,
  heldPrompt,
  isModelId,
  prPrompt,
  readDispositions,
  readLinks,
  readReview,
  readTrailer,
  readTriage,
  readCheck,
  readVerdicts,
  readVerify,
  readyPrompt,
  replyIdOf,
  replyIdsOf,
  reportPrompt,
  reviewPrompt,
  stepDown,
  stepOf,
  TRAILER,
  triagePrompt,
  verifyPrompt,
} from './core'
import {
  collectionDone,
  isTrusted,
  postsFor,
  readCheckRuns,
  readInlineComments,
  readIssueComments,
  readRequested,
  readRequired,
  readReviews,
  readRoster,
  readStatuses,
  severityHint,
} from './github'
import type { Check, Feedback, Roster } from './github'
import {
  acceptRebuttal,
  answersOf,
  applyAnswer,
  applyLinks,
  decideNext,
  dropLink,
  holdText,
  lapseWaivers,
  checksOwed,
  isAcceptedRebuttal,
  isBlocking,
  isChargedRound,
  isDisputed,
  isLinkOwed,
  isLoweringOwed,
  isReverifyOwed,
  issueOf,
  lastCoveredHead,
  markHeld,
  markVerified,
  mergeFindings,
  mergeHolds,
  newRecord,
  nextIds,
  mayAcknowledge,
  peakOf,
  raisedIn,
  readDiff,
  refuseLink,
  rejections,
  relocate,
  roundOf,
  ruleLowering,
  securityHolds,
  standingOf,
  triage,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
  waivedIds,
  linkTo,
  withLinkedPeak,
  withRound,
  wouldSettle,
} from './lifecycle'
import type { Allowances, Next, TriageClass } from './lifecycle'
import { archiveRecord, isHeldByOther, LOG_CAP, loadRecord, lockRecord, logEvent, ownerOf, saveRecord, setOwner, updateRecord } from './store'

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
  required.clear()
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
 * Makes this session the record's owner (#13): a start, a resume or a person's command takes the record. A headless session
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

/**
 * The ticker's beat, on its first tick and then every 30 s: false when another session holds the record. A ticker never takes a
 * record another session holds, not even a restarted one: only a person's command, or an owner gone quiet, moves it (#13).
 */
async function beat($: Engine, run: Run, now: number): Promise<boolean> {
  if (beatAt !== 0 && now - beatAt < BEAT_MS) return true
  if (await isOwnedElsewhere($, run.root, run.branch)) return false
  return claimRecord($, run.root, run.branch)
}

/** Whether this session may act on the run's record now; when another session holds it, this one stands down (#13). */
export async function isStillMine($: Engine, run: Pick<Run, 'root' | 'branch'>): Promise<boolean> {
  if (!(await isOwnedElsewhere($, run.root, run.branch))) return true
  await standDown($, run)
  return false
}

/** Another session runs this record's lifecycle: this one drops its copy of the run, unfinished, and leaves the record alone. */
async function standDown($: Engine, run: Pick<Run, 'root' | 'branch'>): Promise<void> {
  const live = await getRun($)
  if (live === null || (live.root === run.root && live.branch === run.branch)) {
    stopTicker()
    isLive = false
    await update($, runAtom, () => null)
  }
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
// Each outermost hold is a batch: its flush sends only its own entries, and a note merges only within it (PR #19 review).
type Queued = { text: string; key: RecordKey; batch: number; isNote?: boolean }
let holdDepth = 0
let batch = 0
let queued: Queued[] = []

/** The record a prompt is about: it is sent only while this session still holds it (#13). */
export type RecordKey = Pick<Run, 'root' | 'branch'>

const sameRecord = (a: RecordKey, b: RecordKey): boolean => a.root === b.root && a.branch === b.branch

/** Submits a prompt unless another session took its record meanwhile; this one then stands down instead (#13). */
async function deliver($: Engine, key: RecordKey, text: string): Promise<void> {
  if (!(await isStillMine($, key))) return
  await $.prompt.submit({ text }).catch(() => undefined)
}

/**
 * Within one command's batch, an action's note and a prompt for the same record become one prompt: the note's first line leads it
 * (R81). What the note says holds the merge follows the prompt, so a failing check is not lost behind a ready prompt (gate R2-4);
 * only the note's own next step gives way to the prompt's.
 */
export function mergeNotes(held: readonly Queued[]): Queued[] {
  const isPair = (a: Queued, b: Queued): boolean => a.batch === b.batch && sameRecord(a.key, b.key)
  return held.flatMap(one => {
    if (one.isNote === true) return held.some(each => each.isNote !== true && isPair(each, one)) ? [] : [one]
    const note = held.find(each => each.isNote === true && isPair(each, one))
    if (note === undefined) return [one]
    const [lead = '', ...rest] = note.text.split('\n\n')
    const holds = rest.filter(part => !part.startsWith('Your next step:')).join('\n\n')
    return [{ ...one, text: [lead, one.text, ...(holds === '' ? [] : [holds])].join('\n\n') }]
  })
}

/**
 * Drops everything queued about `key`'s record and not yet sent: a stop or reset supersedes it (R81, PR #19 review). Every batch, the
 * caller's own too: a stop run while another command holds the turn shares that command's batch (gate R4-5), and stop and reset
 * call this before they queue their own note.
 */
export function dropQueued(key: RecordKey): void {
  queued = queued.filter(one => !sameRecord(one.key, key))
}

/** Runs `body` with the prompts it decides held back; once it has returned, its own batch is sent one second later, in order. */
export async function holdingPrompts<T>($: Engine, body: () => Promise<T>): Promise<T> {
  if (holdDepth === 0) batch += 1
  const mine = batch
  holdDepth += 1
  try {
    return await body()
  } finally {
    holdDepth -= 1
    if (holdDepth === 0 && queued.some(one => one.batch === mine)) {
      $.clock.after(1000, () => {
        const held = mergeNotes(queued.filter(one => one.batch === mine))
        queued = queued.filter(one => one.batch !== mine)
        void (async () => {
          for (const one of held) await deliver($, one.key, one.text)
        })()
      })
    }
  }
}

/**
 * Sends a prompt about `key`'s record to the main agent now, or after the command that holds the turn has returned. Either way
 * the owner is checked at delivery: a session that lost the record sends nothing (#13). `isNote`: an action's note, which a prompt
 * of the same command and record absorbs (R81).
 */
export async function say($: Engine, key: RecordKey, text: string, isNote = false): Promise<void> {
  if (holdDepth > 0) {
    queued.push({ text, key, batch, ...(isNote ? { isNote } : {}) })
    return
  }
  await deliver($, key, text)
}

/** The person's action, told to the agent (R81): what they did, what still holds, and the agent's next step. Queued as a note. */
export async function tellAgent($: Engine, key: RecordKey, did: string, next: string, standing?: Standing): Promise<void> {
  const lines = [`pr-gate: the person ${did}.`]
  const holds = standing === undefined ? '' : holdText(standing)
  if (holds !== '') lines.push('', holds)
  lines.push('', `Your next step: ${next}`)
  await say($, key, lines.join('\n'), true)
}

export async function getRun($: Engine): Promise<Run | null> {
  return (await $.state.get(RUN)).value ?? null
}

/** Whether run `id` is still the one in flight and running: a step re-reads it after a long await (finding 29, R80). */
async function isRunning($: Engine, id: string): Promise<boolean> {
  const live = await getRun($)
  return live !== null && live.id === id && live.status === 'running'
}

/**
 * Applies a change to the run in flight; a run that ended or was replaced is left alone, and null comes back for it (final review
 * M2), so a caller's `after === null` also catches a run stopped or waived since it was read.
 */
export async function patch($: Engine, id: string, change: (run: Run) => Run): Promise<Run | null> {
  let after: Run | null = null
  await update($, runAtom, run => {
    const isOurs = run !== null && run !== undefined && run.id === id && run.status === 'running'
    after = isOurs ? change(run) : null
    return isOurs ? after : (run ?? null)
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
 * head after it. A dirty checkout, one with commits the PR lacks, or one on another branch is left as it is: that is the person's to sort out.
 */
export async function syncToHead($: Engine, root: string, branch: string, prHead: string): Promise<boolean> {
  const local = await git($, root, ['rev-parse', 'HEAD'])
  if (!local.isOk) return false
  if (local.out === prHead) return true
  // Only the PR's own branch is moved: a checkout switched to another branch meanwhile is never fast-forwarded to the PR head.
  const on = await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!on.isOk || on.out !== branch) return false
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
  // Only a change near a finding reopens it, read from the head its line was placed at (R73); git failing reopens everything.
  const bases = new Set(rec.findings.map(one => one.lineHead ?? from ?? to).filter(base => base !== to))
  const diffs = new Map<string, ReturnType<typeof readDiff> | 'all'>()
  for (const base of bases) {
    const diff = await git($, root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', base, to], 60_000)
    diffs.set(base, diff.isOk ? readDiff(diff.out) : 'all')
  }
  const findings = relocate(rec.findings, from, to, diffs)
  return { findings, waivers: await lapsedAt($, { root, waivers: rec.waivers, findings }, to, now) }
}

/**
 * A run saw a new head: `headMoved` over its ledger, written to the record at once (`endCollect` and `beginTriage` read the record)
 * and to the run's own copy, which wins over the record's when the two are merged.
 */
export async function onNewHead($: Engine, run: Run, from: string, to: string, now: number): Promise<void> {
  const live = await getRun($)
  const own = live?.id === run.id ? live.findings : run.findings
  // Each finding's flag and its line, placed at the new head (R73), go to both copies.
  let placed = new Map<string, Finding>()
  const flag = (findings: readonly Finding[]): Finding[] =>
    findings.map(one => {
      const at = placed.get(one.id)
      if (at === undefined) return one
      return {
        ...one,
        ...(at.needsRecheck === true ? { needsRecheck: true } : {}),
        ...(at.line === undefined ? {} : { line: at.line }),
        ...(at.lineHead === undefined ? {} : { lineHead: at.lineHead }),
      }
    })
  const move = async (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Promise<Waiver[]> => {
    const moved = await headMoved($, run.root, { findings: mergeFindings(rec.findings, own), waivers: rec.waivers }, from, to, now)
    placed = new Map(moved.findings.map(one => [one.id, one]))
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
  // The first tick beats for this session, unless another holds the record (#13).
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
      if (run.collect !== undefined) {
        // Collection polls on while a triage turn answers what arrived (R88); only the turn itself has a step timeout.
        await poll($, run)
        if (run.phase === 'collect') return // waiting on reviewers is not a step: no step timeout while collecting
        // afterTriage settling a turn taken while collecting (A4): the poll clears a stale flag, so the step timeout does not apply.
        if (run.isSettling !== undefined && run.pending.length === 0) return
      }
      if (now - run.phaseStartedAt > config.stepTimeoutMs) {
        // The first turn taken while collecting that times out in a round goes back to collecting and is asked again (R88): the gate
        // runs on without the person. Only a second one stops the run.
        // Only a turn still unanswered: an answered one whose afterTriage failed before settling it falls through to the stop below,
        // never a requeue that cannot apply on every tick.
        const isUnanswered = run.pending.some(one => one.answer === undefined)
        if (run.phase === 'triage' && run.collect !== undefined && isUnanswered && (run.midTurnTimeouts ?? 0) === 0) {
          // Missed (the run moved on, or the turn was answered since this tick read it): nothing this tick; the next one reads afresh.
          await requeueMidTurn($, run, now)
          return
        }
        // A main-agent step whose prompt's turn never started could not have been answered: say so, not only that it ran long.
        const isUnseen = run.pending.some(one => one.isMain === true && one.answer === undefined && one.turnId === undefined)
        const why =
          `The ${run.phase} step ran past ${elapsed(config.stepTimeoutMs)}.` +
          (isUnseen ? ' Its prompt\'s turn was never seen: the main agent never started on it, so no answer could count.' : '') +
          // A turn taken while collecting (R88) ends here too, never a triage with nothing in flight: the feedback it was handed stays unprocessed.
          (run.phase === 'triage' && run.collect !== undefined
            ? ' It was answering feedback while reviews were still being collected; that feedback stays unanswered: run /pr-gate resume to collect again and be asked it.'
            : '')
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

/**
 * A turn taken while collecting ran past the step timeout, the first time this round (R88): the round goes back to collecting, with
 * no attempt noted. The feedback it left unanswered leaves `handed`, so the next poll asks it again in a turn of its own; a late answer
 * to this turn matches nothing pending (`isTurnOf` knows a turn by its id).
 */
async function requeueMidTurn($: Engine, run: Run, now: number): Promise<boolean> {
  const rec = await loadRecord($, run.root, run.branch)
  const unanswered = (run.triaged ?? []).filter(id => !(rec?.processed ?? []).includes(id))
  const step = run.pending[0]
  let isBack = false
  await patch($, run.id, one => {
    const live = one.pending[0]
    const isSame = one.round === run.round && one.phase === 'triage' && one.collect !== undefined && live !== undefined && step !== undefined &&
      live.step === step.step && live.turnId === step.turnId && live.answer === undefined
    if (!isSame) return one
    isBack = true
    return {
      ...one,
      phase: 'collect',
      phaseStartedAt: now,
      activeMs: one.activeMs + (now - one.phaseStartedAt),
      pending: [],
      isSettling: undefined,
      hasReprompted: false,
      midTurnTimeouts: 1,
      handed: (one.handed ?? []).filter(id => !unanswered.includes(id)),
      activity: 'waiting on reviewers…',
      steps: withStep(one.steps, {
        id: `r${one.round}-triage`,
        label: `Round ${one.round} · answer the reviews (main agent)`,
        state: 'done',
        detail: `timed out after ${elapsed(config.stepTimeoutMs)}; asked again`,
      }),
    }
  })
  if (!isBack) return false
  const what = unanswered.length === 0 ? 'nothing was left unanswered' : `${unanswered.length} unanswered item${unanswered.length === 1 ? '' : 's'} will be asked again`
  await logEvent($, run.root, run.branch, 'head', `post-PR round ${run.round}: a turn taken while collecting timed out after ${elapsed(config.stepTimeoutMs)}; collection goes on, ${what}`)
  $.ui.status(`pr-gate r${run.round}: waiting on reviewers`)
  return true
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
      isSettling: undefined,
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
 * fresh start must not repeat (processed feedback, recorded replies and the replies the agent reported, R91). False when there was no live record.
 */
export async function archiveLifecycle($: Engine, root: string, branch: string, now: number): Promise<boolean> {
  return lockRecord(root, branch, async () => {
    const last = await loadRecord($, root, branch)
    if (last === undefined || last.phase === 'archived') return false
    await archiveRecord($, last, now)
    const { base, head, tier, tierWhy, lane, allowance } = last
    const seed = newRecord({ root, branch, base, head, tier, tierWhy, lane, allowance, at: now })
    // When the head reached the PR (#24) is kept only for the head the seed names: a fresh start on another head looks it up afresh.
    const arrival = last.headArrival?.head === head ? { headArrival: last.headArrival } : {}
    await saveRecord($, { ...seed, processed: last.processed, replies: last.replies, ownReplies: last.ownReplies, ...arrival, phase: 'archived', generation: (last.generation ?? 0) + 1 })
    return true
  })
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

/** Reads a PR's state from gh's JSON; undefined when it is not there. */
export const prStateIn = (json: unknown): PrState | undefined => {
  const state = (json as { state?: unknown } | null)?.state
  return state === 'OPEN' || state === 'MERGED' || state === 'CLOSED' ? state : undefined
}

/**
 * The head and base of PR `pr`, as gh reports them; undefined when gh cannot say, a failed spawn included (final review T8). The base
 * is read with the head, so a PR retargeted since is judged against its new base (gate R3-4).
 */
async function prTipOf($: Engine, root: string, pr: number): Promise<{ head: string; base?: string } | undefined> {
  try {
    const view = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,baseRefName'], { cwd: root, timeoutMs: 30_000 })
    if (view.exitCode !== 0) return undefined
    const read = JSON.parse(view.stdout) as { headRefOid?: unknown; baseRefName?: unknown } | null
    const head = read?.headRefOid
    const base = read?.baseRefName
    if (typeof head !== 'string' || head === '') return undefined
    return { head, ...(typeof base === 'string' && base !== '' ? { base } : {}) }
  } catch {
    return undefined
  }
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
  // When the head reached the PR, read from GitHub again on every collection (#24): a stop and a resume keep a comment's coverage,
  // and a head the branch left and came back to while no session ran takes its later arrival.
  const arrival = await noteArrival($, opened.root, opened.branch, opened.roundStartHead, now)
  if (arrival !== undefined && arrival.at !== now) {
    await patch($, id, run => (run.collect === undefined ? run : { ...run, collect: { ...run.collect, headAt: arrival.at } }))
  }
  const rec = await loadRecord($, opened.root, opened.branch)
  // A later post-PR round, on a new head: ask the roster's reviewers to look again.
  if (rec !== undefined && rec.rounds.some(one => one.phase === 'post' && one.isCompleted) && rec.pr !== undefined && rec.slug !== undefined) {
    const roster = await rosterOf($, opened.root, opened.base)
    const names = roster?.requestReview ?? []
    for (const who of names) await askAgain($, rec, who)
    // Asked for this head: a comment that may predate it is not asked about a second time (#24).
    const head = opened.roundStartHead
    if (names.length > 0) {
      await updateRecord($, opened.root, opened.branch, one => {
        if (one.headArrival?.head !== head) return one
        return { ...one, headArrival: { ...one.headArrival, asked: [...new Set([...(one.headArrival.asked ?? []), ...names])] } }
      })
    }
  }
  $.ui.status(`pr-gate r${opened.round}: waiting on reviewers`)
}

/** Asks a requestReview reviewer to review the PR again: the POST to `requested_reviewers` (1.4.0). */
async function askAgain($: Engine, rec: LifecycleRecord, who: string): Promise<void> {
  await $.process
    .run(['gh', 'api', '-X', 'POST', `repos/${rec.slug ?? ''}/pulls/${rec.pr ?? ''}/requested_reviewers`, '-f', `reviewers[]=${who}`], {
      cwd: rec.root,
      timeoutMs: 30_000,
    })
    .catch(() => undefined)
}

type HeadArrival = NonNullable<LifecycleRecord['headArrival']>

/** Where the PR's head branch lives: its repository (a fork's, for a PR from one) and branch name. Absent parts are the record's. */
export type HeadPlace = { repo?: string; branch?: string; isCrossRepository?: boolean }

/**
 * The repository and branch whose activity log holds the PR head's pushes: gh's word from this poll, else the record's, else the
 * PR's own repository and the checked-out branch. A PR from a fork whose repository gh never named has none: the base repository's
 * log would be another branch's.
 */
const pushPlaceOf = (rec: LifecycleRecord, where: HeadPlace = {}): { repo: string; branch: string } | undefined => {
  const place = { ...rec.headPlace, ...where }
  const repo = place.repo ?? (place.isCrossRepository === true ? undefined : rec.slug)
  const branch = place.branch ?? rec.branch
  return repo === undefined || repo === '' || branch === '' ? undefined : { repo, branch }
}

/** The activity rows that move a branch to a commit; a deletion's all-zero sha is none. */
const MOVES = ['push', 'force_push', 'branch_creation']

/** A push into the PR's head branch, as GitHub's repository activity log lists it: the sha it moved the branch to, and when. */
type Push = { after: string; at: number }

/** The head branch's pushes from GitHub's repository activity log (#24); undefined when gh fails or the answer does not parse. */
async function pushesOf($: Engine, rec: LifecycleRecord, where: HeadPlace = {}): Promise<Push[] | undefined> {
  const place = pushPlaceOf(rec, where)
  if (place === undefined) return undefined
  const { repo, branch } = place
  const ref = `refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`
  try {
    const ran = await $.process.run(['gh', 'api', `repos/${repo}/activity?ref=${ref}&per_page=100`], { cwd: rec.root, timeoutMs: 30_000 })
    if (ran.exitCode !== 0) return undefined
    const rows = JSON.parse(ran.stdout) as unknown
    if (!Array.isArray(rows)) return undefined
    return rows.flatMap(row => {
      const one = row as { after?: unknown; timestamp?: unknown; activity_type?: unknown } | null
      const at = typeof one?.timestamp === 'string' ? Date.parse(one.timestamp) : Number.NaN
      const isMove = typeof one?.activity_type === 'string' && MOVES.includes(one.activity_type)
      return isMove && typeof one.after === 'string' && !/^0+$/.test(one.after) && Number.isFinite(at) ? [{ after: one.after, at }] : []
    })
  } catch {
    return undefined
  }
}

/**
 * When `head` was last pushed into the PR's head branch (#24): the latest push into it, never the earliest, since a branch can return
 * to a sha (A, B, then A again: only the last arrival of A is A's arrival now). undefined when GitHub does not say.
 */
export async function pushTimeOf($: Engine, rec: LifecycleRecord, head: string, where: HeadPlace = {}): Promise<number | undefined> {
  const times = (await pushesOf($, rec, where))?.filter(one => one.after === head).map(one => one.at) ?? []
  return times.length === 0 ? undefined : Math.max(...times)
}

/** The head branch's newest push, whatever sha it moved the branch to; undefined when GitHub does not say. */
export async function latestPushOf($: Engine, rec: LifecycleRecord, where: HeadPlace = {}): Promise<Push | undefined> {
  const pushes = await pushesOf($, rec, where)
  if (pushes === undefined || pushes.length === 0) return undefined
  return pushes.reduce((newest, one) => (one.at > newest.at ? one : newest))
}

/**
 * Notes on the record when `head` reached the PR (#24): GitHub's push time when it gives one (never later than now), which replaces
 * a stored time for the same head; else the stored time; else `fallback`, the time the gate first saw it. A record whose
 * `headArrival` names another head never lends that head's time, only a lower bound (`since`): the new head reached the PR after
 * the gate last saw the old one there, and after the old one arrived. undefined when there is no record.
 */
export async function noteArrival(
  $: Engine,
  root: string,
  branch: string,
  head: string,
  fallback: number,
  where: HeadPlace = {},
): Promise<HeadArrival | undefined> {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined) return undefined
  const now = await $.clock.now()
  const read = rec.headArrival
  const stored = read?.head === head ? read : undefined
  const before = read === undefined || stored !== undefined ? undefined : Math.max(read.seenAt ?? 0, read.at, read.since ?? 0)
  const fresh = { head, ...(before === undefined || before <= 0 ? {} : { since: before }) }
  const push = await pushTimeOf($, rec, head, where)
  const at = push === undefined ? undefined : Math.min(push, now)
  const next: HeadArrival =
    at === undefined
      ? (stored ?? { ...fresh, at: Math.min(fallback, now), isPushTime: false })
      : stored?.isPushTime === true && stored.at === at
        ? stored
        : { ...(stored ?? fresh), at, isPushTime: true }
  // Written only over the arrival this read: one another poll wrote meanwhile, for another head, is not replaced by an older one.
  if (next !== stored) {
    await updateRecord($, root, branch, one =>
      one.headArrival === undefined || one.headArrival.head === read?.head || one.headArrival.head === head ? { ...one, headArrival: next } : one,
    )
  }
  return next
}

/** A time as GitHub prints it, for the run log. */
const isoOf = (at: number): string => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * No silent wait on a guess (#24): while GitHub gives no push time for the head, a roster reviewer's issue comment posted after the
 * head commit's committer date but before the gate first saw the head may or may not be about it. A requestReview reviewer is asked
 * again, once per head, and its reply covers the head; any other roster reviewer's comment counts for the head. Both are logged.
 * Returns the coverage with the counted comments placed on the head.
 */
async function guessCover($: Engine, rec: LifecycleRecord, roster: Roster, arrival: HeadArrival, cover: Feedback[]): Promise<Feedback[]> {
  const head = arrival.head
  const doubtful = cover.filter(one => one.kind === 'comment' && one.head === undefined && one.at < arrival.at && roster.reviewers.includes(one.reviewer))
  const asked = new Set(arrival.asked ?? [])
  const counted = new Set(arrival.counted ?? [])
  const nameOf = (one: Feedback): string | undefined => roster.requestReview.find(name => postsFor(one.reviewer, name))
  const open = doubtful.filter(one => !counted.has(one.id) && !asked.has(nameOf(one) ?? ''))
  if (open.length > 0) {
    // The window's start: a commit is never pushed before it was made (its committer date, read once per head), nor before the
    // gate last saw the head before it on the PR (`since`). Neither known, nothing bounds it.
    let committedAt = arrival.committedAt
    if (committedAt === undefined) {
      const dated = await $.process
        .run(['gh', 'api', `repos/${rec.slug ?? ''}/commits/${head}`, '--jq', '.commit.committer.date'], { cwd: rec.root, timeoutMs: 30_000 })
        .catch(() => undefined)
      const parsed = dated?.exitCode === 0 ? Date.parse(dated.stdout.trim()) : Number.NaN
      committedAt = Number.isFinite(parsed) ? parsed : undefined
    }
    const since = Math.max(committedAt ?? 0, arrival.since ?? 0)
    for (const one of open.filter(each => each.at > since).sort((a, b) => a.at - b.at)) {
      const name = nameOf(one)
      if (name !== undefined) {
        if (asked.has(name)) continue
        asked.add(name)
        await askAgain($, rec, name)
        await logEvent($, rec.root, rec.branch, 'head', `${one.reviewer}: comment at ${isoOf(one.at)} may predate ${head.slice(0, 7)}; asked again`)
      } else {
        counted.add(one.id)
        await logEvent($, rec.root, rec.branch, 'head', `${one.reviewer}: comment at ${isoOf(one.at)} counted for ${head.slice(0, 7)}; GitHub gave no push time`)
      }
    }
    const isChanged =
      asked.size !== (arrival.asked ?? []).length || counted.size !== (arrival.counted ?? []).length || committedAt !== arrival.committedAt
    if (isChanged) {
      const dated = committedAt === undefined ? {} : { committedAt }
      await updateRecord($, rec.root, rec.branch, one =>
        one.headArrival?.head !== head ? one : { ...one, headArrival: { ...one.headArrival, asked: [...asked], counted: [...counted], ...dated } },
      )
    }
  }
  return cover.map(one => (counted.has(one.id) ? { ...one, head } : one))
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
  /** Where the PR's head branch lives, as gh says (a fork's, for a PR from one), for its push times (#24). */
  where?: HeadPlace
  /** Logins with a pending review request (R89), this machine's own left out. */
  requested?: string[]
}

/** The PR head's checks from `gh pr checks` (R1-9): [] when gh reports none, { unreadable: gh's own words } when it can't say. */
export async function readChecks($: Engine, root: string, pr: number, repo?: string): Promise<{ name: string; bucket: string }[] | { unreadable: string }> {
  let ran: { exitCode: number; stdout: string; stderr: string }
  try {
    ran = await $.process.run(['gh', 'pr', 'checks', String(pr), ...(repo === undefined ? [] : ['--repo', repo]), '--json', 'name,state,bucket'], {
      cwd: root,
      timeoutMs: 30_000,
    })
  } catch (error) {
    ran = { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  try {
    const read = JSON.parse(ran.stdout) as unknown
    const row = (one: unknown): Record<string, unknown> => (typeof one === 'object' && one !== null ? (one as Record<string, unknown>) : {})
    if (Array.isArray(read)) return read.map(one => ({ name: String(row(one).name ?? '?'), bucket: String(row(one).bucket ?? '') }))
  } catch {
    // Not JSON: read stderr below.
  }
  return /no checks reported/i.test(ran.stderr) ? [] : { unreadable: ran.stderr.trim().slice(0, 200) || `gh pr checks exited ${ran.exitCode}` }
}

const required = new Map<string, { found: Set<string>; at: number }>()
/** How long a base's required checks are reused: a check made required since is read again after this (gate R1-4). */
const REQUIRED_TTL_MS = 5 * 60_000

/**
 * The base's required checks (R86): the union of its rulesets and classic protection, cached per repository and base for REQUIRED_TTL_MS.
 * Each source must be parsed, or authoritatively absent (classic's 404 "not protected" or "status checks not enabled"); a throw,
 * a 403 or 500, or a payload that doesn't parse from either makes it unknown, with the reason in gh's own words where it gave one:
 * that holds the merge (R86, gate R3-1, R3-2) and is not cached (PR #19 review).
 */
export async function requiredChecksOf($: Engine, root: string, slug: string | undefined, base: string): Promise<Set<string> | { unknown: string }> {
  // Without a known slug (a waiver-only record), gh fills {owner}/{repo} from the checkout's own remote.
  const repo = slug ?? '{owner}/{repo}'
  const key = `${slug ?? root}:${base}`
  const now = await $.clock.now()
  const seen = required.get(key)
  if (seen !== undefined && now - seen.at < REQUIRED_TTL_MS) return seen.found
  const api = (path: string) => $.process.run(['gh', 'api', path], { cwd: root, timeoutMs: 30_000 }).catch((err: unknown) => String(err).slice(0, 160))
  // Pages of 100 (final review M3): GitHub's default of 30 could cut a required-checks rule, and a full page means another may
  // follow, read until one is short (gate R4-4).
  // A base such as release/1.0 is one path segment, encoded (gate R5-1).
  const rulesAt = `repos/${repo}/rules/branches/${encodeURIComponent(base)}`
  const classicAt = `repos/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`
  const readRules = async (): Promise<string | { exitCode: number; stdout: string; stderr: string }> => {
    const all: unknown[] = []
    for (let page = 1; page <= 20; page += 1) {
      const got = await api(`${rulesAt}?per_page=100${page === 1 ? '' : `&page=${page}`}`)
      if (typeof got === 'string' || got.exitCode !== 0) return got
      let rows: unknown
      try {
        rows = JSON.parse(got.stdout)
      } catch {
        return got
      }
      // A payload that isn't a list goes to readRequired as it came, which reads it as unknown.
      if (!Array.isArray(rows)) return got
      all.push(...(rows as unknown[]))
      if (rows.length < 100) return { ...got, stdout: JSON.stringify(all) }
    }
    return 'more than 20 pages of rules'
  }
  const rules = await readRules()
  const classic = await api(classicAt)
  // The endpoint is named, so the person knows what the gh login must be able to read.
  const failed = (at: string, ran: string | { exitCode: number; stderr: string }) =>
    ({ unknown: `gh api ${at}: ${typeof ran === 'string' ? ran : ran.stderr.trim().slice(0, 160) || `exit ${ran.exitCode}`}` })
  if (typeof rules === 'string' || rules.exitCode !== 0) return failed(rulesAt, rules)
  if (typeof classic === 'string') return failed(classicAt, classic)
  // Only GitHub's own words are an authoritative none: a 404 for any other reason (a missing branch or token scope) is unknown (M3).
  // A protected branch that requires no status checks (reviews only, say) answers "Required status checks not enabled" (gate R4-1, R4-2).
  const isClassicNone = classic.exitCode !== 0 && /Branch not protected|Required status checks not enabled/i.test(classic.stderr)
  if (classic.exitCode !== 0 && !isClassicNone) return failed(classicAt, classic)
  const listed = readRequired(rules.stdout, classic.exitCode === 0 ? classic.stdout : undefined)
  if (listed === undefined) return { unknown: `gh api ${rulesAt} or ${classicAt} returned a payload that does not parse` }
  const found = new Set(listed)
  required.set(key, { found, at: now })
  return found
}

/** The standing of a PR head (R79): the record's findings and review, its checks, and which of them its base requires. */
export async function gatherStanding(
  $: Engine,
  rec: LifecycleRecord,
  pr: { number: number; baseRefName: string; headRefOid: string },
  repo?: string,
): Promise<Standing> {
  const checks = await readChecks($, rec.root, pr.number, repo)
  const needed = !Array.isArray(checks) ? new Set<string>() : await requiredChecksOf($, rec.root, repo ?? rec.slug, pr.baseRefName)
  // A required check that never reported holds the merge too, as GitHub's ruleset does (gate R1-3).
  const reported = new Set(Array.isArray(checks) ? checks.map(one => one.name) : [])
  // A base whose required checks can't be read makes every reported check required, so a waiver sets none aside (R86, PR19-2).
  // It adds no hold of its own: GitHub's ruleset still enforces required checks at merge (Adam's ruling on gate R2-2, option B).
  if (!(needed instanceof Set)) {
    return standingOf(rec, { head: pr.headRefOid, base: pr.baseRefName }, (checks as CheckState[]).map(one => ({ ...one, isRequired: true })))
  }
  const missing = [...needed].filter(name => !reported.has(name)).map(name => ({ name, bucket: 'missing', isRequired: true }))
  const ci: CheckState[] | { unreadable: string } =
    !Array.isArray(checks) ? checks : [...checks.map(one => ({ ...one, isRequired: needed.has(one.name) })), ...missing]
  return standingOf(rec, { head: pr.headRefOid, base: pr.baseRefName }, ci)
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
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr), '--json', 'headRefOid,state,headRefName,headRepository,headRepositoryOwner,isCrossRepository'], {
    cwd: rec.root,
    timeoutMs: 30_000,
  })
  if (pr.exitCode !== 0) {
    return fail(`gh could not read PR #${rec.pr} (${pr.stderr.trim().slice(0, 160) || `exit ${pr.exitCode}`}); check gh auth login and the network`)
  }
  let prHead: string | undefined
  let state: PrState | undefined
  const where: HeadPlace = {}
  try {
    const read = JSON.parse(pr.stdout) as {
      headRefOid?: unknown
      headRefName?: unknown
      headRepository?: { name?: unknown } | null
      headRepositoryOwner?: { login?: unknown } | null
      isCrossRepository?: unknown
    } | null
    prHead = read?.headRefOid as string | undefined
    state = prStateIn(read)
    if (typeof read?.headRefName === 'string' && read.headRefName !== '') where.branch = read.headRefName
    const owner = read?.headRepositoryOwner?.login
    const name = read?.headRepository?.name
    if (typeof owner === 'string' && owner !== '' && typeof name === 'string' && name !== '') where.repo = `${owner}/${name}`
    if (typeof read?.isCrossRepository === 'boolean') where.isCrossRepository = read.isCrossRepository
  } catch {
    prHead = undefined
  }
  if (state === 'MERGED' || state === 'CLOSED') return { ...fail(`PR #${rec.pr} was ${state.toLowerCase()}`), closed: state }
  if (typeof prHead !== 'string' || prHead === '') {
    return fail(`gh returned unreadable output for PR #${rec.pr} (${pr.stdout.trim().slice(0, 80)}); check gh auth login, rate limits and the network`)
  }
  // Where the head branch lives, kept for the steps that read push times without asking gh for the PR (#24).
  const place = { ...rec.headPlace, ...where }
  if (JSON.stringify(place) !== JSON.stringify(rec.headPlace ?? {})) await updateRecord($, rec.root, rec.branch, one => ({ ...one, headPlace: place }))
  const at = `repos/${rec.slug}`
  const [reviews, inline, comments, checks, requests, status] = await Promise.all([
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/reviews`),
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/issues/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/commits/${prHead}/check-runs`),
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/requested_reviewers`),
    ghJson($, rec.root, `${at}/commits/${prHead}/status`),
  ])
  const bad = [reviews, inline, comments, checks].find(one => !one.isOk)
  if (bad !== undefined) return fail(`gh api failed (${bad.err.slice(0, 160)}); check gh auth login, rate limits and the network`)
  // Pending review requests only add waits (R89): a failed read lists none, and the round goes on by its other signals.
  if (!requests.isOk) await logEvent($, rec.root, rec.branch, 'head', `could not read requested reviewers: ${requests.err.slice(0, 160)}`)
  // A required check some CI posts as a commit status, not a check run (R89): without it, its context would never finish and every
  // round would wait out the cap. A failed or unreadable read falls back to check runs only, and the log says so.
  let statuses: Check[] = []
  if (!status.isOk) await logEvent($, rec.root, rec.branch, 'check', `could not read commit statuses: ${status.err.slice(0, 160)}; check runs only`)
  else {
    try {
      statuses = readStatuses(status.out)
    } catch {
      await logEvent($, rec.root, rec.branch, 'check', 'could not read commit statuses: unreadable JSON from gh; check runs only')
    }
  }
  // A proxy's error page or a cut-off page is not "no feedback" (R12): the poll fails closed.
  try {
    // Only feedback from someone with write access, or on the roster, is read (R1-8); this machine's own rows are sorted out below.
    const roster = await rosterOf($, rec.root, rec.base)
    const all = [...readReviews(reviews.out), ...readInlineComments(inline.out), ...readIssueComments(comments.out)].filter(
      one => one.reviewer === self || isTrusted(one, roster),
    )
    // Of this machine's own comments, only the mod's replies are not feedback (R64): an inline reply in a thread, or a comment
    // whose id is a recorded reply or one the agent reported (R91). The person's other top-level and review comments reach
    // triage. Its inline replies are its replies, which no turn may post twice (R35).
    // A reply recorded as the URL gh printed (before R66) is read as its comment number too.
    // Every reply the agent reported is the gate's own, whatever its answer (R91).
    const replied = new Set([...Object.values(rec.replies).map(replyIdOf), ...(rec.ownReplies ?? [])])
    const isReply = (one: Feedback): boolean =>
      (one.kind === 'inline' && one.threadId !== one.id.slice('inline:'.length)) || replied.has(one.id.slice(one.id.indexOf(':') + 1))
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
    const requested = requests.isOk ? readRequested(requests.out, self) : []
    return { isOk: true, feedback, cover: others, checks: [...readCheckRuns(checks.out), ...statuses], prHead, ownReplies, where, requested }
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
  // Read again: another tick may have polled since this one read the run. A run collecting, or answering while collecting (R88).
  const read = await getRun($)
  if (read === null || read.id !== seen.id || read.status !== 'running' || read.collect === undefined) return
  if (read.phase !== 'collect' && read.phase !== 'triage') return
  let run: Run = read
  // A settling flag older than the step timeout (A4): afterTriage threw, or its session died, between clearing the turn and its last
  // write. The gate never gets stuck: the flag is cleared, the round goes back to collecting, and the log says so. The answers it
  // recorded stand; what it did not record is asked again.
  const settling = read.isSettling
  // At least five minutes: a slow but healthy afterTriage is not stale (a fetch alone can take two).
  const staleMs = Math.max(config.stepTimeoutMs, 5 * 60_000)
  if (settling !== undefined && read.pending.length === 0 && now - settling > staleMs) {
    const cleared = await patch($, read.id, one =>
      one.isSettling !== settling || one.round !== read.round
        ? one
        : {
            ...one,
            isSettling: undefined,
            phase: 'collect',
            phaseStartedAt: now,
            activeMs: one.activeMs + (now - one.phaseStartedAt),
            hasReprompted: false,
            activity: 'waiting on reviewers…',
          },
    )
    if (cleared === null || cleared.collect === undefined) return
    await logEvent(
      $,
      read.root,
      read.branch,
      'head',
      `post-PR round ${read.round}: the answers to a turn taken while collecting were not settled within ${elapsed(staleMs)}; ` +
        'settling flag cleared, collection goes on',
    )
    run = cleared
  }
  const collect = run.collect
  if (collect === undefined || now - collect.polledAt < POLL_MS) return
  // A triage turn in flight, or afterTriage settling one (A4): this poll only notes arrivals.
  const isTurn = run.phase === 'triage'
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
    // A triage turn is answering: a failed poll is tried again at the next one, not a stop under the agent's feet.
    if (isTurn) return
    await noteAttempt($, run, got.why ?? 'gh failed')
    await finish($, run.id, 'error', `Post-PR round ${run.round} could not read GitHub: ${got.why ?? 'gh failed'}. Fix that, then /pr-gate resume.`)
    return
  }
  const fresh = got.feedback.filter(one => !rec.processed.includes(one.id))
  const lastArrivalAt = Math.max(collect.lastArrivalAt, ...fresh.map(one => Math.min(one.at, now)))
  const seenIds = new Set(run.polled ?? [])
  const isArrival = fresh.some(one => !seenIds.has(one.id))
  // The PR's head, not the local one, is what the round covers (an adopted PR, another agent's push).
  const isNewHead = got.prHead !== run.roundStartHead
  // When the head reached the PR (#24): the record's, read from GitHub on first sight and, while GitHub has given no push time, on
  // each poll; else the time the gate first saw it.
  const known = rec.headArrival?.head === got.prHead ? rec.headArrival : undefined
  const arrival =
    known?.isPushTime === true ? known : ((await noteArrival($, run.root, run.branch, got.prHead, isNewHead ? now : collect.headAt, got.where)) ?? known)
  let headAt = arrival?.at ?? (isNewHead ? now : collect.headAt)
  // While a triage turn answers, a poll only notes what arrived, and when a head it sees reached the PR (#24); the turn's own end
  // reads the head it pushed (R88). Written only to the collection this poll read: the turn's end may have closed it meanwhile.
  if (isTurn) {
    const startedAt = collect.startedAt
    await patch($, run.id, one =>
      one.round !== run.round || one.collect?.startedAt !== startedAt
        ? one
        : {
            ...one,
            collect: { ...one.collect, polledAt: now, lastArrivalAt: isArrival ? now : lastArrivalAt, ...(isNewHead ? {} : { headAt }) },
            polled: fresh.map(each => each.id),
          },
    )
    await updateRecord($, run.root, run.branch, one =>
      one.headArrival?.head !== got.prHead ? one : { ...one, headArrival: { ...one.headArrival, seenAt: now } },
    )
    return
  }
  // A new head restarts the quiet period: its checks may not be registered yet.
  const arrived = isNewHead || isArrival
  // Judged from the head the round had before this one replaces it (R56).
  if (isNewHead) await onNewHead($, run, run.roundStartHead, got.prHead, now)
  const after = await patch($, run.id, one => ({
    ...one,
    roundStartHead: got.prHead,
    collect: { ...collect, polledAt: now, lastArrivalAt: arrived ? now : lastArrivalAt, headAt },
    polled: fresh.map(each => each.id),
  }))
  if (after === null) return
  // This poll saw the head on the PR: a later head reached it after now, the lower bound of a guess about it (#24).
  await updateRecord($, run.root, run.branch, one =>
    one.headArrival?.head !== got.prHead ? one : { ...one, headArrival: { ...one.headArrival, seenAt: now } },
  )
  const roster = await rosterOf($, run.root, run.base)
  let cover = got.cover ?? got.feedback
  if (roster !== undefined && arrival !== undefined && !arrival.isPushTime) {
    cover = await guessCover($, (await loadRecord($, run.root, run.branch)) ?? rec, roster, arrival, cover)
  }
  const capMs = (roster?.waitCapMinutes ?? config.waitCapMs / 60_000) * 60_000
  // The base's required checks (R86): unknown makes every reported check stand in.
  const needed = await requiredChecksOf($, run.root, rec.slug, run.base)
  const judge = () =>
    collectionDone({
      roster,
      feedback: cover,
      checks: got.checks,
      head: got.prHead,
      headAt,
      startedAt: collect.startedAt,
      lastArrivalAt: after.collect?.lastArrivalAt ?? now,
      now,
      quietMs: (roster?.quietMinutes ?? config.quietMs / 60_000) * 60_000,
      capMs,
      requested: got.requested ?? [],
      required: needed instanceof Set ? [...needed] : 'unknown',
    })
  let done = judge()
  // Coverage that rests on an issue comment (no commit) is checked against the branch's newest push before it ends collection
  // (#24, A→B→A between two polls): the branch may have left the head and come back after the comment. Reviews carry their commit.
  const restsOnComment = cover.some(one => one.kind === 'comment' && one.head === undefined && one.at >= headAt && done.covered.includes(one.reviewer))
  // A PR from a fork whose repository gh never named has no log to read: the stored time stands.
  if (done.isDone && restsOnComment && pushPlaceOf(rec, got.where) !== undefined) {
    const newest = await latestPushOf($, rec, got.where)
    const head7 = got.prHead.slice(0, 7)
    if (newest === undefined) {
      // The gate never gets stuck: a failed check keeps the stored time, and the log says so.
      await logEvent($, run.root, run.branch, 'head', `could not read when ${head7} was last pushed; a comment with no commit ends collection on the stored time`)
    } else if (newest.after !== got.prHead && now - collect.startedAt < capMs) {
      // The head moved during the poll: the next poll reads the new one.
      const moved = `the branch moved to ${newest.after.slice(0, 7)}; reading it at the next poll`
      if (moved !== after.activity) await patch($, run.id, one => ({ ...one, activity: moved }))
      return
    } else if (newest.after === got.prHead && Math.min(newest.at, now) > headAt) {
      headAt = Math.min(newest.at, now)
      const at = headAt
      // A new arrival of the same head: its guesses are over, its lower bound and commit date still hold.
      await updateRecord($, run.root, run.branch, one => {
        const was = one.headArrival
        if (was !== undefined && was.head !== got.prHead) return one
        const kept = { ...(was?.since === undefined ? {} : { since: was.since }), ...(was?.committedAt === undefined ? {} : { committedAt: was.committedAt }) }
        return { ...one, headArrival: { head: got.prHead, at, isPushTime: true, ...kept, seenAt: now } }
      })
      await patch($, run.id, one => (one.collect === undefined ? one : { ...one, collect: { ...one.collect, headAt: at } }))
      done = judge()
    }
  }
  if (done.isDone) {
    await endCollect($, after, got, done)
    return
  }
  // Feedback no turn of this round was handed, with one quiet poll since the last arrival: the agent answers it now (R88).
  const handed = new Set(after.handed ?? [])
  const unhanded = fresh.filter(one => one.isFinding && !handed.has(one.id))
  if (unhanded.length > 0 && now - (after.collect?.lastArrivalAt ?? now) >= POLL_MS) {
    await beginTriage($, after.id, false, true)
    return
  }
  const waiting = done.missing.length > 0 ? `waiting on ${done.missing.join(', ')}` : 'waiting for feedback to go quiet'
  if (waiting !== after.activity) await patch($, run.id, one => ({ ...one, activity: waiting }))
}

/** Collection on the round's head is over: its wait is added, `collect` is cleared and its step is marked done. */
async function closeCollect($: Engine, id: string, now: number, detail: string, extra: Partial<Run> = {}): Promise<Run | null> {
  return patch($, id, one => ({
    ...one,
    ...extra,
    waitMs: one.waitMs + (one.collect === undefined ? 0 : now - one.collect.startedAt),
    collect: undefined,
    steps: withStep(one.steps, { id: `r${one.round}-collect`, label: `Round ${one.round} · collect reviews (${one.roundKind})`, state: 'done', detail }),
  }))
}

/** Collection is over: Codex covers a head nobody reviewed (or verification owed); then the feedback goes to triage. */
async function endCollect($: Engine, run: Run, got: Fetched, done: ReturnType<typeof collectionDone>): Promise<void> {
  const now = await $.clock.now()
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
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
  // Feedback a turn of this round already answered while collecting (R88) counts as the round's, as it did when it waited until now.
  const hasFindings = got.feedback.some(one => one.isFinding && !rec.processed.includes(one.id)) || (run.handed ?? []).length > 0
  const detail = `${done.covered.length} reviewer${done.covered.length === 1 ? '' : 's'}${done.isComplete ? '' : `, missing ${done.missing.join(', ')}`}`
  const after = await closeCollect($, run.id, now, detail, { evidence, headSha: got.prHead })
  if (after === null) return
  // A fix only reported no longer calls for a full Codex review: the round's own Codex check verifies it (R72).
  if (run.roundKind === 'final-head-check' || (!isCovered && !isPassThroughRound1)) {
    // Codex reads the local checkout: it must be the PR head, or it would review something else.
    // A clean checkout behind the PR head (a reviewer's or a bot's push) catches up on its own (R71).
    const isSynced = await syncToHead($, run.root, run.branch, got.prHead)
    const local = await git($, run.root, ['rev-parse', 'HEAD'])
    if (!(await isRunning($, run.id))) return
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
  // A run stopped or waived meanwhile failed nothing: no attempt, no message (finding 29, R80).
  if (!(await isRunning($, run.id))) return
  await noteAttempt($, run, why)
  await finish($, run.id, 'error', `Post-PR round ${run.round} stopped: ${why}.`)
  await say($, run, `pr-gate: post-PR round ${run.round} on ${run.branch} stopped: ${why}.`)
}

/**
 * Triage: the round's fresh GitHub feedback, Codex's open findings when it ran, and blockers still open from earlier
 * rounds (R32) go to the main agent in one turn. While collection still waits (R88), only the fresh feedback no turn of the round
 * was handed. Nothing to answer and no unreviewed commits end the round clean (R3).
 */
async function beginTriage($: Engine, id: string, isFromCommand = false, isMidCollect = false): Promise<void> {
  const now = await $.clock.now()
  const run = await getRun($)
  if (run === null || run.id !== id || run.status !== 'running') return
  if (isMidCollect && (run.phase !== 'collect' || run.collect === undefined)) return
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
  // Each long await below re-reads the run: one stopped or waived meanwhile asks nothing and decides nothing (finding 29, R80).
  if (!(await isRunning($, id))) return
  if (!got.isOk) {
    await failPost($, run, `GitHub could not be read: ${got.why ?? 'gh failed'}; fix that, then run /pr-gate resume`)
    return
  }
  // Replies this machine already posted in a thread count as replies (R35), whatever an earlier turn reported.
  const own = got.ownReplies ?? {}
  const rec = Object.keys(own).some(key => prior.replies[key] === undefined)
    ? ((await updateRecord($, run.root, run.branch, one => ({ ...one, replies: { ...own, ...one.replies } }))) ?? prior)
    : prior
  const handed = new Set(run.handed ?? [])
  const items = got.feedback.filter(one => one.isFinding && !rec.processed.includes(one.id) && !(isMidCollect && handed.has(one.id)))
  // A review that said there is nothing to act on settles on its own (R83): logged once, and processed so it is never asked about.
  const settled = got.feedback.filter(one => one.kind === 'review' && !one.isFinding && one.body.trim() !== '' && !rec.processed.includes(one.id))
  for (const one of settled) await logEvent($, run.root, run.branch, 'approval', `${one.reviewer}: ${one.body.split('\n')[0]?.slice(0, 120) ?? ''}`)
  if (settled.length > 0) {
    await updateRecord($, run.root, run.branch, one => ({ ...one, processed: [...new Set([...one.processed, ...settled.map(each => each.id)])] }))
  }
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
  // Originals already on the ledger whose peak a new link raised (R90).
  const raised: Finding[] = []
  const listed: { feedback: Feedback; cls: TriageClass; matchId?: string; findingId: string }[] = []
  for (const feedback of items) {
    const title = feedback.body.split('\n')[0]?.replace(/[*_`#>]/g, '').trim().slice(0, 200) || `${feedback.reviewer} ${feedback.kind}`
    const others = ledger.filter(one => one.externalId !== feedback.id)
    // The batch so far too: a review summary and its own inline comment arrive together (R90).
    const placed = triage({ file: feedback.file, line: feedback.line, title, at: feedback.at }, [...others, ...fresh], new Set())
    let cls = placed.cls
    let matchId = placed.matchId
    const base = matchId === undefined ? prevStart : ([...others, ...fresh].find(one => one.id === matchId)?.headSeen ?? prevStart)
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
      peakSeverity: hint.severity,
      severitySource: hint.isTagged ? 'tag' : 'hint',
      ...(hint.isSecurity ? { isSecurity: true } : {}),
      title,
      ...(feedback.file === undefined ? {} : { file: feedback.file }),
      ...(feedback.line === undefined ? {} : { line: feedback.line }),
      detail: feedback.body.slice(0, 4000),
      headSeen: run.headSha,
      status: 'open',
      history: [{ round: run.round, status: 'open', by: feedback.reviewer, at: now }],
    }
    // The gate's match is a link (R90): the original's peak rises to the new item's, wherever the original is kept.
    const original = cls === 'duplicate' && matchId !== undefined ? [...ledger, ...fresh].find(one => one.id === matchId) : undefined
    if (original === undefined) fresh.push(finding)
    else {
      const linked = linkTo(finding, original, 'gate', run.round, now)
      const inBatch = fresh.findIndex(one => one.id === original.id)
      if (inBatch !== -1) fresh[inBatch] = withLinkedPeak(fresh[inBatch] as Finding, linked)
      else {
        const at = raised.findIndex(one => one.id === original.id)
        if (at === -1) raised.push(withLinkedPeak(original, linked))
        else raised[at] = withLinkedPeak(raised[at] as Finding, linked)
      }
      fresh.push(linked)
    }
    listed.push({ feedback, cls, ...(matchId === undefined ? {} : { matchId }), findingId: finding.id })
  }
  // Codex's findings of this round still open (the fallback or the final-head check): answered in the same turn.
  // A turn while collecting asks neither: the end of the head's collection does, as before R88.
  const codex = isMidCollect ? [] : run.findings.filter(one => one.source !== 'github' && raisedIn(one, run.round) && one.status === 'open')
  // Findings still open from earlier rounds, of either phase and any severity, come back until answered (R32, R39).
  const listedIds = new Set([...listed.map(one => one.findingId), ...codex.map(one => one.id)])
  const carried = isMidCollect
    ? []
    : mergeHolds({ findings: mergeFindings(ledger, [...fresh, ...raised]), waivers: rec.waivers }).filter(
        // By the round it was raised in, not "touched this round": Codex reopening an earlier finding must not hide it (finding 21, R82).
        one => one.status === 'open' && one.round !== run.round && !listedIds.has(one.id),
      )
  // Commits on the PR since the record's head, not yet reviewed: fetched first, so the log can read them.
  let others: string[] = []
  if (!isMidCollect && got.prHead !== rec.head) {
    // A failed fetch, twice, stops the round here (R1-10): the log would read a stale origin.
    const fetched = await fetchTwice($, run.root, ['--quiet', 'origin'], 60_000)
    if (!fetched.isOk) {
      await failPost($, run, `git could not fetch origin, twice (${fetched.err}); check the network and the remote, then run /pr-gate resume`)
      return
    }
    const log = await git($, run.root, ['log', '--format=%h %an %s', `${rec.head}..${got.prHead}`])
    others = log.isOk ? log.out.split('\n').filter(Boolean) : []
  }
  if (!(await isRunning($, id))) return
  const asked = [...listedIds, ...carried.map(one => one.id)]
  // Nothing new to hand over while collecting: the round goes on collecting.
  if (isMidCollect && asked.length === 0) return
  if (asked.length === 0 && others.length === 0) {
    const rebuttals = rebuttalsOwed(run)
    if (rebuttals.length > 0) await checkRebuttals($, run, rebuttals)
    else await endRound($, run, true)
    return
  }
  const count = asked.length
  // A turn while collecting opens only on the collection the poll saw: a stop, a waiver or a new round meanwhile asks nothing.
  let isOpened = false
  const opened = await patch($, id, one => {
    if (isMidCollect && (one.round !== run.round || one.phase !== 'collect' || one.collect === undefined)) return one
    isOpened = true
    return {
      ...one,
      phase: 'triage',
      phaseStartedAt: now,
      findings: mergeFindings(one.findings, [...fresh, ...raised]),
      triaged: items.map(each => each.id),
      handed: [...new Set([...(one.handed ?? []), ...items.map(each => each.id)])],
      asked,
      pending: [{ role: 'triage', step: stepOf(one, 'triage'), isMain: true }],
      hasReprompted: false,
      activity: isMidCollect ? 'waiting on the main agent to answer feedback while reviews come in…' : 'waiting on the main agent to answer the reviews…',
      steps: withStep(one.steps, {
        id: `r${one.round}-triage`,
        label:
          count === 0
            ? `Round ${one.round} · check the new commits (main agent)`
            : `Round ${one.round} · answer ${count} review item${count === 1 ? '' : 's'}${isMidCollect ? ' while reviews come in' : ''} (main agent)`,
        state: 'running',
      }),
    }
  })
  if (opened === null || !isOpened) return
  $.ui.status(`pr-gate r${opened.round}: answering the reviews`)
  const codexRange = `${opened.diffBase.slice(0, 7)}..${opened.headSha.slice(0, 7)}`
  const intro = isMidCollect
    ? `Reviews are still coming in on ${opened.roundStartHead.slice(0, 7)}: answer these now. Feedback that arrives meanwhile comes in a ` +
      'later turn. A push ends this round when your turn ends, and the next round reviews the new head.'
    : undefined
  const text = triagePrompt(opened, rec, listed, others, { carried, codex, codexRange, ...(intro === undefined ? {} : { intro }) })
  // A command cannot submit a prompt while it holds the turn: the ticker sends it once the command has returned.
  if (isFromCommand) await patch($, id, one => ({ ...one, outbox: text }))
  else await askTriage($, id, text)
}

/**
 * Review feedback on the PR that no round has triaged: a trusted reviewer, never waited for (R76), can post after the lifecycle
 * was ready. undefined when GitHub could not be read.
 */
export async function untriagedFeedback($: Engine, rec: LifecycleRecord): Promise<Feedback[] | undefined> {
  const got = await fetchFeedback($, rec)
  if (!got.isOk) return undefined
  const known = new Set(rec.findings.flatMap(one => (one.externalId === undefined ? [] : [one.externalId])))
  return got.feedback.filter(one => one.isFinding && !rec.processed.includes(one.id) && !known.has(one.id))
}

/** Triages feedback that arrived after the lifecycle was ready, on the same head, as an answer run: no round, no allowance (R76). */
async function startLateTriage($: Engine, rec: LifecycleRecord): Promise<void> {
  const now = await $.clock.now()
  const run = answerRun(rec, [], now, (await configFor($, rec.root, rec.base)).config)
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  await logEvent($, rec.root, rec.branch, 'head', `review feedback arrived after ready at ${rec.head.slice(0, 7)}: triaged on the same head`)
  await beginTriage($, run.id, true)
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

/** Keeps every reply id an answer reported as the gate's own (R91), in the order given, once each. */
const withOwnReplies = (rec: LifecycleRecord, answer: string): Pick<LifecycleRecord, 'ownReplies'> => {
  const ids = replyIdsOf(answer)
  return ids.length === 0 ? {} : { ownReplies: [...new Set([...(rec.ownReplies ?? []), ...ids])] }
}

/** The main agent answered the reviews: record the answers and replies at once, then end the round on the PR head GitHub now reports. */
async function afterTriage($: Engine, run: Run): Promise<void> {
  const now = await $.clock.now()
  // "acknowledged" counts only with a reply in the thread, on an item that may take it (R82); stored as a rebuttal, so Codex checks it.
  const said = readTriage(run.pending[0]?.answer ?? '').flatMap(each => {
    if (each.action !== 'acknowledged') return [each]
    const one = run.findings.find(f => f.id === each.id)
    if (one === undefined || !mayAcknowledge(one) || each.replyId === undefined) return []
    return [{ ...each, note: `No change requested: ${each.note ?? 'the comment asks for no change'}` }]
  })
  // The agent's links (R90), checked on canonical ids over the round's ledger and the record (A2): a link from or to an id not on
  // the list, to itself, on a cycle, or one Codex already refused is no answer, and the item is asked about again.
  const proposed = readLinks(run.pending[0]?.answer ?? '')
  const start = await loadRecord($, run.root, run.branch)
  const kept = start?.findings ?? []
  // The round and the record's generation this turn settles (A4): kept from the start, and read again after each await below.
  const generation = start?.generation ?? 0
  let linked: string[] = []
  const after = await patch($, run.id, one => {
    const ledger = mergeFindings(kept, one.findings)
    const applied = applyLinks(ledger, proposed, one.round, now)
    linked = applied.linked
    // What a link moved or raised joins the run, a finding only the record holds included, so the record takes it below.
    const changed = applied.findings.filter((f, i) => f !== ledger[i])
    return {
      ...one,
      pending: [],
      // A turn taken while collecting is in flight until this settles it (A4): polls only note arrivals meanwhile.
      isSettling: one.collect === undefined ? undefined : now,
      findings: mergeFindings(one.findings, changed).map(finding => {
        if (linked.includes(finding.id)) return finding
        const answer = said.find(each => each.id === finding.id)
        // Answered on its own: whatever link it had is dropped (R90), and the agent refuses the gate's link that way.
        return answer === undefined ? finding : applyAnswer(finding.duplicateOf === undefined ? finding : dropLink(finding), answer, one.round, 'main', now)
      }),
      steps: withStep(one.steps, {
        id: `r${one.round}-triage`,
        label: `Round ${one.round} · answer the reviews (main agent)`,
        state: 'done',
        detail: `${said.length + linked.length} answered`,
      }),
    }
  })
  if (after === null) return
  const isMid = after.collect !== undefined
  // A4: after each await, the run and the record must still be the ones this turn settles. A stop, a new round, a reset, or a poll
  // that cleared a stale settling flag means another path owns them now: this one writes nothing more.
  const isOwn = async (): Promise<boolean> => {
    const live = await getRun($)
    if (live === null || live.id !== run.id || live.status !== 'running' || live.round !== run.round) return false
    if (isMid && live.isSettling !== now) return false
    return ((await loadRecord($, run.root, run.branch))?.generation ?? 0) === generation
  }
  // Before anything can end the round: answered feedback is processed and its replies are known, so no reply is asked for twice.
  // Feedback still without an answer is not processed (R34): a later round asks again.
  const answered = (feedbackId: string): boolean => after.findings.some(f => f.externalId === feedbackId && (f.status !== 'open' || f.duplicateOf !== undefined))
  const triaged = (run.triaged ?? []).filter(answered)
  if (!(await isOwn())) return
  // Checked again under the record's lock: a reset since isOwn writes nothing into the new record, and this turn stands down.
  let isReset = false
  const rec = await updateRecord($, run.root, run.branch, one => {
    if ((one.generation ?? 0) !== generation) {
      isReset = true
      return one
    }
    return {
      ...one,
      ...withOwnReplies(one, run.pending[0]?.answer ?? ''),
      findings: mergeFindings(one.findings, after.findings),
      processed: [...new Set([...one.processed, ...triaged])],
      replies: {
        ...one.replies,
        ...Object.fromEntries(
          [...said, ...proposed.filter(each => linked.includes(each.id))].flatMap(each => {
            const externalId = after.findings.find(f => f.id === each.id)?.externalId
            return each.replyId === undefined || externalId === undefined ? [] : [[externalId, each.replyId]]
          }),
        ),
      },
    }
  })
  if (isReset) return
  if (rec === undefined) {
    // The record went while the answers were read (A4): stop with the reason, never leave a settling turn to freeze collection. Only
    // the run this turn settles is stopped; there is no record left whose generation could say more.
    const live = await getRun($)
    const isSame = live !== null && live.id === run.id && live.status === 'running' && live.round === run.round && (!isMid || live.isSettling === now)
    if (isSame) {
      await finish($, run.id, 'error', `The lifecycle record of ${run.branch} is gone, so post-PR round ${run.round} cannot go on. Run /pr-gate to start it again.`)
    }
    return
  }
  // An item left without an answer is asked about once more, as the fix step does (R34); one the person waived meanwhile is not.
  const waived = waivedIds(rec)
  const unanswered = (after.asked ?? []).filter(
    id => after.findings.some(f => f.id === id && f.status === 'open') && !said.some(each => each.id === id) && !linked.includes(id) && !waived.has(id),
  )
  if (unanswered.length > 0 && after.hasReprompted !== true) {
    const step = stepOf(after, 'triage')
    if (!(await isOwn())) return
    const asked = await patch($, run.id, one => ({
      ...one,
      hasReprompted: true,
      isSettling: undefined,
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
        `{"step":"${step}","dispositions":[{"id":"${unanswered[0]}","action":"fixed|rebutted|deferred|acknowledged","severity":"P2","note":"...","replyId":"123"}]}`,
    )
    return
  }
  const dirty = await git($, run.root, ['status', '--porcelain', '--untracked-files=no'])
  if (!(await isOwn())) return
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
  if (!(await isOwn())) return
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
  if (!(await isOwn())) return
  if (!isContained) {
    const by = await unpushedBy($, run.root)
    if (!(await isOwn())) return
    await failPost($, after, `commits on ${run.branch} are not on the PR${by}: pull or push, then /pr-gate resume`)
    return
  }
  const endHead = prHead
  // A turn while collecting that pushed nothing: the round goes on collecting on the same head (R88). Its rebuttals and
  // acknowledgements are checked when the head's collection ends.
  if (isMid && endHead === run.roundStartHead) {
    const back = await $.clock.now()
    await patch($, run.id, one => ({
      ...one,
      phase: 'collect',
      phaseStartedAt: back,
      activeMs: one.activeMs + (back - one.phaseStartedAt),
      pending: [],
      isSettling: undefined,
      hasReprompted: false,
      activity: 'waiting on reviewers…',
    }))
    $.ui.status(`pr-gate r${after.round}: waiting on reviewers`)
    return
  }
  // A push in a turn while collecting ends the round on the head it pushed (R88): collection on the old head is over. With `collect`
  // cleared, no poll runs for this round any more, so the awaits below need no settling flag.
  if (isMid) await closeCollect($, run.id, await $.clock.now(), `ended by the push of ${endHead.slice(0, 7)}`, { isSettling: undefined })
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
  // After `closeCollect` no settling flag guards the tail (no poll runs for the round): the run, its round and the record's generation do.
  if (ended === null || ended.id !== run.id || ended.status !== 'running' || ended.round !== run.round) return
  if (((await loadRecord($, run.root, run.branch))?.generation ?? 0) !== generation) return
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
  // A clean checkout behind the PR head catches up on its own (R71). A run stopped or waived before or during it goes no further (R80).
  if (!(await isRunning($, run.id))) return
  const isSynced = await syncToHead($, run.root, run.branch, run.headSha)
  if (!(await isRunning($, run.id))) return
  if (!isSynced) {
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
  if (saved === undefined) return
  // The whole standing, CI included (R79), as the report a round ends with lists it.
  const pr = saved.pr === undefined ? undefined : { number: saved.pr, baseRefName: saved.base, headRefOid: saved.head }
  const standing = pr === undefined ? undefined : await gatherStanding($, saved, pr)
  if (await isPostWaived($, saved)) return
  // A reset, stop or push while the standing was gathered supersedes this hold (gate G7-3).
  if (!(await isStillCurrent($, saved))) return
  await say($, saved, heldPrompt(saved, why, nextStep, standing))
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
    // Logged, not noted as an attempt: the round completes here, and an answer run's note would undo the round it answers.
    await logEvent($, run.root, run.branch, 'check', `Codex gave no readable verdict on ${owed.map(f => f.id).join(', ') || 'the reported fixes'}, twice; they stay owed`)
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
      // The agent's link (R90), first, whatever the item's status: agreed, it stands; refused, the item stands alone and is asked
      // about again, and a link to that original again is no answer. Never charged.
      if (isLinkOwed(f)) {
        return verdict.holds
          ? { ...f, isLinkChecked: true, history: [...f.history, { round: one.round, status: f.status, note: `Codex: the same problem as ${f.duplicateOf ?? '?'}`, by: 'codex', at: now }] }
          : refuseLink(f, one.round, now, verdict.note ?? 'Codex: a different problem')
      }
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
      // The agent's lowering of a deferral's severity (R85): agreed, it may settle; refused, it is the person's, with Codex's reason.
      if (isLoweringOwed(f)) return ruleLowering(f, verdict.holds, one.round, now, verdict.holds ? undefined : (verdict.note ?? 'no reason given'))
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
  if (after === null) return
  // Reported fixes Codex left out while ruling on others get the same one retry (R72): the verdicts in are kept, only these are asked again.
  const unruled = after.findings.filter(f => missing.includes(f.id) && f.status === 'reported-fixed' && !isReverifyOwed(f))
  if (run.hasRetriedCheck !== true && unruled.length > 0) {
    const again = await patch($, run.id, one => ({ ...one, hasRetriedCheck: true }))
    if (again !== null) await checkRebuttals($, again, unruled)
    return
  }
  await endRound($, after, true)
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
  // A run stopped or waived while this step awaited git or gh records nothing more and decides nothing (finding 29, R80).
  if (!(await isRunning($, run.id))) return
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
    let isGone = false
    await updateRecord($, run.root, run.branch, async rec => {
      // Read again under the record's lock: a stop or waiver given while this step awaited writes nothing (gate R3-3).
      if (!(await isRunning($, run.id))) {
        isGone = true
        return rec
      }
      return { ...rec, head: endHead, findings: mergeFindings(rec.findings, findings), effort: run.carriedEffort ?? run.effort }
    })
    // A stop given after the write, before the controller reads the record, decides nothing more (gate R3-3).
    if (isCompleted && !isGone && (await isRunning($, run.id))) await advance($, run.root, run.branch)
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
    // Only a round that could draw on the allowance says whether it did: baseline rounds, final-head checks and attempts never do.
    ...(run.lifecycle === 'post' && run.roundKind === 'discretionary' && isCompleted ? { isCharged: isChargedRound(run.findings, run.round) } : {}),
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
    const last = answersOf(one).at(-1)
    return one.status === 'verified-fixed' && last?.round === run.round && last.by === 'fix-reviewer' && run.headSha === endHead
  }
  // The head move is read from the record under its lock (R1-6), so a waiver given meanwhile is lapsed or kept, never lost.
  let isGone = false
  await updateRecord($, run.root, run.branch, async rec => {
    // Read again under the record's lock: a stop or waiver given while this step awaited the clock or git records no round (gate R3-3).
    if (!(await isRunning($, run.id))) {
      isGone = true
      return rec
    }
    const moved = isMoved
      ? await headMoved($, run.root, { ...rec, findings: mergeFindings(rec.findings, run.findings) }, run.roundStartHead, endHead, now)
      : undefined
    // Each finding keeps its line as placed at the end head (R73); only the re-check flag spares a fix verified at that head.
    const placed = new Map(moved?.findings.map(one => [one.id, one]) ?? [])
    const place = (one: Finding): Finding => {
      const at = placed.get(one.id)
      if (at === undefined) return one
      return {
        ...one,
        ...(at.needsRecheck === true && !isVerifiedAtEnd(at) ? { needsRecheck: true } : {}),
        ...(at.line === undefined ? {} : { line: at.line }),
        ...(at.lineHead === undefined ? {} : { lineHead: at.lineHead }),
      }
    }
    return {
      ...withRound(rec, round),
      head: endHead,
      findings: mergeFindings(rec.findings, run.findings).map(place),
      ...(moved === undefined ? {} : { waivers: moved.waivers }),
      effort: run.carriedEffort ?? run.effort,
    }
  })
  // A stop given after the write, before the controller reads the record, decides nothing more (gate R3-3).
  if (isCompleted && !isGone && (await isRunning($, run.id))) await advance($, run.root, run.branch)
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
  let rec = await loadRecord($, root, branch)
  if (rec === undefined) return
  // Every prompt the controller sends (open the PR, ready, held) comes from here: none while another session holds the record (#13).
  if (!(await isStillMine($, { root, branch }))) return
  // A post waiver covering this head ends review work for it (R80): checked before any branch that starts triage, a recheck or a round
  // (PR #19 review), so a waived head gets what the waiver covers and what CI still holds, never the hold or more review.
  const posts = rec.phase !== 'pre' && rec.pr !== undefined && securityHolds(rec).length === 0 ? rec.waivers.filter(one => one.scope === 'post') : []
  // GitHub's head, read once whenever a post waiver exists, decides: a waiver given while a round ran names the PR head, which the
  // record's head may not have reached (the late round records nothing), and a push by someone else after the waiver is not covered
  // by it (gate R1-1, R1-5). When gh cannot say, the record's head decides.
  const tip = rec.pr !== undefined && posts.length > 0 ? await prTipOf($, root, rec.pr) : undefined
  const at = tip?.head ?? rec.head
  if (rec.pr !== undefined && posts.some(one => one.head === at)) {
    const standing = await gatherStanding($, rec, { number: rec.pr, baseRefName: tip?.base ?? rec.base, headRefOid: at })
    if (!(await isStillCurrent($, rec))) return
    await say($, rec, `pr-gate: the person's post waiver covers PR #${rec.pr} at ${at.slice(0, 7)}.\n\n${holdText(standing)}`)
    return
  }
  // The waiver covers the checkout's head, but the PR moved past it: no review or waiver covers the PR's head yet.
  const recHead = rec.head
  if (rec.pr !== undefined && at !== recHead && posts.some(one => one.head === recHead)) {
    await say(
      $,
      rec,
      `pr-gate: the person's post waiver covers PR #${rec.pr} at ${rec.head.slice(0, 7)}, but the PR head is now ${at.slice(0, 7)}, ` +
        `which no review or waiver covers. The local checkout ${rec.head.slice(0, 7)} is not the PR head: pull (or push), then run /pr-gate resume.`,
    )
    return
  }
  // A deferral that settles once its issue carries the finding's peak severity is labelled first, every pass until it is (R85).
  const labelled = await labelDeferrals($, rec)
  if (labelled === undefined) return
  rec = labelled
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
      if (held !== undefined) await say($, saved, heldPrompt(saved, held.why, held.nextStep))
      return
    }
    if (config.openPr) {
      await markPr($, 'running', 'handed to the main agent')
      await say($, saved, prPrompt(ended, saved, next.status))
    }
    return
  }
  if (next.kind === 'ready') {
    // A resume of a ready lifecycle reads GitHub again: feedback that arrived since is triaged before it is ready again (R76).
    const late = isResume && id === undefined ? await untriagedFeedback($, rec) : undefined
    if (late !== undefined && late.length > 0) {
      await startLateTriage($, rec)
      return
    }
    const saved = await updateRecord($, root, branch, ifStill(one => ({ ...one, phase: 'ready', postStatus: undefined, message: undefined })))
    if (isStale) return advance($, root, branch, isResume)
    const at = (saved ?? rec).head.slice(0, 7)
    if (id !== undefined) await finish($, id, 'passed', `Lifecycle review complete at ${at}: ready for the merge decision.`)
    else if (saved !== undefined) await logEvent($, root, branch, 'end', `ready for the merge decision at ${at}`)
    if (saved !== undefined) await say($, saved, readyPrompt(saved))
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
    if (id !== undefined) await say($, saved, heldPrompt(saved, next.why, next.nextStep))
    return
  }
  const pr = saved.pr === undefined ? undefined : { number: saved.pr, baseRefName: saved.base, headRefOid: saved.head }
  const standing = pr === undefined ? undefined : await gatherStanding($, saved, pr)
  // A post waiver given while the standing was gathered covers this head: no hold after it (final review M1, R80).
  if (await isPostWaived($, saved)) return
  // So does a reset, a stop or a push in that time: the report is for a lifecycle that has moved on (gate G7-3).
  if (!(await isStillCurrent($, saved))) return
  await say($, saved, reportPrompt(saved, next, standing))
}

/** The colour of each severity label the gate makes on a follow-up's repository (R85). */
const LABEL_COLOURS: Record<Severity, string> = { P0: 'b60205', P1: 'd93f0b', P2: 'fbca04', P3: '0e8a16' }

/**
 * Labels the follow-up issue of each deferral that would settle with the highest severity its finding had (R85, Adam 2026-10-20),
 * once per peak: a peak that rose since adds the new label. The label is made first when the repository lacks it; a failed edit
 * is recorded on the finding, which holds the merge until a later pass labels it (fail closed). Only after the PR opens. Undefined
 * when the lifecycle was reset, replaced or stopped while gh ran: the caller decides nothing for it.
 */
export async function labelDeferrals($: Engine, rec: LifecycleRecord): Promise<LifecycleRecord | undefined> {
  if (rec.phase === 'pre') return rec
  const owed = rec.findings.filter(one => wouldSettle(one) && one.followUpLabel !== peakOf(one))
  if (owed.length === 0) return rec
  const gh = async (args: string[]): Promise<{ exitCode: number; stderr: string }> => {
    try {
      return await $.process.run(['gh', ...args], { cwd: rec.root, timeoutMs: 30_000 })
    } catch (e) {
      return { exitCode: 1, stderr: e instanceof Error ? e.message : String(e) }
    }
  }
  // A reset, a fresh lifecycle or a stop since this pass began ends it (gate G7-8, R8-2): checked before each issue and after its
  // gh calls, so no later issue is labelled and no log line lands in another lifecycle's log.
  const isMoved = (latest: LifecycleRecord | undefined): boolean =>
    latest === undefined || latest.phase === 'archived' || (latest.generation ?? 0) !== (rec.generation ?? 0) || latest.postStatus !== rec.postStatus
  const results = new Map<string, { followUp: string | undefined; peak: Severity; error?: string }>()
  // Logged with the results, in the same guarded write: a reset between a check and a log write of its own would put the line in
  // another lifecycle's log (gate R9-1).
  const lines: LogEntry[] = []
  for (const one of owed) {
    if (isMoved(await loadRecord($, rec.root, rec.branch))) return undefined
    const peak = peakOf(one)
    const issue = issueOf(one.followUp, rec.slug)
    if (issue === undefined) {
      results.set(one.id, { followUp: one.followUp, peak, error: 'no repository is known for this issue' })
      continue
    }
    const label = `severity:${peak}`
    // Made only when missing: an existing label's colour and description are the repository's (gate R7-7). gh refuses one that
    // exists; the edit below reports any real failure.
    await gh(['label', 'create', label, '--repo', issue.repo, '--color', LABEL_COLOURS[peak]])
    if (isMoved(await loadRecord($, rec.root, rec.branch))) return undefined
    const edit = await gh(['issue', 'edit', String(issue.number), '--repo', issue.repo, '--add-label', label])
    results.set(one.id, { followUp: one.followUp, peak, ...(edit.exitCode === 0 ? {} : { error: (edit.stderr.trim() || `gh exited ${edit.exitCode}`).slice(0, 200) }) })
    if (isMoved(await loadRecord($, rec.root, rec.branch))) return undefined
    const text = edit.exitCode === 0 ? `${one.id}: labelled ${issue.repo}#${issue.number} ${label}` : `${one.id}: could not label ${issue.repo}#${issue.number} ${label}`
    lines.push({ at: await $.clock.now(), kind: 'check', text: text.slice(0, 300) })
  }
  // And on the write itself: nothing is written, and nothing is decided (gate G7-8, R7-4).
  let isSuperseded = false
  // Written only where the follow-up and peak are still the ones labelled: a later answer that moved either is labelled anew.
  const saved = await updateRecord($, rec.root, rec.branch, latest => {
    isSuperseded = isMoved(latest)
    if (isSuperseded) return latest
    const findings = latest.findings.map(f => {
      const got = results.get(f.id)
      if (got === undefined || got.followUp !== f.followUp || got.peak !== peakOf(f)) return f
      return got.error === undefined ? { ...f, followUpLabel: got.peak, followUpLabelError: undefined } : { ...f, followUpLabelError: got.error }
    })
    return { ...latest, findings, log: [...(latest.log ?? []), ...lines].slice(-LOG_CAP) }
  })
  return isSuperseded ? undefined : (saved ?? rec)
}

/** Whether a post waiver now covers the record's head, read afresh: what a hold sent after a slow gather checks first (M1). */
async function isPostWaived($: Engine, rec: LifecycleRecord): Promise<boolean> {
  const latest = await loadRecord($, rec.root, rec.branch)
  return latest !== undefined && latest.waivers.some(one => one.scope === 'post' && one.head === rec.head) && securityHolds(latest).length === 0
}

/**
 * Whether `rec` is still the branch's live lifecycle, at the same head and state, read afresh. A report or note gathered over a slow
 * await is dropped once a reset archived the record, a fresh lifecycle replaced it, or a push, a stop or a new round moved it on: the
 * queue's drop cannot reach work still awaiting (gate G7-3).
 */
export async function isStillCurrent($: Engine, rec: LifecycleRecord): Promise<boolean> {
  const latest = await loadRecord($, rec.root, rec.branch)
  return (
    latest !== undefined &&
    latest.phase !== 'archived' &&
    (latest.generation ?? 0) === (rec.generation ?? 0) &&
    latest.head === rec.head &&
    latest.pr === rec.pr &&
    latest.postStatus === rec.postStatus &&
    latest.rounds.length === rec.rounds.length &&
    latest.rounds[0]?.startedAt === rec.rounds[0]?.startedAt
  )
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
        peakSeverity: one.severity,
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
  const answer = run.pending[0]?.answer ?? ''
  const said = readDispositions(answer)
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
  if (replyIdsOf(answer).length > 0) await updateRecord($, run.root, run.branch, one => ({ ...one, ...withOwnReplies(one, answer) }))
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
  // A result that lands after another session took the record over is not this session's to act on (#13).
  if (!(await isStillMine($, run))) return
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
