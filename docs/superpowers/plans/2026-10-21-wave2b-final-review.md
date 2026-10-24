# Final whole-branch review: pr-lifecycle 1.5.0 (wave 2b)

Range a10a336 → 51d9bff, checkout /home/allisone/Projects/pr-gate-wave2b. Read-only; no tests run (reasoned from code).

Passes made:
1. Spec, plan, ledger, rulings 2b section: what was promised and what was deferred.
2. Run/round machinery (`round.ts`): ticker, mid-turn requeue, collect/poll/rollOver/endCollect, triage, rebuttal check, rounds, `advance`.
3. Decisions (`lifecycle.ts`): charging (A8), links (R90), deferrals and issues (R92), `decidePost`/`awaiting`, gate grants.
4. Filing and close (`round.ts` `fileIssues`, `checkIssuesAfterMerge`, `closeLifecycle`/`closeOnce`) and merge wiring (`register.tsx` `onMerged`, tool hook, session start; `core.ts` `mergeStep`, `reportPrompt`).
5. Each ledger deferred minor re-checked against the head.

## Strengths

- Generation/A6 guards are consistent: every write after an await re-reads under the lock and drops itself on a reset, fresh lifecycle or archive (`isMovedFrom`, `save` in `fileIssues`, `closeOnce`).
- gh calls are bounded (30 s timeouts) and fail closed: a hang becomes a recorded failure the agent sees, never a wait.
- Filing results persist per POST with their log line, so an issue GitHub has is never filed twice; refile happens only on GitHub's own "Could not resolve to an issue" text; A7 label verification keeps the issue and relabels instead of refiling.
- Links never chain, cycles across a batch are rejected, and a link raises the target's severity/peak/security (`withLinkedPeak`) with a recheck when an accepted rebuttal or agreed deferral is raised to P0/P1 or security: no severity is lost through dedup.
- Lost peak files as P1 (`filingPeak`); security never files, it waits for the person: matches owner rule 4.
- `closing` set guard plus `MERGE_UNCONFIRMED` keep a merge from archiving past an unconfirmed issue check (rule 2).
- #24/A5 push-time handling: arrival read from GitHub's activity log, re-read before a comment-only coverage ends collection; a guess asks again or counts rather than waiting forever.
- R89 `collectionDone` (`github.ts:310-340`) is bounded on every path:
  - A known required check that has not reported stays missing until the cap.
  - An unreadable required list (`'unknown'`) or requested list falls back to the reported checks plus the quiet window, then the cap.
  - An early end drops no hold: the merge standing re-reads CI (R86), and later feedback goes to late triage.
- A8 bounds advisory churn: any agent-reported fix charges the round; linked duplicates excluded.

## Issues

### Critical

None found. I found no path where the gate waits on nobody with no prompt at all, and no path that archives or allows merge past an unconfirmed finding or issue.

### Important

1. **A filing pass that hits a waiver or a refused grant ends the lifecycle in the wrong state, and only a manual resume picks it up again** (`round.ts:3086-3102`, `round.ts:3133-3135`, `round.ts:3140`; `advance` `round.ts:2932-2935`; `lifecycle.ts:1190-1207`).
   - What's wrong:
     - *Grant path.* When the lock read shows a new waiver, or `gateGrant` returns undefined, `fileIssues` hands back the record with no grant. `advance` decides once from it and never runs `planIssues` again. A record that needed a gate round (late blocker) ends `exhausted`: the person is told "a new round needs their allowance", although the gate would grant it on the next pass.
     - *File path.* A waiver landing between gh calls makes the loop `return current`. Any remaining fileable items are left unfiled, and `decidePost` → `awaiting` returns `blocked` "… wait for their GitHub issue", with nextStep "nothing to change: the gate files them (/pr-gate resume)".
     - Nothing re-runs the pass by itself:
    - The pass runs inside `endRound` → `advance` while the run is still `running` (`round.ts:2855`).
    - The person's `/pr-gate waive` advances only when no run is going (`register.tsx:993`, `!isRunning`), so their waiver does not re-run it.
    - Session start ignores `post`+`blocked`, and the ticker has no step for it.
   - Why it matters:
     - Owner rule 3: a forced manual `/pr-gate resume` that the spec does not call for.
     - The *exhausted* variant also sends the person a wrong "needs your allowance" message: a needless waiver/allowance cost and a misleading reason.
     - The window is narrow (the seconds of gh calls, or the gap between `advance`'s load and the lock), but it opens exactly when the person is acting (waiving).
     - It is not stuck, because the agent is shown "(/pr-gate resume)". That is why it is Important, not Critical.
   - Fix: when `fileIssues` returns a record whose `waivers` grew, or whose `planIssues` is still non-empty, re-enter `advance` from the top once (bounded to 2 passes).
     - Re-entering from the top also covers a *post* waiver landing mid-pass. `advance` checks post waivers only before `fileIssues`, and `decideNext` never sees them, so a `fileIssues`-only loop would miss that case.
     - Add flow tests for: a waiver mid-pass with ≥2 fileable items; a refused in-lock grant; a post waiver mid-pass.

### Minor

1. **Session start skips the §5.12 check for post records that are not idle** (`register.tsx:1300-1313`).
   - What's wrong: only `ready`+MERGED and `post` with `postStatus` undefined/`error` are checked. A `post`+`blocked` record (including `MERGE_UNCONFIRMED` after a failed issue check) whose PR was merged elsewhere is not closed until someone runs `/pr-gate`.
   - Why it matters: the spec lists session start as a §5.12 trigger. It is not stuck (the pane and `/pr-gate` show it), but it is babysitting.
   - Fix: run the MERGED/CLOSED check for any `post`/`ready` record with a `pr`, and keep `advance` only for undefined/`error`.
2. **Ticker race during the `rollOver`/`endCollect` tail** (`round.ts` ticker ~693-756, `closeCollect`).
   - What's wrong: `closeCollect` clears `collect` but leaves phase `collect`. A tick in the tail measures the step timeout from the old `phaseStartedAt`.
   - Why it matters: only when the roster's `waitCapMinutes` ≥ `stepTimeoutMinutes` (30). Defaults (20) are safe. The result is a wrong "collect step ran past" stop and a resume.
   - Fix: set `phaseStartedAt = now` in `closeCollect`, or reject roster caps ≥ the step timeout at config read.
3. **The filing pass runs under the previous step's timeout clock.** The ticker can `holdPost` "Codex check did not finish" in the middle of filing when the verify phase started ~30 min earlier. The message is wrong and a resume is needed. Fix: stamp `phaseStartedAt` at the filing pass start.
4. **A merge without a PR number** (`gh pr merge -d` with no number; `onMerged` `gh pr view` in cwd, `register.tsx:811-840`).
   - What's wrong: `-d` switches to the base branch, so `view` fails silently, and session start then reads the base branch and finds no record.
   - Why it matters: unlikely, because `mergeStep` always gives the number. The fallback is `/pr-gate`.
   - Fix: parse the number from the merge output, or take it from the record of the branch the command ran on.
5. **`onMerged` failing before `closeLifecycle`** (a git/gh spawn throw) only shows a toast. The agent is not told the issue check did not run. Fix: `say` a short line telling it to run `/pr-gate`.
6. **An error in the `onMerged` catch replaces the original.** A `say` that throws inside the catch hides the original error. Fix: wrap it in its own try.
7. **The merge tool result is held through `checkIssuesAfterMerge`.** It is bounded (30 s × gh calls × findings), but a long hold with many findings looks like a hang. Acceptable; consider a toast "checking N issues".
8. **A final-head check's collection is ended by a mid-turn push** (R88). Codex never reviews that head, and `decidePost` gives `exhausted` → person. The outcome is the same as 1.4.0 for a fix after the final-head review, and the plan accepted it (plan ~1793). Noted only.

## Deferred-minor verdicts

**Task 1**
- TAG misses em dash / "Severity: P1" / "Priority: P0": still real, Minor. Untagged findings fall back to Codex severity; nothing is lost but precision.
- Test loop gaps (labels, no P0, lowercase, badge): still real, Minor (coverage only).
- Duplicated regex: still real, Minor (maintenance).

**Task 2**
- History copy on a no-op answer: not real harm. It is cosmetic churn in the log; acceptable.
- No mixed ack+rebuttal recheck test: still real, Minor (coverage).
- async without await: acceptable (lint-level).
- Rejection wording untested: still real, Minor.

**Task 4**
- `toMatchObject` weakens the #24 asserts: still real, Minor (tests only).
- `beginCollect` records asks but doesn't read them: acceptable. They are read by `guessCover` and `askAgain` later.
- `noteArrival` same-head concurrent overwrite: acceptable. Both writers set the same head's arrival from the same activity log.

**Task 5**
- Log flood "could not read requested reviewers/commit statuses" every poll: still real, Minor. It drowns `/pr-gate log`; dedupe per head.
- No test for a context that is both a running check run and a final status: still real, Minor.

**Task 6**
- `isCharged` doc: acceptable (doc wording).
- No flow test of a clean discretionary round leaving `remaining` unchanged: still real, Minor.
- `isRejected` looks only at the entry before: acceptable. Rejections are appended in order per round.

**Task 6b**
- Late/answer-run fixes never charged by A8: still real, Minor. It can extend churn by one round, bounded by GATE_ROUNDS/allowance.
- Label wording after an un-ruled raise: Minor, cosmetic.

**Task 7**
- `rejections` counts a refused link: not real now. It was addressed later in the branch (refused links are excluded).
- `triagePrompt` "earlier answer" misses the same-batch original: still real, Minor (prompt clarity).
- No pointer reply enforced on a gate-linked item: still real, Minor. GitHub thread hygiene only; the hold is still kept.

**Task 8**
- `afterTriage` first patch doesn't check status after a stop: acceptable. A later guard drops the write on a status/generation change.
- Ticker `isSettling` early return relies on the poll: acceptable. The poll runs every 30 s, and the step timeout still applies.
- An r{n}-triage marker written directly would reopen late-start: not real. No code path writes it outside `beginTriage`.

**Task 9**
- (1) `isFirstPoll` counts a poll that threw → an extra empty round on an adopted PR: still real, Minor. A fetch failure stops the run anyway, so only a throw after the fetch costs one quiet round, with no hold lost.
- (2) Ticker race: still real, Minor. Only with roster `waitCapMinutes` ≥ 30; see Minor 2.
- (3) Untested rollover→`checkRebuttals`, `diffBase` after rollover, the log line; a nominal two-pushes test: still real, Minor (coverage).
- (4) `rollOver` tail has no generation check: Minor. The later writes go through generation-guarded updates, so a reset mid-tail loses no hold.

**Task 10**
- No test for a reviewer-less roster: still real, Minor.
- No test of a reset between `isOwn` and the tail guard: still real, Minor.

**Task 11**
- A refused deferral ignored after `markHeld('pr-gate')` loses the "Codex says…" line: still real, Minor. The agent loses Codex's reason but still sees the hold.
- `deferral-unchecked` on a pre record with a post waiver: acceptable. The post waiver covers that head.
- Stale comment ~3119: Minor (doc).
- "fix or rebut" wording omits defer-again: Minor (prompt).
- Shadowed `last`: Minor (lint).
- Pane shows an owed deferral as "— deferred": Minor (display).

**Task 12**
- (1) A waiver mid-pass or a refused in-lock `gateGrant` ends `exhausted` without the gate round: still real, **Important** (Important 1).
- (2) ≥2 fileable items + a waiver mid-pass ends `blocked`, and nothing re-runs filing: still real, **Important** (Important 1).
- No flow test that the merge guard holds while an issue is owed: still real, Minor.
- No missing-repo flow test: still real, Minor.
- A reused agent issue is not checked open, and its body lacks the gate text: still real, Minor. A closed issue would count as the follow-up until §5.12 checks it at merge, so the hold is kept then.

**Task 13**
- The waiver note "gate has just sent you the merge step" assumes `advance`'s say ran: still real, Minor. If `advance` decides otherwise, the note misleads for one turn.

**Task 14**
- task-14-report stale: Minor (ledger only).
- Long test lines: Minor (style).
- Load re-check owed: acceptable. `loadRecord` is re-read at each guarded write.

**Task 15**
- M4 post+blocked not rechecked at session start: still real, Minor (Minor 1).
- M5 A6 assertion vacuous / `closeLifecycle` guards untested: still real, Minor (coverage of a correct guard).
- M6 merge Bash result held through the check: acceptable/Minor (Minor 7).
- Merge without a number: still real, Minor (Minor 4).
- A poll-initiated close that throws after a merge doesn't tell the agent: Minor. The ticker swallows the error, the run stays running, and the next poll retries. `closeOnce` catches check throws itself, so only a store/say failure can throw, and that is retried, not silent-stuck.
- A say throwing in the `onMerged` catch replaces the original error: still real, Minor (Minor 6).

## Declined to judge

- Exhaustion with reported-fixed (verify-owed) findings goes to the person, not to filing: the spec §5.2 lists only open/deferred/disputed/rejected-fix as fileable. Per spec.
- `issueError` filing failures need a resume: spec §5.7 says the agent is told and checks; it is told (`issueRelease`).
- GATE_ROUNDS = 2 and the "scope may be too wide" wording: a ruling (R92), not code.
- Security findings never filed and waiting for the person: owner rule 4, as specified.
- The quiet window applies only without signals (R89): a design choice per spec.
- `waitCapMinutes` with no upper bound vs the step timeout: covered under Minor 2. Whether to cap it is a config-policy call.
- The ChatGPT reviewer task posting as Adam's login is not counted as coverage: per CLAUDE.md/R76, out of scope.
- pane.tsx layout details beyond the deferral label: not read in depth; display only.
- github.ts `severityHint` internals: skimmed only; covered by the ledger's task reviews, with no flagged doubt.
- Docs (README/ROADMAP/rulings prose): not reviewed line by line; version lines left to the release checklist.

## Recommendations

1. Fix Important 1 with a bounded re-plan loop in `advance` (covers both the grant and file variants), with two flow tests.
2. Widen the session-start §5.12 check to every post/ready record with a PR (Minor 1). It is cheap and removes a babysitting case.
3. Stamp `phaseStartedAt` in `closeCollect` and at the filing pass start (Minors 2–3). One-line fixes that close the step-timeout false stops.
4. Dedupe the per-poll "could not read …" log lines per head (Task 5).
5. File the remaining Minors as one follow-up issue (tests: A6 guards, missing repo, merge guard while an issue is owed, two pushes).

## Assessment

Ready to merge? With fixes
