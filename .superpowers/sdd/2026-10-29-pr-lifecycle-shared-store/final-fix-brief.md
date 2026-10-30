# Final fix dispatch — #29 Part B (pr-lifecycle 1.6.0)

Fix every item below. The final review report is the detail source: /home/allisone/Projects/pr-gate/.superpowers/sdd/2026-10-29-pr-lifecycle-shared-store/final-review-report.md (read Issues and Deferred-minor triage fully).

## From the final review
1. I1 (security). Ruling: add PR_GATE_RELAY_URL. Send credential headers only when the origin of sharedStore.url equals the origin of PR_GATE_RELAY_URL. Pin unset or mismatched → no credential sent, no relay call, the lifecycle runs locally, one log line per lifecycle naming the mismatch (never a credential value). Tests: mismatched host → no request carries credential headers and the lifecycle runs locally; pin unset → local; matching → relay used. Document in pr-lifecycle/README.md's credential section, pr-lifecycle-relay/README.md, and the CLAUDE.md relay bullet. Add a line to spec §… where credentials are described (credential env vars) noting the pin.
2. I2. settleOwed passes isAdvancing: true to ledgerOf and saves the fileAttempt the ledger returns. Test exactly as the report describes (#n done and closed, relay down, local refile #m, relay up → record ends on #m, attempt 2 done in ledger, nothing reported as duplicate).
3. M1–M6 as the report's "How to fix it" says, with M4 per this ruling: fetch with redirect: 'manual'; a 3xx status or a text/html content-type counts as refused (never down). Test both.
4. Every Deferred-minor triage row marked "Fix now" (tests and code as stated). Leave "Stays deferred" rows alone.

## Task 12 docs minors
5. pr-lifecycle/tests/gate.test.ts:64 test "the shared allowance (4) without agreement ends the pre-PR gate as exhausted": add { timeoutMs: 15_000 }; update CLAUDE.md's slow-test count (53 → 54) and any other place that count appears.
6. ROADMAP.md: move the 1.6.0 note to after "What closes wave 2", before "Wave 2c".
7. pr-lifecycle-relay/wrangler.jsonc: add an "ADMINS" placeholder to vars (empty / placeholder like the other vars).
8. Relay README: the `take` row says "a live lease"; the `moveTo` row says moveTo answers 200 and later ops answer 410.
9. pr-lifecycle README: "same principal" notes a shared service token counts as one principal; a body that isn't JSON counts as down (except the M4 cases, which are refused).
10. CLAUDE.md relay bullet: say "no answer (network, 5xx, timeout)" runs locally; mention the pin and that a refused credential stands down.
11. Spec line ~124: add "of a lease op" where the review flagged it (check context: the sentence about which answer stands down).

Update test counts in CLAUDE.md (pr-lifecycle 813, relay 86) to the new totals.
