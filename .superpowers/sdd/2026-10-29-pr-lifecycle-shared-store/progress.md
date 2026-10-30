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
Task 6: review — Critical: (1) security text leaves the checkout via message, rounds[].outstanding, log[].text, waivers[].reason (MERGE_SECURITY why lists titles) — R107 says text stays local. Important: (2) relayOf's git show runs on every transact in every repo (pr-lifecycle loads from this working tree, so it is live in Adam's sessions); (3) an opted-in repo whose opt-in check fails writes locally with no pending flag, later lost without archive
Task 6: Ruling: redact walks every string outside `findings` for each security finding's needles (word-bounded id, title, detail, note, file, url, jira summaries) and replaces the whole string with a placeholder; the test drives a real MERGE_SECURITY block and walks the whole JSON of every commit and snapshot body — R107; over-redacting is the safe direction — cost if wrong: some non-security messages shown as placeholders on other checkouts
Task 6: Ruling: no base may set sharedStore until Task 8 lands (StaleRecord uncaught, lease secret not sent); the branch is not merged between tasks — cost if wrong: none while no base opts in
Task 7 carry: relayRev is per object path — reset or re-key it when the path changes branch→#pr (else equal revs could overwrite another checkout's PR record); clear :relay-pending in tombstone/fresh-start; a failed snapshot gets a retry flag
Task 8 carry: commit must send the lease secret (relay lifecycle.ts:233 isMine needs proof, else 423 under any live lease); catch StaleRecord at the four non-pure sites (round.ts 714, 889, 3189, 3234; register.tsx:282 startGate); a 423's lease goes in its own field, not StaleRecord.record; "no relay credential" log line
Task 6: fix round 1/5 dispatched (C1, I2 memoise relayOf per (root, base) + count process.run in the opt-out test, I3 unresolvable opt-in with a relayRev mirror = fallback, a failed snapshot logs a line, save-without-load 409 with no relayRev → keepLocal, full-suite rerun)
Task 6: fix round 1/5 (5 addressed, 0 open; commit 3c28516); re-review found 2 new redaction defects
Task 6: Ruling: an exact finding id string (waiver.findingId) and top-level identity fields (root, branch, base, slug, lifecycleId) are never scrubbed — an id carries no text and is already shared on the finding — cost if wrong: none
Task 6: Ruling: a finding whose duplicateOf chain reaches a security finding is redacted as security (withLinkedPeak marks only the original) — R107 — cost if wrong: a non-security duplicate shown as a placeholder elsewhere
Task 6: Ruling: the scrub touches free text only — enum/identity keys skipped, non-id needle floor 8 chars — a 4-char note like 'check' turned log kinds into placeholders — cost if wrong: a security title under 8 chars without its id could leak (low value text)
Task 6: minor (deferred): free text that paraphrases a security title without its id, file or full title is not caught — heuristic by design; final review to note
Task 6: fix round 2/5 dispatched
Task 6: fix round 2/5 (2 addressed, 0 open; commit 8c57166)
Task 6: minor (deferred): the kind:'check' test doesn't discriminate FIXED_KEYS (needle under the 8-char floor anyway); a short security `file` (a.ts) in free text is not scrubbed — accepted per the 8-char ruling
Task 6: complete (commits dda210a..8c57166, review clean)
Task 7: review — Important: (1) commit/claim 410 with a mismatched lifecycleId always fresh-starts with isFresh over the tombstone, reviving a dead lifecycle (spec §1 says stand down); (2) no client test for a mismatched tombstone; the leftover-tombstone-record fresh-start branch is never exercised
Task 7: Ruling: on a 410, fresh-start only when the record's lifecycleId differs from the mirror's (a real new lifecycle: reset/adoption); a record whose id matches the mirror but not the tombstone stands down (RelayMoved + noteOnce) — spec §1 — cost if wrong: a legit new lifecycle needs one more load
Task 7: Ruling: a failed release of the PR claim joins the owed queue (as moveDone) — cheap now, else 423s for up to 120 s — cost if wrong: none
Task 8 carry: catch StaleRecord/RelayMoved at the non-pure sites; the PR claim/release window; the crash test's boundary assertion (`// Task 8:` note in shared-move.test.ts)
Task 10 carry: liveRecords reads the index only when some local record has relayRev — a fresh checkout of an opted-in repo sees nothing (spec §9 narrowed)
Task 7: minor (deferred): fresh-start moveDone assumes step 2 landed without checking the PR object's lifecycleId; crash test doesn't hold back the index or run a PR-key client; noteStop shares the 'relay down' noteOnce prefix; a non-200/non-down moveTo has no log line; a stale @b mirror's log lines go to the tombstoned object
Task 7: fix round 1/5 dispatched
Task 7: fix round 1/5 (4 addressed, 0 open; commit 8e5f996)
Task 7: minor (deferred): noteOnce dedupes 'relay move refused' per lifecycle; a fresh start whose calls are dropped falls back local and, on next load, stands down with a 'under another lifecycle' text that is slightly misleading — no data lost, Task 8 recovery settles it
Task 7: complete (commits 27be59b..8e5f996, review clean)
Task 8: dispatched (base cc845a1)
Task 8: implementer DONE_WITH_CONCERNS (commit 617555f; 775 plugin tests)
Task 8: review — Important: (1) a commit/move-claim 423 leaves the kept lease cached, so a stood-down session's watchBeat can `take` from the live driver; (2) the end-of-run release is re-claimed at once by deliver's boundary and lingers ≤120 s (headless start refused); (3) no boundary before fileTicket (Jira) in fileOnce/checkOnce
Task 8: Ruling: a lost lease's beat answers 409 (relay contract), not the 423 spec §14 names — both stand down; the docs task rewords §14 — cost if wrong: none, behaviour identical
Task 8: Ruling: a plain rev 409 at a non-pure site keeps the run (the next tick recovers, §14); only 423, RelayMoved and refused stand down — cost if wrong: one more tick before a stand-down
Task 8: minor (deferred): beat() on down makes three failing calls per tick (≤15 s); Kept.token unused; CLAUDE.md slow-test count (Task 12 docs)
Task 8: fix round 1/5 dispatched
Task 8: fix round 1/5 (3 Important + ruling + minors addressed, 0 open; commit 0e34ea7)
Task 8: minor (deferred): a fileOnce/checkOnce with no running run and no kept lease only reads at its boundary (no lease held during the write) — no concrete caller found; checkOnce's Jira boundary and watchBeat's finally-release have no dedicated test
Task 8: complete (commits cc845a1..0e34ea7, review clean)
Task 9: dispatched (base 42ae5bd)
Task 9: implementer DONE (commit 8489357; 788 plugin tests)
Task 9: review — Approved (spec ✅, no Critical/Important); minors: claim left with no POST on moved/waived/security exits; adopt gated at stepTimeoutMs not max(stepTimeout, 30 min); settleOwed lists issues per owed finding per pass; same-checkout crash + quick close → second POST (local path same, not a regression); a refused owed call jams the owed queue; local-only repos write a filing secret; coverage gaps (young-claim settle, owed fileDone paid)
Task 9: Ruling: fix the queue jam (drop a refused owed entry), the adopt threshold, the local-only secret, and a log line for an abandoned claim, with tests — the jam is permanent and cheap to fix — cost if wrong: one short fix round
Task 9: fix round 1/5 dispatched
Task 9: fix round 1/5 (6 addressed incl. a real closed-issue re-adopt fixed, 0 open; commit a79be38)
Task 9: minor (deferred): markSent exits (~4048 gone/secret) leave a post claim with no log line; the now-security abandoned-claim path has no assertion; a credential revocation drops every owed entry incl. a moveDone (payOwed runs only after a call that landed, so low risk); a deleted/transferred issue counts as closed and advances the attempt (matches the merge check)
Task 9: complete (commits 42ae5bd..a79be38, review clean)
Task 10: dispatched (base d09a411)
Task 10: implementer DONE (commit 5902b7e after trailer fix; 805 plugin tests)
Task 10: review — Important: (1) fresh-checkout discovery hardcodes dev,main instead of config.bases (a repo with other bases is never discovered); (2) the stuck listing skips findings with no followUp/issueError, possibly hiding early claims; (3) stuck probe: serial calls, stacks 5 s timeouts on down, can flush the owed queue from a read-only command
Task 10: Ruling: stuck filings list known findings only (no relay list op this wave), labelled "(known findings only)", and the probe stops at the first down with the unreachable note — §7.2 asks only that a stuck claim show in the log — cost if wrong: a dead second checkout's claim stays unlisted until an admin looks
Task 10: fix round 1/5 dispatched
Task 10: fix round 1/5 (2 Important + ruling + minors addressed, 0 open; commit 3a72327)
Task 10: minor (deferred): the unreachable line also shows when sharedOf resolves local (no credential/slug); the log's stuck-section catch is broad; the slug memo lives for the process
Task 10: complete (commits d09a411..3a72327, review clean)
Task 11: dispatched (base d2351b5)
Task 11: implementer DONE (commit 6522e81; check passes; ratio 2.187)
Task 11: review — Important: the ±10% ratio band leaves 0.6% headroom (ratio = 2 + 2c/W by construction); minors: test 5 title says "next tick" but calls a second start; A's second filing pass is non-probative; B's stand-down is engine-level
Task 11: Ruling: assert the exact formula all == 2·W + 2·commits and keep 1.8–2.2 only as this script's sanity bound — the formula is the real claim — cost if wrong: none
Task 12 carry: §12 records the true figure (DO ≈ 2 + 2·commits/W per Worker request, plus a `list`+`read` per 60 s tick that §12 omits); §14 rewords "beat gets 423" to 409; CLAUDE.md slow-test count and test counts; follow-up issue: can the tick's read be skipped while the lease is cached
Task 11: fix round 1/5 dispatched
Task 11: fix round 1/5 (4 addressed, 0 open; commit e529466) — test-only 27-line diff, re-reviewed inline by the controller
Task 11: minor (deferred): the plain-409 keep-the-run path is not driven through the ticker in a two-controller test
Task 11: complete (commits d2351b5..e529466, review clean)
Task 12: dispatched (base d9a12ad)
Task 12: implementer DONE (commit f8d5a82; 22/813/86; one flaky 5 s timeout on rerun-pass)
Task 12: review — Approved (no Critical/Important); minors carried to the final fix dispatch: gate.test.ts:64 flaky 5 s test needs timeoutMs; ROADMAP 1.6.0 note placement; wrangler.jsonc lacks an ADMINS placeholder; relay README take row ("a live lease") and moveTo row (moveTo answers 200; later ops 410); pr-lifecycle README "same principal" and non-JSON body as down; CLAUDE.md relay bullet "no answer (network, 5xx, timeout)" runs locally; spec line 124 "of a lease op"
Task 12: complete (commits d9a12ad..f8d5a82, review clean)
Final review: dispatched (opus) over 7d717cd..85ef831; inputs final-review-inputs.md, report final-review-report.md
