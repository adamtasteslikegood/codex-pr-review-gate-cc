// GitHub's half, pure: what `gh api` printed, read as feedback and checks; the
// per-repo roster; when collection is over; and which calls open or merge a PR.

import type { Severity } from '../types'

export type Feedback = {
  /** `review:<id>`, `inline:<id>` or `comment:<id>`: stable across polls and sessions. */
  id: string
  kind: 'review' | 'inline' | 'comment'
  reviewer: string
  body: string
  /** The commit it reviewed, when GitHub says. */
  head?: string
  file?: string
  line?: number
  /** For an inline comment: the id of the thread's first comment, to reply to. */
  threadId?: string
  url?: string
  state?: string
  at: number
  /** False for an empty approval or comment: it covers a head but raises nothing. */
  isFinding: boolean
}

export type Check = { name: string; status: string; conclusion: string | null }

export type Roster = { reviewers: string[]; checks: string[]; requestReview: string[]; quietMinutes?: number; waitCapMinutes?: number }

type Row = Record<string, unknown>

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const login = (row: Row): string => str((row.user as Row | undefined)?.login) ?? 'unknown'
const when = (value: unknown): number => {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const UNREADABLE = 'unreadable JSON from gh'

/**
 * `gh api --paginate` prints one JSON value per page, joined with nothing. Splits at top-level ends only, so a
 * `] [` or `}{` inside a string is data. Blank input is nothing; any other text that does not parse throws.
 */
function readPages(text: string): unknown[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const chunks: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = 0
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth < 0) throw new Error(UNREADABLE)
      if (depth === 0) {
        chunks.push(trimmed.slice(start, i + 1))
        start = i + 1
      }
    }
  }
  const rest = trimmed.slice(start).trim()
  if (rest !== '') chunks.push(rest)
  return chunks.map(chunk => {
    try {
      return JSON.parse(chunk) as unknown
    } catch {
      throw new Error(UNREADABLE)
    }
  })
}

/** Paginated `gh api --paginate` output read as one list: each page's array is flattened, a non-array page is kept as-is. */
export function readJsonList(text: string): unknown[] {
  return readPages(text).flatMap(page => (Array.isArray(page) ? page : [page]))
}

const rows = (text: string): Row[] => readJsonList(text).filter((one): one is Row => typeof one === 'object' && one !== null)

export const readReviews = (text: string): Feedback[] =>
  rows(text).map(row => {
    const body = str(row.body) ?? ''
    return {
      id: `review:${String(row.id)}`,
      kind: 'review',
      reviewer: login(row),
      body,
      head: str(row.commit_id),
      url: str(row.html_url),
      state: str(row.state),
      at: when(row.submitted_at),
      isFinding: body.trim() !== '' || row.state === 'CHANGES_REQUESTED',
    }
  })

export const readInlineComments = (text: string): Feedback[] =>
  rows(text).map(row => ({
    id: `inline:${String(row.id)}`,
    kind: 'inline',
    reviewer: login(row),
    body: str(row.body) ?? '',
    head: str(row.commit_id),
    file: str(row.path),
    line: num(row.line) ?? num(row.original_line),
    threadId: String(num(row.in_reply_to_id) ?? row.id),
    url: str(row.html_url),
    at: when(row.created_at),
    isFinding: (str(row.body) ?? '').trim() !== '',
  }))

export const readIssueComments = (text: string): Feedback[] =>
  rows(text).map(row => ({
    id: `comment:${String(row.id)}`,
    kind: 'comment',
    reviewer: login(row),
    body: str(row.body) ?? '',
    url: str(row.html_url),
    at: when(row.created_at),
    isFinding: (str(row.body) ?? '').trim() !== '',
  }))

/** Each page is `{ total_count, check_runs: [...] }`; an unpaginated single object reads the same way. */
export function readCheckRuns(text: string): Check[] {
  return readPages(text).flatMap(page => {
    const runs = (page as { check_runs?: unknown } | null)?.check_runs
    return Array.isArray(runs) ? (runs as Row[]) : []
  }).map(row => ({ name: String(row.name ?? ''), status: String(row.status ?? ''), conclusion: str(row.conclusion) ?? null }))
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [])

/** `.github/pr-gate.json`: who and what to wait for. A file that is not a JSON object is ignored. */
export function readRoster(text: string): Roster | undefined {
  if (text.trim() === '') return undefined
  try {
    const row = JSON.parse(text) as unknown
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
    const r = row as Row
    return {
      reviewers: strings(r.reviewers),
      checks: strings(r.checks),
      requestReview: strings(r.requestReview),
      ...(num(r.quietMinutes) === undefined ? {} : { quietMinutes: num(r.quietMinutes) }),
      ...(num(r.waitCapMinutes) === undefined ? {} : { waitCapMinutes: num(r.waitCapMinutes) }),
    }
  } catch {
    return undefined
  }
}

const SECURITY = /\b(security|injection|xss|csrf|ssrf|secret|credential|auth(entication|orization)? bypass|rce|path traversal)\b/i

/** The reviewer's own severity, when it gave one; the main agent can still change it. */
export function severityHint(body: string): { severity: Severity; isSecurity: boolean } {
  const isSecurity = SECURITY.test(body)
  const tagged = body.match(/\bP([0-3])\b/)?.[1]
  if (tagged !== undefined) return { severity: `P${tagged}` as Severity, isSecurity }
  if (/\b(critical|blocker|high)\b/i.test(body)) return { severity: 'P1', isSecurity }
  // A security hint never drops below P2 unless the reviewer tagged a severity itself.
  if (/\b(nit|nitpick|typo|minor)\b/i.test(body)) return { severity: isSecurity ? 'P2' : 'P3', isSecurity }
  return { severity: isSecurity ? 'P1' : 'P2', isSecurity }
}

export type CollectInput = {
  roster?: Roster
  feedback: readonly Feedback[]
  checks: readonly Check[]
  head: string
  /** When the head was first seen: feedback with no commit counts for it from then on. */
  headAt: number
  startedAt: number
  lastArrivalAt: number
  now: number
  quietMs: number
  capMs: number
}

/** Whether a post-PR round has collected enough: the roster's list, or settled checks and a quiet spell; always the cap. */
export function collectionDone(input: CollectInput): { isDone: boolean; isComplete: boolean; missing: string[]; covered: string[] } {
  const covered = [
    ...new Set(input.feedback.filter(one => (one.head === undefined ? one.at >= input.headAt : one.head === input.head)).map(one => one.reviewer)),
  ]
  const finished = new Set(input.checks.filter(one => one.status === 'completed').map(one => one.name))
  const roster = input.roster
  const hasRoster = roster !== undefined && (roster.reviewers.length > 0 || roster.checks.length > 0)
  const missing = hasRoster
    ? [...roster.reviewers.filter(one => !covered.includes(one)), ...roster.checks.filter(one => !finished.has(one))]
    : input.checks.filter(one => one.status !== 'completed').map(one => one.name)
  const isQuiet = hasRoster || input.now - input.lastArrivalAt >= input.quietMs
  if (missing.length === 0 && isQuiet) return { isDone: true, isComplete: true, missing, covered }
  if (input.now - input.startedAt >= input.capMs) return { isDone: true, isComplete: missing.length === 0, missing, covered }
  return { isDone: false, isComplete: false, missing, covered }
}

// ----------------------------------------------------------- PR actions
//
// Design (ruling R18): not a shell parser. Every route an agent might reach for after a refusal is held, failing toward a hold. A false hold
// costs one retry with a waiver; a miss costs the whole gate. Residual risk that a regex cannot see: shell indirection such as `g=gh; $g pr ...`,
// `eval`, and commands built in files or scripts that run later.

export type PrAction = {
  action: 'create' | 'merge'
  /** How: a command or a tool name, for the refusal's words. */
  via: string
  base?: string
  head?: string
  /** owner/repo when the call names one. */
  repo?: string
  /** A merge's PR number; undefined means the PR of the checked-out branch. */
  number?: number
  cwd?: string
  /** A GitHub tool this mod does not know, held because it reads as opening or merging a PR. */
  isUnknown?: boolean
}

// ------------------------------------------------------------------ Bash

/** Join continuations, drop quotes, collapse whitespace. */
const normalise = (command: string): string =>
  command
    .replace(/\\\r?\n/g, ' ')
    .replace(/['"]/g, '')
    .replace(/[ \t]+/g, ' ')

const segmentsOf = (normal: string): string[] =>
  normal
    .split(/;|&&|\|\||\||\n|\$\(|`|\(|\)/)
    .map((one) => one.trim())
    .filter((one) => one !== '')

const cdOf = (normal: string): string | undefined => normal.match(/(?:^|&&|;)\s*cd\s+([^\s;&]+)/)?.[1]

const isCommand = (token: string, name: string): boolean => token === name || token.endsWith(`/${name}`)

/** The value of a flag in any of its spellings: `-R x`, `--repo x`, `--repo=x`, `-Rx`. */
function flagValue(tokens: string[], names: string[]): string | undefined {
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    for (const name of names) {
      if (token === name) return tokens[at + 1]
      if (name.startsWith('--') && token.startsWith(`${name}=`)) return token.slice(name.length + 1)
      if (!name.startsWith('--') && token.startsWith(name) && token.length > name.length && !token.startsWith('--')) return token.slice(name.length)
    }
  }
  return undefined
}

const FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field']

/** The value of a `-f name=value` style field in any spelling. */
function fieldValue(tokens: string[], name: string): string | undefined {
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    let pair: string | undefined
    if (FIELD_FLAGS.includes(token)) pair = tokens[at + 1]
    else if (token.startsWith('--field=')) pair = token.slice(8)
    else if (token.startsWith('--raw-field=')) pair = token.slice(12)
    else if (/^-[fF][^-]/.test(token)) pair = token.slice(2)
    if (pair !== undefined && pair.startsWith(`${name}=`)) return pair.slice(name.length + 1)
  }
  return undefined
}

const hasFieldFlag = (tokens: string[]): boolean => tokens.some((token) => /^(-[fF]|--field|--raw-field|--input)/.test(token))

/** `-X POST`, `-XPOST`, `--method POST`, `--method=POST`, uppercased; '' when none. */
const methodOf = (tokens: string[], names: string[]): string => (flagValue(tokens, names) ?? '').toUpperCase()

const MERGE_VALUE_FLAGS = ['--body', '-b', '--subject', '-t', '--match-head-commit', '-R', '--repo', '--author-email', '-A']

/** The PR a `gh pr merge` names: a number, a /pull/ URL, or something else (a branch) that is held as unknown. */
function mergeTarget(args: string[]): { number?: number; isUnknown?: boolean } {
  for (let at = 0; at < args.length; at++) {
    const token = args[at] ?? ''
    if (token.startsWith('-')) {
      if (MERGE_VALUE_FLAGS.includes(token)) at++
      continue
    }
    const url = token.match(/\/pull\/(\d+)/)?.[1]
    if (url !== undefined) return { number: Number(url) }
    if (/^\d+$/.test(token)) return { number: Number(token) }
    return { number: undefined, isUnknown: true }
  }
  return { number: undefined }
}

/** The subcommand after `pr`, skipping global flags and their values. */
function prSubcommand(tokens: string[], from: number): number {
  for (let at = from; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    if (token.startsWith('-')) continue
    const before = tokens[at - 1] ?? ''
    if (before === '-R' || before === '--repo') continue
    return at
  }
  return -1
}

function readGhPr(tokens: string[], gh: number, cwd: string | undefined): PrAction | undefined {
  const pr = tokens.indexOf('pr', gh + 1)
  if (pr < 0) return undefined
  const sub = prSubcommand(tokens, pr + 1)
  const verb = sub < 0 ? '' : (tokens[sub] ?? '')
  const repo = flagValue(tokens, ['-R', '--repo'])
  if (verb === 'merge') return { action: 'merge', via: 'gh pr merge', repo, cwd, ...mergeTarget(tokens.slice(sub + 1)) }
  if (verb === 'create' || verb === 'new') {
    return { action: 'create', via: 'gh pr create', repo, cwd, base: flagValue(tokens, ['--base', '-B']), head: flagValue(tokens, ['--head', '-H']) }
  }
  return undefined
}

const PULLS_PATH = /(?:^|\/)repos\/([^/\s]+)\/([^/\s]+)\/pulls(?:\/(\d+)\/merge)?\/?(?:\?.*)?$/

type PullsPath = { repo?: string; number?: number; isMerge: boolean }

function pullsPathOf(tokens: string[]): PullsPath | undefined {
  for (const token of tokens) {
    const found = token.match(PULLS_PATH)
    if (found === null) continue
    const repo = `${found[1]}/${found[2]}`
    return { repo: repo.includes('{') ? undefined : repo, number: found[3] === undefined ? undefined : Number(found[3]), isMerge: found[3] !== undefined }
  }
  return undefined
}

/** A REST call to the pulls API that writes: POST or PUT, or no method but fields (gh then posts). An explicit GET stays free. */
function readRest(tokens: string[], via: string, methodFlags: string[], hasBody: boolean, cwd: string | undefined): PrAction | undefined {
  const path = pullsPathOf(tokens)
  if (path === undefined) return undefined
  const method = methodOf(tokens, methodFlags)
  if (!(method === 'POST' || method === 'PUT' || (method === '' && hasBody))) return undefined
  if (path.isMerge) return { action: 'merge', via, repo: path.repo, number: path.number, cwd }
  return { action: 'create', via, repo: path.repo, base: fieldValue(tokens, 'base'), head: fieldValue(tokens, 'head'), cwd }
}

const GRAPHQL_MERGES = /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest)\b/

/** GraphQL names are matched over the whole command: its braces and parentheses split segments. */
function readGraphql(normal: string, tokens: string[], cwd: string | undefined): PrAction | undefined {
  const via = 'gh api graphql'
  if (GRAPHQL_MERGES.test(normal)) return { action: 'merge', via, cwd }
  if (/\bcreatePullRequest\b/.test(normal)) return { action: 'create', via, cwd }
  const isUnreadable = tokens.some((token) => token.startsWith('query=@') || token === '--input') || /\$(?!\()/.test(normal)
  return isUnreadable ? { action: 'merge', via, cwd, isUnknown: true } : undefined
}

function readSegment(segment: string, normal: string, cwd: string | undefined): PrAction | undefined {
  const tokens = segment.split(' ')
  const gh = tokens.findIndex((token) => isCommand(token, 'gh'))
  if (gh >= 0) {
    const pr = readGhPr(tokens, gh, cwd)
    if (pr !== undefined) return pr
    const api = tokens.indexOf('api', gh + 1)
    if (api >= 0) {
      if (tokens.indexOf('graphql', api + 1) >= 0) return readGraphql(normal, tokens, cwd)
      return readRest(tokens.slice(api + 1), 'gh api', ['-X', '--method'], hasFieldFlag(tokens), cwd)
    }
  }
  const curl = tokens.findIndex((token) => isCommand(token, 'curl'))
  if (curl >= 0 && segment.includes('api.github.com')) {
    const hasBody = tokens.some((token) => /^(-d|--data|--json)/.test(token))
    const rest = readRest(tokens.slice(curl + 1), 'curl', ['-X', '--request'], hasBody, cwd)
    if (rest !== undefined) return rest
  }
  const hub = tokens.findIndex((token) => isCommand(token, 'hub'))
  if (hub >= 0 && tokens.indexOf('pull-request', hub + 1) >= 0) return { action: 'create', via: 'hub pull-request', cwd }
  return undefined
}

/** Merge wins over create when one command holds both. */
function readBash(command: string): PrAction | undefined {
  const normal = normalise(command)
  const cwd = cdOf(normal)
  const found = segmentsOf(normal)
    .map((segment) => readSegment(segment, normal, cwd))
    .filter((one): one is PrAction => one !== undefined)
  return found.find((one) => one.action === 'merge') ?? found[0]
}

// ------------------------------------------------------------------- MCP

const GRAPHQL_MCP = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
const MAX_PLAIN = 120

/** Every key and every short string value, however nested. A GraphQL `query` is always kept; long prose (a PR body) is not. */
function flatten(value: unknown, key: string | undefined, out: string[], depth: number): void {
  if (depth > 8) return
  if (typeof value === 'string') {
    if (value.length <= MAX_PLAIN || key === 'query') out.push(value)
  } else if (Array.isArray(value)) {
    for (const one of value) flatten(one, key, out, depth + 1)
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, one] of Object.entries(value)) {
      out.push(name)
      flatten(one, name, out, depth + 1)
    }
  }
}

/** Camel case split, punctuation to spaces, lowercase: `mergePullRequest` and `merge_pull_request` read the same. */
function wordsOf(tool: string, input: Record<string, unknown>): string {
  const parts: string[] = [tool]
  flatten(input, undefined, parts, 0)
  return parts
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
}

const MERGE_WORDS = /\b(merge|enqueue|automerge)\b/
const CREATE_WORDS = /\b(create|new|open|submit)\b/
const PR_WORDS = /\b(pull|pulls|pr|prs)\b/
const REVIEW_WORDS = /\b(reviews?|comments?)\b/

function readUnknownTool(tool: string, input: Record<string, unknown>, repo: string | undefined): PrAction | undefined {
  const said = wordsOf(tool, input)
  if (!PR_WORDS.test(said)) return undefined
  if (MERGE_WORDS.test(said)) return { action: 'merge', via: tool, number: num(input.number ?? input.pullNumber ?? input.pull_number), repo, isUnknown: true }
  if (CREATE_WORDS.test(said) && !REVIEW_WORDS.test(said)) return { action: 'create', via: tool, base: str(input.base), head: str(input.head), repo, isUnknown: true }
  return undefined
}

/** The tools this mod knows by name, and what each one's arguments say. */
function readKnownTool(tool: string, input: Record<string, unknown>, repo: string | undefined): PrAction | undefined {
  const create = (via: string): PrAction => ({ action: 'create', via, base: str(input.base), head: str(input.head), repo })
  const merge = (via: string, number: unknown): PrAction => ({ action: 'merge', via, number: num(number), repo })
  if (tool === 'mcp__plugin_github_github__create_pull_request') return create(tool)
  if (tool === 'mcp__plugin_github_github__merge_pull_request') return merge(tool, input.pullNumber)
  if (tool === 'mcp__plugin_github_github__pull_request_write') {
    const method = String(input.method ?? '').toLowerCase()
    if (method === 'create') return create(`${tool} (create)`)
    if (method === 'merge') return merge(`${tool} (merge)`, input.pullNumber)
  }
  if (tool === GRAPHQL_MCP) {
    const action = String(input.action ?? '').toLowerCase()
    if (action === 'create') return create(`${tool} (create)`)
    if (action === 'merge' || action === 'enqueue') return merge(`${tool} (${action})`, input.number)
  }
  return undefined
}

/** Whether a tool call opens or merges a pull request, on any route this mod can see. Unknown GitHub tools fail closed. */
export function readPrAction(tool: string, input: Record<string, unknown>): PrAction | undefined {
  if (tool === 'Bash') return typeof input.command === 'string' ? readBash(input.command) : undefined
  const owner = str(input.owner)
  const repoName = str(input.repo)
  const repo = owner !== undefined && repoName !== undefined ? `${owner}/${repoName}` : repoName
  const known = readKnownTool(tool, input, repo)
  if (known !== undefined) return known
  if (!tool.startsWith('mcp__') || !/github/i.test(tool)) return undefined
  return readUnknownTool(tool, input, repo)
}
