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

