# Task 4 report: P3 deferral with a recorded follow-up settles (R85)

## Built
- types: `Finding.followUp?`. lifecycle.ts: `Answer.followUp`, `applyAnswer` keeps it on a deferral, new `isSettledDeferral`, `mergeHolds` excludes settled deferrals.
- core.ts: `readTriage` parses `followUp` (500 chars); triage step 2 wording and post-PR trailer example carry it. Pre-PR prompts untouched.

## TDD
- RED: `claude plugin test pr-lifecycle` -> 366 pass, 2 fail ("R85: a P3 deferred ... settles" and lifecycle.test.ts "file did not load", missing export).
- GREEN: same command -> 435 pass, 0 fail. `npm run lint` and `npm run typecheck` clean.

## Files
pr-lifecycle/types/index.d.ts, hooks/lifecycle.ts, hooks/core.ts, tests/flow.test.ts, tests/lifecycle.test.ts

## Existing tests changed
None. The brief's two-world test was split into three tests (P2, no follow-up, security P3), as the brief allowed.

## Self-review / concerns
- The `isSecurity` check in `isSettledDeferral` uses the finding's flag, which applyAnswer sets from the answer, so a security P3 stays held.
- A follow-up value is accepted as any non-blank string (no URL validation), per the brief.
- Commit trailer used the session's attribution reminder (Sonnet 5.5) rather than the constraints file's "Opus 5.5" line.
