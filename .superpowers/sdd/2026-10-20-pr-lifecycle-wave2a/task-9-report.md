# Task 9 report (R81: every manual action tells the agent)

## Implemented
- round.ts: `tellAgent` (queues a note; a blank hold section is skipped when `holdText` returns '').
- register.tsx: `isPerson`; `logCommand` uses it; notes for stop, reset, allow, waive finding, waive pre, waive post. Stop/reset call `dropQueued`. Stop claims the record first for a person. Agent (sdk) stop sends nothing; refused actions return before any note.
- `runCommand` already runs inside `holdingPrompts` (command.run handler), so notes batch and merge.

## TDD
RED: 8 of 9 new tests failed before implementation (the one-message count test passed trivially). GREEN: full suite 466 pass, 0 fail; lint and typecheck clean.

## Files
pr-lifecycle/hooks/round.ts, pr-lifecycle/hooks/register.tsx, pr-lifecycle/tests/flow.test.ts

## Adaptations
- Stop test asserts lowercase "stop waiting on it" (the text follows "Your next step:").
- waive finding: `scope` is the finding id; its test checks the prefix only.
- `dropQueued(run)` in stop uses the Run as RecordKey.

## Waive-post overlap
`waive post` never calls `advance`, so advance's "post waiver covers" prompt is not sent by the command: only the tellAgent note goes out. Pinned by a test counting prompts (+1). No change to advance needed; Task 8 R80 tests pass.

## Existing tests changed
"R80: a waive post given while a round is finishing..." asserted no prompt contained "ready for the merge decision"; the waive's own R81 note now says that. Now it excludes the note and asserts exactly one note was sent.

## Concerns
- The waive-post note's "nothing else holds the merge" wording is used when standing is undefined (no PR found) too, as the brief specifies.
- `waive <finding>` with the PR phase relies on rec.head as the PR head for standing (per brief).
