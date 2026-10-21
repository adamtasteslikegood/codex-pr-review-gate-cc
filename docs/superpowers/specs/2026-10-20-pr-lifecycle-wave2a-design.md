# pr-lifecycle 1.4.0 (wave 2a): design

Status: design approved by Adam on 2026-10-20 (decisions E, I, J as narrowed by
review G2-2 on PR #19, K and L in [ROADMAP.md](../../../ROADMAP.md)). Builds on
1.3.0 (rulings R71-R78). `codex-gate/` stays frozen.

## Goal

The person's actions and the gate's holds stop costing extra turns:

- every manual action tells the agent what happened and what to do next;
- one hold lists everything between this head and the merge;
- a waiver is never followed by a hold that contradicts it;
- approvals with nothing to act on, and P3 no-action notes, settle without a
  round-trip or a waiver;
- the finding 21 bug, where an answered approval held the PR, is gone.

Success: each finding below has a regression test that fails on 1.3.0 and
passes on 1.4.0, the existing suite passes (adjusted only where behaviour
deliberately changes), and `npm run check` is green.

**Needed, not designed yet: one finding per problem.** The gate should merge
findings from separate rounds and reviewers that name the same problem (Adam,
2026-10-20). Today it doesn't:
- `triage()` (`lifecycle.ts:185`) only labels new feedback a duplicate for the
  prompt, and only against an answered finding in the same file with similar
  title words;
- the agent's `duplicateOf` answer is read (`core.ts:218`) but never used, so
  each copy stays its own blocker. On PR #19, review summary G2-1 was carried
  as a separate P2 blocker next to its own inline finding G2-2.

A later wave designs this. It needs to say: what counts as the same finding
(the gate's match, the agent's `duplicateOf`, or both), whether a duplicate
takes on its original's status and replies, and how a summary and its inline
findings are linked. This wave's `acknowledged` answer and advisory labels
reduce the cost, but don't solve it.

Out of scope here (wave 2b, 1.5.0): early triage during collection, one round
per push, charging only rounds with new findings, one re-request per burst,
and ending collection on GitHub's signals. Wave 3: the pane's waive and merge
links.

## Decisions

| | Decision | Source |
| --- | --- | --- |
| E | Every manual action ends with one message to the agent | Adam, 2026-10-20 |
| I | A P3 deferred with a recorded follow-up settles without a waiver; holds show the triaged severity | Adam, 2026-10-20 |
| J | Approvals settle on their own only on positive no-action evidence; inline comments are always triaged | Adam, narrowed by review G2-2 |
| K | `waive post` sets aside checks GitHub doesn't require, naming each | Adam, 2026-10-20 |
| L | Wave 2 ships as 2a (this) then 2b | Adam, 2026-10-20 |

## 1. One standing: everything between this head and the merge

**Problem (findings 27, 28, 29).** Five producers write hold text, each from
part of the picture:

| Producer | Where | Lists |
| --- | --- | --- |
| `judgeCreate` | `register.tsx:495`, texts 534-571, via `heldReason` (`round.ts:2085`) | one `why` |
| `judgeMerge` + `owedOf` | `register.tsx:654`, `:583` | `mergeHolds`, then one `next` line; CI only once the review clears |
| `ciHold` | `register.tsx:606` | CI, only when ready or post-waived |
| `reportPrompt` | `core.ts:786`, sent by `advance` (`round.ts:2075`) | one `decidePost` branch's `why` + `mergeHolds` |
| `heldPrompt` | `core.ts:848`, via `advance` and `holdPost` (`round.ts:1511`) | `preHolds` or `mergeHolds` |

The first blocker is always one branch of `decideNext`. Clearing it surfaces
the next branch, so the person pays one command per blocker (finding 27). Only
the guard reads a post waiver (`register.tsx:704`); `decideNext`, `advance` and
the prompts never do (finding 29). The guard treats every CI check alike and
never reads which ones GitHub requires (finding 28).

**Design.** A pure function in `lifecycle.ts` and an async gatherer in
`round.ts`:

```ts
type Blocker = {
  kind:
    | 'open' | 'verify-owed' | 'reverify-owed' | 'rebuttal-unchecked' | 'disputed' | 'deferred' | 'security-p1'
    | 'head-unreviewed' | 'round-owed' | 'retargeted' | 'late-feedback'
    | 'ci-failing' | 'ci-running' | 'ci-unreadable'
  id?: string            // a finding id, or a check name
  said: string           // one line, with the triaged severity
  owner: 'agent' | 'codex' | 'person' | 'gate'
  release: string        // the exact step that clears it, e.g. "/pr-gate waive G5-9 <reason>"
}
type Standing = {
  phase: 'pre' | 'post'
  head: string
  waiver?: Waiver        // the pre or post waiver covering this head and base, if any
  setAside: string[]     // non-required checks a post waiver set aside (section 5)
  mayProceed: boolean    // nothing left that this head's create or merge waits on
  blockers: Blocker[]    // every blocker, none short-circuited
}

function standingOf(rec, at: { head; base }, ci?: CheckState[] | 'unreadable', late?: Feedback[]): Standing   // pure
async function gatherStanding($, root, branch, pr?): Promise<Standing>                              // gh pr checks, required checks, untriagedFeedback
function holdText(s: Standing, named?: ReadonlySet<string>): string   // skips blockers the text already named by id
```

- `judgeCreate`, `judgeMerge`, `reportPrompt`, `heldPrompt`, the replies of
  `waive` and `allow`, and the action messages (section 2) all render from
  `holdText`. The R77 opening ("pr-gate HOLD (not an error):") and the R42/R49
  rules stay. The person's steps go only in `person` text and in the agent's
  "tell the person" line, never as the agent's own step.
- `decideNext` keeps deciding only what the controller runs next. The words
  sent come from `standingOf`.
- A post waiver covering this head, with no security P1, leaves only CI
  blockers. `advance` checks it right after its ownership and staleness
  checks and **before** any branch that dispatches work (`startRound`,
  `startAnswer`, `startRecheck`), so a waived head never starts triage, a
  recheck or a review round (PR #19 review). `advance` then sends no review hold for that head. It sends the
  waiver's action message (section 2), and only if the command hasn't
  already sent it.
- `mergeHolds`, `unresolvedBlockers`, `verificationOwed` and `ciHold` become
  inputs to `standingOf`, not text producers.

**A round that ends after it was stopped (finding 29).** `beginTriage`
(`round.ts:1147`) checks that its run is running only on entry, then awaits
`fetchFeedback`, `fetchTwice` (up to 60 s) and `git log` before
`endRound($, run, true)`. `endRound` (`round.ts:1851`) writes the round and calls
`advance` with no check, outside `holdingPrompts`. A `waive post` in that window
is followed by the full hold. Fix: `endRound` and the `after*` handlers
re-read the run after each long await and return when it is no longer this
run or no longer running. The lines named by the trace are `1556`, `1609`,
`2231`, `2336` and `2363`.

## 2. Every manual action tells the agent (decision E)

**Today.**

| Action | Message to the agent |
| --- | --- |
| `waive pre` | `sayOpenPr`, only when `openPr` is on |
| `waive <id>` | only through `advance` when no run is in flight; pre-PR only if the gate now passes |
| `waive post` | none |
| `allow` | only through a round that `advance` starts |
| `stop` | none; any origin can run it; not owner-checked |
| `reset` | none |
| `resume` | through `advance` |
| Pane "Stop the gate" (`pane.tsx:232`) | none; calls `finish()` directly: no origin or owner check, not logged, outside `holdingPrompts` |

**Design.**

- `tellAgent($, key, action: ActionNote, standing: Standing)` in `round.ts`
  composes one message and sends it through `say()`. That means it's queued
  under `holdingPrompts` and delivered only while this session owns the
  record (R74's `deliver`).
- The message has three parts:
  1. what the person did, with the reason;
  2. what still holds, from `holdText(standing, 'prompt')`;
  3. the agent's next step.

  Examples:
  - `waive post`: "pr-gate: the person waived post-PR review of PR #19 at
    aec7a65 (docs only). Set aside: Independent Claude review. Still
    holding: required check `check` running." Once nothing holds, the next
    step says, as `readyPrompt` does, that the PR is ready for the merge
    decision, which is the person's.
  - `waive pre`: "... Open the PR." This is sent even when `openPr` is off:
    the PR is the agent's to open either way.
  - `waive <id>`: "... G2-3 waived. Still holding: G2-5 [P2] open, yours to
    fix or rebut." Or: "Nothing holds the merge."
  - `allow`: "... 1 more round allowed. The gate continues the review; leave
    the branch alone until it says otherwise."
  - `stop`: "... The person stopped the gate. Stop waiting on it. Opening and
    merging stay held."
  - `reset`: "... The lifecycle was archived. `/pr-gate` starts a fresh one."
  - `resume`: the prompt the restarted step sends, with no extra note.
- **One message per action.** If the action makes `advance` queue a round
  prompt, the action line is put at the front of that prompt, and no separate
  message is sent. Each `holdingPrompts` call is a batch with its own id;
  queued entries carry it, and a note merges only into a prompt of the same
  batch and record. Two commands before one flush never merge into each
  other. `stop` and `reset` also drop prompts for their record that earlier
  batches queued and that haven't been delivered, so the agent never gets a
  superseded instruction (for example `waive pre`'s open-PR prompt after a
  reset) (PR #19 review).
- **The pane's Stop button** calls the command handler with `stop` and origin
  `pane`. It gets the owner check, `take()`, the log line and the message.
  Wave 3's links use the same route. `pane` counts as the person (the pane is
  only shown to the person), so wave 3's waive links may use it.
- A refused action (wrong origin, nothing to waive, security P1) sends
  nothing; its reply to the person says why, as today.

## 3. Approvals, triage and severity (decision J; findings 9, 11, 21)

**The finding 21 bug** (traced against the archived cookbook record of PR 3706,
`~/.claude/plugins/store/pr-lifecycle_inline-30946c8489d2.json`). Approval
G2-11's history:
1. r2 `open`;
2. r2 `reported-fixed`, by the agent (it had no "no action" answer);
3. r3 `open`, by Codex, which cannot verify a fix to an approval
   (`markHeld`, `round.ts:2179`).

`beginTriage` then asks about it through none of its three paths:
- its feedback id is in `processed` (`round.ts:1178`);
- the Codex list wants `source !== 'github'` (`round.ts:1238`);
- the carried list wants `!raisedIn(one, run.round)`, and Codex's reopening
  makes that true (`round.ts:1242`).

So it never reaches `asked`, the answer-again reprompt misses it, and
`decidePost` holds the PR on it with only the person's steps left. The bug is
the same on main.

**Design.**

1. **Carried by the round raised in.** `beginTriage` carries an open finding
   from an earlier round when `one.round !== run.round`, whoever touched it
   last. `listedIds` already keeps it out of the Codex list.
2. **An `acknowledged` answer, replied to and checked (Adam, 2026-10-20).**
   An unresolved thread always gets a reply and/or a fix. That rule is older
   than the gate (Adam's PR guidance and tool-use hooks), and the gate keeps
   it, so this answer never closes an item silently.
   - `Answer.action` gains `'acknowledged'`: the agent says the comment asks
     for no change (an approval with notes, a status report). Unlike a
     rebuttal, it doesn't claim the comment is wrong.
   - It is stored as a rebuttal (status `rebutted`, note starting "No change
     requested:"), so Codex's rebuttal check, acceptance, rejection and
     R40's dispute rule apply unchanged. `FindingStatus` doesn't change.
   - It needs a reply in the item's thread (`replyId`). Without one, the
     answer counts as unanswered and goes through the R34 reprompt.
   - It is allowed only for a `source: 'github'` finding that is not
     security-flagged and carries no explicit `P0`-`P2` tag. Anything else
     answered `acknowledged` counts as unanswered.
   - Codex checks it as it checks a rebuttal, on the same head, using no
     round (R36, R39). The "No change requested:" note tells Codex the
     question is whether the comment asks for any change. Upheld, it settles. Rejected, it is open
     again with Codex's reason, and R40's rule applies: the agent fixes or
     defers it, and a second `acknowledged` goes to the person as a dispute.
   - The triage prompt explains it: "acknowledged: the comment asks for no
     change (an approval with notes, a status note); reply in its thread
     saying so; Codex confirms it".
   - Clear-cut approvals (point 3) never reach the agent, so they need no
     answer at all.
3. **Positive no-action evidence (J, as narrowed by G2-2).** In `readReviews`
   (`github.ts:98`), a review is `isFinding: false` (it covers the head and
   raises nothing, as an empty approval does today) only when all of these
   hold:
   - its state is `APPROVED` or `COMMENTED`; `CHANGES_REQUESTED` never
     qualifies;
   - the body is empty and the state is `APPROVED` or `COMMENTED`, or **every**
     sentence of the body (split on `.`, `!`, `?`, `;` and line breaks) is,
     as a whole sentence and case-insensitive, one of these no-action forms:
     "LGTM", "looks good (to me)", "approved", "ship it", "thanks" or "thank
     you"; "no actionable/blocking findings/issues/comments", optionally
     followed by "in/for this …"; "no issues found"; "nothing to fix";
     "reviewed <sha>", optionally followed by "against <base>". Trailing
     punctuation and a leading emoji or `#` heading mark are ignored.
   - A `COMMENTED` body must also contain at least one of the no-action
     forms other than "thanks" and "reviewed …".

   The test is the whole body, never a list of request words: any sentence
   that isn't a no-action form, such as "LGTM. Preserve the pending findings
   before archiving." or "LGTM. Reset still deletes pending findings.", sends
   the review to triage (PR #19 review, thread on this section).

   Inline comments are separate `Feedback` rows and are triaged on their own,
   even under an APPROVED review. A settled review is logged (`approval`
   event, R78) so `/pr-gate log` shows it. Everything else, including an
   untagged comment, goes to triage as today.
4. **Triaged severity replaces a guessed one.**
   - `Finding` gains `severitySource?: 'tag' | 'hint' | 'codex'`. In
     `beginTriage` (`round.ts:1216`), GitHub findings record `'tag'` when
     `severityHint` found an explicit `P0`-`P3`, and `'hint'` otherwise
     (keyword or default).
   - `applyAnswer` (`lifecycle.ts:133`) takes the answered severity for a
     `'hint'` finding, lower or higher, and records the change in history.
     For `'tag'` and `'codex'` findings the R-rule stands: a fixer can't
     lower its own finding.
   - A lowering is Codex's call, not the person's (Adam, 2026-10-20): the
     history event records the severity before it (`from`), and a P3
     deferral the agent lowered settles only once Codex agrees (section 4).
     `peakSeverity` keeps the highest severity the finding had.
   - A security flag stays as set. This wave doesn't let the agent clear a
     keyword-only security flag; clear-cut approvals no longer reach the
     keyword test at all (point 3).
   - Holds show `severity` as stored, so a hold shows the triaged severity
     (finding 11, G3-1).
5. **Advisory markers (Adam, 2026-10-20).** `severityHint` (`github.ts:208`)
   reads a reviewer's own advisory label as P3. The labels are "advisory",
   "non-blocking", "nit", "optional" and "follow-up", when they label the
   comment or its list of findings, not inside a quoted phrase. Only a label
   at the start of the body counts (a heading mark, list marker or bold
   allowed): "Nit:" on a later line labels that line, not the finding above
   it (final review C1). Its `severitySource` is `'tag'`: it is the
   reviewer's own word, so the agent may raise it but never lower it, as for
   any reviewer tag (amended after the final review, M5). A review
   comment that lists several advisory findings stays one finding, P3, with
   the list in its detail. The agent answers it once: fixing what it fixes,
   `acknowledged`, or deferred with a follow-up (section 4). An explicit
   `P0`-`P2` tag on any item in the list wins over the label.

## 4. Cheap deferral (decision I; finding 11)

- `Answer` gains `followUp?: string`: the GitHub issue that tracks it, as
  `#<n>`, `owner/repo#<n>` or the issue's URL; a ticket key may sit beside it.
- A `deferred` finding settles, so it is no longer in `mergeHolds` or
  `unresolvedBlockers`, when all of these hold (amended by Adam, 2026-10-20,
  after the final review, replacing the controller's I2 and guessed-P3
  rulings):
  - its `followUp` names a GitHub issue (`issueOf`); a PR, comment or other
    URL alone keeps the deferral but settles nothing (final review T4);
  - its stored severity is `P3`, guessed or tagged alike;
  - if the agent lowered its severity (an answer set one below the one
    before it, recorded as `from` on the history event), Codex agreed with
    the lowering since. The lowering goes to Codex in the round's own check
    (`checksOwed`, `checkRebuttals`), with the reviewer's comment, the
    severity before and after and the agent's reason. Agreed: Codex's entry
    (`lowering: 'agreed'`) follows the lowering. Disagreed: it holds for the
    person, said as "Codex disagrees with lowering G2-1 from P1 to P3:
    <reason>". A later lowering needs Codex again;
  - the gate labelled the issue `severity:<peak>`: `peakSeverity` is the
    highest severity the finding had (set at creation, raised by any
    answer; older records read it from their history). `advance` labels
    each such issue first (`gh label create … --force`, then
    `gh issue edit <n> --repo <owner/repo> --add-label severity:<peak>`),
    once per peak, recording `followUpLabel`. A failure records gh's error
    and holds: "could not label issue #<n> severity:<peak> (<error>)",
    owner agent, retried on the next pass;
  - it is not security-flagged.

  A deferral that comes without a `followUp` clears an earlier one.

  It shows in `/pr-gate status` and the ready prompt as "deferred,
  follow-up at …, labelled severity:<peak>".
- P0-P2, security, or no issue named: held for the person's waiver, as today
  (R42).
- The triage prompt says a P3, not security, deferred with followUp naming
  the GitHub issue that tracks it needs no waiver; if the agent lowered its
  severity, Codex checks the lowering; the gate labels the issue with the
  highest severity the finding had.

## 5. `waive post` and checks GitHub doesn't require (decision K; findings 28, 29)

- `requiredChecksOf($, slug, base)` reads, in this order:
  1. `gh api repos/<slug>/rules/branches/<base>`: each `required_status_checks`
     rule's `parameters.required_status_checks[].context`;
  2. `gh api repos/<slug>/branches/<base>/protection/required_status_checks`:
     `contexts` and `checks[].context`. A 404 means no classic protection.

  The result is cached per base for the session. Here, main's ruleset gives
  `check`, `analyze (actions)` and `analyze (javascript-typescript)`.
- Rulesets and classic protection apply together, so the required set is the
  union of both, and **each** source must be established: parsed
  successfully, or authoritatively absent (classic protection's 404 "Branch
  not protected"; a ruleset list `[]`). If either source fails in any other
  way (a thrown request, 403, 500, or a payload that doesn't parse), the
  required set is unknown and every check counts as required (fail closed):
  a waiver sets nothing aside (PR #19 review, thread on this section).
- In `standingOf`:
  - a required check that is failing, cancelled or running is a `ci-*`
    blocker, waiver or not;
  - a non-required check is a blocker only when no post waiver covers this
    head;
  - under a waiver, a non-required check goes into `setAside`, whatever its
    state.
- The `waive post` reply and its agent message name each check set aside.
- R1-9 ("a waiver does not release a red check") is narrowed to required
  checks.

## 6. Rulings to record (from R79)

| Ruling | Says | Amends |
| --- | --- | --- |
| R79 | One `standingOf`; every hold text renders from it and lists every blocker | R39, R49, R77 wording |
| R80 | A post waiver covering the head ends review holds for it; a stopped run's late `endRound` does nothing | R62 |
| R81 | Every manual action, the pane's Stop included, ends with one agent message through `say()`; merged into a round prompt the action starts | — |
| R82 | Triage carries open findings by the round raised in; `acknowledged` ("asks for no change") needs a reply and a Codex check, as a rebuttal does | R32, R34, R36, R40 |
| R83 | A review is `isFinding: false` only on positive no-action evidence | readReviews' non-empty rule |
| R84 | A triaged severity replaces a keyword-guessed one; explicit tags and Codex severities are never lowered; a reviewer's advisory label reads as a P3 tag; a lowering is Codex's to check | applyAnswer's rule, severityHint |
| R85 | A P3 deferral, not security, with a `followUp` naming a GitHub issue settles without a waiver once the issue is labelled with the peak severity; a lowering needs Codex's agreement first | R42 |
| R86 | Required checks come from rulesets and classic protection; `waive post` sets aside the rest | R1-9 |
| R87 | A hold on a Bash command that does more than its PR action says that nothing in it ran (section 5a) | R77 wording |

### 5a. A hold on a chained command (added 2026-10-20, from live use)

**Today.** A hook allows or refuses a whole tool call. An agent that wrote
`cat > body.md <<'EOF' … EOF` and `gh pr create --body-file body.md` in one
Bash call had the create held. The file write didn't run either, and the hold
didn't say so. This happened twice in one session (cookbook PRs #3732 and
#3741). The agent found the missing file afterwards and rewrote it.

**Design.** `hasOtherSteps(command)` in `github.ts` is true when a Bash
command has a step besides the PR action. Steps are split on `;`, `&&`, `||`,
`|` and newlines, after heredoc bodies, quoted text and `$(…)` are removed. A
bare `cd <dir>` doesn't count. Every hold the `tool.call` hook returns for such
a command (create, merge, outside, no base, the guard's own failure) ends with:

> Nothing in this Bash command ran: a hold refuses the whole command, so the
> steps chained with the PR command did not run either. Run those on their own
> (write a PR body file with the Write tool), and keep the PR command in a Bash
> call by itself.

**Rejected:** rewriting the command to drop only the PR part, through
`updatedInput` or a changed `next(e)`. Running part of what the agent wrote,
silently, is worse than refusing all of it and saying so.

## 7. Testing

New tests in `pr-lifecycle/tests/`, through the existing engine fakes. Each
fails on 1.3.0:

- **Finding 21:** replay G2-11's history (open, then agent `reported-fixed`,
  then Codex `open` in round 3). Round 3's triage asks about it. An
  `acknowledged` answer with a reply goes to the Codex check and settles
  when Codex upholds it.
- **`acknowledged` never closes silently:** without a `replyId` it is
  unanswered and reprompted; on a P2-tagged or security item it is
  unanswered; Codex rejecting it reopens the item with the reason.
- **Approval classifier (required by review G2-2):**
  - an untagged actionable COMMENTED summary ("The reset path deletes the
    pending findings. Preserve them before archiving.") goes to triage;
  - a clean approval (APPROVED, empty or "LGTM") and a COMMENTED "No
    actionable findings in this diff." settle with no prompt;
  - approval text mixed with a requested fix ("LGTM, but please rename X";
    "No blocking findings. You should add a test.") goes to triage;
  - an inline comment under an APPROVED review is triaged.
- **Finding 27:** a head with an open P2, a re-verify owed, a deferral and a
  running required check yields one hold naming all four, in both the
  guard's refusal and the agent's prompt.
- **Finding 28:** under `waive post`, a cancelled non-required check is set
  aside and named, and a running required check still holds.
- **Finding 29:** `waive post` while `beginTriage` is awaiting; the late
  `endRound` sends nothing, and the only message is the waiver's.
- **Decision E:** each action's message text and owner check. The pane's
  Stop goes through the command handler. An `allow` that starts a round sends
  one prompt, with the action line at its front. A refused action sends
  nothing.
- **Severity:** a hinted P2 triaged P3 shows as P3 in the hold; a tagged P2
  triaged P3 stays P2.
- **Advisory labels:** "Advisory, non-blocking:" followed by a list of
  findings becomes one P3 finding with the list in its detail; the same list
  with one item tagged P1 becomes P1; "the reviewer's advisory note" quoted
  inside a sentence doesn't count.
- **Deferral:** a P3 with an issue `followUp` settles once its issue is
  labelled; a guessed P1 lowered to P3 waits on Codex, settles when Codex
  agrees (the issue labelled severity:P1) and holds for the person when it
  disagrees; a failed label holds until a later pass labels it; a P2 with
  `followUp`, a P3 without one, and a security P3 each hold.

Checks: `npm run check` from the repo root (lint, both test suites, validate,
typecheck with the generated types present).

## 8. Housekeeping

- Version 1.4.0 in `pr-lifecycle/.claude-plugin/plugin.json`, the
  pr-lifecycle README's version line and the root README table.
- The rulings doc gets R79-R86 as they're implemented.
- LIFECYCLE_SPEC.md: dispositions (`acknowledged`, `followUp`) and the
  waiver's reach over checks.
- CLAUDE.md "Current state": 1.4.0, and the open follow-up "a failing optional
  CI check holds a pr-lifecycle merge, with no waiver" is resolved by R86.
- Code on branch `wave2a/pr-lifecycle-1.4.0`, gated by the loaded 1.3.0.
