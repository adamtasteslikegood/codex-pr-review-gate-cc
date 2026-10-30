# SDD ledger — plan: docs/superpowers/plans/2026-10-29-pr-lifecycle-shared-store.md

Spec: docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md (rulings R100–R108).
Branch: docs/wave2b, restarted from main 7d717cd (PR #51 merged). Adam approved the plan 2026-10-29, SDD with per-task review.

## Planning rulings (from the plan)

- Ruling: local backend keeps BEAT_MS 30 s; the relay lease beats every 60 s — R100's 60 s is the relay's beat; changing local shifts ~12 tests — cost if wrong: one constant.
- Ruling: relay credentials are env vars only (PR_GATE_RELAY_CLIENT_ID/_SECRET or PR_GATE_RELAY_TOKEN) — userConfig has no sensitive field — cost if wrong: a config surface added later.
- Ruling: the branch→PR move happens inside the store on a commit whose record carries `pr` — no call-site changes — cost if wrong: move logic relocated.
- Ruling: every relay commit mirrors the full record locally with relayRev — fallback and R(b) restore need it — cost if wrong: local disk churn.
- Ruling: R(b) redaction shape and same-lifecycle restore as in the plan — PR #51 review — cost if wrong: security text shown placeholder-only more often.
- Ruling: `list` is POST /v1/<owner>/<repo> {op:'list'}; /v1/admin/... matched first — cost if wrong: one route.
- Ruling: TEST_FAULTS='1' enables POST /v1/admin/index {op:'fault'}; unset → 404 — cost if wrong: a test-only route in prod code, gated off.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
| --- | --- | --- |
| T1 ↔ T2–T4 | T1 harness `start/call/grant/person/service`, x-relay-preset | consistent |
| T1 ↔ existing relay.test.ts | T1 Step 4 says "the 17 existing ones" | main has 18 (fileAdopt test added in PR #51). Ruling below. |
| T3 ↔ main | T3 produces `fileAdopt`, FILING_STALE_MS, `adoptedBy` | already on main (8c1f048) with a relay test. Ruling below. |
| T2 ↔ T4 | tombstone / moveTo write `removed` outbox entries | consistent (T4 consumes T2's tombstone) |
| T4 ↔ T1 | T4 adds bindings to T1's harness | consistent, T4 edits harness |
| T5 ↔ T1–T4 | contract replays against Miniflare; fake mirrors wire table | consistent |
| T6 ↔ T5 | relayOf, relayCall, keyPath, leaseSecret, fakeRelay | consistent |
| T7 ↔ T6, T2 | move steps use moveTo/claim/commit from/moveDone | consistent |
| T7 ↔ T10 | T7 test "/pr-gate log says how many earlier lines are gone" vs T10 owns the command | overlap. Ruling below. |
| T8 ↔ T5–T7 | boundary(), lease cache, take/claim | consistent |
| T9 ↔ T3, T8 | fileClaim/fileDone/fileAdopt, boundary | consistent |
| T10 ↔ T7 | relayLog | consistent |
| T11 ↔ all | twoWorlds, request count | consistent |
| Global ↔ T13 | Global says Access exercised "only by Task 12's deploy" | deploy is Task 13; typo, no effect |
| each task self-consistency | tests vs code vs files | T1–T13 consistent apart from the rows above |

- Ruling: T1's Step 4 expects every existing relay test to pass (18 now, not 17) — main moved on — cost if wrong: none.
- Ruling: T3 does not rebuild fileAdopt; the existing op and its relay.test.ts test stay. T3 adds only the fileAdopt cases the plan lists that are not already covered (young claim 409, missing claim 409, same-result 200, other-result 409, no-lease 423) to log.test.ts, and the harness carries FILING_STALE_MS '300' — fileAdopt landed in PR #51 — cost if wrong: duplicated assertions.
- Ruling: T7's "/pr-gate log says how many earlier lines are gone" is tested at the relayLog level (dropped count); T10 owns the command's output — avoids two tasks editing register.tsx's log subcommand — cost if wrong: one test moved.
- Ruling: open issues #50 (G2-6), #52 (G2-4), #53 (G2-5) need no plan change: #53 is T4 (outbox, alarm retry, zero-further-commit test); #52 is T3's snapshot op plus T6's recovery/migration tests with distinct findings; #50 is T8 (lease cache emptied on 409/423/410, boundary beat, take-after-beat test). The PR body names them to close — cost if wrong: an issue left open after merge.

## Tasks
Task 1: complete (commits eadd80e..ae16a18, review clean)
Task 1: minor (deferred): header-replacement test doesn't isolate x-relay-principal (forge ADAM + breakLease → 403 would)
Task 1: minor (deferred): /v1/admin/* shadows a repo admin/grants or admin/index — Ruling: Task 4 (which adds /v1/<owner>/<repo> list) treats owner `admin` as reserved — cost if wrong: a real GitHub owner named admin can't use the relay
Task 1: minor (deferred): grant-path history tests use relative revs, not literal 1,2,3
Task 1: minor (deferred): a thrown GrantStore fetch is an unmapped 500, a non-2xx presetOf a 502 (fails closed)
Task 1: minor (deferred): re-granting the same preset writes rev + history
Task 1: minor (deferred): relay README still describes the GRANTS env var (Task 12 updates docs)
Task 2: review — Important: (1) fresh-start test reads PR 41 not PR 7; (2) isFresh over a tombstone still carrying `record` discards the only copy
Task 2: Ruling: the relay refuses isFresh with 409 { error, movedTo, lifecycleId } while the tombstone still carries `record` (moveDone not yet run); the client finishes steps 2–3 first (Task 7 already does so on load) — spec §1 says a frozen record is never lost — cost if wrong: a fresh start waits one recovery step
Task 2: Ruling: tighten isBranchName to also refuse a bare `@`, a component starting with `.`, and a component ending `.lock` (reviewer minor 2; matches the comment's git claim) — cost if wrong: a few legal-to-us names refused
Task 2: minor (deferred): moveDone changes record without bumping rev (idempotent, harmless)
Task 2: minor (deferred): a PR object once committed with record:null answers `from` with 409 record:null — client takes the snapshot path (note for Task 7)
Task 2: minor (deferred): 410 Response built eagerly on every tombstone request; test title typo "tombstone own"
Task 3 carry: add `take` to NEEDS so the tombstone's 410 is reached; add the deferred take-410 and log/snapshot-on-tombstone assertions
Task 4 carry: moveTo queues the index removal (lifecycle.ts moveTo case)
Task 2: fix round 1/5 (4 addressed, 0 open; commits 6181e2c..a006b8f)
Task 2: complete (commits 1328059..a006b8f, review clean)
Task 3: complete (commits e69284a..cb3663e, review clean)
Task 3: minor (deferred): log `kind`/`holder` uncut — Ruling: carried into Task 4 (which edits lifecycle.ts): cut both to 200 chars — an oversized log value would break `log` for good — cost if wrong: long holder names truncated
Task 3: minor (deferred): snapshot record of any size lands in `state` (commit's archive has the same exposure) — final review to triage a size cap
Task 3: minor (deferred): fileAdopt 423 tested only with no lease, not another principal's live lease
Task 3: minor (deferred): snapshot test uses CODEX as actor, brief said ADAM (stronger test)
Task 3: minor (deferred): `s` is read before `await verifierOf` (crypto.subtle, not storage) — two concurrent same-principal takes might both get fence+1; pre-existing pattern in claim; final review to triage
Task 4: review — Important: (1) retention tests use fixed sleeps (archived PR rev===0 single check; branch rev===2 ~100 ms margin) — flake under load
Task 4: Ruling: the TEST_FAULTS fault refuses only index `update` (503); `list` keeps answering — the fault exists to fail registration (#53), a failing list adds nothing — cost if wrong: one test-only branch
Task 4: Ruling: /v1/admin/index also accepts `update` (test-only, admin + TEST_FAULTS gated) — lets tests drive (born, rev) ordering directly — cost if wrong: none in prod (404)
Task 4: Ruling: the index group runs in its own Miniflare instance with a long RETENTION_MS; branch.test.ts too — at 400 ms objects retired mid-test — cost if wrong: none
Task 4: minor (deferred): `log` bypasses save — a line on an empty/deleted object leaves an orphan `log` key; branch retention ignores log-only activity — final review to triage (refuse log at rev 0 vs write state alongside; T7 relayLog is the caller)
Task 4: fix round 1/5 dispatched (Important 1 + minors: deleteAll before deleteAlarm, send timeout 5 s, retry via arm, #53 timing assertion, line wrap, TEST_FAULTS-unset 404 test)
Task 4: fix round 1/5 (7 addressed, 0 open; commit ba6c681)
Task 4: minor (deferred): index send's 5 s AbortSignal timeout is not exercised under Miniflare
Task 4: minor (deferred): archived-PR test asserts rev===2 right after the outbox drains; flaky only if that wait exceeds ~400 ms
Task 4: complete (commits 91f3eb9..ba6c681, review clean)
Task 5: review — Important: (1) plan-mandated "401/403 are down" contradicts spec §8 (fallback only on network error, 5xx, 5 s timeout) and §10 (revoke cuts a principal off on its next request): a revoked or read-only checkout would fall back and keep acting locally
Task 5: Ruling: RelayAnswer gains `{ refused: string }` for 401 and 403; the caller stands down (does not act, does not fall back), logs once; `down` stays for network error, 5xx, timeout and a non-JSON body — the spec is the binding authority and the plan's Review Focus 2 was looser than it — cost if wrong: an expired person token stands the session down instead of continuing locally (re-auth fixes it)
Task 5: Ruling: Task 6 consumes `refused` as stand-down; Tasks 6–9 dispatches carry it. Non-JSON (e.g. an Access login page on an expired token) stays `down` — check what Access actually answers at the Task 13 deploy — cost if wrong: one more branch in relayCall
Task 5: Ruling: the relay answers 400 (not 500) for a body that isn't JSON (lifecycle, repo-index, grants) — a bad request is not an outage — cost if wrong: none
Task 5: Ruling: Roster stays in hooks/github.ts; baseFileOf moves to relay.ts (no import cycle for Task 6); validate's env-name listing is checked in Task 6 when register.tsx reaches relayOf — cost if wrong: none
Task 5: fix round 1/5 (5 addressed, 0 open; commit 3f5e274)
Task 5: complete (commits ec1a7e9..3f5e274, review clean); .wrangler/ ignored in a chore commit
Task 6 carry: relayCall returns `{ refused }` on 401/403 — the store stands down (no fallback, no local writes), logs once; only `down` means fallback. validate must list PR_GATE_RELAY_CLIENT_ID/_SECRET/_TOKEN, $.env.get and $.http.fetch once register.tsx reaches relayOf
