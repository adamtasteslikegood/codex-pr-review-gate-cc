# Task 16 report: rulings, docs and version 1.5.0

Status: DONE. Commit `06ca87b` "pr-lifecycle 1.5.0: rulings R88-R94, docs and version". No code changed.

## Files changed

- `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`: new section "Rulings in wave 2b (1.5.0)", R88-R94 and
  "Rulings made while planning and building 1.5.0" (the brief's 11 lines plus 21 more, 32 in all).
- `pr-lifecycle/README.md`: version line and the R88-R94 changes (listed below).
- `pr-lifecycle/.claude-plugin/plugin.json`: `"version": "1.5.0"`.
- `README.md`: table row and "`pr-lifecycle` 1.5.0 is the plugin in daily use".
- `LIFECYCLE_SPEC.md`: "Amended in pr-lifecycle 1.5.0 (wave 2b)".
- `ROADMAP.md`: wave 2b items 1-4 done, a status line, items 6 and 7, item 5 moved to "Wave 2c: parallel fixers in lanes",
  "Not yet placed" removed, spec path changed to `2026-10-21-…`.
- `CLAUDE.md`: state heading `(2026-10-21, after wave 2b)`, **1.5.0**, the R92/R93 sentence, "R88–R94 in wave 2b", test
  count 619, and a line on the 19 tests bounded at 15 s with the load re-check still owed.

## Where the brief's verbatim text was changed to match the build

- **R88:** A8 added (a discretionary post round is also charged when the agent reports a fix in it for any finding, raised then
  or earlier; linked duplicates excluded; at most once; non-blocking rebuttal/deferral/acknowledgement free), with why (P2/P3
  churn was unbounded) and the extra cost. The same correction is in the README's "Outside the allowance", ROADMAP item 2 and
  LIFECYCLE_SPEC.
- **R90:** A1-A3 and A9 added (canonical ids, no self-links or cycles, severity and security rise as well as peak, lowered only
  through R85's Codex lowering, refused link leaves it raised, no match through an unchecked link).
- **R92:** M3 named; A7 (an issue counts only once GitHub shows its label); lost severity "not held for the person"; post-merge
  refile only on "Could not resolve to an issue or pull request", any other failure blocks until resume and the agent is told;
  A6 (a reset or fresh start while gh runs writes nothing).
- **R93:** as built: "no *review finding* holds the merge"; `gh pr merge <n> --<method>`; a guard hold for running checks →
  `gh pr checks <n> --watch` and merge again; a failed required check or a GitHub refusal → report in its own words and stop;
  the merge step sent once (also after a waiver); no closing keyword before a follow-up issue's number; why it says "review
  finding" (CI is the guard's). Cost extended: the agent waits on checks in its own turn.
- **R94:** the ledger's acknowledgement-wording ruling folded in (pane and rejection text; Codex verify prompt unchanged).
- **Flaky tests line:** extended with the 15 s ruling (19 tests as built; the ledger's "17" was before two more were bounded)
  and the owed three-run load re-check.
- README `issueSpec`: the brief says "at most 80 characters"; the code trims and cuts it to 80 (`round.ts:282`), so the README
  says "cut to 80 characters".

## Every ledger ruling and where it landed

| Ledger line | Ruling | Landed |
| --- | --- | --- |
| 29 | lost-severity findings filed as P1, not held | merged into R92 |
| 30 | file-at-once answered by fix-first + §5.12 | merged into the brief's "When issues are filed" line |
| 40 | acknowledgement texts cover pane and rejection text | merged into R94 |
| 41 | PR #25 review folded as A1-A7 | new line "The PR #25 Codex review … A1-A7"; A1-A3 in R90, A6/A7 in R92, A4/A5 own lines |
| 47, 50 | A5: activity-log push time, latest push, first-seen fallback, re-request or count, newest-push re-read | two new A5 lines |
| 55 | team review requests ignored | new line; also README collection bullet |
| 56, 57 | commit statuses (revised: read for required contexts) | new line, recording the revision |
| 59 | inline replies use `original_commit_id` | new line |
| 64 | advisory churn unbounded, raised to Adam | superseded by A8; the "why" in R88 |
| 66 | refused link not accepted again to the same original | new line |
| 68, 81 | A8, and A8 broadened to any fix | merged into R88 |
| 71 | A9 | merged into R90 |
| 74 (spec note) | raise from a guessed dup has no Codex lowering path | new line |
| 78, 82, 116 | raise re-check of accepted rebuttal/ack/agreed deferral; refusal is a full rejection | one new line covering all three |
| 83 (note) | A8 doesn't verify a push | new line |
| 87 | isSettling stale after max(step timeout, 5 min) | new A4 line |
| 88, 91 | mid-collection timeout → collecting once, second stops | new line |
| 94 | `isTurn = phase === 'triage'`; endCollect counts handed feedback | new line |
| 103 | first-poll head = start head (Task 9) | new line |
| 104 | rolled-over baseline has no isCharged | new line |
| 124 | security-only late blocker gets a gate round | new line |
| 132 | merge step wording (Task 13) | merged into R93 |
| 140, 144 | 15 s bound on 17→19 tests; Task 14 committed with load check partial | merged into the brief's flaky-tests line |
| 153 | refile only on "Could not resolve…" (Task 15 I1) | merged into R92, plus its own new line |

Task report departures recorded:
- Task 9: first-poll rule (line above).
- Task 12: `!isLinkOwed` not fileable; no repository → `issue-failed`; a waiver stops a filing pass; each issue written right
  after its POST (fix round 1) — three new lines.
- Task 15: label-owed refile labelled, not refiled; check runs after the agent's own merge inside the held turn; I2 throw told to
  the agent; one close per lifecycle (M1); failed check ends a running collection as blocked; touched fields only; success
  message after the archive — one new line, plus the I1 line.

## README changes (brief Step 2, items 1-10)

1. `Version 1.5.0.`
2. "One round": a paragraph on R88 (one head, triage during collection, a push ends the round at the end of the turn).
3. "The budget": "Outside the allowance" replaced, with A8; `allow` line unchanged ("It settles no deferral or dispute" still
   true).
4. "Deferrals" → "Deferrals and issues", the brief's text, plus A7 (label must show) and refile only when gh says missing.
5. "Waivers lapse": "A finding settled by its issue does not lapse (R92)."
6. "Who decides": names the person only for security findings; fix, Codex's check or an issue; the agent merges. Dropped "After
   the PR opens, exhaustion names the person whatever `onExhausted` is" (no longer true); kept the pre-PR `onExhausted: stop`
   case.
7. New "The agent merges", as built (see R93), plus a paragraph on the post-merge issue check.
8. Settings: `mergeMethod` and `issueSpec` in the example and a sentence on them.
9. Commands: `waive <findingId>` names security as the usual case; `allow` row is "add 1 to 5 review rounds".
10. Other text fixed:
    - "What happens" step 7: triage while collection runs.
    - "What happens" step 8: "ready for the merge decision" → no review finding holds the merge, and the agent merges.
    - Findings: "shows a duplicate with the earlier answer" → links it (R90); one sentence on R91 (every reported reply id is
      the gate's own).
    - Rebuttals: "A second rebuttal ends in `awaiting-decision`, a dispute for the person" → a dispute, filed as an issue.
    - The merge rule: "unless … the person waived" → "unless its follow-up issue settles it (R92) or the person waived".
    - Collection: "With a roster … / Without one …" → R89's three signals (required check runs or statuses, pending review
      requests, roster), suites never read, team requests and own login not waited for, quiet window only with none.
    - `requestReview`: "on a new head in round 2 or later" → once per agent turn that pushed, on its last head (R88).
    - Options: intro notes `mergeMethod`/`issueSpec` are set in the base file only; `quietMinutes` row says when it applies.

## Checks

- `npm run test` (run once, before the doc edits; this task changes no code):
  - codex-gate: `22 pass, 0 fail`, "Ran 22 tests across 1 file."
  - pr-lifecycle: `619 pass, 0 fail`, "Ran 619 tests across 8 files. [140.07s]".
  - **The controller's numbers were off:** pr-lifecycle alone has 619 tests (641 with codex-gate), not 597. CLAUDE.md says
    `codex-gate 22, pr-lifecycle 619`.
- `npm run validate`: codex-gate "✔ Validation passed", pr-lifecycle "✔ Validation passed" (each with the marketplace
  install-line advice, which does not change the verdict).
- `npm run lint`: exit 0, no problems.
- `npm run typecheck`: exit 0.
- `grep -c 'timeoutMs: 15_000'`: flow 16, gate 1, models 1, settings 1 = 19.

## Concerns

- Test count: 619 for pr-lifecycle, not 597 (see above).
- The root README and CLAUDE.md say 1.5.0 is "the plugin in daily use", as the brief asks; it is only loaded once this branch
  merges and Adam's `CLAUDE_CODE_PLUGIN_DIRS` folder has it.
- CLAUDE.md's Git section still says `gh pr create` is held by codex-gate's gate (stale since pr-lifecycle took over); not named
  by the brief, left as is.
- This report is in the gitignored `.superpowers/` folder; it is force-added in its own commit.

## Fix round 1

Commit `492056c` "docs: wave 2b rulings and README match the post-merge check and the person's holds".

1. **Post-merge check (Important).** Read `round.ts` ~3240-3320. As built: an open issue is logged; a closed one is reopened, and
   if the reopen fails a new issue is filed (logged "could not be reopened"); "Could not resolve to an issue or pull request"
   only decides whether a failed *read* means the issue is gone (filed again) or unreadable (blocked); a refile that fails
   blocks. Reworded:
   - `pr-lifecycle/README.md`, "Deferrals and issues": "files one again when gh says it no longer exists or the reopen fails".
   - `pr-lifecycle/README.md`, "The agent merges": the full sequence above.
   - Rulings doc R92: "a closed one is reopened with a comment, and filed again if the reopen fails; a missing one (its read
     fails with …) is filed again. Any other failed read, and a refile gh cannot complete, leaves the record blocked …".
   - Rulings doc, Task 15 I1 line: "treats a failed read of an issue as 'missing' only when gh answers …, and files it again".
   - Also `LIFECYCLE_SPEC.md`'s R93 bullet, which said the same: "filing it again when it is missing or cannot be reopened".
2. **Who decides (Important).** Read `lifecycle.ts` ~825-895 (`blockerOf`, `standingOf`) and `isFileable` (~724: not security,
   not linked, no owed link). The person owns: `disputed` and `deferred`/`security-p1` blockers when the finding is not fileable
   (in practice a security one, since linked and link-owed ones go to their original or Codex first); `head-unreviewed` when
   `decideNext` is `exhausted` (allowance spent, head no round reviewed, nothing to file; release `/pr-gate allow 1` or
   `waive post`); `retargeted` (point it back, or `/pr-gate reset`). The README's "only for security findings" is now a list of
   those three, plus the pre-PR exhaustion case it already named.
3. **ROADMAP numbering (Minor).** Wave 2b's items are now 1-6, with "The lanes item moved to wave 2c." after them; the lanes
   item is item 1 under wave 2c.
4. **ROADMAP wave 3 item 4 (Minor).** R91 makes every reply id the agent reports the gate's own, whatever its answer, and never
   read back as feedback; R64 already sent the person's other comments under the same login to triage. Together they are what
   the item asked for, so I **marked it done in 1.5.0 (R91)** and reworded its sentence to say what is built.
5. **CLAUDE.md Git (Minor).** "held by codex-gate's pre-PR gate" → "held by pr-lifecycle's pre-PR gate". The "Pre-PR Codex gate"
   line note stays: pr-lifecycle's open-PR prompt still asks for it (`core.ts:852`).

Checks: `npm run validate` passed for codex-gate and pr-lifecycle; `npm run lint` exit 0. Docs only, so no test run.
