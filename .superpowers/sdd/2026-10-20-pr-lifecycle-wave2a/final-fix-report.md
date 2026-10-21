# Final-review fix round: report (wave 2a, pr-lifecycle 1.4.0)

Status: DONE_WITH_CONCERNS (concerns are residuals and judgement calls, listed at the end; nothing is left unfixed).

Commits (on wave2a/pr-lifecycle-1.4.0, not pushed):

- bcf5e59 anchor the advisory label; R85 follow-up shape, stale follow-up, never-lowered (C1, T4, I2)
- 222b170 the standing holds a head pushed after the review; waive <id> sends no stale ready (I1)
- 5ee6227 patch returns null for a stopped run, no hold after a waiver given mid-gather, stricter required-checks reads, prHeadOf never throws (M1-M3, T8)
- 35660e8 docs: R79, R82, R84, R85, spec §3.5/§4/§6, LIFECYCLE_SPEC, CLAUDE.md count

Tests: `npm run check` is green: lint, test (pr-lifecycle 482 pass, 0 fail, up from 472; codex-gate 22), validate, typecheck.
Every new test was run and seen failing before its fix, except the M3 case, which was written in the same edit as the fix (with the old
`\b404\b` regex, `['ok', 404]` gives `['check']`, not 'unknown', and the old unpaginated path doesn't match the tightened fake).

## What changed, by item

1. **C1** (`hooks/github.ts` `ADVISORY`): the `m` flag is gone, so the label counts only at the start of the body (leading whitespace, `#`
   heading, list marker, bold/brackets still allowed). `\n` was added as a terminator so "Nit\n- rename x" still tags. The brief's
   "every non-empty line is advisory-labelled" rule is implied by the start rule (if every line is labelled, the first is), so no
   separate code; a test pins a two-labelled-line body. Tests: the report's three mixed bodies and "critical … Nit:" (P1, untagged)
   are untagged; "Advisory, non-blocking:\n- a\n- b", "**Nit:** x" still P3 tagged. Flow test: the "**Optional:**" mixed body
   deferred as P3 with a URL follow-up stays awaiting-decision.
2. **followUp shape** (`lifecycle.ts` `isFollowUpRef`, used by `isSettledDeferral`): `https://\S+`, `#\d+` or `owner/repo#\d+`, trimmed.
   Anything else keeps the deferral (status `deferred`), which then holds as before R85.
3. **Stale followUp** (`applyAnswer`): a `deferred` answer always sets `followUp` to the answer's (undefined clears it).
4. **I2** (`isSettledDeferral` + `wasLowered`): settles only if no history event carries a `severity`. Only `applyAnswer` writes one,
   and only when the severity changed, so a finding that is P3 now with any such event was lowered to P3 at some point (P3 is the
   floor). Covers the same-answer case, a later answer, and raise-then-lower (T2). Tests: guessed P1 lowered + deferred + valid
   follow-up holds (unit and flow); reviewer-tagged P3 settles; a P3 guess the agent kept settles. The two existing R85 flow tests
   that lowered a P2 guess ("Consider renaming this") now use a tagged "nit: rename this" body. The triage prompt
   (`core.ts`) now says the no-waiver P3 must be one whose severity the agent did not lower, with a follow-up of that shape.
5. **I1**:
   - `standingOf`: in a post phase, when `decideNext` is neither `round` nor `exhausted`, no post waiver matches `at.head`, and
     `at.head !== rec.head`, it pushes `{ kind: 'head-unreviewed', id: 'head', said: '<at 7> was pushed after the review completed at
     <rec 7>', owner: 'gate', release: '/pr-gate resume reviews it' }`.
   - `judgeMerge`: 'head' joins `named` in the ready + pushed-after case, so the reason is given once (test at the existing
     "later push holds it again" flow test).
   - `waive <id>`: reads the live head (`openPrOf`) before `advance`; in a post phase with a different live head it skips `advance`,
     so no `readyPrompt` for the stale head. `tellAgent`'s standing now carries the head blocker, so it says no "ready". The
     flow test (was ~3741) asserts nothing sent contains "ready for the merge decision" and that the note names the push and
     "/pr-gate resume reviews it".
6. **M2** (`patch`): returns null unless it patched the running run it names; the atom keeps the other run unchanged. All callers
   already guard `=== null`; the two `?? run` fallbacks (afterRebuttalCheck, the review's ranModels) behave as before. Unit test in
   `round.test.ts` with an in-memory state engine.
7. **M1** (`advance` post tail, `holdPost`): after `gatherStanding`, `isPostWaived` reloads the record and skips the `say` when a post
   waiver for the record's head now stands (and no security hold). Flow test: a waiver issued from the `gh pr checks` fake
   (`w.gh.onChecks`) during the triage-ending gather sends no "stopped short of ready" report.
8. **M3** (`requiredChecksOf`): `rules/branches/<base>?per_page=100`; classic none only on `/Branch not protected/i`. The world fake
   now matches the rules path only with `?per_page=100`; R86 case table gains `['ok', 404, 'unknown']`.
9. **prHeadOf**: the spawn is inside the try, so a throw gives undefined (the record's head decides, no early return). Flow test with
   `w.gh.isHeadReadBroken` on a resume after a waiver for an unrecorded head.

Docs: R79 (M7 clause + I1 blocker), R82 (M6 clause), R84 (start-of-body label; a lowered guess no longer settles), R85 (shape rule,
never-lowered, stale clear, cost if wrong); spec §3.5 (start-of-body; agent may raise, never lower a tag, M5), §4 conditions, §6 table;
LIFECYCLE_SPEC R85 line; CLAUDE.md count 472 → 482 (it appears once in Checks, not twice).

## Concerns

- **I1 narrowed slightly from the brief.** The pushed-after blocker is not added when `decideNext` is `round` (round-owed already holds
  and names the live head) or `exhausted` (its own 'head' blocker, with the person's release, already holds). Adding it there would
  give two 'head' ids, and `namedIn` would hide both behind the exhausted reason, or give a contradictory release. Every such case
  still holds (`mayProceed` false). Its wording ("after the review completed") is also used in a non-ready post phase, where the
  review isn't strictly complete; only reachable when the record's head lags the PR.
- **waive <id> after a push skips `advance`.** The record keeps its pre-waive status (e.g. awaiting-decision) until `/pr-gate resume`;
  the note tells the agent so. Safe (holding), but the waived finding's "ready" is only reached on resume.
- **Residual of C1/I2 (controller's call):** a mixed body whose *guess* is already P3 (it contains "nit", "typo" or "minor" anywhere,
  e.g. the report's first and third bodies, which guess P3 untagged) can still settle by an R85 deferral with a valid follow-up, since
  the agent never lowered it. The keyword guess, not the label, is now the weak point.
- **I2 for 1.3.0 records:** history events from 1.3.0 never carry `severity`, so a lowering made under 1.3.0 is invisible. 1.3.0 GitHub
  findings have no `severitySource` and can't be lowered under 1.4.0 at all, so only pre-1.4.0 lowerings slip through.
- M4 (rules endpoint on a repo with no rulesets) was not checked live, as before.
