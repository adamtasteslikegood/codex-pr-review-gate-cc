import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Run } from '../types'

export const RUN = { plugin: 'pr-lifecycle', key: 'run' } as const
export const TRAILER = 'PR_GATE_RESULT'

export type World = {
  /** Each sub-agent spawned: its prompt, its description, and the Claude model it was given (absent: the session's own). */
  spawned: { prompt: string; description?: string; model?: string }[]
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
    /** `git diff --unified=0` between two heads; undefined makes every file in `changed` changed throughout. */
    hunks?: string
    /** Whether the local head is an ancestor of another commit (`merge-base --is-ancestor <head> <sha>`). */
    isAncestor: boolean
    /** `.github/pr-gate.json` on the base (`git show refs/remotes/origin/<base>:...`); empty means none. */
    roster: string
    /** When set, only `origin/<rosterOn>` has the file: any other base's read fails as a missing path or ref does. */
    rosterOn?: string
    /** Each base's own file, by base name; a base listed here ignores `roster` and `rosterOn`. */
    byBase: Record<string, string>
    /** The file under a local tag or branch named `origin/<base>`, which a bare `origin/<base>:` would read instead (M4). */
    shadow: string
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
    onFetch?: () => void | Promise<void>
    /** Called on each `git rev-parse HEAD`, before it answers: a test acts while a step awaits the head. */
    onHead?: () => void | Promise<void>
    /** `git log --format=%h %an %s <a>..<b>`: the commits on the PR since the record's head, one per line. */
    newCommits?: string
    /** The branch's head on origin, as `git ls-remote` prints it; undefined prints nothing. */
    remoteHead?: string
    /** `git log --not --remotes=origin`: the local commits no origin branch has, one `<sha> by <author>` per line. */
    unpushed: string
    /** Called on each `git log --not --remotes=origin`, before it answers: a test acts while a step lists the unpushed commits. */
    onUnpushed?: () => void | Promise<void>
    /** Called on each read of a base's roster file, before it answers: a test acts while the gate reads the roster. */
    onRoster?: () => void | Promise<void>
  }
  /** The fake `gh`: the PR of the checked-out branch, its feedback and checks, and every call made. */
  gh: {
    pr: number
    prHead: string
    base: string
    /** Bases `gh pr view` answers in turn, one per call, before falling back to `base`: a PR retargeted while the gate scopes. */
    baseSeq?: string[]
    headRef: string
    self: string
    reviews: object[]
    comments: object[]
    issueComments: object[]
    checks: object[]
    /**
     * The branch's pushes, as GitHub's repository activity log lists them (#24): the sha each moved the branch to, and when.
     * Only the PR's head branch (`headRef`) has any; undefined lists none.
     */
    pushes?: { after: string; timestamp: string }[]
    /** The owner of the fork the PR comes from; undefined means the PR's own repository (me/repo). Its activity log is the fork's. */
    forkOwner?: string
    /** The activity log call fails, as it does for a token that cannot read it. */
    isActivityBroken?: boolean
    /** The head commit's committer date, as `gh api repos/<slug>/commits/<sha> --jq .commit.committer.date` prints it; undefined fails it. */
    commitDate?: string
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
    /** Checks the base requires; undefined requires every check in `checks` (as before R86). */
    required?: string[]
    /** How the rules endpoint answers: 'ok' (default), 'garbage', 'throw', or an HTTP status. */
    rulesAnswer?: 'ok' | 'paged' | 'garbage' | 'throw' | number
    /** How classic protection answers: 'none' (404, the default), 'ok' (requires 'legacy'), 'garbage', 'throw', or an HTTP status. */
    classicAnswer?: 'none' | 'off' | 'ok' | 'garbage' | 'throw' | number
    calls: string[]
    /** How `gh issue edit` answers when the gate labels a follow-up issue (R85): 'ok' (default) or 'fail'. */
    labelAnswer?: 'ok' | 'fail'
    /** How `gh label create` answers: 'ok' (default) or 'exists', as gh does for a label the repository already has. */
    labelCreateAnswer?: 'ok' | 'exists'
    /** Called on each `gh label create`, before it answers: a test acts while the label is made. */
    onLabelCreate?: () => void | Promise<void>
    /** Called on each `gh issue edit`, before it answers: a test acts while the gate labels an issue. */
    onLabel?: () => void | Promise<void>
    /** Every label call the gate made (its `label` and `issue edit` calls), in order. */
    labelled: string[]
    /**
     * How `gh api -X POST repos/<slug>/issues` answers when the gate files an issue (R92): 'ok' (default) or 'fail'; 'lost' files the
     * issue but answers as a timeout does, so the gate never learns its number (wave 2b gate R1-5).
     */
    issueAnswer?: 'ok' | 'fail' | 'lost'
    /** How `gh api repos/<slug>/issues?state=all&…` lists the issues filed (wave 2b gate R1-5): 'ok' (default) or 'fail'. */
    issueListAnswer?: 'ok' | 'fail'
    /** Unrelated open issues GitHub's list shows before the gate's own, newest first: a list longer than one page (gate R2-2). */
    issueListFiller?: number
    /** Every issue the fake's POST filed, as the REST list gives it; its state is read from `issueStates`, and a 'missing' one is not listed. */
    issues: { number: number; title: string; body?: string; labels: string[] }[]
    /** The number the next filed issue gets (default 21); each filing adds one. */
    issueNumber?: number
    /** The label names the POST's answer carries (A7); undefined echoes the labels asked for. GitHub drops them without push access. */
    issueLabels?: string[]
    /** Every issue the gate filed: its argv after `gh`, in order. */
    filed: string[][]
    /** Called on each issue filing, before it answers: a test acts while the gate files an issue. */
    onIssue?: () => void | Promise<void>
    /**
     * Each issue's state for `gh issue view` (spec §5.12); absent means OPEN, 'missing' answers as a deleted issue does, and
     * 'unreadable' fails as a 502 does.
     */
    issueStates: Record<number, 'OPEN' | 'CLOSED' | 'missing' | 'unreadable'>
    /** How `gh issue reopen` answers: 'ok' (default), 'fail', or 'lost' (GitHub reopens it, then gh fails with a 502). */
    reopenAnswer?: 'ok' | 'fail' | 'lost'
    /** Every reopen the gate ran: its argv after `gh`. */
    reopened: string[][]
    /** Called on each `gh issue view`, before it answers: a test acts while the gate reads an issue after the merge. */
    onIssueView?: () => void | Promise<void>
    /** Called on each `gh pr view`, before it answers: a test acts while the gate reads a PR's state. */
    onPrView?: () => void | Promise<void>
    /** Called on each `gh issue reopen`, before it answers: a test acts while the gate reopens an issue. */
    onReopen?: () => void | Promise<void>
    /** How the agent's `gh pr merge` answers in the Bash fake: 'ok' (default) merges the PR, 'fail' refuses as GitHub would. */
    mergeAnswer?: 'ok' | 'fail'
    /** Logins `GET .../requested_reviewers` lists (R89); undefined lists none. */
    requested?: string[]
    /** Every `-X POST .../requested_reviewers` call the gate made, in order. */
    requests: string[]
    /** Commit statuses on the head (`{ context, state }`), as `GET .../commits/<sha>/status` lists them; undefined lists none. */
    statuses?: object[]
    /** `GET .../commits/<sha>/status` fails, as a 502 would. */
    isStatusBroken?: boolean
    /** `GET .../requested_reviewers` fails, as a 502 would. */
    isRequestedBroken?: boolean
    /** `POST .../requested_reviewers` fails, as a 502 would. */
    isRequestPostBroken?: boolean
    /** `gh pr view <n> --json headRefOid` (the PR head read alone) throws, as a spawn failure does. */
    isHeadReadBroken?: boolean
    /** The read of a merged PR after the agent's merge (`--json number,headRefName,state`) throws, as a failed spawn does. */
    isMergedReadBroken?: boolean
    /** Called on each `gh pr checks`, before it answers: a test acts while the standing is gathered. */
    onChecks?: () => void | Promise<void>
  }
  /**
   * The `acli` fake (spec §5.13.7): Jira's work items as `acli jira workitem create|view|search --json` reads and makes them. Each
   * knob is 'ok' (the default), 'fail' (acli's error), 'unauthorized' (not logged in) or 'missing': acli is not installed, so the
   * spawn throws; for `view`, the ticket does not exist. `create` may also be 'lost': Jira files the ticket, but the answer is a timeout.
   */
  acli: {
    create?: 'ok' | 'fail' | 'unauthorized' | 'missing' | 'lost'
    view?: 'ok' | 'fail' | 'unauthorized' | 'missing'
    search?: 'ok' | 'fail' | 'unauthorized' | 'missing'
    /** Every acli call: its argv after `acli`, in order. */
    calls: string[][]
    /** Every ticket the fake's create filed: `view` answers for these, and a key not here does not exist. */
    tickets: { key: string; summary: string; labels: string[]; description: string }[]
    /** The number of the next ticket (default 512). */
    next?: number
  }
  /** The files `$.fs.write` wrote that no `rm -f` removed since, by path. */
  files: Map<string, string>
  /** Every `$.fs.write`, in order, whether removed since or not. */
  written: { path: string; text: string }[]
  /** `$.fs.write` fails, as a full disk or a missing directory would. */
  isWriteBroken?: boolean
  /** Every toast the mod showed the person, in order. */
  toasts: string[]
  /** A stand-in engine for calling the mod's async helpers directly: its `process.run` is the fake `gh` and `git`. */
  engine: never
  /** The run as the mod last wrote it. */
  run?: Run
  /** The plugin's store, as the mod wrote it. */
  store: Map<string, unknown>
  stored: (key: string) => unknown
  /** The test's clock: `advance` moves it, and fires what falls due. */
  clock: { advance: (ms: number) => Promise<void> }
  /** A new session: the run state reads as empty until the mod writes it again; the store stays. */
  clearState: () => void
  /** The session's id, as `$.session.id()` answers it. */
  sessionId: string
  /** Called after each store read, with the key and how many reads of it came before: a test changes the store between two reads. */
  afterRead?: (key: string, n: number) => void
  /** Awaited before each store read, with its key: a test holds a step at a read until it lets it go. */
  beforeRead?: (key: string) => void | Promise<void>
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
  const mocked = mock.clock(on, { now: 1_000 })
  // The engine stand-in reads the same time the test's clock moves to.
  let now = 1_000
  const clock = { ...mocked, advance: async (ms: number) => { now += ms; await mocked.advance(ms) } }
  const w: World = {
    engine: undefined as never,
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
      shadow: '',
      locals: [],
      isOutside: false,
      fetchFails: 0,
      fetchError: 'fatal: unable to access origin: Could not resolve host: github.com',
      fetches: [],
      unpushed: '',
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
      labelled: [],
      filed: [],
      issues: [],
      issueStates: {},
      reopened: [],
      requests: [],
    },
    acli: { calls: [], tickets: [] },
    files: new Map(),
    written: [],
    toasts: [],
    store: new Map(),
    stored: (key: string) => w.store.get(key),
    clock,
    clearState: () => {
      isCleared = true
      w.run = undefined
    },
    sessionId: 'session-1',
  }
  let isCleared = false
  latest = w
  // A new session reads no run until the mod writes one. Since steps are armed by their own turn (R51), the hop this adds to each read is harmless.
  on('state.get', RUN, (_$, e, next) =>
    isCleared ? next(e).then(read => (read.value === undefined ? read : { value: { ...read.value, value: null } })) : next(e),
  )
  const reads = new Map<string, number>()
  on('store.get', async (_$, e) => {
    await w.beforeRead?.(e.key)
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
  const fake = async (e: { argv: readonly string[]; init?: { cwd?: string } }) => {
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
      // The gate's issue filing (R92): a POST to repos/<slug>/issues; the answer carries the new issue's number and its labels.
      if (e.argv[1] === 'api' && e.argv[2] === '-X' && e.argv[3] === 'POST' && /^repos\/[^/\s]+\/[^/\s]+\/issues$/.test(e.argv[4] ?? '')) {
        w.gh.filed.push(e.argv.slice(1))
        await w.gh.onIssue?.()
        if (w.gh.issueAnswer === 'fail') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 410: Issues are disabled for this repo', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        const number = w.gh.issueNumber ?? 21
        w.gh.issueNumber = number + 1
        const repo = (e.argv[4] ?? '').split('/').slice(1, 3).join('/')
        const asked = e.argv.flatMap(one => (one.startsWith('labels[]=') ? [one.slice('labels[]='.length)] : []))
        const names = w.gh.issueLabels ?? asked
        const title = e.argv.find(one => one.startsWith('title='))?.slice('title='.length) ?? ''
        const body = e.argv.find(one => one.startsWith('body='))?.slice('body='.length) ?? ''
        w.gh.issues.push({ number, title, body, labels: names })
        if (w.gh.issueAnswer === 'lost') {
          const stderr = 'Post "https://api.github.com/repos/me/repo/issues": context deadline exceeded'
          return { value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
        }
        return out(JSON.stringify({ number, html_url: `https://github.com/${repo}/issues/${number}`, labels: names.map(name => ({ name })) }))
      }
      // The check for an issue a lost answer filed (wave 2b gate R1-5): GitHub's REST list, newest first; a PR in it is skipped.
      if (/^api repos\/[^/\s]+\/[^/\s]+\/issues\?state=open&per_page=100&sort=created&direction=desc(&page=\d+)?$/.test(args)) {
        if (w.gh.issueListAnswer === 'fail') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        const listed = [...w.gh.issues].reverse().filter(one => w.gh.issueStates[one.number] !== 'missing').map(one => ({
          number: one.number,
          title: one.title,
          body: one.body ?? '',
          state: (w.gh.issueStates[one.number] ?? 'OPEN') === 'CLOSED' ? 'closed' : 'open',
          labels: one.labels.map(name => ({ name })),
        }))
        const filler = Array.from({ length: w.gh.issueListFiller ?? 0 }, (_, i) => ({ number: 1000 + i, title: `other work ${i}`, state: 'open', labels: [] }))
        const all = [{ number: 99, title: 'a pull request', pull_request: { url: 'x' } }, ...filler, ...listed]
        const page = Number(/&page=(\d+)$/.exec(args)?.[1] ?? '1')
        return out(JSON.stringify(all.slice((page - 1) * 100, page * 100)))
      }
      // The post-merge check (spec §5.12): gh issue view <n> --repo <r> --json state, and gh issue reopen <n> --repo <r> --comment <text>.
      if (e.argv[1] === 'issue' && e.argv[2] === 'view') {
        await w.gh.onIssueView?.()
        const state = w.gh.issueStates[Number(e.argv[3])] ?? 'OPEN'
        if (state === 'unreadable') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        if (state === 'missing') {
          return { value: { exitCode: 1, stdout: '', stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${e.argv[3]}.`, isStdoutTruncated: false, isStderrTruncated: false } }
        }
        return out(JSON.stringify({ state }))
      }
      if (e.argv[1] === 'issue' && e.argv[2] === 'reopen') {
        w.gh.reopened.push(e.argv.slice(1))
        await w.gh.onReopen?.()
        if (w.gh.reopenAnswer === 'fail') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        w.gh.issueStates[Number(e.argv[3])] = 'OPEN'
        if (w.gh.reopenAnswer === 'lost') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        return out('')
      }
      if (w.gh.garbage !== undefined && args.startsWith('api ')) return out(w.gh.garbage)
      const failed = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      if (/^api repos\/\S+\/rules\/branches\/[^\s?]+\?per_page=100(&page=\d+)?$/.test(args)) {
        const how = w.gh.rulesAnswer ?? 'ok'
        if (how === 'throw') throw new Error('network down')
        if (typeof how === 'number') return failed(`gh: HTTP ${how}`)
        if (how === 'garbage') return out('<html>proxy error</html>')
        const names = w.gh.required ?? (w.gh.checks as { name?: string }[]).map(one => String(one.name))
        // 'paged': a full first page of other rules, the required-checks rule on the second.
        if (how === 'paged' && !args.includes('&page=')) return out(JSON.stringify(Array.from({ length: 100 }, () => ({ type: 'deletion' }))))
        return out(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: names.map(context => ({ context })) } }]))
      }
      if (/^api repos\/\S+\/branches\/\S+\/protection/.test(args)) {
        const how = w.gh.classicAnswer ?? 'none'
        if (how === 'throw') throw new Error('network down')
        if (how === 'none') return failed('gh: Branch not protected (HTTP 404)')
        if (how === 'off') return failed('gh: Required status checks not enabled (HTTP 404)')
        if (typeof how === 'number') return failed(`gh: HTTP ${how}`)
        if (how === 'garbage') return out('<html>proxy error</html>')
        return out(JSON.stringify({ contexts: ['legacy'], checks: [] }))
      }
      if (args.startsWith('pr view')) {
        await w.gh.onPrView?.()
        if (w.gh.isHeadReadBroken === true && /--json headRefOid(,baseRefName)?$/.test(args)) throw new Error('spawn failed')
        if (w.gh.isMergedReadBroken === true && args.endsWith('--json number,headRefName,state')) throw new Error('spawn failed')
        if (!w.gh.hasPr) return out('', 1)
        const baseRefName = w.gh.baseSeq?.shift() ?? w.gh.base
        const owner = w.gh.forkOwner ?? 'me'
        // Another repository's PR of the same number and branch, merged there (gate R1-4).
        const isOtherRepo = /(?:-R|--repo)\s+(?!me\/repo\b)\S+/.test(args)
        return out(JSON.stringify({
          number: w.gh.pr,
          baseRefName,
          headRefName: w.gh.headRef,
          headRefOid: w.gh.prHead,
          state: isOtherRepo ? 'MERGED' : w.gh.state,
          headRepository: { id: 'R_1', name: 'repo', nameWithOwner: `${owner}/repo` },
          headRepositoryOwner: { id: 'U_1', login: owner },
          isCrossRepository: owner !== 'me',
        }))
      }
      // `gh pr checks --json`: the same check runs, by gh's buckets; none at all is gh's "no checks reported" error.
      if (args.startsWith('pr checks')) {
        await w.gh.onChecks?.()
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
      // The follow-up issue's severity label (R85): the label is made, then added to the issue, unless the test makes the edit fail.
      if (args.startsWith('label create') || args.startsWith('issue edit')) {
        w.gh.labelled.push(args)
        if (args.startsWith('label create')) await w.gh.onLabelCreate?.()
        if (args.startsWith('label create') && w.gh.labelCreateAnswer === 'exists') return failed(`label with name "${args.split(' ')[2]}" already exists; use \`--force\` to update its color and description`)
        if (args.startsWith('issue edit')) await w.gh.onLabel?.()
        if (args.startsWith('issue edit') && w.gh.labelAnswer === 'fail') return failed('GraphQL: Could not resolve to an issue or pull request with the number of 12.')
        return out('')
      }
      const activity = args.match(/^api repos\/(\S+)\/activity\?ref=refs\/heads\/(\S+)&per_page=100$/)
      if (activity !== null) {
        if (w.gh.isActivityBroken === true) return failed('gh: Resource not accessible by integration (HTTP 403)')
        // Only the head repository's log has the head branch's pushes: the fork's, for a PR from one.
        const isHeadRepo = activity[1] === `${w.gh.forkOwner ?? 'me'}/repo`
        const rows = isHeadRepo && decodeURIComponent(activity[2] ?? '') === w.gh.headRef ? (w.gh.pushes ?? []) : []
        return out(JSON.stringify(rows.map(one => ({ ...one, activity_type: 'push', ref: `refs/heads/${w.gh.headRef}` }))))
      }
      if (/^api repos\/\S+\/commits\/[0-9a-f]+ --jq \.commit\.committer\.date$/.test(args)) {
        return w.gh.commitDate === undefined ? failed('gh: Not Found (HTTP 404)') : out(`${w.gh.commitDate}\n`)
      }
      if (/pulls\/\d+\/reviews/.test(args)) return out(JSON.stringify(w.gh.reviews))
      if (/pulls\/\d+\/comments/.test(args)) return out(JSON.stringify(w.gh.comments))
      if (/issues\/\d+\/comments/.test(args)) return out(JSON.stringify(w.gh.issueComments))
      if (/commits\/[0-9a-f]+\/status$/.test(args)) {
        if (w.gh.isStatusBroken === true) return failed('gh: Server Error (HTTP 502)')
        return out(JSON.stringify({ state: 'pending', statuses: w.gh.statuses ?? [] }))
      }
      if (/commits\/[0-9a-f]+\/check-runs/.test(args)) return out(JSON.stringify({ check_runs: w.gh.checks }))
      if (/requested_reviewers/.test(args)) {
        if (args.includes('-X POST')) {
          w.gh.requests.push(args)
          if (w.gh.isRequestPostBroken === true) return failed('gh: Server Error (HTTP 502)')
          return out('{}')
        }
        if (w.gh.isRequestedBroken === true) return failed('gh: Server Error (HTTP 502)')
        return out(JSON.stringify({ users: (w.gh.requested ?? []).map(login => ({ login })), teams: [] }))
      }
      return out('')
    }
    // The Jira CLI (spec §5.13.7): its answers as acli gives them, `--json`.
    if (e.argv[0] === 'acli') {
      w.acli.calls.push(e.argv.slice(1))
      const verb = e.argv[3]
      const knob = verb === 'create' ? w.acli.create : verb === 'view' ? w.acli.view : verb === 'search' ? w.acli.search : undefined
      const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      const flag = (name: string): string => e.argv[e.argv.indexOf(name) + 1] ?? ''
      if (knob === 'missing' && verb !== 'view') throw new Error('spawn acli ENOENT')
      if (knob === 'unauthorized') return fail("unauthorized: use 'acli [product] auth login' to authenticate")
      if (knob === 'fail') return fail('Error: the Jira site answered 502 Bad Gateway')
      if (verb === 'create') {
        const n = w.acli.next ?? 512
        w.acli.next = n + 1
        const key = `${flag('--project')}-${n}`
        w.acli.tickets.push({ key, summary: flag('--summary'), labels: flag('--label').split(','), description: w.files.get(flag('--description-file')) ?? '' })
        if (knob === 'lost') return fail('Post "https://example.atlassian.net/rest/api/3/issue": context deadline exceeded')
        return out(JSON.stringify({ key, id: String(10_000 + n), self: `https://example.atlassian.net/rest/api/3/issue/${10_000 + n}` }))
      }
      if (verb === 'view') {
        const key = e.argv[4] ?? ''
        const one = knob === 'missing' ? undefined : w.acli.tickets.find(each => each.key === key)
        if (one === undefined) return fail(`Error: work item ${key} does not exist or you do not have permission to see it`)
        return out(JSON.stringify({ key, fields: { summary: one.summary, status: { name: 'To Do' } } }))
      }
      if (verb === 'search') {
        const id = /\\"([^"\\]+)\\"/.exec(flag('--jql'))?.[1] ?? ''
        return out(JSON.stringify(w.acli.tickets.filter(one => one.summary.includes(id)).map(one => ({ key: one.key, fields: { summary: one.summary } }))))
      }
      return fail(`Error: unknown command ${args}`)
    }
    if (e.argv[0] === 'rm') {
      for (const one of e.argv.slice(2)) w.files.delete(one)
      return out('')
    }
    if (args.startsWith('rev-parse --absolute-git-dir')) return out('/repo/.git\n')
    if (args.startsWith('fetch')) {
      w.git.fetches.push(args)
      await w.git.onFetch?.()
      const fail = (stderr: string) => ({ value: { exitCode: 128, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      const missing = w.git.missingRefs.find(ref => e.argv.slice(3).includes(ref))
      if (missing !== undefined) return fail(`fatal: couldn't find remote ref ${missing}`)
      if (w.git.fetchFails <= 0 || (w.git.fetchOnly !== undefined && !args.endsWith(` ${w.git.fetchOnly}`))) return out('')
      w.git.fetchFails -= 1
      return fail(w.git.fetchError)
    }
    if (args.startsWith('show HEAD:.github/pr-gate.json')) return out(w.git.headRoster, w.git.headRoster === '' ? 128 : 0)
    if (/^show origin\/\S+:\.github\/pr-gate\.json$/.test(args)) return out(w.git.shadow, w.git.shadow === '' ? 128 : 0)
    const onBase = args.match(/^show refs\/remotes\/origin\/(\S+):\.github\/pr-gate\.json$/)?.[1]
    if (onBase !== undefined) {
      await w.git.onRoster?.()
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
    if (args.startsWith('rev-parse HEAD')) {
      await w.git.onHead?.()
      return out(`${w.git.head}\n`)
    }
    if (args.startsWith('status')) return out(w.git.dirty)
    if (args.startsWith('diff --numstat origin/')) return out(w.git.numstat)
    if (args.startsWith('diff --raw')) return out(w.git.raw)
    if (args.startsWith('diff -U0')) return out(w.git.pkgDiff)
    if (args.startsWith(`merge-base --is-ancestor ${w.git.head}`)) return out('', w.git.isAncestor ? 0 : 1)
    if (args.startsWith('merge-base --is-ancestor')) return out('', w.git.isLanded ? 0 : 1)
    if (args.startsWith('rev-list --no-merges')) return out(w.git.left)
    if (args.startsWith('diff --numstat')) return out(w.git.since)
    if (args.startsWith('diff --name-only')) return out(w.git.changed)
    // Line ranges (R73): each changed file whole, unless a test gives its own hunks.
    if (args.startsWith('diff --unified=0')) {
      const whole = w.git.changed.split('\n').filter(Boolean).map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,100000 +1,100000 @@`)
      return out(w.git.hunks ?? whole.join('\n'))
    }
    if (args.startsWith('ls-remote origin')) return out(w.git.remoteHead === undefined ? '' : `${w.git.remoteHead}\trefs/heads/${w.git.branch}\n`)
    if (args.startsWith('log --format=%h by %an')) {
      await w.git.onUnpushed?.()
      return out(w.git.unpushed)
    }
    if (args.startsWith('log --format=%h %an %s')) return out(w.git.newCommits ?? '')
    // A fast-forward to a commit the local head is an ancestor of moves the head there.
    const ff = args.match(/^merge --ff-only --quiet (\S+)$/)?.[1]
    if (ff !== undefined) {
      if (!w.git.isAncestor) return out('', 128)
      w.git.head = ff
      return out('')
    }
    if (args.startsWith('remote get-url')) return out('https://github.com/me/repo.git\n')
    return out('')
  }
  on('process.run', async (_$, e) => fake(e))
  const write = (path: string, text: string): void => {
    if (w.isWriteBroken === true) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
    w.written.push({ path, text })
    w.files.set(path, text)
  }
  on('fs.write', (_$, e) => {
    write(e.path, e.text)
    return { value: undefined }
  })
  // The tests' own `$` has no `process`, and the host refuses it to a module that never calls it: this engine stand-in runs the same fake.
  w.engine = {
    process: { run: async (argv: readonly string[], init?: { cwd?: string }) => (await fake({ argv, init })).value },
    clock: { now: async () => now },
    fs: { write: async (path: string, text: string) => write(path, text) },
    // The same store the mod's own engine reads: a helper that notes something on the record writes where the test reads it.
    store: {
      get: async (key: string) => w.store.get(key),
      set: async (key: string, value: unknown) => void w.store.set(key, value),
      delete: async (key: string) => void w.store.delete(key),
      keys: async () => [...w.store.keys()],
    },
  } as never
  on('agent.spawn', (_$, e) => {
    w.spawned.push({ prompt: e.prompt, description: e.description, ...(e.model === undefined ? {} : { model: e.model }) })
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
    // The agent's merge (R93): GitHub accepts it and the PR reads MERGED, or refuses it.
    if (/\bgh\s+pr\s+merge\b/.test(e.command)) {
      if (w.gh.mergeAnswer === 'fail') {
        return { result: { stdout: '', stderr: 'GraphQL: Required status check "ci" is expected. (mergePullRequest)', interrupted: false }, isError: true } as never
      }
      // A merge of another repository's PR leaves this one as it is.
      const isOther = /github\.com\/(?!me\/repo\/)/.test(e.command) || /(?:-R|--repo)\s+(?!me\/repo\b)\S+/.test(e.command)
      if (!isOther) w.gh.state = 'MERGED'
      return { result: { stdout: `✓ Merged pull request #${w.gh.pr}`, stderr: '', interrupted: false } as never }
    }
    return { result: { stdout: 'https://github.com/me/repo/pull/1', stderr: '', interrupted: false } as never }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.sessionId }))
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
