### Task 11: Rulings, docs and version 1.4.0

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md` (append R79-R87)
- Modify: `LIFECYCLE_SPEC.md`, `CLAUDE.md`, `README.md`, `pr-lifecycle/README.md`, `pr-lifecycle/.claude-plugin/plugin.json`, `ROADMAP.md`

- [ ] **Step 1: Rulings.** Append to the rulings doc, after R78, one line each, in the doc's own form ("- Ruling R79 (…): … — cost if wrong: …"):
  - **R79** (findings 27, 28): one standing (`standingOf`) lists every blocker between a head and its merge, with owner and release. The guard's refusal and the post-PR prompts render the rest of it after what they already name. Cost if wrong: longer hold texts.
  - **R80** (amends R62; finding 29): a post waiver covering the head ends review holds for it; `advance` says what it covers instead. A run stopped or waived while a step awaited makes `endRound` do nothing. Cost if wrong: a waived head no longer gets a reminder of open findings.
  - **R81** (Adam, decision E): every manual action by the person (`waive pre|post|<id>`, `allow`, `stop`, `reset`, and the pane's Stop) ends with one agent message through `say()`. A note and a prompt the same command queues for the same record become one message, the note's line first. An agent's own `stop` sends nothing. Cost if wrong: one extra message per action.
  - **R82** (amends R32, R34, R36, R40; finding 21; Adam: every unresolved thread gets a reply and/or a fix, as the PR guidance and tool-use hooks required before the gate): triage carries open findings by the round raised in. `acknowledged` ("asks for no change") counts only with a `replyId`, on a GitHub finding with no security flag and no explicit P0-P2. It is stored as a rebuttal noted "No change requested:", and Codex checks it. Cost if wrong: a Codex check for a plain approval note.
  - **R83** (Adam, decision J, narrowed by review G2-2 on PR #19): a review is no finding only on positive no-action evidence (`isNoAction`). Settled reviews are logged as `approval`. Cost if wrong: a no-action review the classifier misses goes to triage.
  - **R84** (findings 11, 21): a triaged severity replaces one guessed from a comment's words, up or down, recorded in the history. A reviewer's tag and Codex's severity are never lowered. A reviewer's advisory label reads as a P3 tag. Cost if wrong: an agent lowers a guessed P2 to P3.
  - **R85** (amends R42; Adam, decision I): a P3 deferral with a `followUp`, not security, settles without a waiver. Cost if wrong: a P3 the person would have wanted to see.
  - **R86** (amends R1-9; Adam, decision K; finding 28): required checks come from the base's rulesets and classic protection, failing closed when unreadable. A post waiver sets aside every other check, named. Cost if wrong: a check that should have blocked goes unnoticed under a waiver.
  - **R87** (live use, cookbook PRs #3732 and #3741): a hold on a Bash command that does more than its PR action ends by saying nothing in it ran, and asks for the other steps on their own and the PR command alone. The command is never rewritten to run part of it. Cost if wrong: one extra line on a hold.

- [ ] **Step 2: LIFECYCLE_SPEC.md.** In its dispositions and waiver sections, add `acknowledged` (replied, Codex-checked), `followUp` for P3 deferrals, approvals that settle on positive no-action evidence, and `waive post`'s reach over checks GitHub doesn't require.

- [ ] **Step 3: Version 1.4.0, together:**
  - `pr-lifecycle/.claude-plugin/plugin.json`: `"version": "1.4.0"`;
  - the version line in `pr-lifecycle/README.md`;
  - the component table in the root `README.md`.

- [ ] **Step 4: CLAUDE.md "Current state".**
  - Change `pr-lifecycle/` to **1.4.0**, and the rulings range to R1-R87.
  - Update the test count (run `npm run test` and copy the pr-lifecycle number).
  - Remove the open follow-up "a failing optional CI check holds a pr-lifecycle merge, with no waiver" (R86 resolves it).
  - In ROADMAP.md, set wave 2a's status line to "built on `wave2a/pr-lifecycle-1.4.0` (rulings R79-R87)".

- [ ] **Step 5: Full check**

Run from the repo root: `npm run check`
Expected: lint, both test suites, validate and typecheck all pass. Typecheck needs `pr-lifecycle/.claude-plugin/types/`, which a session with the mod loaded generates. If they're missing, say so in the PR body instead of skipping silently.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md LIFECYCLE_SPEC.md CLAUDE.md README.md pr-lifecycle/README.md pr-lifecycle/.claude-plugin/plugin.json ROADMAP.md
git commit -m "pr-lifecycle 1.4.0: rulings R79-R87, spec, docs and version"
```

---

## After the tasks

- Push the branch. The PR is opened by the main session, gated by the loaded 1.3.0. Adam fast-tracks it.
- The PR body carries the summary, the rulings list, the test count, and the line "Pre-PR Codex gate: …" if the gate adds one.
- The gated PR is wave 1's first live run: once it merges, `/pr-gate log` on the branch gives the numbers for ROADMAP.
