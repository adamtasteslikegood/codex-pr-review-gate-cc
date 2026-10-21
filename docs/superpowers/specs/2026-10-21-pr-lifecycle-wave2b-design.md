# pr-lifecycle 1.5.0 (wave 2b): design

Status: design approved by Adam on 2026-10-21, section by section (round
model, consolidation and own replies, issues instead of waivers, merge, bugs).
Builds on 1.4.0 (wave 2a, rulings R79-R87, merged as aae4dbb on PR #20).
`codex-gate/` stays frozen. Parallel fixer lanes are wave 2c (1.6.0) and get
their own spec.

## Goal

The gate takes the person out of babysitting the PR:

- the agent answers feedback as it arrives and pushes as it goes; each push
  is its own round, and only a round that finds something new costs one;
- collection ends when GitHub says the head is covered, not after a quiet
  timer;
- one problem is one finding, however many reviewers, rounds and replies name
  it, and the gate never reads its own replies as feedback;
- where the gate would stop for the person's waiver, it files a GitHub issue
  instead, so the person works from the issues queue, highest severity first;
- when nothing holds the merge, the agent merges.

Success: each item below has a regression test that fails on 1.4.0 and
passes on 1.5.0, the existing suite passes (adjusted only where behaviour
deliberately changes), and `npm run check` is green. On a live PR, the person
sends no `/pr-gate waive <id>` for a non-security finding, and no gate reply
comes back as a new item.

## Decisions

| | Decision | Source |
| --- | --- | --- |
| F | Findings go to the agent while slow reviewers are still collecting; the agent pushes as it goes | Adam, 2026-10-20 |
| G | Each push is its own round; a round is charged only when it finds a new blocker or Codex rejects a fix or rebuttal in it | Adam, 2026-10-20 |
| H | Roster reviewers are re-requested once per burst, on the head the agent's turn ends on; one Codex pass covers the heads between | Adam, 2026-10-20 |
| S | Collection ends on GitHub's signals; the quiet window stays only where there are none | ROADMAP wave 2b item 4; probe on PR #20 (§2) |
| O | A new item that names a problem already on the list is linked to it and follows its status | Adam, 2026-10-21 |
| M | Where the gate would ask the person to waive a finding, it files a GitHub issue instead, and the issue settles it; security still needs the person | Adam, 2026-10-21 |
| N | When nothing holds the merge, the agent merges with a merge commit | Adam, 2026-10-21 |
| L2 | 2b (this, 1.5.0) then 2c (parallel fixer lanes, 1.6.0) | Adam, 2026-10-21 |

## 1. A round is one head (decisions F, G, H)

**Today.** A post-PR round collects until the roster has covered the head, or
the quiet window passes, or the 20-minute cap. Only then does the agent see
any feedback (`endCollect` → `beginTriage`, `round.ts`). A push during
collection moves the round's start head (`pollOnce`, `onNewHead`) inside the
same round. Every completed discretionary round is charged (`usedRounds`,
`lifecycle.ts`), clean or not.

**Change.**

1. **Triage during collection.** At each poll (`POLL_MS`, 30 s), fresh
   feedback (not processed, not an own reply (§4), not linked to a finding
   (§3)) goes to the agent in a triage turn without ending collection. The gate
   waits one poll after the last arrival before asking, so a reviewer's burst
   of inline comments arrives as one turn. While the agent works, polling
   goes on; what arrives meanwhile waits for the next triage turn. Only one
   triage turn is in flight at a time.
2. **A push ends the round on its head.** When the PR head moves, the round on
   the old head ends, completed, with what it collected and answered. The next
   round starts on the new head straight away. Answers the agent gives after
   the push, in the same turn, are recorded against the finding as today; the
   round that asked keeps the triage step.
3. **Feedback about an earlier head** that arrives later joins the current
   round, carries the head it names (`headSeen`), and goes through §3 first,
   so a slow reviewer's comment on a problem already fixed links to it instead
   of opening a new finding.
4. **Charging (G).** A round record gets `isCharged: boolean`. A completed
   discretionary round is charged when, during it:
   - a new blocking finding was raised (a linked duplicate (§3) is not new); or
   - Codex rejected a fix (the check found it does not hold) or a rebuttal or
     acknowledgement.

   A rejected fix is charged to the round in which Codex rejects it ("a
   rejected fix still uses a round, because it does"). `usedRounds` counts
   charged rounds. A failing fix loop therefore still exhausts the allowance
   into a hold that says why. Baseline rounds and final-head checks stay free,
   as today. A record from before 1.5.0 has no `isCharged`: its completed
   discretionary rounds count as charged.
5. **Bursts (H).** The agent may push several times in one turn. Roster
   `requestReview` reviewers are re-requested once, when the agent's turn ends,
   on the head it ends on (today `beginCollect` re-requests at every later
   round). At the end of that head's collection, if no reviewer covered it,
   one Codex review runs from the last head a review covered (`diffBase`, R60)
   to it, covering the heads between. Rounds on the heads between have no
   reviewer coverage of their own and need none: they are clean or charged by
   what was found in them.
6. **The cap.** `waitCapMinutes` (20) stays the backstop for a round on one
   head. A new head restarts it.

## 2. Collection ends on GitHub's signals (decision S)

**Probe (PR #20, head f9e35cb, 2026-10-21).**

| Signal | Reliable | Why |
| --- | --- | --- |
| Check suites on the head | No | Six installed apps (Vercel, Railway, Datadog, Google Cloud Build, Cyrus, Claude) leave a suite `queued` forever with no runs. |
| Check runs on the head | Yes | A run that starts reports its status and completes. |
| The ruleset's required checks | Yes | Read for R86 already (`requiredChecksOf`). |
| Pending review requests | Yes, when there are any | `requested_reviewers` was empty: nobody is formally requested on this repo. |
| The Codex connector's 👀 reaction | No | Absent on PRs #18, #19 and #20. |
| A review's `commit_id` | Yes | Each review names the head it covered. |

**Change.** `collectionDone` (`github.ts`) is done for a head when all of
these hold:

- every required check (§R86 list, or every reported check when it is
  unknown) has a completed run on the head;
- every reviewer in `requested_reviewers` has a review whose `commit_id` is
  the head;
- with a roster, every roster reviewer has covered the head, as today.

Check suites are never read. The quiet window (`quietMinutes`, 3) applies only
when none of the three exists: no required checks, no pending requests and no
roster. The cap applies always. A pending request that GitHub drops (the
reviewer is removed) stops being waited for at the next poll.

## 3. One finding per problem (decision O)

**Today.** `triage()` (`lifecycle.ts`) compares new feedback only with
*answered* findings, and only marks it `duplicate` for the prompt. The agent's
`duplicateOf` answer is read (`core.ts`) and never used. On PR #19, review
summary G2-1 stayed a separate blocker beside its own inline G2-2.

**Change.**

1. **Linking.** A new item is compared with every finding on the list, open
   ones included. The gate links it when the match is clear (`isSame`: same
   file, lines within 5, at least half the title words shared). The agent may
   link an item by answering `duplicateOf: <id>`. Two rules stay:
   - feedback posted after a rebuttal answers that rebuttal and is never its
     duplicate (R33);
   - an item on a file changed since the original was answered stays new
     (`new-on-changed`), since it may be a regression.
2. **What a link means.** A finding gets `duplicateOf?: string`. A linked
   finding takes its original's status: it holds while the original holds and
   settles when the original settles. `mergeHolds` and the standing list the
   original once, with its linked ids beside it ("G2-1 (also G2-2)"). A link
   never chains: linking to a linked finding links to its original.
3. **Replies.** Every thread still gets a reply (R82). For a linked item the
   agent posts one pointer reply ("Same as G2-1: fixed in abc1234"), not a new
   argument; its answer is `{"id":"G2-2","duplicateOf":"G2-1","replyId":…}`.
4. **Disputes.** The agent may refuse a link the gate made by answering the
   item on its own (fixed, rebutted, deferred); the link is dropped. A link the
   agent claimed goes to Codex in the round's existing check (the one for
   rebuttals and acknowledgements) at no round's cost: agreed, it stands;
   refused, the item stands alone and is asked about again.
5. **Severity.** A link never lowers anything: the original's `peakSeverity`
   becomes the higher of the two (R85), so its issue carries the highest
   severity either had.

## 4. The gate never reads its own replies as feedback

**Cause, traced on PR #20.** `fetchFeedback` skips this machine's comments
whose ids are recorded replies (R64). `afterTriage` records a reply only for an
answer it accepts on a finding with a GitHub `externalId`. Two kinds of reply
slipped through and came back as new items:

- replies that answer only Codex findings (no `externalId`): the round-6
  summary came back as G7-4, and the R1-7 reply as G11-2;
- replies to answers the gate dropped: G7-2's `acknowledged` was refused
  (§7.1), its reply id discarded with it, and the reply came back as G7-9
  (G7-10 the same way).

**Change.** The record gets `ownReplies: string[]`: every reply id the agent
reports, in any step and for any answer, accepted or not, Codex finding or
GitHub item. `fetchFeedback` drops this machine's comments whose id is in
`ownReplies` or in `replies`. The person's own comments, under the same login,
still reach triage. §3 is the net for a reply posted some other way.

## 5. Issues instead of waivers (decision M)

**Today.** A deferral at P0-P2, a P3 deferral without an issue, and a dispute
wait for `/pr-gate waive <id>` (R39, R40, R85). On PR #20 Adam waived R1-6,
R2-1, R2-2, R4-3, R5-2 and R5-3 by hand, and R4-3 and R5-2 again after a fix
touched their file (R55).

**Change.** At every point where the gate would ask the person to waive a
finding, it files a GitHub issue instead, and the issue settles the finding.

1. **When.** A deferral at any severity, and a dispute (Codex rejected a
   rebuttal and the agent stands by it, R40), once the round's answers and
   Codex's check are in. Not before: the gate first resolves everything it
   can.
2. **Not security.** A security-flagged finding still waits for the person's
   waiver. `waive post` stays for whole-head decisions.
3. **Reuse.** If the agent's answer names an issue (`followUp`, R85), the gate
   uses it: it labels and links it instead of filing another.
4. **The issue.**
   - Title: `<id> <Name> [P<n>] <title> (#<pr>, <branch><, Jira key><, spec>)`,
     for example `R4-3 Major [P2] Workflows rules ignored when reading
     required checks (#20, wave2a/pr-lifecycle-1.4.0)`. Names: P0 Blocker,
     P1 Critical, P2 Major, P3 Minor. The Jira key is the first
     `[A-Z][A-Z0-9]+-\d+` in the branch name, when there is one. The spec
     handle is `issueSpec` from `.github/pr-gate.json`, when set.
   - Body: who raised it and where (PR, round, thread link); the severity it
     peaked at and whether it is security; the problem (the finding's detail);
     its impact and why it was not fixed (the agent's note, and Codex's reason
     for a dispute); linked findings (§3) and related issues. Issues #21-#23
     are the model.
   - Label: `severity:<peak>` (R85), created when missing with R85's colours.
5. **Settling.** The finding settles once its issue exists and carries the
   label; the record keeps `followUp` and `followUpLabel` as for R85 today.
   `/pr-gate status` and the hold list name the issue ("R4-3 → #21 Major
   [P2]"). If filing or labelling fails, the finding holds with gh's error,
   and the next pass retries, as R85's labelling does. A reset, a fresh start
   or a stop while gh runs ends the pass with nothing written (G7-8, R8-2).
6. **Lapse.** A finding settled by its issue does not lapse when its file
   changes (unlike a waiver, R55); its issue stays open for the person. R5-3
   (#23) asks whether a file change should reopen a settled deferral; that
   stays the person's call and is not changed here.
7. **Bash text.** The gate files issues through `gh api -X POST
   repos/<slug>/issues`, never a command line the PR-create guards read.

## 6. The agent merges (decision N)

1. When the standing has nothing that holds the merge (ready, or a post
   waiver covering the head), the ready prompt tells the agent to merge now,
   with `gh pr merge <n> --merge`, and to report the merge commit. It no longer
   tells the agent to leave the decision to the person.
2. `mergeMethod` in `.github/pr-gate.json`: `merge` (default), `squash` or
   `rebase`. This repo keeps `merge` so rulings' commit hashes stay on `main`.
3. The merge guard (`judgeMerge`, `register.tsx`) lets the command through on
   a head whose standing allows it, as today; nothing changes in the guard.
4. A merge GitHub refuses (a required check the gate didn't know of, R4-3) is
   reported to the agent with GitHub's words, and the lifecycle stays where it
   was.

## 7. Bugs from PR #20

1. **Tags.** `severityHint` (`github.ts`) reads any `P0`-`P3` word anywhere as
   the reviewer's tag, so "[P2 thread]" in a gate reply made G7-2 and G7-4
   tagged P2s, which may not be acknowledged (R82). A tag is now only a token
   standing alone: `[P2]`, `(P2)`, `**P2**`, `P2:` or `P2 -` at the start of a
   line, or a badge image named for it (`![P2 Badge]`). Any other mention is a
   hint. The most severe tag still wins.
2. **Labels.** An `acknowledged` answer is stored as a rebuttal noted "No
   change requested:" (R82), so holds say "rebuttal not yet accepted". The
   history event gets `answer: 'acknowledged'`, and texts say "acknowledgement
   not yet confirmed".
3. **Flaky tests.** Some flow tests time out at 5 s when the machine is loaded
   (load average 5-6). Find the cause first (a real wait in the harness, a
   fake process that sleeps); raise the timeout only for tests whose cost is
   the machine's load, and say so beside each.

## 8. Rulings to record (from R88)

Each with its cost if wrong, in the rulings doc:

- R88 (F, G, H): a round is one head; triage during collection; a push ends
  the round; a round is charged only for a new blocker or a Codex rejection;
  re-requests once per burst.
- R89 (S): collection ends on required check runs, requested reviews and the
  roster; suites are never read; the quiet window only without them.
- R90 (O): linked duplicates follow their original; the agent's links are
  checked by Codex.
- R91: every reply id the agent reports is the gate's own, whatever the
  answer.
- R92 (M): issues instead of waivers, except security; amends R39, R40, R55
  and R85.
- R93 (N): the agent merges when nothing holds the merge; `mergeMethod`.
- R94: tags are standalone tokens; acknowledgements are named as such.

## 9. Testing

- `lifecycle.test.ts`: charging (new blocker, rejected fix, rejected rebuttal,
  clean round free, pre-1.5.0 record charged); linking (open finding, R33,
  changed file, no chains, peak raised); settle by issue (each severity,
  security holds, dispute, failed label holds and retries).
- `github.test.ts`: `collectionDone` with required runs, pending requests,
  roster, none (quiet window), queued suites ignored; `severityHint` tag forms
  and "[P2 thread]" as a hint.
- `flow.test.ts`:
  - feedback triaged during collection, batched after one quiet poll;
  - a push mid-turn ends the round and starts the next on the new head;
  - three pushes in one turn: one re-request, one Codex pass over the range;
  - a slow reviewer's comment on a fixed problem links instead of opening;
  - a reply to a Codex-only finding and a dropped answer's reply are never
    read back (the PR #20 cases G7-4, G7-9, G11-2);
  - a P2 deferral and a dispute file issues with the title and label above
    and settle; filing fails, holds, retries; a security deferral waits for
    the person;
  - ready tells the agent to merge with `mergeMethod`.
- `world.ts`: fakes for `requested_reviewers`, check runs per head, issue
  filing (`issues` POST) with a failure knob, and `pr merge`.

## 10. Housekeeping

- Version 1.5.0: `plugin.json`, the README version line and the root README
  table together; CLAUDE.md's state section and test count.
- ROADMAP.md: wave 2b items 1-4 done; "one finding per problem" placed here;
  item 5 (lanes) moves to wave 2c.
- LIFECYCLE_SPEC.md: the round, collection, settle and merge rules.
- New settings in `.github/pr-gate.json`: `mergeMethod`, `issueSpec`.
