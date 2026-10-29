# The shared lifecycle store: connecting pr-lifecycle to the relay (#29 Part B)

Status: proposed for owner review. Nothing in this document is built or deployed yet.

Inputs:

- the seam (#47, `pr-lifecycle/hooks/store.ts`);
- the relay prototype (#48, `pr-lifecycle-relay/`, 17 tests under Miniflare);
- Adam's identity rulings of 2026-10-27, the decided items, and decisions N and O (ROADMAP);
- the open decisions in `docs/superpowers/plans/2026-10-27-pr-lifecycle-filing-identity.md`, Part B.

Each of those open decisions below has a recommendation and needs Adam's ruling. The same goes for the three new ones this design raises: **P**, **Q** and **R**.

## What the shared store is for

Decision N makes the store the record every party reads and writes: what was found, what holds the merge, and who is driving. Today each checkout has its own copy in the plugin store. A second checkout of the same PR can't see the first, so it can file a finding again (#29) or resume a lifecycle another worktree is running (#27). The relay gives each PR one object that checks, in a single step, three things:

- the caller's grant;
- the driver's lease;
- the record's revision.

The validator (#33) and the conductor will read the same object, but they are not part of this design.

## 1. Which records the relay holds (open decision 4, with #27)

| Record | Where | Why |
| --- | --- | --- |
| Pre-PR (no `pr`) | local, as today | The relay's key is `owner/repo#pr`. Before a PR exists, one checkout drives the branch, so there is nothing to coordinate. |
| Post-PR (`pr` and `slug` set) | the relay, in a repo that opts in | One PR, many checkouts. |
| Archives of post-PR records | the relay | They are kept with the record they came from. |

A record **crosses over** the moment it gets a PR number:

- after the PR create the gate sees;
- after an adoption;
- or when a resume finds an existing PR.

The first relay `commit` (at `rev: 0`) creates the object. The local copy is then kept read-only as the fallback seed for section 8, and every later change goes to the relay.

**Recommendation:** build "records by PR" (wave 3, item 2) on the relay for post-PR records, and keep it local for pre-PR ones. #27 is then fixed for any repo that opts in. Repos that don't opt in keep today's behaviour.

## 2. Choosing a backend

- **The repo opts in through `.github/pr-gate.json`**, read from the base branch like every other per-repo setting. It carries no credential:

  ```json
  { "sharedStore": { "url": "https://<relay host>", "aud": "<Access application AUD tag>" } }
  ```

- **The credential is per machine and never in the repo.** It is an Access service token (client id and secret), read from the user's settings or the environment. A person's own session may instead use their Access sign-in token. With no credential, or no `sharedStore`, the local store is used and the run log says why, once per lifecycle.
- **The backend is chosen inside the exported functions in `store.ts`.** The engine follows `$` only into function declarations, so the seam can't be an object. Each function reads the config and calls either the local implementation or a small `relay.ts` client, whose calls are all `POST /v1/<owner>/<repo>/<pr>`.

## 3. `transact` against the relay

The rule in the seam doesn't change: a change of a live record goes through `transact($, root, branch, tx => ...)`.

1. **The in-process lock stays.** `transact` still takes the lock for its branch, which keeps one process's transactions in order, exactly as today.
2. **Load.** `tx.load()` sends `read` and keeps the returned `rev`.
3. **Work runs locally.** Any git or gh calls inside it run on the checkout. `startGate` is one that does. No network lock is held while they run.
4. **Commit.** `tx.save(rec)`, with any `tx.archive(old, at)` alongside, becomes one `commit` carrying `{ rev, record, archive? }`, sent when `work` returns. `archive` is `{ at, record }`: the record `tx.archive` was given, with `phase: 'archived'`, as the local `writeArchive` stores it. The prototype's `archiveAt`, which copies whatever record is stored, changes to this, so the relay keeps exactly what the local store would. A save with no archive sends no `archive`. If `work` saves twice, only the last save is sent.
5. **Who else can commit.** The lease keeps other checkouts out: a commit under someone else's live lease gets 423. A 409 (stale revision) can then happen only in three ways:
   - the lease lapsed and was taken over mid-transaction;
   - an admin broke the lease;
   - a non-holder wrote, which section 5 confines to the log.

What a refused commit does depends on the caller, because the plan forbids retrying work that has side effects on its own:

| Caller | On 409 or 423 |
| --- | --- |
| `updateRecord` or `upsertRecord` with a pure `change` (most of the 32 sites) | Retried once, against the record the 409 returned. A second refusal is handled as in the next row. |
| Any `transact` whose work ran git, gh, an agent or a filing (`startGate`, `archiveLifecycle`, the filing pass) | Not retried. `transact` throws `StaleRecord`. The tick drops what it computed and stands down through `isStillMine`, so the next tick starts again from the relay's record. |
| `saveRecord` (a seed or a test) | Throws. |

A "pure change" is marked at the call site (`updateRecord(..., { isPure: true })`), so no backend has to guess. The default is "not pure".

## 4. Owner and lease (open decision 1, plus new decision P)

`Owner { sessionId, beatAt }` maps to the relay's `Lease { holder, principal, token, until }`:

| pr-lifecycle | Relay |
| --- | --- |
| `claimRecord` (start, resume, a person's command) | `claim` with `holder` set to the session id |
| `beat` (every 30 s today, `BEAT_MS`; 60 s recommended under decision 1) | `beat` |
| `isOwnedElsewhere` / `isStillMine` | Answered from the `until` and `holder` that the last `claim`, `beat` or `read` returned. A network read happens only after that lease has lapsed, or when this session isn't the holder. |
| `OWNER_STALE_MS` (120 s, R74) | `LEASE_MS` (120 s) |
| standing down at the end of a run | `release` |

The lease is **fenced**: every new holder gets a higher `token`. It is also **bound to its holder's capability**: the same principal, and a secret whose hash matches.

**Decision P: a person's takeover of a live lease.** Today `claimRecord` lets an interactive session overwrite a live owner (`round.ts:416-419`); only a headless one is refused. The relay refuses any live lease held by another holder (423), and `isMine` also requires the holder's own secret. So even two sessions on one machine, under one principal, can't hand the record over. There are three options:

- **(a) Wait for the lease to lapse, or ask an admin.** A person's command on a held record says who holds it and until when. After at most 2 minutes of silence it is taken over under R74. Adam can run `breakLease` at once. This is the simplest, and it can't be misused across machines.
- **(b) A `take` op limited to the same principal.** Allowed when the caller's principal equals the lease's: one person, or one machine's service token, moving between their own sessions. It issues a new token, which fences out the old session. A takeover across principals still needs a lapse or an admin. This keeps #13's interactive behaviour on one machine.
- **(c) Any `operate` principal may take a live lease.** This matches today's local behaviour, but any granted checkout could then cut off any other.

**Recommendation: (b).** It keeps what a person at their own prompt can do today and adds no new power across machines. It is one new op, with a test that a different principal gets 423.

## 5. The run log under a lease (new decision Q)

`logEvent` runs through `updateRecord` from 24 sites in `round.ts`. Some of them log *because* this session isn't the holder: `standDown`, and the takeover line in `claimRecord`. Under the relay, those commits would always get 423.

**Recommendation:** move the log out of the record into the object's own list.

- A new `log` op needs `operate`, not the lease. It doesn't bump `rev`, and it's capped at `LOG_CAP` (200).
- `read` returns the list beside the record.
- `/pr-gate log` (R78) reads it from there.
- Each line records the principal and the session id.

Log lines then never conflict with record commits. The alternative, keeping the log local, would split one PR's history across checkouts.

## 6. The checkout's secret (the answer to G6-1 on PR #48)

- The secret is made once per session: two `crypto.randomUUID()` values joined, 72 characters, above `MIN_SECRET` (32).
- There are two secrets, because a lease and a filing outlive different things:
  - the **lease secret** belongs to the session. It is saved in the plugin store under `relay-secret:<sessionId>`. A restarted session has a new session id, so it gets a new secret, and it is correctly treated as a new holder;
  - the **filing secret** belongs to the checkout and the lifecycle. It is saved under `relay-filing-secret:<root>:<lifecycleId>`, so a session restarted in the same checkout finishes a filing its predecessor claimed (section 7). Another checkout never has it, so it can't finish someone else's claim.
- Each is saved **before** the first call that sends it. If that save fails, the call isn't sent, and the session uses the local store as in section 8.
- A lost response is retried with the saved secret, so a claim's or filing's own author can always finish it.
- Only the hash leaves the checkout's memory and is stored: the object keeps the SHA-256 and never returns it.

## 7. The filing ledger (open decision 2)

In a repo that opts in, filing one finding goes:

1. **Exact-mark search first**, as today (R96). An issue already carrying `<!-- pr-gate filing: <id> of #<pr> lc <uuid> -->` is adopted. A crash after a POST is recovered this way, because a claim alone can't tell whether the POST went out. The ledger then records the adoption, without impersonating anyone:
   - **unclaimed** (filed during fallback, section 8): `fileClaim` first, then `fileDone` with the issue;
   - **claimed by this checkout** (the claimant crashed after its POST, and this session restarted in the same checkout): `fileDone` with the filing secret it kept (section 6). The relay answers as for the claimant, because it is the claimant's capability;
   - **claimed by another checkout**: as in step 2's third case, no POST and no `fileDone`. The issue is used locally, and only the claimant or an admin moves the ledger;
   - **done**: adopt its result.
2. **`fileClaim`** with the key `lifecycleId:findingId:attempt`:
   - `isFresh: true`, or `isMine: true` (a retry after a lost answer): file the issue, then send `fileDone` with `{ number, url }`.
   - `isFresh: false, isMine: false`, still `claimed`: another checkout is filing. Don't POST. Read `filing` again on the next tick. A claim older than the step timeout (`stepTimeoutMinutes`, 30) with no `fileDone` shows in `/pr-gate log` as stuck, for an admin's `fileDelete`. It is never taken over automatically, because its POST may already have gone out.
   - `state: 'done'`: adopt its result.
3. **When `attempt` advances:** only when the same finding holds the merge again in the same lifecycle after its earlier issue was closed. It starts at 1. A new lifecycle has a new `lifecycleId`, so its keys never collide with earlier ones.

## 8. Fallback and recovery (decided: fall back; open decision 3: migration)

**Fallback.** When the relay can't be reached (network error, 5xx, or a timeout of 5 s per call):

- the round uses the local store;
- the run log says so once;
- the round never stalls on the network.

While in fallback, the local record carries `relayRev`, the last revision it read from the relay.

**Recovery, proposed.** On the first relay call that succeeds again:

| Case | Result |
| --- | --- |
| The relay's `rev` still equals `relayRev` | The local record is committed at that `rev`. Its changes win, since nobody else wrote. |
| The relay moved on | The relay's record wins. The local changes are kept as an archive taken at the recovery time, and the run log says so. The person or the conductor reads both, and nothing is merged blindly. |

Fallback coordinates nothing across checkouts (the decided rule), so it can't stop duplicates. Two checkouts in fallback at once can each pass the exact-mark search before either issue exists, and each file the same finding. On recovery, the step 1 search in section 7 finds every issue carrying the mark. It adopts the lowest-numbered one into the ledger and lists the others in the run log, for the person to close. It never closes them itself. A single checkout in fallback files no duplicate, because its own retries find their mark.

**Migration (decision 3), recommended:** leave existing local records alone, and leave existing issues and marks alone too. A post-PR record crosses over on its next change in a repo that has opted in:

- if the object is empty (`rev: 0`), the local record is pushed up;
- if it isn't, the relay's record is adopted, and the local one is archived.

Pre-PR records never move.

**Retention, recommended:**

| What | Kept for |
| --- | --- |
| Archives | 20 per PR (`ARCHIVE_CAP`), as prototyped |
| Filing results | as long as the PR's object exists |
| Each PR's object | 90 days after its PR is merged or closed, after which an alarm deletes it. The issues on GitHub stay as the lasting record. |

## 9. Discovery and archives

**Archives.** `latestArchive` becomes `archives`, which returns the newest. `tx.archive` together with `tx.save` is one `commit` with `archive` (section 3).

**Discovery.** `liveRecords(root)` lists every live record under a checkout root. A per-PR object can't answer that, so:

- A second object class, `RepoIndex`, holds one object per `owner/repo`, with an entry `{ pr, branch, phase, rev, updatedAt }` for each live post-PR record.
- After each `commit`, the PR's object calls its repo's index (object to object, inside the Worker). An archive or a closed PR removes its entry. A failed index update doesn't fail the commit; the next commit retries it.
- `liveRecords(root)` maps the root to its slug, then returns the index's entries, each read from its PR's object, plus the local pre-PR records.
- A new `list` op reads the index. It needs `read` on the repo.

## 10. Grants (open decision 5)

**Recommendation:** a `relay-grants.json` versioned in this repo, holding principals, repos and presets, plus the admin list. It is loaded into the Worker's `GRANTS` and `ADMINS` at deploy. A change goes through a PR like any other code, and the pre-PR gate reviews it.

Access policy groups would also need a mirror, two places that can drift; leave them for v2. Revoking a service token in Access cuts that machine off at once, whatever the file says.

## 11. Security findings in a shared store (new decision R)

The record carries each finding's text, security findings included. R92 and R95 keep those off GitHub; they go to Jira where `jiraProject` is set. The relay would be a new place that text lives: a Cloudflare object any principal with `read` on the repo can read.

- **(a) Full text, guarded by grants.** The simplest option. Who can read is exactly the grant list for that repo.
- **(b) A reference only.** A security finding is stored as `{ id, severity, isSecurity: true, ref }`. Its text stays in the local record, or in Jira, and only the checkout that found it shows it in full.

**Recommendation: (b) until the grant list holds anyone besides Adam and his own service identities**, then revisit. It costs one redaction step at the commit boundary, and a test that no security finding's body reaches `commit`.

## 12. Request count and latency

### Request count per active lifecycle-hour (a count from the code, not measured)

| Source | Rate in the code | Relay requests per hour |
| --- | --- | --- |
| Holder's beat (`BEAT_MS`, 30 s) | 1 per 30 s | 120 |
| `isOwnedElsewhere` / `isStillMine` (5 sites, plus the watcher) | each check | 0 for the holder (section 4's cache). A non-holder's watcher reads once per 60 s per watched record (`WATCH_TICK_MS`): 60 |
| Record commits (32 `updateRecord` sites, `transact` ×5) | a few per round transition | about 2 per change (`read` + `commit`), tens per round |
| Log lines (24 sites) | a few per round | 1 each (`log`) |
| Filing | per finding filed | 2 to 3 (`fileClaim`, `fileDone`, sometimes `filing`) |

So the floor is about 120 requests per hour per lifecycle with a driving session, and roughly 180 to 300 in practice, plus a burst at each round's transitions.

The lever is the beat. A `LEASE_MS` of 120 s with a beat every 60 s, instead of 30 s, halves the floor and still leaves two misses before a takeover.

Comparing these counts with the prepaid Workers plan's included requests and Durable Object requests is left for Adam: the plan's figures aren't quoted here from memory.

### Latency (not measured yet)

| Measurement | Status |
| --- | --- |
| The baseline: today's in-process lock plus plugin-store write | Can be measured locally; not yet run. |
| A Miniflare round trip | In-process, so a floor at best: it leaves out the network and Access entirely. |
| A real round trip (checkout → Access → Worker → object) | Needs a development deploy, which nobody has authorized. **Ask Adam:** may one Worker and one Access application be created on the Cloudflare account to measure this? |

The design keeps the network off the paths where latency would matter:

- the holder's ownership checks are answered locally;
- no lock is held across git or gh;
- a slow relay falls back after 5 s.

## 13. What changes, and what stays

**Changes, in a repo that opts in:**

- `store.ts` chooses a backend;
- a new `relay.ts` client and a `relay-secret` store key;
- `transact` becomes a commit with a revision check;
- `claimRecord`, `beat`, `isOwnedElsewhere` and `standDown` go through the lease;
- `logEvent` goes through `log`;
- `fileOnce` goes through the ledger.

**New in the relay:**

- `take` (if decision P is (b));
- `commit`'s `archive` in place of `archiveAt`;
- `log` and `list`;
- the `RepoIndex` class;
- the retention alarm;
- the redaction test (if decision R is (b)).

**Stays the same:**

- rounds, triage, reviews and budgets;
- waivers and filing dispositions;
- security and Jira routing;
- R74's 2-minute takeover;
- every repo that doesn't opt in;
- `codex-gate/` (frozen).

## 14. Proof before it is used

- **Two controller clients** (two checkout roots, two session ids, one Miniflare relay, one fake GitHub) run one PR:
  - only the holder dispatches work;
  - the other stands down;
  - a takeover after a lapse fences out the old holder's commit;
  - neither files a finding twice.
- **A stale `startGate` commit** (409) isn't retried, and the next tick recovers.
- **Fallback:** the relay goes down mid-round, the round continues locally, and recovery follows the rule in section 8 in both cases. Two checkouts that both file in fallback: on recovery, the lowest-numbered issue is adopted and the other is reported, not closed.
- **Crash after a POST:** the issue POST succeeds, the session dies before `fileDone`, and a new session starts in the same checkout. The exact-mark hit sends no second POST, `fileDone` with the kept filing secret leaves the ledger `done`, and the same restart from another checkout leaves it `claimed`, with no second POST either.
- **Archive:** `commit` with `archive` keeps the record `tx.archive` was given, `phase: 'archived'`, matching the local store.
- **Discovery:** `liveRecords` through the index matches the per-PR objects.
- **Per decision:**
  - P(b): a different principal's `take` gets 423;
  - Q: a non-holder's `log` succeeds and its commit gets 423;
  - R(b): no security finding's text reaches `commit`.
- **The request count** for one scripted lifecycle, counted at the Miniflare boundary, to check section 12's table.
- **The repo's own gates:** `npm run check` (the plugin harness, the relay tests, both typechecks).

## Decisions for Adam

| | Decision | Recommendation |
| --- | --- | --- |
| 1 | Driver lease | 120 s (R74), fenced, bound to its holder's secret; a beat every 60 s |
| 2 | Retry identity | `lifecycleId:findingId:attempt`; `attempt` advances only on a re-file after an issue closed unfixed |
| 3 | Retention and migration | 20 archives; objects deleted 90 days after the PR ends; local records cross over on their next change, never pushed in bulk |
| 4 | Scope with wave 3 item 2 and #27 | Post-PR records on the relay, pre-PR local |
| 5 | Grants | `relay-grants.json` in this repo, reviewed by PR |
| P | A person taking over a live lease | (b) a `take` op within the same principal |
| Q | The run log under a lease | its own lease-free `log` list in the object |
| R | Security findings in the shared store | (b) a reference only, while only Adam's identities hold grants |
| - | A development deploy, to measure real latency | Ask: one Worker and one Access application, removed afterwards |
