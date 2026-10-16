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
import { activityOf, classify, isBlocking, isVersionOnly, lowerOf, prPrompt, readGitlinks, slugOf, stepDown } from './core'
import { readPrAction } from './github'
import type { PrAction } from './github'
import { allowanceFor, invalidate, isDisputed, lastReviewedHead, mergeHolds, newRecord, remaining, rescope, unresolvedBlockers } from './lifecycle'
import {
  advance,
  configOf,
  elapsed,
  finish,
  getRun,
  git,
  hasSecurityBlocker,
  heldReason,
  isLiveNow,
  markPr,
  onAnswer,
  PANE,
  patch,
  setLive,
  setup,
  SPINNER,
  startTicker,
} from './round'
import type { Config } from './round'
import { loadRecord, saveRecord, updateRecord } from './store'

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
          effort,
          ...(scope.tier === 'trivial' ? { passThrough: scope.why } : {}),
        }
  if (prior !== undefined && prior.head !== head) {
    const lastHead = lastReviewedHead(prior)
    const since = lastHead === undefined ? undefined : await git($, root, ['diff', '--name-only', lastHead, head])
    rec = { ...rec, findings: invalidate(rec.findings, since?.isOk === true ? new Set(since.out.split('\n').filter(Boolean)) : 'all') }
  }
  // A PR the gate never saw opened (opened by hand, or before this mod): adopt it straight into post-PR review.
  const adopted = prior === undefined || prior.phase === 'pre' ? await openPrOf($, root, branch) : undefined
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
      void $.prompt.submit({ text: prPrompt(shown, saved, 'passed') }).catch(() => undefined)
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
  if (held !== undefined) {
    // No round started: the PR stays held for a settled reason, and waiting will not change it.
    return [
      `pr-gate: ${action.via} to ${base} is held for ${branch} at ${head.slice(0, 7)}: ${held.why}.`,
      `Your next step: ${held.nextStep}. Do not create the pull request another way.`,
      `Tell the person: they can type /${COMMAND} waive <reason> to let this commit through, or /${COMMAND} allow 1 <reason> for one more review round.`,
    ].join('\n') + unknownNote(action)
  }
  return (
    [
      `pr-gate: ${action.via} to ${base} waits for the pre-PR review of ${branch} at ${head.slice(0, 7)}.`,
      started,
      'Do not retry this command and do not open the pull request another way.',
      'End your turn: the gate reviews the branch, sends back any findings to fix, and prompts you to open the pull request when it is done.',
      `(The person can type /${COMMAND} status, or /${COMMAND} waive <reason> to open it without the gate.)`,
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
  const rec = await loadRecord($, root, pr.headRefName)
  // No record and no such branch here: a PR from a branch not checked out here is not this gate's to review.
  if (rec === undefined && !(await git($, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${pr.headRefName}`])).isOk) return undefined
  if (rec?.waivers.some(one => one.scope === 'post' && one.head === pr.headRefOid) === true) return undefined
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
        `who can type /${COMMAND} waive ${action.action === 'merge' ? 'post ' : ''}<reason> to let it through.`,
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
      description: 'Run the PR lifecycle review on this branch (start, resume, status, stop, waive)',
      argumentHint: '[base] | resume | status | stop | waive <reason>',
      immediate: true,
    })
    const run = await getRun($)
    if (run !== null && run.status === 'running') {
      // A reload dropped the module's timer, not the run: the host kept it.
      startTicker($)
      void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
    } else {
      setLive(false)
    }
    return next(e)
  })

  on('command.run', { command: 'pr-gate' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const run = await getRun($)
    if (verb === 'status') {
      // Says where the pane stands too: a surface that places no panes gives its reason here.
      const pane = await $.ui
        .open({ id: PANE, title: 'PR lifecycle' })
        .then(opened => (opened.isPlaced ? ' The pane is open.' : ` The pane is not drawn here: ${opened.reason}`))
        .catch(() => ' The pane could not be opened.')
      if (run === null) return { text: `pr-gate has not run in this session.${pane}` }
      const rec = await loadRecord($, run.root, run.branch)
      const open = (rec?.findings ?? run.findings).filter(one => isBlocking(one) && one.status === 'open').length
      const budget = rec === undefined ? '' : `, ${remaining(rec)} of ${rec.allowance} review rounds left`
      return {
        text:
          `pr-gate ${run.status} for ${run.branch} → ${run.base}: round ${run.round}${run.fixKind === 'advisory' ? ' (advisories)' : ''}, ` +
          `codex at ${run.effort}, ${run.findings.length} findings raised, ${open} high/critical open${budget}.` +
          `${run.message === undefined ? '' : ` ${run.message}`}${pane}`,
      }
    }
    if (verb === 'stop') {
      if (run === null || run.status !== 'running') return { text: 'pr-gate is not running.' }
      await finish($, run.id, 'stopped', 'Stopped by the person.')
      return { text: 'pr-gate stopped. Pull requests to a gated base stay held until it passes or is waived.' }
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
      // A waiver covers this commit for every gated base, and is kept in the record's history.
      const prior = await loadRecord($, top.out, branch)
      const rec =
        prior ??
        newRecord({
          root: top.out,
          branch,
          base: config.bases[0] ?? 'dev',
          head,
          tier: 'standard',
          tierWhy: 'not scoped: waived before the gate ran',
          lane: 'full',
          allowance: config.allowances.standard,
          at: now,
        })
      await saveRecord($, {
        ...rec,
        preStatus: 'waived',
        preHead: head,
        waivers: [...rec.waivers, { scope: 'pre', head, reason, by: e.origin.kind, at: now }],
      })
      return { text: `pr-gate waived for ${branch} at ${head.slice(0, 7)}: ${reason}. A new commit needs a new review or waiver.` }
    }
    const base = verb === '' || verb === 'start' || verb === 'resume' ? rest[0] : verb
    return { text: `pr-gate: ${await startGate($, { base })}` }
  })

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
