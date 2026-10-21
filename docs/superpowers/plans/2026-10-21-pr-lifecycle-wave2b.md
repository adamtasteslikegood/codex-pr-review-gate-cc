# pr-lifecycle 1.5.0 (wave 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gate takes the person out of babysitting the PR. The agent answers feedback while reviewers are still collecting, each push is its own round, and only a round that finds something new costs one. Collection ends on GitHub's own signals. One problem is one finding. The gate never reads its own replies. Where 1.4.0 asked for a waiver, the gate files a GitHub issue, but only after the rounds. When nothing holds the merge, the agent merges.

**Architecture:**
- Pure decisions stay in `hooks/lifecycle.ts`: charging, linking, settling by issue, the late-blocker grant, and the issue title and body. Parsers stay in `hooks/github.ts`: tags, `collectionDone` with signals, and check-run start times. Async work stays in `hooks/round.ts`: polling, triage while collecting, rollover, and the filing pass.
- **The post-PR round state machine (1.5.0):**

  ```
  beginCollect(head H) ──► phase 'collect' ◄─────────────────────────────────┐
     │  every POLL_MS: pollOnce                                               │
     │   ├─ PR head moved to H' (fresh roundStartHead check)                  │
     │   │    → rollover: close round on H (isCharged computed), open the     │
     │   │      next round on H' (baseline / discretionary / final-head-check)│
     │   │      keep pending triage + run.findings, reset timers and cap ─────┘
     │   ├─ fresh unasked feedback, one quiet poll since the last arrival,
     │   │  no triage turn in flight → triage turn (phase stays 'collect',
     │   │  pending role 'triage'); answers recorded by afterTriage without
     │   │  ending the round; turn end re-requests roster reviewers once if the
     │   │  head moved since the last request
     │   └─ collectionDone(signals) && no pending && nothing fresh unasked
     │        → endCollect: Codex fallback from diffBase if the head is
     │          uncovered, then the end-of-head triage (1.4.0 ending: checks,
     │          endRound, advance)
     ▼
  advance → decideNext
     ├─ round / ready / blocked: as 1.4.0 (ready now says "merge now")
     └─ exhausted / awaiting-decision (post):
          fileIssues: 1) a blocker first raised in the last completed round and
          gate grants < 2 → grant by 'gate', start a round; else 2) file or
          label an issue for every non-security held finding → settle → decide
          again (ready → the agent merges)
  ```
- Charging (R88) is post-PR only: a pre-PR round is always charged, as in 1.4.0.
- A triage turn during collection reuses `askTriage`/`afterTriage`. `afterTriage` gets a `midCollect` flag that skips the round's ending.
- Everything else is additive. Where behaviour deliberately changes (R85's early P3 settle, the ready prompt, waivers for non-security findings, the quiet window), the old tests are updated in the task that changes it.

**Tech Stack:**
- TypeScript 6.0.3, as a Claude Code plugin (`claude-code` engine API).
- Tests run through `claude plugin test` with the fakes in `pr-lifecycle/tests/world.ts`.
- ESLint with `@stylistic`.

**Spec:** `docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md`, including the M2 amendment and §7.4 (#24). Read it first. Then read `CLAUDE.md` (repo rules) and the rulings doc `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md` (R1-R87). This plan adds R88-R94.

## Global Constraints

- Work on branch `wave2b/pr-lifecycle-1.5.0`. Make it from `main` once the docs PR for `docs/wave2b` has merged, or from `docs/wave2b` if it hasn't.
- Never touch `codex-gate/` (frozen at 0.3.1).
- Hand style: no semicolons, single quotes, lines up to about 160 columns. **Never run Prettier or `eslint --fix`**; edit surgically.
- Never commit `pr-lifecycle/.claude-plugin/types/` (generated, gitignored). `pr-lifecycle/types/index.d.ts` is tracked and holds the record types.
- Don't use a bare `npx tsc`. Use `npm run typecheck` from the repo root.
- Never run a Bash command whose text contains the literal PR-create command line. The loaded gate refuses it even inside a grep or a string. Build such strings from pieces. The gate files issues with `gh api -X POST repos/<slug>/issues`.
- Commit after each task. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1
  ```
- Run the suite with `claude plugin test pr-lifecycle` from the repo root (about 504 tests before this wave). Before the last task, `npm run check` from the repo root must pass.
- Every refusal of a PR create or merge still starts with "pr-gate HOLD (not an error):" (R77). Prompts never start with `/` (R21).
- An agent prompt never gives the person's command as the agent's own step (R42, R49). Security findings still wait for the person's waiver (spec §5.4).
- Severity names: P0 Blocker, P1 Critical, P2 Major, P3 Minor. Label colours as R85: P0 `b60205`, P1 `d93f0b`, P2 `fbca04`, P3 `0e8a16`.
- Late-blocker rounds the gate adds: at most **2** per lifecycle.
- `mergeMethod` values: `merge` (default), `squash`, `rebase`.

## Review Focus

1. **Resume after a reviewer already commented (#24).** A roster reviewer's issue comment (no `commit_id`) posted after the push but before `/pr-gate resume` still covers the head. The round must not wait out the cap. Test in Task 4.
2. **This machine's login in `requested_reviewers`.** The person may request a review from themselves (the same gh login as `self`). The gate must not wait for that review. Test in Task 5.
3. **Two pushes between two polls.** The gate sees only the last head. It must close one round on the old head and open one on the newest, never one round per commit, and must not crash on the commit it never saw. Test in Task 9.
4. **An answer that names a finding raised in a round that has since rolled over.** The agent answers G3-2 after its push ended round 3. The answer applies to G3-2, and it is not dropped as unasked. Test in Task 9.
5. **A linked duplicate whose original is security.** The linked item holds with the original. It is never filed as an issue, because the original is security and needs the person. Test in Task 12.

---
## File Map

| File | What changes |
| --- | --- |
| `pr-lifecycle/types/index.d.ts` | `FindingEvent.answer`, `FindingEvent.deferral`, `FindingEvent.link`; `Finding.duplicateOf`, `Finding.issueError`; `RoundRecord.isCharged`; `Grant.by`; `LifecycleRecord.ownReplies`; `Run.requestedHead`, `Run.isMidCollect` |
| `pr-lifecycle/hooks/github.ts` | `severityHint` tag forms (Task 1); `Check.startedAt` (Task 4); `collectionDone` signals and `readRequested` (Task 5) |
| `pr-lifecycle/hooks/lifecycle.ts` | `isAcknowledged` (Task 2); charging (Task 6); linking (Task 7); deferral check (Task 11); settling by issue, the late-blocker grant, `issueTitle`/`issueBody` (Task 12) |
| `pr-lifecycle/hooks/core.ts` | `replyIdsOf` (Task 3); triage prompt wording (Tasks 7, 8); `readyPrompt(rec, method)` (Task 13) |
| `pr-lifecycle/hooks/round.ts` | `fetchFeedback` (Tasks 3, 4, 5); `pollOnce`, triage during collection, rollover (Tasks 8, 9); re-requests (Task 10); `fileIssues` (Task 12); config (Tasks 12, 13) |
| `pr-lifecycle/hooks/register.tsx` | status text for issues (Task 12) |
| `pr-lifecycle/tests/world.ts` | knobs: `commitDate`, `requested`, `posted`, `issueAnswer`, `issueNumber` |
| `pr-lifecycle/tests/*.test.ts` | the tests in each task |
| docs | rulings R88-R94, LIFECYCLE_SPEC.md, ROADMAP.md, READMEs, CLAUDE.md (Task 15) |

Run one test file while working on a task: `claude plugin test pr-lifecycle -- tests/github.test.ts` (from the repo root). Run the whole suite before each commit: `claude plugin test pr-lifecycle`.

---

### Task 1: Severity tags are standalone tokens (R94, spec §7.1)

**Why:** `severityHint` reads any `P0`-`P3` word anywhere as the reviewer's tag. On PR #20 the gate's own reply "Same as G7-2 [P2 thread]" came back tagged P2, and a tagged P2 may not be acknowledged (R82).

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (`severityHint`, about line 214)
- Test: `pr-lifecycle/tests/github.test.ts`

**Interfaces:**
- Produces: `severityHint(body)` keeps its signature `{ severity: Severity; isSecurity: boolean; isTagged: boolean }`. Only what counts as `isTagged: true` changes.

- [ ] **Step 1: Write the failing test**

Append to `pr-lifecycle/tests/github.test.ts`:

```ts
test('R94: a tag is a token standing alone; any other P0-P3 mention is a hint', async () => {
  for (const body of ['[P2] the cache is never cleared', '(P2) the cache is never cleared', '**P2** the cache', '**P2:** the cache', 'P2: the cache',
    'P2 - the cache', '  - P2: the cache', '1. P2: the cache', '![P2 Badge](https://img.shields.io/badge/P2-yellow) the cache', 'Intro line\nP2: the cache']) {
    expect(severityHint(body)).toEqual({ severity: 'P2', isSecurity: false, isTagged: true })
  }
  // The gate's own words on PR #20: a mention, not the reviewer's tag.
  expect(severityHint('Same as G7-2 [P2 thread]: fixed in abc1234')).toEqual({ severity: 'P2', isSecurity: false, isTagged: false })
  expect(severityHint('supersedes the outstanding P2')).toEqual({ severity: 'P2', isSecurity: false, isTagged: false })
  expect(severityHint('P2s are fine here')).toMatchObject({ isTagged: false })
  // The most severe tag still wins, and a tag beats a mention.
  expect(severityHint('[P3] tidy\n- P1: the token leaks into logs')).toMatchObject({ severity: 'P1', isTagged: true })
  expect(severityHint('[P3] tidy; see the earlier P1')).toMatchObject({ severity: 'P3', isTagged: true })
  // A security mention never reads below P2 unless the reviewer tagged it.
  expect(severityHint('this was a P3 but it leaks a secret')).toEqual({ severity: 'P2', isSecurity: true, isTagged: false })
  expect(severityHint('[P3] the secret name is misspelt')).toEqual({ severity: 'P3', isSecurity: true, isTagged: true })
})
```

In the existing test `R84: a reviewer's advisory label reads as a P3 tag; an explicit P0-P2 anywhere wins`, change the line

```ts
  expect(severityHint('supersedes the outstanding P2')).toMatchObject({ severity: 'P2', isTagged: true })
```

to

```ts
  // A mention in a sentence is a hint since R94.
  expect(severityHint('supersedes the outstanding P2')).toMatchObject({ severity: 'P2', isTagged: false })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `claude plugin test pr-lifecycle -- tests/github.test.ts`
Expected: FAIL in the R94 test ("[P2 thread]" reads `isTagged: true`) and in the changed R84 line.

- [ ] **Step 3: Implement**

In `pr-lifecycle/hooks/github.ts`, above `severityHint`, add:

```ts
/**
 * A reviewer's own severity tag (R94): a token standing alone. `[P2]`, `(P2)`, `**P2**` or `**P2:**` anywhere; `P2:` or `P2 -` at the
 * start of a line, after a list marker; or a badge image named for it (`![P2 Badge]`, as Codex's connector posts). Any other mention,
 * such as "[P2 thread]" or "the outstanding P2", is a hint the agent may change.
 */
const TAG = /\[P([0-3])\]|\(P([0-3])\)|\*\*P([0-3]):?\*\*|!\[P([0-3])[ _-]?Badge\]|^[ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+)?P([0-3])(?::|[ \t]+-[ \t])/gim
```

Replace the body of `severityHint` with:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle -- tests/github.test.ts`
Expected: PASS.

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A flow test whose review body names a severity in a sentence (not one of the tag forms) may now read it as a hint. Change such a test only if its body is a mention in prose; then make it a tag form (`P1: ...` or `**P1** ...`) so it still tests what it tested, and list each change in your report.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/tests/github.test.ts
git commit -m "pr-lifecycle 1.5.0: a severity tag is a token standing alone (R94)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 2: Acknowledgements are named as such (R94, spec §7.2)

**Why:** an `acknowledged` answer is stored as a rebuttal (R82), so every hold says "rebuttal not yet accepted" about a comment the agent only acknowledged.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`FindingEvent`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`applyAnswer` about line 163, `blockerOf` about line 525, `decidePost`'s `recheck` about line 806)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Produces: `FindingEvent.answer?: 'acknowledged'`; `export const isAcknowledged = (f: Finding): boolean` in `lifecycle.ts`.

- [ ] **Step 1: Write the failing test**

Add `isAcknowledged` to the import list from `'../hooks/lifecycle'` at the top of `pr-lifecycle/tests/lifecycle.test.ts`, then append (after the `postRec` helper is defined, so at the end of the file):

```ts
test('R94: an acknowledgement is named as one in the history, the standing and the recheck', async () => {
  const comment = (id: string, severity: 'P2' | 'P3') => finding({ id, round: 2, source: 'github', reviewer: 'bot', severity, severitySource: 'hint' })
  const ack = applyAnswer(comment('G2-1', 'P3'), { id: 'G2-1', action: 'acknowledged', note: 'No change requested: a status note' }, 2, 'main', 5)
  expect(ack.status).toBe('rebutted')
  expect(ack.history.at(-1)).toMatchObject({ status: 'rebutted', answer: 'acknowledged' })
  expect(isAcknowledged(ack)).toBe(true)
  const argued = applyAnswer(comment('G2-2', 'P2'), { id: 'G2-2', action: 'rebutted', note: 'see src/app.ts:3' }, 2, 'main', 5)
  expect(isAcknowledged(argued)).toBe(false)
  const blockers = standingOf(postRec({ findings: [ack, argued] }), { head: 'a', base: 'dev' }).blockers
  expect(blockers.find(one => one.id === 'G2-1')?.said).toBe('G2-1 [P3] comment from bot: acknowledgement not yet confirmed')
  expect(blockers.find(one => one.id === 'G2-2')?.said).toBe('G2-2 [P2] comment from bot: rebuttal not yet accepted')
  const next = decideNext(postRec({ findings: [ack] }))
  expect(next).toMatchObject({ kind: 'blocked', recheck: ['G2-1'], nextStep: 'run /pr-gate resume: Codex checks the acknowledgement on this head, using no review round' })
  expect((next as { why: string }).why).toBe('Codex has not checked the acknowledgement of G2-1 on a')
  // Codex reopening it ends the acknowledgement; a later rebuttal is a rebuttal.
  const reopened = markHeld(ack, 2, 'codex', 6, 'it asks for a change')
  expect(isAcknowledged(reopened)).toBe(false)
  expect(isAcknowledged(applyAnswer(reopened, { id: 'G2-1', action: 'rebutted', note: 'see src/app.ts:9' }, 2, 'main', 7))).toBe(false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts`
Expected: FAIL: `isAcknowledged` is not exported.

- [ ] **Step 3: Implement**

In `pr-lifecycle/types/index.d.ts`, add to `FindingEvent` after `lowering?`:

```ts
  /** The answer as the agent gave it, when the status alone does not say: an acknowledgement is stored as a rebuttal (R82, R94). */
  answer?: 'acknowledged'
```

and extend its doc comment's first line with: `` `answer`: an acknowledgement, stored as a rebuttal (R94). ``

In `pr-lifecycle/hooks/lifecycle.ts`, in `applyAnswer`, replace

```ts
  const history =
    severity === f.severity ? next.history : next.history.map((one, i) => (i === next.history.length - 1 ? { ...one, severity, from: f.severity } : one))
```

with

```ts
  const last = next.history.length - 1
  const history = next.history.map((one, i) =>
    i !== last
      ? one
      : { ...one, ...(severity === f.severity ? {} : { severity, from: f.severity }), ...(a.action === 'acknowledged' ? { answer: 'acknowledged' as const } : {}) },
  )
```

Below `applyAnswer`, add:

```ts
/** A rebuttal that is the agent's acknowledgement of a comment asking for no change (R82): named as such in every text (R94). */
export const isAcknowledged = (f: Finding): boolean => f.status === 'rebutted' && f.history.filter(one => one.by !== 'codex').at(-1)?.answer === 'acknowledged'
```

In `blockerOf`, replace the `rebuttal-unchecked` return with:

```ts
    const what = isAcknowledged(f) ? 'acknowledgement not yet confirmed' : 'rebuttal not yet accepted'
    return { kind: 'rebuttal-unchecked', id: f.id, said: `${tag}: ${what}`, owner: 'codex', release: "the gate's Codex check rules on it" }
```

In `decidePost`'s `recheck`, replace

```ts
    const rebuttals = unchecked.filter(one => !isReverifyOwed(one) && !isLoweringOwed(one))
    const reverify = unchecked.filter(isReverifyOwed)
    const said = [
      ...(rebuttals.length === 0 ? [] : [`Codex has not checked the rebuttal of ${ids(rebuttals)} on ${last.endHead.slice(0, 7)}`]),
```

with

```ts
    const answered = unchecked.filter(one => !isReverifyOwed(one) && !isLoweringOwed(one))
    const acks = answered.filter(isAcknowledged)
    const rebuttals = answered.filter(one => !isAcknowledged(one))
    const reverify = unchecked.filter(isReverifyOwed)
    const said = [
      ...(rebuttals.length === 0 ? [] : [`Codex has not checked the rebuttal of ${ids(rebuttals)} on ${last.endHead.slice(0, 7)}`]),
      ...(acks.length === 0 ? [] : [`Codex has not checked the acknowledgement of ${ids(acks)} on ${last.endHead.slice(0, 7)}`]),
```

and replace the `what` line with:

```ts
    const kinds = [rebuttals, acks, lowered, reverify].filter(one => one.length > 0)
    const what =
      kinds.length !== 1 ? 'them' : rebuttals.length > 0 ? 'the rebuttal' : acks.length > 0 ? 'the acknowledgement' : lowered.length === 1 ? 'the lowering' : 'them'
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. If an existing test expects "the rebuttal" for a recheck that mixes kinds, check it against the new `what`: one kind keeps its old words, mixed kinds say "them" as before.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/tests/lifecycle.test.ts
git commit -m "pr-lifecycle 1.5.0: an acknowledgement is named as one, not as a rebuttal (R94)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 3: The gate never reads its own replies (R91, spec §4)

**Why:** `afterTriage` records a reply only for an accepted answer on a GitHub finding. On PR #20 a reply about a Codex-only finding (G7-4, G11-2) and the reply of a dropped answer (G7-9, G7-10) came back as new items.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`LifecycleRecord`)
- Modify: `pr-lifecycle/hooks/core.ts` (new `replyIdsOf`, next to `readTriage`)
- Modify: `pr-lifecycle/hooks/round.ts` (`fetchFeedback` about line 1166, `afterTriage` about line 1575, the fix step's answer handler about line 2642)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `LifecycleRecord.ownReplies?: string[]` (comment ids, as `replyIdOf` reads them). `export function replyIdsOf(answer: string): string[]` in `core.ts`.
- Note: `Fetched.ownReplies` in `round.ts` is a different thing (an inline thread's reviewer comment to this machine's reply in it, R38). Leave it as it is.

- [ ] **Step 1: Write the failing test**

Add `untriagedFeedback` to the imports from `'../hooks/round'` in `pr-lifecycle/tests/flow.test.ts` if it is not imported yet. Append:

```ts
test('R91: every reply id the agent reports is the gate\'s own, whatever the answer, and never comes back as feedback (PR #20 G7-4, G7-9, G11-2)', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  const mine = (id: number, body: string) => ({ id, user: { login: 'me' }, body, created_at: '1970-01-01T00:02:00Z', html_url: `c${id}` })
  w.gh.issueComments = [
    mine(77, 'Same as G7-2 [P2 thread]: no change asked'),
    mine(79, 'Round 2: R1-9 rebutted, see src/app.ts:4'),
    mine(81, 'Thanks, noted'),
    // The person's own note, under the same gh login: still feedback.
    mine(80, 'Please also rename the flag'),
  ]
  await done($, triaged('r2-triage', [
    { id: 'G2-1', action: 'fixed', note: 'parameterised' },
    // A Codex finding: no GitHub item, so 1.4.0 recorded no reply.
    { id: 'R1-9', action: 'rebutted', note: 'not reachable', replyId: '79' },
    // A P1 may not be acknowledged (R82): the answer is dropped, its reply is still the gate's.
    { id: 'G2-1', action: 'acknowledged', note: 'nothing asked', replyId: 'https://github.com/me/repo/pull/1#issuecomment-77' },
    // Not an answer the gate can read at all: its reply is still the gate's.
    { id: 'G2-1', action: 'thanks', replyId: 81 },
  ]))
  const rec = await recordOf(w)
  expect(rec.ownReplies).toEqual(['79', '77', '81'])
  expect((await untriagedFeedback(w.engine, rec))?.map(one => one.id)).toEqual(['comment:80'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: FAIL: `ownReplies` is undefined, and comments 77, 79 and 81 come back.

- [ ] **Step 3: Implement**

In `pr-lifecycle/types/index.d.ts`, add to `LifecycleRecord` after `replies`:

```ts
  /** Every reply id the agent reported, in any step and for any answer, accepted or not (R91): never read back as feedback. */
  ownReplies?: string[]
```

In `pr-lifecycle/hooks/core.ts`, below `readTriage`, add:

```ts
/** Every reply id in an answer's trailer, whatever its answer and whether or not the answer reads (R91), as comment ids. */
export function replyIdsOf(answer: string): string[] {
  const listed = readTrailer(answer)?.dispositions
  if (!Array.isArray(listed)) return []
  return listed.flatMap(one => {
    const raw = (one as { replyId?: unknown } | null)?.replyId
    return typeof raw === 'string' && raw.trim() !== '' ? [replyIdOf(raw)] : typeof raw === 'number' && Number.isFinite(raw) ? [String(raw)] : []
  })
}
```

In `pr-lifecycle/hooks/round.ts`, import `replyIdsOf` from `./core`, and add this helper next to `afterTriage`:

```ts
/** Keeps every reply id an answer reported as the gate's own (R91), in the order given, once each. */
const withOwnReplies = (rec: LifecycleRecord, answer: string): Pick<LifecycleRecord, 'ownReplies'> => {
  const ids = replyIdsOf(answer)
  return ids.length === 0 ? {} : { ownReplies: [...new Set([...(rec.ownReplies ?? []), ...ids])] }
}
```

In `afterTriage`, in the `updateRecord` call that sets `processed` and `replies`, add after `...one,`:

```ts
    ...withOwnReplies(one, run.pending[0]?.answer ?? ''),
```

In the fix step's handler (the function that calls `readDispositions(run.pending[0]?.answer ?? '')`, about line 2642), find its `updateRecord` call and add the same line there, after `...one,`. If that handler has no `updateRecord` call before it moves on, add one right after `const said = readDispositions(...)`:

```ts
  const answer = run.pending[0]?.answer ?? ''
  if (replyIdsOf(answer).length > 0) await updateRecord($, run.root, run.branch, one => ({ ...one, ...withOwnReplies(one, answer) }))
```

In `fetchFeedback`, replace

```ts
    const replied = new Set(Object.values(rec.replies).map(replyIdOf))
    const isReply = (one: Feedback): boolean =>
      one.kind === 'inline' ? one.threadId !== one.id.slice('inline:'.length) : replied.has(one.id.slice(one.id.indexOf(':') + 1))
```

with

```ts
    // Every reply the agent reported is the gate's own, whatever its answer (R91).
    const replied = new Set([...Object.values(rec.replies).map(replyIdOf), ...(rec.ownReplies ?? [])])
    const isReply = (one: Feedback): boolean =>
      (one.kind === 'inline' && one.threadId !== one.id.slice('inline:'.length)) || replied.has(one.id.slice(one.id.indexOf(':') + 1))
```

and update the comment above it to say "a comment whose id is a recorded reply or one the agent reported (R91)".

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/core.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: every reply id the agent reports is the gate's own (R91)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 4: A head's time is when it reached the PR (#24, spec §7.4)

**Why:** `beginCollect` sets `collect.headAt` to the time collection began, and an issue comment (no `commit_id`) counts for the head only from then on. After `/pr-gate resume`, a roster reviewer's comment already on the head stops counting and the round waits out the 20-minute cap (PR 3749, 2026-10-21; issue #24).

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (`Check`, `readCheckRuns`)
- Modify: `pr-lifecycle/hooks/round.ts` (`Fetched`, `fetchFeedback`, `pollOnce`)
- Modify: `pr-lifecycle/tests/world.ts` (knob `commitDate`)
- Test: `pr-lifecycle/tests/github.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `Check.startedAt?: number` (ms; absent when GitHub gives none). `Fetched.headAt?: number`. World knob `w.gh.commitDate?: string` (ISO; undefined makes the commit lookup fail).

- [ ] **Step 1: Write the failing tests**

Append to `pr-lifecycle/tests/github.test.ts`:

```ts
test('#24: a check run carries when it started', async () => {
  const runs = readCheckRuns(JSON.stringify({ check_runs: [
    { name: 'ci', status: 'completed', conclusion: 'success', started_at: '1970-01-01T00:00:50Z' },
    { name: 'lint', status: 'queued', conclusion: null, started_at: null },
  ] }))
  expect(runs).toEqual([
    { name: 'ci', status: 'completed', conclusion: 'success', startedAt: 50_000 },
    { name: 'lint', status: 'queued', conclusion: null },
  ])
})
```

In `pr-lifecycle/tests/world.ts`, add to the `gh` type, after `checks: object[]`:

```ts
    /** The head commit's committer date, as `gh api repos/<slug>/commits/<sha> --jq .commit.committer.date` prints it; undefined fails it. */
    commitDate?: string
```

and in the fake, before the `check-runs` line, add:

```ts
      if (/^api repos\/\S+\/commits\/[0-9a-f]+ --jq \.commit\.committer\.date$/.test(args)) {
        return w.gh.commitDate === undefined ? failed('gh: Not Found (HTTP 404)') : out(`${w.gh.commitDate}\n`)
      }
```

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
test('#24: after a resume, a roster reviewer\'s comment already on the head still covers it', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  await $.command.run(cmd('stop'))
  // The head's check started at 00:00:50; the reviewer's comment (no commit) came at 00:01:00, while the gate was stopped.
  w.gh.checks = [{ name: 'ci', status: 'completed', conclusion: 'success', started_at: '1970-01-01T00:00:50Z' }]
  w.gh.issueComments = [{ id: 31, user: { login: 'claude[bot]' }, body: '', created_at: '1970-01-01T00:01:00Z', html_url: 'c31' }]
  await w.clock.advance(60 * 60_000)
  await $.command.run(cmd('resume'))
  await w.clock.advance(30_000)
  expect((await recordOf(w)).phase).toBe('ready')
})

test('#24: with no check runs, the head commit\'s date stands for when it arrived, never later than now', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  await $.command.run(cmd('stop'))
  w.gh.commitDate = '1970-01-01T00:00:40Z'
  w.gh.issueComments = [{ id: 31, user: { login: 'claude[bot]' }, body: '', created_at: '1970-01-01T00:01:00Z', html_url: 'c31' }]
  await w.clock.advance(60 * 60_000)
  await $.command.run(cmd('resume'))
  await w.clock.advance(30_000)
  expect((await recordOf(w)).phase).toBe('ready')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/github.test.ts` and `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: FAIL: `startedAt` is missing; both flow tests stay in `collect` (phase `post`), waiting for claude[bot].

- [ ] **Step 3: Implement**

In `pr-lifecycle/hooks/github.ts`:

```ts
/** A check run on a head; `startedAt` (ms) when GitHub says when it started (#24). */
export type Check = { name: string; status: string; conclusion: string | null; startedAt?: number }
```

and in `readCheckRuns` replace the final `.map(...)` with:

```ts
  }).map(row => {
    const startedAt = when(row.started_at)
    return { name: String(row.name ?? ''), status: String(row.status ?? ''), conclusion: str(row.conclusion) ?? null, ...(startedAt > 0 ? { startedAt } : {}) }
  })
```

In `pr-lifecycle/hooks/round.ts`, add to `Fetched`:

```ts
  /** When the PR head reached the PR (#24): its earliest check run's start, else its commit's date; never later than now. */
  headAt?: number
```

In `fetchFeedback`, replace the line `return { isOk: true, feedback, cover: others, checks: readCheckRuns(checks.out), prHead, ownReplies }` with:

```ts
    const runs = readCheckRuns(checks.out)
    const headAt = await headArrival($, rec, prHead, runs)
    return { isOk: true, feedback, cover: others, checks: runs, prHead, ownReplies, ...(headAt === undefined ? {} : { headAt }) }
```

and add above `fetchFeedback`:

```ts
/**
 * When a head reached the PR (#24): the earliest start of its check runs, which the poll already has; with none, its commit's
 * committer date. Never later than now. undefined when neither is known: the caller keeps the time it first saw the head.
 */
async function headArrival($: Engine, rec: LifecycleRecord, head: string, runs: readonly Check[]): Promise<number | undefined> {
  const now = await $.clock.now()
  const started = runs.flatMap(one => (one.startedAt === undefined ? [] : [one.startedAt]))
  if (started.length > 0) return Math.min(now, ...started)
  const ran = await $.process.run(['gh', 'api', `repos/${rec.slug ?? ''}/commits/${head}`, '--jq', '.commit.committer.date'], { cwd: rec.root, timeoutMs: 30_000 })
  const at = ran.exitCode === 0 ? Date.parse(ran.stdout.trim()) : Number.NaN
  return Number.isFinite(at) && at > 0 ? Math.min(now, at) : undefined
}
```

(`Check` must be imported from `./github` as a type if it is not already.)

In `pollOnce`, replace

```ts
  const headAt = isNewHead ? now : collect.headAt
```

with

```ts
  // When the head reached the PR, as GitHub says (#24), so a comment posted before a resume still counts for it.
  const headAt = got.headAt ?? (isNewHead ? now : collect.headAt)
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. An existing test that set check runs without `started_at` is unaffected (`startedAt` absent, then the commit lookup fails in the world, so `headAt` falls back as before).

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/world.ts pr-lifecycle/tests/github.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: a head's time is when it reached the PR, so a resume keeps its coverage (#24)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 5: Collection ends on GitHub's signals (R89, spec §2)

**Why:** collection waits for the roster, or for running checks and a 3-minute quiet spell. GitHub already says what to wait for: the base's required checks (R86), the PR's pending review requests, and the roster. The quiet window stays only where none of the three exists. Review Focus 2: the person may request a review from this machine's own login; the gate must not wait for it.

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (`CollectInput`, `collectionDone`, new `readRequested`)
- Modify: `pr-lifecycle/hooks/round.ts` (`Fetched`, `fetchFeedback`, `pollOnce`)
- Modify: `pr-lifecycle/tests/world.ts` (knobs `requested` and `requests`)
- Test: `pr-lifecycle/tests/github.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `requiredChecksOf($, root, slug, base): Promise<Set<string> | { unknown: string }>` (`round.ts`, R86).
- Produces:
  - `CollectInput.requested?: readonly string[]` and `CollectInput.required?: readonly string[] | 'unknown'` (absent reads as `'unknown'`: every reported check stands in).
  - `export function readRequested(text: string, self: string): string[]` in `github.ts`.
  - `Fetched.requested?: string[]`.
  - World: `w.gh.requested?: string[]` (logins `requested_reviewers` lists; default none) and `w.gh.requests: string[]` (every `-X POST .../requested_reviewers` call, in order). Task 10 reads `w.gh.requests`.

- [ ] **Step 1: Write the failing tests**

Add `readRequested` to the imports in `pr-lifecycle/tests/github.test.ts`. Replace the test `without a roster, collection ends when checks are done and feedback has gone quiet` with:

```ts
test('R89: a running required check holds collection; a completed one is a signal, so no quiet wait; with no signal at all, the quiet window decides', async () => {
  const running = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  const done = [{ name: 'ci', status: 'completed', conclusion: 'failure' }]
  expect(collectionDone({ ...base, feedback: [], checks: running, now: 600_000 }).isDone).toBe(false)
  // Unknown required checks: every reported check stands in, and is a signal.
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 500_000, now: 600_000 })).toMatchObject({ isDone: true, isComplete: true })
  // No required check, no request, no roster: only the quiet window.
  expect(collectionDone({ ...base, required: [], feedback: [], checks: done, lastArrivalAt: 500_000, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, required: [], feedback: [], checks: done, lastArrivalAt: 400_000, now: 600_000 })).toMatchObject({ isDone: true, isComplete: true })
})
```

Append:

```ts
test('R89: required checks need a completed run on the head; a check that is not required is not waited for', async () => {
  const running = (name: string) => ({ name, status: 'in_progress', conclusion: null })
  const completed = (name: string) => ({ name, status: 'completed', conclusion: 'success' })
  expect(collectionDone({ ...base, required: ['ci'], feedback: [], checks: [completed('ci'), running('preview')], now: 60_000 })).toMatchObject({ isDone: true, isComplete: true })
  // A required check with no run yet is missing.
  expect(collectionDone({ ...base, required: ['ci', 'analyze'], feedback: [], checks: [completed('ci')], now: 60_000 })).toMatchObject({ isDone: false, missing: ['analyze'] })
  expect(collectionDone({ ...base, required: 'unknown', feedback: [], checks: [completed('ci'), running('preview')], now: 60_000 })).toMatchObject({ isDone: false, missing: ['preview'] })
  // With a roster, a required check is waited for too.
  const roster = { reviewers: ['claude[bot]'], checks: [], requestReview: [], trusted: [] }
  expect(collectionDone({ ...base, roster, required: ['ci'], feedback: [fb('claude[bot]', 'b')], checks: [running('ci')], now: 60_000 })).toMatchObject({ isDone: false, missing: ['ci'] })
  // The cap still ends it.
  expect(collectionDone({ ...base, required: ['analyze'], feedback: [], checks: [], now: 1_200_000 })).toMatchObject({ isDone: true, isComplete: false, missing: ['analyze'] })
})

test('R89: a pending review request holds collection until that reviewer reviews the head; this machine\'s login is never waited for', async () => {
  const req = { ...base, required: [] as string[], checks: [], now: 60_000 }
  expect(collectionDone({ ...req, requested: ['alice'], feedback: [] })).toMatchObject({ isDone: false, missing: ['alice'] })
  // A review of an older head does not answer the request.
  expect(collectionDone({ ...req, requested: ['alice'], feedback: [fb('alice', 'a')] }).isDone).toBe(false)
  expect(collectionDone({ ...req, requested: ['alice'], feedback: [fb('alice', 'b')] })).toMatchObject({ isDone: true, isComplete: true })
  // A GitHub App's review answers the request made to its name (F3).
  expect(collectionDone({ ...req, requested: ['copilot'], feedback: [fb('copilot-pull-request-reviewer[bot]', 'b')] }).isDone).toBe(true)
  expect(readRequested(JSON.stringify({ users: [{ login: 'alice' }, { login: 'me' }], teams: [{ slug: 'core' }] }), 'me')).toEqual(['alice'])
  expect(readRequested('{}', 'me')).toEqual([])
  expect(readRequested('<html>proxy error</html>', 'me')).toEqual([])
})
```

In `pr-lifecycle/tests/world.ts`, add to the `gh` type after `labelled: string[]`:

```ts
    /** Logins `GET .../requested_reviewers` lists (R89); undefined lists none. */
    requested?: string[]
    /** Every `-X POST .../requested_reviewers` call the gate made, in order. */
    requests: string[]
```

initialise `requests: []` next to `labelled: []`, and replace the line

```ts
      if (/requested_reviewers/.test(args)) return out('{}')
```

with

```ts
      if (/requested_reviewers/.test(args)) {
        if (args.includes('-X POST')) {
          w.gh.requests.push(args)
          return out('{}')
        }
        return out(JSON.stringify({ users: (w.gh.requested ?? []).map(login => ({ login })), teams: [] }))
      }
```

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
test('R89: a pending review request holds the round until that reviewer reviews the head', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  w.gh.requested = ['alice']
  await toPost($, w)
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  expect((await runOf(w)).activity).toBe('waiting on alice')
  // GitHub drops the request once alice reviews.
  w.gh.requested = []
  w.gh.reviews = [...covers(w.gh.prHead), { id: 6, user: { login: 'alice' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  expect((await recordOf(w)).phase).toBe('ready')
})

test('R89 (Review Focus 2): a review requested from this machine\'s own login is never waited for', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  w.gh.requested = ['me']
  await toPost($, w)
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  expect((await recordOf(w)).phase).toBe('ready')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/github.test.ts` and `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: FAIL: `readRequested` is not exported; the flow test for alice reaches `ready` without her.

- [ ] **Step 3: Implement**

In `pr-lifecycle/hooks/github.ts`, add to `CollectInput`:

```ts
  /** Logins with a pending review request on the PR, this machine's own left out (R89). */
  requested?: readonly string[]
  /** The base's required checks (R86), or 'unknown', where every reported check stands in. Absent reads as 'unknown'. */
  required?: readonly string[] | 'unknown'
```

Replace `collectionDone` with:

```ts
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
  const isReviewed = (who: string): boolean => input.feedback.some(one => one.kind === 'review' && one.head === input.head && postsFor(one.reviewer, who))
  const missing = [
    ...new Set([
      ...(hasRoster ? [...roster.reviewers.filter(one => !covered.includes(one)), ...roster.checks.filter(one => !finished.has(one))] : []),
      ...requested.filter(one => !isReviewed(one)),
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
```

`postsFor` is defined further down the file as a `const`; move its definition (with its doc comment) above `collectionDone` so it is initialised before use.

In `pr-lifecycle/hooks/round.ts`:

- Add to `Fetched`: `/** Logins with a pending review request (R89), this machine's own left out. */ requested?: string[]`.
- Import `readRequested` from `./github`.
- In `fetchFeedback`, add a fifth read to the `Promise.all` and to `bad`:

```ts
  const [reviews, inline, comments, checks, requests] = await Promise.all([
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/reviews`),
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/issues/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/commits/${prHead}/check-runs`),
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/requested_reviewers`),
  ])
  const bad = [reviews, inline, comments, checks, requests].find(one => !one.isOk)
```

  and add `requested: readRequested(requests.out, self)` to the returned object (Task 4 already changed that return line).
- In `pollOnce`, before `const done = collectionDone({`, add:

```ts
  // The base's required checks (R86): unknown makes every reported check stand in.
  const needed = await requiredChecksOf($, run.root, rec.slug, run.base)
```

  and add to the `collectionDone` input:

```ts
    requested: got.requested ?? [],
    required: needed instanceof Set ? [...needed] : 'unknown',
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. In the world, `w.gh.required` undefined means every reported check is required, so a flow test that had a running check and a roster now waits for that check too. That is the intended change (spec §2). If such a test fails, make its check complete or set `w.gh.required = []` so it tests what it tested, and list each change in your report.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/world.ts pr-lifecycle/tests/github.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: collection ends on required checks, review requests and the roster (R89)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 6: A post round is charged only when it finds something (R88, spec §1.4)

**Why:** every completed discretionary round draws on the allowance, clean or not. A post round should cost one only when a new blocker was raised in it, or Codex rejected a fix, rebuttal or acknowledgement in it. A pre-PR round is always charged, as in 1.4.0 (plan ruling: the spec's charging is about the post-PR rounds the agent pushes through).

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`RoundRecord`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`usedRounds`, new `isChargedRound`)
- Modify: `pr-lifecycle/hooks/round.ts` (`endRound`, about line 2077)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `RoundRecord.isCharged?: boolean` (set on every post round from 1.5.0; absent on older records and on pre rounds). `export function isChargedRound(findings: readonly Finding[], round: number): boolean`. Task 7 adds "a linked duplicate is not new" to it.
- Ruling for the plan: a Codex rejection in an answer run (R37, which records no round) charges nothing.

- [ ] **Step 1: Write the failing tests**

Add `isChargedRound` to the imports in `pr-lifecycle/tests/lifecycle.test.ts` and append:

```ts
test('R88: a post round is charged for a new blocker or a Codex rejection in it; a pre round and an older record always count', async () => {
  const blocker = finding({ id: 'G3-1', round: 3, source: 'github', severity: 'P1' })
  const advisory = finding({ id: 'G3-2', round: 3, source: 'github', severity: 'P3' })
  expect(isChargedRound([blocker], 3)).toBe(true)
  expect(isChargedRound([advisory], 3)).toBe(false)
  expect(isChargedRound([blocker], 4)).toBe(false)
  // A fix Codex rejects is charged to the round that rejects it.
  const rejectedFix = finding({ id: 'R2-1', round: 2, history: [
    { round: 2, status: 'open', by: 'codex', at: 1 },
    { round: 3, status: 'reported-fixed', by: 'main', at: 2 },
    { round: 3, status: 'open', note: 'still reachable', by: 'codex', at: 3 },
  ] })
  expect(isChargedRound([rejectedFix], 3)).toBe(true)
  expect(isChargedRound([rejectedFix], 2)).toBe(false)
  const upheld = finding({ id: 'R2-2', round: 2, status: 'verified-fixed', history: [
    { round: 3, status: 'reported-fixed', by: 'main', at: 1 },
    { round: 3, status: 'verified-fixed', by: 'codex', at: 2 },
  ] })
  expect(isChargedRound([upheld], 3)).toBe(false)
  // A rejected rebuttal and a rejected acknowledgement charge too.
  expect(isChargedRound([rejected()], 2)).toBe(true)
  const d = (n: number, over: object = {}) => roundOf({ n, phase: 'post', kind: 'discretionary', ...over })
  expect(usedRounds({ rounds: [pre(), d(2, { isCharged: false }), d(3, { isCharged: true }), d(4)] })).toBe(3)
  expect(usedRounds({ rounds: [pre({ isCharged: false })] })).toBe(1)
  expect(remaining({ allowance: 2, grants: [], rounds: [d(2, { isCharged: false }), d(3, { isCharged: false })] })).toBe(2)
})
```

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
test('R88: each post round records whether it was charged: a clean one is free, a new blocker charges it', async ($, on) => {
  const clean = world(on)
  clean.git.roster = roster
  await toPost($, clean)
  clean.gh.reviews = covers(clean.gh.prHead)
  await clean.clock.advance(30_000)
  expect((await recordOf(clean)).rounds.filter(one => one.phase === 'post').map(one => one.isCharged)).toEqual([false])
})

test('R88: a round that raises a new blocker is charged', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).rounds.filter(one => one.phase === 'post').map(one => one.isCharged)).toEqual([true])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts`
Expected: FAIL: `isChargedRound` is not exported.

- [ ] **Step 3: Implement**

In `pr-lifecycle/types/index.d.ts`, add to `RoundRecord` after `isCompleted`:

```ts
  /**
   * Post only (R88): whether the round drew on the allowance, because a new blocker was raised in it or Codex rejected a fix,
   * rebuttal or acknowledgement in it. Absent on a pre round and on a record from before 1.5.0, which count as charged.
   */
  isCharged?: boolean
```

In `pr-lifecycle/hooks/lifecycle.ts`, replace `usedRounds` with:

```ts
/**
 * Rounds that drew on the allowance: completed discretionary ones. A post round from 1.5.0 counts only when it was charged (R88);
 * a pre round, and a round from an older record, always count. Baseline rounds, final-head checks and incomplete attempts use nothing.
 */
export const usedRounds = (rec: Pick<LifecycleRecord, 'rounds'>): number =>
  rec.rounds.filter(one => one.isCompleted && one.kind === 'discretionary' && (one.phase === 'pre' || one.isCharged !== false)).length
```

Below it, add (it uses `isBlocking`, defined further down as a `const`; place this function after `isBlocking`'s definition):

```ts
/** The agent's answers Codex can reject. */
const REJECTABLE: readonly FindingStatus[] = ['reported-fixed', 'verified-fixed', 'rebutted', 'deferred']

/**
 * Whether a post round costs one (R88): a blocking finding first raised in it, or Codex reopening, in it, a finding the agent had
 * answered (a fix, a rebuttal, an acknowledgement, a deferral). "A rejected fix still uses a round, because it does."
 */
export function isChargedRound(findings: readonly Finding[], round: number): boolean {
  const isNewBlocker = findings.some(one => one.round === round && isBlocking(one))
  const isRejected = findings.some(one =>
    one.history.some((each, i) => each.round === round && each.by === 'codex' && each.status === 'open' && i > 0 && REJECTABLE.includes(one.history[i - 1]?.status ?? 'open')),
  )
  return isNewBlocker || isRejected
}
```

(If `FindingStatus` is not imported as a type in `lifecycle.ts`, add it to the type import from `'../types'`.)

In `pr-lifecycle/hooks/round.ts`, in `endRound`, where the `RoundRecord` is built (the object with `raised`, `rebutted`, `deferredBlocking`), add:

```ts
    ...(run.lifecycle === 'post' ? { isCharged: isChargedRound(run.findings, run.round) } : {}),
```

and import `isChargedRound` from `./lifecycle`.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A flow test that counted on a clean discretionary post round using up the allowance (an `exhausted` after N clean rounds) now gets more rounds. Change it so its rounds raise a new blocker each time, keeping what it tests, and list each change in your report.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: a post round is charged only for a new blocker or a Codex rejection (R88)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 7: One finding per problem (R90, spec §3)

**Why:** `triage()` compares new feedback only with *answered* findings and only labels it `duplicate` in the prompt; the agent's `duplicateOf` is read and never used. On PR #19 review summary G2-1 stayed a separate blocker beside its own inline G2-2.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Finding`, `Blocker`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`triage`, new link helpers, `mergeHolds`, `checksOwed`, `blockerOf`, `standingOf`, `decidePost`, `isChargedRound`)
- Modify: `pr-lifecycle/hooks/core.ts` (`readTriage`, new `readLinks`, `triagePrompt`, `verifyPrompt`)
- Modify: `pr-lifecycle/hooks/round.ts` (`beginTriage`, `afterTriage`, `afterRebuttalCheck`)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `isChargedRound` (Task 6), `peakOf`, `higher`, `isPeakUnknown` (R85).
- Produces:
  - `Finding.duplicateOf?: string`, `Finding.linkBy?: 'gate' | 'agent'`, `Finding.isLinkChecked?: boolean`; `Blocker` kind `'link-unchecked'`.
  - In `lifecycle.ts`: `isLinked(f): boolean` (stands for its original: the gate's link, or the agent's once Codex agreed), `isLinkOwed(f): boolean`, `linkTo(f, original, by, round, at): Finding`, `dropLink(f): Finding`, `withLinkedPeak(original, linked): Finding`, `alsoOf(findings, id): string[]`.
  - In `core.ts`: `export type LinkAnswer = { id: string; duplicateOf: string; replyId?: string }`, `export function readLinks(answer: string): LinkAnswer[]`.
- Rulings for the plan: a row with `duplicateOf` is a link, whatever its `action`; a link Codex refuses is not charged (the item was never answered, so it is no rejected answer); a link to an id that is not on the list, or to itself, is no answer.

- [ ] **Step 1: Write the failing tests**

Add `alsoOf, dropLink, isLinked, isLinkOwed, linkTo, withLinkedPeak` to the `lifecycle` imports and `readLinks` to the `core` imports in `pr-lifecycle/tests/lifecycle.test.ts`. Append:

```ts
test('R90: new feedback links to any finding naming the same problem, open ones included, never to a linked one', async () => {
  const open = finding({ id: 'G2-1', source: 'github', title: 'the cache is never cleared', file: 'src/cache.ts', line: 10, status: 'open' })
  const item = { file: 'src/cache.ts', line: 12, title: 'cache never cleared on logout', at: 5 }
  expect(triage(item, [open], new Set())).toEqual({ cls: 'duplicate', matchId: 'G2-1' })
  // Linking to a linked finding links to its original.
  const linked = { ...finding({ id: 'G3-1', source: 'github', title: 'cache never cleared', file: 'src/cache.ts', line: 11 }), duplicateOf: 'G2-1', linkBy: 'gate' as const }
  expect(triage(item, [linked], new Set())).toEqual({ cls: 'duplicate', matchId: 'G2-1' })
  // R33: feedback after a rebuttal answers it; a changed file keeps it new.
  const rebutted = { ...open, status: 'rebutted' as const, history: [{ round: 2, status: 'rebutted' as const, by: 'main', at: 4 }] }
  expect(triage(item, [rebutted], new Set()).cls).toBe('new-on-reviewed')
  expect(triage(item, [open], new Set(['src/cache.ts'])).cls).toBe('new-on-changed')
})

test('R90: a linked finding holds and settles with its original, is listed beside it, and raises its peak', async () => {
  const original = finding({ id: 'G2-1', source: 'github', reviewer: 'bot', severity: 'P2', peakSeverity: 'P2', status: 'open' })
  const dup = linkTo(finding({ id: 'G2-2', source: 'github', reviewer: 'bot', severity: 'P1', peakSeverity: 'P1' }), original, 'gate', 2, 5)
  expect(dup).toMatchObject({ duplicateOf: 'G2-1', linkBy: 'gate' })
  expect(dup.history.at(-1)).toMatchObject({ note: 'linked to G2-1', by: 'gate' })
  expect(isLinked(dup)).toBe(true)
  const raised = withLinkedPeak(original, dup)
  expect(raised.peakSeverity).toBe('P1')
  expect(withLinkedPeak(dup, original).peakSeverity).toBe('P1')
  const rec = postRec({ findings: [raised, dup] })
  expect(mergeHolds(rec).map(one => one.id)).toEqual(['G2-1'])
  expect(alsoOf(rec.findings, 'G2-1')).toEqual(['G2-2'])
  expect(standingOf(rec, { head: 'a', base: 'dev' }).blockers[0]?.said).toBe('G2-1 (also G2-2) [P2] comment from bot: open')
  // The original settles: so does the link.
  expect(mergeHolds(postRec({ findings: [markVerified(raised, 2, 'codex', 6), dup] }))).toEqual([])
  // Never a chain: linking to a linked finding links to its original.
  expect(linkTo(finding({ id: 'G3-1' }), dup, 'gate', 3, 7).duplicateOf).toBe('G2-1')
  expect(dropLink(dup)).not.toHaveProperty('duplicateOf', 'G2-1')
})

test('R90: the agent\'s link waits for Codex, at no round\'s cost; agreed it stands, refused the item stands alone', async () => {
  const original = finding({ id: 'G2-1', source: 'github', reviewer: 'bot', severity: 'P2', status: 'reported-fixed' })
  const claimed = linkTo(finding({ id: 'G2-2', source: 'github', reviewer: 'bot', severity: 'P2' }), original, 'agent', 2, 5)
  expect(isLinkOwed(claimed)).toBe(true)
  expect(isLinked(claimed)).toBe(false)
  const blockers = standingOf(postRec({ findings: [claimed] }), { head: 'a', base: 'dev' }).blockers
  expect(blockers.map(one => [one.id, one.kind, one.owner])).toEqual([['G2-2', 'link-unchecked', 'codex']])
  expect(checksOwed([claimed]).map(one => one.id)).toEqual(['G2-2'])
  expect(decideNext(postRec({ findings: [claimed] }))).toMatchObject({ kind: 'blocked', recheck: ['G2-2'] })
  const agreed = { ...claimed, isLinkChecked: true }
  expect(isLinked(agreed)).toBe(true)
  const refused = markHeld(dropLink(claimed), 2, 'codex', 6, 'a different file')
  expect(isChargedRound([refused], 2)).toBe(false)
  // A linked duplicate raised as a blocker is not new: it charges nothing.
  expect(isChargedRound([linkTo(finding({ id: 'G2-3', round: 2, severity: 'P1' }), original, 'gate', 2, 5)], 2)).toBe(false)
})

test('R90: a row with duplicateOf reads as a link, whatever its action', async () => {
  const answer = trailerOf({ step: 'r2-triage', dispositions: [
    { id: 'G2-2', duplicateOf: 'G2-1', replyId: 'https://github.com/me/repo/pull/1#discussion_r55' },
    { id: 'G2-3', action: 'fixed', duplicateOf: 'G2-1' },
    { id: 'G2-4', action: 'fixed', note: 'done' },
  ] })
  expect(readLinks(answer)).toEqual([{ id: 'G2-2', duplicateOf: 'G2-1', replyId: '55' }, { id: 'G2-3', duplicateOf: 'G2-1' }])
  expect(readTriage(answer).map(one => one.id)).toEqual(['G2-4'])
})
```

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
test('R90: a reviewer\'s second comment on the same problem is linked, answered with a pointer reply, and holds as one finding', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  w.gh.comments = [
    inline(11, '**P2** the cache is never cleared on logout', w.gh.prHead, 10),
    inline(12, '**P2** cache never cleared after logout', w.gh.prHead, 12),
  ]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  const prompt = w.prompts.at(-1) ?? ''
  expect(prompt).toContain('G2-2 from claude[bot] (src/app.ts:12), same problem as G2-1')
  expect((await runOf(w)).findings.find(one => one.id === 'G2-2')).toMatchObject({ duplicateOf: 'G2-1', linkBy: 'gate' })
  await done($, triaged('r2-triage', [
    { id: 'G2-1', action: 'deferred', note: 'needs a store change', replyId: '901' },
    { id: 'G2-2', duplicateOf: 'G2-1', replyId: '902' },
  ]))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-2')).toMatchObject({ duplicateOf: 'G2-1', linkBy: 'gate' })
  expect(rec.replies['inline:12']).toBe('902')
  expect(mergeHolds(rec).map(one => one.id)).toEqual(['G2-1'])
})

test('R90: the agent refuses the gate\'s link by answering the item on its own', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  w.gh.comments = [inline(11, '**P2** the cache is never cleared on logout', w.gh.prHead, 10), inline(12, '**P2** cache never cleared after logout', w.gh.prHead, 12)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  await done($, triaged('r2-triage', [
    { id: 'G2-1', action: 'fixed', note: 'clear on logout', replyId: '901' },
    { id: 'G2-2', action: 'fixed', note: 'a second cache, also cleared now', replyId: '902' },
  ]))
  expect((await recordOf(w)).findings.find(one => one.id === 'G2-2')?.duplicateOf).toBeUndefined()
})
```

Add `mergeHolds` to the `lifecycle` imports in `flow.test.ts` if it is not imported yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts`
Expected: FAIL: `linkTo` and the other helpers are not exported.

- [ ] **Step 3: Implement the record and the pure rules**

In `pr-lifecycle/types/index.d.ts`, add to `Finding` after `followUpLabelError`:

```ts
  /** The finding this one names again (R90): it holds, and settles, with its original. Never a linked finding's id. */
  duplicateOf?: string
  /** Who linked it: the gate's match (`isSame`), or the agent's answer, which Codex checks (R90). */
  linkBy?: 'gate' | 'agent'
  /** Codex agreed the agent's link names the same problem. */
  isLinkChecked?: boolean
```

and add `| 'link-unchecked'` to `Blocker.kind` after `'label-failed'`.

In `pr-lifecycle/hooks/lifecycle.ts`:

1. In `triage`, replace the last two lines with:

```ts
  // Every finding on the list, open ones included (R90); a linked one stands for its original, so the link goes there.
  const match = findings.find(one => one.needsRecheck !== true && !isAnswerTo(one) && isSame(one, item))
  return match === undefined ? { cls: 'new-on-reviewed' } : { cls: 'duplicate', matchId: match.duplicateOf ?? match.id }
```

and delete the now-unused `ANSWERED` constant if nothing else reads it (`grep -n ANSWERED pr-lifecycle/hooks/lifecycle.ts`).

2. After `markHeld`, add:

```ts
/** A linked finding that stands for its original (R90): the gate's link, or the agent's once Codex agreed. */
export const isLinked = (f: Finding): boolean => f.duplicateOf !== undefined && (f.linkBy !== 'agent' || f.isLinkChecked === true)

/** The agent's link Codex has not ruled on: Codex checks it in the round's free check (R90). */
export const isLinkOwed = (f: Finding): boolean => f.duplicateOf !== undefined && f.linkBy === 'agent' && f.isLinkChecked !== true

/** Links a finding to its original, never to a linked one (no chains, R90). Its status is its own; its holds are the original's. */
export function linkTo(f: Finding, original: Finding, by: 'gate' | 'agent', round: number, at: number): Finding {
  const to = original.duplicateOf ?? original.id
  return { ...f, duplicateOf: to, linkBy: by, isLinkChecked: undefined, history: [...f.history, { round, status: f.status, note: `linked to ${to}`, by: by === 'gate' ? 'gate' : 'main', at }] }
}

/** The finding standing alone again: the agent answered it on its own, or Codex found it a different problem. */
export const dropLink = (f: Finding): Finding => ({ ...f, duplicateOf: undefined, linkBy: undefined, isLinkChecked: undefined })

/** A link never lowers anything (R90): the original's peak becomes the higher of the two, so its issue carries it (R85). */
export const withLinkedPeak = (original: Finding, linked: Finding): Finding =>
  isPeakUnknown(original) || isPeakUnknown(linked) ? original : { ...original, peakSeverity: higher(peakOf(original), peakOf(linked)) }

/** The ids linked to a finding, for "G2-1 (also G2-2)". */
export const alsoOf = (findings: readonly Finding[], id: string): string[] => findings.filter(one => one.duplicateOf === id && isLinked(one)).map(one => one.id)
```

(If `isPeakUnknown`, `peakOf` or `higher` are defined below this point as `const`s, place these helpers after them.)

3. In `isChargedRound` (Task 6), change `isNewBlocker` to leave linked findings out:

```ts
  const isNewBlocker = findings.some(one => one.round === round && isBlocking(one) && one.duplicateOf === undefined)
```

4. In `mergeHolds`, add `&& !isLinked(one)` to the filter, and add to its doc comment: "A linked duplicate holds through its original (R90)."

5. In `checksOwed`, add `|| isLinkOwed(one)` to the filter, and to its doc comment: "and the agent's links (R90)".

6. Give `blockerOf` the linked ids: change its signature to `function blockerOf(f: Finding, also: readonly string[] = []): Blocker`, its first line to

```ts
  const tag = `${f.id}${also.length === 0 ? '' : ` (also ${also.join(', ')})`} [${f.severity}]${f.isSecurity === true ? ' security' : ''} ${titleOf(f)}`
```

and add, before `if (isDisputed(f))`:

```ts
  if (isLinkOwed(f)) {
    return { kind: 'link-unchecked', id: f.id, said: `${tag}: linked to ${f.duplicateOf ?? '?'}, Codex has not checked the link`, owner: 'codex', release: "the gate's Codex check rules on it" }
  }
```

   In `standingOf`, change `.map(blockerOf)` to `.map(one => blockerOf(one, alsoOf(rec.findings, one.id)))`.

7. In `decidePost`, change the `unchecked` filter to include `|| isLinkOwed(one)`, and in `recheck` add a line for them:

```ts
    const links = unchecked.filter(isLinkOwed)
```

   with `...(links.length === 0 ? [] : [`Codex has not checked the link of ${ids(links)}`]),` in `said`, and leave `links` out of `answered` (`answered = unchecked.filter(one => !isReverifyOwed(one) && !isLoweringOwed(one) && !isLinkOwed(one))`). Add `links` to `kinds` in the `what` line (Task 2), with the words `'the link'` when it is the only kind.

- [ ] **Step 4: Implement the answers and prompts**

In `pr-lifecycle/hooks/core.ts`:

1. In `readTriage`, right after `const row = one as Record<string, unknown>`, add `if (text(row.duplicateOf) !== undefined) continue` (a link is read by `readLinks`), and remove the now-dead `duplicateOf` spread from the pushed object. Keep `TriageAnswer`'s `duplicateOf?` field out: change it to `export type TriageAnswer = Answer & { replyId?: string }`.
2. Below `readTriage`, add:

```ts
/** The agent's word that an item names a problem already on the list (R90): a row with `duplicateOf`, whatever its action. */
export type LinkAnswer = { id: string; duplicateOf: string; replyId?: string }

export function readLinks(answer: string): LinkAnswer[] {
  const listed = readTrailer(answer)?.dispositions
  if (!Array.isArray(listed)) return []
  return listed.flatMap(one => {
    if (typeof one !== 'object' || one === null) return []
    const row = one as Record<string, unknown>
    const id = text(row.id)
    const to = text(row.duplicateOf)
    if (id === undefined || to === undefined) return []
    const given = typeof row.replyId === 'string' ? text(row.replyId) : typeof row.replyId === 'number' && Number.isFinite(row.replyId) ? String(row.replyId) : undefined
    return [{ id, duplicateOf: to, ...(given === undefined ? {} : { replyId: replyIdOf(given) }) }]
  })
}
```

3. In `triagePrompt`, change the `duplicate` class words to `'same problem as an earlier finding, linked'` and make the line for a duplicate name the original: replace the `lines.push(`- ${one.findingId} from ...`)` line with

```ts
    const kind = one.cls === 'duplicate' && one.matchId !== undefined ? `same problem as ${one.matchId}` : cls[one.cls]
    lines.push(`- ${one.findingId} from ${one.feedback.reviewer}${at}, ${kind}; ${reply}:\n${quoted}${earlier}`)
```

   Change step 2's last sentence (`'A duplicate gets a reply pointing to the earlier answer, not a new argument.'`) to:

```ts
'An item that names the same problem as an earlier finding gets one pointer reply in its thread ("Same as G2-1: fixed in abc1234"), not a new argument, and the answer {"id":"G2-2","duplicateOf":"G2-1","replyId":"…"}. To say it is a different problem, answer it on its own instead.'
```

   In the trailer example, drop `"duplicateOf":"R1-1 when it is one",` from the disposition and add a second example row: `{"id":"G1-2","duplicateOf":"G1-1","replyId":"124"}`.
4. In `verifyPrompt`, add a links section. Compute `const links = rebuttals.filter(isLinkOwed)` and leave them out of `argued` (`&& !isLinkOwed(one)`), then add, after the lowerings section:

```ts
      ...(links.length === 0
        ? []
        : [
            '',
            'The main agent says each of these names the same problem as an earlier finding, and answered it there. A link settles nothing until you agree:',
            ...links.map(one => `${listFindings([one])}\n    Same as: ${one.duplicateOf ?? '?'}`),
            '   For each one: holds is true when it is the same problem as the finding it names; false, with why, when it is a different one.',
          ]),
```

   (`isLinkOwed` is imported from `./lifecycle`.)

In `pr-lifecycle/hooks/round.ts`:

1. In `beginTriage`, link a fresh finding the gate matched, including one that matches another item of the same batch (a review summary and its own inline comment arrive together). Before the loop, add `const raised: Finding[] = []`. In the loop, compare with the batch so far too: change

```ts
    const placed = triage({ file: feedback.file, line: feedback.line, title, at: feedback.at }, others, new Set())
```

   to

```ts
    const placed = triage({ file: feedback.file, line: feedback.line, title, at: feedback.at }, [...others, ...fresh], new Set())
```

   After `const finding: Finding = { ... }` is built, replace `fresh.push(finding)` with:

```ts
    // The gate's match is a link (R90): the original's peak rises to the new item's, wherever the original is kept.
    const original = cls === 'duplicate' && matchId !== undefined ? [...ledger, ...fresh].find(one => one.id === matchId) : undefined
    if (original === undefined) fresh.push(finding)
    else {
      const linked = linkTo(finding, original, 'gate', run.round, now)
      const inBatch = fresh.findIndex(one => one.id === original.id)
      if (inBatch !== -1) fresh[inBatch] = withLinkedPeak(fresh[inBatch] as Finding, linked)
      else {
        const at = raised.findIndex(one => one.id === original.id)
        if (at === -1) raised.push(withLinkedPeak(original, linked))
        else raised[at] = withLinkedPeak(raised[at] as Finding, linked)
      }
      fresh.push(linked)
    }
```

   In the `patch` that opens triage change `findings: mergeFindings(one.findings, fresh)` to `findings: mergeFindings(one.findings, [...fresh, ...raised])`, and change the `carried` line's `mergeFindings(ledger, fresh)` to `mergeFindings(ledger, [...fresh, ...raised])`.

2. In `afterTriage`, read links beside answers and apply them. After `const said = ...`, add:

```ts
  const ids = new Set(run.findings.map(f => f.id))
  // A link names a finding on the list, never itself (R90); anything else is no answer, and the item is asked about again.
  const links = readLinks(run.pending[0]?.answer ?? '').filter(each => each.id !== each.duplicateOf && ids.has(each.id) && ids.has(each.duplicateOf))
```

   (`run.findings` holds the round's ledger: `beginTriage` merged the record's findings in. If a link names a finding only in the record, look it up in `await loadRecord(...)`'s findings as well; add it to `ids` from there.)

   In the `patch`'s `findings` map, replace the body with:

```ts
    findings: one.findings.map(finding => {
      const link = links.find(each => each.id === finding.id)
      if (link !== undefined) {
        // The gate's own link confirmed stays the gate's; any other link is the agent's, for Codex to check.
        if (finding.duplicateOf === link.duplicateOf && finding.linkBy === 'gate') return finding
        const original = one.findings.find(f => f.id === link.duplicateOf)
        return original === undefined ? finding : linkTo(finding, original, 'agent', one.round, now)
      }
      const answer = said.find(each => each.id === finding.id)
      // Answered on its own: whatever link it had is dropped (R90).
      return answer === undefined ? finding : applyAnswer(finding.duplicateOf === undefined ? finding : dropLink(finding), answer, one.round, 'main', now)
    }),
```

   Then raise each original's peak for the agent's links: after that `patch`, if any link was applied, patch again with `findings: one.findings.map(f => { const dups = one.findings.filter(d => d.duplicateOf === f.id); return dups.reduce(withLinkedPeak, f) })`.

   A link counts as an answer: in `answered` (the `processed` filter) use `f.status !== 'open' || f.duplicateOf !== undefined`; in the `replies` map add the links' `replyId`s the same way as the answers'; in `unanswered`, add `&& !links.some(each => each.id === id)`.

3. In `afterRebuttalCheck`'s `findings` map, before the `isLoweringOwed` line, add:

```ts
      // The agent's link (R90): agreed, it stands; refused, the item stands alone and is asked about again. Never charged.
      if (isLinkOwed(f)) {
        return verdict.holds
          ? { ...f, isLinkChecked: true, history: [...f.history, { round: one.round, status: f.status, note: `Codex: the same problem as ${f.duplicateOf ?? '?'}`, by: 'codex', at: now }] }
          : markHeld(dropLink(f), one.round, 'codex', now, verdict.note ?? 'Codex: a different problem')
      }
```

   Import `dropLink`, `isLinkOwed`, `linkTo`, `withLinkedPeak` from `./lifecycle` and `readLinks` from `./core`.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. An existing test that relied on a P1 duplicate being its own blocker now sees it held through its original; check each failure against spec §3 and update only where the new rule applies, listing each in your report.

- [ ] **Step 6: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/core.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: one finding per problem; linked duplicates follow their original (R90)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---


### Task 8: The agent answers feedback while collection still waits (R92, spec §1.1, §1.2)

**Why:** In 1.4.0 the agent sees nothing until collection ends (roster covered, checks done, quiet window, or the 20-minute cap). In 1.5.0, feedback that arrives while collection is still waiting goes to the agent after one quiet poll, in a triage turn that does not end the round. A push in that turn ends the round when the turn ends.

**Plan rulings (record them in Task 15's rulings):**
- A mid-collection turn runs in phase `'triage'` with `run.collect` kept. The ticker polls whenever `run.collect` is set, so polling goes on during the turn. The step timeout applies to the turn, because its phase is not `'collect'`. `afterTriage` tells a mid-collection turn by `run.collect !== undefined` (`endCollect` clears it). There is no `Run.isMidCollect` field.
- While a turn is in flight a poll only notes arrivals. It never starts a turn, never ends collection and never acts on a head move; a failed poll is tried again at the next one. The turn's own end reads the head it pushed.
- When collection is already done at the poll that sees new feedback, the end-of-head triage (1.4.0's) asks it, with no mid-collection turn first. The existing tests where feedback and coverage arrive together keep working.
- A mid-collection turn asks only the fresh feedback no turn of this round was handed (`Run.handed`). It does not ask Codex's findings or the carried ones; the end-of-head turn does, as in 1.4.0.
- A mid-collection turn that pushes nothing returns to collecting. Its rebuttals and acknowledgements are checked by Codex when the head's collection ends, through the end-of-head triage (`asked` empty → `checkRebuttals`). A rejection there is charged to this round (spec §1.4).
- A push in a mid-collection turn ends the round when the turn ends, not at the push itself: "straight away" in spec §1.2 slips by up to one turn. That way the round that asked keeps the triage step, and every answer in the turn is recorded first.
- A mid-collection turn's time counts as active time. It also stays inside the collection's wait, because the cap runs from `collect.startedAt`. The log reads both, as before.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Run.handed`, `Run.polled`)
- Modify: `pr-lifecycle/hooks/round.ts` (`startTicker`, `pollOnce`, new `closeCollect`, `endCollect`, `beginTriage`, `afterTriage`)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `collectionDone` with signals (Task 5); `Fetched.headAt` (Task 4); `triagePrompt(run, rec, items, others, more)` with `more.intro` (`core.ts`); `POLL_MS` (30 000).
- Produces:
  - `Run.handed?: string[]`: the feedback ids every triage turn of this round was handed; `startRound` builds a new Run, so it resets per round.
  - `Run.polled?: string[]`: the fresh feedback ids the last poll saw. The next poll tells an arrival by an id not in it. This replaces `pollOnce`'s use of `Run.triaged`, which now only means "what this turn was asked".
  - `closeCollect($, id, now, detail, extra?): Promise<Run | null>` in `round.ts`: ends collection on the round's head (adds the wait, clears `collect`, marks the collect step done). Task 9 uses it.
  - `beginTriage($, id, isFromCommand = false, isMidCollect = false)`.

- [ ] **Step 1: Write the failing tests**

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
/** Feedback a reviewer posted before the poll that reads it: its time never counts as a later arrival. */
const early = <T extends object>(one: T): T => ({ ...one, created_at: '1970-01-01T00:00:01Z' })
const ciRunning = '{"reviewers":["claude[bot]"],"checks":["ci"]}'
const triageTurns = (w: ReturnType<typeof world>, step: string) => w.prompts.filter(one => one.includes(`"step":"${step}"`))

test('R92: feedback is answered while collection waits, after one quiet poll, and the round goes on collecting', async ($, on) => {
  const w = world(on)
  w.git.roster = ciRunning
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  w.gh.comments = [early(inline(11, '**P2** this leaks a file handle', w.gh.prHead))]
  await w.clock.advance(30_000)
  // The poll that sees it waits one more, so a reviewer's burst arrives as one turn.
  expect(triageTurns(w, 'r2-triage')).toHaveLength(0)
  w.gh.comments = [...w.gh.comments, early(inline(12, '**P2** and this one too', w.gh.prHead, 9))]
  await w.clock.advance(30_000)
  expect(triageTurns(w, 'r2-triage')).toHaveLength(0)
  await w.clock.advance(30_000)
  expect(triageTurns(w, 'r2-triage')).toHaveLength(1)
  const asked = triageTurns(w, 'r2-triage')[0] ?? ''
  expect(asked).toContain('G2-1')
  expect(asked).toContain('G2-2')
  expect(asked).toContain('still coming in')
  const turnRun = await runOf(w)
  expect([turnRun.phase, turnRun.collect !== undefined]).toEqual(['triage', true])
  // Polling goes on during the turn: a comment that arrives now waits for the next turn.
  w.gh.comments = [...w.gh.comments, early(inline(13, '**P2** a third one', w.gh.prHead, 20))]
  await w.clock.advance(30_000)
  expect(triageTurns(w, 'r2-triage')).toHaveLength(1)
  await done($, triaged('r2-triage', [
    { id: 'G2-1', action: 'rebutted', severity: 'P2', note: 'closed in the finally block, src/app.ts:30', replyId: '991' },
    { id: 'G2-2', action: 'rebutted', severity: 'P2', note: 'same handle, same finally block', replyId: '992' },
  ]))
  // No push: the round goes on collecting, nothing is recorded as a round, the answers are kept.
  const after = await runOf(w)
  expect([after.phase, after.round, after.status]).toEqual(['collect', 2, 'running'])
  const rec = await recordOf(w)
  expect(rec.processed).toEqual(expect.arrayContaining(['inline:11', 'inline:12']))
  expect(rec.rounds.filter(one => one.phase === 'post')).toHaveLength(0)
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('rebutted')
  // The comment that arrived during the turn gets a turn of its own, asking it alone.
  for (let i = 0; i < 3 && triageTurns(w, 'r2-triage').length < 2; i += 1) await w.clock.advance(30_000)
  const second = triageTurns(w, 'r2-triage')[1] ?? ''
  expect(second).toContain('G2-3')
  expect(second).not.toContain('- G2-1 from')
  await done($, triaged('r2-triage', [{ id: 'G2-3', action: 'rebutted', severity: 'P2', note: 'same finally block', replyId: '993' }]))
  expect((await runOf(w)).phase).toBe('collect')
  // ci finishes and the reviewer covers the head: the head's end has Codex check the rebuttals, then the round ends.
  w.gh.checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('verify')
})

test('R92: a push in a mid-collection turn ends the round on the old head when the turn ends', async ($, on) => {
  const w = world(on)
  w.git.roster = ciRunning
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  w.gh.comments = [early(inline(11, '**P1** SQL injection', w.gh.prHead))]
  await w.clock.advance(60_000)
  expect(triageTurns(w, 'r2-triage')).toHaveLength(1)
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', note: 'parameterised', replyId: '991' }]))
  // Codex checks the fix on the new head first (R72); then the round on a…a ends and the next one collects on e…e.
  expect((await runOf(w)).phase).toBe('verify')
  await done($, accept('r2-verify', w))
  const rec = await recordOf(w)
  const post = rec.rounds.filter(one => one.phase === 'post')
  expect(post.map(one => [one.n, one.startHead, one.endHead, one.isCompleted])).toEqual([[2, 'a'.repeat(40), 'e'.repeat(40), true]])
  const next = await runOf(w)
  expect([next.round, next.phase, next.roundStartHead, next.roundKind]).toEqual([3, 'collect', 'e'.repeat(40), 'baseline'])
  // A new head restarts the cap (spec §1.6): collection began when the round did.
  expect(next.collect?.startedAt).toBe(next.roundStartedAt)
})
```

`toPost` leaves the PR head at `'a'.repeat(40)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: FAIL. In 1.4.0 no triage prompt is sent while `ci` runs, so `triageTurns(w, 'r2-triage')` stays empty.

- [ ] **Step 3: Implement**

In `pr-lifecycle/types/index.d.ts`, add to `Run` after `triaged`:

```ts
  /** Post-PR: the feedback ids every triage turn of this round was handed (R92); a turn while collecting asks only what is not in it. */
  handed?: string[]
  /** Post-PR: the fresh feedback ids the last poll saw, so the next poll can tell what arrived since. */
  polled?: string[]
```

and change the `triaged` doc comment to `/** Post-PR: the feedback ids handed to the main agent in the triage turn in flight (or the last one). */`.

In `pr-lifecycle/hooks/round.ts`:

1. In `startTicker`, replace

```ts
      if (run.phase === 'collect') {
        await poll($, run)
        return // waiting on reviewers is not a step: no step timeout while collecting
      }
```

   with

```ts
      if (run.collect !== undefined) {
        // Collection polls on while a triage turn answers what arrived (R92); only the turn itself has a step timeout.
        await poll($, run)
        if (run.phase === 'collect') return // waiting on reviewers is not a step: no step timeout while collecting
      }
```

2. Add `closeCollect` above `endCollect`:

```ts
/** Collection on the round's head is over: its wait is added, `collect` is cleared and its step is marked done. */
async function closeCollect($: Engine, id: string, now: number, detail: string, extra: Partial<Run> = {}): Promise<Run | null> {
  return patch($, id, one => ({
    ...one,
    ...extra,
    waitMs: one.waitMs + (one.collect === undefined ? 0 : now - one.collect.startedAt),
    collect: undefined,
    steps: withStep(one.steps, { id: `r${one.round}-collect`, label: `Round ${one.round} · collect reviews (${one.roundKind})`, state: 'done', detail }),
  }))
}
```

   In `endCollect`, drop `const waitMs = ...` and replace the `const after = await patch($, run.id, one => ({ ... }))` block with:

```ts
  const detail = `${done.covered.length} reviewer${done.covered.length === 1 ? '' : 's'}${done.isComplete ? '' : `, missing ${done.missing.join(', ')}`}`
  const after = await closeCollect($, run.id, now, detail, { evidence, headSha: got.prHead })
```

3. In `pollOnce`:
   - Change the guard to read a run collecting, or answering while collecting:

```ts
  if (run === null || run.id !== seen.id || run.status !== 'running' || collect === undefined || (run.phase !== 'collect' && run.phase !== 'triage')) return
```

   - Replace the `if (!got.isOk) { ... }` block with:

```ts
  const isTurn = run.pending.length > 0
  if (!got.isOk) {
    // A triage turn is answering: a failed poll is tried again at the next one, not a stop under the agent's feet.
    if (isTurn) return
    await noteAttempt($, run, got.why ?? 'gh failed')
    await finish($, run.id, 'error', `Post-PR round ${run.round} could not read GitHub: ${got.why ?? 'gh failed'}. Fix that, then /pr-gate resume.`)
    return
  }
```

   - After `const lastArrivalAt = ...`, add:

```ts
  const seenIds = new Set(run.polled ?? [])
  const isArrival = fresh.some(one => !seenIds.has(one.id))
  // While a triage turn answers, a poll only notes what arrived; the turn's own end reads the head it pushed (R92).
  if (isTurn) {
    await patch($, run.id, one => ({
      ...one,
      collect: one.collect === undefined ? one.collect : { ...one.collect, polledAt: now, lastArrivalAt: isArrival ? now : lastArrivalAt },
      polled: fresh.map(each => each.id),
    }))
    return
  }
```

   - Change `const arrived = isNewHead || fresh.length > (run.triaged?.length ?? 0)` to `const arrived = isNewHead || isArrival`. In the `after` patch, replace `triaged: fresh.map(each => each.id),` with `polled: fresh.map(each => each.id),`.
   - Replace the tail from `if (!done.isDone) {` to the end of the function with:

```ts
  if (done.isDone) {
    await endCollect($, after, got, done)
    return
  }
  // Feedback no turn of this round was handed, with one quiet poll since the last arrival: the agent answers it now (R92).
  const handed = new Set(after.handed ?? [])
  const unhanded = fresh.filter(one => one.isFinding && !handed.has(one.id))
  if (unhanded.length > 0 && now - (after.collect?.lastArrivalAt ?? now) >= POLL_MS) {
    await beginTriage($, after.id, false, true)
    return
  }
  const waiting = done.missing.length > 0 ? `waiting on ${done.missing.join(', ')}` : 'waiting for feedback to go quiet'
  if (waiting !== after.activity) await patch($, run.id, one => ({ ...one, activity: waiting }))
```

4. In `beginTriage`:
   - Change the signature to `async function beginTriage($: Engine, id: string, isFromCommand = false, isMidCollect = false): Promise<void>` and its doc comment's first sentence to: `Triage: the round's fresh GitHub feedback, Codex's open findings when it ran, and blockers still open from earlier rounds (R32) go to the main agent in one turn. While collection still waits (R92), only the fresh feedback no turn of the round was handed.`
   - Change `const items = ...` to:

```ts
  const handed = new Set(run.handed ?? [])
  const items = got.feedback.filter(one => one.isFinding && !rec.processed.includes(one.id) && !(isMidCollect && handed.has(one.id)))
```

   - Change `const codex = ...` to `const codex = isMidCollect ? [] : run.findings.filter(...)` (same filter), and wrap the `carried` value the same way: `const carried = isMidCollect ? [] : mergeHolds(...).filter(...)`.
   - Change `if (got.prHead !== rec.head) {` to `if (!isMidCollect && got.prHead !== rec.head) {`.
   - Before `if (asked.length === 0 && others.length === 0) {`, add:

```ts
  // Nothing new to hand over while collecting: the round goes on collecting.
  if (isMidCollect && asked.length === 0) return
```

   - In the `opened` patch, add `handed: [...new Set([...(one.handed ?? []), ...items.map(each => each.id)])],` and `hasReprompted: false,`. Change `activity` and the step label so a mid-collection turn says so:

```ts
    activity: isMidCollect ? 'waiting on the main agent to answer feedback while reviews come in…' : 'waiting on the main agent to answer the reviews…',
```

```ts
      label:
        count === 0
          ? `Round ${one.round} · check the new commits (main agent)`
          : `Round ${one.round} · answer ${count} review item${count === 1 ? '' : 's'}${isMidCollect ? ' while reviews come in' : ''} (main agent)`,
```

   - Pass an intro to `triagePrompt` for a mid-collection turn:

```ts
  const intro = isMidCollect
    ? `Reviews are still coming in on ${opened.roundStartHead.slice(0, 7)}: answer these now. Feedback that arrives meanwhile comes in a ` +
      'later turn. A push ends this round when your turn ends, and the next round reviews the new head.'
    : undefined
  const text = triagePrompt(opened, rec, listed, others, { carried, codex, codexRange, ...(intro === undefined ? {} : { intro }) })
```

5. In `afterTriage`, after `const endHead = prHead`, add:

```ts
  // A turn while collecting that pushed nothing: the round goes on collecting on the same head (R92). Its rebuttals and
  // acknowledgements are checked when the head's collection ends.
  if (after.collect !== undefined && endHead === run.roundStartHead) {
    const back = await $.clock.now()
    await patch($, run.id, one => ({
      ...one,
      phase: 'collect',
      phaseStartedAt: back,
      activeMs: one.activeMs + (back - one.phaseStartedAt),
      pending: [],
      hasReprompted: false,
      activity: 'waiting on reviewers…',
    }))
    $.ui.status(`pr-gate r${after.round}: waiting on reviewers`)
    return
  }
```

   Then, before `const ended = await getRun($)`, add:

```ts
  // A push in a turn while collecting ends the round on the head it pushed (R92): collection on the old head is over.
  if (after.collect !== undefined) await closeCollect($, run.id, await $.clock.now(), `ended by the push of ${endHead.slice(0, 7)}`)
```

   The rest of the tail (`onNewHead`, the exemption, `checkRebuttals` or `endRound`, then `advance` → `startRound` → `beginCollect` on the new head) is 1.4.0's and ends the round.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A test that relied on `Run.triaged` being rewritten by every poll now reads `Run.polled`; update only those and list them in your report.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: the agent answers feedback while collection waits (R92)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 9: A push ends the round on its head (R92, spec §1.2, §1.3, §1.6)

**Why:** In 1.4.0 a push seen while collecting moves the round's start head inside the same round (`pollOnce`: `roundStartHead: got.prHead`). In 1.5.0 a round is one head. A push with no triage turn in flight (someone else's push, or the agent's outside a turn) ends the round on the old head at the poll that sees it. `decideNext` then opens the next round on the new head, with a fresh cap. Task 8 already ends the round for a push made in a turn.

**Plan rulings:**
- The closed round records `startHead` = the old head and `endHead` = the new one, like a 1.4.0 round whose fix was pushed. `rec.head` becomes the new head. A rolled-over round has no evidence of its own; `diffBase` stays on the last covered head (R60), so the next head's Codex fallback covers the commits between (spec §1.5).
- After a rollover, `decidePost` sees a changed head, so it returns a round (baseline, discretionary or final-head-check) or, after a final-head check, `exhausted`. It never returns `blocked`.
- Commits pushed by someone else are no longer listed as "Commits on the PR since …" in the triage prompt: every push now ends the round, and the next round reviews them. The list stays for an answer run and for late triage.
- Feedback left unanswered when its round rolled over is fresh in the next round (its id is not processed). That round's first quiet poll hands it to the agent again, under its own finding id.

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (`pollOnce`)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `closeCollect($, id, now, detail, extra?)`, `Run.polled`, `Run.handed` (Task 8); `rebuttalsOwed(run)`, `checkRebuttals`, `endRound`, `onNewHead`, `logEvent` (`round.ts`); `isChargedRound` via `endRound` (Task 6).
- Produces: no new names. Behaviour: a poll with no turn in flight that sees a new PR head ends the round.

- [ ] **Step 1: Write the failing tests**

Append to `pr-lifecycle/tests/flow.test.ts` (it uses `early`, `ciRunning` and `triageTurns` from Task 8):

```ts
test('R92 (Review Focus 3): two pushes between polls end one round, on the newest head', async ($, on) => {
  const w = world(on)
  w.git.roster = ciRunning
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  await w.clock.advance(30_000)
  expect((await runOf(w)).round).toBe(2)
  // Someone pushes twice before the next poll; the gate only ever sees the second.
  w.gh.prHead = 'c'.repeat(40)
  w.gh.prHead = 'd'.repeat(40)
  w.git.head = 'd'.repeat(40)
  await w.clock.advance(30_000)
  const rec = await recordOf(w)
  const post = rec.rounds.filter(one => one.phase === 'post')
  expect(post.map(one => [one.n, one.startHead, one.endHead, one.isCompleted])).toEqual([[2, 'a'.repeat(40), 'd'.repeat(40), true]])
  // Nothing was found in it: the round is free (R88).
  expect(post[0]?.isCharged).toBe(false)
  expect(rec.head).toBe('d'.repeat(40))
  const next = await runOf(w)
  expect([next.round, next.phase, next.roundStartHead, next.roundKind, next.status]).toEqual([3, 'collect', 'd'.repeat(40), 'baseline', 'running'])
})

test('R92: a poll during a turn never ends the round; the turn\'s own end does', async ($, on) => {
  const w = world(on)
  w.git.roster = ciRunning
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  w.gh.comments = [early(inline(11, '**P2** this leaks a file handle', w.gh.prHead))]
  await w.clock.advance(60_000)
  expect(triageTurns(w, 'r2-triage')).toHaveLength(1)
  // The agent pushes, and a poll runs before its turn ends.
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await w.clock.advance(30_000)
  const during = await runOf(w)
  expect([during.round, during.phase, during.roundStartHead]).toEqual([2, 'triage', 'a'.repeat(40)])
  expect((await recordOf(w)).rounds.filter(one => one.phase === 'post')).toHaveLength(0)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P2', note: 'closed in finally', replyId: '991' }]))
  await done($, accept('r2-verify', w))
  const post = (await recordOf(w)).rounds.filter(one => one.phase === 'post')
  expect(post.map(one => [one.n, one.startHead, one.endHead])).toEqual([[2, 'a'.repeat(40), 'e'.repeat(40)]])
  expect((await runOf(w)).round).toBe(3)
})

test('R92 (Review Focus 4): a finding left unanswered when its round rolled over is answered in the next round', async ($, on) => {
  const w = world(on)
  w.git.roster = ciRunning
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  w.gh.comments = [early(inline(11, '**P2** this leaks a file handle', w.gh.prHead))]
  await w.clock.advance(60_000)
  // No answer, asked once more (R34), no answer again: the round goes on collecting with G2-1 open.
  await done($, triaged('r2-triage', []))
  await done($, triaged('r2-triage', []))
  expect((await runOf(w)).phase).toBe('collect')
  // Someone else's push ends round 2.
  w.gh.prHead = 'e'.repeat(40)
  w.git.head = 'e'.repeat(40)
  await w.clock.advance(30_000)
  expect((await runOf(w)).round).toBe(3)
  // Round 3 hands G2-1 to the agent again, under its own id, after one quiet poll.
  for (let i = 0; i < 3 && triageTurns(w, 'r3-triage').length === 0; i += 1) await w.clock.advance(30_000)
  expect(triageTurns(w, 'r3-triage')[0]).toContain('G2-1')
  await done($, triaged('r3-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P2', note: 'closed in the finally block', replyId: '991' }]))
  const g = (await recordOf(w)).findings.find(one => one.id === 'G2-1')
  expect(g?.status).toBe('rebutted')
  expect(g?.history.at(-1)?.round).toBe(3)
  expect((await recordOf(w)).processed).toContain('inline:11')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: FAIL. In 1.4.0 the poll that sees `d…d` moves round 2's start head and records no round, so `post` is empty.

- [ ] **Step 3: Implement**

In `pr-lifecycle/hooks/round.ts`, in `pollOnce`, directly after the `if (isTurn) { ... }` block from Task 8, add:

```ts
  // A push with no turn in flight ends the round on the head it had (R92): someone else's push, or the agent's outside a turn.
  if (isNewHead) {
    await onNewHead($, run, run.roundStartHead, got.prHead, now)
    const closed = await closeCollect($, run.id, now, `ended by the push of ${got.prHead.slice(0, 7)}`)
    if (closed === null) return
    await logEvent($, run.root, run.branch, 'head', `round ${run.round} ended on ${run.roundStartHead.slice(0, 7)}: the PR moved to ${got.prHead.slice(0, 7)}`)
    // What Codex owes is checked on the new head first (R72). Then the round ends, and decideNext opens the next one on the new head:
    // a round, or exhausted after a final-head check, never blocked (the head changed).
    const owed = rebuttalsOwed(closed)
    if (owed.length > 0) await checkRebuttals($, { ...closed, headSha: got.prHead }, owed)
    else await endRound($, { ...closed, headSha: got.prHead }, true)
    return
  }
```

Then remove the 1.4.0 in-round head move, which can no longer happen below this point:
- Delete the line `if (isNewHead) await onNewHead($, run, run.roundStartHead, got.prHead, now)` and the comment above it.
- In the `after` patch, delete `roundStartHead: got.prHead,`.
- Change `const headAt = got.headAt ?? (isNewHead ? now : collect.headAt)` (Task 4) to `const headAt = got.headAt ?? collect.headAt`.
- Change `const arrived = isNewHead || isArrival` to `const arrived = isArrival`, and delete the comment `// A new head restarts the quiet period: its checks may not be registered yet.` (`beginCollect` starts the new round's collection fresh).

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: the new tests pass. Existing tests where a push lands while a round collects now see one more round. Known ones:
- `pushMidCollect` (R56): after push C the run is round 4 on `c…c`, not round 3. Change its first `expect` after the push to `expect((await runOf(w)).roundStartHead).toBe('c'.repeat(40))` plus `expect((await runOf(w)).round).toBe(4)`.
- 'when no reviewer covers the head by the wait cap, Codex reviews the delta': the push to `b…b` ends round 2 at the first poll, and round 3's cap starts then. Advance `21 * 60_000` instead of `20 * 60_000`. `diffBase` is still `a…a`.

Fix each failure only where spec §1.2 changes the behaviour, and list every changed test in your report.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/round.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: a push ends the round on its head (R92)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 10: Reviewers are asked again once per turn that pushed (R93, spec §1.5)

**Why:** 1.4.0 re-requests the roster's `requestReview` reviewers at the start of every later post round (`beginCollect`). In 1.5.0 a push ends the round, so that would re-request on every push, including someone else's. Spec §1.5: re-request once, when the agent's turn ends, on the head it ends on.

**Plan ruling:** a push ends the round when the turn ends (Task 8), so one turn can push at most once per round: "the turn pushed" (`endHead !== run.roundStartHead` in `afterTriage`) is the whole condition, and no `Run.requestedHead` is kept. A rollover by someone else's push (Task 9) requests nothing.

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (`beginCollect`, `afterTriage`)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `w.gh.requests` (Task 5: every `-X POST .../requested_reviewers` call, in order); `rosterOf($, root, base)`; Tasks 8 and 9.
- Produces: no new names.

- [ ] **Step 1: Write the failing test**

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
test('R93: a turn that pushes re-requests the roster reviewers once; another\'s push and a new round request nothing', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]"],"requestReview":["claude[bot]"],"checks":["ci"]}'
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  await w.clock.advance(30_000)
  // Someone else pushes: round 2 ends, round 3 starts on c…c, and nobody is asked again.
  w.gh.prHead = 'c'.repeat(40)
  w.git.head = 'c'.repeat(40)
  await w.clock.advance(30_000)
  expect((await runOf(w)).round).toBe(3)
  expect(w.gh.requests).toHaveLength(0)
  // Feedback on c…c; the agent's turn pushes three commits, and GitHub reports the last.
  w.gh.comments = [early(inline(11, '**P2** this leaks a file handle', w.gh.prHead))]
  for (let i = 0; i < 3 && triageTurns(w, 'r3-triage').length === 0; i += 1) await w.clock.advance(30_000)
  w.git.head = 'f'.repeat(40)
  w.gh.prHead = 'f'.repeat(40)
  await done($, triaged('r3-triage', [{ id: 'G3-1', action: 'fixed', severity: 'P2', note: 'closed in finally', replyId: '991' }]))
  await done($, accept('r3-verify', w, { 'G3-1': true }))
  expect(w.gh.requests).toHaveLength(1)
  expect(w.gh.requests[0]).toContain('reviewers[]=claude[bot]')
  // Round 4 on f…f: nobody covers it by the cap, and one Codex review reads from the last covered head, a…a, over c…c and f…f.
  expect((await runOf(w)).roundStartHead).toBe('f'.repeat(40))
  await w.clock.advance(21 * 60_000)
  const run = await runOf(w)
  expect(run.phase).toBe('review')
  expect(run.diffBase).toBe('a'.repeat(40))
  expect(w.gh.requests).toHaveLength(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: FAIL. `beginCollect` requests at the start of round 3, so `w.gh.requests` has 1 entry after the first push.

- [ ] **Step 3: Implement**

In `pr-lifecycle/hooks/round.ts`:

1. In `beginCollect`, delete the block from `const rec = await loadRecord($, opened.root, opened.branch)` through the closing `}` of the `if (rec !== undefined && rec.rounds.some(...))` block, with its comment. Change the doc comment to: `/** Post-PR collection: the ticker polls GitHub every 30 s until GitHub's signals, or the wait cap, say it is over (R89). Reviewers are asked again where a turn pushed (R93), not here. */`
2. In `afterTriage`, inside `if (endHead !== run.roundStartHead) {`, after the exemption writes, add:

```ts
    // The turn pushed (R93): the roster's reviewers are asked again, once, for the head it ended on, however many commits it pushed.
    if (rec.pr !== undefined && rec.slug !== undefined) {
      const roster = await rosterOf($, run.root, run.base)
      for (const who of roster?.requestReview ?? []) {
        await $.process.run(['gh', 'api', '-X', 'POST', `repos/${rec.slug}/pulls/${rec.pr}/requested_reviewers`, '-f', `reviewers[]=${who}`], {
          cwd: run.root,
          timeoutMs: 30_000,
        })
      }
    }
```

   (`rec` here is the record `afterTriage` updated above.)

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A 1.4.0 test that expected a re-request at the start of a later round (search the tests for `requested_reviewers` and `requests`) now expects it at the end of the turn that pushed; update it and list it in your report.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/round.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: reviewers are asked again once per turn that pushed (R93)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---
