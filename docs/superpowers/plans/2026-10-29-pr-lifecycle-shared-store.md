# The shared lifecycle store (#29 Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pr-lifecycle keeps each lifecycle record in one shared relay object per PR (and per branch before the PR exists), so two checkouts of the same PR never drive it at once or file a finding twice.

**Architecture:** The relay (`pr-lifecycle-relay/`, a Cloudflare Worker with Durable Objects) gains a `GrantStore`, branch keys with a move to the PR key, a lease-free log, a `RepoIndex` with an outbox, and retention. The plugin gains a `relay.ts` client, and `store.ts` chooses the relay or the local store inside each exported function. `round.ts` drives its owner checks and filings through the relay's lease and filing ledger.

**Tech Stack:** TypeScript 6.0.3 (no semicolons, single quotes); Cloudflare Workers and Durable Objects under Miniflare 4.20260730.0 (`node --test`); the Claude Code plugin harness (`claude plugin test`, `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md` (rulings R100–R108 in `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`).

## Global Constraints

- Hand style: no semicolons, single quotes, lines up to about 160 columns. **Never** run Prettier, `eslint --fix` or any whole-file formatter; edit surgically.
- `codex-gate/` is frozen: touch nothing in it.
- Never commit `pr-lifecycle/.claude-plugin/types/` (generated, gitignored). Never use a bare `npx tsc`.
- A slow plugin test carries `{ timeoutMs: 15_000 }`.
- Each task's gate: `npm run lint`, `npm run test`, `npm run test:relay`, `npm run typecheck:relay`, and `npm run typecheck` when the generated types exist. `npm run check` runs them all.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No model identifier anywhere else.
- Lease: `LEASE_MS` 120 000 ms (R74, R100). The relay backend beats every **60 000 ms**. The local backend keeps `BEAT_MS` 30 000 (ruling below).
- Secrets: two `crypto.randomUUID()` values joined, 72 characters (`MIN_SECRET` is 32). They are saved before the first call that sends them, under `relay-secret:<sessionId>` (lease) and `relay-filing-secret:<root>:<lifecycleId>` (filing).
- Relay call timeout: **5 000 ms** per call, then fallback (spec §8).
- `RELAY_LOG_CAP` 1000 lines per object, with `logDropped`. The local `LOG_CAP` stays 200, and a log line's text is cut to 300 characters on both backends.
- `ARCHIVE_CAP` 20. `WRITE_CAP` 100. The grant history is capped at 500. Retention is 90 days (`RETENTION_MS` 7 776 000 000).
- Filing key: `lifecycleId:findingId:attempt`, where `attempt` starts at 1.
- Grants: presets `read` and `operate`; one repo per grant (`owner/name`, lowercased); no wildcard. Admins come only from the `ADMINS` Worker variable, people only.
- Version: pr-lifecycle becomes **1.6.0**: `plugin.json`, its README version line and the root README table change together.

**Rulings made while planning** (they go in the SDD ledger as well):

- The local backend keeps `BEAT_MS` 30 s. R100's 60 s is the relay lease's beat, and changing the local beat would shift about a dozen existing tests that advance the clock by 30 s, for no gain.
- Credentials are environment variables only: `PR_GATE_RELAY_CLIENT_ID` and `PR_GATE_RELAY_CLIENT_SECRET` (an Access service token, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`), or `PR_GATE_RELAY_TOKEN` (a person's Access token, sent as `cf-access-token`). `userConfig` has no sensitive field to rely on. Access turning these into `Cf-Access-Jwt-Assertion` is exercised only by Task 12's deploy.
- The move to the PR key happens inside the store: a relay commit on a branch key whose record now carries `pr` performs the move. No call site changes for it. The record gains `pr` in `register.tsx` at `onOpened` (≈:820) and at adoption (≈:334), and on a resume that finds the PR.
- The mirror rule: every successful relay commit also writes the local key, with `relayRev` set to the new rev and the **full** record (security text included). Fallback starts from that mirror, and R(b) restores redacted findings from it.
- R(b) redaction: a finding with `isSecurity: true` is sent as `{ id, round, source, reviewer, severity, isSecurity: true, headSeen, status, title: '[security finding: text kept by the checkout that found it]', ref: 'local' }`. It carries no `detail`, `note`, `file`, `line`, `url` or real title. On load, a redacted finding takes its text from the local mirror only when the mirror's `lifecycleId` equals the remote record's and it holds a finding with the same `id`. Only the redacted fields come back (`title`, `detail`, `note`, `file`, `line`, `url`); everything else stays the relay's. Otherwise the placeholder stays (PR #51 review).
- `list` URL: `POST /v1/<owner>/<repo>` with `{ "op": "list" }`. `/v1/admin/...` routes match before owner/repo parsing.
- Index fault injection for tests: when the Worker binding `TEST_FAULTS` is `'1'`, the admin route `POST /v1/admin/index` takes `{ op: 'fault', repo, until }`, and that repo's `RepoIndex` answers 503 until then. With `TEST_FAULTS` unset (as in wrangler), the route answers 404.

## Wire shapes (every task uses these names)

The Worker routes are:

| Route | Object | Ops |
| --- | --- | --- |
| `POST /v1/<owner>/<repo>/<pr>` | `LifecycleObject` `owner/repo#<pr>` | record, lease, log, filing ops |
| `POST /v1/<owner>/<repo>/branch/<enc branch>` | `LifecycleObject` `owner/repo@<branch>` | the same ops, plus `moveTo` |
| `POST /v1/<owner>/<repo>` | `RepoIndex` `owner/repo` | `list` |
| `POST /v1/admin/grants` | `GrantStore` `grants` | `grants`, `grant`, `revoke` |
| `POST /v1/admin/index` (only when `TEST_FAULTS` is `'1'`) | `RepoIndex` | `fault` |

The Worker sets internal headers, replacing any of the same name the caller sent: `x-relay-principal` (JSON `Principal`), `x-relay-repo` (`owner/repo`, lowercased), `x-relay-preset` (`read`, `operate` or empty) and `x-relay-key` (`#<pr>` or `@<branch>`).

**Lifecycle ops** (body `{ op, secret?, ... }`). Unchanged ops keep the prototype's shapes.

| Op | Needs | Body | 200 answer | Refusals |
| --- | --- | --- | --- | --- |
| `read` | read | `{ logSince? }` (a `seq`) | `{ rev, record, lease, lastWrite, log, logDropped, logSeq }` | — |
| `commit` | operate + lease if live | `{ rev, record, archive?: { at, record }, from?: '@<branch>', isFresh? }` | `{ rev }` | 409 `{ rev, record }`, 423 `{ lease }`, 410 `{ movedTo, lifecycleId }` |
| `claim` | operate | `{ holder, secret }` | `{ lease }` | 423, 410 |
| `take` | operate, same principal as the live lease | `{ holder, secret }` | `{ lease }` (new token) | 423 for another principal, 410 |
| `beat` / `release` | operate + own lease | `{ secret }` | `{ lease }` / `{}` | 409 `{ lease }`, 410 |
| `moveTo` (branch only) | operate + own lease | `{ pr, secret }` | `{ rev }` | 409, 410, 404 on a PR key |
| `moveDone` (branch only) | operate | `{ lifecycleId }` | `{}` (again: `{}`) | 409 when not moved or the id differs, 404 on a PR key |
| `log` | operate | `{ at, kind, text, holder }` | `{ logDropped }` | — |
| `fileAdopt` | operate + own live lease | `{ key, result: { number, url }, secret }` (the lease secret) | `{ filing }` with `adoptedBy` | 423 without the lease, 409 when the claim is younger than `FILING_STALE_MS` or done with another result, 409 when there is no claim |
| `snapshot` | operate | `{ at, record, reason: 'fallback' \| 'migration' \| 'move' }` | `{}` | — |
| `archives` / `filing` / `fileClaim` / `fileDone` / `fileDelete` / `breakLease` | as prototyped | as prototyped | as prototyped | as prototyped |

`log` stores `{ seq, at, kind, text, principal, holder }`, with `text` cut to 300 characters; `seq` goes up by one per append and never goes back. `snapshot` appends `{ at, record, actor, reason }` to the archives. Neither bumps `rev`.

**Index entry:** `{ key, pr?, branch, phase, rev, updatedAt, lifecycleId }`. **Outbox entry:** `{ key, born, rev, entry } | { key, born, rev, removed: true }`. The index orders and removes by `key`, never by `pr`, and keeps the highest `(born, rev)` per key, compared `born` first. `born` is the time of the object's first write after it was empty, kept in its state until it is deleted.

**Tombstone:** `{ movedTo, lifecycleId, record? }`. `record` is there from `moveTo` until `moveDone`.

---

## Review Focus

1. **A commit that times out on the client but was applied by the relay.** `$.http.fetch` can't be cancelled, so the 5 s race drops the answer and the round falls back. On recovery, the relay's rev is `relayRev + 1`. That takes the "relay moved on" path: the relay's record is kept, the local one is snapshotted, and nothing is lost or overwritten. Test in Task 6.
2. **The relay answers 401, 403 or a body that isn't JSON mid-lifecycle** (a revoked grant, an expired token, a proxy error page). The round treats it as fallback, logs it once, and neither crashes nor stalls. Test in Task 5.
3. **Branch names that are legal in git but awkward in a URL:** `feat/a/b`, `fix-ü`, `a%2Fb` taken literally, `100%`. Each must round-trip to the same object, and a name git refuses gets 404. Test in Task 2.
4. **A plugin-store write of a secret fails.** The call that would carry it is never sent, and the record stays local. Test in Task 5.
5. **One person, two sessions on one machine.** A person's command in the second session takes the lease (`take`). A headless second session never does. The first session's next action-boundary beat is refused, and it stands down. Test in Task 8.

---

### Task 1: GrantStore, admin ops and the preset header (relay)

**Files:**
- Create: `pr-lifecycle-relay/src/grants.ts`
- Create: `pr-lifecycle-relay/test/harness.ts`: the Miniflare setup, `sign`, `person`, `service` and `call`, moved out of `relay.test.ts`, plus `grant(principal, repo, preset)` and `seed()`.
- Create: `pr-lifecycle-relay/test/grants.test.ts`
- Modify: `pr-lifecycle-relay/src/index.ts`, `src/auth.ts` (remove `grantsOf` and `presetOf` from env), `src/lifecycle.ts` (read the preset from the header), `src/types.ts` (Env: `GRANTS: DurableObjectNamespace`, remove the `GRANTS?: string` var), `wrangler.jsonc` (a `GRANTS` binding, migration `v2` with `new_sqlite_classes: ['GrantStore']`)
- Modify: `pr-lifecycle-relay/test/relay.test.ts`: it uses the harness and seeds the same grants through `grant` in `before`.

**Interfaces:**
- Produces: `export class GrantStore`, whose `fetch` takes `{ op: 'grants' | 'grant' | 'revoke' | 'presetOf', ... }`. `presetOf { principal, repo }` is internal: the Worker calls it, and it is not routed from outside. It answers `{ preset: 'read' | 'operate' | null }`.
- Produces: state `{ rev, grants: Grant[], history: { actor, op, at, rev, grant }[] }`, with history capped at 500.
- Produces: the Worker sets `x-relay-preset` on every object call. `LifecycleObject` reads the preset only from that header.
- Produces: `test/harness.ts` exports `start(bindings?)`, `stop()`, `call(token, body, path?, headers?)`, `person(email)`, `service(id)`, `sign(...)`, `grant(adminToken, principal, repo, preset)`, and the constants `ADAM`, `CODEX`, `READER`.

- [ ] **Step 1: Write the failing tests** in `grants.test.ts`:
  - `a principal with no grant gets 403`: `call(person('new@example.org'), { op: 'read' })` gives 403.
  - `after grant it gets through, after revoke it gets 403 on its next request`: Adam `grant`s `read` and then `read` gives 200; Adam `revoke`s and then `read` gives 403.
  - `grant of an existing pair changes its preset`: `read` becomes `operate`, `grants` lists one entry, and `claim` then gives 200.
  - `a non-admin's grant gets 403`: a person with operate on the repo is refused, and so is the service `CODEX` even though it is listed in `ADMINS`.
  - `a caller's own x-relay-preset and x-relay-principal are replaced`: READER sends `x-relay-preset: operate` and `x-relay-principal: {"id":"adam@example.org","isService":false}`, and `claim` still gives 403.
  - `every grant change is in the history with its actor`: after grant, grant and revoke, `grants` returns `history.length === 3`, each `actor === ADAM`, with rev 1, 2, 3.
  - `a grant names one lowercased repo; a wildcard or a malformed repo is 400`: `Owner/Repo` is stored as `owner/repo`; `*` and `owner` give 400.
  - `history keeps the last 500`: 501 grant writes leave `history.length === 500`, starting at rev 2.
- [ ] **Step 2: Run** `node --test pr-lifecycle-relay/test/grants.test.ts`. Expected: FAIL, because the route doesn't exist.
- [ ] **Step 3: Implement** `GrantStore` in `src/grants.ts` and the admin route in `index.ts`. The route matches `/v1/admin/grants` before owner/repo parsing, and `isAdmin` is checked in the Worker. For other calls, the Worker calls `presetOf` on `env.GRANTS.get(env.GRANTS.idFromName('grants'))`, with no cache. `LifecycleObject` drops its `presetOf(env, ...)` import and reads `x-relay-preset`.
- [ ] **Step 4: Run** `npm run test:relay && npm run typecheck:relay`. Expected: all relay tests PASS, the 17 existing ones included, now seeded through `grant`.
- [ ] **Step 5: Commit** with `feat(relay): grants stored in a GrantStore object, edited by admin ops; the Worker passes the preset (R104)`.

### Task 2: Branch keys, the move and the tombstone (relay)

**Files:**
- Modify: `pr-lifecycle-relay/src/index.ts` (the branch route and its validation), `src/lifecycle.ts` (`moveTo`, the tombstone, 410, `isFresh`, `from`)
- Create: `pr-lifecycle-relay/test/branch.test.ts`

**Interfaces:**
- Consumes: Task 1's harness and the preset header.
- Produces: `export const isBranchName = (name: string): boolean` in `index.ts`: 1–255 UTF-8 bytes, and no `..`, control characters, space, `~ ^ : ? * [ \`, `@{`, leading `-` or `/`, trailing `/`, `.` or `.lock`, or `//`.
- Produces: the object name `owner/repo@<branch>`, with owner and repo lowercased and the branch kept as is. `x-relay-key` is `@<branch>` or `#<pr>`.
- Produces: tombstone state, where `record` is `{ movedTo: number, lifecycleId: string, record?: unknown }` (`record` kept from `moveTo` until `moveDone`) and the state gains `movedTo?: number`.

- [ ] **Step 1: Write the failing tests** in `branch.test.ts`:
  - `a branch with / round-trips`: a commit at `/v1/owner/repo/branch/feat%2Fa%2Fb` is read back from the same URL, and not from `.../branch/feat` (that read gives `rev: 0`).
  - `awkward names round-trip`: `fix-%C3%BC` and `100%25` work, and `a%252Fb` reaches the branch `a%2Fb`, not `a/b`.
  - `a name git would refuse gets 404`: for each of `a..b`, `-x`, `x.lock`, `x/`, `a%20b`, `a~b`, `a%5Cb`, `a@%7Bb`, and an empty name.
  - `owner and repo are case-folded, the branch is not`: `Owner/Repo/branch/Feat` and `owner/repo/branch/Feat` are one object; `.../branch/feat` is another.
  - `moveTo needs the lease, freezes the record and releases the lease`: claim, commit `{ lifecycleId: 'L1', n: 1 }`, `moveTo { pr: 7 }` gives 200; `read` gives `record: { movedTo: 7, lifecycleId: 'L1', record: { lifecycleId: 'L1', n: 1 } }`, `lease: null`, and `rev` bumped.
  - `moveDone drops the copy and is idempotent`: `moveDone { lifecycleId: 'L1' }` gives 200 twice, and `read` then gives `record: { movedTo: 7, lifecycleId: 'L1' }`; with `'L9'` it gives 409; it needs operate, not the lease.
  - `record and lease ops on a tombstone answer 410`: `commit`, `claim`, `beat`, `take`, `release` and `moveTo` each give 410 `{ movedTo: 7, lifecycleId: 'L1' }`.
  - `archives, filing, log, snapshot and moveDone still work on a tombstone`: each gives 200.
  - `a frozen branch takes no beat`: the old holder's `beat` right after `moveTo` gives 410, so no source boundary passes.
  - `a fresh start over a tombstone`: `commit { rev, record: { lifecycleId: 'L2' }, isFresh: true }` gives 200; the PR 7 object's record is unchanged.
  - `isFresh with the tombstone's own lifecycleId is 410`: a fresh start must be a new lifecycle.
  - `moveTo and moveDone on a PR key are 404`.
  - `commit with from on a non-empty PR object is 409 with its record`: the client reads `lifecycleId` from that answer (spec §1 step 1).
- [ ] **Step 2: Run** `node --test pr-lifecycle-relay/test/branch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The Worker decodes the segment with `decodeURIComponent` once, validates it with `isBranchName`, and answers 404 when the decode throws. `LifecycleObject` reads `x-relay-key` to know whether it is a branch object.
- [ ] **Step 4: Run** `npm run test:relay && npm run typecheck:relay`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(relay): pre-PR records keyed by branch, frozen and moved to the PR key with a tombstone (R103)`.

### Task 3: `take`, the lease-free log and `snapshot` (relay)

**Files:**
- Modify: `pr-lifecycle-relay/src/lifecycle.ts`
- Create: `pr-lifecycle-relay/test/log.test.ts`

**Interfaces:**
- Produces: the ops `take`, `log`, `snapshot` and `fileAdopt` with the wire shapes above, `export const RELAY_LOG_CAP = 1000`, and `FILING_STALE_MS` 1 800 000 (env `FILING_STALE_MS` overrides it; the harness sets `'300'`). `Filing` gains `adoptedBy?: string`.
- Produces: the log is stored under its own storage key `log` as `{ lines: LogLine[], dropped: number, seq: number }`. `read` returns `log` (lines with `seq` above `logSince` when it is given), `logDropped` and `logSeq`.

- [ ] **Step 1: Write the failing tests:**
  - `take by the same principal issues a new token and fences out the old holder`: Adam claims as `s1`, Adam takes as `s2`, the token rises, and `s1`'s `beat` and `commit` give 409 and 423.
  - `take by a different principal gets 423`: CODEX can't take Adam's live lease.
  - `take of a lapsed or empty lease acts as claim`.
  - `a non-holder's log succeeds and its commit gets 423`: CODEX logs under Adam's lease and gets 200, then commits and gets 423.
  - `log needs operate`: READER's `log` gives 403.
  - `log does not bump rev`.
  - `line 1001 drops the oldest line and logDropped counts it`: 1001 lines leave the first kept line at `at: 2` and `logDropped: 1`. This is a slow test: batch with `Promise.all` in chunks of 50.
  - `logSince returns only lines after the cursor`: lines with seq 1, 2 and 3 and `logSince: 2` return only seq 3.
  - `a frozen clock loses no line`: with every line at the same `at`, append A, read (cursor = `logSeq`), append B, read from the cursor: B comes back once and A doesn't come back. After 1001 lines, `logSeq` is 1001 and `logDropped` is 1.
  - `each line records the principal and the holder`.
  - `fileAdopt finishes a stale claim under the lease, without impersonating`: CODEX claims a filing with secret A; after `FILING_STALE_MS`, Adam (holding the lease, another secret) adopts with `{ number: 5, url }` and gets 200; `filing` gives `state: 'done'`, `actor: CODEX`, `adoptedBy: ADAM`; the write history names `fileAdopt` by ADAM.
  - `fileAdopt is refused without the live lease (423), on a claim younger than FILING_STALE_MS (409), on a missing claim (409), and with another result on a done filing (409)`; with the same result it gives 200.
  - `snapshot appends to archives without touching record or rev`: the archive's last entry is `{ reason: 'fallback', actor: ADAM }`, and `ARCHIVE_CAP` still applies.
- [ ] **Step 2: Run** `node --test pr-lifecycle-relay/test/log.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three ops. The log is written with a single `storage.put({ log })` and never inside `state`.
- [ ] **Step 4: Run** `npm run test:relay`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(relay): take within one principal, a lease-free log capped at 1000, snapshot, and fileAdopt (R101, R105, R106)`.

### Task 4: RepoIndex, the outbox and its alarm, `list`, retention (relay)

**Files:**
- Create: `pr-lifecycle-relay/src/repo-index.ts`
- Create: `pr-lifecycle-relay/test/index.test.ts`
- Modify: `pr-lifecycle-relay/src/lifecycle.ts` (the outbox written in the same `put` as the commit, `alarm()`), `src/index.ts` (the `list` route and the test-only fault route), `src/types.ts` (Env `REPO_INDEX`, `RETENTION_MS?`, `INDEX_RETRY_MS?`, `TEST_FAULTS?`; storage `setAlarm`, `getAlarm`, `deleteAlarm`, `deleteAll`, and `get`/`put` of several keys), `wrangler.jsonc` (a `REPO_INDEX` binding, `RepoIndex` added to migration `v2`), `test/harness.ts` (new bindings: `INDEX_RETRY_MS: '50'`, `RETENTION_MS: '400'`, `TEST_FAULTS: '1'`)

**Interfaces:**
- Produces: `RepoIndex` ops: `update { key, born, rev, entry | removed }`, where an update whose `(born, rev)` is not above the held one is ignored and tombstones are kept; `list`, which answers `{ entries: IndexEntry[] }` without tombstones; and `fault { until }`.
- Produces: each record commit, `moveTo` and archive commit writes an outbox entry. A record with `phase: 'archived'` or a tombstone writes `removed`. A non-empty outbox sets an alarm. The alarm sends the outbox to `env.REPO_INDEX.idFromName(repo)` and clears what was acknowledged. On failure it retries with doubling backoff from `INDEX_RETRY_MS` (default 1000), capped at 5 minutes.
- Produces: retention. Once `RETENTION_MS` has passed since the PR's archive commit (a PR key) or since the last write (a branch key), the alarm delivers a removal at `(born, rev + 1)` to the index, then deletes the object (`deleteAll`) once the index has acknowledged it.

- [ ] **Step 1: Write the failing tests.** Alarms run in real time under Miniflare, so each test polls `list` every 25 ms for up to 3 s.
  - `list through the index matches the objects`: commits to `#7`, `#8` and `@feat/x` list three entries with their `rev` and `lifecycleId`.
  - `a failed first registration converges with no further commit`: set `fault` until now + 300 ms, commit once, and the entry appears after the fault ends.
  - `a delayed old update never brings back a removed or older entry`: send `update` rev 3, then `removed` at rev 4, then the old `update` rev 3 again; the entry stays gone.
  - `the move leaves only the PR entry`: after `moveTo` and the commit to `#7`, `list` shows `#7` and no `@feat/x`.
  - `two branches at the same rev both register, and moving one removes only its own entry`: commit once each to `@a` and `@b` (both rev 1), fault the index until now + 300 ms so updates arrive late, then move `@a` to `#9`; `list` ends with `@b` and `#9`.
  - `list needs read`: a principal with no grant gets 403.
  - `an archived PR object is deleted after RETENTION_MS`: after an archive commit and a wait above 400 ms, `read` gives `rev: 0`.
  - `a branch object is deleted RETENTION_MS after its last write`.
  - `a recreated branch is found at once, and an update from before its deletion can't replace it`: commit `@x` up to rev 8, wait for retention, then commit `@x` again (rev 1, lifecycle L2). `list` shows `@x` at rev 1 with L2. A delayed `update { key: '@x', born: <old>, rev: 8 }` sent straight to the index leaves it unchanged.
- [ ] **Step 2: Run** `node --test pr-lifecycle-relay/test/index.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:relay && npm run typecheck:relay`. Expected: PASS. Run it three times, because alarm timing is real.
- [ ] **Step 5: Commit** with `feat(relay): a RepoIndex fed by an outbox and alarm, list, and 90-day retention`.

### Task 5: The relay client, its config, credentials and secrets (plugin)

**Files:**
- Create: `pr-lifecycle/hooks/relay.ts`
- Create: `pr-lifecycle/tests/relay-fake.ts`: an in-process relay with the same ops and refusals, which a test installs with `on('http.fetch', ...)`.
- Create: `pr-lifecycle/tests/contract.ts`: a transcript `{ name, steps: { as, path, body, status, match }[] }[]`.
- Create: `pr-lifecycle/tests/relay.test.ts`
- Create: `pr-lifecycle-relay/test/contract.test.ts`: replays `../../pr-lifecycle/tests/contract.ts` against Miniflare.
- Modify: `pr-lifecycle/hooks/github.ts` (`readRoster` reads `sharedStore { url, aud }`; a URL that isn't https is ignored), `pr-lifecycle/types/index.d.ts` (`Roster.sharedStore?`)

**Interfaces:**
- Produces, in `relay.ts` (all function declarations taking `$`):
  - `relayOf($, root, base): Promise<Relay | { local: string }>`, where `Relay = { url, aud, headers }`. It reads `sharedStore` from the base's `.github/pr-gate.json` (through the existing `baseFileOf`/`readRoster` path) and the credentials from `$.env.get('PR_GATE_RELAY_CLIENT_ID')`, `'PR_GATE_RELAY_CLIENT_SECRET'` and `'PR_GATE_RELAY_TOKEN'`. `local` says why it is local.
  - `keyPath(slug, key): string`, giving `/v1/<owner>/<repo>/<pr>` or `/v1/<owner>/<repo>/branch/${encodeURIComponent(branch)}`.
  - `relayCall($, relay, path, body): Promise<RelayAnswer>`, where `RelayAnswer = { status: number; json: Record<string, unknown> } | { down: string }`. It races `$.http.fetch` against `$.clock.after(5_000)`. A network error, a 5xx, 401, 403, a timeout or a body that isn't JSON is `down`.
  - `leaseSecret($): Promise<string | undefined>` and `filingSecret($, root, lifecycleId): Promise<string | undefined>`. Each makes the secret once, saves it before returning, and returns undefined when the save fails.
- Produces, in `relay-fake.ts`: `fakeRelay(on, opts?): FakeRelay`, with `FakeRelay = { objects, index, calls: { path, body }[], down: boolean, delayNext(ms), principalOf(headers) }`. It answers like the relay for every op in the wire table, including 410, 409, 423 and `logSince`.

- [ ] **Step 1: Write the contract transcript** in `tests/contract.ts`. Cover these cases, each step with its expected status and the fields it matches:
  - claim, commit, read, beat and release;
  - a stale commit (409) and a commit under another holder's lease (423);
  - take, by the same principal and by a different one;
  - log and logSince (by `seq`);
  - snapshot;
  - moveTo, then 410, moveDone, then a fresh start;
  - fileClaim, fileDone and filing;
  - list.
- [ ] **Step 2: Write `contract.test.ts`** (relay side), which replays every case against Miniflare. Run `npm run test:relay`. Expected: PASS, because Tasks 1–4 built the relay. A failure here is a relay bug or a transcript bug, to be fixed before going on.
- [ ] **Step 3: Write the failing plugin tests** in `tests/relay.test.ts`:
  - `the fake relay passes the contract`: replay `contract.ts` through `relayCall` against `fakeRelay`.
  - `no sharedStore or no credential stays local and says why`: `relayOf` answers `{ local: 'no sharedStore in .github/pr-gate.json' }` or `{ local: 'no relay credential' }`.
  - `sharedStore is read from the base, never the HEAD`: `w.git.headRoster` carries `sharedStore` and the base doesn't, so the answer is local.
  - `a service token is sent as CF-Access-Client-Id and -Secret, a person token as cf-access-token`.
  - `a 5 s timeout is down`: `delayNext(6_000)`, advance the clock 5 000, and the answer is `{ down: 'timeout' }`.
  - `401, 403, 502 and a body that isn't JSON are down` (Review Focus 2).
  - `a secret is saved before the first call that sends it, and a failed save sends nothing`: make `store.set` of `relay-secret:` fail, and `fake.calls` stays empty (Review Focus 4).
  - `a branch with / or % encodes as one segment`.
- [ ] **Step 4: Run** `npm run test`. Expected: the new tests FAIL.
- [ ] **Step 5: Implement** `relay.ts`, `relay-fake.ts` and the `readRoster` change.
- [ ] **Step 6: Run** `npm run lint && npm run test && npm run validate`. Expected: PASS. `validate` lists the three env names.
- [ ] **Step 7: Commit** with `feat(pr-lifecycle): a relay client, read from the base's sharedStore with env credentials; a fake relay held to the relay's contract`.

### Task 6: The relay backend in `store.ts`: transact, fallback, recovery, migration, redaction (plugin)

**Files:**
- Modify: `pr-lifecycle/hooks/store.ts`
- Modify: `pr-lifecycle/types/index.d.ts`: `LifecycleRecord.relayRev?: number`; `Finding.ref?: 'local'`.
- Modify: the `updateRecord`/`upsertRecord` call sites in `pr-lifecycle/hooks/round.ts` and `hooks/register.tsx` that pass `{ isPure: true }` (Step 3).
- Create: `pr-lifecycle/tests/shared-store.test.ts`

**Interfaces:**
- Consumes: Task 5's `relayOf`, `relayCall`, `keyPath`, `leaseSecret` and `fakeRelay`.
- Produces:
  - `export class StaleRecord extends Error { rev: number; record: unknown }`;
  - `updateRecord($, root, branch, change, opts?: { isPure?: boolean })` and `upsertRecord(..., opts?)`, with the same signatures plus `opts`;
  - `export const redact = (rec: LifecycleRecord): LifecycleRecord` and `export const restore = (remote: LifecycleRecord, local: LifecycleRecord | undefined): LifecycleRecord`;
  - the mirror rule (above).
- The behaviour, per spec §3 and §8:
  - `transact` keeps the in-process lock. `tx.load` sends `read` and keeps `rev`. `tx.save` and `tx.archive` are buffered, and the last save is sent as one `commit { rev, record: redact(rec), archive? }` after `work` returns.
  - On 409 or 423: a pure `updateRecord`/`upsertRecord` retries once against the returned record. Anything else throws `StaleRecord`. `saveRecord` throws.
  - `down` means fallback: the round works on the local mirror. The run log says once per lifecycle why (kind `session`), and `relayRev` is kept.
  - Recovery, on the first call that succeeds again. The relay rev equals `relayRev`: commit the local record at that rev. Otherwise the relay's record wins, and the local one is archived locally (`writeArchive`) and then `snapshot { reason: 'fallback' }`, and the run log says so.
  - Migration: a local record without `relayRev` in a repo that opts in, at its first change. At `rev: 0` it is committed. Otherwise the relay's record is adopted, and the local one is archived locally and `snapshot { reason: 'migration' }`.
  - A record without `lifecycleId` gets `newLifecycleId()` before its first relay commit.
  - The slug comes from `rec.slug`. When it is unset, the store resolves `slugOf(git remote get-url origin)` and saves it on the record. With no slug, the record stays local.

- [ ] **Step 1: Write the failing tests** in `shared-store.test.ts`, each with `fakeRelay` and a `sharedStore` roster:
  - `a pure update retries once on 409, against the returned record`: a second writer bumps rev between read and commit; the change runs twice and the commit lands.
  - `a transact whose work ran git is not retried: it throws StaleRecord`.
  - `the last of two saves is the one committed`.
  - `an archive with a save is one commit carrying { at, record } with phase archived`.
  - `every relay commit mirrors the full record locally with relayRev`.
  - `relay down mid-round: the round goes on locally and the log says so once`.
  - `recovery when nobody else wrote: the local changes are committed at relayRev`.
  - `recovery when the relay moved on: relay record and rev unchanged, local findings kept in the local archive and in a snapshot`: the two records carry visibly different findings.
  - `a commit that timed out but was applied: recovery keeps the relay's record and snapshots the local one, losing nothing` (Review Focus 1).
  - `migration into an empty object pushes the local record`.
  - `migration into a non-empty object adopts the relay's, archives and snapshots the local one`.
  - `no security finding's text reaches commit`: walk every `fake.calls` body with `op: 'commit'` or `'snapshot'`; no security finding's title, detail, note, file or url appears.
  - `a redacted finding is restored from the local mirror on load`, and `one found by another checkout shows the placeholder title`.
  - `restore needs the same lifecycle`: a local mirror of lifecycle L1 with security finding G1-1, and a remote L2 record whose redacted G1-1 is another finding: `restore` keeps the placeholder and none of L1's text. With both at L1, the text comes back, but the remote `status` wins.
  - `a repo that does not opt in behaves exactly as before`: no `http.fetch` calls at all.
- [ ] **Step 2: Run** `npm run test`. Expected: FAIL.
- [ ] **Step 3: Classify the call sites.** Run `grep -n "updateRecord(\|upsertRecord(" pr-lifecycle/hooks/round.ts pr-lifecycle/hooks/register.tsx`. A site passes `{ isPure: true }` only when its `change` uses nothing from `$` and runs no git, gh, agent or filing, which is a plain object transform. List each site with its verdict in the task report.
- [ ] **Step 4: Implement.** Keep the local paths byte-for-byte when `relayOf` answers `local`.
- [ ] **Step 5: Run** `npm run lint && npm run test && npm run typecheck`. Expected: PASS, all 713 existing tests included.
- [ ] **Step 6: Commit** with `feat(pr-lifecycle): records on the relay through transact, with fallback, recovery, migration and redacted security text (R102, R107)`.

### Task 7: The move, `logEvent` through `log`, `liveRecords` and archives from the relay (plugin)

**Files:**
- Modify: `pr-lifecycle/hooks/store.ts`
- Create: `pr-lifecycle/tests/shared-move.test.ts`

**Interfaces:**
- Consumes: Task 6's backend.
- Produces:
  - `logEvent` sends `log { at, kind, text, holder: sessionId }` on the relay backend (no lease, no rev).
  - `export async function relayLog($, root, branch): Promise<{ lines: LogEntry[]; dropped: number; movedFrom?: { lines: LogEntry[]; dropped: number } }>` for `/pr-gate log`. A moved lifecycle shows the branch log, then the PR log.
  - `liveRecords($, root)` gives the index's entries (`list`), each read from its object, plus local records of a repo not on the relay. A branch entry is dropped when a PR entry carries its `lifecycleId`.
  - `latestArchive` reads `archives` and returns the newest.
- The move (spec §1), run by the store when a commit on a branch key saves a record with `pr` set:
  1. `moveTo { pr }` on the branch key, which freezes it with the record kept in the tombstone.
  2. `claim` the PR key, then `commit { rev: 0, record, from: '@<branch>' }`. On 409, the same `lifecycleId` carries on, and another id keeps the record by `snapshot { reason: 'move' }`.
  3. `moveDone { lifecycleId }` on the branch key.
  4. From then on the record's key is `#<pr>`.
  On load, a 410 or a tombstone whose `lifecycleId` matches is followed to the PR key. A tombstone that still carries `record` gets steps 2 and 3 run first, from that record. A tombstone whose id doesn't match means standing down.

- [ ] **Step 1: Write the failing tests:**
  - `a pre-PR record lives on the branch key and moves to the PR key on onOpened`: the fake shows the tombstone on `@feat/x` and the record on `#7`.
  - `a stale checkout still driving the branch key follows the 410`.
  - `a crash after each move step is finished by the next load, and only the PR driver dispatches`: for each of the three steps, the fake drops every later step once and holds the index update back; then a branch-key client and a PR-key client each start a round, and only the PR-key one passes a boundary or dispatches.
  - `the index ends with only the PR entry`.
  - `a fresh start over the tombstone leaves the old PR's object alone`.
  - `a non-holder's logEvent lands while its commit would get 423`.
  - `the 1001st line drops the oldest and /pr-gate log says how many earlier lines are gone`.
  - `liveRecords through the index matches the per-PR objects`.
  - `latestArchive reads the relay's newest archive`.
- [ ] **Step 2: Run** `npm run test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm run test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(pr-lifecycle): a pre-PR record moves from its branch key to its PR key; the run log, discovery and archives come from the relay (R103, R106)`.

### Task 8: The lease in `round.ts`: claim, beat, take, action boundaries, stand-down (plugin)

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (`claimRecord` ≈:414, `isOwnedElsewhere` ≈:428, `beat` ≈:436, `isStillMine` ≈:443, `standDown` ≈:450, and the action-boundary sites), `pr-lifecycle/hooks/store.ts` (`ownerOf`/`setOwner` on the relay backend use `claim`, `take` and `read`)
- Create: `pr-lifecycle/tests/lease.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces:
  - `export async function boundary($, run): Promise<boolean>`, the action-boundary beat. The local backend answers `isStillMine`. The relay backend sends `beat` and is true only on a 200. A 409, 423 or 410 empties the lease cache and stands down.
  - A module lease cache `{ key, holder, token, until } | undefined`. `isOwnedElsewhere` answers from it while `until > now` and this session is the holder. Otherwise it sends a `read`.
  - `RELAY_BEAT_MS = 60_000` for the relay backend.
  - `claimRecord`: interactive uses `take` and falls back to `claim`; headless uses `claim` only. A 423 means false. `release` happens at the end of a run.
- Call `boundary` before each of these:
  - an agent turn (`deliver` ≈:493, `tellAgent` ≈:559);
  - `spawn` (≈:1411);
  - a git push;
  - every gh write: a reply, a review request, a label, a merge (find them with `grep -n "'gh', 'api'.*POST\|'gh', 'pr', '\(merge\|edit\|comment\)'\|'--method'" pr-lifecycle/hooks/round.ts`);
  - each filing POST (≈:3823, ≈:4190).
  List each site in the report.

- [ ] **Step 1: Write the failing tests:**
  - `the relay holder beats every 60 s, and its ownership checks make no network read while the lease holds`: count `fake.calls` of `read`.
  - `a take right after the old driver's beat: the old driver's next boundary gets 423, it stands down, and nothing is dispatched` (spec §14).
  - `a headless second session never takes a live lease; an interactive one by the same principal does` (Review Focus 5).
  - `a different principal's take gets 423 and the person is told who holds it until when`.
  - `a takeover after a lapse fences out the old holder's commit`.
  - `standDown logs through log, not a commit`.
  - `the local backend is unchanged`: the existing owner tests pass as they are.
- [ ] **Step 2: Run** `npm run test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm run test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(pr-lifecycle): the driver holds the relay's lease, beats at each action boundary, and a person takes over within one principal (R100, R105)`.

### Task 9: The filing ledger in `fileOnce` (plugin)

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (`fileOnce` ≈:3685, `fileIssues` ≈:3616, `checkIssuesAfterMerge` ≈:3991 when it re-files)
- Create: `pr-lifecycle/tests/filing-ledger.test.ts`

**Interfaces:**
- Consumes: `relayCall`, `filingSecret`, `boundary`.
- Produces: the spec §7 order. First comes the exact-mark search, with adoption by the ledger's state (unclaimed, mine, another's, lost secret, done). Then `fileClaim` with key `${lifecycleId}:${findingId}:${attempt}`. Then the POST (after `boundary`), then `fileDone { number, url }`. `attempt` advances only when the same finding holds the merge again after its issue was closed, and it is kept on the finding as `fileAttempt?: number`. With several marked issues after a fallback, the lowest-numbered one is adopted and the others are named in the run log, never closed.

- [ ] **Step 1: Write the failing tests** (spec §14, "Crash after a POST"):
  - `a crash after the POST: a new session in the same checkout sends no second POST and leaves the ledger done`.
  - `the same restart from another checkout leaves it claimed, with no second POST`.
  - `with the plugin store lost too, the lease holder adopts the marked issue with fileAdopt once the claim is stale: no second POST, no admin, the ledger ends done with adoptedBy`.
  - `a stale claim with no marked issue is not adopted and waits for an admin's fileDelete`.
  - `another checkout's live claim: no POST; read filing again on the next tick`.
  - `a claim older than stepTimeoutMinutes shows as stuck`.
  - `two checkouts that both filed in fallback: on recovery the lowest-numbered issue is adopted and the other is reported, not closed`.
  - `attempt advances only after the earlier issue closed with the finding still holding`.
- [ ] **Step 2: Run** `npm run test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm run test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(pr-lifecycle): filing goes through the relay's ledger, so a finding is never filed twice (R101)`.

### Task 10: `/pr-gate log` from the relay (plugin)

**Files:**
- Modify: `pr-lifecycle/hooks/register.tsx` (the `log` subcommand, R78)
- Modify: `pr-lifecycle/tests/round.test.ts` or create `tests/log-command.test.ts`

**Interfaces:**
- Consumes: `relayLog` (Task 7), and the `filing` reads for stuck claims.
- Produces the output:
  - `N earlier lines dropped` when `dropped > 0`;
  - for a moved lifecycle, a `branch <name>` section, then a `PR #<n>` section;
  - each line's principal and short session id;
  - a `stuck filings` section listing claims older than `stepTimeoutMinutes` with no `fileDone`, each with its key and claimant, and the hint `the driver adopts it once its issue is found; otherwise an admin's fileDelete frees it`.

- [ ] **Step 1: Write the failing tests** for each of those output parts, plus `a repo not on the relay prints as before`.
- [ ] **Step 2: Run** `npm run test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm run test`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(pr-lifecycle): /pr-gate log reads the relay's log, across a move, and lists stuck filings`.

### Task 11: Two-controller proofs and the request count

**Files:**
- Create: `pr-lifecycle/tests/two-controllers.test.ts`
- Create: `pr-lifecycle-relay/test/request-count.test.ts`

**Interfaces:**
- Consumes: everything above. The two controllers are two `world`s sharing one `fakeRelay` and one fake GitHub: two checkout roots, two session ids. Write a small `twoWorlds(on)` helper in the test file if `world` can't host two sessions. If neither works, run them in sequence against the shared fake, interleaving by clock advances, and say so in the report.

- [ ] **Step 1: Write the tests** (spec §14):
  - `no new dispatch after a takeover; an acknowledged action may finish, its commit is refused, its filing goes through the ledger`;
  - `the other stands down`;
  - `a takeover after a lapse fences out the old holder's commit`;
  - `neither files a finding twice`;
  - `a stale startGate commit (409) is not retried and the next tick recovers`.
- [ ] **Step 2: Write `request-count.test.ts`**, which runs one scripted lifecycle-hour against Miniflare: claim, 60 beats at 60 s simulated by direct calls, 10 commits, 20 log lines and 3 filings. Count requests at the Miniflare boundary (Worker requests, and Durable Object requests through a counter the harness wraps around the bindings). Assert DO requests ≈ 2 × Worker requests (±10 %), and print the table for the spec §12 note.
- [ ] **Step 3: Run** `npm run check`. Expected: PASS.
- [ ] **Step 4: Commit** with `test: two controllers on one PR through the relay, and the request count per lifecycle-hour`.

### Task 12: Docs and version 1.6.0

**Files:**
- Modify:
  - `pr-lifecycle/.claude-plugin/plugin.json` (`"version": "1.6.0"`);
  - `pr-lifecycle/README.md` (the version line, plus the shared store: opting in, the env names, local fallback);
  - `README.md` (the table row);
  - `pr-lifecycle-relay/README.md` (the routes, ops, bindings, `ADMINS`, seeding grants, and the test-only fault route);
  - `CLAUDE.md` ("Current state": 1.6.0, the relay's role, test counts, R100–R108);
  - `ROADMAP.md` (#29 Part B built, not yet deployed);
  - the spec §12, with the measured request count from Task 11.

- [ ] **Step 1: Update the docs.** Run `npm run test` and `npm run test:relay` and copy the actual counts into `CLAUDE.md`.
- [ ] **Step 2: Run** `npm run check`. Expected: PASS.
- [ ] **Step 3: Commit** with `docs: pr-lifecycle 1.6.0, the shared store (#29 Part B)`.

### Task 13: Development deploy and latency (R108). **STOP and confirm with Adam first.**

This task changes Adam's Cloudflare account. The controller does **not** dispatch it. The controller asks Adam, in one message, for the go-ahead, the account, and the Access team domain. Only on his yes:

- [x] **Step 1:** Deploy the Worker as `pr-lifecycle-relay-dev` with wrangler, with `ADMINS` set to Adam's email. Create one Access application and one service token.
- [x] **Step 2:** Seed one grant (`operate` on this repo) for the service token.
- [x] **Step 3:** Measure 50 `read` and 50 `commit` round trips from this machine, giving p50 and p95. Measure the local baseline (in-process lock plus plugin-store write) the same way.
- [x] **Step 4:** Write the numbers into spec §12's latency table and commit.
- [x] **Step 5:** Tear down the Worker, the Access application and the service token, and confirm each is gone.
