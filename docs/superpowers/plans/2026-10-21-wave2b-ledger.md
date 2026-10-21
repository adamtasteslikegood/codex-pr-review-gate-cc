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
Task 6: implemented c8f1412 + report 1e981a2 (BASE d3c4305), 544/544, DONE_WITH_CONCERNS (unbounded clean post rounds? — sent to reviewer as named risk); rejectedFix fixture set P2 (P1 default made it a round-2 blocker) → task review on opus dispatched
Task 6: review Spec ✅ Quality Approved. Minors deferred to final review: isCharged written on baseline/final-head/incomplete post records (doc says "drew on the allowance") — write only for discretionary or fix doc; both R88 flow tests check a baseline round (no flow test of a clean discretionary post round leaving remaining() unchanged); isRejected looks only at the entry just before Codex's reopen (no current path inserts between).
Ruling: advisory churn (P2/P3 raised on every head, agent fixes and pushes) is now never charged and has no gate bound — kept as spec §1.4 says (Adam-approved G); never waits forever so not "stuck", but unbounded paid Codex rounds. Raised to Adam for a ruling; candidate fixes: cap on free rounds, or charge a push that fixes findings raised in the previous round — cost if wrong: Codex spend on long advisory loops.
Task 6: complete (commits d3c4305..1e981a2, review clean)
Ruling: a link Codex refused (X→Y) is not accepted again from the agent (same canonical target = no answer, asked again under the reprompt bound) — free link checks must not loop (gate can't get stuck) — cost if wrong: an agent can't re-propose a link after fixing its reasoning; it answers the item on its own instead
Task 7: dispatched (BASE fd2ae67, opus) with A1-A3 binding; isFileable assertion deferred to Task 12
Ruling (Adam, 2026-10-21, option b): a post round is also charged when the agent pushed a fix for a finding raised in it (any severity); charged at most once; rebut/defer/acknowledge of non-blocking stays free. Spec §1.4 amended (A8). Build as Task 6b after Task 7 (Task 7 also edits isChargedRound). Record in Task 16 rulings.
Task 7: implemented 669fa51 + f022ed6 + report b9a8f5f (BASE fd2ae67), 555/555, DONE_WITH_CONCERNS (gate can follow an unchecked agent link → may settle with wrong original after refusal; refused link reopens a reported fix; moved aliases become agent links; refusedLink on history event) → task review on opus dispatched with 8 named risks
Task 7: review Spec ✅ (⚠️ §3.5 severity gap) Quality Changes needed: (I1) gate triage follows an unchecked agent link → new item linked to wrong original after refusal, drops P1/security hold; (I2) withLinkedPeak raises peak+security but not severity → link downgrades a P1/security hold (securityHolds, P3 issue deferral settles). Minors: rejections counts a refused link as rejected rebuttal; triagePrompt "earlier answer" misses same-batch original; no pointer reply enforced on unanswered gate-linked item.
Ruling (A9, spec §3.5/§3.7 amended): a link raises the original's severity too (higher of the two; lowered only via R85 Codex lowering; refused agent link leaves it raised); triage skips isLinkOwed candidates (new item stands alone) — fail closed — cost if wrong: extra holds/extra findings, never a dropped hold
Task 7: fix round 1 sent (I1, I2, Minor #3); Minors #4, #5 deferred to final review
Task 7: fix round 1 b641e4a + report 1c3cee2, 558/558 (I1 no match via owed link; I2 link raises severity, tag kept if dup tagged; Minor #3) → scoped re-review on opus
Task 7: re-review All addressed. New Minor (folded into Task 6b dispatch): the severity-raise event copies original.status, so on a rebutted original it reads as a new gate 'rebutted' entry → isAcceptedRebuttal false (fail-closed), rebuttedAt moves forward (R33: an earlier reviewer reply no longer answers it — hold-drop vector), isAcknowledged lost. Spec note for Task 16: a raise from a guessed dup onto a tagged/Codex original has no Codex lowering path (fix/rebuttal/waiver release it; fail-closed).
Task 7: complete (commits fd2ae67..1c3cee2, review clean)
Task 6b: A8 charging (push fixing a finding raised in the round) + Task 7 raise-event minor; dispatched opus
Task 6b: implemented 78e913a (A8) + b800f5b (A9 raise marked raisedBy, answersOf readers) + report 3094dac (BASE 8c71e69), 562/562; isCharged only on discretionary post rounds; Task 6 flow tests moved to discretionary round 4 (toDiscretionary helper). Concerns: late fixes / answer-run fixes never charged by A8 (bounded by unchanged-head block); Task 8 must keep stamping triage answers with the asking round.
Ruling: a link raising an accepted rebuttal/acknowledgement into P0/P1 or security sends it back to Codex for a free re-check (rebuttedAt kept); P3→P2 raise does not — never drop a hold — cost if wrong: one extra Codex check
Task 6b: ruling follow-up ef95ecd + report ec7926e, 562/562 (raise re-check via needsRecheck; pane mislabels as "file changed") → task review on opus dispatched (range 8c71e69..ec7926e)
Task 6b: review Spec ✅ Quality Changes needed (Important: raise re-check prompt mislabelled "file changed" and doesn't show Codex the raising link; Minors: pane label, R90 flow test trivially baseline, answersOf twice) → fix round 1 sent
Ruling: A8 broadened to Adam's words — a discretionary post round is charged when the agent reports a fix in it for ANY finding (raised then or earlier); linked dups excluded; once; answer runs free — cost if wrong: allowance spent faster on late blocker fixes
Ruling: a refused raise re-check is a full rejection (rejections+1, charged if discretionary) — it is a real Codex rejection at the new severity — cost if wrong: one round
Note: A8 does not verify a push happened ("fixed" answer + Codex holds still charged) — low impact, accepted
Task 6b: fix round 1 3bbdaa0 + report c77b336, 564/564 (raiseOf labels; A8 any fix in round; R90 flow test on discretionary) → scoped re-review on sonnet
Task 6b: re-review All addressed, no new breakage ("not on this run" fallback unreachable; label names only the raise if a file change lands after an un-ruled raise — wording only, deferred).
Task 6b: complete (commits 8c71e69..c77b336, review clean)
Ruling: A4's isSettling carries its set time; a flag older than the agent step timeout is stale, cleared with a log line, and the poll proceeds (cap still ends collection) — a crash mid-afterTriage must not freeze collection — cost if wrong: a very slow afterTriage could race one poll
Ruling: a mid-collection turn's step timeout returns to collecting or holds; never phase 'triage' with collect set and nothing in flight
Task 8: dispatched (BASE d6dacd9, opus) with rulings above, polls during a turn still persist headArrival
Task 8: implemented 374a840 + report e59c537 + dad1874 (BASE d6dacd9); controller full run 570/570. Concerns: mid-collect turn step timeout → error stop needing /pr-gate resume; isTurn = phase==='triage'; early return moved after noteArrival; endCollect counts handed feedback; generation check on every afterTriage.
Ruling: first step timeout of a mid-collection turn in a round → back to collecting, feedback asked again; second in the same round → stop as today — Adam: the gate automates babysitting; a resume is a manual step — cost if wrong: one wasted turn
Task 8: task review on opus dispatched (timeout ruling included as a required change)
Task 8: review Spec ❌ (timeout ruling) Quality Changes needed (I2 unguarded failPost after unpushedBy await; minors: stale threshold = step timeout too short, rec undefined leaves isSettling, shared r{n}-triage step id lets a late answer land on the re-ask) → fix round 1 sent (timeout→collect once; isOwn before failPost; stale max(step,5min); clear isSettling; ignore late answers). Minor 3 (stale check behind poll lock) left, bounded by gh/git timeouts.
Ruling (Task 16): isTurn = phase==='triage' (equivalent, fail-safe); endCollect counts handed feedback for hasFindings
Task 8: fix round 1 72ef884 + report 85a8464, 573/573 (timeout→collect once; answers match by turn id so late answer ignored; isOwn guards; stale max(step,5min); record-gone → guarded error) → scoped re-review on opus
Task 8: re-review — 5/5 addressed but NEW Important: requeue branch on pending.length>0 with patch needing answer===undefined → answered-but-unsettled turn hangs forever (stuck). Minors: re-ask reuses r{n}-triage marker (onTurnStart arms by marker); generation not checked inside updateRecord callback → fix round 2 sent
- Task 8 fix round 2: implementer reported BLOCKED (claude plugin test refused to start: hooks modules off). Controller ran the suite fine: 575/576, the one failure is the rewritten 'answered … afterTriage failed' test (went to done). Implementer resumed to fix that test and commit.
- Task 8 fix round 2 committed: b39f6e8 (code+tests), 7b54aeb (report). Controller-run suite 576/576, codex-gate 22/22, lint+typecheck clean (implementer's process can't run claude plugin test). Accepted: one-tick wait when the requeue misses. Scoped re-review (opus) dispatched on 85a8464..b39f6e8.
- Task 8 re-review (fix round 2): all findings addressed, no new breakage. Deferred minors for final review: afterTriage's first patch (round.ts ~2005) does not check status, so a stalled afterTriage resuming after a stop rewrites pending/findings/steps on an errored run (status stays error); the ticker's isSettling early return relies on poll clearing a stale flag; a new caller writing the r{n}-triage marker directly (not via stepOf) would reopen the late-start issue.
Task 8: complete (374a840, e59c537, dad1874, 72ef884, 85a8464, b39f6e8, report 7b54aeb)
Task 9: dispatched (BASE fb8911a, opus, implementer af5398fb613ff2f00). Told: adapt Step 3 to post-Task-8 pollOnce (noteArrival before rollover; closeCollect null → stand down), report NEEDS_TEST_RUN if the runner refuses.
Task 9: implemented 058efbd (BASE fb8911a), 579/579 + codex-gate 22/22, lint/typecheck clean. First attempt failed 7 tests (adopted PR, R1-10, 4×R80): a head differing at a round's FIRST poll was treated as a push.
Ruling: on a round's first poll (collect.polledAt === 0) a different PR head becomes the round's start head (1.4.0 behaviour); only later polls end the round — no head was read from the PR yet, so it is not a push during collection — cost if wrong: a push in the ~1 s before the first poll is reviewed in the round instead of rolling it over.
Ruling: a rolled-over baseline round records no isCharged (Task 6 writes it on discretionary rounds only; baseline never draws on the allowance) — brief test assertion changed — cost if wrong: none to the allowance.
Task 9 task review (opus) dispatched on fb8911a..058efbd.
- Task 9 review: Approved (spec ✅, first-poll deviation verified sound: polledAt 0 only in beginCollect, written before fetch each poll). Deferred minors for final review: (1) isFirstPoll counts a poll that threw before reading a head → an adopted PR can get one extra empty round (fix: flag set where the first-poll patch writes roundStartHead); (2) ticker race: a concurrent tick during rollOver/endCollect tail sees phase collect with no collect and can stop a healthy rollover as "collect step ran past" when waitCapMinutes ≥ stepTimeoutMinutes (pre-existing, shared with endCollect); (3) untested: rollover→checkRebuttals branch, next round's diffBase after rollover (R60), the rollover log line, the two-pushes test is nominally one push; (4) rollOver's tail has no generation check (relies on reset stopping before archive).
Task 9: complete (058efbd)
Task 10: dispatched (BASE 38c02a8, sonnet, implementer af110854db272ab14). Told: place re-request after Task 8's isOwn/isReset stand-downs; a failed gh re-request logs and carries on (gate can't get stuck).
Task 10: implemented f92e52b (BASE 4e15c32), 581/581, lint/typecheck clean, DONE_WITH_CONCERNS (headArrival.asked no longer written at the re-request → #24 may ask the same reviewer again). Task review (sonnet) dispatched.
- Task 10 review: Approved. headArrival.asked claim verified (missing mark → only a duplicate POST + log line; never counted coverage, no cap wait). Fix round 1 sent: move re-request below afterTriage's tail ended/generation guard (a stopped/reset run must send none) + test; test that a first post round's pushing turn re-requests. Deferred minor: no test for a reviewer-less roster.
- Task 10 fix round 1: 0fe8857, 583/583, lint/typecheck clean (request below tail guard + per-POST run/generation re-check; tests for reset at roster read and first-round re-request). Scoped re-review (sonnet) dispatched.
- Task 10 re-review: all findings addressed, no new breakage. Deferred nit: no test for a reset between isOwn() and the tail guard (tail guard's checks unchanged).
Task 10: complete (f92e52b, 0fe8857)
Task 11: dispatched (BASE 6fc860c, opus, implementer a26b1daa749137795). Told: reconcile lastDeferral/deferralRuling with 6b answersOf; check 6b needsRecheck for an agreed deferral raised by a link (report, don't build new); linked duplicates follow the rebuttal pattern; a deferral owed Codex must always reach a check.
Task 11: implemented (uncommitted at NEEDS_TEST_RUN; controller ran suite 586/586, codex-gate 22/22). Accepted: charge tests on discretionary round 4 (baseline has no isCharged); brief code merged with Tasks 6-7 (recheck keeps link/ack handling, deferralRuling via answersOf, links count as rebuttals in verifyPrompt); linked items follow the rebuttal pattern.
Ruling: a link that raises a Codex-agreed deferral into P0/P1 or security sets needsRecheck (as 6b does for an accepted rebuttal); a refusal reopens it and charges the round — Codex's agreement was given at the lower severity, and Adam's rule is every finding goes through Codex before it waits on him or is filed — cost if wrong: one extra free Codex check per such raise.
Deferred minors for final review (Task 11): pre-PR standingOf shows deferral-unchecked owned by codex on a pre record with a post waiver (no test); "fix or rebut" for a refused deferral whose rebuttal was rejected earlier (rebutting again becomes a dispute, R40); pane shows an owed deferral as "— deferred".
