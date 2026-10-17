# CLAUDE.md

Working rules for this repo. Claude Code loads this file in every session
started here. [CONTRIBUTING.md](CONTRIBUTING.md) holds the same rules for
people; [QUICKSTART.md](QUICKSTART.md) covers setup.

## What this repo is

Claude Code mods for pre-PR and post-PR review, owned by Adam Schoen. See
[README.md](README.md) for the component table.

## Current state (2026-10-17)

- `codex-gate/` **0.3.1** is the plugin in daily use, loaded through
  `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. It is **frozen**:
  don't change it unless Adam asks for a fix. Known, unfixed issues:
  - A PR can be created through the github-graphql MCP connector without
    the gate.
  - It refuses any Bash command whose *text* contains the PR-create command
    line, even inside a grep, a string or a heredoc. Write files that mention
    it with the Write tool, and build such strings from pieces in code.
- `pr-lifecycle/` **1.2.0** is **not loaded** (1.0.0 merged in PR #1).
  It extends `/pr-gate` across pre-PR and post-PR review and implements
  [LIFECYCLE_SPEC.md](LIFECYCLE_SPEC.md). The Claude model of each sub-agent
  and the Codex model and effort per tier are settings (#10, #11; R68–R70).
  Per-repo settings live in `.github/pr-gate.json`, read from the base
  branch, never the PR's HEAD:
  - Design: `docs/superpowers/specs/2026-10-16-pr-lifecycle-design.md`.
  - Every ruling made while building it, R1–R66, Adam's rulings on
    codex-gate's deferred items R1-5 to R1-10, and R67–R70 after 1.0.0:
    `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`.
  - Read the spec and the rulings before changing it.
- **Never load both folders at once.** Both register `/pr-gate` and hold PR
  creation, so two would gate the same PR twice. Switching
  `CLAUDE_CODE_PLUGIN_DIRS` to `pr-lifecycle` is Adam's call.
- Open follow-ups, left as is on purpose:
  - a failing optional CI check holds a pr-lifecycle merge, with no waiver;
  - a failed fetch of a submodule or of the other base stops a round;
  - in a repo with no reviewer roster, review bots without write access are
    dropped.

## Repo setup

- **Tooling:** a root `package.json` pins TypeScript 6.0.3, ESLint and
  `@stylistic`. Run `npm ci` once.
- **CI** (`.github/workflows/ci.yml`): one `check` job runs lint, test and
  validate, then typecheck. Typecheck is skipped with a warning in CI, because
  the generated plugin types exist only after a Claude Code session loads the
  mod.
- **CodeQL** (`.github/workflows/codeql.yml`) uses the advanced setup:
  JavaScript/TypeScript and Actions, on PRs and pushes to `main` and weekly.
  CodeQL's default setup must stay **off** in repo settings, or the uploads
  are rejected.
- **Dependabot** (`.github/dependabot.yml`): weekly updates for npm dev
  dependencies (grouped) and for actions. TypeScript gets patch updates only,
  because typescript-eslint caps it below 6.1.
- **Actions are pinned to commit SHAs**, with the tag in a comment.
- **Templates:** `.github/PULL_REQUEST_TEMPLATE.md` and
  `.github/ISSUE_TEMPLATE/` (bug and feature forms).
- **Ruleset `main`** (on the default branch):
  - no deletion and no force-push;
  - changes only through a pull request, with 0 approvals required and
    review threads resolved;
  - the `check`, `analyze (actions)` and `analyze (javascript-typescript)`
    checks must pass on an up-to-date branch;
  - the repo admin role can bypass only when merging a pull request.
- **Codex's GitHub connector** (`chatgpt-codex-connector`) reviews PRs when
  they open, but only while the Codex account's usage limit allows. When it
  can't, the PR goes ahead without its review if Adam says so.
- **A scheduled ChatGPT reviewer task** reviews PRs and posts its review
  and inline comments **as Adam's account** (`adamtasteslikegood`). A PR
  comment asking for a review triggers it (first used on PR #12); whether a
  new commit does is not yet confirmed. It does not depend on the Codex
  connector's usage limit. pr-lifecycle uses the same `gh` login, so it reads
  the task's findings but never counts them as review coverage of a head
  (`fetchFeedback`, `cover`): the Codex fallback still runs, and listing
  that login under `reviewers` would make every round wait for
  `waitCapMinutes`. Read its review before merging.

## Code style

- Hand style: no semicolons, single quotes, lines up to about 160 columns.
  `npm run lint` checks it on `pr-lifecycle/` and only reports problems.
- **Never run a whole-file formatter** (Prettier or similar) or
  `eslint --fix`. Prettier's defaults once rewrote `register.tsx` from 950 to
  1,460 lines. Edit surgically.

## Checks

From the repo root:

```bash
npm run lint       # eslint, pr-lifecycle only
npm run test       # claude plugin test, both components (codex-gate 22, pr-lifecycle 389)
npm run validate   # claude plugin validate, both components
npm run typecheck  # tsc -p pr-lifecycle --noEmit, with the pinned TypeScript
npm run check      # all four
```

- `typecheck` needs `pr-lifecycle/.claude-plugin/types/`, which the harness
  writes when a session loads that mod. With the types present, it runs in
  about 2 s with 0 errors.
- `codex-gate` is not type-checked. Its tsconfig pulls in the generated
  `claude-code-mcp` types, about 1.6 MB, which ran tsc out of memory.
- Don't use a bare `npx tsc`: here it resolves to a fake package.
- `.claude-plugin/types/` is generated and gitignored; never commit it.

## Git

- `main` is the only long-lived branch; remote `origin` is
  `github.com/adamtasteslikegood/codex-pr-review-gate-cc`.
- Work on a branch and open a PR to `main`. The ruleset blocks direct pushes.
- `gh pr create` is held by codex-gate's pre-PR gate until it passes or Adam
  waives it. Add its "Pre-PR Codex gate" line to the PR body.
- Commit after each change, end commit messages with a `Co-Authored-By:`
  line for the model, and push when Adam asks. Merge with a merge commit, so
  the commit hashes cited in the rulings doc stay on `main`.
- When a component's version changes, bump its `plugin.json`, the version
  line in its README and the table in the root README together. There is
  deliberately no `VERSION` file.
