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
