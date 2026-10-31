# pr-lifecycle-relay

The shared lifecycle store for pr-lifecycle (#29 Part B): a Cloudflare Worker and Durable Objects that hold a PR's record, its lease, its run
log and its filing ledger, so that checkouts of one PR share one record. It is built and tested under Miniflare. **Nothing is deployed**: no
Cloudflare resource or Access application exists for it, and the first deploy waits for Adam's confirmation (R108). pr-lifecycle 1.6.0 calls
it only for a repo that opts in (see the pr-lifecycle README, "The shared store"), and only from a machine whose `PR_GATE_RELAY_URL` has the
same origin as the repo's `sharedStore.url`: a checkout never sends its Access credential to a relay its own machine did not pin.

## Shape

- The Worker (`src/index.ts`) verifies the Cloudflare Access JWT in `Cf-Access-Jwt-Assertion` (`src/auth.ts`): RS256 against the team's
  published keys, then issuer, audience, `exp` and `nbf`. A person is their `email`; a service token is its `common_name`. A header value
  alone is never an identity. Principals, grants and admins are compared in lower case.
- It asks `GrantStore` for the caller's preset on the repo, then hands the call to one object. The object checks the preset, the lease and
  the revision in the same step that writes. The Worker replaces `x-relay-principal`, `x-relay-repo`, `x-relay-preset` and `x-relay-key` on
  every call, whatever the caller sent.
- Only `POST` is served. Anything else, and any path not listed here, answers 404. A body that is not JSON answers 400.

## Routes

| Route | Object | Ops |
| --- | --- | --- |
| `POST /v1/<owner>/<repo>/<pr>` | `LifecycleObject` for `owner/repo#<pr>` | the lifecycle ops below |
| `POST /v1/<owner>/<repo>/branch/<branch>` | `LifecycleObject` for `owner/repo@<branch>` | the same, plus `moveTo` and `moveDone`. The branch is one percent-encoded segment, checked against git's ref rules; a name git would refuse answers 404. |
| `POST /v1/<owner>/<repo>` | `RepoIndex` for `owner/repo` | `list` (needs `read`) |
| `POST /v1/<owner>/<repo>/work` | `WorkBoard` for `owner/repo` | the work-claim ops below |
| `POST /v1/admin/grants` | `GrantStore` | `grants`, `grant`, `revoke` (admin) |
| `POST /v1/admin/index` | `RepoIndex` | `fault`, `update`: only when `TEST_FAULTS` is `'1'`, for tests; otherwise 404 |

The owner `admin` is reserved: `/v1/admin/...` is matched before owner and repo are parsed.

## Lifecycle ops

Body `{ "op": ..., "secret"?: ..., ... }`. A checkout makes its own secret (32 characters or more) and sends it with each lease call; the
object keeps only its SHA-256 and never returns it.

| Op | Needs | What it does |
| --- | --- | --- |
| `read` | `read` | `{ rev, record, lease, lastWrite, log, logDropped, logSeq }`. `logSince` (a `seq`) returns only newer log lines. |
| `archives`, `filing` | `read` | The kept archives; one filing. |
| `commit` | `operate` | Writes the record if `rev` is current (else 409 with the current record) and no lease is live that the caller doesn't hold (else 423). `archive: { at, record }` keeps the record the caller archived. `isFresh` starts a new lifecycle over a tombstone. A branch key whose record now carries `pr` moves to the PR key inside the commit (R103). A tombstone answers 410. |
| `claim` | `operate` | Takes the lease if none is live. A new holder gets a higher public fence `token`. A live lease held by another is 423. |
| `take` | `operate` | Takes a live lease from another session of the same principal at once, with a new `token` (R105); a lapsed or empty lease is simply taken. Another principal's live lease answers 423. |
| `beat`, `release` | `operate` | Renew or drop your own lease. A lease you no longer hold answers 409. A lapsed lease is lost even to its holder. |
| `moveTo`, `moveDone` | `operate` | Branch keys only (404 on a PR key). `moveTo` answers 200 and freezes the branch key with a tombstone that keeps the record; every record and lease op after it answers 410 (apart from a fresh start). `moveDone` drops the copy once the PR key has it. |
| `log` | `operate` | Appends `{ seq, at, kind, text, principal, holder }`, with no lease needed. `text` is cut to 300 characters. The log holds 1000 lines (`RELAY_LOG_CAP`), and `logDropped` counts the lines pushed out (R106). |
| `snapshot` | `operate` | Appends a record to the archives, with a `reason` of `fallback`, `migration` or `move`. It does not change `rev`. The archives keep at most 1 MiB, dropping the oldest. |
| `fileClaim`, `fileDone` | `operate` | The filing ledger, keyed `lifecycleId:findingId:attempt` (R101). A second claim of a key finds the first. Only the claimant finishes it (anyone else gets 409), and a retry with the same secret answers `isMine: true`. A done filing never changes. |
| `fileAdopt` | `operate` + the live lease | Finishes a claim older than `FILING_STALE_MS` with the issue the exact-mark search found, recorded as `adoptedBy`. 423 without the lease, 409 on a younger claim or one with no claim. |
| `breakLease`, `fileDelete` | admin | Held by people listed in `ADMINS`, never by a service principal. |

A `commit` or `snapshot` body over 512 KiB answers 413 and changes nothing. The plugin then keeps that lifecycle in its local store.

Every write, a heartbeat included, records its principal.

## Work claims

One `WorkBoard` per repo holds its work claims (design: `docs/superpowers/specs/2026-10-31-relay-work-claims-design.md`). An agent on any
runtime claims a piece of work by its ref (`gh#12`), checkpoints where it pushed the code and its notes file, and releases it. When its
lease lapses, the next session takes the claim over and gets back the branch, commit, notes path and recent steps; the dead holder's last
step is logged as `interrupted`. Every body carries `ref` (`^[A-Za-z0-9][A-Za-z0-9_.:#/@-]{0,127}$`) except `list`.

| Op | Needs | What it does |
| --- | --- | --- |
| `claim { holder, runtime, secret, title?, branch?, reopen? }` | `operate` | Takes a free, paused or lapsed claim with a new fence `token`; answers `{ claim, token, tookOver, resume }`. Renews the holder's own live claim. A live claim held by anyone else is 423; a `done` or `abandoned` one is 409 unless `reopen`. |
| `beat { secret, token }` | `operate` | Renews the lease. |
| `checkpoint { secret, token, text, commit?, branch?, notes? }` | `operate` | Records where the work was pushed, logs a step, renews the lease. |
| `release { secret, token, outcome, text? }` | `operate` | `outcome` is `paused`, `done` or `abandoned`. |
| `get`, `list { state? }` | `read` | One claim with its steps; every claim with its last step. An active claim with no live lease shows as `lapsed`. |
| `breakClaim { text? }` | admin | Drops the lease and pauses the claim. |
| `deleteClaim` | admin | Deletes the claim and its steps. |

A wrong secret, principal or token, or a lapsed lease, is 409. A `branch` git would refuse is 400. A claim keeps its last 200 steps,
stored apart from its summary; a board holds at most 2000 claims; a claim untouched for `RETENTION_MS`, whatever its state, is deleted
unless its lease is live.

**Client:** `npm run relay:work -- <command>` (`client/relay-work.ts`, Node 22, no dependencies) works the same from the TUI, a Workers
sandbox, a VPS, Claude cloud or the game bridge (which can also call the HTTP API directly). It reads the pr-lifecycle variables
(`PR_GATE_RELAY_URL`, then the service token pair or `PR_GATE_RELAY_TOKEN`), plus `RELAY_RUNTIME`; keeps the checkout's secret and tokens
under `<git dir>/relay-work/`; and fills the branch and commit from git. `keepalive <ref> &` beats every 30 s until the claim is lost;
`checkpoint --push` pushes before it records; `claim --checkout` checks out the branch a takeover resumes.

## Running it locally

`npm run relay:dev` serves the production Worker and objects under Miniflare at `http://127.0.0.1:8787`, with state kept in
`pr-lifecycle-relay/.dev/` (gitignored) across restarts, behind a stand-in for Access that signs JWTs with keys it makes. It seeds
`operate` grants for one service token per runtime (`DEV_RUNTIMES`, default `tui,sandbox,vps,cloud,bridge,gate`) and the dev admin
(`DEV_ADMIN`) on each repo in `DEV_REPOS`, and writes `.dev/<runtime>.env` and `.dev/admin.env`. Source one and run the client:

```bash
npm run relay:dev                                     # in one terminal
. pr-lifecycle-relay/.dev/sandbox.env && npm run relay:work -- claim gh#12 --repo adamtasteslikegood/td2do
```

`LEASE_MS=5000` shortens the lease for a takeover test. pr-lifecycle needs an `https` relay, so the gate itself is tested against a deploy.

## Grants and admins

- `GrantStore` is one object. Presets are `read` (read ops, `list`) and `operate` (all but admin ops). A grant names one repo (`owner/name`,
  lowercased) and a principal; there is no wildcard.
- `grants` lists them. `grant { principal, repo, preset }` adds one or changes its preset. `revoke { principal, repo }` removes it. Each
  records its actor in a history capped at 500 entries (R104).
- A principal with no grant gets 403. A revoke holds for every request that starts after it commits; there is no cache.
- Admins come only from the `ADMINS` Worker variable (comma-separated people). No op makes an admin.
- **Seeding.** `GrantStore` starts empty. After the first deploy, an admin sends `{ "op": "grant", "principal": "<email or service token common_name>", "repo": "owner/name", "preset": "operate" }` to `/v1/admin/grants`, once per principal and repo.

## Bindings and variables

| Name | Kind | Meaning |
| --- | --- | --- |
| `LIFECYCLE`, `GRANTS`, `REPO_INDEX`, `WORK` | Durable Objects | `LifecycleObject`, `GrantStore`, `RepoIndex`, `WorkBoard` (see `wrangler.jsonc`) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | vars | the Access team's domain and the application's AUD tag |
| `ADMINS` | var | comma-separated admin people |
| `LEASE_MS` | var, optional | lease length; 120 000 (R74, R100) when unset |
| `FILING_STALE_MS` | var, optional | age before the lease holder may adopt a claim; 30 minutes when unset |
| `RETENTION_MS` | var, optional | how long an object is kept: 90 days after its PR's archive commit, or after a branch key's last write (R102) |
| `INDEX_RETRY_MS` | var, optional | first delay before an object retries its index update (doubled to 5 minutes); 1000 when unset |
| `TEST_FAULTS` | var, tests only | `'1'` opens `/v1/admin/index`. Leave it unset in wrangler. |

## Also kept

- 20 archives per object (`ARCHIVE_CAP`), and 100 write-history entries (`WRITE_CAP`).
- Each object tells `RepoIndex` about its changes through an outbox, delivered by an alarm that retries; `list` reads the index. The index
  orders by `(born, rev)` per key, so a late update never brings back a removed entry.

## Checks

```bash
npm run test:relay       # node --test, the Worker under Miniflare
npm run typecheck:relay  # tsc -p pr-lifecycle-relay
```

`wrangler.jsonc` is for reference only. The request count per lifecycle-hour is in the design's section 12
(`docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md`).
