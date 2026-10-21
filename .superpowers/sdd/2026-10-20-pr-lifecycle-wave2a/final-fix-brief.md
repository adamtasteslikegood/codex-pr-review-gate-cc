# Final-review fix round (wave 2a, pr-lifecycle 1.4.0)

Read the reviewer's report first: `.superpowers/sdd/2026-10-20-pr-lifecycle-wave2a/review-final-report.md` (file:line refs, failing bodies, suggested fixes).
Fix every item below, each with a test that fails before the fix. Hand style: no semicolons, single quotes, ~160 cols. Never run Prettier or eslint --fix.

## Must fix

1. **C1, ADVISORY anchoring** (`pr-lifecycle/hooks/github.ts` ~208/216). Drop the `m` flag: the advisory label counts only at the start of the body
   (leading whitespace, `#` heading, list marker and `**bold**` allowed). Also accept a body whose every non-empty line is advisory-labelled.
   - `severityHint` tests: the three mixed bodies in the report and "This is a critical bug.\n\nNit: …" must NOT come back P3/isTagged
     (P1 for the critical one, otherwise the untagged default). "Advisory, non-blocking:\n- a\n- b" and "**Nit:** x" alone still P3 tagged.
   - Flow test: a mixed-body GitHub finding that the agent defers as P3 with a followUp still holds the merge.
2. **followUp shape check (R85)** (`lifecycle.ts` `applyAnswer` / `isSettledDeferral`). A followUp settles only if it names a URL (`https://…`),
   `#<n>`, or `owner/repo#<n>`. Anything else: keep the deferral but it does not settle (holds like a pre-R85 deferral). Test both.
3. **Stale followUp**: a deferral that arrives without a followUp clears any earlier `followUp` on the finding. Test.
4. **I2 ruling (controller, recorded):** an R85 deferral settles only if the finding was already P3 before the agent's answers, i.e. the agent never
   lowered its severity (no history event from the agent that lowered it; this covers a guessed P1/P2 lowered to P3 in the same answer or later).
   Otherwise the deferral holds as before R85. This also covers T2 (severitySource staying 'hint'). Tests: guessed P1 ("critical") lowered to P3 +
   deferred + valid followUp → still holds; a reviewer-tagged P3 deferred with a valid followUp → settles.
5. **I1, live head unreviewed** (`lifecycle.ts` `standingOf`; `round.ts` `judgeMerge`; `register.tsx` `waive <id>`). In a post phase that isn't
   covered by a post waiver for `at.head`, when `at.head !== rec.head` push a blocker: kind `head-unreviewed`, id `'head'`, said
   "`<at.head 7>` was pushed after the review completed at `<rec.head 7>`", owner gate, release "/pr-gate resume reviews it". Avoid listing it twice
   in `judgeMerge` (add 'head' to `named` for the pushed-after case). `waive <id>` must not send a "ready for the merge decision" note or let
   `advance` send `readyPrompt` for a stale `rec.head` when the live head differs. Strengthen the test at `flow.test.ts` ~3741 to assert nothing
   sent contains "ready for the merge decision" in that case. Keep the existing 'head' id/namedIn usage consistent (grep for it).

## Should fix (small)

6. **M2**: `patch()` in round.ts returns null when the run it patched is no longer `running` (or callers check `after.status`). Audit callers.
7. **M1**: in `advance`'s post tail and `holdPost`, after `gatherStanding`, reload the record and skip the hold/report `say` if a post waiver now covers the head.
8. **M3**: rules endpoint `repos/<slug>/rules/branches/<base>?per_page=100`; `isClassicNone` matches `/Branch not protected/i` only. Update the world.ts fakes/regexes and tests.
9. Wrap `prHeadOf` in try/catch (a throw must not fail `advance`; treat as unknown head → no early return).

## Docs (`docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`, wave 2a section; spec `docs/superpowers/specs/2026-10-20-pr-lifecycle-wave2a-design.md`)

- R85: add the followUp shape rule and "settles only if the agent never lowered the severity" (I2), with its cost if wrong.
- R84: note that a lowered guess no longer settles under R85.
- R79: one clause: the pre-PR texts (judgeCreate, pre heldPrompt, allow/waive replies) are unchanged in 2a (M7); the standing adds the
  head-unreviewed blocker when the live head moved (I1).
- R82: one clause noting 1.3.0 GitHub findings have no severitySource and read as untagged (M6).
- Spec §3.5: amend wording to say the agent may raise but never lower a reviewer-tagged severity (M5).
- Update the test count in CLAUDE.md (two places: "pr-lifecycle NNN" in Checks) if it changes.

## Finish

Run `npm run check` from the repo root; all green. Commit (one or a few commits) ending with:

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1

IMPORTANT: a loaded hook refuses any Bash command whose text contains the words gh, pr and create together (even in grep/strings).
Never write such a Bash command; use the Grep/Read tools to search for that text. Do not dispatch subagents. Do not push.
Write your report to `.superpowers/sdd/2026-10-20-pr-lifecycle-wave2a/final-fix-report.md` and return only: status, commits, test summary, concerns.
