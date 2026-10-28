# pr-gate

Checks that run on a branch before and after its pull request is opened, as
Claude Code mods. Each component lives in its own folder, with its own README and
version.

| Component                    | Version | What it does                                                                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| [codex-gate](codex-gate/)    | 0.3.1   | Rounds of adversarial Codex review and agent fixes before a PR to `dev` or `main`. [README](codex-gate/README.md) |
| [pr-lifecycle](pr-lifecycle/) | 1.5.2   | `/pr-gate` across the PR lifecycle: pre-PR Codex rounds, then the PR's own reviews, under one review budget and record. [README](pr-lifecycle/README.md) |

## Using a component

Load a component by naming its folder in `CLAUDE_CODE_PLUGIN_DIRS`, for
example in `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/pr-gate/codex-gate" }
```

Each component's README covers its own setup, options and checks.

## Which one to load

`pr-lifecycle` 1.5.2 is the plugin in daily use: Adam switched
`CLAUDE_CODE_PLUGIN_DIRS` to its folder. `codex-gate` 0.3.1 is frozen. Never load
both: both register `/pr-gate` and hold PR creation, so two would gate the
same PR twice. [LIFECYCLE_SPEC.md](LIFECYCLE_SPEC.md) is the spec
`pr-lifecycle` implements.

## Versions

A component's version is the `version` field in its
`.claude-plugin/plugin.json`. Its README and the table above repeat it, so
bump all three together.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo's rules and [QUICKSTART.md](QUICKSTART.md) to get set up.

## License

MIT. See [LICENSE](LICENSE).
