# Task 6 report: R88, a post round is charged only when it finds something

Status: DONE_WITH_CONCERNS. Code commit c8f1412.

## Changes
- pr-lifecycle/types/index.d.ts: RoundRecord.isCharged?: boolean.
- pr-lifecycle/hooks/lifecycle.ts: usedRounds counts a completed discretionary round when phase is pre or isCharged !== false; new exported isChargedRound(findings, round) with REJECTABLE (placed after isBlocking). A rejected acknowledgement is covered since it is stored as status 'rebutted'.
- pr-lifecycle/hooks/round.ts: endRound sets isCharged on post rounds only; imports isChargedRound.
- Tests: R88 unit test in tests/lifecycle.test.ts (isChargedRound import added); two R88 flow tests in tests/flow.test.ts. Helpers finding, roundOf, pre, remaining, rejected all existed as the brief assumed; flow helpers needed no setup change.

## Adapted tests
- Brief's unit test: rejectedFix used the default severity P1, so isChargedRound([rejectedFix], 2) was true (a new blocker in round 2) against the expected false. Added severity: 'P2' to that fixture; the assertion's meaning is unchanged.
- No existing flow test needed changing (none relied on clean post rounds exhausting the allowance).

## Results
test 544/544 pass (was 541 + 3 new); lint clean; typecheck clean; validate passed.

## Concerns
- Answer-run Codex rejections (R37) record no round, so they charge nothing, per the ruling.
- Unbounded-repeat check: a clean post round is now free, so the allowance no longer caps post rounds that find nothing. Each such round ends only through the decideNext paths (clean round settles/ready, waitCap, human). I did not trace every decideNext branch, so I cannot rule out a loop that re-runs clean discretionary rounds on repeated new heads; a push by the agent or a bot between rounds is the only driver, and that is bounded by nothing but the human or the merge. Not changed, per instruction; worth a reviewer's look at decideNext for a post phase with remaining() unchanged.
