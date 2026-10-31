# Work claims in the relay: one claim per piece of work, resumable from any runtime

Adam's brainstorm on 2026-10-30 and 2026-10-31 (td2do phase 2, the game bridge, pr-gate). This adds one object class to
`pr-lifecycle-relay`; the lifecycle objects, grants and index are unchanged.

## What it is for

An agent claims a piece of work (an issue such as `gh#12`), works on it, saves as it goes, and lets the claim go. The claim is tracked the
same way whatever runs the agent: the TUI, the game's agent bridge (local, Workers or Claude cloud), a background process (sandboxed, in a VM
or container, or not), Adam's Hetzner VPS, or Claude cloud. When an agent dies mid-task, its claim lapses, and the next session, on any
runtime, takes it over and resumes from the last checkpoint.

**Resume is a recap plus the branch** (Adam, 2026-10-31), as the game bridge does: no Claude transcript is stored. The code and a short-term
notes file (`notes/<ref>.md` by default, summarising what is done, what is next and the decisions made) are committed and pushed at each
checkpoint. The relay holds only coordination: who holds the claim, from which runtime, the branch and last pushed commit, the notes path,
and a step log. A step left mid-flight is marked interrupted and never re-run blindly (the game bridge's rule).

td2do's claims are the first user, the game bridge the second, pr-gate the third (a lifecycle could claim the PR's fix work later).

## Shape

- **`WorkBoard`**, one Durable Object per `owner/repo`, at `POST /v1/<owner>/<repo>/work`. Every claim of the repo lives in it, each under
  its own storage key, so `list` is one call and atomic.
- Identity and grants are the relay's own: a Cloudflare Access JWT, then the caller's preset on the repo from `GrantStore`. `read` reads;
  `operate` claims and writes; admin (people in `ADMINS`) breaks a claim.
- A **ref** is the work's name: `gh#12`, `td2do:<fingerprint>`, a branch-like name. `^[A-Za-z0-9][A-Za-z0-9_.:#/@-]{0,127}$`.

## The claim

| Field | Meaning |
| --- | --- |
| `state` | `active`, `paused`, `done` or `abandoned`; shown as `lapsed` while `active` with no live lease |
| `lease` | `{ holder, principal, runtime, token, until }`; the secret's SHA-256 is kept, never shown |
| `branch`, `commit`, `notes` | where the work and its notes were last pushed |
| `steps` | `{ seq, at, kind, text, principal, holder, runtime, commit? }`, the last 200; `stepsDropped` counts older ones |

The lease works as the lifecycle lease does (R74, R100, R105): a checkout makes its own secret (32 characters or more); a new holder gets a
higher fence `token`; `beat`, `checkpoint` and `release` must prove the secret, the principal and the current token. A lease lapses after
`LEASE_MS` (2 minutes) without a beat, and a lapsed lease is lost even to its holder.

## Ops

| Op | Needs | What it does |
| --- | --- | --- |
| `claim { ref, holder, runtime, secret, title?, branch?, reopen? }` | operate | Takes a free or lapsed claim, with a new token. Taking over a lapsed `active` claim logs an `interrupted` step for the old holder. Answers `{ claim, token, tookOver, resume }`, where `resume` is the branch, commit, notes path and recent steps. The holder's own live claim is renewed with the same token. A live claim held by anyone else is 423. A `done` or `abandoned` claim is 409 unless `reopen`. |
| `beat { ref, secret, token }` | operate | Renews the lease. |
| `checkpoint { ref, secret, token, text, commit?, branch?, notes? }` | operate | Records where the work was pushed and a step; renews the lease. |
| `release { ref, secret, token, outcome, text? }` | operate | `outcome` is `paused`, `done` or `abandoned`; drops the lease. |
| `get { ref }` | read | One claim, with its steps. |
| `list { state? }` | read | Every claim, without steps (the last one only). |
| `breakClaim { ref, text? }` | admin | Drops a live lease and pauses the claim, logging who broke it. |

Wrong secret, principal or token, or a lapsed lease: 409. A `done` or `abandoned` claim is deleted `RETENTION_MS` (90 days) after it closed.
A board holds at most 2000 claims; a new claim beyond that is 409.

## Clients

- **`client/relay-work.ts`**, a small CLI for any runtime with Node 22: `claim`, `beat`, `keepalive`, `checkpoint [--push]`, `release`,
  `get`, `list`. It reads the same variables as pr-lifecycle (`PR_GATE_RELAY_URL`, then `PR_GATE_RELAY_CLIENT_ID` and
  `PR_GATE_RELAY_CLIENT_SECRET`, or `PR_GATE_RELAY_TOKEN`), keeps the checkout's secret and tokens under `.git/relay-work/`, and fills
  the branch and commit from git.
- The game bridge (Python) can call the HTTP API directly or run the CLI.
- **`dev/serve.ts`** runs the relay locally under Miniflare, with state kept on disk, behind a stand-in for Access: it signs JWTs for the
  dev identities it seeds, so every runtime on the machine (and pr-lifecycle) can test against it with no Cloudflare account.

## Not in this step

- td2do's `claim` commands (phase 2) wrap this API; its file-once ledger stays GitHub's exact-mark search until a later step.
- The Workers Sandbox test session needs the relay deployed; the deploy waits for Adam's confirmation (R108).
