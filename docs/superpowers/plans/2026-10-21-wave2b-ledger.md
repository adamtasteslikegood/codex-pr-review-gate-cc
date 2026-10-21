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
Task 2: implemented 0d2588c (BASE 0a320ae), 506/506
Task 2: review Approved (minors: history copy on no-op answer; no mixed ack+rebuttal recheck test; async w/o await). Scope ⚠️: pane/rejection text still say "rebuttal" for acks.
Ruling: spec §7.2 "texts say acknowledgement" covers the pane and agent-facing rejection text — fix round 1 on Task 2; Codex verify prompt left as is — cost if wrong: a few strings.
Ruling: PR #25 Codex review (7 findings) folded into the plan as amendments A1-A7 (docs a47400f): Task 4 4a (A5 headArrival, replaces commit/check times), Task 7 5a (A1-A3), Task 8 3a (A4 isSettling), Task 12 9a (A7 label verify), Task 15 6a (A6 generation guard + A7 refile). Task 4 now opus (prose). Merge docs/wave2b into build branch before Task 3's brief.
Task 2: fix round 1 4967be1 (pane + rejection text say acknowledgement), re-reviewed by controller (small diff): clean. Minor deferred: rejection wording untested.
Task 2: complete (commits 0a320ae..4967be1, review clean)
Task 3: implemented a575cdf (BASE 63ac5a9), 507/507
Task 3: review Changes needed (Important: archive seed dropped ownReplies) → fix round 1 d5b8dfe (seed + fresh-start carry in register.tsx, afterFix order, tests), controller re-review clean, 509/509
Task 3: complete (commits 63ac5a9..d5b8dfe, review clean)
Ruling: A5 amended again (39b06cb, 7a04661): push time = latest activity-log push into the head; ambiguous comment → re-request or count, never a cap wait (Adam: gate can't get stuck).
Task 4: implemented 67899a6 (BASE 5457a09), 523/523, DONE_WITH_CONCERNS (no lower bound when activity+commit-date both fail; fork lookups in beginCollect/onOpened use base repo; 100-entry page; headArrival.asked/counted extra fields)
Task 4: review Needs fixes (Important: no lower bound when both lookups fail → false coverage from round 2; owner/name/fork path untested) → fix round 1 sent with minors 1-6
Ruling: A5's plan rulings (activity-log push time; first-seen fallback; re-request or count, never a cap wait; latest/newest push re-reads) are recorded in Task 16's rulings text with R88-R94 — no task owned them — cost if wrong: a missing doc line
Task 4: fix round 1 9a8cac5, re-review Approved, 527/527. Minors deferred to final review: toMatchObject weakens #24 (7)/(12) asserts; beginCollect records asks but doesn't read them; noteArrival same-head concurrent overwrite (narrow)
Task 4: complete (commits 5457a09..9a8cac5, review clean)
Task 5: implemented c4938b2 + report 8f49684 (BASE 3ec5fd8), 534/534; adaptations: roster coverage answers a request; 5 tests count POSTs via w.gh.requests; R79 test sets required=[]
Task 5: review Changes needed (Important: no-roster coverage answering a request; failed requested_reviewers read stops round) → fix round 1 sent, plus inline comments use original_commit_id (pre-existing false coverage)
Ruling: team review requests ignored (cannot match a login; only ends collection sooner) — record in Task 16 rulings — cost if wrong: a CODEOWNERS team's review not waited on
Ruling: a required context posted as a commit status (not a check run) is not seen; costs a cap wait; note in Task 16 rulings / follow-up
Ruling (revised): commit statuses ARE read for required contexts (sent into Task 5 fix round 1) — a cap wait every round violates 'gate can't get stuck'
Task 5: fix round 1 0283ef8, 541/541 (roster-only request coverage; failed requested read → [] + log; original_commit_id; isAnswered/unknown-checks flow tests; commit statuses read for required contexts) → scoped re-review on opus dispatched. Concern: a status left pending forever holds collection to the cap when required checks are unreadable (same as a stuck check run; cap is the backstop)
Task 5: re-review All addressed. Minors deferred to final review: "could not read requested reviewers/commit statuses" logged every poll while broken (log flood; requested line uses kind 'head') — log once per head; no test for a context both as running check run and final status. Rulings note (Task 16): inline thread replies carry original_commit_id, so an old-thread reply no longer covers a new head.
Task 5: complete (commits 3ec5fd8..0283ef8, review clean)
Task 6: dispatched (BASE d3c4305, sonnet) — R88 charging; acknowledgement stored as rebutted so REJECTABLE covers it
