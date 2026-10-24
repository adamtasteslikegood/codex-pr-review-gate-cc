# Task 4 report: a head's time is when it reached the PR (#24, spec §7.4, A5)

Status: DONE_WITH_CONCERNS (concerns are judgement calls, listed below; nothing is failing).

## What was built (A5, plus the coordinator's two mid-task changes)

Steps 1-3's check-run start and commit-date arrival were not built (no `Check.startedAt`, no `headArrival` from checks).

- `types/index.d.ts`: `LifecycleRecord.headArrival?: { head; at; isPushTime; asked?; counted? }`.
  `asked` (requestReview names asked again for this head) and `counted` (comment ids counted on a guess) are additions
  beyond the brief's type. They make "once per head" and "log once" hold across polls, stop/resume and sessions. They reset
  on their own when the head changes.
- `round.ts`:
  - `pushesOf`: `gh api repos/<repo>/activity?ref=refs/heads/<branch>&per_page=100`, with the JSON parsed in TS (no `--jq`).
    It returns undefined on any failure, throw or unparseable answer.
  - `pushTimeOf(rec, head)`: the **latest** push into the head (handles A→B→A).
  - `latestPushOf(rec)`: the branch's newest push, whatever its sha (the coordinator's second change).
  - `noteArrival(root, branch, head, fallback)`: writes `headArrival`. GitHub's push time wins, clamped to never later than now, and replaces a stored time in either direction. That follows the coordinator's change 1: the "never moves later within a collection" rule is dropped. Otherwise the stored time is kept for the same head. Failing both, the time is first-seen (`fallback`). A stored arrival for another head is never reused.
  - Callers of `noteArrival`:
    - `onOpened` (register.tsx).
    - Every `beginCollect`: it always reads GitHub again, which covers test 9, and it sets `collect.headAt`.
    - `pollOnce`, when the head is new or not stored, or when the stored time has `isPushTime: false`. That is one try per poll.
  - `pollOnce`: `headAt` comes from the record's `headArrival` for the PR head.
  - The "no silent wait on a guess" rule is in `guessCover`. It applies when the push time is unknown and a roster reviewer's issue comment falls in the window from the committer date to `headArrival.at`:
    - If the reviewer is in `requestReview` (matched with `postsFor`, now exported), the gate sends one `requested_reviewers` POST per name per head. That is the same POST `beginCollect` makes, now factored into `askAgain`. The log line is `<login>: comment at <time> may predate <head7>; asked again`.
    - Otherwise the comment counts: it is placed on the head for `collectionDone`. The log line is `... counted for <head7>; GitHub gave no push time`.
    - The commit-date lookup runs lazily, only while an unhandled comment is in doubt.
  - Before a poll ends collection on coverage that rests on an issue comment with no commit, it reads `latestPushOf` (coordinator change 2):
    - The newest push is this head and later than `headAt`: `headArrival.at` and `collect.headAt` move to it, and coverage is judged again on the same poll.
    - The newest push is another head: collection does not end, and the next poll takes the new head. This holds only within the wait cap, so a mismatch that never resolves cannot stick the gate.
    - The read fails: the stored time is kept and collection ends. The log notes `could not read when <head7> was last pushed; ...`.
    - Reviews matched by `commit_id` trigger no re-read.
  - `fetchFeedback` now asks `gh pr view` for `headRefName,headRepository,headRepositoryOwner` too. This lets a fork PR's push times be read from the fork (`Fetched.where`).
- Reset and fresh start: `headArrival` carries over **only when it names the same head**:
  - `archiveLifecycle`'s seed carries it when it names `last.head`;
  - register.tsx's fresh start carries it when it names the new head.

  Any other head is looked up afresh.
- `tests/world.ts` gains these knobs:
  - `gh.pushes`: the activity log. Only the `headRef` branch has entries.
  - `gh.isActivityBroken`.
  - `gh.commitDate`: the committer date, used only as the window bound.

## Tests

`tests/flow.test.ts` has 14 new tests: A5's 1-9 and 5b, the coordinator's 10 and 11, and its 12 and 13. Tests 1, 2 and 4-11 failed before the implementation. Test 3 is a regression guard that passed before too. Tests 12 and 13 were added after the `latestPushOf` re-read existed, so they were never seen red. They still test it: without the re-read, the comment at 25 s is at or after headAt (10 s) and ends collection.

Full suite: **523 pass, 0 fail** (509 before). `npm run lint` and `npm run typecheck` are clean.

## Judgement calls and concerns

1. **Unknown committer date**: when the commit lookup fails, the window has no lower bound (0), so the gate can't get stuck. As a result, any older comment by a roster reviewer the gate cannot ask counts. That needs both the activity call and the commit call to fail.
2. **`beginCollect` and `onOpened` read `rec.slug` and `rec.branch`**, not the PR's head repository. For a fork PR they fall back to first-seen. The polls, which know the fork from `gh pr view`, then find the real push time. The pre-end `latestPushOf` re-read uses the fork too. If gh gave no head repository, a fork PR's base-repo branch of the same name could report another sha. Collection then waits for the next poll, but never past the wait cap.
3. The activity call reads one page of 100 entries. A head pushed more than 100 branch activities ago reads as unknown and falls back to first-seen.
4. The rulings this brief asks to record (the push time is GitHub's activity log; first-seen is only the fallback; an ambiguous comment gets a re-request or counts) were **not** added to the rulings doc. That is left for the rulings task (spec §8).
5. The coordinator's doc changes (0a76163 and the next commit on docs/wave2b) were not merged here, as instructed.
6. `pushesOf` does not filter on `activity_type`. A `branch_creation` row is a real arrival. A `branch_deletion` row (after `000…`) never matches a head, but `latestPushOf` can return it as the newest push. That reads as "moved" for one poll, until the poll sees the PR closed. Harmless.
7. `gh pr view --json headRefName,headRepository,headRepositoryOwner` was checked against live gh on PR #25: the fields exist, `headRepository.name` and `headRepositoryOwner.login` are present, and `npm run validate` passes.

## Fix round 1

Important:
1. **A lower bound for the guess window.**
   - Each poll that sees the PR head writes `headArrival.seenAt`.
   - When `noteArrival` replaces an arrival stored for another head, the new one gets `since = max(old.seenAt, old.at, old.since)`. This is the last time the gate saw the old head on the PR. `seenAt` is a superset of the suggested `collect.polledAt`: it also survives across runs, for example a round 1 that ended ready before round 2 started.
   - `guessCover`'s window now starts at `max(committedAt ?? 0, since ?? 0)`.
   - Test 14 covers round 2 with the activity log broken and no commit date. Round 1's roster comment is not counted, the round waits, and the cap ends collection, after which Codex covers the head.
2. **The world fake now answers `headRepository`, `headRepositoryOwner` and `isCrossRepository`.**
   - It has a `gh.forkOwner` knob.
   - The activity fake checks the repository in the URL path.
   - Test 15 covers a fork PR: the push is only in `forker/repo`'s log, and the head's time comes from it. The record keeps `headPlace`.

Minor:
1. `fetchFeedback` persists `LifecycleRecord.headPlace { repo, branch, isCrossRepository }`.
   - `pushesOf` (and so `beginCollect` and `onOpened`) uses `pushPlaceOf`: gh's word from this poll, then the record's, then the slug and the branch.
   - A cross-repository PR whose head repo is unknown reads no log, so the pre-end re-read is skipped.
2. `pushesOf` keeps only rows whose `activity_type` is `push`, `force_push` or `branch_creation`, and drops all-zero `after` shas. This closes the old concern 6.
3. `beginCollect`'s requestReview asks are added to `headArrival.asked` for the head.
4. Guarded writes:
   - The `noteArrival` write applies only when the stored arrival is still the one read: it is absent, or it names the head that was read or this head.
   - The pre-end re-read applies only when the stored arrival is absent or names the PR head. It keeps `since` and `committedAt`.
5. The committer date is cached as `headArrival.committedAt`.
6. Tests 16 and 17:
   - 16: while the log's newest push stays on another sha, the wait cap ends collection on the "moved" path.
   - 17: `asked` persists across stop and resume, with no second POST.

Other changes:
- The world's engine stand-in now has a `store`, because `fetchFeedback` writes `headPlace` and `untriagedFeedback` (R91 test) runs through it.
- The `headArrival` assertions use `toMatchObject`, since `seenAt` changes with each poll.

Result: 527 pass, 0 fail. Lint, typecheck and validate are clean.
