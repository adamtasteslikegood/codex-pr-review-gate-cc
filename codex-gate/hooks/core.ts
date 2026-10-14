// The gate's pure half: reading what the agents answered, sizing a change,
// reading a `gh pr create`, and the words each agent is sent. No `$` here.

import type { Effort, Finding, Role, Run, Severity, Tier } from '../types'

export const TRAILER = 'CODEX_GATE_RESULT'

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2', 'P3']

export const isBlocking = (finding: Pick<Finding, 'severity'>): boolean =>
  finding.severity === 'P0' || finding.severity === 'P1'

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
  findings: Omit<Finding, 'id' | 'round' | 'source' | 'status'>[]
  note?: string
  failure?: ReviewFailure
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
    if (said === 'PASS' || said === 'UNVERIFIED') return { gate: said, findings: [] }
    const note =
      said === 'FAIL' ? 'The reviewer reported GATE: FAIL without listing its findings.' : 'The reviewer ended without a verdict.'
    return { gate: 'ERROR', findings: [], note, failure: failureOf(undefined, answer) }
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
  if (gate !== 'PASS' && gate !== 'FAIL' && gate !== 'UNVERIFIED') {
    return { gate: 'ERROR', findings, note: note ?? 'The review did not complete.', failure: failureOf(trailer.error, note ?? answer) }
  }
  const hasBlocking = findings.some(isBlocking)
  if (gate === 'FAIL' && !hasBlocking) {
    return {
      gate: 'ERROR',
      findings,
      note: note ?? 'FAIL with no P0/P1 finding listed: the review did not complete.',
      failure: 'other',
    }
  }
  // A blocking finding outranks whatever word the agent put on the gate.
  return { gate: hasBlocking ? 'FAIL' : gate, findings, note }
}

export type Disposition = { id: string; action: 'fixed' | 'rebutted' | 'deferred'; note?: string }

/** What the fixer said it did with each finding; empty when it said nothing. */
export function readDispositions(answer: string): Disposition[] {
  const listed = readTrailer(answer)?.dispositions
  if (!Array.isArray(listed)) return []
  const out: Disposition[] = []
  for (const one of listed) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const id = text(row.id)
    const action = String(row.action ?? '').toLowerCase()
    if (id === undefined) continue
    if (action !== 'fixed' && action !== 'rebutted' && action !== 'deferred') continue
    out.push({ id, action, note: text(row.note)?.slice(0, 2000) })
  }
  return out
}

/** The fix reviewer's verdict; an unreadable one counts as fine (Codex decides next). */
export function readVerify(answer: string): { isOk: boolean; notes?: string } {
  const trailer = readTrailer(answer)
  if (trailer === undefined) return { isOk: true }
  return { isOk: trailer.ok !== false, notes: text(trailer.notes)?.slice(0, 4000) }
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

// ------------------------------------------------------------ gh pr create

export type PrCreate = { base: string | undefined; cwd: string | undefined; repo: string | undefined }

/** Reads a shell command for `gh pr create`: its base, the directory it first enters, its `--repo`. */
export function readPrCreate(command: string): PrCreate | undefined {
  if (!/\bgh\s+pr\s+create\b/.test(command)) return undefined
  const flag = (names: string): string | undefined =>
    command.match(new RegExp(`(?:^|\\s)(?:${names})(?:=|\\s+)["']?([^\\s"']+)`))?.[1]
  return {
    base: flag('--base|-B'),
    repo: flag('--repo|-R'),
    cwd: command.match(/(?:^|&&|;)\s*cd\s+["']?([^\s"';&]+)/)?.[1],
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
      const note = one.note === undefined ? '' : `\n    ${one.status}${one.note === '' ? '' : `: ${one.note}`}`
      return `- ${one.id} [${one.severity}] ${one.title}${at}${detail}${note}`
    })
    .join('\n')

export function reviewPrompt(run: Run, role: 'review' | 'challenge'): string {
  // A run started before effort was tracked (a reload mid-run) keeps the old ceiling.
  run = { ...run, effort: (run.effort as Effort | undefined) ?? 'high' }
  const rebutted = run.findings.filter(one => one.round === run.round - 1 && one.status === 'rebutted')
  const mode =
    role === 'review'
      ? 'Review mode (Step 2A), including the gate verdict it computes'
      : 'Challenge mode (Step 2B)'
  const lines = [
    `You are the Codex ${role} step of codex-gate, a pre-PR gate. Round ${run.round}.`,
    where(run),
    '',
    `1. Invoke the Skill tool with skill "codex" and args "${role} --effort ${run.effort}", and follow that skill's instructions exactly as written: its preamble, its probes, and its ${mode}.`,
    `   The base branch is origin/${run.base}: use it wherever the skill says <base>, whatever its own base detection prints.`,
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
  if (rebutted.length > 0 && role === 'review') {
    lines.push(
      '',
      'The fixer rebutted these findings from the previous round instead of changing code:',
      listFindings(rebutted),
      "After the review, put each rebuttal to Codex through the same skill's consult mode (one prompt listing them all): does Codex concede it, or hold the finding? Report every finding Codex holds, with its original severity, even when the fresh review did not raise it again. Leave out the ones Codex concedes.",
    )
  }
  lines.push(
    '',
    trailerRule(
      stepOf(run, role),
      '{"gate":"PASS|FAIL|UNVERIFIED|ERROR","findings":[{"severity":"P1","title":"...","file":"path","line":1,"detail":"one or two sentences"}],"error":"only with ERROR: timeout|other","note":"optional"}',
    ),
  )
  return lines.join('\n')
}

/** The advisory round's words: no high/critical finding is left, and Codex's other findings are put to the fixer. */
function advisoryPrompt(run: Run, isMain: boolean): string {
  const advisory = run.findings.filter(one => one.round === run.round && !isBlocking(one))
  const lines = [
    `codex-gate, advisory round ${run.advisoryRound} of ${run.advisoryMax}: Codex left no high/critical finding on ${run.branch} against origin/${run.base}, and raised ${advisory.length} advisory finding${advisory.length === 1 ? '' : 's'} (P2/P3). They do not block the PR; address each one before it opens.`,
    where(run),
    '',
    'Advisory (P2/P3):',
    listFindings(advisory),
    '',
    'What to do:',
    '1. Invoke the superpowers:receiving-code-review skill first, if it is available. Verify every finding against the code before acting on it.',
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
  const current = run.findings.filter(one => one.round === run.round)
  const blocking = current.filter(isBlocking)
  const advisory = current.filter(one => !isBlocking(one))
  const lines = [
    `codex-gate, round ${run.round}: Codex found ${blocking.length} high/critical finding${blocking.length === 1 ? '' : 's'} on ${run.branch} against origin/${run.base}. The PR stays unopened until they are settled.`,
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

export function verifyPrompt(run: Run, fromSha: string): string {
  const current = run.findings.filter(one => one.round === run.round && isBlocking(one))
  return [
    `You review a fix for codex-gate, a pre-PR gate. Round ${run.round}.`,
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

export function prPrompt(run: Run, hasConverged: boolean): string {
  const blocking = run.findings.filter(one => one.round === run.round && isBlocking(one)).length
  const total = run.findings.length
  const left = run.findings.filter(one => one.round === run.round && !isBlocking(one) && one.status !== 'fixed').length
  const advisory =
    run.advisoryRound === 0 ? '' : ` ${run.advisoryRound} advisory round${run.advisoryRound === 1 ? '' : 's'} run, ${left} advisory finding${left === 1 ? '' : 's'} not fixed.`
  const summary =
    run.tier === 'trivial'
      ? `codex-gate skipped Codex for ${run.branch}: ${run.tierWhy}.`
      : hasConverged
        ? `codex-gate passed for ${run.branch} at ${run.headSha.slice(0, 7)}: no high/critical finding left after ${run.round} round${run.round === 1 ? '' : 's'} (${total} finding${total === 1 ? '' : 's'} raised in all).${advisory}`
        : `codex-gate did not converge for ${run.branch}: ${blocking} high/critical finding${blocking === 1 ? '' : 's'} still open after ${run.round} rounds.`
  const lines = [
    summary,
    '',
    `Now open the pull request to ${run.base}, following this repository's own rules for one (its pre-PR checks and preflight, the title and body conventions, the push).`,
    'Add one line to the body under a "Pre-PR Codex gate" heading: the rounds run and the counts above.',
    `The gate's verdict is for commit ${run.headSha.slice(0, 7)}. A docs-only commit on top (a CHANGELOG line) still rides on it; any other new commit, or a rebase, holds the pull request until the gate has run again, so do not add one unless a check requires it.`,
  ]
  lines.push(
    '',
    hasConverged
      ? 'This gate is one early review, not the last one. Once the pull request is open, run the whole pull-request lifecycle as this repository does it: wait for every reviewer and every check, the ones that are not required included, read each review in full, and fix or answer what they raise. A clean gate is no reason to skip, shorten or dismiss any of them.'
      : 'The rounds ran out, so the review is not finished: it carries on in the pull request. Once it is open, run the whole pull-request lifecycle as this repository does it: wait for every reviewer and every check, the ones that are not required included, read each review in full, and keep fixing, starting with the findings still open below.',
  )
  if (run.findings.length > 0) {
    lines.push(
      '',
      'Everything Codex raised, and what became of each:',
      listFindings(run.findings.map(one => (one.note === undefined && one.status !== 'open' ? { ...one, note: '' } : one))),
      '',
      'Tell the user about these here in the conversation, the ones still open first, each with why it is open. The pull request gets the counts only: do not paste a finding into it.',
    )
  }
  if (!hasConverged) {
    lines.push('In the pull request say only that the gate did not converge, with the count.')
  }
  return lines.join('\n')
}
