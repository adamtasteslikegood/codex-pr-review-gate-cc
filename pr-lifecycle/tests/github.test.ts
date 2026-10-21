import { expect, test } from 'claude-code/testing'

import {
  collectionDone,
  hasOtherSteps,
  isNoAction,
  isTrusted,
  readCheckRuns,
  readInlineComments,
  readIssueComments,
  readJsonList,
  readPrAction,
  readRequired,
  readReviews,
  readRoster,
  severityHint,
} from '../hooks/github'
import type { Feedback } from '../hooks/github'

const at = (iso: string) => Date.parse(iso)

test('paginated gh output is read as one list', async () => {
  expect(readJsonList('[{"id":1}]\n[{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  expect(readJsonList('')).toEqual([])
  expect(() => readJsonList('not json')).toThrow()
  // A page's body may hold `] [`: only a page boundary splits the text.
  const pages = readJsonList('[{"id":1,"body":"a ] [ b"}][{"id":2,"body":"c"}]')
  expect(pages).toHaveLength(2)
  expect((pages[0] as { body: string }).body).toBe('a ] [ b')
  // Escaped quotes and braces inside a string are data, not boundaries.
  const escaped = readJsonList('[{"body":"say \\"}{\\" ok"}][{"body":"x"}]')
  expect(escaped).toHaveLength(2)
  expect((escaped[0] as { body: string }).body).toBe('say "}{" ok')
  // Consecutive top-level objects are separate pages too.
  expect(readJsonList('{"id":1}{"id":2}')).toEqual([{ id: 1 }, { id: 2 }])
})

test('unreadable gh output fails loudly; blank output is still nothing', async () => {
  expect(() => readJsonList('oops')).toThrow('unreadable JSON from gh')
  expect(() => readReviews('oops')).toThrow()
  expect(() => readCheckRuns('oops')).toThrow()
  expect(readCheckRuns('')).toEqual([])
  expect(readReviews('  \n')).toEqual([])
})

test('check runs from paginated pages, or one unpaginated object', async () => {
  const pages = '{"total_count":2,"check_runs":[{"name":"a","status":"completed","conclusion":"success"}]}'
    + '{"total_count":2,"check_runs":[{"name":"b","status":"in_progress","conclusion":null}]}'
  expect(readCheckRuns(pages)).toEqual([
    { name: 'a', status: 'completed', conclusion: 'success' },
    { name: 'b', status: 'in_progress', conclusion: null },
  ])
})

test('reviews, inline comments and issue comments become feedback with stable ids', async () => {
  const reviews = readReviews(JSON.stringify([
    { id: 7, user: { login: 'copilot-pull-request-reviewer[bot]' }, body: 'Looks fine', state: 'COMMENTED', commit_id: 'b', submitted_at: '2026-10-16T10:00:00Z', html_url: 'u' },
    { id: 8, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: 'b', submitted_at: '2026-10-16T10:01:00Z' },
  ]))
  expect(reviews.map(one => [one.id, one.reviewer, one.head, one.isFinding])).toEqual([
    ['review:7', 'copilot-pull-request-reviewer[bot]', 'b', true],
    ['review:8', 'claude[bot]', 'b', false],
  ])
  const inline = readInlineComments(JSON.stringify([
    { id: 11, user: { login: 'claude[bot]' }, body: '**P1** SQL injection', path: 'src/db.ts', line: 4, commit_id: 'b', created_at: '2026-10-16T10:02:00Z', html_url: 'u2' },
    { id: 12, user: { login: 'me' }, body: 'Fixed in c', path: 'src/db.ts', line: 4, in_reply_to_id: 11, commit_id: 'b', created_at: '2026-10-16T10:03:00Z' },
  ]))
  expect(inline[0]).toMatchObject({ id: 'inline:11', file: 'src/db.ts', line: 4, threadId: '11', isFinding: true, at: at('2026-10-16T10:02:00Z') })
  expect(inline[1]).toMatchObject({ id: 'inline:12', threadId: '11' })
  const comments = readIssueComments(JSON.stringify([{ id: 21, user: { login: 'rovo[bot]' }, body: 'nit: typo', created_at: '2026-10-16T10:04:00Z' }]))
  expect(comments[0]).toMatchObject({ id: 'comment:21', reviewer: 'rovo[bot]', isFinding: true })
  expect(comments[0]?.head).toBeUndefined()
})

test('check runs and the roster file are read; a bad roster is ignored', async () => {
  expect(readCheckRuns(JSON.stringify({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }))).toEqual([
    { name: 'ci', status: 'completed', conclusion: 'success' },
  ])
  expect(readRoster('{"reviewers":["claude[bot]"],"checks":["ci"],"quietMinutes":2}')).toEqual({
    reviewers: ['claude[bot]'],
    checks: ['ci'],
    requestReview: [],
    trusted: [],
    quietMinutes: 2,
  })
  // A wait under a minute would end collection on the first poll: it falls back to the plugin option, like the user options.
  expect(readRoster('{"quietMinutes":0,"waitCapMinutes":-5}')).toEqual({ reviewers: [], checks: [], requestReview: [], trusted: [] })
  expect(readRoster('{"waitCapMinutes":0.5}')).toEqual({ reviewers: [], checks: [], requestReview: [], trusted: [] })
  // A huge wait would never time out: it is capped at a day.
  expect(readRoster('{"quietMinutes":1e308,"waitCapMinutes":100000}')).toEqual({
    reviewers: [], checks: [], requestReview: [], trusted: [], quietMinutes: 1440, waitCapMinutes: 1440,
  })
  expect(readRoster('{')).toBeUndefined()
  expect(readRoster('')).toBeUndefined()
})

test('a severity is read from the reviewer\'s own words, P2 when it says none', async () => {
  expect(severityHint('**P1** SQL injection')).toEqual({ severity: 'P1', isSecurity: true, isTagged: true })
  expect(severityHint('Critical: crashes on empty input')).toEqual({ severity: 'P1', isSecurity: false, isTagged: false })
  expect(severityHint('nit: typo')).toEqual({ severity: 'P3', isSecurity: false, isTagged: true })
  // A security hint never drops below P2 unless the reviewer tagged a severity itself.
  expect(severityHint('minor: possible XSS here')).toEqual({ severity: 'P2', isSecurity: true, isTagged: false })
  expect(severityHint('Consider renaming')).toEqual({ severity: 'P2', isSecurity: false, isTagged: false })
})

const base = { head: 'b', headAt: 0, startedAt: 0, lastArrivalAt: 0, quietMs: 180_000, capMs: 1_200_000 }
const fb = (reviewer: string, head?: string, when = 10) => ({ id: `review:${reviewer}`, kind: 'review' as const, reviewer, body: '', head, at: when, isFinding: false })

test('with a roster, collection ends once every listed reviewer covered the head and every listed check finished', async () => {
  const roster = { reviewers: ['claude[bot]', 'copilot'], checks: ['ci'], requestReview: [], trusted: [] }
  const checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b')], checks, now: 60_000 })).toMatchObject({ isDone: false, missing: ['copilot'] })
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('copilot', 'b')], checks, now: 60_000 })).toMatchObject({ isDone: true, isComplete: true })
  // A review of an older head does not cover this one.
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('copilot', 'a')], checks, now: 60_000 }).isDone).toBe(false)
})

test('#14: a trusted reviewer is never waited for, but its review already in covers the head', async () => {
  const roster = { reviewers: [], checks: ['ci'], requestReview: [], trusted: ['claude[bot]'] }
  const checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  expect(collectionDone({ ...base, roster, feedback: [], checks, now: 60_000 })).toMatchObject({ isDone: true, isComplete: true, covered: [] })
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b')], checks, now: 60_000 }).covered).toEqual(['claude[bot]'])
  // Trusted, so its comments are triaged even with no write access (R1-8).
  const bot = { ...fb('claude[bot]', 'b'), association: 'NONE' }
  expect(isTrusted(bot, roster)).toBe(true)
  expect(isTrusted(bot, { ...roster, trusted: [] })).toBe(false)
})

test('without a roster, collection ends when checks are done and feedback has gone quiet', async () => {
  const running = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  const done = [{ name: 'ci', status: 'completed', conclusion: 'failure' }]
  expect(collectionDone({ ...base, feedback: [], checks: running, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 500_000, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 400_000, now: 600_000 })).toMatchObject({ isDone: true, isComplete: true })
})

test('the wait cap ends collection with what arrived, marked incomplete', async () => {
  const roster = { reviewers: ['copilot'], checks: [], requestReview: [], trusted: [] }
  expect(collectionDone({ ...base, roster, feedback: [], checks: [], now: 1_200_000 })).toEqual({ isDone: true, isComplete: false, missing: ['copilot'], covered: [] })
})

test('with a roster, only its reviewers cover the head', async () => {
  const roster = { reviewers: ['claude[bot]'], checks: [], requestReview: [], trusted: [] }
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('netlify[bot]', 'b')], checks: [], now: 60_000 }).covered).toEqual(['claude[bot]'])
})

test('without a roster, an issue comment (a deploy-preview bot) does not cover the head; a review or inline comment does', async () => {
  const comment = { id: 'comment:1', kind: 'comment' as const, reviewer: 'netlify[bot]', body: 'Preview ready', at: 10, isFinding: true }
  const inline = { id: 'inline:2', kind: 'inline' as const, reviewer: 'copilot', body: 'x', head: 'b', at: 10, isFinding: true }
  const now = 600_000
  expect(collectionDone({ ...base, feedback: [comment], checks: [], now }).covered).toEqual([])
  expect(collectionDone({ ...base, feedback: [comment, inline, fb('claude[bot]', 'b')], checks: [], now }).covered).toEqual(['copilot', 'claude[bot]'])
})

const bash = (command: string) => readPrAction('Bash', { command })

test('gh pr create and gh pr merge, with and without a number or --auto', async () => {
  expect(bash('gh pr create --base dev --title x')).toMatchObject({ action: 'create', base: 'dev', via: 'gh pr create' })
  expect(bash('cd /repo && gh pr merge 12 --squash')).toMatchObject({ action: 'merge', number: 12, cwd: '/repo' })
  expect(bash('gh pr merge --auto --squash')).toMatchObject({ action: 'merge', number: undefined })
  expect(bash('gh pr merge https://github.com/me/repo/pull/9')).toMatchObject({ action: 'merge', number: 9 })
  expect(bash('gh pr view 12')).toBeUndefined()
})

test('gh api REST and GraphQL calls that open or merge a PR', async () => {
  expect(bash('gh api repos/me/repo/pulls -f base=dev -f head=feat/x -f title=t')).toMatchObject({ action: 'create', base: 'dev', head: 'feat/x', repo: 'me/repo' })
  expect(bash('gh api -X PUT repos/me/repo/pulls/12/merge')).toMatchObject({ action: 'merge', number: 12, repo: 'me/repo' })
  expect(bash("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash("gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"X\"}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash("gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'")).toMatchObject({ action: 'create' })
  // Reading pulls is not opening one.
  expect(bash('gh api repos/me/repo/pulls')).toBeUndefined()
  expect(bash('gh api repos/me/repo/pulls/12/comments')).toBeUndefined()
})

test('both GitHub MCP connectors', async () => {
  expect(readPrAction('mcp__plugin_github_github__create_pull_request', { owner: 'me', repo: 'repo', base: 'dev', head: 'feat/x' })).toMatchObject({
    action: 'create',
    base: 'dev',
    head: 'feat/x',
    repo: 'me/repo',
  })
  expect(readPrAction('mcp__plugin_github_github__merge_pull_request', { owner: 'me', repo: 'repo', pullNumber: 3 })).toMatchObject({ action: 'merge', number: 3 })
  const graphql = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
  expect(readPrAction(graphql, { action: 'create', repo: 'me/repo', base: 'dev', head: 'feat/x' })).toMatchObject({ action: 'create', base: 'dev' })
  expect(readPrAction(graphql, { action: 'merge', repo: 'me/repo', number: 4 })).toMatchObject({ action: 'merge', number: 4 })
  expect(readPrAction(graphql, { action: 'enqueue', repo: 'me/repo', number: 4 })).toMatchObject({ action: 'merge', number: 4 })
  expect(readPrAction(graphql, { action: 'get', repo: 'me/repo', number: 4 })).toBeUndefined()
})

test('an unknown GitHub tool that reads as opening or merging a PR is held; others are not', async () => {
  expect(readPrAction('mcp__someone_github__merge_pr', { n: 1 })).toMatchObject({ action: 'merge', isUnknown: true })
  expect(readPrAction('mcp__gh_tools__pulls', { method: 'create_pull_request' })).toBeUndefined()
  expect(readPrAction('mcp__acme-github__pulls', { method: 'create_pull_request' })).toMatchObject({ action: 'create', isUnknown: true })
  expect(readPrAction('mcp__acme-github__issues', { action: 'create' })).toBeUndefined()
  expect(readPrAction('Read', { file_path: 'merge.ts' })).toBeUndefined()
})

// Fix round 1 (R18): the classifier fails closed on flags, aliases, quoting, nesting and other routes.

test('bash: global flags, aliases, quoting and line continuations still hold', async () => {
  expect(bash('gh -R me/r pr merge 5')).toMatchObject({ action: 'merge', number: 5, repo: 'me/r' })
  expect(bash('gh --repo=me/r pr create')).toMatchObject({ action: 'create', repo: 'me/r' })
  expect(bash('gh pr new')).toMatchObject({ action: 'create' })
  expect(bash('"gh" pr \'create\'')).toMatchObject({ action: 'create' })
  expect(bash('gh pr \\\ncreate')).toMatchObject({ action: 'create' })
  expect(bash('/usr/bin/gh pr create')).toMatchObject({ action: 'create' })
})

test('bash: mixed commands, merge wins', async () => {
  expect(bash('gh pr merge 5 --auto && gh pr create')).toMatchObject({ action: 'merge' })
  expect(bash('gh pr create && gh pr merge 5')).toMatchObject({ action: 'merge' })
  expect(bash('echo hi; $(gh pr create)')).toMatchObject({ action: 'create' })
})

test('bash: the merge target', async () => {
  expect(bash('gh pr merge --body 7 5')).toMatchObject({ action: 'merge', number: 5 })
  expect(bash('gh pr merge feat-x')).toMatchObject({ action: 'merge', number: undefined, isUnknown: true })
  expect(bash('gh pr merge https://github.com/o/r/pull/9')).toMatchObject({ action: 'merge', number: 9 })
  expect(bash('gh pr merge --auto --squash')?.isUnknown).toBeUndefined()
})

test('bash: gh api route forms', async () => {
  expect(bash('gh api -XPOST repos/o/r/pulls')).toMatchObject({ action: 'create' })
  expect(bash('gh api repos/o/r/pulls/ -f title=t')).toMatchObject({ action: 'create' })
  expect(bash('gh api repos/o/r/pulls?x=1 -ftitle=t')).toMatchObject({ action: 'create' })
  expect(bash('gh api --field=title=t repos/o/r/pulls')).toMatchObject({ action: 'create' })
  expect(bash('gh api --method=PUT /repos/o/r/pulls/4/merge')).toMatchObject({ action: 'merge', number: 4 })
  expect(bash('gh api graphql -F query=@m.gql')).toMatchObject({ action: 'merge', isUnknown: true })
  expect(bash("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash('curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge')).toMatchObject({ action: 'merge' })
  expect(bash('curl --request POST https://api.github.com/repos/o/r/pulls -d {}')).toMatchObject({ action: 'create' })
  expect(bash('hub pull-request -m x')).toMatchObject({ action: 'create' })
})

test('bash: reads stay free', async () => {
  expect(bash('gh api repos/o/r/pulls -f state=open -X GET')).toBeUndefined()
  expect(bash('gh pr view 5')).toBeUndefined()
  expect(bash('gh pr list')).toBeUndefined()
  expect(bash('gh api repos/o/r/pulls/5/comments')).toBeUndefined()
  expect(bash("gh api graphql -f query='{ viewer { login } }'")).toBeUndefined()
})

test('mcp: renamed, re-cased and nested calls still hold', async () => {
  const graphql = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
  const written = readPrAction('mcp__plugin_github_github__pull_request_write', { method: 'create', owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' })
  expect(written).toMatchObject({ action: 'create', repo: 'o/r', base: 'b', head: 'h' })
  expect(written?.isUnknown).toBeUndefined()
  expect(readPrAction(graphql, { action: 'MERGE', number: 2 })).toMatchObject({ action: 'merge', number: 2 })
  expect(readPrAction(graphql, { action: 'enable_auto_merge' })).toMatchObject({ action: 'merge' })
  expect(readPrAction(graphql, { operation: 'merge' })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__github__pulls', { title: 't', head: 'h', base: 'b', action: 'create' })).toMatchObject({ action: 'create' })
  expect(readPrAction('mcp__github__rest', { method: 'PUT', path: '/repos/o/r/pulls/1/merge' })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__github__graphql', { query: 'mutation { mergePullRequest(input:{}) { clientMutationId } }' })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__acme-github__tool', { tool: 'merge_pull_request' })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__acme-github__tool', { args: { inner: [{ op: 'merge_pull_request' }] } })).toMatchObject({ action: 'merge' })
})

test('mcp: open and new are create verbs only where they name the operation', async () => {
  expect(readPrAction('mcp__plugin_github_github__list_pull_requests', { state: 'open', owner: 'o', repo: 'r' })).toBeUndefined()
  expect(readPrAction('mcp__claude_ai_github-graphql-mcp__manage_pull_requests', { action: 'list', state: 'OPEN' })).toBeUndefined()
  expect(readPrAction('mcp__github__pulls', { action: 'open', title: 't' })).toMatchObject({ action: 'create', isUnknown: true })
  expect(readPrAction('mcp__github__open_pull_request', { title: 't' })).toMatchObject({ action: 'create', isUnknown: true })
})

// Fix round 3 (R19): structural input only; curl graphql and long mutations held.

test('bash r19: curl graphql and rest on any host, upper-case gh, hostname flag, unreadable queries', async () => {
  const mutation = '{"query":"mutation { mergePullRequest(input:{}) { clientMutationId } }"}'
  expect(bash(`curl -X POST https://api.github.com/graphql -d '${mutation}'`)).toMatchObject({ action: 'merge' })
  expect(bash('curl -X POST https://api.github.com/graphql -d @q.json')).toMatchObject({ action: 'merge', isUnknown: true })
  expect(bash('curl -X PUT https://ghe.corp/api/v3/repos/o/r/pulls/5/merge')).toMatchObject({ action: 'merge', number: 5 })
  expect(bash('GH pr create')).toMatchObject({ action: 'create' })
  expect(bash('gh api graphql -f query="$Q"')).toMatchObject({ action: 'merge', isUnknown: true })
  expect(bash('gh --hostname h.example pr merge 3')).toMatchObject({ action: 'merge', number: 3 })
})

test('bash r19: prose, other subcommands and variables inside literal queries are not commands', async () => {
  expect(bash("gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}) { thread { id } } }' -f id=X")).toBeUndefined()
  expect(bash('gh issue create --title "pr merge bug"')).toBeUndefined()
  expect(bash('git commit -m "docs: gating of gh pr ' + 'create"')).toBeUndefined()
  expect(bash('grep -rn "gh pr ' + 'merge" docs')).toBeUndefined()
  expect(bash("git commit -F - <<'EOF'\nsubject\n\ngh pr " + 'create --base dev\nEOF')).toBeUndefined()
  expect(bash('cat <<-EOF\n\tgh pr ' + 'merge 5\n\tEOF\necho done')).toBeUndefined()
})

test('mcp r19: a long mutation string under any key, and pullrequest as one word', async () => {
  const long = 'mutation M { mergePullRequest(input: { pullRequestId: "' + 'x'.repeat(150) + '" }) { clientMutationId } }'
  expect(readPrAction('mcp__github__graphql', { mutation: long })).toMatchObject({ action: 'merge', isUnknown: true })
  expect(readPrAction('mcp__github__graphql', { doc: { nested: [long.replace('mergePullRequest', 'createPullRequest')] } })).toMatchObject({ action: 'create' })
  expect(readPrAction('mcp__github__pullrequest', { action: 'merge' })).toMatchObject({ action: 'merge' })
})

test('mcp r19: file, branch, comment, search and list tools are not held', async () => {
  const file = { path: 'pr-lifecycle/hooks/github.ts', content: 'x', message: 'fix pr gate' }
  expect(readPrAction('mcp__plugin_github_github__create_or_update_file', file)).toBeUndefined()
  expect(readPrAction('mcp__plugin_github_github__create_branch', { branch: 'feat/pr-lifecycle' })).toBeUndefined()
  expect(readPrAction('mcp__plugin_github_github__pull_request_review_write', { method: 'create', body: 'Looks good, merge when green', pullNumber: 1 })).toBeUndefined()
  expect(readPrAction('mcp__plugin_github_github__add_issue_comment', { body: 'ready to merge the pr' })).toBeUndefined()
  expect(readPrAction('mcp__plugin_github_github__search_pull_requests', { query: 'merge conflict' })).toBeUndefined()
  expect(readPrAction('mcp__acme-github__list_open_pull_requests', {})).toBeUndefined()
  expect(readPrAction('mcp__acme-github__get_new_pull_requests', {})).toBeUndefined()
  expect(readPrAction('mcp__github__pulls', { action: 'list', type: 'open' })).toBeUndefined()
})

test('mcp r19: tool-name verbs, and what stays held after the narrowing', async () => {
  expect(readPrAction('mcp__acme-github__submit_pull_request', {})).toMatchObject({ action: 'create', isUnknown: true })
  expect(readPrAction('mcp__acme-github__enable_pr_auto_merge', {})).toMatchObject({ action: 'merge', isUnknown: true })
  expect(readPrAction('mcp__plugin_github_github__merge_pull_request', { pullNumber: 3 })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__github__rest', { method: 'PUT', path: '/repos/o/r/pulls/1/merge' })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__acme-github__tool', { tool: 'merge_pull_request' })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__github__pulls', { title: 't', head: 'h', base: 'b', action: 'create' })).toMatchObject({ action: 'create' })
})

test('mcp: reads, reviews and long prose stay free', async () => {
  expect(readPrAction('mcp__plugin_github_github__pull_request_read', { method: 'get', pullNumber: 1 })).toBeUndefined()
  expect(readPrAction('mcp__acme-github__list_merged', {})).toBeUndefined()
  expect(readPrAction('mcp__plugin_github_github__create_pull_request_review', { body: 'x' })).toBeUndefined()
  expect(readPrAction('mcp__claude_ai_github-graphql-mcp__manage_pull_requests', { action: 'list' })).toBeUndefined()
  expect(readPrAction('mcp__acme-github__pulls', { body: 'please merge this later, it will create a pull request when the long prose runs on and on'.padEnd(130, '.') })).toBeUndefined()
})

// Fix round 4 (R20): here-strings are not heredocs; shell-fed heredocs and nested MCP operations are read.

const mergeCmd = 'gh pr ' + 'merge 5'
const createCmd = 'gh pr ' + 'create'

test('bash r20: here-strings and arithmetic shifts are not heredocs', async () => {
  expect(bash('cat <<< "hello"\n' + mergeCmd)).toMatchObject({ action: 'merge', number: 5 })
  expect(bash('cat <<<hello\n' + mergeCmd)).toMatchObject({ action: 'merge', number: 5 })
  expect(bash('echo $((1<<2))\n' + mergeCmd)).toMatchObject({ action: 'merge', number: 5 })
})

test('bash r20: heredoc bodies fed to a shell are read; bodies written to a file are not', async () => {
  expect(bash('bash <<EOF\n' + mergeCmd + '\nEOF')).toMatchObject({ action: 'merge', number: 5 })
  expect(bash("bash -s <<'EOF'\n" + createCmd + '\nEOF')).toMatchObject({ action: 'create' })
  expect(bash('ssh h <<EOF\n' + mergeCmd + '\nEOF')).toMatchObject({ action: 'merge', number: 5 })
  expect(bash('cat <<EOF | bash\n' + mergeCmd + '\nEOF')).toMatchObject({ action: 'merge', number: 5 })
  expect(bash('cat > notes.md <<EOF\n' + mergeCmd + '\nEOF')).toBeUndefined()
  expect(bash("git commit -F - <<'EOF'\nsubject\n\n" + createCmd + ' --base dev\nEOF')).toBeUndefined()
})

test('mcp r20: operation keys at any depth, more key names, and endpoint paths', async () => {
  const call = { method: 'tools/call', params: { name: 'merge_pull_request', arguments: { pullNumber: 5 } } }
  expect(readPrAction('mcp__github__tools', call)).toMatchObject({ action: 'merge', isUnknown: true })
  expect(readPrAction('mcp__acme-github__run', { action: 'x', command: 'pr create' })).toMatchObject({ action: 'create', isUnknown: true })
  expect(readPrAction('mcp__github__pulls', { verb: 'merge', pull_number: 3 })).toMatchObject({ action: 'merge' })
  expect(readPrAction('mcp__github__call', { endpoint: 'PUT /repos/o/r/pulls/2/merge' })).toMatchObject({ action: 'merge' })
})

test('mcp r20: open and new still yield to a primary key', async () => {
  expect(readPrAction('mcp__github__pulls', { action: 'list', type: 'open' })).toBeUndefined()
  expect(readPrAction('mcp__plugin_github_github__list_pull_requests', { state: 'open' })).toBeUndefined()
})

test('R1-8: the author association is read from either spelling, and only write access or the roster is kept', async () => {
  const [review] = readReviews(JSON.stringify([{ id: 1, user: { login: 'a' }, body: 'x', state: 'COMMENTED', author_association: 'MEMBER' }]))
  const [inline] = readInlineComments(JSON.stringify([{ id: 2, user: { login: 'b' }, body: 'x', authorAssociation: 'NONE' }]))
  const [comment] = readIssueComments(JSON.stringify([{ id: 3, user: { login: 'c' }, body: 'x' }]))
  expect(review?.association).toBe('MEMBER')
  expect(inline?.association).toBe('NONE')
  expect(comment?.association).toBeUndefined()
  const roster = { reviewers: ['b'], checks: [], requestReview: ['copilot'], trusted: [] }
  const one = (reviewer: string, association?: string) => ({ ...(comment as Feedback), reviewer, ...(association === undefined ? {} : { association }) })
  expect(['OWNER', 'MEMBER', 'COLLABORATOR'].every(each => isTrusted(one('x', each), undefined))).toBe(true)
  expect(isTrusted(one('x', 'CONTRIBUTOR'), undefined)).toBe(false)
  expect(isTrusted(one('x', 'NONE'), roster)).toBe(false)
  expect(isTrusted(one('b', 'NONE'), roster)).toBe(true)
  expect(isTrusted(one('copilot', 'NONE'), roster)).toBe(true)
  // A row without an association is kept: its text is still fenced.
  expect(isTrusted(one('x'), undefined)).toBe(true)
})

test('F3: a requestReview name keeps the bot that posts for it, and nothing more', async () => {
  const [base] = readIssueComments(JSON.stringify([{ id: 3, user: { login: 'c' }, body: 'x', author_association: 'NONE' }]))
  const by = (reviewer: string): Feedback => ({ ...(base as Feedback), reviewer })
  const roster = { reviewers: [], checks: [], requestReview: ['copilot'], trusted: [] }
  expect(isTrusted(by('copilot-pull-request-reviewer[bot]'), roster)).toBe(true)
  expect(isTrusted(by('copilot[bot]'), roster)).toBe(true)
  expect(isTrusted(by('copilot'), roster)).toBe(true)
  // Not over-matched: a human login with the prefix, a longer bot name, a bot whose name only contains it.
  expect(isTrusted(by('copilot-fan'), roster)).toBe(false)
  expect(isTrusted(by('copilotx[bot]'), roster)).toBe(false)
  expect(isTrusted(by('my-copilot[bot]'), roster)).toBe(false)
  expect(isTrusted(by('copilot-pull-request-reviewer'), roster)).toBe(false)
})

test('R83: only positive no-action evidence settles a review (review G2-2)', async () => {
  // Untagged but actionable: never settled.
  expect(isNoAction('COMMENTED', 'The reset path deletes the pending findings. Preserve them before archiving.')).toBe(false)
  // Clean approvals.
  expect(isNoAction('APPROVED', '')).toBe(true)
  expect(isNoAction('APPROVED', 'LGTM')).toBe(true)
  expect(isNoAction('COMMENTED', 'No actionable findings in this diff.')).toBe(true)
  expect(isNoAction('COMMENTED', 'Reviewed 1d4fa73 against main. No actionable findings in this roadmap-only diff.')).toBe(true)
  expect(isNoAction('COMMENTED', '## No blocking findings 🎉')).toBe(true)
  expect(isNoAction('APPROVED', 'Thanks!')).toBe(true)
  // The whole body must be no-action forms (PR #19 review): any other sentence goes to triage, request word or not.
  expect(isNoAction('COMMENTED', 'Reviewed 1d4fa73 against main. No actionable findings in this roadmap-only diff.\n\nScope: docs only.')).toBe(false)
  expect(isNoAction('COMMENTED', 'LGTM. Preserve the pending findings before archiving.')).toBe(false)
  expect(isNoAction('APPROVED', 'LGTM. Preserve the pending findings before archiving.')).toBe(false)
  expect(isNoAction('COMMENTED', 'LGTM. Reset still deletes pending findings.')).toBe(false)
  expect(isNoAction('APPROVED', 'LGTM, the cache is never cleared')).toBe(false)
  expect(isNoAction('COMMENTED', 'No blocking findings.\n\nHowever, the cache is never cleared.')).toBe(false)
  expect(isNoAction('COMMENTED', 'Thanks!')).toBe(false)
  // A trailing scope phrase is a fixed shape, not any run of words (round 2): the rest of the sentence is a finding.
  expect(isNoAction('COMMENTED', 'No actionable findings in this PR but the cache is never cleared')).toBe(false)
  expect(isNoAction('COMMENTED', 'No blocking issues for this change and the reset deletes pending findings')).toBe(false)
  // Approval text mixed with a requested fix.
  expect(isNoAction('APPROVED', 'LGTM, but please rename X')).toBe(false)
  expect(isNoAction('COMMENTED', 'No blocking findings. You should add a test.')).toBe(false)
  expect(isNoAction('APPROVED', 'LGTM. Should we also cover the retry path?')).toBe(false)
  expect(isNoAction('COMMENTED', 'No blocking findings, however the cache is never cleared.')).toBe(false)
  // A severity tag or a strong word means there is something to act on.
  expect(isNoAction('COMMENTED', 'No blocking findings; one P2 note inline.')).toBe(false)
  expect(isNoAction('CHANGES_REQUESTED', 'LGTM')).toBe(false)
})

test('R83: readReviews marks a positive no-action review as no finding, and keeps every other body', async () => {
  const rows = readReviews(JSON.stringify([
    { id: 1, user: { login: 'a' }, body: 'No actionable findings.', state: 'COMMENTED', commit_id: 'h', submitted_at: '1970-01-01T00:01:00Z' },
    { id: 2, user: { login: 'a' }, body: 'The cache is never cleared.', state: 'COMMENTED', commit_id: 'h', submitted_at: '1970-01-01T00:01:00Z' },
    { id: 3, user: { login: 'a' }, body: 'LGTM', state: 'APPROVED', commit_id: 'h', submitted_at: '1970-01-01T00:01:00Z' },
  ]))
  expect(rows.map(one => one.isFinding)).toEqual([false, true, false])
})

test('R84: a reviewer\'s advisory label reads as a P3 tag; an explicit P0-P2 anywhere wins', async () => {
  expect(severityHint('Advisory, non-blocking:\n- rename the flag\n- add a log line')).toEqual({ severity: 'P3', isSecurity: false, isTagged: true })
  expect(severityHint('## Advisory (non-blocking)\n1. tidy the docs')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('nit: rename this')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('Advisory, non-blocking:\n- rename the flag\n- P1: the token leaks into logs')).toMatchObject({ severity: 'P1', isTagged: true })
  // Quoted inside a sentence, the word labels nothing.
  expect(severityHint('This is not the advisory note you think it is; the loop never ends.')).toMatchObject({ severity: 'P2', isTagged: false })
  expect(severityHint('supersedes the outstanding P2')).toMatchObject({ severity: 'P2', isTagged: true })
  expect(severityHint('the loop never ends')).toMatchObject({ severity: 'P2', isTagged: false })
  // A label needs a mark after it (colon, comma, bracket, dash or line end): a sentence that starts with the word is not one (Task 1 review).
  expect(severityHint('Optional chaining here crashes on null')).toMatchObject({ severity: 'P2', isTagged: false })
  expect(severityHint('Advisory locks are never released')).toMatchObject({ severity: 'P2', isTagged: false })
  expect(severityHint('Nit-picking aside, this leaks')).toMatchObject({ severity: 'P3', isTagged: false })
  expect(severityHint('Optional-chaining crashes on null')).toMatchObject({ severity: 'P2', isTagged: false })
  expect(severityHint('Advisory - rename it')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('**Nit**: rename this')).toMatchObject({ severity: 'P3', isTagged: true })
})

test('R84: an advisory label counts only at the start of the body, or on every line (final review C1)', async () => {
  // A label on a later line tags nothing: the body's real finding keeps the untagged guess.
  expect(severityHint('This migration drops the users table on rollback, losing data.\n\nNit: the comment above has a typo.')).toMatchObject({ isTagged: false })
  expect(severityHint('The reset path deletes pending findings.\n\n**Optional:** add a test.')).toMatchObject({ severity: 'P2', isTagged: false })
  expect(severityHint('Race: the lock is released before the write.\n- nit: rename x')).toMatchObject({ isTagged: false })
  expect(severityHint('This is a critical bug.\n\nNit: the comment has a typo.')).toMatchObject({ severity: 'P1', isTagged: false })
  // At the start, with its heading, list marker or bold, it still tags the body.
  expect(severityHint('Advisory, non-blocking:\n- a\n- b')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('**Nit:** x')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('  - nit: rename x')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('Nit\n- rename x')).toMatchObject({ severity: 'P3', isTagged: true })
  expect(severityHint('nit: rename x\n\noptional: add a log line')).toMatchObject({ severity: 'P3', isTagged: true })
})

test('R86: required checks come from the ruleset and classic protection; anything unreadable is undefined', async () => {
  const rules = JSON.stringify([
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'check' }, { context: 'analyze (actions)' }] } },
  ])
  expect(readRequired(rules, undefined)).toEqual(['check', 'analyze (actions)'])
  expect(readRequired(rules, JSON.stringify({ contexts: ['legacy'], checks: [{ context: 'check' }] }))).toEqual(['check', 'analyze (actions)', 'legacy'])
  expect(readRequired('[]', undefined)).toEqual([])
  expect(readRequired('<html>proxy error</html>', undefined)).toBeUndefined()
  expect(readRequired('', undefined)).toBeUndefined()
  // Classic protection that answered but can't be parsed makes the whole set unknown (PR #19 review).
  expect(readRequired(rules, '<html>proxy error</html>')).toBeUndefined()
  // A malformed payload that parses is not an empty policy (gate R1-7).
  expect(readRequired(JSON.stringify([{ type: 'required_status_checks' }]), undefined)).toBeUndefined()
  expect(readRequired(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{}] } }]), undefined)).toBeUndefined()
  expect(readRequired(rules, JSON.stringify({ message: 'Bad Gateway' }))).toBeUndefined()
  expect(readRequired(rules, 'null')).toBeUndefined()
  // Classic entries that name no check are malformed too (gate R5-4).
  expect(readRequired(rules, JSON.stringify({ contexts: [1], checks: [] }))).toBeUndefined()
  expect(readRequired(rules, JSON.stringify({ contexts: [], checks: [{}] }))).toBeUndefined()
})

test('R87: hasOtherSteps sees steps chained with a PR command, not text inside quotes, $(…) or a heredoc body', async () => {
  expect(hasOtherSteps('gh pr create --base dev --title "a; b && c"')).toBe(false)
  expect(hasOtherSteps('gh pr create --base dev --body "$(cat body.md)"')).toBe(false)
  expect(hasOtherSteps('cd /repo && gh pr create --base dev')).toBe(false)
  expect(hasOtherSteps("gh pr create --base dev --body-file - <<'EOF'\nline one; two\nEOF")).toBe(false)
  expect(hasOtherSteps("cat > body.md <<'EOF'\nSummary\nEOF\ngh pr create --base dev --body-file body.md")).toBe(true)
  expect(hasOtherSteps('git push -u origin HEAD && gh pr create --base dev')).toBe(true)
  expect(hasOtherSteps('gh pr merge 1 --squash; git checkout dev')).toBe(true)
})
