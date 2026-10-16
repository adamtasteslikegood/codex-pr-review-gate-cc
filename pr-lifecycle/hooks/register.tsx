// pr-lifecycle: /pr-gate across the PR lifecycle. Rounds of adversarial Codex
// review and agent fixes run locally before a pull request to a gated base is
// opened, on one review allowance kept in the lifecycle record.
//
// round.ts runs a round as a state machine the host keeps in `$.state`, and holds
// the controller (`advance`), which reads the record after each round and does
// what `decideNext` says. Here are the hooks, the guard, the command and the pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Finding, LifecycleRecord, Run, Step } from '../types'
import { activityOf, classify, isBlocking, isVersionOnly, lowerOf, prePerson, prPrompt, readGitlinks, slugOf, stepDown } from './core'
import { readPrAction } from './github'
import type { PrAction } from './github'
import {
  allowanceFor,
  invalidate,
  isAcceptedRebuttal,
  isDisputed,
  lastReviewedHead,
  mergeHolds,
  newRecord,
  remaining,
  rescope,
  securityHolds,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
} from './lifecycle'
import {
  advance,
  configOf,
  elapsed,
  finish,
  getRun,
  git,
  hasSecurityBlocker,
  heldReason,
  holdingPrompts,
  isLiveNow,
  markPr,
  onAnswer,
  PANE,
  patch,
  say,
  setLive,
  setup,
  SPINNER,
  startTicker,
} from './round'
import type { Config } from './round'
import { archiveRecord, loadRecord, saveRecord, updateRecord } from './store'

const COMMAND = 'pr-gate'
// The same state round.ts writes: the engine reads an atom only where this file makes it.
const runAtom = atom({ plugin: 'pr-lifecycle', key: 'run' } as const, null)
const tickAtom = atom({ plugin: 'pr-lifecycle', key: 'tick' } as const, 0)

type Engine = EngineInterface

// The module's own: what `register` was last given.
let config: Config = configOf({})

/** The run a pass-through shows in the pane: no round runs, so it is ended from the start. */
const passThroughRun = (rec: LifecycleRecord, cwd: string, now: number): Run => ({
  id: `${now}`,
  cwd,
  root: rec.root,
  branch: rec.branch,
  base: rec.base,
  headSha: rec.head,
  tier: rec.tier,
  tierWhy: rec.tierWhy,
  lane: rec.lane,
  effort: rec.effort ?? config.effort,
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
  ...passThroughRun(rec, rec.root, now),
  headSha: rec.preHead ?? rec.head,
  round: rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).length,
  findings: rec.findings,
  message: undefined,
})

/** Sends the agent to open the PR, once the person's waiver let the pre-PR gate pass; through the command's prompt queue. */
const sayOpenPr = ($: Engine, rec: LifecycleRecord, status: 'passed' | 'waived', now: number): void => {
  if (config.openPr) say($, prPrompt(settledRun(rec, now), rec, status))
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
  const prior = await loadRecord($, root, branch)
  // The branch's last run timed out at its lowest step: this one starts a level below where that one ended.
  // Otherwise it starts no higher than the effort a review last completed at on this branch.
  const afterTimeout = prior?.hasTimedOut === true && prior.effort !== undefined ? (stepDown(prior.effort) ?? 'low') : startEffort
  const effort = lowerOf(lowerOf(startEffort, afterTimeout), prior?.passedEffort ?? startEffort)
  const now = await $.clock.now()
  const allowance = allowanceFor(scope.tier, lane, config.allowances)
  let rec: LifecycleRecord =
    prior !== undefined && prior.phase !== 'archived'
      ? {
          ...rescope(
            { ...prior, head, base, ...(prior.phase === 'ready' && prior.head !== head ? { phase: 'post' as const } : {}), postStatus: undefined },
            scope.tier,
            scope.why,
            config.allowances,
          ),
          effort,
          // A pass-through that now needs Codex is one no longer.
          ...(scope.tier === 'trivial' ? {} : { passThrough: undefined }),
        }
      : {
          ...newRecord({ root, branch, base, head, tier: scope.tier, tierWhy: scope.why, lane, allowance, at: now }),
          // After a reset: feedback already processed and replied to stays answered (R47).
          ...(prior === undefined ? {} : { processed: prior.processed, replies: prior.replies }),
          effort,
          ...(scope.tier === 'trivial' ? { passThrough: scope.why } : {}),
        }
  if (prior !== undefined && prior.head !== head) {
    const lastHead = lastReviewedHead(prior)
    const since = lastHead === undefined ? undefined : await git($, root, ['diff', '--name-only', lastHead, head])
    rec = { ...rec, findings: invalidate(rec.findings, since?.isOk === true ? new Set(since.out.split('\n').filter(Boolean)) : 'all') }
  }
  // A PR the gate never saw opened (opened by hand, or before this mod): adopt it straight into post-PR review.
  const adopted = prior === undefined || prior.phase === 'pre' || prior.phase === 'archived' ? await openPrOf($, root, branch) : undefined
  if (adopted !== undefined && config.bases.includes(adopted.baseRefName)) {
    const adoptedRec: LifecycleRecord = {
      ...rec,
      ...(await identityOf($, root)),
      phase: 'post',
      base: adopted.baseRefName,
      pr: adopted.number,
      passThrough: undefined,
    }
    await saveRecord($, adoptedRec)
    await advance($, root, branch)
    return (
      `PR #${adopted.number} from ${branch} to ${adopted.baseRefName} is already open: adopted into post-PR review, ` +
      `${remaining(adoptedRec)} of ${adoptedRec.allowance} review rounds left.`
    )
  }
  if (rec.tier === 'trivial') {
    // A pass-through runs no round: the pane shows it passed, and the held call goes straight through.
    const shown = passThroughRun(rec, want.cwd ?? root, now)
    await update($, runAtom, () => shown)
    setLive(false)
    void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
    await saveRecord($, rec)
    await advance($, root, branch)
    const saved = await loadRecord($, root, branch)
    if (want.isHeldCall !== true && config.openPr && saved !== undefined) {
      await markPr($, 'running', 'handed to the main agent')
      say($, prPrompt(shown, saved, 'passed'))
    }
    return `Gate passed without Codex: ${scope.why}.`
  }
  await saveRecord($, rec)
  await advance($, root, branch)
  const run = await getRun($)
  if (run === null || run.status !== 'running') {
    const after = (await loadRecord($, root, branch)) ?? rec
    const said = after.message === undefined ? '' : ` (${after.message})`
    // After the PR opened, the post-PR review's standing is the one that counts (M3).
    const stands =
      after.phase === 'pre'
        ? `the pre-PR gate stands at ${after.preStatus ?? 'not run'}${said}`
        : `the post-PR review of PR #${after.pr ?? '?'} stands at ${after.phase === 'ready' ? 'ready' : (after.postStatus ?? 'in progress')}` +
          `${after.phase === 'ready' ? '' : said}`
    return `Nothing to review for ${branch} at ${head.slice(0, 7)}: ${stands}, ${remaining(after)} of ${after.allowance} review rounds left.`
  }
  const tierNote = rec.tier === 'high' ? ' Review and challenge run in parallel, and fixes are reviewed before each new round.' : ''
  const lightNote = rec.lane === 'light' ? ` Light lane: ${branch} matches lightBranches.` : ''
  return (
    `Lifecycle ${prior === undefined ? 'started' : 'resumed'} for ${branch} → ${base}: ${rec.tier} blast radius (${rec.tierWhy}), ` +
    `Codex at ${run.effort} effort, ${remaining(rec)} of ${rec.allowance} review rounds left.${tierNote}${lightNote}`
  )
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


// ---------------------------------------------------------- the guards

/** The checked-out branch a create is for, when it is this gate's to review; else undefined. */
const gatedCreate = async ($: Engine, action: PrAction): Promise<{ root: string; branch: string; base: string } | undefined> => {
  const base = action.base ?? config.bases[0] ?? 'dev'
  if (!config.bases.includes(base)) return undefined
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return undefined
  const root = top.out
  if (action.repo !== undefined) {
    const origin = await git($, root, ['remote', 'get-url', 'origin'])
    if (origin.isOk && slugOf(origin.out) !== slugOf(action.repo)) return undefined
  }
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  // A PR from a branch that is not checked out here (a release PR, dev into main) is not this gate's to review.
  if (action.head !== undefined && action.head.replace(/^[^:]+:/, '') !== branch) return undefined
  // A promotion between gated bases (dev into main) carries only what was gated on its way in.
  if (config.bases.includes(branch)) return undefined
  return { root, branch, base }
}

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
  const allows = (one: LifecycleRecord | undefined): one is LifecycleRecord =>
    one !== undefined &&
    // A reset record lets nothing through: the lifecycle starts fresh.
    one.phase !== 'archived' &&
    (one.waivers.some(each => each.scope === 'pre' && each.head === head) ||
      (one.preStatus === 'passed' && !hasSecurityBlocker(one)) ||
      (one.preStatus === 'exhausted' && config.onExhausted === 'open-pr' && !hasSecurityBlocker(one)))
  const rec = await loadRecord($, root, branch)
  if (allows(rec) && rec.preHead === head) return undefined
  if (allows(rec) && rec.preHead !== undefined) {
    // Commits since the gate finished: docs alone (a CHANGELOG line) ride on its verdict; code does not.
    const since = await git($, root, ['diff', '--numstat', rec.preHead, 'HEAD'])
    const files = since.out === '' ? [] : since.out.split('\n').map(line => line.split('\t')[2] ?? '')
    if (since.isOk && files.length > 0 && classify(files, 0, config.highRisk).tier === 'trivial') {
      await saveRecord($, { ...rec, preHead: head })
      return undefined
    }
  }
  const started = await startGate($, { base, cwd: root, isHeldCall: true })
  // A change Codex is not needed for passes at once: the held call goes straight through.
  const after = await loadRecord($, root, branch)
  if (allows(after) && after.preHead === head) return undefined
  const held = after === undefined || (await getRun($))?.status === 'running' ? undefined : heldReason(after)
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
      'End your turn: the gate reviews the branch, sends back any findings to fix, and prompts you to open the pull request when it is done.',
      `(The person can type /${COMMAND} status, or /${COMMAND} waive pre <reason> to open it without the gate.)`,
    ].join('\n') + unknownNote(action)
  )
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
  const holding = mergeHolds(rec).map(one => `${one.id} [${one.severity}] ${said(one)}`)
  if (rec.postStatus !== undefined) return `${rec.postStatus}: ${rec.message ?? 'no reason recorded'}${holding.length === 0 ? '' : `; ${holding.join(', ')}`}`
  if (holding.length > 0 && (rec.phase === 'ready' || post.length > 1)) return holding.join(', ')
  if (post.length === 0) return `post-PR round 1 owed on ${rec.head.slice(0, 7)}`
  if (post.length === 1 && post[0]?.endHead !== post[0]?.startHead) return `post-PR round 2 owed on ${rec.head.slice(0, 7)}`
  if (open.length > 0) return open.map(one => `${one.id} [${one.severity}] unresolved`).join(', ')
  return 'review in progress'
}

/**
 * Whether a PR may be merged now (merge, enqueue or auto-merge): its lifecycle must be ready for the PR's current head,
 * or the person waived post for it. A refusal never starts work, and tells the agent its own next step.
 */
const judgeMerge = async ($: Engine, action: PrAction): Promise<string | undefined> => {
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return undefined
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
  const isWaived = rec?.waivers.some(one => one.scope === 'post' && one.head === pr.headRefOid) === true
  if (isWaived && rec !== undefined && securityHolds(rec).length === 0) return undefined
  // The same predicate as the controller's ready (R39): ready for this head, and nothing holds the merge.
  if (rec !== undefined && rec.phase === 'ready' && rec.head === pr.headRefOid && mergeHolds(rec).length === 0) return undefined
  const short = pr.headRefOid.slice(0, 7)
  const missing =
    rec === undefined
      ? 'no lifecycle record for this branch'
      : rec.phase === 'ready' && rec.head !== pr.headRefOid
        ? `${short} was pushed after the review completed at ${rec.head.slice(0, 7)}`
        : owedOf(rec)
  const run = await getRun($)
  const isRunning = run !== null && run.status === 'running' && rec !== undefined && run.root === rec.root && run.branch === rec.branch
  // The agent's own next step; the person is named only where the spec leaves the decision to them.
  const next =
    rec === undefined
      ? `Your next step: check out ${pr.headRefName} and run /${COMMAND}, which adopts the open PR into post-PR review; merging is held until it is complete.`
      : isRunning
        ? `End your turn: /${COMMAND} collects the reviews itself, sends you what needs an answer, and says when the PR is ready for the merge decision.`
        : rec.phase !== 'ready' && rec.postStatus === 'awaiting-decision'
          ? `This needs the person's decision: tell them which findings are deferred or disputed and why, then stop. They can type ` +
            `/${COMMAND} waive <findingId> <reason> for each one, or /${COMMAND} waive post <reason> to let this head merge.`
          : rec.phase !== 'ready' && rec.postStatus === 'blocked'
          ? `Your next step: run /${COMMAND} resume on ${pr.headRefName}; it sends you the open items to answer, or has Codex check a rebuttal.`
          : rec.phase !== 'ready' && rec.postStatus === 'exhausted'
          ? `This needs the person's decision: tell them why. They can type /${COMMAND} waive post <reason> to let this head merge, ` +
            `or /${COMMAND} allow 1 <reason> for one more review round.`
          : `Your next step: check out ${pr.headRefName} and run /${COMMAND} resume, which reviews ${short} and says when the PR is ready to merge.`
  return (
    [
      `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held: the lifecycle review is not complete for ${short}: ${missing}.`,
      'Do not merge another way.',
      next,
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
  const saved = await updateRecord($, root, branch, rec => ({ ...rec, ...who, phase: 'post', pr: pr.number, head: pr.headRefOid }))
  await markOpened($)
  if (saved !== undefined) await advance($, root, branch)
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
  return (
    `${rec.branch} → ${rec.base}: ${rec.phase}${standing === undefined ? '' : ` (${standing})`}${pr}, ` +
    `${usedRounds(rec)}/${rec.allowance + granted} rounds used, baseline ${baseline}/2, ${unresolvedBlockers(rec).length} blocking open, ` +
    `${verificationOwed(rec).length} owed, ${mergeHolds(rec).length} holding the merge.${rec.message === undefined ? '' : ` ${rec.message}.`}${live}${pane}`
  )
}

/** Why a finding is settled, for a waiver that has nothing to release. */
const settledAs = (rec: LifecycleRecord, one: Finding): string =>
  rec.waivers.some(each => each.scope === 'finding' && each.findingId === one.id)
    ? 'waived'
    : isAcceptedRebuttal(one)
      ? 'its rebuttal is accepted by Codex'
      : one.status === 'verified-fixed'
        ? 'verified fixed'
        : one.status

/**
 * `/pr-gate start|<base>`, `status`, `stop`, `resume`, `waive pre|post|<findingId> <reason>`, `allow <n> <reason>`, `reset`.
 * Waivers, `allow` and `reset` are the person's alone. The replies may start with the command; prompts never do (R21).
 */
const runCommand = async ($: Engine, args: string, origin: string): Promise<string> => {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const run = await getRun($)
  if (verb === 'status') return statusText($, run)
  if (verb === 'stop') {
    if (run === null || run.status !== 'running') return `/${COMMAND} is not running.`
    await finish($, run.id, 'stopped', 'Stopped by the person.')
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
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const head = (await git($, root, ['rev-parse', 'HEAD'])).out
  const stored = await loadRecord($, root, branch)
  const rec = stored?.phase === 'archived' ? undefined : stored
  const now = await $.clock.now()
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
    if (isOurs) await finish($, run.id, 'stopped', 'Reset by the person.')
    const last = await loadRecord($, root, branch)
    if (last !== undefined && last.phase !== 'archived') {
      // The whole record is kept under an archive key; the branch's own key keeps only what a fresh start must not repeat (R47).
      await archiveRecord($, last, now)
      const { base, head: at, tier, tierWhy, lane, allowance } = last
      const seed = newRecord({ root, branch, base, head: at, tier, tierWhy, lane, allowance, at: now })
      await saveRecord($, { ...seed, processed: last.processed, replies: last.replies, phase: 'archived' })
    }
    return `/${COMMAND}: the lifecycle for ${branch} is archived under its own key, its history kept. /${COMMAND} starts a fresh one.`
  }
  if (verb === 'allow') {
    const n = Number(rest[0])
    const reason = rest.slice(1).join(' ').trim()
    if (!Number.isInteger(n) || n < 1 || n > 5 || reason === '') return `Say how many and why: /${COMMAND} allow <1-5> <reason>`
    if (rec === undefined) return none
    await saveRecord($, { ...rec, grants: [...rec.grants, { n, reason, head, at: now }] })
    // A run in flight reads the grant when its round ends; otherwise the controller decides again now (a ready record stays ready).
    if (!isRunning && rec.phase !== 'ready') await advance($, root, branch)
    const after = (await loadRecord($, root, branch)) ?? rec
    // Rounds never settle a deferral or a dispute (R42): only the person's waiver of each does.
    const theirs = mergeHolds(after).filter(one => one.status === 'deferred' || isDisputed(one))
    const settles =
      theirs.length === 0
        ? ''
        : ` Rounds settle no deferral or dispute: ${theirs.map(one => `/${COMMAND} waive ${one.id} <reason>`).join(', ')} ` +
          `${theirs.length === 1 ? 'releases' : 'release'} ${ids(theirs)}.`
    return `/${COMMAND}: ${n} more round${n === 1 ? '' : 's'} allowed for ${branch}: ${reason}.${settles}`
  }
  const [scope = '', ...why] = rest
  const reason = why.join(' ').trim()
  const isFinding = /^[RG]\d+-\d+$/.test(scope)
  if ((scope !== 'pre' && scope !== 'post' && !isFinding) || reason === '') return `Say what and why: /${COMMAND} waive pre|post|<findingId> <reason>`
  if (isFinding) {
    const finding = rec?.findings.find(one => one.id === scope)
    if (rec === undefined || finding === undefined) return `/${COMMAND}: there is no finding ${scope} in the lifecycle of ${branch}.`
    if (!mergeHolds(rec).some(one => one.id === scope)) {
      return `/${COMMAND}: ${scope} is already settled (${settledAs(rec, finding)}): there is nothing to waive.`
    }
    // Waived at this head: a waiver that lapsed on a file change (R50) is given again, so the finding's flag is cleared with it.
    const findings = rec.findings.map(one => (one.id === scope ? { ...one, needsRecheck: undefined } : one))
    const waiver = { scope: 'finding' as const, findingId: scope, head: rec.head, reason, by: origin, at: now }
    await saveRecord($, { ...rec, findings, waivers: [...rec.waivers, waiver] })
    // A round in flight carries its own copy of the ledger: it is not asked about again, and its flag does not come back at the round's end.
    if (isOurs) {
      await patch($, run.id, one => ({
        ...one,
        findings: one.findings.map(each => (each.id === scope ? { ...each, needsRecheck: undefined } : each)),
        ...(one.asked === undefined ? {} : { asked: one.asked.filter(id => id !== scope) }),
      }))
    }
    // Released from the merge test and from ready: the controller decides again, unless a round in flight will.
    if (!isRunning) await advance($, root, branch)
    const after = await loadRecord($, root, branch)
    const wasPassed = rec.preStatus === 'passed' && rec.preHead === after?.preHead
    if (after !== undefined && after.phase === 'pre' && after.preStatus === 'passed' && !wasPassed) sayOpenPr($, after, 'passed', now)
    return `/${COMMAND} waived ${scope} for ${branch}: ${reason}.`
  }
  if (scope === 'pre') {
    if (rec !== undefined && rec.phase !== 'pre') {
      return (
        `/${COMMAND}: PR #${rec.pr ?? '?'} from ${branch} is already open, so there is no pre-PR review to waive. ` +
        `/${COMMAND} waive post <reason> lets this head merge.`
      )
    }
    if (isOurs && run.lifecycle === 'pre') await finish($, run.id, 'waived', `Waived: ${reason}`)
    // A waiver covers this commit for every gated base, and is kept in the record's history.
    const base =
      rec ??
      newRecord({
        root,
        branch,
        base: config.bases[0] ?? 'dev',
        head,
        tier: 'standard',
        tierWhy: 'not scoped: waived before the gate ran',
        lane: 'full',
        allowance: config.allowances.standard,
        at: now,
      })
    const waiver = { scope: 'pre' as const, head, reason, by: origin, at: now }
    const waived: LifecycleRecord = { ...base, preStatus: 'waived', preHead: head, waivers: [...base.waivers, waiver] }
    await saveRecord($, waived)
    sayOpenPr($, waived, 'waived', now)
    return `/${COMMAND} waived pre-PR review for ${branch} at ${head.slice(0, 7)}: ${reason}. The PR may open; post-PR review still runs.`
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
  const pr = await openPrOf($, root, branch)
  const at = pr?.headRefOid ?? head
  const base =
    rec ??
    newRecord({ root, branch, base: config.bases[0] ?? 'dev', head, tier: 'standard', tierWhy: 'waived before scoping', lane: 'full', allowance: 0, at: now })
  await saveRecord($, { ...base, waivers: [...base.waivers, { scope: 'post', head: at, reason, by: origin, at: now }] })
  return `/${COMMAND} waived post-PR review for ${branch} at ${at.slice(0, 7)}: ${reason}. This head may merge; a new commit needs a new review or waiver.`
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
        const who = run.pending.find(one =>
          one.isMain === true ? e.agentId === undefined && one.isArmed === true : one.agentId !== undefined && one.agentId === e.agentId,
        )
        if (who === undefined) return
        const activity = activityOf(who.role, String(e.tool), e as unknown as Record<string, unknown>)
        if (activity !== run.activity) await patch($, run.id, one => ({ ...one, activity }))
      })().catch(() => undefined)
    }
    const action = readPrAction(String(e.tool), e as unknown as Record<string, unknown>)
    if (action === undefined) return next(e)
    if (action.action === 'merge') {
      // A merge given by URL names its repository there: gh pr view reads that one, and another repo's PR is not intercepted.
      const command = (e as unknown as Record<string, unknown>).command
      const url = action.repo === undefined && typeof command === 'string' ? command.match(/github\.com\/([^/\s'"]+\/[^/\s'"]+)\/pull\/(\d+)/) : null
      const target = url !== null && url[1] !== undefined && Number(url[2]) === action.number ? { ...action, repo: url[1] } : action
      const refusal = config.enforceMerge ? await judgeMerge($, target) : undefined
      return refusal !== undefined ? { deny: refusal } : next(e)
    }
    const gated = await gatedCreate($, action)
    const refusal = gated !== undefined && config.enforce ? await judgeCreate($, action, gated) : undefined
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    if (gated !== undefined && ran.deny === undefined && ran.isError !== true) await onOpened($, gated.root, gated.branch)
    return ran
  }).catch(($, e, next) => {
    const action = next.called ? undefined : readPrAction(String(e.tool), e as unknown as Record<string, unknown>)
    if (action === undefined) return next(e)
    return {
      deny:
        'pr-gate: its guard failed, so this pull request action is held. Try it once more; if it fails again, tell the person, ' +
        `who can type /${COMMAND} waive ${action.action === 'merge' ? 'post' : 'pre'} <reason> to let it through.`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isLiveNow()) {
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
      description: "Run /pr-gate: pre-PR Codex review, then the PR's own reviews, under one budget (start, status, stop, resume, waive, allow, reset)",
      argumentHint: '[base] | status | stop | resume | waive pre|post|<id> <reason> | allow <n> <reason> | reset',
      immediate: true,
    })
    const run = await getRun($)
    if (run !== null && run.status === 'running') {
      // A reload dropped the module's timer, not the run: the host kept it.
      startTicker($)
      void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
    } else {
      setLive(false)
      // A new session: a post-PR review that was under way when the last one ended goes on collecting. Processed ids and
      // recorded replies keep it from repeating work; a record that is ready, held, stopped or awaiting the person is left as it is.
      try {
        const top = await git($, e.cwd, ['rev-parse', '--show-toplevel'])
        const branch = top.isOk ? (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out : ''
        const rec = top.isOk && branch !== '' && branch !== 'HEAD' ? await loadRecord($, top.out, branch) : undefined
        // A review that stopped on an error (gh down, a step that failed) polls again, as the spec's restart does; a stop is the person's.
        if (rec !== undefined && rec.phase === 'post' && (rec.postStatus === undefined || rec.postStatus === 'error')) {
          if (rec.postStatus === 'error') await updateRecord($, top.out, branch, one => ({ ...one, postStatus: undefined }))
          await holdingPrompts($, () => advance($, top.out, branch))
        }
      } catch {
        // The session starts whatever the record says.
      }
    }
    return next(e)
  })

  // Prompts a command decides wait until it has returned: the host refuses a submit while the command holds the turn.
  on('command.run', { command: 'pr-gate' }, async ($, e) => ({ text: await holdingPrompts($, () => runCommand($, e.args, e.origin.kind)) }))

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const run = await read($, runAtom)
    const now = await read($, tickAtom)

    if (run === null) {
      return (
        <Box flexDirection="column">
          <Text bold>PR lifecycle</Text>
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
            ? `addressing advisories, round ${run.round}`
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
          {run.fixKind === 'advisory' ? ' · advisories' : ''} · {run.tier} blast radius{run.lane === 'light' ? ' · light lane' : ''} · codex {run.effort} ·{' '}
          {elapsed((run.endedAt ?? now) - run.startedAt)}
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
              strikethrough={one.status === 'verified-fixed' || one.status === 'reported-fixed'}
            >
              {one.status === 'verified-fixed' || one.status === 'reported-fixed'
                ? '✔'
                : one.status === 'rebutted'
                  ? '↩'
                  : one.status === 'deferred'
                    ? '⏸'
                    : isBlocking(one)
                      ? '●'
                      : '·'}{' '}
              {one.id} [
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
