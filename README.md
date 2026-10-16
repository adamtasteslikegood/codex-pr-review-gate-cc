# pr-gate

Checks that run on a branch before its pull request is opened, as Claude
Code mods. Each component lives in its own folder, with its own README and
version.

| Component                    | Version | What it does                                                                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| [codex-gate](codex-gate/)    | 0.3.1   | Rounds of adversarial Codex review and agent fixes before a PR to `dev` or `main`. [README](codex-gate/README.md) |

## Using a component

Load a component by naming its folder in `CLAUDE_CODE_PLUGIN_DIRS`, for
example in `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/pr-gate/codex-gate" }
```

Each component's README covers its own setup, options and checks.

## In planning

[LIFECYCLE_SPEC.md](LIFECYCLE_SPEC.md) describes the next major version of
`/pr-gate`: one lifecycle, review history and budget across pre-PR and
post-PR review. It will be built in a separate folder while `codex-gate`
stays at 0.3.1 as the plugin in use.

## Versions

A component's version is the `version` field in its
`.claude-plugin/plugin.json`. Its README and the table above repeat it, so
bump all three together.

## License

MIT. See [LICENSE](LICENSE).
