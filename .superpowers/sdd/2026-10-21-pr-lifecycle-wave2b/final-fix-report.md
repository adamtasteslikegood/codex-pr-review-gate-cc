# Final review fix round: pr-lifecycle 1.5.0 (wave 2b)

Base: 51d9bff. Findings from `final-review.md`: Important 1 and Minors 1, 2, 3, 5 and 6. The other minors are parked, as asked.

## Important 1: a filing pass cut short by a waiver re-enters `advance` once

`round.ts` `advance`:
- New last parameter `pass = 0`.
- After `fileIssues` returns, if `filed.waivers.length !== rec.waivers.length` and `pass === 0`, `advance` re-enters from the top with `pass + 1`.
- The three existing `isStale` recursions now forward `pass`, so they can't reset the bound.
- At the bound (pass 1), `advance` goes on to `decideNext` as before. The run is finished as `blocked`/`exhausted` with its resume line, so it is never left `running`.

The re-entry starts from the top of `advance`, so every case is decided again:
- **Grant refused in the lock.** `fileIssues` returned the record without a grant. On re-entry, `planIssues` plans the grant again and the lock grants it, so the gate round starts. Before the fix, the lifecycle ended `exhausted` with "needs their allowance".
- **Loop stopped with items left unfiled.** On re-entry, the rest are filed.
- **Post waiver landed mid-pass.** On re-entry, the post-waiver branch at the top of `advance` sees it. When `pass > 0` that branch says nothing: `waive post` has already told the agent what the waiver covers (one message, as R81 requires), and it has already finished a post run of the branch. The branch still finishes a run of this branch if one is somehow still running, so nothing waits on no one. Before the fix, the record was written `postStatus: 'blocked'` with "… waits for its GitHub issue" on a waived head.

**Deviation from the review's wording.** The review suggested re-entering when "waivers grew, *or* `planIssues` is still non-empty". I re-enter only when the waivers grew:
- After a *failed* filing, the finding keeps `issueError` or `followUpLabelError` and is still fileable, so `planIssues` stays non-empty.
- With that clause, every failure would be retried at once in the same pass. A7's "filed without its label → the next pass labels it" would collapse into a single pass, and every gh failure would cost a second 30 s bounded attempt.
- Every way a pass is cut short is a waiver: the loop's `isWaived` return, the grant lock's `isWaived` return, and a post waiver. So "waivers grew" is the exact trigger.
- A grant refused under the lock with no waiver means another pass changed the record. The record `fileIssues` returns then already carries that change, and `decideNext` acts on it.

The `fileIssues` doc comment now says the caller re-enters once.

## Minor 1: session start checks every post or ready record with a PR

`register.tsx` session start:
- Any `post` or `ready` record with a `pr`, in any status (blocked, awaiting the person, MERGE_UNCONFIRMED, held), gets one `prStateOf` read.
- MERGED or CLOSED → `closeLifecycle`, which runs the issue check first.
- `advance` still runs only for an open PR with `postStatus` undefined or `error`.
- This also closes `ready`+CLOSED at session start now, as `startGate` already does (R62).
- A note on the shape of the case. A failed post-merge issue check (MERGE_UNCONFIRMED) leaves the record `ready`+`blocked`, not `post`+`blocked`, and session start already handled `ready`+MERGED. The new coverage is a `post` record that is `blocked` or `awaiting-decision` (a hold the agent was told of) whose PR was merged on GitHub.

## Minor 2: `closeCollect` restamps the step clock

`closeCollect` sets `phaseStartedAt = now`. It adds the elapsed time to `activeMs` when the phase is not `collect`: the mid-turn afterTriage caller closes collection from a `triage` phase, and that turn's active time would otherwise be lost. `extra` still overrides.

## Minor 3: the filing pass gets its own step clock

- The filing pass has no phase of its own.
- The least invasive correct stamp: inside `fileIssues`, on the `file` path, a `restamp()` before each issue. It patches the branch's running run with `phaseStartedAt = now` (plus `activeMs` accrual, as above) and `activity: 'filing follow-up issues…'`, and leaves its phase alone.
- The grant path makes no gh call and needs no stamp.
- Restamping before *each* issue, rather than once at the pass start, keeps many issues (up to about 90 s of bounded gh calls each) from adding up past the step timeout. A stalled pass is still bounded per issue.
- Not adding a phase avoids touching the pane, `noteAttempt` and the ticker branches.

## Minor 5: a spawn failure before the close tells the agent

In `register.tsx` `onMerged`, the `git rev-parse` and `gh pr view` calls now sit in a try:
- On a throw, the gate reads the checkout's branch as best it can (a git failure there gives `''`).
- It queues a `say`: "the merge went through, but the gate failed before it could check the follow-up issues (…). The issue check did not run, and the lifecycle is not closed: run /pr-gate."
- It then rethrows, so the existing toast stays.
- The key is `{ root, branch }`. `deliver` checks ownership: a key with no record is not owned elsewhere, so the prompt is delivered (#13 respected, no direct `prompt.submit`).
- A non-zero gh exit or a non-MERGED state still returns silently (R62, left to poll, session start or /pr-gate).

## Minor 6: a throwing say doesn't hide the original error

`onMerged` has a local `tell()` that wraps `say` in its own try. Both catch blocks use it and then rethrow the original error.

## Tests added (`pr-lifecycle/tests/flow.test.ts`)

All were confirmed failing on the unfixed hooks (scratch copy of 51d9bff's `round.ts`/`register.tsx`) and passing with the fix. None is slow (under 1 s each), so none carries a `timeoutMs`.

1. **wave 2b final review I1: a finding waived while the filing pass runs leaves no issue unfiled: the pass runs again, with no resume.**
   - Setup: two P2 deferrals, and `waive G2-1` given through the real command during G2-1's POST.
   - Expect: 2 issues filed, G2-2 → #22, the record ready, the run `passed`, and no "wait for their GitHub issue" prompt.
   - Before the fix: 1 filed.
2. **wave 2b final review I1: a waive post given while the filing pass runs is honoured: no hold, no blocked record, one message.**
   - Setup: `waive post` given through the real command during the first POST.
   - Expect: the run `waived`, only the issue in flight kept, `postStatus`/`message` undefined, exactly one waive note, and no issue or "covers PR" prompt.
   - Before the fix: `postStatus: 'blocked'`.
3. **wave 2b final review I1: a gate round refused in the lock because a waiver just landed is granted when the pass runs again, not exhausted.**
   - Setup: a crafted post record with the allowance spent and a final-head check (on a push) that raised a late P1. The test asserts `decideNext` gives `exhausted` and `planIssues` gives `grant`.
   - Trigger: session start. A finding waiver is injected from `w.git.onRoster`, which fires in `fileIssues`'s `configFor`, between `advance`'s load and the grant lock.
   - Expect: one gate grant, a running discretionary round, and no "needs their allowance".
   - Before the fix: no grant.
4. **wave 2b final review m3: the filing pass gets its own step clock: a verify step near its timeout does not stop it** (`stepTimeoutMinutes: 1`).
   - Setup: 50 s into the verify step, then each POST takes 40 s.
   - Expect: both filed, the run `passed`, and no "did not finish".
   - Before the fix: the ticker stopped it after 1 issue.
5. **wave 2b final review m1: a session start checks a blocked post record whose PR merged on GitHub, and archives it.**
   - Setup: a post+blocked record, the PR MERGED, and issue #21 closed.
   - Expect: the session start reopens #21 and archives the record.
   - Before the fix: nothing happened.
6. **wave 2b final review m5: a gh spawn that fails after GitHub took the merge tells the agent the issue check did not run.**
   - Setup: the merged-PR read throws.
   - Expect: the merge is not held, the last prompt says the issue check did not run and to run /pr-gate, and the record stays ready.

`tests/world.ts` has one test-only addition: `gh.isMergedReadBroken` makes `gh pr view … --json number,headRefName,state` throw.

No existing test was changed.

## Checks

- `npm run lint`: clean.
- `npm run typecheck`: 0 errors.
- `npm run test`: codex-gate 22 pass, 0 fail. pr-lifecycle 625 pass, 0 fail (619 + 6 new), 189 s.

## Concerns

- In the Important 1 post-waiver case the agent gets one message: the waive command's own. If that note were superseded (a reset while it gathers the standing), the reset's own note is what the agent gets, as before.
- The filing-pass stamp keeps the run's phase name (e.g. `verify`). If a single issue's gh calls ever ran past the step timeout (impossible with 3 × 30 s bounds and the 30 min default), the ticker's message would still name that phase.
- The session-start check now costs one `gh pr view` for every post/ready record, not only idle ones.
