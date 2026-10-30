# `todo`: a CLI that keeps TODO comments tracked as issues

Status: draft for Adam's review (2026-10-29). Nothing is built. Decisions still open are listed at the end.

Inputs:

- three design passes run on 2026-10-29: developer UX, technical architecture, devil's advocate;
- Adam's answers that day: the goal is better-tracked TODOs; the user is Adam (developer and his own lead) and the agents working for him; every
  tracked TODO links to an issue; the tool must later work with the relay;
- the relay design: `docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md` (R100–R108) and `pr-lifecycle-relay/README.md`.

## 1. Goal

A TODO comment is **tracked** when it points to an open issue. Tracking is what stops repeats: before anyone, person or agent, writes a TODO,
they can find out whether the work is already recorded, and the TODO they write points to that record.

**Goals, in order:**

1. Every new TODO is tracked: it carries an issue reference, or the check fails.
2. Agents never write a duplicate: they search first, and the tool files issues for them, once.
3. Adam can see every TODO, with its issue and state, from the terminal and from an agent.

**Not goals in v1:** dashboards, trend charts, priorities or assignees inside comments, two-way sync, a web UI, an editor extension, and
counting existing TODOs down. Existing TODOs are left alone until someone tracks them (section 6).

**Why not existing tools.** `rg`, IDE TODO panels, Ruff's TD rules, ESLint `no-warning-comments`, todocheck and the todo-to-issue Action each
cover part of this (not verified against their current docs). None gives agents one command to search, file an issue once, and write a
canonical TODO, across every language. That is the gap.

## 2. Users

- **Adam at the keyboard.** Reads the list, decides what gets tracked, sets the policy in `.todo.toml`.
- **Agents** (local Claude Code sessions, cloud sessions, CI). They read the list as JSON, search before writing, and add TODOs only through
  the tool. Agents add TODOs faster and less consistently than a person, so the check exists mainly for them.

## 3. The comment syntax

```
TAG(REF): text
TAG(REF, extra): text
```

- **TAG**: `TODO`, `FIXME`, `HACK`, `XXX`, `BUG` by default; uppercase; configurable.
- **REF**: an issue reference with a prefix that names its backend:
  - `gh#123`: an issue in this repo on GitHub;
  - `gh:owner/repo#123`: an issue in another repo;
  - `#123` is read as `gh#123` in a repo whose `origin` is on GitHub, so existing comments count, but the tool always writes `gh#123`.
  - Reserved for later: `relay:<id>` and `jira:<KEY-123>`. Fixing the prefix form now means a new backend changes no existing comment.
- **extra**: free text after the first comma, kept but not interpreted in v1.
- **Untracked**: a TODO with no REF (`TODO: fix`, `TODO(alice): fix`). Still listed; never valid in new code under `check`.

A TODO is found only inside a comment (section 8). Continuation lines of the same comment, with no tag of their own, belong to it.

## 4. Identity

Two different things need identity; they are kept apart.

- **A tracked TODO's identity is its REF.** It is written in the code, so moves, renames and rewording don't matter. Several TODOs may share
  one REF (one issue, several places in the code).
- **A TODO's fingerprint** is `sha256(repo slug + tag + normalized text)`, shortened to 16 hex characters. Normalizing strips comment markers
  and REF, lowercases, and collapses whitespace. It is used only to file an issue **once** (section 5), never as a lasting ID, so rewording
  a TODO later is harmless.

Catching a reworded duplicate ("retry on 429" and "handle rate limit") is not identity: it is search (`todo find`, section 6), and the
person or agent decides.

## 5. Filing an issue, once

`todo track` and `todo add` file issues. Filing follows the same rule pr-gate's filing ledger uses (R96, relay design section 7): find an exact
mark first, so a crash between creating the issue and writing the comment never files a second one.

1. Compute the fingerprint.
2. **Search for the mark.** Ask the backend for an issue whose body contains `<!-- todo: <fingerprint> -->`. If one exists, open or closed,
   adopt it: an open one becomes the REF; a closed one is reported and the TODO is left untracked, for the caller to decide (re-open or file
   anew with `--new`).
3. Otherwise **create** the issue: title from the TODO text, body with the file, line, commit, the surrounding code, and the mark; label
   `todo` (configurable).
4. **Rewrite the comment** in place to `TAG(gh#N): text`, changing nothing else on the line.

A retry after any crash repeats step 2 and finds the mark. Two agents filing the same TODO at the same moment can still both pass step 2
before either issue exists; the next `todo check` finds two issues with one mark, keeps the lowest number, and lists the other for Adam to
close. It never closes anything itself (the same stance as the relay design, section 8). The relay ledger in section 10 removes this race.

## 6. Commands

Every command takes `--json`. JSON output carries `"schema": 1`. Exit codes: 0 success, 1 the check failed, 2 usage or config error,
3 the backend could not be reached when the command needs it.

| Command | What it does | Who uses it |
| --- | --- | --- |
| `todo` / `todo list` | Every TODO: file:line, tag, text, REF, and, with `--online`, the issue's state. Filters: `--untracked`, `--ref gh#12`, `--path`, `--tag`. | Adam, agents |
| `todo find <words>` | Searches TODO text in the code **and** open issues labelled `todo`, ranked by shared words. The step an agent runs before writing a TODO. | agents first |
| `todo add <file>:<line> <text> [--tag FIXME] [--ref gh#12]` | Inserts a canonical TODO above that line in the file's comment syntax. With `--ref`, points to an existing issue; without it, files one (section 5). Prints the REF. | agents |
| `todo track <file>:<line>` | Files an issue for an existing untracked TODO and rewrites it. `--all [--path]` tracks many, asking once with the count unless `--yes`. | Adam |
| `todo show <REF or file:line>` | The issue and every TODO pointing at it, with a few lines of code around each. What an agent reads to pick up the work. | agents |
| `todo check` | The policy check (section 7). | pre-commit, CI |
| `todo init` | Writes `.todo.toml`, a pre-commit hook, a CI step, and the agent rule for `CLAUDE.md` (section 9), showing each before writing. | Adam, once |

Output on a terminal is grouped by file with colour; piped output is `path:line:col: TAG(REF) text`, which editors open directly. `NO_COLOR`
is honoured.

## 7. `todo check`

By default it looks only at lines this branch **adds**, against the merge base with the default branch (`--base` to change it). Existing
TODOs never fail it, so the first run on an old repo is green.

| Rule | Default | Needs the network |
| --- | --- | --- |
| A new TODO has no REF | fail | no |
| A new TODO's REF is malformed or names an unknown prefix | fail | no |
| A new TODO's fingerprint equals another TODO's in the repo | warn (probably a copy) | no |
| A new TODO points to a closed issue | fail | yes, with `--online` |
| One mark found on two issues (section 5) | warn, list them | yes, with `--online` |

`--all` checks every TODO, not only new ones, and is for reports, not gates. Offline rules give the same answer every run. `--online` rules
need the backend; if it can't be reached, they are skipped with one warning and the exit code is not changed by them, so a flaky network never
fails a build. Inline escape: `todo:ignore` on the line.

Diff mode needs the merge base; a shallow CI clone must fetch it (`fetch-depth: 0`, or fetch the base branch), and `todo check` says so
instead of guessing.

## 8. How it is built

- **Language: Rust.** A single binary that starts in milliseconds, which matters in a pre-commit hook, and the crates below. (Open decision 1.)
- **Files:** `git ls-files` inside a repo, else the `ignore` crate's parallel walk, which honours `.gitignore`. Skips binaries (a NUL in the
  first 8 KB), files over 2 MB, lockfiles, minified and vendored code.
- **Scanning in two layers:**
  1. a prefilter with `grep-searcher` for the tag words drops the files that have none;
  2. a comment lexer decides whether each match is inside a comment. A table per language gives its line-comment marker, block delimiters,
     string delimiters and whether blocks nest; about 20 languages at launch. tree-sitter is deferred until the lexer is shown to be wrong
     for a language.
- **Diff mode:** `git merge-base`, then `git diff -U0 base...HEAD`; only added lines are checked, with the whole file lexed for context.
- **Editing files** (`add`, `track`): rewrite only the target line, keep the file's line endings and indentation, write to a temporary file
  and rename. Refuse a file with unresolved merge conflict markers.
- **No blame in v1.** Nothing in the goals needs author or age; it is the slowest part of every tool like this.
- **No stored state.** The code and the issues are the database; nothing to lose or migrate.

```
walker → prefilter → lexer → parser → (diff filter) → rules / output
                                   ↘ backend adapter (GitHub now, relay later)
```

### The backend adapter

```
interface IssueBackend {
  findByMark(mark): Issue[]                 // exact match in issue bodies
  create({ title, body, labels }): Issue    // body includes the mark
  get(ref): Issue                           // number, url, state, title
  search(words, label): Issue[]             // for todo find
  list(label, state): Issue[]
}
```

**GitHub adapter (v1):** the GitHub REST and search APIs with the `gh` CLI's token (`gh auth token`) or `GITHUB_TOKEN`. Search indexing lags
by a minute or so, so `findByMark` also lists recent issues labelled `todo` and scans their bodies, which covers a retry soon after a crash.

## 9. Agents

Agents use only the CLI; an MCP server or skill can wrap it later without changing it.

`todo init` offers this rule for `CLAUDE.md` (or `AGENTS.md`):

> Before writing a TODO, FIXME or HACK comment, run `todo find <a few words>`. If an issue covers it, add the comment with
> `todo add <file>:<line> "<text>" --ref <REF>`; otherwise `todo add <file>:<line> "<text>"`, which files the issue. Never hand-write a TODO.
> To pick up work, `todo list --json` and `todo show <REF>`.

The check catches an agent that ignores the rule. Cloud sessions need the binary and a GitHub token in their environment; `todo` works with no
other setup there.

## 10. The relay, later

As the relay is designed today (R100–R108) it can't back this tool:

- it holds pr-gate's records per PR or branch, deleted 90 days after the PR ends, while a TODO outlives any PR;
- it mints no issue ids, stores no code locations, and has no search;
- its filing ledger, `fileClaim` / `fileDone` keyed `lifecycleId:findingId:attempt`, solves exactly the "file once" problem of section 5,
  but per PR.

**Proposal for a later relay wave, not for the current build:** an `IssueLedger` object class, one per `owner/repo`, reached at
`POST /v1/<owner>/<repo>/issues`, with the same grants (`read`, `operate`) and Access identities as the rest of the relay.

| Op | Needs | What it does |
| --- | --- | --- |
| `claim { key, secret }` | `operate` | As `fileClaim`. `key` is `todo:<fingerprint>`; pr-gate could later use `finding:<…>` here too. |
| `done { key, result: { ref, url }, secret }` | `operate` | As `fileDone`. A done entry never changes. |
| `get { key }` / `byRef { ref }` | `read` | One entry; every key pointing at one issue. |
| `list { state? }` | `read` | Every entry, for `todo list --online` without hitting GitHub's rate limit. |
| `search { words }` | `read` | Word search over entry titles, for `todo find`. |

With it, step 2 of section 5 becomes `claim`: the race between two agents is closed by the object, as it is for findings today. Entries are
kept while their issue is open, and for 90 days after it closes. The relay adapter implements `IssueBackend` with GitHub still creating the
issue, and falls back to the GitHub adapter after the same 5 s timeout the relay design uses. The repo opts in through the same
`sharedStore` entry in `.github/pr-gate.json`, so there is one setting for both tools.

This needs Adam's ruling (open decision 5) and its own design pass against the relay as built.

## 11. Configuration

`.todo.toml` at the repo root; every key optional.

```toml
tags = ["TODO", "FIXME", "HACK", "XXX", "BUG"]
label = "todo"
ignore = ["docs/**", "**/*.snap"]

[check]
base = "main"
duplicate_text = "warn"   # or "fail" / "off"
```

## 12. Testing

- Lexer: a golden corpus per language, including a tag inside a string, nested block comments, heredocs, raw strings, URLs and `todoList`.
- Property tests: arbitrary bytes never panic the scanner; output order never depends on thread count.
- Filing: a fake GitHub server. A crash after `create` and before the rewrite, then a retry, files one issue. Two concurrent `add`s of the
  same text produce at most two issues, and `check --online` reports them.
- Diff mode: scripted fixture repos with renames, moved lines and a shallow clone.
- `add` and `track` keep line endings, indentation and the rest of the file byte for byte.

## 13. Phases

1. `list`, `check` (offline rules), `init`. Useful on day one with no network.
2. The GitHub adapter: `add`, `track`, `show`, `find`, `check --online`.
3. The agent rule in use; tune `find` ranking from real misses.
4. The relay adapter, once an `IssueLedger` exists.

## Open decisions for Adam

| | Decision | Recommendation |
| --- | --- | --- |
| 1 | Language | Rust, for startup time and the ripgrep crates. TypeScript would match this repo's tooling but starts 10–50× slower in a hook. |
| 2 | Where the tool lives | Its own repo; it isn't a Claude Code mod. |
| 3 | Untracked TODOs already in a repo | Leave them; list with `--untracked`; track by hand or with `track --all`. |
| 4 | Closing issues when their TODOs are removed | Never automatic in v1. `check --online --all` lists open `todo` issues no TODO points to. |
| 5 | A repo-level `IssueLedger` in the relay (section 10) | Yes, as a later wave after #29 Part B ships, with its own design. |
| 6 | Name | `todo` collides with existing tools; pick a distinct binary name before release. |
