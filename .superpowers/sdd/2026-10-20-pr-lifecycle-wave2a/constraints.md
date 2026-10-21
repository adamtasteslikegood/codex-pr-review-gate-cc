# Global constraints (verbatim from the plan) + working notes

- Branch `wave2a/pr-lifecycle-1.4.0` is already checked out in /home/allisone/Projects/pr-gate. Do not switch branches.
- Never touch `codex-gate/` (frozen at 0.3.1).
- Hand style: no semicolons, single quotes, lines up to about 160 columns. **Never run Prettier or `eslint --fix`**; edit surgically.
- Never commit `pr-lifecycle/.claude-plugin/types/` (generated, gitignored). `pr-lifecycle/types/index.d.ts` is tracked and is where the record types live.
- Don't use a bare `npx tsc`. Use `npm run typecheck` from the repo root.
- Do not run any Bash command whose text contains the literal PR-create command line (gh + pr + create, together). The loaded gate refuses it even inside a grep or a string. Build such strings from pieces.
- Commit after each task. End every commit message with:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013psw4N6YUX1kFWBPU3DdQ1
- Tests: `claude plugin test pr-lifecycle` from the repo root (whole suite, fast). Also run `npm run lint` and `npm run typecheck` from the repo root before committing.
- Every refusal of a PR create or merge still starts with "pr-gate HOLD (not an error):" wherever it does today (R77). Prompts never start with `/` (R21).
- An agent prompt never gives the person's command as the agent's own step (R42, R49). The person's steps are only ever named as theirs.
- Spec (authority behind the plan): docs/superpowers/specs/2026-10-20-pr-lifecycle-wave2a-design.md. Rulings doc: docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md.
- The plan's code is a strong draft, not gospel: if a line in it doesn't compile or a test helper differs from what the brief assumes, adapt minimally and say so in your report. If an existing test breaks, change it only when the new behaviour is the one the brief asks for, and say why in the report.
