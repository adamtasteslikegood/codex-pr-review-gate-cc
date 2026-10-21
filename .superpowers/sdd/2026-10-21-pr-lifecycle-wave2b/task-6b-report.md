# Task 6b report: A8 (charge the push that fixes a round's findings) and the A9 raise event

Status: DONE_WITH_CONCERNS. Commits 78e913a (Part 1, A8) and b800f5b (Part 2, the raise event).

## What the code does when it records a fix

- In post-PR triage, `afterTriage` (round.ts) applies the agent's answers with
  `applyAnswer(finding, answer, one.round, 'main', now)`. `one.round` is the round of the run that
  asked, so a 'fixed' answer is a `{ status: 'reported-fixed', by: 'main', round: R }` event.
- This happens before the gate reads the PR head. Only after that does `afterTriage` call
  `onNewHead`, which flags findings and lapses waivers but never changes `run.round`. Then it runs
  `checkRebuttals` or goes straight to `endRound`, and either way the round is recorded as `run.round`, the same R.
- Today (before Tasks 8-10) a finding raised in round R is triaged in round R, at the end of R's
  collection. So the fix of a finding raised in R is stamped R, and the push ends R. No shift to
  the next round happens.
- Tasks 8-10 keep this. The plan says "the push ends the round at the end of the turn", and the
  answer is stamped by the run that asked. If Task 8 ever stamps answers with the new head's
  round, this rule has to follow.
- The new flow test asserts the stamp, `{ round: 4, by: 'main' }`, so a change to it fails a test.
- The pre-PR fix step (round.ts ~2973) stamps `'fixer'` or `'main'` with `one.round`. Pre rounds are always charged, so it has no effect there.

## The rule as implemented

A post round R is charged (`isChargedRound`) when any of these holds:
- a new blocker is raised in it (Task 6, plus Task 7's "a linked duplicate is not new");
- Codex rejects an answer in it (Task 6);
- **(A8)** the agent fixed, in R, a finding raised in R. In code: some finding with
  `round === R` and no `duplicateOf` has a `reported-fixed` event in R by anyone other than
  `'codex'` or `'gate'`.

Details:
- The charge is a boolean, so the round is charged once whatever the reasons.
- Rebutting, deferring or acknowledging a non-blocking finding stays free.
- A linked duplicate's fix charges nothing. Its original charges the round only if the original
  was raised in that round and has a fix event there.
- The rule excludes `'codex'` and `'gate'` rather than allowing only `'main'`, so the pre-PR
  `'fixer'` name also counts.
- **Answer runs (R37)** record no round, so a fix pushed in one charges nothing, as Task 6 ruled.
  Kept.
- **Pre rounds** are unaffected. `usedRounds` still counts every completed discretionary pre round.
- **`isCharged` is now written only on completed discretionary post rounds** (`endRound`:
  `run.lifecycle === 'post' && run.roundKind === 'discretionary' && isCompleted`). Baseline
  rounds, final-head checks and incomplete attempts carry no field. `usedRounds` already counts
  only discretionary rounds, and the plan's Task 12 `lateBlockers` filters
  `kind === 'discretionary' && isCharged !== false`, so both agree with this.

## Changes, file by file

### Part 1 (78e913a)
- `pr-lifecycle/hooks/lifecycle.ts`: `isChargedRound` gains the `isFixed` reason, and its JSDoc names A8.
- `pr-lifecycle/hooks/round.ts`: `endRound` writes `isCharged` only on completed discretionary post rounds.
- `pr-lifecycle/types/index.d.ts`: the `RoundRecord.isCharged` doc names A8 and lists where the field is absent.
- `pr-lifecycle/tests/lifecycle.test.ts`: one new unit test. It covers:
  - a P3 fixed in its own round charges;
  - a rebuttal, deferral or acknowledgement does not;
  - a finding raised in round 2 and fixed in round 3 charges neither round;
  - a gate or Codex `reported-fixed` entry does not charge;
  - the pre-PR fixer charges;
  - a linked duplicate fixed does not charge;
  - a blocker plus a fix charges once.
- `pr-lifecycle/tests/flow.test.ts`:
  - New helper `toDiscretionary`. It runs rounds 2 and 3, the baseline pair, each fixing and
    pushing, then asserts that round 4 is `discretionary`.
  - New helper `chargedOf`.
  - New flow tests, described under "Tests adapted" below.

### Part 2 (b800f5b)

**The problem.** `withLinkedPeak` adds an event to the original's history when a link raises its
severity. That event copies the original's status, so on a rebutted original it reads as a new
gate 'rebutted' entry, last in the history.

**The fix: mark the event and have the status readers skip it.** The raise stays in the history,
recorded as the gate's change with the severity before it (R85, spec A9). This was the smallest
change that keeps both `loweringOf` and that record correct.

**The changes.**
- `pr-lifecycle/types/index.d.ts`: new `FindingEvent.raisedBy?: string`, the id of the link that
  raised the severity.
- `pr-lifecycle/hooks/lifecycle.ts`:
  - `withLinkedPeak` stamps `raisedBy: linked.id` on the raise event.
  - New exported `answersOf(f)`: the history without raise events.
  - These readers now read `answersOf`:
    - `isAcceptedRebuttal` (a);
    - `rebuttedAt`, for R33 (b);
    - `isAcknowledged` (c);
    - `rejections` and `isChargedRound`, both the rejection and the fix reason (each index-based
      read now runs over the filtered list);
    - `raisedIn`, because an open original raised by a link was otherwise "raised in" the link's round;
    - `disputeOf`, which would otherwise quote "raised by its link G…" as the agent's argument;
    - the `refuted` check in `decidePost`, which reads `at(-1)` and `at(-2)`.
- `pr-lifecycle/hooks/core.ts`: `isAck` in the held-prompt text reads `answersOf`. It duplicates
  `isAcknowledged`, and the two would otherwise diverge.
- `pr-lifecycle/hooks/pane.tsx`: `markOf`'s `wasAccepted` reads `answersOf(one).at(-1)`, so an
  accepted rebuttal whose file changed still shows "re-verify owed". This is display only, and
  no test covers it.
- `pr-lifecycle/hooks/round.ts`: `isVerifiedAtEnd` reads `answersOf(one).at(-1)`. Before, a
  raise as the last entry made a verified fix look owed again. That over-held, which is the safe
  direction, but it was wrong.

**Sweep.** I grepped every `.ts` and `.tsx` source in the plugin (hooks/, types/) for `history`.
Beyond the readers above, only `register.tsx` matched, and only in comments and strings about the
record's history. No other reader of finding events exists.

**Left reading the raise on purpose.**
- `loweringOf`: a raise is not a lowering, since by-gate entries rise. It sets `before`, which
  is correct.
- `isPeakUnknown` and the first-severity read: the raise carries `from`, so it never makes a known peak unknown.

**Unit test.** One new test in `pr-lifecycle/tests/lifecycle.test.ts`, on a P3 original
acknowledged by the agent and accepted by Codex, which a P1 duplicate then links to. It checks:
- the raise is recorded with `raisedBy`, `from: 'P3'`, `by: 'gate'`, and `loweringOf` is undefined;
- the original stays an accepted rebuttal and stays acknowledged, with 0 rejections and no dispute;
- `mergeHolds` and `checksOwed` are empty;
- a reply posted between the rebuttal (at 4) and the link (at 9) still triages `new-on-reviewed` under R33;
- the link's round charges nothing;
- a rebuttal Codex has not ruled on stays owed to Codex and holds;
- an open original is not `raisedIn` the link's round;
- a rejection before the raise still counts, and still charges its round.

Without the filter (`answersOf` returning the whole history), this test fails at
`isAcceptedRebuttal`, which was verified.

**What the accepted rebuttal does at P1.** It does not hold. `mergeHolds` drops any accepted
rebuttal, at any severity (R39), and the duplicate holds only through its original. This fits the
spec:
- A9's "keeps its P1 hold" is about an original that holds: open, reported-fixed, or deferred.
  For those, the raise still moves `severity`, so every hold reads P1, and a P3 deferral waits
  for the person. Task 7's tests keep covering that.
- R33 refuses a gate link to a rebuttal for feedback posted after it. So a link to an accepted
  rebuttal only comes from an item posted before the rebuttal, which is the same claim Codex
  already ruled on, or from the agent's link, which Codex checks.

See the first concern below.

## Tests adapted

- **Task 6's flow test "each post round records whether it was charged: a clean one is free…"**
  asserted `[false]` on post round 2, a baseline round. It now asserts that round 2 carries no
  `isCharged`: `[[2, 'baseline', undefined]]`.
  - The "clean round is free" check moved to a new test, "a clean discretionary round is free",
    on round 4: `[2, baseline, undefined], [3, baseline, undefined], [4, discretionary, false]`.
  - It is split in two because the harness allows one `world(on)` per test.
- **Task 6's flow test "a round that raises a new blocker is charged"** asserted `[true]` on
  baseline round 2. It now runs on discretionary round 4 (via `toDiscretionary`): a new P1, rebutted and
  accepted, gives `[4, 'discretionary', true]`.
- **New A8 flow test.** In discretionary round 4, a P3 nit is fixed and pushed, and Codex
  verifies it.
  - The fix event is stamped `{ round: 4, by: 'main' }`.
  - Round 4 is recorded `isCharged: true`.
  - Round 5 reviews the new head clean: `isCharged: false`, and the record is `ready`.
  - Without the A8 rule, this test and the A8 unit test fail, which was verified.
- **flow.test.ts, R90 test "the agent's link goes to Codex at no round's cost…"** asserts
  `rounds.filter(post && isCharged === true)` is `[]`. Its round is baseline round 2, so the
  assertion is now trivially true. I left it unchanged; it still guards against any post round
  being charged there.

## Results

- `npm run test`: 562/562 pass. That is 558 + 1 A8 unit + 1 net new flow test + 1 A9 unit + 1
  from the split. The codex-gate suite: 22/22.
- Two runs in this session had a 5 s timeout, unrelated to this change, under load:
  - "a roster on the base is used…" (settings.test.ts);
  - "#11: the post-PR Codex fallback re-review runs at rereviewEffort" (models.test.ts).

  Both pass on rerun. The first runs at 3.6-4.2 s against a 5 s limit.
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm run validate`: passed.

## Concerns

1. **A P1 duplicate linked to an accepted P3 rebuttal is not re-checked by Codex at P1.** The
   original stays settled, which is what the brief asked for and what R39 does. Before this fix,
   the bug made the rebuttal unaccepted, so Codex re-ruled it at P1 by accident. If Adam wants a
   raise to blocking to send an accepted rebuttal back to Codex, that is a deliberate
   `needsRecheck` on raise, not this event. Worth a ruling.
2. **A fix that answers a finding in a later round than the one that raised it charges no round
   under A8.** The fix is only charged if Codex rejects it. This affects:
   - an item left unanswered, then re-asked or fixed in R+1;
   - a fix in an answer run (R37) after a round ended blocked (R32). Round R is already recorded,
     and the answer run records none.

   This is the brief's rule, and the loop it leaves is bounded by the R32 block on an unchanged
   head, not by the allowance.
3. Task 8 has to keep stamping triage answers with the round that asked (see "What the code does
   when it records a fix"). The A8 flow test asserts the stamp, so a change would show.
4. Older records may hold raise events without `raisedBy`, written by the unreleased 1.5.0
   branch's Task 7. None were shipped, so no migration was added.
