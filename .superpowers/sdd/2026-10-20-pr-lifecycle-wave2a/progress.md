# SDD ledger — plan: docs/superpowers/plans/2026-10-20-pr-lifecycle-wave2a.md
Spec: docs/superpowers/specs/2026-10-20-pr-lifecycle-wave2a-design.md
Branch: wave2a/pr-lifecycle-1.4.0, from docs/wave2 at 095f040 (MERGE_BASE 095f040)

Ruling: build on a branch in the main checkout, not a git worktree — the generated pr-lifecycle/.claude-plugin/types/ (needed by typecheck) and node_modules exist only here — costs: none if no other work happens in this checkout meanwhile.

## Pre-flight scan
| Pair / task | Produces → consumes | Found |
|---|---|---|
| T1 → T2 | severityHint().isTagged → severitySource | consistent |
| T2 → T3 | Answer.action 'acknowledged'; applyAnswer maps to 'rebutted' → afterTriage conversion | consistent |
| T2 → T4 | applyAnswer return object; T4 adds followUp spread | consistent (both edit applyAnswer; T4 builds on T2's version) |
| T3 → T4 | triage prompt step-2 string (T3 writes, T4 edits) | consistent, T4 must edit T3's text |
| T5 → T6 | standingOf(rec, at, ci) ← gatherStanding | consistent |
| T6 → T7 | gatherStanding, world.gh.required | consistent |
| T7 internal | Interfaces says ciHold($, action, pr, standing); code says ciHold(action, pr, standing) | CONFLICT — ruling below |
| T7 → T9 | waive post reply's `standing` var; T9 appends tellAgent | consistent |
| T8 → T9 | say(..., isNote), mergeNotes | consistent |
| T9 → T10 | logCommand isPerson incl. 'pane'; runCommand origin 'pane' | consistent |
| T5 ↔ T8 | holdText used in reportPrompt/heldPrompt/advance | consistent |
| T1 self | tests vs isNoAction/severityHint code traced case by case | consistent; note 'nit' becomes tagged P3 (was untagged P3; security nit was P2 → now P3) |
| T2 self | tests vs applyAnswer | consistent |
| T3 self | 'Looks fine…' bodies go through toTriage as inline comments, not reviews, so R83 doesn't settle them | consistent |
| T4 self | tests vs isSettledDeferral | consistent |
| T5 self | postRec via at([post({endHead:'a'})]) — decideNext may add round-owed; tests use arrayContaining except the waived case | consistent |
| T6 self | readRequired tests vs code | consistent |
| T7 self | isHeld exists in world.ts | consistent |
| T8 self | finding-29 test depends on fake fetch timing; plan tells implementer to trace | risk, not conflict |
| T9 self | openPr option key confirmed `openPr` (round.ts:170) | consistent |
| T10 self | recordOf in gate.test.ts is sync | fixed in plan (await is harmless) |

Ruling: T7 ciHold takes (action, pr, standing) with no $ — the standing already carries CI, so the engine isn't needed — costs: nothing; a signature only T7 uses.
Ruling: T1's advisory label outranks the security P2 floor (a security-hinted "nit:" reads P3) as the plan's code says — the spec says advisory labels read as a P3 tag and only explicit P0-P2 wins; mayAcknowledge and isSettledDeferral still refuse security findings — costs: a security nit shows P3 instead of P2 in holds; it still holds the merge.

## Tasks
Task 1: dispatched (BASE 095f040, implementer a828188ec312e4078, sonnet)
Task 1: implementer DONE_WITH_CONCERNS, commit 69f4c58 (421 pass)

## External review of PR #19 (ChatGPT reviewer, 4 unresolved P2 threads, read 2026-10-20)
Ruling: PR19-1 (isNoAction trusts a keyword list) — accept: settle only when EVERY sentence of the body matches a whole-sentence no-action form (LGTM/looks good/approved/ship it/thanks, no actionable|blocking findings|issues|comments [in this …], no issues found, nothing to fix, reviewed <sha> [against <base>]); any other sentence → triage. Enters Task 1's fix loop with the reviewer's two cases — costs if wrong: a few clean reviews with extra prose get triaged (one agent answer each).
Ruling: PR19-2 (required checks partial) — accept: each source must be parsed OK or authoritatively absent (classic 404 "not protected"); a throw, 403, 500 or malformed JSON from either → 'unknown' (all required). readRequired returns undefined on malformed classic JSON. Tests for 200/403, 200/500, 403/200, 500/200, throw, malformed. Plan Task 6 amended before dispatch — costs: none beyond fail-closed holds when GitHub hiccups.
Ruling: PR19-3 (post waiver guard too late) — accept: advance checks a valid head/base post waiver + no security hold right after its ownership/staleness checks, before startRound/startAnswer/startRecheck. Tests: waived head with open P2, with verification owed, with a round owed → resume starts no triage/recheck/review. Plan Task 8 amended — costs: none.
Ruling: PR19-4 (note merging spans commands) — accept: queue entries carry a batch id per holdingPrompts call; mergeNotes merges within a batch only; stop/reset drop queued prompts for the same record from earlier batches. Regression: waive pre then reset before the flush → agent gets the reset note and no open-PR prompt. Plan Tasks 8/9 amended — costs: none.
Docs fixes go on docs/wave2 (PR #19) via a worktree, then docs/wave2 is merged into this branch between tasks.
Task 1: review Approved (spec ✅); minors: (1) ADVISORY regex over-matches "Optional chaining…" — Ruling: fix in round 1 with the plan's tightened regex, cheap and it mislabels real findings as tagged P3 — costs: none; (2) loose text outside the no-action sentence = PR19-1; (3) logEvent loop then updateRecord not atomic — deferred minor; (4) 'New review feedback' assertion wording-dependent — deferred minor.
Task 1: minor (deferred): beginTriage logs approvals before marking processed; crash between re-logs once
Task 1: minor (deferred): first R83 flow test's "New review feedback" check depends on prompt wording
PR #19: docs fixed in 8755fb1, replied in all 4 threads, threads resolved; docs/wave2 merged into this branch.
Task 1: fix round 1/5 dispatched (FIX_BASE 3aa05cf; findings PR19-1 classifier, ADVISORY over-match)
Task 1: fix round 1 implementer DONE, commit 641236d (421 pass); re-review dispatched
Task 1: fix round 1/5 (1 addressed, 1 open — SETTLES[0] tail accepts trailing actionable clause; new minor: hyphen mark; commits 3aa05cf..641236d)
Task 1: fix round 2/5 dispatched (FIX_BASE 641236d)
Ruling: Task 1 "Nit-picking aside…" stays an untagged P3 (the existing nit/minor word guess), not P2 — it is a guess (severitySource 'hint'), so triage can raise it after Task 2 — costs: a guessed P3 shows until triaged.
Task 1: fix round 2 implementer DONE, commit 1135e23 (421 pass); re-review dispatched
Task 1: fix round 2/5 (2 addressed, 0 open; commits 641236d..1135e23)
Task 1: complete (commits 095f040..1135e23, review clean)
Task 2: dispatched (BASE 723724c, sonnet)
Task 2: implementer DONE, commit 2226a7d (424 pass); review dispatched
Task 2: review Approved; ⚠️ readTriage widening is Task 3 step 5 (checked in plan)
Task 2: minor (deferred): severitySource stays 'hint' after triage, so a later answer can move it again
Task 2: minor (deferred): no test that a hint finding keeps its severity when the answer carries none
Task 2: complete (commits 723724c..2226a7d, review clean)
Task 3: dispatched (BASE 675fdb0, sonnet)
Task 3: implementer DONE_WITH_CONCERNS, commit dd58e14 (430 pass); concern: tagged-P2 acknowledged test may not exercise mayAcknowledge; reprompt prose still 'fix, rebut or defer'
Task 3: review Approved (tagged-P2 test does fail if mayAcknowledge is bypassed)
Task 3: minor (deferred): R82 flow test title claims the security case; only the unit test covers security
Task 3: minor (deferred): ineligible-acknowledged tests assert only the reprompt text, not that G2-1 stays open / no reply recorded
Task 3: minor (deferred): positive acknowledged test doesn't assert replyId lands in rec.replies
Task 3: minor (deferred): R34 reprompt prose still says "fix, rebut or defer" (trailer example has acknowledged)
Task 3: complete (commits 675fdb0..dd58e14, review clean)
Task 4: dispatched (BASE 5c51b96, sonnet)
Task 4: implementer DONE, commit 9a27eae (435 pass); review dispatched
Task 4: review Approved, but ⚠️ confirmed gap: spec §4 "deferred, follow-up at …" in /pr-gate status and log not built (no task owned it) → fix round 1/5 dispatched (FIX_BASE 9a27eae)
Task 4: minor (deferred): followUp not shape-checked (any non-blank text settles a P3) — plan-mandated
Task 4: minor (deferred): a stale followUp survives a later re-deferral without one
Task 4: fix round 1 implementer DONE, commit 87c5c44 (437 pass); /pr-gate log has no per-finding status, left alone; re-review dispatched
Task 4: fix round 1/5 (1 addressed, 0 open; commits 9a27eae..87c5c44)
Task 4: complete (commits 5c51b96..87c5c44, review clean)
Task 4: minor (deferred): status puts the settled-deferral note before rec.message (cosmetic)
Task 5: implementer dispatched (sonnet), BASE 14ddf6e
Task 5: implementer DONE, commit d2a3afe (441 pass); review dispatched
Task 5: review Approved (spec ✅); waiver+security P1 shows every hold, matching today's guard and spec §1
Task 5: complete (commits 14ddf6e..d2a3afe, review clean)
Task 5: minor (deferred): tests don't pin non-security holds under waiver+security P1, retargeted, round-owed, pre phase, disputed; holdText returns '' when all named
Ruling: spec §1's 'late-feedback' Blocker kind and standingOf's late param are not built — the plan dropped them and judgeMerge's ready branch keeps today's untriagedFeedback hold (Task 7 leaves it), so a late review still blocks the merge — cost if wrong: late reviews aren't listed in the one standing text; final review can add it
Task 6: implementer dispatched (sonnet), BASE bb3615b
Ruling: added Task 12 (R87, spec §5a) from Adam's forwarded live report (cookbook #3732/#3741: a held chained create also dropped the body-file write) — run order 10, 12, 11 so Task 11 records R87 — cost if wrong: one small task of scope in 1.4.0; rewriting the command to run only part of it was rejected
Task 6: implementer DONE_WITH_CONCERNS, commit 1290918 (443 pass); test $ has no process → w.engine fake; brief test bug (classicAnswer reset); cache cleared in setup; review dispatched
Task 6: review Approved (spec ✅)
Task 6: complete (commits 7efabdb..1290918, review clean)
Task 6: minor (deferred): required cache keyed slug:base, cleared only in setup; classic 404 regex reads all of stderr
Task 7: implementer dispatched (sonnet), BASE 5dc0b21
Task 7: implementer DONE, commit ee94802 (446 pass); unreadable-CI refusal lost gh's stderr (test now matches 'gh auth status'); review dispatched
Task 7: review Approved (spec ✅, untriagedFeedback ruling intact, R77 intact)
Task 7: fix round 1/5 dispatched (FIX_BASE ee94802): restore gh stderr on unreadable CI; tighten tests 1 and 3
Task 7: minor (deferred): standing read before late-review check (extra gh calls); retargeted/round-owed may repeat what 'missing' says (no id to skip)
Task 7: fix round 1 implementer DONE, commit e8b9dd3 (446 pass); Blocker gains optional detail; readChecks returns {unreadable}; re-review dispatched
Task 7: fix round 1/5 (2 addressed, 0 open; commits ee94802..e8b9dd3)
Task 7: complete (commits e853524..e8b9dd3, review clean)
Task 7: minor (deferred): unreadable reason in both said and detail (harmless duplication)
Task 8: implementer dispatched (opus — timing + queue), BASE d32640d
Task 8: implementer DONE, commits 98f8b48, ba79873 (454 pass); concern: waiver landing mid-round names the PR head while rec.head stays old → a later resume reviews the waived head again; waiver message resent each session; review dispatched (opus)
Task 8: review Needs fixes — Important (plan-mandated): real-git beginTriage path (git log prints commits → patch → askTriage) still triages after a waiver; patch returns a stopped run, not null. Important (plan-mandated): advance matches waiver to stale rec.head on session-start/allow/waive <id> paths → round on waived PR head. Minor: head-unreviewed repeated (no id)
Task 8: fix round 1/5 dispatched (FIX_BASE ba79873)
Task 8: minor (deferred): waiver message resent per session (Task 9's 'only if not already sent'); overlapping holdingPrompts share a batch; mergeNotes prepends to every prompt in batch; audit patch()'s stopped-run return for === null checks
Task 8: fix round 1 implementer DONE, commit bcdf6dc (458 pass); isRunning re-checks after long awaits; advance reads PR head on waiver mismatch; head blocker id 'head'; re-review dispatched
Task 8: fix round 1/5 (3 addressed, 0 open; commits ba79873..bcdf6dc)
Task 8: complete (commits 9fc314f..bcdf6dc, review clean)
Task 8: minor (deferred): advance reads gh pr view each pass while an unmatched post waiver exists; prHeadOf's process.run not try-wrapped (same as prStateOf); a waiver matching rec.head while the PR head moved on still sends the waiver message
Task 9: implementer dispatched (sonnet), BASE 35ec60e; ruling carried: one waive post = one agent message (note merges into advance's waiver prompt, or advance skips it in that batch, spec §1)
Task 9: implementer DONE, commit f1beb67 (466 pass); waive post never calls advance → one note; R80 test assertion adapted; review dispatched
Task 9: review Needs fixes — Important: waive <finding> standing uses stale rec.head (can say ready on an unreviewed push); no-op reset still notes 'archived'; waive post with no PR says 'ready' (plan-mandated). Minors: R80 one-prompt count, pre wording, now2 name, reset next-step wording
Task 9: fix round 1/5 dispatched (FIX_BASE f1beb67)
Task 9: fix round 1 implementer DONE, commit c986d23 (469 pass); re-review dispatched
Ruling: advance's own ready prompt after waive <finding> can name a stale rec.head as ready — pre-existing (1.3.0 does the same), the merge guard still refuses a head ≠ rec.head — left for the final review, not widened into Task 9 — cost if wrong: one misleading 'ready' line on a rare path
Task 9: fix round 1/5 (3 addressed, 0 open; commits f1beb67..c986d23)
Task 9: complete (commits 35ec60e..c986d23, review clean)
Task 9: minor (deferred): waive <finding> live-head test doesn't observe the head used; reset-before-flush test checks the waive-pre note marker, not the open-PR body; reset text hard-codes /pr-gate
Task 10: implementer dispatched (sonnet), BASE 158400a
