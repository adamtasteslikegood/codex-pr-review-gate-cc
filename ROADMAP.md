# Roadmap

How pr-lifecycle moves toward the goals in [VISION.md](VISION.md). The work
comes in waves, one PR each. Each wave fixes what the previous live run showed,
and the next live run checks it.

Sources:
- [Discussion #15](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/discussions/15),
  with findings 1-29 from the first live runs (cookbook PRs #3705-#3707,
  2026-10-17). Finding numbers below refer to it.
- Issues [#13](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/issues/13)
  and [#14](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/issues/14).
- [HANDOFF-2026-10-17-gate-fixes.md](HANDOFF-2026-10-17-gate-fixes.md).

**Guiding fact:** a Codex review takes 1-2 minutes. A round's time goes to
waiting: on slow reviewers, and on the person to resume, allow or waive. Each
wave moves work onto Codex and the gate, and away from the person.

## Decisions made (Adam, 2026-10-17)

Each change to an existing ruling is recorded in the rulings doc as R71 or
later when it is implemented.

| | Decision |
| --- | --- |
| A | Fixes are verified by a **dedicated Codex verification pass** each round, run by the gate itself. It is not left to the review sub-agent's extra step, and a clean review doesn't count as verification. The pass uses no round. |
| B | Dropped. pr-lifecycle doesn't hold the PR from opening the way codex-gate did, so `judgeCreate` stays as it is. |
| C | The light lane gets **3** rounds (it was hard-coded to 1). |
| D | A new **interactive** session takes over a record automatically once the owning session has been quiet for **2 minutes**. Headless (`-p`/SDK) sessions never take over. |

## Decisions made (Adam, 2026-10-20)

For wave 2. Recorded as rulings R79 or later when implemented.

| | Decision |
| --- | --- |
| E | **Every manual action tells the agent.** `waive pre\|post\|<findingId>`, `allow`, `stop`, `reset`, `resume` and the pane's buttons each end with one short message to the agent: what the person did, what still holds, and its next step. |
| F | **Early triage, push as it goes.** Findings already in go to the agent while slow reviewers finish, and it pushes fixes right away. |
| G | **Each push is its own round** (own head, evidence and log line), but a round is **charged against the allowance unless it comes back clean**. It is charged when it raises a new blocking finding, and also when Codex rejects a fix or a rebuttal: a rejected fix is a used round. Only a round that verifies its fixes and finds nothing new is free, so a fix loop that keeps failing still runs out of rounds and ends in the usual exhausted hold, which tells the person why the PR isn't ready. |
| H | **Reviewers are re-requested once per burst**, on the head the agent's triage turn ends on. The gate's Codex pass covers the heads in between. |
| I | **A P3 answered "no change needed, follow-up recorded"** (with where) settles without a waiver. P1/P2 deferrals and security findings still need one. Holds show the triaged severity. |
| J | **Approvals settle on their own** only on positive no-action evidence, never on missing tags: an APPROVED review, or a COMMENTED one whose body says there is nothing to act on ("no actionable findings", "no blocking findings", "LGTM") and asks for no change. Inline comments are triaged on their own, even on an APPROVED review. Anything else, including an untagged comment, goes to the agent, which replies in its thread. Its new "no change needed" answer is checked by Codex as a rebuttal is (every unresolved thread gets a reply and/or a fix, as Adam's PR guidance and tool-use hooks required before the gate existed). (Narrowed by review G2-2 on PR #19: an untagged actionable comment would otherwise be lost.) |
| K | **`waive post` covers rostered checks GitHub doesn't require**, pending, failing or cancelled, and names each one it sets aside. Required checks still have to pass. |
| L | **Wave 2 ships as two PRs:** 2a (1.4.0, the small fixes) first, then 2b (1.5.0, the round changes). |

## Decisions made (Adam, 2026-10-28)

After 1.5.4. Recorded as rulings when implemented.

| | Decision |
| --- | --- |
| M | **The gate is off by default for now.** `enforce` and `enforceMerge` are off in Adam's settings, and the Codex models and efforts are set per repo, so the gate no longer holds other sessions' work. |
| N | **Separate the powers.** Rounds and sub-agents see only their own slice, so they keep finding reasons to hold. Three parts take over from growing regular expressions: **(1) a shared store**, one Durable Object per PR that every party reads and writes (#29 Part B), the record of what was found and what holds; **(2) a validator**, an agent that judges the gate's PASS or HOLD and whether every finding is tracked, reading the PR, its comments, the store and the issues, never the code (#33), that is, it judges the judgements; **(3) a conductor**, which runs the train and keeps each PR moving. The regex filters stay as the validator's inputs, not the last word. |
| O | **Order:** the store seam first (a refactor with no behavior change), then the Durable Object prototype, then the validator, then the conductor. |

## Wave 1: no errors, no babysitting the basics (pr-lifecycle 1.3.0)

**Status:** built on `wave1/pr-lifecycle-1.3.0` (rulings R71-R78). Not built: a
pre-PR verification pass (R72 leaves pre-PR as it was, so opening the PR is
never delayed), and finding 21's approvals, which moves to wave 2 item 2.

Serves goals 1 and 2. Fixes what broke runs or forced the person in for
routine steps.

1. **One session runs each record (#13; findings 18, 15).**
   - **Problem:** at startup, any session whose folder and branch match a
     post-PR record calls `advance()` and becomes a second controller
     (`register.tsx:1060-1078`). That is how the headless summarizer got round
     2 and pushed `21a5dd1`.
   - **Owner on the record:** store the owning session's id (`$.session.id()`)
     and a heartbeat on the record. Set the owner on start, on resume and on
     any `/pr-gate` command.
   - **No headless takeover:** a headless session (`$.session.surfaces()` is
     empty) never takes over, starts the ticker or sends a prompt.
   - **Takeover after 2 minutes:** another interactive session takes over only
     when the heartbeat is more than 2 minutes old (decision D). A session
     that stands down says so in its status line and in the run log.
   - **One owner check:** all three prompt paths (`round.ts:347`, `679`,
     `1143`) go through it.
   - **Verify first:** that the session id stays the same through compaction
     and `--resume`.
2. **A moved head no longer stops the round (findings 12, 18, 19; changes R28).**
   - **Local branch ahead of what GitHub reports** (`round.ts:1253`): if
     `git ls-remote` shows the push landed, `gh` is behind. Check again a few
     times before stopping.
   - **Local branch behind** (`round.ts:967`, `1284`): if the working tree is
     clean, fetch and fast-forward, then continue on the new head, which Codex
     reviews.
   - **When it does stop:** only when the branches have split or the tree is
     dirty. The message names who wrote the commits.
3. **Verification by a dedicated Codex pass (decision A; findings 2, 17, 20, 23, 24; changes R17, R58).**
   - **Every round:** the gate runs one low-effort Codex consult listing every
     owed item, meaning fixes not yet verified and fixes to re-verify. It uses
     no round.
   - **Rejections reach the agent:** Codex's reason for each rejection goes on
     the record and into the next prompt. This fixes `round.ts:1937`, which
     dropped the reason and showed the agent's own fix note as "open".
   - **Narrower re-verification:** it is owed only when lines near a fix
     change, not anything in its file.
   - **Advisories too:** fixed advisories are verified by the same pass, so
     they no longer hold the merge unverified.
   - **Finding 21:** trace it before changing anything. G2-11 was answered
     "fixed" with a reply id, stayed open, and wasn't carried into the next
     round.
4. **Settings (decision C; finding 4).**
   - **Light lane:** a new `allowanceLight` setting (plugin options and
     `.github/pr-gate.json`), default **3**, replaces the hard-coded 1 at
     `lifecycle.ts:15`.
   - **Blast radius beats branch name:** a high blast radius forces the full
     lane whatever the branch name (`register.tsx:251`).
5. **The `trusted` roster field (#14, part 1).**
   - **Trusted:** the gate reads and triages that reviewer's comments, but
     collection doesn't wait for them.
   - **Also counted:** a trusted author's feedback that arrives after a round
     closes is triaged in the next round.
   - **Unblocks** the cookbook's KAN-420 config change.
6. **Hold wording (finding 7, moved up from wave 3: every agent trips on it).**
   - Lead with "HOLD (not an error)".
   - Name who acts next, the gate or the person.
   - Say "leave this branch alone", not "end your turn".
   - Promise a gate message only when one will come.
7. **A run log (`/pr-gate log`).**
   - **Events on the record:** one line per event (round start and end, a stop
     and its reason, resume, allow, waive, a moved head, stand-down), capped
     at about 200.
   - **`/pr-gate log`** prints a short summary: rounds and time per round,
     Codex time vs. waiting, how many times the person stepped in and why, and
     the stop reasons. The next live run uses it to measure this wave.
8. **Housekeeping.**
   - Rulings from R71.
   - LIFECYCLE_SPEC updates and tests.
   - Version 1.3.0 in `plugin.json` and both READMEs.
   - Fix CLAUDE.md's "current state": `~/.claude/settings.json` loads
     **pr-lifecycle**, not codex-gate (finding 6).

## Wave 2: the post-PR loop runs itself

Serves goal 2. Removes the waits and the one-command-per-blocker routine.
Two PRs (decision L). Specs:
`docs/superpowers/specs/2026-10-20-pr-lifecycle-wave2a-design.md` and
`docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md`.

### Wave 2a: the person's actions and holds (pr-lifecycle 1.4.0)

**Status:** built on `wave2a/pr-lifecycle-1.4.0` (rulings R79-R87). R87, added
in live use, makes a hold on a chained command say nothing in it ran.

1. **Every manual action tells the agent (decision E; finding 22).** Today
   `waive post`, a post-PR finding waiver, `stop`, `reset` and the pane's
   stop button send the agent nothing, and `waive pre` sends something only
   when `openPr` is on, so the person has to follow up by hand. Each action
   ends with one message through `deliver()`, sent only while this session
   owns the record (R74), and not when a round prompt the action starts
   already says it.
2. **Waivers that work end to end (decision K; findings 28, 29).**
   - `waive post` covers rostered checks GitHub doesn't require.
   - No contradictory hold is sent right after a waiver.
   - A waiver that clears the last hold tells the agent the PR is ready to
     merge, and names what still holds otherwise (required CI).
3. **One hold lists every blocker (finding 27).** Everything between this head
   and the merge goes in one message, built in one place, for the guard's
   refusal and the agent's prompts alike.
4. **Settle approvals on their own (decision J; findings 9, 21).** Includes
   the finding 21 bug: an answered approval stayed open and dropped out of the
   carried list. Required regression tests (review G2-2 on PR #19):
   - an untagged actionable COMMENTED summary goes to triage, not settled;
   - a clean approval settles with no prompt;
   - approval text mixed with a requested fix goes to triage.
5. **Make deferral cheaper (decision I; finding 11).** Holds show the triaged
   severity, never the reviewer's hint.

### Wave 2b: rounds that keep up with the agent (pr-lifecycle 1.5.0)

**Status:** built on `wave2b/pr-lifecycle-1.5.0` (rulings R88-R94).

1. **Triage while slow reviewers finish (decision F; #14 part 2; findings 5, 10) (done in 1.5.0).**
   Findings already in go to the agent during collection, and it pushes as it
   goes.
2. **One round per push; only a clean round is free (decision G) (done in 1.5.0).** A new
   blocking finding, a rejected fix or rebuttal, or a fix the agent reports
   (amendment A8) charges the round.
   Amends what counts in `usedRounds`.
3. **One re-request per burst (decision H) (done in 1.5.0).**
4. **Collection ends on GitHub's signals, not a timer (replaces "tune the
   wait times") (done in 1.5.0).** The 3-minute quiet window only applied
   with no roster: it waits out unknown reviewers and checks that haven't
   registered yet. 2b reads the ruleset's required check runs and pending
   review requests as well as the roster, and keeps the quiet window only
   when none of those exist. Check suites are not read: some never finish
   (R89). Which signals are reliable was probed first (spec §2; the Codex
   connector's 👀 reaction, for one, didn't show on PRs #18 and #19).
5. **One finding per problem (done in 1.5.0, R90).**
6. **Issues instead of waivers; the agent merges (done in 1.5.0, R92, R93).**

The lanes item moved to wave 2c.

**Follow-up (1.5.1): a filing identity unique across checkouts (#29, option A) (done in 1.5.1, R96).**
From PR #28's review: a second checkout of the same PR could adopt the first's
issue after a lost POST answer. Each lifecycle gets a random id, which goes in
the filing mark, and a mark is never written without one. Spec:
`docs/superpowers/specs/2026-10-24-lifecycle-filing-identity-design.md`. Plan:
`docs/superpowers/plans/2026-10-27-pr-lifecycle-filing-identity.md`. Option B,
a shared Durable Object store, is evaluated with wave 3 item 2.

**1.5.2: approvals settle on their verdict (R97, PR #32; discussion #15 items 30, 32-34) (done in 1.5.2).**

**What closes wave 2 (Adam, 2026-10-28).**
- **#34 (P0), fix now:** the PR-create guard passes a create whose `--head`
  names a branch other than the checked-out one (discussion #15 item 35)
  (done in 1.5.3, R98).
- **#26 (P1):** the fix step times out while its fixer still works
  (done in 1.5.4, R99).
- **The slow-test re-check:** the three-run check under load
  (`docs/superpowers/plans/2026-10-21-wave2b-flaky-tests.md`).
- **A clean live run** of the released version on a cookbook PR.

The P2 issues #21-#24 stay in the issue queue, highest severity first. #27
goes with wave 3 item 2. Lanes (2c) move to wave 3.

### Wave 2c: parallel fixers in lanes (moved to wave 3)

1. **Parallel fixers in lanes (Adam, 2026-10-20).** With `fixer: 'subagent'`, the gate
   groups a round's findings into lanes by the files they touch and starts one fixer per
   lane in parallel; findings that share a file share a lane, so no two fixers edit the
   same code. On PR #20's pre-PR round 1, one fixer took 7 findings in turn where two lanes
   (required checks, waivers) would have run side by side.

## Wave 3: visibility, scoping and fewer person-only steps

Serves goal 2. Makes the gate legible and reachable from anywhere.

1. **Pane actions (finding 8).**
   - Links next to "[stop the gate]", in the order the lifecycle reaches
     them: "[waive pre]" before the PR opens, "[waive post]" after, then
     "[merge PR now]". "Merge PR now" replaces "[stop the gate]" after a
     waiver or a ready verdict.
   - Each link runs the same code as its `/pr-gate` command, so it sends the
     agent the same message (wave 2 item 4). A waiver link asks for a reason.
   - "Stop" stops cleanly, without an error.
2. **Records by PR, not only by folder (findings 12-15).**
   - `/pr-gate status` lists every live record.
   - Subcommands accept a `#<pr>` argument.
   - The merge guard resolves the PR being merged, not the checked-out branch.
   - Subcommands resolve "the current branch" the same way.
   - Decided together with #27 (resume across worktrees) and #29 option B (one
     Durable Object per `owner/repo#pr`, behind `store.ts`): all three are
     one PR seen from many checkouts. See the #29 plan's Part B.
3. **Archive when the PR merges (finding 14).** The record is archived when the
   merge is seen, not at the next command.
4. **The shared account (findings 16, 25) (done in 1.5.0, R91).** Adam, Codex
   and the agent all post as `adamtasteslikegood`. The gate skips every comment
   id the agent reported as a reply, whatever its answer (R91), and the person's
   other comments under that login still reach triage (R64).
5. **Announce background work (finding 23).** The pane names the Codex
   verification and final-head sub-agents while they run.
6. **Prevent merges outside the gate.** A required `pr-gate` commit status in
   the `main` ruleset (pending until ready), with the merge link. Since 1.5.0
   the gate sees such a merge and files what still held (R95); this stops it.

## Wave 4 and later: findings that are never lost, and the exhausted decision

Serves goals 3 and 4. It starts once waves 1-3 run live without errors.

- **Every finding fixed or tracked.**
  - An unresolved finding becomes a Jira ticket where the repo has a Jira
    project, and a GitHub issue otherwise.
  - The ticket is linked back from the PR thread.
  - Security findings already go to Jira since 1.5.0 (R95), where
    `jiraProject` is set. The rest follow in wave 4.
- **Redefine "exhausted"** to fit how rounds actually run once the loop is
  smooth.
- **At exhaustion,** the gate either blocks the merge or allows it with an issue
  filed for each unresolved finding. **Either outcome goes to Adam.**

## Parallel track: the cookbook repo

Done in that repo's own directory and session, under its rules: branch from
`origin/dev`, Jira key in the PR title, merge with `--merge`.

- **KAN-419:** the precompact summarizer uses `--tools ''` (not
  `--allowedTools ''`) and loads no plugins. This removes the trigger for
  #13, while wave 1 removes the class of bug.
- **KAN-420:** in `claude-review.yml`:
  - full review on open; on `synchronize`, review only the new commits, at low
    effort;
  - `persist-credentials: false` on "Checkout PR head", after checking that
    claude-code-action still pushes with its own token;
  - after wave 1 ships `trusted`, move `claude[bot]` to `trusted` and drop
    "Independent Claude review" from `checks`.
