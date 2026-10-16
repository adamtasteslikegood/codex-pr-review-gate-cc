# CLAUDE.md

Working rules for this repo. Claude Code loads this file in every session
started here.

## What this repo is

Claude Code mods for pre-PR review, owned by Adam Schoen. See
[README.md](README.md) for the component table.

- `codex-gate/`: the `/pr-gate` mod, **frozen at 0.3.1**. It is the plugin
  in daily use, loaded through `CLAUDE_CODE_PLUGIN_DIRS` in
  `~/.claude/settings.json`. Do not change it while the next version is in
  development, unless Adam asks for a fix to it.
- [LIFECYCLE_SPEC.md](LIFECYCLE_SPEC.md): the next major version, which
  extends `/pr-gate` across pre-PR and post-PR review. Read it in full
  before any work on the new version.

## Building the next version

- Build it in a **new sibling folder** (name settled during design), not in
  `codex-gate/`. Start from a copy of `codex-gate/` and reuse what the spec
  says to reuse.
- **Never load both folders at once.** Both register `/pr-gate` and
  intercept PR creation, so two would gate the same PR twice. Switching
  `CLAUDE_CODE_PLUGIN_DIRS` to the new folder is Adam's call.
- Agreed workflow: `superpowers:brainstorming` to settle the spec's open
  decisions with Adam and save a design doc in this repo, then
  `superpowers:writing-plans`, then build with `plugin-authoring` and
  `superpowers:test-driven-development`. The spec's "Behaviors to verify"
  list is the starting test suite.

## Code style

- Hand style: no semicolons, single quotes, lines up to about 160 columns.
- **Never run a whole-file formatter** (Prettier or similar). Prettier's
  defaults once rewrote `register.tsx` from 950 to 1,460 lines. Edit
  surgically.

## Checks

Run from the component folder (for example `codex-gate/`):

```bash
claude plugin validate .   # manifest and hook wiring
claude plugin test .       # tests/gate.test.ts (22 pass on 0.3.1)
```

Type-check with the pinned TypeScript from the cookbook checkout:

```bash
~/Projects/tasteslikegoodtheangularsvegancookbook/node_modules/.bin/tsc -p . --noEmit
```

`npx tsc` here resolves to a fake package; don't use it.

**Known issue (2026-10-16):** that type-check currently runs out of memory,
even with an 8 GB heap and even on `hooks/core.ts` alone. The cause is
`.claude-plugin/types/`, not the mod's code: the harness generates
`claude-code-mcp/index.d.ts` (about 1.6 MB) from every MCP tool on this
machine. Earlier runs finished with known errors in `register.tsx` (the
GitHub MCP create-PR matcher: TS2589, TS2345, TS7006) and
`tests/gate.test.ts`. Fix or work around this early in the new version,
since `claude plugin test` does not type-check.

`.claude-plugin/types/` is generated and gitignored; never commit it.

## Git

- `main` is the only branch; remote `origin` is
  `github.com/adamtasteslikegood/codex-pr-review-gate-cc`.
- Commit after each change, end commit messages with a `Co-Authored-By:`
  line for the model, and push when Adam asks.
- When a component's version changes, bump its `plugin.json`, the version
  line in its README and the table in the root README together. There is
  deliberately no `VERSION` file.
