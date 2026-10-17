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

## Wave 1: no errors, no babysitting the basics (pr-lifecycle 1.3.0)

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
     when the heartbeat is more than 2 minutes old (decision D). Until then,
     the pane says who owns the record.
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
6. **Housekeeping.**
   - Rulings from R71.
   - LIFECYCLE_SPEC updates and tests.
   - Version 1.3.0 in `plugin.json` and both READMEs.
   - Fix CLAUDE.md's "current state": `~/.claude/settings.json` loads
     **pr-lifecycle**, not codex-gate (finding 6).

## Wave 2: the post-PR loop runs itself

Serves goal 2. Removes the waits and the one-command-per-blocker routine.

1. **Triage while slow reviewers finish (#14, part 2; findings 5, 10).**
   - Send the findings already in to the agent during collection.
   - Either batch its pushes until collection ends, or take them into the
     round without stopping. Wave 1's head-move handling makes the second
     option possible.
2. **Settle approvals on their own (findings 9, 21).** A review with nothing
   actionable ("no blocking findings") needs no agent round-trip and no answer.
3. **Make deferral cheaper (finding 11).** A low-severity "no change needed,
   follow-up recorded" doesn't cost the person a waiver. Severity shown in a
   hold matches the triaged severity.
4. **Waivers that work end to end (findings 22, 28, 29).**
   - `waive post` covers a rostered check that GitHub doesn't require.
   - No contradictory hold is sent right after a waiver.
   - A waiver that clears the last hold tells the agent the PR is ready to
     merge.
5. **One hold lists every blocker (finding 27).** Everything between this head
   and the merge goes in one message, not one blocker per command.
6. **Tune the wait times.** Revisit `waitCapMinutes` (20) and `quietMinutes` (3)
   once `trusted` has changed what the cap means.

## Wave 3: visibility, scoping and fewer person-only steps

Serves goal 2. Makes the gate legible and reachable from anywhere.

1. **Pane actions (finding 8).**
   - Links for "waive pre" and "merge PR now". "Merge PR now" replaces
     "[stop the gate]" after a waiver or a ready verdict.
   - "Stop" stops cleanly, without an error.
2. **Records by PR, not only by folder (findings 12-15).**
   - `/pr-gate status` lists every live record.
   - Subcommands accept a `#<pr>` argument.
   - The merge guard resolves the PR being merged, not the checked-out branch.
   - Subcommands resolve "the current branch" the same way.
3. **Archive when the PR merges (finding 14).** The record is archived when the
   merge is seen, not at the next command.
4. **The shared account (findings 16, 25).** Adam, Codex and the agent all post
   as `adamtasteslikegood`. The gate skips comments whose ids the session itself
   reported as `replyId`, and doesn't count others' replies as the agent's own.
5. **Hold wording (finding 7).**
   - Lead with "HOLD (not an error)".
   - Name who acts next, the gate or the person.
   - Say "leave this branch alone", not "end your turn".
   - Promise a gate message only when one will come.
6. **Announce background work (finding 23).** The pane names the Codex
   verification and final-head sub-agents while they run.

## Wave 4 and later: findings that are never lost, and the exhausted decision

Serves goals 3 and 4. It starts once waves 1-3 run live without errors.

- **Every finding fixed or tracked.**
  - An unresolved finding becomes a Jira ticket where the repo has a Jira
    project, and a GitHub issue otherwise.
  - The ticket is linked back from the PR thread.
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
