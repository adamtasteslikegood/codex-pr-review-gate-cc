# pr-lifecycle 1.0.0: design

Status: design settled with Adam on 2026-10-16. Implements
[LIFECYCLE_SPEC.md](../../../LIFECYCLE_SPEC.md). `codex-gate/` stays frozen at
0.3.1 and is not touched.

## Goal

One `/pr-gate` controller that owns a branch from its first pre-PR Codex round
to "ready for the final merge decision", with one shared review budget and one
persistent record of heads, rounds, attempts and finding dispositions. A
protected post-PR baseline always runs, whatever happened before the PR
opened.

Success: the spec's 13 "Behaviors to verify" pass as tests, alongside the
0.3.1 suite (adjusted only where behaviour deliberately changes).

## Decisions

| Question | Decision |
| --- | --- |
| Folder and plugin name | `pr-lifecycle/`, plugin `pr-lifecycle`, version 1.0.0; command stays `/pr-gate` |
| What ends post-PR collection | Hybrid: optional per-repo roster file; otherwise checks settled plus a quiet period; always capped by a wait timebox |
| Routine timebox | Soft target on active time (reported, not failing); `stepTimeoutMinutes` stays the hard fail-closed cap; waiting has its own clock and cap |
| Merge | Held for gated bases until the lifecycle is `ready` for the current head; waivable by the person |
| Post-PR evidence | Repo reviewers first; local Codex on the delta as fallback when no repo reviewer covers the head within the wait cap |
| Budget | One discretionary allowance per lifecycle by tier, shared by pre/post and blocking/advisory; protected post-PR baseline outside it |
| `/pr-gate-round` | Internal operation only for 1.0.0 |

## 1. Structure and state

New folder `pr-lifecycle/`, started from a copy of `codex-gate/` at 0.3.1.
Plugin name `pr-lifecycle` (state keys, store keys, pane id and
`pluginConfigs` key all derive from it). Never load it together with
`codex-gate/`.

| File | Role | Pure |
| --- | --- | --- |
| `hooks/core.ts` | `classify`, pass-through helpers, trailer readers, prompts (now history-aware) | yes |
| `hooks/lifecycle.ts` | Lifecycle record operations: budget policy, baseline rules, controller decision, finding ledger transitions, coverage | yes |
| `hooks/github.ts` | Parse `gh api` JSON (reviews, review comments, issue comments, check runs) into `Feedback` with stable ids; read `gh pr merge`; read the roster file | yes |
| `hooks/round.ts` | Execute one round (review, fix, verify; post-PR collect) and return a `RoundResult` | no |
| `hooks/pane.tsx` | The pane, moved out of `register.tsx` with the new budget/phase lines | UI |
| `hooks/register.tsx` | Hooks, guards, commands, controller wiring | no |

State is split in two:

- **`LifecycleRecord`** in `$.store` under `lifecycle:<root>:<branch>`. It
  survives restarts and replaces `PassRecord`. Fields:
  - identity: repo slug, root, branch, base, PR number when known;
  - `head` and, per review, the head it covered;
  - `tier`, `tierWhy`, `lane`, pass-through reasons;
  - budget: `allowance`, completed rounds (derived), `attempts`, `activeMs`, `waitMs`, `grants` (extra rounds the person allowed, with reasons);
  - `rounds: RoundRecord[]`, each with `phase: 'pre' | 'post'`, `kind: 'baseline' | 'discretionary' | 'final-head-check'`, `startHead`, `endHead`, `completed`, evidence, `activeMs`, `waitMs`, `outstanding?`;
  - `findings: Finding[]` (the ledger, section 3);
  - `processed: string[]` (external feedback ids already handled) and `replies` (feedback id to reply id);
  - `waivers: Waiver[]`;
  - `phase: 'pre' | 'post' | 'ready' | 'archived'` and `status` (`running`, `passed`, `exhausted`, `blocked`, `error`, `stopped`, `waived`).
  - Effort carry-over from 0.3.1 (`effort`, `hasTimedOut`, `passedEffort`) moves onto the record unchanged.
- **`Run`** in `$.state`: only the round in flight (steps, pending agents,
  activity, phase start). The pane reads both.

`round` stays an iteration label for step names and trailers. The budget
counts completed `RoundRecord`s only; a skipped review or a failed attempt
never consumes a round.

Type-check fix (plan task 1): the 0.3.1 type check runs out of memory on the
generated `.claude-plugin/types/claude-code-mcp/index.d.ts`. The new folder's
`tsconfig.json` excludes that package and declares the two GitHub MCP tool
inputs it matches (create PR, merge PR) locally.

## 2. Lifecycle flow and one round

Phases: `pre` → PR opened → `post` → `ready`. A successful `gh pr create`
records the PR number and switches to `post` instead of ending tracking. A
merged or closed PR archives the record.

### One round

`round.ts` exposes one operation taking `(record, phase, startHead)` and
returning:

```ts
type RoundResult = {
  startHead: string
  endHead: string
  evidence: { source: string; reviewer: string; head: string; complete: boolean }[]
  dispositions: { findingId: string; status: FindingStatus; note?: string }[]
  commits: string[]
  checks: string[]
  completed: boolean
  outstanding?: string
  activeMs: number
  waitMs: number
}
```

- **Pre-PR round**: Codex review (plus challenge in parallel on `high`),
  fixer answers each finding, optional verify of the fix (`fixReview`).
  Completed when every reviewer returned a verdict and the fix step ended
  with an answer. The fix step runs on every finding of the round, blocking
  and advisory alike: each is answered fixed, rebutted with a reason, or
  deferred with a reason. A finding left without an answer gets the fix
  step prompted once more for the missing ids, which consumes no round; one
  still unanswered stays `open` and is reported as unresolved. A blocker's
  fix is re-reviewed on the allowance. The reserve rule decides only whether
  Codex re-reviews advisory fixes before the PR opens; when it does not, the
  free post-PR baseline round reviews that head. A Codex timeout or missing
  verdict is an incomplete attempt: effort recorded, no round consumed.
  Timeout step-down and retry behave as in 0.3.1.
- **Post-PR round**:
  1. *Collect* (section 4) until the end condition or the wait cap.
  2. *Codex fallback*: when no repo reviewer covered the current head and the
     head is not already covered, run local Codex review on
     `<lastReviewedHead>..HEAD`.
  3. *Triage* (section 3), then prompt the main agent to verify, fix or
     rebut, reply in the thread, and run checks.
  4. *Record* the resulting head.
  Feedback already processed is filtered out before step 3. If nothing new
  arrived and the head is unchanged, no round is recorded.

### Controller decision (pure, `lifecycle.ts`)

After each round:

- **Pre-PR**: nothing blocking, every finding answered by the fix step, and
  either no advisory fixes to re-review or no allowance to re-review them
  under the reserve rule → pre-PR gate complete; prompt the
  main agent to open the PR. Blocking findings and allowance left → next
  round. Allowance spent with blockers → `exhausted`, then `onExhausted`
  decides whether the PR may open.
- **Post-PR baseline**, free of allowance: post-PR round 1 always runs; round
  2 runs when round 1 changed the head, by anyone.
- **After the baseline**: the last round clean, verified and head unchanged →
  `ready`. Clean means no finding from either phase, at any severity, is
  `open`, `deferred`, `reported-fixed` without verification, or `rebutted`
  without Codex accepting the rebuttal. Post-PR, Codex checks every rebuttal
  on the same head (free of allowance); a rejected rebuttal reopens the
  finding. A deferral is an honest answer that lets triage end, but it keeps
  the merge held: only the person's waiver of that finding (or `waive post`)
  releases it. Opening a PR and merging it are separate actions; open
  findings may ride into the PR, never into the merge. A new unreviewed head → a discretionary round if allowance
  remains, otherwise a `final-head-check` (Codex on the delta only), which is
  always permitted. Budget exhaustion never certifies an unreviewed head.
  Substantive issues and no allowance → `exhausted`, with a report of what
  remains and the smallest next step.

Commits pushed by others: each poll compares the PR head with
`record.head`. An unknown head is inspected by the fixer in the next round
and needs coverage.

Rebase or force-push: history stays. Coverage is recomputed against the last
reviewed head by patch-id comparison; evidence on unchanged files stays
valid. A rescope that raises the tier raises the allowance to the new tier's
total; rounds already used still count.

## 3. Findings ledger and triage

```ts
type FindingStatus = 'open' | 'reported-fixed' | 'verified-fixed' | 'rebutted' | 'deferred'

type Finding = {
  id: string
  source: 'codex-review' | 'codex-challenge' | 'github'
  reviewer: string          // GitHub login, or 'codex'
  externalId?: string       // review or comment id
  threadId?: string
  url?: string
  severity: Severity
  isSecurity?: boolean
  title: string
  file?: string
  line?: number
  headSeen: string
  firstRound: number
  status: FindingStatus
  history: { round: number; status: FindingStatus; note?: string; evidence?: string; by: string }[]
}
```

`open` is the spec's "still unresolved".

Transitions:

- The fixer's answer sets `reported-fixed`, `rebutted` (with evidence) or
  `deferred` (with a reason; an accepted nonblocking deferral).
- `verified-fixed` only from verification: the verify step, a later reviewer
  explicitly confirming it, or Codex holding no objection when the finding
  is put to it in consult mode.
- **No automatic close.** The 0.3.1 rule at `register.tsx:412` (an open
  finding Codex no longer raises becomes `fixed`) is removed. A finding a
  later review omits keeps its status; `reported-fixed` stays "verification
  owed" and is listed as such.

GitHub feedback carries no standard severity. On first processing the main
agent assigns one, using the reviewer's own label where present; the ledger
keeps it.

Triage classes, computed before the agent sees anything:

1. **Processed**: `externalId` in `processed`. Dropped silently.
2. **Duplicate of an answered finding**: same file, nearby line, similar
   title, and the earlier answer's evidence still applies (the file has not
   changed since). Sent with the earlier answer attached; the reply points to
   it.
3. **New claim on previously reviewed code**: handled on its merits; prior
   review cannot dismiss it.
4. **Finding on newly changed code**: handled normally.
5. **Blocker or nit**: P0/P1 block, P2/P3 do not.

Every review prompt, Codex included, gets a "prior rounds" section: the
still-applicable findings in the touched files, their dispositions,
evidence, and verification owed.

Replies: inline findings are answered in their thread
(`gh api repos/{o}/{r}/pulls/{n}/comments/{id}/replies`); top-level reviews
get an issue comment. The reply id is recorded so a resumed session does not
reply twice.

A P1 finding marked security cannot end `deferred`, nor let a run pass on
exhaustion, without a person's waiver naming it.

## 4. Post-PR collection, roster and time

Optional per-repo roster file `.github/pr-gate.json`:

```json
{
  "reviewers": ["claude[bot]", "copilot-pull-request-reviewer[bot]"],
  "checks": ["Claude Review", "ci"],
  "requestReview": ["copilot"],
  "quietMinutes": 3,
  "waitCapMinutes": 20
}
```

All fields optional; repo values override plugin options.

Collection ends when:

- with a roster: every listed reviewer has posted on the current head and
  every listed check has completed;
- without one: every check run has completed and nothing new arrived for
  `quietMinutes`;
- always: at `waitCapMinutes`, with whatever arrived. Missing evidence is
  recorded (`complete: false`); if no reviewer covered the head, the Codex
  fallback runs.

Polling: `$.clock.every` about every 30 s while waiting, `gh api` through
`$.process.run`: `pulls/{n}`, `pulls/{n}/reviews`, `pulls/{n}/comments`,
`issues/{n}/comments`, `commits/{head}/check-runs`. Reviews and comments
are tied to a head by `commit_id` where GitHub provides it. Only the
controller's polls establish that feedback arrived; session events never do.

While waiting, the session stays free and the pane shows who is awaited and
for how long. On `session.start` with a record in `post`, polling resumes,
and `processed` prevents redoing work.

Time:

- `activeMs`: agent steps, compared with `routineRoundMinutes` (3).
  Overrunning is shown and recorded, not failed.
- `waitMs`: waiting on external reviewers; never counted as effort.
- `stepTimeoutMinutes` (30): fail-closed hard cap on any single agent step,
  as in 0.3.1.

`requestReview`: on a new head in round 2 or later, the controller
re-requests review from the listed reviewers. Otherwise it never triggers
reviewers.

If `gh` is unauthenticated or rate-limited, the attempt is recorded
incomplete with the reason and fails closed; the pane says what to fix, and
`/pr-gate resume` retries.

## 5. Guards, commands, waivers, exhaustion

Guards:

- `gh pr create` and the GitHub MCP create-PR tool: as in 0.3.1, reading the
  record. Allowed when the pre-PR status is `passed` or waived (pre) for this
  head, or `exhausted` with `onExhausted: open-pr`. A docs-only commit on top
  still rides. Success switches to `post` and starts post-PR round 1.
- `gh pr merge` and the GitHub MCP merge tool (new, `enforceMerge`): held for
  gated bases unless the phase is `ready` for the PR's current head or the
  person waived post. Any open, deferred, unverified or unaccepted finding
  keeps the merge held, whatever its severity. The refusal names what is missing (for example "round 2
  owed on a1b2c3d", "R3-2 [P1] unresolved"). A refusal never starts work.
- Not intercepted: PRs from a branch not checked out here, other repos
  (`--repo`), promotions between gated bases.
- Every route that opens or merges a PR goes through one pure classifier,
  `readPrAction(tool, input)` in `github.ts`, returning `create` or `merge`
  (merge includes merge-queue enqueue and auto-merge) or nothing:
  - Bash: `gh pr create`, `gh pr merge` (with or without `--auto`), `gh api`
    REST calls (`POST .../pulls`, `PUT .../pulls/{n}/merge`), and `gh api
    graphql` with a `createPullRequest`, `mergePullRequest`,
    `enqueuePullRequest` or `enablePullRequestAutoMerge` mutation;
  - `mcp__plugin_github_github__create_pull_request` and `__merge_pull_request`;
  - `mcp__claude_ai_github-graphql-mcp__manage_pull_requests` with `action`
    `create`, `merge` or `enqueue`;
  - fail-closed fallback: any other MCP tool whose name contains `github`
    and whose name or `action`/`method` input reads as creating, merging or
    enqueuing a pull request is held with a message naming the tool,
    waivable like any hold.
  A merge names a PR number, not a base, so the guard reads base, head
  branch and head SHA with `gh pr view <n> --json baseRefName,headRefName,headRefOid`.
  (Added 2026-10-16 after review found the github-graphql connector could
  bypass both holds. `codex-gate` 0.3.1 has the same gap on create; it stays
  frozen unless Adam asks for a fix.)

Commands:

| Command | Effect |
| --- | --- |
| `/pr-gate [base]` | start or resume the lifecycle |
| `/pr-gate status` | phase, budget used/allowance, baseline state, open findings |
| `/pr-gate stop` | stop the round in flight; the record stays |
| `/pr-gate resume` | continue a stopped or incomplete round |
| `/pr-gate waive pre <reason>` | the PR may open; post-PR still runs |
| `/pr-gate waive post <reason>` | this head is ready for the merge decision |
| `/pr-gate waive <findingId> <reason>` | accept one unresolved blocker, security P1 included |
| `/pr-gate allow <n> <reason>` | add discretionary rounds |
| `/pr-gate reset` | archive the record and start fresh |

Waivers, `allow` and `reset` are the person's alone (command origin
`composer` or `bridge`). Each waiver records who, when, head, scope and
reason, and covers its scope at that head; a new code commit needs a new one.

Budget:

- Allowance by tier: trivial 0, light lane 1, standard `allowanceStandard`
  (4), high `allowanceHigh` (6), plus person grants.
- Pre-PR and post-PR rounds, blocking, advisory and rebuttal rounds all draw
  from it.
- Reserve rule: an advisory-only round (Codex re-reviewing advisory fixes)
  runs only while at least one round would remain afterwards. The advisory
  fix itself never waits on the reserve.
- Baseline rounds and the final-head check do not draw from it.

Exhaustion is its own status, never read as passed. The record and pane show
open blockers with evidence and the smallest next step ("fix R4-1 and push",
"`/pr-gate waive R4-1 <reason>`", "`/pr-gate allow 1 <reason>`").

Option migration (README section; old keys read when the new ones are unset):

| 0.3.1 | 1.0.0 |
| --- | --- |
| `maxRounds` | `allowanceStandard` (default 4) |
| none | `allowanceHigh` (default 6) |
| `lightBranches` | unchanged; light lane = allowance 1 |
| `advisoryMinRounds`, `advisoryMaxRounds` | removed; the reserve rule replaces them |
| `reviewEffort`, `lightEffort`, `highRiskPaths`, `fixer`, `fixReview`, `bases`, `enforce`, `openPr`, `onExhausted`, `stepTimeoutMinutes` | unchanged |
| none | `enforceMerge` (true), `routineRoundMinutes` (3), `waitCapMinutes` (20), `quietMinutes` (3) |

Pass-throughs (docs-only, landed submodule pointer, version-only bump,
already-landed commits) still skip pre-PR Codex. Their post-PR baseline is
round 1 on whatever the repo's reviewers post, without the Codex fallback.

## 6. Testing and checks

TDD with `claude plugin test`. The `world()` harness from 0.3.1 gains a fake
`gh` (PR state, reviews, comments, check runs, head, reply posts), a
controllable clock for poll, quiet and cap timers, and a store that persists
across a simulated `session.start`.

- `tests/lifecycle.test.ts`: budget policy, ledger transitions, dedup,
  coverage (pure).
- `tests/github.test.ts`: `gh` JSON parsers, `gh pr merge` reading, roster
  file.
- `tests/gate.test.ts`: the 0.3.1 suite carried over; tests that change on
  purpose (advisory rounds on the shared allowance, no automatic close) say
  why in their names.
- `tests/flow.test.ts`: one test per spec behavior:
  1. A clean pre-PR result still enters post-PR review.
  2. An exhausted pre-PR allowance still permits the post-PR baseline.
  3. A clean first post-PR round does not force a second.
  4. Code changes in post-PR round 1 (own or another agent's push) require review of the resulting head.
  5. Several reviewers in one cycle consume one round.
  6. Duplicate comments and polling consume no round.
  7. Fix commits and a session restart keep budget and history.
  8. New scope invalidates only affected evidence.
  9. Omitted findings are not marked fixed.
  10. Timeout retries record effort, not completion.
  11. Pass-through cases still work.
  12. Two repos with different roster files wait for their own reviewers.
  13. Exhaustion is distinct from passing, and merge stays held.

  Plus: a security P1 cannot pass on exhaustion; a pre-PR waiver does not
  waive post-PR; the merge guard holds and releases.

Checks for every task, from `pr-lifecycle/`: `claude plugin validate .`,
`claude plugin test .`, and the pinned `tsc -p . --noEmit` once task 1 makes
it finish.

Release: bump `plugin.json`, the README version line and the root README
table together (new row for `pr-lifecycle`). Switching
`CLAUDE_CODE_PLUGIN_DIRS` from `codex-gate` to `pr-lifecycle` is Adam's
call.

## Out of scope

- `/pr-gate-round` as a public command.
- Learning a repo's reviewer roster automatically.
- Any hosted service, CI change or fixed reviewer roster.
- Any change to `codex-gate/`.
