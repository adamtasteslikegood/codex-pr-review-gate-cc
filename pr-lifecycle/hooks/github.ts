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
  /** The author's GitHub author association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...), when the row says. */
  association?: string
}

export type Check = { name: string; status: string; conclusion: string | null }

/**
 * A repository's `.github/pr-gate.json` roster: `reviewers` are trusted and waited for, `checks` are waited for, `trusted` are
 * trusted only (#14): their feedback is triaged, but collection never waits on them.
 */
export type Roster = { reviewers: string[]; checks: string[]; requestReview: string[]; trusted: string[]; quietMinutes?: number; waitCapMinutes?: number }

type Row = Record<string, unknown>

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const login = (row: Row): string => str((row.user as Row | undefined)?.login) ?? 'unknown'
const associationOf = (row: Row): string | undefined => str(row.author_association) ?? str(row.authorAssociation)
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
      isFinding: row.state === 'CHANGES_REQUESTED' || (body.trim() !== '' && !isNoAction(str(row.state), body)),
      association: associationOf(row),
    }
  })

export const readInlineComments = (text: string): Feedback[] =>
  rows(text).map(row => ({
    id: `inline:${String(row.id)}`,
    kind: 'inline',
    reviewer: login(row),
    body: str(row.body) ?? '',
    // The commit the comment was written on: GitHub moves commit_id forward to the newest commit while the line is unchanged, which
    // would make an old comment read as coverage of a new head.
    head: str(row.original_commit_id) ?? str(row.commit_id),
    file: str(row.path),
    line: num(row.line) ?? num(row.original_line),
    threadId: String(num(row.in_reply_to_id) ?? row.id),
    url: str(row.html_url),
    at: when(row.created_at),
    isFinding: (str(row.body) ?? '').trim() !== '',
    association: associationOf(row),
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
    association: associationOf(row),
  }))

/** Each page is `{ total_count, check_runs: [...] }`; an unpaginated single object reads the same way. */
export function readCheckRuns(text: string): Check[] {
  return readPages(text).flatMap(page => {
    const runs = (page as { check_runs?: unknown } | null)?.check_runs
    return Array.isArray(runs) ? (runs as Row[]) : []
  }).map(row => ({ name: String(row.name ?? ''), status: String(row.status ?? ''), conclusion: str(row.conclusion) ?? null }))
}

/** Commit-status states that are final: a pending status has not finished. */
const FINAL_STATES = ['success', 'failure', 'error']

/**
 * The head's combined commit status (`{ state, statuses: [{ context, state }] }` per page) read as checks (R89): some CI posts a
 * required check as a status, not a check run. A final state is a completed check whose conclusion is that state. Throws on text
 * that does not parse, so the caller can say so.
 */
export function readStatuses(text: string): Check[] {
  return readPages(text).flatMap(page => {
    const rows = (page as { statuses?: unknown } | null)?.statuses
    return Array.isArray(rows) ? (rows as Row[]) : []
  }).flatMap(row => {
    const name = str(row.context)
    const state = str(row.state) ?? ''
    if (name === undefined) return []
    return [{ name, status: FINAL_STATES.includes(state) ? 'completed' : 'pending', conclusion: FINAL_STATES.includes(state) ? state : null }]
  })
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [])

/** `.github/pr-gate.json`: who and what to wait for. A file that is not a JSON object is ignored. */
export function readRoster(text: string): Roster | undefined {
  if (text.trim() === '') return undefined
  try {
    const row = JSON.parse(text) as unknown
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
    const r = row as Row
    // A wait under a minute would end collection on the first poll: it is ignored, so the plugin option applies.
    // One over a day is capped there: a huge one would never time out.
    const minutes = (value: unknown): number | undefined => {
      const n = num(value)
      return n !== undefined && n >= 1 ? Math.min(Math.floor(n), 24 * 60) : undefined
    }
    const quietMinutes = minutes(r.quietMinutes)
    const waitCapMinutes = minutes(r.waitCapMinutes)
    return {
      reviewers: strings(r.reviewers),
      checks: strings(r.checks),
      requestReview: strings(r.requestReview),
      trusted: strings(r.trusted),
      ...(quietMinutes === undefined ? {} : { quietMinutes }),
      ...(waitCapMinutes === undefined ? {} : { waitCapMinutes }),
    }
  } catch {
    return undefined
  }
}

/** Author associations with write access to the repository. */
const WRITERS = ['OWNER', 'MEMBER', 'COLLABORATOR']

/**
 * Whether a piece of feedback is triaged at all (R1-8): its author has write access, or is on the roster (a review bot, waited for
 * or only trusted, #14), or the row does not say (kept, and fenced like the rest). Anyone else's comment is dropped before it
 * reaches a prompt or covers a head.
 */
export const isTrusted = (one: Feedback, roster: Roster | undefined): boolean =>
  one.association === undefined ||
  WRITERS.includes(one.association) ||
  roster?.reviewers.includes(one.reviewer) === true ||
  roster?.trusted.includes(one.reviewer) === true ||
  roster?.requestReview.some(name => postsFor(one.reviewer, name)) === true

/**
 * Whether a login posts for a `requestReview` name (F3): the name itself, or a GitHub App bot whose login, `[bot]` dropped, is the
 * name or starts with `<name>-` (`copilot` posts as `copilot-pull-request-reviewer[bot]`). Only a `[bot]` login, which no person can
 * hold, matches by prefix.
 */
export const postsFor = (login: string, name: string): boolean => {
  if (login === name) return true
  if (!login.endsWith('[bot]')) return false
  const stem = login.slice(0, -'[bot]'.length)
  return stem === name || stem.startsWith(`${name}-`)
}

const SECURITY = /\b(security|injection|xss|csrf|ssrf|secret|credential|auth(entication|orization)? bypass|rce|path traversal)\b/i

/**
 * A reviewer's own advisory label at the start of the body (after a heading mark or list marker), never inside a sentence. Only the
 * start counts (final review C1): "Nit:" on a later line labels that line, not the finding above it, so it tags nothing.
 */
const ADVISORY = /^\s*(?:#+\s*|[-*+]\s+|\d+\.\s+)?[*_[(]*\s*(?:advisory|non-blocking|nit(?:pick)?|optional|follow-up)[*_\])]*\s*(?:[:,(—]|-\s|\n|$)/i

/**
 * A reviewer's own severity tag (R94): a token standing alone. `[P2]`, `(P2)`, `**P2**` or `**P2:**` anywhere; `P2:` or `P2 -` at the
 * start of a line, after a list marker; or a badge image named for it (`![P2 Badge]`, as Codex's connector posts). Any other mention,
 * such as "[P2 thread]" or "the outstanding P2", is a hint the agent may change.
 */
const TAG = /\[P([0-3])\]|\(P([0-3])\)|\*\*P([0-3]):?\*\*|!\[P([0-3])[ _-]?Badge\]|^[ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+)?P([0-3])(?::|[ \t]+-[ \t])/gim

/** The reviewer's own severity, when it gave one; the main agent can still change a guessed one (R84). */
export function severityHint(body: string): { severity: Severity; isSecurity: boolean; isTagged: boolean } {
  const isSecurity = SECURITY.test(body)
  // The most severe tag anywhere wins: one P1 in a list of advisories is a P1.
  const tags = [...body.matchAll(TAG)].map(one => Number(one.slice(1).find(each => each !== undefined)))
  if (tags.length > 0) return { severity: `P${Math.min(...tags)}` as Severity, isSecurity, isTagged: true }
  if (ADVISORY.test(body)) return { severity: 'P3', isSecurity, isTagged: true }
  // A severity named in passing is a guess (R94): the most severe one named, never below P2 for a security hint.
  const named = [...body.matchAll(/\bP([0-3])\b/g)].map(one => Number(one[1]))
  if (named.length > 0) {
    const level = Math.min(...named)
    return { severity: `P${isSecurity ? Math.min(level, 2) : level}` as Severity, isSecurity, isTagged: false }
  }
  if (/\b(critical|blocker|high)\b/i.test(body)) return { severity: 'P1', isSecurity, isTagged: false }
  // A security hint never drops below P2 unless the reviewer tagged a severity itself.
  if (/\b(nit|nitpick|typo|minor)\b/i.test(body)) return { severity: isSecurity ? 'P2' : 'P3', isSecurity, isTagged: false }
  return { severity: isSecurity ? 'P1' : 'P2', isSecurity, isTagged: false }
}

/** Whole sentences that settle a review (R83). */
const SCOPE = '(?: (?:in|for) this (?:[\\w/-]+ ){0,2}(?:diff|pr|pull request|changes?|commit|patch|update|revision))?'
const SETTLES = [
  new RegExp(`^no (?:actionable|blocking) (?:findings|issues|comments)${SCOPE}$`, 'i'),
  /^(?:no issues found|nothing to fix|lgtm|looks good(?: to me)?|approved|ship it)$/i,
]
/** Whole sentences that may sit beside them and change nothing. */
const POLITE = [/^(?:thanks|thank you)$/i, /^reviewed [0-9a-f]{7,40}(?: against [\w./-]+)?$/i]

/**
 * Whether a review says there is nothing to act on (R83): positive evidence only (review G2-2 on PR #19). Every sentence of the body
 * must be a no-action form, judged whole, never by the absence of request words (PR #19 review): "LGTM. Preserve the pending
 * findings." goes to triage. A COMMENTED review also needs one settling sentence. Inline comments are separate rows, triaged on their own.
 */
export function isNoAction(state: string | undefined, body: string): boolean {
  if (state !== 'APPROVED' && state !== 'COMMENTED') return false
  const sentences = body
    .split(/[.!?;]+|\n+/)
    .map(one => one.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(one => one !== '')
  if (sentences.length === 0) return true
  const settles = (one: string): boolean => SETTLES.some(re => re.test(one))
  if (!sentences.every(one => settles(one) || POLITE.some(re => re.test(one)))) return false
  return state === 'APPROVED' || sentences.some(settles)
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
  /** Logins with a pending review request on the PR, this machine's own left out (R89). */
  requested?: readonly string[]
  /** The base's required checks (R86), or 'unknown', where every reported check stands in. Absent reads as 'unknown'. */
  required?: readonly string[] | 'unknown'
}

/**
 * Whether a post-PR round has collected enough (R89): every required check has a completed run on the head, every pending review
 * request has a review of the head, and every roster reviewer covered it. Check suites are never read: an installed app can leave
 * one queued forever. The quiet window applies only where none of the three exists. The cap applies always.
 */
export function collectionDone(input: CollectInput): { isDone: boolean; isComplete: boolean; missing: string[]; covered: string[] } {
  const roster = input.roster
  const hasRoster = roster !== undefined && (roster.reviewers.length > 0 || roster.checks.length > 0)
  // Who covers the head: with a roster, its reviewers, and a trusted reviewer whose review is already in (#14: never waited for);
  // without one, reviews and inline comments, never an issue comment (a deploy-preview bot's note reviews nothing).
  const counts = (one: Feedback): boolean =>
    hasRoster && roster !== undefined ? roster.reviewers.includes(one.reviewer) || roster.trusted.includes(one.reviewer) : one.kind !== 'comment'
  const isOnHead = (one: Feedback): boolean => (one.head === undefined ? one.at >= input.headAt : one.head === input.head)
  const covered = [...new Set(input.feedback.filter(one => counts(one) && isOnHead(one)).map(one => one.reviewer))]
  const finished = new Set(input.checks.filter(one => one.status === 'completed').map(one => one.name))
  const required = input.required === undefined || input.required === 'unknown' ? [...new Set(input.checks.map(one => one.name))] : input.required
  const requested = input.requested ?? []
  // A request is answered by a review of the head, or, with a roster, by the reviewer covering it as the roster counts it: a roster
  // reviewer the gate asked again may reply in a comment, which GitHub never clears the request for (#24: never a wait on the cap).
  // Without a roster, coverage never answers one: only a review of the head does.
  const isAnswered = (who: string): boolean =>
    input.feedback.some(one => one.kind === 'review' && one.head === input.head && postsFor(one.reviewer, who)) ||
    (hasRoster && covered.some(one => postsFor(one, who)))
  const missing = [
    ...new Set([
      ...(hasRoster ? [...roster.reviewers.filter(one => !covered.includes(one)), ...roster.checks.filter(one => !finished.has(one))] : []),
      ...requested.filter(one => !isAnswered(one)),
      ...required.filter(one => !finished.has(one)),
    ]),
  ]
  const hasSignals = hasRoster || requested.length > 0 || required.length > 0
  const isQuiet = hasSignals || input.now - input.lastArrivalAt >= input.quietMs
  if (missing.length === 0 && isQuiet) return { isDone: true, isComplete: true, missing, covered }
  if (input.now - input.startedAt >= input.capMs) return { isDone: true, isComplete: missing.length === 0, missing, covered }
  return { isDone: false, isComplete: false, missing, covered }
}

/**
 * The logins a PR's review is requested from (R89), as `GET .../requested_reviewers` lists them; teams are not people the gate can
 * match, so they are left out, and so is this machine's own login (Review Focus 2). Unreadable text lists none.
 */
export function readRequested(text: string, self: string): string[] {
  try {
    const users = (JSON.parse(text) as { users?: unknown } | null)?.users
    if (!Array.isArray(users)) return []
    return users.flatMap(one => {
      const name = str((one as Row | null)?.login)
      return name === undefined || name === self ? [] : [name]
    })
  } catch {
    return []
  }
}

// ----------------------------------------------------------- PR actions
//
// Design (rulings R18, R19): not a shell parser. Every route an agent might reasonably reach for after a refusal is held, failing toward a hold.
// A false hold costs one retry with a waiver; a miss costs the whole gate. MCP calls are read from structure only (tool name, operation keys,
// key names, REST paths, mutation names), never from free text such as titles, bodies, messages and file contents.

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

/** A heredoc opener: `<<` that is not part of a `<<<` here-string and not a shift after a digit or `(`. */
const HEREDOC = /(?<![<\d(])<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/

/** Whether `<<` sits inside an open `$((` or `((` arithmetic expression on its line. */
const isArithmetic = (before: string): boolean => (before.match(/\(\(/g) ?? []).length > (before.match(/\)\)/g) ?? []).length

const SHELLS = ['bash', 'sh', 'zsh']
const SHELL_FEEDERS = [...SHELLS, 'eval', 'ssh', 'xargs']

/** The command name of a shell segment, past `sudo`, `env` and `VAR=value` prefixes, quotes dropped. */
function commandName(segment: string): string {
  const tokens = segment.replace(/['"]/g, '').trim().split(/\s+/)
  const at = tokens.findIndex((token) => token !== 'sudo' && token !== 'env' && !/^[A-Za-z_]\w*=/.test(token))
  return (tokens[at] ?? '').split('/').pop() ?? ''
}

/** A heredoc whose body a shell runs: the command before `<<` is a shell or feeder, or the line pipes into a shell. */
function isShellFed(line: string, opener: number): boolean {
  const before = line.slice(0, opener).split(/;|&&|\|\||\||\(/).pop() ?? ''
  if (SHELL_FEEDERS.includes(commandName(before))) return true
  return line.slice(opener).split('|').slice(1).some((piped) => SHELLS.includes(commandName(piped)))
}

/**
 * Drop heredoc bodies: from `<<WORD`, `<<'WORD'`, `<<"WORD"` or `<<-WORD` to the line equal to WORD (leading tabs trimmed for `<<-`).
 * A body fed to a shell is kept, so its lines are read as commands.
 */
function dropHeredocs(command: string): string {
  const kept: string[] = []
  let end: { word: string; isDash: boolean; isKept: boolean } | undefined
  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if ((end.isDash ? line.replace(/^\t+/, '') : line) === end.word) end = undefined
      else if (end.isKept) kept.push(line)
      continue
    }
    kept.push(line)
    const here = line.match(HEREDOC)
    if (here === null || isArithmetic(line.slice(0, here.index))) continue
    end = { word: here[3] ?? '', isDash: here[1] === '-', isKept: isShellFed(line, here.index ?? 0) }
  }
  return kept.join('\n')
}

/** Join continuations, drop heredoc bodies and quotes, collapse whitespace. */
const normalise = (command: string): string =>
  dropHeredocs(command.replace(/\\\r?\n/g, ' '))
    .replace(/['"]/g, '')
    .replace(/[ \t]+/g, ' ')

const segmentsOf = (normal: string): string[] =>
  normal
    .split(/;|&&|\|\||\||\n|\$\(|`|\(|\)/)
    .map((one) => one.trim())
    .filter((one) => one !== '')

const cdOf = (normal: string): string | undefined => normal.match(/(?:^|&&|;)\s*cd\s+([^\s;&]+)/)?.[1]

/** The command name, as `gh` or `/usr/bin/GH` alike. */
const isCommand = (token: string, name: string): boolean => {
  const lower = token.toLowerCase()
  return lower === name || lower.endsWith(`/${name}`)
}

/** Commands that print or store text, so a `gh pr ...` after them is prose. Residual risk: they can also hide a command. */
const PROSE_COMMANDS = ['echo', 'printf', 'grep', 'rg', 'cat', 'git', 'sed', 'awk']

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

const GH_VALUE_FLAGS = ['-R', '--repo', '--hostname']

/** The first non-flag token after `gh` and its global flags: `pr`, `api`, `issue`, ... Returns its index, or -1. */
function ghSubject(tokens: string[], gh: number): number {
  for (let at = gh + 1; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    if (!token.startsWith('-')) return at
    if (GH_VALUE_FLAGS.includes(token)) at++
  }
  return -1
}

/** The subcommand after `pr`, skipping flags and their values. */
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

function readGhPr(tokens: string[], pr: number, cwd: string | undefined): PrAction | undefined {
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

function pullsPathIn(value: string): PullsPath | undefined {
  const found = value.match(PULLS_PATH)
  if (found === null) return undefined
  const repo = `${found[1]}/${found[2]}`
  return { repo: repo.includes('{') ? undefined : repo, number: found[3] === undefined ? undefined : Number(found[3]), isMerge: found[3] !== undefined }
}

function pullsPathOf(tokens: string[]): PullsPath | undefined {
  for (const token of tokens) {
    const found = pullsPathIn(token)
    if (found !== undefined) return found
  }
  return undefined
}

/** A REST call to the pulls API that writes: POST or PUT, or no method but a body (gh and curl then post). An explicit GET stays free. */
function readRest(tokens: string[], via: string, methodFlags: string[], hasBody: boolean, cwd: string | undefined): PrAction | undefined {
  const path = pullsPathOf(tokens)
  if (path === undefined) return undefined
  const method = methodOf(tokens, methodFlags)
  if (!(method === 'POST' || method === 'PUT' || (method === '' && hasBody))) return undefined
  if (path.isMerge) return { action: 'merge', via, repo: path.repo, number: path.number, cwd }
  return { action: 'create', via, repo: path.repo, base: fieldValue(tokens, 'base'), head: fieldValue(tokens, 'head'), cwd }
}

const MERGE_MUTATIONS = ['mergePullRequest', 'enablePullRequestAutoMerge', 'enqueuePullRequest']
const CREATE_MUTATIONS = ['createPullRequest']

/** The mutation a text names, if any; merge wins. */
function mutationIn(text: string): 'merge' | 'create' | undefined {
  if (MERGE_MUTATIONS.some((name) => text.includes(name))) return 'merge'
  return CREATE_MUTATIONS.some((name) => text.includes(name)) ? 'create' : undefined
}

/** GraphQL names are matched over the whole command: its braces and parentheses split segments. An unreadable query is held as unknown. */
function readGraphql(normal: string, isUnreadable: boolean, via: string, cwd: string | undefined): PrAction | undefined {
  const mutation = mutationIn(normal)
  if (mutation !== undefined) return { action: mutation, via, cwd }
  return isUnreadable ? { action: 'merge', via, cwd, isUnknown: true } : undefined
}

/** `gh api graphql`: a query read from a file or input, or whose value starts with `$` or `$(`. Variables inside literal text are readable. */
const isGhQueryUnreadable = (tokens: string[], normal: string): boolean =>
  tokens.some((token) => token.startsWith('query=@') || token === '--input') || /query=\$/.test(normal)

const BODY_FLAGS = ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json']

/** `curl` body flags: the body is unreadable when it comes from a file or starts with `$`. */
function isCurlBodyUnreadable(tokens: string[]): boolean {
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    const attached = BODY_FLAGS.find((flag) => token.startsWith(flag) && token.length > flag.length)
    const value = BODY_FLAGS.includes(token) ? tokens[at + 1] : attached === undefined ? undefined : token.slice(attached.length).replace(/^=/, '')
    if (value !== undefined && (value.startsWith('@') || value.startsWith('$'))) return true
  }
  return false
}

function readCurl(tokens: string[], curl: number, normal: string, cwd: string | undefined): PrAction | undefined {
  const rest = tokens.slice(curl + 1)
  if (rest.some((token) => /\/graphql\/?(?:\?.*)?$/.test(token))) return readGraphql(normal, isCurlBodyUnreadable(rest), 'curl graphql', cwd)
  const hasBody = rest.some((token) => /^(-d|--data|--json)/.test(token))
  return readRest(rest, 'curl', ['-X', '--request'], hasBody, cwd)
}

function readSegment(segment: string, normal: string, cwd: string | undefined): PrAction | undefined {
  const tokens = segment.split(' ')
  const first = (tokens[0] ?? '').split('/').pop()?.toLowerCase() ?? ''
  if (PROSE_COMMANDS.includes(first)) return undefined
  const gh = tokens.findIndex((token) => isCommand(token, 'gh'))
  if (gh >= 0) {
    const subject = ghSubject(tokens, gh)
    const word = subject < 0 ? '' : (tokens[subject] ?? '')
    if (word === 'pr') return readGhPr(tokens, subject, cwd)
    if (word === 'api') {
      if (tokens.indexOf('graphql', subject + 1) >= 0) return readGraphql(normal, isGhQueryUnreadable(tokens, normal), 'gh api graphql', cwd)
      return readRest(tokens.slice(subject + 1), 'gh api', ['-X', '--method'], hasFieldFlag(tokens), cwd)
    }
  }
  const curl = tokens.findIndex((token) => isCommand(token, 'curl'))
  if (curl >= 0) {
    const found = readCurl(tokens, curl, normal, cwd)
    if (found !== undefined) return found
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

/**
 * Whether a Bash command does more than its PR action (R87). A hook allows or refuses the whole command, so a held `gh pr create`
 * also stops the file write or push chained with it. Quoted text, `$(…)` and heredoc bodies belong to their step; a bare `cd` is no step.
 */
export function hasOtherSteps(command: string): boolean {
  const bare = dropHeredocs(command.replace(/\\\r?\n/g, ' '))
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q')
    .replace(/\$\([^()]*\)/g, 'S')
  const steps = bare
    .split(/;|&&|\|\||\||\n/)
    .map(one => one.trim())
    .filter(one => one !== '' && !/^cd\s+\S+$/.test(one))
  return steps.length > 1
}

// ------------------------------------------------------------------- MCP

const GRAPHQL_MCP = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
const MAX_PLAIN = 120

/** Camel case split, punctuation to spaces, lowercase: `mergePullRequest` and `merge_pull_request` read the same. */
const wordsOf = (text: string): string =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()

const PRIMARY_KEYS = ['action', 'method', 'operation', 'op']
const SECONDARY_KEYS = ['command', 'type', 'name', 'tool', 'mode', 'function', 'verb', 'subcommand', 'operationname', 'tool_name']

/** What a call's input structurally says. Free text (titles, bodies, messages, paths to files) is never read, except for mutation names. */
type Shape = {
  /** Every string value, whatever its length or key: only searched for mutation names. */
  strings: string[]
  keys: string[]
  /** Values under action, method, operation and op. */
  primary: string[]
  /** Values under the other operation keys (command, type, name, tool, verb, ...), at any depth. */
  secondary: string[]
  /** Values that parse as a REST path to the pulls API, such as `path` or `endpoint`. */
  paths: PullsPath[]
  method: string
}

function shapeOf(value: unknown, key: string | undefined, shape: Shape, depth: number): void {
  if (depth > 8) return
  if (typeof value === 'string') {
    shape.strings.push(value)
    const lower = (key ?? '').toLowerCase()
    if (value.length <= MAX_PLAIN) {
      if (PRIMARY_KEYS.includes(lower)) shape.primary.push(value)
      else if (SECONDARY_KEYS.includes(lower)) shape.secondary.push(value)
      const path = pullsPathIn(value)
      if (path !== undefined) shape.paths.push(path)
      if (lower === 'method' && shape.method === '') shape.method = value.toUpperCase()
      const leading = value.match(/^(GET|POST|PUT|PATCH|DELETE)\s/i)?.[1]
      if (path !== undefined && leading !== undefined && shape.method === '') shape.method = leading.toUpperCase()
    }
  } else if (Array.isArray(value)) {
    for (const one of value) shapeOf(one, key, shape, depth + 1)
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, one] of Object.entries(value)) {
      shape.keys.push(name)
      shapeOf(one, name, shape, depth + 1)
    }
  }
}

const MERGE_WORDS = /\b(merge|enqueue|automerge)\b/
const CREATE_WORDS = /\b(create|new|open|submit)\b/
const PR_WORDS = /\b(pull|pulls|pr|prs|pullrequests?)\b/
const REVIEW_WORDS = /\b(reviews?|comments?)\b/

/**
 * The operation words. A primary key (action, method, operation, op) that names a create or merge decides alone. One that names
 * neither does not hide another operation key's merge or create verb, but `open` and `new` there still yield to it.
 */
function operationOf(shape: Shape): string {
  const primary = wordsOf(shape.primary.join(' '))
  const secondary = wordsOf(shape.secondary.join(' '))
  if (shape.primary.length === 0) return secondary
  if (MERGE_WORDS.test(primary) || CREATE_WORDS.test(primary)) return primary
  return `${primary} ${secondary.replace(/\b(open|new)\b/g, ' ')}`
}

function readUnknownTool(tool: string, input: Record<string, unknown>, repo: string | undefined): PrAction | undefined {
  const shape: Shape = { strings: [], keys: [], primary: [], secondary: [], paths: [], method: '' }
  shapeOf(input, undefined, shape, 0)
  const number = num(input.number ?? input.pullNumber ?? input.pull_number)
  const create = (): PrAction => ({ action: 'create', via: tool, base: str(input.base), head: str(input.head), repo, isUnknown: true })
  const merge = (): PrAction => ({ action: 'merge', via: tool, number, repo, isUnknown: true })

  const mutation = mutationIn(shape.strings.join(' '))
  if (mutation === 'merge') return merge()

  const name = wordsOf(tool.split('__').pop() ?? '')
  const operation = operationOf(shape)
  const path = shape.paths[0]
  const isWrite = shape.method === 'POST' || shape.method === 'PUT'
  const hasPr = PR_WORDS.test(name) || PR_WORDS.test(operation) || PR_WORDS.test(wordsOf(shape.keys.join(' '))) || path !== undefined
  if (hasPr && (MERGE_WORDS.test(name) || MERGE_WORDS.test(operation) || (path?.isMerge === true && isWrite))) {
    return { ...merge(), number: path?.number ?? number, repo: path?.repo ?? repo }
  }
  if (mutation === 'create') return create()
  const isCreateVerb = CREATE_WORDS.test(`${name.split(' ')[0] ?? ''}`) || CREATE_WORDS.test(operation) || (path !== undefined && !path.isMerge && isWrite)
  if (hasPr && isCreateVerb && !REVIEW_WORDS.test(`${name} ${operation}`)) return { ...create(), repo: path?.repo ?? repo }
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

/**
 * Whether a tool call opens or merges a pull request, on any route this mod can see. Unknown GitHub tools fail closed.
 *
 * Residual risk, what text matching cannot see:
 * - shell indirection (`g=gh; $g ...`, `$(which gh)`)
 * - scripts and package-manager scripts that call gh
 * - a segment that starts with `git`, `echo`, `cat` and so on and hides a command (for example `git -c alias.x='!gh pr ...' x`)
 * - REST calls from other tools (`http`, `wget`, language one-liners)
 * - a heredoc written to a file and run later (`cat > s.sh <<EOF ... EOF; bash s.sh`): only bodies fed straight to a shell are read
 * - an MCP operation under a key this mod does not list, or an operation spelled only in free text
 * - an MCP argv array (`args: ['pr', 'merge', '5']`) is free text, not an operation
 */
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

/**
 * The checks a base requires (R86): each `required_status_checks` rule of `gh api repos/<slug>/rules/branches/<base>`, plus classic
 * protection's `contexts` and `checks[].context` when given. undefined when either payload can't be parsed: every check then counts as required.
 */
export function readRequired(rules: string, protection: string | undefined): string[] | undefined {
  let listed: unknown
  try {
    listed = JSON.parse(rules)
  } catch {
    return undefined
  }
  if (!Array.isArray(listed)) return undefined
  const out: string[] = []
  for (const rule of listed) {
    // Every rule GitHub lists names its type: a row that is not an object, or has no type, is malformed (gate R1-7).
    if (typeof rule !== 'object' || rule === null || typeof (rule as { type?: unknown }).type !== 'string') return undefined
    const row = rule as Record<string, unknown>
    if (row.type !== 'required_status_checks') continue
    // A required-checks rule without its list, or with an entry that names no check, is a malformed payload, not an empty policy (gate R1-7).
    const params = (typeof row.parameters === 'object' && row.parameters !== null ? row.parameters : {}) as { required_status_checks?: unknown }
    if (!Array.isArray(params.required_status_checks)) return undefined
    for (const one of params.required_status_checks as unknown[]) {
      const context = typeof one === 'object' && one !== null ? (one as { context?: unknown }).context : undefined
      if (typeof context !== 'string') return undefined
      out.push(context)
    }
  }
  if (protection !== undefined) {
    let read: unknown
    try {
      read = JSON.parse(protection)
    } catch {
      // Rulesets and classic protection apply together: half a set is not the set (PR #19 review).
      return undefined
    }
    // Classic protection always lists contexts and checks: a body with neither (an error message) is not the set (gate R1-7).
    const body = (typeof read === 'object' && read !== null ? read : {}) as { contexts?: unknown; checks?: unknown }
    if (!Array.isArray(body.contexts) && !Array.isArray(body.checks)) return undefined
    // A field that is there but not a list is malformed too, even beside a valid one (gate R1-7, R5-4).
    if ((body.contexts !== undefined && !Array.isArray(body.contexts)) || (body.checks !== undefined && !Array.isArray(body.checks))) return undefined
    // An entry that names no check is malformed, as in a ruleset (gate R5-4).
    for (const one of Array.isArray(body.contexts) ? (body.contexts as unknown[]) : []) {
      if (typeof one !== 'string') return undefined
      out.push(one)
    }
    for (const one of Array.isArray(body.checks) ? (body.checks as unknown[]) : []) {
      const context = typeof one === 'object' && one !== null ? (one as { context?: unknown }).context : undefined
      if (typeof context !== 'string') return undefined
      out.push(context)
    }
  }
  return [...new Set(out)]
}
