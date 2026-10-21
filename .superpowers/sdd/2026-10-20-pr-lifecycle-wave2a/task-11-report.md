# Task 11 report

Status: DONE. Commit bb4f037 "pr-lifecycle 1.4.0: rulings R79-R87, spec, docs and version".

## Changes
- docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md: new section "Rulings in wave 2a (1.4.0)" with R79-R87, one line each in the doc's "Ruling Rn (...): ... — cost if wrong: ..." form. R79 says a late review is held by the guard's untriaged-feedback check (no `late-feedback` blocker kind). R80 covers a waiver naming the PR head. R86 says the unreadable-CI hold quotes gh.
- LIFECYCLE_SPEC.md: finding-handling bullets for followUp P3 deferrals (R85), `acknowledged` (R82), no-action approvals (R83); waiver paragraph for `waive post` reach, required checks and the per-action agent message (R80, R81, R86); pointer line now also cites R79-R87.
- CLAUDE.md: 1.4.0, rulings list gains R79-R87, test count 415 -> 472, resolved optional-CI follow-up removed. codex-gate parts untouched.
- ROADMAP.md: wave 2a status line (built on `wave2a/pr-lifecycle-1.4.0`, R79-R87) plus a mention of R87.
- plugin.json, pr-lifecycle/README.md, root README table and "Which one to load" line: 1.4.0.

## npm run check (exit 0)
- lint: clean
- test: codex-gate 22 pass / 0 fail; pr-lifecycle 472 pass / 0 fail
- validate: both passed (only the marketplace-install advice)
- typecheck: passed (tsc -p pr-lifecycle, 0 errors)

## Concerns
- The commit trailer names "Claude Sonnet 5.5", following the session's attribution reminder, not constraints.md's "Opus 5.5".
- CLAUDE.md's heading "Current state (2026-10-17, after wave 1)" is left as is; wave 2a is not merged yet.
- Also edited the root README's "Which one to load" line (1.3.0 -> 1.4.0) beyond the brief's table, to keep versions together.
