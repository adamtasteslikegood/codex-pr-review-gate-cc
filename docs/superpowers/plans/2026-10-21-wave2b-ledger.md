# SDD ledger — plan: docs/superpowers/plans/2026-10-21-pr-lifecycle-wave2b.md

Spec: docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md (with M2, M3 amendments).
Worktree: /home/allisone/Projects/pr-gate-wave2b, branch wave2b/pr-lifecycle-1.5.0, from docs/wave2b f9f772c.
Baseline: npm run check green at f9f772c (2026-10-21).
Copy of the ledger is committed to docs/superpowers/plans/2026-10-21-wave2b-ledger.md on each task completion (Adam: commit progress as you go).

## Pre-flight scan

| Pair / task | Produces → consumes | Found |
| --- | --- | --- |
| 1 → (none) | severityHint tag forms | self-consistent |
| 2 → 16 | FindingEvent.answer, isAcknowledged | ok |
| 3 → 16 | ownReplies, replyIdsOf | ok |
| 4 → 5 | Check.startedAt, Fetched.headAt → collectionDone | ok, both edit fetchFeedback (sequential) |
| 5 → 8 | collectionDone(signals) → pollOnce | ok |
| 6 → 7 | isChargedRound → "linked duplicate is not new" | ok |
| 6 → 12 | RoundRecord.isCharged → lateBlockers | ok |
| 7 → 12 | isLinked, alsoOf, linkTo → isFileable, issueBody, Review Focus 5 test | ok |
| 8 → 9 → 10 | closeCollect, Run.handed, Run.polled; push ends round at turn end | ok; Task 10 relies on Task 8's no-requestedHead ruling |
| 11 → 12 | isDeferralOwed/Agreed, ruleDeferral, agreedBy; Task 12 edits Task 11 tests (wouldSettle → isSettledByIssue) | ok, by design |
| 12 → 13 | readyPrompt summary + scopeNote → Task 13 ends sentence | ok |
| 12 → 15 | issueTitle/Body, filingPeak, issueNumberOf, world filed/issueAnswer → post-merge check | ok |
| 13 → 15 | Task 13 flow test merges; Task 15 makes the Bash fake merge (archives) | Task 15 Step 1 tells implementer to adjust merging tests |
| 16 | docs after all | Task numbering 15→16 renumbered in plan; ok |
| Each task self-consistency | tests vs code in each task | checked while writing; Task 12 edited for M3 (filingPeak) consistently |

Rulings before execution:
- Ruling: lost-severity findings filed as P1 and not held (Adam 2026-10-21) — supersedes Task 12's earlier text; plan edited — cost if wrong: an issue at P1 for a minor finding.
- Ruling: file-at-once request answered by fix-first + post-merge check (spec §5.11) — Adam's "better way" leave — cost if wrong: Adam asks for immediate filing; Task 12/15 extend.

## Progress
Task 1: implemented 3a02a2b (sonnet), 505/505; review dispatched. Note: test file filter is ignored, every run is the full suite (~107 s).
Task 1: minor (deferred): TAG misses "P2 —" (em dash), "Severity: P1", "Priority: P0" forms (plan-mandated list; follow-up if seen live)
Task 1: minor (deferred): R94 test loop has no per-body label; no P0 / lowercase / full Codex badge-body case
Task 1: minor (deferred): \bP([0-3])\b duplicated across TAG and mention paths; case differs
Task 1: complete (commits f9f772c..3a02a2b, review clean)
