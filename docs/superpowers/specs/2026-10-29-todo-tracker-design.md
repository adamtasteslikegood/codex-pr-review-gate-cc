# td2do: moved

The td2do design spec was written here and moved on 2026-10-30 to its own repo (Adam's decision 2):
[adamtasteslikegood/td2do, `docs/specs/2026-10-29-td2do-design.md`](https://github.com/adamtasteslikegood/td2do/blob/main/docs/specs/2026-10-29-td2do-design.md).
The full text before the move is in this file's history (commit be5210c).

## What concerns this repo: a repo-level `IssueLedger` in the relay

td2do files a GitHub issue for each TODO, once. It uses the same exact-mark search as pr-gate's filing (R96). Two agents filing the same TODO
at the same moment can still both file, which the relay's claim and done ops would prevent. The relay as designed (R100–R108) can't serve
this: its objects are per PR or branch and deleted 90 days after the PR ends, and it has no search.

The proposal, td2do spec section 10: an `IssueLedger` object class, one per `owner/repo`, at `POST /v1/<owner>/<repo>/issues`, with the
relay's grants and Access identities.

| Op | Needs | What it does |
| --- | --- | --- |
| `claim { key, secret }` | `operate` | As `fileClaim`; `key` is `td2do:<fingerprint>`, and pr-gate findings could use `finding:<…>` later |
| `done { key, result: { ref, url }, secret }` | `operate` | As `fileDone`; a done entry never changes |
| `get { key }` / `byRef { ref }` | `read` | One entry; every key pointing at one issue |
| `list { state? }` | `read` | Every entry |
| `search { words }` | `read` | Word search over entry titles |

Entries are kept while their issue is open and for 90 days after it closes. A repo opts in through the same `sharedStore` entry in
`.github/pr-gate.json`.

**Adam's ruling (2026-10-30, td2do decision 5): a later wave**, after #29 Part B ships, with its own design against the relay as built. The
current relay build is unchanged. It is listed in [ROADMAP.md](../../../ROADMAP.md) under *Wave 4 and later*.
