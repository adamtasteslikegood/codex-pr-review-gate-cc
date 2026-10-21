# Task 8 report: the agent answers feedback while collection waits (R88, spec §1.1–1.2, A4)

Status: DONE_WITH_CONCERNS (the concerns are below; none blocks)
Commit: `374a840` pr-lifecycle 1.5.0: the agent answers feedback while collection waits (R88). A4 is in the same commit.

## Changes, file by file

### `pr-lifecycle/types/index.d.ts`
- `Run.triaged`: the doc comment is now "the feedback ids handed to the main agent in the triage turn in flight (or the last one)".
- New `Run.handed?: string[]`: the feedback ids that every triage turn of this round was handed. `startRound` builds a new Run, so it resets each round.
- New `Run.polled?: string[]`: the fresh feedback ids the last poll saw. It replaces `pollOnce`'s use of `triaged`.
- New `Run.isSettling?: number` (A4, ruling 1):
  - It holds the time `afterTriage` began settling a turn taken while collecting.
  - It doubles as that call's ownership token.
  - A flag older than the step timeout is stale.

### `pr-lifecycle/hooks/round.ts`
- **`startTicker`:**
  - It polls whenever `run.collect` is set, not only in phase `'collect'`.
  - Phase `'collect'` still has no step timeout.
  - A mid-collection turn (phase `'triage'`) does have one.
  - While a turn settles (`isSettling` set, nothing pending), the ticker skips the step timeout, because `pollOnce`'s stale-flag check governs that state.
  - The step-timeout message for a mid-collection turn adds: "It was answering feedback while reviews were still being collected; that feedback stays unanswered: run /pr-gate resume to collect again and be asked it."
- **New `closeCollect($, id, now, detail, extra?)`:** it adds the wait, clears `collect` and marks `r{n}-collect` done.
  - `endCollect` now uses it, and Task 9 can use it too.
  - `endCollect`'s own `waitMs` computation was removed.
- **`endCollect`:**
  - `hasFindings` also counts `run.handed`, so feedback a turn of the round already answered while collecting still counts as the round's.
  - Without this, a pass-through round 1 whose only comment was answered mid-collection ended in "No reviewer covered … within the wait cap". The R76 test caught it.
- **`pollOnce`:**
  - **Guard:** it accepts phase `'collect'` or `'triage'` with `collect` set.
  - **Stale-flag check (ruling 1):** this runs before the 30 s throttle.
    - It fires when `isSettling` is older than `config.stepTimeoutMs` and nothing is pending.
    - It clears the flag, puts the run back in phase `'collect'` (adding `activeMs` and resetting `hasReprompted`), and logs a kind `'head'` line (not `'stop'`: `/pr-gate log` counts `'stop'` entries as stops, and the run did not stop): "…settling flag cleared, collection goes on".
    - The poll then goes on normally.
  - **`isTurn = run.phase === 'triage'`:** this covers both a turn in flight and `afterTriage` settling one (see the fit notes below).
  - **A failed gh read during a turn:** the poll returns, and the next poll tries again.
  - **`isArrival`:** an arrival is now told by `polled`, not by `triaged.length`.
  - **The turn-time early return:** it is placed after the arrival block (`noteArrival` and `headAt`), not after `lastArrivalAt` as in the brief (ruling 3).
    - It writes `polledAt`, `lastArrivalAt` and `polled` to the run. It writes `headAt` only when the head did not move.
    - It writes those only to the collection this poll read (same `round` and same `collect.startedAt`).
    - It writes the record's `headArrival.seenAt`.
    - It never calls `onNewHead`, never moves `roundStartHead` and never judges collection.
  - **The `after` patch:** it writes `polled`, not `triaged`.
  - **The tail:** done means `endCollect`. Otherwise, unhanded fresh findings with one quiet poll since the last arrival start `beginTriage(…, false, true)`. Otherwise the activity line is updated.
- **`beginTriage($, id, isFromCommand = false, isMidCollect = false)`:**
  - When mid-collection, it returns unless the run is still in phase `'collect'` with `collect` set.
  - `items` skips ids in `handed`.
  - `codex` and `carried` are `[]`.
  - It reads no log of new commits.
  - It returns when `asked` is empty.
  - The opening patch is refused unless the run is still on the same round, in `'collect'`, with `collect` set.
  - That patch adds `handed` and `hasReprompted: false`, and sets the mid-collection activity and step label.
  - The prompt gets the brief's `intro` text verbatim.
- **`afterTriage`:**
  - **Start:** it keeps the record's `generation` from the start. The first patch (which clears `pending`) sets `isSettling: now` when `collect` is set.
  - **`isOwn()`:** it re-reads the run (same id, running, same `round`, and for a mid-collection turn `isSettling === now`) and the record's `generation`. It is checked after each awaited read, before each write: before the record write, before the re-prompt patch, after `git status`, after `gh pr view`, and after the ancestry check.
  - **The re-prompt patch:** it clears `isSettling`.
  - **No push while collecting:** the run goes back to `'collect'`. That patch clears `pending` and `isSettling`, adds `activeMs` and resets `hasReprompted`.
  - **A push while collecting:** `closeCollect(…, 'ended by the push of …', { isSettling: undefined })`. 1.4.0's tail then ends the round: `onNewHead`, the exemption, then `checkRebuttals` or `endRound`, then `advance`.
- **`finish`:** clears `isSettling`.

### `pr-lifecycle/tests/flow.test.ts`
- The brief's two tests, verbatim:
  - "R88: feedback is answered while collection waits…"
  - "R88: a push in a mid-collection turn ends the round on the old head…"
- A new helper, `toMidTurn`.
- Four new tests:
  - "R88 (A4): a poll while afterTriage settles a pushed head opens no round under it; the turn's end opens exactly one".
    - `w.git.onHead` holds `afterTriage` at its `rev-parse HEAD`. That is after `pending` cleared, just before the PR-head read.
    - The test ticks twice with the pushed head on the PR, then releases.
    - It checks: exactly one post round, `[2, a…, e…]`; round 3 collecting on e…e; `r2-triage` done; the only `r3-` step is `r3-collect` running; `isSettling` cleared.
  - "R88: a head pushed during a mid-collection turn gets its arrival noted by the poll that sees it". This is ruling 3: the poll during the turn records `headArrival {e…, at: that poll, isPushTime: false}`, and the next round keeps it.
  - "R88: a mid-collection turn that never answers times out with an attempt, never a stuck triage" (`stepTimeoutMinutes: 1`). This is ruling 2. The test also checks the message, then that `/pr-gate resume` collects again on round 2 and asks the feedback again.
  - "R88: a settling flag older than the step timeout is cleared and collection goes on" (`stepTimeoutMinutes: 1`). This is ruling 1.
    - `afterTriage` is held past the timeout.
    - The poll clears the flag, returns to `'collect'` and logs.
    - The late release writes nothing.
    - The head's end still has Codex check the recorded rebuttal.

## How the brief was fitted to the code Tasks 4–7 changed
- **`pollOnce` (Tasks 4, 5):**
  - Task 4's arrival block (`known`/`noteArrival`/`headAt`), the `seenAt` write, `guessCover`, the `latestPushOf` re-read and Task 5's signals in `collectionDone` are all kept unchanged for the normal path.
  - The turn-time return sits between the arrival block and `onNewHead`, so polls during a turn still persist `headArrival`.
  - The `latestPushOf` "branch moved" early return stays ahead of the new tail.
- **`endCollect`:** Task 4/5's evidence and the `collectionDone` result are passed through `closeCollect`'s `extra` (`evidence`, `headSha`).
- **`beginTriage` (Task 7):**
  - The gate's duplicate links (`linkTo`, `withLinkedPeak`, `raised`) run unchanged for a mid-collection turn.
  - Only the `items` filter, `codex`, `carried` and the commit log are gated by `isMidCollect`.
- **`afterTriage` (Tasks 3, 6b, 7):**
  - `readLinks`/`applyLinks` (canonical ids, the refused-link rule), A9's raise, `withOwnReplies` (R91), `processed` and `replies` all run before the new branch. A turn that returns to collecting has therefore recorded its answers, links, replies and processed ids.
  - Answers are stamped with `one.round`, the current round, so A8's check still sees them; 6b's flow test passes.
- **`startRound`:** it builds a fresh `Run` object, so `handed`, `polled` and `isSettling` cannot carry into a new round without any edit.
- **Placement of `closeCollect` in `afterTriage`:** it runs right after the head is known, before `onNewHead`, not just before `getRun` as the brief has it. With `collect` cleared, no poll runs for the round during the remaining awaits, so those awaits need no settling flag. A comment says so.
- **`isTurn`:** this is `phase === 'triage'`, not `pending.length > 0 || isSettling`.
  - With `collect` set, phase `'triage'` happens only while a turn is in flight or settling.
  - This also covers any triage state with nothing pending and no flag. Such a state then meets the ticker's step timeout, which skips only while `isSettling` is set, so it cannot get stuck.

## Rulings
1. **Stale-turn guard.**
   - `isSettling` is a timestamp.
   - `pollOnce` clears a flag older than `config.stepTimeoutMs` (the `stepTimeoutMinutes` setting, 30 min by default), with a kind `'head'` log line. It returns the run to `'collect'`, and the poll goes on.
   - The ticker leaves the settling state to this check rather than to `finish(error)`, so the stale path is the one that actually runs. Test: "a settling flag older than the step timeout…".
   - **The cap during a turn:** a poll during a turn never judges collection, so the 20-minute cap cannot end collection mid-turn.
     - A turn that hits its step timeout ends through the ticker: `noteAttempt` + `finish('error')`, with the message above. The run is no longer running, so neither the ticker nor `pollOnce` acts on it.
     - `/pr-gate resume` starts a fresh collection with its own cap, and the feedback is asked again (tested).
     - A turn that ends normally returns to `'collect'`, and the next poll applies the cap from `collect.startedAt`. A cap already passed ends collection at once, as the R76 adaptation shows.
2. **The step timeout of a mid-collection turn:**
   - It holds with a clear message: status `'error'`, phase `'done'`, an attempt noted, and a message naming `/pr-gate resume`.
   - It never leaves phase `'triage'` with `collect` set and nothing in flight while running: `finish` sets phase `'done'` and clears `pending` and `isSettling`.
   - Tested, including the resume.
3. **Polls during a turn:** yes, the brief's `isTurn` return skipped `noteArrival` and the `seenAt` write, because it sat before the arrival block. I moved it after that block. Tested.
4. **Charging:** unchanged.
   - A push ends the round through 1.4.0's tail, where A8's `isChargedRound` stamps it.
   - A turn with no push records no round. Its rebuttals are checked through the end-of-head triage (`asked` empty → `checkRebuttals`), and a rejection there falls in this round.

## Existing tests adapted
- **"R76: on a pass-through PR, a resume triages a trusted reviewer's late P1 too, at no round":**
  - Alice's comment is now answered by a mid-collection turn during the 20-minute advance.
  - I added `await w.clock.advance(30_000)` after the triage answer, so the next poll ends the capped collection and Codex checks the rebuttal (`r1-verify`).
  - The test also found the `endCollect` `hasFindings` gap fixed above.
- **The `run.triaged` assertions at lines 706 and 2629** needed no change. They read `triaged` after `beginTriage`, which still sets it.

## Results
- `npm run test`:
  - codex-gate: 22/22.
  - pr-lifecycle: 570 tests (564 + 6 new). The last full run was 569/570. The one failure was the known 5 s timeout "a roster on the base is used: collection waits on its reviewer, whose comment is trusted".
  - In a flow-only run just before it, all 570 passed, that test and "#11 …rereviewEffort" included (each has timed out at 5 s under load in one run or another).
- `npm run lint`: clean.
- `npm run typecheck`: clean, 0 errors.

## Concerns
- **The step timeout of a mid-collection turn stops the run; it does not go back to collecting.** It ends with `finish('error')` and a message naming `/pr-gate resume`. That is not a state the cap governs. It matches how 1.4.0 handles an end-of-head triage timeout, and the resume is tested.
  - The controller may prefer to go back to collecting here: clear `pending` and set phase `'collect'`, so the cap that has already passed ends collection at the next poll and the end-of-head triage asks the feedback.
  - That is a change of about 10 lines in the ticker's `else` branch.
- **A head push during collection with no turn in flight** still moves `roundStartHead` inside the round (1.4.0's `onNewHead` path). Task 9's rollover replaces that. The same applies to a push left after a stale-flag clear: the answers already recorded stand, and the next poll moves the head as before.
- **`isOwn()` re-reads the record after each await.** That adds a few store reads per triage end. The generation check applies to every `afterTriage`, not only mid-collection turns. The full suite shows no behaviour change.
- **The ticker skips the step timeout while a mid-collection turn settles.** The stale-flag check in `pollOnce` is the only backstop there. It runs on every tick (before the 30 s throttle), so it fires within a second of the threshold.
- **The 5 s flaky tests** remain as before.

## Fix round 1

Commit: `72ef884` pr-lifecycle 1.5.0: a timed-out turn while collecting is asked again once; afterTriage guards every stop (R88, A4).
This report section is a commit of its own.

### Changes
1. **The first timeout of a mid-collection turn goes back to collecting** (controller ruling).
   - New `Run.midTurnTimeouts?: number`. `startRound` builds a new Run, so it resets each round.
   - **Where it is handled:** the ticker handles `phase === 'triage' && collect !== undefined && pending.length > 0 && (midTurnTimeouts ?? 0) === 0` before the generic timeout branch, through the new `requeueMidTurn`.
   - **When the patch applies:** only when the run is on the same round, still in `'triage'`, `collect` is still set, and the same pending step (same `step` and `turnId`, no answer yet) is in flight.
   - **What the patch sets:**
     - phase to `'collect'` and `phaseStartedAt` to now;
     - `activeMs += now - phaseStartedAt`;
     - `pending` to `[]`, `isSettling` to undefined and `hasReprompted` to false;
     - `midTurnTimeouts` to 1;
     - `r{n}-triage` to done, with the detail "timed out after …; asked again".
   - **Asking again:** the turn's unanswered ids (`run.triaged` minus `rec.processed`) are removed from `handed`, so the next poll opens a new mid-collection turn that asks them again.
   - **Logging:** kind `'head'`. `noteAttempt` is not called.
   - **A second timeout in the same round:** unchanged, `noteAttempt` + `finish('error')` with the resume message.
2. **A late answer to a timed-out turn (Minor 6):** no code change was needed. Instead I traced it and added a test.
   - The main agent's answer matches a pending step only through `isTurnOf`, which requires the pending entry's `turnId` to equal the answering turn's id.
   - That `turnId` is armed by `onTurnStart` for the turn that started with the step's prompt.
   - After the timeout, `pending` is `[]`, so a late answer matches nothing.
   - The re-ask's pending entry has no `turnId` until its own turn starts, and then gets that turn's id. The old turn's id never matches it.
   - The new test checks this. The old turn (`turn-old`, started with the first prompt) ends after the re-ask was sent. Its answer is not applied: the run stays in triage with the answer unset and G2-1 open. The re-ask's own turn is then recorded.
3. **Every stop in `afterTriage` is guarded after its awaits (Important 2):**
   - Added `isOwn()` between `unpushedBy` and `failPost`.
   - **Audit of every stop and write in `afterTriage`:**
     - The record write: `isOwn` checked before it.
     - The re-prompt: `isOwn` before it.
     - The dirty `failPost`: `isOwn` after `git status`.
     - `closeLifecycle` and the head-read `failPost`: `isOwn` after `rev-parse` and `gh pr view`.
     - The `isPushed`/`fetchTwice`/`merge-base` awaits: followed by `isOwn` before the containment stop, and now again after `unpushedBy`.
     - Back-to-collecting and `closeCollect`: only a clock read since the last `isOwn`.
   - **The tail after `closeCollect`/`onNewHead`:** it now checks `round` and the record's `generation` as well as id and status.
   - `checkRebuttals` and `endRound` keep their own `isRunning` checks.
4. **Stale threshold (Minor 4):**
   - It is now `Math.max(stepTimeoutMs, 5 * 60_000)`, and the log line names it.
   - The stale test now first asserts that at 62 s, with a 1-minute step timeout, the flag is still set. It is cleared after 5 minutes.
5. **A record that is gone after `afterTriage`'s write (Minor 5):**
   - This is now a guarded `finish('error')`: "The lifecycle record of … is gone…".
   - It is guarded by the same run id, `'running'`, the same round, and for a mid-collection turn its own `isSettling` token.
   - The stop clears `isSettling`, so collection is never frozen.
   - This applies to an end-of-head triage too, which used to return silently and wait for the step timeout.

### Tests
- **Updated:** "R88: a mid-collection turn that never answers goes back to collecting once; a second timeout in the round stops it" (formerly "…times out with an attempt…").
  - The first timeout returns to collecting with no attempt and a log line, and the step is done with "timed out".
  - The next turn asks G2-1 again.
  - A second timeout stops the run with the attempt and the resume message.
  - Resume collects again.
- **New:**
  - "R88: a late answer to a timed-out mid-collection turn is not read as the answer to the turn that asks again".
  - "R88 (A4): a reset while afterTriage lists the unpushed commits writes no stop over it". The world gains a `git.onUnpushed` hook, and the test bumps the record's generation inside it.
  - "R88 (A4): a record gone when afterTriage settles a turn while collecting stops the run with a clear message, never a frozen collection". It uses `w.afterRead`.
- **Renamed and extended:** "R88: a settling flag older than the step timeout (at least five minutes) is cleared and collection goes on".
- **Results:** `npm run test` passed codex-gate 22/22 and pr-lifecycle 573/573. A flow-only run before that had the known 5 s timeout in "#11 …rereviewEffort" once. `npm run lint` and `npm run typecheck` are clean.

### Rulings to record (Task 16)
- **`isTurn = phase === 'triage'`** in `pollOnce`, not `pending.length > 0 || isSettling`.
  - With `collect` set, phase `'triage'` occurs only while a turn is in flight or `afterTriage` settles one, so the two tests are equivalent.
  - It is fail-safe: a triage state with nothing pending and no flag still meets the ticker's step timeout.
- **`endCollect` counts handed feedback:** `hasFindings` includes `run.handed`. Feedback a turn of the round answered while collecting counts as the round's feedback, as it did when it waited until collection ended. So a pass-through round 1 whose only comment was answered mid-collection goes on to the rebuttal check instead of ending in "No reviewer covered … within the wait cap".

### Concerns
- The "step timeout stops the run" concern above is resolved by item 1. A second mid-collection timeout in a round still needs `/pr-gate resume`, as ruled.
- The re-ask after a timeout reuses the step id `r{n}-triage`. That is safe because answers match by turn id, not by step marker. If the engine's matching ever moved to step markers alone, the re-ask would need a distinct marker.
- Minor 3 (the stale check sits behind the poll lock) is left alone, as directed.
