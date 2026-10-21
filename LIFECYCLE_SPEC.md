<!--
Status (2026-10-16): requested, not started.

Development plan: `codex-gate/` stays as-is at 0.3.1 and remains the loaded
plugin while this is built. The new version is developed in a second
sub-directory of this repo (name to be decided when work starts). Load only
one of the two at a time: both register `/pr-gate` and intercept PR creation.
-->

# Requested change: extend `/pr-gate` across the PR lifecycle

## What I want

Extend the existing plugin so pre-PR and post-PR review share one lifecycle, review history, and budget policy.

Keep `/pr-gate` as the main controller and keep its existing pane, progress reporting, and todo tracking. Separate its responsibilities internally where useful; this does not need to become several independent plugins.

This is a behavior/design request. Exact configuration names and budget defaults can be settled during implementation.

## Current setup

The plugin currently:
- Intercepts PR creation and runs a pre-PR Codex gate through gstack’s `/codex` skill.
- Classifies changes as trivial, standard, or high risk.
- Recognizes existing pass-through cases, including docs-only changes, qualifying submodule promotions, version-only changes, and already-landed commits.
- Runs review/fix/recheck cycles, with additional challenge and fix review for high-risk changes.
- Gives blocking and advisory reviews separate round allowances.
- Hands the post-PR lifecycle back to the main Claude agent.

After opening a PR, existing CI and repository-specific reviewers run. These can include independent Claude Review on GitHub Actions, Copilot, Codex/ChatGPT automation, RovoDev, and Junie.

Claude owns the lifecycle: read feedback, inspect changes pushed by other agents, verify findings, fix or rebut them, test changes, and reply to the relevant threads/comments.

Reviewer availability and triggers differ between repositories.

## Problems to address

- Pre-PR and post-PR reviews have no shared budget.
- Blocking and advisory allowances can stack up before the PR even opens.
- Reviews can repeat work already completed on effectively unchanged code.
- Starting another gate can lose the useful context of previous rounds.
- Some changes receive the right amount of review; others receive too much.
- I sometimes waive the gate because the change is unusual or already reviewed and the existing policy cannot express that well.

The objective is to spend review effort where it adds evidence, while preserving the normal post-PR review process.

## Agreed definition of one round

One round means:

> Collect available reviews for a specific branch/PR head, evaluate the findings, fix or rebut them, verify the outcome, and record the resulting head and finding dispositions.

The number of participating reviewers does not change the round count.

Before a PR exists, use the branch head and gate-requested reviews. Afterward, use the PR head and available repository review feedback.

A completed clean review counts as a round. Merely polling, rereading comments, or receiving duplicate feedback does not.

Fix commits are outputs of the current round. Reviewing those commits can start the next round.

Record incomplete attempts and their effort separately from completed rounds.

## Proposed internal responsibilities

### 1. Scope and risk assessment

Reuse the current classification and pass-through detection.

Produce:
- Risk tier and the reasons for it.
- Applicable pass-through reasoning.
- What changed since the last reviewed revision.
- Which previous review evidence still applies.

A branch name is only a weak signal. Actual changed content and scope remain authoritative.

### 2. Budget policy

Assign a shared review allowance using risk, scope, and applicable review history.

The policy should:
- Account for both pre-PR and post-PR rounds.
- Protect the required post-PR review described below.
- Avoid separate advisory allowances silently adding another budget.
- Reassess materially expanded scope without resetting history.
- Avoid requiring extra rounds solely to reach a minimum when the required evidence is already present.

Track completed rounds separately from attempts, retries, and elapsed review effort. One logical round can contain multiple agent/model calls.

### 3. One-round execution

Extract or adapt the existing machinery into an operation that performs one round under the controller’s allowance.

A possible name is `/pr-gate-round`, but it can start as an internal operation. If exposed as a command, it must use the same lifecycle record rather than creating a separate allowance.

Return structured results:
- Starting head and resulting head.
- Review evidence collected and its coverage.
- Findings and dispositions.
- Changes made and verification performed.
- Whether the round completed.
- Outstanding work or reasons it could not finish.

### 4. Lifecycle controller

Extend `/pr-gate` to maintain the lifecycle across both phases.

Opening the PR becomes a phase transition, rather than the end of tracking.

Reuse the existing session/tool observation and pane where practical. Observe the owning agent’s work and record structured completion evidence; do not infer that a round succeeded merely because a tool was called or a turn ended.

The controller must explicitly obtain or receive GitHub feedback. Session observation alone cannot establish that asynchronous reviews have arrived.

## Required post-PR behavior

Post-PR review still takes place even when:
- The pre-PR gate was clean.
- The discretionary review allowance has been used up.

The baseline is:

1. Collect and process the first post-PR reviews.
2. If that round produces code changes, including changes pushed by another agent, review the resulting head in a second round.
3. If the applicable reviews are clean, verification passes, and no blockers remain, the review phase can pass.
4. If substantive issues remain, use the saved history and remaining allowance to choose the next action.

This is a protected minimum, not an unconditional two-round requirement and not permission to pass after two rounds.

If the second round changes code again, the resulting changes still need verification. Budget exhaustion cannot certify an unreviewed final head.

Distinguish:
- Pre-PR gate complete / PR may open.
- Full lifecycle review complete / ready for the final merge decision.

## How history should affect further review

Use review coverage, changed scope, and finding substance—not just the number of earlier rounds.

For incoming feedback, distinguish:
- A duplicate already answered with still-applicable evidence.
- A new claim about previously reviewed code.
- A finding concerning newly changed code.
- An unresolved blocker.
- A nonblocking improvement or nit.

Prior review can reduce the justification for another broad review. It cannot invalidate a concrete new finding.

Reviewers need access to relevant earlier findings, fixes, rebuttals, and verification so the same argument does not restart from scratch.

## Finding handling

Continue using `superpowers:receiving-code-review` when available.

Claude should:
- Verify claims against the current code before changing it.
- Inspect and verify commits pushed by other agents.
- Fix confirmed issues with appropriate checks.
- Reply in the original inline thread where applicable.
- Rebut incorrect findings with code/test/requirement evidence.
- Explicitly record accepted nonblocking deferrals. A P3 deferral whose `followUp` names where it is tracked (a URL, `#<n>` or `owner/repo#<n>`), is not security, was not lowered to P3 by the agent, and whose P3 is a reviewer's label or Codex's rather than a guess, settles without a waiver (R85).
- Mark a finding `acknowledged` when it asks for no change: it needs a reply in the thread, applies only to a GitHub finding with no security flag and no explicit P0-P2, is stored as a rebuttal, and Codex checks it (R82).
- A review settles with no finding only on positive no-action evidence, such as a plain approval; an unclear one goes to triage (R83).

Do not automatically mark an earlier finding “fixed” because a later reviewer omitted it. Preserve the distinction between:
- Reported fixed.
- Verified fixed.
- Rebutted with evidence.
- Deferred.
- Still unresolved.

## State to preserve

Maintain a lifecycle record containing:
- Repository, branch, base, and PR identity when available.
- Current head and revisions covered by each review.
- Risk classification and pass-through reasons.
- Assigned budget, completed rounds, attempts, and remaining allowance.
- Pre-PR versus post-PR round history.
- Findings, dispositions, supporting evidence, and verification still owed.
- Review feedback already processed, using stable identifiers where available.

Persist enough to resume after interruption without resetting the budget or processing the same feedback twice.

One session runs each record: a headless session in the same checkout never takes it over, and another interactive session does only once the owner has been quiet for 2 minutes (R74). After the PR opens, the gate's own Codex check verifies reported fixes on the head each round ends on, at no round (R72). See the rulings doc's "after the first live run" section (R71-R78) for the 1.3.0 changes, and R79-R87 for 1.4.0.

A normal fix commit continues the lifecycle. A rebase or significant scope change triggers coverage reassessment, not automatic deletion of all history.

## Code areas likely involved

Based on the inspected implementation:

- `hooks/core.ts`
  - Keep/reuse `classify()`.
  - Adjust prompts for lifecycle-aware, history-aware reviews.
- `hooks/register.tsx`
  - Extend the state machine beyond the pre-PR finish/open transition.
  - Separate one-round execution from the decision to start another.
  - Update pane/status reporting for shared accounting.
  - Replace automatic closure of old findings with explicit dispositions.
- `types/index.d.ts`
  - Extend the current run/pass-record model to preserve lifecycle history.
- `.claude-plugin/plugin.json`
  - Update budget configuration and explain migration from existing options.

The current `round` value is an iteration number and starts at 1 even when review is skipped. Do not reuse it unchanged as “completed rounds consumed.”

## Stopping and exhaustion

Preserve fail-closed handling of incomplete reviews.

Retain a configurable routine review timebox; the current working expectation is approximately 2–4 minutes per routine round. Track active work separately from waiting for external reviewers.

When discretionary budget is exhausted:
- Stop automatically repeating broad reviews or advisory/rebuttal loops.
- Still complete the protected post-PR baseline.
- Preserve unresolved findings.
- Report the remaining issue, evidence, and smallest useful next step.
- Require a deliberate decision for unresolved blockers.

P1 security findings must not become acceptable simply because time or rounds ran out.

Keep human waivers explicit and attributable. A pre-PR waiver must not silently waive the post-PR lifecycle.

A post waiver covers its head: it ends review holds for it and sets aside, by name, the checks GitHub doesn't require. Checks GitHub does require, from the base's rulesets and classic protection, still hold, a required check that never reported included, and an unreadable list holds too (R80, R86). A resume reads the PR's head first: when someone pushed past the waived head, it says so and asks for a pull, then a resume. Every manual action by the person ends with one message to the agent (R81).

## Behaviors to verify

- A clean pre-PR result still enters post-PR review.
- Exhausted pre-PR allowance still permits the protected post-PR baseline.
- A clean first post-PR round does not force an unnecessary second round.
- Code changes in the first post-PR round require review of the resulting head.
- Several reviewers participating in one cycle consume one logical round.
- Duplicate comments/polling do not consume new completed rounds.
- Fix commits and session restarts preserve budget/history.
- New scope invalidates affected evidence without erasing unrelated history.
- Omitted findings are not automatically marked fixed.
- Timeout retries record effort without recording false completion.
- Existing pass-through cases remain supported.
- Different repositories work with different reviewer rosters.
- Exhaustion remains distinct from passing.

## Keep the change focused

Reuse the existing review execution, session hooks, commands, and UI where practical. The main change is lifecycle ownership and accounting.

No new hosting service, replacement CI pipeline, fixed reviewer roster, or separate project-management layer is needed.
