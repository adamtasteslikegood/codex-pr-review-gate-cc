# Task 5 report: collection ends on GitHub's signals (R89)

Status: DONE. Commit: c4938b2.

## What changed

- `hooks/github.ts`: `CollectInput` gains `requested?` and `required?` (absent = `'unknown'`: every reported check stands in).
  `collectionDone` waits for required checks (a completed run on the head), pending review requests (a review of the head) and
  the roster; the quiet window only applies when none of the three exists; the cap always ends collection. New
  `readRequested(text, self)`: users only, own login and teams dropped, unreadable text lists none. `postsFor` was already above
  `collectionDone`, so no move was needed.
- `hooks/round.ts`: `Fetched.requested`; `fetchFeedback` reads `pulls/<n>/requested_reviewers` as a fifth read (a failed read
  fails the poll closed, like the other four); `pollOnce` reads `requiredChecksOf` (R86, cached 5 min) before `judge()` and passes
  `requested` and `required`. All Task 4 behaviour kept: `noteArrival`, `guessCover`, `seenAt`, the pre-end `latestPushOf` re-read
  (it calls `judge()` again, which now carries the new inputs), the cap.
- `tests/world.ts`: `w.gh.requested` (GET lists these) and `w.gh.requests` (every POST, in order), as briefed.

## Adaptations from the brief

1. **A request is also answered by roster coverage** (`isAnswered` = a review of the head by `postsFor`, or the login appears in
   `covered`). Why: Task 4's `guessCover` re-requests a `requestReview` reviewer via POST, and on real GitHub that reviewer then
   stays in `requested_reviewers` until it submits a *review*. If its reply is an issue comment (which the roster counts as
   coverage), the brief's review-only rule would wait out the cap on a guess, which Task 4 forbids. Unit test in
   `github.test.ts` plus flow test `R89 with #24 (5): ...` (GitHub keeps alice requested after the POST; her comment ends collection).
2. The brief's `isReviewed` was renamed `isAnswered` to reflect (1).
3. Existing tests that counted `w.gh.calls` matching `requested_reviewers` (flow.test.ts #24 (5), (5b), (17); settings.test.ts
   junie test) now assert on `w.gh.requests` (POSTs only), since every poll now also GETs that endpoint. Same intent.
4. `R79: a post-PR hold prompt lists CI next to the findings`: its running check would now hold collection (unknown required =
   every reported check). Set `w.gh.required = []` so it still tests the prompt listing a running, non-required check.
5. One brief test line exceeded 160 columns; split into a `quiet` const.
6. Added one extra flow test: without a roster, a completed required check ends collection with no quiet wait while a
   non-required check is still running.

## Checks

- `claude plugin test pr-lifecycle`: 534 pass, 0 fail (527 before + 7 new).
- `npm run lint`: clean. `npm run typecheck`: exit 0.

## Concerns

- The `requested_reviewers` GET adds one API call per poll; a failure of it fails the poll closed (consistent with the other
  reads, but a new way for a round to stop on gh trouble).
- With unknown required checks, any reported check that never completes (an app's run left `in_progress`) now holds collection
  until the cap. Spec §2 says "every reported check when it is unknown", so this is intended; suites are never read.
- A requested *team* is ignored (cannot be matched to a login); spec doesn't cover teams.

## Fix round 1

1. `isAnswered` (github.ts): coverage answers a pending request only with a roster (`hasRoster && covered.some(...)`); without
   one, only a review of the head does. Test: a no-roster inline comment on the head does not answer alice's request.
2. A failed `requested_reviewers` read no longer stops the round: it is left out of `bad`, `requested` is `[]`, and the log says
   `could not read requested reviewers: <gh words>`. World knob `w.gh.isRequestedBroken`; flow test: the read fails, the round
   ends by the roster, and the log line is there.
3. Pre-existing: `readInlineComments` takes `original_commit_id` (the commit the comment was written on) as the head, falling
   back to `commit_id`. The flow fake's `inline()` rows carry `original_commit_id`. Test: an inline comment written on A whose
   `commit_id` GitHub moved to B reads as A and does not cover B.
4. The flow test for a pending request now keeps `w.gh.requested = ['alice']` while her review of the head answers it. New flow
   test: with the rules endpoint failing (required checks unknown), a reported `preview` run that is still going holds collection
   until it completes.
5. Lines over 160 columns that this task added are wrapped (test titles shortened; code lines split).
6. (Coordinator's added item) Commit statuses: `fetchFeedback` also reads `repos/<slug>/commits/<head>/status`; new
   `readStatuses` turns each `{ context, state }` into a check, completed when `success`, `failure` or `error`, otherwise
   `pending` (not finished). They join the check runs passed to `collectionDone`, so a required context counts as finished from either source.
   A failed or unreadable read falls back to check runs only and logs `could not read commit statuses: ...; check runs only`
   (log kind `check`); the poll never stops on it. World knobs `w.gh.statuses`, `w.gh.isStatusBroken`. Tests: unit
   `readStatuses`; flow: a required context reported only as a status holds while pending and ends collection when it is success,
   with no wait on the cap; flow: a failed status read is logged and check runs decide.

Ruling recorded: team requests are ignored. A team can't be matched to a login, so ignoring it can only end collection sooner,
never hold it.

Note: with required checks unknown, every reported check stands in, and that now includes status contexts, so a status left
`pending` forever holds collection until the cap, just as a check run does.

Checks: `claude plugin test pr-lifecycle` gives 541 pass, 0 fail; `npm run lint` is clean; `npm run typecheck` exits 0.
