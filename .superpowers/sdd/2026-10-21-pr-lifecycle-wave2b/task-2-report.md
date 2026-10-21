# Task 2 report: acknowledgements named as such (R94)

Changed: types/index.d.ts (FindingEvent.answer + doc line), hooks/lifecycle.ts (applyAnswer stamps answer on the last history event; new isAcknowledged; blockerOf text; decidePost recheck splits rebuttals/acks and picks `what`), tests/lifecycle.test.ts (new R94 test, import isAcknowledged).
Tests: 506 pass, 0 fail (was 505). Lint clean (one 191-col doc comment line wrapped after first run). Typecheck 0 errors.
Deviations: none; the doc comment of FindingEvent was re-wrapped to stay under 160 columns.
