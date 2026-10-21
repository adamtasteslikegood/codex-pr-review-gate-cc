# pr-lifecycle 1.4.0 (wave 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person's actions and the gate's holds stop costing extra turns. Every manual action messages the agent, one hold lists every blocker, `waive post` sets aside checks GitHub doesn't require, clear approvals settle on their own, and the finding 21 bug is fixed.

**Architecture:**
- Pure decisions live in `hooks/lifecycle.ts` (ledger, `standingOf`, `holdText`) and `hooks/github.ts` (parsers: approval classifier, severity labels, required checks).
- Async work lives in `hooks/round.ts`: reading checks, `gatherStanding`, `tellAgent`, the prompt queue.
- The command and the guards are in `hooks/register.tsx`.
- Everything is additive. Today's hold texts keep their first lines, and the full blocker list is appended, so the existing suite stays green except where behaviour deliberately changes.

**Tech Stack:**
- TypeScript 6.0.3, as a Claude Code plugin (`claude-code` engine API).
- Tests run through `claude plugin test` with the fakes in `pr-lifecycle/tests/world.ts`.
- ESLint with `@stylistic`.

**Spec:** `docs/superpowers/specs/2026-10-20-pr-lifecycle-wave2a-design.md`. Read it first, then `CLAUDE.md` (repo rules) and the rulings doc `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md` (R1-R78; this plan adds R79-R86).

## Global Constraints

- Work on branch `wave2a/pr-lifecycle-1.4.0`, made from `main` once PR #19 has merged, or from `docs/wave2` if it hasn't.
- Never touch `codex-gate/` (frozen at 0.3.1).
- Hand style: no semicolons, single quotes, lines up to about 160 columns. **Never run Prettier or `eslint --fix`**; edit surgically.
- Never commit `pr-lifecycle/.claude-plugin/types/` (generated, gitignored). `pr-lifecycle/types/index.d.ts` is tracked and is where the record types live.
- Don't use a bare `npx tsc`. Use `npm run typecheck` from the repo root.
- Do not run any Bash command whose text contains the literal PR-create command line. The loaded gate (1.3.0) refuses it even inside a grep or a string. Build such strings from pieces.
- Commit after each task. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1
  ```
- Run a single test file with `claude plugin test pr-lifecycle` (the whole suite is fast, about 415 tests). Before the last task, `npm run check` from the repo root must pass.
- Every refusal of a PR create or merge still starts with "pr-gate HOLD (not an error):" wherever it does today (R77). Prompts never start with `/` (R21).
- An agent prompt never gives the person's command as the agent's own step (R42, R49). The person's steps are only ever named as theirs.

## Review Focus

1. **An agent-run `/pr-gate stop`** (origin `sdk`) must not message the agent about itself, and must not be logged as the person's step. Test in Task 9.
2. **A review body that both approves and asks** ("LGTM. Should we also cover X?") must go to triage, never settle. Test in Task 1.
3. **Required checks that can't be read** (rules API error, garbage output): every check counts as required (fail closed), so a waiver can't set a failing check aside. Test in Task 6.
4. **An `acknowledged` answer on a P2-tagged or security finding, or without a `replyId`**, counts as unanswered and goes through the R34 reprompt. It never settles and never goes to Codex. Test in Task 3.
5. **A waiver note and a round prompt queued by the same command** are merged into one message for the same record only. A note about another branch's record stays separate. Test in Task 8.

---

### Task 1: Approval classifier and advisory labels (`github.ts`)

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts:95-111` (`readReviews`), `:208-216` (`severityHint`)
- Modify: `pr-lifecycle/hooks/round.ts` (`beginTriage`, around line 1176: log settled approvals)
- Modify: `pr-lifecycle/types/index.d.ts:134` (`LogEntry.kind` gains `'approval'`)
- Test: `pr-lifecycle/tests/github.test.ts`, `pr-lifecycle/tests/flow.test.ts` (append at the end)

**Interfaces:**
- Produces: `export function isNoAction(state: string | undefined, body: string): boolean` in `github.ts`.
- Produces: `severityHint(body)` now returns `{ severity: Severity; isSecurity: boolean; isTagged: boolean }`. `isTagged` is true when the reviewer's own words set the severity (an explicit `P0`-`P3`, or an advisory label).

- [ ] **Step 1: Write the failing unit tests** (append to `tests/github.test.ts`; add `isNoAction` to its import list from `'../hooks/github'`):

```ts
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
  expect(severityHint('**Nit**: rename this')).toMatchObject({ severity: 'P3', isTagged: true })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`
Expected: FAIL. `isNoAction` is not exported, and `severityHint` returns no `isTagged`.

- [ ] **Step 3: Implement in `github.ts`**

Replace `severityHint` (lines 208-216) with:

```ts
/** A reviewer's own advisory label, at the start of a line (a heading, a list item or the body itself), never inside a sentence. */
const ADVISORY = /^\s*(?:#+\s*|[-*+]\s+|\d+\.\s+)?[*_[(]*\s*(?:advisory|non-blocking|nit(?:pick)?|optional|follow-up)[*_\])]*\s*(?:[:,(—-]|$)/im

/** The reviewer's own severity, when it gave one; the main agent can still change a guessed one (R84). */
export function severityHint(body: string): { severity: Severity; isSecurity: boolean; isTagged: boolean } {
  const isSecurity = SECURITY.test(body)
  // The most severe explicit tag anywhere wins: one P1 in a list of advisories is a P1.
  const tags = [...body.matchAll(/\bP([0-3])\b/g)].map(one => Number(one[1]))
  if (tags.length > 0) return { severity: `P${Math.min(...tags)}` as Severity, isSecurity, isTagged: true }
  if (ADVISORY.test(body)) return { severity: 'P3', isSecurity, isTagged: true }
  if (/\b(critical|blocker|high)\b/i.test(body)) return { severity: 'P1', isSecurity, isTagged: false }
  // A security hint never drops below P2 unless the reviewer tagged a severity itself.
  if (/\b(nit|nitpick|typo|minor)\b/i.test(body)) return { severity: isSecurity ? 'P2' : 'P3', isSecurity, isTagged: false }
  return { severity: isSecurity ? 'P1' : 'P2', isSecurity, isTagged: false }
}

/** Whole sentences that settle a review (R83). */
const SETTLES = [
  /^no (?:actionable|blocking) (?:findings|issues|comments)(?: (?:in|for) this [\w\s/-]+)?$/i,
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
```

In `readReviews` (line 107) change `isFinding`:

```ts
      isFinding: row.state === 'CHANGES_REQUESTED' || (body.trim() !== '' && !isNoAction(str(row.state), body)),
```

Inline comments and issue comments keep `isFinding: body.trim() !== ''`.

- [ ] **Step 4: Fix the one caller of `severityHint`**

In `round.ts`, `beginTriage` (around line 1215), `severityHint` is only destructured for `severity` and `isSecurity`, so it compiles. Leave it for Task 2, which uses `isTagged`.

- [ ] **Step 5: Log settled approvals.** Add `'approval'` to `LogEntry.kind` in `types/index.d.ts:134`. In `beginTriage`, right after `const items = ...` (line 1178), add:

```ts
  // A review that said there is nothing to act on settles on its own (R83): logged once, and processed so it is never asked about.
  const settled = got.feedback.filter(one => one.kind === 'review' && !one.isFinding && one.body.trim() !== '' && !rec.processed.includes(one.id))
  for (const one of settled) await logEvent($, run.root, run.branch, 'approval', `${one.reviewer}: ${one.body.split('\n')[0]?.slice(0, 120) ?? ''}`)
  if (settled.length > 0) {
    await updateRecord($, run.root, run.branch, one => ({ ...one, processed: [...new Set([...one.processed, ...settled.map(each => each.id)])] }))
  }
```

`logEvent` comes from `./store`; check that `round.ts` already imports it (it does for `'check'` events).

- [ ] **Step 6: Write the flow test** (append to `tests/flow.test.ts`):

```ts
test('R83: a COMMENTED review that says there is nothing to act on covers the head and asks the agent nothing', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const prompts = w.prompts.length
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: 'No actionable findings in this diff.', state: 'COMMENTED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  expect(w.prompts.slice(prompts).some(one => one.includes('New review feedback'))).toBe(false)
  const rec = await recordOf(w)
  expect(rec.findings.filter(one => one.source === 'github')).toHaveLength(0)
  expect(rec.processed).toContain('review:5')
  expect(rec.log?.some(one => one.kind === 'approval' && one.text.includes('No actionable findings'))).toBe(true)
})

test('R83: an untagged actionable COMMENTED summary still goes to triage', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: 'The reset path deletes the pending findings. Preserve them before archiving.', state: 'COMMENTED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  expect(w.prompts.at(-1)).toContain('The reset path deletes the pending findings')
})

test('R83: an inline comment under an APPROVED review is triaged', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: 'LGTM', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  w.gh.comments = [inline(11, 'this branch never closes the file', w.gh.prHead)]
  await w.clock.advance(30_000)
  expect(w.prompts.at(-1)).toContain('this branch never closes the file')
})
```

- [ ] **Step 7: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: the new tests PASS.

If an existing test fails because a review body it uses now reads as no-action (for example `'LGTM'` with APPROVED), confirm the change is the intended R83 behaviour. Then update only that assertion and say why in the commit.

- [ ] **Step 8: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/round.ts pr-lifecycle/types/index.d.ts pr-lifecycle/tests/github.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: approvals settle only on positive no-action evidence; advisory labels read as P3 (R83, R84)"
```

---

### Task 2: A triaged severity replaces a guessed one

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Finding` gains `severitySource?: 'tag' | 'hint'`; `FindingEvent` gains `severity?: Severity`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts:133-139` (`applyAnswer`)
- Modify: `pr-lifecycle/hooks/round.ts` (`beginTriage`, finding creation around line 1216)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `severityHint(...).isTagged` from Task 1.
- Produces: `Finding.severitySource`. A GitHub finding is `'tag'` (the reviewer's own words) or `'hint'` (guessed). Codex findings leave it undefined, which behaves like `'tag'`.

- [ ] **Step 1: Write the failing tests** (`tests/lifecycle.test.ts`, append):

```ts
test('R84: a triaged severity replaces a guessed one, up or down, and the change is in the history', async () => {
  const guessed = finding({ source: 'github', severity: 'P2', severitySource: 'hint' })
  const lowered = applyAnswer(guessed, { id: 'R1-1', action: 'deferred', severity: 'P3' }, 2, 'main', 5)
  expect(lowered.severity).toBe('P3')
  expect(lowered.history.at(-1)?.severity).toBe('P3')
  expect(applyAnswer(guessed, { id: 'R1-1', action: 'fixed', severity: 'P1' }, 2, 'main', 5).severity).toBe('P1')
})

test('R84: a reviewer\'s own tag and a Codex severity are never lowered', async () => {
  const tagged = finding({ source: 'github', severity: 'P2', severitySource: 'tag' })
  expect(applyAnswer(tagged, { id: 'R1-1', action: 'deferred', severity: 'P3' }, 2, 'main', 5).severity).toBe('P2')
  expect(applyAnswer(finding({ severity: 'P2' }), { id: 'R1-1', action: 'deferred', severity: 'P3' }, 2, 'main', 5).severity).toBe('P2')
})
```

Append to `tests/flow.test.ts`:

```ts
test('R84: a guessed P2 the agent triages as P3 shows as P3 in the hold', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w, 'Consider renaming this', { severity: 'P3' })
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.severity).toBe('P3')
  expect(w.prompts.at(-1)).toContain('G2-1 [P3]')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`
Expected: FAIL on the severity expectations.

- [ ] **Step 3: Implement**

In `types/index.d.ts`:
- add `severitySource?: 'tag' | 'hint'` to `Finding`, after `isSecurity`, with the comment `/** GitHub: the reviewer's own words ('tag') or a guess from them ('hint', R84). */`;
- add `severity?: Severity` to `FindingEvent`.

In `lifecycle.ts`, replace `applyAnswer`:

```ts
/**
 * The fixer's word: fixed is only reported until a check confirms it. A fixer cannot lower a severity a reviewer or Codex set;
 * disagreement is a rebuttal. A severity only guessed from a GitHub comment's words takes the triaged one, up or down (R84).
 */
export function applyAnswer(f: Finding, a: Answer, round: number, by: string, at: number): Finding {
  const status: FindingStatus = a.action === 'fixed' ? 'reported-fixed' : a.action === 'acknowledged' ? 'rebutted' : a.action
  const next = moved(f, status, round, by, at, a.note, a.evidence)
  const isGuessed = f.severitySource === 'hint'
  const severity =
    a.severity === undefined ? f.severity : isGuessed || RANK[a.severity] < RANK[f.severity] ? a.severity : f.severity
  const security = f.isSecurity === true || a.isSecurity === true
  const history = severity === f.severity ? next.history : [...next.history.slice(0, -1), { ...next.history.at(-1)!, severity }]
  return { ...next, severity, history, ...(security ? { isSecurity: true } : {}) }
}
```

The `'acknowledged'` branch is used from Task 3. Add `'acknowledged'` to `Answer['action']` now so this compiles: `action: 'fixed' | 'rebutted' | 'deferred' | 'acknowledged'`. If the linter rejects the non-null assertion `!`, use `next.history.map((one, i) => i === next.history.length - 1 ? { ...one, severity } : one)` instead.

In `round.ts` `beginTriage`, in the `finding: Finding = { ... }` literal, after `severity: hint.severity,`, add:

```ts
      severitySource: hint.isTagged ? 'tag' : 'hint',
```

- [ ] **Step 4: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. Existing tests compare history entries with `toEqual`; they still pass because `severity` is only added when it changes.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: a triaged severity replaces one guessed from a comment's words (R84)"
```

---

### Task 3: Finding 21: carried by the round raised in; `acknowledged`, replied and checked

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts:1242` (carried list), `afterTriage` (`round.ts:1340-1362`), the reprompt template (`round.ts:1398`)
- Modify: `pr-lifecycle/hooks/core.ts:184-221` (`readTriage`, `readDispositions`), `:686-700` (triage prompt text)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (add `mayAcknowledge`)
- Test: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `Answer.action` includes `'acknowledged'`, and `applyAnswer` stores it as `'rebutted'` (Task 2).
- Produces: `export const mayAcknowledge = (f: Finding): boolean` in `lifecycle.ts`. `TriageAnswer` can now carry `action: 'acknowledged'`. `readDispositions` (the pre-PR fix step) drops `acknowledged` answers.

- [ ] **Step 1: Write the failing tests.** `KEY`, `roster`, `inline`, `covers`, `triaged`, `accept` and `toPost` are already defined in `flow.test.ts`. Append:

```ts
/** Finding 21's shape (cookbook PR 3706, G2-11): an approval answered "fixed", which Codex could not verify and reopened. */
const reopenedApproval = (): Finding => ({
  id: 'G1-1', round: 1, source: 'github', reviewer: 'claude[bot]', externalId: 'inline:7', threadId: '7', severity: 'P2',
  title: 'No blocking findings', headSeen: 'a'.repeat(40), status: 'open',
  history: [
    { round: 1, status: 'open', by: 'claude[bot]', at: 1 },
    { round: 1, status: 'reported-fixed', note: 'nothing to fix', by: 'main', at: 2 },
    { round: 2, status: 'open', note: 'Codex: no fix to verify', by: 'codex', at: 3 },
  ],
})

test('finding 21: an earlier round\'s finding Codex reopened this round is carried into triage', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const rec = await recordOf(w)
  w.store.set(KEY, { ...rec, findings: [reopenedApproval()], processed: ['inline:7'] })
  w.gh.comments = [inline(11, 'nit: rename this', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('Carried from earlier rounds, still open')
  expect(said).toContain('G1-1')
  expect((await runOf(w)).asked).toContain('G1-1')
})

test('R82: acknowledged, with a reply, goes to the Codex check and settles when Codex upholds it', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Looks fine to me; the retry loop is the same as before.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', severity: 'P3', note: 'a status note, nothing asked', replyId: '992' }]))
  const run = await runOf(w)
  expect(run.findings.find(one => one.id === 'G2-1')?.note).toContain('No change requested:')
  expect(run.phase).toBe('verify')
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
})

test('R82: acknowledged without a reply, or on a tagged P2 or security finding, is unanswered and asked again', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'P2: the cache is never cleared')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', note: 'fine', replyId: '992' }]))
  expect(w.prompts.at(-1)).toContain('These review items have no answer yet: G2-1')
  const w2 = world(on)
  await toTriage($, w2, 'Looks fine to me.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', note: 'fine' }]))
  expect(w2.prompts.at(-1)).toContain('These review items have no answer yet: G2-1')
})

test('R82: Codex rejecting an acknowledgement reopens the item with its reason', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Looks fine, though the retry loop now never stops.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', note: 'nothing asked', replyId: '992' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'it reports a loop that never stops' }))
  const found = (await recordOf(w)).findings.find(one => one.id === 'G2-1')
  expect(found?.status).toBe('open')
  expect(found?.history.at(-1)?.note).toContain('never stops')
})
```

Calling `world(on)` twice in one test makes a second world on the same engine. If the harness doesn't allow that, split the second half into its own `test(...)`.

Append to `tests/lifecycle.test.ts` (import `mayAcknowledge`):

```ts
test('R82: only an untagged-or-P3, non-security GitHub finding may be acknowledged', async () => {
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P2', severitySource: 'hint' }))).toBe(true)
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P3', severitySource: 'tag' }))).toBe(true)
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P2', severitySource: 'tag' }))).toBe(false)
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P2', severitySource: 'hint', isSecurity: true }))).toBe(false)
  expect(mayAcknowledge(finding())).toBe(false)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`
Expected: FAIL. The finding 21 test fails because `G1-1` isn't asked. The R82 tests fail because `readTriage` drops `acknowledged`. `mayAcknowledge` is undefined.

- [ ] **Step 3: Carry by the round raised in.** In `round.ts` `beginTriage` (line 1242), change the carried filter:

```ts
  const carried = mergeHolds({ findings: mergeFindings(ledger, fresh), waivers: rec.waivers }).filter(
    // By the round it was raised in, not "touched this round": Codex reopening an earlier finding must not hide it (finding 21, R82).
    one => one.status === 'open' && one.round !== run.round && !listedIds.has(one.id),
  )
```

- [ ] **Step 4: `mayAcknowledge`** in `lifecycle.ts`, next to `isBlocking`:

```ts
/** A GitHub item the agent may answer "no change requested" (R82): no security flag, and no explicit P0-P2 from the reviewer. */
export const mayAcknowledge = (f: Finding): boolean =>
  f.source === 'github' && f.isSecurity !== true && !(f.severitySource === 'tag' && RANK[f.severity] <= 2)
```

Move `RANK` above it if needed.

- [ ] **Step 5: Parse it.** In `core.ts` `readTriage`, change the action check:

```ts
    if (id === undefined || !['fixed', 'rebutted', 'deferred', 'acknowledged'].includes(action)) continue
```

Cast where `action` is pushed: `action: action as Answer['action']`. Change `readDispositions`, which the pre-PR fix step uses:

```ts
/** What the fixer said it did with each finding; "acknowledged" is a post-PR triage answer only (R82). */
export const readDispositions = (answer: string): Answer[] => readTriage(answer).filter(one => one.action !== 'acknowledged')
```

- [ ] **Step 6: Accept it only with a reply, and store it as a rebuttal.** In `round.ts` `afterTriage`, replace the first line that reads `said`:

```ts
  // "acknowledged" counts only with a reply in the thread, on an item that may take it (R82); stored as a rebuttal, so Codex checks it.
  const said = readTriage(run.pending[0]?.answer ?? '').flatMap(each => {
    if (each.action !== 'acknowledged') return [each]
    const one = run.findings.find(f => f.id === each.id)
    if (one === undefined || !mayAcknowledge(one) || each.replyId === undefined) return []
    return [{ ...each, note: `No change requested: ${each.note ?? 'the comment asks for no change'}` }]
  })
```

`applyAnswer` turns `acknowledged` into `rebutted` (Task 2). `rebuttalsOwed` → `checksOwed` then includes it, and `afterTriage` ends in `checkRebuttals`.

Check that `verifyPrompt` (core.ts) shows each rebutted finding's `note`. If it shows only the title, add the note to the line it prints for rebuttals, so Codex sees "No change requested: …".

- [ ] **Step 7: Tell the agent.** In `core.ts` triage prompt step 2 (line 686), replace the string with:

```ts
    '2. Give each item one answer: fix it (smallest change, with a test where one fits), rebut it with file:line, test or requirement evidence, defer it with the reason, or acknowledge it when the comment asks for no change (an approval with notes, a status note): reply in its thread saying so, and Codex confirms it. A duplicate gets a reply pointing to the earlier answer, not a new argument.',
```

In the trailer example (line 699) and the reprompt in `round.ts:1398`, replace `fixed|rebutted|deferred` with `fixed|rebutted|deferred|acknowledged`, in post-PR triage texts only. The pre-PR fix prompts at `core.ts:519` and `:556` stay as they are.

- [ ] **Step 8: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A test that asserts the exact old trailer example text should be updated to the new one.

- [ ] **Step 9: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/tests
git commit -m "pr-lifecycle: triage carries findings by the round raised in (finding 21); acknowledged needs a reply and a Codex check (R82)"
```

---

### Task 4: A P3 deferral with a recorded follow-up settles (decision I)

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Finding.followUp?: string`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`Answer.followUp`, `applyAnswer`, new `isSettledDeferral`, `mergeHolds`)
- Modify: `pr-lifecycle/hooks/core.ts` (`readTriage` parses `followUp`; triage prompt text)
- Test: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Produces: `export const isSettledDeferral = (f: Finding): boolean`. `mergeHolds` excludes such findings.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`):

```ts
const ISSUE = 'https://github.com/me/repo/issues/9'

test('R85: a P3 deferred with a recorded follow-up settles without a waiver', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'cosmetic', followUp: ISSUE, replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  expect(rec.findings.find(one => one.id === 'G2-1')?.followUp).toBe(ISSUE)
})

test('R85: a P2 deferral, a P3 one without a follow-up, and a security P3 still wait for the person', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w, 'Consider renaming this', { severity: 'P2', followUp: ISSUE })
  const w2 = world(on)
  await toAwaiting($, w2, 'Consider renaming this', { severity: 'P3' })
  const w3 = world(on)
  await toAwaiting($, w3, 'Consider renaming the token variable', { severity: 'P3', isSecurity: true, followUp: ISSUE })
})
```

`toAwaiting` already asserts `postStatus === 'awaiting-decision'`, which is the expectation here. If two worlds per test are refused, split them into three tests.

`lifecycle.test.ts`:

```ts
test('R85: isSettledDeferral needs deferred, P3, a follow-up and no security flag', async () => {
  const base = finding({ source: 'github', status: 'deferred', severity: 'P3', followUp: 'https://x/issues/1' })
  expect(isSettledDeferral(base)).toBe(true)
  expect(isSettledDeferral({ ...base, severity: 'P2' })).toBe(false)
  expect(isSettledDeferral({ ...base, followUp: undefined })).toBe(false)
  expect(isSettledDeferral({ ...base, isSecurity: true })).toBe(false)
  expect(isSettledDeferral({ ...base, status: 'open' })).toBe(false)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`. Expected: FAIL.

- [ ] **Step 3: Implement**
- `types/index.d.ts`: on `Finding`, add `/** Where a P3 deferral's follow-up is recorded (R85): an issue or comment URL, or #<n>. */ followUp?: string`.
- `lifecycle.ts`: add `followUp?: string` to `Answer`. In `applyAnswer`, add `...(a.action === 'deferred' && a.followUp !== undefined ? { followUp: a.followUp } : {})` to the returned object.
- Add, above `mergeHolds`:

```ts
/** A P3 deferred with its follow-up recorded, not security: settled without the person's waiver (R85, decision I). */
export const isSettledDeferral = (f: Finding): boolean =>
  f.status === 'deferred' && f.severity === 'P3' && f.isSecurity !== true && f.followUp !== undefined && f.followUp.trim() !== ''
```

- In `mergeHolds`, add `&& !isSettledDeferral(one)` to the filter.
- `core.ts` `readTriage`: add `...(text(row.followUp) === undefined ? {} : { followUp: text(row.followUp)?.slice(0, 500) }),`.
- In the triage prompt step 2 string from Task 3, replace "defer it with the reason" with "defer it with the reason (only what the person must rule on; a P3 with followUp, the issue or comment URL where it is tracked, needs no waiver)". Add `"followUp":"https://… for a P3 deferral"` to the post-PR trailer example.

- [ ] **Step 4: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. The existing "R39: a deferred P3 after the PR opened is not ready" test has no `followUp`, so it still holds.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/types/index.d.ts pr-lifecycle/tests
git commit -m "pr-lifecycle: a P3 deferral with a recorded follow-up settles without a waiver (R85)"
```

---

### Task 5: `standingOf` and `holdText` (pure)

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (add `CheckState`, `Blocker`, `Standing`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (add `standingOf`, `holdText`, `blockerOf`)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Produces, in `types/index.d.ts`:

```ts
/** A CI check on a PR head, by gh's bucket (pass, fail, cancel, pending, skipping), and whether the base requires it (R86). */
export type CheckState = { name: string; bucket: string; isRequired: boolean }

export type Blocker = {
  kind:
    | 'open' | 'verify-owed' | 'reverify-owed' | 'rebuttal-unchecked' | 'disputed' | 'deferred' | 'security-p1'
    | 'head-unreviewed' | 'round-owed' | 'retargeted' | 'ci-failing' | 'ci-running' | 'ci-unreadable'
  /** A finding id, or a check name. */
  id?: string
  /** One line, with the stored (triaged) severity. */
  said: string
  owner: 'agent' | 'codex' | 'person' | 'gate'
  /** The exact step that clears it. */
  release: string
}

/** Everything between a head and its merge (R79): one list, none short-circuited. */
export type Standing = {
  phase: 'pre' | 'post'
  head: string
  waiver?: Waiver
  /** Checks GitHub doesn't require that a post waiver set aside (R86). */
  setAside: string[]
  mayProceed: boolean
  blockers: Blocker[]
}
```

- Produces, in `lifecycle.ts`:
  - `export function standingOf(rec: LifecycleRecord, at: { head: string; base: string }, ci?: readonly CheckState[] | 'unreadable'): Standing`
  - `export function holdText(s: Standing, named?: ReadonlySet<string>): string`

- [ ] **Step 1: Write the failing tests** (`lifecycle.test.ts`; import `standingOf`, `holdText`):

```ts
const postRec = (over: object = {}) => at([post({ endHead: 'a' })], { phase: 'post', pr: 7, ...over })

test('R79: the standing lists every finding that holds the merge, each with its owner and release', async () => {
  const rec = postRec({
    findings: [
      finding({ id: 'G2-1', source: 'github', severity: 'P2', status: 'open' }),
      finding({ id: 'G2-2', source: 'github', severity: 'P3', status: 'deferred' }),
      finding({ id: 'R1-1', status: 'reported-fixed' }),
      finding({ id: 'R1-2', status: 'verified-fixed', needsRecheck: true }),
    ],
  })
  const s = standingOf(rec, { head: 'a', base: 'dev' })
  expect(s.blockers.map(one => [one.id, one.kind, one.owner])).toEqual(
    expect.arrayContaining([
      ['G2-1', 'open', 'agent'],
      ['G2-2', 'deferred', 'person'],
      ['R1-1', 'verify-owed', 'codex'],
      ['R1-2', 'reverify-owed', 'codex'],
    ]),
  )
  expect(s.mayProceed).toBe(false)
  expect(s.blockers.find(one => one.id === 'G2-2')?.release).toBe('/pr-gate waive G2-2 <reason>')
})

test('R79/R86: CI joins the standing; a post waiver sets aside only checks GitHub does not require', async () => {
  const ci = [
    { name: 'check', bucket: 'pending', isRequired: true },
    { name: 'Independent Claude review', bucket: 'cancel', isRequired: false },
    { name: 'lint', bucket: 'pass', isRequired: true },
  ]
  const open = standingOf(postRec(), { head: 'a', base: 'dev' }, ci)
  expect(open.blockers.map(one => [one.id, one.kind])).toEqual(
    expect.arrayContaining([['check', 'ci-running'], ['Independent Claude review', 'ci-failing']]),
  )
  const waived = postRec({ waivers: [{ scope: 'post', head: 'a', reason: 'docs only', by: 'composer', at: 2 }], findings: [finding({ id: 'G2-1', source: 'github', severity: 'P2' })] })
  const s = standingOf(waived, { head: 'a', base: 'dev' }, ci)
  expect(s.setAside).toEqual(['Independent Claude review'])
  expect(s.blockers.map(one => one.id)).toEqual(['check'])
  expect(standingOf(waived, { head: 'a', base: 'dev' }, ci.filter(one => one.name !== 'check')).mayProceed).toBe(true)
})

test('R79: unreadable checks are a blocker; a security P1 survives a post waiver', async () => {
  expect(standingOf(postRec(), { head: 'a', base: 'dev' }, 'unreadable').blockers.map(one => one.kind)).toContain('ci-unreadable')
  const rec = postRec({
    waivers: [{ scope: 'post', head: 'a', reason: 'x', by: 'composer', at: 2 }],
    findings: [finding({ id: 'R1-1', isSecurity: true, status: 'open' })],
  })
  expect(standingOf(rec, { head: 'a', base: 'dev' }).blockers.map(one => one.kind)).toContain('security-p1')
})

test('R79: holdText names every blocker once, skipping ids the caller already named', async () => {
  const rec = postRec({ findings: [finding({ id: 'G2-1', source: 'github', severity: 'P2' }), finding({ id: 'G2-2', source: 'github', severity: 'P3', status: 'deferred' })] })
  const s = standingOf(rec, { head: 'abcdef1234', base: 'dev' }, [{ name: 'check', bucket: 'fail', isRequired: true }])
  const all = holdText(s)
  expect(all).toContain('Everything between abcdef1 and the merge:')
  expect(all).toContain('G2-1 [P2]')
  expect(all).toContain('G2-2 [P3]')
  expect(all).toContain('check')
  const rest = holdText(s, new Set(['G2-1']))
  expect(rest).not.toContain('G2-1')
  expect(rest).toContain('Also holding:')
  expect(holdText(standingOf(postRec(), { head: 'abcdef1234', base: 'dev' }, []))).toContain('Nothing else holds the merge of abcdef1.')
})
```

`decideNext` on `postRec()` may itself add a head-level blocker (`round-owed`, say). That's why the tests use `arrayContaining`, except the waived case, where head blockers are dropped.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL, `standingOf` undefined.

- [ ] **Step 3: Implement** in `lifecycle.ts`, after `securityHolds`:

```ts
const short = (sha: string): string => sha.slice(0, 7)

/** One finding that holds the merge, as a blocker with its owner and the step that clears it (R79). */
function blockerOf(f: Finding): Blocker {
  const tag = `${f.id} [${f.severity}]${f.isSecurity === true ? ' security' : ''} ${f.title}`
  const waive = `/pr-gate waive ${f.id} <reason>`
  const isSecurityP1 = isBlocking(f) && f.isSecurity === true
  if (isDisputed(f)) return { kind: 'disputed', id: f.id, said: `${tag}: disputed`, owner: 'person', release: waive }
  if (f.status === 'deferred') return { kind: isSecurityP1 ? 'security-p1' : 'deferred', id: f.id, said: `${tag}: deferred`, owner: 'person', release: waive }
  if (isReverifyOwed(f)) {
    return { kind: 'reverify-owed', id: f.id, said: `${tag}: fixed, re-verify owed (file changed)`, owner: 'codex', release: "the gate's Codex check re-verifies it" }
  }
  if (f.status === 'reported-fixed') {
    return { kind: 'verify-owed', id: f.id, said: `${tag}: fixed, verification owed`, owner: 'codex', release: "the gate's Codex check verifies it" }
  }
  if (f.status === 'rebutted') {
    return { kind: 'rebuttal-unchecked', id: f.id, said: `${tag}: rebuttal not yet accepted`, owner: 'codex', release: "the gate's Codex check rules on it" }
  }
  return { kind: isSecurityP1 ? 'security-p1' : 'open', id: f.id, said: `${tag}: open`, owner: 'agent', release: 'fix it, or rebut it with file:line evidence' }
}

/**
 * Everything between this head and its merge (R79): findings, the head's own review, and CI, with nothing short-circuited. A post
 * waiver for this head and base leaves only a security P1 and CI; CI a waiver covers is only what GitHub does not require (R86).
 */
export function standingOf(rec: LifecycleRecord, at: { head: string; base: string }, ci?: readonly CheckState[] | 'unreadable'): Standing {
  const phase = rec.phase === 'pre' ? 'pre' : 'post'
  const isOnBase = rec.base === at.base
  const waiver = isOnBase ? rec.waivers.find(one => one.scope === phase && one.head === at.head && (phase === 'post' || one.base === at.base)) : undefined
  const security = securityHolds(rec)
  const isWaived = waiver !== undefined && security.length === 0
  const blockers: Blocker[] = (isWaived ? [] : mergeHolds(rec)).map(blockerOf)
  if (!isOnBase && phase === 'post') {
    blockers.push({ kind: 'retargeted', said: `reviewed for ${rec.base}, but the PR now targets ${at.base}`, owner: 'person', release: `point it back at ${rec.base}, or /pr-gate reset` })
  }
  if (!isWaived && phase === 'post') {
    const next = decideNext(rec)
    if (next.kind === 'round') blockers.push({ kind: 'round-owed', said: `a review round is owed on ${short(at.head)}`, owner: 'gate', release: 'the gate runs it; leave the branch alone' })
    if (next.kind === 'exhausted') {
      blockers.push({ kind: 'head-unreviewed', said: next.why, owner: 'person', release: '/pr-gate allow 1 <reason>, or /pr-gate waive post <reason>' })
    }
  }
  const setAside: string[] = []
  if (ci === 'unreadable') {
    blockers.push({ kind: 'ci-unreadable', said: `the CI checks on ${short(at.head)} could not be read`, owner: 'agent', release: 'check gh auth status and the network, then try again' })
  } else {
    for (const one of ci ?? []) {
      const isBad = one.bucket === 'fail' || one.bucket === 'cancel'
      if (!isBad && (one.bucket === 'pass' || one.bucket === 'skipping')) continue
      if (isWaived && !one.isRequired) {
        setAside.push(one.name)
        continue
      }
      blockers.push(
        isBad
          ? { kind: 'ci-failing', id: one.name, said: `check ${one.name} ${one.bucket === 'cancel' ? 'cancelled' : 'failing'}`, owner: 'agent', release: 'fix what it reports and push, or rerun it (gh run rerun <run-id> --failed)' }
          : { kind: 'ci-running', id: one.name, said: `check ${one.name} running`, owner: 'gate', release: `wait for it (gh pr checks ${rec.pr ?? ''} --watch)` },
      )
    }
  }
  return { phase, head: at.head, ...(waiver === undefined ? {} : { waiver }), setAside, mayProceed: blockers.length === 0, blockers }
}

const OWNERS: Record<Blocker['owner'], string> = { agent: 'yours', codex: 'the gate (Codex)', person: "the person's", gate: 'the gate' }

/** The standing in words (R79): every blocker once, skipping ids the text around it already named, with who acts and how. */
export function holdText(s: Standing, named: ReadonlySet<string> = new Set()): string {
  const what = s.phase === 'pre' ? 'pull request' : 'merge'
  const aside = s.setAside.length === 0 ? [] : [`Set aside by the post waiver (GitHub does not require them): ${s.setAside.join(', ')}.`]
  if (s.blockers.length === 0) return [...aside, `Nothing else holds the ${what} of ${short(s.head)}.`].join('\n')
  const rest = s.blockers.filter(one => one.id === undefined || !named.has(one.id))
  if (rest.length === 0) return aside.join('\n')
  const heading = named.size > 0 ? 'Also holding:' : `Everything between ${short(s.head)} and the ${what}:`
  return [...aside, heading, ...rest.map(one => `- ${one.said} (${OWNERS[one.owner]}: ${one.release})`)].join('\n')
}
```

Import the `Blocker`, `CheckState` and `Standing` types from `'../types'` at the top of `lifecycle.ts`. `decideNext` is defined later in the same file; a function declaration is hoisted, so the call is fine.

- [ ] **Step 4: Run the suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/tests/lifecycle.test.ts
git commit -m "pr-lifecycle: standingOf and holdText, everything between a head and its merge (R79)"
```

---

### Task 6: Required checks and `gatherStanding`

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (add `readRequired`)
- Modify: `pr-lifecycle/hooks/round.ts` (add `readChecks`, `requiredChecksOf`, `gatherStanding`)
- Modify: `pr-lifecycle/tests/world.ts` (fake the rules and protection endpoints)
- Test: `pr-lifecycle/tests/github.test.ts`

**Interfaces:**
- Produces: `export function readRequired(rules: string, protection: string | undefined): string[] | undefined` (`github.ts`). It returns `undefined` when the rules text isn't a JSON array.
- Produces (`round.ts`):
  - `export async function readChecks($: Engine, root: string, pr: number, repo?: string): Promise<{ name: string; bucket: string }[] | 'unreadable'>`
  - `export async function requiredChecksOf($: Engine, root: string, slug: string | undefined, base: string): Promise<Set<string> | 'unknown'>`
  - `export async function gatherStanding($: Engine, rec: LifecycleRecord, pr: { number: number; baseRefName: string; headRefOid: string }, repo?: string): Promise<Standing>`

- [ ] **Step 1: Write the failing unit test** (`github.test.ts`, import `readRequired`):

```ts
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
})
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.

- [ ] **Step 3: Implement `readRequired`** (`github.ts`):

```ts
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
    const row = typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>) : {}
    if (row.type !== 'required_status_checks') continue
    const params = (row.parameters ?? {}) as { required_status_checks?: { context?: unknown }[] }
    for (const one of params.required_status_checks ?? []) if (typeof one.context === 'string') out.push(one.context)
  }
  if (protection !== undefined) {
    try {
      const read = JSON.parse(protection) as { contexts?: unknown[]; checks?: { context?: unknown }[] }
      for (const one of read.contexts ?? []) if (typeof one === 'string') out.push(one)
      for (const one of read.checks ?? []) if (typeof one.context === 'string') out.push(one.context)
    } catch {
      // Rulesets and classic protection apply together: half a set is not the set (PR #19 review).
      return undefined
    }
  }
  return [...new Set(out)]
}
```

- [ ] **Step 4: Fake the endpoints** in `tests/world.ts`. Add to the `gh` type:
  - `/** Checks the base requires; undefined requires every check in \`checks\` (as before R86). */ required?: string[]`
  - `/** How the rules endpoint answers: 'ok' (default), 'garbage', 'throw', or an HTTP status. */ rulesAnswer?: 'ok' | 'garbage' | 'throw' | number`
  - `/** How classic protection answers: 'none' (404, the default), 'ok' (requires 'legacy'), 'garbage', 'throw', or an HTTP status. */ classicAnswer?: 'none' | 'ok' | 'garbage' | 'throw' | number`

In the `process.run` handler, after the `garbage` line, add:

```ts
      const failed = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      if (/^api repos\/\S+\/rules\/branches\//.test(args)) {
        const how = w.gh.rulesAnswer ?? 'ok'
        if (how === 'throw') throw new Error('network down')
        if (typeof how === 'number') return failed(`gh: HTTP ${how}`)
        if (how === 'garbage') return out('<html>proxy error</html>')
        const names = w.gh.required ?? (w.gh.checks as { name?: string }[]).map(one => String(one.name))
        return out(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: names.map(context => ({ context })) } }]))
      }
      if (/^api repos\/\S+\/branches\/\S+\/protection/.test(args)) {
        const how = w.gh.classicAnswer ?? 'none'
        if (how === 'throw') throw new Error('network down')
        if (how === 'none') return failed('gh: Branch not protected (HTTP 404)')
        if (typeof how === 'number') return failed(`gh: HTTP ${how}`)
        if (how === 'garbage') return out('<html>proxy error</html>')
        return out(JSON.stringify({ contexts: ['legacy'], checks: [] }))
      }
```

If a throwing handler doesn't surface as a rejected `process.run` in this harness, model `'throw'` however the fake engine reports a failed spawn, and say so in the report.

Add the source-combination test to `tests/flow.test.ts` (import `requiredChecksOf` from `'../hooks/round'`):

```ts
test('R86: the required set is known only when both sources are established (PR #19 review)', async ($, on) => {
  const w = world(on)
  const cases: [World['gh']['rulesAnswer'], World['gh']['classicAnswer'], string[] | 'unknown'][] = [
    ['ok', 'none', ['check']],
    ['ok', 'ok', ['check', 'legacy']],
    ['ok', 403, 'unknown'],
    ['ok', 500, 'unknown'],
    [403, 'none', 'unknown'],
    [500, 'ok', 'unknown'],
    ['throw', 'none', 'unknown'],
    ['ok', 'throw', 'unknown'],
    ['garbage', 'none', 'unknown'],
    ['ok', 'garbage', 'unknown'],
  ]
  w.gh.required = ['check']
  for (const [i, [rules, classic, want]] of cases.entries()) {
    w.gh.rulesAnswer = rules
    w.gh.classicAnswer = classic
    const got = await requiredChecksOf($, '/repo', 'me/repo', `base${i}`)
    expect(got === 'unknown' ? 'unknown' : [...got]).toEqual(want)
  }
  // An unknown answer is not cached: once GitHub answers, the same base reads.
  w.gh.rulesAnswer = 500
  expect(await requiredChecksOf($, '/repo', 'me/repo', 'later')).toBe('unknown')
  w.gh.rulesAnswer = 'ok'
  expect(await requiredChecksOf($, '/repo', 'me/repo', 'later')).toEqual(new Set(['check']))
})
```

Use the world type the file already uses (`ReturnType<typeof world>`) if `World` isn't exported.

- [ ] **Step 5: Implement the async helpers** in `round.ts` (near `fetchFeedback`; import `readRequired` from `./github`, and the `Standing` and `CheckState` types and `standingOf` from `./lifecycle` and `../types`):

```ts
/** The PR head's checks from `gh pr checks` (R1-9): [] when gh reports none, 'unreadable' when it can't say. */
export async function readChecks($: Engine, root: string, pr: number, repo?: string): Promise<{ name: string; bucket: string }[] | 'unreadable'> {
  let ran: { exitCode: number; stdout: string; stderr: string }
  try {
    ran = await $.process.run(['gh', 'pr', 'checks', String(pr), ...(repo === undefined ? [] : ['--repo', repo]), '--json', 'name,state,bucket'], {
      cwd: root,
      timeoutMs: 30_000,
    })
  } catch (error) {
    ran = { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  try {
    const read = JSON.parse(ran.stdout) as unknown
    const row = (one: unknown): Record<string, unknown> => (typeof one === 'object' && one !== null ? (one as Record<string, unknown>) : {})
    if (Array.isArray(read)) return read.map(one => ({ name: String(row(one).name ?? '?'), bucket: String(row(one).bucket ?? '') }))
  } catch {
    // Not JSON: read stderr below.
  }
  return /no checks reported/i.test(ran.stderr) ? [] : 'unreadable'
}

const required = new Map<string, Set<string>>()

/**
 * The base's required checks (R86): the union of its rulesets and classic protection, cached per repository and base for the session.
 * Each source must be parsed, or authoritatively absent (classic's 404 "not protected"); a throw, a 403 or 500, or a payload that
 * doesn't parse from either makes it 'unknown', which fails closed (every check required) and is not cached (PR #19 review).
 */
export async function requiredChecksOf($: Engine, root: string, slug: string | undefined, base: string): Promise<Set<string> | 'unknown'> {
  if (slug === undefined) return 'unknown'
  const key = `${slug}:${base}`
  const seen = required.get(key)
  if (seen !== undefined) return seen
  const api = (path: string) => $.process.run(['gh', 'api', path], { cwd: root, timeoutMs: 30_000 }).catch(() => undefined)
  const rules = await api(`repos/${slug}/rules/branches/${base}`)
  const classic = await api(`repos/${slug}/branches/${base}/protection/required_status_checks`)
  if (rules === undefined || rules.exitCode !== 0 || classic === undefined) return 'unknown'
  const isClassicNone = classic.exitCode !== 0 && /\b404\b|not protected/i.test(classic.stderr)
  if (classic.exitCode !== 0 && !isClassicNone) return 'unknown'
  const listed = readRequired(rules.stdout, classic.exitCode === 0 ? classic.stdout : undefined)
  if (listed === undefined) return 'unknown'
  const found = new Set(listed)
  required.set(key, found)
  return found
}

/** The standing of a PR head (R79): the record's findings and review, its checks, and which of them its base requires. */
export async function gatherStanding(
  $: Engine,
  rec: LifecycleRecord,
  pr: { number: number; baseRefName: string; headRefOid: string },
  repo?: string,
): Promise<Standing> {
  const checks = await readChecks($, rec.root, pr.number, repo)
  const needed = checks === 'unreadable' || checks.length === 0 ? new Set<string>() : await requiredChecksOf($, rec.root, repo ?? rec.slug, pr.baseRefName)
  const ci: CheckState[] | 'unreadable' =
    checks === 'unreadable' ? 'unreadable' : checks.map(one => ({ ...one, isRequired: needed === 'unknown' || needed.has(one.name) }))
  return standingOf(rec, { head: pr.headRefOid, base: pr.baseRefName }, ci)
}
```

The `required` cache is module state. If tests that use different `w.gh.required` values interfere, add the world's id to the key, or clear the map in `setup(c)` (called on each `register`).

- [ ] **Step 6: Run the suite.** Expected: PASS. Nothing calls the async helpers yet.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/world.ts pr-lifecycle/tests/github.test.ts
git commit -m "pr-lifecycle: required checks from rulesets and classic protection; gatherStanding (R86)"
```

---

### Task 7: The merge guard renders from the standing (findings 27, 28)

**Files:**
- Modify: `pr-lifecycle/hooks/register.tsx:595-646` (`ciHold`), `:652-756` (`judgeMerge`), `:1021-1049` (the `waive post` reply)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `gatherStanding`, `holdText` (Tasks 5, 6).
- Produces: `ciHold($, action, pr, standing)`. CI's words come from the standing's `ci-*` blockers, and set-aside checks are named.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`; `merge` is defined at line 303):

```ts
test('R86: waive post sets aside a cancelled check GitHub does not require, and names it; a running required check still holds', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.hasPr = true
  w.gh.required = ['check']
  w.gh.checks = [
    { name: 'Independent Claude review', status: 'completed', conclusion: 'cancelled' },
    { name: 'check', status: 'in_progress', conclusion: null },
  ]
  const said = await say($, 'waive post reviewed by hand')
  expect(said.text).toContain('Set aside')
  expect(said.text).toContain('Independent Claude review')
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny ?? '').toContain('check')
  expect(held.deny ?? '').not.toContain('failing: Independent Claude review')
  w.gh.checks = [{ name: 'Independent Claude review', status: 'completed', conclusion: 'cancelled' }, { name: 'check', status: 'completed', conclusion: 'success' }]
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R79: one merge refusal names every blocker: findings and CI', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  w.gh.checks = [{ name: 'check', status: 'in_progress', conclusion: null }]
  const held = await $.tool.call(merge)
  const text = held.deny ?? ''
  expect(text).toContain('G2-1')
  expect(text).toContain('check check running')
})

test('R86: with the required checks unreadable, a waiver sets nothing aside', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.hasPr = true
  w.gh.garbage = '<html>proxy error</html>'
  w.gh.checks = [{ name: 'Independent Claude review', status: 'completed', conclusion: 'cancelled' }]
  await say($, 'waive post reviewed by hand')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})
```

`isHeld(result)` means the guard refused (`result.deny !== undefined`). If `flow.test.ts` has no helper by that name, define it at the top of these tests.

`gh.garbage` applies to every `gh api` call, so the rules call reads as unreadable. Check `toPost`'s state: `toPost` already opens the PR (`createPr` sets `hasPr`). Keep `w.gh.hasPr = true` only if a test needs it.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL. The waiver reply doesn't name the set-aside check, and the guard holds on the cancelled check.

- [ ] **Step 3: Rewrite `ciHold`** to take the standing:

```ts
/**
 * The CI hold on a merge the review lets through (R1-9, narrowed by R86): the standing's CI blockers. A required check that fails, is
 * cancelled or runs holds it, and so do checks gh can't read; under a post waiver a check GitHub does not require is set aside, named.
 */
const ciHold = (action: PrAction, pr: MergedPr, standing: Standing): string | undefined => {
  const ci = standing.blockers.filter(one => one.kind.startsWith('ci-'))
  if (ci.length === 0) return undefined
  const head = `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held`
  const short = pr.headRefOid.slice(0, 7)
  if (ci.some(one => one.kind === 'ci-unreadable')) {
    return [
      `${head}: the CI checks on ${short} could not be read, and a merge waits until they can.`,
      'Do not merge another way. Check gh auth status and the network, then try the merge again.',
    ].join('\n') + unknownNote(action)
  }
  const failing = ci.filter(one => one.kind === 'ci-failing').map(one => one.id ?? '?')
  const running = ci.filter(one => one.kind === 'ci-running').map(one => one.id ?? '?')
  const said = [...(failing.length === 0 ? [] : [`failing: ${failing.join(', ')}`]), ...(running.length === 0 ? [] : [`still running: ${running.join(', ')}`])]
  return [
    `${head}: CI on ${short} is not green (${said.join('; ')}).`,
    ...(standing.setAside.length === 0 ? [] : [`Set aside by the post waiver (GitHub does not require them): ${standing.setAside.join(', ')}.`]),
    'Do not merge another way.',
    ...(failing.length === 0
      ? []
      : ['Your next step: fix what the failing checks report and push, or rerun a check that failed for a flaky reason (gh run rerun <run-id> --failed).']),
    ...(running.length === 0
      ? []
      : [`${failing.length === 0 ? 'Your next step: wait' : 'Wait'} for the running checks (gh pr checks ${pr.number} --watch), then try the merge again.`]),
  ].join('\n') + unknownNote(action)
}
```

This keeps today's sentences ("CI on … is not green (failing: …; still running: …)"), so the existing R1-9 tests still match.

- [ ] **Step 4: Use it in `judgeMerge`.** After `isWaived` is computed, read the standing once, when there's a record:

```ts
  const standing = rec === undefined ? undefined : await gatherStanding($, rec, pr, action.repo)
```

- Replace `return ciHold($, root, action, pr)` in the waived branch with `return standing === undefined ? undefined : ciHold(action, pr, standing)`.
- In the ready branch, replace it with `return standing === undefined ? undefined : ciHold(action, pr, standing)`.
- In the final refusal, append the rest of the standing, skipping the ids the first line already names:

```ts
  const named = new Set(missing.match(/\b[RG]\d+-\d+\b/g) ?? [])
  const rest = standing === undefined ? '' : holdText(standing, named)
  return (
    [
      `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held: the lifecycle review is not complete for ${short}: ${missing}.`,
      'Do not merge another way.',
      next,
      ...(rest === '' ? [] : ['', rest]),
    ].join('\n') + unknownNote(action)
  )
```

`MergedPr` wants `{ number, baseRefName, headRefOid }`. The `pr` read in `judgeMerge` has those fields, so pass it directly. Import `gatherStanding` from `./round`, `holdText` from `./lifecycle`, and the `Standing` type from `../types`.

- [ ] **Step 5: Name the set-aside checks in the `waive post` reply.** At the end of the `waive post` branch of `runCommand`, after the record is written:

```ts
  const after = await loadRecord($, root, branch)
  const standing = after !== undefined && pr !== undefined ? await gatherStanding($, after, pr) : undefined
  const aside = standing === undefined || standing.setAside.length === 0 ? '' : ` Set aside (GitHub does not require them): ${standing.setAside.join(', ')}.`
  return `/${COMMAND} waived post-PR review for ${branch} at ${at.slice(0, 7)}: ${reason}. This head may merge; a new commit needs a new review or waiver.${aside}`
```

`pr` here comes from `openPrOf($, root, branch)`. Check that its type has `number`, `baseRefName` and `headRefOid`; if not, build `{ number: pr.number, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid }`. Task 9 adds the agent message to this branch.

- [ ] **Step 6: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. Merge tests now make extra `gh pr checks` and `gh api …/rules` calls. A test that asserts an exact count of `w.gh.calls` should be updated to the new count.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: the merge guard names every blocker; waive post sets aside checks GitHub does not require (R79, R86)"
```

---

### Task 8: No hold after a waiver (finding 29), and post-PR prompts list the whole standing

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (`endRound` guard at line 1851; `advance` post branch at line 2075; the queue in `say` and `holdingPrompts`, lines 393-435)
- Modify: `pr-lifecycle/hooks/core.ts` (`reportPrompt` and `heldPrompt` take an optional `standing`)
- Modify: `pr-lifecycle/tests/world.ts` (`onFetch` may be async)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `reportPrompt(rec, next, standing?: Standing)` and `heldPrompt(rec, why, nextStep, standing?: Standing)`. In the post phase, `holdText(standing, idsAlreadyListed)` is appended before the "Do not merge" lines.
- Produces: `say($, key, text, isNote = false)`. A queued note merges into a prompt queued by the same command (batch) for the same record (used by Task 9).
- Produces: `export function mergeNotes(held: readonly Queued[]): Queued[]`, where `type Queued = { text: string; key: RecordKey; batch: number; isNote?: boolean }`.
- Produces: `export function dropQueued(key: RecordKey): void`: drops undelivered prompts and notes about `key`'s record that earlier commands queued (used by stop and reset in Task 9).

- [ ] **Step 1: Make `onFetch` awaitable** in `tests/world.ts`. Change the type to `onFetch?: () => void | Promise<void>`. Change the handler to async (`on('process.run', async (_$, e) => {`) and call `await w.git.onFetch?.()`.

- [ ] **Step 2: Write the failing tests** (`flow.test.ts`):

```ts
test('R80: a waive post given while a round is finishing is followed by no hold and no new round', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const moved = 'f'.repeat(40)
  w.gh.prHead = moved
  w.git.head = moved
  w.git.isAncestor = true
  w.gh.reviews = covers(moved)
  let waived = ''
  w.git.onFetch = async () => {
    if (waived === '') waived = String((await say($, 'waive post reviewed by hand')).text)
  }
  const prompts = w.prompts.length
  const spawned = w.spawned.length
  await w.clock.advance(30_000)
  await w.clock.advance(1000)
  expect(waived).toContain('waived post-PR review')
  expect((await runOf(w)).status).toBe('waived')
  expect(w.spawned).toHaveLength(spawned)
  const sent = w.prompts.slice(prompts)
  expect(sent.some(one => one.includes('stopped short of ready'))).toBe(false)
  expect(sent.some(one => one.includes('post-PR round'))).toBe(false)
})

test('R80: after waive post, a resume says the waiver covers the head instead of sending the hold', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'waive post the rename is cosmetic')
  await w.clock.advance(1000)
  const prompts = w.prompts.length
  await say($, 'resume')
  await w.clock.advance(1000)
  const sent = w.prompts.slice(prompts)
  expect(sent.some(one => one.includes('stopped short of ready'))).toBe(false)
  expect(sent.at(-1)).toContain("the person's post waiver covers")
})

test('R79: a post-PR hold prompt lists CI next to the findings', async ($, on) => {
  const w = world(on)
  w.gh.checks = [{ name: 'check', status: 'in_progress', conclusion: null }]
  await toAwaiting($, w)
  expect(w.prompts.at(-1)).toContain('check check running')
})
```

The first test relies on `beginTriage` fetching when the PR head moved (`got.prHead !== rec.head`). If the fake doesn't reach that fetch, trace `pollOnce` → `endCollect` → `beginTriage` with the fakes and move `w.gh.prHead` at the point the fetch is reached. The test must make the waiver land while `beginTriage` awaits, then show the late `endRound` doing nothing.

- [ ] **Step 3: Run them to verify they fail.** Expected: FAIL. The late round sends a hold or starts a round; resume sends "stopped short of ready"; the prompt lacks CI.

- [ ] **Step 4: Guard `endRound`.** At the top of `endRound` (round.ts:1851):

```ts
  // A run stopped or waived while this step awaited git or gh records nothing more and decides nothing (finding 29, R80).
  const live = await getRun($)
  if (live === null || live.id !== run.id || live.status !== 'running') return
```

Then check each `endRound` caller (lines 1260, 1464, 1558, 1609, 2231, 2336, 2363) and confirm none calls it after finishing its own run. If one does, call `finish` after `endRound` there instead.

- [ ] **Step 5: `advance` honours a post waiver before it dispatches any work.** In `advance` (round.ts:1972), right after the `isStillMine` check (line 1976) and **before** the first branch that dispatches work (`startRound` at 1993, and later `startAnswer` and `startRecheck`), add:

```ts
  // A post waiver covering this head ends review work for it (R80): checked before any branch that starts triage, a recheck or a round
  // (PR #19 review), so a waived head gets what the waiver covers and what CI still holds, never the hold or more review.
  const waived = rec.phase !== 'pre' && rec.pr !== undefined && securityHolds(rec).length === 0 && rec.waivers.some(one => one.scope === 'post' && one.head === rec.head)
  if (waived && rec.pr !== undefined) {
    const standing = await gatherStanding($, rec, { number: rec.pr, baseRefName: rec.base, headRefOid: rec.head })
    await say($, rec, `pr-gate: the person's post waiver covers PR #${rec.pr} at ${rec.head.slice(0, 7)}.\n\n${holdText(standing)}`)
    return
  }
```

Then, at the end of the post branch, pass the standing to the report: replace `await say($, saved, reportPrompt(saved, next))` with:

```ts
  const pr = saved.pr === undefined ? undefined : { number: saved.pr, baseRefName: saved.base, headRefOid: saved.head }
  await say($, saved, reportPrompt(saved, next, pr === undefined ? undefined : await gatherStanding($, saved, pr)))
```

Add the regression the PR #19 review asked for (`flow.test.ts`; `reopenedApproval` and `KEY` are defined in the file by Task 3):

```ts
test('R80: after waive post, resume starts no triage, recheck or review round on the waived head (PR #19 review)', async ($, on) => {
  for (const [label, over] of [
    ['an open P2 the agent can answer', { status: 'open' }],
    ['a fix awaiting verification', { status: 'reported-fixed' }],
  ] as const) {
    const w = world(on)
    await toPost($, w)
    const rec = await recordOf(w)
    w.store.set(KEY, { ...rec, findings: [{ ...reopenedApproval(), history: [], ...over }] })
    await say($, 'waive post reviewed by hand')
    await w.clock.advance(1000)
    const prompts = w.prompts.length
    const spawned = w.spawned.length
    await say($, 'resume')
    await w.clock.advance(1000)
    expect(w.spawned, label).toHaveLength(spawned)
    const sent = w.prompts.slice(prompts)
    expect(sent.some(one => one.includes('New review feedback') || one.includes('stopped short of ready')), label).toBe(false)
    expect(sent.at(-1), label).toContain("the person's post waiver covers")
  }
})
```

Add a third case where a review round is owed on the waived head: build a record for which `decideNext(rec).kind === 'round'` (assert that precondition in the test before waiving), and expect the same. If two worlds per test are refused, split the cases into separate tests. If `expect` takes no message argument here, drop the labels.

- [ ] **Step 6: Append the standing to post prompts.** In `core.ts` `reportPrompt`, after the "What holds the merge" block:

```ts
  if (standing !== undefined) {
    const rest = holdText(standing, new Set(holding.map(one => one.id)))
    if (rest !== '') lines.push('', rest)
  }
```

Do the same in the post branch of `heldPrompt` (with `holds`). Add the optional `standing?: Standing` parameter to both, and import `holdText` and the type. Where `advance` calls `heldPrompt` for a post record, pass the standing if one was gathered; the pre-PR branch is unchanged.

- [ ] **Step 7: Notes merge only within one command's batch.** The queue is global and flushed a second later, so two commands can queue before one flush (PR #19 review). Each outermost `holdingPrompts` call gets a batch id; entries carry it, the flush sends only its own batch, and merging never crosses batches. Replace `queued`, `holdingPrompts` and `say` (round.ts:393-433) with:

```ts
type Queued = { text: string; key: RecordKey; batch: number; isNote?: boolean }
let holdDepth = 0
let batch = 0
let queued: Queued[] = []

const sameRecord = (a: RecordKey, b: RecordKey): boolean => a.root === b.root && a.branch === b.branch

/** Within one command's batch, an action's note and a prompt for the same record become one prompt: the note's first line leads it (R81). */
export function mergeNotes(held: readonly Queued[]): Queued[] {
  const isPair = (a: Queued, b: Queued): boolean => a.batch === b.batch && sameRecord(a.key, b.key)
  return held.flatMap(one => {
    if (one.isNote === true) return held.some(each => each.isNote !== true && isPair(each, one)) ? [] : [one]
    const note = held.find(each => each.isNote === true && isPair(each, one))
    return [note === undefined ? one : { ...one, text: `${note.text.split('\n')[0] ?? ''}\n\n${one.text}` }]
  })
}

/** Drops what earlier commands queued about `key`'s record and haven't sent: a stop or reset supersedes it (R81, PR #19 review). */
export function dropQueued(key: RecordKey): void {
  queued = queued.filter(one => one.batch === batch || !sameRecord(one.key, key))
}

/** Runs `body` with the prompts it decides held back; once it has returned, its own batch is sent one second later, in order. */
export async function holdingPrompts<T>($: Engine, body: () => Promise<T>): Promise<T> {
  if (holdDepth === 0) batch += 1
  const mine = batch
  holdDepth += 1
  try {
    return await body()
  } finally {
    holdDepth -= 1
    if (holdDepth === 0 && queued.some(one => one.batch === mine)) {
      $.clock.after(1000, () => {
        const held = mergeNotes(queued.filter(one => one.batch === mine))
        queued = queued.filter(one => one.batch !== mine)
        void (async () => {
          for (const one of held) await deliver($, one.key, one.text)
        })()
      })
    }
  }
}

export async function say($: Engine, key: RecordKey, text: string, isNote = false): Promise<void> {
  if (holdDepth > 0) {
    queued.push({ text, key, batch, ...(isNote ? { isNote } : {}) })
    return
  }
  await deliver($, key, text)
}
```

Keep the existing doc comments on `RecordKey`, `deliver` and `say`.

Add a unit test (in `lifecycle.test.ts`, or a new `tests/round.test.ts` if importing `round.ts` there is cleaner):

```ts
test('R81: a note merges into a prompt of the same batch and record only', async () => {
  const a = { root: '/repo', branch: 'feat/x' }
  const b = { root: '/repo', branch: 'feat/y' }
  const out = mergeNotes([
    { text: 'pr-gate: the person allowed 1 more round: x.\n\nmore', key: a, batch: 1, isNote: true },
    { text: 'pr-gate: round prompt', key: a, batch: 1 },
    { text: 'pr-gate: the person stopped the gate.', key: b, batch: 1, isNote: true },
    { text: 'pr-gate: the person reset the lifecycle of feat/x.', key: a, batch: 2, isNote: true },
  ])
  expect(out.map(one => one.text)).toEqual([
    'pr-gate: the person allowed 1 more round: x.\n\npr-gate: round prompt',
    'pr-gate: the person stopped the gate.',
    'pr-gate: the person reset the lifecycle of feat/x.',
  ])
})
```

- [ ] **Step 8: Run the suite.** Expected: PASS. Prompts that assert `toContain` on hold texts still pass because the standing is appended.

- [ ] **Step 9: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/tests
git commit -m "pr-lifecycle: no hold after a waiver, a late round decides nothing, post prompts list CI (R79, R80)"
```

---

### Task 9: Every manual action tells the agent (decision E)

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (add `tellAgent`)
- Modify: `pr-lifecycle/hooks/register.tsx:840-1049` (`logCommand`; the `runCommand` branches stop, reset, allow, waive finding, waive pre, waive post)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `say($, key, text, true)` and `mergeNotes` (Task 8), `gatherStanding` and `holdText` (Tasks 5, 6).
- Produces: `export async function tellAgent($: Engine, key: RecordKey, did: string, next: string, standing?: Standing): Promise<void>`.
- Produces: `const isPerson = (origin: string): boolean => origin === 'composer' || origin === 'bridge' || origin === 'pane'` in `register.tsx`.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`):

```ts
test('R81: waive post tells the agent what it covers and what still holds', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  await say($, 'waive post reviewed by hand')
  await w.clock.advance(1000)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('pr-gate: the person waived post-PR review of PR #1')
  expect(said).toContain('Nothing else holds the merge')
  expect(said).toContain("the merge decision, which is the person's")
})

test('R81: the person\'s stop tells the agent to stop waiting; an agent\'s stop says nothing', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  const prompts = w.prompts.length
  await say($, 'stop', { ...asPerson, origin: { kind: 'sdk' } })
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts)
  await say($, 'resume')
  await w.clock.advance(1000)
  const before = w.prompts.length
  await say($, 'stop')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(before + 1)
  expect(w.prompts.at(-1)).toContain('the person stopped the gate')
  expect(w.prompts.at(-1)).toContain('Stop waiting on it')
})

test('R81: an allow that leads to a prompt sends one message, the action line first', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const prompts = w.prompts.length
  await say($, 'allow 2 more review')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts + 1)
  expect(w.prompts.at(-1)?.startsWith('pr-gate: the person allowed 2 more rounds')).toBe(true)
  expect(w.prompts.at(-1)).toContain('Their options:')
})

test('R81: waiving a finding tells the agent what still holds; a refused waiver sends nothing', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const prompts = w.prompts.length
  await say($, 'waive G9-9 because')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts)
  await say($, 'waive G2-1 the rename lands with KAN-9')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts + 1)
  expect(w.prompts.at(-1)?.startsWith('pr-gate: the person waived G2-1')).toBe(true)
  expect(w.prompts.at(-1)).toContain('ready for the merge decision')
})

test('R81: waive pre tells the agent to open the PR even with openPr off', { options: { openPr: false } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await say($, 'waive pre hotfix for the outage')
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('the person waived the pre-PR review')
  expect(w.prompts.at(-1)).toContain('open the pull request')
})

test('R81: reset tells the agent the lifecycle was archived', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'reset')
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('the person reset the lifecycle of feat/x')
})
```

Check the plugin option name for `openPr` in `pr-lifecycle/.claude-plugin/plugin.json` and `configOf` (round.ts:138). Use whatever key `configOf` reads for `config.openPr`.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL. No messages are sent.

- [ ] **Step 3: `tellAgent`** in `round.ts`, after `say`:

```ts
/** The person's action, told to the agent (R81): what they did, what still holds, and the agent's next step. Queued as a note. */
export async function tellAgent($: Engine, key: RecordKey, did: string, next: string, standing?: Standing): Promise<void> {
  const lines = [`pr-gate: the person ${did}.`]
  if (standing !== undefined) lines.push('', holdText(standing))
  lines.push('', `Your next step: ${next}`)
  await say($, key, lines.join('\n'), true)
}
```

- [ ] **Step 4: Wire the actions** in `register.tsx` `runCommand`. Add `isPerson` near the top of the file.
- **stop** (lines 859-863), replacing the body after the `not running` check:

```ts
    if (isPerson(origin)) await claimRecord($, run.root, run.branch)
    dropQueued(run)
    await finish($, run.id, 'stopped', 'Stopped by the person.')
    if (isPerson(origin)) {
      await tellAgent($, run, 'stopped the gate', 'stop waiting on it. Opening and merging stay held; /pr-gate resume continues it.')
    }
    return `/${COMMAND} stopped. The record stays: /${COMMAND} resume continues it. Opening and merging stay held.`
```

- **reset**: after `archiveLifecycle(...)`:

```ts
    dropQueued({ root, branch })
    await tellAgent($, { root, branch }, `reset the lifecycle of ${branch}: it is archived, its history kept`,
      `nothing for the old review. /${COMMAND} starts a fresh one; opening and merging stay held until it completes.`)
```

- **allow**: right after `updateRecord(... grants ...)`, before `advance`:

```ts
    await tellAgent($, { root, branch }, `allowed ${n} more round${n === 1 ? '' : 's'}: ${reason}`,
      'the gate continues the review. Leave the branch alone until it sends you what needs an answer.')
```

- **waive <findingId>**: after the `sayOpenPr` block, before `return`:

```ts
    const now2 = await loadRecord($, root, branch)
    const pr = now2?.phase !== 'pre' && now2?.pr !== undefined ? { number: now2.pr, baseRefName: now2.base, headRefOid: now2.head } : undefined
    const standing = now2 !== undefined && pr !== undefined ? await gatherStanding($, now2, pr) : undefined
    await tellAgent($, { root, branch }, `waived ${scope}: ${reason}`,
      standing === undefined
        ? 'the pre-PR review continues.'
        : standing.mayProceed
          ? "nothing holds the merge. It is ready for the merge decision, which is the person's: tell them, and do not merge unless they ask."
          : 'answer what is yours in the list above, and leave the rest to who it names.',
      standing)
```

- **waive pre**: replace `await sayOpenPr($, waived, 'waived', now)` with:

```ts
    await sayOpenPr($, waived, 'waived', now)
    await tellAgent($, waived, `waived the pre-PR review of ${branch} at ${head.slice(0, 7)}: ${reason}`,
      `open the pull request for ${branch} → ${waived.base}; the guard lets it through, and post-PR review runs once it opens.`)
```

When `openPr` is on, `sayOpenPr` queues the open-PR prompt and the note merges into its front (Task 8). When it's off, the note goes alone.
- **waive post**: after the reply's `standing` is computed (Task 7, Step 5):

```ts
  await tellAgent($, { root, branch }, `waived post-PR review of PR #${pr?.number ?? '?'} at ${at.slice(0, 7)}: ${reason}`,
    standing === undefined || standing.mayProceed
      ? "nothing else holds the merge. It is ready for the merge decision, which is the person's: tell them, and do not merge unless they ask."
      : 'the waiver covers the review only: wait for what is listed, then tell the person.',
    standing)
```

- **resume** sends no note. Its restarted step's prompt says what it needs.

- [ ] **Step 4b: The regression for superseded prompts** (PR #19 review), in `flow.test.ts`:

```ts
test('R81: a reset before the flush drops the earlier command\'s open-PR prompt and keeps its own note (PR #19 review)', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  const prompts = w.prompts.length
  await say($, 'waive pre hotfix for the outage')
  await say($, 'reset')
  await w.clock.advance(1000)
  const sent = w.prompts.slice(prompts)
  expect(sent.some(one => one.includes('open the pull request'))).toBe(false)
  expect(sent.at(-1)).toContain('the person reset the lifecycle')
})
```

- [ ] **Step 5: Log the pane as the person.** In `logCommand` (line 843), replace `(origin !== 'composer' && origin !== 'bridge')` with `!isPerson(origin)`. In `runCommand` line 866, keep `waive`, `allow` and `reset` to `composer` and `bridge` as today. `pane` gains them in wave 3, when its links exist.

- [ ] **Step 6: Run the suite.** Expected: PASS. Existing tests that count prompts after a person's command may now see one more message. Update those counts only where the new message is the intended R81 note, and keep each test's own assertion about the text it checks.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/tests
git commit -m "pr-lifecycle: every manual action tells the agent what happened and what to do next (R81)"
```

---

### Task 10: The pane's Stop goes through the command

**Files:**
- Modify: `pr-lifecycle/hooks/pane.tsx:86` (`renderPane` signature), `:230-234` (the Button)
- Modify: `pr-lifecycle/hooks/register.tsx:1176-1186` (the `ui.render` handler)
- Test: `pr-lifecycle/tests/gate.test.ts`

**Interfaces:**
- Produces: `renderPane($, e, run, rec, now, actions: { stop: () => Promise<void> })`.

- [ ] **Step 1: Write the failing test** (append to `gate.test.ts`):

```ts
test('R81: the pane\'s Stop runs /pr-gate stop: logged as the person, and the agent is told', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  const ui = await $.ui.mount({
    plugin: 'pr-lifecycle',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pr-lifecycle',
    props: { title: 'PR lifecycle', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { top: 0, bodyRows: 40, rows: 40 } as never, view: {} as never },
  })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  await w.clock.advance(1000)
  expect((await runOf(w)).status).toBe('stopped')
  expect(w.prompts.at(-1)).toContain('the person stopped the gate')
  expect((await recordOf(w)).log?.some(one => one.kind === 'person' && one.text.includes('/pr-gate stop'))).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL. No prompt, no log line.

- [ ] **Step 3: Implement.** In `pane.tsx`, add the parameter `actions: { stop: () => Promise<void> }` to `renderPane`, and change the Button:

```tsx
          <Button key="stop" label="Stop the gate" onPress={() => void actions.stop()} />
```

Drop `finish` from the pane's import from `./round` if nothing else uses it, and update the file's header comment: the Stop button runs `/pr-gate stop`.

In `register.tsx`, in the `ui.render` handler:

```tsx
    // The pane's Stop is the person's /pr-gate stop (R81): the owner check, the log line and the agent's message come with it.
    const stop = async (): Promise<void> => {
      const text = await holdingPrompts($, () => runCommand($, 'stop', 'pane'))
      await logCommand($, 'stop', text, 'pane').catch(() => undefined)
    }
    return renderPane($, e, run, rec, now, { stop })
```

- [ ] **Step 4: Run the suite.** Expected: PASS, including the existing pane test at `gate.test.ts:391`.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/pane.tsx pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/gate.test.ts
git commit -m "pr-lifecycle: the pane's Stop runs /pr-gate stop, so it is logged and the agent is told (R81)"
```

---

### Task 12: A hold on a chained command says nothing in it ran (R87, spec §5a)

Added 2026-10-20 from live use (cookbook PRs #3732, #3741). Run it after Task 10 and before Task 11, so Task 11 records R87 with the rest.

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (add `hasOtherSteps`, next to `readBash`)
- Modify: `pr-lifecycle/hooks/register.tsx` (the `tool.call` hook and its `.catch`)
- Test: `pr-lifecycle/tests/github.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `export function hasOtherSteps(command: string): boolean` (`github.ts`).

- [ ] **Step 1: Write the failing unit test** (`github.test.ts`, import `hasOtherSteps`):

```ts
test('R87: hasOtherSteps sees steps chained with a PR command, not text inside quotes, $(…) or a heredoc body', async () => {
  expect(hasOtherSteps('gh pr create --base dev --title "a; b && c"')).toBe(false)
  expect(hasOtherSteps('gh pr create --base dev --body "$(cat body.md)"')).toBe(false)
  expect(hasOtherSteps('cd /repo && gh pr create --base dev')).toBe(false)
  expect(hasOtherSteps("gh pr create --base dev --body-file - <<'EOF'\nline one; two\nEOF")).toBe(false)
  expect(hasOtherSteps("cat > body.md <<'EOF'\nSummary\nEOF\ngh pr create --base dev --body-file body.md")).toBe(true)
  expect(hasOtherSteps('git push -u origin HEAD && gh pr create --base dev')).toBe(true)
  expect(hasOtherSteps('gh pr merge 1 --squash; git checkout dev')).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL, `hasOtherSteps` not exported.

- [ ] **Step 3: Implement** (`github.ts`, after `readBash`):

```ts
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
```

- [ ] **Step 4: Write the failing flow test** (`flow.test.ts`):

```ts
test('R87: a hold on a chained command says nothing in it ran; a lone PR command gets no such line', async ($, on) => {
  world(on)
  const chained = { tool: 'Bash' as const, command: `cat > /tmp/body.md <<'EOF'\nSummary\nEOF\n${createPr.command} --body-file /tmp/body.md` }
  const held = await $.tool.call(chained)
  expect(isHeld(held)).toBe(true)
  expect(held.deny ?? '').toContain('Nothing in this Bash command ran')
  expect(held.deny ?? '').toContain('Write tool')
  const lone = await $.tool.call(createPr)
  expect(isHeld(lone)).toBe(true)
  expect(lone.deny ?? '').not.toContain('Nothing in this Bash command ran')
  const chainedMerge = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --squash && git checkout dev' })
  expect(isHeld(chainedMerge)).toBe(true)
  expect(chainedMerge.deny ?? '').toContain('Nothing in this Bash command ran')
})
```

If the first chained create starts the round and the lone create is then held for the running round, that's the intended setup. If the chained merge isn't held in this state, drive the world to post-PR the way the neighbouring merge tests do, and say so in the report.

- [ ] **Step 5: Wire it into the `tool.call` hook** (`register.tsx`). Import `hasOtherSteps` from `./github`. Add near `asHold`:

```ts
/** The line a hold on a chained Bash command ends with (R87): nothing in it ran, so the agent redoes the other steps on their own. */
const CHAINED =
  '\nNothing in this Bash command ran: a hold refuses the whole command, so the steps chained with the PR command did not run either. ' +
  'Run those on their own (write a PR body file with the Write tool), and keep the PR command in a Bash call by itself.'

/** What a refusal adds for this call: the R87 line when it is a Bash command with other steps. */
const chainedOf = (tool: string, e: unknown): string => {
  const command = (e as Record<string, unknown>).command
  return tool === 'Bash' && typeof command === 'string' && hasOtherSteps(command) ? CHAINED : ''
}
```

In the `tool.call` handler, after `if (action === undefined) return next(e)`, compute `const tail = chainedOf(String(e.tool), e)` and append `tail` to every `asHold(…)` the handler returns: the merge refusal, `outsideText`, `noBaseText` and the create refusal. In the `.catch` handler, append `chainedOf(String(e.tool), e)` to its `asHold(…)` too. The R77 opening stays first; the line goes last.

- [ ] **Step 6: Run the suite.** Run: `claude plugin test pr-lifecycle`. Expected: PASS. An existing test that asserts a hold's whole text with `toBe` on a chained command needs the line added; say which in the report.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/github.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: a hold on a chained Bash command says nothing in it ran (R87)"
```

---

### Task 11: Rulings, docs and version 1.4.0

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md` (append R79-R87)
- Modify: `LIFECYCLE_SPEC.md`, `CLAUDE.md`, `README.md`, `pr-lifecycle/README.md`, `pr-lifecycle/.claude-plugin/plugin.json`, `ROADMAP.md`

- [ ] **Step 1: Rulings.** Append to the rulings doc, after R78, one line each, in the doc's own form ("- Ruling R79 (…): … — cost if wrong: …"):
  - **R79** (findings 27, 28): one standing (`standingOf`) lists every blocker between a head and its merge, with owner and release. The guard's refusal and the post-PR prompts render the rest of it after what they already name. Cost if wrong: longer hold texts.
  - **R80** (amends R62; finding 29): a post waiver covering the head ends review holds for it; `advance` says what it covers instead. A run stopped or waived while a step awaited makes `endRound` do nothing. Cost if wrong: a waived head no longer gets a reminder of open findings.
  - **R81** (Adam, decision E): every manual action by the person (`waive pre|post|<id>`, `allow`, `stop`, `reset`, and the pane's Stop) ends with one agent message through `say()`. A note and a prompt the same command queues for the same record become one message, the note's line first. An agent's own `stop` sends nothing. Cost if wrong: one extra message per action.
  - **R82** (amends R32, R34, R36, R40; finding 21; Adam: every unresolved thread gets a reply and/or a fix, as the PR guidance and tool-use hooks required before the gate): triage carries open findings by the round raised in. `acknowledged` ("asks for no change") counts only with a `replyId`, on a GitHub finding with no security flag and no explicit P0-P2. It is stored as a rebuttal noted "No change requested:", and Codex checks it. Cost if wrong: a Codex check for a plain approval note.
  - **R83** (Adam, decision J, narrowed by review G2-2 on PR #19): a review is no finding only on positive no-action evidence (`isNoAction`). Settled reviews are logged as `approval`. Cost if wrong: a no-action review the classifier misses goes to triage.
  - **R84** (findings 11, 21): a triaged severity replaces one guessed from a comment's words, up or down, recorded in the history. A reviewer's tag and Codex's severity are never lowered. A reviewer's advisory label reads as a P3 tag. Cost if wrong: an agent lowers a guessed P2 to P3.
  - **R85** (amends R42; Adam, decision I): a P3 deferral with a `followUp`, not security, settles without a waiver. Cost if wrong: a P3 the person would have wanted to see.
  - **R86** (amends R1-9; Adam, decision K; finding 28): required checks come from the base's rulesets and classic protection, failing closed when unreadable. A post waiver sets aside every other check, named. Cost if wrong: a check that should have blocked goes unnoticed under a waiver.
  - **R87** (live use, cookbook PRs #3732 and #3741): a hold on a Bash command that does more than its PR action ends by saying nothing in it ran, and asks for the other steps on their own and the PR command alone. The command is never rewritten to run part of it. Cost if wrong: one extra line on a hold.

- [ ] **Step 2: LIFECYCLE_SPEC.md.** In its dispositions and waiver sections, add `acknowledged` (replied, Codex-checked), `followUp` for P3 deferrals, approvals that settle on positive no-action evidence, and `waive post`'s reach over checks GitHub doesn't require.

- [ ] **Step 3: Version 1.4.0, together:**
  - `pr-lifecycle/.claude-plugin/plugin.json`: `"version": "1.4.0"`;
  - the version line in `pr-lifecycle/README.md`;
  - the component table in the root `README.md`.

- [ ] **Step 4: CLAUDE.md "Current state".**
  - Change `pr-lifecycle/` to **1.4.0**, and the rulings range to R1-R87.
  - Update the test count (run `npm run test` and copy the pr-lifecycle number).
  - Remove the open follow-up "a failing optional CI check holds a pr-lifecycle merge, with no waiver" (R86 resolves it).
  - In ROADMAP.md, set wave 2a's status line to "built on `wave2a/pr-lifecycle-1.4.0` (rulings R79-R87)".

- [ ] **Step 5: Full check**

Run from the repo root: `npm run check`
Expected: lint, both test suites, validate and typecheck all pass. Typecheck needs `pr-lifecycle/.claude-plugin/types/`, which a session with the mod loaded generates. If they're missing, say so in the PR body instead of skipping silently.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md LIFECYCLE_SPEC.md CLAUDE.md README.md pr-lifecycle/README.md pr-lifecycle/.claude-plugin/plugin.json ROADMAP.md
git commit -m "pr-lifecycle 1.4.0: rulings R79-R87, spec, docs and version"
```

---

## After the tasks

- Push the branch. The PR is opened by the main session, gated by the loaded 1.3.0. Adam fast-tracks it.
- The PR body carries the summary, the rulings list, the test count, and the line "Pre-PR Codex gate: …" if the gate adds one.
- The gated PR is wave 1's first live run: once it merges, `/pr-gate log` on the branch gives the numbers for ROADMAP.
