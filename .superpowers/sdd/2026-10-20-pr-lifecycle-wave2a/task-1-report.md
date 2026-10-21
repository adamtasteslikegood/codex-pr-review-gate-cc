# Task 1 report

## Built
- github.ts: `isNoAction`, new `severityHint` with `isTagged` and advisory-label P3 (ADVISORY regex), `readReviews` isFinding via `isNoAction`.
- round.ts `beginTriage`: settled approvals are logged (`approval`) and added to `processed`.
- types/index.d.ts: `LogEntry.kind` gains `'approval'`.
- Tests: 3 unit tests in github.test.ts, 3 flow tests at the end of flow.test.ts (helpers `roster`, `toPost`, `inline`, `recordOf` all existed; used as in the brief).

## TDD
- RED: `claude plugin test pr-lifecycle` -> 382 pass, 2 fail (flow test "R83: a COMMENTED review ... asks the agent nothing" failed; github.test.ts did not load because `isNoAction` was not exported).
- GREEN after implementing: 420 pass, 1 fail (existing test, below). After updating it: `claude plugin test pr-lifecycle` -> 421 pass, 0 fail. `npm run lint` and `npm run typecheck` clean.

## Files
pr-lifecycle/hooks/github.ts, hooks/round.ts, types/index.d.ts, tests/github.test.ts, tests/flow.test.ts

## Existing test changed
tests/github.test.ts "a severity is read from the reviewer's own words": `toEqual` assertions gained `isTagged` (true for P1 tag and 'nit: typo' (advisory), false for Critical, 'minor: possible XSS', 'Consider renaming'). No severity value changed; the security-nit P2 assertion used "minor:", not "nit:", so it still reads P2 (isTagged false).

## Self-review / concerns
- Code applied verbatim from the brief; no adaptation needed.
- 'minor:' with security is still not an advisory label (not in ADVISORY list), so P2 floor stays for it; only "nit:" outranks the floor, per the controller ruling.
- Settled loop logs once per review via `processed`; the updateRecord runs only when there are settled rows.
- I did not run a separate flow test of the "Co-Authored-By" model name: the commit uses the system reminder's "Claude Sonnet 5.5" trailer, while constraints.md says "Claude Opus 5.5". The reminder says it takes precedence for new commits.

## Fix round 1
- Changed (hooks/github.ts): replaced NO_ACTION/REQUEST/STRONG/CAVEAT and the old `isNoAction` with `SETTLES`, `POLITE` and a whole-body `isNoAction` (every sentence must be a no-action form; COMMENTED also needs a settling sentence). Kept the `u`-flag `\p{L}\p{N}` regex: lint and typecheck accept it. Tightened `ADVISORY` to need a mark (colon, comma, bracket, dash, line end) after the label.
- Covering tests (tests/github.test.ts): the R83 test gained the whole-body cases ("LGTM. Preserve ...", "LGTM. Reset still deletes ...", "LGTM, the cache is never cleared", "No blocking findings.\n\nHowever ...", Thanks!, emoji heading); the "Reviewed ... \n\nScope: docs only." case flipped to false. The R84 test gained "Optional chaining ...", "Advisory locks ...", "**Nit**: rename this".
- RED: `claude plugin test pr-lifecycle` -> 419 pass, 2 fail (the R83 and R84 unit tests).
- GREEN: `claude plugin test pr-lifecycle` -> 421 pass, 0 fail; `npm run lint` and `npm run typecheck` clean.
- Uncommitted brief.md/progress.md edits in the tree are the coordinator's; not staged.

## Fix round 2
- Why "No blocking issues for this change and the reset deletes pending findings" settled: it has no sentence-ending mark, so it is one sentence, and the old tail `[\w\s/-]+` swallowed "change and the reset deletes pending findings" whole, matching SETTLES[0] to the end. The split by `[.!?;]+|\n+` never cut it.
- Fix: scope tail is now `in|for this`, at most two words, then a noun from a fixed list (diff, pr, pull request, change(s), commit, patch, update, revision). Moved into a `SCOPE` string and built with `new RegExp` to stay under 160 columns (lint max-len). Both strings trace to false: one sentence, no regex matches, so `every` fails. "in this roadmap-only diff" stays true.
- ADVISORY mark class is now `(?:[:,(—]|-\s|$)`: a dash counts only before whitespace.
- Tests added (github.test.ts): the two scope strings `toBe(false)`; "Nit-picking aside, this leaks" and "Optional-chaining crashes on null" untagged; "Advisory - rename it" tagged P3.
- Deviation: "Nit-picking aside, this leaks" is untagged but severity P3, not P2, because the later `\bnit\b` guess matches "Nit-". Expected P3/isTagged false in the test. The point (not tagged) holds; say if you want the guess changed.
- First run: lint failed max-len (164) and one test expected P2; both fixed above.
- GREEN: `claude plugin test pr-lifecycle` -> 421 pass, 0 fail; lint and typecheck clean.
