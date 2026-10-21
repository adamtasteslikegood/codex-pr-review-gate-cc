# Wave 2b, Task 14: flaky flow tests (spec §7.3)

On PR #20 some flow tests failed at the kit's 5000 ms test limit when the machine was loaded, and passed on a second run. This file records
which tests, why, and what was done.

## Method

- Eight busy loops (`while :; do :; done`) ran beside `claude plugin test pr-lifecycle`, seven times (run 8 was cut short, see Step 4). The load average was 15-17 in runs 4-7.
  Runs 1-3 are **contaminated**: another agent was editing tests while they ran, so they show the same timeouts but also one unrelated
  assertion failure (R81 in run 2, `waive post tells the agent what it covers`, which is a half-edited test and not a timeout). Runs 4-6
  ran on a clean tree.
- `idle-1.txt` is one run at low load: 606 of 606 tests pass, and its per-test times are the "idle" column below.
- Outputs are kept in `.superpowers/flaky/` (run-1..8, idle-1, and post-fix: the normal-load suite after the bounds, 606/606).

## Cause: load, for every failure

- Every failure is `Error: timed out after 5000 ms`, the kit's own per-test limit.
- No run lists a skipped hook (the kit's 1.5 s bound for `session.end` and the like never fired). No hook does too much in one call, so no
  hook was changed.
- Every failing test passes at low load in 0.9-3.0 s. Nothing in `pr-lifecycle/hooks/` or `pr-lifecycle/tests/` waits on a real timer: the
  world fakes the clock and every process. The cost is the engine's own CPU work, which grows with the load. Nothing here depends on the
  order of tests.

## Ruling

Every test that timed out in any run, and every test at 1300 ms or more at low load, gets `{ timeoutMs: 15_000 }` and the comment
`// Machine load: <N> engine steps, no real wait (spec §7.3).` The limit stays at 5000 ms for the rest of the suite. R71 (fast-forward) failed
once and took 0.9 s idle, so it is bounded too, though it is below the 1300 ms line.

Step count = the test body's `clock.advance(`, `done(` and `say(` calls, plus one for each helper call (`toPost`, `toTriage`, `adoptAt`,
`toMidTurn`). A call in a loop is counted once. `$.tool.call`, `turn(...)` and `world(...)` are not counted: they are setup or inputs to `done(...)`.

## Findings

Runs 1-3 were contaminated (see above). "Kit's reason" is the same for every row: `timed out after 5000 ms`. Skipped hook: none for every row.

| Test | File | Failed in runs | Steps | Idle (ms) | Cause |
| --- | --- | --- | --- | --- | --- |
| a roster on the base is used: collection waits on its reviewer, whose comment is trusted | settings.test.ts | 1, 3, 4, 5, 6 | 3 (2 advance, toPost) | 2957 | load |
| #11: the post-PR Codex fallback re-review runs at rereviewEffort | models.test.ts | 2, 3, 4, 6 | 2 (1 advance, 1 done) | 2732 | load |
| R66: a reply reported as the URL gh prints does not come back as feedback in the next round | flow.test.ts | 1, 4, 5, 6 | 5 (2 advance, 2 done, toPost) | 2216 | load |
| R88: a settling flag older than the step timeout (at least five minutes) is cleared and collection goes on | flow.test.ts | none (bounded by idle time) | 5 (3 advance, 1 done, toMidTurn) | 2118 | load |
| R88: a turn that pushes re-requests the roster reviewers once; another's push and a new round request nothing | flow.test.ts | 2, 4, 6 | 7 (4 advance, 2 done, toPost; advance in a loop counted once) | 1951 | load |
| R45: a deferral a later Codex review calls verified stays deferred, and the merge stays held | flow.test.ts | 5 | 5 (1 advance, 3 done, toTriage) | 1811 | load |
| R40: a security dispute a later Codex review rules on stays the person's | flow.test.ts | 4 | 7 (2 advance, 4 done, toTriage) | 1758 | load |
| R60: the post-PR Codex fallback reviews from the last head a review covered, not one pushed during triage | flow.test.ts | 4, 5, 6 | 4 (1 advance, 2 done, toTriage) | 1712 | load |
| R64: the person's own top-level comment reaches triage; the mod's recorded reply and inline replies do not | flow.test.ts | none (bounded by idle time) | 2 (1 advance, toPost) | 1645 | load |
| a roster reviewer who never posted is recorded as missing evidence | flow.test.ts | 4 | 2 (1 advance, toPost) | 1598 | load |
| a pass-through round whose only feedback is a human comment sends it to triage, not to an error | flow.test.ts | none (bounded by idle time) | 1 (1 advance) | 1592 | load |
| at the wait cap with nobody covering the head, fresh findings still go to triage | flow.test.ts | none (bounded by idle time) | 1 (1 advance) | 1518 | load |
| a PR to a gated base is held and starts the gate; a clean review opens it | gate.test.ts | none (bounded by idle time) | 1 (1 done) | 1464 | load |
| R76: on a pass-through PR, a resume triages a trusted reviewer's late P1 too, at no round | flow.test.ts | none (bounded by idle time) | 7 (4 advance, 2 done, 1 say) | 1457 | load |
| #24 (14): round 2, no push time and no commit date: a roster comment from round 1 does not count for the new head, and the cap still ends collection | flow.test.ts | 4 | 5 (4 advance, toPost) | 1416 | load |
| when no reviewer covers the head by the wait cap, Codex reviews the delta | flow.test.ts | 4 | 2 (1 advance, toPost) | 1369 | load |
| #24 (16): the wait cap ends collection on the "moved" path while the newest push stays on another sha | flow.test.ts | 3 | 3 (2 advance, adoptAt) | 1312 | load |
| R71: a clean checkout behind the PR head fast-forwards, and the Codex fallback reviews the new head | flow.test.ts | 1 | 2 (1 advance, toPost) | 900 | load |
| R39, R92: a pre-PR deferred advisory carried into the PR holds the merge until its issue is filed | flow.test.ts | 7 (the Step 4 check) | 4 (1 advance, 3 done) | 1076 | load |

The step counts are low because the heavy work is inside each `done(...)`, `toPost` and `toTriage`: one step runs a whole hook turn through
the engine, with its gh and git fakes. The count is a size hint, not a time model.

## Step 4: check under load again

Run 7 (bounded tests, 8 busy loops): 605 pass, 1 fail. The failure was a test not yet bounded, "R39, R92: a pre-PR deferred advisory
carried into the PR holds the merge until its issue is filed" (timed out after 5000 ms, no skipped hook, 1076 ms in the timing run), so
it was bounded too (the row above). None of the 18 bounded tests failed.

Runs 8 and 9 did not complete: Claude Code stopped the load check because the machine was critically low on memory (other processes,
not the suite). The three-run check is still owed, and should be repeated when memory allows.

The R39 test shows that the 1.3 s cut-off is not a hard line: the slow tail of the suite reaches below it. If another test times out
under load, it gets the same bound with its own comment; the suite-wide limit stays 5000 ms (brief ruling).
