# Vision

What the PR gate is for, in Adam's terms. This file states the goals and the
order they come in. It is not a roadmap: the waves of work that move toward
these goals are planned separately, and every design choice in
[LIFECYCLE_SPEC.md](LIFECYCLE_SPEC.md) and the rulings doc should serve a goal
named here.

## The goals, in order

Each goal builds on the one before it. A later goal isn't worked on in earnest
until the earlier ones run without errors.

### 1. Pre-PR review rounds that run smoothly

The gate runs Codex review rounds, and the fixes for their findings, **before
the PR opens**. That way most problems are caught while they are cheap and the
post-PR rounds stay short.

- **Where it stands:** this works well. pr-lifecycle's pre-PR rounds are much
  faster than codex-gate's, and the way it calls `/codex` no longer blocks
  opening the PR.
- **What's left:** adjustments so the rounds run without friction, such as the
  round budget, the lane choice and the effort per tier. No redesign.

### 2. Post-PR review rounds that oversee themselves

The gate runs the PR's review rounds from start to finish: it collects the
reviews, has the agent triage and fix, gets fixes verified, and moves on. **Adam
should not have to babysit the PR or nudge the agent.**

- **Success:** the person is involved only for decisions that are truly theirs.
  Not to restart a round after a push, not to grant one more round for a routine
  fix, and not to tell the agent something the gate already knows.
- **Where it stands:** the code covers the whole lifecycle. The first live run
  (cookbook PR #3706, about 2 hours, 2-3 manual interventions) showed that it
  needs fixes and tuned settings to get there. See
  [Discussion #15](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/discussions/15).
- **The time is outside Codex:** a Codex review takes 1-2 minutes. The time
  goes to waiting on other reviewers and on the person. The gate should lean on
  Codex, the fast part, and remove those waits.

### 3. Ship faster, and still catch bugs

With goals 1 and 2 in place, code ships faster without losing what the reviews
catch. **Every finding ends up either fixed or tracked:**

- fixed in the PR, and verified;
- or ticketed: a Jira issue where the repo has a Jira project, or a GitHub issue
  on repos without one, as a last resort.

No finding is lost because a round ended, a budget ran out or a thread got
resolved.

### 4. The ultimate goal: decide what happens when a PR is exhausted

First, **redefine "exhausted"**. Today it means a lifecycle has used up its
review rounds. The new meaning should fit how rounds actually go once goals 1-3
work.

Then, when a PR is exhausted with findings still unresolved, the gate decides
between:

- **blocking the merge**, or
- **allowing the merge, with an issue filed for each unresolved finding**
  (goal 3's tracking).

**In either case, the outcome goes to Adam.** A blocked PR, or a PR merged with
issues, is never silent.

This goal isn't expected until goals 1 and 2 run without errors. That is the
current focus.

## How to use this file

- When a ruling or spec rule works against a goal here, that is a reason to
  revisit it. The rulings were made before the gate was used live, and using it
  live is the better evidence.
- Fix and tune before redesigning. The lifecycle code exists; it needs to work
  smoothly.
- Work on a later goal must not break an earlier one.
