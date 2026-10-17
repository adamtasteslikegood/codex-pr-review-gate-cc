# Quickstart

## 1. Clone and install

```bash
git clone https://github.com/adamtasteslikegood/codex-pr-review-gate-cc.git pr-gate
cd pr-gate
npm ci
```

`npm ci` installs only the dev tools (TypeScript, ESLint). You also need the
`claude` CLI and `gh`.

## 2. Load a plugin

Name one component's folder in `CLAUDE_CODE_PLUGIN_DIRS`, for example in
`~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/pr-gate/codex-gate" }
```

Which one to load, from the [README](README.md):

`codex-gate` 0.3.1 is the plugin in daily use. `pr-lifecycle` 1.0.0 replaces
it once Adam switches `CLAUDE_CODE_PLUGIN_DIRS` to its folder. Never load
both: both register `/pr-gate` and hold PR creation, so two would gate the
same PR twice. [LIFECYCLE_SPEC.md](LIFECYCLE_SPEC.md) is the spec
`pr-lifecycle` implements.

Loading a component in a session also writes its generated
`.claude-plugin/types/`, which `npm run typecheck` needs.

## 3. Run the checks

```bash
npm run check   # lint, test, validate, typecheck
```

Each check also runs on its own: `npm run lint`, `npm run test`,
`npm run validate`, `npm run typecheck`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## 4. Use `/pr-gate`

With the plugin loaded, open a PR as usual. When an agent runs `gh pr create`
against a gated base (`dev`, `main`), the plugin holds it and runs the
pre-PR Codex gate first. Start it by hand with `/pr-gate [base]`. Each
component's README covers its options.
