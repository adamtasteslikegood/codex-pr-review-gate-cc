// pr-lifecycle: /pr-gate across the PR lifecycle. Rounds of adversarial Codex
// review and agent fixes run locally before a pull request to a gated base is
// opened, on one review allowance kept in the lifecycle record.
//
// round.ts runs a round as a state machine the host keeps in `$.state`, and holds
// the controller (`advance`), which reads the record after each round and does
// what `decideNext` says. Here are the hooks, the guard, the command and the pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Finding, LifecycleRecord, Run, Standing } from '../types'
import { activityOf, classify, isVersionOnly, lowerOf, mergeStep, prePerson, prPrompt, readGitlinks, slugOf, stepDown } from './core'
import { hasOtherSteps, readPrAction } from './github'
import type { PrAction } from './github'
import {
  allowanceFor,
  isAcceptedRebuttal,
  isDisputed,
  lastReviewedHead,
  holdText,
  isReverifyOwed,
  isFileable,
  isSettledByIssue,
  issueLine,
  scopeNote,
  mergeHolds,
  reverifyOwed,
  newRecord,
  remaining,
  rescope,
  securityHolds,
  logSummary,
  ticketLine,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
} from './lifecycle'
import {
  advance,
  archiveLifecycle,
  awaitsLate,
  badOptionsNote,
  claimRecord,
  closeLifecycle,
  configFor,
  configOf,
  defaultEffort,
  dropQueued,
  fetchTwice,
  finish,
  gatherStanding,
  getRun,
  git,
  hasSecurityBlocker,
  headMoved,
  heldNoteOf,
  heldReason,
  holdingPrompts,
  ignoredNote,
  isLiveNow,
  isMergeBlocked,
  isOwnedElsewhere,
  isStillCurrent,
  isStoodDownBy,
  isTurnOf,
  markPr,
  noteArrival,
  noteSeen,
  onAnswer,
  onTurnStart,
  PANE,
  patch,
  prStateOf,
  say,
  securityBlockedIds,
  setLive,
  setSession,
  setup,
  startTicker,
  startWatcher,
  tellAgent,
  untriagedFeedback,
} from './round'
import type { Config, RecordKey } from './round'
import { renderPane } from './pane'
import { latestArchive, liveRecords, loadRecord, logEvent, transact, updateRecord, upsertRecord } from './store'

const COMMAND = 'pr-gate'
// The same state round.ts writes: the engine reads an atom only where this file makes it.
const runAtom = atom({ plugin: 'pr-lifecycle', key: 'run' } as const, null)
const tickAtom = atom({ plugin: 'pr-lifecycle', key: 'tick' } as const, 0)

type Engine = EngineInterface

// The module's own: what `register` was last given.
let config: Config = configOf({})

/** The run a pass-through shows in the pane: no round runs, so it is ended from the start. */
/** `c` is the base's settings (configFor), for the tier's own effort (R69). */
const passThroughRun = (rec: LifecycleRecord, cwd: string, now: number, c: Config): Run => ({
  id: `${now}`,
  cwd,
  root: rec.root,
  branch: rec.branch,
  base: rec.base,
  headSha: rec.head,
  tier: rec.tier,
  tierWhy: rec.tierWhy,
  lane: rec.lane,
  effort: rec.effort ?? defaultEffort(rec, c),
  round: 0,
  status: 'passed',
  phase: 'done',
  lifecycle: 'pre',
  roundKind: 'discretionary',
  roundStartHead: rec.head,
  roundStartedAt: now,
  diffBase: `origin/${rec.base}`,
  evidence: [],
  activeMs: 0,
  waitMs: 0,
  hasRefixed: false,
  fixKind: 'blocking',
  steps: [
    { id: 'scope', label: 'Scope & blast radius', state: 'done', detail: `${rec.tier}${rec.lane === 'light' ? ', light lane' : ''}: ${rec.tierWhy}` },
    { id: 'r1-review', label: 'Codex review', state: 'skipped', detail: rec.tierWhy },
    { id: 'pr', label: `Open PR → ${rec.base}`, state: 'pending' },
  ],
  findings: [],
  pending: [],
  activity: '',
  startedAt: now,
  phaseStartedAt: now,
  endedAt: now,
  message: `Codex skipped: ${rec.tierWhy}.`,
})

/** The run an open-PR prompt is written from when no run is live: a waiver let the pre-PR gate pass (R48). */
const settledRun = (rec: LifecycleRecord, now: number): Run => ({
  ...passThroughRun(rec, rec.root, now, config),
  headSha: rec.preHead ?? rec.head,
  round: rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).length,
  findings: rec.findings,
  message: undefined,
})

/** A repository file's ignored keys (R67), said once in the pane's scope step, where the person sees them. */
const withScopeNote = (run: Run, note: string): Run =>
  note === '' ? run : { ...run, steps: run.steps.map(one => (one.id === 'scope' ? { ...one, detail: `${one.detail ?? ''}.${note}` } : one)) }

/** Sends the agent to open the PR, once the person's waiver let the pre-PR gate pass; through the command's prompt queue. */
const sayOpenPr = async ($: Engine, rec: LifecycleRecord, status: 'passed' | 'waived', now: number, waivedNote?: string): Promise<void> => {
  if (config.openPr) await say($, rec, prPrompt(settledRun(rec, now), rec, status, waivedNote))
}

// ------------------------------------------------------------ starting

type OpenPr = { number: number; baseRefName: string; headRefName: string; headRefOid: string }

/** The open PR from a branch, as gh reports it; undefined when there is none or gh cannot say. */
const openPrOf = async ($: Engine, root: string, branch: string): Promise<OpenPr | undefined> => {
  const view = await $.process.run(['gh', 'pr', 'view', branch, '--json', 'number,state,baseRefName,headRefName,headRefOid'], {
    cwd: root,
    timeoutMs: 30_000,
  })
  if (view.exitCode !== 0) return undefined
  try {
    const pr = JSON.parse(view.stdout) as Record<string, unknown>
    const isOurs = pr.state === 'OPEN' && pr.headRefName === branch
    return isOurs && typeof pr.number === 'number' && typeof pr.baseRefName === 'string' && typeof pr.headRefOid === 'string'
      ? { number: pr.number, baseRefName: pr.baseRefName, headRefName: branch, headRefOid: pr.headRefOid }
      : undefined
  } catch {
    return undefined
  }
}

/** This machine's gh login and the repository's slug, kept so post-PR rounds read the right PR and skip their own replies. */
const identityOf = async ($: Engine, root: string): Promise<{ self?: string; slug?: string }> => {
  const self = await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { cwd: root, timeoutMs: 30_000 })
  const origin = await git($, root, ['remote', 'get-url', 'origin'])
  const login = self.exitCode === 0 ? self.stdout.trim() : ''
  const slug = origin.isOk ? slugOf(origin.out) : undefined
  return { ...(login === '' ? {} : { self: login }), ...(slug === undefined ? {} : { slug }) }
}

/** The start of what `startGate` says when a fetch failed twice (R1-10): a held create says so instead of promising a review. */
const NOT_FETCHED = 'Not started: git could not fetch'

type NotFetched = { notFetched: string }

/** A fetch failed twice: no round starts, and the agent and the status line are told why. The next start fetches again. */
const notFetched = ($: Engine, what: string, err: string): NotFetched => {
  $.ui.status(`pr-gate: could not fetch ${what}`)
  return {
    notFetched:
      `${NOT_FETCHED} ${what}, twice: ${err}. Nothing is reviewed against a stale base; ` +
      `the next /${COMMAND} or pull request create fetches again.`,
  }
}

const isNotFetched = (value: unknown): value is NotFetched => typeof value === 'object' && value !== null && 'notFetched' in value

/**
 * The repository's default branch, which GitHub opens a PR against when the create names no base (R1-5): `gh repo view` in the
 * checkout, or for the repository the call names. `err` says why when gh cannot tell.
 */
const defaultBranchOf = async ($: Engine, root: string, repo?: string): Promise<{ name?: string; err: string }> => {
  try {
    const ran = await $.process.run(['gh', 'repo', 'view', ...(repo === undefined ? [] : [repo]), '--json', 'defaultBranchRef'], {
      cwd: root,
      timeoutMs: 30_000,
    })
    const name = ran.exitCode === 0 ? (JSON.parse(ran.stdout) as { defaultBranchRef?: { name?: unknown } } | null)?.defaultBranchRef?.name : undefined
    if (typeof name === 'string' && name !== '') return { name, err: '' }
    return { err: ran.stderr.trim().slice(0, 200) || `gh repo view printed no default branch (exit ${ran.exitCode})` }
  } catch (error) {
    return { err: (error instanceof Error ? error.message : String(error)).slice(0, 200) }
  }
}

const startGate = async ($: Engine, want: { base?: string; cwd?: string; isHeldCall?: boolean; isRescoped?: boolean }): Promise<string> => {
  const existing = await getRun($)
  if (existing !== null && existing.status === 'running') {
    return `The gate is already running for ${existing.branch} (round ${existing.round}).`
  }
  const top = await git($, want.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return 'Not started: this is not a git repository.'
  const root = top.out
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  if (branch === '' || branch === 'HEAD') return 'Not started: HEAD is detached, so there is no branch to open a PR from.'
  // A start or a resume takes the record for this session (#13); a headless one never takes it from another.
  if (!(await claimRecord($, root, branch))) return `Not started: ${heldNoteOf() ?? 'another session runs this lifecycle'}.`
  const known = await loadRecord($, root, branch)
  // A PR merged or closed since: nothing more to review on it, and its record is archived (R62).
  const isOpened = known !== undefined && (known.phase === 'post' || known.phase === 'ready') && known.pr !== undefined
  const state = isOpened ? await prStateOf($, root, known.pr ?? 0) : undefined
  if (state === 'MERGED' || state === 'CLOSED') return `${await closeLifecycle($, root, branch, known?.pr, state)}. Nothing to review.`
  // An open PR's base is fixed: a resume or a bare /pr-gate keeps it. Before the PR, no base named keeps the record's own.
  const isKept = known !== undefined && known.phase !== 'archived' && (known.phase !== 'pre' || want.base === undefined)
  // No base named and none kept: the one a PR with no base opens against, the repository's default branch (R1-5).
  const found = isKept || want.base !== undefined ? undefined : await defaultBranchOf($, root)
  if (found !== undefined && found.name === undefined) {
    return `Not started: gh could not read the repository's default branch (${found.err}). Name the base: /${COMMAND} <base>.`
  }
  const base = isKept ? known.base : (want.base ?? found?.name ?? '')
  if (branch === base) return `Not started: you are on ${base} itself. Check out the branch the PR will come from.`
  const fetched = await fetchTwice($, root, ['origin', base], 120_000)
  if (!fetched.isOk) return notFetched($, `origin/${base}`, fetched.err).notFetched
  $.ui.status(undefined)
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
  if (isNotFetched(settled)) return settled.notFetched
  const landedOn = await isAlreadyOnBase($, root, base)
  if (isNotFetched(landedOn)) return landedOn.notFetched
  // The tier, lane and allowance follow the base's own .github/pr-gate.json, just fetched, never the branch's (R67).
  const { config: settings, ignored } = await configFor($, root, base)
  const note =
    (ignored.length === 0 ? '' : ` ${ignoredNote(base, ignored)}`) + (settings.badOptions.length === 0 ? '' : ` ${badOptionsNote(settings.badOptions)}`)
  const scope =
    landedOn !== undefined
      ? { tier: 'trivial' as const, why: `already reviewed: every commit is on ${landedOn}` }
      : classify(files, lines, settings.highRisk, settled)
  // A high blast radius takes the full lane whatever the branch is called (finding 4).
  const lane = scope.tier !== 'high' && settings.light !== undefined && settings.light.test(branch) ? ('light' as const) : ('full' as const)
  // Each tier starts at its own effort, as the base's settings say (R69): highEffort, lightEffort on a light-lane branch, else reviewEffort.
  const startEffort: Effort = defaultEffort({ tier: scope.tier, lane }, settings)
  const now = await $.clock.now()
  const allowance = allowanceFor(scope.tier, lane, settings.allowances)
  // Read, rebuilt and written under the record's lock (R1-6): a waiver or grant given meanwhile is not overwritten. Only git and gh
  // run inside it; the controller runs after.
  const made = await transact($, root, branch, async tx => {
    const prior = await tx.load()
    // The branch's last run timed out at its lowest step: this one starts a level below where that one ended.
    // Otherwise it starts no higher than the effort a review last completed at on this branch.
    const afterTimeout = prior?.hasTimedOut === true && prior.effort !== undefined ? (stepDown(prior.effort) ?? 'low') : startEffort
    const effort = lowerOf(lowerOf(startEffort, afterTimeout), prior?.passedEffort ?? startEffort)
    const kept: LifecycleRecord | undefined =
      prior !== undefined && prior.phase !== 'archived'
        ? {
            ...prior,
            head,
            base,
            ...(prior.phase === 'ready' && prior.head !== head ? { phase: 'post' as const } : {}),
            // A pre-PR verdict was about the old head: the new run's own outcome replaces it (R57).
            // So was one about another base: a pass against dev does not open a PR against main.
            ...(prior.phase === 'pre' && (prior.head !== head || prior.base !== base) ? { preStatus: undefined, preHead: undefined } : {}),
            postStatus: undefined,
          }
        : undefined
    let rec: LifecycleRecord =
      kept !== undefined && prior !== undefined
        ? {
            // Another base is a new scope (R67, C1): its own file sets tier, lane and allowance, up or down; the rounds used still count.
            // The same base only rescopes upward.
            ...(prior.base === base
              ? rescope(kept, scope.tier, scope.why, settings.allowances)
              : { ...kept, tier: scope.tier, tierWhy: scope.why, lane, allowance }),
            effort,
            // A pass-through that now needs Codex is one no longer; on a new base, a trivial change is one.
            ...(scope.tier !== 'trivial' ? { passThrough: undefined } : prior.base === base ? {} : { passThrough: scope.why }),
          }
        : {
            ...newRecord({ root, branch, base, head, tier: scope.tier, tierWhy: scope.why, lane, allowance, at: now }),
            // After a reset: feedback already processed and replied to stays answered (R47).
            ...(prior === undefined ? {} : { processed: prior.processed, replies: prior.replies, ownReplies: prior.ownReplies, generation: prior.generation }),
            // When the head reached the PR (#24) carries over only for that same head.
            ...(prior?.headArrival?.head === head ? { headArrival: prior.headArrival } : {}),
            effort,
            ...(scope.tier === 'trivial' ? { passThrough: scope.why } : {}),
          }
    // A new head since the last reviewed one (R56): answered findings on a changed file need a re-check, and their waivers lapse.
    if (prior !== undefined && prior.head !== head) rec = { ...rec, ...(await headMoved($, root, rec, lastReviewedHead(prior), head, now)) }
    // A PR the gate never saw opened (opened by hand, or before this mod): adopt it straight into post-PR review.
    const open = prior === undefined || prior.phase === 'pre' || prior.phase === 'archived' ? await openPrOf($, root, branch) : undefined
    // An open PR on another base than this scope's: nothing is saved, and the gate scopes again against the PR's own base (R67, C1).
    if (open !== undefined && config.bases.includes(open.baseRefName) && open.baseRefName !== base) {
      return { prior, rec, adopted: undefined, rebase: open.baseRefName }
    }
    if (open !== undefined && config.bases.includes(open.baseRefName)) {
      const adoptedRec: LifecycleRecord = {
        ...rec,
        ...(await identityOf($, root)),
        phase: 'post',
        base: open.baseRefName,
        pr: open.number,
        passThrough: undefined,
      }
      await tx.save(adoptedRec)
      return { prior, rec: adoptedRec, adopted: open, rebase: undefined }
    }
    await tx.save(rec)
    return { prior, rec, adopted: undefined, rebase: undefined }
  }).catch(async (error: unknown) => {
    // The shared store would not take the start (Task 8): a stale commit, another session's lease, a moved record or a refusal.
    // This session stands down with a log line, and starts nothing.
    if (await isStoodDownBy($, { root, branch }, error)) return undefined
    throw error
  })
  if (made === undefined) return `Not started: ${heldNoteOf() ?? 'another session runs this lifecycle'}.`
  const { prior, rec, adopted, rebase } = made
  // One rescope only: a PR whose base moved again meanwhile is not chased; the next /pr-gate scopes against where it settled.
  if (rebase !== undefined && want.isRescoped === true) {
    return `The open PR from ${branch} moved to ${rebase} while the gate was scoping it: nothing was saved; run /pr-gate again.`
  }
  if (rebase !== undefined) return startGate($, { ...want, base: rebase, isRescoped: true })
  if (adopted !== undefined) {
    await advance($, root, branch)
    // The pane's scope step names what the base's file got wrong, as on any other start (gate R3-1).
    if (note !== '') {
      await update($, runAtom, run => (run !== null && run.root === root && run.branch === branch ? withScopeNote(run, note) : run))
    }
    return (
      `PR #${adopted.number} from ${branch} to ${adopted.baseRefName} is already open: adopted into post-PR review, ` +
      `${remaining(rec)} of ${rec.allowance} review rounds left.${note}`
    )
  }
  // After the PR opened, a trivial record goes through the controller like any other: a resume then triages late feedback (R76).
  if (rec.tier === 'trivial' && rec.phase === 'pre') {
    // A pass-through runs no round: the pane shows it passed, and the held call goes straight through.
    const shown = withScopeNote(passThroughRun(rec, want.cwd ?? root, now, settings), note)
    await update($, runAtom, () => shown)
    setLive(false)
    void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
    await advance($, root, branch)
    const saved = await loadRecord($, root, branch)
    if (want.isHeldCall !== true && config.openPr && saved !== undefined) {
      await markPr($, 'running', 'handed to the main agent')
      await say($, saved, prPrompt(shown, saved, 'passed'))
    }
    return `Gate passed without Codex: ${scope.why}.${note}`
  }
  await advance($, root, branch, want.isHeldCall !== true)
  const run = note === '' ? await getRun($) : await patch($, (await getRun($))?.id ?? '', one => withScopeNote(one, note))
  if (run === null || run.status !== 'running') {
    const after = (await loadRecord($, root, branch)) ?? rec
    const said = after.message === undefined ? '' : ` (${after.message})`
    // After the PR opened, the post-PR review's standing is the one that counts (M3).
    const stands =
      after.phase === 'pre'
        ? `the pre-PR gate stands at ${after.preStatus ?? 'not run'}${said}`
        : `the post-PR review of PR #${after.pr ?? '?'} stands at ${after.phase === 'ready' ? 'ready' : (after.postStatus ?? 'in progress')}` +
          `${after.phase === 'ready' ? '' : said}`
    return `Nothing to review for ${branch} at ${head.slice(0, 7)}: ${stands}, ${remaining(after)} of ${after.allowance} review rounds left.${note}`
  }
  const tierNote = rec.tier === 'high' ? ' Review and challenge run in parallel, and fixes are reviewed before each new round.' : ''
  const lightNote = rec.lane === 'light' ? ` Light lane: ${branch} matches lightBranches.` : ''
  return (
    `Lifecycle ${prior === undefined ? 'started' : 'resumed'} for ${branch} → ${base}: ${rec.tier} blast radius (${rec.tierWhy}), ` +
    `Codex${run.codexModel === undefined ? '' : ` ${run.codexModel}`} at ${run.effort} effort, ${remaining(rec)} of ${rec.allowance} review rounds left.` +
    `${tierNote}${lightNote}${note}`
  )
}

/**
 * Changed files whose content was reviewed elsewhere: a submodule pointer to a commit
 * already on that submodule's origin/main or origin/dev, and a package.json or lock change
 * that touches only "version" lines. A pointer to an unlanded commit is not settled.
 */
const settledFiles = async ($: Engine, root: string, base: string, files: readonly string[]): Promise<string[] | NotFetched> => {
  const out: string[] = []
  const raw = await git($, root, ['diff', '--raw', `origin/${base}...HEAD`])
  for (const link of raw.isOk ? readGitlinks(raw.out) : []) {
    const at = `${root}/${link.path}`
    // One ref at a time: a submodule whose origin has no dev still fetches its main.
    for (const ref of ['main', 'dev']) {
      const fetched = await fetchTwice($, at, ['origin', ref], 120_000)
      if (!fetched.isOk) return notFetched($, `origin/${ref} in ${link.path}`, fetched.err)
    }
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
const isAlreadyOnBase = async ($: Engine, root: string, base: string): Promise<string | NotFetched | undefined> => {
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
    const fetched = await fetchTwice($, root, ['origin', other], 120_000)
    if (!fetched.isOk) return notFetched($, `origin/${other}`, fetched.err)
    // A back-sync can be one clean merge and nothing else: every commit it brings is on the other base.
    const left = await git($, root, ['rev-list', '--no-merges', `origin/${base}..HEAD`, `^origin/${other}`])
    if (left.isOk && left.out === '') return `origin/${other}`
  }
  return undefined
}


// ---------------------------------------------------------- the guards

/**
 * Outside a checkout, an action that names a PR number or a repository, or comes from a GitHub MCP tool, can reach a gated PR the
 * guard cannot check: it is held, never let through (R61). A plain gh call outside a checkout names no repository gh can act on.
 */
const isOutsideHeld = (action: PrAction): boolean => action.number !== undefined || action.repo !== undefined || action.via.startsWith('mcp__')

const outsideText = (action: PrAction): string =>
  [
    `pr-gate: ${action.via} is held: it does not run inside a git checkout, so the guard cannot check the pull request's lifecycle review.`,
    `Your next step: run it from the repository's checkout so the gate can check it. Do not ${action.action === 'merge' ? 'merge' : 'open'} it another way.`,
  ].join('\n') + unknownNote(action)

type Gated = { root: string; branch: string; base: string }

/** A create whose head is a branch other than the one checked out here (R98). */
type Elsewhere = { head: string; branch: string }

/**
 * The checked-out branch a create is for, when it is this gate's to review; 'outside' when it must be held unchecked (R61);
 * `noBase` when it names no base and gh cannot read the default branch it would open against (R1-5); `head` when it names a head
 * that is not checked out here, so the gate cannot review it (R98); else undefined.
 */
const gatedCreate = async ($: Engine, action: PrAction): Promise<Gated | 'outside' | { noBase: string } | Elsewhere | undefined> => {
  if (action.base !== undefined && !config.bases.includes(action.base)) return undefined
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return isOutsideHeld(action) ? 'outside' : undefined
  const root = top.out
  if (action.repo !== undefined) {
    const origin = await git($, root, ['remote', 'get-url', 'origin'])
    if (origin.isOk && slugOf(origin.out) !== slugOf(action.repo)) return undefined
  }
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const head = action.head?.replace(/^[^:]+:/, '')
  // A promotion between gated bases (dev into main) carries only what was gated on its way in.
  if (config.bases.includes(head ?? branch)) return undefined
  // Any other head that is not checked out here is held, never let through: a branch pushed under another name opened PR #32
  // with no review (R98, #34). The gate reviews only the branch it can see, so the create is run from that branch.
  if (head !== undefined && head !== branch) return { head, branch }
  if (action.base !== undefined) return { root, branch, base: action.base }
  // Only gh pr create may leave the base out: REST, GraphQL and the MCP tools require one, so there a missing base is one this mod
  // could not read, and the create is held against the first gated base, as before R1-5.
  if (action.via !== 'gh pr create') return { root, branch, base: config.bases[0] ?? 'dev' }
  // No base named: GitHub opens it against the default branch, so that is the base the gate checks (R1-5).
  const found = await defaultBranchOf($, root, action.repo)
  if (found.name === undefined) return { noBase: found.err }
  return config.bases.includes(found.name) ? { root, branch, base: found.name } : undefined
}

const noBaseText = (action: PrAction, err: string): string =>
  [
    `pr-gate: ${action.via} is held: it names no base, and gh could not read the repository's default branch (${err}), ` +
      'so the guard cannot tell which base the pull request would open against.',
    'Your next step: run it again with the base named (--base <branch>, or the base field of the tool). Do not create the pull request another way.',
  ].join('\n') + unknownNote(action)

const elsewhereText = (action: PrAction, found: Elsewhere): string =>
  [
    `pr-gate: ${action.via} is held: it opens a pull request from ${found.head}, but this checkout has ${found.branch} checked out, ` +
      'so the gate cannot review what that pull request would carry.',
    `Your next step: check out a local branch named ${found.head} that holds these commits (git branch -m ${found.head}, or ` +
      `git switch ${found.head}), then run the create again from it so its gate reviews it. Do not open the pull request another way.`,
  ].join('\n') + unknownNote(action)

/** Why an unknown tool is held: said after the refusal, so the agent knows it was not misread as something else. */
const unknownNote = (action: PrAction): string =>
  action.isUnknown === true
    ? `\n(pr-gate does not know ${action.via}; it reads as ${action.action === 'create' ? 'opening' : 'merging'} a pull request, ` +
      `so it is held like gh pr ${action.action}.)`
    : ''

/** Whether a PR to a gated base may be opened now; a refusal starts the gate. */
const judgeCreate = async ($: Engine, action: PrAction, gated: { root: string; branch: string; base: string }): Promise<string | undefined> => {
  const { root, branch, base } = gated
  const head = (await git($, root, ['rev-parse', 'HEAD'])).out
  // The base's own settings (R67), from the ref the last fetch left: a create is no reason to fetch.
  const settings = (await configFor($, root, base)).config
  const allows = (one: LifecycleRecord | undefined, s: Config = settings): one is LifecycleRecord =>
    one !== undefined &&
    // A reset record lets nothing through: the lifecycle starts fresh.
    one.phase !== 'archived' &&
    // A verdict or waiver is about the base it was given for: a pass against dev opens no PR against main.
    one.base === base &&
    // A pre waiver never releases a security blocker: only a waiver naming it does (R54).
    // A pre waiver covers the commit and the base it was given for, whatever round runs against another base since (R1-1).
    ((one.waivers.some(each => each.scope === 'pre' && each.head === head && each.base === base) && !hasSecurityBlocker(one)) ||
      (one.preStatus === 'passed' && !hasSecurityBlocker(one)) ||
      (one.preStatus === 'exhausted' && s.onExhausted === 'open-pr' && !hasSecurityBlocker(one)))
  const rec = await loadRecord($, root, branch)
  // Only open-pr lets an exhausted gate open the PR, and that is the base's to say: before it does, the base is fetched, so a stop
  // that just landed holds it (gate R3-2). A fetch that fails decides nothing here: the gate below fetches again and holds on failure.
  const stopped: Config = { ...settings, onExhausted: 'stop' }
  const onlyExhausted = allows(rec) && !allows(rec, stopped)
  const now = !onlyExhausted
    ? settings
    : (await git($, root, ['fetch', '--quiet', 'origin', base], 60_000)).isOk
      ? (await configFor($, root, base)).config
      : stopped
  if (allows(rec, now) && rec.preHead === head) return undefined
  if (allows(rec, now) && rec.preHead !== undefined) {
    // Commits since the gate finished: docs alone (a CHANGELOG line) ride on its verdict; code does not.
    const since = await git($, root, ['diff', '--numstat', rec.preHead, 'HEAD'])
    const files = since.out === '' ? [] : since.out.split('\n').map(line => line.split('\t')[2] ?? '')
    if (since.isOk && files.length > 0 && classify(files, 0, now.highRisk).tier === 'trivial') {
      await updateRecord($, root, branch, one => ({ ...one, preHead: head }), { isPure: true })
      return undefined
    }
  }
  const started = await startGate($, { base, cwd: root, isHeldCall: true })
  // A fetch that failed twice started no round (R1-10): the create is held, and nothing will prompt the agent, so it is told.
  if (started.startsWith(NOT_FETCHED)) {
    return [
      `pr-gate: ${action.via} to ${base} is held for ${branch} at ${head.slice(0, 7)}: ${started.slice('Not started: '.length)}`,
      'Your next step: check the network and the origin remote, then run the create again. Do not create the pull request another way.',
    ].join('\n') + unknownNote(action)
  }
  // A change Codex is not needed for passes at once: the held call goes straight through.
  const after = await loadRecord($, root, branch)
  // One read decides the rest of this create (M2): the record's base, as the gate just fetched it.
  const fresh = (await configFor($, root, after?.base ?? base)).config
  if (allows(after, fresh) && after.preHead === head) return undefined
  const held = after === undefined || (await getRun($))?.status === 'running' ? undefined : heldReason(after, fresh.onExhausted)
  const person = after === undefined ? undefined : prePerson(after)
  if (held !== undefined) {
    // No round started: the PR stays held for a settled reason, and waiting will not change it.
    return [
      `pr-gate: ${action.via} to ${base} is held for ${branch} at ${head.slice(0, 7)}: ${held.why}.`,
      `Your next step: ${held.nextStep}. Do not create the pull request another way.`,
      // The person is named only where the decision is theirs (R49).
      ...(person === undefined ? [] : [`Tell the person why it is held. ${person}`]),
    ].join('\n') + unknownNote(action)
  }
  return (
    [
      `pr-gate: ${action.via} to ${base} waits for the pre-PR review of ${branch} at ${head.slice(0, 7)}.`,
      started,
      'Do not retry this command and do not open the pull request another way.',
      'Next: the gate. A Codex round is running on this branch. Leave this branch alone (no commits, no pushes) until the gate sends you ' +
        'findings to fix or tells you to open the pull request; other work is fine.',
      `(The person can type /${COMMAND} status, or /${COMMAND} waive pre <reason> to open it without the gate.)`,
    ].join('\n') + unknownNote(action)
  )
}

/**
 * A refusal reaches the agent as a failed tool call. It says first that it is a hold, not an error (finding 7): agents read a
 * plain refusal as something broken and work around it.
 */
function asHold(text: string): string {
  return text.startsWith('pr-gate: ') ? `pr-gate HOLD (not an error): ${text.slice('pr-gate: '.length)}` : `pr-gate HOLD (not an error): ${text}`
}

/** The line a hold on a chained Bash command ends with (R87): nothing in it ran, so the agent redoes the other steps on their own. */
const CHAINED =
  '\nNothing in this Bash command ran: a hold refuses the whole command, so the steps chained with the PR command did not run either. ' +
  'Run those on their own (write a PR body file with the Write tool), and keep the PR command in a Bash call by itself.'

/** What a refusal adds for this call: the R87 line when it is a Bash command with other steps. */
const chainedOf = (tool: string, e: unknown): string => {
  const command = (e as Record<string, unknown>).command
  return tool === 'Bash' && typeof command === 'string' && hasOtherSteps(command) ? CHAINED : ''
}

/** What still stands between a record and ready, in a few words. */
const HOLD: Record<string, string> = {
  open: 'unresolved',
  deferred: 'deferred',
  'reported-fixed': 'fixed, not verified',
  rebutted: 'rebuttal not accepted by Codex',
}

const owedOf = (rec: LifecycleRecord): string => {
  const post = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)
  const open = unresolvedBlockers(rec)
  if (rec.phase === 'pre') return 'the PR is still in pre-PR review'
  // Every finding that holds the merge, named, whatever its severity (R39).
  const said = (one: Finding): string => (isDisputed(one) ? 'disputed: the person decides' : (HOLD[one.status] ?? one.status))
  // A verified fix whose file changed since is named as such (R58).
  const holding = mergeHolds(rec).map(one => (isReverifyOwed(one) ? reverifyOwed(one) : `${one.id} [${one.severity}] ${said(one)}`))
  if (rec.postStatus !== undefined) return `${rec.postStatus}: ${rec.message ?? 'no reason recorded'}${holding.length === 0 ? '' : `; ${holding.join(', ')}`}`
  if (holding.length > 0 && (rec.phase === 'ready' || post.length > 1 || mergeHolds(rec).some(isReverifyOwed))) return holding.join(', ')
  if (post.length === 0) return `post-PR round 1 owed on ${rec.head.slice(0, 7)}`
  if (post.length === 1 && post[0]?.endHead !== post[0]?.startHead) return `post-PR round 2 owed on ${rec.head.slice(0, 7)}`
  if (open.length > 0) return open.map(one => `${one.id} [${one.severity}] unresolved`).join(', ')
  return 'review in progress'
}

type MergedPr = { number: number; baseRefName: string; headRefOid: string }

/**
 * The CI hold on a merge the review lets through (R1-9, narrowed by R86): the standing's CI blockers. A required check that fails, is
 * cancelled or runs holds it, and so do checks gh can't read; under a post waiver a check GitHub does not require is set aside, named.
 */
const ciHold = (action: PrAction, pr: MergedPr, standing: Standing): string | undefined => {
  const ci = standing.blockers.filter(one => one.kind.startsWith('ci-'))
  if (ci.length === 0) return undefined
  const head = `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held`
  const short = pr.headRefOid.slice(0, 7)
  const failing = ci.filter(one => one.kind === 'ci-failing').map(one => one.id ?? '?')
  // A required check that never reported (gate R1-3) is held like a running one, and named as what it is.
  const isMissing = (one: Standing['blockers'][number]): boolean => one.said.endsWith('has not reported')
  const running = ci.filter(one => one.kind === 'ci-running' && !isMissing(one)).map(one => one.id ?? '?')
  const missing = ci.filter(one => one.kind === 'ci-running' && isMissing(one)).map(one => one.id ?? '?')
  const said = [
    ...(failing.length === 0 ? [] : [`failing: ${failing.join(', ')}`]),
    ...(running.length === 0 ? [] : [`still running: ${running.join(', ')}`]),
    ...(missing.length === 0 ? [] : [`required but not reported: ${missing.join(', ')}`]),
  ]
  const unreadable = ci.find(one => one.kind === 'ci-unreadable')
  if (unreadable !== undefined) {
    // Checks read while the base's required ones could not be are named too (gate R3-1): each holds as required.
    return [
      `${head}: the CI checks on ${short} could not be read${unreadable.detail === undefined ? '' : ` (${unreadable.detail})`}, and a merge waits until they can.`,
      ...(said.length === 0 ? [] : [`CI on ${short} is not green either (${said.join('; ')}).`]),
      'Do not merge another way. Check gh auth status and the network, then try the merge again.',
    ].join('\n') + unknownNote(action)
  }
  return [
    `${head}: CI on ${short} is not green (${said.join('; ')}).`,
    ...(standing.setAside.length === 0 ? [] : [`Set aside by the post waiver (GitHub does not require them): ${standing.setAside.join(', ')}.`]),
    'Do not merge another way.',
    ...(failing.length === 0
      ? []
      : ['Your next step: fix what the failing checks report and push, or rerun a check that failed for a flaky reason (gh run rerun <run-id> --failed).']),
    ...(running.length === 0
      ? []
      : [`${failing.length === 0 ? 'Your next step: wait' : 'Wait'} for the running checks (gh pr checks ${pr.number} --watch), then try the merge again.`]),
    ...(missing.length === 0
      ? []
      : ['A check the base requires has not reported on this head: wait for it to start, or find why its workflow does not run here, then try the merge again.']),
  ].join('\n') + unknownNote(action)
}

/**
 * Whether a PR may be merged now (merge, enqueue or auto-merge): its lifecycle must be ready for the PR's current head,
 * or the person waived post for it. A refusal never starts work, and tells the agent its own next step.
 */
const judgeMerge = async ($: Engine, action: PrAction): Promise<string | undefined> => {
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return isOutsideHeld(action) ? outsideText(action) : undefined
  const root = top.out
  if (action.repo !== undefined) {
    const origin = await git($, root, ['remote', 'get-url', 'origin'])
    if (origin.isOk && slugOf(origin.out) !== slugOf(action.repo)) return undefined
  }
  // Only `gh pr merge` without a target means the checked-out branch's PR; any other unnumbered merge names a PR the guard cannot see.
  if (action.number === undefined && (action.via !== 'gh pr merge' || action.isUnknown === true)) {
    return [
      `pr-gate: ${action.via} is held: it does not name the pull request it merges by number, so the guard cannot check that PR's lifecycle review.`,
      'Do not merge another way. Once the lifecycle review is complete, merge with gh pr merge <number>, which the guard can check.',
    ].join('\n')
  }
  const view = await $.process.run(
    [
      'gh',
      'pr',
      'view',
      ...(action.number === undefined ? [] : [String(action.number)]),
      ...(action.repo === undefined ? [] : ['--repo', action.repo]),
      '--json',
      'number,baseRefName,headRefName,headRefOid',
    ],
    { cwd: root, timeoutMs: 30_000 },
  )
  let pr: { number: number; baseRefName: string; headRefName: string; headRefOid: string } | undefined
  try {
    pr = view.exitCode === 0 ? JSON.parse(view.stdout) : undefined
  } catch {
    pr = undefined
  }
  if (pr === undefined || typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string') {
    const said = view.stderr.trim().slice(0, 200)
    return [
      `pr-gate: ${action.via} is held: gh could not say which pull request this merges${said === '' ? '' : ` (${said})`}.`,
      'Do not merge another way. Check gh auth status and the PR number, then try again: the guard checks the PR once gh can read it.',
    ].join('\n')
  }
  if (!config.bases.includes(pr.baseRefName) || config.bases.includes(pr.headRefName)) return undefined
  const stored = await loadRecord($, root, pr.headRefName)
  // A reset record counts as none: the lifecycle starts fresh.
  const rec = stored?.phase === 'archived' ? undefined : stored
  // No record and no such branch here: a PR from a branch not checked out here is not this gate's to review.
  if (rec === undefined && !(await git($, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${pr.headRefName}`])).isOk) return undefined
  // The person's post waiver for this head, unless a security P1 holds: only a waiver naming it releases that (spec §3).
  // Ready, or waived, means for the base it was reviewed against: a PR retargeted since holds (its base's settings and roster were
  // not applied; gate R2-3, R4-1).
  const isOnBase = rec !== undefined && rec.base === pr.baseRefName
  const isWaived = isOnBase && rec?.waivers.some(one => one.scope === 'post' && one.head === pr.headRefOid) === true
  const standing = rec === undefined ? undefined : await gatherStanding($, rec, pr, action.repo)
  // Whichever lets it through, CI on the head must be green too (R1-9); a waiver does not release a required check (R86).
  if (isWaived && rec !== undefined && securityHolds(rec).length === 0) return standing === undefined ? undefined : ciHold(action, pr, standing)
  // The same predicate as the controller's ready (R39): ready for this head, and nothing holds the merge.
  if (rec !== undefined && rec.phase === 'ready' && isOnBase && rec.head === pr.headRefOid && mergeHolds(rec).length === 0) {
    // A trusted reviewer is never waited for (R76): what it posted after ready is triaged before the merge, never merged past.
    const late = await untriagedFeedback($, rec)
    if (late === undefined) {
      return [
        `pr-gate: ${action.via} is held: gh could not read PR #${pr.number}'s reviews, so the guard cannot tell whether any arrived ` +
          'after the lifecycle review completed.',
        'Do not merge another way. Check gh auth status and the network, then try the merge again.',
      ].join('\n')
    }
    if (late.length > 0) {
      const who = [...new Set(late.map(one => one.reviewer))].join(', ')
      return [
        `pr-gate: ${action.via} is held: ${late.length} review comment${late.length === 1 ? '' : 's'} from ${who} arrived after the lifecycle ` +
          `review completed at ${rec.head.slice(0, 7)}, and no round has triaged ${late.length === 1 ? 'it' : 'them'}.`,
        `Your next step: run /${COMMAND} resume, which triages ${late.length === 1 ? 'it' : 'them'} on this head and uses no review round. Then try the merge again.`,
      ].join('\n')
    }
    return standing === undefined ? undefined : ciHold(action, pr, standing)
  }
  const short = pr.headRefOid.slice(0, 7)
  const missing =
    rec === undefined
      ? 'no lifecycle record for this branch'
      : !isOnBase
        ? `it was reviewed for ${rec.base}, but PR #${pr.number} now targets ${pr.baseRefName}`
      : rec.phase === 'ready' && rec.head !== pr.headRefOid
        ? `${short} was pushed after the review completed at ${rec.head.slice(0, 7)}`
        : owedOf(rec)
  const run = await getRun($)
  const isRunning = run !== null && run.status === 'running' && rec !== undefined && run.root === rec.root && run.branch === rec.branch
  // The agent's own next step; the person is named only where the spec leaves the decision to them.
  const next =
    rec === undefined
      ? `Your next step: check out ${pr.headRefName} and run /${COMMAND}, which adopts the open PR into post-PR review; merging is held until it is complete.`
      : !isOnBase
        ? `This needs the person's decision: tell them the PR was retargeted after its review. They can point it back at ${rec.base}, ` +
          `or type /${COMMAND} reset to review it again for ${pr.baseRefName}.`
      : isRunning
        ? `Next: the gate. /${COMMAND} is collecting the reviews now. Leave this branch alone until it sends you what needs an answer, ` +
          'or says to merge the PR; other work is fine.'
        : rec.phase !== 'ready' && rec.postStatus === 'awaiting-decision'
          ? `This needs the person's decision: tell them which findings are deferred or disputed and why, then stop. They can type ` +
            `/${COMMAND} waive <findingId> <reason> for each one, or /${COMMAND} waive post <reason> to let this head merge.`
          : rec.phase !== 'ready' && rec.postStatus === 'blocked'
          ? `Your next step: run /${COMMAND} resume on ${pr.headRefName}; it sends you the open items to answer, or has Codex check a rebuttal.`
          : rec.phase !== 'ready' && rec.postStatus === 'exhausted'
          ? `This needs the person's decision: tell them why. They can type /${COMMAND} waive post <reason> to let this head merge, ` +
            `or /${COMMAND} allow 1 <reason> for one more review round.`
          : `Your next step: check out ${pr.headRefName} and run /${COMMAND} resume, which reviews ${short} and says when the PR is ready to merge.`
  const isPushedAfter = rec !== undefined && isOnBase && rec.phase === 'ready' && rec.head !== pr.headRefOid
  // The pushed-after reason is the standing's head blocker in the same words: given once (final review I1).
  const named = new Set([...(missing.match(/\b[RG]\d+-\d+\b/g) ?? []), ...(isPushedAfter ? ['head'] : [])])
  const rest = standing === undefined ? '' : holdText(standing, named)
  return (
    [
      `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held: the lifecycle review is not complete for ${short}: ${missing}.`,
      'Do not merge another way.',
      next,
      ...(rest === '' ? [] : ['', rest]),
    ].join('\n') + unknownNote(action)
  )
}

const markOpened = async ($: Engine): Promise<void> => {
  await markPr($, 'done', 'opened')
}

/** The PR opened: the lifecycle crosses into post-PR review instead of ending. Only a PR gh confirms open from this branch counts. */
const onOpened = async ($: Engine, root: string, branch: string): Promise<void> => {
  const pr = await openPrOf($, root, branch)
  if (pr === undefined) return
  const who = await identityOf($, root)
  const saved = await updateRecord($, root, branch, rec => ({ ...rec, ...who, phase: 'post', pr: pr.number, head: pr.headRefOid }), { isPure: true })
  // When the head reached the PR (#24): GitHub's push time, else now.
  if (saved !== undefined) await noteArrival($, root, branch, pr.headRefOid, await $.clock.now())
  await markOpened($)
  if (saved !== undefined) await advance($, root, branch)
}

/**
 * The agent's merge went through (R93): once GitHub reads the PR as merged, the lifecycle closes, after the issue check (spec §5.12).
 * A merge not yet done (`--auto`), or a `gh pr view` that fails here, is left to the next poll, session start or /pr-gate (R62).
 */
const onMerged = async ($: Engine, action: PrAction): Promise<void> => {
  // A say that throws must not hide the error that brought the gate here (final review m6).
  const tell = async (key: RecordKey, text: string): Promise<void> => {
    try {
      await say($, key, text)
    } catch {
      // The original error is rethrown below.
    }
  }
  let root = action.cwd ?? ''
  let view: Awaited<ReturnType<Engine['process']['run']>>
  try {
    const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
    if (!top.isOk) return
    root = top.out
    // A merge in another repository (`--repo`, a PR URL) is not this checkout's PR, even with the same number and branch (wave 2b gate R1-4).
    if (action.repo !== undefined) {
      const origin = await git($, root, ['remote', 'get-url', 'origin'])
      if (origin.isOk && slugOf(origin.out) !== slugOf(action.repo)) return
    }
    view = await $.process.run(
      ['gh', 'pr', 'view', ...(action.number === undefined ? [] : [String(action.number)]), ...(action.repo === undefined ? [] : ['--repo', action.repo]), '--json', 'number,headRefName,state'],
      { cwd: top.out, timeoutMs: 30_000 },
    )
  } catch (error) {
    // A git or gh spawn threw before the gate knew the PR: the merge went through, and the agent is told the issue check did not run
    // (final review m5). The checkout's record, if any, is the one the prompt is about.
    const said = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    const branch = await git($, root === '' ? undefined : root, ['rev-parse', '--abbrev-ref', 'HEAD']).then(got => (got.isOk ? got.out : ''), () => '')
    await tell({ root, branch }, `pr-gate: the merge went through, but the gate failed before it could check the follow-up issues (${said}). ` +
      'The issue check did not run, and the lifecycle is not closed: run /pr-gate.')
    throw error
  }
  let pr: { number?: unknown; headRefName?: unknown; state?: unknown } | undefined
  try {
    pr = view.exitCode === 0 ? (JSON.parse(view.stdout) as { number?: unknown; headRefName?: unknown; state?: unknown } | null) ?? undefined : undefined
  } catch {
    pr = undefined
  }
  if (pr?.state !== 'MERGED' || typeof pr.headRefName !== 'string' || typeof pr.number !== 'number') return
  const key = { root, branch: pr.headRefName }
  const number = pr.number
  try {
    const rec = await loadRecord($, key.root, key.branch)
    if (rec === undefined || rec.phase === 'archived' || rec.pr !== number) return
    // closeLifecycle turns a failed issue check into a blocked record with gh's words, which /pr-gate resume runs again.
    await closeLifecycle($, key.root, key.branch, number, 'MERGED')
  } catch (error) {
    // GitHub took the merge, but the gate failed closing it: the agent is told, never left with a toast alone (the gate can't go
    // silent). The record, unarchived, is checked again by /pr-gate resume, or at the next session start.
    const said = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    await tell(key, `pr-gate: PR #${number} merged, but the gate failed while it checked the follow-up issues and closed the lifecycle (${said}). ` +
      'The follow-up issues are not confirmed yet. Run /pr-gate resume: the gate checks them again (a new session does too).')
    throw error
  }
}

// ------------------------------------------------------------ the command

const ids = (findings: readonly Finding[]): string => findings.map(one => one.id).join(', ')

/** One line on where the lifecycle stands: phase, budget, baseline, what is open, owed and holding the merge. */
const statusText = async ($: Engine, run: Run | null): Promise<string> => {
  // Says where the pane stands too: a surface that places no panes gives its reason here.
  const pane = await $.ui
    .open({ id: PANE, title: 'PR lifecycle' })
    .then(opened => (opened.isPlaced ? ' The pane is open.' : ` The pane is not drawn here: ${opened.reason}`))
    .catch(() => ' The pane could not be opened.')
  const top = run === null ? await git($, undefined, ['rev-parse', '--show-toplevel']) : { isOk: true, out: run.root }
  const branch = run?.branch ?? (top.isOk ? (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out : '')
  const rec = top.isOk && branch !== '' ? await loadRecord($, top.out, branch) : undefined
  const live = run === null ? '' : ` The run: ${run.status}, round ${run.round}${run.status === 'running' ? `, ${run.phase}` : ''}.`
  if (rec === undefined) return `/${COMMAND} has not run${branch === '' ? '' : ` for ${branch}`}.${live}${pane}`
  const standing = rec.phase === 'pre' ? rec.preStatus : rec.phase === 'post' ? rec.postStatus : undefined
  const granted = rec.grants.reduce((sum, one) => sum + one.n, 0)
  const baseline = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted && one.kind === 'baseline').length
  const pr = rec.pr === undefined ? '' : ` (PR #${rec.pr})`
  const note = scopeNote(rec)
  // A security finding's Jira ticket tracks it and never settles it (spec §5.13.7): named with the waiver it still waits for.
  const tickets = mergeHolds(rec).filter(one => one.isSecurity === true && one.jiraTicket !== undefined)
  const settled = rec.findings
    .filter(isSettledByIssue)
    .map(one => ` ${issueLine(one)}.`)
    .concat(tickets.map(one => ` ${ticketLine(one)}, waiting for your waiver.`))
    .concat(note === undefined ? [] : [` ${note}`])
    .join('')
  return (
    `${rec.branch} → ${rec.base}: ${rec.phase}${standing === undefined ? '' : ` (${standing})`}${pr}, ` +
    `${usedRounds(rec)}/${rec.allowance + granted} rounds used, baseline ${baseline}/2, ${unresolvedBlockers(rec).length} blocking open, ` +
    `${verificationOwed(rec).length} owed, ${mergeHolds(rec).length} holding the merge.${settled}${rec.message === undefined ? '' : ` ${rec.message}.`}${live}${pane}`
  )
}

const FINDING_ID = /^[RG]\d+-\d+$/

/**
 * The branch a `/pr-gate waive <id>` acts on (spec §5.13.2, §5.13.4). `<branch>:<id>` names it. An unqualified id is the checked-out
 * branch's, or else the one merged lifecycle under this root blocked on that security finding: ids repeat across lifecycles, so one
 * that could mean more than one is refused, naming each with its qualified command, and nothing is written.
 */
async function waiveTarget($: Engine, root: string, checkedOut: string, arg: string): Promise<{ branch: string } | { refusal: string }> {
  // A branch name never holds a colon (git refuses one), so a colon in it could only reach another root's key: refused.
  const qualified = /^([^\s:]+):([RG]\d+-\d+)$/.exec(arg)
  if (qualified !== null) return { branch: qualified[1] ?? checkedOut }
  if (!FINDING_ID.test(arg)) return { branch: checkedOut }
  const own = await loadRecord($, root, checkedOut)
  const isOwn = own !== undefined && own.phase !== 'archived' && own.findings.some(each => each.id === arg)
  const blocked = (await liveRecords($, root)).filter(one => one.branch !== checkedOut && securityBlockedIds(one).includes(arg)).map(one => one.branch)
  const all = [...(isOwn ? [checkedOut] : []), ...blocked]
  if (all.length > 1) {
    return {
      refusal: `/${COMMAND}: ${arg} names a finding in the lifecycles of ${all.join(', ')}: nothing was waived. Say which: ` +
        `${all.map(one => `/${COMMAND} waive ${one}:${arg} <reason>`).join(', ')}.`,
    }
  }
  const [only] = blocked
  return { branch: !isOwn && only !== undefined ? only : checkedOut }
}

/** Why a finding is settled, for a waiver that has nothing to release. */
const settledAs = (rec: LifecycleRecord, one: Finding): string =>
  rec.waivers.some(each => each.scope === 'finding' && each.findingId === one.id)
    ? 'waived'
    : isAcceptedRebuttal(one)
      ? 'its rebuttal is accepted by Codex'
      : isSettledByIssue(one)
        ? `tracked by its issue: ${issueLine(one)}`
        : one.status === 'verified-fixed'
          ? 'verified fixed'
          : one.status

/** The checkout's branch: its toplevel and name, or undefined outside a checkout or on a detached HEAD. */
async function hereOf($: Engine): Promise<{ root: string; branch: string } | undefined> {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return undefined
  const branch = (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  return branch === '' || branch === 'HEAD' ? undefined : { root: top.out, branch }
}

/** `/pr-gate log`: the branch's run log, summed up; once the lifecycle closed, its newest archive's. */
async function logText($: Engine): Promise<string> {
  const here = await hereOf($)
  if (here === undefined) return `/${COMMAND} log: not on a branch of a git checkout.`
  const live = await loadRecord($, here.root, here.branch)
  const rec = live !== undefined && live.phase !== 'archived' ? live : await latestArchive($, here.root, here.branch)
  if (rec === undefined) return `/${COMMAND} log: there is no lifecycle for ${here.branch}.`
  return `/${COMMAND} log: ${logSummary(rec, rec !== live)}`
}

/** The person's commands that change a lifecycle, for its run log. */
/** Whether a command came from the person: the composer, the bridge or the pane. */
const isPerson = (origin: string): boolean => origin === 'composer' || origin === 'bridge' || origin === 'pane'

const LOGGED = ['resume', 'stop', 'waive', 'allow', 'reset']

/** Logs a person's command and the first line of its reply on the branch's record (`/pr-gate log`). */
async function logCommand($: Engine, args: string, reply: string, origin: string): Promise<void> {
  const verb = args.trim().split(/\s+/)[0] ?? ''
  // Only the person's own: an agent's run of a person-only command is refused, and is no step of theirs.
  if (!LOGGED.includes(verb) || !isPerson(origin)) return
  const here = await hereOf($)
  if (here === undefined) return
  const said = reply.split('\n')[0]?.replace(/^\/pr-gate:?\s*/, '') ?? ''
  await logEvent($, here.root, here.branch, 'person', `/${COMMAND} ${args.trim()} → ${said}`)
}

/**
 * `/pr-gate start|<base>`, `status`, `log`, `stop`, `resume`, `waive pre|post|[<branch>:]<findingId> <reason>`, `allow <n> <reason>`, `reset`.
 * Waivers, `allow` and `reset` are the person's alone. The replies may start with the command; prompts never do (R21).
 */
const runCommand = async ($: Engine, args: string, origin: string): Promise<string> => {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const run = await getRun($)
  if (verb === 'status') return statusText($, run)
  if (verb === 'log') return logText($)
  if (verb === 'stop') {
    if (run === null || run.status !== 'running') return `/${COMMAND} is not running.`
    if (isPerson(origin)) await claimRecord($, run.root, run.branch)
    dropQueued(run)
    await finish($, run.id, 'stopped', 'Stopped by the person.')
    if (isPerson(origin)) {
      await tellAgent($, run, 'stopped the gate', 'stop waiting on it. Opening and merging stay held; /pr-gate resume continues it.')
    }
    return `/${COMMAND} stopped. The record stays: /${COMMAND} resume continues it. Opening and merging stay held.`
  }
  const isPersons = verb === 'waive' || verb === 'allow' || verb === 'reset'
  // An agent's or a plugin's command run never grants one.
  if (isPersons && origin !== 'composer' && origin !== 'bridge') return 'Only the person can waive, allow rounds or reset.'
  if (!isPersons && verb !== 'resume') {
    const base = verb === '' || verb === 'start' ? rest[0] : verb
    return `/${COMMAND}: ${await startGate($, { base })}`
  }
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return 'Not a git repository.'
  const root = top.out
  const checkedOut = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const head = (await git($, root, ['rev-parse', 'HEAD'])).out
  // `waive <id>` may act on another branch's merged lifecycle (spec §5.13.2): everything below is about the branch it names.
  const aimed = verb === 'waive' ? await waiveTarget($, root, checkedOut, rest[0] ?? '') : { branch: checkedOut }
  if ('refusal' in aimed) return aimed.refusal
  const { branch } = aimed
  const stored = await loadRecord($, root, branch)
  const rec = stored?.phase === 'archived' ? undefined : stored
  const now = await $.clock.now()
  // The person's waive, allow or reset takes the record for this session (#13), once it is accepted: what it starts is this
  // session's to run. A refused one leaves the record with its owner.
  const take = async (): Promise<void> => {
    await claimRecord($, root, branch)
  }
  const isRunning = run !== null && run.status === 'running'
  const isOurs = isRunning && run.root === root && run.branch === branch
  const none = `/${COMMAND}: there is no lifecycle for ${branch} yet: /${COMMAND} starts one.`
  if (verb === 'resume') {
    // The controller re-decides from the record (startGate clears a post-PR stop): an answerable block re-opens triage (R37),
    // a held rebuttal check runs again (R36, R39), and a post-PR record reports its post-PR standing (M3).
    if (rec === undefined) return none
    return `/${COMMAND}: ${await startGate($, { base: rest[0] })}`
  }
  if (verb === 'reset') {
    await take()
    if (isOurs) await finish($, run.id, 'stopped', 'Reset by the person.')
    // The whole record is kept under an archive key; the branch's own key keeps only what a fresh start must not repeat (R47).
    const did = await archiveLifecycle($, root, branch, now)
    dropQueued({ root, branch })
    if (did) {
      await tellAgent($, { root, branch }, `reset the lifecycle of ${branch}: it is archived, its history kept`,
        'nothing for the old review. A fresh review starts when the person runs /pr-gate, or when you next open the pull request; ' +
          'opening and merging stay held until it completes.')
    }
    return `/${COMMAND}: the lifecycle for ${branch} is archived under its own key, its history kept. /${COMMAND} starts a fresh one.`
  }
  if (verb === 'allow') {
    const n = Number(rest[0])
    const reason = rest.slice(1).join(' ').trim()
    if (!Number.isInteger(n) || n < 1 || n > 5 || reason === '') return `Say how many and why: /${COMMAND} allow <1-5> <reason>`
    if (rec === undefined) return none
    await take()
    await updateRecord($, root, branch, one => ({ ...one, grants: [...one.grants, { n, reason, head, at: now }] }), { isPure: true })
    await tellAgent($, { root, branch }, `allowed ${n} more round${n === 1 ? '' : 's'}: ${reason}`,
      'the gate continues the review. Leave the branch alone until it sends you what needs an answer.')
    // A run in flight reads the grant when its round ends; otherwise the controller decides again now (a ready record stays ready).
    if (!isRunning && rec.phase !== 'ready') await advance($, root, branch)
    const after = (await loadRecord($, root, branch)) ?? rec
    // Rounds never settle a deferral or a dispute (R42): only the person's waiver of each does, or its issue when the gate files it (R92).
    const theirs = mergeHolds(after).filter(one => (one.status === 'deferred' || isDisputed(one)) && !isFileable(one))
    const settles =
      theirs.length === 0
        ? ''
        : ` Rounds settle no deferral or dispute: ${theirs.map(one => `/${COMMAND} waive ${one.id} <reason>`).join(', ')} ` +
          `${theirs.length === 1 ? 'releases' : 'release'} ${ids(theirs)}.`
    return `/${COMMAND}: ${n} more round${n === 1 ? '' : 's'} allowed for ${branch}: ${reason}.${settles}`
  }
  const [named = '', ...why] = rest
  const reason = why.join(' ').trim()
  // `<branch>:<id>` named the branch above; the finding is the id.
  const scope = named.replace(/^\S+:(?=[RG]\d+-\d+$)/, '')
  const isFinding = FINDING_ID.test(scope)
  if ((scope !== 'pre' && scope !== 'post' && !isFinding) || reason === '') return `Say what and why: /${COMMAND} waive pre|post|[<branch>:]<findingId> <reason>`
  if (isFinding) {
    // Decided on the read taken under the record's lock (F5): a finding settled meanwhile is not waived.
    const refusalOf = (one: LifecycleRecord | undefined): string | undefined => {
      const finding = one?.phase === 'archived' ? undefined : one?.findings.find(each => each.id === scope)
      if (one === undefined || finding === undefined) return `/${COMMAND}: there is no finding ${scope} in the lifecycle of ${branch}.`
      if (!mergeHolds(one).some(each => each.id === scope)) {
        return `/${COMMAND}: ${scope} is already settled (${settledAs(one, finding)}): there is nothing to waive.`
      }
      return undefined
    }
    let refusal = refusalOf(rec)
    if (refusal !== undefined || rec === undefined) return refusal ?? `/${COMMAND}: there is no finding ${scope} in the lifecycle of ${branch}.`
    let before: LifecycleRecord = rec
    await updateRecord($, root, branch, one => {
      before = one
      refusal = refusalOf(one)
      if (refusal !== undefined) return one
      // A fresh waiver at this head: one that lapsed on a file change stays in the history as lapsed (R55).
      return { ...one, waivers: [...one.waivers, { scope: 'finding' as const, findingId: scope, head: one.head, reason, by: origin, at: now }] }
    }, { isPure: true })
    if (refusal !== undefined) return refusal
    await take()
    // A PR merged before the gate finished, blocked on this finding or on an issue it could not confirm (spec §5.12, §5.13.2): the
    // waiver runs the close again, never a round on a merged PR, and the lifecycle is archived once nothing is left.
    const merged = await loadRecord($, root, branch)
    if (merged !== undefined && merged.pr !== undefined && isMergeBlocked(merged)) {
      const closed = await closeLifecycle($, root, branch, merged.pr, 'MERGED')
      const isArchived = (await loadRecord($, root, branch))?.phase === 'archived'
      if (isArchived) {
        await tellAgent($, { root, branch }, `waived ${scope}: ${reason}`, `${closed}. Nothing more is needed from you for PR #${merged.pr}.`)
      }
      return `/${COMMAND} waived ${scope} for ${branch}: ${reason}. ${closed}.`
    }
    // A round in flight is not asked about it again.
    if (isOurs) await patch($, run.id, one => (one.asked === undefined ? one : { ...one, asked: one.asked.filter(id => id !== scope) }))
    // Released from the merge test and from ready: the controller decides again, unless a round in flight will. After a push no
    // round recorded, its verdict would be for the record's old head: the note below names the push instead (final review I1).
    const latest = isRunning ? undefined : await loadRecord($, root, branch)
    const pushed = latest !== undefined && latest.phase !== 'pre' && latest.pr !== undefined ? await openPrOf($, root, branch) : undefined
    if (!isRunning && (pushed === undefined || pushed.headRefOid === latest?.head)) await advance($, root, branch)
    const after = await loadRecord($, root, branch)
    const wasPassed = before.preStatus === 'passed' && before.preHead === after?.preHead
    if (after !== undefined && after.phase === 'pre' && after.preStatus === 'passed' && !wasPassed) {
      await sayOpenPr($, after, 'passed', now, `${scope} waived by the person: ${reason}`)
    }
    const settled = await loadRecord($, root, branch)
    // The head GitHub reports, as `waive post` reads it: a push no round recorded is not judged by the record's old head.
    const live = settled?.phase !== 'pre' && settled?.pr !== undefined ? await openPrOf($, root, branch) : undefined
    const pr = settled?.phase !== 'pre' && settled?.pr !== undefined
      ? { number: settled.pr, baseRefName: live?.baseRefName ?? settled.base, headRefOid: live?.headRefOid ?? settled.head }
      : undefined
    const standing = settled !== undefined && pr !== undefined ? await gatherStanding($, settled, pr) : undefined
    const method = (await configFor($, root, pr?.baseRefName ?? settled?.base ?? '')).config.mergeMethod
    // advance has just sent the ready prompt, merge step included, when this waiver is what made the lifecycle ready: say it once.
    const hasMergeStep = before.phase !== 'ready' && settled?.phase === 'ready'
    // A reset while the standing was gathered supersedes this note (gate G7-3).
    if (settled !== undefined && pr !== undefined && !(await isStillCurrent($, settled))) return `/${COMMAND} waived ${scope} for ${branch}: ${reason}.`
    await tellAgent($, { root, branch }, `waived ${scope}: ${reason}`,
      standing === undefined
        ? 'nothing more is needed from you for this finding; the pre-PR review continues.'
        : standing.mayProceed
          ? hasMergeStep
            ? 'no review finding holds the merge: the gate has just sent you the merge step; follow that one.'
            : `no review finding holds the merge: ${mergeStep(pr?.number, method, pr?.headRefOid)}.`
          : 'answer what is yours in the list above, and leave the rest to who it names.',
      standing)
    return `/${COMMAND} waived ${scope} for ${branch}: ${reason}.`
  }
  if (scope === 'pre') {
    // Checked on the command's read, and again on the read taken under the record's lock (F5).
    const refusalOf = (one: LifecycleRecord | undefined): string | undefined => {
      if (one === undefined || one.phase === 'archived') return undefined
      if (one.phase !== 'pre') {
        return (
          `/${COMMAND}: PR #${one.pr ?? '?'} from ${branch} is already open, so there is no pre-PR review to waive. ` +
          `/${COMMAND} waive post <reason> lets this head merge.`
        )
      }
      // A security blocker is released only by a waiver naming it, never by waiving the whole review (R54).
      const security = [...unresolvedBlockers(one), ...verificationOwed(one)].filter(each => each.isSecurity === true)
      if (security.length === 0) return undefined
      const isOne = security.length === 1
      return (
        `/${COMMAND}: ${ids(security)} ${isOne ? 'is a security P1' : 'are security P1s'} holding the pull request for ${branch}, and only a waiver naming ` +
        `${isOne ? 'it' : 'each'} releases ${isOne ? 'it' : 'them'}: ${security.map(each => `/${COMMAND} waive ${each.id} <reason>`).join(', ')}. ` +
        'No pre waiver was recorded.'
      )
    }
    let refusal = refusalOf(rec)
    if (refusal !== undefined) return refusal
    // With no record, the waiver covers the base a PR with no base opens against: the repository's default branch (R1-5).
    const found = rec === undefined ? await defaultBranchOf($, root) : undefined
    if (found !== undefined && found.name === undefined) {
      return `/${COMMAND}: gh could not read the repository's default branch (${found.err}), so the waiver has no base to cover. No pre waiver was recorded.`
    }
    // A record started by the waiver takes its allowance from the base's own settings (R67), read before the lock.
    const { allowances } = (await configFor($, root, found?.name ?? rec?.base ?? '')).config
    // A waiver covers this commit for the record's base at this moment, and is kept in the record's history.
    const waived = await upsertRecord($, root, branch, one => {
      refusal = refusalOf(one)
      if (refusal !== undefined) return undefined
      const base =
        one?.phase === 'archived' || one === undefined
          ? {
            // A record started over a reset keeps the reset's generation (gate G7-7).
            generation: one?.generation,
            ...newRecord({
              root,
              branch,
              base: found?.name ?? one?.base ?? '',
              head,
              tier: 'standard',
              tierWhy: 'not scoped: waived before the gate ran',
              lane: 'full',
              allowance: allowances.standard,
              at: now,
            }),
          }
          : one
      const waiver = { scope: 'pre' as const, head, base: base.base, reason, by: origin, at: now }
      return { ...base, preStatus: 'waived' as const, preHead: head, waivers: [...base.waivers, waiver] }
    }, { isPure: true })
    if (refusal !== undefined || waived === undefined) return refusal ?? `/${COMMAND}: no pre waiver was recorded.`
    await take()
    if (isOurs && run.lifecycle === 'pre') await finish($, run.id, 'waived', `Waived: ${reason}`)
    await sayOpenPr($, waived, 'waived', now)
    await tellAgent($, waived, `waived the pre-PR review of ${branch} at ${head.slice(0, 7)}: ${reason}`,
      `open the pull request for ${branch} → ${waived.base}; the guard lets it through, and post-PR review runs once it opens.`)
    return (
      `/${COMMAND} waived pre-PR review for ${branch} at ${head.slice(0, 7)}: ${reason}. ` +
      `The PR may open; this waiver covers ${waived.base} only, and post-PR review still runs.`
    )
  }
  // waive post: the head GitHub reports for the PR, which is what the merge guard checks.
  const security = rec === undefined ? [] : securityHolds(rec)
  if (security.length > 0) {
    const one = security.length === 1
    return (
      `/${COMMAND}: ${ids(security)} ${one ? 'is a security P1' : 'are security P1s'} holding the merge of ${branch}, and only a waiver naming ` +
      `${one ? 'it' : 'each'} releases ${one ? 'it' : 'them'}: ${security.map(each => `/${COMMAND} waive ${each.id} <reason>`).join(', ')}. ` +
      'No post waiver was recorded.'
    )
  }
  await take()
  const pr = await openPrOf($, root, branch)
  const at = pr?.headRefOid ?? head
  // A record started here only carries the waiver: its base is the PR's, else the default branch (R1-5), else the first gated base.
  const fallback = rec === undefined && pr === undefined ? (await defaultBranchOf($, root)).name : undefined
  await upsertRecord($, root, branch, one => {
    const base =
      one === undefined || one.phase === 'archived'
        ? {
          // A record started over a reset keeps the reset's generation (gate G7-7).
          generation: one?.generation,
          ...newRecord({
            root,
            branch,
            base: pr?.baseRefName ?? fallback ?? config.bases[0] ?? 'dev',
            head,
            tier: 'standard',
            tierWhy: 'waived before scoping',
            lane: 'full',
            allowance: 0,
            at: now,
          }),
        }
        : one
    return { ...base, waivers: [...base.waivers, { scope: 'post' as const, head: at, reason, by: origin, at: now }] }
  }, { isPure: true })
  // The review the waiver settles stops collecting, as a pre waiver ends a pre run (R62).
  if (isOurs && run.lifecycle === 'post') await finish($, run.id, 'waived', `Waived: ${reason}`)
  const after = await loadRecord($, root, branch)
  const standing = after !== undefined && pr !== undefined ? await gatherStanding($, after, pr) : undefined
  const method = (await configFor($, root, pr?.baseRefName ?? after?.base ?? '')).config.mergeMethod
  // A reset while the standing was gathered supersedes this note (gate G7-3).
  const isSuperseded = after !== undefined && pr !== undefined && !(await isStillCurrent($, after))
  if (!isSuperseded) {
    await tellAgent($, { root, branch }, `waived post-PR review of ${pr === undefined ? branch : `PR #${pr.number}`} at ${at.slice(0, 7)}: ${reason}`,
      standing === undefined
        ? 'the waiver is recorded, but GitHub did not return this pull request, so what else holds the merge is unknown. ' +
            'Check it with gh pr view before telling the person anything; do not merge.'
        : standing.mayProceed
          ? `no other review finding holds the merge: ${mergeStep(pr?.number, method, at)}.`
          : 'the waiver covers the review only: wait for what is listed, then tell the person.',
      standing)
  }
  const aside = standing === undefined || standing.setAside.length === 0 ? '' : ` Set aside (GitHub does not require them): ${standing.setAside.join(', ')}.`
  return `/${COMMAND} waived post-PR review for ${branch} at ${at.slice(0, 7)}: ${reason}. This head may merge; a new commit needs a new review or waiver.${aside}`
}

export const register: Register = (on, options) => {
  config = configOf(options)
  setup(config)

  // One hook for every tool call (the engine takes one without a matcher). It updates the line that changes in place, then guards
  // every route that opens or merges a PR: Bash, the known GitHub MCP tools, and any GitHub tool that reads as one.
  on('tool.call', async ($, e, next) => {
    if (isLiveNow()) {
      void (async () => {
        const run = await getRun($)
        if (run === null || run.status !== 'running') {
          setLive(false)
          return
        }
        // The main agent's call belongs to its step's own turn (R51); a sub-agent's to its id.
        if (e.agentId !== undefined) await noteSeen($, run, e.agentId)
        const who = run.pending.find(one => isTurnOf(one, e.agentId))
        if (who === undefined) return
        const activity = activityOf(who.role, String(e.tool), e as unknown as Record<string, unknown>)
        if (activity !== run.activity) await patch($, run.id, one => ({ ...one, activity }))
      })().catch(() => undefined)
    }
    const action = readPrAction(String(e.tool), e as unknown as Record<string, unknown>)
    if (action === undefined) return next(e)
    const tail = chainedOf(String(e.tool), e)
    if (action.action === 'merge') {
      // A merge given by URL names its repository there: gh pr view reads that one, and another repo's PR is not intercepted.
      const command = (e as unknown as Record<string, unknown>).command
      const url = action.repo === undefined && typeof command === 'string' ? command.match(/github\.com\/([^/\s'"]+\/[^/\s'"]+)\/pull\/(\d+)/) : null
      const target = url !== null && url[1] !== undefined && Number(url[2]) === action.number ? { ...action, repo: url[1] } : action
      const refusal = config.enforceMerge ? await judgeMerge($, target) : undefined
      if (refusal !== undefined) return { deny: asHold(refusal) + tail }
      const ran = await next(e)
      // A merge GitHub refused leaves the lifecycle where it was (spec §6.4); one that went through closes it (spec §5.12). What fails
      // here is said, never dropped: the merge itself has run, so its result goes back as it was. The agent's turn holds the
      // session while its tool runs, so what the check tells it waits until the call has returned, as a command's prompts do.
      if (ran.deny === undefined && ran.isError !== true) {
        await holdingPrompts($, () => onMerged($, target)).catch((error: unknown) => {
          $.ui.toast(`pr-gate: the merge went through, but the gate could not close its lifecycle (${error instanceof Error ? error.message : String(error)}). Run /pr-gate.`.slice(0, 300))
        })
      }
      return ran
    }
    const found = await gatedCreate($, action)
    if (found === 'outside') return config.enforce ? { deny: asHold(outsideText(action)) + tail } : next(e)
    if (found !== undefined && 'noBase' in found) return config.enforce ? { deny: asHold(noBaseText(action, found.noBase)) + tail } : next(e)
    if (found !== undefined && 'head' in found) return config.enforce ? { deny: asHold(elsewhereText(action, found)) + tail } : next(e)
    const gated = found
    const refusal = gated !== undefined && config.enforce ? await judgeCreate($, action, gated) : undefined
    if (refusal !== undefined) return { deny: asHold(refusal) + tail }
    const ran = await next(e)
    if (gated !== undefined && ran.deny === undefined && ran.isError !== true) await onOpened($, gated.root, gated.branch)
    return ran
  }).catch(($, e, next) => {
    // Once the hook called `next`, the tool ran: here `next(e)` replays what it settled to and never runs the tool again (Caught).
    const action = next.called ? undefined : readPrAction(String(e.tool), e as unknown as Record<string, unknown>)
    if (action === undefined) return next(e)
    return {
      deny: asHold(
        'pr-gate: its guard failed, so this pull request action is held. Try it once more; if it fails again, tell the person, ' +
          `who can type /${COMMAND} waive ${action.action === 'merge' ? 'post' : 'pre'} <reason> to let it through.`,
      ) + chainedOf(String(e.tool), e),
    }
  })

  // A main-loop turn that starts with a step's prompt is that step's own turn (R51).
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (isLiveNow()) await onTurnStart($, e.agentId, e.turnId, e.text).catch(() => undefined)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isLiveNow() || (await awaitsLate($, e.agentId))) {
      try {
        await onAnswer($, e.agentId, e.answer, e.reason, e.turnId)
      } catch (error) {
        const run = await getRun($)
        // The shared store would not take a change (Task 8): this session stands down with a log line, and its run is not failed.
        if (run !== null && (await isStoodDownBy($, run, error))) return done
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
      description: "Run /pr-gate: pre-PR Codex review, then the PR's own reviews, under one budget (start, status, log, stop, resume, waive, allow, reset)",
      argumentHint: '[base] | status | log | stop | resume | waive pre|post|[<branch>:]<id> <reason> | allow <n> <reason> | reset',
      immediate: true,
    })
    setSession(e.isInteractive)
    const run = await getRun($)
    if (run !== null && run.status === 'running') {
      // A reload dropped the module's timers, not the run: the host kept it.
      startTicker($)
      startWatcher($, run.root)
      void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
    } else {
      setLive(false)
      // A new session: a post-PR review that was under way when the last one ended goes on collecting. Processed ids and
      // recorded replies keep it from repeating work; a record that is ready, held, stopped or awaiting the person is left as it is.
      try {
        const top = await git($, e.cwd, ['rev-parse', '--show-toplevel'])
        const branch = top.isOk ? (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out : ''
        // Every record under the repository's root, not only the branch checked out (spec §5.13.4): a merge done while no session ran
        // is caught by the next one, whichever branch it is on. A PR merged or closed meanwhile is closed here, after the issue check
        // (spec §5.12) and the filing of what still holds (§5.13.1), whatever the record waits on (final review m1); it is not
        // collected again (R62). Only a session a person is at does this, and never on a record a live session elsewhere owns (#13).
        if (top.isOk && e.isInteractive) {
          for (const one of await liveRecords($, top.out)) {
            if (one.pr === undefined || (one.phase !== 'ready' && one.phase !== 'post')) continue
            const pr = one.pr
            try {
              if (await isOwnedElsewhere($, top.out, one.branch)) continue
              const state = await prStateOf($, top.out, pr)
              if (state !== 'MERGED' && state !== 'CLOSED') continue
              await claimRecord($, top.out, one.branch)
              await holdingPrompts($, () => closeLifecycle($, top.out, one.branch, pr, state))
            } catch {
              // A failed read is the watcher's to retry; the other records are read all the same.
            }
          }
          // Whatever is left with a PR is watched from now on (spec §5.13.3); the watcher stops itself when nothing is.
          startWatcher($, top.out)
        }
        const rec = top.isOk && branch !== '' && branch !== 'HEAD' ? await loadRecord($, top.out, branch) : undefined
        // A review that stopped on an error (gh down, a step that failed) polls again, as the spec's restart does; a stop is the person's.
        // Only a session a person is at takes a record over, and only once its owner has gone quiet (#13; Adam, decision D): a
        // headless child in the same checkout (a hook's `claude -p`) never runs the lifecycle or gets its prompts.
        const isMine = rec !== undefined && e.isInteractive && !(await isOwnedElsewhere($, top.out, branch))
        // One still open is left as it is, unless its review was under way or stopped on an error.
        if (rec !== undefined && isMine && rec.phase === 'post' && (rec.postStatus === undefined || rec.postStatus === 'error')) {
          if (rec.postStatus === 'error') await updateRecord($, top.out, branch, one => ({ ...one, postStatus: undefined }), { isPure: true })
          await holdingPrompts($, () => advance($, top.out, branch))
        }
      } catch {
        // The session starts whatever the record says.
      }
    }
    return next(e)
  })

  // Prompts a command decides wait until it has returned: the host refuses a submit while the command holds the turn.
  on('command.run', { command: 'pr-gate' }, async ($, e) => {
    const text = await holdingPrompts($, () => runCommand($, e.args, e.origin.kind))
    await logCommand($, e.args, text, e.origin.kind).catch(() => undefined)
    return { text }
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const run = await read($, runAtom)
    const now = await read($, tickAtom)
    // Read-only: the run's own root and branch find its record; with no run, the checkout's.
    const top = run === null ? await git($, undefined, ['rev-parse', '--show-toplevel']) : undefined
    const root = run !== null ? run.root : top?.isOk === true ? top.out : ''
    const branch = run !== null ? run.branch : root === '' ? '' : (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
    const rec = root !== '' && branch !== '' && branch !== 'HEAD' ? await loadRecord($, root, branch) : undefined
    // The pane's Stop is the person's /pr-gate stop (R81): the owner check, the log line and the agent's message come with it.
    const stop = async (): Promise<void> => {
      const text = await holdingPrompts($, () => runCommand($, 'stop', 'pane'))
      await logCommand($, 'stop', text, 'pane').catch(() => undefined)
    }
    return renderPane($, e, run, rec, now, { stop })
  })
}
