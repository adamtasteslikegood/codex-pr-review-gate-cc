## Summary

<!-- What changes and why, in a few lines. -->

## Component(s) touched

- [ ] `pr-lifecycle`
- [ ] `codex-gate` (frozen at 0.3.1: only for a fix Adam asked for)
- [ ] Repo tooling or docs only

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run validate` passes
- [ ] `npm run typecheck` passes
- [ ] If a component's version changed: its `plugin.json`, its README version line and the root README table are bumped together
- [ ] No generated `.claude-plugin/types/` files are committed
- [ ] `codex-gate/` is untouched, unless Adam asked for the change

Pre-PR Codex gate: <!-- the /pr-gate verdict for this branch, e.g. PASS after round 2 -->
