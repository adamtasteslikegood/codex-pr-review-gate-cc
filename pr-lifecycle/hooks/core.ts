// pr-lifecycle's pure half: reading what the agents answered, sizing a change,
// reading a `gh pr create`, and the words each agent is sent. No `$` here.

import {
  isAcceptedRebuttal,
  isBlocking,
  isDisputed,
  mergeHolds,
  raisedIn,
  rejections,
  securityHolds,
  unresolvedBlockers,
  usedRounds,
  verificationOwed,
  waivedIds,
} from './lifecycle'
import type { Feedback } from './github'
import type { Answer, Next, TriageClass } from './lifecycle'
import type { Effort, Finding, LifecycleRecord, Role, Run, Severity, Tier } from '../types'

export const TRAILER = 'PR_GATE_RESULT'

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2', 'P3']

export { isBlocking } from './lifecycle'

// ---------------------------------------------------------------- answers

/** The JSON object an agent ended its answer with, after the trailer word. */
export function readTrailer(answer: string): Record<string, unknown> | undefined {
  const at = answer.lastIndexOf(TRAILER)
  if (at < 0) return undefined
  const tail = answer.slice(at + TRAILER.length)
  const open = tail.indexOf('{')
  const close = tail.lastIndexOf('}')
  if (open < 0 || close <= open) return undefined
  try {
    const parsed: unknown = JSON.parse(tail.slice(open, close + 1))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export type ReviewGate = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'ERROR'

/** Why a review did not complete; only a timeout is worth a rerun at lower effort. */
export type ReviewFailure = 'timeout' | 'other'

export type ReviewResult = {
  gate: ReviewGate
  findings: {
    severity: Severity
    title: string
    file?: string | undefined
    line?: number | undefined
    detail?: string | undefined
  }[]
  note?: string
  failure?: ReviewFailure
  /** Ids of reported-fixed findings the reviewer confirmed. */
  verified: string[]
  /** Ids whose rebuttal or fix the reviewer did not accept. */
  held: string[]
}

const TIMEOUT_WORDS = /\btim(e|ed|ing)[\s-]?out\b|\bstall(ed)?\b|exit(ed)?( code)? 124\b/i

/** The failure kind a reviewer reported, or read from its note when it named none. */
function failureOf(said: unknown, note: string | undefined): ReviewFailure {
  const kind = String(said ?? '').toLowerCase()
  if (kind === 'timeout') return 'timeout'
  if (kind !== '') return 'other'
  return note !== undefined && TIMEOUT_WORDS.test(note) ? 'timeout' : 'other'
}

const EFFORTS: readonly Effort[] = ['high', 'medium', 'low']

/** One level below, or undefined at the bottom. */
export const stepDown = (effort: Effort): Effort | undefined => EFFORTS[EFFORTS.indexOf(effort) + 1]

/** The lower of two efforts. */
export const lowerOf = (a: Effort, b: Effort): Effort => (EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * A reviewer's answer as a gate verdict. Fails closed: an answer with no
 * readable verdict, or a FAIL that names no blocking finding, is an ERROR,
 * never a pass.
 */
export function readReview(answer: string): ReviewResult {
  const trailer = readTrailer(answer)
  if (trailer === undefined) {
    const said = answer.match(/\bGATE:\s*(PASS|FAIL|UNVERIFIED)\b/)?.[1]
    if (said === 'PASS' || said === 'UNVERIFIED') return { gate: said, findings: [], verified: [], held: [] }
    const note =
      said === 'FAIL' ? 'The reviewer reported GATE: FAIL without listing its findings.' : 'The reviewer ended without a verdict.'
    return { gate: 'ERROR', findings: [], note, failure: failureOf(undefined, answer), verified: [], held: [] }
  }
  const gate = String(trailer.gate ?? '').toUpperCase()
  const listed = Array.isArray(trailer.findings) ? trailer.findings : []
  const findings: ReviewResult['findings'] = []
  for (const one of listed) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const severity = String(row.severity ?? '').toUpperCase() as Severity
    const title = text(row.title)
    if (!SEVERITIES.includes(severity) || title === undefined) continue
    findings.push({
      severity,
      title: title.slice(0, 300),
      file: text(row.file),
      line: typeof row.line === 'number' ? row.line : undefined,
      detail: text(row.detail)?.slice(0, 4000),
    })
  }
  const note = text(trailer.note)
  const idList = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter((one): one is string => one !== undefined) : [])
  const verified = idList(trailer.verified)
  const held = idList(trailer.held)
  if (gate !== 'PASS' && gate !== 'FAIL' && gate !== 'UNVERIFIED') {
    return { gate: 'ERROR', findings, note: note ?? 'The review did not complete.', failure: failureOf(trailer.error, note ?? answer), verified, held }
  }
  const hasBlocking = findings.some(isBlocking)
  if (gate === 'FAIL' && !hasBlocking) {
    return {
      gate: 'ERROR',
      findings,
      note: note ?? 'FAIL with no P0/P1 finding listed: the review did not complete.',
      failure: 'other',
      verified,
      held,
    }
  }
  // A blocking finding outranks whatever word the agent put on the gate.
  return { gate: hasBlocking ? 'FAIL' : gate, findings, note, verified, held }
}

export type TriageAnswer = Answer & { replyId?: string; duplicateOf?: string }

/** What the fixer said it did with each finding, as the fix and triage steps both report it; empty when it said nothing. */
export function readTriage(answer: string): TriageAnswer[] {
  const listed = readTrailer(answer)?.dispositions
  if (!Array.isArray(listed)) return []
  const out: TriageAnswer[] = []
  for (const one of listed) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const id = text(row.id)
    const action = String(row.action ?? '').toLowerCase()
    if (id === undefined || (action !== 'fixed' && action !== 'rebutted' && action !== 'deferred')) continue
    const severity = String(row.severity ?? '').toUpperCase() as Severity
    const replyId =
      typeof row.replyId === 'string' ? text(row.replyId) : typeof row.replyId === 'number' && Number.isFinite(row.replyId) ? String(row.replyId) : undefined
    out.push({
      id,
      action,
      ...(text(row.note) === undefined ? {} : { note: text(row.note)?.slice(0, 2000) }),
      ...(text(row.evidence) === undefined ? {} : { evidence: text(row.evidence)?.slice(0, 2000) }),
      ...(SEVERITIES.includes(severity) ? { severity } : {}),
      ...(typeof row.isSecurity === 'boolean' ? { isSecurity: row.isSecurity } : {}),
      ...(replyId === undefined ? {} : { replyId }),
      ...(text(row.duplicateOf) === undefined ? {} : { duplicateOf: text(row.duplicateOf) }),
    })
  }
  return out
}

/** What the fixer said it did with each finding. */
export const readDispositions = (answer: string): Answer[] => readTriage(answer)

/** The fix reviewer's verdict; an unreadable one counts as fine (Codex decides next). */
export function readVerify(answer: string): { isOk: boolean; notes?: string } {
  const trailer = readTrailer(answer)
  if (trailer === undefined) return { isOk: true }
  return { isOk: trailer.ok !== false, notes: text(trailer.notes)?.slice(0, 4000) }
}

export type Verdict = { holds: boolean; note?: string }

/**
 * Codex's rebuttal check, one verdict per finding id (R41). An entry without an id or a boolean `holds` is dropped, so that id
 * stays unruled. A note that repeats the id in front ("G2-1: ...") is stored without it (R44).
 */
export function readVerdicts(answer: string): Map<string, Verdict> {
  const out = new Map<string, Verdict>()
  const listed = readTrailer(answer)?.verdicts
  if (!Array.isArray(listed)) return out
  for (const one of listed) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const id = text(row.id)
    if (id === undefined || typeof row.holds !== 'boolean' || out.has(id)) continue
    const raw = text(row.note)
    const note = text(raw?.startsWith(id) === true && /^\s*:/.test(raw.slice(id.length)) ? raw.slice(id.length).replace(/^\s*:\s*/, '') : raw)
    out.set(id, { holds: row.holds, ...(note === undefined ? {} : { note: note.slice(0, 2000) }) })
  }
  return out
}

// ------------------------------------------------------------ blast radius

const DOCS = /(\.(md|mdx|txt|rst)$)|(^|\/)(docs?|specs)\/|(^|\/)(LICENSE|CHANGELOG)[^/]*$/i

export type Scope = { tier: Tier; why: string }

/** Sizes a change from its file list and line count: what the rounds cost follows from it. */
export function classify(
  files: readonly string[],
  changedLines: number,
  highRisk: RegExp | undefined,
  /** Files whose change was reviewed elsewhere: a landed submodule pointer, a version-only bump. */
  settled: readonly string[] = [],
): Scope {
  if (files.length === 0) return { tier: 'trivial', why: 'no changes against the base' }
  const rest = files.filter(file => !settled.includes(file))
  if (rest.every(file => DOCS.test(file))) {
    if (rest.length === files.length) {
      return { tier: 'trivial', why: `docs only (${files.length} file${files.length === 1 ? '' : 's'})` }
    }
    const docs = rest.length === 0 ? '' : ` and ${rest.length} doc${rest.length === 1 ? '' : 's'}`
    return { tier: 'trivial', why: `already reviewed: ${files.filter(file => settled.includes(file)).join(', ')}${docs}` }
  }
  const risky = highRisk === undefined ? [] : rest.filter(file => highRisk.test(file))
  if (risky.length > 0) {
    const more = risky.length > 3 ? ` +${risky.length - 3}` : ''
    return { tier: 'high', why: `touches ${risky.slice(0, 3).join(', ')}${more}` }
  }
  if (changedLines > 400 || files.length > 25) {
    return { tier: 'high', why: `${changedLines} lines across ${files.length} file${files.length === 1 ? '' : 's'}` }
  }
  return { tier: 'standard', why: `${changedLines} lines across ${files.length} file${files.length === 1 ? '' : 's'}` }
}

/** Submodule pointers a `git diff --raw` changes: path and the commit it now points at. */
export function readGitlinks(raw: string): { path: string; sha: string }[] {
  const out: { path: string; sha: string }[] = []
  for (const line of raw.split('\n')) {
    const row = line.match(/^:\d+ 160000 [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\t(.+)$/)
    if (row?.[1] !== undefined && row[2] !== undefined && !/^0+$/.test(row[1])) out.push({ path: row[2], sha: row[1] })
  }
  return out
}

/** Whether a `git diff -U0` changes only `"version"` lines: a release bump of package.json and its lock. */
export function isVersionOnly(diff: string): boolean {
  const changed = diff.split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line))
  return changed.length > 0 && changed.every(line => /^[+-]\s*"version":\s*"[^"]*",?\s*$/.test(line))
}

export function compileRisk(source: string): RegExp | undefined {
  if (source.trim() === '') return undefined
  try {
    return new RegExp(source, 'i')
  } catch {
    return undefined
  }
}

/** `owner/repo` from a remote URL or a `--repo` value, lowercased. */
export function slugOf(remote: string): string | undefined {
  return remote
    .trim()
    .match(/(?:^|[:/])([^/:\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1]
    ?.toLowerCase()
}

// ------------------------------------------------------------------ words

export function activityOf(role: Role, tool: string, input: Record<string, unknown>): string {
  const who =
    role === 'review' || role === 'challenge' ? 'codex reviewer' : role === 'verify' ? 'fix reviewer' : 'fixer'
  const command = typeof input.command === 'string' ? input.command : ''
  if (tool === 'Bash' && /\bcodex\s+(review|exec)\b/.test(command)) {
    return role === 'challenge' ? 'codex is attacking the diff…' : 'codex is reviewing the diff…'
  }
  if (tool === 'Skill') return `${who}: loading /${String(input.skill ?? 'skill')}`
  const what =
    tool === 'Bash'
      ? command.replace(/\s+/g, ' ').slice(0, 60)
      : String(input.file_path ?? input.pattern ?? input.description ?? '').slice(-60)
  return `${who}: ${tool}${what === '' ? '' : ` ${what}`}`
}

const where = (run: Run): string =>
  `Repository: ${run.root}\nBranch: ${run.branch}\nBase: origin/${run.base} (already fetched)\nHEAD: ${run.headSha}`

/** A step's name: what its agent repeats in its trailer, so its answer is known for this step's. */
export const stepOf = (run: Pick<Run, 'round'>, role: Role): string => `r${run.round}-${role}`

const trailerRule = (step: string, shape: string): string =>
  `End your final message with the word ${TRAILER} on its own line, followed by one JSON object and nothing after it. Copy "step" exactly:\n${TRAILER}\n{"step":"${step}",${shape.slice(1)}`

const listFindings = (findings: readonly Finding[]): string =>
  findings
    .map(one => {
      const at = one.file === undefined ? '' : ` (${one.file}${one.line === undefined ? '' : `:${one.line}`})`
      const detail = one.detail === undefined ? '' : `\n    ${one.detail.replace(/\n/g, '\n    ')}`
      const said = one.status === 'reported-fixed' ? 'reported-fixed, verification owed' : one.status
      const note = one.status === 'open' && one.note === undefined ? '' : `\n    ${said}${one.note === undefined || one.note === '' ? '' : `: ${one.note}`}`
      const recheck = one.needsRecheck === true ? ' (file changed since: re-verify)' : ''
      return `- ${one.id} [${one.severity}] ${one.title}${at}${recheck}${detail}${note}`
    })
    .join('\n')

export const listFindingsOf = listFindings

/** Earlier findings that still apply to the files under review, so a round checks their answers instead of re-arguing them. */
export function priorRounds(findings: readonly Finding[], files?: ReadonlySet<string>): string {
  const applies = findings.filter(
    one =>
      one.status !== 'open' &&
      one.status !== 'verified-fixed' &&
      !isAcceptedRebuttal(one) &&
      (files === undefined || one.file === undefined || files.has(one.file)),
  )
  const recheck = findings.filter(one => one.needsRecheck === true && !applies.includes(one))
  const all = [...applies, ...recheck]
  return all.length === 0 ? '' : listFindings(all)
}

export function reviewPrompt(run: Run, role: 'review' | 'challenge', prior: readonly Finding[]): string {
  // A run started before effort was tracked (a reload mid-run) keeps the old ceiling.
  run = { ...run, effort: (run.effort as Effort | undefined) ?? 'high' }
  const mode =
    role === 'review'
      ? 'Review mode (Step 2A), including the gate verdict it computes'
      : 'Challenge mode (Step 2B)'
  const lines = [
    `You are the Codex ${role} step of /pr-gate (pr-lifecycle). Round ${run.round}, ${run.lifecycle === 'pre' ? 'before the pull request opens' : 'after it opened'}.`,
    where(run),
    '',
    `1. Invoke the Skill tool with skill "codex" and args "${role} --effort ${run.effort}", and follow that skill's instructions exactly as written: its preamble, its probes, and its ${mode}.`,
    `   The base is ${run.diffBase}: use it wherever the skill says <base>, whatever its own base detection prints.`,
    `   Reasoning effort is ${run.effort} for every Codex dispatch in this step, consult included. Never pass --xhigh or a higher --effort, and prefix each Codex dispatch with GSTACK_CODEX_EFFORT=${run.effort} so no setting raises it: higher efforts time out here.`,
    '2. You are read-only. Do not edit files, do not fix anything, do not commit, push or open a pull request.',
    '3. Do not ask the user anything: nobody is watching this step. Where the skill would ask, take its documented default and say so.',
  ]
  if (role === 'review') {
    lines.push(
      "4. Report every finding Codex tagged [P0] to [P3], with Codex's own severity and title. Do not downgrade, merge or drop a finding.",
      "   gate is the skill's verdict: PASS, FAIL or UNVERIFIED. If Codex did not complete (non-zero exit, timeout, empty output, auth), gate is ERROR, error is timeout when Codex timed out or stalled and other otherwise, and note says why.",
    )
  } else {
    lines.push(
      '4. Challenge mode output carries no severity tags. Read the code for each problem Codex raised, then report it as P1 only when it is a concrete, reachable failure or security hole in code this branch changes; report the rest as P2. gate is FAIL when any P1 stands, else PASS. If Codex did not complete, gate is ERROR, and error is timeout when Codex timed out or stalled, other otherwise.',
    )
  }
  // After the PR opens, a dispute or a deferral is the person's (R40, R45): Codex is not asked about it again.
  const answered = priorRounds(run.lifecycle === 'post' ? prior.filter(one => !isDisputed(one) && one.status !== 'deferred') : prior)
  if (answered !== '' && role === 'review') {
    lines.push(
      '',
      'Earlier rounds on this branch settled these, with the evidence shown. Check the answers; do not re-derive them:',
      answered,
      "After the review, put every rebutted or reported-fixed one to Codex through the same skill's consult mode (one prompt listing them all). List the ids Codex confirms fixed under verified, and the ids whose rebuttal or fix Codex does not accept under held. Do not list a held one again under findings.",
    )
  }
  lines.push(
    '',
    trailerRule(
      stepOf(run, role),
      '{"gate":"PASS|FAIL|UNVERIFIED|ERROR","findings":[{"severity":"P1","title":"...","file":"path","line":1,"detail":"one or two sentences"}],"error":"only with ERROR: timeout|other","note":"optional","verified":["R1-1"],"held":["R1-2"]}',
    ),
  )
  return lines.join('\n')
}

/** The advisory round's words: no high/critical finding is left, and Codex's other findings are put to the fixer. */
function advisoryPrompt(run: Run, isMain: boolean): string {
  const advisory = run.findings.filter(one => raisedIn(one, run.round) && !isBlocking(one))
  const lines = [
    `pr-gate, round ${run.round}, advisories: Codex left no high/critical finding on ${run.branch} against origin/${run.base}, and raised ${advisory.length} advisory finding${advisory.length === 1 ? '' : 's'} (P2/P3). They do not block the PR; address each one before it opens.`,
    where(run),
    '',
    'Advisory (P2/P3):',
    listFindings(advisory),
    '',
    'What to do:',
    '1. Invoke the superpowers:receiving-code-review skill first, if it is available. Verify every finding against the code before acting on it.',
    '   A finding marked reported-fixed or rebutted in an earlier round is listed with that answer: do not answer it again unless its file changed.',
    '2. Give every finding one answer. Fix it when it is real and the fix is small and inside this branch. Rebut it with file:line evidence when it is wrong. Defer it, with the reason, when it is real but belongs in other work.',
    '3. Run the checks that cover what you touched, then commit your fixes on this branch. Codex reviews the new commits, so keep them small: a fix that adds a high/critical finding costs a blocking round.',
    '4. Do not push and do not open a pull request: the gate does that when the rounds are over.',
    '',
    trailerRule(
      stepOf(run, 'fix'),
      '{"dispositions":[{"id":"R1-1","action":"fixed|rebutted|deferred","note":"what changed, the evidence, or why it waits"}]}',
    ),
  ]
  if (isMain) {
    lines.push('', 'Then end your turn. The gate picks up from there: Codex looks again when you changed code or rebutted a finding, and the PR opens after that.')
  }
  return lines.join('\n')
}

export function fixPrompt(run: Run, notes: string | undefined, isMain: boolean): string {
  if (run.fixKind === 'advisory') return advisoryPrompt(run, isMain)
  const current = run.findings.filter(one => raisedIn(one, run.round))
  const blocking = current.filter(isBlocking)
  const advisory = current.filter(one => !isBlocking(one))
  const lines = [
    `pr-gate, round ${run.round}: Codex found ${blocking.length} high/critical finding${blocking.length === 1 ? '' : 's'} on ${run.branch} against origin/${run.base}. The PR stays unopened until they are settled.`,
    where(run),
    '',
    'Blocking (P0/P1):',
    listFindings(blocking),
  ]
  if (advisory.length > 0) {
    lines.push('', 'Advisory (P2/P3), fix only where it is cheap and in scope:', listFindings(advisory))
  }
  if (notes !== undefined) lines.push('', 'A reviewer of your previous fix says it is not done:', notes)
  lines.push(
    '',
    'What to do:',
    '1. Invoke the superpowers:receiving-code-review skill first, if it is available. Verify every finding against the code before acting on it.',
    '   A finding marked reported-fixed or rebutted in an earlier round is listed with that answer: do not answer it again unless its file changed.',
    '2. A real finding: fix it with the smallest change that settles it, with a test where one fits. A false positive: rebut it with file:line evidence, and change nothing for it.',
    "3. Weigh the blast radius. If the honest fix reaches past this branch's scope (a schema change, a public contract, another service), mark the finding deferred and say what decision it needs; do not widen the change on your own.",
    '4. Run the checks that cover what you touched, then commit your fixes on this branch. The next Codex round reads committed code only.',
    '5. Do not push and do not open a pull request: the gate does that when the rounds are over.',
    '',
    trailerRule(
      stepOf(run, 'fix'),
      '{"dispositions":[{"id":"R1-1","action":"fixed|rebutted|deferred","note":"what changed, or the evidence"}]}',
    ),
  )
  if (isMain) {
    lines.push('', 'Then end your turn. The gate picks up from there and starts the next Codex round by itself.')
  }
  return lines.join('\n')
}

export function verifyPrompt(run: Run, fromSha: string, rebuttals?: readonly Finding[]): string {
  if (rebuttals !== undefined) {
    return [
      `You check rebuttals for pr-gate's post-PR review. Round ${run.round}.`,
      where(run),
      '',
      'The main agent rebutted these findings instead of fixing them. After the PR opens, a rebuttal settles nothing until you accept it:',
      listFindings(rebuttals),
      '',
      'For each one: read the code at HEAD and decide whether the rebuttal holds. Give one verdict per finding id, each on its own:',
      'holds is true when the rebuttal holds, false when it does not, with a note saying why it fails. Leave out no id.',
      'You are read-only: do not edit, commit or push.',
      '',
      trailerRule(
        stepOf(run, 'verify'),
        `{"verdicts":[${rebuttals.map(one => `{"id":"${one.id}","holds":true|false,"note":"when holds is false: why"}`).join(',')}]}`,
      ),
    ].join('\n')
  }
  const current = run.findings.filter(one => raisedIn(one, run.round) && isBlocking(one))
  return [
    `You review a fix for pr-gate, a pre-PR gate. Round ${run.round}.`,
    where(run),
    '',
    `Codex raised these high/critical findings, and the fixer answered each (\`git diff ${fromSha}..HEAD\` is what it changed):`,
    listFindings(current),
    '',
    'For each one: does the committed code now settle it, or does the rebuttal hold against the code? Look for a fix that only moves the problem, a missing test, and anything the fix broke. You are read-only: do not edit, commit or push.',
    '',
    trailerRule(stepOf(run, 'verify'), '{"ok":true,"notes":"when ok is false: what is still wrong, by finding id"}'),
  ].join('\n')
}

export function triagePrompt(
  run: Run,
  rec: LifecycleRecord,
  items: readonly { feedback: Feedback; cls: TriageClass; matchId?: string; findingId: string }[],
  others: readonly string[],
  more: { carried?: readonly Finding[]; codex?: readonly Finding[]; codexRange?: string; intro?: string; carriedHeading?: string } = {},
): string {
  const cls = { duplicate: 'duplicate of an answered finding', 'new-on-reviewed': 'new claim about code already reviewed', 'new-on-changed': 'about code changed since the last review' } as const
  const lines = [
    `pr-gate, post-PR round ${run.round} (${run.roundKind}) for PR #${rec.pr} on ${rec.branch} → ${rec.base}, head ${run.roundStartHead.slice(0, 7)}.`,
    where(run),
    '',
  ]
  if (others.length > 0) {
    lines.push(
      `Commits on the PR since ${rec.head.slice(0, 7)}, not yet reviewed: ${others.join(', ')}.`,
      'Pull them (git pull --ff-only), read each, and verify it like a review finding before anything else.',
      '',
    )
  }
  if (more.intro !== undefined) lines.push(more.intro, '')
  if (items.length > 0) lines.push('New review feedback:')
  for (const one of items) {
    const at = one.feedback.file === undefined ? '' : ` (${one.feedback.file}${one.feedback.line === undefined ? '' : `:${one.feedback.line}`})`
    const earlier = one.matchId === undefined ? '' : `\n    earlier answer: ${listFindings(rec.findings.filter(each => each.id === one.matchId)).replace(/\n/g, '\n    ')}`
    const replied = rec.replies[one.feedback.id]
    const where = one.feedback.kind === 'inline' ? `thread ${one.feedback.threadId}` : 'the PR conversation'
    const reply = replied === undefined ? `reply to ${where}` : `you replied (${replied}) in ${where}: if your reply there does not address this comment, reply`
    const body = one.feedback.body.slice(0, 1500).replace(/\n/g, '\n    ')
    lines.push(`- ${one.findingId} from ${one.feedback.reviewer}${at}, ${cls[one.cls]}; ${reply}:\n    ${body}${earlier}`)
  }
  if ((more.codex ?? []).length > 0) lines.push('', `Codex reviewed ${more.codexRange ?? 'the round'} and raised:`, listFindings(more.codex ?? []))
  if ((more.carried ?? []).length > 0) {
    const heading = more.carriedHeading ?? 'Carried from earlier rounds, still open (fix or rebut each; it blocks the merge):'
    lines.push('', heading, listFindings(more.carried ?? []))
    // Reviewer feedback among them is answered in its own thread.
    const threads = (more.carried ?? []).filter(one => one.source === 'github' && one.externalId !== undefined)
    if (threads.length > 0) {
      const at = (one: Finding): string => {
        const thread = one.threadId ?? one.externalId?.slice('inline:'.length)
        const where = one.externalId?.startsWith('inline:') === true ? `thread ${thread}` : 'the PR conversation'
        const replied = rec.replies[one.externalId ?? '']
        return replied === undefined ? `${one.id} in ${where}` : `${one.id} in ${where} (you replied ${replied}: if it does not address this comment, reply)`
      }
      lines.push(`Where to reply: ${threads.map(at).join('; ')}.`)
    }
  }
  // After one rejection a finding is fixed or deferred (R40): a second rebuttal goes to the person, not to Codex.
  const rejected = [...(more.carried ?? []), ...(more.codex ?? [])].filter(one => one.status === 'open' && rejections(one) > 0)
  if (rejected.length > 0) {
    const which = rejected.map(one => one.id).join(', ')
    lines.push(
      '',
      `Codex did not accept your rebuttal of ${which}: fix it or defer it with the reason.`,
      'Do not rebut it again: a second rebuttal is not sent to Codex, it goes to the person as a dispute.',
    )
  }
  const owed = rec.findings.filter(one => isBlocking(one) && one.status === 'reported-fixed')
  if (owed.length > 0) lines.push('', 'Reported fixed, verification still owed:', listFindings(owed))
  // Replied feedback by its finding id (M4), not the internal key.
  const already = Object.keys(rec.replies).map(key => rec.findings.find(one => one.externalId === key)?.id ?? key)
  lines.push(
    '',
    'What to do:',
    '1. Invoke the superpowers:receiving-code-review skill first, if it is available. Verify every claim against the current code before changing anything.',
    '2. Give each item one answer: fix it (smallest change, with a test where one fits), rebut it with file:line, test or requirement evidence, or defer it with the reason. A duplicate gets a reply pointing to the earlier answer, not a new argument.',
    ...(items.some(one => one.cls === 'new-on-reviewed') ? ['   An earlier review is not a reason to rebut a new claim: answer it on its merits.'] : []),
    "3. Give each item a severity (P0–P3), keeping the reviewer's own where it gave one, and say whether it is a security issue.",
    `4. Reply where the feedback was given: an inline comment in its thread (gh api repos/${rec.slug}/pulls/${rec.pr}/comments/<threadId>/replies -f body=...), anything else as a PR comment (gh pr comment ${rec.pr}). Put the reply id in replyId.${already.length > 0 ? ` Already replied to: ${already.join(', ')}; do not reply to those again.` : ''}`,
    '   Before posting, check the thread for a reply of yours already there: never post a second one.',
    '5. Run the checks that cover what you touched, commit, and push to the PR branch.',
    '',
    trailerRule(
      stepOf(run, 'triage'),
      '{"dispositions":[{"id":"G1-1","action":"fixed|rebutted|deferred","severity":"P1","isSecurity":false,"note":"what changed, or the evidence","replyId":"123","duplicateOf":"R1-1 when it is one"}]}',
    ),
    '',
    'Then end your turn. /pr-gate collects the next reviews by itself.',
  )
  return lines.join('\n')
}

/** `waivedNote`: the person's finding waiver that let a held gate pass, said in place of a clean pass. */
export function prPrompt(run: Run, rec: LifecycleRecord, status: 'passed' | 'exhausted' | 'waived', waivedNote?: string): string {
  const hasConverged = status !== 'exhausted'
  const blocking = unresolvedBlockers(rec).length
  const total = rec.findings.length
  const left = rec.findings.filter(one => !isBlocking(one) && one.status !== 'verified-fixed' && !isAcceptedRebuttal(one)).length
  const budget = `${usedRounds(rec)} of ${rec.allowance} review rounds used`
  const advisory = left === 0 ? '' : ` ${left} advisory finding${left === 1 ? '' : 's'} not fixed.`
  const summary =
    status === 'waived'
      ? `pr-gate was waived for ${run.branch} at ${run.headSha.slice(0, 7)}.`
      : run.tier === 'trivial'
        ? `pr-gate skipped Codex for ${run.branch}: ${run.tierWhy}.`
        : waivedNote !== undefined && status === 'passed'
          ? `pr-gate let ${run.branch} through at ${run.headSha.slice(0, 7)}: ${waivedNote} ` +
            `(${budget}; ${total} finding${total === 1 ? '' : 's'} raised in all).${advisory}`
          : hasConverged
            ? `pr-gate passed for ${run.branch} at ${run.headSha.slice(0, 7)}: no high/critical finding left after ${run.round} round${run.round === 1 ? '' : 's'} (${budget}; ${total} finding${total === 1 ? '' : 's'} raised in all).${advisory}`
            : `pr-gate did not converge for ${run.branch}: ${blocking} high/critical finding${blocking === 1 ? '' : 's'} still open after ${run.round} rounds (${budget}).`
  const lines = [
    summary,
    '',
    `Now open the pull request to ${run.base}, following this repository's own rules for one (its pre-PR checks and preflight, the title and body conventions, the push).`,
    `Add one line to the body under a "Pre-PR Codex gate" heading: the rounds run and the counts above.`,
    `The gate's verdict is for commit ${run.headSha.slice(0, 7)}. A docs-only commit on top (a CHANGELOG line) still rides on it; any other new commit, or a rebase, holds the pull request until the gate has run again, so do not add one unless a check requires it.`,
    '',
    "/pr-gate stays with this pull request: once it is open it collects the repository's reviews itself and sends you what needs an answer. Do not wait or poll for reviewers yourself, and do not merge: merging is held until the lifecycle review is complete.",
  ]
  if (run.findings.length > 0) {
    lines.push(
      '',
      'Everything Codex raised, and what became of each:',
      listFindings(run.findings.map(one => (one.note === undefined && one.status !== 'open' ? { ...one, note: '' } : one))),
      '',
      'Tell the user about these here in the conversation, the ones still open first, each with why it is open. The pull request gets the counts only: do not paste a finding into it.',
    )
  }
  if (status === 'exhausted') {
    lines.push('In the pull request say only that the gate did not converge, with the count.')
  }
  return lines.join('\n')
}

export function readyPrompt(rec: LifecycleRecord): string {
  const done = rec.rounds.filter(one => one.isCompleted)
  const pre = done.filter(one => one.phase === 'pre').length
  const post = done.filter(one => one.phase === 'post').length
  const count = (status: Finding['status']): number => rec.findings.filter(one => one.status === status).length
  const deferred = rec.findings.filter(one => one.status === 'deferred')
  const summary = [
    `${pre} pre-PR and ${post} post-PR round${pre + post === 1 ? '' : 's'}`,
    `${rec.findings.length} finding${rec.findings.length === 1 ? '' : 's'} (${count('verified-fixed')} verified fixed, ${count('rebutted')} rebutted, ${count('deferred')} deferred, ${count('open') + count('reported-fixed')} open)`,
    deferred.length === 0 ? 'no deferrals' : `deferred: ${deferred.map(one => `${one.id} ${one.title}`).join('; ')}`,
  ].join('; ')
  return `pr-gate: the lifecycle review of PR #${rec.pr} is complete at ${rec.head.slice(0, 7)}: ${summary}. It is ready for the merge decision, which is the person's: tell them, and do not merge unless they ask.`
}

/**
 * The person's options after the PR opened: the waiver of each deferral or dispute (M1, R40), and `waive post`.
 * One more review round is offered only where a round could help (not when the person is only asked to decide, R42).
 */
const personPost = (rec: Pick<LifecycleRecord, 'findings' | 'waivers'>, withRound = true): string => {
  const theirs = mergeHolds(rec).filter(one => one.status === 'deferred' || isDisputed(one))
  const waive = theirs.map(one => `/pr-gate waive ${one.id} <reason> lets the ${one.status === 'deferred' ? 'deferred' : 'disputed'} ${one.id} into the merge`)
  // A security P1 is released only by a waiver naming it (spec §3): waive post covers the rest once it is.
  const security = securityHolds(rec).map(one => one.id)
  const post =
    security.length === 0
      ? '/pr-gate waive post <reason> lets this head merge without the review'
      : `/pr-gate waive post <reason> lets this head merge without the review once the security P1 ${security.join(', ')} is waived by name`
  const options = withRound ? [post, ...waive, '/pr-gate allow 1 <reason> grants one more review round'] : [...waive, post]
  return `Their options: ${options.slice(0, -1).join(', ')}${options.length > 1 ? ', and ' : ''}${options.at(-1)}.`
}

/**
 * Post-PR review stopped short of ready: why, what holds the merge, and the agent's next step. The person is named, with their
 * options, only where the decision is theirs: awaiting-decision, exhaustion, a deferred security P1. An answerable block gives
 * the agent's step alone.
 */
export function reportPrompt(rec: LifecycleRecord, next: Exclude<Next, { kind: 'round' | 'open-pr' | 'ready' }>): string {
  // Every finding that holds the merge, at any severity (R39): the same list the merge guard names.
  const holding = mergeHolds(rec)
  const lines = [`pr-gate: the post-PR review of PR #${rec.pr} stopped short of ready at ${rec.head.slice(0, 7)}: ${next.why}.`]
  if (holding.length > 0) lines.push('', 'What holds the merge, with the evidence so far:', listFindings(holding))
  lines.push('', `Your next step: ${next.nextStep}.`)
  if (next.kind === 'awaiting-decision') {
    // The person decides (R42): nothing for the agent to change, only to say and stop.
    lines.push(
      'Do not merge, and do not merge another way: only the person can release these findings.',
      `Tell the person what is deferred or disputed and why. ${personPost(rec, false)}`,
    )
    return lines.join('\n')
  }
  lines.push(
    'Verify each finding against the code first: fix a real one with the smallest change, commit and push it,',
    'or rebut a false one with file:line evidence in its thread (one Codex already rejected a rebuttal of is fixed or deferred).',
  )
  const isSecurityHold = holding.some(one => isBlocking(one) && one.isSecurity === true && one.status === 'deferred')
  if (next.kind === 'exhausted' || isSecurityHold) {
    lines.push(
      'Do not merge, and do not merge another way: the guard holds the merge until the review is complete or the person decides.',
      `Tell the person why it stopped. ${personPost(rec)}`,
    )
  } else {
    lines.push('Do not merge, and do not merge another way: the guard holds the merge until the review is complete.')
  }
  return lines.join('\n')
}

/** Before the PR: blockers unresolved or only reported fixed, and blockers deferred, unless the person waived them. */
const preHolds = (rec: LifecycleRecord): Finding[] => {
  const waived = waivedIds(rec)
  const deferred = rec.findings.filter(one => isBlocking(one) && one.status === 'deferred' && !waived.has(one.id))
  const held = [...unresolvedBlockers(rec), ...verificationOwed(rec)]
  return [...held, ...deferred.filter(one => !held.includes(one))]
}

/**
 * Before the PR, the person's options, only where the decision is theirs (R49): a deferred blocker, a security P1, or a spent
 * allowance that holds the PR. Each holding finding is released by a waiver naming it; only exhaustion offers a round.
 */
export function prePerson(rec: LifecycleRecord): string | undefined {
  const holding = preHolds(rec)
  const isTheirs = holding.some(one => one.status === 'deferred' || one.isSecurity === true)
  const isExhausted = rec.preStatus === 'exhausted'
  if (!isTheirs && !isExhausted) return undefined
  // Once the decision is theirs, every holding finding has its own waiver.
  const options = [
    ...holding.map(one => `/pr-gate waive ${one.id} <reason> releases ${one.id}`),
    ...(isExhausted && !holding.some(one => one.isSecurity === true)
      ? ["/pr-gate waive pre <reason> lets this commit's pull request through without the review"]
      : []),
    ...(isExhausted ? ['/pr-gate allow 1 <reason> grants one more review round'] : []),
  ]
  return `Their options: ${options.slice(0, -1).join(', ')}${options.length > 1 ? ', and ' : ''}${options.at(-1)}.`
}

/**
 * The gate holds the pull request (pre-PR) or its merge (post-PR): why, what holds it and the agent's next step. Before the PR the
 * person's options follow; after it, only where the decision is theirs (awaiting-decision, a deferred security P1, R46).
 */
export function heldPrompt(rec: LifecycleRecord, why: string, nextStep: string): string {
  if (rec.phase !== 'pre') {
    // After the PR opened: the merge is what is held, by every finding the merge guard names (R39, R46).
    const holds = mergeHolds(rec)
    const post = [`pr-gate: PR #${rec.pr} on ${rec.branch} → ${rec.base} is held from merging at ${rec.head.slice(0, 7)}: ${why}.`]
    if (holds.length > 0) post.push('', 'What holds it, with the evidence so far:', listFindings(holds))
    post.push('', `Your next step: ${nextStep}.`)
    // The person is named only for a decision of theirs, as in reportPrompt (R42): a check that could not run is the agent's to rerun.
    const isAwaiting = rec.postStatus === 'awaiting-decision'
    const isSecurityHold = holds.some(one => isBlocking(one) && one.isSecurity === true && one.status === 'deferred')
    if (isAwaiting || isSecurityHold) {
      post.push(
        'Do not merge, and do not merge another way: the guard holds the merge until the review is complete or the person decides.',
        `Tell the person why it is held. ${personPost(rec, !isAwaiting)}`,
      )
    } else {
      post.push('Do not merge, and do not merge another way: the guard holds the merge until the review is complete.')
    }
    return post.join('\n')
  }
  // Before the PR: what holds it, deferred blockers included, then the agent's step; the person only where the decision is theirs (R49).
  const holding = preHolds(rec)
  const lines = [`pr-gate: the pull request for ${rec.branch} → ${rec.base} is held at ${rec.head.slice(0, 7)}: ${why}.`]
  if (holding.length > 0) lines.push('', 'What holds it, with the evidence so far:', listFindings(holding))
  lines.push('', `Your next step: ${nextStep}.`)
  // The agent's own work only while a finding is open and a round can still check it: never once the allowance is spent.
  if (holding.some(one => one.status === 'open') && rec.preStatus !== 'exhausted') {
    lines.push(
      'Verify each finding against the code first: fix a real one with the smallest change and commit it, or rebut a false one with file:line evidence. ' +
        'Then run /pr-gate resume.',
    )
  }
  const person = prePerson(rec)
  if (person === undefined) {
    lines.push('Do not push for review and do not create the pull request another way: the guard holds it until the review passes.')
  } else {
    lines.push(
      'Do not push for review and do not create the pull request another way: the guard holds it until the review passes or the person decides.',
      `Tell the person why it is held. ${person}`,
    )
  }
  return lines.join('\n')
}
