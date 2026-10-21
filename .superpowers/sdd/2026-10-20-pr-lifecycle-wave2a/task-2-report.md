# Task 2 report: a triaged severity replaces a guessed one (R84)

## Built
- types/index.d.ts: `Finding.severitySource?: 'tag' | 'hint'` (after isSecurity), `FindingEvent.severity?: Severity`.
- hooks/lifecycle.ts: `Answer.action` gains `'acknowledged'` (stored as `'rebutted'`); `applyAnswer` lets a guessed ('hint') severity take the triaged one up or down, writes the change into the last history event, and keeps the old rule (only raise) for tagged/Codex findings. Used the non-`!` `history.map` form from the brief.
- hooks/round.ts beginTriage: `severitySource: hint.isTagged ? 'tag' : 'hint'`.

## TDD
- RED: `claude plugin test pr-lifecycle` -> 422 pass, 2 fail (the lifecycle "replaces a guessed one" test and the flow "shows as P3 in the hold" test). The "never lowered" test passed already, as expected (it pins existing behaviour).
- GREEN: same command -> 424 pass, 0 fail. `npm run lint` and `npm run typecheck` clean.

## Files
pr-lifecycle/types/index.d.ts, hooks/lifecycle.ts, hooks/round.ts, tests/lifecycle.test.ts, tests/flow.test.ts.

## Existing tests changed
None.

## Self-review / concerns
- No adaptations were needed; the brief's code compiled and the flow helpers matched.
- Codex findings (severitySource undefined) behave as 'tag'.
- Task 4 can add a `followUp` spread to the applyAnswer return object.
