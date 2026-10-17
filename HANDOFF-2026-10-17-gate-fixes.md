# Handoff: pr-lifecycle gate fixes (2026-10-17)

From the first full live test of pr-lifecycle 1.2.0 on cookbook PR #3706 (KAN-417; merged a1e663b). The PR was open more than 2 hours and needed 2-3 manual interventions. Codex review sessions take 1-2 minutes. The time goes everywhere else.

**Owner's direction (Adam, quoted):** "the gate should focus on these, improved pre-pr rounds with fixes - the whole point was to review the code before a pr opens to shorten review rounds, then the gate was holding up pr-open… now the code exists to run along the full lifcycle, but the fixes need applied and params adjusted". Fix and tune. Don't redesign.

## Do in this order

### 1. KAN-419: cookbook repo, small

Summarizer in `.claude/hooks/precompact-session-log.sh` (around line 220, `claude -p … --allowedTools ''`).

- `--allowedTools ''` only auto-approves; it doesn't remove tools. Use `--tools ''`.
- Stop the child from loading plugins. It inherits `CLAUDE_CODE_PLUGIN_DIRS`, so unset it for the child or pass the flag that disables plugins.
- Why: on #3706 this headless child received the gate's round-2 prompt and committed and pushed `21a5dd1`. The transcript is `~/.claude/projects/…--claude-worktrees-kan-417/de3c3f1b…jsonl`, 14:27:24Z.
- Cookbook rules apply: branch from `origin/dev`, run `scripts/git/branch-preflight.sh`, put the Jira key in the PR title, merge with `--merge`.

### 2. codex-pr-review-gate-cc#13: this repo

Gate prompts reach every session sharing the cwd+branch key, including headless `-p` children. Target only the session that owns the record.

- Records are keyed `lifecycle:<toplevel of cwd>:<branch>` (`pr-lifecycle/hooks/store.ts:9`).

### 3. codex-pr-review-gate-cc#14: this repo

Two parts:
- Add a `trusted` roster field: the gate reads and triages that reviewer's comments, but collection doesn't wait for them.
- Triage the findings already in while a slow reviewer is still running, instead of idling.

Collection logic is `collectionDone` in `github.ts:226-242`. `isTrusted` uses the roster reviewers.

### 4. KAN-420: cookbook + Backend `claude-review.yml`

- **On open:** full review, unchanged.
- **On `synchronize`:** review only the delta, at low effort.
- **After #14 ships:** move `claude[bot]` from `reviewers` to `trusted` in the cookbook's `.github/pr-gate.json`, and drop "Independent Claude review" from `checks`.
- **Item 3:** set `persist-credentials: false` on the "Checkout PR head" step in both repos, so the bot's fix pushes stop needing Adam's approval for workflow runs. First check that claude-code-action still pushes with its own token. If it can't push at all, decide with Adam before merging.

## Params to tune (pr-lifecycle hooks)

| Param | Current value | Location |
| --- | --- | --- |
| Light-lane discretionary rounds | exactly 1 (every fix push needed `/pr-gate allow 1`) | `lifecycle.ts:15` |
| `lightBranches` default | `^chore/` (a high-blast-radius `chore/` PR still landed light) | `round.ts:177` |
| `waitCapMinutes` / `quietMinutes` | 20 / 3 | `round.ts:171-172` |
| `allowanceStandard` / `allowanceHigh` | 4 / 6 | `round.ts:158-159` |

## Full findings

The full list is Discussion #15 in this repo, grouped into five root causes, with findings 25-29 in a comment. These cause the most friction after the four tickets above:

- Fixed or answered items stay "open" every round (findings 17, 20, 21, 24, 27).
- Any head move stops the round and only the person can restart it (12, 18, 19).
- `waive post` doesn't cover a rostered CI check GitHub doesn't require, and the hold message contradicts the waiver (28, 29).
- `/pr-gate waive` sends the agent nothing (22).

## Gotchas for the session doing this

- The gate plugin is loaded in every session through `CLAUDE_CODE_PLUGIN_DIRS`. Editing it while it gates your own PR is circular; expect holds on your own branch.
- `/pr-gate` subcommands are person-only. The agent can't waive, allow or resume.
- Adam, Codex and the agent all post as `adamtasteslikegood`. The gate can't tell them apart (findings 16, 25).
- Never cancel a rostered check to speed up a merge (finding 28).
- Memory note: `pr-lifecycle-live-test-findings.md` in the cookbook project memory.
