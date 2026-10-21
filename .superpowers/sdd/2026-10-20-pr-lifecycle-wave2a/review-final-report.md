# Final review: pr-lifecycle 1.4.0 (wave 2a), 7ab6b64..7619966

Reviewer: Claude (senior code review), 2026-10-20. Read-only review. The checks ran at ac9a91d, whose later commits touch only the ledger:
`npm run check` is green: lint, test (pr-lifecycle 472 pass, 0 fail; codex-gate 22), validate, typecheck.

## Strengths

- **The pure and async halves are split cleanly.** `standingOf` and `holdText` (lifecycle.ts) are pure and unit-tested. `gatherStanding`,
  `readChecks` and `requiredChecksOf` (round.ts) only gather. `ciHold` is now a pure renderer of the standing's `ci-*` blockers, so the
  guard and the prompts can't disagree about CI.
- **R86 fails closed where it counts.** `requiredChecksOf` returns 'unknown' on a throw, a non-zero rules exit, a non-404 classic
  failure, or a payload that doesn't parse. 'unknown' is not cached. `gatherStanding` then marks every check required, so a waiver sets
  nothing aside. `readRequired` treats half a set as no set.
- **The R80 re-reads are in the right places.** `isRunning` runs after each long await in `beginTriage` (after `fetchFeedback`, after the
  fetch and `git log`), around `syncToHead` in `checkRebuttals` and `endCollect`, in `failPost`, and at the top of `endRound`. A stopped
  or waived run records nothing and sends nothing. The early return in `advance` sits before every branch that starts work. The flow
  tests cover triage, recheck, round-owed and verify-owed.
- **Batching is correct.** Each outermost `holdingPrompts` call is its own batch, and `mergeNotes` pairs a note and a prompt only by
  batch and record. `dropQueued` keeps the current batch. The PR19-4 regression test (reset before the flush) pins it.
- **`isNoAction` reads the whole body.** It splits the body into sentences and requires every one to be a no-action form, and a
  COMMENTED review must also contain a settling sentence. CHANGES_REQUESTED never settles. "LGTM, but please rename X" stays one
  sentence and goes to triage.
- **Every deny path carries R87.** The merge, outside, no-base and create denies and the `.catch` guard failure all append the line, and
  heredoc bodies, quoted text and `$(…)` are removed before the command is split.
- **Docs and version agree.** plugin.json, the pr-lifecycle README, the root README table, CLAUDE.md (version, R79–R87 and the 472
  count) and LIFECYCLE_SPEC all say 1.4.0, and the R79–R87 rulings are recorded with their costs.
- **1.3.0 records still load.** Every new field (`severitySource`, `followUp`, `FindingEvent.severity`, the `approval` log kind) is
  optional, so a 1.3.0 record loads unchanged.

## Issues

### Critical (Must Fix)

**C1. An advisory label on any line tags the whole comment P3, which lets the agent settle a real finding with no person and no Codex
check.** `pr-lifecycle/hooks/github.ts:208` (`ADVISORY`), used by `severityHint` at `:216`.

- **What's wrong.** `ADVISORY` has the `m` flag, so `^` matches at the start of every line. Any review body with one line that starts
  "Nit:", "Optional:", "**Optional:**", "- nit:", "Follow-up:" or similar reads as a reviewer-labelled P3 (`isTagged: true`, so
  `severitySource: 'tag'`), whatever the rest of the body says. These bodies all return P3 'tag' (checked with node):
  - "This migration drops the users table on rollback, losing data.\n\nNit: the comment above has a typo."
  - "The reset path deletes pending findings.\n\n**Optional:** add a test."
  - "Race: the lock is released before the write.\n- nit: rename x"
- **It also regresses 1.3.0.** `ADVISORY` is tested before the `critical|blocker|high` → P1 guess (`:218`). "This is a critical bug.\n\nNit: …"
  was P1 in 1.3.0 and is P3 'tag' in 1.4.0.
- **Why it matters (gating).** The finding is stored as a reviewer-tagged P3, so two settle paths open:
  - **R85.** `isSettledDeferral` (lifecycle.ts) wants deferred + P3 + `followUp` + no security flag. The agent answers `deferred` with
    any non-blank `followUp` (not shape-checked; a deferred minor). The finding leaves `mergeHolds`, `decideNext` goes to ready, and
    `judgeMerge` finds nothing holding: the merge runs with no Codex check and no waiver from the person. The triage prompt even tells
    the agent to keep the reviewer's own severity.
  - **R82.** `mayAcknowledge` passes, because a 'tag' P3 isn't ≤ P2. Only Codex's check stands between "acknowledged" and settled.

  A data-loss or race finding should hold the merge until it is fixed and verified, its rebuttal is accepted, or the person waives it.
  Here it can be merged past on the agent's word alone. Mixed bodies like these are the usual shape of a Copilot or Claude review
  comment, so this isn't an edge case. The controller's line-33 ruling covers only the security case, which both settle paths refuse.
- **Fix.**
  - Anchor the label to the start of the body: drop `m`, and keep the leading whitespace, `#` heading, list-marker and bold allowance,
    so "Advisory, non-blocking:\n- a\n- b" and "**Nit:** …" alone still match.
  - Optionally, also accept a body whose every non-empty line is advisory-labelled.
  - Add the three bodies above, and the "critical … Nit:" one, as `severityHint` tests that expect P2 or P1 with `isTagged: false`.
  - Add a flow test: such a finding deferred as P3 with a `followUp` still holds the merge.

### Important (Should Fix)

**I1. The standing never says the live head is unreviewed, so `waive <id>` can tell the agent "ready" for a head no round has seen.**
`pr-lifecycle/hooks/lifecycle.ts` (`standingOf`) and `pr-lifecycle/hooks/register.tsx:405-418` (`waive <id>` → `tellAgent`). This is
the known pre-existing stale-`rec.head` issue; 1.4.0 makes it louder.

- **What's wrong.** `standingOf` reads findings and `decideNext` from `rec` alone. It adds `head-unreviewed` only when `decideNext` is
  `exhausted`, and never compares `at.head` with `rec.head`. `waive <id>` builds the standing from the live head (`openPrOf`).
- **The path.** Take a ready record at `d` with CI green, push `e`, then run `waive G2-1`:
  - the standing for `e` has no blockers, so `mayProceed` is true and `tellAgent` says "nothing holds the merge. It is ready for the
    merge decision";
  - `advance` sends `readyPrompt` naming `d` as ready, and the note merges into it;
  - the guard then refuses: `rec.head !== pr.headRefOid`, "pushed after the review completed".
- **Why it matters.** The gate is safe, but the agent tells the person "ready", the person tries the merge and gets a hold. That's the
  wasted turn and the contradictory message this wave exists to remove. `flow.test.ts:3741` admits in a comment that it doesn't observe
  the standing.
- **Fix.**
  - In `standingOf`, for a post phase that isn't waived, push a blocker when `at.head !== rec.head`: kind `head-unreviewed`, id `'head'`,
    said "`<e>` was pushed after the review completed at `<d>`", owner `gate`, release "/pr-gate resume reviews it".
  - In `judgeMerge`, add `'head'` to `named` when `missing` is the pushed-after case, so it isn't listed twice.
  - Make 3741 assert that nothing sent contains "ready for the merge decision". Better still, have `waive <id>` skip `advance`'s ready
    prompt when the live head differs from `rec.head`.

**I2. Spec/plan issue for Adam: R84 and R85 together let the agent alone settle a finding a reviewer called a blocker.**
`lifecycle.ts` (`applyAnswer` and `isSettledDeferral`). The code matches the spec. The spec gap: a GitHub comment whose severity was
only guessed can be lowered by the agent to anything. That includes a P1 guessed from "critical", "blocker" or "high". The agent can
then lower it to P3 and defer it with any `followUp` in the same answer, and it settles. No person and no Codex sees it. R84's recorded
cost is "an agent lowers a guessed P2 to P3"; the P1 guesses and the combination with R85 aren't covered.

Recommended ruling, either of:
- settle under R85 only when the severity was already P3 before this answer (no 'main' entry in the history lowered it);
- or send a guessed severity the agent lowered to Codex, as a rebuttal is.

Not a merge blocker if Adam accepts the cost on record, but it should be ruled on explicitly.

### Minor (Nice to Have)

- **M1. A waiver during `gatherStanding` is followed by a stale hold** (`round.ts`, the `advance` tail and `holdPost`).
  - The run is finished first. Then up to three gh calls run (30 s timeouts; the required set is cached after the first success), and
    only then is the report or hold sent, with no fresh check for a post waiver.
  - A `waive post` in that window is followed by a hold that contradicts it, which is the R80 promise. The window is seconds.
  - Fix: after `gatherStanding`, reload the record and skip the `say` if a post waiver now covers the head.
- **M2. `patch()` returns a stopped run, not null** (the deferred "audit patch()" item).
  - Callers' `if (after === null) return` doesn't catch a run stopped since. `afterRebuttalCheck` → `holdPost` could then write
    `postStatus: 'blocked'` and send `heldPrompt` after a waiver.
  - The window is only between `onAnswer`'s `getRun` and its `patch`, so it's practically tiny. Have `patch` return null when the run
    isn't running, or check `after.status`.
- **M3. Classic protection's 404 is read loosely** (`round.ts`, `requiredChecksOf`).
  - `isClassicNone` takes any "404" in stderr, not only "Branch not protected". A 404 from the classic endpoint for another reason
    would count as no classic protection.
  - The rules endpoint reads one page (30 rules by default) with no `--paginate`/`per_page`. A required-checks rule past the first page
    would be missed, and a check it requires could be set aside under a waiver. GitHub still enforces it, except for an admin bypass.
  - Use `?per_page=100` and match `/Branch not protected/`.
- **M4. To confirm, not asserted:** what does the rules endpoint return on a repo with no rulesets? If it 404s rather than `200 []`,
  `requiredChecksOf` is always 'unknown' there, and `waive post` can never set anything aside on such repos (safe, but R86 wouldn't apply).
  Try it once against a repo with no rulesets.
- **M5. Spec §3.5 says the agent can't raise an advisory label to blocking**, but `applyAnswer` lets the agent raise any 'tag' finding
  and refuses only lowering. The code goes the safer way: amend the spec wording, not the code.
- **M6. Old GitHub findings read as untagged** (1.3.0 compatibility). A 1.3.0 GitHub finding has no `severitySource`, so `mayAcknowledge`
  treats an explicitly tagged P0–P2 one as untagged, and it may be acknowledged. Codex still checks it. Acceptable, but worth a line in
  the R82 ruling.
- **M7. Spec §1 is narrowed without saying so.** The spec has `judgeCreate`, the pre-phase `heldPrompt` and the `allow`/`waive` replies
  render from `holdText`. The plan and the R79 ruling narrow this to "the guard's refusal and the post-PR prompts", and `allow`'s note
  carries no standing. The narrowing is recorded, but implicitly: add one clause to R79 saying the pre-PR texts are unchanged in 2a.
- **M8. A post waiver's base is never checked against the record's.** `advance`'s waiver check matches by head only. `standingOf`
  ignores the waiver's base for a post waiver and relies on `rec.base === at.base`. `gatherStanding` in that branch passes `rec.base`, so
  a retargeted PR is never flagged there. The guard still checks `isOnBase`, so this is only a misleading message.

## Deferred minors triage

| Item | Verdict |
| --- | --- |
| T1 beginTriage logs approvals before marking them processed (re-logs once after a crash) | Stay deferred: log noise only |
| T1 the R83 flow test depends on prompt wording | Stay deferred |
| T2 severitySource stays 'hint' after triage, so a later answer can move it again | **Fix with I2's ruling**: it widens I2 (lower again later). Once triaged, set it to 'tag' or freeze the severity |
| T2 no test that a hint finding keeps its severity when the answer has none | Stay deferred (code is obviously right: `a.severity === undefined ? f.severity`) |
| T3 the R82 flow test title claims the security case | Stay deferred; fix the title when convenient |
| T3 ineligible-acknowledged tests assert only the reprompt | Stay deferred |
| T3 positive acknowledged test doesn't assert replyId in rec.replies | Stay deferred |
| T3 the R34 reprompt prose still says "fix, rebut or defer" | Stay deferred (the trailer example lists acknowledged) |
| T4 followUp not shape-checked | **Fix before merge, together with C1**. Not alone a hole, but with C1 any text settles a real finding. A light check (URL, `#<n>`, or `owner/repo#n`) is cheap |
| T4 a stale followUp survives a later re-deferral without one | Should fix (one line: clear `followUp` when a deferral comes without it). Otherwise an old follow-up settles a later deferral the agent gave no follow-up for |
| T4 status puts the settled-deferral note before rec.message | Stay deferred (cosmetic) |
| T5 tests don't pin non-security holds under waiver + security P1, etc.; holdText '' when all named | Stay deferred |
| Ruling: no late-feedback Blocker kind | Accept: the guard's untriagedFeedback hold still blocks. Stay deferred to 2b |
| T6 required cache keyed slug:base, cleared only in setup; the 404 regex reads all of stderr | Stay deferred for the cache (GitHub enforces required checks). Tighten the regex (M3) |
| T7 standing read before the late-review check (extra gh calls); retargeted/round-owed may repeat 'missing' | Stay deferred |
| T7 unreadable reason in both said and detail | Stay deferred |
| T8 waiver message resent per session start | Stay deferred: one repeated, accurate message per session |
| T8 overlapping holdingPrompts share a batch; mergeNotes prepends to every prompt in a batch | Stay deferred |
| T8 audit patch()'s stopped-run return | Should fix (M2); small |
| T8 prHeadOf each pass with an unmatched waiver; prHeadOf not try-wrapped; a waiver matching rec.head while the PR head moved on | Stay deferred. Wrap prHeadOf in try/catch when convenient: a throw there fails `advance` |
| Known: advance's ready prompt after `waive <finding>` can name a stale rec.head | **Fix with I1**: same root, and 1.4.0's tellAgent now adds a second "ready" |
| T9 waive <finding> live-head test doesn't observe the head; reset-before-flush checks a marker; reset text hard-codes /pr-gate | Strengthen the first with I1; the rest stay deferred |
| T10 pane stop's runCommand rejection uncaught | Stay deferred (`void`, same as before); add `.catch` when convenient |
| T12 CHAINED mentions a PR body for merges; hasOtherSteps misses `&` and can false-positive on nested `$()` | Stay deferred: wording only, never affects allow/deny |

## Declined to judge

- **Whether R84/R85 should allow lowering a guessed severity at all.** It's a spec decision (Adam's I/J). I flagged only the gap (I2),
  not the decision.
- **The wave 2b items** (early triage, one round per push, the late-feedback blocker kind): the spec puts them out of scope.
- **Deduplicating findings** (`duplicateOf`): the spec lists it as "needed, not designed yet".
- **The wave 3 pane waive and merge links, and the pane origin's rights beyond stop**: out of scope.
- **codex-gate/**: frozen, and not in the range.
- **Whether GitHub's check-run `name` always equals a required-check context** (matrix or app-qualified names). It depends on GitHub's
  data. A mismatch fails open only under a waiver, and GitHub still enforces required checks.
- **Rewording of prompts the tests don't pin**: style, not behaviour.

## Recommendations

1. Fix C1: anchor `ADVISORY` and add the mixed-body tests. With it, add the light `followUp` shape check and clear a stale `followUp`.
2. Fix I1: add a `head-unreviewed` blocker when the live head ≠ `rec.head`, and assert 3741 sends no "ready".
3. Ask Adam to rule on I2, and record the ruling in R84/R85.
4. Make `patch()` return null for a run that isn't running (M2), and re-check the waiver after `gatherStanding` (M1). Both are small and
   close the last R80 windows.

## Assessment

**Ready to merge?** With fixes

**Reasoning:** The wave is well built and green, but C1 lets a real finding be tagged P3 because of one "Nit:" line, and then settled by
the agent's deferral with no person and no Codex, which is a merge-gate hole. Once C1 and I1 are fixed (both small, with tests), and I2 is
ruled on, it is ready to merge.
