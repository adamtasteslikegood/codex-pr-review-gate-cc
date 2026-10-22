# Task 18 report: a merge outside the gate (spec §5.13 items 1-6, A9, R95)

Status: DONE. Commits on `wave2b/pr-lifecycle-1.5.0` (not pushed):
- `1aec7a4` pr-lifecycle 1.5.0: a merge outside the gate files what still holds and is seen without a resume (A9, R95)
- `6887fc0` pr-lifecycle 1.5.0: Task 18, a merge under the person's post waiver files nothing at the merge

## Changes, file by file

### `pr-lifecycle/hooks/lifecycle.ts`
- `mergedLine(pr)`: "PR #<n> merged before the gate finished: no fix round ran on this finding."
- `issueBody(f, rec, isMerged = false)`: when `isMerged` is set, the body carries `mergedLine`, and its "why" fits any status: reported fixed but not verified, verified but re-verify owed, rebutted but not accepted, or still open. A deferral Codex has not ruled on says so ("Codex had not ruled on the deferral"); the normal path files only agreed deferrals, so its text does not change. The footer reads "Filed by pr-gate when #n merged." **The title is never changed.**
- `planIssues(rec, at, spec, isMerged = false)`: when `isMerged` is set, there is no filing-point check and no `gateGrant` (no round can run on a merged PR). The items are `mergeHolds(rec).filter(isMergeFileable)`.
- `isMergeFileable(f)`: not security, and no `followUp` that names an issue. A finding that already names an issue (the agent's R85 issue, or one whose label GitHub dropped) is left to `checkIssuesAfterMerge`, which labels, reopens or refiles it.
- `untrackedSecurity(rec)`: `mergeHolds(rec).filter(isSecurity)`. Task 19 can narrow it to findings without a `jiraTicket`.

### `pr-lifecycle/hooks/round.ts`
- Config: `mergeWatchMinutes` (default 5). It can only be set in the repository file. `overrideConfig` accepts a whole number from 1 to 60; anything else goes to `bad('mergeWatchMinutes', 'not a whole number of minutes from 1 to 60')`.
- `fileIssues($, rec, isMerged = false)` → `fileOnce(..., isMerged)` → `planIssues(..., isMerged)`. The per-branch `filing` guard, the Task 17 duplicate guard (REST list before a retry) and save-as-you-go are all reused unchanged.
- `closeOnce` on MERGED:
  1. Unless a post waiver covers the record's head, a record that has merge-fileable holds runs `fileIssues(rec, true)`.
  2. If that returns `undefined`, the gate reads the record again. If it moved, the close returns `replaced` (A6). Otherwise the filing is a **failed check**: either another pass was in flight or the filing threw. A thrown error is caught, so it never escapes the close.
  3. Any merge-fileable hold left without an issue counts as a failure, with its `issueError`.
  4. `checkIssuesAfterMerge` **always runs too**. If either step failed, the record is blocked.
  5. `untrackedSecurity` also blocks, with the new constant `MERGE_SECURITY` ("merged before the gate finished, with a security finding still holding that no ticket tracks:"). The finding is named, `say` tells the agent to tell the person the exact waive command and never to type it, and a toast goes to the person.
  6. Failures from the filing and from the check share the `MERGE_UNCONFIRMED` message. `isUnblocked` now clears both kinds of message (`isMergeBlocked`, exported).
  7. The archive's "Follow-up issues still open" list also names the issues filed at the merge.
  8. A watcher beat that finds the same failure again (same message on an already-blocked record) does not say it again. A resume, a waiver or a session start still does.
- `checkIssuesAfterMerge`: also covers held, non-security findings with an issue `followUp` (unless a post waiver covers the head). They are read, labelled if the label is owed, reopened, or refiled. On the gate's own merge none holds, so that path is unchanged.
- The merge watcher (`startWatcher`, `watchBeat`, `stopWatcher`):
  - It is a second `$.clock.every` timer, separate from the run ticker, and runs only in interactive sessions.
  - It ticks every 60 s. Each record is read every `mergeWatchMinutes` of its own base's config, read once when the watcher first sees the record.
  - It watches live records under this session's roots that have a PR, are in `ready` or `post`, have no running run in this session, are not owned elsewhere, and are not blocked only on security (only a waiver releases those).
  - On MERGED or CLOSED it runs `claimRecord`, then `holdingPrompts(closeLifecycle(..., isWatch=true))`. A failed read waits for the next beat.
  - It stops itself once no such record is left.
  - It starts at session start (also on the reload branch), when the ready path is reached in `advance`, and at the end of `finish` for a post run.
  - `setup()` resets it after a reload.

### `pr-lifecycle/hooks/store.ts`
- `liveRecords($, root)` lists keys under the prefix `lifecycle:<root>:` whose remainder has no `:`, so `:owner` and `:archived:` keys are left out. It keeps only values with `version === 1`, not archived, whose own key matches.

### `pr-lifecycle/hooks/register.tsx`
- Session start (interactive): for every live record under the root that has a PR and is in `ready` or `post`, and is not owned elsewhere, the gate reads the PR state. If it is MERGED or CLOSED, it claims the record and closes it. Each record is wrapped in its own try, so one failure does not stop the others. The watcher then starts. Advancing the checked-out branch's `post` record is unchanged; that record is read again after the closes.
- `waive <id>`: once the waiver is written, a record that `isMergeBlocked` says is blocked runs `closeLifecycle(..., 'MERGED')` instead of `advance`, so no round runs on a merged PR. When the record is archived, the agent is told, and the reply includes the close's words.

## Tests

The run reported 7 failures without the fix: the hooks were stashed and the new tests run against the old code (636 pass, 7 fail). The post-waiver test was checked the same way against `1aec7a4` (643 pass, 1 fail).

| Test | Spec test | Failed without the fix |
|---|---|---|
| A9: a PR merged on the website while a P2 is open and a P3 deferral waits: the watcher files both, checks them and archives, with no command | 1 | yes |
| A9: a filing that fails at a website merge blocks the record and tells the agent; the next watcher beat files, checks and archives | 2 | yes |
| A9: a security finding open at a website merge blocks the record, files nothing and tells the person; their waiver archives it | 3 | yes |
| A9: a ready record merged on the website is closed by the watcher within mergeWatchMinutes, and §5.12's check runs | 4 | yes |
| A9: a session started on another branch closes a merged record of a branch not checked out; one owned by a live session elsewhere is left alone | 5 | yes |
| A9: a watcher read that fails is no stop: the next beat closes the record | 6 | yes |
| R95: mergeWatchMinutes … 0, "x" or anything outside 1-60 is ignored with the usual warning (settings.test.ts) | 7 | yes |
| A9: a PR merged under the person's post waiver for its head is no merge outside the gate: nothing is filed | (added) | yes, against `1aec7a4` |

The tests put findings on the record (`toHolding`) after `toFiled` rather than driving them through rounds. They merge "on the website" by setting `w.gh.state = 'MERGED'`, with no `gh pr merge` call and no `/pr-gate` command, and advance `w.clock` by 5 minutes.

## Results
- `claude plugin test pr-lifecycle`: **644 pass, 0 fail** (from 636).
- `npm run lint`: clean. `npm run typecheck`: 0 errors. `npm run validate`: passed. Validate repeats its existing advisory about the README having no marketplace install line; that predates this task.
- `claude plugin test` ran in this process. On the first try it printed nothing, after a timeout.

## Concerns
- **The `waive post` path (decision taken here, not in the brief).** `waivedIds` holds only finding waivers, so before the follow-up commit a merge under `waive post` would have filed every waived-through finding as "merged before the gate finished". Now a post waiver that covers the record's head skips the merge-time filing (spec §5.4: a whole-head decision), so the ready and post-waiver paths behave as before. Security still blocks, since `waive post` never releases it. If Adam wants issues filed for those too, it is a one-line change, but the body would then need different wording.
- `mergeWatchMinutes` is read once per record when the watcher first sees it, so a change to the file takes effect when the watcher next starts. The watcher wakes every 60 s, so a record is read within one minute after its minutes are up.
- `claimRecord` in the watcher and the session-start scan resets the module's `beatAt`. That can delay a running run's ownership re-check by up to 30 s. This is harmless while the stale limit is 120 s.
- A record blocked on `MERGE_UNCONFIRMED` is retried on every watcher read (an issue list plus a POST every 5 min while gh is down). That is intended (§5.13.3), and a repeated failure is not said again.
- `/pr-gate waive <id>` resolves the checked-out branch, so a security-blocked record of another branch must be waived from its own checkout.
- Docs: the README's `pr-gate.json` key list and sample don't mention `mergeWatchMinutes`. That file is outside this task's list, so it is left for the docs task.
- No disagreement found between the brief and the spec. §5.13.2's Jira ticket is Task 19, through `untrackedSecurity`.

## Fix round 1 (task-18-review.md, controller rulings)

Commit `ab3dd86` (pr-lifecycle 1.5.0: Task 18 review fixes).

1. **Post waiver.** `isPostWaivedHead` is removed. A merge under `/pr-gate waive post` now files, at the merge, an issue for each non-security finding still holding. This covers a website merge and the agent's own `gh pr merge`, since both go through `closeOnce`. `lifecycle.ts` adds `MergeKind = { kind: 'outside' } | { kind: 'post-waiver'; reason }`, which is threaded through `fileIssues` → `fileOnce` → `planIssues` → `issueBody`/`mergedLine`. Under a post waiver the body says "PR #n merged under the person's post waiver (/pr-gate waive post): <reason>. No fix round ran on this finding." The title is unchanged. In `checkIssuesAfterMerge`, `held` no longer has the post-waiver exception, and its comment is updated. The post-waiver test is flipped: it now expects 2 POSTs, checks the title and the waiver line in the body, and checks the archive. No existing waive-post-then-merge test reached a close with fileable holds, so none needed updating (the suite passes unchanged).
2. **Per-finding waivers are not filed.** `waivedIds`'s doc comment says so. A test covers a finding waived before a website merge: it gets no issue.
3. **Stale security block.** The security list and the block message are now computed inside the `updateRecord` updater, from `latest`, after the check's writes (`untrackedSecurity({ ...latest, findings })`). If nothing is left, the same write clears an earlier merge block and the close archives. `isSecurityOnlyBlocked` is now decided from state: `isMergeBlocked`, no `MERGE_UNCONFIRMED`, and `untrackedSecurity(rec).length > 0`. New test: the first close blocks on an unreadable #21 plus a security finding. During the next close's `gh issue view`, the person's `waive G2-5` lands and its own close answers "already closing". The in-flight close then archives the record with no message and no resume.
4. **Waive from another branch.** `securityBlockedIds(rec)` is exported from round.ts. If the checked-out branch has no such finding, `/pr-gate waive <id>` looks at `liveRecords(root)` on other branches for records merge-blocked with `MERGE_SECURITY` on that id. With exactly one, it waives there and runs the close. With several, it names their branches and waives none. The block message and the agent's instruction now name the branch ("PR #1 from feat/x merged before…", "the lifecycle of feat/x stays open on …", "from any checkout of this repository"). The new test covers both legs.
5. **Minors.**
   - `isRepeat` now compares a per-record signature kept in a module map, `blockSaid`. The signature is the generation, the leading id or phrase of each failed entry, and the security ids. A changed gh text is not a new block. The entry is cleared when the close passes.
   - The watcher stays alive while a record is skipped because its run is running or because another live session owns it (`isWaiting`).
   - Test 5 sets `beatAt` from the engine clock's now. It is extended so that, once the other owner goes stale, the next beat archives feat/z with no command.
   - New tests:
     - a second and a third session start leave one watcher, checked by `:owner` reads per minute against the first minute;
     - a merge close that meets another filing pass of the branch: the session-start scan during the pass's POST reports "another filing pass was running", the watcher then archives, and 2 POSTs means nothing is filed twice;
     - the watcher skips a running triage run's record (no `pr view --json state`), and archives after `/pr-gate stop`;
     - a repeated block (POST failing twice) is said once.
   - The toast is not asserted: the world doesn't record toasts.
6. **README:** left for the docs task.

Against the pre-fix hooks, these new or changed tests fail: the post waiver, review I1, review I2, the security block's wording, and test 5's owner-goes-stale leg. The minor-coverage tests pass on both versions, since they guard existing behaviour.

**Results:** `claude plugin test pr-lifecycle` gives **651 pass, 0 fail**. `npm run lint` is clean and `npm run typecheck` has 0 errors.

**Concerns:**
- `blockSaid` lives in memory, so a reload or a new session says a block once more. That is intended: a session start says it.
- The always-written merge-close update now runs even when the check changed nothing. It is harmless, because the record is archived right after.
