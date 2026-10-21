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

