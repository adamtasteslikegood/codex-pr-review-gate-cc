# Task 12 report: docs and version 1.6.0

Status: done.

Files changed:
- pr-lifecycle/.claude-plugin/plugin.json (1.6.0)
- pr-lifecycle/README.md (version line, `sharedStore` setting, new "The shared store" section)
- README.md (table: 1.6.0, relay row, "Which one to load")
- pr-lifecycle-relay/README.md (rewritten: routes, ops, grants, bindings, ADMINS, seeding, TEST_FAULTS route)
- CLAUDE.md (current state 1.6.0, R100-R108, relay bullet, counts)
- ROADMAP.md (1.6.0 follow-up: built, not deployed)
- docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md (§7.2 stuck-filings label, §12 measured count and identity, §14 409/423 wording and the Task 8 ruling)

R100-R108 were already in the rulings doc; nothing added there.

Counts (own run): codex-gate 22, pr-lifecycle 813, relay 86. `timeoutMs: 15_000` occurrences in pr-lifecycle/tests: 53.
`npm run check` passed on the second run. The first run failed one test, "the shared allowance (4) without agreement ends the pre-PR gate as
exhausted", which timed out at 5000 ms (it has no `timeoutMs: 15_000`); it passed on the rerun.
