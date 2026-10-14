# codex-gate

A Claude Code mod that runs rounds of adversarial Codex review on a branch
**before** its pull request is opened, the way lint and tests run locally
before a push. Codex is reached through the gstack `/codex` skill; the fixes
are made by an agent; the mod keeps the rounds going without a person
nudging each one.

## What happens

1. An agent runs `gh pr create` (or the GitHub MCP create-PR tool) against a
   gated base (`dev`, `main`). The mod holds the call and starts the gate.
   `/pr-gate [base]` starts it by hand.
2. **Scope.** The diff against `origin/<base>` is sized: `trivial` (docs
   or already-reviewed changes only, Codex skipped; see below), `standard`, or `high` (a path matching
   `highRiskPaths`, over 400 changed lines, or over 25 files).
3. **Review.** A sub-agent invokes the `codex` skill in review mode and
   reports Codex's findings. On a `high` change a second sub-agent runs the
   skill's challenge mode in parallel.
4. **Fix.** P0/P1 findings go to the main agent (or a sub-agent, per
   `fixer`), which verifies each against the code, fixes or rebuts it, and
   commits. On a `high` change another sub-agent reviews the fix first.
5. **Again.** Codex reviews the new commits; rebuttals are put to Codex
   through the skill's consult mode. This repeats until no P0/P1 finding is
   left, or `maxRounds` (5) is reached; then the PR is opened either way.
6. **Advisories.** Once nothing blocks, whatever else Codex raised (P2/P3)
   goes to the fixer, who fixes, rebuts or defers each one. New commits go
   back to Codex, and so does a rebuttal until round `advisoryMinRounds`
   (1). This stops when Codex raises none, when the fixer changes nothing
   more, or after `advisoryMaxRounds` (3). These rounds are on top of
   `maxRounds`; a fix that adds a P0/P1 goes back to step 4.
7. **PR.** The main agent is prompted to push and open the pull request by
   the repository's own rules, and is given every finding Codex raised
   with what became of each, to report in the conversation. The held `gh pr create` now goes through,
   for the commit the gate finished on. A docs-only commit on top (a
   CHANGELOG line) rides on that verdict; any other new commit, or a
   rebase, needs a new gate.

A promotion between gated bases (`dev` into `main`) is not gated, and
neither is a PR for another repository (`--repo`) or from a branch that is
not checked out.

The gate fails closed: a review that did not complete (timeout, auth, no
verdict) stops it as an error and spends no round. A finding the fixer
defers, because the fix reaches past the branch's scope, stops it as
`blocked` for a person to decide.

## What counts as already reviewed

Nothing is keyed on a `docs/` branch name: a change is trivial because of
**what it changes**. Codex is skipped, on any branch, when every changed
file is one of these:

- a doc (`*.md`, `docs/`, `specs/`, `CHANGELOG*`, `LICENSE*`);
- a submodule pointer whose new commit is already on that submodule's
  `origin/main` or `origin/dev` (a Backend pointer bump after promotion). A
  pointer to a commit on neither is unreviewed code arriving through the
  pointer, and stays high blast radius;
- a `package.json` or `package-lock.json` change to `"version"` lines only.

A branch whose every commit is already on another gated base (a back-sync of
`main` into `dev`), with no merge commit carrying edits of its own, is skipped
too.

## The light lane (`chore/`)

A branch matching `lightBranches` (`^chore/`) that still needs Codex gets one
round and no advisory rounds. Codex starts at `lightEffort` (`low`), or at
`high` on a high blast-radius change. With `onExhausted: open-pr` (the
default), what it raises does not hold the pull request: the gate ends
`exhausted` (or `passed`), and the findings go to the main agent for the pull
request's own review. With `stop`, a P0/P1 still holds it. The prefix is a weak signal,
since hooks code can be named `chore/` too, so a high blast-radius chore still
reviews at high effort.

## Effort

Codex starts at `high` on a high blast-radius change (`highRiskPaths`, or a
large diff) and at `reviewEffort` (`medium`) otherwise. It never runs at
`xhigh`, which timed out. When a review times out (the reviewer reports
`"error":"timeout"`, or the review step passes `stepTimeoutMinutes`), the
same round reruns one level lower and spends no round: high, then medium,
then low. A timeout at `low` fails closed. The next run on that branch
starts one level below where the timed-out run ended. A run that stepped down
and then completed its reviews keeps that effort for the branch: later runs
start no higher than it. A branch that never stepped down keeps no such
limit, so it still starts at `high` once it grows into high blast radius. A reviewer that was
replaced is not stopped, since there is no way to; its late answer is
ignored.

## The pane

`Codex gate` shows the branch, the round, a line that changes in place as
the agents call tools (`in progress: codex round 2 · waiting on 1 agent`),
the to-do list of steps, and Codex's findings with what became of each.
The surface decides where a pane sits: docked beside the transcript in a
fullscreen terminal from 110 columns, above the prompt otherwise.

## Commands

| | |
| --- | --- |
| `/pr-gate [base]` | start the gate for the current branch |
| `/pr-gate status` | one line of where it stands, and open the pane |
| `/pr-gate stop` | stop a running gate |
| `/pr-gate waive <reason>` | let this commit's PR through without the gate; the person's alone |

## Options

Set in `/config` or under `pluginConfigs["codex-gate"].options`:
`maxRounds`, `advisoryMinRounds`, `advisoryMaxRounds`, `bases`, `enforce`, `fixer` (`main` or `subagent`),
`fixReview` (`auto`, `always`, `never`), `onExhausted` (`open-pr` or
`stop`), `openPr`, `highRiskPaths`, `reviewEffort`, `lightBranches`,
`lightEffort`, `stepTimeoutMinutes`.

When the rounds run out with `onExhausted: open-pr`, the pull request says
only that the gate did not converge, with a count. Findings, advisory
ones included, are reported in the conversation and never pasted into the
pull request.

The gate is an early review, not the last one: the
prompt that opens the pull request tells the agent to run the repository's
full PR lifecycle afterwards, non-required reviewers and checks included,
whether the gate came back clean or ran out of rounds.

## Needs

The gstack `codex` skill and an authenticated `codex` CLI. The
`superpowers:receiving-code-review` skill is used by the fixer when present.

## Running it

```
claude --plugin-dir /path/to/codex-gate
```

or name the folder in `CLAUDE_CODE_PLUGIN_DIRS`. Checks:
`claude plugin validate .` and `claude plugin test .`
