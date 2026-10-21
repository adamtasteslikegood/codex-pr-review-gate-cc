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
     │   ├─ fresh feedback no turn was handed, one quiet poll since the last
     │   │  arrival, no turn in flight → mid-collection triage turn (phase
     │   │  'triage', run.collect kept, so polls go on and only note arrivals);
     │   │  afterTriage records the answers without ending the round; if the
     │   │  turn pushed, its end closes the round on the new head and asks
     │   │  roster reviewers again once (Tasks 8-10)
     │   └─ collectionDone(signals) && no pending && nothing fresh unasked
     │        → endCollect: Codex fallback from diffBase if the head is
     │          uncovered, then the end-of-head triage (1.4.0 ending: checks,
     │          endRound, advance)
     ▼
  advance → decideNext
     ├─ round / ready / blocked: as 1.4.0 (ready now says "merge now")
     └─ exhausted / awaiting-decision (post):
          fileIssues: 1) a held blocker first raised in the last completed post
          round or the last charged round, gate grants < 2, and the grant
          starts a round → grant by 'gate'; else 2) file or label an issue for
          every held finding Codex has ruled on, except security (a lost
          severity files as P1) → settle → decide again (ready → the agent
          merges → closeLifecycle checks every follow-up issue, reopening or
          refiling it, then archives)
  ```
- Charging (R88) is post-PR only: a pre-PR round is always charged, as in 1.4.0.
- A triage turn during collection reuses `beginTriage`/`afterTriage`. `afterTriage` tells it by `run.collect !== undefined` and skips the round's ending (Task 8).
- Everything else is additive. Where behaviour deliberately changes (R85's early P3 settle, the ready prompt, waivers for non-security findings, the quiet window), the old tests are updated in the task that changes it.

**Tech Stack:**
- TypeScript 6.0.3, as a Claude Code plugin (`claude-code` engine API).
- Tests run through `claude plugin test` with the fakes in `pr-lifecycle/tests/world.ts`.
- ESLint with `@stylistic`.

**Spec:** `docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md`, including the M2 and M3 amendments (§5.10-5.12) and §7.4 (#24). Read it first. Then read `CLAUDE.md` (repo rules) and the rulings doc `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md` (R1-R87). This plan adds R88-R94.

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

1. **Resume after a reviewer already commented (#24).** A roster reviewer's issue comment (no `commit_id`) posted after the gate first saw the head but before `/pr-gate resume` still covers the head (the time is GitHub's push time from the activity log, kept as the record's `headArrival`; never a commit or check time; PR #25 review). The round must not wait out the cap. Test in Task 4.
2. **This machine's login in `requested_reviewers`.** The person may request a review from themselves (the same gh login as `self`). The gate must not wait for that review. Test in Task 5.
3. **Two pushes between two polls.** The gate sees only the last head. It must close one round on the old head and open one on the newest, never one round per commit, and must not crash on the commit it never saw. Test in Task 9.
4. **An answer that names a finding raised in a round that has since rolled over.** The agent answers G3-2 after its push ended round 3. The answer applies to G3-2, and it is not dropped as unasked. Test in Task 9.
5. **A linked duplicate whose original is security.** The linked item holds with the original. It is never filed as an issue, because the original is security and needs the person. Test in Task 12.

---
## File Map

| File | What changes |
| --- | --- |
| `pr-lifecycle/types/index.d.ts` | `FindingEvent.answer` (Task 2), `FindingEvent.deferral` (Task 11); `Finding.duplicateOf`, `linkBy`, `isLinkChecked` (Task 7), `Finding.issueError` (Task 12); `RoundRecord.isCharged` (Task 6); `Grant.by` (Task 12); `LifecycleRecord.ownReplies` (Task 3); `Run.handed`, `Run.polled` (Task 8); `Blocker` kinds (Tasks 7, 11, 12); `MergeMethod` (Task 13) |
| `pr-lifecycle/hooks/github.ts` | `severityHint` tag forms (Task 1); `Check.startedAt` (Task 4); `collectionDone` signals and `readRequested` (Task 5) |
| `pr-lifecycle/hooks/lifecycle.ts` | `isAcknowledged` (Task 2); charging (Task 6); linking (Task 7); deferral check (Task 11); settling by issue, the late-blocker grant, `issueTitle`/`issueBody`, `planIssues` (Task 12) |
| `pr-lifecycle/hooks/core.ts` | `replyIdsOf` (Task 3); `readLinks`, triage and verify prompts (Tasks 7, 8, 11, 12); `readyPrompt`, `personPost`, `reportPrompt` (Task 12); `mergeStep`, `readyPrompt(rec, method)` (Task 13) |
| `pr-lifecycle/hooks/round.ts` | `fetchFeedback` (Tasks 3, 4, 5); `pollOnce`, triage during collection, rollover (Tasks 8, 9); re-requests (Task 10); deferral check (Task 11); `fileIssues` replaces `labelDeferrals` (Task 12); `checkIssuesAfterMerge`, `closeLifecycle` (Task 15); `issueSpec`, `mergeMethod` settings (Tasks 12, 13) |
| `pr-lifecycle/hooks/register.tsx` | status text (Tasks 11, 12); the waiver notes tell the agent to merge (Task 13); `onMerged` after the agent's merge (Task 15) |
| `pr-lifecycle/tests/world.ts` | knobs: `commitDate` (Task 4), `requested`, `requests` (Task 5), `issueAnswer`, `issueNumber`, `filed`, `onIssue` (Task 12); `issueStates`, `reopenAnswer`, `reopened`, `mergeAnswer` (Task 15) |
| `pr-lifecycle/tests/*.test.ts` | the tests in each task |
| docs | rulings R88-R94, LIFECYCLE_SPEC.md, ROADMAP.md, READMEs, CLAUDE.md (Task 16) |

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

- [ ] **Step 4a: Amendment A5 (PR #25 review): a head's time is when the gate first saw it, kept in the record**

This step **replaces** the timestamp source in Steps 1-3. Codex showed that commit and check timestamps break the invariant: a commit authored before an earlier comment and pushed later makes that comment cover the new head, and a check that starts after a reviewer's comment makes a valid comment miss it (#24 again). Do not add `Check.startedAt`, `headArrival` or the `commitDate` knob. Instead:

- Add to `LifecycleRecord` (`types/index.d.ts`): `/** When the PR's head reached the PR (#24), kept across stop, resume and another session: GitHub's push time, else when the gate first saw it. */ headArrival?: { head: string; at: number; isPushTime: boolean }`.
- **The push time comes from GitHub (Adam: "the gate can't get stuck").** GitHub's repository activity log records each push with the
  head it moved the branch to: `gh api 'repos/<head repo>/activity?ref=refs/heads/<branch>&per_page=100' --jq '.[] | select(.after == "<head>") | .timestamp'`
  (`activity_type` `push` or `force_push`; for a PR from a fork, the head repo is the fork's). Checked live on this repo, 2026-10-21:
  the push of a47400f reads 13:57:14Z. Add `pushTimeOf($, rec, head): Promise<number | undefined>` in `round.ts` (30 s timeout;
  undefined on any failure or no match). It returns the **latest** transition into the head, never the earliest: a branch can revisit a
  sha (A at 10, B at 20, a comment on B at 30, a force-push back to A at 40), and only the last arrival of A is A's arrival now (PR #25
  review, A→B→A).
- When the gate first sees a PR head (`onOpened`, `beginCollect`, and `pollOnce` when `isNewHead`) and `rec.headArrival?.head !== head`,
  it reads `pushTimeOf`. It writes `headArrival: { head, at, isPushTime }`: `at` is the push time when GitHub gave it (never later
  than now), else `now` with `isPushTime: false`. Each `beginCollect` reads `pushTimeOf` again even when the stored head matches: a
  latest transition later than the stored time means the branch left the head and came back while no session saw it, and the later time
  replaces the stored one. The same holds within a collection (PR #25 review, A→B→A between two polls): before a poll ends
  collection on coverage that rests on an issue comment (no `commit_id`), it reads `pushTimeOf` again; a later transition moves
  `headArrival.at` and `collect.headAt` to it, and coverage is computed again on that poll. A failed read keeps the stored time and
  does not hold the end of collection (the gate can't get stuck). Reviews by `commit_id` need no re-read. When a later poll finds the push time for a
  head stored with `isPushTime: false`, it replaces `at` with it (it is earlier) and sets `isPushTime: true`; try once per poll, at most
  until collection ends.
- `beginCollect` and `pollOnce` take `collect.headAt` from `rec.headArrival` for that head, else `now`. Reviews still cover a head by
  `commit_id`, whatever their time.
- **No silent wait on a guess.** If the push time is still unknown and a roster reviewer has an issue comment on the PR created after the
  head commit's committer date but before `headArrival.at` (it may or may not be about this head), the gate never waits out the cap for it:
  - the reviewer is in `requestReview`: the gate asks again at once, with the POST to `requested_reviewers` that `beginCollect` already
    makes (1.4.0), once per head, and logs `<login>: comment at <time> may predate <head7>; asked again`. Its reply covers the head.
  - otherwise (it cannot be asked): the comment counts as covering the head, and the gate logs
    `<login>: comment at <time> counted for <head7>; GitHub gave no push time`. A rare false coverage is the cost; a stuck gate is not
    accepted (Adam, 2026-10-21).
- Never commit or check-run times as the arrival (PR #25 review).

Record as plan rulings: the push time is GitHub's activity log; first-seen is only the fallback, and an ambiguous comment gets a
re-request, or counts when the reviewer cannot be asked, never a 20-minute wait.

Tests (flow), replacing Step 1's check-run fixtures. Add a world knob `w.gh.pushes: { after: string; timestamp: string }[]` answering the activity call (an unknown ref or `undefined` answers `[]`; a knob to make it fail):
1. #24: the head was pushed at T (in `pushes`), the gate is stopped, a roster reviewer's issue comment comes at T+60 s, `/pr-gate resume` much later: the comment covers the head and the phase reaches `ready`.
2. A push the gate never saw: pushed at 100 s (in `pushes`), comment at 120 s, the gate first sees the head at 600 s: the comment covers it.
3. Push at 100 s, comment at 50 s, commit dated 10 s: the comment does not cover the head.
4. Push at 100 s, comment at 120 s, a check run starting at 200 s: the comment covers it.
5. The activity call fails, a `requestReview` reviewer's comment falls between the commit date and first-seen: one re-request POST and its log line, no 20-minute wait; the reviewer's later reply covers the head.
5b. Same, for a roster reviewer not in `requestReview`: the comment counts at once, with the "counted" log line, and collection ends without the cap.
6. The activity call fails at first sight and works at the next poll: `headArrival.at` moves earlier to the push time, `isPushTime` becomes true.
7. A record whose `headArrival` names an older head: the new head is looked up afresh; the old time is never reused.
8. A→B→A: pushes A at 10, B at 20, a roster comment at 30, a force-push to A at 40 (all in `pushes`), the gate first sees A at 50: `headArrival.at` is 40 and the comment does not cover A.
9. The record holds A at 10 (`isPushTime: true`); the branch went to B and back to A at 40 while no session ran; `/pr-gate resume`: `beginCollect` moves A's time to 40.
10. During one collection: A stored at 10; between two polls the branch goes to B at 20, a roster issue comment arrives at 25, and the branch returns to A at 30. The next poll sees the same sha: it re-reads the push time before ending, moves `headAt` to 30, and the comment at 25 does not cover A; collection keeps waiting.
11. Same, with the re-read failing: collection ends on the comment as before (no hold on a failed read), and the log notes the failed check.

Use the most capable model for this task: the code is prose here, not given.

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

- [ ] **Step 5a: Amendment A1-A3 (PR #25 review): links never drop a hold**

Three holes Codex reproduced with the planned helpers. Fix each one and pin it with a test:

- **A1 (security).** `withLinkedPeak` raises security as well as severity. The original gets `isSecurity: true` when either one has it, even when a peak is unknown. A link never clears it, and neither does `dropLink` on the original. Tests, in both directions:
  - A non-security original with a security duplicate linked to it: the original is `isSecurity`, `mergeHolds` still holds it for the person, and `isFileable(original)` is false (Task 12's predicate; add the assertion there if Task 12 is not built yet).
  - A security original with a non-security duplicate: it stays security.
- **A2 (no self-links).** Validate an agent's link on canonical ids. In `afterTriage`, `const canon = (id: string) => byId.get(id)?.duplicateOf ?? id` over the round's ledger and the record. A link is no answer when `canon(link.duplicateOf) === link.id`, or when either id is not on the list. When the finding being linked is itself an original with linked findings, point those at the new canonical target in the same patch, so links never chain. Tests:
  - B is linked to A, and the agent answers `A duplicateOf B`: no answer. A still holds and is asked again, and B still holds through A.
  - B is linked to A, and the agent answers `A duplicateOf C`: A and B both point at C.
  - Validate the whole proposed link graph before applying the batch, not just each link against the pre-update ledger. Reject every proposed link participating in a self-link or cycle as no answer; leave those findings holding and ask again. Only commit the remaining acyclic links, canonicalize their targets and re-point existing aliases in the same patch. Codex agreeing that two reports concern the same problem must never be enough to accept a cyclic ownership graph.
  - Two previously unlinked findings A and B are answered in one trailer with `A duplicateOf B` and `B duplicateOf A`: neither link is applied, both findings remain held, and no finding disappears after a later link-check result. Also test a three-finding cycle and an acyclic A→B→C batch; the latter ends with A and B pointing at C.
- **A3 (R33 on the original).** In `triage`, resolve each candidate to its canonical original before the R33 (`isAnswerTo`) and `needsRecheck` predicates. Skip the candidate if the original or the alias fails either predicate. Test: A is rebutted and the rebuttal accepted; B is linked to A and still has status `open`; a later objection C matching B is `new-on-reviewed`, not a duplicate of A.

- [ ] **Step 6: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/core.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: one finding per problem; linked duplicates follow their original (R90)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---


### Task 8: The agent answers feedback while collection still waits (R88, spec §1.1, §1.2)

**Why:** In 1.4.0 the agent sees nothing until collection ends (roster covered, checks done, quiet window, or the 20-minute cap). In 1.5.0, feedback that arrives while collection is still waiting goes to the agent after one quiet poll, in a triage turn that does not end the round. A push in that turn ends the round when the turn ends.

**Plan rulings (record them in Task 16's rulings):**
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

test('R88: feedback is answered while collection waits, after one quiet poll, and the round goes on collecting', async ($, on) => {
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

test('R88: a push in a mid-collection turn ends the round on the old head when the turn ends', async ($, on) => {
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
  /** Post-PR: the feedback ids every triage turn of this round was handed (R88); a turn while collecting asks only what is not in it. */
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
        // Collection polls on while a triage turn answers what arrived (R88); only the turn itself has a step timeout.
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
  // While a triage turn answers, a poll only notes what arrived; the turn's own end reads the head it pushed (R88).
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
  // Feedback no turn of this round was handed, with one quiet poll since the last arrival: the agent answers it now (R88).
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
   - Change the signature to `async function beginTriage($: Engine, id: string, isFromCommand = false, isMidCollect = false): Promise<void>` and its doc comment's first sentence to: `Triage: the round's fresh GitHub feedback, Codex's open findings when it ran, and blockers still open from earlier rounds (R32) go to the main agent in one turn. While collection still waits (R88), only the fresh feedback no turn of the round was handed.`
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
  // A turn while collecting that pushed nothing: the round goes on collecting on the same head (R88). Its rebuttals and
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
  // A push in a turn while collecting ends the round on the head it pushed (R88): collection on the old head is over.
  if (after.collect !== undefined) await closeCollect($, run.id, await $.clock.now(), `ended by the push of ${endHead.slice(0, 7)}`)
```

   The rest of the tail (`onNewHead`, the exemption, `checkRebuttals` or `endRound`, then `advance` → `startRound` → `beginCollect` on the new head) is 1.4.0's and ends the round.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A test that relied on `Run.triaged` being rewritten by every poll now reads `Run.polled`; update only those and list them in your report.

- [ ] **Step 3a: Amendment A4 (PR #25 review): the turn guard lasts until `afterTriage` finishes**

`afterTriage` clears `pending` in its first patch and then awaits record, git and GitHub reads. A poll in that gap would see no turn, take Task 9's rollover and open the next round. `startRound` keeps the run's id, so the old continuation's id and status guards would not stop it touching the new round. Fix:

- Add `Run.isSettling?: true` (`types/index.d.ts`): `/** afterTriage is between clearing the turn and its last write: polls only note arrivals (R88). */`.
- Set it in the same patch that clears `pending` in `afterTriage`. Clear it in every patch that ends `afterTriage`: the back-to-collecting patch in Step 3, `closeCollect`'s `extra`, the `endRound` and `advance` paths, every early return that writes, and `finish`. Also clear it in `startRound`'s patch, so a new round never inherits it.
- In `pollOnce`, `const isTurn = run.pending.length > 0 || run.isSettling === true`.
- In `afterTriage`, keep `round` and `generation` from the start. After each awaited read, reload the run and the record, and return without writing if the run's `round`, `status` or the record's `generation` changed.
- Test (flow): hold `afterTriage`'s PR-head read with a world gate that releases on demand, after `pending` has cleared. Tick with a pushed head while it is held, then release it. Exactly one new round opens, after `afterTriage` ends. The old round's triage step is done, and the new round's steps are untouched.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: the agent answers feedback while collection waits (R88)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 9: A push ends the round on its head (R88, spec §1.2, §1.3, §1.6)

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
test('R88 (Review Focus 3): two pushes between polls end one round, on the newest head', async ($, on) => {
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

test('R88: a poll during a turn never ends the round; the turn\'s own end does', async ($, on) => {
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

test('R88 (Review Focus 4): a finding left unanswered when its round rolled over is answered in the next round', async ($, on) => {
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
  // A push with no turn in flight ends the round on the head it had (R88): someone else's push, or the agent's outside a turn.
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
git commit -m "pr-lifecycle 1.5.0: a push ends the round on its head (R88)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 10: Reviewers are asked again once per turn that pushed (R88, spec §1.5)

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
test('R88: a turn that pushes re-requests the roster reviewers once; another\'s push and a new round request nothing', async ($, on) => {
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

1. In `beginCollect`, delete the block from `const rec = await loadRecord($, opened.root, opened.branch)` through the closing `}` of the `if (rec !== undefined && rec.rounds.some(...))` block, with its comment. Change the doc comment to: `/** Post-PR collection: the ticker polls GitHub every 30 s until GitHub's signals, or the wait cap, say it is over (R89). Reviewers are asked again where a turn pushed (R88), not here. */`
2. In `afterTriage`, inside `if (endHead !== run.roundStartHead) {`, after the exemption writes, add:

```ts
    // The turn pushed (R88): the roster's reviewers are asked again, once, for the head it ended on, however many commits it pushed.
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
git commit -m "pr-lifecycle 1.5.0: reviewers are asked again once per turn that pushed (R88)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

---

### Task 11: Codex checks every deferral (R92 M2, spec §5.1)

**Why:** in 1.4.0 a deferral after the PR opens goes straight to the person (R45), and only a P3 whose severity the agent lowered goes to Codex (R85's lowering check). Adam (2026-10-21): every blocking or advisory finding first goes through Codex and a fix attempt. A deferral at any severity goes to Codex in the round's free check, as a rebuttal does. If Codex says it can be fixed in this PR, the finding is open again, goes back to the agent, and the round is charged. If Codex agrees it is out of scope, it waits. This task replaces R85's lowering check with this deferral check. R85's early settle of a P3 with a labelled issue stays for now, but only after Codex agreed. Task 12 replaces that settle with the filing pass.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`FindingEvent`, `Blocker`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`checksOwed`, the R85 lowering functions, `wouldSettle`, `blockerOf`, `decidePost`, `awaiting`)
- Modify: `pr-lifecycle/hooks/round.ts` (`checkLabel` about line 1721, `afterRebuttalCheck` about line 1812, imports)
- Modify: `pr-lifecycle/hooks/core.ts` (`verifyPrompt` about line 569, `triagePrompt` step 2 about line 707, imports)
- Modify: `pr-lifecycle/hooks/register.tsx` (`statusText` about line 824, imports)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `isChargedRound` and `REJECTABLE` (Task 6; `'deferred'` is already in `REJECTABLE`, so a refusal charges the round with no change there). `markHeld` (`lifecycle.ts`).
- Produces (Task 12 relies on these):
  - `FindingEvent.deferral?: 'agreed' | 'refused'`: Codex's ruling on the agent's deferral.
  - `export const isDeferralOwed = (f: Finding): boolean`: deferred, with no Codex ruling since the agent's last deferral. Any severity, security included.
  - `export const isDeferralAgreed = (f: Finding): boolean`: deferred, and Codex's last ruling since the agent's last deferral is `'agreed'`.
  - `export function ruleDeferral(f: Finding, holds: boolean, round: number, at: number, note?: string): Finding`.
  - Blocker kind `'deferral-unchecked'` (owner `codex`) replaces `'lowering-unchecked'`.
- Removed: `isLoweringOwed`, `loweringRefusal`, `ruleLowering` and the private `loweringRuling`. `loweringOf` stays: the deferral prompt still says when the agent lowered the severity. `FindingEvent.lowering` stays in the type, for records written by 1.4.0.
- Rulings for the plan:
  - The deferral check is post-PR only, like the rebuttal check (`checksOwed` is read only after the PR opens). Before the PR, the next Codex review already sees each deferral among the prior answers.
  - A deferral from a 1.4.0 record, even one whose lowering Codex agreed with, has no `deferral` ruling, so Codex checks it once more. Cost: one free check per such finding.
  - A deferral Codex refused is `open`. The agent may fix it, rebut it, or defer it again with a better reason. A new deferral is checked again, and each refusal charges its round, so the allowance bounds the loop.
  - Codex's check also rules on a lowered severity: a deferral holds only when the finding cannot reasonably be fixed in this PR and its severity stands.

- [ ] **Step 1: Write the failing tests**

In `pr-lifecycle/tests/lifecycle.test.ts`, in the import from `'../hooks/lifecycle'`, remove `isLoweringOwed`, `loweringRefusal` and `ruleLowering`, and add `isDeferralAgreed`, `isDeferralOwed` and `ruleDeferral`. Below the `finding` helper, add:

```ts
/** Codex agreed with the finding's deferral (R92 M2). */
const agreedBy = (f: Finding): Finding => ruleDeferral(f, true, 9, 9)
```

Replace the test `'R85: a severity the agent lowered settles only once Codex agrees with the lowering (Adam, 2026-10-20)'` with:

```ts
test('R92: every deferral waits on Codex; agreed it waits, refused it is open again and charges the round (Adam, 2026-10-21)', async () => {
  // A P2 deferral, a security deferral and a P3 deferred to an issue all go to Codex.
  const p2 = applyAnswer(finding({ source: 'github', severity: 'P2', severitySource: 'tag' }), { id: 'R1-1', action: 'deferred', note: 'needs a schema change' }, 2, 'main', 5)
  expect(isDeferralOwed(p2)).toBe(true)
  expect(isDeferralOwed({ ...p2, isSecurity: true })).toBe(true)
  const p3 = { ...applyAnswer(finding({ source: 'github', severity: 'P3', severitySource: 'tag' }), { id: 'R1-1', action: 'deferred', followUp: '#12' }, 2, 'main', 5), followUpLabel: 'P3' as const }
  expect(isDeferralOwed(p3)).toBe(true)
  expect(wouldSettle(p3)).toBe(false)
  expect(isSettledDeferral(p3)).toBe(false)
  expect(checksOwed([p2, p3]).map(one => one.id)).toEqual(['R1-1', 'R1-1'])
  // Agreed: it stays deferred and waits; Codex is not asked again.
  const agreed = ruleDeferral(p2, true, 2, 6)
  expect(agreed.status).toBe('deferred')
  expect(agreed.history.at(-1)).toMatchObject({ round: 2, status: 'deferred', deferral: 'agreed', by: 'codex', at: 6 })
  expect(isDeferralOwed(agreed)).toBe(false)
  expect(isDeferralAgreed(agreed)).toBe(true)
  expect(checksOwed([agreed])).toEqual([])
  expect(isSettledDeferral(agreedBy(p3))).toBe(true)
  // Refused: open again with Codex's reason, back to the agent; the refusal charges the round it is in.
  const refused = ruleDeferral(p2, false, 2, 6, 'a one-line guard fixes it')
  expect(refused.status).toBe('open')
  expect(refused.history.at(-1)).toMatchObject({ round: 2, status: 'open', note: 'a one-line guard fixes it', deferral: 'refused', by: 'codex' })
  expect(isDeferralOwed(refused)).toBe(false)
  expect(isChargedRound([refused], 2)).toBe(true)
  expect(isChargedRound([agreed], 2)).toBe(false)
  // Deferred again after the refusal: Codex checks the new deferral.
  const again = applyAnswer(refused, { id: 'R1-1', action: 'deferred', note: 'the guard breaks the public API' }, 3, 'main', 7)
  expect(isDeferralOwed(again)).toBe(true)
  // A deferral from a 1.4.0 record, whose lowering Codex agreed with, is checked once more: a lowering ruling is not a deferral ruling.
  const legacy = { ...p3, history: [...p3.history, { round: 2, status: 'deferred' as const, lowering: 'agreed' as const, by: 'codex', at: 6 }] }
  expect(isDeferralOwed(legacy)).toBe(true)
  // The agent's lowering is still read, for the prompt.
  const lowered = applyAnswer(finding({ source: 'github', severity: 'P1', severitySource: 'hint' }), { id: 'R1-1', action: 'deferred', severity: 'P3', note: 'only a typo', followUp: '#12' }, 2, 'main', 5)
  expect(loweringOf(lowered)).toMatchObject({ from: 'P1', to: 'P3' })
  expect(isDeferralOwed(lowered)).toBe(true)
})
```

Add `isChargedRound` to the imports if Task 6 did not. In the same file, update the other R85 tests so a deferral that should settle has Codex's agreement:
- `'R85: isSettledDeferral needs deferred, P3, an issue follow-up, its label and no security flag'`: `const base = agreedBy(finding({ ... }))` (same fields as now). Add after the last line: `expect(isSettledDeferral({ ...base, history: [] })).toBe(false)`, with the comment `// Codex has not agreed with the deferral: it waits on the check (R92 M2).`
- `'gate R7-6: ...'`: `const base = agreedBy(finding({ ... }))`. Replace the two `isLoweringOwed` lines with `expect(wouldSettle(agreedBy(legacy))).toBe(false)`, with the comment `// Even with Codex agreeing, the lost peak keeps it from settling on its own.` Make the last line `expect(wouldSettle(agreedBy({ ...again, followUpLabel: 'P3' }))).toBe(false)`.
- `'R85: a follow-up settles only when it names a GitHub issue (Adam, 2026-10-20)'`: `const base = agreedBy(finding({ ... }))`.
- `'R85: a deferral without a follow-up clears the earlier one and its label (final review T4)'`: `const first = { ...agreedBy(applyAnswer(tagged, { ... }, 2, 'main', 5)), followUpLabel: 'P3' as const }`. Make the last line `expect(wouldSettle(agreedBy(moved))).toBe(true)`.
- `'R85: the ready prompt names the follow-up of a settled deferral and not of a plain one'`: `const settled = agreedBy(finding({ ... }))`.

Replace the test `'R85: a lowering owed Codex, one Codex refused, and an issue the gate could not label each hold with their own owner'` with:

```ts
test('R92: a deferral owed Codex holds as Codex\'s; one Codex refused is open; an issue the gate could not label holds as the agent\'s', async () => {
  const deferred = applyAnswer(finding({ id: 'G2-1', source: 'github', reviewer: 'mallory', severity: 'P1', severitySource: 'hint' }), { id: 'G2-1', action: 'deferred', severity: 'P3', followUp: '#12' }, 2, 'main', 5)
  const owed = standingOf(postRec({ findings: [deferred] }), { head: 'a', base: 'dev' }).blockers
  expect(owed.map(one => [one.id, one.kind, one.owner])).toEqual([['G2-1', 'deferral-unchecked', 'codex']])
  expect(owed[0]?.said).toBe('G2-1 [P3] comment from mallory: deferred, Codex has not checked the deferral')
  const refused = ruleDeferral(deferred, false, 2, 6, 'it loses data')
  const held = standingOf(postRec({ findings: [refused] }), { head: 'a', base: 'dev' }).blockers
  expect(held.map(one => [one.id, one.kind, one.owner])).toEqual([['G2-1', 'open', 'agent']])
  const failed = { ...ruleDeferral(deferred, true, 2, 6), followUpLabelError: 'HTTP 404: Not Found' }
  const label = standingOf(postRec({ findings: [failed] }), { head: 'a', base: 'dev' }).blockers
  expect(label).toEqual([{
    kind: 'label-failed', id: 'G2-1', said: 'could not label issue #12 severity:P1 (HTTP 404: Not Found)', owner: 'agent',
    release: 'check the issue exists and gh can edit it; the gate retries on the next pass',
  }])
  const pending = standingOf(postRec({ findings: [ruleDeferral(deferred, true, 2, 6)] }), { head: 'a', base: 'dev' }).blockers
  expect(pending.map(one => [one.id, one.kind, one.owner])).toEqual([['G2-1', 'label-owed', 'gate']])
  // The controller sends a deferral to Codex, never to the person; a refusal goes back to the agent.
  const next = decideNext(postRec({ findings: [deferred] }))
  expect(next).toMatchObject({ kind: 'blocked', recheck: ['G2-1'] })
  expect(next.kind === 'blocked' ? next.why : '').toBe('Codex has not checked the deferral of G2-1')
  expect(next.kind === 'blocked' ? next.nextStep : '').toBe('run /pr-gate resume: Codex checks the deferral on this head, using no review round')
  const back = decideNext(postRec({ findings: [refused] }))
  expect(back).toMatchObject({ kind: 'blocked', answer: ['G2-1'] })
  expect(back.kind === 'blocked' ? back.why : '').toBe('Codex says G2-1 can be fixed in this PR: it loses data')
  // Agreed and not an issue P3: the person's, as in 1.4.0 (Task 12 files its issue instead).
  const p2 = ruleDeferral(applyAnswer(finding({ id: 'G2-1', source: 'github', severity: 'P2', severitySource: 'tag' }), { id: 'G2-1', action: 'deferred', note: 'later' }, 2, 'main', 5), true, 2, 6)
  expect(decideNext(postRec({ findings: [p2] })).kind).toBe('awaiting-decision')
})
```

In `pr-lifecycle/tests/flow.test.ts`:

1. In `toAwaiting`, after the `triaged` line, add the Codex check:
   ```ts
     // Codex checks the deferral first, in the round's free check (R92 M2).
     await done($, accept('r2-verify', w))
   ```
2. Every other flow test where a triage answer defers a finding and the test then expects the lifecycle to move on (ready, awaiting-decision, a label call, a status line) now meets a verify step first. Add `await done($, accept('r<n>-verify', w))` right after that `triaged` call, where `<n>` is the round in the step name, unless the test already answers a verify step there. The R85 tests at about lines 3411-3600 and the gate R7-7, G7-8 and R8-2 tests are among them. Run `grep -n "action: 'deferred'" pr-lifecycle/tests/flow.test.ts` to find them all, and list each test you changed in your report.
3. Replace the test `'R85: a guessed P1 the agent lowers to P3 waits on Codex; Codex agrees, and the issue carries severity:P1 (Adam, 2026-10-20)'` with:

```ts
test('R92: a deferral waits on Codex\'s check; a lowered P3 Codex agrees with carries severity:P1 on its issue (Adam, 2026-10-21)', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'This is a critical bug.\n\nNit: the comment has a typo.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'only the typo is real', followUp: 'KAN-9 #12', replyId: '992' }]))
  // Not ready: Codex checks the deferral in the round's own check, using no round.
  expect((await runOf(w)).phase).toBe('verify')
  expect((await recordOf(w)).phase).not.toBe('ready')
  const asked = w.spawned.at(-1)?.prompt ?? ''
  expect(asked).toContain('The main agent deferred these findings instead of fixing them in this PR.')
  expect(asked).toContain('The agent lowered it from P1 to P3. Follow-up: KAN-9 #12. Its reason: only the typo is real')
  expect(asked).toContain('This is a critical bug.')
  expect(asked).toContain('holds is true when it cannot reasonably be fixed in this PR and its severity stands')
  expect(w.gh.labelled).toEqual([])
  await done($, accept('r2-verify', w))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  expect(rec.findings.find(one => one.id === 'G2-1')?.history.at(-1)).toMatchObject({ by: 'codex', status: 'deferred', deferral: 'agreed' })
  // The peak, not the lowered severity, goes on the issue.
  expect(labelled(w, 12, 'P1')).toBe(true)
  expect(w.prompts.at(-1)).toContain('(follow-up at KAN-9 #12, labelled severity:P1)')
})
```

4. Replace the test `'R85: Codex disagreeing with a lowering leaves the deferral to the person, with its reason (Adam, 2026-10-20)'` with:

```ts
test('R92: Codex refusing a deferral opens it again for the agent, with its reason, and charges the round (Adam, 2026-10-21)', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'This is a critical bug.\n\nNit: the comment has a typo.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'only the typo is real', followUp: '#12', replyId: '992' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'the comment reports a real crash' }))
  const rec = await recordOf(w)
  const found = rec.findings.find(one => one.id === 'G2-1')
  expect(found?.status).toBe('open')
  expect(found?.history.at(-1)).toMatchObject({ by: 'codex', status: 'open', deferral: 'refused', note: 'the comment reports a real crash' })
  expect(rec.rounds.filter(one => one.phase === 'post').at(-1)?.isCharged).toBe(true)
  // The agent is told, with Codex's words; the person is not asked to waive anything.
  expect(w.prompts.at(-1)).toContain('Codex says G2-1 can be fixed in this PR: the comment reports a real crash')
  expect(w.prompts.at(-1)).not.toContain('/pr-gate waive G2-1')
  expect(w.gh.labelled).toEqual([])
})
```

5. Add:

```ts
test('R92: Codex agreeing with a P2 deferral leaves it deferred, using no round', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w, 'Consider renaming this', { severity: 'P2' })
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.history.at(-1)).toMatchObject({ by: 'codex', status: 'deferred', deferral: 'agreed' })
  expect(rec.rounds.filter(one => one.phase === 'post').at(-1)?.isCharged).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts`
Expected: FAIL: `ruleDeferral`, `isDeferralOwed` and `isDeferralAgreed` are not exported.

- [ ] **Step 3: Implement the types**

In `pr-lifecycle/types/index.d.ts`, replace the `FindingEvent` doc comment and add `deferral`:

```ts
/**
 * `severity`: the severity an answer set, with `from` the one before it (R85). `lowering`: Codex's ruling on the agent's lowering of
 * the severity before it, on a record from 1.4.0 (R85, replaced by `deferral`). `deferral`: Codex's ruling on the agent's deferral
 * (R92 M2): agreed, it cannot reasonably be fixed in this PR; refused, it can, and the finding is open again.
 */
export type FindingEvent = {
  round: number
  status: FindingStatus
  note?: string
  evidence?: string
  severity?: Severity
  from?: Severity
  lowering?: 'agreed' | 'refused'
  deferral?: 'agreed' | 'refused'
  by: string
  at: number
}
```

(Keep any field an earlier task added to `FindingEvent`, such as `answer` from Task 2.) In `Blocker['kind']`, replace `'lowering-unchecked'` with `'deferral-unchecked'`.

- [ ] **Step 4: Implement the deferral check in `lifecycle.ts`**

1. Delete `loweringRuling`, `isLoweringOwed`, `loweringRefusal` and `ruleLowering` with their doc comments. Keep `loweringOf` and `isIssueDeferral`.
2. After `isIssueDeferral`, add:

```ts
/** Where the agent last deferred the finding in its history, or -1 when the history records no deferral of the agent's. */
const lastDeferral = (f: Pick<Finding, 'history'>): number =>
  f.history.reduce((found, one, i) => (one.status === 'deferred' && one.by !== 'codex' ? i : found), -1)

/** Codex's ruling on the agent's last deferral (R92 M2), if it gave one since. A 1.4.0 lowering ruling is not one. */
const deferralRuling = (f: Finding): FindingEvent | undefined =>
  f.history.slice(lastDeferral(f) + 1).filter(one => one.by === 'codex' && one.deferral !== undefined).at(-1)

/**
 * A deferral Codex has not ruled on (R92 M2, Adam 2026-10-21): at any severity, security included. The round's free check rules on
 * it, as on a rebuttal; nothing settles by an issue, or waits for the person, before it.
 */
export const isDeferralOwed = (f: Finding): boolean => f.status === 'deferred' && deferralRuling(f) === undefined

/** A deferral Codex agreed cannot reasonably be fixed in this PR (R92 M2): it waits. */
export const isDeferralAgreed = (f: Finding): boolean => f.status === 'deferred' && deferralRuling(f)?.deferral === 'agreed'

/**
 * Codex's ruling on a deferral (R92 M2): agreed, it stays deferred and waits; refused, it is open again with Codex's reason and goes
 * back to the agent. The refusal is a Codex `open` right after a deferral, so `isChargedRound` charges the round it is in (R88).
 */
export function ruleDeferral(f: Finding, holds: boolean, round: number, at: number, note?: string): Finding {
  if (holds) {
    const said = note ?? 'Codex: it cannot reasonably be fixed in this PR'
    return { ...f, history: [...f.history, { round, status: 'deferred', note: said, deferral: 'agreed', by: 'codex', at }] }
  }
  const held = markHeld(f, round, 'codex', at, note ?? 'Codex: it can be fixed in this PR')
  const last = held.history.at(-1)
  return last === undefined ? held : { ...held, history: [...held.history.slice(0, -1), { ...last, deferral: 'refused' }] }
}
```

   Add `FindingEvent` to the type import from `'../types'` if it is not there.
3. Replace `wouldSettle` and its doc comment with:

```ts
/**
 * Everything a deferral needs to settle but its issue's label (R85, amended by Adam 2026-10-21): a P3, not security, deferred to a
 * GitHub issue, that Codex agreed cannot reasonably be fixed in this PR (R92 M2). A guessed P3 settles as a tagged one.
 */
export const wouldSettle = (f: Finding): boolean => isIssueDeferral(f) && !isPeakUnknown(f) && isDeferralAgreed(f)
```

4. In `checksOwed`, replace `isLoweringOwed(one)` with `isDeferralOwed(one)`, and end its doc comment with: "and every deferral, at any severity, that Codex has not ruled on (R92 M2, Adam 2026-10-21; it replaces R85's lowering check)." Drop the sentence "Any other deferral is the person's to release (R45), never Codex's."
5. In `blockerOf`, replace the start of the `if (f.status === 'deferred') {` block (the `low`, `isLoweringOwed` and `refusal` lines) with:

```ts
  if (f.status === 'deferred') {
    if (isDeferralOwed(f)) {
      return { kind: 'deferral-unchecked', id: f.id, said: `${tag}: deferred, Codex has not checked the deferral`, owner: 'codex', release: "the gate's Codex check rules on it" }
    }
```

   Keep the `wouldSettle` branch after it as it is.
6. In `decidePost`:
   - In `unchecked`, replace `isLoweringOwed(one)` with `isDeferralOwed(one)`, and make the comment above it say "…as free as a rebuttal check (R58); so is every deferral Codex has not ruled on (R92 M2)."
   - Make `deferred` `holding.filter(one => one.status === 'deferred' && !isDeferralOwed(one) && !wouldSettle(one))`.
   - In the `if (!isChanged && open.length > 0)` block, after `refuted`, add:

```ts
    // A deferral Codex says can be fixed in this PR (R92 M2): the agent's to fix, or to rebut with evidence.
    const undeferred = open.filter(one => one.history.at(-1)?.by === 'codex' && one.history.at(-1)?.deferral === 'refused')
```

     Exclude it from `ignored` (`!rejected.includes(one) && !refuted.includes(one) && !undeferred.includes(one)`). Make `isFeedbackOnly` require `rejected.length + refuted.length + undeferred.length === 0`. In `said`, after the `refuted` line, add `...undeferred.map(one => \`Codex says ${one.id} can be fixed in this PR: ${codexSaid(one)}\`),`. In `steps`, make the first group `ignored.length + refuted.length + undeferred.length === 0 ? [] : [\`fix or rebut ${ids([...refuted, ...undeferred, ...ignored])}\`]`.
   - Replace `recheck` with:

```ts
  const recheck = (): Next => {
    const deferrals = unchecked.filter(isDeferralOwed)
    const rebuttals = unchecked.filter(one => !isReverifyOwed(one) && !isDeferralOwed(one))
    const reverify = unchecked.filter(isReverifyOwed)
    const said = [
      ...(rebuttals.length === 0 ? [] : [`Codex has not checked the rebuttal of ${ids(rebuttals)} on ${last.endHead.slice(0, 7)}`]),
      ...(deferrals.length === 0 ? [] : [`Codex has not checked the deferral of ${ids(deferrals)}`]),
      ...reverify.map(reverifyOwed),
    ]
    const what = reverify.length + deferrals.length === 0 ? 'the rebuttal' : rebuttals.length + reverify.length === 0 && deferrals.length === 1 ? 'the deferral' : 'them'
    return {
      kind: 'blocked',
      why: said.join('; '),
      nextStep: `run /pr-gate resume: Codex checks ${what} on this head, using no review round`,
      recheck: unchecked.map(one => one.id),
    }
  }
```

7. In `awaiting`, delete `refused` and `plain`, and make `what` `[...are(deferred, 'deferred'), ...disputed.map(disputeOf)].join('; ')`.

- [ ] **Step 5: Implement the check in `round.ts`**

1. In the import from `'./lifecycle'`, replace `isLoweringOwed` with `isDeferralOwed` and `ruleLowering` with `ruleDeferral`.
2. Replace `checkLabel` with:

```ts
const checkLabel = (round: number, checked: readonly Finding[]): string => {
  const fixes = checked.filter(one => isReverifyOwed(one) || one.status === 'reported-fixed').length
  const deferrals = checked.filter(isDeferralOwed).length
  const kinds = [
    ...(checked.length - fixes - deferrals > 0 ? ['rebuttals'] : []),
    ...(fixes > 0 ? ['fixes'] : []),
    ...(deferrals > 0 ? ['deferrals'] : []),
  ]
  return `Round ${round} · codex ${fixes === checked.length ? 'verifies the fixes' : `checks the ${kinds.join(' and ')}`}`
}
```

3. In `afterRebuttalCheck`, replace the two lines of the R85 lowering branch with:

```ts
      // A deferral (R92 M2): agreed, it waits; refused, it is open again with Codex's reason, back to the agent, and charges the round.
      if (isDeferralOwed(f)) return ruleDeferral(f, verdict.holds, one.round, now, verdict.note)
```

- [ ] **Step 6: Implement the prompts in `core.ts` and the status in `register.tsx`**

1. In `core.ts`, in the import from `'./lifecycle'`, replace `isLoweringOwed` with `isDeferralOwed` (keep `loweringOf`).
2. In `verifyPrompt`, replace the `lowered`, `argued`, `what` and `lowerings` lines with:

```ts
    // Every deferral Codex has not ruled on (R92 M2): Codex rules on whether it can be fixed in this PR, not on a fix.
    const deferrals = rebuttals.filter(isDeferralOwed)
    const argued = rebuttals.filter(one => !isReverifyOwed(one) && one.status !== 'reported-fixed' && !isDeferralOwed(one))
    const kinds = [
      ...(argued.length === 0 ? [] : ['rebuttals']),
      ...(fixes.length + reported.length === 0 ? [] : ['fixes']),
      ...(deferrals.length === 0 ? [] : ['deferrals']),
    ]
    const what = kinds.join(' and ')
    const deferred = deferrals.map(one => {
      const low = loweringOf(one)
      const lowered = low === undefined ? '' : `The agent lowered it from ${low.from} to ${low.to}. `
      const follow = one.followUp === undefined ? '' : `Follow-up: ${one.followUp}. `
      return `${listFindings([one])}\n    ${lowered}${follow}Its reason: ${one.note ?? 'no reason given'}`
    })
```

   Replace the `...(lowered.length === 0 ? [] : [ ... ])` section with:

```ts
      ...(deferrals.length === 0
        ? []
        : [
            '',
            'The main agent deferred these findings instead of fixing them in this PR. A deferral settles nothing until you agree with it:',
            ...deferred,
            '   For each one: given the finding and the code at HEAD, can it reasonably be fixed in this PR, and if the agent lowered its severity, ' +
              'is the lower one right? holds is true when it cannot reasonably be fixed in this PR and its severity stands.',
          ]),
```

   In step 1 of the same prompt, replace "and rule on each one: does the rebuttal, or the fix, still hold?" with "and rule on each one: does the rebuttal, the fix or the deferral hold?".
3. In `triagePrompt` step 2, replace the sentence that starts `'   A deferral waits for the person, except a P3, …'` (both string pieces) with:

```ts
    '   Codex checks every deferral at the end of the round: if it says the finding can be fixed in this PR, the finding comes back to you open and the round is charged. ' +
      'A P3, not security, deferred with followUp naming the GitHub issue that tracks it (#<n>, owner/repo#<n> or its URL; a ticket key may sit beside it) needs no waiver once Codex agrees; ' +
      'the gate labels the issue with the highest severity the finding had.',
```

4. In `register.tsx`, remove `loweringRefusal` from the import from `'./lifecycle'`, and delete the `.concat(...)` line in `statusText` that uses it (a refused deferral is open, and the hold list says why).

- [ ] **Step 7: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. If a test outside the R85 group failed because a deferral now meets a verify step first, add the `accept` call as in Step 1 and list it in your report. Then run `npm run lint` and `npm run typecheck` from the repo root (typecheck needs the generated types; if they are missing, say so in your report).

- [ ] **Step 8: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/round.ts pr-lifecycle/hooks/core.ts pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: Codex checks every deferral; a refusal reopens it and charges the round (R92 M2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 12: The gate files issues instead of asking for waivers (R92, spec §5)

**Why:** on PR #20 Adam waived six findings by hand, and two of them again after a fix touched their file (R55). Where 1.4.0 ends `exhausted` or `awaiting-decision`, the gate can do no more on the head. 1.5.0 files a GitHub issue there for each finding still holding the merge, except security, and the issue settles the finding. Before filing, a blocker first raised in the round that spent the allowance gets one more round, at most twice per lifecycle, and the report says the scope may be too wide. This task removes R85's early settle: an issue the agent names is labelled in the filing pass, like a new one.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Finding`, `Grant`, `Blocker`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (new filing helpers; `mergeHolds`, `unresolvedBlockers`, `blockerOf`, `decidePost`, `awaiting`, `Next`; removes `isIssueDeferral`, `wouldSettle`, `isSettledDeferral`)
- Modify: `pr-lifecycle/hooks/round.ts` (`Config`, `configOf`, `overrideConfig`, `advance`, new `fileIssues` replacing `labelDeferrals`)
- Modify: `pr-lifecycle/hooks/core.ts` (`readyPrompt`, `personPost`, `reportPrompt`, `triagePrompt` step 2)
- Modify: `pr-lifecycle/hooks/register.tsx` (`statusText`)
- Modify: `pr-lifecycle/tests/world.ts` (issue filing fake)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/settings.test.ts`

**Interfaces:**
- Consumes: `isDeferralOwed`, `isDeferralAgreed`, `ruleDeferral` (Task 11); `isLinked`, `alsoOf`, `linkTo` (Task 7); `isChargedRound` and `RoundRecord.isCharged` (Task 6); `issueOf`, `isFollowUpRef`, `peakOf`, `isPeakUnknown`, `isDisputed`, `mergeHolds` (1.4.0).
- Produces (Task 13 and Task 16 rely on these):
  - Types: `Finding.issueError?: string`; `Grant.by?: 'gate'`; Blocker kinds `'issue-owed'` (owner `gate`) and `'issue-failed'` (owner `agent`) replace `'label-owed'`. `'label-failed'` stays. `Next`'s `blocked` gets `issues?: string[]`.
  - In `lifecycle.ts`: `SEVERITY_NAMES`, `filingPeak(f)`, `GATE_ROUNDS = 2`, `jiraKeyOf(branch)`, `isFileable(f)`, `isSettledByIssue(f)`, `issueLine(f)`, `issueTitle(f, rec, spec?)`, `issueBody(f, rec)`, `lateBlockers(rec)`, `gateGrant(rec, at)`, `scopeNote(rec)`, `isFilingPoint(next)`, `type IssueItem`, `type IssuePlan`, `planIssues(rec, at, spec?)`.
  - In `round.ts`: `Config.issueSpec: string | undefined`; `export async function fileIssues($: Engine, rec: LifecycleRecord): Promise<LifecycleRecord | undefined>`.
  - In `world.ts`: `gh.issueAnswer?: 'ok' | 'fail'`, `gh.issueNumber?: number` (default 21), `gh.filed: string[][]`, `gh.onIssue?: () => void | Promise<void>`.
- Rulings for the plan:
  - The gate files what holds the merge and is not security: open findings (a fix Codex rejected is open), deferrals Codex agreed with, and disputes. It never files a fix only reported, a rebuttal or link Codex has not checked, or a deferral Codex has not checked: those are Codex's, and the check comes first.
  - A finding whose peak the record lost (gate R7-6, `isPeakUnknown`) is filed as **Critical [P1]**, and its body says the severity was lost. It does not wait for the person (Adam, 2026-10-21: "lost severity critical, not held for me"). `filingPeak(f)` gives the severity the gate files and labels with.
  - A finding settles by its issue only while it is `open`, `deferred` (with Codex's agreement) or `rebutted`. A fix reported later is verified as usual. `needsRecheck` (its file changed) does not unsettle it (spec §5.8).
  - A late blocker is a held blocker first raised in the last completed post round, or in the last charged discretionary round (the one that spent the allowance). The gate adds a round only when that grant would start one (`decideNext` with it is a round). Otherwise, or after two gate rounds, the late blocker gets its issue.
  - A new issue's `followUp` is `#<n>`. A follow-up the agent gave that names no issue (a ticket key) goes into the issue's body.
  - The exhaustion paths (late-blocker rounds, an open finding filed at exhaustion) are tested on `planIssues` in `lifecycle.test.ts`. The gh side is tested through the awaiting path in `flow.test.ts`, which runs the same `fileIssues`. A dispute is tested at the unit level (`isFileable`, `issueBody`).

- [ ] **Step 1: Write the failing unit tests**

In `pr-lifecycle/tests/lifecycle.test.ts`, add to the import from `'../hooks/lifecycle'`: `gateGrant`, `isFileable`, `isSettledByIssue`, `issueBody`, `issueTitle`, `jiraKeyOf`, `planIssues`, `scopeNote`. Remove `isSettledDeferral` and `wouldSettle` from it. Append:

```ts
/** A post lifecycle with the allowance spent: four charged rounds, then a final-head check that moved the head from a to b. */
const spent = (over: object = {}) =>
  postRec({
    head: 'b',
    rounds: [
      post({ n: 2 }),
      ...[3, 4, 5, 6].map(n => roundOf({ n, phase: 'post', kind: 'discretionary', isCharged: true })),
      roundOf({ n: 7, phase: 'post', kind: 'final-head-check', endHead: 'b' }),
    ],
    ...over,
  })

test('R92: the issue title names the finding, its peak severity, the PR, the branch, a Jira key and the spec handle', async () => {
  const f = finding({ id: 'R4-3', severity: 'P2', title: 'Workflows rules ignored when reading required checks' })
  expect(issueTitle(f, { pr: 20, branch: 'wave2a/pr-lifecycle-1.4.0' })).toBe(
    'R4-3 Major [P2] Workflows rules ignored when reading required checks (#20, wave2a/pr-lifecycle-1.4.0)',
  )
  expect(issueTitle({ ...f, severity: 'P3', peakSeverity: 'P1' }, { pr: 20, branch: 'feat/KAN-12-cache' }, 'docs/spec.md')).toBe(
    'R4-3 Critical [P1] Workflows rules ignored when reading required checks (#20, feat/KAN-12-cache, KAN-12, docs/spec.md)',
  )
  expect(jiraKeyOf('feat/x')).toBeUndefined()
  expect(jiraKeyOf('fix/ABC2-77-retry')).toBe('ABC2-77')
})

test('R92: the issue body says who raised it and where, its severity, the problem, why it waits, and what is linked', async () => {
  const f = agreedBy(finding({
    id: 'G4-3', source: 'github', reviewer: 'mallory', severity: 'P2', title: 'cache never cleared', detail: 'Logging out keeps the cache.',
    url: 'https://github.com/me/repo/pull/20#discussion_r5', file: 'src/cache.ts', line: 10, round: 4, status: 'deferred', note: 'needs a schema change', followUp: 'KAN-9',
  }))
  const dup = { ...finding({ id: 'G5-1', source: 'github' }), duplicateOf: 'G4-3', linkBy: 'gate' as const }
  const body = issueBody(f, { pr: 20, findings: [f, dup] })
  expect(body).toContain('Raised by mallory in round 4 of #20, at `src/cache.ts:10` ([thread](https://github.com/me/repo/pull/20#discussion_r5)).')
  expect(body).toContain('Severity: Major [P2].')
  expect(body).toContain('## Problem\n\nLogging out keeps the cache.')
  expect(body).toContain('Deferred by the agent: needs a schema change. Codex agreed it cannot reasonably be fixed in this PR.')
  expect(body).toContain('Follow-up named by the agent: KAN-9.')
  expect(body).toContain('- G5-1: the same problem, raised again')
  // A lowered severity says so; a dispute gives both sides; an open finding says the rounds ran out.
  expect(issueBody({ ...f, severity: 'P3', peakSeverity: 'P1' }, { pr: 20, findings: [] })).toContain('Severity: Critical [P1], answered as P3.')
  expect(issueBody(disputed(), { pr: 20, findings: [] })).toContain('is disputed: the agent says')
  const left = finding({ id: 'R7-1', status: 'open', history: [{ round: 7, status: 'open', note: 'still reachable from /login', by: 'codex', at: 1 }] })
  expect(issueBody(left, { pr: 20, findings: [] })).toContain("Still open when the review rounds ran out. Codex's last word: still reachable from /login.")
})

test('R92: a finding settles by its issue, labelled at its peak, unless it is security; its file changing does not unsettle it', async () => {
  const filed = { ...agreedBy(finding({ id: 'G2-1', source: 'github', severity: 'P2', status: 'deferred' })), followUp: '#21', followUpLabel: 'P2' as const }
  expect(isSettledByIssue(filed)).toBe(true)
  expect(isSettledByIssue({ ...filed, followUpLabel: undefined })).toBe(false)
  expect(isSettledByIssue({ ...filed, peakSeverity: 'P1' })).toBe(false)
  expect(isSettledByIssue({ ...filed, isSecurity: true })).toBe(false)
  expect(isSettledByIssue({ ...filed, followUp: 'KAN-9' })).toBe(false)
  expect(isSettledByIssue({ ...filed, status: 'open' })).toBe(true)
  expect(isSettledByIssue({ ...filed, status: 'reported-fixed' })).toBe(false)
  expect(isSettledByIssue({ ...filed, needsRecheck: true })).toBe(true)
  // A deferral Codex has not checked never settles, whatever its label says.
  expect(isSettledByIssue({ ...filed, history: [] })).toBe(false)
  const rec = postRec({ findings: [filed] })
  expect(mergeHolds(rec)).toEqual([])
  expect(decideNext(rec)).toEqual({ kind: 'ready' })
})

test('R92: the gate files open findings, deferrals Codex agreed with and disputes; never security, a link or an unchecked answer', async () => {
  const open = finding({ id: 'R1-1', severity: 'P2', status: 'open' })
  const owed = applyAnswer(finding({ id: 'R1-2', severity: 'P2' }), { id: 'R1-2', action: 'deferred', note: 'later' }, 2, 'main', 5)
  expect(isFileable(open)).toBe(true)
  expect(isFileable(owed)).toBe(false)
  expect(isFileable(agreedBy(owed))).toBe(true)
  expect(isFileable(disputed())).toBe(true)
  expect(isFileable(rejected())).toBe(true)
  expect(isFileable({ ...open, isSecurity: true })).toBe(false)
  expect(isFileable({ ...open, status: 'reported-fixed' })).toBe(false)
  expect(isFileable({ ...open, status: 'rebutted', history: [{ round: 2, status: 'rebutted', by: 'main', at: 1 }] })).toBe(false)
  // Gate R7-6: a record that lost the peak is filed as Critical [P1], with the loss in its body (Adam, 2026-10-21).
  const legacy = agreedBy({ ...finding({ source: 'github', status: 'deferred', severity: 'P3', severitySource: 'hint' }), history: [{ round: 2, status: 'deferred' as const, severity: 'P3' as const, note: 'cosmetic', by: 'main', at: 5 }] })
  expect(isFileable(legacy)).toBe(true)
  expect(filingPeak(legacy)).toBe('P1')
  expect(filingPeak({ ...legacy, peakSeverity: 'P2' })).toBe('P2')
  expect(issueTitle(legacy, { pr: 20, branch: 'feat/x' })).toMatch(/^R1-1 Critical \[P1\] /)
  expect(issueBody(legacy, { pr: 20, findings: [] })).toContain("Severity: Critical [P1], assigned because the gate lost this finding's severity (answered as P3).")
  expect(isSettledByIssue({ ...legacy, followUp: '#21', followUpLabel: 'P1' })).toBe(true)
  // Review Focus 5: a duplicate linked to a security original holds with it and is never filed.
  const original = finding({ id: 'G2-1', source: 'github', severity: 'P1', isSecurity: true, status: 'open' })
  const dup = linkTo(finding({ id: 'G2-2', source: 'github', severity: 'P2' }), original, 'gate', 2, 5)
  expect(isFileable(dup)).toBe(false)
  expect(planIssues(spent({ findings: [original, dup] }), 9)).toEqual({ kind: 'none' })
})

test('R92: at exhaustion a blocker first raised in the round that spent the allowance, or the last one, adds a round, twice at most', async () => {
  const late = finding({ id: 'R7-1', round: 7, severity: 'P1', status: 'open' })
  const rec = spent({ findings: [late] })
  expect(decideNext(rec).kind).toBe('exhausted')
  const grant = { n: 1, reason: "late blocker R7-1: the PR's scope may be too wide", head: 'b', at: 50, by: 'gate' }
  expect(gateGrant(rec, 50)).toEqual(grant)
  expect(planIssues(rec, 50)).toEqual({ kind: 'grant', grant, late: ['R7-1'] })
  // Raised in the last charged round (6) is late too; an earlier one, or a late advisory, gets its issue.
  expect(planIssues(spent({ findings: [{ ...late, id: 'R6-1', round: 6 }] }), 50).kind).toBe('grant')
  expect(planIssues(spent({ findings: [{ ...late, id: 'R5-1', round: 5 }] }), 50)).toMatchObject({ kind: 'file', items: [{ id: 'R5-1', peak: 'P1' }] })
  expect(planIssues(spent({ findings: [{ ...late, severity: 'P2' }] }), 50)).toMatchObject({ kind: 'file', items: [{ id: 'R7-1', peak: 'P2' }] })
  // Two gate rounds used: the third late blocker gets its issue. A person's grant does not count against them.
  const twice = spent({
    rounds: [
      post({ n: 2 }),
      ...[3, 4, 5, 6, 7, 8].map(n => roundOf({ n, phase: 'post', kind: 'discretionary', isCharged: true })),
      roundOf({ n: 9, phase: 'post', kind: 'final-head-check', endHead: 'b' }),
    ],
    grants: [
      { n: 1, reason: 'late blocker R6-1', head: 'a', at: 1, by: 'gate' },
      { n: 1, reason: 'late blocker R8-1', head: 'a', at: 2, by: 'gate' },
    ],
    findings: [{ ...late, id: 'R9-1', round: 9 }],
  })
  expect(decideNext(twice).kind).toBe('exhausted')
  expect(gateGrant(twice, 50)).toBeUndefined()
  expect(planIssues(twice, 50)).toMatchObject({ kind: 'file', items: [{ id: 'R9-1', peak: 'P1' }] })
  expect(scopeNote(twice)).toBe(
    "The gate added 2 rounds for blockers first raised after the allowance was spent (late blocker R6-1; late blocker R8-1): tell the person the PR's scope may be too wide.",
  )
  expect(scopeNote(rec)).toBeUndefined()
  // Before the PR, or with nothing to file, there is no plan.
  expect(planIssues({ ...rec, phase: 'pre' }, 50)).toEqual({ kind: 'none' })
  expect(planIssues(postRec(), 50)).toEqual({ kind: 'none' })
})

test('R92: a deferral the agent tied to an issue is filed by labelling that issue; any other gets a new one', async () => {
  const named = agreedBy(applyAnswer(finding({ id: 'G2-1', source: 'github', severity: 'P2', severitySource: 'tag' }), { id: 'G2-1', action: 'deferred', note: 'later', followUp: 'other/lib#7' }, 2, 'main', 5))
  const unnamed = agreedBy(applyAnswer(finding({ id: 'G2-2', source: 'github', severity: 'P3', severitySource: 'tag' }), { id: 'G2-2', action: 'deferred', note: 'later' }, 2, 'main', 5))
  const next = decideNext(postRec({ findings: [named, unnamed] }))
  expect(next).toMatchObject({ kind: 'blocked', issues: ['G2-1', 'G2-2'] })
  const plan = planIssues(postRec({ findings: [named, unnamed], slug: 'me/repo' }), 9)
  expect(plan).toMatchObject({ kind: 'file', items: [{ id: 'G2-1', peak: 'P2', reuse: { repo: 'other/lib', number: 7 } }, { id: 'G2-2', peak: 'P3' }] })
  expect(plan.kind === 'file' ? plan.items[1] : undefined).not.toHaveProperty('reuse')
})
```

Update the tests from earlier tasks that this task changes:
- Task 11's `'R92: every deferral waits on Codex; …'`: replace `expect(wouldSettle(p3)).toBe(false)` and `expect(isSettledDeferral(p3)).toBe(false)` with `expect(isSettledByIssue(p3)).toBe(false)`, and `expect(isSettledDeferral(agreedBy(p3))).toBe(true)` with `expect(isSettledByIssue(agreedBy(p3))).toBe(true)`.
- Task 11's standing test `'R92: a deferral owed Codex holds as Codex\'s; …'`: in `pending`, expect `[['G2-1', 'issue-owed', 'gate']]`. Make its last line `expect(decideNext(postRec({ findings: [p2] }))).toMatchObject({ kind: 'blocked', issues: ['G2-1'] })`, with the comment `// Agreed: the gate files its issue (R92).`
- Delete `'R85: isSettledDeferral needs deferred, P3, an issue follow-up, its label and no security flag'` (the settle test above replaces it).
- Replace `'gate R7-6: …'` with the `legacy` lines now in the `isFileable` test above: delete the old test. Add `filingPeak` to the import from `'../hooks/lifecycle'`.
- `'R85: a follow-up settles only when it names a GitHub issue (Adam, 2026-10-20)'`: replace each `isSettledDeferral` with `isSettledByIssue`; `base` stays `agreedBy(finding({ ... }))`.
- `'R85: a deferral without a follow-up clears the earlier one and its label (final review T4)'`: replace each `isSettledDeferral` with `isSettledByIssue`, and delete its `wouldSettle` line.
- Replace `'R85: the ready prompt names the follow-up of a settled deferral and not of a plain one'` with:

```ts
test('R92: the ready prompt lists each finding settled by its issue', async () => {
  const settled = { ...agreedBy(finding({ id: 'G2-1', source: 'github', status: 'deferred', severity: 'P3', severitySource: 'tag', peakSeverity: 'P1' })), followUp: '#21', followUpLabel: 'P1' as const }
  const plain = finding({ id: 'G2-2', source: 'github', status: 'verified-fixed', severity: 'P3' })
  const said = readyPrompt({ ...fresh(), pr: 7, findings: [settled, plain] })
  expect(said).toContain('follow-up issues: G2-1 → #21 Critical [P1]')
  expect(said).not.toContain('G2-2 →')
})
```

In `pr-lifecycle/tests/settings.test.ts`, append:

```ts
test('R92: issueSpec names the spec in each issue title; a blank or non-string one is ignored', async () => {
  expect(configOf({}).issueSpec).toBeUndefined()
  expect(overrideConfig(configOf({}), '{"issueSpec":"docs/spec.md"}').config.issueSpec).toBe('docs/spec.md')
  const bad = overrideConfig(configOf({}), '{"issueSpec":7}')
  expect(bad.config.issueSpec).toBeUndefined()
  expect(bad.ignored).toEqual(['issueSpec (not a non-empty string)'])
})
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts`
Expected: FAIL: `issueTitle`, `planIssues` and the other new helpers are not exported.

- [ ] **Step 3: Implement the types**

In `pr-lifecycle/types/index.d.ts`:

1. In `Finding`, replace the doc comments of `followUp`, `followUpLabel` and `followUpLabelError`, and add `issueError` after them:

```ts
  /** The GitHub issue that tracks it: named by the agent's answer (R85) or filed by the gate (R92). `#<n>`, `owner/repo#<n>` or its URL, other text around it. */
  followUp?: string
  /** The highest severity the finding had during the gate (R85): what its issue is labelled with. */
  peakSeverity?: Severity
  /** The `severity:<P>` label the gate put on that issue; the finding settles once it is the peak's (R92). */
  followUpLabel?: Severity
  /** gh's error when the gate last failed to label the issue the agent named: the finding holds until a pass labels it. */
  followUpLabelError?: string
  /** gh's error when the gate last failed to file the finding's issue (R92): the finding holds until a pass files it. */
  issueError?: string
```

   (`peakSeverity` keeps its place; only its comment changes.)
2. Replace `Grant` with:

```ts
/** A round added to the allowance: the person's `/pr-gate allow`, or the gate's own for a late blocker (`by: 'gate'`, R92, at most two). */
export type Grant = { n: number; reason: string; head: string; at: number; by?: 'gate' }
```

3. In `Blocker['kind']`, replace `'label-owed'` with `'issue-owed' | 'issue-failed'`.

- [ ] **Step 4: Implement the filing helpers in `lifecycle.ts`**

1. Add `Grant` to the type import from `'../types'` if it is not there.
2. Delete `isIssueDeferral`, `wouldSettle` and `isSettledDeferral` with their doc comments. Keep `issueOf`, `isFollowUpRef`, `labelFailure` and `LABEL_RELEASE`.
3. After `ruleDeferral` (Task 11), add:

```ts
/** Severity names in an issue's title (spec §5.6). */
export const SEVERITY_NAMES: Record<Severity, string> = { P0: 'Blocker', P1: 'Critical', P2: 'Major', P3: 'Minor' }

/**
 * The severity the gate files and labels a finding's issue with (R92): its peak, or Critical [P1] when the record lost the peak
 * (gate R7-6). Adam, 2026-10-21: "lost severity critical, not held for me".
 */
export const filingPeak = (f: Finding): Severity => (isPeakUnknown(f) ? 'P1' : peakOf(f))

/** The most rounds the gate adds for late blockers in one lifecycle (R92, spec §5.3). */
export const GATE_ROUNDS = 2

/** The Jira key in a branch name, if any: its first `[A-Z][A-Z0-9]+-\d+`. */
export const jiraKeyOf = (branch: string): string | undefined => branch.match(/[A-Z][A-Z0-9]+-\d+/)?.[0]

/**
 * What the filing pass files (R92, spec §5.2): a held finding that is not security, not a linked duplicate (it holds with its
 * original), and is open, deferred with Codex's agreement, or disputed. A fix only reported, a rebuttal, link or deferral Codex has
 * not checked are Codex's first. A record that lost the finding's peak (gate R7-6) is filed as P1 (`filingPeak`).
 */
export const isFileable = (f: Finding): boolean =>
  f.isSecurity !== true && !isLinked(f) && (f.status === 'open' || isDeferralAgreed(f) || isDisputed(f))

/**
 * A finding settled by its GitHub issue (R92, spec §5.7): not security, open, deferred with Codex's agreement or rebutted, its
 * follow-up names an issue, and that issue carries the label of the highest severity the finding had. Its file changing does not
 * unsettle it (unlike a waiver, R55): the issue stays open for the person.
 */
export const isSettledByIssue = (f: Finding): boolean =>
  f.isSecurity !== true &&
  (f.status === 'open' || f.status === 'rebutted' || (f.status === 'deferred' && !isDeferralOwed(f))) &&
  isFollowUpRef(f.followUp) &&
  f.followUpLabel === filingPeak(f)

/** A settled finding as status and the ready prompt name it: "R4-3 → #21 Major [P2]". */
export const issueLine = (f: Finding): string => `${f.id} → ${f.followUp ?? '?'} ${SEVERITY_NAMES[filingPeak(f)]} [${filingPeak(f)}]`

/** A filed issue's title (spec §5.6): `<id> <Name> [P<n>] <title> (#<pr>, <branch><, Jira key><, spec>)`. */
export function issueTitle(f: Finding, rec: Pick<LifecycleRecord, 'pr' | 'branch'>, spec?: string): string {
  const peak = filingPeak(f)
  const jira = jiraKeyOf(rec.branch)
  const where = [`#${rec.pr ?? '?'}`, rec.branch, ...(jira === undefined ? [] : [jira]), ...(spec === undefined || spec === '' ? [] : [spec])]
  return `${f.id} ${SEVERITY_NAMES[peak]} [${peak}] ${f.title.replace(/\s+/g, ' ').trim().slice(0, 120)} (${where.join(', ')})`
}

/**
 * A filed issue's body (spec §5.6; issues #21-#23 are the model): who raised it and where, its peak severity, the problem, why it
 * was not fixed in the PR, and the findings linked to it.
 */
export function issueBody(f: Finding, rec: Pick<LifecycleRecord, 'pr' | 'findings'>): string {
  const peak = filingPeak(f)
  const at = f.file === undefined ? '' : `, at \`${f.file}${f.line === undefined ? '' : `:${f.line}`}\``
  const thread = f.url === undefined ? '' : ` ([thread](${f.url}))`
  const codex = f.history.filter(one => one.by === 'codex').at(-1)?.note
  const why = isDisputed(f)
    ? `${disputeOf(f)}.`
    : f.status === 'deferred'
      ? `Deferred by the agent: ${f.note ?? 'no reason given'}. Codex agreed it cannot reasonably be fixed in this PR.`
      : `Still open when the review rounds ran out.${codex === undefined ? '' : ` Codex's last word: ${codex}.`}`
  const named = f.followUp !== undefined && !isFollowUpRef(f.followUp) ? [`Follow-up named by the agent: ${f.followUp}.`] : []
  const linked = alsoOf(rec.findings, f.id)
  return [
    `Raised by ${f.reviewer} in round ${f.round} of #${rec.pr ?? '?'}${at}${thread}.`,
    isPeakUnknown(f)
      ? `Severity: ${SEVERITY_NAMES[peak]} [${peak}], assigned because the gate lost this finding's severity (answered as ${f.severity}).`
      : `Severity: ${SEVERITY_NAMES[peak]} [${peak}]${f.severity === peak ? '' : `, answered as ${f.severity}`}${f.isSecurity === true ? ', security' : ''}.`,
    '',
    '## Problem',
    '',
    f.detail ?? f.title,
    '',
    '## Impact, and why it was not fixed in this PR',
    '',
    why,
    ...named,
    ...(linked.length === 0 ? [] : ['', '## Linked findings', '', ...linked.map(id => `- ${id}: the same problem, raised again`)]),
    '',
    `Filed by pr-gate when the review of #${rec.pr ?? '?'} could do no more.`,
  ].join('\n')
}
```

   `disputeOf` is defined earlier in the file; if it is below `issueBody`, move `issueBody` below it. Place these helpers after `isBlocking`, `isLinked`, `isDeferralAgreed` and `alsoOf` are defined (`const`s are not hoisted for use at load time, but these are only called later, so a function body may refer to a `const` defined further down; keep the order readable).

4. Replace `!isSettledDeferral(one)` with `!isSettledByIssue(one)` in `mergeHolds`, and end its doc comment with "A finding settled by its issue no longer holds it (R92)." In `unresolvedBlockers`, add `&& !isSettledByIssue(one)` to the filter.
5. In `blockerOf`, at its top (after `isSecurityP1`), add:

```ts
  // The filing pass failed for it (R92): the agent checks gh; the gate retries on its next pass.
  if (isFileable(f) && f.issueError !== undefined) return { kind: 'issue-failed', id: f.id, said: issueFailure(f), owner: 'agent', release: ISSUE_RELEASE }
  if (isFileable(f) && f.followUpLabelError !== undefined) return { kind: 'label-failed', id: f.id, said: labelFailure(f), owner: 'agent', release: LABEL_RELEASE }
  const issueOwed = (what: string): Blocker =>
    ({ kind: 'issue-owed', id: f.id, said: `${tag}: ${what}; the gate files its GitHub issue when the review can do no more`, owner: 'gate', release: 'nothing: the gate files it' })
```

   Make the `isDisputed` line `if (isDisputed(f)) return isFileable(f) ? issueOwed('disputed') : { kind: 'disputed', id: f.id, said: \`${tag}: disputed\`, owner: 'person', release: waive }`. In the `if (f.status === 'deferred') {` block, replace the `wouldSettle` branch with `if (isFileable(f)) return issueOwed('deferred, and Codex agreed it cannot reasonably be fixed in this PR')`.
6. Next to `LABEL_RELEASE`, add:

```ts
const ISSUE_RELEASE = 'check that gh can create issues in the repository (gh auth status); the gate retries on the next pass'

/** A failed filing in words (R92). */
const issueFailure = (f: Finding): string => `could not file an issue for ${f.id} (${f.issueError ?? 'no error recorded'})`
```

7. In `Next`, make the `blocked` member `{ kind: 'blocked'; why: string; nextStep: string; answer?: string[]; recheck?: string[]; issues?: string[] }`, and add to its doc comment: "issues: findings the filing pass still owes an issue (R92); the next pass files them."
8. In `decidePost`, delete `unlabelled`. Make `deferred` `holding.filter(one => one.status === 'deferred' && !isDeferralOwed(one))`. In the final-head-check branch, make the awaiting line `if (!isChanged && deferred.length + disputed.length === holding.length) return awaiting(deferred, disputed)`. Make the last line `return awaiting(deferred, disputed)`.
9. Replace `awaiting` and its doc comment with:

```ts
/**
 * Only deferrals and disputes hold the merge. Each that is not security gets a GitHub issue from the filing pass (R92): until it has
 * one, the gate retries, and a failure is the agent's to check. Security ones wait for the person's waiver (R39, R40); a finding
 * whose peak was lost is filed as P1 (gate R7-6, Adam 2026-10-21).
 */
function awaiting(deferred: readonly Finding[], disputed: readonly Finding[] = []): Next {
  const all = [...deferred, ...disputed]
  const toFile = all.filter(isFileable)
  if (toFile.length > 0) {
    const failed = toFile.filter(each => each.issueError !== undefined || each.followUpLabelError !== undefined)
    const waiting = toFile.filter(each => !failed.includes(each))
    const said = [
      ...failed.map(each => (each.issueError !== undefined ? issueFailure(each) : labelFailure(each))),
      ...(waiting.length === 0 ? [] : [`${ids(waiting)} ${waiting.length === 1 ? 'waits for its' : 'wait for their'} GitHub issue`]),
    ]
    const releases = [...new Set(failed.map(each => (each.issueError !== undefined ? ISSUE_RELEASE : LABEL_RELEASE)))]
    return {
      kind: 'blocked',
      why: said.join('; '),
      nextStep: `${releases.length === 0 ? 'nothing to change: the gate files them' : releases.join('; ')} (/pr-gate resume)`,
      issues: toFile.map(each => each.id),
    }
  }
  const one = all.length === 1
  const are = (list: readonly Finding[], word: string): string[] => (list.length === 0 ? [] : [`${ids(list)} ${list.length === 1 ? 'is' : 'are'} ${word}`])
  const what = [...are(deferred, 'deferred'), ...disputed.map(disputeOf)].join('; ')
  const told = [...are(deferred, 'deferred'), ...are(disputed, 'disputed')]
  return {
    kind: 'awaiting-decision',
    why: `${what}; only the person's waiver lets ${one ? 'it' : 'them'} into the merge`,
    nextStep: `tell the person ${told.join(' and ')} and why, then stop: only their waiver settles ${one ? 'it' : 'them'}`,
  }
}
```

10. After `decideNext`, add:

```ts
/**
 * Blockers the gate may add a round for at exhaustion (R92, spec §5.3): held, blocking, first raised in the last completed post round
 * or in the last charged discretionary round, the one that spent the allowance.
 */
export function lateBlockers(rec: LifecycleRecord): Finding[] {
  const done = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)
  const late = new Set([done.at(-1)?.n, done.filter(one => one.kind === 'discretionary' && one.isCharged !== false).at(-1)?.n])
  return mergeHolds(rec).filter(one => isBlocking(one) && late.has(one.round))
}

/**
 * The round the gate adds for late blockers at exhaustion (R92): under GATE_ROUNDS per lifecycle, and only when it starts a round.
 * Each one is a sign to the person that the PR's scope is too wide; `scopeNote` says so.
 */
export function gateGrant(rec: LifecycleRecord, at: number): Grant | undefined {
  if (decideNext(rec).kind !== 'exhausted') return undefined
  if (rec.grants.filter(one => one.by === 'gate').length >= GATE_ROUNDS) return undefined
  const late = lateBlockers(rec)
  if (late.length === 0) return undefined
  const grant: Grant = { n: 1, reason: `late blocker${late.length === 1 ? '' : 's'} ${ids(late)}: the PR's scope may be too wide`, head: rec.head, at, by: 'gate' }
  return decideNext({ ...rec, grants: [...rec.grants, grant] }).kind === 'round' ? grant : undefined
}

/** The rounds the gate added, in words for the person (R92); undefined when it added none. */
export function scopeNote(rec: Pick<LifecycleRecord, 'grants'>): string | undefined {
  const added = rec.grants.filter(one => one.by === 'gate')
  if (added.length === 0) return undefined
  const rounds = `${added.length} round${added.length === 1 ? '' : 's'}`
  return `The gate added ${rounds} for blockers first raised after the allowance was spent (${added.map(one => one.reason.replace(/: the PR's scope may be too wide$/, '')).join('; ')}): tell the person the PR's scope may be too wide.`
}

/** Where the filing pass runs (R92): where 1.4.0 ended exhausted or awaiting the person, and while an issue is still owed. */
export const isFilingPoint = (next: Next): boolean =>
  next.kind === 'exhausted' || next.kind === 'awaiting-decision' || (next.kind === 'blocked' && (next.issues ?? []).length > 0)

/** One issue the filing pass owes: a new one, or the one the agent named (`reuse`), labelled `severity:<peak>`. */
export type IssueItem = { id: string; peak: Severity; followUp?: string; reuse?: { repo: string; number: number }; title: string; body: string }

export type IssuePlan = { kind: 'none' } | { kind: 'grant'; grant: Grant; late: string[] } | { kind: 'file'; items: IssueItem[] }

/**
 * What the filing pass does (R92, spec §5): nothing before the PR or short of a filing point; else a round for a late blocker
 * (`gateGrant`); else an issue for each held finding it files (`isFileable`).
 */
export function planIssues(rec: LifecycleRecord, at: number, spec?: string): IssuePlan {
  if (rec.phase === 'pre' || rec.pr === undefined || !isFilingPoint(decideNext(rec))) return { kind: 'none' }
  const grant = gateGrant(rec, at)
  if (grant !== undefined) return { kind: 'grant', grant, late: lateBlockers(rec).map(one => one.id) }
  const items = mergeHolds(rec)
    .filter(isFileable)
    .map((f): IssueItem => {
      const reuse = issueOf(f.followUp, rec.slug)
      return {
        id: f.id,
        peak: filingPeak(f),
        ...(f.followUp === undefined ? {} : { followUp: f.followUp }),
        ...(reuse === undefined ? {} : { reuse }),
        title: issueTitle(f, rec, spec),
        body: issueBody(f, rec),
      }
    })
  return items.length === 0 ? { kind: 'none' } : { kind: 'file', items }
}
```

- [ ] **Step 5: Run the unit tests**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts`
Expected: the new tests PASS. Failures left in `round.ts`, `core.ts` and `register.tsx` imports are fixed next.

- [ ] **Step 6: Write the failing flow tests and the world fake**

In `pr-lifecycle/tests/world.ts`, add to the `gh` type, after `labelled`:

```ts
    /** How `gh api -X POST repos/<slug>/issues` answers when the gate files an issue (R92): 'ok' (default) or 'fail'. */
    issueAnswer?: 'ok' | 'fail'
    /** The number the next filed issue gets (default 21); each filing adds one. */
    issueNumber?: number
    /** Every issue the gate filed: its argv after `gh`, in order. */
    filed: string[][]
    /** Called on each issue filing, before it answers: a test acts while the gate files an issue. */
    onIssue?: () => void | Promise<void>
```

Add `filed: [],` next to `labelled: [],` where the world is built. In `fake`, before the line `if (w.gh.garbage !== undefined && args.startsWith('api ')) return out(w.gh.garbage)`, add:

```ts
      // The gate's issue filing (R92): a POST to repos/<slug>/issues; the answer carries the new issue's number.
      if (e.argv[1] === 'api' && e.argv[2] === '-X' && e.argv[3] === 'POST' && /^repos\/[^/\s]+\/[^/\s]+\/issues$/.test(e.argv[4] ?? '')) {
        w.gh.filed.push(e.argv.slice(1))
        await w.gh.onIssue?.()
        if (w.gh.issueAnswer === 'fail') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 410: Issues are disabled for this repo', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        const number = w.gh.issueNumber ?? 21
        w.gh.issueNumber = number + 1
        const repo = (e.argv[4] ?? '').split('/').slice(1, 3).join('/')
        return out(JSON.stringify({ number, html_url: `https://github.com/${repo}/issues/${number}` }))
      }
```

In `pr-lifecycle/tests/flow.test.ts`:

1. Make `toAwaiting` defer a **security** finding by default, since only security waits for the person now. Its disposition becomes `{ id: 'G2-1', action: 'deferred', note: 'tracked in KAN-9', replyId: '992', isSecurity: true, ...extra }`.
2. Append:

```ts
test('R92: when the review can do no more, a P2 deferral Codex agreed with gets its GitHub issue, settles, and the lifecycle is ready', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P2', note: 'needs a schema change', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  expect(w.gh.filed).toHaveLength(1)
  const argv = w.gh.filed[0] ?? []
  expect(argv.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/me/repo/issues'])
  expect(argv).toContain(`title=G2-1 Major [P2] Consider renaming this (#${w.gh.pr}, feat/x)`)
  expect(argv).toContain('labels[]=severity:P2')
  expect(argv.find(one => one.startsWith('body='))).toContain('Deferred by the agent: needs a schema change.')
  expect(w.gh.labelled).toContain('label create severity:P2 --repo me/repo --color fbca04')
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')).toMatchObject({ followUp: '#21', followUpLabel: 'P2' })
  expect(rec.phase).toBe('ready')
  expect(rec.log?.some(one => one.kind === 'check' && one.text === 'G2-1: filed me/repo#21 severity:P2')).toBe(true)
  expect((await say($, 'status')).text).toContain('G2-1 → #21 Major [P2].')
})

test('R92: an issue the gate could not file holds the merge with gh\'s words, and the next pass files it', async ($, on) => {
  const w = world(on)
  w.gh.issueAnswer = 'fail'
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P2', note: 'later', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  const held = await recordOf(w)
  expect(held.phase).not.toBe('ready')
  expect(held.findings.find(one => one.id === 'G2-1')?.issueError).toBe('HTTP 410: Issues are disabled for this repo')
  expect(w.prompts.at(-1)).toContain('could not file an issue for G2-1 (HTTP 410: Issues are disabled for this repo)')
  expect(w.prompts.at(-1)).toContain('check that gh can create issues in the repository (gh auth status)')
  w.gh.issueAnswer = 'ok'
  await say($, 'resume')
  await w.clock.advance(1000)
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')).toMatchObject({ followUp: '#21', followUpLabel: 'P2' })
  expect(rec.findings.find(one => one.id === 'G2-1')?.issueError).toBeUndefined()
  expect(rec.phase).toBe('ready')
})

test('R92: a reset while an issue is filed writes nothing for the archived lifecycle (G7-8)', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  let isResetting = false
  w.gh.onIssue = async () => {
    if (isResetting) return
    isResetting = true
    await say($, 'reset')
  }
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P2', note: 'later', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  await w.clock.advance(1000)
  expect(isResetting).toBe(true)
  const rec = await recordOf(w)
  expect(rec.phase).toBe('archived')
  expect(rec.findings).toEqual([])
  expect(JSON.stringify(rec.log ?? [])).not.toContain('filed')
  expect((await runOf(w)).status).not.toBe('running')
})
```

3. Update the R85 flow tests to the filing pass:
   - `'R85: a P3 deferred with a recorded follow-up settles without a waiver, once its issue is labelled'`: rename it `'R92: a P3 deferral whose follow-up names an issue gets that issue labelled, not a new one'`, and add `expect(w.gh.filed).toEqual([])`.
   - Replace `'R85: a P2 deferral with a follow-up still waits for the person'` with a test named `'R92: a P2 deferral whose follow-up names an issue gets it labelled severity:P2 and settles'`. It runs `toTriage($, w, 'Consider renaming this')`, a P2 deferral with `followUp: ISSUE`, and `accept('r2-verify', w)`. It expects `labelled(w, 9, 'P2')`, `w.gh.filed` empty and phase `'ready'`.
   - Replace `'R85: a P3 deferral without a follow-up still waits for the person'` with `'R92: a P3 deferral with no follow-up gets a new issue labelled severity:P3'`. Expect one filing with `labels[]=severity:P3`, and phase `'ready'`.
   - Replace `'R85: a P3 deferral whose follow-up is a ticket key alone still waits for the person'` with `'R92: a ticket key alone is no issue: the gate files one and keeps the key in its body'`. Expect one filing whose `body=` argument contains `Follow-up named by the agent: KAN-9.`, and the finding's `followUp` to be `'#21'`.
   - `'R85: a security P3 deferral with a follow-up still waits for the person'`: add `expect(w.gh.filed).toEqual([])`.
   - Task 11's `'R92: a deferral waits on Codex\'s check; a lowered P3 …'`: replace its last line with `expect(w.prompts.at(-1)).toContain('follow-up issues: G2-1 → KAN-9 #12 Critical [P1]')`.
   - `'R85: an issue the gate could not label holds the merge, and the next pass labels it (fail closed)'`: add the verify step (Task 11 did) and keep the rest. The hold still says `could not label issue #12 severity:P3 (…` and the label release.
   - `'R85: /pr-gate status names the follow-up of a settled deferral and its label'`: rename it `'R92: /pr-gate status names each finding settled by its issue'`, and expect the status text to contain `` `G2-1 → ${ISSUE} Minor [P3].` ``.
4. Any other flow test that expected `awaiting-decision` for a deferral or dispute that is not security now sees the filing pass. Where the test is about the person's waiver, make the finding security (`isSecurity: true`). Where it is about the end state, assert the issue instead. List each change in your report.

- [ ] **Step 7: Implement `fileIssues`, the setting and the controller in `round.ts`**

1. Add `issueSpec: string | undefined` to `Config`, with the doc comment `/** The spec handle each filed issue's title names (R92); undefined names none. Repository file only. */`. In `configOf`, add `issueSpec: undefined,`. In `overrideConfig`, after `onExhausted`, add:

```ts
  const issueSpec =
    r.issueSpec === undefined ? undefined : typeof r.issueSpec === 'string' && r.issueSpec.trim() !== '' ? r.issueSpec.trim().slice(0, 80) : bad('issueSpec', 'not a non-empty string')
```

   and in the returned config `issueSpec: issueSpec ?? c.issueSpec,`. Add `issueSpec` to the list of keys in `overrideConfig`'s doc comment.
2. In the import from `'./lifecycle'`, remove `wouldSettle` and add `planIssues` and `GATE_ROUNDS`.
3. Replace `labelDeferrals` and its doc comment with:

```ts
/**
 * The filing pass (R92, spec §5): where the review can do no more, it first adds a round for a late blocker (`gateGrant`); else it
 * files a GitHub issue for each held finding but security, or labels the issue the agent's follow-up names, with `severity:<peak>`.
 * A failure is recorded on the finding, which holds, and the next pass retries. Undefined when the lifecycle was reset, replaced or
 * stopped while gh ran: the caller decides nothing for it (gate G7-8, R8-2). Never through a PR-create command line (spec §5.9).
 */
export async function fileIssues($: Engine, rec: LifecycleRecord): Promise<LifecycleRecord | undefined> {
  if (rec.phase === 'pre' || rec.pr === undefined) return rec
  const now = await $.clock.now()
  const { config: c } = await configFor($, rec.root, rec.base)
  const plan = planIssues(rec, now, c.issueSpec)
  if (plan.kind === 'none') return rec
  // A reset, a fresh lifecycle or a stop since this pass began ends it (gate G7-8, R8-2): checked before each issue and after its
  // gh calls, so nothing more is filed and no log line lands in another lifecycle's log.
  const isMoved = (latest: LifecycleRecord | undefined): boolean =>
    latest === undefined || latest.phase === 'archived' || (latest.generation ?? 0) !== (rec.generation ?? 0) || latest.postStatus !== rec.postStatus
  if (plan.kind === 'grant') {
    const n = rec.grants.filter(one => one.by === 'gate').length + 1
    const text = `the gate added a round for ${plan.late.join(', ')}, first raised after the allowance was spent (${n} of ${GATE_ROUNDS}): the PR's scope may be too wide`
    let isGone = false
    const saved = await updateRecord($, rec.root, rec.branch, latest => {
      isGone = isMoved(latest)
      if (isGone) return latest
      return { ...latest, grants: [...latest.grants, plan.grant], log: [...(latest.log ?? []), { at: now, kind: 'check' as const, text }].slice(-LOG_CAP) }
    })
    if (isGone) return undefined
    $.ui.toast(`pr-gate: ${text}.`)
    return saved ?? rec
  }
  if (rec.slug === undefined) return rec
  const gh = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    try {
      return await $.process.run(['gh', ...args], { cwd: rec.root, timeoutMs: 30_000 })
    } catch (e) {
      return { exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
    }
  }
  const failure = (got: { exitCode: number; stderr: string }): string => (got.stderr.trim() || `gh exited ${got.exitCode}`).slice(0, 200)
  const results = new Map<string, { peak: Severity; was: string | undefined; followUp: string | undefined; isLabel: boolean; error?: string }>()
  // Logged with the results, in the same guarded write (gate R9-1).
  const lines: LogEntry[] = []
  for (const item of plan.items) {
    if (isMoved(await loadRecord($, rec.root, rec.branch))) return undefined
    const label = `severity:${item.peak}`
    const repo = item.reuse?.repo ?? rec.slug
    // Made only when missing: an existing label's colour and description are the repository's (gate R7-7).
    await gh(['label', 'create', label, '--repo', repo, '--color', LABEL_COLOURS[item.peak]])
    if (isMoved(await loadRecord($, rec.root, rec.branch))) return undefined
    let text: string
    if (item.reuse !== undefined) {
      const edit = await gh(['issue', 'edit', String(item.reuse.number), '--repo', repo, '--add-label', label])
      const error = edit.exitCode === 0 ? undefined : failure(edit)
      results.set(item.id, { peak: item.peak, was: item.followUp, followUp: item.followUp, isLabel: true, ...(error === undefined ? {} : { error }) })
      text = error === undefined ? `${item.id}: labelled ${repo}#${item.reuse.number} ${label}` : `${item.id}: could not label ${repo}#${item.reuse.number} ${label}`
    } else {
      const post = await gh(['api', '-X', 'POST', `repos/${rec.slug}/issues`, '-f', `title=${item.title}`, '-f', `body=${item.body}`, '-f', `labels[]=${label}`])
      const number = post.exitCode === 0 ? issueNumberOf(post.stdout) : undefined
      const error = number !== undefined ? undefined : post.exitCode === 0 ? "GitHub did not give the new issue's number" : failure(post)
      results.set(item.id, { peak: item.peak, was: item.followUp, followUp: number === undefined ? undefined : `#${number}`, isLabel: false, ...(error === undefined ? {} : { error }) })
      text = error === undefined ? `${item.id}: filed ${rec.slug}#${number ?? '?'} ${label}` : `${item.id}: could not file an issue in ${rec.slug}`
    }
    if (isMoved(await loadRecord($, rec.root, rec.branch))) return undefined
    lines.push({ at: await $.clock.now(), kind: 'check', text: text.slice(0, 300) })
  }
  let isGone = false
  // Written only where the follow-up and peak are still the ones filed for: a later answer that moved either is filed anew.
  const saved = await updateRecord($, rec.root, rec.branch, latest => {
    isGone = isMoved(latest)
    if (isGone) return latest
    const findings = latest.findings.map(f => {
      const got = results.get(f.id)
      if (got === undefined || got.was !== f.followUp || got.peak !== filingPeak(f)) return f
      if (got.error !== undefined) return got.isLabel ? { ...f, followUpLabelError: got.error } : { ...f, issueError: got.error }
      return { ...f, followUp: got.followUp, followUpLabel: got.peak, followUpLabelError: undefined, issueError: undefined }
    })
    return { ...latest, findings, log: [...(latest.log ?? []), ...lines].slice(-LOG_CAP) }
  })
  return isGone ? undefined : (saved ?? rec)
}

/** The number in GitHub's answer to an issue POST; undefined when it gave none. */
const issueNumberOf = (stdout: string): number | undefined => {
  try {
    const n = (JSON.parse(stdout) as { number?: unknown }).number
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}
```

4. In `advance`, replace the three `labelDeferrals` lines (and their comment) with:

```ts
  // Where the review can do no more, the gate first adds a round for a late blocker, else files an issue for each held finding but
  // security; it then decides again from what it wrote (R92).
  const filed = await fileIssues($, rec)
  if (filed === undefined) return
  rec = filed
```

   Check nothing else calls `labelDeferrals` (`grep -n labelDeferrals pr-lifecycle`), and that no Bash text the gate builds contains the PR-create command line.

- [ ] **Step 8: Implement the prompts and the status**

In `pr-lifecycle/hooks/core.ts`:

1. In the import from `'./lifecycle'`, replace `isSettledDeferral` with `isFileable`, `isSettledByIssue`, `issueLine` and `scopeNote`.
2. In `readyPrompt`, replace the `deferred.length === 0 ? 'no deferrals' : …` element of `summary` with:

```ts
    settled.length === 0 ? 'no follow-up issues' : `follow-up issues: ${settled.map(issueLine).join('; ')}`,
```

   where `const settled = rec.findings.filter(isSettledByIssue)` replaces `const deferred = …`. Add `scopeNote(rec)` after the sentence, when defined: `${note === undefined ? '' : ` ${note}`}` with `const note = scopeNote(rec)`. (Task 13 rewrites the last sentence.)
3. In `personPost`, make `theirs` `mergeHolds(rec).filter(one => (one.status === 'deferred' || isDisputed(one)) && !isFileable(one))`, and make its doc comment say "the waiver of each security deferral or dispute, or one the gate cannot file (R92), and `waive post`."
4. In `reportPrompt`, right after `lines.push('', \`Your next step: ${next.nextStep}.\`)`, add:

```ts
  const note = scopeNote(rec)
  if (note !== undefined) lines.push(note)
  // The gate still owes an issue (R92): nothing in the code to change; the agent checks gh when filing failed.
  if (next.kind === 'blocked' && (next.issues ?? []).length > 0) {
    lines.push('Do not merge, and do not merge another way: the guard holds the merge until each issue is filed and labelled.')
    return noted(lines.join('\n'))
  }
```

5. In `triagePrompt` step 2, replace the deferral sentence from Task 11 with:

```ts
    '   Codex checks every deferral at the end of the round: if it says the finding can be fixed in this PR, the finding comes back to you open and the round is charged. ' +
      'When the review can do no more, the gate files a GitHub issue for each finding still held, except security ones, which wait for the person; ' +
      'if your followUp names the issue that already tracks it (#<n>, owner/repo#<n> or its URL), the gate labels that one instead.',
```

In `pr-lifecycle/hooks/register.tsx`, in the import from `'./lifecycle'`, replace `isSettledDeferral` with `isSettledByIssue`, `issueLine` and `scopeNote`. In `statusText`, replace `settled` with:

```ts
  const note = scopeNote(rec)
  const settled = rec.findings
    .filter(isSettledByIssue)
    .map(one => ` ${issueLine(one)}.`)
    .concat(note === undefined ? [] : [` ${note}`])
    .join('')
```

- [ ] **Step 9: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. Then `npm run lint` and `npm run typecheck` from the repo root.

- [ ] **Step 9a: Amendment A7 (PR #25 review): a filed issue counts only once GitHub shows its label**

GitHub accepts an issue POST from an account without push access and silently drops the labels it was given. A successful POST with a number is therefore not enough to set `followUpLabel`. Fix, in `fileIssues`:

- Read the POST's answer for `labels[].name` alongside `number`, with a helper beside `issueNumberOf`.
- If the label is missing, keep the issue: write `followUp: '#<n>'` and `followUpLabelError: 'GitHub filed #<n> without its severity:<P> label (the account may lack push access to label it)'`. Leave `followUpLabel` unset, so the finding still holds as `label-failed`.
- The next pass takes the reuse path (`gh issue edit <n> --add-label`) for that issue and never POSTs a second one.
- A failed `label create` stays ignored, because the returned labels are now the check.

Tests:
1. The world's POST answers with `labels: []`: the finding holds as `label-failed` with `followUp` `#<n>`. A second pass, with `issue edit` succeeding, settles it. Exactly one POST is made over both passes.
2. The POST answers with the label: it settles in one pass, as before.

Add a world knob for the POST answer's labels (default: echo the requested label).

- [ ] **Step 10: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/round.ts pr-lifecycle/hooks/core.ts pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/world.ts pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts pr-lifecycle/tests/settings.test.ts
git commit -m "pr-lifecycle 1.5.0: the gate files issues instead of asking for waivers; late blockers add up to two rounds (R92)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 13: The agent merges when nothing holds the merge (R93, spec §6)

**Why:** in 1.4.0, once nothing holds the merge, the ready prompt and the waiver notes say "ready for the merge decision, which is the person's: … do not merge unless they ask", and Adam has to send a follow-up message. Adam (2026-10-21): "once the gate allows a merge the agent should merge". The release train still protects production, so a merge does not ship code. The prompt now tells the agent to merge with `gh pr merge <n> --<method>` and report the merge commit. If GitHub refuses the merge, the agent reports GitHub's words and stops. The merge guard (`judgeMerge`) does not change: it still lets the command through only on a head whose standing allows it.

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`MergeMethod`)
- Modify: `pr-lifecycle/hooks/core.ts` (`mergeStep`, `readyPrompt`)
- Modify: `pr-lifecycle/hooks/round.ts` (`Config`, `configOf`, `overrideConfig`, the ready branch of `advance`)
- Modify: `pr-lifecycle/hooks/register.tsx` (the two waiver notes)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/settings.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `readyPrompt` as Task 12 left it (its summary lists the follow-up issues and `scopeNote`). `configFor($, root, base)` from 1.4.0.
- Produces: `export type MergeMethod = 'merge' | 'squash' | 'rebase'` in `types/index.d.ts`; `Config.mergeMethod: MergeMethod`; `export const mergeStep = (pr: number | undefined, method: MergeMethod): string` in `core.ts`; `readyPrompt(rec: LifecycleRecord, method: MergeMethod = 'merge'): string`.
- Rulings for the plan:
  - `mergeMethod` is read only from the base's `.github/pr-gate.json`, like `issueSpec`. There is no user setting for it.
  - A refused merge is the agent's to report, and the gate sees no merge event. The lifecycle stays where it was. The next pass (a push, a new review, `/pr-gate resume`) reads the PR as usual.

- [ ] **Step 1: Write the failing tests**

In `pr-lifecycle/tests/lifecycle.test.ts`, add `mergeStep` to the import from `'../hooks/core'`, and append:

```ts
test('R93: the ready prompt tells the agent to merge with the repository\'s method and report the merge commit', async () => {
  const rec = { ...fresh(), pr: 7 }
  const said = readyPrompt(rec)
  expect(said).toContain('Nothing holds the merge: merge it now with gh pr merge 7 --merge and tell the person the merge commit')
  expect(said).toContain("if GitHub refuses the merge, tell the person GitHub's words and stop")
  expect(said).not.toContain("the person's")
  expect(said).not.toContain('do not merge')
  expect(readyPrompt(rec, 'squash')).toContain('gh pr merge 7 --squash')
  expect(mergeStep(12, 'rebase')).toBe(
    "merge it now with gh pr merge 12 --rebase and tell the person the merge commit; never write Closes, Fixes or Resolves before a follow-up issue's number in the PR, a commit or the merge, because those issues stay open, and the gate checks them after the merge; if GitHub refuses the merge, tell the person GitHub's words and stop: the lifecycle stays where it is",
  )
})
```

In `pr-lifecycle/tests/settings.test.ts`, append:

```ts
test('R93: mergeMethod picks how the agent merges; merge by default, anything else is ignored', async () => {
  expect(configOf({}).mergeMethod).toBe('merge')
  expect(overrideConfig(configOf({}), '{"mergeMethod":"squash"}').config.mergeMethod).toBe('squash')
  expect(overrideConfig(configOf({}), '{"mergeMethod":"rebase"}').config.mergeMethod).toBe('rebase')
  const bad = overrideConfig(configOf({}), '{"mergeMethod":"fast-forward"}')
  expect(bad.config.mergeMethod).toBe('merge')
  expect(bad.ignored).toEqual(['mergeMethod (not merge, squash or rebase)'])
})
```

In `pr-lifecycle/tests/flow.test.ts`:

1. In `'a clean first post-PR round does not force a second'`, replace `expect(w.prompts.at(-1)).toContain('ready for the merge decision')` with `expect(w.prompts.at(-1)).toContain('gh pr merge 1 --merge')`. Do the same for the other `toContain('ready for the merge decision')` (near line 1548).
2. In `'R81: waive post tells the agent what it covers and what still holds'`, replace `expect(said).toContain("the merge decision, which is the person's")` with `expect(said).toContain('merge it now with gh pr merge 1 --merge')`.
3. Append:

```ts
test('R93: the base\'s mergeMethod reaches the ready prompt', async ($, on) => {
  const w = world(on)
  w.git.roster = JSON.stringify({ mergeMethod: 'squash' })
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', note: 'name matches the API', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
  expect(w.prompts.at(-1)).toContain('gh pr merge 1 --squash')
  // The guard still lets the merge through on the ready head (spec §6.3).
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --squash' }))).toBe(false)
})
```

   If `w.git.roster` holding only `mergeMethod` changes the roster or collection of this flow (no `reviewers` key), add the keys the existing `toTriage` world uses to the JSON, and note it in your report.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/lifecycle.test.ts tests/settings.test.ts`
Expected: FAIL: `mergeStep` is not exported, `mergeMethod` is undefined.

- [ ] **Step 3: Implement the type and the setting**

In `pr-lifecycle/types/index.d.ts`, after `Lane`, add:

```ts
/** How the agent merges a PR the gate let through (R93): `gh pr merge --merge`, `--squash` or `--rebase`. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'
```

In `pr-lifecycle/hooks/round.ts`:

1. Add `MergeMethod` to the type import from `'../types'`.
2. Add to `Config`, after `issueSpec`: `/** How the agent merges once nothing holds the merge (R93). Repository file only. */ mergeMethod: MergeMethod`.
3. In `configOf`, add `mergeMethod: 'merge',`.
4. In `overrideConfig`, after `issueSpec`, add:

```ts
  const mergeMethod =
    r.mergeMethod === undefined || r.mergeMethod === 'merge' || r.mergeMethod === 'squash' || r.mergeMethod === 'rebase'
      ? r.mergeMethod
      : bad('mergeMethod', 'not merge, squash or rebase')
```

   and in the returned config, `mergeMethod: mergeMethod ?? c.mergeMethod,`. Add `mergeMethod` to the doc comment's list of keys.

- [ ] **Step 4: Implement the prompts**

In `pr-lifecycle/hooks/core.ts`:

1. Add `MergeMethod` to the type import from `'../types'`.
2. Before `readyPrompt`, add:

```ts
/**
 * What the agent does once nothing holds the merge (R93): it merges, with the repository's method, and reports the commit. A merge
 * GitHub refuses is reported in GitHub's words; the lifecycle stays where it is. The merge guard still checks the head (judgeMerge).
 * A closing keyword (Closes, Fixes, Resolves #n) in the PR, a commit or the merge would close a follow-up issue on merge; the gate's
 * own issue text never has one, and the agent is told not to write one. The post-merge check (Task 15) reopens any that closed anyway.
 */
export const mergeStep = (pr: number | undefined, method: MergeMethod): string =>
  `merge it now with gh pr merge ${pr ?? '<n>'} --${method} and tell the person the merge commit; ` +
  "never write Closes, Fixes or Resolves before a follow-up issue's number in the PR, a commit or the merge, because those issues stay open, " +
  'and the gate checks them after the merge; ' +
  "if GitHub refuses the merge, tell the person GitHub's words and stop: the lifecycle stays where it is"
```

3. Make `readyPrompt` take `method: MergeMethod = 'merge'`, and make its returned sentence end:

```ts
  return `pr-gate: the lifecycle review of PR #${rec.pr} is complete at ${rec.head.slice(0, 7)}: ${summary}.${note === undefined ? '' : ` ${note}`} Nothing holds the merge: ${mergeStep(rec.pr, method)}.`
```

   (`note` is Task 12's `scopeNote(rec)`.)

In `pr-lifecycle/hooks/round.ts`, in the ready branch of `advance`:

```ts
    if (id !== undefined) await finish($, id, 'passed', `Lifecycle review complete at ${at}: nothing holds the merge.`)
    else if (saved !== undefined) await logEvent($, root, branch, 'end', `ready to merge at ${at}`)
    if (saved !== undefined) await say($, saved, readyPrompt(saved, (await configFor($, saved.root, saved.base)).config.mergeMethod))
```

In `pr-lifecycle/hooks/register.tsx`:

1. Import `mergeStep` from `'./core'`.
2. In the finding-waiver note (the `tellAgent` after `const standing = settled !== undefined && pr !== undefined ? …`), replace the `standing.mayProceed` text with:

```ts
        : standing.mayProceed
          ? `nothing holds the merge: ${mergeStep(pr?.number, (await configFor($, root, pr?.baseRefName ?? settled?.base ?? '')).config.mergeMethod)}.`
```

3. In the `waive post` note, replace its `standing.mayProceed` text with:

```ts
        : standing.mayProceed
          ? `nothing else holds the merge: ${mergeStep(pr?.number, (await configFor($, root, pr?.baseRefName ?? after?.base ?? '')).config.mergeMethod)}.`
```

   If an `await` inside the conditional reads poorly, compute `const method = …` above the `tellAgent` call instead; the text is what the tests check.
4. Search for any other "do not merge unless they ask" or "ready for the merge decision" text in `pr-lifecycle/hooks/` (`grep -rn "merge decision\|do not merge unless" pr-lifecycle/hooks`). The register.tsx guidance at about line 763 ("or says the PR is ready for the merge decision") becomes "or says to merge the PR". Report anything else you change.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. `round.test.ts` fixtures that quote "ready for the merge decision" as an input text are batching tests: leave them. Then run `npm run lint` and `npm run typecheck` from the repo root.

- [ ] **Step 6: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/core.ts pr-lifecycle/hooks/round.ts pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/settings.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: the agent merges when nothing holds the merge; mergeMethod (R93)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 14: Flaky flow tests: find the cause first (spec §7.3)

**Why:** on PR #20 some flow tests failed at the kit's 5000 ms test limit when the machine was loaded (load average 5-6), and passed when they were run again. The suite has no real wait: `world.ts` fakes the clock and every process, and nothing in `pr-lifecycle/hooks/` or `pr-lifecycle/tests/` calls `setTimeout`. So the cost is the engine's own work under load, or one of the kit's wall-clock bounds. The kit fails a test that "throws, rejects or outlasts its time (5000 ms, or `timeoutMs`)". It also skips a hook that outlasts its own short wall-clock bound (1.5 s for `session.end`), and the failure lists each skipped hook and why. This task finds which of these fails before it changes anything. It raises the limit only for tests whose cost is the machine's load, and says so beside each one.

**Files:**
- Modify: `pr-lifecycle/tests/flow.test.ts` (and any other test file the run names)
- Modify, only if the cause is in the code: the hook it names
- Create: `docs/superpowers/plans/2026-10-21-wave2b-flaky-tests.md` (the findings)

**Interfaces:**
- Consumes: the whole suite after Tasks 1-13.
- Produces: nothing other tasks use.
- Rulings for the plan:
  - A test whose failure under load lists a skipped hook does not get a higher limit. That is a hook doing too much in one call, so fix the hook, or record it in the findings for the person with the hook's name.
  - A test that only outlasts 5000 ms under load gets `{ timeoutMs: 15_000 }` and the comment `// Machine load: <N> engine steps, no real wait (spec §7.3).` The limit is not raised for the whole suite.

- [ ] **Step 1: Reproduce under load**

From the repo root, load all 8 cores and run the suite three times, keeping each output:

```bash
mkdir -p .superpowers/flaky
for i in 1 2 3 4 5 6 7 8; do (timeout 900 sh -c 'while :; do :; done' &) ; done
for n in 1 2 3; do claude plugin test pr-lifecycle > .superpowers/flaky/run-$n.txt 2>&1; echo "run $n exit $?"; done
pkill -f "while :; do :; done"
uptime
```

Expected: the load average is 5 or more, and some runs fail. If none fail, run two suites at once (`claude plugin test pr-lifecycle & claude plugin test pr-lifecycle; wait`), which is how two sessions on one machine load it.

- [ ] **Step 2: Classify each failure**

For each failing test in `.superpowers/flaky/run-*.txt`, write one row in `docs/superpowers/plans/2026-10-21-wave2b-flaky-tests.md`. Each row has the test name, the runs it failed in, the kit's reason, any skipped hook with its event and reason, and the test's count of `w.clock.advance`, `done(…)` and `say(…)` calls. Then give the cause in one line:

- **load:** it outlasted 5000 ms, no hook was skipped, and it passes alone in under 5000 ms. Time it with `time claude plugin test pr-lifecycle -- tests/flow.test.ts` while the machine is idle; the per-test times the run prints, if any, go in the row.
- **hook:** the failure lists a skipped hook. Name the hook, and find which call in it waits (a loop over gh calls, a store write per finding).
- **order:** it fails only after another test, without load. Run it alone and in its file to tell.

- [ ] **Step 3: Fix by cause**

- **load:** give the test `{ timeoutMs: 15_000 }` (the kit's `test(name, options, body)` form) with the comment from the rulings, naming its step count. Example:

```ts
// Machine load: 14 engine steps, no real wait (spec §7.3).
test('R88 (Review Focus 3): two pushes between polls end one round, on the newest head', { timeoutMs: 15_000 }, async ($, on) => {
```

- **hook:** fix the hook so that one call does bounded work, for example by moving a loop of gh calls out of the hook into the ticker the way `fileIssues` runs in `advance`. Add a test that fails at the kit's default limit before the fix and passes after it. If the fix would change the gate's behaviour, record it in the findings file as a follow-up for the person, and do not change the code in this task.
- **order:** find the state the earlier test leaves behind (a module-level variable, a store the world does not reset), and reset it in `world()`.

- [ ] **Step 4: Check under load again**

Run Step 1 again. Expected: three passing runs at a load average of 5 or more. Add the result to the findings file.

- [ ] **Step 5: Run the checks**

Run `npm run check` from the repo root. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pr-lifecycle/tests docs/superpowers/plans/2026-10-21-wave2b-flaky-tests.md
git add pr-lifecycle/hooks   # only if Step 3 changed a hook
git commit -m "pr-lifecycle 1.5.0: flaky flow tests, cause found and fixed or bounded (spec §7.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 15: The gate checks the follow-up issues after the merge (spec §5.10-5.12, decision M3)

**Why:** Adam (2026-10-21): "the important part is the gate checks that the issues are there after the PR merges before it stops running." GitHub closes an issue on merge only when the PR links it with a closing keyword (`Closes`, `Fixes`, `Resolves #n`) or through the Development sidebar. The gate's own text never uses one, and Task 13 tells the agent never to write one. An issue can still close another way, for example by a keyword in a commit or by hand, or it can be deleted or transferred. So when the gate sees the PR merged, and before it archives the record, it reads each follow-up issue:
- open: logged as checked;
- closed: reopened, with a comment;
- missing, or the reopen fails: filed again.

If any check fails, the record stays put and the agent gets gh's words. In 1.4.0 the gate notices a merge only at `/pr-gate`, at a session start or in a collection poll (R62). This task also notices the agent's own `gh pr merge` succeeding.

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (new `checkIssuesAfterMerge`, `closeLifecycle`)
- Modify: `pr-lifecycle/hooks/register.tsx` (the merge branch of the `tool.call` hook, new `onMerged`)
- Modify: `pr-lifecycle/tests/world.ts` (issue view and reopen fakes; the Bash fake merges)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes (Task 12): `isSettledByIssue`, `issueOf`, `issueTitle`, `issueBody`, `filingPeak`, `issueLine`, `LABEL_COLOURS`, `issueNumberOf`, `configFor(...).config.issueSpec`. Also (1.4.0) `closeLifecycle`, `archiveLifecycle`, `prStateOf`, `say`, `updateRecord`, `LOG_CAP`.
- Produces: `export async function checkIssuesAfterMerge($: Engine, rec: LifecycleRecord): Promise<{ failed: string[]; lines: LogEntry[]; findings: Finding[] }>` in `round.ts`. World knobs: `gh.issueStates: Record<number, 'OPEN' | 'CLOSED' | 'missing'>` (absent means OPEN), `gh.reopenAnswer?: 'ok' | 'fail'`, `gh.reopened: string[][]`, `gh.mergeAnswer?: 'ok' | 'fail'`.
- Rulings for the plan:
  - The check runs only for a PR that **merged**. A closed PR's issues are left as they are.
  - It runs wherever `closeLifecycle(…, 'MERGED')` runs (`/pr-gate`, a session start, a collection poll), and after the agent's own `gh pr merge` that GitHub accepted and that reads back as MERGED. An auto-merge (`--auto`) that has not merged yet is checked at the next of those.
  - A failed check leaves the record where it was, with `postStatus: 'blocked'` and the message, and does not archive it. `/pr-gate resume` reads the PR as MERGED and runs the check again (the start path already calls `closeLifecycle`).
  - Findings the person waived (security) have no issue and are not checked.

- [ ] **Step 1: Write the world fakes**

In `pr-lifecycle/tests/world.ts`, add to the `gh` type:

```ts
    /** Each issue's state for `gh issue view` (spec §5.12); absent means OPEN, 'missing' answers as a deleted issue does. */
    issueStates: Record<number, 'OPEN' | 'CLOSED' | 'missing'>
    /** How `gh issue reopen` answers: 'ok' (default) or 'fail'. */
    reopenAnswer?: 'ok' | 'fail'
    /** Every reopen the gate ran: its argv after `gh`. */
    reopened: string[][]
    /** How the agent's `gh pr merge` answers in the Bash fake: 'ok' (default) merges the PR, 'fail' refuses as GitHub would. */
    mergeAnswer?: 'ok' | 'fail'
```

Initialise `issueStates: {}` and `reopened: []` next to `filed: []`. In `fake`, next to Task 12's issue branch, add:

```ts
      // The post-merge check (spec §5.12): gh issue view <n> --repo <r> --json state, and gh issue reopen <n> --repo <r> --comment <text>.
      if (e.argv[1] === 'issue' && e.argv[2] === 'view') {
        const state = w.gh.issueStates[Number(e.argv[3])] ?? 'OPEN'
        if (state === 'missing') {
          return { value: { exitCode: 1, stdout: '', stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${e.argv[3]}.`, isStdoutTruncated: false, isStderrTruncated: false } }
        }
        return out(JSON.stringify({ state }))
      }
      if (e.argv[1] === 'issue' && e.argv[2] === 'reopen') {
        w.gh.reopened.push(e.argv.slice(1))
        if (w.gh.reopenAnswer === 'fail') {
          return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        w.gh.issueStates[Number(e.argv[3])] = 'OPEN'
        return out('')
      }
```

In the Bash `tool.call` fake, before its `return`, add:

```ts
    // The agent's merge (R93): GitHub accepts it and the PR reads MERGED, or refuses it.
    if (/\bgh\s+pr\s+merge\b/.test(e.command)) {
      if (w.gh.mergeAnswer === 'fail') {
        return { result: { stdout: '', stderr: 'GraphQL: Required status check "ci" is expected. (mergePullRequest)', interrupted: false }, isError: true } as never
      }
      w.gh.state = 'MERGED'
      return { result: { stdout: `✓ Merged pull request #${w.gh.pr}`, stderr: '', interrupted: false } as never }
    }
```

If the engine's tool result has a different field for a failed Bash call than `isError`, use the one `isHeld` already reads, and note it in your report.

Existing tests that merge (`gh pr merge 1 --squash` in `'a clean first post-PR round does not force a second'`, Task 13's test and others: `grep -n "pr merge" pr-lifecycle/tests/*.ts`) now archive the record when the merge goes through. Where a test reads the record after the merge expecting `ready`, set `w.gh.mergeAnswer = 'fail'` before the merge if the test is about the guard, or assert `archived` if it is about the end state. List each change.

- [ ] **Step 2: Write the failing flow tests**

Append to `pr-lifecycle/tests/flow.test.ts`:

```ts
/** A P2 deferral Codex agreed with, filed as #21 by the gate: the lifecycle is ready (Task 12). */
const toFiled = async ($: Engine, w: ReturnType<typeof world>): Promise<void> => {
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P2', note: 'needs a schema change', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
}

const archivedOf = (w: ReturnType<typeof world>): LifecycleRecord | undefined => {
  const key = [...w.store.keys()].find(one => one.startsWith(`${KEY}:archived:`))
  return key === undefined ? undefined : (w.stored(key) as LifecycleRecord)
}

test('spec §5.12: after the agent merges, the gate finds each follow-up issue open, logs it, archives the record and says what stays open', async ($, on) => {
  const w = world(on)
  await toFiled($, w)
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --merge' }))).toBe(false)
  await w.clock.advance(1000)
  expect((await recordOf(w)).phase).toBe('archived')
  expect(archivedOf(w)?.log?.some(one => one.text === 'G2-1: me/repo#21 open after the merge')).toBe(true)
  expect(w.prompts.at(-1)).toContain('PR #1 merged. Follow-up issues still open: G2-1 → #21 Major [P2].')
  expect(w.gh.reopened).toEqual([])
})

test('spec §5.12: a follow-up issue the merge closed is reopened with a comment', async ($, on) => {
  const w = world(on)
  await toFiled($, w)
  w.gh.issueStates[21] = 'CLOSED'
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --merge' })
  await w.clock.advance(1000)
  expect(w.gh.reopened).toHaveLength(1)
  expect(w.gh.reopened[0]?.slice(0, 5)).toEqual(['issue', 'reopen', '21', '--repo', 'me/repo'])
  expect(w.gh.reopened[0]?.at(-1)).toContain('PR #1 merged without fixing G2-1')
  expect((await recordOf(w)).phase).toBe('archived')
  expect(archivedOf(w)?.log?.some(one => one.text === 'G2-1: reopened me/repo#21 after the merge')).toBe(true)
})

test('spec §5.12: a follow-up issue that is gone is filed again, and the finding names the new one', async ($, on) => {
  const w = world(on)
  await toFiled($, w)
  w.gh.issueStates[21] = 'missing'
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --merge' })
  await w.clock.advance(1000)
  expect(w.gh.filed).toHaveLength(2)
  expect(w.gh.filed[1]).toContain(`title=G2-1 Major [P2] Consider renaming this (#${w.gh.pr}, feat/x)`)
  expect(archivedOf(w)?.findings.find(one => one.id === 'G2-1')?.followUp).toBe('#22')
  expect(w.prompts.at(-1)).toContain('G2-1 → #22 Major [P2]')
})

test('spec §5.12: when an issue cannot be reopened or filed again, the record is not archived, and resume checks again', async ($, on) => {
  const w = world(on)
  await toFiled($, w)
  w.gh.issueStates[21] = 'CLOSED'
  w.gh.reopenAnswer = 'fail'
  w.gh.issueAnswer = 'fail'
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --merge' })
  await w.clock.advance(1000)
  const held = await recordOf(w)
  expect(held.phase).not.toBe('archived')
  expect(held.postStatus).toBe('blocked')
  expect(w.prompts.at(-1)).toContain('PR #1 merged, but the gate could not confirm the follow-up issue of G2-1')
  expect(w.prompts.at(-1)).toContain('HTTP 403: Resource not accessible by integration')
  expect(w.prompts.at(-1)).toContain('/pr-gate resume')
  w.gh.reopenAnswer = 'ok'
  w.gh.issueAnswer = 'ok'
  await say($, 'resume')
  await w.clock.advance(1000)
  expect((await recordOf(w)).phase).toBe('archived')
  expect(w.gh.issueStates[21]).toBe('OPEN')
})

test('spec §6.4: a merge GitHub refuses leaves the lifecycle where it was', async ($, on) => {
  const w = world(on)
  await toFiled($, w)
  w.gh.mergeAnswer = 'fail'
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --merge' })
  await w.clock.advance(1000)
  expect((await recordOf(w)).phase).toBe('ready')
  expect(w.gh.reopened).toEqual([])
})

test('spec §5.12: a merge the session finds at its start runs the check before it archives', async ($, on) => {
  const w = world(on)
  await toFiled($, w)
  w.gh.state = 'MERGED'
  w.gh.issueStates[21] = 'CLOSED'
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(1000)
  expect(w.gh.reopened).toHaveLength(1)
  expect((await recordOf(w)).phase).toBe('archived')
})
```

Import `Engine` and `LifecycleRecord` types and `KEY` if the file does not already have them. The session-start test needs the start path to reach a `ready` record. If the session-start hook only looks at `post` records (it checks `rec.phase === 'post'`), widen that one check to `post` or `ready` for the MERGED read alone, and keep the rest as it is.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `claude plugin test pr-lifecycle -- tests/flow.test.ts`
Expected: the new tests FAIL. The merge leaves the record `ready`, because nothing notices it.

- [ ] **Step 4: Implement the check in `round.ts`**

Next to `closeLifecycle`, add:

```ts
/**
 * After a merge (spec §5.12, decision M3): each finding settled by its issue still has an open issue. A closed one is reopened with a
 * comment; a missing one, or one gh cannot reopen, is filed again with its title and body. `failed` names each finding whose issue
 * the gate could not confirm, with gh's words; the caller then leaves the record where it is.
 */
export async function checkIssuesAfterMerge($: Engine, rec: LifecycleRecord): Promise<{ failed: string[]; lines: LogEntry[]; findings: Finding[] }> {
  const failed: string[] = []
  const lines: LogEntry[] = []
  const settled = rec.findings.filter(isSettledByIssue)
  if (settled.length === 0 || rec.slug === undefined) return { failed, lines, findings: rec.findings }
  const { config: c } = await configFor($, rec.root, rec.base)
  const gh = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    try {
      return await $.process.run(['gh', ...args], { cwd: rec.root, timeoutMs: 30_000 })
    } catch (e) {
      return { exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
    }
  }
  const words = (got: { exitCode: number; stderr: string }): string => (got.stderr.trim() || `gh exited ${got.exitCode}`).slice(0, 200)
  const log = async (text: string): Promise<void> => {
    lines.push({ at: await $.clock.now(), kind: 'check', text: text.slice(0, 300) })
  }
  const moved = new Map<string, string>()
  for (const f of settled) {
    const ref = issueOf(f.followUp, rec.slug)
    if (ref === undefined) continue
    const where = `${ref.repo}#${ref.number}`
    const view = await gh(['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'state'])
    let state: unknown
    try {
      state = view.exitCode === 0 ? (JSON.parse(view.stdout) as { state?: unknown }).state : undefined
    } catch {
      state = undefined
    }
    if (state === 'OPEN') {
      await log(`${f.id}: ${where} open after the merge`)
      continue
    }
    let why = view.exitCode === 0 ? `gh read the issue's state as ${String(state)}` : words(view)
    if (state === 'CLOSED') {
      const comment = `Reopened by pr-gate: PR #${rec.pr ?? '?'} merged without fixing ${f.id}. It stays open as the follow-up.`
      const reopen = await gh(['issue', 'reopen', String(ref.number), '--repo', ref.repo, '--comment', comment])
      if (reopen.exitCode === 0) {
        await log(`${f.id}: reopened ${where} after the merge`)
        continue
      }
      why = words(reopen)
    }
    // Gone, or not reopened: file it again in this repository, labelled as before.
    const label = `severity:${filingPeak(f)}`
    await gh(['label', 'create', label, '--repo', rec.slug, '--color', LABEL_COLOURS[filingPeak(f)]])
    const post = await gh(['api', '-X', 'POST', `repos/${rec.slug}/issues`, '-f', `title=${issueTitle(f, rec, c.issueSpec)}`, '-f', `body=${issueBody(f, rec)}`, '-f', `labels[]=${label}`])
    const number = post.exitCode === 0 ? issueNumberOf(post.stdout) : undefined
    if (number !== undefined) {
      moved.set(f.id, `#${number}`)
      await log(`${f.id}: ${where} ${state === 'CLOSED' ? 'could not be reopened' : 'is gone'}; filed ${rec.slug}#${number} ${label}`)
      continue
    }
    failed.push(`${f.id} (${why}; filing it again: ${post.exitCode === 0 ? "GitHub did not give the new issue's number" : words(post)})`)
    await log(`${f.id}: could not confirm ${where} after the merge`)
  }
  const findings = rec.findings.map(f => (moved.has(f.id) ? { ...f, followUp: moved.get(f.id), issueError: undefined } : f))
  return { failed, lines, findings }
}
```

`issueNumberOf` and `LABEL_COLOURS` are defined in `round.ts` (Task 12 and R85). If `LABEL_COLOURS` sits at the end of the file as a `const`, that is fine, because the function runs later.

Replace `closeLifecycle` with:

```ts
/**
 * The PR was merged or closed (R62): the branch's live run ends with a short message, and its record is archived. After a merge the
 * follow-up issues are checked first (spec §5.12): if one cannot be confirmed, the record stays, blocked, the agent gets gh's words,
 * and `/pr-gate resume` checks again.
 */
export async function closeLifecycle($: Engine, root: string, branch: string, pr: number | undefined, state: 'MERGED' | 'CLOSED'): Promise<string> {
  const rec = await loadRecord($, root, branch)
  if (state === 'MERGED' && rec !== undefined && rec.phase !== 'archived') {
    const checked = await checkIssuesAfterMerge($, rec)
    if (checked.failed.length > 0) {
      const why = `PR #${pr ?? '?'} merged, but the gate could not confirm the follow-up issue of ${checked.failed.join('; ')}`
      const saved = await updateRecord($, root, branch, one => ({
        ...one,
        findings: checked.findings,
        postStatus: 'blocked',
        message: why,
        log: [...(one.log ?? []), ...checked.lines].slice(-LOG_CAP),
      }))
      if (saved !== undefined) {
        await say($, saved, `pr-gate: ${why}. Check that gh can read and create issues in the repository (gh auth status), then run /pr-gate resume: the gate checks them again.`)
      }
      return why
    }
    if (checked.lines.length > 0) {
      const saved = await updateRecord($, root, branch, one => ({ ...one, findings: checked.findings, log: [...(one.log ?? []), ...checked.lines].slice(-LOG_CAP) }))
      const open = (saved ?? rec).findings.filter(isSettledByIssue)
      if (saved !== undefined && open.length > 0) await say($, saved, `pr-gate: PR #${pr ?? '?'} merged. Follow-up issues still open: ${open.map(issueLine).join('; ')}.`)
    }
  }
  const said = `PR #${pr ?? '?'} from ${branch} was ${state === 'MERGED' ? 'merged' : 'closed'}: its lifecycle is archived, its history kept`
  const run = await getRun($)
  if (run !== null && run.status === 'running' && run.root === root && run.branch === branch) await finish($, run.id, 'stopped', `${said}.`)
  await archiveLifecycle($, root, branch, await $.clock.now())
  return said
}
```

The prompt says "/pr-gate resume" because the person types it. It is not the agent's own step (R42): the agent fixes gh, then tells the person. If a test of R42/R49 flags the wording, use "then tell the person to run /pr-gate resume" instead and update the test string.

Add `isSettledByIssue`, `issueOf`, `issueTitle`, `issueBody`, `filingPeak` and `issueLine` to the import from `'./lifecycle'` where they are not already imported.

- [ ] **Step 5: Notice the agent's merge in `register.tsx`**

Add, near `onOpened`:

```ts
/** The agent's merge went through (R93): once GitHub reads the PR as merged, the lifecycle closes, after the issue check (spec §5.12). */
const onMerged = async ($: Engine, action: PrAction): Promise<void> => {
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return
  const view = await $.process.run(
    ['gh', 'pr', 'view', ...(action.number === undefined ? [] : [String(action.number)]), ...(action.repo === undefined ? [] : ['--repo', action.repo]), '--json', 'number,headRefName,state'],
    { cwd: top.out, timeoutMs: 30_000 },
  )
  let pr: { number?: unknown; headRefName?: unknown; state?: unknown } | undefined
  try {
    pr = view.exitCode === 0 ? JSON.parse(view.stdout) : undefined
  } catch {
    pr = undefined
  }
  if (pr?.state !== 'MERGED' || typeof pr.headRefName !== 'string' || typeof pr.number !== 'number') return
  const rec = await loadRecord($, top.out, pr.headRefName)
  if (rec === undefined || rec.phase === 'archived' || rec.pr !== pr.number) return
  await closeLifecycle($, top.out, pr.headRefName, pr.number, 'MERGED')
}
```

In the `tool.call` hook's merge branch, replace `return refusal !== undefined ? { deny: asHold(refusal) + tail } : next(e)` with:

```ts
      if (refusal !== undefined) return { deny: asHold(refusal) + tail }
      const ran = await next(e)
      // A merge GitHub refused leaves the lifecycle where it was (spec §6.4); one that went through closes it (spec §5.12).
      if (ran.deny === undefined && ran.isError !== true) await onMerged($, target).catch(() => undefined)
      return ran
```

Import `closeLifecycle` from `'./round'` if it is not imported. Check that the `.catch(($, e, next) => …)` fallback still replays the tool's result, not a hold, once `next` was called (it reads `next.called`).

- [ ] **Step 6: Run the tests**

Run: `claude plugin test pr-lifecycle`
Expected: PASS, including the R62 tests (no settled findings, so nothing changes for them). Then run `npm run lint` and `npm run typecheck` from the repo root.

- [ ] **Step 6a: Amendment A6 + A7 (PR #25 review): the post-merge check never writes over a replaced lifecycle**

Codex reproduced the bug with a delayed checker. A reset during `checkIssuesAfterMerge`'s reads let `closeLifecycle` write generation 1's findings into generation 2 and then archive it. Fix:

- `checkIssuesAfterMerge($, rec)` uses Task 12's `isMoved` rule against `rec`: the record is gone or archived, its `generation` changed, or its `postStatus` moved. It reloads and checks before every GitHub mutation (reopen, refile) and after the last read. When the record has moved, it returns `{ moved: true }` and does nothing more.
- In `closeLifecycle`, every `updateRecord` callback returns `latest` unchanged when `(latest.generation ?? 0) !== (rec.generation ?? 0)` or the record is archived, and notes it. On a moved record: no `say`, no finish of the live run, no archive, and the function returns a "replaced" message.
- `archiveLifecycle` gets an optional `generation` argument and archives only a record of that generation. `closeLifecycle` passes `rec.generation ?? 0`.
- The refile path follows A7 (Task 12): a POST whose answer lacks the label keeps the new issue number with `followUpLabelError`, counts as failed for this check, and is labelled, not posted again, on resume.

Tests, using Task 12's delayed-`gh` pattern. Each one holds the call, runs `/pr-gate reset` and a fresh start, then releases it:
1. Holding the issue read: generation 2 is not archived, its findings are its own, and no reopen or POST follows.
2. Holding the reopen: same, and no refile after it.
3. Holding the refile POST: same, and generation 2's findings carry no `followUp` from it.
4. A refile whose POST drops the label: the record stays blocked with `label-failed` named. Resume labels that issue, and only one POST is made.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/round.ts pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/world.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle 1.5.0: the gate checks the follow-up issues after the merge, reopening or refiling them (spec §5.12)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```

---

### Task 16: Rulings, docs and version 1.5.0 (spec §8, §10)

**Why:** the repo keeps every ruling with its cost if wrong, so a later change can tell a decision from an accident (CLAUDE.md). The README, the roadmap and CLAUDE.md must say what 1.5.0 does. When a component's version changes, its `plugin.json`, its README version line and the root README table change together.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`
- Modify: `pr-lifecycle/README.md`, `README.md`, `pr-lifecycle/.claude-plugin/plugin.json`
- Modify: `LIFECYCLE_SPEC.md`, `ROADMAP.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 1-15 as built. Read each task's report in the SDD workspace for any ruling the implementer or the controller made, and add it.
- Produces: nothing code uses.

- [ ] **Step 1: Record the rulings**

Append to `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`:

```markdown
## Rulings in wave 2b (1.5.0)

Spec: `docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md`. Plan: `docs/superpowers/plans/2026-10-21-pr-lifecycle-wave2b.md`.

- Ruling R88 (amends R33, R42 and what `usedRounds` counts; Adam, decisions F, G, H, 2026-10-20 and 2026-10-21): a post-PR round is one head. Findings go to the agent while collection still waits for slow reviewers, and the agent pushes as it goes; a push ends the round on its head at the end of the turn that pushed, and the next round starts on the new head. A round is charged only when it brings a new blocking finding or Codex rejects a fix, rebuttal or deferral in it ("a rejected fix still uses a round"); a clean round is free. Reviewers are asked again once per turn that pushed, on its last head — cost if wrong: an agent that pushes often spends no allowance on clean pushes, and a slow reviewer's late finding lands in a later round.
- Ruling R89 (Adam, decision S): collection ends on GitHub's signals: the base's required check runs, the PR's pending review requests and the roster. Check suites are never read. The quiet window applies only when none of the three exists. A review requested from this machine's own login is never waited for — cost if wrong: a reviewer GitHub does not list as requested, outside the roster, is not waited for.
- Ruling R90 (Adam, decision O): a finding that names a problem already raised is linked to the earlier one and follows its status; the gate links an exact repeat, and a link the agent gives is checked by Codex. Links do not chain, a link takes the higher peak severity, and a linked finding is never filed on its own — cost if wrong: two separate problems linked in error settle together until Codex refuses the link.
- Ruling R91 (PR #20, G7-4, G7-9, G11-2): every reply id the agent reports is the gate's own, whatever its answer, and is never read back as feedback — cost if wrong: a reviewer comment whose id the agent misreports is dropped.
- Ruling R92 (amends R39, R40, R55 and R85; Adam, decisions M and M2, 2026-10-21): a finding goes through a Codex review round and a fix attempt before any issue. Every deferral, at any severity, goes to Codex's free check: refused, it is open again and the round is charged; agreed, it waits. When the review can do no more (exhausted, or only deferrals and disputes hold), the gate files a GitHub issue for each finding still holding the merge, except security, labelled `severity:<peak>` and titled `<id> <Name> [P<n>] <title> (#<pr>, <branch>, <Jira key>, <spec>)`; an issue the agent's follow-up names is labelled instead. The issue settles the finding, and a change to its file does not unsettle it. Before filing, a blocker first raised in the round that spent the allowance, or in the last round, adds one round, at most twice per lifecycle, and the report tells the person the PR's scope may be too wide. A finding whose severity the record lost is filed as Critical [P1], with the loss in its body. Security findings wait for the person's waiver. After the merge, and before it archives the record, the gate checks each follow-up issue: an open one is logged, a closed one is reopened with a comment, and a missing one is filed again. A check gh cannot complete leaves the record blocked until `/pr-gate resume` (decision M3, spec §5.12) — cost if wrong: an issue is filed for a finding the person would have waived, and closing it is theirs.
- Ruling R93 (Adam, decision N, 2026-10-21: "once the gate allows a merge the agent should merge"): when nothing holds the merge, the agent merges with `gh pr merge <n> --<mergeMethod>` (`merge` by default, from the base's `.github/pr-gate.json` only) and reports the merge commit; a merge GitHub refuses is reported in GitHub's words and the lifecycle stays where it was. The merge guard does not change. The release train still protects production — cost if wrong: a PR merges without the person reading it last.
- Ruling R94 (PR #20, G7-2, G7-4): a severity tag is only a token standing alone (`[P2]`, `(P2)`, `**P2**`, `P2:` or `P2 -` at the start of a line, or a badge image named for it); any other mention is a hint. An acknowledgement is stored with `answer: 'acknowledged'` and named as one in holds — cost if wrong: a reviewer's tag written another way reads as a hint, which triage may lower.

### Rulings made while planning and building 1.5.0

- Charging applies to post-PR rounds only; pre-PR rounds draw on the allowance as in 1.4.0 — cost if wrong: a clean pre-PR round still costs a round.
- A rejection in an answer run (R37, no round recorded) charges nothing — cost if wrong: an answer run's rejected fix is free.
- Codex refusing a link the agent gave is not charged; the finding is open again on its own — cost if wrong: a wrong link costs no round.
- The deferral check replaces R85's lowering check: one check of the deferral covers a lowered severity too — cost if wrong: none known; the lowering is in the deferral's text Codex reads.
- Triage at the end of a head keeps 1.4.0's ending: the final-head check is still free — cost if wrong: none known.
- A push ends the round at the end of the turn that pushed, not at the push; polls pause the gate's actions during the agent's turn — cost if wrong: a long turn holds the next round until it ends.
- The prompts no longer list "commits since" a round began — cost if wrong: the agent reads the log itself.
- The exhaustion paths are tested on `planIssues` (no store in the test engine), and the gh side through the awaiting path, which runs the same `fileIssues`. A dispute is tested at the unit level — cost if wrong: a flow-only bug at exhaustion is caught later.
- A deferral settled under R85 before 1.5.0 has no Codex ruling, so Codex checks it once after the upgrade — cost if wrong: one extra free check per such deferral.
- When issues are filed (spec §5.11): Adam asked for blockers to be filed at once and advisories before the PR opens, with leave to do better. The gate keeps M2's fix-first order and adds the post-merge check, so the issue queue holds only what the PR left unfixed — cost if wrong: a finding is visible as an issue only once the rounds end, not as it is raised.
- Flaky tests (spec §7.3): the limit is raised only for a test whose cost is machine load, with a comment beside it; a test that loses a hook under load is fixed or recorded instead.
```

Then add one line for each ruling the controller recorded in the SDD ledger that is not above, in the same form: what was decided, why, and the cost if wrong.

- [ ] **Step 2: Update the README**

In `pr-lifecycle/README.md`:

1. Change `Version 1.4.0.` to `Version 1.5.0.`
2. Under **One round**, add: a post-PR round is one head, triage starts during collection, and a push ends the round at the end of the turn (R88).
3. Under **The budget**, replace "Outside the allowance." with: "**Outside the allowance.** The post-PR baseline (rounds 1 and 2), the final-head check, Codex's checks (rebuttal, deferral, link), and any post-PR round that brings no new blocking finding and no Codex rejection (R88). Up to two rounds the gate adds for late blockers (R92) are named in the report." Change the `allow` line to "It is the person's alone." (drop "It settles no deferral or dispute" only if it is no longer true; it still is).
4. Replace **Deferrals** with:

```markdown
### Deferrals and issues

A deferral is an answer, not a release. Codex checks every deferral at the end
of the round, at no cost: if it says the finding can be fixed in this PR, the
finding is open again and the round is charged (R92). If it agrees, the
finding waits.

When the review can do no more (the allowance is spent, or only deferrals and
disputes hold the merge), the gate files a GitHub issue for each finding still
holding it, except security ones:

- title: `R4-3 Major [P2] <title> (#20, <branch>, <Jira key>, <issueSpec>)`;
- label: `severity:<P>`, the highest severity the finding had;
- body: who raised it and where, the problem, and why it was not fixed here.

If the agent's follow-up names an issue that already tracks it, the gate
labels that one instead. A finding whose severity was lost is filed as
Critical [P1]. The issue settles the finding; a change to its file does not
unsettle it. After the merge, before the gate archives the record, it checks
each follow-up issue: it reopens a closed one and files a missing one again. A failure to file holds the merge with gh's words, and
the next pass retries. Security findings wait for `/pr-gate waive <id>`.

Before filing, a blocker first raised in the round that spent the allowance
gets one more round, at most twice per lifecycle. The report then says the
PR's scope may be too wide.
```

5. Under **Waivers lapse**, add: "A finding settled by its issue does not lapse (R92)."
6. Under **Who decides**, replace the second paragraph's list with: "It names the person only for security findings. Everything else ends in a fix, Codex's check, or an issue (R92). When nothing holds the merge, the agent merges (R93)."
7. Add a section after **Who decides**:

```markdown
### The agent merges

When nothing holds the merge, the ready prompt tells the agent to merge with
`gh pr merge <n> --<mergeMethod>` and report the merge commit (R93). The guard
still checks the head and CI. If GitHub refuses, the agent reports GitHub's
words, and the lifecycle stays where it was.
```

8. Under **Settings per repository**, add `"mergeMethod": "merge"` and `"issueSpec": "docs/spec.md"` to the example, and add after the limits sentence: "`mergeMethod` is `merge` (default), `squash` or `rebase`. `issueSpec` is a spec handle of at most 80 characters, named in each filed issue's title. Both are read from the base's file only."
9. Under **Commands**, change the `waive <findingId>` row's list to say a finding the gate cannot file (security) is the usual case, and the `allow` row to "add 1 to 5 review rounds".
10. Read the README for any other text that says the person decides the merge, that a deferral waits for a waiver, or that collection waits a quiet window with a roster, and fix it to match. List each change in your report.

In `pr-lifecycle/.claude-plugin/plugin.json`, set `"version": "1.5.0"`. In the root `README.md`, change the table's `1.4.0` to `1.5.0`, and the line "`pr-lifecycle` 1.4.0 is the plugin in daily use" to 1.5.0.

- [ ] **Step 3: Update LIFECYCLE_SPEC.md and ROADMAP.md**

In `LIFECYCLE_SPEC.md`, append:

```markdown
## Amended in pr-lifecycle 1.5.0 (wave 2b)

- **One round is one head (R88).** A post-PR round reviews one head. A push ends it at the end of the turn that pushed. Only a round with a new blocking finding or a Codex rejection draws on the allowance.
- **Collection (R89).** It waits for the base's required checks, the PR's requested reviews and the roster; the quiet window only when none exists.
- **Settling (R92).** Deferrals get Codex's check. When the review can do no more, findings still holding the merge get GitHub issues, except security; the issue settles them.
- **The merge (R93).** When nothing holds the merge, the agent merges with the repository's `mergeMethod`. The gate then checks that every follow-up issue is open (reopening or refiling it) before it archives the record.

See `docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md`.
```

In `ROADMAP.md`, under **Wave 2b**, mark items 1-4 done with "(done in 1.5.0)". Move item 5 (lanes) to a new `### Wave 2c: parallel fixers in lanes` section after it, unchanged. Replace the **Not yet placed: one finding per problem** section with one line under wave 2b: "6. **One finding per problem (done in 1.5.0, R90).**" Add "7. **Issues instead of waivers; the agent merges (done in 1.5.0, R92, R93).**". Update the wave 2 spec path in the intro if it names `2026-10-20-pr-lifecycle-wave2b-design.md`: the spec is `2026-10-21-pr-lifecycle-wave2b-design.md`.

- [ ] **Step 4: Update CLAUDE.md**

1. The state heading: `## Current state (<today's date>, after wave 2b)`.
2. `pr-lifecycle/` **1.4.0** → **1.5.0**. Add to the ruling list: "R88–R94 in wave 2b".
3. In **Checks**, set pr-lifecycle's test count to the number `npm run test` prints now.
4. Add to the pr-lifecycle bullet: "When the review can do no more, it files a GitHub issue for each finding still holding the merge, except security (R92), and once nothing holds the merge, the agent merges (R93). The GitHub issue queue is Adam's list of what to fix, highest severity first."

- [ ] **Step 5: Run the checks**

Run `npm run check` from the repo root. Expected: PASS (lint, test, validate, typecheck).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md pr-lifecycle/README.md README.md pr-lifecycle/.claude-plugin/plugin.json LIFECYCLE_SPEC.md ROADMAP.md CLAUDE.md
git commit -m "pr-lifecycle 1.5.0: rulings R88-R94, docs and version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1"
```
