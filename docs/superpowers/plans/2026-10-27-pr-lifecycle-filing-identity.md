# Lifecycle filing identity (#29) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish and ship option A of #29 (a persisted random `lifecycleId` in the filing mark) as pr-lifecycle 1.5.1, then frame option B (a shared Durable Object store) as decisions for Adam, not code.

**Architecture:** Option A is already built on `fix/29-lifecycle-id` (c9790da, one commit on top of `d2aff78`, which is in `main`). This plan takes that commit as its input. Part A adds the tests the design's Verification list asks for that the branch doesn't prove yet, tightens one type so a mark can never be written without an id, and does the release housekeeping. Part B is a design spike whose output is a decision document. Nothing in this plan deploys anything.

**Tech Stack:** TypeScript 6.0.3 in `pr-lifecycle/`, the `claude plugin test` harness with the `tests/world.ts` fake transport, ESLint with `@stylistic`.

**Spec:** `docs/superpowers/specs/2026-10-24-lifecycle-filing-identity-design.md` (Adam's design, saved verbatim). The source is issue #29.

## Implementation status (2026-10-27)

Part A is implemented on [PR #31](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/pull/31)
at [dacbb82](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/commit/dacbb82d176796b52cf31c85456fbe5931e3b61f)
as pr-lifecycle 1.5.1; the PR was still open when this note was written.
The task checkboxes and input-commit discussion below preserve the original plan,
not the current implementation status. The linked design remains Adam's verbatim
proposal; this note does not rewrite that historical text.

[CI run 40594242724](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/actions/runs/40594242724)
passed lint, the real plugin harness (codex-gate 22 tests and pr-lifecycle 698 tests),
and validation for that implementation head. CI explicitly skipped typechecking
because generated host types were absent; the PR reports an author's local
typecheck pass, not an independently rerun check here.
The [pre-merge review](https://github.com/adamtasteslikegood/codex-pr-review-gate-cc/pull/31#pullrequestreview-5675735777)
records the implementation and remaining boundaries.

Part B remains a design spike: this PR does not implement or deploy a shared store.
The full shared-store decision document and the open decisions below remain future
work under #29; Part A does not close those decisions or issue #27.

## Where #29 fits

- **Wave 2b shipped** as PR #28 (pr-lifecycle 1.5.0, rulings R88-R95, merged 2026-10-22). #29 came out of that PR's review (thread on `lifecycle.ts:834`, P2). It is a correctness bug in 2b's "issues instead of waivers" (R92): a lost POST answer can settle a finding against another checkout's issue.
- **Option A is a 2b follow-up patch, 1.5.1**, the same shape as R87 was for 2a. It isn't a new wave, and it doesn't block wave 2c or 3. It does belong before anything that relies on filed issues being right (wave 4's "every finding fixed or tracked").
- **Option B belongs with wave 3 item 2** ("Records by PR, not only by folder") and open issue #27 (resume ignores another worktree's lifecycle). All three are one problem: one PR, many checkouts. B should be decided together with them so the per-PR key, the `#<pr>` subcommand argument and cross-worktree resume share one design.
- **Queue order.** Adam's rule is that GitHub issues are the fix queue, highest severity first. #26 (P1: the fix step times out while its fixer still works) outranks #29 (P2). Because A is already built, finishing it is cheap, but it shouldn't delay #26.

## Global Constraints

- `codex-gate/` is frozen and outside this change (spec §6; CLAUDE.md).
- The mark is exactly `<!-- pr-gate filing: <finding-id> of #<pr> lc <uuid> -->` (spec §4). Lost-answer adoption needs an exact match of the whole mark.
- Generation-less marks and `gen <n>` marks are never adopted, not even through the title fallback. Truly unmarked issues keep the title fallback. Never retitle another marked issue, and never rewrite historical marks (spec §5).
- Ids come from `crypto.randomUUID()`. No counter, no service (spec §1).
- Pure formatting functions never mint ids (spec §3).
- Hand style: no semicolons, single quotes, lines up to about 160 columns. Never run Prettier or `eslint --fix` (CLAUDE.md).
- A version bump changes `pr-lifecycle/.claude-plugin/plugin.json`, the version line in `pr-lifecycle/README.md` and the table in the root `README.md` together (CLAUDE.md).
- Run the repo's real gates (`npm run check`) with the real plugin harness. Don't substitute an adapter (spec, Verification). Preflight on Adam's machine: `claude` is at `/usr/bin/claude`, and `pr-lifecycle/.claude-plugin/types/` exists in the `pr-gate-wave2b` worktree, so the spec's cloud-PATH blocker doesn't apply there.

## What c9790da already meets

| Spec item | Where |
| --- | --- |
| §1 random id per fresh lifecycle, adoption and reset | `newRecord` in `lifecycle.ts`; reset through `archiveLifecycle`'s seed |
| §2 kept across stop, resume, retries and changed heads | stored on the record; `archiveRecord` saves the old record whole under `:archived:<at>` |
| §3 legacy records migrated under the lock before filing | `withLifecycleId` in `round.ts`, called first by `fileOnce` and `checkIssuesAfterMerge` |
| §4 new mark, exact match | `filingMark`, `issueFiledFor` |
| §5 old marks never adopted; unmarked title fallback kept | `issueFiledFor` (`!one.body.includes(FILING_MARK)` guards the title fallback) |
| Lost answer reuses the same mark | PR #28 review test, updated to `lc <id>` |
| Two checkouts at the same generation | `#29` test, but it simulates checkout B by overwriting A's own store key |

## Review Focus

1. **A real second root.** The existing test swaps the id under `lifecycle:/repo:feat/x`. Two roots means two keys and one fake GitHub, with A's record left untouched. *(Task 2)*
2. **A failed id save.** If the migration's `saveRecord` throws, the filing pass must send no POST, and a later pass must still file once with an id. *(Task 2)*
3. **A mark with `lc ?`.** `filingMark` falls back to `?` when the id is missing. Make that a type error, and assert that no fake issue body ever contains `lc ?`. *(Task 1)*
4. **Takeover and resume keep the id.** A different session must take ownership through the real session-start path, then `resume` without changing `lifecycleId`; clearing run state alone is not a new session. *(Task 2)*
5. **Archived history keeps the id.** The `:archived:<at>` copy carries the old id, and the live seed carries a new one. *(Task 2)*

---

## Part A: ship option A as 1.5.1

Work in the `/home/allisone/Projects/pr-gate-wave2b` worktree, on branch `fix/29-lifecycle-id`.

### Task 0: Bring the branch up to `main`

- [ ] **Step 1:** `git fetch origin && git merge origin/main`. Use a merge commit, never a rebase (CLAUDE.md, Git). Expected: clean, or conflicts only in `flow.test.ts` hunks next to the #29 tests. Keep both sides.
- [ ] **Step 2:** `npm run check`. Expected: lint, test, validate and typecheck all pass. Record the test count, which was 694 at c9790da.

### Task 1: No mark without an id, by type

**Files:**
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`filingMark`, `githubBody`, about line 838)
- Modify: `pr-lifecycle/hooks/round.ts` (`withLifecycleId`, about line 3542, and its two callers)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `type WithId = LifecycleRecord & { lifecycleId: string }` (exported from `lifecycle.ts`). `withLifecycleId($, rec): Promise<WithId | undefined>`. `filingMark(id: string, rec: Pick<WithId, 'pr' | 'lifecycleId'>): string`. `githubBody(f, rec: Pick<WithId, 'pr' | 'findings' | 'lifecycleId'>, merged?)`.

- [ ] **Step 1: Write the failing test.** Add `const noUnknownId = (w: World): void => expect(w.gh.issues.filter(i => i.body.includes(' lc ?'))).toEqual([])` next to `recordOf`, and call it at the end of every `#29` test and of the two PR #28 review lost-answer tests. These pass today; the type change is what gets checked.
- [ ] **Step 2:** Change the signatures above. `filingMark`'s body becomes `` `${FILING_MARK} ${id} of #${rec.pr ?? '?'} lc ${rec.lifecycleId} -->` `` with no `?` fallback for the id. In `fileOnce` and `checkIssuesAfterMerge`, the local `rec` is the `WithId` that `withLifecycleId` returns.
- [ ] **Step 3:** `npm run typecheck && npm run lint`. Expected: 0 errors. Any other caller of `filingMark` or `githubBody` the compiler names must get its record from `withLifecycleId` too.
- [ ] **Step 4:** `npm run test`. Expected: all pass.
- [ ] **Step 5:** Commit: `fix(pr-lifecycle): a filing mark needs a lifecycle id by type, never "lc ?" (#29)`.

### Task 2: The tests the spec's Verification list asks for

**Files:**
- Modify: `pr-lifecycle/tests/world.ts` (the `git` options and the `store.set` handler, about lines 333 and 562-582)
- Test: `pr-lifecycle/tests/flow.test.ts` (next to the existing `#29` tests, about line 6203)

**Interfaces:**
- Produces in `world.ts`: `w.git.toplevel: string` (default `'/repo'`), which `rev-parse --show-toplevel` and `rev-parse --absolute-git-dir` (`${toplevel}/.git`) answer with. Also `w.failSet?: (key: string, value: unknown, prior: unknown) => boolean`: when it returns true, the `store.set` handler throws `new Error('store write failed')` and stores nothing. A test makes it one-shot itself. It is never a failure on every write to a key, because `markSent` (`round.ts:3688`) writes the same key before the POST and would hide a missing id save (PR #30 review, G1-2).

- [ ] **Step 1: Add the two world options.** With both unset, every existing test must behave the same. Run `npm run test` to confirm.
- [ ] **Step 2: Write the tests.**
  - `'#29: two checkout roots of one PR, same generation and finding id: the second neither adopts nor edits the first\'s issue'`. Checkout A files G2-1 with the answer lost, as the existing `#29` test does. Then set `w.git.toplevel = '/repo-b'`, call `w.clearState()`, and start B's record under `lifecycle:/repo-b:feat/x`, either through the real adoption path or, if `world` can't drive adoption from a second root, by seeding it with `newRecord({ root: '/repo-b', ... })` carrying an unrelated G2-1 marked sent. Set `issueAnswer = 'ok'` and `say($, 'resume')`. Assert:
    - `w.gh.issues` has length 2;
    - `w.gh.issues[0]` equals A's issue as first filed;
    - no `issue edit <A's number>` in `w.gh.labelled`;
    - the stored record at A's key deep-equals its value before B ran;
    - B's issue body contains `lc ${B's id}`;
    - `noUnknownId(w)`.
  - `'#29: a failed id save on a record from before ids sends no issue POST, and the next pass files once with an id'`. Use a legacy record (no `lifecycleId`). Before the filing pass, set a one-shot `failSet` that matches only the migration write: `key === KEY`, `prior` has no `lifecycleId`, `value` has one, and the hook hasn't fired yet. Set `fired = true` when it matches. All other writes go through. Assert:
    - `fired` is true;
    - the stored record still has no `lifecycleId`;
    - `w.gh.issues` has length 0.

    Then `resume`. Assert one issue. Take its mark's UUID with `/<!-- pr-gate filing: G2-1 of #1 lc ([0-9a-f-]{36}) -->/` and assert `expect(sent).toBe((await recordOf(w)).lifecycleId)`, an exact equality, not a substring. Note in a comment how the run reports the failed save (hold or stop), as observed.
  - **Mutation check (not committed):** in `withLifecycleId`, first return `{ ...rec, lifecycleId: newLifecycleId() }` without saving, then wrap the `updateRecord` in a `try`/`catch` that carries on. Each change must make the test above fail. Restore the code, and record both failures in the task's commit message.
  - `'#29: a new session and a resume keep the lifecycle id'`. Follow the existing #13 interactive takeover test in `flow.test.ts`: get to triage, save the lifecycle id and current owner, clear run state, set a different `w.sessionId`, and emit `$.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)` to reset the cached session identity. Check that a recent owner's record is not automatically taken. Advance the fake clock through the required owner-staleness interval (the existing test uses 121_000 ms), then start a fresh interactive session with another distinct id. Assert the stored `:owner` session id changed to that session, and the persisted lifecycle id is unchanged both after takeover and after `say($, 'resume')`. `w.clearState()` alone does not change the session, and assigning `w.sessionId` alone does not reset `round.ts`'s cached `me`.
  - `'#29: a reset archives the old lifecycle with its id; the live record gets a new one'`. After `say($, 'reset')`, find the key matching `/^lifecycle:\/repo:feat\/x:archived:/`. Assert that its `lifecycleId` is the old one, and that the live record's id is defined and different.
- [ ] **Step 3:** `npm run test`. Expected: the new tests pass on c9790da's code plus Task 1. A test that fails here is a real gap in option A: fix it in `round.ts` and say so in the commit.
- [ ] **Step 4:** Commit: `test(pr-lifecycle): #29 two roots, a failed id save, resume and archive keep the id`.

### Task 3: Rulings, spec, version 1.5.1

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-pr-lifecycle-rulings.md`, adding a section `## Rulings after 1.5.0` with **R96**.
- Modify: `LIFECYCLE_SPEC.md`, beside "The merge (R93)" (about line 253): one paragraph on the filing mark and lost-answer adoption.
- Modify: `pr-lifecycle/.claude-plugin/plugin.json`, `pr-lifecycle/README.md` line 3, and `README.md` lines 10 and 25: 1.5.0 → 1.5.1.
- Modify: `CLAUDE.md` "Current state": 1.5.1, with R96 in the rulings range.
- Modify: `ROADMAP.md`, marking the "Follow-up (1.5.1)" paragraph under Wave 2b as done (the paragraph itself comes with this plan through `docs/wave2b`). Merge `main` first if it isn't there yet.

- [ ] **Step 1:** Write R96 (amends PR #28's gen-mark fix; Adam, #29 option A, 2026-10-24): every lifecycle has a random id, made with its record (fresh start, adoption, reset) and saved under the lock before its first filing for a record from before ids. The filing mark names it, and only an exact mark is adopted. Earlier marks are never adopted, not even by title. Unmarked issues keep the title fallback. Cost if wrong: a POST whose answer was lost just before the upgrade files its issue once more.
- [ ] **Step 2:** Make the version and docs edits listed above.
- [ ] **Step 3:** `npm run check`. Expected: all four pass.
- [ ] **Step 4:** Commit: `pr-lifecycle 1.5.1: a lifecycle id in the filing mark (#29 option A, R96)`.

### Task 4: PR

- [ ] **Step 1:** Push `fix/29-lifecycle-id`. Open a PR to `main` titled `pr-lifecycle 1.5.1: lifecycle filing identity unique across checkouts (#29, option A)`, with `Refs #29`, not `Closes`: B stays open on the issue. The loaded pr-lifecycle gates it. Expect holds, and merge with a merge commit once nothing holds it.

---

## Part B: a shared Durable Object store (evaluation, decisions only)

**Output:** `docs/superpowers/specs/<date>-pr-lifecycle-shared-store-design.md`, plus Adam's rulings on the decisions below. Its own plan follows once the decisions are made. No Worker is deployed and no Cloudflare resource is created under this plan (spec, "Next design").

### Fixed inputs

- **Seam.** Audit all of `pr-lifecycle/hooks/store.ts`: record operations (`loadRecord`, `saveRecord`, `archiveRecord`, `updateRecord`, `upsertRecord`, `lockRecord`), ownership (`ownerOf`, `setOwner`) and discovery/history (`liveRecords`, `latestArchive`). Connect the adapter to the controller's claim, heartbeat, takeover and ownership checks, not just record reads/writes. Explicitly define which backend supplies discovery and archived history.
- **Atomic mutation boundary.** The existing `lockRecord` serializes load → arbitrary async callback → save within one client process. Separate remote load/save calls do not preserve that contract merely because a DO is single-threaded. The spike must define server-side atomic mutations or revision/CAS commits that reject or safely reconcile stale updates, including any interleaving around external awaits. Decide how client callbacks map to that boundary; do not automatically retry callbacks with external side effects. Option A's `lifecycleId` remains identity/key material within the per-PR shared state.
- **Shared tooling, not a mandate.** One Worker serves many repositories, and one DO is keyed by canonical `owner/repo#pr`. A repository opts in through `.github/pr-gate.json`, read from the base branch like every other per-repo setting. Without it, the local store stays as it is. Nothing assumes one issue tracker or one source of truth for all of Adam's projects, and nothing forbids one.
- **What A doesn't cover and B must:** a crash after a POST still needs exact-mark reconciliation, because a claim alone isn't enough (spec). There is also no atomic remote create.

### Identity and access (Adam, 2026-10-27, on PR #30)

"One user" in the design meant *who authenticates to the store today*. It never meant that other people or identities can't hold access, or privileged access, later. So:

- **Allowlist of principals.** Every caller is a named principal (a person or a machine identity) with its own rights. Today the list holds Adam alone: GitHub login `adamtasteslikegood`, with Google sign-in through his tasteslikegood.org address on the Cloudflare account. Adding a principal is a configuration change, not a redesign. No code may assume a single user.
- **Authentication: Cloudflare Access with service tokens.** People sign in through Access with Google as the identity provider. Each machine or agent gets its own Access service token, which can be revoked without touching any other. A GitHub token alone is not a credential to the store.
- **Non-human actors get scoped identities of their own.** Codex, CI, cloud sessions and Plaza each have a service identity limited to the repositories and operations they need. They never act as Adam. Every write to the store records which principal made it.
- **Repo-scoped grants from fixed presets.** A grant names a principal, a repository, and one of two presets: `read` (records, history, the filing ledger) or `operate` (also claim a lease, mutate the record, record filings). Grants are managed in configuration in v1. Custom roles and delegated administration are deferred.
- **Admin is a separate capability.** Breaking another checkout's lease, deleting or rewriting filing records, and changing grants are admin-only. Admin is not a preset and doesn't come with `operate`. Only Adam's human identity holds it at first; no service principal holds it.
- **Identity is verified before it is trusted.** A header value is never an identity by itself. The Worker takes the principal only from a supported trust path: the identity Cloudflare's runtime hands the Worker for an Access-protected invocation (`ctx.access`, where it applies), or the Access JWT (`Cf-Access-Jwt-Assertion`) checked for its signature against the team's published keys, its issuer, its audience (the application's AUD tag) and its validity times. A missing or failed check refuses the call before any grant lookup or actor record. Test stand-ins enter only after this step and are never a production fallback (PR #30 review).
- **Enforced on the server.** The Worker or DO checks the caller's grant on every call, in the same atomic step as the lease and revision checks. A client never decides its own permissions. Every change records the authenticated principal that made it.
- **The spike tests it:**
  - a call with no identity, or with a caller-supplied identity header and no valid Access token, is refused;
  - a token with a bad signature, the wrong audience, the wrong issuer, or outside its validity times is refused;
  - a principal with no grant is refused;
  - `read` can't mutate;
  - `operate` on repo X can't touch repo Y;
  - a service principal can't run an admin operation;
  - revoking one token leaves the others working;
  - each write records its actor.

### Decided (Adam, 2026-10-27)

- **Offline or Worker down:** fall back to the local store with A's ids, and say so in the run log. Nothing coordinates across checkouts meanwhile, but a round never stalls on the network.
- **Where the code lives:** a `pr-lifecycle-relay/` Worker in this repository, versioned with the adapter. Other projects call the deployed Worker. It stays separate from Plaza's DomainSessionStore, per the spec.

### Decisions still open (each with the fact that decides it)

1. **Driver lease.** The lease length, whether it is fenced (a token checked on each write), and how it maps to R74's 2-minute takeover.
2. **Retry identity.** The claim key `lifecycleId:findingId:attempt`, and when `attempt` advances.
3. **Retention and migration.** How long filing results stay, and whether existing local records are pushed up or left alone.
4. **Scope with wave 3 item 2 and #27.** Whether "records by PR" is built on the DO or locally first.
5. **Grant configuration.** Which file or binding holds the v1 grants (a Worker config versioned in this repo, or Access policy groups mirrored in it), and how a change to them is reviewed.

### Spike steps

- [x] Write the adapter interface after auditing the record, ownership, discovery and archive operations above, with the local implementation behind it and no behavior change. Trace `claimRecord`, `isOwnedElsewhere`, heartbeat and takeover through this boundary. This one piece may land early as a refactor PR with all tests green; it must not silently leave ownership or history on a different backend.
  - **Done (2026-10-28).** The seam is `store.ts`'s exported functions, not an object: the engine follows `$` only into function declarations, so a backend is chosen inside them. Records, owners, discovery (`liveRecords`) and archives (`latestArchive`) all stay in it. A change of a live record goes through `transact($, root, branch, tx => ...)`, whose `tx` loads, saves and archives inside one atomic boundary; `updateRecord`, `upsertRecord`, `saveRecord`, `startGate` and `archiveLifecycle` all use it, and `lockRecord` is now private to the local backend. Traced: `claimRecord` reads the owner and then sets it, two calls with no atomic boundary between them, and the heartbeat is a bare `setOwner`. Locally that matches today's behaviour; the shared backend must make claim, beat and takeover one server-side operation (open decision 1). `startGate` runs git and gh inside its transaction, so the shared backend's `transact` must be a revision check at commit, not a lock held across those calls.
- [ ] Prototype the DO under Miniflare or `wrangler dev`, locally only, with the explicit atomic mutation boundary, a filing ledger and a lease. Add a deterministic two-client read/modify/write interleaving test: both read revision R, one commits, and the stale second commit is rejected or safely reconciled without losing either accepted update. Exercise two independent controller clients against the same PR through the adapter; verify claim, heartbeat and takeover obey the selected R74/lease policy and a non-owner cannot dispatch work. Include discovery and archive retrieval checks. Lease duration/fencing policy remains Adam's decision; a standalone ledger/lease test is not a substitute for controller integration.
  - **Object side done (2026-10-28), controller side still owed.** `pr-lifecycle-relay/`: a Worker that verifies the caller and hands the call to one Durable Object per `owner/repo#pr`. Each operation checks the grant, the lease and the revision in the same step that writes. `commit` names the revision it read and gets 409 with the current record when it is stale; `claim`, `beat` and `release` are server-side with a fenced token and a capability the checkout makes and the object keeps only as a hash (PR #48 review), so neither a stale holder nor a reader of the lease can write; a commit can archive the record it replaces; the filing ledger's claim is idempotent per key. 17 tests under Miniflare (`npm run test:relay`), including the two-client interleaving. Provisional where Adam's decisions are open: R74's 2-minute lease, the key `lifecycleId:findingId:attempt`, 20 archives, grants in an env var. Not done yet: two controller clients through `store.ts`, and discovery across PRs (`liveRecords`), which a per-PR object can't answer alone.
- [x] Add the identity checks listed under "Identity and access" to the local prototype, at the verification boundary first: sign test tokens with a local key pair served as the team's keys, and run the missing, forged, wrong-audience, wrong-issuer and expired cases against the real verifier. The grant tests then start from a verified principal. No Access application is created, and nothing is deployed. References: [Workers and Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [validating the Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
  - **Done (2026-10-28)** in the same prototype: missing token, a header-only identity, a forged signature, an unknown key, the wrong audience or issuer, expired and not-yet-valid are all 401; no grant is 403, `read` can't mutate, `operate` on one repo can't touch another, a service principal can't run an admin operation, and each write records its actor.
- [ ] Measure the latency of a hook round trip against today's local lock, and the request count per lifecycle against the prepaid Workers plan.
- [ ] Write the design doc with the measurements and the decisions above, for Adam's review.
  - **Drafted (2026-10-29)** before the integration, at Adam's direction: `docs/superpowers/specs/2026-10-29-pr-lifecycle-shared-store-design.md`. It recommends an answer to each open decision, raises three more (P: a person's takeover of a live lease; Q: the run log under a lease; R: security findings in a shared store), and counts requests from the code. Latency and the plan comparison are still owed; a real round trip needs a development deploy Adam hasn't authorized.
