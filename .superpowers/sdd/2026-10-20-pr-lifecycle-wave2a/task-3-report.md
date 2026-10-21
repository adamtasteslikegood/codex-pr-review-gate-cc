# Task 3 report

## Built
- round.ts: carried filter now `one.round !== run.round` (finding 21). afterTriage filters `acknowledged` answers before applyAnswer: kept only with a replyId on a finding passing `mayAcknowledge`; note prefixed "No change requested:". Reprompt trailer example lists `acknowledged`.
- lifecycle.ts: `mayAcknowledge` (RANK moved above it).
- core.ts: `readTriage` accepts `acknowledged`; `readDispositions` drops it; triage prompt step 2 and trailer example updated. Pre-PR prompts untouched.

## Dropped answers reach the R34 reprompt (confirmed)
`unanswered` in afterTriage tests `!said.some(...)`; `said` is the filtered list, so a dropped acknowledgement is unanswered. The "no reply" test passes via that path.

## TDD
- RED: `claude plugin test pr-lifecycle` -> 3 flow tests failed (finding 21, R82 settle, R82 reject) plus lifecycle.test.ts "the file did not load" (mayAcknowledge missing).
- GREEN: same command -> 430 pass, 0 fail. `npm run lint` and `npm run typecheck` clean.
- toTriage puts bodies in as inline comments, so Task 1 does not settle them (tests confirm: phase reaches verify).

## Files
pr-lifecycle/hooks/{core,lifecycle,round}.ts, pr-lifecycle/tests/{flow,lifecycle}.test.ts

## Existing tests changed
None. The brief's second R82 test was split into two tests (one world each), as the brief allowed. The tagged-P2/replied case is covered by `mayAcknowledge` unit test and the first split test only loosely (its body "P2: ..." is hint-parsed); not separately proven that it was dropped by mayAcknowledge rather than something else.

## verifyPrompt
Already shows the note: listFindings prints `status: note` for rebutted findings, so Codex sees "No change requested: ...". No change needed.

## Concerns
- The reprompt text still says "fix it, rebut it, or defer it" in prose; only the trailer example gained `acknowledged`.
- Commit trailer used the system-reminder model line (Claude Sonnet 5.5), which differs from constraints.md (Opus 5.5).
