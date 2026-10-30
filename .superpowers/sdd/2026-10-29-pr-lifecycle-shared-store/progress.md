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
