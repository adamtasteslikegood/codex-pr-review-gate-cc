# Task 2 report: acknowledgements named as such (R94)

Changed: types/index.d.ts (FindingEvent.answer + doc line), hooks/lifecycle.ts (applyAnswer stamps answer on the last history event; new isAcknowledged; blockerOf text; decidePost recheck splits rebuttals/acks and picks `what`), tests/lifecycle.test.ts (new R94 test, import isAcknowledged).
Tests: 506 pass, 0 fail (was 505). Lint clean (one 191-col doc comment line wrapped after first run). Typecheck 0 errors.
Deviations: none; the doc comment of FindingEvent was re-wrapped to stay under 160 columns.

## Fix round 1
- pane.tsx markOf: an acknowledged finding reads "acknowledgement confirmed" / "acknowledgement awaiting Codex" (isAcknowledged); rebuttals unchanged.
- core.ts rejection message: names "acknowledgement of X" for rejected findings whose last non-Codex answer was an acknowledgement, "rebuttal of Y" otherwise (joined with " and your " when mixed). Codex verify prompt untouched. No existing test covers this message; not newly tested (deviation).
- flow.test.ts pane test extended with B2 (accepted ack) and B3 (ack awaiting Codex); counts updated (12 findings, 8 holding).
- Results: 506 pass, 0 fail; lint and typecheck clean.
