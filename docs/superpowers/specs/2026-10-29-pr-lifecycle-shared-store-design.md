# The shared lifecycle store: connecting pr-lifecycle to the relay (#29 Part B)

Status: decided (Adam, 2026-10-29; rulings R100–R108). Adam overrode the recommendations on decisions 4, 5 and Q; sections 1, 2, 5, 8, 9, 10, 12, 13 and 14 carry his rulings, and the sub-choices they left open are ruled in place, each marked **Ruled**. Nothing is built or deployed yet.

Inputs:

- the seam (#47, `pr-lifecycle/hooks/store.ts`);
- the relay prototype (#48, `pr-lifecycle-relay/`, 17 tests under Miniflare);
- Adam's identity rulings of 2026-10-27, the decided items, and decisions N and O (ROADMAP);
- the open decisions in `docs/superpowers/plans/2026-10-27-pr-lifecycle-filing-identity.md`, Part B.

Each of those open decisions, and the three new ones this design raised (**P**, **Q** and **R**), now has Adam's ruling; see the table at the end.

## What the shared store is for

Decision N makes the store the record every party reads and writes: what was found, what holds the merge, and who is driving. Today each checkout has its own copy in the plugin store. A second checkout of the same PR can't see the first, so it can file a finding again (#29) or resume a lifecycle another worktree is running (#27). The relay gives each PR one object that checks, in a single step, three things:

- the caller's grant;
- the driver's lease;
- the record's revision.

The validator (#33) and the conductor will read the same object, but they are not part of this design.

## 1. Which records the relay holds (decision 4, R103)

**Adam's ruling: pre-PR records go to the relay too, keyed by branch.** The recommendation kept them local on the grounds that one checkout drives a branch before its PR exists. That doesn't hold: two worktrees or a cloud session can drive the same branch, and the validator and conductor (decision N) need to see a lifecycle before its PR opens.

| Record | Key | Where |
| --- | --- | --- |
| Pre-PR (no `pr`) | `owner/repo@<branch>` | the relay, in a repo that opts in |
| Post-PR (`pr` and `slug` set) | `owner/repo#<pr>` | the relay, in a repo that opts in |
| Archives | kept with the object their record came from | the relay |
| Any record in a repo that doesn't opt in, or whose checkout has no GitHub `origin` to name the slug | today's local key | local |

**The slug of a pre-PR record** comes from the checkout's `origin` remote (`slugOf`), resolved when the record is made and saved on it, so every later call names the same object.

**The branch key.** The URL is `POST /v1/<owner>/<repo>/branch/<branch>`, with the branch percent-encoded as one path segment (`/` becomes `%2F`). The Worker decodes it and accepts a name of 1 to 255 bytes that `git check-ref-format --branch` would accept: no `..`, no control characters, no space, `~`, `^`, `:`, `?`, `*`, `[` or `\`, not starting with `-` or `/`, not ending with `/`, `.` or `.lock`. The object's name is `owner/repo@<branch>`, the owner and repo lowercased, the branch kept as is (git branch names are case-sensitive). The PR URL, `POST /v1/<owner>/<repo>/<pr>`, is unchanged.

**The move to the PR key.** A record moves the moment it gets a PR number: after the PR create the gate sees, after an adoption, or when a resume finds an existing PR. Two objects can't be written in one step, so the move is ordered and every step is idempotent (**Ruled**):

1. **Freeze the source.** Under the branch object's lease, send `moveTo { pr }` to it. It replaces the record with a tombstone `{ movedTo: pr, lifecycleId, record }` that still carries the record, bumps `rev`, releases the lease and queues an index removal (section 9). From this step on, the branch object can't be driven (step 3), so the PR object is never made driveable while the branch still is (PR #51 review).
2. **Publish the destination.** `claim` the PR object, then `commit` the tombstone's `record` to it at `rev: 0`, with `from: '@<branch>'`. If the PR object is not at `rev: 0`, its record's `lifecycleId` decides: the same id means an earlier move got this far, so the move carries on at step 3; another id means the PR already has a lifecycle, and the record is kept by `snapshot` (`reason: 'move'`), as in section 8's recovery.
3. **Finish.** Send `moveDone` to the branch object. It needs `operate` and the tombstone's `lifecycleId`, not the lease, since the lease was released at step 1. It drops the record copy from the tombstone, leaving `{ movedTo, lifecycleId }`. Sending it again is a no-op. Archives and filings stay where they are.

From step 1 on, every record or lease op on the branch object (`commit`, `claim`, `beat`, `take`, `release`, `moveTo`), except a fresh start (below), answers **410** with `{ movedTo, lifecycleId }`. So no action-boundary beat on the branch key succeeds, and no source client dispatches. `read` answers 200 with the tombstone as the record; `archives`, `filing`, `log`, `snapshot` and `moveDone` work as before. A client whose `lifecycleId` matches follows it to the PR key, and so does a stale checkout still driving the branch key.

**Recovery is the same from each state (Ruled).** A client that meets a tombstone still carrying `record` runs steps 2 and 3 itself before following. Each step is idempotent:

- A crash before step 1 leaves only the branch object live.
- A crash between steps 1 and 2 leaves the frozen branch and an empty PR object. The record is still on the branch, so it isn't lost.
- A crash between steps 2 and 3 leaves the PR object holding the record and the branch still frozen.

In none of these can both objects be driven. A delayed index update can't change that, because the fence is the branch object's own state, not the index.

**A branch name used again.** After a PR merges or closes, a branch of the same name can start a new lifecycle. A fresh start, an adoption or a reset (a new `lifecycleId`, R96) may `commit` over a tombstone at its `rev` with `isFresh: true`, so the old PR's object is left alone. A follower whose `lifecycleId` matches neither the tombstone nor the new record stands down.

**Recommendation as ruled:** "records by PR" (wave 3, item 2) is built on the relay for both kinds. #27 is then fixed for any repo that opts in. Repos that don't opt in keep today's behaviour.

## 2. Choosing a backend

- **The repo opts in through `.github/pr-gate.json`**, read from the base branch like every other per-repo setting. It carries no credential:

  ```json
  { "sharedStore": { "url": "https://<relay host>", "aud": "<Access application AUD tag>" } }
  ```

- **The credential is per machine and never in the repo.** It is an Access service token (client id and secret), read from the user's settings or the environment. A person's own session may instead use their Access sign-in token. With no credential, or no `sharedStore`, the local store is used and the run log says why, once per lifecycle.
- **The machine pins the relay (final review I1).** `PR_GATE_RELAY_URL` names the relay this machine trusts. Credential headers are sent only when the origin of `sharedStore.url` equals the origin of `PR_GATE_RELAY_URL`, since the base's file is anyone's who can push to the base. With the pin unset or of another origin, no credential is sent, no relay call is made, the lifecycle runs locally, and the run log names the mismatch once per lifecycle, never a credential value.
- **The backend is chosen inside the exported functions in `store.ts`.** The engine follows `$` only into function declarations, so the seam can't be an object. Each function reads the config and calls either the local implementation or a small `relay.ts` client, whose calls are `POST /v1/<owner>/<repo>/<pr>` for a post-PR record and `POST /v1/<owner>/<repo>/branch/<branch>` for a pre-PR one (section 1). Grant edits go to `POST /v1/admin/grants` (section 10).

## 3. `transact` against the relay

The rule in the seam doesn't change: a change of a live record goes through `transact($, root, branch, tx => ...)`.

1. **The in-process lock stays.** `transact` still takes the lock for its branch, which keeps one process's transactions in order, exactly as today.
2. **Load.** `tx.load()` sends `read` and keeps the returned `rev`.
3. **Work runs locally.** Any git or gh calls inside it run on the checkout. `startGate` is one that does. No network lock is held while they run.
4. **Commit.** `tx.save(rec)`, with any `tx.archive(old, at)` alongside, becomes one `commit` carrying `{ rev, record, archive? }`, sent when `work` returns. `archive` is `{ at, record }`: the record `tx.archive` was given, with `phase: 'archived'`, as the local `writeArchive` stores it. The prototype's `commit` takes this payload (it replaced `archiveAt`, which copied whatever record was stored), so the relay keeps exactly what the local store would. A save with no archive sends no `archive`. If `work` saves twice, only the last save is sent.
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
| `isOwnedElsewhere` / `isStillMine` | Between actions, answered from the `until` and `holder` that the last `claim`, `beat` or `read` returned. A network read happens only after that lease has lapsed, or when this session isn't the holder. **At an action boundary** (see the contract below), always a `beat`. |
| `OWNER_STALE_MS` (120 s, R74) | `LEASE_MS` (120 s) |
| standing down at the end of a run | `release` |

The lease is **fenced**: every new holder gets a higher `token`. It is also **bound to its holder's capability**: the same principal, and a secret whose hash matches.

**Decision P: a person's takeover of a live lease.** Today `claimRecord` lets an interactive session overwrite a live owner (`round.ts:416-419`); only a headless one is refused. The relay refuses any live lease held by another holder (423), and `isMine` also requires the holder's own secret. So even two sessions on one machine, under one principal, can't hand the record over. There are three options:

- **(a) Wait for the lease to lapse, or ask an admin.** A person's command on a held record says who holds it and until when. After at most 2 minutes of silence it is taken over under R74. Adam can run `breakLease` at once. This is the simplest, and it can't be misused across machines.
- **(b) A `take` op limited to the same principal.** Allowed when the caller's principal equals the lease's: one person, or one machine's service token, moving between their own sessions. It issues a new token, which fences out the old session. A takeover across principals still needs a lapse or an admin. This keeps #13's interactive behaviour on one machine.
- **(c) Any `operate` principal may take a live lease.** This matches today's local behaviour, but any granted checkout could then cut off any other.

**Recommendation: (b).** It keeps what a person at their own prompt can do today and adds no new power across machines. It is one new op, with a test that a different principal gets 423.

**The ownership cache and an immediate takeover.** A `take` or an admin `breakLease` can end a lease before the `until` its holder has cached. So the cache can never by itself authorize work with outside effects:

- **An action boundary** is the moment before the driver starts:
  - an agent turn;
  - a git push;
  - a gh write: a reply, a review request, a label, a merge;
  - a filing POST.

  At each one, the driver sends `beat`, and it goes ahead only on a 200. That 200 is the server acknowledging that it still holds the lease at that moment.
- **Any 409 or 423 of a lease op empties the cache at once.** That covers a `beat` or a `release` refused, and a `commit` refused by another holder's lease (423). The session then stands down as `standDown` does today. A plain revision 409 of a `commit` keeps the run (final review M1).
- **The overlap is bounded, not zero.** An action that was already acknowledged and in flight when a `take` landed runs to its end: at most one step, capped by `stepTimeoutMinutes`. Its record commit is then refused by the revision and lease checks. Its outside effects were already sent. They are safe because each is idempotent or self-correcting:
  - a push lands on the PR branch, which the new driver fetches before acting (`round.ts`'s catch-up);
  - a filing goes through the ledger (section 7), so it is never posted twice;
  - a reply or review request may appear twice, which is visible and harmless.

  No new action starts after the old driver's next boundary, so section 14 promises no new dispatch after a takeover, not exclusive dispatch of steps already in flight.
- **The cost** is one `beat` per action boundary, a handful per round, added to section 12's count.

## 5. The run log under a lease (decision Q, R106)

`logEvent` runs through `updateRecord` from 24 sites in `round.ts`. Some of them log *because* this session isn't the holder: `standDown`, and the takeover line in `claimRecord`. Under the relay, those commits would always get 423.

**Adam's ruling: the log lives in the object's own lease-free list, with a bigger cap than the recommended 200.**

- A new `log` op needs `operate`, not the lease. It doesn't bump `rev`. **Ruled:** each line gets `seq`, a per-object counter that goes up by one on every append and never goes back, even when old lines are dropped.
- **Ruled:** the relay keeps the last `RELAY_LOG_CAP` = 1000 lines per object. When a line pushes the list past the cap, the oldest line is dropped and the object's `logDropped` count goes up by one, so `/pr-gate log` can say how many earlier lines are gone. The list is stored under its own storage key (`log`), apart from the record's `state`, so a long log never makes a record commit larger. The local store's `LOG_CAP` (200) is unchanged for repos that don't opt in.
- `read` returns the list, `logDropped` and `logSeq` (the last line's `seq`) beside the record. **Ruled:** with `logSince: <seq>`, it returns only the lines whose `seq` is above it, so the watcher doesn't fetch 1000 lines each tick. The cursor is the sequence, not the time: two lines with the same `at` are both delivered, once each (PR #51 review).
- A tombstoned branch object (section 1) still takes `log`, so its history up to the move stays readable; `/pr-gate log` shows a moved lifecycle's branch log, then its PR log.
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
- The checkout sends the secret itself, over TLS, and the object hashes it on arrival (`verifierOf`): it stores only the SHA-256 and never returns it. A checkout never sends a hash in its place.

## 7. The filing ledger (open decision 2)

In a repo that opts in, filing one finding goes:

1. **Exact-mark search first**, as today (R96). An issue already carrying `<!-- pr-gate filing: <id> of #<pr> lc <uuid> -->` is adopted. A crash after a POST is recovered this way, because a claim alone can't tell whether the POST went out. The ledger then records the adoption, without impersonating anyone:
   - **unclaimed** (filed during fallback, section 8): `fileClaim` first, then `fileDone` with the issue;
   - **claimed by this checkout** (the claimant crashed after its POST, and this session restarted in the same checkout): `fileDone` with the filing secret it kept (section 6). The relay answers as for the claimant, because it is the claimant's capability;
   - **claimed by another checkout, or claimed and its secret is gone** (the claimant's plugin store was lost, or its checkout no longer exists; the relay can't tell these apart, PR #48 G6-1): no POST and no `fileDone`. While the claim is younger than `FILING_STALE_MS` (30 minutes, the step timeout), the issue is used locally and the claimant may still finish. Once it is older, the driver reconciles it with **`fileAdopt`** (**Ruled**, PR #51 review G1-2):
     - `fileAdopt { key, result: { number, url }, secret }` needs `operate` and the PR object's **live lease**, proven by the lease secret. So the relay's one authorized driver adopts, and nobody else does.
     - It is accepted only for a `claimed` filing older than `FILING_STALE_MS`, and only with the issue the exact-mark search found. With no marked issue, there is nothing to adopt, and the claim stays for an admin, because its POST may still be on its way.
     - It writes `{ state: 'done', actor: <the claimant>, adoptedBy: <the driver's principal>, at, result }` and records `fileAdopt <key>` in the write history. The claimant stays the claimant; the adoption is recorded under the adopter's own name, so nobody is impersonated.
     - On a `done` filing it acts like `fileDone`: the same result again is 200, a different one 409.
     An admin's `fileDelete` stays the path for a claim with no marked issue;
   - **done**: adopt its result.
2. **`fileClaim`** with the key `lifecycleId:findingId:attempt`:
   - `isFresh: true`, or `isMine: true` (a retry after a lost answer): file the issue, then send `fileDone` with `{ number, url }`.
   - `isFresh: false, isMine: false`, still `claimed`: another checkout is filing. Don't POST. Read `filing` again on the next tick. A claim older than the step timeout (`stepTimeoutMinutes`, 30) with no `fileDone` shows in `/pr-gate log` as stuck, under the header `stuck filings (known findings only)`: no relay op lists every filing, so the section checks the keys of the findings the record knows, and says so if the relay was unreachable. It is never claimed afresh automatically, because its POST may already have gone out: the driver adopts it with `fileAdopt` once the exact-mark search finds its issue (step 1), and otherwise it waits for an admin's `fileDelete`.
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
| The relay moved on | The relay's record wins, and is never overwritten, not even for a moment. The losing local record is kept twice: <ul><li>locally first, under `lifecycle:<root>:<branch>:archived:<at>` as today;</li><li>then in the relay through a new `snapshot` op.</li></ul>`snapshot` appends `{ at, record, actor, reason: 'fallback' }` to the PR's archives. It needs `operate`, not the lease, and doesn't change `record` or `rev`. The run log says so. The person or the conductor reads both, and nothing is merged blindly. |

Fallback coordinates nothing across checkouts (the decided rule), so it can't stop duplicates. Two checkouts in fallback at once can each pass the exact-mark search before either issue exists, and each file the same finding. On recovery, the step 1 search in section 7 finds every issue carrying the mark. It adopts the lowest-numbered one into the ledger and lists the others in the run log, for the person to close. It never closes them itself. A single checkout in fallback files no duplicate, because its own retries find their mark.

**Migration (decision 3), recommended:** leave existing local records alone, and leave existing issues and marks alone too. A post-PR record crosses over on its next change in a repo that has opted in:

- if the object is empty (`rev: 0`), the local record is pushed up;
- if it isn't, the relay's record is adopted, and the local one is kept by `snapshot` (`reason: 'migration'`), as in the table above.

A pre-PR record crosses over the same way, to its branch key (R103); one that gets its PR number while still local goes straight to its PR key.

**Retention, recommended:**

| What | Kept for |
| --- | --- |
| Archives | 20 per PR (`ARCHIVE_CAP`), as prototyped |
| Filing results | as long as the PR's object exists |
| Each PR's object | 90 days after its PR is merged or closed, after which an alarm deletes it. The issues on GitHub stay as the lasting record. |
| Each branch object | 90 days after its last write, live record or tombstone (**Ruled**: a branch has no merge or close of its own). A later fresh start makes it again, as a new incarnation (section 9). |

## 9. Discovery and archives

**Archives.** `latestArchive` becomes `archives`, which returns the newest. `tx.archive` together with `tx.save` is one `commit` with `archive` (section 3).

**Discovery.** `liveRecords(root)` lists every live record under a checkout root. A per-PR object can't answer that, so:

- A second object class, `RepoIndex`, holds one object per `owner/repo`, with an entry `{ key, pr?, branch, phase, rev, updatedAt }` for each live record. `key` is the object's own key within the repo: `#<pr>` or `@<branch>` (R103). A move (section 1) writes the PR key's entry from the PR object and a removal from the branch object; for the moment between them both entries can show, and `liveRecords` drops a branch entry whose `lifecycleId` a PR entry already carries.
- **Each commit queues an index update.** It writes an outbox entry `{ key, rev, entry | removed }` in the same storage step as the commit, and sets an alarm. `key` is the object's own key (`#<pr>` or `@<branch>`), so pre-PR records, which have no `pr`, are told apart (PR #51 review). Archiving the record or closing the PR writes a removal: a tombstone carrying its `rev`.
- **The object sends its outbox to its repo's index** (object to object, inside the Worker), and clears it once the index acknowledges. If the update fails, the alarm retries it with backoff until it succeeds. No client and no further commit is needed, so a lifecycle whose controller exits right after its first commit is still discovered.
- **The index applies updates by incarnation, then revision (Ruled, PR #51 review).** Deleting an object resets its `rev` to 0, so `rev` alone can't order a key's updates across a deletion. Each object therefore records `born`, the time of its first write after it was empty, and keeps it until it is deleted. Every outbox entry carries `{ key, born, rev }`. The index keeps the highest `(born, rev)` per `key`, compared `born` first, and ignores any update not above it, tombstones included.
  - A delayed retry from the same incarnation can't bring back an old entry or a removed one.
  - A recreated object has a later `born`, so its first update replaces whatever the old incarnation left, and the new lifecycle can be found at once.
  - A delayed update from before the deletion carries the old `born`, so it is ignored.
  - Before the retention alarm deletes an object, it delivers a removal at its own `(born, rev + 1)` and deletes only once the index has acknowledged it.
  - Each tombstone is kept for its own object's retention period (section 8), by `key`.
- `liveRecords(root)` maps the root to its slug, then returns the index's entries, each read from its object, plus any local records of a repo or checkout that isn't on the relay. So the entry also carries `lifecycleId`.
- A new `list` op reads the index. It needs `read` on the repo.

## 10. Grants (decision 5, R104)

**Adam's ruling: grants are stored in the relay**, not in a file in this repo. A change takes effect without a deploy, and the relay records who made it.

- **A third object class, `GrantStore`**, has one object (`idFromName('grants')`). It holds the grants `[{ principal, repo, preset }]` (presets `read` and `operate`, as prototyped), a `rev`, and a write history of `{ actor, op, at, rev, grant }`, capped at 500 entries.
- **Admin ops** on `POST /v1/admin/grants`: `grants` (list them), `grant { principal, repo, preset }` (add, or change the preset of an existing pair), and `revoke { principal, repo }`. Each needs admin and records the actor. A grant names one repo (`owner/name`, lowercased); there is no wildcard in v1.
- **Who is admin stays at deploy (Ruled).** `ADMINS` remains a Worker variable, as prototyped and as the 2026-10-27 ruling requires: admin is a separate capability, held by Adam's human identity only. No op can add an admin, so a stolen operate token can't escalate, and the store can't lock its own admin out. The Worker's `GRANTS` variable is removed. `GrantStore` starts empty, and Adam seeds it with `grant`.
- **The check stays in one step with the write (Ruled).** The Worker reads the caller's preset for the repo from `GrantStore`, by an object-to-object call, and passes it to the PR or branch object in an internal header (`x-relay-preset`) that replaces any header of that name the caller sent, as `x-relay-principal` does today. The object checks it in the same step that checks the lease and the revision and writes. There is no cache, so a `revoke` holds for every request that starts after it commits. A request that read its grant just before the revoke can still finish; that window is one request. Revoking the machine's Access service token still cuts it off at once.
- **The cost** is one more Durable Object request per relay call (section 12). A per-isolate cache would save it but would let a revoked grant keep working for the cache's lifetime; it can be revisited once the request count is measured.

Access policy groups would also need a mirror, two places that can drift; leave them for v2.

## 11. Security findings in a shared store (new decision R)

The record carries each finding's text, security findings included. R92 and R95 keep those off GitHub; they go to Jira where `jiraProject` is set. The relay would be a new place that text lives: a Cloudflare object any principal with `read` on the repo can read.

- **(a) Full text, guarded by grants.** The simplest option. Who can read is exactly the grant list for that repo.
- **(b) A reference only.** A security finding is stored as `{ id, severity, isSecurity: true, ref }`. Its text stays in the local record, or in Jira, and only the checkout that found it shows it in full. **Ruled** (PR #51 review): on load, a redacted finding gets its text back from the local record only when both records carry the same `lifecycleId` and a finding with the same `id`. Finding ids such as `G1-1` start again in each lifecycle, so text from another lifecycle is never attached. Only the redacted fields come back (`title`, `detail`, `note`, `file`, `line`, `url`). Everything else, status included, is the relay's. Otherwise the placeholder stays.
  - **Ruled** (PR #54 review, G1-2 and G1-3): the reference keeps every field that is not text, so another checkout still holds the merge on it: `needsRecheck`, `linkBy`, `isLinkChecked`, the filing fields, and the history without its `note` and `evidence`. The text it drops is `title`, `detail`, `note`, `file`, `line`, `url`, the Jira summaries, and the filing and label errors. Any other finding's text that names a security finding is held whole, as the rest of the record's text is, and comes back from the local record of the same lifecycle.

**Recommendation: (b) until the grant list holds anyone besides Adam and his own service identities**, then revisit. It costs one redaction step at the commit boundary, and a test that no security finding's body reaches `commit`.

## 12. Request count and latency

### Request count per active lifecycle-hour (counted at the Miniflare boundary in Task 11)

The first version of this table was a count from the code. It is now measured, for a scripted hour of one driving session: 1 claim, 60 beats (the beat is every 60 s, R100), 10 record changes (a `read` and a `commit` each), 20 log lines and 3 filings (`fileClaim` and `fileDone`).

| Source | Worker requests | Durable Object requests |
| --- | --- | --- |
| claim | 1 | 2 |
| beat x 60 (one per 60 s) | 60 | 120 |
| record change x 10 (`read` + `commit`) | 20 | 60 |
| log x 20 | 20 | 40 |
| filing x 3 (`fileClaim` + `fileDone`) | 6 | 12 |
| **Total** | **107** | **234** |

- **The identity.** Durable Object requests = 2 x W + 2 x commits, where W is the Worker requests: each Worker request costs one `GrantStore` lookup and one lifecycle-object request (R104), and each commit adds an outbox alarm and a `RepoIndex` update. Here 234 = 2 x 107 + 2 x 10. The ratio is 2 + 2 x commits / W, so it is 2.19 in this script, and about 2.37 with 20 commits among the 107 requests. "About twice" is the floor.
- **What the script leaves out.** Each tick of a driving session sends a `list` and a `read` before its beat, and the first version of the table did not count them. That is 2 more Worker requests per tick, and 4 more Durable Object requests (a `GrantStore` lookup and an object or index request each). At one tick a minute, 120 more Worker requests and 240 more Durable Object requests an hour. So the true figure for a driving session is about 227 Worker requests and 474 Durable Object requests an hour in this script's shape, before bursts at round transitions. A non-holder's watcher reads once per 60 s per watched record (`WATCH_TICK_MS`), which is 60 more Worker requests an hour for each.
- **The beat** stays the lever: `LEASE_MS` 120 s with a beat every 60 s.
- The count does not exercise the 60 s cadence itself; the harness sends the calls back to back. Comparing these counts with the prepaid Workers plan's included requests is left for Adam.

### Latency (not measured yet)

| Measurement | Status |
| --- | --- |
| The baseline: today's in-process lock plus plugin-store write | Can be measured locally; not yet run. |
| A Miniflare round trip | In-process, so a floor at best: it leaves out the network and Access entirely. |
| A real round trip (checkout → Access → Worker → object) | Needs a development deploy. **Adam's ruling (R108): yes, as the last step of the build**: one Worker and one Access application, removed afterwards. The agent stops and confirms with Adam immediately before creating them, since it changes his Cloudflare account. |

The design keeps the network off the paths where latency would matter:

- the holder's ownership checks are answered locally;
- no lock is held across git or gh;
- a slow relay falls back after 5 s.

## 13. What changes, and what stays

**Changes, in a repo that opts in:**

- `store.ts` chooses a backend, for pre-PR and post-PR records alike;
- a new `relay.ts` client and a `relay-secret` store key;
- a record moves from its branch key to its PR key (section 1);
- `transact` becomes a commit with a revision check;
- `claimRecord`, `beat`, `isOwnedElsewhere` and `standDown` go through the lease;
- `logEvent` goes through `log`;
- `fileOnce` goes through the ledger.

**New in the relay:**

- `take` (decision P);
- `log`, `list` and `snapshot`;
- branch keys, `moveTo`, `moveDone` and the tombstone (decision 4);
- the index outbox and its alarm;
- the `RepoIndex` class;
- the `GrantStore` class, its admin ops, and the preset header (decision 5);
- the retention alarm;
- the redaction step and its test (decision R).

**Stays the same:**

- rounds, triage, reviews and budgets;
- waivers and filing dispositions;
- security and Jira routing;
- R74's 2-minute takeover;
- every repo that doesn't opt in;
- `codex-gate/` (frozen).

## 14. Proof before it is used

- **Two controller clients** (two checkout roots, two session ids, one Miniflare relay, one fake GitHub) run one PR:
  - no new dispatch after a takeover: once the old driver's boundary `beat` is refused, it starts nothing, while the new holder dispatches. An action already acknowledged before the `take` may finish (section 4's bounded overlap): its commit is refused, its push is caught up by the new driver's fetch, its filing goes through the ledger with no second POST, and a reply it sent may appear twice;
  - a `take` right after the old driver's beat, then an old-driver dispatch before its next beat: the old driver's next `beat` is refused, and nothing is dispatched. A lost lease's `beat` answers 409 and a `commit` under another holder's live lease answers 423 (the relay's contract); both stand the old driver down. A plain revision 409 at a site that is not pure keeps the run, and the next tick recovers from the relay's record; only a 423, a moved record (410) or a refused credential (401, 403) stands down;
  - the other stands down;
  - a takeover after a lapse fences out the old holder's commit;
  - neither files a finding twice.
- **A stale `startGate` commit** (409) isn't retried, and the next tick recovers.
- **Fallback:** the relay goes down mid-round, the round continues locally, and recovery follows the rule in section 8 in both cases. Two checkouts that both file in fallback: on recovery, the lowest-numbered issue is adopted and the other is reported, not closed.
- **Crash after a POST:** the issue POST succeeds, the session dies before `fileDone`, and a new session starts in the same checkout. The exact-mark hit sends no second POST, `fileDone` with the kept filing secret leaves the ledger `done`, and the same restart from another checkout leaves it `claimed`, with no second POST either. With the plugin store lost as well, a new session that holds the lease waits until the claim is older than `FILING_STALE_MS`, then finds the marked issue, sends `fileAdopt` and ends `done` with `adoptedBy` set, with no second POST and no admin. `fileAdopt` from a session without the live lease gets 423, on a younger claim 409, and without a marked issue it isn't sent.
- **Archive:** `commit` with `archive` keeps the record `tx.archive` was given, `phase: 'archived'`, matching the local store.
- **Discovery:** `liveRecords` through the index matches the per-PR objects. Two pre-PR branches at the same `rev`, with delayed updates, both register, and moving one removes only its own `@<branch>` entry. A first registration that fails, followed by no client commit at all: after the transport recovers, the alarm's retry makes discovery converge. A delayed old update or tombstone never brings back a removed entry or an older one.
- **Recovery and migration with different findings:** the local record and the relay's carry visibly different findings. After recovery, and after a migration to an object that isn't empty, the relay's record and `rev` are unchanged, and the local findings survive both in the local archive and in the relay's `snapshot`.
- **Per decision:**
  - P(b): a different principal's `take` gets 423;
  - Q: a non-holder's `log` succeeds and its commit gets 423; line 1001 drops the oldest line and `logDropped` counts it; `logSince` returns only newer lines by `seq`, and with the clock frozen, append, read, append and read deliver every line once;
  - R(b): no security finding's text reaches `commit`;
  - 4: a pre-PR lifecycle on its branch key moves to its PR key: the branch object answers 410 to record and lease ops, a stale checkout follows the 410, a crash after each of the move's three steps, with the index update delayed, is finished by the next load: independent branch and PR clients start, and only the PR key's driver dispatches; the index ends with only the PR entry, and a fresh start over the tombstone leaves the old PR's object alone; a branch name with `/` round-trips through the URL, and a name git would refuse gets 404;
  - 5: a principal with no grant gets 403; after `grant` it gets through, after `revoke` it gets 403 on its next request; a non-admin's `grant` gets 403; a caller's own `x-relay-preset` or `x-relay-principal` header is replaced; every grant change is in the history with its actor.
- **The request count** for one scripted lifecycle, counted at the Miniflare boundary, to check section 12's table.
- **The repo's own gates:** `npm run check` (the plugin harness, the relay tests, both typechecks).

## Adam's decisions (2026-10-29)

| | Decision | Ruling | |
| --- | --- | --- | --- |
| 1 | Driver lease | 120 s (R74), fenced, bound to its holder's secret; a beat every 60 s | R100, as recommended |
| 2 | Retry identity | `lifecycleId:findingId:attempt`; `attempt` advances only on a re-file after an issue closed unfixed | R101, as recommended |
| 3 | Retention and migration | 20 archives; objects deleted 90 days after the PR ends; local records cross over on their next change, never pushed in bulk | R102, as recommended |
| 4 | Scope with wave 3 item 2 and #27 | **Pre-PR records too**, keyed `owner/repo@<branch>`, moved to `#<pr>` when the PR exists (section 1) | R103, **overrides** "post-PR only" |
| 5 | Grants | **Stored in the relay**: a `GrantStore` object edited by admin ops; admins stay a deploy variable (section 10) | R104, **overrides** `relay-grants.json` |
| P | A person taking over a live lease | (b) a `take` op within the same principal | R105, as recommended |
| Q | The run log under a lease | its own lease-free `log` list, **capped at 1000** with a dropped count (section 5) | R106, **overrides** the cap of 200 |
| R | Security findings in the shared store | (b) a reference only, while only Adam's identities hold grants | R107, as recommended |
| - | A development deploy, to measure real latency | Yes, as the build's last step, confirmed with Adam just before it runs; removed afterwards | R108 |
