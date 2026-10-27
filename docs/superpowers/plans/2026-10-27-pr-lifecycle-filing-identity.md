# Lifecycle filing identity (#29) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish and ship option A of #29 (a persisted random `lifecycleId` in the filing mark) as pr-lifecycle 1.5.1, then frame option B (a shared Durable Object store) as decisions for Adam, not code.

**Architecture:** Option A is already built on `fix/29-lifecycle-id` (c9790da, one commit on top of `d2aff78`, which is in `main`). This plan takes that commit as its input. Part A adds the tests the design's Verification list asks for that the branch doesn't prove yet, tightens one type so a mark can never be written without an id, and does the release housekeeping. Part B is a design spike whose output is a decision document. Nothing in this plan deploys anything.

**Tech Stack:** TypeScript 6.0.3 in `pr-lifecycle/`, the `claude plugin test` harness with the `tests/world.ts` fake transport, ESLint with `@stylistic`.

**Spec:** `docs/superpowers/specs/2026-10-24-lifecycle-filing-identity-design.md` (Adam's design, saved verbatim). The source is issue #29.

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
4. **Takeover and resume keep the id.** A new session (`w.clearState()`) followed by `resume` must not change `lifecycleId`. *(Task 2)*
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
- Produces in `world.ts`: `w.git.toplevel: string` (default `'/repo'`), which `rev-parse --show-toplevel` and `rev-parse --absolute-git-dir` (`${toplevel}/.git`) answer with. Also `w.failSet?: (key: string) => boolean`: when it returns true, the `store.set` handler throws `new Error('store write failed')` and stores nothing.

- [ ] **Step 1: Add the two world options.** With both unset, every existing test must behave the same. Run `npm run test` to confirm.
- [ ] **Step 2: Write the tests.**
  - `'#29: two checkout roots of one PR, same generation and finding id: the second neither adopts nor edits the first\'s issue'`. Checkout A files G2-1 with the answer lost, as the existing `#29` test does. Then set `w.git.toplevel = '/repo-b'`, call `w.clearState()`, and start B's record under `lifecycle:/repo-b:feat/x`, either through the real adoption path or, if `world` can't drive adoption from a second root, by seeding it with `newRecord({ root: '/repo-b', ... })` carrying an unrelated G2-1 marked sent. Set `issueAnswer = 'ok'` and `say($, 'resume')`. Assert:
    - `w.gh.issues` has length 2;
    - `w.gh.issues[0]` equals A's issue as first filed;
    - no `issue edit <A's number>` in `w.gh.labelled`;
    - the stored record at A's key deep-equals its value before B ran;
    - B's issue body contains `lc ${B's id}`;
    - `noUnknownId(w)`.
  - `'#29: a failed id save on a record from before ids sends no issue POST, and the next pass files once with an id'`. Use a legacy record (no `lifecycleId`) and set `w.failSet = k => k === KEY` before the filing pass. Assert `w.gh.issues` has length 0. Then clear `failSet` and `resume`. Assert one issue, whose body contains `lc ${(await recordOf(w)).lifecycleId}`. Note in a comment how the run reports the failed save (hold or stop), as observed.
  - `'#29: a new session and a resume keep the lifecycle id'`. Get to triage, read the id, call `w.clearState()` and `say($, 'resume')`. Assert the id is unchanged.
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

- **Seam.** `pr-lifecycle/hooks/store.ts`: `loadRecord`, `saveRecord`, `archiveRecord`, `updateRecord`, `upsertRecord` and `lockRecord`. `lockRecord`'s per-process promise chain is what a DO's single-threaded storage would replace. Option A's `lifecycleId` becomes the DO's key material, so none of A is thrown away.
- **Shared tooling, not a mandate.** One Worker serves many repositories, and one DO is keyed by canonical `owner/repo#pr`. A repository opts in through `.github/pr-gate.json`, read from the base branch like every other per-repo setting. Without it, the local store stays as it is. Nothing assumes one issue tracker or one source of truth for all of Adam's projects, and nothing forbids one.
- **One human principal for now:** GitHub login `adamtasteslikegood`, which owns the Cloudflare account and signs in with Google using Adam's tasteslikegood.org address. Agents act as that person; there is no second human.
- **What A doesn't cover and B must:** a crash after a POST still needs exact-mark reconciliation, because a claim alone isn't enough (spec). There is also no atomic remote create.

### Decisions for Adam (each with the fact that decides it)

1. **Auth from a hook.** (a) The Worker checks the GitHub token the hook already has through `gh` (`GET /user`, login on an allowlist). No new credential is needed, but every call carries a GitHub token. (b) Cloudflare Access with Google as the identity provider for the person, and an Access service token for hooks. This is a new secret on each machine, but the login stays separate from GitHub. Deciding fact: whether Plaza and other consumers already sit behind Access.
2. **Offline or Worker down.** Fall back to the local store with A's ids, or hold the round. Deciding fact: how often hooks run without network (cloud sessions do, by policy).
3. **Driver lease.** The lease length, whether it is fenced (a token checked on each write), and how it maps to R74's 2-minute takeover.
4. **Retry identity.** The claim key `lifecycleId:findingId:attempt`, and when `attempt` advances.
5. **Retention and migration.** How long filing results stay, and whether existing local records are pushed up or left alone.
6. **Where the code lives.** A `pr-lifecycle-relay/` Worker in this repo, or a shared package Plaza also uses. Its relation to Plaza's DomainSessionStore: separate, per the spec.
7. **Scope with wave 3 item 2 and #27.** Whether "records by PR" is built on the DO or locally first.

### Spike steps

- [ ] Write the adapter interface over `store.ts`'s six functions, with the local implementation behind it and no behavior change. This one piece may land early as a refactor PR with all tests green.
- [ ] Prototype the DO under Miniflare or `wrangler dev`, locally only, with `updateRecord` semantics, a filing ledger and a lease. Exercise it against `world.ts` through the adapter.
- [ ] Measure the latency of a hook round trip against today's local lock, and the request count per lifecycle against the prepaid Workers plan.
- [ ] Write the design doc with the measurements and the decisions above, for Adam's review.
