# pr-lifecycle 1.5.0 (wave 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gate takes the person out of babysitting the PR. The agent answers feedback while reviewers are still collecting, each push is its own round, and only a round that finds something new costs one. Collection ends on GitHub's own signals. One problem is one finding. The gate never reads its own replies. Where 1.4.0 asked for a waiver, the gate files a GitHub issue, but only after the rounds. When nothing holds the merge, the agent merges.

**Architecture:**
- Pure decisions stay in `hooks/lifecycle.ts`: charging, linking, settling by issue, the late-blocker grant, and the issue title and body. Parsers stay in `hooks/github.ts`: tags, `collectionDone` with signals, and check-run start times. Async work stays in `hooks/round.ts`: polling, triage while collecting, rollover, and the filing pass.
- **The post-PR round state machine (1.5.0):**

  ```
  beginCollect(head H) ──► phase 'collect' ◄─────────────────────────────────┐
     │  every POLL_MS: pollOnce                                               │
     │   ├─ PR head moved to H' (fresh roundStartHead check)                  │
     │   │    → rollover: close round on H (isCharged computed), open the     │
     │   │      next round on H' (baseline / discretionary / final-head-check)│
     │   │      keep pending triage + run.findings, reset timers and cap ─────┘
     │   ├─ fresh unasked feedback, one quiet poll since the last arrival,
     │   │  no triage turn in flight → triage turn (phase stays 'collect',
     │   │  pending role 'triage'); answers recorded by afterTriage without
     │   │  ending the round; turn end re-requests roster reviewers once if the
     │   │  head moved since the last request
     │   └─ collectionDone(signals) && no pending && nothing fresh unasked
     │        → endCollect: Codex fallback from diffBase if the head is
     │          uncovered, then the end-of-head triage (1.4.0 ending: checks,
     │          endRound, advance)
     ▼
  advance → decideNext
     ├─ round / ready / blocked: as 1.4.0 (ready now says "merge now")
     └─ exhausted / awaiting-decision (post):
          fileIssues: 1) a blocker first raised in the last completed round and
          gate grants < 2 → grant by 'gate', start a round; else 2) file or
          label an issue for every non-security held finding → settle → decide
          again (ready → the agent merges)
  ```
- Charging (R88) is post-PR only: a pre-PR round is always charged, as in 1.4.0.
- A triage turn during collection reuses `askTriage`/`afterTriage`. `afterTriage` gets a `midCollect` flag that skips the round's ending.
- Everything else is additive. Where behaviour deliberately changes (R85's early P3 settle, the ready prompt, waivers for non-security findings, the quiet window), the old tests are updated in the task that changes it.

**Tech Stack:**
- TypeScript 6.0.3, as a Claude Code plugin (`claude-code` engine API).
- Tests run through `claude plugin test` with the fakes in `pr-lifecycle/tests/world.ts`.
- ESLint with `@stylistic`.

**Spec:** `docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md`, including the M2 amendment and §7.4 (#24). Read it first. Then read `CLAUDE.md` (repo rules) and the rulings doc `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md` (R1-R87). This plan adds R88-R94.

## Global Constraints

- Work on branch `wave2b/pr-lifecycle-1.5.0`. Make it from `main` once the docs PR for `docs/wave2b` has merged, or from `docs/wave2b` if it hasn't.
- Never touch `codex-gate/` (frozen at 0.3.1).
- Hand style: no semicolons, single quotes, lines up to about 160 columns. **Never run Prettier or `eslint --fix`**; edit surgically.
- Never commit `pr-lifecycle/.claude-plugin/types/` (generated, gitignored). `pr-lifecycle/types/index.d.ts` is tracked and holds the record types.
- Don't use a bare `npx tsc`. Use `npm run typecheck` from the repo root.
- Never run a Bash command whose text contains the literal PR-create command line. The loaded gate refuses it even inside a grep or a string. Build such strings from pieces. The gate files issues with `gh api -X POST repos/<slug>/issues`.
- Commit after each task. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1
  ```
- Run the suite with `claude plugin test pr-lifecycle` from the repo root (about 504 tests before this wave). Before the last task, `npm run check` from the repo root must pass.
- Every refusal of a PR create or merge still starts with "pr-gate HOLD (not an error):" (R77). Prompts never start with `/` (R21).
- An agent prompt never gives the person's command as the agent's own step (R42, R49). Security findings still wait for the person's waiver (spec §5.4).
- Severity names: P0 Blocker, P1 Critical, P2 Major, P3 Minor. Label colours as R85: P0 `b60205`, P1 `d93f0b`, P2 `fbca04`, P3 `0e8a16`.
- Late-blocker rounds the gate adds: at most **2** per lifecycle.
- `mergeMethod` values: `merge` (default), `squash`, `rebase`.

## Review Focus

1. **Resume after a reviewer already commented (#24).** A roster reviewer's issue comment (no `commit_id`) posted after the push but before `/pr-gate resume` still covers the head. The round must not wait out the cap. Test in Task 4.
2. **This machine's login in `requested_reviewers`.** The person may request a review from themselves (the same gh login as `self`). The gate must not wait for that review. Test in Task 5.
3. **Two pushes between two polls.** The gate sees only the last head. It must close one round on the old head and open one on the newest, never one round per commit, and must not crash on the commit it never saw. Test in Task 9.
4. **An answer that names a finding raised in a round that has since rolled over.** The agent answers G3-2 after its push ended round 3. The answer applies to G3-2, and it is not dropped as unasked. Test in Task 9.
5. **A linked duplicate whose original is security.** The linked item holds with the original. It is never filed as an issue, because the original is security and needs the person. Test in Task 12.

---
