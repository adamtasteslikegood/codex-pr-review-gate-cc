# Final review: #29 Part B, the shared lifecycle store (pr-lifecycle 1.6.0)

Range 7d717cd..85ef831 on docs/wave2b. Read-only review. I ran `npm run test:relay` in a temporary worktree at 85ef831 and removed the worktree afterwards: 86 of 86 tests pass, which is the count CLAUDE.md gives, and the §12 request-count table prints a ratio of 2.19. Line numbers below are file lines at 85ef831.

## Strengths

- **`refused` is never treated as `down`.**
  - In `answerOf` (pr-lifecycle/hooks/relay.ts:85–94), 401 and 403 are the only answers that mean refused.
  - `standDown` throws `RelayRefused`. Every caller I traced stops there, and none falls back to `localTx`.
  - An owed entry the relay refuses is dropped with a run-log line, not retried for ever.
- **`sharedStore` is read from the base only.**
  - `baseFileOf` reads `git show refs/remotes/origin/<base>:.github/pr-gate.json` and never consults the PR's HEAD.
  - `sharedStoreOf` requires an https URL with no query or fragment.
- **Credentials stay out of the repo and the logs.** `relayAt` reads them from the environment only. No log line, toast or record field carries a header value.
- **The relay object enforces lease fencing.**
  - Holder, principal and a SHA-256 verifier of the secret must all match, so a stolen holder id is not enough.
  - `take` crosses sessions only within the same principal (R105).
  - A commit under another session's live lease answers 423.
  - `fileAdopt` needs the live lease.
  - `breakLease` and `fileDelete` need admin, and only people listed in ADMINS are admins.
- **Redaction (R107) runs everywhere data leaves the machine.**
  - It covers the commit, the move's `from`, the archive snapshot, and the log lines (through `scrub`).
  - `restore` puts text back only from the same lifecycle's mirror, as the PR #51 ruling requires.
- **Filing is protected against duplicates at several layers.**
  - Before any POST, the issue list is read for the exact mark.
  - `fileDone` is sent before the record is saved, and one that doesn't land is owed.
  - The claimant's own secret makes a restart idempotent.
  - When two fallbacks filed the same finding, the lowest-numbered issue is kept and the others are named for the person to close.
- **The local backend is unchanged.**
  - A mirror with no `relayRev` takes `localTx`, the old path.
  - A repo without `sharedStore` makes no relay call and keeps no filing secret (filing-ledger.test.ts:359).
- **The move protocol (R103) is careful.**
  - The tombstone carries the record until `moveDone`, and frozen ops get 410.
  - A fresh start over a tombstone needs a new lifecycleId.
  - shared-move.test.ts covers each crash point.
- **The docs match the code.**
  - The version is 1.6.0 in `plugin.json`, in the pr-lifecycle README and in the root README table.
  - The credential variables the README documents (`PR_GATE_RELAY_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN`) are exactly the ones relay.ts reads.
  - The relay README's op table matches the `NEEDS` map in lifecycle.ts:128–146, op for op and tier for tier.
- **The tests exercise real behaviour.**
  - The Miniflare tests run the real Worker and real objects.
  - The plugin tests drive full lifecycles against relay-fake: two-controllers, lease, filing-ledger, shared-move and shared-store.
  - `contract.ts` keeps the fake honest against the relay.

## Issues

### Critical

None.

### Important

**I1. The machine's relay credential is sent to whatever URL the base branch's config names.**

- **Where:**
  - pr-lifecycle/hooks/relay.ts:61–74 (`relayAt`) and 97–104 (`relayCall`);
  - pr-lifecycle/hooks/github.ts `sharedStoreOf`;
  - pr-lifecycle/hooks/store.ts `optInOf` and `FRESH_BASES`.
- **What's wrong:**
  - `sharedStore.url` comes from `.github/pr-gate.json` on `refs/remotes/origin/<rec.base>`. That is the base of the victim's PR, or `dev`/`main` for a checkout with no record.
  - Every request to that URL carries the Access service token (`CF-Access-Client-Id` and `-Secret`) or the person's `cf-access-token`.
  - Nothing ties the URL to a host the machine's owner chose.
- **Who can exploit it:** someone who controls the content of the branch the victim's lifecycle uses as base. That means pushing to an unprotected `dev`, or creating a branch and getting the victim to review a PR against it. A protected `main` needs a merged PR.
- **Why it matters:**
  - Trusting the base for review *config* is the existing model. Trusting it for the *destination of a credential* is a different class of trust.
  - A service token is a bearer secret, and a person's Access JWT is valid for the real application's aud, which the same file names. Either can be replayed against the real relay with `operate`: commits, takes within the principal, and filing claims.
  - The spec says nothing about this. A reasonable user expects a credential they set per machine to go only to the relay they set it up for.
- **How to fix it:**
  - Pin the relay per machine: add `PR_GATE_RELAY_URL` (or a host allowlist) beside the credential variables.
  - Send the credential only when `sharedStore.url`'s origin equals the pin. On a mismatch, run locally and log one line per lifecycle.
  - Add a test with a base whose `sharedStore.url` names another host: no credential header is sent, and the lifecycle runs locally.
  - Document the pin in the README's credential section.
  - Fix this before any base opts in.

**I2. A finding refiled while the relay was down, after its ledger issue closed, settles back onto the closed issue.**

- **Where:** pr-lifecycle/hooks/round.ts.
  - `settleOwed` (4335) calls `ledgerOf` without `isAdvancing` (4359).
  - In `ledgerOf` (4257), the done branch (4289) returns `found: listedAs(n)`. At 4287, `listedAs` makes up an entry for an issue that is not in the open list.
  - `checkOnce` keeps the old attempt on the local path (`const g = ledger.kind === 'local' ? f : ahead`, 4587), and the filing pass does the same.
- **The sequence:** a finding's ledger key `L:id:1` is done with issue #n. #n is closed, and the finding holds again.
  1. With the relay down, the filing pass or the post-merge check files #m locally. `fileClaim` answered down, so the record saves `isFilingOwed: true`, but `fileAttempt` doesn't advance. Only the ledger's `isAdvancing` branch advances it, and a down relay never reaches that branch.
  2. Once the relay is back, `settleOwed` reads key `L:id:1` and gets done with #n.
  3. `isMoving` is true, so it relabels the closed #n, moves `followUp` to `#n`, and logs the open #m, which carries the same mark, as a duplicate to "close by hand".
- **Why it matters:**
  - The review brief names "attempt advances on a closed issue" as a focus.
  - Adam's fix queue loses the live issue: the record points at a closed one and calls the open one a duplicate.
  - The post-merge check then reopens #n, so there are two open issues and the wrong one is labelled the duplicate.
  - No test covers a down relay at refile time; filing-ledger.test.ts:290 and :428 cover the advance with the relay up only.
- **How to fix it:**
  - Pass `isAdvancing: true` from `settleOwed`. A done result that is missing from the open list is then treated as closed, and the next attempt is claimed. Being `isMine`, it finds #m by its mark and sends `fileDone`.
  - Have `settleOwed` save the `fileAttempt` the ledger returns. Today it drops it, while the filing pass saves it through `advanced`.
  - Add a test: #n done and closed, relay down, local refile #m, relay up. The record should end on #m with attempt 2 done in the ledger, and nothing reported as a duplicate.

### Minor

**M1. The move path releases this session's own driver lease on a plain 409.**

- **Where:** pr-lifecycle/hooks/store.ts:971–974.
- **What's wrong:**
  - After `claim`, which renews a lease this session already holds, any commit answer other than 200 or 410 sends `release`.
  - When the session was already the driver, a plain 409 drops its lease on the relay while `leases` still keeps it.
  - The next `beatLease` (1160–1174) gets 409, reads it as `lost`, and the session stands down. This contradicts the rule "a plain 409 keeps the run".
- **Why it is only Minor:** it needs a concurrent commit to land between this session's claim and its commit, while it holds the lease. Every other session would be refused with 423 in that window, so only a lapsed lease or a stale mirror of its own can get there.
- **How to fix it:** release only a lease this call newly took. Note whether a lease was kept for `at.path` before the claim, or compare `Kept.token`.

**M2. The move's `moveDone` is sent even when its archive snapshot was only owed.**

- **Where:** pr-lifecycle/hooks/store.ts:670–679 (`publishMove`).
- **What's wrong:** when another lifecycle already holds the PR object, `keepLocal` writes the local archive and then a redacted snapshot. If the snapshot was down and only owed, `moveDone` still strips the record from the tombstone. The relay then holds no copy until the owed snapshot is paid, though the local archive is kept.
- **How to fix it:** send `moveDone` only after the snapshot answered 200. Otherwise leave the tombstone's record for the next load.

**M3. A `fileDone` from a non-claimant answers 403, which the client reads as `refused`.**

- **Where:** pr-lifecycle-relay/src/lifecycle.ts:341–354.
- **What's wrong:** a valid credential that merely isn't the claimant stands the session down, or has its owed entry dropped. This is reachable only if the filing secret is lost between the claim and `fileDone`.
- **How to fix it:** answer 409 for "not the claimant" and keep 403 for authorization. Update the relay README row.

**M4. An Access login redirect or HTML page reads as `down`, so a refused credential falls back to local.**

- **Where:** pr-lifecycle/hooks/relay.ts:85–94.
- **What's wrong:** Access may answer a missing or expired credential with a 302 or an HTML login page. Neither is JSON, so the session runs locally.
- **How to fix it:** fetch with `redirect: 'manual'`, and treat a 3xx or a `text/html` body as refused. Task 5's ruling postponed this to the deploy, but it is cheap, so do it before the dev deploy rather than after.

**M5. The secret's verifier is computed after state is read.**

- **Where:** pr-lifecycle-relay/src/lifecycle.ts:174–177.
- **What's wrong:** `storage.get('state')` runs first, then `await verifierOf(body.secret)`. That is a non-storage await, so the input gate may let another request commit in between, and this request then acts on a stale `s`. Two same-principal takes could both get fence + 1.
- **How to fix it:** compute the verifier before the read. It is a one-line reorder.

**M6. Neither a record nor an archive snapshot has a size bound.**

- **Where:**
  - pr-lifecycle-relay/src/lifecycle.ts:237 and 288, where archives are capped at 20 entries (ARCHIVE_CAP) but not in bytes;
  - lifecycle.ts:193, which saves the whole `state` as one key.
- **What's wrong:** the record, its log of up to LOG_CAP lines, and 20 archived records all share one SQLite-backed value, which is limited to 2 MB. If one put fails, every later commit to that object fails too. The client reads that as `down` and falls back to local for that lifecycle for good.
- **How to fix it:** refuse a `commit` or `snapshot` whose body is over a fixed size, say 128 KiB, with 413, which the client treats as a non-retryable error. Or trim archives by bytes as well as by count.

## Deferred-minor triage

**Task 1**

| Item | Decision |
| --- | --- |
| The header-replacement test doesn't isolate `x-relay-principal` | **Fix now.** Add a test in which an outside request forges `x-relay-principal: <admin>` and sends `breakLease`; it must answer 403. |
| `/v1/admin/*` shadows a repo owner named `admin` | Stays deferred. Task 4 reserved the owner, and a GitHub owner named `admin` is unlikely. |
| The grant history tests use relative revs | Stays deferred. They test the same thing. |
| A thrown GrantStore fetch is an unmapped 500; a non-2xx `presetOf` is a 502 | Stays deferred. Both fail closed. |
| Re-granting the same preset writes a rev and a history entry | Stays deferred. It is history noise, capped at 500. |
| The relay README still describes the GRANTS env var | Already handled. The README at 85ef831 lists `GRANTS` only as the Durable Object binding, which is correct. |

**Task 2**

| Item | Decision |
| --- | --- |
| `moveDone` changes the record without bumping rev | Stays deferred. It is idempotent and touches only the tombstone's copy. |
| A PR object committed once with `record: null` answers `from` with 409 `record: null` | Stays deferred. Task 7's client takes the snapshot path, as noted. |
| The 410 response is built eagerly on every tombstone request | Stays deferred. It costs only an allocation. |
| The test title typo "tombstone own" | Already fixed. The phrase is no longer in branch.test.ts at 85ef831. |

**Task 3**

| Item | Decision |
| --- | --- |
| Log `kind` and `holder` uncut | Done in Task 4. |
| A snapshot record of any size lands in `state` | **Fix now**, as M6: a byte bound with 413. |
| The `fileAdopt` 423 is tested only with no lease | **Fix now**, cheaply. Add one case where another principal's live lease is held, and assert 423. It guards the one-driver rule. |
| The snapshot test uses CODEX as actor, not ADAM | Stays deferred. It is test wording only. |
| `s` is read before `await verifierOf` | **Fix now**, as M5: move the digest above the read. |

**Task 4**

| Item | Decision |
| --- | --- |
| `log` bypasses save: an orphan `log` key, and branch retention ignores log-only activity | Stays deferred. Retirement's `deleteAll` removes the orphan. The retention edge needs a branch with only log traffic for 90 days. |
| The index send's 5 s timeout is not exercised | Stays deferred. Miniflare can't stall an object-to-object fetch without a fault hook. |
| The archived-PR test asserts `rev === 2` right after the outbox drains | Stays deferred. It passed in this run, and it would fail only if the wait went over about 400 ms. |

**Task 6**

| Item | Decision |
| --- | --- |
| A paraphrase of a security title without its id is not caught | Stays deferred. String matching is a heuristic by design (the Task 6 ruling). |
| The `kind: 'check'` test doesn't discriminate FIXED_KEYS; a short security `file` is not scrubbed | **Fix now**, the test half. Assert that a FIXED_KEYS field holding a security finding's id is kept and that a free-text field holding its title is scrubbed. It guards R107 at one test's cost. The short-file half stays deferred under the 8-character ruling. |

**Task 7**

| Item | Decision |
| --- | --- |
| The fresh-start `moveDone` assumes step 2 landed | Stays deferred. The next load's 409 on a tombstone that still holds its record recovers it. |
| The crash test doesn't hold the index back or run a PR-key client | Stays deferred. shared-move.test.ts covers the delayed index separately. |
| `noteStop` shares the 'relay down' prefix | Stays deferred. It is log wording. |
| A non-200, non-down `moveTo` has no log line | Already handled. store.ts:983 logs 'relay move refused'. |
| A stale `@b` mirror's log lines go to the tombstoned object | Stays deferred. `/pr-gate log` reads both sections across a move. |
| `noteOnce` dedupes 'relay move refused'; the fresh-start text is slightly misleading | Stays deferred. No data is lost, and Task 8's recovery settles it. |

**Task 8**

| Item | Decision |
| --- | --- |
| `beat()` makes three failing calls per tick while the relay is down | Stays deferred. It costs time only, bounded at 15 s. |
| `Kept.token` is unused | **Fix now**, as part of M1: use the token to tell a renewal from a new claim. |
| CLAUDE.md slow-test count | Slated for the Task 12 docs fix. |
| A `fileOnce`/`checkOnce` with no run and no kept lease only reads at its boundary | Stays deferred. No caller reaches it, and every gh write still crosses `boundary`. |
| `checkOnce`'s Jira boundary and watchBeat's `finally` release have no dedicated test | Stays deferred. |

**Task 9**

| Item | Decision |
| --- | --- |
| `markSent`'s gone or secret exits leave a post claim with no log line | **Fix now.** Call `left(...)` on those two exits, as the other exits do. The abandoned-claim line is what tells an admin that a `fileDelete` is safe. |
| The now-security abandoned-claim path has no assertion | Stays deferred. |
| A revocation drops every owed entry, including a `moveDone` | Stays deferred. A revoked credential must not replay, and each drop is logged. |
| A deleted or transferred issue counts as closed and advances the attempt | Stays deferred as designed. Add a case for it to I2's test. |

**Task 10**

| Item | Decision |
| --- | --- |
| The unreachable line also shows when `sharedOf` resolves local | Stays deferred. It is log wording. |
| The stuck-section catch is broad | Stays deferred. It only skips the section. |
| The slug memo lives for the whole process | Stays deferred. A slug rarely changes. |

**Task 11**

| Item | Decision |
| --- | --- |
| The plain-409 keep-the-run path is not driven through the ticker | **Fix now**, together with M1. That test is the one that proves M1's fix. |

**Task 12** minors are slated for the docs fix dispatch and are not re-reported here.

## Declined to judge

- **The pr-lifecycle plugin suite (813 tests) and `npm run typecheck`.** I did not run them: `claude plugin test` and the generated types need a loaded Claude Code session.
- **Whether workerd opens the input gate on `crypto.subtle.digest` (M5).** This is runtime behaviour Miniflare can't show, so M5 is a cheap fix, not a proven race.
- **What Access really answers to a bad credential (M4).** It depends on the Access application's settings, and nothing is deployed.
- **The §12 latency (R108).** It waits for Adam's confirmed dev deploy.

## Assessment

**Ready to merge: with fixes.** The relay and the client meet the spec's security, lease and redaction rules. I1 must be fixed before any base opts in, because otherwise anyone who controls a base can capture the machine's credential. I2 must be fixed on this branch, because it points Adam's fix queue at a closed issue. Both fixes are small and local. The Minor items can go into the same fix dispatch as the Task 12 docs fixes.
