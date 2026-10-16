// GitHub's half, pure: what `gh api` printed, read as feedback and checks; the
// per-repo roster; when collection is over; and which calls open or merge a PR.

import type { Severity } from '../types'
import { readPrCreate } from './core'

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

const cdOf = (command: string): string | undefined => command.match(/(?:^|&&|;)\s*cd\s+["']?([^\s"';&]+)/)?.[1]
const flagOf = (command: string, names: string): string | undefined =>
  command.match(new RegExp(`(?:^|\\s)(?:${names})(?:=|\\s+)["']?([^\\s"']+)`))?.[1]
const fieldOf = (command: string, name: string): string | undefined =>
  command.match(new RegExp(`(?:-f|-F|--field|--raw-field)\\s+["']?${name}=([^\\s"']+)`))?.[1]

function readBash(command: string): PrAction | undefined {
  const cwd = cdOf(command)
  const create = readPrCreate(command)
  if (create !== undefined) {
    return { action: 'create', via: 'gh pr create', base: create.base, repo: create.repo, cwd: create.cwd, head: flagOf(command, '--head|-H') }
  }
  const merge = command.match(/\bgh\s+pr\s+merge\b([^;&|]*)/)
  if (merge !== null) {
    const args = merge[1] ?? ''
    const number = args.match(/\/pull\/(\d+)/)?.[1] ?? args.match(/(?:^|\s)(\d+)(?=\s|$)/)?.[1]
    return { action: 'merge', via: 'gh pr merge', number: number === undefined ? undefined : Number(number), repo: flagOf(command, '--repo|-R'), cwd }
  }
  if (!/\bgh\s+api\b/.test(command)) return undefined
  if (/\bgraphql\b/.test(command)) {
    if (/\b(mergePullRequest|enqueuePullRequest|enablePullRequestAutoMerge)\b/.test(command)) return { action: 'merge', via: 'gh api graphql', cwd }
    if (/\bcreatePullRequest\b/.test(command)) return { action: 'create', via: 'gh api graphql', cwd }
    return undefined
  }
  const merged = command.match(/repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge\b/)
  if (merged !== null) return { action: 'merge', via: 'gh api', repo: merged[1], number: Number(merged[2]), cwd }
  const pulls = command.match(/repos\/([^/\s]+\/[^/\s]+)\/pulls(?=["'\s]|$)/)
  const method = (flagOf(command, '-X|--method') ?? '').toUpperCase()
  const hasFields = /(?:^|\s)(-f|-F|--field|--raw-field|--input)\s/.test(command)
  if (pulls !== null && (method === 'POST' || (method === '' && hasFields))) {
    return { action: 'create', via: 'gh api', repo: pulls[1], base: fieldOf(command, 'base'), head: fieldOf(command, 'head'), cwd }
  }
  return undefined
}

const GRAPHQL_MCP = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'

/** Whether a tool call opens or merges a pull request, on any route this mod can see. Unknown GitHub tools fail closed. */
export function readPrAction(tool: string, input: Record<string, unknown>): PrAction | undefined {
  if (tool === 'Bash') return typeof input.command === 'string' ? readBash(input.command) : undefined
  const owner = str(input.owner)
  const repoName = str(input.repo)
  const repo = owner !== undefined && repoName !== undefined ? `${owner}/${repoName}` : repoName
  if (tool === 'mcp__plugin_github_github__create_pull_request') {
    return { action: 'create', via: tool, base: str(input.base), head: str(input.head), repo }
  }
  if (tool === 'mcp__plugin_github_github__merge_pull_request') return { action: 'merge', via: tool, number: num(input.pullNumber), repo }
  if (tool === GRAPHQL_MCP) {
    const action = String(input.action ?? '')
    if (action === 'create') return { action: 'create', via: `${tool} (create)`, base: str(input.base), head: str(input.head), repo }
    if (action === 'merge' || action === 'enqueue') return { action: 'merge', via: `${tool} (${action})`, number: num(input.number), repo }
    return undefined
  }
  if (!tool.startsWith('mcp__') || !/github/i.test(tool)) return undefined
  const said = `${tool} ${String(input.action ?? input.method ?? input.operation ?? '')}`.toLowerCase()
  if (/merge|enqueue|auto[_\s-]?merge/.test(said)) return { action: 'merge', via: tool, number: num(input.number ?? input.pullNumber ?? input.pull_number), repo, isUnknown: true }
  if (/(create|open)[_\s-]*(pull|pr\b)/.test(said)) return { action: 'create', via: tool, base: str(input.base), head: str(input.head), repo, isUnknown: true }
  return undefined
}
