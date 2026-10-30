# Final re-review: fix round 27fb359..1b9cb48 (#29 Part B, pr-lifecycle 1.6.0)

Read-only. I read the rubric, the final review report, the fix brief, the fix report and the whole diff (in three passes, by size). I did not re-run any suite. I read code outside the diff only to trace where the fixed code is called from. Line numbers are at 1b9cb48.

## Finding Verdicts

- **I1: the machine's credential goes to whatever URL the base names.** ADDRESSED.
  - **The single choke point.** Every `Relay` value, the object that carries the credential headers, is built in `relayAt` (pr-lifecycle/hooks/relay.ts:80-98). Its only callers are `relayOf` (relay.ts:48) and `optInOf` (store.ts:424 and :427).
    - Every relay path takes its `Relay` from `optInOf`: the transaction path (`sharedOf`), the index and discovery path (`sharedForRoot`, store.ts:82-97), `payOwed`, the lease ops, `releaseLease`, `/pr-gate log` (`relayLog`, which goes through `leaseAt`/`sharedOf`), filings and archives.
    - Move targets use `atKey` (store.ts:396), which copies `relay` as it is and swaps only `key` and `path`.
    - Owed entries keep only `path` and `body`, and `payOwed` sends them through the current `relay`.
    - round.ts never calls `relayCall`.
    - Every `path` is `/v1/...`, appended to the pinned-origin `url`, so a path can't change the host.
  - **The comparison is exact.**
    - It compares `new URL(x).origin` strings (relay.ts:66-72, 92-96): scheme, host and port, after URL normalisation, with userinfo dropped.
    - It never matches a prefix or a substring.
    - `sharedStore.url` must be https (github.ts:189-196), so its origin is never the opaque `"null"`.
    - The pin is read from the environment on every call, including when the opt-in answer is cached (store.ts:424).
  - **Tests.**
    - pr-lifecycle/tests/relay.test.ts covers another host, a suffix-domain, a subdomain, another port, http against https, a pin that is not set or empty, a pin that is not a URL, and a path or a trailing `/` on either side.
    - lease.test.ts:334, :347 and :356 drive a full lifecycle. With a mismatched pin or no pin, there are zero fetches, the lifecycle runs locally, and the run log has exactly one line naming both origins and no token. With the matching pin, every fetch goes to `${URL_}/v1/` and carries the token.
  - **Docs.** README:421, relay README:6, CLAUDE.md:50-57 and spec §2 line 68 all document the pin.
  - **Redirects.** `redirect: 'manual'` is sent (relay.ts:136), but whether the host honours it can't be verified here (see Concern 2). Even if the host follows a redirect, the target is chosen by the *pinned* origin or the Cloudflare edge in front of it, never by the base's file. So that is not an I1-class leak.
- **I2: a refile made while the relay was down settles back onto the closed ledger issue.** ADDRESSED.
  - Code:
    - round.ts:4369: `settleOwed` passes `isAdvancing: true`.
    - round.ts:4371: it saves `fileAttempt` through `advanced`.
    - round.ts:4386: the saved finding spreads `...advanced`.
  - The recursion claims attempt 2 and excludes #n. Because the mark carries no attempt, `marked[0]` is the refile #m, and `fileDone` for attempt 2 records #m.
  - The test filing-ledger.test.ts:492-525 does exactly what the brief asked:
    - #21 is done and closed (or missing), the relay is down, and #22 is refiled locally;
    - when the relay is back, the ledger has attempt 1 = #21 and attempt 2 = #22;
    - the finding ends `#22` with `fileAttempt: 1`, `isFilingOwed` is cleared, nothing says "close by hand", and #21 is never edited.
  - There is one side effect, a Minor below (N4).
- **M1: a plain 409 at the move's commit releases the driver's own lease.** ADDRESSED.
  - store.ts:980-982 reads the kept lease before the claim.
  - store.ts:989 sets `isRenewal` when the path matches and the token is unchanged.
  - store.ts:991 releases only a claim that is not a renewal.
  - This is correct against the real relay, because a live same-holder claim keeps its token (pr-lifecycle-relay/src/lifecycle.ts:265-266). A lapsed lease that is claimed again gets `fence + 1`, so it is not a renewal and is released as before.
  - Test: shared-move.test.ts:595.
- **M2: `moveDone` is sent while the move's archive snapshot is only owed.** ADDRESSED.
  - store.ts:684-686 returns before `moveDone` while `keepLocal` reports a line.
  - Test: shared-move.test.ts:523. It has a weakness (N5) and a side effect (N3).
- **M3: a `fileDone` from a non-claimant answers 403.** ADDRESSED.
  - The relay now answers 409 (lifecycle.ts:359), and so does the fake (relay-fake.ts:390).
  - The contract (contract.ts:184) is replayed against both, with the error matched.
  - Both relay tests were changed to 409.
  - The owed-refusal test (filing-ledger.test.ts:317) now gets its 403 from a grant cut to read, and asserts exactly one refused line.
- **M4: an Access redirect or HTML page reads as `down`.** ADDRESSED, per the ruling.
  - relay.ts:116-118: a 3xx is refused, and a non-5xx `text/html` answer is refused.
  - relay.ts:136: the fetch is made with `redirect: 'manual'`.
  - relay.ts:115: a 5xx stays down.
  - The test relay.test.ts:235 covers a 302, a 307, a 200 HTML page and a 502 HTML page, and checks the init.
  - The host reports header names in lower case (`HttpResponse.headers`), so the `content-type` lookup is right.
  - There is an over-match, Minor N2.
- **M5: the verifier is computed after the state read.** ADDRESSED. lifecycle.ts:186 runs `verifierOf` before `storage.get('state')` at :188.
- **M6: no size bound on a record or a snapshot.** ADDRESSED on the relay, with a new problem in the client, N1.
  - lifecycle.ts:72 and :184 answer 413 to a `commit` or `snapshot` body over 128 KiB.
  - `trimmed` (lifecycle.ts:76-80) cuts the archives to 1 MiB, applied at :250 and :301.
  - The fake does the same.
  - Tests: the contract at contract.ts:262 and relay.test.ts:98.
- **Fix-now row, Task 1: a forged `x-relay-principal` with `breakLease`.** ADDRESSED. pr-lifecycle-relay/test/relay.test.ts:51 sends it from READER and CODEX, and both get 403.
- **Fix-now row, Task 3: `fileAdopt` answers 423 under another principal's live lease.** ADDRESSED. contract.ts:231 lets the claim go stale while ADAM's session holds the lease, then expects 423 with `holder: 'session-a'`.
- **Fix-now row, Tasks 3 and 6: the snapshot bound and the digest order.** ADDRESSED, as M6 and M5.
- **Fix-now row, Task 6: the FIXED_KEYS discrimination test.** ADDRESSED. shared-store.test.ts:493 keeps `kind` and `by` holding the id and the title, and scrubs free text to `HELD_PLACEHOLDER`.
- **Fix-now row, Task 8: `Kept.token` is used.** ADDRESSED, in M1 at store.ts:989.
- **Fix-now row, Task 9: `markSent`'s gone and secret exits call `left(...)`.** ADDRESSED for the secret exit (round.ts:4053) and for the gone exit after a generation bump (round.ts:4049). PARTIAL for the gone exit after an archive; see N6.
  - `left` was hoisted to round.ts:3988-3993.
  - Tests: filing-ledger.test.ts:409 and :422.
- **Fix-now row, Task 11: the plain-409 test proves M1.** ADDRESSED. It is shared-move.test.ts:595, and it asserts that no `release` is sent and that the next `beatLease` answers `{ mine }`.
- **Brief 5: the slow gate test.** ADDRESSED. gate.test.ts:64 carries the timeout.
  - CLAUDE.md:129 says **61**. I checked it: `git grep -c "timeoutMs: 15_000" 1b9cb48 -- pr-lifecycle/tests` sums to 61.
  - The brief's 54 was wrong, because the branch's new tests also carry the timeout. The fixer's count is right.
- **Brief 6: ROADMAP placement.** ADDRESSED. The 1.6.0 note is at ROADMAP.md:220, after "What closes wave 2" at :207 and before "### Wave 2c" at :224.
- **Brief 7: `ADMINS` in wrangler.jsonc.** ADDRESSED. It is a placeholder in `vars` at wrangler.jsonc:17.
- **Brief 8: the relay README's `take` and `moveTo` rows.** ADDRESSED, at relay README:42-44. It also adds the 409 for a non-claimant `fileDone`, the 1 MiB archive limit and the 413 line.
- **Brief 9: pr-lifecycle README "same principal" and the not-JSON case.** ADDRESSED, at README:437-443.
- **Brief 10: the CLAUDE.md relay bullet.** ADDRESSED, at CLAUDE.md:50-57. It names no answer (network, 5xx, timeout), the pin, and a refusal standing down.
- **Brief 11: spec "of a lease op".** ADDRESSED. The spec, line 125 (the line ~124 the brief pointed to), now names the plain-409 exception (M1).
- **The test counts in CLAUDE.md.** ADDRESSED: 825 and 89, matching the fix report's runs. I didn't re-run them.

## New Breakage in the Fix Diff

**N1 (Important): a record over 128 KiB now fails the gate run, instead of degrading.**
- **Where:**
  - pr-lifecycle-relay/src/lifecycle.ts:72 and :184 (`BODY_MAX`);
  - pr-lifecycle/hooks/store.ts:913, where `settle` throws a plain `Error`;
  - register.tsx:1417-1424, where the run is finished as `error` with "The gate itself failed: ... HTTP 413".
- **What happens:** the client has no handling for a 413. There is no `noteOnce` line, no local fallback and no client-side size check. Every later commit on that lifecycle answers 413 again, so the lifecycle can't continue on the relay.
- **Why the bound is reachable:**
  - Nothing in a non-security record is cut by `redact`. A finding's `detail` can be up to 4,000 characters (round.ts:2534), and the record carries its own log (`LOG_CAP` 200 lines × 300 characters, about 60 KB).
  - About 15–20 long review findings plus a full log go over 128 KiB.
  - A `commit` that archives carries two records in one body, so it reaches the bound sooner.
- **Why it is worse than before:** previously, only the 2 MB storage limit failed, and that showed as a 5xx: down, so the lifecycle fell back to local.
- **The move case.** The same 413 on the move's snapshot means `keepLocal` reports a line every time. The owed snapshot is paid as done (`payOwed` treats a non-down, non-refused answer as done). `moveDone` is never sent, so the fresh start meets `StaleRecord` on every load: the move never finishes.
- **Fix before any base opts in.** Either fix works, and both are best:
  - raise `BODY_MAX` for `commit` to fit the 2 MB budget (for example 512 KiB, with the archives trimmed to the remainder);
  - have the client map a 413 to a logged local fallback, with one line per lifecycle naming the size, rather than a throw.

**N2 (Minor): the `text/html` rule also catches pages that are not Access's.**
- **Where:** relay.ts:117-118.
- **What happens:** any non-5xx HTML answer is refused, so the session stands down. That includes a Cloudflare edge 404 page (a Worker not bound to that route, or a mistyped url path). CLAUDE.md and the README describe refusal as a credential problem, so the run log's "relay refused" line will mislead in that case.
- **Ruling:** this follows the M4 ruling as written. Note it for the dev deploy; it needs no change now.

**N3 (Minor): a refused move snapshot no longer stands the session down at once.**
- **Where:** store.ts:684-686 (M2).
- **What happens:** `keepLocal` owes a refused snapshot (401, 403 or 3xx) and returns a line, but never calls `standDown`.
  - Before the fix, the `moveDone` that followed would be refused, and the session stood down.
  - Now `publishMove` returns `placed` early, and the stand-down waits for the next relay op.
- **Ruling:** the delay is bounded and leaks nothing. Optionally, make `keepLocal`'s caller stand down on `refused`.

**N4 (Minor): `settleOwed` can now spend a ledger attempt with nothing new to file.**
- **Where:** round.ts:4369 (I2).
- **The case:** a finding is owed, the ledger already has attempt 1 done with the same #n the record names, and #n has closed before the settle. That happens with a young claim's issue the claimant finished, or with an owed `fileDone` that was paid.
  - Before the fix, it settled on #n.
  - Now it claims attempt 2, finds no other marked issue, and falls back to `saved` (#n, closed).
  - It then records attempt 2 = #n and advances `fileAttempt`.
- **Why it is only Minor:**
  - The record still names #n.
  - Nothing is filed twice.
  - A later hold advances to attempt 3 correctly.
- **The fix:** in the `isAdvancing` branch, skip the advance when `at.saved === n`.

**N5 (Minor, test only): the M2 test doesn't prove what its title says.**
- **Where:** shared-move.test.ts:523-541.
- **What's wrong:** the test removes duplicate lifecycle ids before it compares the `move` archives, so it can't show there is a single copy. As the fixer reports, there are two.
- **The fix:** rename the test, or assert the count explicitly (`>= 1`, with the duplicate named).

**N6 (Minor): the gone exit's toast is wrong for an archived lifecycle.**
- **Where:** round.ts:4048-4050, Task 9.
- **What's wrong:** `markSent` answers `gone` both for `phase === 'archived'` and for a generation bump (round.ts:3830). The G7-8 rule justifies a toast only for the generation bump. An archived lifecycle is still the same lifecycle, and the row's own reason is that "the abandoned-claim line is what tells an admin a fileDelete is safe". That needs a durable log line, which a toast isn't.
- **What's needed:** `markSent` has to say which kind of `gone` it is: log the archived case, and toast the replaced one. The fixer's "one-line change" would log both, which breaks G7-8 for the generation bump.
- **A related note:** on the secret exit, the line names a security finding, so R107 scrubs it whole to the placeholder (test :422). The admin then sees a line, but no key to `fileDelete`. That is by design under R107, but it limits what the line is for.

## Fixer's concerns 2, 3 and 6

**Concern 2: the host may ignore `redirect: 'manual'`.** No fix needed now.
- The host's `HttpInit` (`.claude-plugin/types/claude-code/index.d.ts:5373-5409`) has no `redirect` field, so the 3xx branch may be dead code in production.
- If the host follows a redirect, the credential headers (CF-Access-*, which a cross-origin redirect does not strip the way it strips `Authorization`) go to the redirect target. That target is chosen by the pinned relay or the Cloudflare edge in front of it, not by the attacker's base file, so it isn't an I1-class leak.
- The `text/html` rule refuses the login page a followed redirect lands on, and that rule is the live safeguard.
- Verify at the R108 dev deploy, before any base opts in:
  - whether `$.http.fetch` follows redirects, and whether it forwards custom headers when it does;
  - what Access answers a missing or bad service token.
- Until then, the code comment at relay.ts:134-135 ("the credential stays on the pinned host") overstates what is guaranteed. Soften it.

**Concern 3: M2 can write more than one copy of a move's archive.** No fix needed now.
- The copies are of the same record and nothing is lost.
- Their size is bounded by the 1 MiB trim and the 20-entry cap. In practice there are about two copies: the owed one, and the next run's.
- A cheap later fix: don't re-snapshot when a `move` snapshot for that lifecycle is already owed.
- Fix the test's title or assertion (N5).

**Concern 6: a toast, not a log line, on the `markSent` gone exit.** Minor, and no blocker. A partial miss (N6): the toast is right for a reset or replaced lifecycle, but the archived case should log. Defer it with a filed follow-up.

## Out-of-Scope Observations

- `relayCall` (relay.ts:137) fetches the string `${relay.url}${path}`, not a URL built from the pinned origin. Both are WHATWG-parsed today, so the check is sound. As cheap defence in depth, assert `new URL(target).origin === pin` inside `relayCall`, or build `target` from the parsed origin, in case the host's parser ever differs.
- `payOwed`'s refusal line goes to the refused entry's own path (the fixer's concern 4). This was there before the fix, and it is left as it was.

## Verdict

**Fix round: findings remain open.**
- Every finding (I1, I2, M1-M6), every "Fix now" row and every brief item is addressed. I1 holds on every path: transactions, the index, `/pr-gate log`, owed payment and move targets all take their credential from the one origin-checked `relayAt`.
- **Open:** N1 (Important). The M6 413 has no client handling, so a busy PR's record over 128 KiB fails the gate run, and the move never finishes. It must be fixed before any base opts in.
- Minors, which can be deferred with a follow-up: N2–N6.
