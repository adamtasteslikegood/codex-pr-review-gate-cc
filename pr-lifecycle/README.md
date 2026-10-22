# pr-lifecycle

Version 1.5.0. Part of [pr-gate](../README.md); MIT licensed, see
[LICENSE](../LICENSE).

A Claude Code mod that takes a branch through the whole pull request
lifecycle: rounds of adversarial Codex review **before** the PR is opened,
then the repository's own reviewers and checks **after** it is, under one
review budget and one record. It replaces `codex-gate` 0.3.1 and keeps its
command, `/pr-gate`. Codex is reached through the gstack `/codex` skill; the
fixes are made by an agent; the mod keeps the rounds going without a person
nudging each one.

## What happens

1. An agent runs `gh pr create` (or the GitHub MCP create-PR tool) against a
   gated base (`dev`, `main`). The mod holds the call and starts the gate.
   `/pr-gate [base]` starts it by hand. A `gh pr create` that names no base
   is checked against the base GitHub will use, the repository's default
   branch (`gh repo view`); if gh cannot read it, the create is held and the
   agent is told to name `--base`. REST, GraphQL and MCP creates require a
   base, so one whose base the mod cannot read is held against the first
   gated base.
2. **Scope.** The diff against `origin/<base>` is sized: `trivial` (docs
   or already-reviewed changes only, Codex skipped; see below), `standard`, or
   `high` (a path matching `highRiskPaths`, over 400 changed lines, or over 25
   files). The tier sets the review allowance.
3. **Review.** A sub-agent invokes the `codex` skill in review mode, naming
   the tier's Codex model and effort, and reports Codex's findings. On a
   `high` change a second sub-agent runs the skill's challenge mode in
   parallel. See Models and effort.
4. **Fix.** Every finding, blocking or not, goes to the main agent (or a
   sub-agent, per `fixer`), which verifies each against the code and answers
   it: fixed, rebutted with a reason, or deferred with a reason. On a `high`
   change another sub-agent reviews the fix first.
5. **Again.** Codex reviews the new commits; rebuttals are put to Codex
   through the skill's consult mode. This repeats until no P0/P1 finding is
   left, or the allowance is spent.
6. **The PR opens.** Opening is a phase change, not the end. The main agent is
   prompted to push and open the pull request by the repository's own rules,
   and the held `gh pr create` goes through for the commit the gate finished
   on. A docs-only commit on top (a CHANGELOG line) rides on that verdict; any
   other new commit, or a rebase, needs a new gate. A pre-PR gate that spent
   its allowance still lets the PR open with `onExhausted: open-pr` (never with
   an open security P1); with `stop` it stays held.
7. **Post-PR round 1, the protected baseline.** It always runs, whatever
   happened before the PR opened, and draws nothing from the allowance. The
   mod *collects* the PR's own reviews and checks, then, if no repository
   reviewer covered the head within the wait cap, runs a *Codex fallback* on
   the delta since the last reviewed head. The main agent *triages* what
   arrives, while collection still runs: it verifies each item against the
   code, fixes or rebuts it, and *replies* in the reviewer's thread. Round 2,
   also free, runs when round 1 changed the head, by anyone. A clean first
   round does not force a second.
8. **Ready.** When the last round is clean, verified and the head unchanged,
   the lifecycle is `ready`: the agent is told no review finding holds the
   merge, and merges (R93). A new unreviewed head gets a discretionary round if allowance
   remains, otherwise a *final-head check* (Codex on the delta only) outside
   the allowance. Running out of allowance never certifies a head nobody
   reviewed.
9. **The merge hold.** Opening a PR and merging it are separate actions. See
   below.

A promotion between gated bases (`dev` into `main`) is not gated, and
neither is a PR for another repository (`--repo`) or from a branch that is
not checked out. A PR the gate never saw opened is adopted into post-PR review
when `/pr-gate` runs on its branch; a merge attempt is held and tells the
agent to run it.

The gate fails closed: a review that did not complete (timeout, auth, no
verdict, `gh` failing, a Codex model gstack cannot use) is an incomplete attempt. It records its effort, spends
no round, and `/pr-gate resume` retries it.

Nothing is reviewed against a stale base. Each fetch the gate makes before a
review (the base, the other gated base, a changed submodule's `main` and `dev`,
and after the PR opens, the PR's new commits) is tried once more when it fails.
A second failure starts no round: the agent and the status line get git's
error, and the next `/pr-gate` or create fetches again. A ref the remote does
not have is not a failed fetch.

## One round

One round means:

> Collect available reviews for a specific branch/PR head, evaluate the findings, fix or rebut them, verify the outcome, and record the resulting head and finding dispositions.

The number of participating reviewers does not change the round count.

Before a PR exists, the round uses the branch head and the gate-requested
reviews. Afterward, it uses the PR head and the available repository review
feedback.

A completed clean review counts as a round. Merely polling, rereading
comments, or receiving duplicate feedback does not.

Fix commits are outputs of the current round. Reviewing those commits can
start the next round.

Incomplete attempts and their effort are recorded separately from completed
rounds.

After the PR opens, a round is one head (R88). Triage starts during
collection: findings go to the agent as they arrive, and it pushes as it goes.
A push ends the round on its old head at the end of the turn that pushed, and
the next round starts on the new head.

## The budget

One discretionary allowance per lifecycle, shared by pre-PR and post-PR
rounds, blocking, advisory and rebuttal rounds alike:

| Tier | Rounds |
| --- | --- |
| trivial | 0 |
| light lane | `allowanceLight` (3); a high blast radius takes the full lane |
| standard | `allowanceStandard` (4) |
| high | `allowanceHigh` (6) |

- **Reserve rule.** A round whose only purpose is Codex re-reviewing advisory
  fixes runs only while at least one round would remain afterwards. The
  advisory fix itself never waits on the reserve.
- **Outside the allowance.** The post-PR baseline (rounds 1 and 2), the
  final-head check, Codex's checks (rebuttal, deferral, link), and any
  post-PR round that brings no new blocking finding, no Codex rejection and no
  fix (R88). A round in which the agent reports a fix, for a finding raised
  then or earlier, is charged (amendment A8). Up to two rounds the gate adds
  for late blockers (R92) are named in the report.
- **`/pr-gate allow <n> <reason>`** adds 1 to 5 rounds. It is the person's
  alone. It settles no deferral or dispute.
- **Exhaustion** is its own status, never read as passing. The record and the
  pane show the open blockers with evidence and the smallest next step.
  Merging stays held. A rescope that raises the tier raises the allowance to
  the new tier's total; rounds already used still count.

## Findings

Every finding, from Codex or from GitHub, lives in one ledger on the record,
in one of five statuses:

| Status | Meaning |
| --- | --- |
| `open` | still unresolved |
| `reported-fixed` | the agent says it fixed it; verification is owed |
| `verified-fixed` | a verify step, a reviewer, or Codex confirmed the fix |
| `rebutted` | the agent disputes it with evidence |
| `deferred` | the agent set it aside, with a reason |

A finding a later review omits **is never marked fixed**: it keeps its status,
and a `reported-fixed` one stays listed as owed a check.

GitHub feedback carries no standard severity. The main agent assigns one on
first processing, using the reviewer's own label where present. P0/P1 block;
P2/P3 do not block a pass, but every finding at any severity counts against
the merge (below).

Triage drops feedback it has already processed, links a duplicate to the
finding it repeats, and judges a new claim on previously reviewed code on
its merits. A linked finding follows its original's status, and raises the
original's severity when it is higher (R90). The gate links a clear repeat;
a link the agent gives is checked by Codex at no cost. Every review prompt carries a "prior rounds" section: the
still-applicable findings in the touched files, their dispositions and
evidence, and what verification is owed. Inline findings are answered in their
own thread, top-level reviews with an issue comment; the reply id (the comment
number, also when the agent reports the URL gh prints) is recorded
so a resumed session never replies twice. Every reply id the agent reports is
kept as the gate's own, whatever the answer (R91). Of the comments made under this
machine's gh login, only those replies are skipped (an inline reply in a
thread, or a comment whose id is a recorded reply): the person's own other
comments reach triage. Their reviews never count as covering a head.

### Rebuttals

- **Before the PR opens, a rebuttal goes to Codex in the next round**, which
  costs a round. When a round's fix step changed nothing and rebutted nothing,
  the gate holds the PR; `/pr-gate resume` re-opens that fix step on the same
  head for the open findings, using no round.
- **After the PR opens, Codex checks every rebuttal** on the same head. The
  check spends no allowance. A rebuttal Codex accepts settles the finding; one
  it rejects reopens it.
- **A rebuttal Codex has rejected cannot be argued again.** The agent fixes or
  defers it.
- **A second rebuttal is a dispute** (R40). When the review can do no more,
  the gate files an issue for it (below).

### Deferrals and issues

A deferral is an answer, not a release. Codex checks every deferral at the end
of the round, at no cost: if it says the finding can be fixed in this PR, the
finding is open again and the round is charged (R92). If it agrees, the
finding waits.

When the review can do no more (the allowance is spent, or only deferrals and
disputes hold the merge), the gate files a GitHub issue for each finding still
holding it, except security ones:

- title: `R4-3 Major [P2] <title> (#20, <branch>, <Jira key>, <issueSpec>)`;
- label: `severity:<P>`, the highest severity the finding had;
- body: who raised it and where, the problem, and why it was not fixed here.

If the agent's follow-up names an issue that already tracks it, the gate
labels that one instead. An issue counts only once GitHub shows its label; an
issue filed without it is labelled on the next pass, not filed again. A
finding whose severity was lost is filed as Critical [P1]. The issue settles
the finding; a change to its file does not unsettle it. After the merge,
before the gate archives the record, it checks each follow-up issue: it
reopens a closed one, and files one again when gh says it no longer exists or
the reopen fails (see The agent merges). A failure to file holds the merge with gh's words, and the next pass
retries. Security findings wait for `/pr-gate waive <id>`.

Before filing, a blocker first raised in the round that spent the allowance
gets one more round, at most twice per lifecycle. The report then says the
PR's scope may be too wide.

### Security P1

A P1 marked security cannot end deferred, and cannot let a run pass on
exhaustion, without a waiver naming it. `waive pre` and `waive post` never
release it.

### Waivers lapse

A finding waiver lapses when the finding's file changes (R50, R55); it stays
in the history as lapsed, and only a fresh waiver restores it. The same applies
to an accepted rebuttal and to a verified fix: when a push touches their file,
each becomes *re-verify owed* and holds the merge until Codex re-verifies it
(R58). A re-verify Codex rejects reopens the finding. A commit that lands while
a fix-review verify runs is not covered by it (R59). A finding settled by its
issue does not lapse (R92).

## The merge rule

Opening a PR and merging it are separate actions. Open findings may ride into
the PR; they never ride into the merge (R39).

A merge to a gated base is held unless the lifecycle is `ready` for the PR's
current head, or the person waived it. There is **no merge while any finding,
from either phase, at any severity, is open, deferred, unverified (including
owed a re-verify), or rebutted without Codex accepting the rebuttal**, unless
its follow-up issue settles it (R92) or the person waived that finding. The refusal names what is missing ("post-PR
round 1 owed", "R3-2 [P1] unresolved"). A refusal never starts work. A new push
holds the merge again until the new head is reviewed.

**CI must be green too.** Once the review lets a merge through, ready or
waived, the guard reads the PR head's checks with `gh pr checks <n> --json
name,state,bucket`. A failing or cancelled check, or one still running, holds
the merge; the refusal names the checks and tells the agent to fix them, rerun
a flaky one, or wait for the running ones. No waiver releases this hold: a
`waive post` covers the review, not CI. A PR with no checks merges. Checks gh
cannot read hold the merge (fail closed), with gh's error.

### Who decides

The gate settles review itself and gives the agent its own next step: fix this,
answer that, run `/pr-gate resume`. It names the person for:

- a security finding that is deferred or disputed, which the gate never files;
- a review exhausted with a head no round reviewed and nothing to file
  (`/pr-gate allow 1` or `waive post`);
- a PR retargeted to another base (point it back, or `/pr-gate reset`);
- before the PR opens, exhaustion under `onExhausted: stop` or with a
  security P1 open.

Everything else ends in a fix, Codex's check, or an issue (R92). When nothing
holds the merge, the agent merges (R93). The person's tools are the waivers
and `allow`.

### The agent merges

When no review finding holds the merge, the ready prompt says so and tells the
agent to merge with `gh pr merge <n> --<mergeMethod>` and report the merge
commit (R93). The guard still checks the head and CI. If it holds the merge
for checks still running, the agent waits with `gh pr checks <n> --watch` and
merges again. If a required check fails, or GitHub refuses, the agent reports
the check's or GitHub's words and stops, and the lifecycle stays where it was.
The merge step is sent once. The agent never writes `Closes`, `Fixes` or
`Resolves` before a follow-up issue's number: those issues stay open.

The gate then checks the follow-up issues, after the agent's merge or when a
poll, a session start or `/pr-gate` sees the PR merged. An open issue is
logged. A closed one is reopened with a comment; if the reopen fails, the
gate files a new issue instead. A read that fails with "Could not resolve to
an issue or pull request" means the issue is gone, and it is filed again; any
other failed read leaves the record blocked. A refile that fails also leaves
it blocked. The agent gets gh's words, and `/pr-gate resume` checks again. Only then is the record archived, and the agent is told which
issues stay open.

## Settings per repository

A repository can set its own reviewers and round settings in an optional
`.github/pr-gate.json`. The file is **read from the base branch**
(`origin/<base>`, as the gate last fetched it; a create that only an exhausted
gate under `open-pr` would let through fetches the base first), **never from the PR branch's
own HEAD**: a pull request must not be able to loosen its own gate, by lowering
its allowance, turning on the light lane, or adding a bot to the trusted roster
(below). A base without the file, or with no fetched `origin/<base>`, has no
overrides; the mod never falls back to HEAD.

```json
{
  "reviewers": ["claude[bot]", "copilot-pull-request-reviewer[bot]"],
  "checks": ["Claude Review", "ci"],
  "requestReview": ["copilot"],
  "trusted": ["chatgpt-codex-connector[bot]"],
  "quietMinutes": 3,
  "waitCapMinutes": 20,
  "allowanceStandard": 3,
  "allowanceHigh": 8,
  "lightBranches": "^(chore|deps)/",
  "onExhausted": "stop",
  "highRiskPaths": "^(server|infra)/|(^|/)auth/",
  "codexModel": "gpt-6-luna",
  "codexModelHigh": "gpt-6-astra",
  "highEffort": "medium",
  "rereviewEffort": "low",
  "runnerModel": "sonnet",
  "mergeMethod": "merge",
  "issueSpec": "docs/spec.md",
  "mergeWatchMinutes": 5,
  "jiraProject": "KAN"
}
```

All fields are optional. The first five shape post-PR collection (below). The
rest are round settings, with the same meaning and limits as the plugin
options of the same name (see Options): `allowanceStandard` and
`allowanceLight` are capped at 10 and `allowanceHigh` at 12, `onExhausted` is `open-pr` or `stop`, and
`lightBranches` and `highRiskPaths` are regular expressions, where `""` (or
only spaces, as for the plugin options) turns the match off
(`"lightBranches": ""` turns the light lane off). The models (`runnerModel`,
`fixAgentModel`, `codexModel`, `codexModelHigh`) are a short alias or id,
letters, digits, dots and dashes, starting with a letter or digit, where `""`
names no model. The efforts (`reviewEffort`, `lightEffort`, `highEffort`,
`rereviewEffort`) are `low`, `medium` or `high` (see Models and effort).
`mergeMethod` is `merge` (default), `squash` or `rebase`. `issueSpec` is a
spec handle, cut to 80 characters, named in each filed issue's title.
`mergeWatchMinutes` is how often the gate reads the PR state of a record with
no run, a whole number of minutes from 1 to 60 (default 5; see Merged outside
the gate). `jiraProject` is a Jira project key such as `KAN`; with it set, a
security finding gets a Jira Bug through `acli` (see Merged outside the gate).
All four are read from the base's file only.

- **Precedence.** The file on the base, then the person's plugin options, then
  the defaults.
- **An invalid value** (a count or a wait in minutes below 1, an unknown
  `onExhausted`, a regular expression that does not compile, a model that is
  not an id, an effort other than `low`, `medium` or `high`) is ignored, so
  that key falls back to the plugin option; the others still apply. The gate
  says which keys it ignored, once, in the pane's scope step and in the start
  message. An invalid model or effort in the plugin options is reported the
  same way, and its default applies. A file that is not a JSON object overrides nothing. A wait over a
  day is capped at 1,440 minutes.
- **The lane and allowance are fixed when the lifecycle is scoped, for that
  base.** A change to the file that lands on the base mid-lifecycle does not
  rewrite an existing record's lane or allowance; a new lifecycle (or
  `/pr-gate reset`) picks it up. One exception: a rise in tier on the same
  base raises the allowance to the new tier's, from the file as it is then.
  A lifecycle that moves to another base (a
  create to another base, `/pr-gate <base>`, or an open PR adopted on another
  base) is scoped afresh from that base's file: tier, lane and allowance, up
  or down, with the rounds already used still counted. Nothing carries over
  from the base it was scoped on before, which may be one outside `bases`. The
  other settings are read again where they are used: `onExhausted` when a
  pre-PR gate is spent and when a create is judged, the roster on every poll,
  the Codex model and efforts when each round starts, and the Claude models
  when each sub-agent is started.
- **A PR that adds or changes `.github/pr-gate.json` is gated by the base's
  version** (or, without one, by the plugin options), not by its own. Its
  settings apply to the PRs after it merges.

- **On GitHub's signals** (R89), collection ends when every check the base
  requires has a completed run or status on the head, every reviewer in the
  PR's pending review requests has reviewed the head, and, with a roster,
  every listed reviewer has covered it. Check suites are never read. A team's
  request is not waited for, nor one from this machine's own login. A
  `trusted` reviewer is never waited for: its feedback is triaged when it
  arrives, in this round or the next, and its review of the current head, when
  already in, covers it.
- **With none of the three**, it ends when every check run has completed and
  nothing new arrived for `quietMinutes`. The mod never guesses a roster.
- **Always**, it ends at `waitCapMinutes` with whatever arrived. Missing
  evidence is recorded as incomplete; if no reviewer covered the head, the
  Codex fallback runs.

Only feedback from someone with write access to the repository (GitHub's
author association `OWNER`, `MEMBER` or `COLLABORATOR`) or on the roster
(`reviewers` or `trusted` by exact login, or `requestReview` by name, where a name also
matches the `[bot]` login posting for it, so `copilot` keeps
`copilot-pull-request-reviewer[bot]`) is read; anyone
else's comment is dropped before triage and covers no head. A row that does
not say its author association is kept.

The mod polls about every 30 seconds with `gh api` while the session stays
free. `requestReview` re-requests review from the listed reviewers once per
agent turn that pushed, on the head the turn ends on (R88); otherwise the mod
never triggers reviewers. If `gh`
is unauthenticated or rate-limited, the attempt is recorded incomplete, the
pane says what to fix, and `/pr-gate resume` retries. A new interactive session picks a
post-PR collection back up where it was once the session that ran it has been
quiet for 2 minutes, and nothing already processed is done again. A headless
session (`claude -p`, the SDK) in the same checkout never takes it over.

## What is held

Every route that opens or merges a PR goes through one classifier,
`readPrAction`:

- **Bash.** `gh pr create`; `gh pr merge` (with or without `--auto`, and
  merge-queue enqueue); `gh api` REST calls (`POST .../pulls`,
  `PUT .../pulls/{n}/merge`); and `gh api graphql` with a `createPullRequest`,
  `mergePullRequest`, `enqueuePullRequest` or `enablePullRequestAutoMerge`
  mutation.
- **GitHub MCP.** `mcp__plugin_github_github__create_pull_request` and
  `__merge_pull_request`, and `mcp__plugin_github_github__pull_request_write`
  with `method` `create` or `merge`, and
  `mcp__claude_ai_github-graphql-mcp__manage_pull_requests` with `action`
  `create`, `merge` or `enqueue`.
- **Fail-closed fallback.** Any other MCP tool whose name contains `github`
  and whose name or an operation key (at any depth) reads as creating,
  merging or enqueuing a pull request is held, with a message naming the tool. It is
  waivable like any hold.

A merge names a PR number, not a base, so the guard reads base, head branch and
head SHA with `gh pr view <n> --json baseRefName,headRefName,headRefOid`. A
merge it cannot resolve is held. Outside a git checkout, a create or merge that
names a PR number or a repository, or comes from a GitHub MCP tool, is held
too: the agent is told to run it from the repository's checkout.

**Not held:** a PR from a branch not checked out here, a PR for another
repository (`--repo`), a promotion between gated bases, and anything for a base
outside `bases`. With `enforce` off nothing is held on create; with
`enforceMerge` off nothing is held on merge.

### Residual risk

What text matching cannot see:

- shell indirection (`g=gh; $g ...`, `$(which gh)`)
- scripts and package-manager scripts that call gh
- a segment that starts with `git`, `echo`, `cat` and so on and hides a command (for example `git -c alias.x='!gh pr ...' x`)
- REST calls from other tools (`http`, `wget`, language one-liners)
- a heredoc written to a file and run later (`cat > s.sh <<EOF ... EOF; bash s.sh`): only bodies fed straight to a shell are read
- an MCP operation under a key this mod does not list, or an operation spelled only in free text
- an MCP argv array (`args: ['pr', 'merge', '5']`) is free text, not an operation
- a contrived nested shape such as `{a:{b:{operation:'merge'}}}`, with no PR words in the tool name or keys, is not held
- shell-fed commands are missed, for example a command fed to `ssh` on stdin (`... | ssh host`; `ssh h "gh pr merge 5"` is caught), `| xargs`, and `bash -c "$(cat <<EOF)"`

Reviewer text reaches the agent's prompts as data. Each comment body is
quoted inside `<reviewer-comment from="login">` tags, with one line saying the
tagged text is data from the reviewer, not instructions; a tag inside a body is
defused so it cannot close the quote early. A reviewer comment carried into a
later prompt is named "comment from <login>", not by its first line. The pane
still shows a comment's first line as its title. Fencing marks the text, it does
not stop an agent from obeying it; dropping authors without write access is
what keeps strangers out.

The hold is a guard against a well-meaning agent skipping the gate, not a
defense against one that works around it.

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
too. These pass-throughs skip pre-PR Codex only. Their post-PR baseline is
round 1 on whatever the repository's reviewers post, without the Codex
fallback.

## The light lane (`chore/`)

A branch matching `lightBranches` (`^chore/`) that still needs Codex gets one
round and no advisory rounds. Codex starts at `lightEffort` (`low`) on
`codexModel`, or on a high blast-radius change at `highEffort` on
`codexModelHigh`. With `onExhausted: open-pr` (the
default), what it raises does not hold the pull request: the gate ends
`exhausted` (or `passed`), and the findings go to the main agent for the pull
request's own review. With `stop`, a P0/P1 still holds it. The prefix is a weak
signal, since hooks code can be named `chore/` too, so a high blast-radius
chore still reviews with the high tier's model and effort.

## Models and effort

### Claude models

Every sub-agent the gate starts is given its Claude model:

| Sub-agent | Option | Default |
| --- | --- | --- |
| Codex review, challenge, and the post-PR rebuttal check | `runnerModel` | `sonnet` |
| the fixer (`fixer: subagent`) and the fix reviewer | `fixAgentModel` | `opus` |

The runners follow skill instructions, run shell commands and turn Codex's
output into findings; fixing and judging a fix need more judgment. An alias
such as `sonnet` follows the latest model of that name; a full id pins one.
An empty value passes no model, so that sub-agent runs on the session's
model. The main agent is never given one: with `fixer: main`, the session's
own model fixes.

### Codex model

The gate names the Codex model for each tier:

| Tier | Option | Default |
| --- | --- | --- |
| standard and light lane | `codexModel` | `gpt-6-luna` |
| high blast radius | `codexModelHigh` | `gpt-6-astra` |

Every Codex step (the review, the challenge, and the post-PR rebuttal check)
passes it to the gstack `/codex` skill as `--model '<model>'` among the
skill's leading flags, next to `--effort`, and prefixes every Codex dispatch
with `GSTACK_CODEX_MODEL=<model>` beside `GSTACK_CODEX_EFFORT`.
gstack picks the model in this order: a model named for the request
(`--model`), then `GSTACK_CODEX_MODEL`, then Codex's `config.toml` (`model`,
or `review_model` first for `codex review`), then `gpt-6-astra`. So the
model the gate names wins over the machine's `~/.codex/config.toml`. An empty
`codexModel` or `codexModelHigh` names none, and gstack's order applies from
`GSTACK_CODEX_MODEL` down, as before 1.2.0.

**The post-PR rebuttal check is a Codex consult.** Its sub-agent runs on
`runnerModel` and invokes the skill as `consult --model '<model>' --effort
<effort>`, putting every rebutted finding (and every verified fix whose file
changed since) to Codex in one prompt. The verdicts are Codex's, not the
sub-agent's. Once Codex has completed a round in the lifecycle, the check is
a re-review and runs at `rereviewEffort`, never above the tier's starting
effort. When it is Codex's first look (after a pass-through and rounds
reviewed only by people), it runs at the tier's starting effort. The pre-PR side
needs no separate check: an earlier round's rebuttals and fixes go to Codex
through the consult inside the next review round.

Each Codex step reports the model on gstack's `CODEX_MODEL:` line. The gate
records every role's model on the round as `ranModels` (`review`,
`challenge`, `verify`), with the review's as `codexModel` beside the round's
`effort`, and shows them in the pane's round line (`codex gpt-6-luna
medium`). A round recorded before 1.2.0 has none of these fields and still
loads.

**A model other than the one named stops the round.** When a step reports a
`CODEX_MODEL:` other than the model the gate named, gstack fell back to
another model. The gate never accepts that: the attempt is discarded, as a
timeout's is, no round is spent, and the stop names the role, both models
and the setting.

**A model gstack cannot use stops the round.** When gstack stops because the
model is invalid or the account cannot use it (`MODEL_UNUSABLE`, a model not
supported, or one that does not exist or the account has no access to), the
reviewer, or the rebuttal check, reports `"error":"model"`; the gate also
reads gstack's markers in what it says, whatever error it names. The round is an incomplete attempt: it
spends no round and steps no effort down, and the gate never falls back to
another model. The stop message gives gstack's repair message and names the
setting to change: `codexModel`, or `codexModelHigh` on a high blast-radius
change, in the plugin options or, when it sets it, the base's
`.github/pr-gate.json`. Change it, then run `/pr-gate resume`.

### Effort

Codex starts at the tier's effort:

| Tier | Option | Default |
| --- | --- | --- |
| standard | `reviewEffort` | `medium` |
| light lane | `lightEffort` | `low` |
| high blast radius | `highEffort` | `medium` |

Every Codex dispatch after the first completed round Codex ran in is a
re-review and runs at `rereviewEffort` (`low`): later rounds, which read the
fix commits, the consult that checks earlier rebuttals and fixes inside
them, the post-PR rebuttal check, and the post-PR Codex fallback. Rounds
that completed without Codex (a pass-through, a round reviewed only by
people) do not count: Codex's first look starts at the tier's effort. It is never above the tier's starting
effort. A rerun of the first round after an incomplete attempt is still the
first round. Efforts are `low`, `medium` or `high`, never `xhigh`, which
timed out.

When a review times out (the reviewer reports `"error":"timeout"`, or the
review step passes `stepTimeoutMinutes`), the same round reruns one level
lower and spends no round: high, then medium, then low. A timeout at `low`
fails closed. Only the effort steps down, never the model. The next run on
that branch starts one level below where the timed-out run ended. A run
that stepped down and then completed its reviews keeps that effort for the
branch: later runs start no higher than it. A re-review's lower effort never
carries this way, so raising `rereviewEffort` takes effect from the next
round. A reviewer that was replaced is
not stopped, since there is no way to; its late answer is ignored.

Time is tracked in two kinds. `activeMs` is agent work, compared with
`routineRoundMinutes` (3): overrunning is shown and recorded, not failed.
`waitMs` is waiting on external reviewers and is never counted as effort.
`stepTimeoutMinutes` (30) is the hard, fail-closed cap on any single agent
step.

## The pane

`PR lifecycle` shows the branch and base; a budget line (phase, rounds used of
the allowance, and the free baseline rounds done out of 2 after the PR opens);
a line that changes in place as the agents call tools and who is awaited
(`in progress: ... · waiting on 1 agent`); the to-do list of steps; and every
finding with its state: open, reported fixed, verified fixed (struck through),
rebutted, deferred, disputed, waived, re-verify owed. The findings heading
counts how many hold the merge, how many blockers are open and how many are
owed verification, from the same test the merge guard uses. When the person is
awaited, it says for which finding. Rendering the pane starts nothing and
writes nothing. The surface decides where it sits: docked beside the
transcript or above the prompt, depending on the host.

## Commands

| Command | Effect |
| --- | --- |
| `/pr-gate [base]`, `/pr-gate start [base]` | start the lifecycle for the current branch, or pick it up from its record; with no base and no record, against the repository's default branch |
| `/pr-gate status` | one line of where it stands (phase, rounds used, baseline, what is open, owed and holding the merge), and open the pane |
| `/pr-gate log` | how the lifecycle went: rounds completed, active and waiting time, how often the person stepped in and with what, the stops and their reasons, and the last events. After a merge or reset it reads the newest archive |
| `/pr-gate stop` | stop the round in flight; the record stays, and opening and merging stay held |
| `/pr-gate resume` | continue a stopped, held or incomplete round from the record |
| `/pr-gate waive pre <reason>` | let this commit's PR open without the pre-PR review, to the base the record has now, or with no record the repository's default branch (it covers that base only); post-PR review still runs. Refused while a security P1 holds |
| `/pr-gate waive post <reason>` | let this head merge without the review, and stop the post-PR review in flight; a security P1 needs its own waiver first |
| `/pr-gate waive [<branch>:]<findingId> <reason>` | release one finding that holds the merge (open, reported fixed, re-verify owed, rebutted, deferred or disputed) from the merge test; the usual case is a finding the gate cannot file, a security one (R92). `<branch>:` names a merged lifecycle of another branch whose security finding blocks its archive; an id that matches more than one lifecycle is refused, and the refusal names each with its qualified command |
| `/pr-gate allow <n> <reason>` | add 1 to 5 review rounds |
| `/pr-gate reset` | archive the record under its own key, history kept, and start fresh |

Waivers, `allow` and `reset` are the person's alone: an agent's or a plugin's
command run is refused. Each waiver records who, when, head, scope and reason,
and covers its scope at that head; a new code commit needs a new one (a finding
waiver lapses only when that finding's file changes). `reset` keeps what a
fresh start must not repeat: feedback already answered is not answered again.

A PR merged or closed outside the gate ends its lifecycle the same way: when a
poll, the triage step, a session start, `/pr-gate` or `resume` reads it merged
or closed, the run in flight stops and the record is archived. Collection does
not start again for it.

### Merged outside the gate

A person on GitHub's website, a connector, or a merge under `waive post` can
merge a PR at any point of its lifecycle. The gate sees it without a command.
A watcher reads the PR state of every record with a PR and no run every
`mergeWatchMinutes`, and a session start reads every record under the
repository's root, not only the checked-out branch. Then the close files a
GitHub issue for each non-security finding still holding. The body says no fix
round ran, or names the post waiver and its reason. A finding the person
waived by id is not filed.

A security finding is never filed in a GitHub issue. With `jiraProject` set,
it gets a Jira Bug through `acli`, labelled `security` and `severity-P<n>`.
The ticket tracks the finding and never settles it: before a merge, only the
person's waiver releases it. At a merge outside the gate, a finding with a
ticket counts as tracked and the record is archived. One with no ticket blocks
the record until the person runs `/pr-gate waive <id>`, or
`/pr-gate waive <branch>:<id> <reason>` from another checkout. After the
merge the ticket is viewed and filed again if it is missing. If `acli` fails,
the finding holds, with one notice: install `acli`, or log in with
`acli jira auth login`. A required `pr-gate` status that would stop such a
merge is on the roadmap (wave 3).

## Options

Set in `/config` or under `pluginConfigs["pr-lifecycle"].options`. A
repository's `.github/pr-gate.json` on the base overrides `allowanceStandard`,
`allowanceHigh`, `allowanceLight`, `onExhausted`, `highRiskPaths`, `lightBranches`,
`waitCapMinutes`, `quietMinutes`, the four models and the four efforts (see
Settings per repository); `mergeMethod`, `issueSpec`, `mergeWatchMinutes` and `jiraProject` are set there only:

| Option | Default | |
| --- | --- | --- |
| `allowanceStandard` | 4 | rounds for a standard change (capped at 10) |
| `allowanceHigh` | 6 | rounds for a high blast-radius change (capped at 12) |
| `allowanceLight` | 3 | rounds for a branch on the light lane (`lightBranches`), unless its blast radius is high (capped at 10) |
| `bases` | `dev,main` | gated base branches. A base nobody named is the repository's default branch, not the first of these; a REST, GraphQL or MCP create whose base cannot be read is held against the first |
| `enforce` | true | hold `gh pr create` and the GitHub MCP create-PR tool |
| `enforceMerge` | true | hold merges until the lifecycle is done |
| `fixer` | `main` | `main` or `subagent` |
| `fixReview` | `auto` | `auto` (high only), `always`, `never` |
| `onExhausted` | `open-pr` | `open-pr` or `stop` |
| `openPr` | true | prompt the main agent to open the PR |
| `highRiskPaths` | a regex | raises the tier to high |
| `reviewEffort` | `medium` | Codex's starting effort, standard changes |
| `lightBranches` | `^chore/` | light-lane branches; empty turns it off |
| `lightEffort` | `low` | Codex's starting effort on the light lane |
| `highEffort` | `medium` | Codex's starting effort, high blast-radius changes |
| `rereviewEffort` | `low` | Codex's effort after the first review round, never above the tier's start |
| `codexModel` | `gpt-6-luna` | Codex model, standard and light-lane changes; empty names none |
| `codexModelHigh` | `gpt-6-astra` | Codex model, high blast-radius changes; empty names none |
| `runnerModel` | `sonnet` | Claude model of the sub-agents that run Codex; empty inherits the session's |
| `fixAgentModel` | `opus` | Claude model of the fix sub-agent and the fix reviewer; empty inherits the session's |
| `stepTimeoutMinutes` | 30 | hard cap on one agent step |
| `routineRoundMinutes` | 3 | soft active-time target for a round |
| `waitCapMinutes` | 20 | longest a round waits for reviewers |
| `quietMinutes` | 3 | quiet period that ends collection with no required checks, no pending review requests and no roster |

## Migrating from codex-gate 0.3.1

| 0.3.1 option | Now |
| --- | --- |
| `maxRounds` | `allowanceStandard`, one allowance shared by pre-PR and post-PR rounds. `maxRounds` is still read when `allowanceStandard` is unset, which only happens in a hand-written options file: the manifest fills in its default of 4. |
| none | `allowanceHigh` (6), `enforceMerge` (true), `routineRoundMinutes` (3), `waitCapMinutes` (20), `quietMinutes` (3) |
| `advisoryMinRounds`, `advisoryMaxRounds` | Removed. Every finding goes to the fixer inside its round; Codex re-reviews an advisory fix only while another round stays in reserve. |
| `bases` | Same list, but its first entry no longer decides a base nobody named: a create without `--base`, a bare `/pr-gate` and a pre waiver with no record use the repository's default branch. |
| none | `highEffort` (`medium`): a high blast-radius change no longer always starts at `high`. `rereviewEffort` (`low`), `codexModel` (`gpt-6-luna`), `codexModelHigh` (`gpt-6-astra`), `runnerModel` (`sonnet`), `fixAgentModel` (`opus`). |
| `enforce`, `fixer`, `fixReview`, `onExhausted`, `openPr`, `highRiskPaths`, `reviewEffort`, `lightBranches`, `lightEffort`, `stepTimeoutMinutes` | unchanged |

- **Options do not carry over by themselves.** The plugin name is now
  `pr-lifecycle`, so options set under `pluginConfigs["codex-gate"]` must be
  copied to `pluginConfigs["pr-lifecycle"]`.
- **Records do not carry over.** The store key changed to
  `lifecycle:<root>:<branch>` under plugin `pr-lifecycle`, so 0.3.1 pass
  records are not read. A branch that passed under 0.3.1 is gated again.

When the rounds run out with `onExhausted: open-pr`, the pull request says
only that the gate did not converge, with a count. Findings, advisory ones
included, are reported in the conversation and never pasted into the pull
request.

## Needs

The gstack `codex` skill, an authenticated `codex` CLI, and an authenticated
`gh` for post-PR collection and the merge guard. The
`superpowers:receiving-code-review` skill is used by the fixer when present.

## Running it

**Never load it together with `codex-gate`.** Both register `/pr-gate` and
intercept PR creation, so two would gate the same PR twice. Name only this
folder:

```
claude --plugin-dir /path/to/pr-lifecycle
```

or in `CLAUDE_CODE_PLUGIN_DIRS`. Switching that setting from `codex-gate` to
`pr-lifecycle` is the person's call.

## Developing

Checks, from this folder:

```
claude plugin validate .   # manifest and hook wiring
claude plugin test .       # tests/*.test.ts
```

`tsconfig.json` extends `.claude-plugin/types/`, which is generated and
gitignored, and which `claude plugin validate .` does not generate. A fresh
checkout must generate it or copy it from `codex-gate`. Type-check with the
pinned TypeScript, never `npx tsc` (it resolves to a fake package):

```
~/Projects/tasteslikegoodtheangularsvegancookbook/node_modules/.bin/tsc -p . --noEmit
```

It runs in about a second with 0 errors, because the GitHub MCP types are small
declared ones (the `types` entry in `tsconfig.json`) rather than the 1.6 MB
generated package that runs `codex-gate`'s check out of memory.
