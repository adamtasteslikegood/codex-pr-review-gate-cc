import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Run } from '../types'

export const RUN = { plugin: 'pr-lifecycle', key: 'run' } as const
export const TRAILER = 'PR_GATE_RESULT'

export type World = {
  spawned: { prompt: string; description?: string }[]
  prompts: string[]
  opened: string[]
  git: {
    head: string
    dirty: string
    numstat: string
    branch: string
    since: string
    /** `git diff --raw` against the base. */
    raw: string
    /** Whether a submodule commit is on the submodule's origin. */
    isLanded: boolean
    /** `git diff -U0` of a package file. */
    pkgDiff: string
    /** Commits not on the other base, as `rev-list` prints them. */
    left: string
    /** `git diff --name-only` between two heads: the files a new commit touched. */
    changed: string
    /** Whether the local head is an ancestor of another commit (`merge-base --is-ancestor <head> <sha>`). */
    isAncestor: boolean
    /** `.github/pr-gate.json` on the base (`git show origin/<base>:...`); empty means none. */
    roster: string
    /** When set, only `origin/<rosterOn>` has the file: any other base's read fails as a missing path or ref does. */
    rosterOn?: string
    /** Each base's own file, by base name; a base listed here ignores `roster` and `rosterOn`. */
    byBase: Record<string, string>
    /** `.github/pr-gate.json` at the branch's own HEAD; empty means none. The mod must never read it (R67). */
    headRoster: string
    /** Local branches besides the checked-out one. */
    locals: string[]
    /** The session is outside any checkout: `rev-parse --show-toplevel` fails wherever it runs. */
    isOutside: boolean
    /** How many `git fetch` calls fail from now on, each with `fetchError` on stderr. */
    fetchFails: number
    fetchError: string
    /** When set, only a fetch whose arguments end with this ref counts toward `fetchFails`. */
    fetchOnly?: string
    /** Refs the remote does not have: a fetch naming one fails as git does, with "couldn't find remote ref". */
    missingRefs: string[]
    /** Every `git fetch` call's arguments. */
    fetches: string[]
    /** Called on each `git fetch`, before it answers: a test changes what the remote has. */
    onFetch?: () => void
  }
  /** The fake `gh`: the PR of the checked-out branch, its feedback and checks, and every call made. */
  gh: {
    pr: number
    prHead: string
    base: string
    headRef: string
    self: string
    reviews: object[]
    comments: object[]
    issueComments: object[]
    checks: object[]
    isAuthed: boolean
    /** Whether the branch has an open PR: false until a PR-creating Bash call succeeds, or a test opens one. */
    hasPr: boolean
    /** The PR's state as gh reports it: OPEN, MERGED or CLOSED. */
    state: string
    /** The repository's default branch, as `gh repo view` reports it; undefined makes the lookup fail. */
    defaultBranch?: string
    /** `gh pr checks` fails with an error instead of reporting the checks. */
    isChecksUnreadable: boolean
    /** Every gh call throws, as a broken runtime would. */
    isBroken: boolean
    /** When set, every `gh api` call but `api user` prints this with exit 0, as a proxy's error page would. */
    garbage?: string
    calls: string[]
  }
  /** The run as the mod last wrote it. */
  run?: Run
  /** The plugin's store, as the mod wrote it. */
  store: Map<string, unknown>
  stored: (key: string) => unknown
  /** The test's clock: `advance` moves it, and fires what falls due. */
  clock: { advance: (ms: number) => Promise<void> }
  /** A new session: the run state reads as empty until the mod writes it again; the store stays. */
  clearState: () => void
  /** Called after each store read, with the key and how many reads of it came before: a test changes the store between two reads. */
  afterRead?: (key: string, n: number) => void
}

export const runOf = async (w: World): Promise<Run> => w.run as Run

// The world a test made last: the host starts the main agent's turn with the prompt that was sent last.
let latest: World | undefined
let turns = 0

type Dispatch = Parameters<TestBody>[0]
type Ended = Parameters<Dispatch['turn']['complete']>[0]

/**
 * A turn of an agent's loop ends with `t`. The main agent's turn starts first, with the last prompt the mod sent as its
 * text, as the host runs a submitted prompt; each gets its own id. A sub-agent's turn only ends.
 */
export async function done($: Dispatch, t: Ended): Promise<unknown> {
  if (t.agentId !== undefined) return $.turn.complete(t)
  turns += 1
  const turnId = `${t.turnId}-${turns}`
  await $.turn.start({ text: latest?.prompts.at(-1) ?? '', turnId })
  return $.turn.complete({ ...t, turnId })
}

/** Everything beneath the mod: git, the agents, the main agent's prompt queue. */
export function world(on: On): World {
  const clock = mock.clock(on, { now: 1_000 })
  const w: World = {
    spawned: [],
    prompts: [],
    opened: [],
    git: {
      head: 'a'.repeat(40),
      dirty: '',
      numstat: '10\t2\tsrc/app.ts',
      branch: 'feat/x',
      since: '',
      raw: '',
      isLanded: false,
      pkgDiff: '',
      left: 'x',
      changed: 'src/app.ts',
      isAncestor: false,
      roster: '',
      headRoster: '',
      byBase: {},
      locals: [],
      isOutside: false,
      fetchFails: 0,
      fetchError: 'fatal: unable to access origin: Could not resolve host: github.com',
      fetches: [],
      missingRefs: [],
    },
    gh: {
      pr: 1,
      prHead: 'a'.repeat(40),
      base: 'dev',
      headRef: 'feat/x',
      self: 'me',
      reviews: [],
      comments: [],
      issueComments: [],
      checks: [],
      isAuthed: true,
      hasPr: false,
      state: 'OPEN',
      defaultBranch: 'dev',
      isChecksUnreadable: false,
      isBroken: false,
      calls: [],
    },
    store: new Map(),
    stored: (key: string) => w.store.get(key),
    clock,
    clearState: () => {
      isCleared = true
      w.run = undefined
    },
  }
  let isCleared = false
  latest = w
  // A new session reads no run until the mod writes one. Since steps are armed by their own turn (R51), the hop this adds to each read is harmless.
  on('state.get', RUN, (_$, e, next) =>
    isCleared ? next(e).then(read => (read.value === undefined ? read : { value: { ...read.value, value: null } })) : next(e),
  )
  const reads = new Map<string, number>()
  on('store.get', (_$, e) => {
    const value = w.store.get(e.key)
    const n = reads.get(e.key) ?? 0
    reads.set(e.key, n + 1)
    w.afterRead?.(e.key, n)
    return { value }
  })
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('state.set', RUN, (_$, e, next) => {
    isCleared = false
    w.run = e.value as Run
    return next(e)
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(1).join(' ')
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'gh') {
      w.gh.calls.push(args)
      if (w.gh.isBroken) throw new Error('gh broke')
      if (!w.gh.isAuthed) return out('', 4)
      if (args.startsWith('api user')) return out(`${w.gh.self}\n`)
      if (args.startsWith('repo view')) {
        if (w.gh.defaultBranch === undefined) {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        return out(JSON.stringify({ defaultBranchRef: { name: w.gh.defaultBranch } }))
      }
      if (w.gh.garbage !== undefined && args.startsWith('api ')) return out(w.gh.garbage)
      if (args.startsWith('pr view')) {
        if (!w.gh.hasPr) return out('', 1)
        return out(JSON.stringify({ number: w.gh.pr, baseRefName: w.gh.base, headRefName: w.gh.headRef, headRefOid: w.gh.prHead, state: w.gh.state }))
      }
      // `gh pr checks --json`: the same check runs, by gh's buckets; none at all is gh's "no checks reported" error.
      if (args.startsWith('pr checks')) {
        const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
        if (w.gh.isChecksUnreadable) return fail('HTTP 502: Bad Gateway')
        if (w.gh.checks.length === 0) return fail(`no checks reported on the '${w.gh.headRef}' branch`)
        const bucket = (one: Record<string, unknown>): string =>
          one.status !== 'completed'
            ? 'pending'
            : one.conclusion === 'success' || one.conclusion === 'neutral'
              ? 'pass'
              : one.conclusion === 'skipped'
                ? 'skipping'
                : one.conclusion === 'cancelled'
                  ? 'cancel'
                  : 'fail'
        const rows = (w.gh.checks as Record<string, unknown>[]).map(one => ({
          name: one.name,
          state: String(one.conclusion ?? one.status).toUpperCase(),
          bucket: bucket(one),
        }))
        return out(JSON.stringify(rows))
      }
      if (/pulls\/\d+\/reviews/.test(args)) return out(JSON.stringify(w.gh.reviews))
      if (/pulls\/\d+\/comments/.test(args)) return out(JSON.stringify(w.gh.comments))
      if (/issues\/\d+\/comments/.test(args)) return out(JSON.stringify(w.gh.issueComments))
      if (/commits\/[0-9a-f]+\/check-runs/.test(args)) return out(JSON.stringify({ check_runs: w.gh.checks }))
      if (/requested_reviewers/.test(args)) return out('{}')
      return out('')
    }
    if (args.startsWith('fetch')) {
      w.git.fetches.push(args)
      w.git.onFetch?.()
      const fail = (stderr: string) => ({ value: { exitCode: 128, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      const missing = w.git.missingRefs.find(ref => e.argv.slice(3).includes(ref))
      if (missing !== undefined) return fail(`fatal: couldn't find remote ref ${missing}`)
      if (w.git.fetchFails <= 0 || (w.git.fetchOnly !== undefined && !args.endsWith(` ${w.git.fetchOnly}`))) return out('')
      w.git.fetchFails -= 1
      return fail(w.git.fetchError)
    }
    if (args.startsWith('show HEAD:.github/pr-gate.json')) return out(w.git.headRoster, w.git.headRoster === '' ? 128 : 0)
    const onBase = args.match(/^show origin\/(\S+):\.github\/pr-gate\.json$/)?.[1]
    if (onBase !== undefined) {
      const file = Object.hasOwn(w.git.byBase, onBase) ? (w.git.byBase[onBase] ?? '') : w.git.rosterOn === undefined || w.git.rosterOn === onBase ? w.git.roster : ''
      return out(file, file === '' ? 128 : 0)
    }
    // Outside a checkout (`cd /tmp && ...`), git finds no repository.
    if (args.startsWith('rev-parse --show-toplevel')) return e.init?.cwd === '/tmp' || w.git.isOutside ? out('', 128) : out('/repo\n')
    if (args.startsWith('rev-parse --abbrev-ref')) return out(`${w.git.branch}\n`)
    if (args.startsWith('rev-parse --verify --quiet refs/heads/')) {
      const name = args.slice('rev-parse --verify --quiet refs/heads/'.length)
      return out('', name === w.git.branch || w.git.locals.includes(name) ? 0 : 1)
    }
    if (args.startsWith('rev-parse --verify')) return out('b\n')
    if (args.startsWith('rev-parse HEAD')) return out(`${w.git.head}\n`)
    if (args.startsWith('status')) return out(w.git.dirty)
    if (args.startsWith('diff --numstat origin/')) return out(w.git.numstat)
    if (args.startsWith('diff --raw')) return out(w.git.raw)
    if (args.startsWith('diff -U0')) return out(w.git.pkgDiff)
    if (args.startsWith(`merge-base --is-ancestor ${w.git.head}`)) return out('', w.git.isAncestor ? 0 : 1)
    if (args.startsWith('merge-base --is-ancestor')) return out('', w.git.isLanded ? 0 : 1)
    if (args.startsWith('rev-list --no-merges')) return out(w.git.left)
    if (args.startsWith('diff --numstat')) return out(w.git.since)
    if (args.startsWith('diff --name-only')) return out(w.git.changed)
    if (args.startsWith('remote get-url')) return out('https://github.com/me/repo.git\n')
    return out('')
  })
  on('agent.spawn', (_$, e) => {
    w.spawned.push({ prompt: e.prompt, description: e.description })
    return { model: 'test', agentId: `agent-${w.spawned.length}` }
  })
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.opened.push(e.command)
    // A PR-creating call that ran opens the branch's PR on the fake GitHub, when it is to the fake PR's base.
    const base = e.command.match(/--base\s+(\S+)/)?.[1]
    if (/\bpr\s+create\b|createPullRequest|\/pulls\b/.test(e.command) && (base === undefined || base === w.gh.base)) w.gh.hasPr = true
    return { result: { stdout: 'https://github.com/me/repo/pull/1', stderr: '', interrupted: false } as never }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return w
}

export const review = (step: string, gate: string, findings: object[] = [], extra: object = {}) =>
  `Codex said things.\n${TRAILER}\n${JSON.stringify({ step, gate, findings, ...extra })}`

export const P1 = { severity: 'P1', title: 'Unvalidated redirect', file: 'src/app.ts', line: 12 }
export const P2 = { severity: 'P2', title: 'Rename this', file: 'src/app.ts', line: 3 }

export const turn = (answer: string, agentId?: string) => ({
  answer,
  agentId,
  durationMs: 1,
  isAborted: false,
  turnId: `turn-${agentId ?? 'main'}`,
  reason: 'answer' as const,
})

export const isHeld = (ran: { deny?: string; isError?: boolean }): boolean => ran.deny !== undefined || ran.isError === true

export const createPr = { tool: 'Bash' as const, command: 'gh pr create --base dev --title "feat: x [KAN-1]"' }
