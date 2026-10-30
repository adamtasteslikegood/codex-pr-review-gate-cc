# Final fix report: #29 Part B (pr-lifecycle 1.6.0), final whole-branch review

Branch `docs/wave2b`, not pushed. Status: **DONE_WITH_CONCERNS** (see Concerns).

## Commits

| Commit | What |
| --- | --- |
| `2a523c2` | I1: send the relay credential only to the relay this machine pinned (`PR_GATE_RELAY_URL`) |
| `de89013` | I2: an owed filing settles on the refile, not the closed ledger issue, and keeps its attempt |
| `80f38ad` | Minors: M1-M6 and the deferred "Fix now" rows |
| `1b9cb48` | Docs: Task 12 minors, the spec lines, the test counts |

## Checks (final runs, after the last commit's content)

- `npm run lint`: clean.
- `npm run test:relay`: 89 pass, 0 fail (was 86).
- `npm run typecheck:relay`: 0 errors.
- `npm run validate`: passed. Its one warning (no marketplace install line in the pr-lifecycle README) was there before this work.
- `npm run test`: codex-gate 22 pass; pr-lifecycle 825 pass, 0 fail (was 813), 199 s.
- `npm run typecheck` (the types are present): 0 errors.

## Item by item

### 1. I1: the relay pin (commit 2a523c2)

- **Code.**
  - pr-lifecycle/hooks/relay.ts:63 adds `NOT_PINNED`.
  - The pin check is in `relayAt` at relay.ts:95-96. It compares the origin (scheme, host and port) of `sharedStore.url` with the origin of `PR_GATE_RELAY_URL`.
  - Nothing is sent when the pin is unset, is not a URL, or names another origin. The lifecycle then runs locally, and the run log names the mismatch once per lifecycle; no credential appears in that line.
  - store.ts's `isUnsent` and `noteNoCredential` treat `NOT_PINNED` like a missing credential.
- **Tests.**
  - pr-lifecycle/tests/lease.test.ts:334, "a base that names another relay than the pinned one: no request carries a credential, and the lifecycle runs locally".
  - lease.test.ts:347, the same with no pin.
  - lease.test.ts:356, the pinned relay is used.
  - A unit test in tests/relay.test.ts.
  - Every test env now sets the pin.
- **Docs.**
  - pr-lifecycle/README.md:421, "The machine pins its relay".
  - pr-lifecycle-relay/README.md:6.
  - The CLAUDE.md relay bullet, lines 50-57.
  - The spec, at docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md:68.

### 2. I2: `settleOwed` (commit de89013)

- **Code.** In pr-lifecycle/hooks/round.ts:4369-4371, `ledgerOf(..., isAdvancing: true)` runs, and the updated finding saves `fileAttempt` when the ledger advanced.
- **Tests.**
  - pr-lifecycle/tests/filing-ledger.test.ts:519 covers a closed issue.
  - filing-ledger.test.ts:523 covers a deleted or transferred issue, one that is not listed at all.
  - Both use the helper `refiledWhileDown` at line 492.

### 3. Minors M1-M6 (commit 80f38ad)

**M1: a plain 409 at a move's commit no longer releases the driver's own lease.**
- **Code.**
  - pr-lifecycle/hooks/store.ts:989 compares the claim's lease `token` with the `Kept.token` of the lease already cached for that path (`isRenewal`).
  - Only a claim this call newly took is released.
- **Test.** tests/shared-move.test.ts:595.
  - It asserts that no `release` is sent and that the next `beatLease` answers `{ mine }`.
  - Checked: with `isRenewal` forced false, the test fails because a `release` is sent.

**M2: `moveDone` waits until the move's archive snapshot lands.**
- **Code.**
  - In store.ts:685-687 (`publishMove`), when `keepLocal` reports that its snapshot did not land, the function returns before `moveDone`.
  - The tombstone keeps the record, and the next load sends both again.
  - The doc comment of `publishMove` was updated to match.
- **Test.** tests/shared-move.test.ts:523.
  - With the snapshot down: no `moveDone` is sent, the tombstone still holds the old record, and the fresh start meets `StaleRecord`.
  - Once the relay answers, the archive holds the old lifecycle and the new one starts.
  - Checked: the test fails without the fix.

**M3: a `fileDone` from a non-claimant answers 409, not 403.**
- **Code.**
  - pr-lifecycle-relay/src/lifecycle.ts:359.
  - The same change in the fake, tests/relay-fake.ts.
  - The `payOwed` comment in store.ts.
- **Tests.**
  - The contract, tests/contract.ts:184, is replayed against both the relay and the fake.
  - Two expectations in pr-lifecycle-relay/test/relay.test.ts changed from 403 to 409.
  - The owed-refusal test, filing-ledger.test.ts:317, was reworked. The non-claimant `fileDone` now answers 409 and is paid silently. The refusal now comes from a grant cut to read for that one call, and exactly one refused line is logged.

**M4: an Access redirect or login page is refused, never treated as down.**
- **Code.** pr-lifecycle/hooks/relay.ts.
  - Line 136: `relayCall` fetches with `redirect: 'manual'`.
  - Lines 116-118: a 3xx, or a non-5xx `text/html` answer, is `refused`.
  - The file header and the `RelayAnswer` doc were updated.
- **Test.** tests/relay.test.ts:235.
  - A 302, a 307 and a 200 `text/html` are refused.
  - A 502 HTML page is still down.
  - The inits carry `redirect: 'manual'`.

**M5: the secret's verifier is computed before the state is read.**
- **Code.** pr-lifecycle-relay/src/lifecycle.ts:186.
- **Test.** No new test, since the behaviour is unchanged. The whole relay suite passes.

**M6: size bounds.**
- **Code.**
  - A `commit` or `snapshot` body over 128 KiB (`BODY_MAX`) answers 413. See lifecycle.ts:72 and :184, and the fake at relay-fake.ts:82 and :261.
  - Archives are trimmed oldest first to 1 MiB (`trimmed`, lifecycle.ts:76), so the stored value stays under 2 MB.
- **Tests.**
  - The contract case "a commit or snapshot body over 128 KiB is 413, and changes nothing", at contract.ts:262.
  - pr-lifecycle-relay/test/relay.test.ts:98, "archives are trimmed oldest first to 1 MiB".

### 4. The deferred "Fix now" rows (commit 80f38ad)

**Task 1: a forged admin principal on `breakLease` answers 403.**
- **Test.** pr-lifecycle-relay/test/relay.test.ts:51. A forged `x-relay-principal` (ADAM) and `x-relay-preset` are sent by READER and by CODEX, and each answers 403.

**Task 3: `fileAdopt` answers 423 under another principal's live lease.**
- **Test.** contract.ts:231 adds a step where CODEX tries to adopt a stale claim while ADAM's session holds the live lease, and expects 423 with `{ holder: 'session-a' }`.
- The young-claim 423 was already covered.

**M6.** Covered above.

**M5.** Covered above.

**Task 6: the scrub test tells FIXED_KEYS apart from free text.**
- **Test.** tests/shared-store.test.ts:493.
  - A log line's `kind` holds the security finding's id, and its `by` holds the finding's title. Both are FIXED_KEYS, and both are kept.
  - Its free-text `text` holding the id, and another line's text holding the title, become `HELD_PLACEHOLDER`.
  - Checked: with `by` removed from FIXED_KEYS, the test fails.
- The short-file half stays deferred, under the 8-character ruling.

**Task 8: `Kept.token` is used.** It is used in M1, above.

**Task 9: `markSent`'s gone and secret exits call `left(...)`.**
- **Code.** pr-lifecycle/hooks/round.ts.
  - `left` was hoisted out of the ledger block, so it is in scope at the POST.
  - A new reason, `REPLACED` ("the lifecycle was reset or replaced"), is announced in a toast like `MOVED_AWAY`. That lifecycle's log now belongs to another lifecycle (the gate G7-8 rule).
  - The gone exit calls `left(REPLACED)`, at line 4049.
  - The secret exit calls `left('the finding is security now')`, at line 4053.
- **Tests.** tests/filing-ledger.test.ts:409 (reset) and :422 (security).
  - Both use the helper `changedAtMark`, which changes the relay's record at `markSent`'s own commit.
  - Reset: the claim stays, and a toast names its key and "reset or replaced". The relay log never names the key.
  - Security: the line reaches the relay's log as `HELD_PLACEHOLDER`, whole, and never with the key.
  - The filing-ledger engine stub now records toasts in `w.toasts`.
  - Checked: each test fails without its own `left` call.

**Task 11: the plain-409 test proves M1.** It is the M1 test, shared-move.test.ts:595.

### 5. The slow gate test and the slow-test count (commit 1b9cb48)

- tests/gate.test.ts:64 now carries `{ timeoutMs: 15_000 }`.
- **CLAUDE.md:129 says 61, not the brief's 54.** The count was 53 at f8d5a82. This branch's new lease and filing tests carry the timeout too, and `git grep -c "timeoutMs: 15_000"` over pr-lifecycle/tests gives 61 with the gate test included.
- No other doc gives the count. The spec's §7.3 and the flaky-tests plan name no number.

### 6. ROADMAP (commit 1b9cb48)

The 1.6.0 follow-up moved to ROADMAP.md:220. It now sits after "What closes wave 2" and its closing paragraph, and before "### Wave 2c".

### 7. wrangler.jsonc (commit 1b9cb48)

`"ADMINS": "<comma-separated admin people>"` was added to `vars` at pr-lifecycle-relay/wrangler.jsonc:17, in the style of the other placeholders.

### 8. Relay README (commit 1b9cb48)

- **`take`, line 42:**
  - it takes a live lease of the same principal at once, with a new `token`;
  - a lapsed or empty lease is simply taken;
  - another principal's live lease answers 423.
- **`moveTo`:** it answers 200; every record and lease op after it answers 410, apart from a fresh start.
- **`fileDone`:** anyone but the claimant gets 409.
- **`snapshot`:** archives keep at most 1 MiB.
- **Line 51, new:** a `commit` or `snapshot` body over 128 KiB answers 413 and changes nothing.

### 9. pr-lifecycle README (commit 1b9cb48)

- **Lease, line 430:** "same principal". A service token is one principal, so every machine that shares it can take over from the others.
- **Fallback, line 433:** a body that isn't JSON counts as down. A refused credential (401, 403), a redirect (3xx) or an HTML page (Access's login) stands the session down.

### 10. CLAUDE.md relay bullet

- I1's edit (2a523c2) already covers:
  - no answer (network, 5xx, timeout) running locally;
  - the pin;
  - a refused credential standing down.
- 1b9cb48 adds "or Access's redirect or login page" to the refusal clause.

### 11. Spec, line 125 (commit 1b9cb48)

The sentence now reads "Any 409 or 423 **of a lease op** empties the cache at once." It also says:
- the rule covers a refused `beat` or `release`, and a `commit` refused by another holder's lease (423);
- a plain revision 409 of a `commit` keeps the run (M1).

### Test counts (commit 1b9cb48)

CLAUDE.md now gives pr-lifecycle 825 (was 813) and relay 89 (was 86), from the final runs.

## Concerns

1. **The slow-test count is 61, not 54.** See item 5. The brief assumed no other test on the branch had gained the timeout.
2. **The host may follow redirects whatever `redirect` says.** The plugin host's `HttpInit` type has no `redirect` field, so the init goes in as a variable. If the host follows redirects anyway, the 3xx rule never fires. The `text/html` rule still refuses the Access login page that a followed redirect ends on.
3. **M2 can write more than one copy of the archive.** Until the relay holds the move's archive, every load runs the move's steps again. Each run writes another local archive and tries another snapshot, so more than one copy of the same record can reach the relay's archives once it answers. The fresh start meets `StaleRecord` (409) until then; the spec's `startOver` already describes that. Nothing is lost, but the duplicates take archive space, now bounded by M6's 1 MiB trim. The M2 test (shared-move.test.ts:523) shows they happen: the owed snapshot is paid and the next run's snapshot also lands, so two `move` archives exist. The test dedupes the lifecycle ids before it compares them, so it does not prove there is exactly one copy.
4. **A refusal line in `payOwed` can be lost (an old limit, unchanged).** The line goes to the refused entry's own path, so when a grant is revoked it never lands. The drop still happens, and only its line is lost.
5. **The validate warning is old.** The pr-lifecycle README has no marketplace install line, and this work left that as it was.
6. **Task 9 uses a toast, not the run log, for the reset exit.** I applied the G7-8 rule, so a reset or replaced lifecycle's claim is announced in a toast. `markSent` also answers `gone` when the lifecycle was archived, which is the same lifecycle, so the toast fires on archive too. Only the generation-bump trigger is tested. If Adam wants that line in the new lifecycle's run log, it is a one-line change in `left`.

## Round 2 (scoped re-review N1–N6)

Commits: `62f25df` (N1, N2, N5, relay.ts comment), `911915a` (N4, N6, CLAUDE.md counts). N3 left alone (parked).

- **N1.** store.ts `tooLargeOf` maps a 413 answer to a down answer tagged `HTTP 413`, and `settle` and the move's commit go through it. `noteDown` writes one `relay too large` line per lifecycle (not `relay down`), and the lifecycle runs locally with no stand-down. `keepLocal` treats a snapshot 413 as not owed: the local archive is the only copy, `publishMove` goes on to `moveDone`, and nothing retries. `BODY_MAX` is 512 KiB in the relay and the fake (`fake.bodyMax` lets a test lower it); the contract pads are 500 KiB and 513 KiB; the relay README says so. Tests: shared-store (a commit over the bound: the local record moves, one line, the gate never throws, and a save that fits reaches the relay again) and shared-move (a snapshot over the bound: one snapshot, one `moveDone`, a local archive only, no later resend).
- **N2.** relay.ts `answerOf` refuses `text/html` only below 400. An HTML 404 is down; HTML 401 and 403 stay refused. The test is in relay.test.ts (M4).
- **N4.** `ledgerOf` advances only when the done issue is not the finding's saved issue (`at.saved !== n`). Test in filing-ledger: an owed finding on #21, the ledger's attempt 1 done with #21, #21 closed. It settles on #21, with no attempt 2 and `fileAttempt` unchanged; before the fix, attempt 2 was claimed and finished with #21.
- **N5.** The M2 test is retitled ("copies deduped"). Two `move` copies land by design: the retried move sends its own snapshot before `moveDone`, and the snapshot owed from the failed try is paid after it. The test now also asserts at least one copy, that every copy is the old lifecycle, and that a snapshot comes before `moveDone`.
- **N6.** `markSent` returns `'archived'` (same generation, phase archived) or `'replaced'` (a generation change or no record) instead of `'gone'`. On archived, the left claim is logged in the lifecycle's own run log (`the lifecycle was archived`). On replaced, it toasts as before. The Jira caller returns on anything but `'sent'`. The filing-ledger test failed with the old toast path.
- **Comment.** relay.ts `relayCall` now says the host may follow redirects whatever `redirect: 'manual'` says, and the `text/html` rule is the backstop.

Checks: lint clean; test:relay 89; typecheck:relay and typecheck 0 errors; validate passes (the README marketplace-line notice as before); `npm run test` codex-gate 22 and pr-lifecycle 829, 0 fail. CLAUDE.md counts: pr-lifecycle 829, slow tests 63 (the N4 and N6 tests carry `{ timeoutMs: 15_000 }`).

Concerns:
- A 413 on the move's own commit (step 2) is handled like down: the move stops there and is tried again on each load until the record fits. It never throws, but a record that stays over 512 KiB never finishes its move to the relay.
- N5 keeps the duplicate archive copy rather than removing it. Removing it would mean dropping an owed snapshot once a later one for the same lifecycle lands.
- N3 is still open, parked as a follow-up.
