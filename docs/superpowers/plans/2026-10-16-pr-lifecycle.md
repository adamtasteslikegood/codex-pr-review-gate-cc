# pr-lifecycle 1.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `pr-lifecycle/`, the successor to `codex-gate` 0.3.1, whose `/pr-gate` owns a branch from its first pre-PR Codex round to "ready for the merge decision" with one shared review budget and one persistent lifecycle record.

**Architecture:** A copy of `codex-gate/` whose pure logic grows two modules (`lifecycle.ts`: budget, ledger, coverage, controller decision; `github.ts`: feedback parsers, roster, PR-action classifier) and whose effectful code is split into `store.ts` (the record in `$.store`), `round.ts` (one round: review, fix, verify, post-PR collect and triage), `pane.tsx`, and `register.tsx` (hooks, guards, commands, the controller `advance`). The session state (`$.state`) holds only the round in flight; everything that must survive a restart lives in the `LifecycleRecord`.

**Tech Stack:** TypeScript Claude Code mod (`claude-code` host API: `$.state`, `$.store`, `$.process.run`, `$.agent.spawn`, `$.prompt.submit`, `$.clock`), `claude-code/testing` (`test`, `expect`, `mock`), `gh` CLI, gstack `/codex` skill.

**Spec:** [docs/superpowers/specs/2026-10-16-pr-lifecycle-design.md](../specs/2026-10-16-pr-lifecycle-design.md), implementing [LIFECYCLE_SPEC.md](../../../LIFECYCLE_SPEC.md). Read both before starting.

## Global Constraints

- Work only in `pr-lifecycle/` and `docs/`. **Never modify `codex-gate/`** (frozen at 0.3.1; it is the plugin in daily use).
- Never load both folders at once; switching `CLAUDE_CODE_PLUGIN_DIRS` is Adam's call, not a task here.
- Plugin name `pr-lifecycle`, version `1.0.0`; the command stays `/pr-gate`.
- Hand style: no semicolons, single quotes, lines up to about 160 columns. **Never run Prettier or any whole-file formatter.** Edit surgically.
- Checks, run from `pr-lifecycle/`: `claude plugin validate .`, `claude plugin test .`, and `~/Projects/tasteslikegoodtheangularsvegancookbook/node_modules/.bin/tsc -p . --noEmit`. Never `npx tsc`.
- `.claude-plugin/types/` is generated and gitignored; never commit it.
- Commit after each task. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb
  ```
- Defaults: `allowanceStandard` 4, `allowanceHigh` 6, light lane 1, trivial 0, `routineRoundMinutes` 3, `waitCapMinutes` 20, `quietMinutes` 3, `stepTimeoutMinutes` 30, `enforceMerge` true. Poll interval 30 s.
- A waiver, `allow`, and `reset` are the person's alone: command origin `composer` or `bridge`.
- `Finding.round` keeps its 0.3.1 name; it is the spec's `firstRound` (the round that first raised it).

## Review Focus

1. **Another route to open or merge a PR** (`gh api` REST/GraphQL, the github-graphql MCP `manage_pull_requests` with `create`/`merge`/`enqueue`, an unknown GitHub MCP tool): a person expects every one of them to be held exactly like `gh pr create`/`gh pr merge`. Tests: Task 7 (classifier) and Task 10 (guards).
2. **`gh` unauthenticated, rate-limited or offline mid-collect**: the attempt is recorded incomplete, no round is consumed, the pane says what to fix, and `/pr-gate resume` continues. Test: Task 11.
3. **Rebase or force-push where the last reviewed commit no longer exists locally**: coverage treats every file as changed and nothing crashes. Test: Task 5.
4. **Session restart in the middle of post-PR collection or triage**: polling resumes, no feedback is triaged twice, no reply is posted twice, and the budget is unchanged. Test: Task 13.
5. **Another agent pushes while the main agent is triaging round 1**: the round's end head is the PR head, so the protected second round runs. Test: Task 12.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `pr-lifecycle/.claude-plugin/plugin.json` | copy + modify | name, version, options |
| `pr-lifecycle/tsconfig.json` | copy + modify | drops the generated MCP types (OOM fix) |
| `pr-lifecycle/types/index.d.ts` | copy + modify | `Finding`, `Run`, `LifecycleRecord`, `RoundRecord`, … |
| `pr-lifecycle/types/github-mcp.d.ts` | create | inputs of the GitHub MCP tools the guard reads |
| `pr-lifecycle/hooks/core.ts` | copy + modify | classify, readers, prompts |
| `pr-lifecycle/hooks/lifecycle.ts` | create | budget, ledger, coverage, `decideNext` (pure) |
| `pr-lifecycle/hooks/github.ts` | create | `gh` JSON parsers, roster, `collectionDone`, `readPrAction` (pure) |
| `pr-lifecycle/hooks/store.ts` | create | load/save/update the `LifecycleRecord` |
| `pr-lifecycle/hooks/round.ts` | create (code moved from register) | one round; ticker; answers |
| `pr-lifecycle/hooks/pane.tsx` | create (code moved from register) | the pane |
| `pr-lifecycle/hooks/register.tsx` | copy + modify | hooks, guards, commands, `advance` |
| `pr-lifecycle/tests/world.ts` | create (moved from gate.test.ts) | the test world, fake `git` and `gh` |
| `pr-lifecycle/tests/gate.test.ts` | copy + modify | 0.3.1 suite, adjusted |
| `pr-lifecycle/tests/lifecycle.test.ts` | create | pure lifecycle tests |
| `pr-lifecycle/tests/github.test.ts` | create | pure github tests |
| `pr-lifecycle/tests/flow.test.ts` | create | the spec's 13 behaviors and the extra ones |
| `pr-lifecycle/README.md`, `README.md` | modify | docs, version table |

---

### Task 1: Scaffold `pr-lifecycle/`, fix the type check, extract the test world

**Files:**
- Create: `pr-lifecycle/` (copy of `codex-gate/` without `.claude-plugin/types/`)
- Modify: `pr-lifecycle/.claude-plugin/plugin.json`, `pr-lifecycle/tsconfig.json`, `pr-lifecycle/hooks/register.tsx` (names only), `pr-lifecycle/types/index.d.ts` (module key only), `pr-lifecycle/tests/gate.test.ts`
- Create: `pr-lifecycle/types/github-mcp.d.ts`, `pr-lifecycle/tests/world.ts`

**Interfaces:**
- Produces: `tests/world.ts` exports `world(on): World`, `runOf(w)`, `review(step, gate, findings?, extra?)`, `turn(answer, agentId?)`, `isHeld(ran)`, `createPr`, `P1`, `P2`, `TRAILER`, `RUN`. Every later test file imports from it.
- Produces: plugin state key `{ plugin: 'pr-lifecycle', key: 'run' }`, pane id `'pr-lifecycle'`.

- [ ] **Step 1: Copy the folder**

```bash
cd ~/Projects/pr-gate
rsync -a --exclude '.claude-plugin/types' codex-gate/ pr-lifecycle/
git status --short pr-lifecycle | head
```
Expected: the 8 tracked files of `codex-gate/` appear under `pr-lifecycle/`, nothing under `.claude-plugin/types/`.

- [ ] **Step 2: Rename the plugin**

In `pr-lifecycle/.claude-plugin/plugin.json` set `"name": "pr-lifecycle"`, `"version": "1.0.0"`, and `"description": "/pr-gate across the PR lifecycle: pre-PR Codex rounds, then the repository's own post-PR reviews, under one review budget and one record, with a live progress pane."`.

In `pr-lifecycle/hooks/register.tsx` change exactly these lines:

```ts
const PANE = 'pr-lifecycle'
const RUN = { plugin: 'pr-lifecycle', key: 'run' } as const
const tickAtom = atom({ plugin: 'pr-lifecycle', key: 'tick' } as const, 0)
```

In `pr-lifecycle/types/index.d.ts` change the module augmentation key:

```ts
declare module 'claude-code' {
  interface PluginState {
    'pr-lifecycle': { run: Run | null; tick: number }
  }
}
```

Leave user-facing words ("codex-gate …") for now; Task 9 rewrites them.

- [ ] **Step 3: Fix the type check (OOM)**

The generated `claude-code-mcp/index.d.ts` (1.6 MB, every MCP tool on the machine) makes `tsc` run out of memory. Replace `pr-lifecycle/tsconfig.json` with:

```json
{
  "extends": "./.claude-plugin/types/tsconfig.json",
  "compilerOptions": {
    "types": ["claude-code", "claude-code-tools"]
  }
}
```

Create `pr-lifecycle/types/github-mcp.d.ts`, declaring only the GitHub MCP tools the guards read:

```ts
// The GitHub MCP tools the guards read, declared here instead of loading the
// generated claude-code-mcp types (1.6 MB; tsc runs out of memory on them).
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__plugin_github_github__create_pull_request: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }
    mcp__plugin_github_github__merge_pull_request: { owner: string; repo: string; pullNumber: number; merge_method?: string }
    'mcp__claude_ai_github-graphql-mcp__manage_pull_requests': {
      action: 'list' | 'get' | 'create' | 'update' | 'close' | 'merge' | 'reopen' | 'add_review' | 'request_reviews' | 'add_comment' | 'enqueue' | 'dequeue'
      repo: string
      base?: string
      head?: string
      number?: number
      title?: string
      body?: string
      merge_method?: 'merge' | 'squash' | 'rebase'
    }
  }
}
```

- [ ] **Step 4: Run the type check**

Run: `cd ~/Projects/pr-gate/pr-lifecycle && claude plugin validate . && ~/Projects/tasteslikegoodtheangularsvegancookbook/node_modules/.bin/tsc -p . --noEmit`
Expected: validate passes (it regenerates `.claude-plugin/types/`); tsc **finishes** (no OOM). It may still report the 0.3.1 errors in `register.tsx` (TS2589/TS2345/TS7006 around `GITHUB_CREATE_PR`) and `tests/gate.test.ts`. Record the exact list in the commit message; Task 10 removes the `register.tsx` ones by replacing that matcher. If any test-file errors remain, fix them now by narrowing the offending casts (for example `as never`), touching only the reported lines.

- [ ] **Step 5: Move the test world to `tests/world.ts`**

Cut lines 1–114 of `tests/gate.test.ts` (imports through `createPr`) into a new `tests/world.ts`, change `RUN` to `{ plugin: 'pr-lifecycle', key: 'run' } as const`, and export every helper: `export const RUN`, `export const TRAILER`, `export type World`, `export const runOf`, `export function world`, `export const review`, `export const P1`, `export const P2`, `export const turn`, `export const isHeld`, `export const createPr`. Extend `review` to take extra trailer fields:

```ts
export const review = (step: string, gate: string, findings: object[] = [], extra: object = {}) =>
  `Codex said things.\n${TRAILER}\n${JSON.stringify({ step, gate, findings, ...extra })}`
```

At the top of `tests/gate.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { createPr, isHeld, P1, P2, review, runOf, TRAILER, turn, world } from './world'
```

In the pane test change `plugin: 'codex-gate'` and `requestId: 'codex-gate'` to `'pr-lifecycle'`.

- [ ] **Step 6: Run the suite**

Run: `claude plugin test .`
Expected: 22 pass, as on 0.3.1.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: copy codex-gate 0.3.1, rename, make the type check finish

tsconfig drops the generated claude-code-mcp types (OOM); the GitHub MCP
tools the guards read are declared in types/github-mcp.d.ts. The test
world moves to tests/world.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 2: Lifecycle types

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts`

**Interfaces:**
- Produces (every later task uses these names exactly):

- [ ] **Step 1: Replace the finding types and add the lifecycle types**

In `types/index.d.ts` replace `FindingStatus` and `Finding` with:

```ts
/** open is the spec's "still unresolved". fixed is split: what the fixer reported, and what a check confirmed. */
export type FindingStatus = 'open' | 'reported-fixed' | 'verified-fixed' | 'rebutted' | 'deferred'

export type FindingSource = 'codex-review' | 'codex-challenge' | 'github'

export type FindingEvent = { round: number; status: FindingStatus; note?: string; evidence?: string; by: string; at: number }

export type Finding = {
  id: string
  /** The round that first raised it (the spec's firstRound). */
  round: number
  source: FindingSource
  /** A GitHub login, or 'codex'. */
  reviewer: string
  /** The GitHub id of the review or comment it came from: `review:<id>`, `inline:<id>`, `comment:<id>`. */
  externalId?: string
  threadId?: string
  url?: string
  severity: Severity
  isSecurity?: boolean
  title: string
  file?: string
  line?: number
  detail?: string
  /** The head it was raised on. */
  headSeen: string
  status: FindingStatus
  note?: string
  /** A later change touched its file: the evidence behind its status needs checking again. */
  needsRecheck?: boolean
  history: FindingEvent[]
}
```

Add after `Lane`:

```ts
export type LifecyclePhase = 'pre' | 'post' | 'ready' | 'archived'

/** baseline rounds and the final-head check are free; discretionary ones draw on the allowance. */
export type RoundKind = 'baseline' | 'discretionary' | 'final-head-check'

export type Evidence = { source: 'codex' | 'github'; reviewer: string; head: string; isComplete: boolean }

export type RoundRecord = {
  /** The iteration label (`Run.round`); not a count of rounds consumed. */
  n: number
  phase: 'pre' | 'post'
  kind: RoundKind
  /** An advisory-only round: it draws under the reserve rule. */
  isAdvisory: boolean
  startHead: string
  endHead: string
  isCompleted: boolean
  evidence: Evidence[]
  raised: { blocking: number; advisory: number }
  rebutted: number
  deferredBlocking: number
  activeMs: number
  waitMs: number
  outstanding?: string
  startedAt: number
  endedAt: number
}

export type Waiver = { scope: 'pre' | 'post' | 'finding'; findingId?: string; head: string; reason: string; by: string; at: number }

export type Grant = { n: number; reason: string; head: string; at: number }

export type LifecycleRecord = {
  version: 1
  root: string
  branch: string
  base: string
  /** owner/repo, lowercased. */
  slug?: string
  pr?: number
  /** The gh login of this machine, so its own replies are not read as feedback. */
  self?: string
  head: string
  tier: Tier
  tierWhy: string
  lane: Lane
  /** Set when a pass-through skipped pre-PR Codex: why. */
  passThrough?: string
  allowance: number
  grants: Grant[]
  attempts: number
  activeMs: number
  waitMs: number
  rounds: RoundRecord[]
  findings: Finding[]
  /** Feedback ids already triaged. */
  processed: string[]
  /** Feedback id to the id of the reply posted to it. */
  replies: Record<string, string>
  waivers: Waiver[]
  phase: LifecyclePhase
  /** The pre-PR verdict, and the head it is for. */
  preStatus?: RunStatus
  preHead?: string
  /** Why the post-PR phase stopped short of ready. */
  postStatus?: 'exhausted' | 'blocked' | 'error' | 'stopped'
  message?: string
  effort?: Effort
  hasTimedOut?: boolean
  passedEffort?: Effort
  updatedAt: number
}
```

Change `Run`: delete `maxRounds`, `advisoryRound`, `advisoryMin`, `advisoryMax`; widen `phase` and add the round fields:

```ts
  phase: 'scope' | 'review' | 'fix' | 'verify' | 'collect' | 'triage' | 'done'
  /** Which side of the PR this round is on. */
  lifecycle: 'pre' | 'post'
  roundKind: RoundKind
  roundStartHead: string
  roundStartedAt: number
  /** The diff base the Codex review reads: origin/<base> before the PR, the last reviewed head after it. */
  diffBase: string
  evidence: Evidence[]
  /** Agent-step time and reviewer-wait time spent in this round so far. */
  activeMs: number
  waitMs: number
  /** Post-PR collection: when it started, when feedback last arrived, when gh was last polled. */
  collect?: { startedAt: number; lastArrivalAt: number; polledAt: number; headAt: number }
  /** Post-PR: the feedback ids handed to the main agent this round. */
  triaged?: string[]
```

Delete `PassRecord` (replaced by `LifecycleRecord`). `Role` gains `'triage'`:

```ts
export type Role = 'review' | 'challenge' | 'fix' | 'verify' | 'triage'
```

- [ ] **Step 2: Run the type check**

Run: `~/Projects/tasteslikegoodtheangularsvegancookbook/node_modules/.bin/tsc -p . --noEmit 2>&1 | head -40`
Expected: errors only in `hooks/register.tsx`, `hooks/core.ts` and `tests/gate.test.ts` where they use the removed fields (`maxRounds`, `advisory*`, `PassRecord`, `status: 'fixed'`, `source: 'review'`). These are fixed in Tasks 8–9; do not fix them here.

- [ ] **Step 3: Commit**

```bash
git add pr-lifecycle/types
git commit -m "pr-lifecycle: lifecycle record, round record and finding ledger types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

(`claude plugin test .` is red from here until Task 9; the type-only commit is deliberate so Tasks 3–8 can build the pure modules against these types.)

---

### Task 3: Budget policy (`lifecycle.ts`)

**Files:**
- Create: `pr-lifecycle/hooks/lifecycle.ts`
- Test: `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `LifecycleRecord`, `RoundRecord`, `Tier`, `Lane` (Task 2).
- Produces:
  ```ts
  export type Allowances = { standard: number; high: number }
  export function allowanceFor(tier: Tier, lane: Lane, a: Allowances): number
  export function usedRounds(rec: Pick<LifecycleRecord, 'rounds'>): number
  export function remaining(rec: Pick<LifecycleRecord, 'rounds' | 'allowance' | 'grants'>): number
  export function mayStartRound(rec: Pick<LifecycleRecord, 'rounds' | 'allowance' | 'grants'>, isAdvisory: boolean): boolean
  export function withRound(rec: LifecycleRecord, round: RoundRecord): LifecycleRecord
  export function rescope(rec: LifecycleRecord, tier: Tier, why: string, a: Allowances): LifecycleRecord
  export function newRecord(init: { root: string; branch: string; base: string; head: string; tier: Tier; tierWhy: string; lane: Lane; allowance: number; at: number }): LifecycleRecord
  export function roundOf(over: Partial<RoundRecord>): RoundRecord   // test and code helper with neutral defaults
  ```

- [ ] **Step 1: Write the failing tests**

`tests/lifecycle.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { allowanceFor, mayStartRound, newRecord, remaining, rescope, roundOf, usedRounds, withRound } from '../hooks/lifecycle'

const A = { standard: 4, high: 6 }
const fresh = () =>
  newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a', tier: 'standard', tierWhy: '10 lines', lane: 'full', allowance: 4, at: 1 })

test('the allowance follows the tier and the lane', async () => {
  expect(allowanceFor('trivial', 'full', A)).toBe(0)
  expect(allowanceFor('standard', 'full', A)).toBe(4)
  expect(allowanceFor('high', 'full', A)).toBe(6)
  expect(allowanceFor('high', 'light', A)).toBe(1)
})

test('only completed discretionary rounds use the allowance', async () => {
  let rec = fresh()
  rec = withRound(rec, roundOf({ n: 1, kind: 'discretionary', isCompleted: true }))
  rec = withRound(rec, roundOf({ n: 2, kind: 'discretionary', isCompleted: false, activeMs: 60_000 }))
  rec = withRound(rec, roundOf({ n: 3, kind: 'baseline', phase: 'post', isCompleted: true }))
  rec = withRound(rec, roundOf({ n: 4, kind: 'final-head-check', phase: 'post', isCompleted: true }))
  expect(usedRounds(rec)).toBe(1)
  expect(remaining(rec)).toBe(3)
  // The incomplete attempt is recorded with its effort.
  expect(rec.attempts).toBe(1)
  expect(rec.activeMs).toBe(60_000)
})

test('an advisory-only round needs a round left over afterwards; a blocking one needs one', async () => {
  let rec = { ...fresh(), allowance: 2 }
  expect(mayStartRound(rec, true)).toBe(true)
  rec = withRound(rec, roundOf({ n: 1, kind: 'discretionary', isCompleted: true }))
  expect(mayStartRound(rec, true)).toBe(false)
  expect(mayStartRound(rec, false)).toBe(true)
})

test('grants from the person add rounds', async () => {
  const rec = { ...fresh(), allowance: 0, grants: [{ n: 2, reason: 'odd change', head: 'a', at: 2 }] }
  expect(remaining(rec)).toBe(2)
})

test('a rescope raises the allowance to the new tier and keeps history; it never lowers it', async () => {
  let rec = withRound(fresh(), roundOf({ n: 1, kind: 'discretionary', isCompleted: true }))
  rec = rescope(rec, 'high', 'touches auth/', A)
  expect(rec.tier).toBe('high')
  expect(rec.allowance).toBe(6)
  expect(rec.rounds).toHaveLength(1)
  expect(remaining(rec)).toBe(5)
  rec = rescope(rec, 'standard', 'smaller now', A)
  expect(rec.tier).toBe('high')
  expect(rec.allowance).toBe(6)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: `tests/lifecycle.test.ts` fails to import `../hooks/lifecycle`.

- [ ] **Step 3: Implement**

`hooks/lifecycle.ts`:

```ts
// The lifecycle's pure half: the budget, the finding ledger, coverage, and
// the controller's choice of what comes next. No `$` here.

import type { Lane, LifecycleRecord, RoundRecord, Tier } from '../types'

// ----------------------------------------------------------------- budget

export type Allowances = { standard: number; high: number }

const TIERS: readonly Tier[] = ['trivial', 'standard', 'high']

/** Discretionary rounds a lifecycle may complete: by tier, one on the light lane, none for a pass-through. */
export function allowanceFor(tier: Tier, lane: Lane, a: Allowances): number {
  if (tier === 'trivial') return 0
  if (lane === 'light') return 1
  return tier === 'high' ? a.high : a.standard
}

/** Completed discretionary rounds: baseline rounds, final-head checks and incomplete attempts use nothing. */
export const usedRounds = (rec: Pick<LifecycleRecord, 'rounds'>): number =>
  rec.rounds.filter(one => one.isCompleted && one.kind === 'discretionary').length

type Budgeted = Pick<LifecycleRecord, 'rounds' | 'allowance' | 'grants'>

export const remaining = (rec: Budgeted): number =>
  Math.max(0, rec.allowance + rec.grants.reduce((sum, one) => sum + one.n, 0) - usedRounds(rec))

/** A blocking round needs one round left; an advisory-only one needs one more after itself (the reserve rule). */
export const mayStartRound = (rec: Budgeted, isAdvisory: boolean): boolean => remaining(rec) >= (isAdvisory ? 2 : 1)

/** Records a round or an incomplete attempt, with its effort; history is only ever appended. */
export function withRound(rec: LifecycleRecord, round: RoundRecord): LifecycleRecord {
  return {
    ...rec,
    rounds: [...rec.rounds, round],
    attempts: rec.attempts + (round.isCompleted ? 0 : 1),
    activeMs: rec.activeMs + round.activeMs,
    waitMs: rec.waitMs + round.waitMs,
    updatedAt: Math.max(rec.updatedAt, round.endedAt),
  }
}

/** A materially wider change: the tier and allowance only go up, and the rounds already run still count. */
export function rescope(rec: LifecycleRecord, tier: Tier, why: string, a: Allowances): LifecycleRecord {
  if (TIERS.indexOf(tier) <= TIERS.indexOf(rec.tier)) return rec
  return { ...rec, tier, tierWhy: why, allowance: Math.max(rec.allowance, allowanceFor(tier, rec.lane, a)) }
}

export function newRecord(init: {
  root: string
  branch: string
  base: string
  head: string
  tier: Tier
  tierWhy: string
  lane: Lane
  allowance: number
  at: number
}): LifecycleRecord {
  const { at, ...rest } = init
  return {
    version: 1,
    ...rest,
    grants: [],
    attempts: 0,
    activeMs: 0,
    waitMs: 0,
    rounds: [],
    findings: [],
    processed: [],
    replies: {},
    waivers: [],
    phase: 'pre',
    updatedAt: at,
  }
}

export const roundOf = (over: Partial<RoundRecord>): RoundRecord => ({
  n: 1,
  phase: 'pre',
  kind: 'discretionary',
  isAdvisory: false,
  startHead: 'a',
  endHead: 'a',
  isCompleted: true,
  evidence: [],
  raised: { blocking: 0, advisory: 0 },
  rebutted: 0,
  deferredBlocking: 0,
  activeMs: 0,
  waitMs: 0,
  startedAt: 0,
  endedAt: 0,
  ...over,
})
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: the 5 tests in `tests/lifecycle.test.ts` pass (`gate.test.ts` is still red from Task 2).

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/tests/lifecycle.test.ts
git commit -m "pr-lifecycle: shared review allowance with the reserve rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 4: Finding ledger and triage (`lifecycle.ts`)

**Files:**
- Modify: `pr-lifecycle/hooks/lifecycle.ts`
- Test: `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `Finding`, `FindingStatus`, `LifecycleRecord` (Task 2); `isBlocking` from `hooks/core.ts`.
- Produces:
  ```ts
  export type Answer = { id: string; action: 'fixed' | 'rebutted' | 'deferred'; note?: string; evidence?: string; severity?: Severity; isSecurity?: boolean }
  export function applyAnswer(f: Finding, a: Answer, round: number, by: string, at: number): Finding
  export function markVerified(f: Finding, round: number, by: string, at: number, note?: string): Finding
  export function markHeld(f: Finding, round: number, by: string, at: number, note?: string): Finding
  export function mergeFindings(kept: readonly Finding[], changed: readonly Finding[]): Finding[]
  export type TriageClass = 'duplicate' | 'new-on-reviewed' | 'new-on-changed'
  export function triage(item: { file?: string; line?: number; title: string }, findings: readonly Finding[], changedFiles: ReadonlySet<string>): { cls: TriageClass; matchId?: string }
  export function unresolvedBlockers(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[]
  export function verificationOwed(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[]
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lifecycle.test.ts` (and add `applyAnswer, markHeld, markVerified, mergeFindings, triage, unresolvedBlockers, verificationOwed` to the import):

```ts
import type { Finding } from '../types'

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'R1-1',
  round: 1,
  source: 'codex-review',
  reviewer: 'codex',
  severity: 'P1',
  title: 'Unvalidated redirect in login',
  file: 'src/app.ts',
  line: 12,
  headSeen: 'a',
  status: 'open',
  history: [],
  ...over,
})

test('the fixer reports a fix; only a check verifies it', async () => {
  const reported = applyAnswer(finding(), { id: 'R1-1', action: 'fixed', note: 'allow-list' }, 1, 'main', 5)
  expect(reported.status).toBe('reported-fixed')
  expect(reported.history.at(-1)).toEqual({ round: 1, status: 'reported-fixed', note: 'allow-list', by: 'main', at: 5 })
  expect(markVerified(reported, 2, 'codex', 6).status).toBe('verified-fixed')
  expect(markHeld(reported, 2, 'codex', 6, 'still reachable').status).toBe('open')
})

test('merging a later review never changes a finding it left out', async () => {
  const old = [finding({ status: 'reported-fixed' }), finding({ id: 'R1-2', status: 'open', severity: 'P2' })]
  const merged = mergeFindings(old, [finding({ id: 'R2-1', round: 2, title: 'Something else' })])
  expect(merged.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'reported-fixed'],
    ['R1-2', 'open'],
    ['R2-1', 'open'],
  ])
})

test('triage tells a duplicate of an answered finding from new claims', async () => {
  const answered = [finding({ status: 'rebutted', note: 'the redirect is checked at src/app.ts:9' })]
  const same = { file: 'src/app.ts', line: 14, title: 'Unvalidated redirect in the login handler' }
  expect(triage(same, answered, new Set())).toEqual({ cls: 'duplicate', matchId: 'R1-1' })
  // The file changed since the answer: the evidence may not hold, so it is a new claim on changed code.
  expect(triage(same, answered, new Set(['src/app.ts'])).cls).toBe('new-on-changed')
  // A different claim about reviewed code is handled on its merits.
  expect(triage({ file: 'src/app.ts', line: 40, title: 'SQL built by string concatenation' }, answered, new Set()).cls).toBe('new-on-reviewed')
  // A finding needing a recheck is never a duplicate.
  expect(triage(same, [{ ...answered[0]!, needsRecheck: true }], new Set()).cls).toBe('new-on-reviewed')
})

test('unresolved blockers: open ones, and a deferred security P1, unless the person waived it', async () => {
  const findings = [
    finding({ id: 'A', status: 'open' }),
    finding({ id: 'B', status: 'deferred', isSecurity: true }),
    finding({ id: 'C', status: 'deferred' }),
    finding({ id: 'D', status: 'open', severity: 'P3' }),
    finding({ id: 'E', status: 'reported-fixed' }),
  ]
  expect(unresolvedBlockers({ findings, waivers: [] }).map(one => one.id)).toEqual(['A', 'B'])
  const waivers = [{ scope: 'finding' as const, findingId: 'B', head: 'a', reason: 'accepted', by: 'person', at: 1 }]
  expect(unresolvedBlockers({ findings, waivers }).map(one => one.id)).toEqual(['A'])
  expect(verificationOwed({ findings, waivers: [] }).map(one => one.id)).toEqual(['E'])
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL, `applyAnswer` (and the rest) not exported.

- [ ] **Step 3: Implement**

Append to `hooks/lifecycle.ts` (add `isBlocking` import from `./core` and `Finding, FindingStatus, Severity` to the type import):

```ts
// ----------------------------------------------------------------- ledger

export type Answer = {
  id: string
  action: 'fixed' | 'rebutted' | 'deferred'
  note?: string
  evidence?: string
  severity?: Severity
  isSecurity?: boolean
}

const moved = (f: Finding, status: FindingStatus, round: number, by: string, at: number, note?: string, evidence?: string): Finding => ({
  ...f,
  status,
  note: note ?? f.note,
  needsRecheck: undefined,
  history: [
    ...f.history,
    { round, status, ...(note === undefined ? {} : { note }), ...(evidence === undefined ? {} : { evidence }), by, at },
  ],
})

/** The fixer's word: fixed is only reported until a check confirms it. */
export function applyAnswer(f: Finding, a: Answer, round: number, by: string, at: number): Finding {
  const status: FindingStatus = a.action === 'fixed' ? 'reported-fixed' : a.action
  const next = moved(f, status, round, by, at, a.note, a.evidence)
  return {
    ...next,
    ...(a.severity === undefined ? {} : { severity: a.severity }),
    ...(a.isSecurity === undefined ? {} : { isSecurity: a.isSecurity }),
  }
}

/** A check confirmed the fix: the verify step, a reviewer saying so, or Codex conceding it. */
export const markVerified = (f: Finding, round: number, by: string, at: number, note?: string): Finding =>
  moved(f, 'verified-fixed', round, by, at, note)

/** A reviewer holds the finding against the fix or rebuttal: it is unresolved again. */
export const markHeld = (f: Finding, round: number, by: string, at: number, note?: string): Finding => moved(f, 'open', round, by, at, note)

/** The ledger after a round: changed findings replace theirs by id, new ones are appended, nothing else moves. */
export function mergeFindings(kept: readonly Finding[], changed: readonly Finding[]): Finding[] {
  const byId = new Map(changed.map(one => [one.id, one]))
  const out = kept.map(one => byId.get(one.id) ?? one)
  for (const one of changed) if (!kept.some(each => each.id === one.id)) out.push(one)
  return out
}

export type TriageClass = 'duplicate' | 'new-on-reviewed' | 'new-on-changed'

const words = (title: string): Set<string> => new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(one => one.length > 2))

/** Whether two findings name the same problem: same file, nearby line, mostly the same words. */
function isSame(a: { file?: string; line?: number; title: string }, b: { file?: string; line?: number; title: string }): boolean {
  if (a.file !== b.file) return false
  if (a.line !== undefined && b.line !== undefined && Math.abs(a.line - b.line) > 5) return false
  const x = words(a.title)
  const y = words(b.title)
  const shared = [...x].filter(one => y.has(one)).length
  return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.5
}

const ANSWERED: readonly FindingStatus[] = ['reported-fixed', 'verified-fixed', 'rebutted', 'deferred']

/** Where incoming feedback stands against the ledger. Prior review can make it a duplicate, never dismiss a new claim. */
export function triage(
  item: { file?: string; line?: number; title: string },
  findings: readonly Finding[],
  changedFiles: ReadonlySet<string>,
): { cls: TriageClass; matchId?: string } {
  if (item.file !== undefined && changedFiles.has(item.file)) return { cls: 'new-on-changed' }
  const match = findings.find(one => ANSWERED.includes(one.status) && one.needsRecheck !== true && isSame(one, item))
  return match === undefined ? { cls: 'new-on-reviewed' } : { cls: 'duplicate', matchId: match.id }
}

const waivedIds = (rec: Pick<LifecycleRecord, 'waivers'>): Set<string> =>
  new Set(rec.waivers.filter(one => one.scope === 'finding' && one.findingId !== undefined).map(one => one.findingId as string))

/** Blockers nobody settled: open ones, and a deferred security P1, which only the person's waiver settles. */
export function unresolvedBlockers(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(
    one => isBlocking(one) && !waived.has(one.id) && (one.status === 'open' || (one.status === 'deferred' && one.isSecurity === true)),
  )
}

/** Blockers the fixer reported fixed that no check has confirmed yet. */
export function verificationOwed(rec: Pick<LifecycleRecord, 'findings' | 'waivers'>): Finding[] {
  const waived = waivedIds(rec)
  return rec.findings.filter(one => isBlocking(one) && !waived.has(one.id) && one.status === 'reported-fixed')
}
```

`isBlocking` in `core.ts` takes `Pick<Finding, 'severity'>`, so it accepts the new `Finding` unchanged.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: the 4 new tests pass, with the 5 from Task 3.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/tests/lifecycle.test.ts
git commit -m "pr-lifecycle: finding ledger with explicit dispositions and feedback triage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 5: Coverage and the controller decision (`lifecycle.ts`)

**Files:**
- Modify: `pr-lifecycle/hooks/lifecycle.ts`
- Test: `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces:
  ```ts
  export function lastReviewedHead(rec: Pick<LifecycleRecord, 'rounds'>): string | undefined
  export function invalidate(findings: readonly Finding[], changedFiles: ReadonlySet<string> | 'all'): Finding[]
  export type Next =
    | { kind: 'round'; phase: 'pre' | 'post'; roundKind: RoundKind; isAdvisory: boolean; scope: 'full' | 'delta' }
    | { kind: 'open-pr'; status: 'passed' | 'exhausted' }
    | { kind: 'ready' }
    | { kind: 'exhausted'; why: string; nextStep: string }
    | { kind: 'blocked'; why: string; nextStep: string }
  export function decideNext(rec: LifecycleRecord): Next
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lifecycle.test.ts` (import `decideNext, invalidate, lastReviewedHead`):

```ts
const pre = (over: Partial<Parameters<typeof roundOf>[0]> = {}) => roundOf({ phase: 'pre', kind: 'discretionary', ...over })
const post = (over: Partial<Parameters<typeof roundOf>[0]> = {}) => roundOf({ phase: 'post', kind: 'baseline', ...over })
const at = (rounds: ReturnType<typeof roundOf>[], over: object = {}) => ({ ...fresh(), rounds, ...over })

test('pre-PR: nothing raised opens the PR; a blocker with allowance left runs another round', async () => {
  expect(decideNext(at([]))).toEqual({ kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' })
  expect(decideNext(at([pre()]))).toEqual({ kind: 'open-pr', status: 'passed' })
  // A commit after the pass is a new head: it is reviewed again.
  expect(decideNext(at([pre()], { head: 'z' }))).toMatchObject({ kind: 'round', phase: 'pre' })
  const blocked = pre({ raised: { blocking: 1, advisory: 0 }, endHead: 'b' })
  expect(decideNext(at([blocked]))).toMatchObject({ kind: 'round', phase: 'pre', isAdvisory: false })
  expect(decideNext(at([blocked, blocked, blocked, blocked]))).toEqual({ kind: 'open-pr', status: 'exhausted' })
})

test('pre-PR: a pass-through with no allowance opens the PR without a round', async () => {
  expect(decideNext(at([], { allowance: 0, tier: 'trivial', passThrough: 'docs only' }))).toEqual({ kind: 'open-pr', status: 'passed' })
})

test('pre-PR: advisories go back to Codex only after new commits and while the reserve holds', async () => {
  const fixedAdvisories = pre({ raised: { blocking: 0, advisory: 2 }, endHead: 'b' })
  expect(decideNext(at([fixedAdvisories]))).toMatchObject({ kind: 'round', isAdvisory: true })
  const rebuttedOnly = pre({ raised: { blocking: 0, advisory: 2 }, rebutted: 2 })
  expect(decideNext(at([rebuttedOnly]))).toEqual({ kind: 'open-pr', status: 'passed' })
  expect(decideNext(at([pre(), pre(), pre(), fixedAdvisories]))).toEqual({ kind: 'open-pr', status: 'passed' })
})

test('pre-PR: a deferred blocker or a fixer who did nothing blocks for a decision', async () => {
  expect(decideNext(at([pre({ raised: { blocking: 1, advisory: 0 }, deferredBlocking: 1, endHead: 'b' })])).kind).toBe('blocked')
  expect(decideNext(at([pre({ raised: { blocking: 1, advisory: 0 } })])).kind).toBe('blocked')
})

test('post-PR baseline: round 1 always, round 2 only when round 1 changed the head', async () => {
  const opened = { phase: 'post' as const }
  expect(decideNext(at([pre()], opened))).toEqual({ kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' })
  expect(decideNext(at([pre(), post()], opened))).toEqual({ kind: 'ready' })
  expect(decideNext(at([pre(), post({ endHead: 'b' })], opened))).toMatchObject({ kind: 'round', roundKind: 'baseline' })
})

test('post-PR: the baseline runs even with the allowance spent', async () => {
  const spent = [pre(), pre(), pre(), pre({ raised: { blocking: 1, advisory: 0 }, endHead: 'b' })]
  expect(decideNext(at(spent, { phase: 'post' }))).toMatchObject({ kind: 'round', roundKind: 'baseline' })
})

test('post-PR: an unreviewed head after the baseline gets a discretionary round, or the final-head check when spent', async () => {
  const baseline = [post({ endHead: 'b' }), post({ n: 2, startHead: 'b', endHead: 'c' })]
  expect(decideNext(at(baseline, { phase: 'post' }))).toMatchObject({ kind: 'round', roundKind: 'discretionary', scope: 'full' })
  expect(decideNext(at(baseline, { phase: 'post', allowance: 0 }))).toMatchObject({ kind: 'round', roundKind: 'final-head-check', scope: 'delta' })
})

test('post-PR: the final-head check never certifies a head it did not review clean', async () => {
  const check = post({ n: 3, kind: 'final-head-check', startHead: 'c', endHead: 'c', raised: { blocking: 1, advisory: 0 } })
  const rec = at([post({ endHead: 'b' }), post({ n: 2, startHead: 'b', endHead: 'c' }), check], {
    phase: 'post',
    allowance: 0,
    findings: [finding({ id: 'R3-1', round: 3, status: 'open' })],
  })
  expect(decideNext(rec).kind).toBe('exhausted')
})

test('post-PR: a reported fix owed verification keeps the lifecycle from ready', async () => {
  const rec = at([post()], { phase: 'post', findings: [finding({ status: 'reported-fixed' })] })
  expect(decideNext(rec)).toMatchObject({ kind: 'round' })
})

test('coverage: a change touching a file flags only the answered findings in it', async () => {
  const findings = [finding({ status: 'rebutted' }), finding({ id: 'R1-2', file: 'src/other.ts', status: 'rebutted' }), finding({ id: 'R1-3', status: 'open' })]
  expect(invalidate(findings, new Set(['src/app.ts'])).map(one => one.needsRecheck === true)).toEqual([true, false, false])
  // A rebase that lost the reviewed commit: every answered finding is rechecked.
  expect(invalidate(findings, 'all').map(one => one.needsRecheck === true)).toEqual([true, true, false])
  expect(lastReviewedHead({ rounds: [pre({ endHead: 'b' }), pre({ isCompleted: false, endHead: 'z' })] })).toBe('b')
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL, `decideNext` not exported.

- [ ] **Step 3: Implement**

Append to `hooks/lifecycle.ts` (add `RoundKind` to the type import):

```ts
// --------------------------------------------------------------- coverage

/** The head the last completed round left behind: what review evidence covers. */
export const lastReviewedHead = (rec: Pick<LifecycleRecord, 'rounds'>): string | undefined =>
  rec.rounds.filter(one => one.isCompleted).at(-1)?.endHead

/** Answered findings whose file changed: their evidence must be checked again. History stays. */
export function invalidate(findings: readonly Finding[], changedFiles: ReadonlySet<string> | 'all'): Finding[] {
  return findings.map(one =>
    one.status !== 'open' && (changedFiles === 'all' || (one.file !== undefined && changedFiles.has(one.file))) ? { ...one, needsRecheck: true } : one,
  )
}

// --------------------------------------------------------------- the next step

export type Next =
  | { kind: 'round'; phase: 'pre' | 'post'; roundKind: RoundKind; isAdvisory: boolean; scope: 'full' | 'delta' }
  | { kind: 'open-pr'; status: 'passed' | 'exhausted' }
  | { kind: 'ready' }
  | { kind: 'exhausted'; why: string; nextStep: string }
  | { kind: 'blocked'; why: string; nextStep: string }

const ids = (findings: readonly Finding[]): string => findings.map(one => one.id).join(', ')

function decidePre(rec: LifecycleRecord): Next {
  const last = rec.rounds.filter(one => one.phase === 'pre' && one.isCompleted).at(-1)
  if (last === undefined) {
    return rec.allowance + rec.grants.reduce((sum, one) => sum + one.n, 0) > 0
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'open-pr', status: 'passed' }
  }
  // Commits since the last completed round: the new head needs its own review.
  if (rec.head !== last.endHead) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'open-pr', status: 'exhausted' }
  }
  const isChanged = last.endHead !== last.startHead
  if (last.deferredBlocking > 0) {
    return { kind: 'blocked', why: 'a blocking finding was deferred: its fix reaches past this branch', nextStep: '/pr-gate waive <findingId> <reason>, or widen the branch and run /pr-gate' }
  }
  if (last.raised.blocking === 0) {
    // Advisories go back to Codex only for new commits, and only while a round stays in reserve.
    return last.raised.advisory > 0 && isChanged && mayStartRound(rec, true)
      ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: true, scope: 'full' }
      : { kind: 'open-pr', status: 'passed' }
  }
  if (!isChanged && last.rebutted === 0) {
    return { kind: 'blocked', why: 'the fixer changed nothing and rebutted nothing, so another round would say the same', nextStep: 'fix or rebut the open findings, then /pr-gate resume' }
  }
  return mayStartRound(rec, false)
    ? { kind: 'round', phase: 'pre', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
    : { kind: 'open-pr', status: 'exhausted' }
}

function decidePost(rec: LifecycleRecord): Next {
  const done = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)
  const last = done.at(-1)
  if (last === undefined) return { kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' }
  const isChanged = last.endHead !== last.startHead
  const unresolved = unresolvedBlockers(rec)
  const owed = verificationOwed(rec)
  if (last.kind === 'final-head-check') {
    if (!isChanged && unresolved.length === 0 && owed.length === 0) return { kind: 'ready' }
    return {
      kind: 'exhausted',
      why: unresolved.length > 0 ? `${ids(unresolved)} unresolved at ${last.endHead.slice(0, 7)}` : `${last.endHead.slice(0, 7)} is not reviewed clean`,
      nextStep: unresolved.length > 0 ? `fix ${unresolved[0]?.id} and push, /pr-gate waive ${unresolved[0]?.id} <reason>, or /pr-gate allow 1 <reason>` : '/pr-gate allow 1 <reason>',
    }
  }
  // The protected baseline: a second round whenever the first one changed the head, by anyone.
  if (done.length === 1 && isChanged) return { kind: 'round', phase: 'post', roundKind: 'baseline', isAdvisory: false, scope: 'full' }
  if (isChanged || owed.length > 0) {
    return mayStartRound(rec, false)
      ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
      : { kind: 'round', phase: 'post', roundKind: 'final-head-check', isAdvisory: false, scope: 'delta' }
  }
  if (unresolved.length === 0) return { kind: 'ready' }
  if (unresolved.some(one => one.status === 'deferred')) {
    return { kind: 'blocked', why: `${ids(unresolved)} deferred, and a security P1 needs your decision`, nextStep: `/pr-gate waive ${unresolved[0]?.id} <reason>` }
  }
  return mayStartRound(rec, false)
    ? { kind: 'round', phase: 'post', roundKind: 'discretionary', isAdvisory: false, scope: 'full' }
    : { kind: 'exhausted', why: `${ids(unresolved)} unresolved and the review allowance is spent`, nextStep: `fix ${unresolved[0]?.id} and push, /pr-gate waive ${unresolved[0]?.id} <reason>, or /pr-gate allow 1 <reason>` }
}

/** What the controller does after a round, from the record alone. Exhaustion is never a pass. */
export function decideNext(rec: LifecycleRecord): Next {
  if (rec.phase === 'ready') return { kind: 'ready' }
  return rec.phase === 'pre' ? decidePre(rec) : decidePost(rec)
}
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: all `lifecycle.test.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/tests/lifecycle.test.ts
git commit -m "pr-lifecycle: coverage and the controller decision, with the protected post-PR baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 6: GitHub feedback, checks, roster and collection end (`github.ts`)

**Files:**
- Create: `pr-lifecycle/hooks/github.ts`
- Test: `pr-lifecycle/tests/github.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Feedback = { id: string; kind: 'review' | 'inline' | 'comment'; reviewer: string; body: string; head?: string; file?: string; line?: number; threadId?: string; url?: string; state?: string; at: number; isFinding: boolean }
  export type Check = { name: string; status: string; conclusion: string | null }
  export type Roster = { reviewers: string[]; checks: string[]; requestReview: string[]; quietMinutes?: number; waitCapMinutes?: number }
  export function readJsonList(text: string): unknown[]          // gh --paginate output, `][` joined
  export function readReviews(text: string): Feedback[]
  export function readInlineComments(text: string): Feedback[]
  export function readIssueComments(text: string): Feedback[]
  export function readCheckRuns(text: string): Check[]
  export function readRoster(text: string): Roster | undefined
  export function severityHint(body: string): { severity: Severity; isSecurity: boolean }
  export type CollectInput = { roster?: Roster; feedback: readonly Feedback[]; checks: readonly Check[]; head: string; headAt: number; startedAt: number; lastArrivalAt: number; now: number; quietMs: number; capMs: number }
  export function collectionDone(input: CollectInput): { isDone: boolean; isComplete: boolean; missing: string[]; covered: string[] }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/github.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { collectionDone, readCheckRuns, readInlineComments, readIssueComments, readJsonList, readReviews, readRoster, severityHint } from '../hooks/github'

const at = (iso: string) => Date.parse(iso)

test('paginated gh output is read as one list', async () => {
  expect(readJsonList('[{"id":1}]\n[{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  expect(readJsonList('')).toEqual([])
  expect(readJsonList('not json')).toEqual([])
})

test('reviews, inline comments and issue comments become feedback with stable ids', async () => {
  const reviews = readReviews(JSON.stringify([
    { id: 7, user: { login: 'copilot-pull-request-reviewer[bot]' }, body: 'Looks fine', state: 'COMMENTED', commit_id: 'b', submitted_at: '2026-10-16T10:00:00Z', html_url: 'u' },
    { id: 8, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: 'b', submitted_at: '2026-10-16T10:01:00Z' },
  ]))
  expect(reviews.map(one => [one.id, one.reviewer, one.head, one.isFinding])).toEqual([
    ['review:7', 'copilot-pull-request-reviewer[bot]', 'b', true],
    ['review:8', 'claude[bot]', 'b', false],
  ])
  const inline = readInlineComments(JSON.stringify([
    { id: 11, user: { login: 'claude[bot]' }, body: '**P1** SQL injection', path: 'src/db.ts', line: 4, commit_id: 'b', created_at: '2026-10-16T10:02:00Z', html_url: 'u2' },
    { id: 12, user: { login: 'me' }, body: 'Fixed in c', path: 'src/db.ts', line: 4, in_reply_to_id: 11, commit_id: 'b', created_at: '2026-10-16T10:03:00Z' },
  ]))
  expect(inline[0]).toMatchObject({ id: 'inline:11', file: 'src/db.ts', line: 4, threadId: '11', isFinding: true, at: at('2026-10-16T10:02:00Z') })
  expect(inline[1]).toMatchObject({ id: 'inline:12', threadId: '11' })
  const comments = readIssueComments(JSON.stringify([{ id: 21, user: { login: 'rovo[bot]' }, body: 'nit: typo', created_at: '2026-10-16T10:04:00Z' }]))
  expect(comments[0]).toMatchObject({ id: 'comment:21', reviewer: 'rovo[bot]', head: undefined, isFinding: true })
})

test('check runs and the roster file are read; a bad roster is ignored', async () => {
  expect(readCheckRuns(JSON.stringify({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }))).toEqual([
    { name: 'ci', status: 'completed', conclusion: 'success' },
  ])
  expect(readRoster('{"reviewers":["claude[bot]"],"checks":["ci"],"quietMinutes":2}')).toEqual({
    reviewers: ['claude[bot]'],
    checks: ['ci'],
    requestReview: [],
    quietMinutes: 2,
  })
  expect(readRoster('{')).toBeUndefined()
  expect(readRoster('')).toBeUndefined()
})

test('a severity is read from the reviewer\'s own words, P2 when it says none', async () => {
  expect(severityHint('**P1** SQL injection')).toEqual({ severity: 'P1', isSecurity: true })
  expect(severityHint('Critical: crashes on empty input')).toEqual({ severity: 'P1', isSecurity: false })
  expect(severityHint('nit: typo')).toEqual({ severity: 'P3', isSecurity: false })
  expect(severityHint('Consider renaming')).toEqual({ severity: 'P2', isSecurity: false })
})

const base = { head: 'b', headAt: 0, startedAt: 0, lastArrivalAt: 0, quietMs: 180_000, capMs: 1_200_000 }
const fb = (reviewer: string, head?: string, when = 10) => ({ id: `review:${reviewer}`, kind: 'review' as const, reviewer, body: '', head, at: when, isFinding: false })

test('with a roster, collection ends once every listed reviewer covered the head and every listed check finished', async () => {
  const roster = { reviewers: ['claude[bot]', 'copilot'], checks: ['ci'], requestReview: [] }
  const checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b')], checks, now: 60_000 })).toMatchObject({ isDone: false, missing: ['copilot'] })
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('copilot', 'b')], checks, now: 60_000 })).toMatchObject({ isDone: true, isComplete: true })
  // A review of an older head does not cover this one.
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('copilot', 'a')], checks, now: 60_000 }).isDone).toBe(false)
})

test('without a roster, collection ends when checks are done and feedback has gone quiet', async () => {
  const running = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  const done = [{ name: 'ci', status: 'completed', conclusion: 'failure' }]
  expect(collectionDone({ ...base, feedback: [], checks: running, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 500_000, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 400_000, now: 600_000 })).toMatchObject({ isDone: true, isComplete: true })
})

test('the wait cap ends collection with what arrived, marked incomplete', async () => {
  const roster = { reviewers: ['copilot'], checks: [], requestReview: [] }
  expect(collectionDone({ ...base, roster, feedback: [], checks: [], now: 1_200_000 })).toEqual({ isDone: true, isComplete: false, missing: ['copilot'], covered: [] })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL, `../hooks/github` not found.

- [ ] **Step 3: Implement**

`hooks/github.ts`:

```ts
// GitHub's half, pure: what `gh api` printed, read as feedback and checks; the
// per-repo roster; when collection is over; and which calls open or merge a PR.

import type { Severity } from '../types'

export type Feedback = {
  /** `review:<id>`, `inline:<id>` or `comment:<id>`: stable across polls and sessions. */
  id: string
  kind: 'review' | 'inline' | 'comment'
  reviewer: string
  body: string
  /** The commit it reviewed, when GitHub says. */
  head?: string
  file?: string
  line?: number
  /** For an inline comment: the id of the thread's first comment, to reply to. */
  threadId?: string
  url?: string
  state?: string
  at: number
  /** False for an empty approval or comment: it covers a head but raises nothing. */
  isFinding: boolean
}

export type Check = { name: string; status: string; conclusion: string | null }

export type Roster = { reviewers: string[]; checks: string[]; requestReview: string[]; quietMinutes?: number; waitCapMinutes?: number }

type Row = Record<string, unknown>

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const login = (row: Row): string => str((row.user as Row | undefined)?.login) ?? 'unknown'
const when = (value: unknown): number => {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/** `gh api --paginate` prints one JSON array per page; reads them as one list, or none when it is not JSON. */
export function readJsonList(text: string): unknown[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  try {
    const parsed: unknown = JSON.parse(`[${trimmed.replace(/\]\s*\[/g, '],[')}]`)
    return (parsed as unknown[]).flatMap(page => (Array.isArray(page) ? page : [page]))
  } catch {
    return []
  }
}

const rows = (text: string): Row[] => readJsonList(text).filter((one): one is Row => typeof one === 'object' && one !== null)

export const readReviews = (text: string): Feedback[] =>
  rows(text).map(row => {
    const body = str(row.body) ?? ''
    return {
      id: `review:${String(row.id)}`,
      kind: 'review',
      reviewer: login(row),
      body,
      head: str(row.commit_id),
      url: str(row.html_url),
      state: str(row.state),
      at: when(row.submitted_at),
      isFinding: body.trim() !== '' || row.state === 'CHANGES_REQUESTED',
    }
  })

export const readInlineComments = (text: string): Feedback[] =>
  rows(text).map(row => ({
    id: `inline:${String(row.id)}`,
    kind: 'inline',
    reviewer: login(row),
    body: str(row.body) ?? '',
    head: str(row.commit_id),
    file: str(row.path),
    line: num(row.line) ?? num(row.original_line),
    threadId: String(num(row.in_reply_to_id) ?? row.id),
    url: str(row.html_url),
    at: when(row.created_at),
    isFinding: (str(row.body) ?? '').trim() !== '',
  }))

export const readIssueComments = (text: string): Feedback[] =>
  rows(text).map(row => ({
    id: `comment:${String(row.id)}`,
    kind: 'comment',
    reviewer: login(row),
    body: str(row.body) ?? '',
    url: str(row.html_url),
    at: when(row.created_at),
    isFinding: (str(row.body) ?? '').trim() !== '',
  }))

export function readCheckRuns(text: string): Check[] {
  try {
    const parsed = JSON.parse(text) as { check_runs?: Row[] }
    return (parsed.check_runs ?? []).map(row => ({ name: String(row.name ?? ''), status: String(row.status ?? ''), conclusion: str(row.conclusion) ?? null }))
  } catch {
    return []
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [])

/** `.github/pr-gate.json`: who and what to wait for. A file that is not a JSON object is ignored. */
export function readRoster(text: string): Roster | undefined {
  if (text.trim() === '') return undefined
  try {
    const row = JSON.parse(text) as unknown
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
    const r = row as Row
    return {
      reviewers: strings(r.reviewers),
      checks: strings(r.checks),
      requestReview: strings(r.requestReview),
      ...(num(r.quietMinutes) === undefined ? {} : { quietMinutes: num(r.quietMinutes) }),
      ...(num(r.waitCapMinutes) === undefined ? {} : { waitCapMinutes: num(r.waitCapMinutes) }),
    }
  } catch {
    return undefined
  }
}

const SECURITY = /\b(security|injection|xss|csrf|ssrf|secret|credential|auth(entication|orization)? bypass|rce|path traversal)\b/i

/** The reviewer's own severity, when it gave one; the main agent can still change it. */
export function severityHint(body: string): { severity: Severity; isSecurity: boolean } {
  const isSecurity = SECURITY.test(body)
  const tagged = body.match(/\bP([0-3])\b/)?.[1]
  if (tagged !== undefined) return { severity: `P${tagged}` as Severity, isSecurity }
  if (/\b(critical|blocker|high)\b/i.test(body)) return { severity: 'P1', isSecurity }
  if (/\b(nit|nitpick|typo|minor)\b/i.test(body)) return { severity: 'P3', isSecurity }
  return { severity: isSecurity ? 'P1' : 'P2', isSecurity }
}

export type CollectInput = {
  roster?: Roster
  feedback: readonly Feedback[]
  checks: readonly Check[]
  head: string
  /** When the head was first seen: feedback with no commit counts for it from then on. */
  headAt: number
  startedAt: number
  lastArrivalAt: number
  now: number
  quietMs: number
  capMs: number
}

/** Whether a post-PR round has collected enough: the roster's list, or settled checks and a quiet spell; always the cap. */
export function collectionDone(input: CollectInput): { isDone: boolean; isComplete: boolean; missing: string[]; covered: string[] } {
  const covered = [
    ...new Set(input.feedback.filter(one => (one.head === undefined ? one.at >= input.headAt : one.head === input.head)).map(one => one.reviewer)),
  ]
  const finished = new Set(input.checks.filter(one => one.status === 'completed').map(one => one.name))
  const roster = input.roster
  const hasRoster = roster !== undefined && (roster.reviewers.length > 0 || roster.checks.length > 0)
  const missing = hasRoster
    ? [...roster.reviewers.filter(one => !covered.includes(one)), ...roster.checks.filter(one => !finished.has(one))]
    : input.checks.filter(one => one.status !== 'completed').map(one => one.name)
  const isQuiet = hasRoster || input.now - input.lastArrivalAt >= input.quietMs
  if (missing.length === 0 && isQuiet) return { isDone: true, isComplete: true, missing, covered }
  if (input.now - input.startedAt >= input.capMs) return { isDone: true, isComplete: missing.length === 0, missing, covered }
  return { isDone: false, isComplete: false, missing, covered }
}
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: all `github.test.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/tests/github.test.ts
git commit -m "pr-lifecycle: read GitHub feedback, checks and the per-repo roster; decide when collection ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 7: Every route that opens or merges a PR (`readPrAction`)

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts`
- Test: `pr-lifecycle/tests/github.test.ts`

**Interfaces:**
- Consumes: `readPrCreate`, `slugOf` from `hooks/core.ts`.
- Produces:
  ```ts
  export type PrAction = { action: 'create' | 'merge'; via: string; base?: string; head?: string; repo?: string; number?: number; cwd?: string; isUnknown?: boolean }
  export function readPrAction(tool: string, input: Record<string, unknown>): PrAction | undefined
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/github.test.ts` (import `readPrAction`):

```ts
const bash = (command: string) => readPrAction('Bash', { command })

test('gh pr create and gh pr merge, with and without a number or --auto', async () => {
  expect(bash('gh pr create --base dev --title x')).toMatchObject({ action: 'create', base: 'dev', via: 'gh pr create' })
  expect(bash('cd /repo && gh pr merge 12 --squash')).toMatchObject({ action: 'merge', number: 12, cwd: '/repo' })
  expect(bash('gh pr merge --auto --squash')).toMatchObject({ action: 'merge', number: undefined })
  expect(bash('gh pr merge https://github.com/me/repo/pull/9')).toMatchObject({ action: 'merge', number: 9 })
  expect(bash('gh pr view 12')).toBeUndefined()
})

test('gh api REST and GraphQL calls that open or merge a PR', async () => {
  expect(bash('gh api repos/me/repo/pulls -f base=dev -f head=feat/x -f title=t')).toMatchObject({ action: 'create', base: 'dev', head: 'feat/x', repo: 'me/repo' })
  expect(bash('gh api -X PUT repos/me/repo/pulls/12/merge')).toMatchObject({ action: 'merge', number: 12, repo: 'me/repo' })
  expect(bash("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash("gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"X\"}) { clientMutationId } }'")).toMatchObject({ action: 'merge' })
  expect(bash("gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'")).toMatchObject({ action: 'create' })
  // Reading pulls is not opening one.
  expect(bash('gh api repos/me/repo/pulls')).toBeUndefined()
  expect(bash('gh api repos/me/repo/pulls/12/comments')).toBeUndefined()
})

test('both GitHub MCP connectors', async () => {
  expect(readPrAction('mcp__plugin_github_github__create_pull_request', { owner: 'me', repo: 'repo', base: 'dev', head: 'feat/x' })).toMatchObject({
    action: 'create',
    base: 'dev',
    head: 'feat/x',
    repo: 'me/repo',
  })
  expect(readPrAction('mcp__plugin_github_github__merge_pull_request', { owner: 'me', repo: 'repo', pullNumber: 3 })).toMatchObject({ action: 'merge', number: 3 })
  const graphql = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
  expect(readPrAction(graphql, { action: 'create', repo: 'me/repo', base: 'dev', head: 'feat/x' })).toMatchObject({ action: 'create', base: 'dev' })
  expect(readPrAction(graphql, { action: 'merge', repo: 'me/repo', number: 4 })).toMatchObject({ action: 'merge', number: 4 })
  expect(readPrAction(graphql, { action: 'enqueue', repo: 'me/repo', number: 4 })).toMatchObject({ action: 'merge', number: 4 })
  expect(readPrAction(graphql, { action: 'get', repo: 'me/repo', number: 4 })).toBeUndefined()
})

test('an unknown GitHub tool that reads as opening or merging a PR is held; others are not', async () => {
  expect(readPrAction('mcp__someone_github__merge_pr', { n: 1 })).toMatchObject({ action: 'merge', isUnknown: true })
  expect(readPrAction('mcp__gh_tools__pulls', { method: 'create_pull_request' })).toBeUndefined()
  expect(readPrAction('mcp__acme-github__pulls', { method: 'create_pull_request' })).toMatchObject({ action: 'create', isUnknown: true })
  expect(readPrAction('mcp__acme-github__issues', { action: 'create' })).toBeUndefined()
  expect(readPrAction('Read', { file_path: 'merge.ts' })).toBeUndefined()
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL, `readPrAction` not exported.

- [ ] **Step 3: Implement**

Append to `hooks/github.ts` (add `import { readPrCreate } from './core'`):

```ts
// ----------------------------------------------------------- PR actions

export type PrAction = {
  action: 'create' | 'merge'
  /** How: a command or a tool name, for the refusal's words. */
  via: string
  base?: string
  head?: string
  /** owner/repo when the call names one. */
  repo?: string
  /** A merge's PR number; undefined means the PR of the checked-out branch. */
  number?: number
  cwd?: string
  /** A GitHub tool this mod does not know, held because it reads as opening or merging a PR. */
  isUnknown?: boolean
}

const cdOf = (command: string): string | undefined => command.match(/(?:^|&&|;)\s*cd\s+["']?([^\s"';&]+)/)?.[1]
const flagOf = (command: string, names: string): string | undefined =>
  command.match(new RegExp(`(?:^|\\s)(?:${names})(?:=|\\s+)["']?([^\\s"']+)`))?.[1]
const fieldOf = (command: string, name: string): string | undefined =>
  command.match(new RegExp(`(?:-f|-F|--field|--raw-field)\\s+["']?${name}=([^\\s"']+)`))?.[1]

function readBash(command: string): PrAction | undefined {
  const cwd = cdOf(command)
  const create = readPrCreate(command)
  if (create !== undefined) {
    return { action: 'create', via: 'gh pr create', base: create.base, repo: create.repo, cwd: create.cwd, head: flagOf(command, '--head|-H') }
  }
  const merge = command.match(/\bgh\s+pr\s+merge\b([^;&|]*)/)
  if (merge !== null) {
    const args = merge[1] ?? ''
    const number = args.match(/\/pull\/(\d+)/)?.[1] ?? args.match(/(?:^|\s)(\d+)(?=\s|$)/)?.[1]
    return { action: 'merge', via: 'gh pr merge', number: number === undefined ? undefined : Number(number), repo: flagOf(command, '--repo|-R'), cwd }
  }
  if (!/\bgh\s+api\b/.test(command)) return undefined
  if (/\bgraphql\b/.test(command)) {
    if (/\b(mergePullRequest|enqueuePullRequest|enablePullRequestAutoMerge)\b/.test(command)) return { action: 'merge', via: 'gh api graphql', cwd }
    if (/\bcreatePullRequest\b/.test(command)) return { action: 'create', via: 'gh api graphql', cwd }
    return undefined
  }
  const merged = command.match(/repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge\b/)
  if (merged !== null) return { action: 'merge', via: 'gh api', repo: merged[1], number: Number(merged[2]), cwd }
  const pulls = command.match(/repos\/([^/\s]+\/[^/\s]+)\/pulls(?=["'\s]|$)/)
  const method = (flagOf(command, '-X|--method') ?? '').toUpperCase()
  const hasFields = /(?:^|\s)(-f|-F|--field|--raw-field|--input)\s/.test(command)
  if (pulls !== null && (method === 'POST' || (method === '' && hasFields))) {
    return { action: 'create', via: 'gh api', repo: pulls[1], base: fieldOf(command, 'base'), head: fieldOf(command, 'head'), cwd }
  }
  return undefined
}

const GRAPHQL_MCP = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'

/** Whether a tool call opens or merges a pull request, on any route this mod can see. Unknown GitHub tools fail closed. */
export function readPrAction(tool: string, input: Record<string, unknown>): PrAction | undefined {
  if (tool === 'Bash') return typeof input.command === 'string' ? readBash(input.command) : undefined
  const owner = str(input.owner)
  const repoName = str(input.repo)
  const repo = owner !== undefined && repoName !== undefined ? `${owner}/${repoName}` : repoName
  if (tool === 'mcp__plugin_github_github__create_pull_request') {
    return { action: 'create', via: tool, base: str(input.base), head: str(input.head), repo }
  }
  if (tool === 'mcp__plugin_github_github__merge_pull_request') return { action: 'merge', via: tool, number: num(input.pullNumber), repo }
  if (tool === GRAPHQL_MCP) {
    const action = String(input.action ?? '')
    if (action === 'create') return { action: 'create', via: `${tool} (create)`, base: str(input.base), head: str(input.head), repo }
    if (action === 'merge' || action === 'enqueue') return { action: 'merge', via: `${tool} (${action})`, number: num(input.number), repo }
    return undefined
  }
  if (!tool.startsWith('mcp__') || !/github/i.test(tool)) return undefined
  const said = `${tool} ${String(input.action ?? input.method ?? input.operation ?? '')}`.toLowerCase()
  if (/merge|enqueue|auto[_\s-]?merge/.test(said)) return { action: 'merge', via: tool, number: num(input.number ?? input.pullNumber ?? input.pull_number), repo, isUnknown: true }
  if (/(create|open)[_\s-]*(pull|pr\b)/.test(said)) return { action: 'create', via: tool, base: str(input.base), head: str(input.head), repo, isUnknown: true }
  return undefined
}
```

Note `mcp__gh_tools__pulls` in the test has no `github` in its name and is deliberately not held: the fallback is scoped to tools whose name says GitHub, so unrelated tools are never caught.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: all `github.test.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/tests/github.test.ts
git commit -m "pr-lifecycle: one classifier for every route that opens or merges a PR

Covers gh pr create/merge, gh api REST and GraphQL, both GitHub MCP
connectors (github-graphql-mcp manage_pull_requests included), and holds
unknown GitHub tools that read as opening or merging a PR.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 8: History-aware prompts and the verified/held trailer (`core.ts`)

**Files:**
- Modify: `pr-lifecycle/hooks/core.ts`
- Test: `pr-lifecycle/tests/lifecycle.test.ts` (prompt and reader tests live with the pure tests)

**Interfaces:**
- Consumes: `Finding` (Task 2), `Feedback` (Task 6), `LifecycleRecord`, `Next` (Task 5).
- Produces:
  ```ts
  export const TRAILER = 'PR_GATE_RESULT'   // renamed from CODEX_GATE_RESULT
  export type ReviewResult = { gate: ReviewGate; findings: ...; note?: string; failure?: ReviewFailure; verified: string[]; held: string[] }
  export function readDispositions(answer: string): Answer[]   // Answer from lifecycle.ts; now also reads severity, isSecurity, evidence, replyId, duplicateOf
  export type TriageAnswer = Answer & { replyId?: string; duplicateOf?: string }
  export function readTriage(answer: string): TriageAnswer[]
  export function priorRounds(findings: readonly Finding[], files?: ReadonlySet<string>): string   // '' when nothing applies
  export function reviewPrompt(run: Run, role: 'review' | 'challenge', prior: readonly Finding[]): string
  export function fixPrompt(run: Run, notes: string | undefined, isMain: boolean): string     // advisory variant unchanged in shape
  export function triagePrompt(run: Run, rec: LifecycleRecord, items: readonly { feedback: Feedback; cls: TriageClass; matchId?: string; findingId: string }[], others: readonly string[]): string
  export function prPrompt(run: Run, rec: LifecycleRecord, status: 'passed' | 'exhausted' | 'waived'): string
  export function readyPrompt(rec: LifecycleRecord): string
  export function reportPrompt(rec: LifecycleRecord, next: { why: string; nextStep: string }): string
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lifecycle.test.ts`:

```ts
import { priorRounds, readReview, readTriage, TRAILER } from '../hooks/core'

test('a review answer can confirm fixes and hold rebuttals by id', async () => {
  const answer = `ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-review', gate: 'PASS', findings: [], verified: ['R1-1'], held: ['R1-2'] })}`
  expect(readReview(answer)).toMatchObject({ gate: 'PASS', verified: ['R1-1'], held: ['R1-2'] })
})

test('the triage answer carries dispositions, severities, reply ids and duplicates', async () => {
  const answer = `${TRAILER}\n${JSON.stringify({
    step: 'r3-triage',
    dispositions: [
      { id: 'G3-1', action: 'fixed', note: 'parameterised', severity: 'P1', isSecurity: true, replyId: '991' },
      { id: 'G3-2', action: 'rebutted', note: 'see R1-1', duplicateOf: 'R1-1', replyId: '992' },
    ],
  })}`
  expect(readTriage(answer)).toEqual([
    { id: 'G3-1', action: 'fixed', note: 'parameterised', severity: 'P1', isSecurity: true, replyId: '991' },
    { id: 'G3-2', action: 'rebutted', note: 'see R1-1', duplicateOf: 'R1-1', replyId: '992' },
  ])
})

test('prior rounds list the answered findings that still apply, with their evidence and what is owed', async () => {
  const text = priorRounds([
    finding({ status: 'rebutted', note: 'checked at src/app.ts:9' }),
    finding({ id: 'R1-2', status: 'reported-fixed', note: 'allow-list' }),
    finding({ id: 'R1-3', file: 'src/other.ts', status: 'verified-fixed' }),
  ], new Set(['src/app.ts']))
  expect(text).toContain('R1-1 [P1] Unvalidated redirect in login (src/app.ts:12)\n    rebutted: checked at src/app.ts:9')
  expect(text).toContain('R1-2 [P1] Unvalidated redirect in login (src/app.ts:12)\n    reported-fixed, verification owed: allow-list')
  expect(text).not.toContain('R1-3')
  expect(priorRounds([])).toBe('')
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL (`readTriage`, `priorRounds` not exported; `verified` missing).

- [ ] **Step 3: Implement in `core.ts`**

1. `export const TRAILER = 'PR_GATE_RESULT'`; update the file header comment to name pr-lifecycle. Update `TRAILER` in `tests/world.ts` to the same string.
2. `ReviewResult` gains `verified: string[]` and `held: string[]`. In `readReview`, every `return` gets them: `verified: [], held: []` on the no-trailer and ERROR paths; on the normal path read them:
   ```ts
   const idList = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter((one): one is string => one !== undefined) : [])
   ```
   and `return { gate: hasBlocking ? 'FAIL' : gate, findings, note, verified: idList(trailer.verified), held: idList(trailer.held) }`.
3. Replace `Disposition`/`readDispositions` with one reader shared by fix and triage (import `Answer` type from `./lifecycle`; `lifecycle.ts` imports only `isBlocking` from `core.ts`, and type-only imports do not create a runtime cycle):
   ```ts
   export type TriageAnswer = Answer & { replyId?: string; duplicateOf?: string }

   export function readTriage(answer: string): TriageAnswer[] {
     const listed = readTrailer(answer)?.dispositions
     if (!Array.isArray(listed)) return []
     const out: TriageAnswer[] = []
     for (const one of listed) {
       if (typeof one !== 'object' || one === null) continue
       const row = one as Record<string, unknown>
       const id = text(row.id)
       const action = String(row.action ?? '').toLowerCase()
       if (id === undefined || (action !== 'fixed' && action !== 'rebutted' && action !== 'deferred')) continue
       const severity = String(row.severity ?? '').toUpperCase() as Severity
       out.push({
         id,
         action,
         ...(text(row.note) === undefined ? {} : { note: text(row.note)?.slice(0, 2000) }),
         ...(text(row.evidence) === undefined ? {} : { evidence: text(row.evidence)?.slice(0, 2000) }),
         ...(SEVERITIES.includes(severity) ? { severity } : {}),
         ...(typeof row.isSecurity === 'boolean' ? { isSecurity: row.isSecurity } : {}),
         ...(row.replyId === undefined || row.replyId === null ? {} : { replyId: String(row.replyId) }),
         ...(text(row.duplicateOf) === undefined ? {} : { duplicateOf: text(row.duplicateOf) }),
       })
     }
     return out
   }

   /** What the fixer said it did with each finding. */
   export const readDispositions = (answer: string): Answer[] => readTriage(answer)
   ```
4. `listFindings` shows the new statuses: replace its `note` line with
   ```ts
   const said = one.status === 'reported-fixed' ? 'reported-fixed, verification owed' : one.status
   const note = one.status === 'open' && one.note === undefined ? '' : `\n    ${said}${one.note === undefined || one.note === '' ? '' : `: ${one.note}`}`
   ```
5. Add `priorRounds`:
   ```ts
   /** Earlier findings that still apply to the files under review, so a round checks their answers instead of re-arguing them. */
   export function priorRounds(findings: readonly Finding[], files?: ReadonlySet<string>): string {
     const applies = findings.filter(
       one => one.status !== 'open' && one.status !== 'verified-fixed' && (files === undefined || one.file === undefined || files.has(one.file)),
     )
     const recheck = findings.filter(one => one.needsRecheck === true && !applies.includes(one))
     const all = [...applies, ...recheck]
     return all.length === 0 ? '' : listFindings(all)
   }
   ```
6. `reviewPrompt(run, role, prior)`: use `run.diffBase` instead of `origin/${run.base}` in the `<base>` line (`The base is ${run.diffBase}: use it wherever the skill says <base>`). Replace the 0.3.1 rebutted block (which read `run.findings` of the previous round) with:
   ```ts
   const answered = priorRounds(prior)
   if (answered !== '' && role === 'review') {
     lines.push(
       '',
       'Earlier rounds on this branch settled these, with the evidence shown. Check the answers; do not re-derive them:',
       answered,
       "After the review, put every rebutted or reported-fixed one to Codex through the same skill's consult mode (one prompt listing them all). List the ids Codex confirms fixed under verified, and the ids whose rebuttal or fix Codex does not accept under held. Do not list a held one again under findings.",
     )
   }
   ```
   and extend the trailer shape string with `"verified":["R1-1"],"held":["R1-2"]`. Change the first line to `You are the Codex ${role} step of /pr-gate (pr-lifecycle). Round ${run.round}, ${run.lifecycle === 'pre' ? 'before the pull request opens' : 'after it opened'}.`
7. `fixPrompt`/`advisoryPrompt`: drop `run.advisoryRound`/`run.advisoryMax` from the words (`codex-gate, advisory round ${run.advisoryRound} of ${run.advisoryMax}` becomes `/pr-gate, round ${run.round}, advisories`). In the fixer instructions add, after the "Verify every finding" line: `'   A finding marked reported-fixed or rebutted in an earlier round is listed with that answer: do not answer it again unless its file changed.'`
8. `triagePrompt` (new, for post-PR rounds):
   ```ts
   export function triagePrompt(
     run: Run,
     rec: LifecycleRecord,
     items: readonly { feedback: Feedback; cls: TriageClass; matchId?: string; findingId: string }[],
     others: readonly string[],
   ): string {
     const cls = { duplicate: 'duplicate of an answered finding', 'new-on-reviewed': 'new claim about code already reviewed', 'new-on-changed': 'about code changed since the last review' } as const
     const lines = [
       `/pr-gate, post-PR round ${run.round} (${run.roundKind}) for PR #${rec.pr} on ${rec.branch} → ${rec.base}, head ${run.roundStartHead.slice(0, 7)}.`,
       where(run),
       '',
     ]
     if (others.length > 0) {
       lines.push(`Commits were pushed by someone else since ${rec.head.slice(0, 7)}: ${others.join(', ')}. Pull them (git pull --ff-only), read each, and verify it like a review finding before anything else.`, '')
     }
     lines.push('New review feedback:')
     for (const one of items) {
       const at = one.feedback.file === undefined ? '' : ` (${one.feedback.file}${one.feedback.line === undefined ? '' : `:${one.feedback.line}`})`
       const earlier = one.matchId === undefined ? '' : `\n    earlier answer: ${listFindings(rec.findings.filter(each => each.id === one.matchId)).replace(/\n/g, '\n    ')}`
       lines.push(`- ${one.findingId} from ${one.feedback.reviewer}${at}, ${cls[one.cls]}; reply to ${one.feedback.kind === 'inline' ? `thread ${one.feedback.threadId}` : 'the PR conversation'}:\n    ${one.feedback.body.slice(0, 1500).replace(/\n/g, '\n    ')}${earlier}`)
     }
     const owed = rec.findings.filter(one => isBlocking(one) && one.status === 'reported-fixed')
     if (owed.length > 0) lines.push('', 'Reported fixed, verification still owed:', listFindings(owed))
     const already = Object.keys(rec.replies)
     lines.push(
       '',
       'What to do:',
       '1. Invoke the superpowers:receiving-code-review skill first, if it is available. Verify every claim against the current code before changing anything.',
       '2. Give each item one answer: fix it (smallest change, with a test where one fits), rebut it with file:line, test or requirement evidence, or defer it with the reason. A duplicate gets a reply pointing to the earlier answer, not a new argument.',
       '3. Give each item a severity (P0–P3), keeping the reviewer\'s own where it gave one, and say whether it is a security issue.',
       `4. Reply where the feedback was given: an inline comment in its thread (gh api repos/${rec.slug}/pulls/${rec.pr}/comments/<threadId>/replies -f body=...), anything else as a PR comment (gh pr comment ${rec.pr}). Put the reply id in replyId.${already.length > 0 ? ` Already replied to: ${already.join(', ')}; do not reply to those again.` : ''}`,
       '5. Run the checks that cover what you touched, commit, and push to the PR branch.',
       '',
       trailerRule(
         stepOf(run, 'triage'),
         '{"dispositions":[{"id":"G1-1","action":"fixed|rebutted|deferred","severity":"P1","isSecurity":false,"note":"what changed, or the evidence","replyId":"123","duplicateOf":"R1-1 when it is one"}]}',
       ),
       '',
       'Then end your turn. /pr-gate collects the next reviews by itself.',
     )
     return lines.join('\n')
   }
   ```
   (Add `Feedback` and `TriageClass`, `LifecycleRecord` type imports.)
9. `prPrompt(run, rec, status)`: keep the 0.3.1 text, replacing the advisory counters with `rec` budget words (`${usedRounds(rec)} of ${rec.allowance} review rounds used`; import from `./lifecycle`), the heading "Pre-PR Codex gate" stays, and replace the closing lifecycle paragraph with: `'/pr-gate stays with this pull request: once it is open it collects the repository\'s reviews itself and sends you what needs an answer. Do not wait or poll for reviewers yourself, and do not merge: merging is held until the lifecycle review is complete.'` For `status === 'exhausted'` keep the "did not converge, with the count" line.
10. `readyPrompt(rec)` returns: `` `/pr-gate: the lifecycle review of PR #${rec.pr} is complete at ${rec.head.slice(0, 7)}: ${summary}. It is ready for the merge decision, which is the person's: tell them, and do not merge unless they ask.` `` where `summary` lists rounds (pre/post counts), findings by status, and deferrals.
11. `reportPrompt(rec, next)` returns: `` `/pr-gate stopped short of ready on PR #${rec.pr}: ${next.why}. Tell the person, with each open finding and its evidence, and the smallest next step: ${next.nextStep}. Do not merge.` `` followed by `listFindings(unresolvedBlockers(rec))`.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: the 3 new tests pass; earlier `lifecycle.test.ts` and `github.test.ts` tests still pass. (`gate.test.ts` is still red until Task 9.)

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/core.ts pr-lifecycle/tests
git commit -m "pr-lifecycle: history-aware prompts, the triage prompt, verified/held in the review trailer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 9: The record in `$.store`, pre-PR rounds on the shared allowance, no automatic close

**Files:**
- Create: `pr-lifecycle/hooks/store.ts`, `pr-lifecycle/hooks/round.ts`
- Modify: `pr-lifecycle/hooks/register.tsx`, `pr-lifecycle/.claude-plugin/plugin.json`
- Test: `pr-lifecycle/tests/gate.test.ts`, `pr-lifecycle/tests/flow.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:
  ```ts
  // store.ts
  export const recordKey = (root: string, branch: string): string => `lifecycle:${root}:${branch}`
  export async function loadRecord($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined>
  export async function saveRecord($: Engine, rec: LifecycleRecord): Promise<void>
  export async function updateRecord($: Engine, root: string, branch: string, change: (rec: LifecycleRecord) => LifecycleRecord): Promise<LifecycleRecord | undefined>
  // round.ts
  export type Config = { ...0.3.1 Config without maxRounds/advisoryMin/advisoryMax..., allowances: Allowances; enforceMerge: boolean; routineRoundMs: number; waitCapMs: number; quietMs: number }
  export function configOf(options: PluginOptions): Config
  export function setup(hooks: { advance: ($: Engine, root: string, branch: string) => Promise<void> }, config: Config): void
  export async function startRound($: Engine, rec: LifecycleRecord, next: Extract<Next, { kind: 'round' }>): Promise<void>
  export async function finish($: Engine, id: string, status: RunStatus, message: string, hasTimedOut?: boolean): Promise<Run | null>
  export async function onAnswer($: Engine, agentId: string | undefined, answer: string, reason: string): Promise<void>
  export function startTicker($: Engine): void
  export const getRun, patch, git, runAtom, tickAtom, isLiveNow(): boolean, setLive(v: boolean): void
  // register.tsx
  const advance = async ($: Engine, root: string, branch: string): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/flow.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'

import { createPr, isHeld, P1, P2, review, runOf, TRAILER, turn, world } from './world'
import type { LifecycleRecord } from '../types'

const recordOf = async (w: ReturnType<typeof world>): Promise<LifecycleRecord> => w.stored('lifecycle:/repo:feat/x') as LifecycleRecord
const fixed = (id: string, note = 'done') => `Fixed.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id, action: 'fixed', note }] })}`

test('several reviewers in one cycle consume one round', async ($, on) => {
  const w = world(on)
  w.git.numstat = '10\t2\tsrc/auth/login.ts' // high: review and challenge run in parallel
  await $.tool.call(createPr)
  expect(w.spawned).toHaveLength(2)
  await $.turn.complete(turn(review('r1-review', 'PASS'), 'agent-1'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-2'))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(rec.rounds[0]?.evidence.map(one => one.reviewer)).toEqual(['codex', 'codex-challenge'])
})

test('omitted findings are not marked fixed', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, P2])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  // Round 2: Codex raises nothing and confirms nothing.
  await $.turn.complete(turn(review('r2-review', 'PASS')))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-1')?.status).toBe('reported-fixed')
  expect(rec.findings.find(one => one.id === 'R1-2')?.status).toBe('open')
})

test('a fix Codex confirms is verified; a rebuttal Codex holds is open again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, { ...P1, title: 'Second', line: 40 }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'rebutted', note: 'guarded at :38' }] })}`))
  expect(w.spawned.at(-1)?.prompt).toContain('R1-2 [P1] Second')
  await $.turn.complete(turn(review('r2-review', 'PASS', [], { verified: ['R1-1'], held: ['R1-2'] })))
  const rec = await recordOf(w)
  expect(rec.findings.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'verified-fixed'],
    ['R1-2', 'open'],
  ])
})

test('a security P1 only reported fixed does not let an exhausted gate open the PR', async ($, on) => {
  const w = world(on, { allowanceStandard: 1 })
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  const rec = await recordOf(w)
  expect(rec.findings[0]?.isSecurity).toBe(true)
  expect(rec.preStatus).toBe('exhausted')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('new scope invalidates only the affected evidence', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, { ...P2, file: 'src/other.ts' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(
    turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'rebutted', note: 'fine as is' }] })}`),
  )
  await $.turn.complete(turn(review('r2-review', 'PASS'), 'agent-2'))
  // A new commit touches src/app.ts only, and the person runs the gate again.
  w.git.head = 'f'.repeat(40)
  w.git.changed = 'src/app.ts'
  await $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-1')?.needsRecheck).toBe(true)
  expect(rec.findings.find(one => one.id === 'R1-2')?.needsRecheck).toBeUndefined()
  // History stays, and the new head gets its own round.
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(2)
  expect(w.spawned.at(-1)?.prompt).toContain('R1-1')
})

test('timeout retries record effort without recording a completed round', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(`${TRAILER}\n${JSON.stringify({ step: 'r1-review', gate: 'ERROR', error: 'timeout' })}`))
  await $.turn.complete(turn(review('r1-review', 'PASS'), 'agent-2'))
  const rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(rec.rounds[0]?.isCompleted).toBe(false)
})
```

`world(on, options?)` must now pass plugin options and expose the store. Change `tests/world.ts`:
- `world(on: On, options: Record<string, unknown> = {})`; keep `mock.store(on)` but also keep a copy: replace it with a store hook of the test's that records into `w.store: Map<string, unknown>`:
  ```ts
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  ```
  and `stored: (key: string) => w.store.get(key)` on the world. (Check the exact `store.get`/`store.set` event field names in `.claude-plugin/types/claude-code/index.d.ts` under `'store.get'`; if the hook form differs, keep `mock.store(on, entries)` and read through `$.store.get` in the test instead.)
- Options: the test runner passes plugin options at register time. Find how in `claude-code/testing` (search the types for `options` on `test(`); if a test cannot set them, give `world` a `w.options` object and make `configOf` read from `$.config`-style options at `register`. Whichever mechanism the testing API offers is the one to use; `allowanceStandard: 1` must reach `configOf`.

Adjust `tests/gate.test.ts` (each change keeps the test's intent, and its name says so):
- `'five rounds without agreement end the gate as exhausted'` → rename to `'the shared allowance (4) without agreement ends the pre-PR gate as exhausted'`, loop 4 reviews instead of 5, and expect `rec.preStatus === 'exhausted'`.
- Advisory tests: rename `'advisory rounds stop at three, and the PR opens with what is left'` → `'advisory rounds stop when the reserve rule would leave no round, and the PR opens with what is left'`; with allowance 4, rounds 1 (advisories, fixed), 2 (advisories, fixed), 3 (advisories) → no advisory fix in round 3 (reserve), PR opens.
- `'with the minimum at one advisory round, a rebuttal with no new commit opens the PR'` → rename to `'an advisory rebuttal with no new commit opens the PR without another round'`.
- `'a chore/ branch gets one Codex round at low effort, then the PR carries the rest'` → rename to `'a chore/ branch gets one Codex round at low effort; its fix is reviewed after the PR opens'`: after the FAIL the fixer is prompted (a blocker is always fixed inside its round), answer that turn, then expect `preStatus === 'exhausted'` and the PR prompt.
- Every `expect(run.findings[0]?.status).toBe('fixed')` → `'reported-fixed'`.
- Every `'codex-gate'` text expectation (`held.deny ?? held.text` contains) → `'/pr-gate'`.
- `prompts` expectations about `'the ones that are not required included'` → `'stays with this pull request'`.

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: the new flow tests fail; adjusted gate tests fail.

- [ ] **Step 3: Create `hooks/store.ts`**

```ts
// The lifecycle record, kept in the plugin's store so a restart resumes it.

import type { EngineInterface } from 'claude-code'

import type { LifecycleRecord } from '../types'

type Engine = EngineInterface

export const recordKey = (root: string, branch: string): string => `lifecycle:${root}:${branch}`

export async function loadRecord($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const value = (await $.store.get(recordKey(root, branch))) as LifecycleRecord | undefined | null
  return value !== null && value !== undefined && value.version === 1 ? value : undefined
}

export async function saveRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, updatedAt: Math.max(rec.updatedAt, await $.clock.now()) })
}

/** Reads, changes and writes the record; undefined when there is none. */
export async function updateRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord) => LifecycleRecord,
): Promise<LifecycleRecord | undefined> {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined) return undefined
  const next = change(rec)
  await saveRecord($, next)
  return next
}
```

- [ ] **Step 4: Move the round machinery to `hooks/round.ts`**

Cut from `register.tsx` into `round.ts`, unchanged at first: `Config`, `effortOf`, `configOf`, `elapsed`, `withStep`, the module state (`config`, `isLive`, `ticker`), `getRun`, `patch`, `git`, `stopTicker`, `startTicker`, `finish`, `spawn`, `beginReview`, `beginFix`, `beginVerify`, `retryLower`, `nextRound`, `afterReview`, `afterFix`, `afterVerify`, `onAnswer`, and the atoms `runAtom`/`tickAtom` with `RUN`/`PANE`/`SPINNER`. Export what `register.tsx` and `pane.tsx` use (listed in Interfaces). Add `export function setup(h, c)` assigning a module-level `hooks = h` and `config = c`, `export const isLiveNow = () => isLive` and `export const setLive = (v: boolean) => { isLive = v }`. `register` calls `setup({ advance }, configOf(options))`.

Run `claude plugin validate .` to confirm the module still loads (imports resolve).

- [ ] **Step 5: Change `Config`/`configOf`**

```ts
export type Config = {
  allowances: Allowances
  bases: string[]
  enforce: boolean
  enforceMerge: boolean
  fixer: 'main' | 'subagent'
  fixReview: 'auto' | 'always' | 'never'
  onExhausted: 'open-pr' | 'stop'
  openPr: boolean
  highRisk: RegExp | undefined
  stepTimeoutMs: number
  routineRoundMs: number
  waitCapMs: number
  quietMs: number
  effort: Effort
  lightEffort: Effort
  light: RegExp | undefined
}
```

In `configOf`, delete `maxRounds`/`advisoryMin`/`advisoryMax` and add (0.3.1's `maxRounds` is read when `allowanceStandard` is unset):

```ts
    allowances: {
      standard: Math.min(number('allowanceStandard', number('maxRounds', 4)), 10),
      high: Math.min(number('allowanceHigh', 6), 12),
    },
    enforceMerge: options.enforceMerge !== false,
    routineRoundMs: number('routineRoundMinutes', 3) * 60_000,
    waitCapMs: number('waitCapMinutes', 20) * 60_000,
    quietMs: number('quietMinutes', 3) * 60_000,
```

In `plugin.json` `userConfig`: delete `maxRounds`, `advisoryMinRounds`, `advisoryMaxRounds`; add

```json
    "allowanceStandard": { "type": "number", "title": "Review rounds, standard changes", "description": "Discretionary review rounds one lifecycle may complete on a standard change, before and after the PR opens together, advisory rounds included. The protected post-PR rounds do not count. Replaces maxRounds, which is read when this is unset.", "default": 4 },
    "allowanceHigh": { "type": "number", "title": "Review rounds, high blast-radius changes", "description": "The same allowance for a high blast-radius change.", "default": 6 },
    "enforceMerge": { "type": "boolean", "title": "Hold merges until the lifecycle is done", "description": "Deny merging a PR to a gated base (gh, gh api, GitHub MCP tools) until its lifecycle review is complete for the PR's current head, or the person waived it.", "default": true },
    "routineRoundMinutes": { "type": "number", "title": "Routine round timebox (minutes)", "description": "The active time a routine round should take. Going over is shown and recorded, not failed; stepTimeoutMinutes is the hard limit.", "default": 3 },
    "waitCapMinutes": { "type": "number", "title": "Reviewer wait cap (minutes)", "description": "The longest a post-PR round waits for reviewers before it carries on with what arrived. A repository's .github/pr-gate.json can set its own.", "default": 20 },
    "quietMinutes": { "type": "number", "title": "Quiet period (minutes)", "description": "Without a roster file, collection ends once checks are done and no new feedback arrived for this long.", "default": 3 }
```

and change `onExhausted`'s description to: `"open-pr opens the PR anyway when the pre-PR allowance is spent (never with an open security P1); stop leaves it held for a person's decision. Either way the post-PR lifecycle still runs, and merging stays held."`.

- [ ] **Step 6: Start a lifecycle and a round from the record**

In `register.tsx`, `startGate` keeps scoping exactly as 0.3.1 (pass-throughs, `classify`, lane, effort carry-over), then instead of building a `Run` directly:

```ts
    const now = await $.clock.now()
    const prior = await loadRecord($, root, branch)
    const allowance = allowanceFor(scope.tier, lane, config.allowances)
    let rec =
      prior !== undefined && prior.phase !== 'archived'
        ? rescope({ ...prior, head, base }, scope.tier, scope.why, config.allowances)
        : { ...newRecord({ root, branch, base, head, tier: scope.tier, tierWhy: scope.why, lane, allowance, at: now }), effort, ...(scope.tier === 'trivial' ? { passThrough: scope.why } : {}) }
    if (prior !== undefined && prior.head !== head) {
      const lastHead = lastReviewedHead(prior)
      const since = lastHead === undefined ? undefined : await git($, root, ['diff', '--name-only', lastHead, head])
      rec = { ...rec, findings: invalidate(rec.findings, since?.isOk === true ? new Set(since.out.split('\n').filter(Boolean)) : 'all') }
    }
    await saveRecord($, rec)
    await advance($, root, branch)
    return `Lifecycle ${prior === undefined ? 'started' : 'resumed'} for ${branch} → ${base}: ${scope.tier} blast radius (${scope.why}), ${remaining(rec)} of ${rec.allowance} review rounds left.`
```

The effort computation keeps reading `last.hasTimedOut`, `last.effort`, `last.passedEffort` — now from `prior` (the record carries the same three fields).

`advance` in `register.tsx`:

```ts
/** After a round, or at start: the controller reads the record and does what `decideNext` says. */
const advance = async ($: Engine, root: string, branch: string): Promise<void> => {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined) return
  const next = decideNext(rec)
  const run = await getRun($)
  const id = run !== null && run.status === 'running' ? run.id : undefined
  if (next.kind === 'round') {
    await startRound($, rec, next)
    return
  }
  if (next.kind === 'open-pr') {
    // A security P1 that is open, or only reported fixed, never rides on exhaustion.
    const hasSecurity = [...unresolvedBlockers(rec), ...verificationOwed(rec)].some(one => one.isSecurity === true)
    const opens = next.status === 'passed' || (config.onExhausted === 'open-pr' && !hasSecurity)
    const saved = await updateRecord($, root, branch, one => ({ ...one, preStatus: next.status, preHead: one.head }))
    const message =
      next.status === 'passed'
        ? rec.passThrough !== undefined ? `Codex skipped: ${rec.passThrough}.` : `No high/critical finding after ${usedRounds(rec)} round${usedRounds(rec) === 1 ? '' : 's'}.`
        : `${unresolvedBlockers(rec).length} high/critical finding(s) still open with the allowance spent${hasSecurity ? ', one of them security: the PR stays held' : ''}.`
    const ended = id === undefined ? null : await finish($, id, next.status, message)
    if (opens && config.openPr && saved !== undefined && ended !== null) void $.prompt.submit({ text: prPrompt(ended, saved, next.status) }).catch(() => undefined)
    return
  }
  if (next.kind === 'ready') {
    const saved = await updateRecord($, root, branch, one => ({ ...one, phase: 'ready', postStatus: undefined }))
    if (id !== undefined) await finish($, id, 'passed', `Lifecycle review complete at ${rec.head.slice(0, 7)}: ready for the merge decision.`)
    if (saved !== undefined) void $.prompt.submit({ text: readyPrompt(saved) }).catch(() => undefined)
    return
  }
  const isPre = rec.phase === 'pre'
  const saved = await updateRecord($, root, branch, one => (isPre ? { ...one, preStatus: next.kind, preHead: one.head, message: next.why } : { ...one, postStatus: next.kind, message: next.why }))
  if (id !== undefined) await finish($, id, next.kind, `${next.why}. Next: ${next.nextStep}`)
  if (saved !== undefined) void $.prompt.submit({ text: reportPrompt(saved, next) }).catch(() => undefined)
}
```

A pass-through runs no round, so there is no `Run` and `advance`'s open-pr branch does not prompt: the held `gh pr create` that started it goes straight through, as in 0.3.1. When the person starts `/pr-gate` on a pass-through, `startGate` returns `Gate passed without Codex: …` and, with `config.openPr` on, submits `prPrompt` itself.

In `judgeCreate` (Step 8), the security check is the same as in `advance`: `[...unresolvedBlockers(one), ...verificationOwed(one)].some(each => each.isSecurity === true)`.

`startRound` in `round.ts` (pre-PR part; Task 11 adds the post-PR part):

```ts
export async function startRound($: Engine, rec: LifecycleRecord, next: Extract<Next, { kind: 'round' }>): Promise<void> {
  const now = await $.clock.now()
  const existing = await getRun($)
  const round = rec.rounds.length === 0 ? 1 : Math.max(...rec.rounds.map(one => one.n)) + (rec.rounds.at(-1)?.isCompleted === false ? 0 : 1)
  const lastHead = lastReviewedHead(rec)
  const run: Run = {
    id: existing !== null && existing.status === 'running' ? existing.id : `${now}`,
    cwd: rec.root,
    root: rec.root,
    branch: rec.branch,
    base: rec.base,
    headSha: rec.head,
    tier: rec.tier,
    tierWhy: rec.tierWhy,
    lane: rec.lane,
    effort: rec.effort ?? config.effort,
    startEffort: rec.effort,
    round,
    status: 'running',
    phase: 'scope',
    hasRefixed: false,
    fixKind: next.isAdvisory ? 'advisory' : 'blocking',
    steps: existing !== null && existing.status === 'running' ? existing.steps : [{ id: 'scope', label: 'Scope & blast radius', state: 'done', detail: `${rec.tier}: ${rec.tierWhy}` }, { id: 'pr', label: `Open PR → ${rec.base}`, state: next.phase === 'pre' ? 'pending' : 'done' }],
    findings: rec.findings,
    pending: [],
    activity: '',
    startedAt: existing?.startedAt ?? now,
    phaseStartedAt: now,
    lifecycle: next.phase,
    roundKind: next.roundKind,
    roundStartHead: rec.head,
    roundStartedAt: now,
    diffBase: next.scope === 'delta' && lastHead !== undefined ? lastHead : next.phase === 'post' && lastHead !== undefined ? lastHead : `origin/${rec.base}`,
    evidence: [],
    activeMs: 0,
    waitMs: 0,
  }
  await update($, runAtom, () => run)
  await update($, tickAtom, () => now)
  isLive = true
  startTicker($)
  void $.ui.open({ id: PANE, title: 'PR lifecycle' }).catch(() => undefined)
  if (next.phase === 'pre') await beginReview($, run.id)
  else await beginCollect($, run.id)   // Task 11
}
```

Until Task 11, define `beginCollect` as a stub that calls `finish($, id, 'error', 'post-PR rounds are not built yet')` — and the Task 9 tests never reach it. Remove the stub in Task 11.

- [ ] **Step 7: End a round into the record; drop the automatic close**

In `round.ts` add:

```ts
/** The round in flight ended, complete or not: append it to the record, then let the controller choose. */
const endRound = async ($: Engine, run: Run, isCompleted: boolean, outstanding?: string): Promise<void> => {
  const now = await $.clock.now()
  const head = await git($, run.root, ['rev-parse', 'HEAD'])
  const endHead = head.isOk ? head.out : run.headSha
  const current = run.findings.filter(one => one.round === run.round)
  const round: RoundRecord = {
    n: run.round,
    phase: run.lifecycle,
    kind: run.roundKind,
    isAdvisory: run.fixKind === 'advisory',
    startHead: run.roundStartHead,
    endHead,
    isCompleted,
    evidence: run.evidence,
    raised: { blocking: current.filter(isBlocking).length, advisory: current.filter(one => !isBlocking(one)).length },
    rebutted: current.filter(one => one.status === 'rebutted').length,
    deferredBlocking: current.filter(one => isBlocking(one) && one.status === 'deferred').length,
    activeMs: run.activeMs + (now - run.phaseStartedAt) * (run.phase === 'collect' ? 0 : 1),
    waitMs: run.waitMs,
    ...(outstanding === undefined ? {} : { outstanding }),
    startedAt: run.roundStartedAt,
    endedAt: now,
  }
  await updateRecord($, run.root, run.branch, rec => ({
    ...withRound(rec, round),
    head: endHead,
    findings: mergeFindings(rec.findings, run.findings),
    effort: run.effort,
  }))
  if (isCompleted) await hooks.advance($, run.root, run.branch)
}
```

Rewrite `afterReview` (pre-PR part):

```ts
const afterReview = async ($: Engine, run: Run): Promise<void> => {
  const now = await $.clock.now()
  const results = run.pending.map(one => ({ role: one.role, result: readReview(one.answer ?? '') }))
  const failed = results.find(one => one.result.gate === 'ERROR')
  if (failed !== undefined && failed.result.failure === 'timeout') {
    await noteAttempt($, run, `Codex ${failed.role} timed out at ${run.effort}`)
    await retryLower($, run, `Codex ${failed.role} timed out at ${run.effort}: ${failed.result.note ?? 'no verdict'}.`)
    return
  }
  const fresh: Finding[] = []
  for (const { role, result } of results) {
    for (const one of result.findings) {
      fresh.push({
        ...one,
        id: `R${run.round}-${fresh.length + 1}`,
        round: run.round,
        source: role === 'challenge' ? 'codex-challenge' : 'codex-review',
        reviewer: 'codex',
        ...(severityHint(`${one.title} ${one.detail ?? ''}`).isSecurity ? { isSecurity: true } : {}),
        headSeen: run.headSha,
        status: 'open',
        history: [{ round: run.round, status: 'open', by: role === 'challenge' ? 'codex-challenge' : 'codex', at: now }],
      })
    }
  }
  const verified = new Set(results.flatMap(one => one.result.verified))
  const held = new Set(results.flatMap(one => one.result.held))
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    // A finding this review left out keeps its status: only an explicit verified or held moves it.
    findings: [
      ...one.findings.map(old => (verified.has(old.id) ? markVerified(old, one.round, 'codex', now) : held.has(old.id) ? markHeld(old, one.round, 'codex', now) : old)),
      ...fresh,
    ],
    evidence: results.filter(each => each.result.gate !== 'ERROR').map(each => ({ source: 'codex' as const, reviewer: each.role === 'challenge' ? 'codex-challenge' : 'codex', head: one.headSha, isComplete: true })),
    steps: /* 0.3.1 step update, unchanged */ results.reduce(/* … as before … */, one.steps),
  }))
  if (after === null) return
  if (failed !== undefined) {
    await noteAttempt($, after, `Codex ${failed.role} did not complete`)
    await finish($, run.id, 'error', `Codex ${failed.role} did not complete: ${failed.result.note ?? 'no verdict'}`)
    return
  }
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
  // A blocker is always fixed inside its round: on the last allowed round the fix is reviewed after the PR opens
  // (or in a round the person allows). An advisory fix runs only while a round stays to review it.
  const projected = withRound(rec, roundOf({ kind: run.roundKind, isCompleted: true }))
  const blocking = fresh.filter(isBlocking)
  if (blocking.length > 0) {
    await beginFix($, run.id, undefined, 'blocking')
    return
  }
  if (blocking.length === 0 && fresh.length > 0 && mayStartRound(projected, true)) {
    await beginFix($, run.id, undefined, 'advisory')
    return
  }
  await endRound($, after, true)
}

/** An attempt that did not complete: its effort is recorded, no round is used. */
const noteAttempt = async ($: Engine, run: Run, why: string): Promise<void> => {
  const now = await $.clock.now()
  await updateRecord($, run.root, run.branch, rec =>
    withRound(rec, roundOf({ n: run.round, phase: run.lifecycle, kind: run.roundKind, startHead: run.roundStartHead, endHead: run.headSha, isCompleted: false, activeMs: now - run.phaseStartedAt, outstanding: why, startedAt: run.roundStartedAt, endedAt: now })),
  )
}
```

Keep the 0.3.1 `steps` reducer body verbatim in place of the comment.

The `retryLower` step-timeout path in `startTicker` also calls `noteAttempt` before `retryLower`.

Rewrite `afterFix` to record answers and hand the decision to the controller:

```ts
const afterFix = async ($: Engine, run: Run): Promise<void> => {
  const now = await $.clock.now()
  const said = readDispositions(run.pending[0]?.answer ?? '')
  const head = await git($, run.root, ['rev-parse', 'HEAD'])
  const dirty = await git($, run.root, ['status', '--porcelain', '--untracked-files=no'])
  const fromSha = run.headSha
  const newSha = head.isOk ? head.out : fromSha
  const count = (action: string): number => said.filter(one => one.action === action).length
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    headSha: newSha,
    findings: one.findings.map(finding => {
      const answer = said.find(each => each.id === finding.id)
      return answer === undefined ? finding : applyAnswer(finding, answer, one.round, config.fixer === 'main' ? 'main' : 'fixer', now)
    }),
    steps: /* 0.3.1 fix-step detail update, with 'fixed' counted from count('fixed') */ one.steps,
  }))
  if (after === null) return
  if (dirty.isOk && dirty.out !== '') {
    await noteAttempt($, after, 'the fixer left uncommitted changes')
    await finish($, run.id, 'error', 'The fixer left uncommitted changes. Reviews read committed code only: commit them and run /pr-gate resume.')
    return
  }
  const wantsVerify = config.fixReview === 'always' || (config.fixReview === 'auto' && after.tier === 'high')
  if (after.fixKind === 'blocking' && wantsVerify && !after.hasRefixed && newSha !== fromSha) {
    await beginVerify($, run.id, fromSha)
    return
  }
  await endRound($, after, true)
}
```

`afterVerify`: when `verdict.isOk`, mark the round's blocking `reported-fixed` findings `verified-fixed` (by `'fix-reviewer'`) in a `patch`, then `endRound($, after, true)`; otherwise `beginFix` as in 0.3.1. Delete `nextRound` (the controller starts rounds now).

`finish` loses its PR prompt and its `PassRecord` write; it ends the `Run`, stops the ticker, toasts, and writes `effort`/`hasTimedOut`/`passedEffort` onto the record with the 0.3.1 rules, using `updateRecord`. It returns the ended `Run` (or `null`). Statuses `error` and `stopped` also set `postStatus` when `run.lifecycle === 'post'`.

- [ ] **Step 8: The create guard reads the record**

`judge` in `register.tsx`: replace the `PassRecord` lookup with

```ts
    const rec = await loadRecord($, root, branch)
    const isWaivedPre = rec?.waivers.some(one => one.scope === 'pre' && one.head === head) === true
    const allows = (one: LifecycleRecord | undefined): boolean =>
      one !== undefined &&
      (isWaivedPre ||
        one.preStatus === 'passed' ||
        (one.preStatus === 'exhausted' && config.onExhausted === 'open-pr' && !unresolvedBlockers(one).some(each => each.isSecurity === true)))
    if (allows(rec) && rec?.preHead === head) return undefined
```

and the docs-only-ride rule writes `preHead: head` with `saveRecord` instead of the old `PassRecord`. After `startGate`, re-read the record the same way.

- [ ] **Step 9: Run the tests**

Run: `claude plugin test .`
Expected: all of `gate.test.ts` (22, some renamed), `lifecycle.test.ts`, `github.test.ts`, and the 5 `flow.test.ts` tests pass. Then run tsc; fix any type errors in the files this task touched.

- [ ] **Step 10: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: pre-PR rounds on the shared allowance, recorded in the lifecycle record

The round machinery moves to round.ts; register.tsx keeps hooks and the
controller. A finding a later review leaves out keeps its status: only an
explicit verified/held from Codex, or the fix reviewer, moves it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 10: Guards for every route; opening the PR switches to post-PR; the merge hold

**Files:**
- Modify: `pr-lifecycle/hooks/register.tsx`
- Test: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/world.ts`

**Interfaces:**
- Consumes: `readPrAction` (Task 7), `loadRecord`/`updateRecord` (Task 9), `advance`.
- Produces: `judgeCreate($, action)`, `judgeMerge($, action)` in `register.tsx`; `onOpened($, root, branch)` which records PR number, slug, self login, sets `phase: 'post'`, and calls `advance`.

- [ ] **Step 1: Extend the fake `gh` in `tests/world.ts`**

Add to `World`:

```ts
  gh: {
    pr: number
    prHead: string
    base: string
    headRef: string
    self: string
    reviews: object[]
    comments: object[]
    issueComments: object[]
    checks: object[]
    isAuthed: boolean
    calls: string[]
  }
```

with defaults `{ pr: 1, prHead: 'a'.repeat(40), base: 'dev', headRef: 'feat/x', self: 'me', reviews: [], comments: [], issueComments: [], checks: [], isAuthed: true, calls: [] }`, and route `gh` in the `process.run` hook before the git routes:

```ts
    if (e.argv[0] === 'gh') {
      w.gh.calls.push(args)
      if (!w.gh.isAuthed) return out('', 4)
      if (args.startsWith('api user')) return out(`${w.gh.self}\n`)
      if (args.startsWith('pr view')) return out(JSON.stringify({ number: w.gh.pr, baseRefName: w.gh.base, headRefName: w.gh.headRef, headRefOid: w.gh.prHead, state: 'OPEN' }))
      if (/pulls\/\d+\/reviews/.test(args)) return out(JSON.stringify(w.gh.reviews))
      if (/pulls\/\d+\/comments/.test(args)) return out(JSON.stringify(w.gh.comments))
      if (/issues\/\d+\/comments/.test(args)) return out(JSON.stringify(w.gh.issueComments))
      if (/commits\/[0-9a-f]+\/check-runs/.test(args)) return out(JSON.stringify({ check_runs: w.gh.checks }))
      if (/requested_reviewers/.test(args)) return out('{}')
      return out('')
    }
```

and in the git routes add `if (args.startsWith('show HEAD:.github/pr-gate.json')) return out(w.git.roster, w.git.roster === '' ? 128 : 0)` with `roster: ''` in `git`. Also add `if (args.startsWith('diff --name-only')) return out(w.git.changed)` with `changed: 'src/app.ts'`. The Bash `tool.call` mock in `world` records any command; for `gh pr merge` it returns success.

- [ ] **Step 2: Write the failing tests**

Append to `tests/flow.test.ts`:

```ts
const GRAPHQL = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
const merge = { tool: 'Bash' as const, command: 'gh pr merge 1 --squash' }

test('a clean pre-PR result still enters post-PR review, and merging stays held', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  const rec = await recordOf(w)
  expect(rec.phase).toBe('post')
  expect(rec.pr).toBe(1)
  expect((await runOf(w)).phase).toBe('collect')
  const held = await $.tool.call(merge)
  expect(held.deny).toContain('post-PR round 1 owed')
})

test('the github-graphql connector cannot open or merge around the gate', async ($, on) => {
  const w = world(on)
  const created = await $.tool.call({ tool: GRAPHQL, action: 'create', repo: 'me/repo', base: 'dev', head: 'feat/x', title: 't' } as never)
  expect(created.deny).toContain('/pr-gate')
  expect(w.spawned).toHaveLength(1)
  for (const action of ['merge', 'enqueue']) {
    const held = await $.tool.call({ tool: GRAPHQL, action, repo: 'me/repo', number: 1 } as never)
    expect(held.deny).toContain('merge')
  }
})

test('gh api merges and unknown GitHub tools are held', async ($, on) => {
  world(on)
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh api -X PUT repos/me/repo/pulls/1/merge' }))).toBe(true)
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'" }))).toBe(true)
  const unknown = await $.tool.call({ tool: 'mcp__acme-github__merge_pr', number: 1 } as never)
  expect(unknown.deny).toContain('mcp__acme-github__merge_pr')
})

test('a merge to an ungated base, or of a promotion, is not held', async ($, on) => {
  const w = world(on)
  w.gh.base = 'release'
  expect(isHeld(await $.tool.call(merge))).toBe(false)
  w.gh.base = 'main'
  w.gh.headRef = 'dev'
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})
```

- [ ] **Step 3: Run to see it fail**

Run: `claude plugin test .`
Expected: the 4 new tests fail.

- [ ] **Step 4: Implement**

Replace the two `on('tool.call', { tool: 'Bash' })` / `{ tool: GITHUB_CREATE_PR }` guards and the `GITHUB_CREATE_PR` constant with one guard. It must run before the activity hook; register it first in `register`:

```ts
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const action = readPrAction(String(e.tool), input)
    if (action === undefined) return next(e)
    const refusal =
      action.action === 'create' ? (config.enforce ? await judgeCreate($, action) : undefined) : config.enforceMerge ? await judgeMerge($, action) : undefined
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    if (action.action === 'create' && ran.deny === undefined && ran.isError !== true) await onOpened($, action)
    return ran
  }).catch(($, e, next) =>
    next.called || readPrAction(String(e.tool), e as unknown as Record<string, unknown>) === undefined
      ? next(e)
      : { deny: `/pr-gate: its guard failed, so this pull request action is held. The person can type /${COMMAND} waive pre|post <reason>.` },
  )
```

`judgeCreate` is the 0.3.1 `judge` (now taking `PrAction`: `base`, `repo`, `cwd`, `head`), with its refusal text starting `` `/pr-gate: ${action.via} to ${base} waits for the pre-PR review to finish for ${branch} at ${head.slice(0, 7)}.` `` and, for `action.isUnknown`, ending with `` `(${action.via} is a GitHub tool /pr-gate does not know; it is held like gh pr create.)` ``.

`judgeMerge`:

```ts
/** Whether a PR may be merged now: its lifecycle must be ready for the PR's current head, or the person waived post. */
const judgeMerge = async ($: Engine, action: PrAction): Promise<string | undefined> => {
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return undefined
  const root = top.out
  if (action.repo !== undefined) {
    const origin = await git($, root, ['remote', 'get-url', 'origin'])
    if (origin.isOk && slugOf(origin.out) !== slugOf(action.repo)) return undefined
  }
  const view = await $.process.run(
    ['gh', 'pr', 'view', ...(action.number === undefined ? [] : [String(action.number)]), '--json', 'number,baseRefName,headRefName,headRefOid'],
    { cwd: root, timeoutMs: 30_000 },
  )
  if (view.exitCode !== 0) return `/pr-gate: ${action.via} is held: gh could not say which pull request this merges (${view.stderr.trim().slice(0, 200)}). The person can type /${COMMAND} waive post <reason>.`
  const pr = JSON.parse(view.stdout) as { number: number; baseRefName: string; headRefName: string; headRefOid: string }
  if (!config.bases.includes(pr.baseRefName) || config.bases.includes(pr.headRefName)) return undefined
  const rec = await loadRecord($, root, pr.headRefName)
  if (rec?.waivers.some(one => one.scope === 'post' && one.head === pr.headRefOid) === true) return undefined
  if (rec !== undefined && rec.phase === 'ready' && rec.head === pr.headRefOid) return undefined
  const missing =
    rec === undefined
      ? 'no lifecycle record for this branch'
      : rec.head !== pr.headRefOid && rec.phase === 'ready'
        ? `${pr.headRefOid.slice(0, 7)} was pushed after the review completed at ${rec.head.slice(0, 7)}`
        : owedOf(rec)
  return [
    `/pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held: the lifecycle review is not complete for ${pr.headRefOid.slice(0, 7)}: ${missing}.`,
    'Do not merge another way. The person decides: /pr-gate status shows what is left, /pr-gate waive post <reason> lets this head merge.',
  ].join('\n')
}

/** What still stands between a record and ready, in a few words. */
const owedOf = (rec: LifecycleRecord): string => {
  const post = rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)
  const open = unresolvedBlockers(rec)
  if (rec.phase === 'pre') return 'the PR is still in pre-PR review'
  if (post.length === 0) return `post-PR round 1 owed on ${rec.head.slice(0, 7)}`
  if (post.length === 1 && post[0]?.endHead !== post[0]?.startHead) return `round 2 owed on ${rec.head.slice(0, 7)}`
  if (open.length > 0) return open.map(one => `${one.id} [${one.severity}] unresolved`).join(', ')
  if (rec.postStatus !== undefined) return `${rec.postStatus}: ${rec.message ?? ''}`
  return 'review in progress'
}
```

(When the record exists and the post phase has started, add a `post-PR round 1 owed` message: the test expects `'post-PR round 1 owed'` while the round is collecting.)

`onOpened`:

```ts
/** The PR opened: the lifecycle crosses into post-PR review instead of ending. */
const onOpened = async ($: Engine, action: PrAction): Promise<void> => {
  const top = await git($, action.cwd, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return
  const branch = (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const view = await $.process.run(['gh', 'pr', 'view', '--json', 'number,headRefOid'], { cwd: top.out, timeoutMs: 30_000 })
  const self = await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { cwd: top.out, timeoutMs: 30_000 })
  const origin = await git($, top.out, ['remote', 'get-url', 'origin'])
  const pr = view.exitCode === 0 ? (JSON.parse(view.stdout) as { number: number; headRefOid: string }) : undefined
  const saved = await updateRecord($, top.out, branch, rec => ({
    ...rec,
    phase: 'post',
    ...(pr === undefined ? {} : { pr: pr.number, head: pr.headRefOid }),
    ...(self.exitCode === 0 ? { self: self.stdout.trim() } : {}),
    ...(origin.isOk ? { slug: slugOf(origin.out) } : {}),
  }))
  await markOpened($)
  if (saved !== undefined) await advance($, top.out, branch)
}
```

- [ ] **Step 5: Run the tests**

Run: `claude plugin test .`
Expected: all pass, including the 22 carried-over gate tests (their `createPr` path now goes through `readPrAction`). Run tsc: the 0.3.1 TS2589/TS2345/TS7006 errors from the `GITHUB_CREATE_PR` matcher are gone with it.

- [ ] **Step 6: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: guard every route that opens or merges a PR; opening the PR starts post-PR review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 11: Post-PR collection and the Codex fallback (`round.ts`)

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts`
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `collectionDone`, `readReviews`, `readInlineComments`, `readIssueComments`, `readCheckRuns`, `readRoster` (Task 6); `lastReviewedHead` (Task 5).
- Produces:
  ```ts
  async function beginCollect($: Engine, id: string): Promise<void>
  async function poll($: Engine, run: Run): Promise<void>                 // called from the ticker every 30 s while phase === 'collect'
  async function fetchFeedback($: Engine, rec: LifecycleRecord): Promise<{ isOk: boolean; why?: string; feedback: Feedback[]; checks: Check[]; prHead: string }>
  async function endCollect($: Engine, run: Run, got: Awaited<ReturnType<typeof fetchFeedback>>, done: ReturnType<typeof collectionDone>): Promise<void>   // fallback or triage
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/flow.test.ts`:

```ts
/** Pre-PR passes clean and the PR opens: the lifecycle is collecting post-PR round 1. */
const toPost = async ($: Parameters<Parameters<typeof test>[1]>[0], w: ReturnType<typeof world>) => {
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
}

test('with a roster, collection waits for the listed reviewers, then needs no Codex', async ($, on) => {
  const w = world(on)
  const clock = w.clock
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":["ci"]}'
  await toPost($, w)
  await clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('collect')
  w.gh.checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  const spawned = w.spawned.length
  await clock.advance(30_000)
  // Clean: the round completes with nothing to triage, and no Codex fallback ran.
  expect(w.spawned).toHaveLength(spawned)
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(1)
  expect(rec.phase).toBe('ready')
})

test('when no reviewer covers the head by the wait cap, Codex reviews the delta', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  await w.clock.advance(20 * 60_000)
  const last = w.spawned.at(-1)
  expect(last?.prompt).toContain('codex')
  expect(last?.prompt).toContain('after it opened')
  expect((await runOf(w)).phase).toBe('review')
})

test('gh failing mid-collect records an incomplete attempt, uses no round, and resume continues', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.isAuthed = false
  await w.clock.advance(30_000)
  let rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(0)
  expect(rec.postStatus).toBe('error')
  expect((await runOf(w)).message).toContain('gh auth login')
  w.gh.isAuthed = true
  const presentation = { isFullscreen: false, columns: 120 }
  await $.command.run({ command: 'pr-gate', args: 'resume', origin: { kind: 'composer' }, presentation })
  expect((await runOf(w)).phase).toBe('collect')
  rec = await recordOf(w)
  expect(rec.postStatus).toBeUndefined()
})
```

`world` must expose the mock clock: in `tests/world.ts` keep `const clock = mock.clock(on, { now: 1_000 })` and put `clock` on `World`. (The `resume` command is built in Task 13; this test's last four lines go green there. Mark them in this task with a `// green in Task 13` comment and leave them in.)

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL (collect is the Task 9 stub).

- [ ] **Step 3: Implement collection**

Replace the `beginCollect` stub in `round.ts`:

```ts
const POLL_MS = 30_000

const beginCollect = async ($: Engine, id: string): Promise<void> => {
  const now = await $.clock.now()
  const opened = await patch($, id, run => ({
    ...run,
    phase: 'collect',
    phaseStartedAt: now,
    collect: { startedAt: now, lastArrivalAt: now, polledAt: 0, headAt: now },
    activity: 'waiting on reviewers…',
    steps: withStep(run.steps, { id: `r${run.round}-collect`, label: `Round ${run.round} · collect reviews (${run.roundKind})`, state: 'running' }),
  }))
  if (opened === null) return
  const rec = await loadRecord($, opened.root, opened.branch)
  // Round 2 or later on a new head: ask the roster's reviewers to look again.
  if (rec !== undefined && opened.round > 1 && rec.pr !== undefined && rec.slug !== undefined) {
    const roster = await rosterOf($, opened.root)
    for (const who of roster?.requestReview ?? []) {
      await $.process.run(['gh', 'api', '-X', 'POST', `repos/${rec.slug}/pulls/${rec.pr}/requested_reviewers`, '-f', `reviewers[]=${who}`], { cwd: opened.root, timeoutMs: 30_000 })
    }
  }
  $.ui.status(`/pr-gate r${opened.round}: waiting on reviewers`)
}

const rosterOf = async ($: Engine, root: string): Promise<Roster | undefined> => {
  const file = await git($, root, ['show', 'HEAD:.github/pr-gate.json'])
  return file.isOk ? readRoster(file.out) : undefined
}

const ghJson = async ($: Engine, root: string, path: string): Promise<{ isOk: boolean; out: string; err: string }> => {
  const ran = await $.process.run(['gh', 'api', '--paginate', path], { cwd: root, timeoutMs: 60_000 })
  return { isOk: ran.exitCode === 0, out: ran.stdout, err: ran.stderr.trim() }
}

/** Everything GitHub holds for the PR now. Only these polls establish that feedback arrived. */
const fetchFeedback = async ($: Engine, rec: LifecycleRecord) => {
  const fail = (why: string) => ({ isOk: false, why, feedback: [] as Feedback[], checks: [] as Check[], prHead: rec.head })
  if (rec.pr === undefined || rec.slug === undefined) return fail('the PR number or repository is not known')
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr), '--json', 'headRefOid'], { cwd: rec.root, timeoutMs: 30_000 })
  if (pr.exitCode !== 0) return fail(`gh could not read PR #${rec.pr} (${pr.stderr.trim().slice(0, 160) || `exit ${pr.exitCode}`}); check gh auth login and the network`)
  const prHead = (JSON.parse(pr.stdout) as { headRefOid: string }).headRefOid
  const at = `repos/${rec.slug}`
  const [reviews, inline, comments, checks] = await Promise.all([
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/reviews`),
    ghJson($, rec.root, `${at}/pulls/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/issues/${rec.pr}/comments`),
    ghJson($, rec.root, `${at}/commits/${prHead}/check-runs`),
  ])
  const bad = [reviews, inline, comments, checks].find(one => !one.isOk)
  if (bad !== undefined) return fail(`gh api failed (${bad.err.slice(0, 160)}); check gh auth login, rate limits and the network`)
  const feedback = [...readReviews(reviews.out), ...readInlineComments(inline.out), ...readIssueComments(comments.out)].filter(one => one.reviewer !== rec.self)
  return { isOk: true, feedback, checks: readCheckRuns(checks.out), prHead }
}

/** One poll of a collecting round: fail closed on gh trouble, else end collection when it is done. */
const poll = async ($: Engine, run: Run): Promise<void> => {
  const now = await $.clock.now()
  const collect = run.collect
  if (collect === undefined || now - collect.polledAt < POLL_MS) return
  await patch($, run.id, one => ({ ...one, collect: one.collect === undefined ? one.collect : { ...one.collect, polledAt: now } }))
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
  const got = await fetchFeedback($, rec)
  if (!got.isOk) {
    await noteAttempt($, { ...run, waitMs: run.waitMs + (now - collect.startedAt) }, got.why ?? 'gh failed')
    await finish($, run.id, 'error', `Post-PR round ${run.round} could not read GitHub: ${got.why}. Fix it, then /pr-gate resume.`)
    return
  }
  const fresh = got.feedback.filter(one => !rec.processed.includes(one.id))
  const lastArrivalAt = Math.max(collect.lastArrivalAt, ...fresh.map(one => Math.min(one.at, now)))
  const headAt = got.prHead === run.roundStartHead ? collect.headAt : now
  const after = await patch($, run.id, one => ({
    ...one,
    roundStartHead: got.prHead,
    collect: { ...collect, polledAt: now, lastArrivalAt: fresh.length > (one.triaged?.length ?? 0) ? now : lastArrivalAt, headAt },
    triaged: fresh.map(each => each.id),
  }))
  if (after === null) return
  const roster = await rosterOf($, run.root)
  const done = collectionDone({
    roster,
    feedback: got.feedback,
    checks: got.checks,
    head: got.prHead,
    headAt,
    startedAt: collect.startedAt,
    lastArrivalAt: after.collect?.lastArrivalAt ?? now,
    now,
    quietMs: (roster?.quietMinutes ?? config.quietMs / 60_000) * 60_000,
    capMs: (roster?.waitCapMinutes ?? config.waitCapMs / 60_000) * 60_000,
  })
  const waiting = done.missing.length > 0 ? `waiting on ${done.missing.join(', ')}` : 'waiting for feedback to go quiet'
  if (!done.isDone) {
    if (waiting !== after.activity) await patch($, run.id, one => ({ ...one, activity: waiting }))
    return
  }
  await endCollect($, after, got, done)
}

/** Collection is over: Codex covers a head nobody reviewed (or verification owed); then the feedback goes to triage. */
const endCollect = async ($: Engine, run: Run, got: { feedback: Feedback[]; prHead: string }, done: { isComplete: boolean; missing: string[]; covered: string[] }): Promise<void> => {
  const now = await $.clock.now()
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
  const waitMs = now - (run.collect?.startedAt ?? now)
  const evidence: Evidence[] = done.covered.map(reviewer => ({ source: 'github', reviewer, head: got.prHead, isComplete: done.isComplete }))
  const isCovered = done.covered.length > 0 || rec.rounds.some(one => one.isCompleted && one.endHead === got.prHead && one.evidence.length > 0)
  const owesVerification = verificationOwed(rec).length > 0
  const isPassThroughRound1 = rec.passThrough !== undefined && rec.rounds.every(one => one.phase !== 'post')
  const after = await patch($, run.id, one => ({
    ...one,
    waitMs: one.waitMs + waitMs,
    evidence,
    headSha: got.prHead,
    collect: undefined,
    steps: withStep(one.steps, { id: `r${one.round}-collect`, label: `Round ${one.round} · collect reviews (${one.roundKind})`, state: 'done', detail: `${done.covered.length} reviewer${done.covered.length === 1 ? '' : 's'}${done.isComplete ? '' : `, missing ${done.missing.join(', ')}`}` }),
  }))
  if (after === null) return
  if (run.roundKind === 'final-head-check' || ((!isCovered || owesVerification) && !isPassThroughRound1)) {
    await beginReview($, run.id)   // the Codex fallback: reviewPrompt reads run.diffBase (the last reviewed head)
    return
  }
  if (!isCovered) {
    await noteAttempt($, after, `no reviewer covered ${got.prHead.slice(0, 7)} within the wait cap`)
    await finish($, run.id, 'error', `No reviewer covered ${got.prHead.slice(0, 7)} within the wait cap. /pr-gate resume waits again.`)
    return
  }
  await beginTriage($, run.id)   // Task 12
}
```

Hook `poll` into `startTicker`: inside the tick, before the step-timeout check,

```ts
        if (run.phase === 'collect') {
          await poll($, run)
          return   // waiting on reviewers is not a step: no step timeout while collecting
        }
```

`afterReview` for a post-PR round (`run.lifecycle === 'post'`): Codex findings are recorded as in pre-PR, then instead of `beginFix` it calls `beginTriage` (the main agent answers Codex's findings and the GitHub feedback together); for `roundKind === 'final-head-check'` it calls `endRound($, after, true)` directly (review-only: no fix step). Until Task 12, define `beginTriage` as a call to `endRound($, run, true)` when `run.triaged` is empty, which is the clean case the first test exercises.

Add the `Roster`, `Feedback`, `Check`, `Evidence` imports.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: the first two new tests pass; the third passes up to its `// green in Task 13` part (temporarily comment those lines out, uncomment in Task 13). All earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: collect post-PR reviews from GitHub; Codex covers a head nobody reviewed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 12: Post-PR triage, replies, the protected second round, ready

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts`
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `triage`, `applyAnswer`, `mergeFindings`, `invalidate` (Tasks 4–5), `triagePrompt`, `readTriage` (Task 8), `severityHint` (Task 6).
- Produces: `beginTriage($, id)`, `afterTriage($, run)` in `round.ts`; `onAnswer` routes `phase === 'triage'` to `afterTriage`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/flow.test.ts`:

```ts
const inline = (id: number, body: string, head: string, line = 4) => ({
  id, user: { login: 'claude[bot]' }, body, path: 'src/app.ts', line, commit_id: head, created_at: '1970-01-01T00:01:00Z', html_url: `u${id}`,
})
const roster = '{"reviewers":["claude[bot]"],"checks":[]}'

/** Round 1 ends with the reviewer's feedback handed to the main agent. */
const toTriage = async ($: Parameters<Parameters<typeof test>[1]>[0], w: ReturnType<typeof world>, body = '**P1** SQL injection') => {
  w.git.roster = roster
  await toPost($, w)
  w.gh.comments = [inline(11, body, w.gh.prHead)]
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'COMMENTED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
}

test('code changes in the first post-PR round require review of the resulting head', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  expect(w.prompts.at(-1)).toContain('G')
  expect(w.prompts.at(-1)).toContain('reply to thread 11')
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'fixed', severity: 'P1', isSecurity: true, replyId: '991' }] })}`))
  const rec = await recordOf(w)
  expect(rec.replies['inline:11']).toBe('991')
  expect(rec.processed).toContain('inline:11')
  expect(rec.findings.find(one => one.externalId === 'inline:11')?.status).toBe('reported-fixed')
  // Round 2, the protected one, is collecting on the new head.
  const run = await runOf(w)
  expect(run.phase).toBe('collect')
  expect(run.roundKind).toBe('baseline')
  expect(rec.phase).toBe('post')
})

test('a clean first post-PR round does not force a second', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'rebutted', severity: 'P3', note: 'name matches the API', replyId: '992' }] })}`))
  expect((await recordOf(w)).phase).toBe('ready')
  expect(w.prompts.at(-1)).toContain('ready for the merge decision')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --squash' }))).toBe(false)
})

test('another agent pushing during triage makes the PR head the round\'s end head', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  w.gh.prHead = '7'.repeat(40) // pushed by someone else; local HEAD unchanged
  w.git.isAncestor = true
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }] })}`))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post').at(-1)?.endHead).toBe('7'.repeat(40))
  expect((await runOf(w)).roundKind).toBe('baseline')
})

test('duplicate comments and polling consume no new round', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }] })}`))
  const before = await recordOf(w)
  await w.clock.advance(10 * 60_000) // ready: nothing polls, nothing counts
  const after = await recordOf(w)
  expect(after.rounds).toHaveLength(before.rounds.length)
  expect(w.prompts.filter(one => one.includes('New review feedback'))).toHaveLength(1)
})
```

Add `isAncestor: false` and `changed` to `w.git`, and route `merge-base --is-ancestor <a> <b>` with a specific head to `w.git.isAncestor` when its first sha is the local head (keep the submodule route keyed on `isLanded`): `if (args.startsWith(`merge-base --is-ancestor ${w.git.head}`)) return out('', w.git.isAncestor ? 0 : 1)` placed before the generic one.

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: the 4 new tests fail.

- [ ] **Step 3: Implement triage**

In `round.ts`:

```ts
const beginTriage = async ($: Engine, id: string): Promise<void> => {
  const now = await $.clock.now()
  const run = await getRun($)
  if (run === null || run.id !== id) return
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
  const got = await fetchFeedback($, rec)
  const items = got.feedback.filter(one => one.isFinding && !rec.processed.includes(one.id))
  const lastHead = lastReviewedHead(rec)
  const changed = lastHead === undefined ? undefined : await git($, run.root, ['diff', '--name-only', lastHead, run.headSha])
  const changedFiles = new Set(changed?.isOk === true ? changed.out.split('\n').filter(Boolean) : [])
  let n = 0
  const listed = items.map(feedback => {
    const hint = severityHint(feedback.body)
    const title = feedback.body.split('\n')[0]?.replace(/[*_`#>]/g, '').trim().slice(0, 200) || `${feedback.reviewer} ${feedback.kind}`
    const placed = triage({ file: feedback.file, line: feedback.line, title }, rec.findings, changedFiles)
    n += 1
    const finding: Finding = {
      id: `G${run.round}-${n}`,
      round: run.round,
      source: 'github',
      reviewer: feedback.reviewer,
      externalId: feedback.id,
      ...(feedback.threadId === undefined ? {} : { threadId: feedback.threadId }),
      ...(feedback.url === undefined ? {} : { url: feedback.url }),
      severity: hint.severity,
      ...(hint.isSecurity ? { isSecurity: true } : {}),
      title,
      ...(feedback.file === undefined ? {} : { file: feedback.file }),
      ...(feedback.line === undefined ? {} : { line: feedback.line }),
      detail: feedback.body.slice(0, 4000),
      headSeen: run.headSha,
      status: 'open',
      history: [{ round: run.round, status: 'open', by: feedback.reviewer, at: now }],
    }
    return { feedback, cls: placed.cls, matchId: placed.matchId, findingId: finding.id, finding }
  })
  const codex = run.findings.filter(one => one.round === run.round && one.source !== 'github')
  // Commits on the PR that this machine did not make.
  const others = got.prHead !== rec.head ? (await git($, run.root, ['log', '--format=%h %an %s', `${rec.head}..${got.prHead}`])).out.split('\n').filter(Boolean) : []
  if (listed.length === 0 && codex.length === 0 && others.length === 0) {
    await endRound($, run, true)
    return
  }
  const opened = await patch($, id, one => ({
    ...one,
    phase: 'triage',
    phaseStartedAt: now,
    findings: [...one.findings, ...listed.map(each => each.finding)],
    triaged: items.map(each => each.id),
    pending: [{ role: 'triage', step: stepOf(one, 'triage'), isMain: true }],
    activity: 'waiting on the main agent to answer the reviews…',
    steps: withStep(one.steps, { id: `r${one.round}-triage`, label: `Round ${one.round} · answer ${listed.length + codex.length} review item${listed.length + codex.length === 1 ? '' : 's'} (main agent)`, state: 'running' }),
  }))
  if (opened === null) return
  const text = triagePrompt(opened, rec, listed, others)
  // Codex's fallback findings, when there are any, are answered in the same turn.
  const prompt = codex.length === 0 ? text : `${text}\n\nCodex also reviewed ${opened.diffBase.slice(0, 7)}..${opened.headSha.slice(0, 7)}:\n${listFindingsOf(codex)}`
  void $.prompt
    .submit({ text: prompt })
    .then(async entered => {
      if ('drop' in entered && typeof entered.drop === 'string') {
        await finish($, id, 'error', `The reviews could not be sent to the main agent: ${entered.drop}`)
        return
      }
      const startedAt = await $.clock.now()
      await patch($, id, one => (one.phase === 'triage' ? { ...one, phaseStartedAt: startedAt, pending: one.pending.map(each => ({ ...each, isArmed: true })) } : one))
    })
    .catch(() => undefined)
}

const afterTriage = async ($: Engine, run: Run): Promise<void> => {
  const now = await $.clock.now()
  const said = readTriage(run.pending[0]?.answer ?? '')
  const dirty = await git($, run.root, ['status', '--porcelain', '--untracked-files=no'])
  const local = await git($, run.root, ['rev-parse', 'HEAD'])
  const rec = await loadRecord($, run.root, run.branch)
  if (rec === undefined) return
  const pr = await $.process.run(['gh', 'pr', 'view', String(rec.pr ?? ''), '--json', 'headRefOid'], { cwd: run.root, timeoutMs: 30_000 })
  const prHead = pr.exitCode === 0 ? (JSON.parse(pr.stdout) as { headRefOid: string }).headRefOid : undefined
  const localHead = local.isOk ? local.out : run.headSha
  // A push by someone else during the turn: the PR head is where the round ended when it contains this machine's head.
  const isAhead = prHead !== undefined && prHead !== localHead && (await git($, run.root, ['merge-base', '--is-ancestor', localHead, prHead])).isOk
  const endHead = isAhead && prHead !== undefined ? prHead : localHead
  const after = await patch($, run.id, one => ({
    ...one,
    pending: [],
    headSha: endHead,
    findings: one.findings.map(finding => {
      const answer = said.find(each => each.id === finding.id)
      return answer === undefined ? finding : applyAnswer(finding, answer, one.round, 'main', now)
    }),
    steps: withStep(one.steps, { id: `r${one.round}-triage`, label: `Round ${one.round} · answer the reviews (main agent)`, state: 'done', detail: `${said.length} answered` }),
  }))
  if (after === null) return
  if (dirty.isOk && dirty.out !== '') {
    await noteAttempt($, after, 'the main agent left uncommitted changes')
    await finish($, run.id, 'error', 'Uncommitted changes after the reviews were answered: commit and push them, then /pr-gate resume.')
    return
  }
  const triaged = run.triaged ?? []
  await updateRecord($, run.root, run.branch, one => ({
    ...one,
    processed: [...new Set([...one.processed, ...triaged])],
    replies: {
      ...one.replies,
      ...Object.fromEntries(
        said.flatMap(each => {
          const externalId = after.findings.find(f => f.id === each.id)?.externalId
          return each.replyId === undefined || externalId === undefined ? [] : [[externalId, each.replyId]]
        }),
      ),
    },
  }))
  if (endHead !== run.roundStartHead) {
    const changed = await git($, run.root, ['diff', '--name-only', run.roundStartHead, endHead])
    await patch($, run.id, one => ({ ...one, findings: invalidate(one.findings, changed.isOk ? new Set(changed.out.split('\n').filter(Boolean)) : 'all').map(f => (f.round === one.round ? { ...f, needsRecheck: undefined } : f)) }))
  }
  const ended = await getRun($)
  if (ended !== null) await endRound($, { ...ended, headSha: endHead }, true)
}
```

`endRound` currently reads `git rev-parse HEAD` for `endHead`; change it to use `run.headSha` when `run.lifecycle === 'post'` (the triage step already settled the end head, PR head included). `listFindingsOf` is `core.ts`'s `listFindings`; export it from `core.ts` under that name.

In `onAnswer`, add `else if (after.phase === 'triage') await afterTriage($, after)`. In `afterReview`, the post-PR non-final branch calls `beginTriage($, run.id)`. Delete the Task 11 stand-in for `beginTriage`.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: post-PR triage with replies and dedup; the protected second round; ready

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 13: Commands, waivers, resume, and restarts

**Files:**
- Modify: `pr-lifecycle/hooks/register.tsx`
- Test: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/gate.test.ts` (the 0.3.1 waiver test)

**Interfaces:**
- Consumes: everything above.
- Produces: `/pr-gate` verbs `start|<base>`, `status`, `stop`, `resume`, `waive pre|post|<findingId> <reason>`, `allow <n> <reason>`, `reset`; `session.start` resumes a record in `post`.

- [ ] **Step 1: Write the failing tests**

Uncomment the `// green in Task 13` lines from Task 11. Append to `tests/flow.test.ts`:

```ts
const asPerson = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const cmd = ($: Parameters<Parameters<typeof test>[1]>[0], args: string, as: object = asPerson) => $.command.run({ command: 'pr-gate', args, ...as } as never)

test('a pre-PR waiver does not waive the post-PR lifecycle', async ($, on) => {
  const w = world(on)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  expect((await cmd($, 'waive pre hotfix for the outage')).text).toContain('post-PR review still runs')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect((await recordOf(w)).phase).toBe('post')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1' }))).toBe(true)
  await cmd($, 'waive post reviewed by hand')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1' }))).toBe(false)
  const waivers = (await recordOf(w)).waivers
  expect(waivers.map(one => [one.scope, one.reason, one.by])).toEqual([
    ['pre', 'hotfix for the outage', 'composer'],
    ['post', 'reviewed by hand', 'composer'],
  ])
})

test('only the person waives, allows or resets', async ($, on) => {
  world(on)
  for (const args of ['waive pre x', 'waive post x', 'allow 1 x', 'reset']) {
    expect((await cmd($, args, { ...asPerson, origin: { kind: 'sdk' } })).text).toContain('Only the person')
  }
  expect((await cmd($, 'waive hotfix')).text).toContain('waive pre|post|<findingId> <reason>')
})

test('exhaustion is distinct from passing, and the person can allow one more round', async ($, on) => {
  const w = world(on, { allowanceStandard: 1 })
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  expect((await runOf(w)).status).toBe('exhausted')
  const before = w.spawned.length
  await cmd($, 'allow 1 the fix is small')
  expect(w.spawned.length).toBeGreaterThan(before)
  expect((await recordOf(w)).grants).toHaveLength(1)
})

test('fix commits and a session restart keep the budget and the history', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  await $.turn.complete(turn(review('r2-review', 'PASS'), 'agent-2'))
  await $.tool.call(createPr)
  const before = await recordOf(w)
  // A new session: the session state is gone, the store is not.
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const after = await recordOf(w)
  expect(after.rounds).toEqual(before.rounds)
  expect(after.findings).toEqual(before.findings)
  expect((await runOf(w)).phase).toBe('collect')
})

test('a restart during triage neither re-triages nor replies twice', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }] })}`))
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(60_000)
  expect(w.prompts.filter(one => one.includes('New review feedback'))).toHaveLength(1)
})
```

In `tests/world.ts`, add `clearState()` which sets the run state back to `null` through the test's state hook (or, if the testing API offers no reset, starts the test's `$.state` fresh by setting `RUN` to `null` with `$.state.set` — use whichever the types allow), and make `session.start` dispatchable (check `SessionStartInput` for required fields and fill them).

Change the 0.3.1 waiver test in `gate.test.ts`: rename to `'only the person waives the pre-PR review, and a waiver lets that commit open its PR'`, use `waive pre hotfix`, and expect the text `'waived pre-PR review for feat/x'`.

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: the new tests fail.

- [ ] **Step 3: Implement the commands**

Rewrite the `command.run` handler in `register.tsx`:

```ts
  on('command.run', { command: 'pr-gate' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const run = await getRun($)
    const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
    if (!top.isOk && verb !== 'status') return { text: 'Not a git repository.' }
    const root = top.out
    const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
    const head = (await git($, root, ['rev-parse', 'HEAD'])).out
    const rec = await loadRecord($, root, branch)
    const now = await $.clock.now()
    if (verb === 'status') return { text: await statusText($, run, rec) }
    if (verb === 'stop') {
      if (run === null || run.status !== 'running') return { text: '/pr-gate is not running.' }
      await finish($, run.id, 'stopped', 'Stopped by the person.')
      return { text: '/pr-gate stopped. The record stays: /pr-gate resume continues it. Opening and merging stay held.' }
    }
    if (verb === 'resume') {
      if (rec === undefined) return { text: `No lifecycle for ${branch} yet: /pr-gate starts one.` }
      await saveRecord($, { ...rec, postStatus: undefined, ...(rec.phase === 'pre' && rec.preStatus !== 'passed' ? { preStatus: undefined } : {}) })
      await advance($, root, branch)
      return { text: `/pr-gate resumed for ${branch}.` }
    }
    if (verb === 'waive' || verb === 'allow' || verb === 'reset') {
      if (!isPerson) return { text: 'Only the person can waive, allow rounds or reset.' }
      if (verb === 'reset') {
        if (rec !== undefined) await saveRecord($, { ...rec, phase: 'archived' })
        if (run !== null && run.status === 'running') await finish($, run.id, 'stopped', 'Reset by the person.')
        return { text: `/pr-gate: the lifecycle for ${branch} is archived. /pr-gate starts a fresh one.` }
      }
      if (verb === 'allow') {
        const n = Number(rest[0])
        const reason = rest.slice(1).join(' ').trim()
        if (!Number.isInteger(n) || n < 1 || n > 5 || reason === '') return { text: `Say how many and why: /${COMMAND} allow <1-5> <reason>` }
        if (rec === undefined) return { text: `No lifecycle for ${branch} yet.` }
        await saveRecord($, { ...rec, grants: [...rec.grants, { n, reason, head, at: now }], postStatus: undefined, ...(rec.phase === 'pre' ? { preStatus: undefined } : {}) })
        await advance($, root, branch)
        return { text: `/pr-gate: ${n} more round${n === 1 ? '' : 's'} allowed for ${branch}: ${reason}.` }
      }
      const [scope = '', ...why] = rest
      const reason = why.join(' ').trim()
      const isFinding = /^[RG]\d+-\d+$/.test(scope)
      if ((scope !== 'pre' && scope !== 'post' && !isFinding) || reason === '') return { text: `Say what and why: /${COMMAND} waive pre|post|<findingId> <reason>` }
      const waiver: Waiver = { scope: isFinding ? 'finding' : (scope as 'pre' | 'post'), ...(isFinding ? { findingId: scope } : {}), head, reason, by: e.origin.kind, at: now }
      const base = rec ?? { ...newRecord({ root, branch, base: config.bases[0] ?? 'dev', head, tier: 'standard', tierWhy: 'waived before scoping', lane: 'full', allowance: 0, at: now }) }
      await saveRecord($, { ...base, waivers: [...base.waivers, waiver] })
      if (scope === 'pre' && run !== null && run.status === 'running' && run.lifecycle === 'pre') await finish($, run.id, 'waived', `Waived: ${reason}`)
      if (isFinding) await advance($, root, branch)
      return {
        text:
          scope === 'pre'
            ? `/pr-gate waived pre-PR review for ${branch} at ${head.slice(0, 7)}: ${reason}. The PR may open; post-PR review still runs.`
            : scope === 'post'
              ? `/pr-gate waived post-PR review for ${branch} at ${head.slice(0, 7)}: ${reason}. This head may merge; a new commit needs a new review or waiver.`
              : `/pr-gate accepted ${scope} unresolved: ${reason}.`,
      }
    }
    const base = verb === '' || verb === 'start' ? rest[0] : verb
    return { text: `/pr-gate: ${await startGate($, { base })}` }
  })
```

`judgeCreate` already treats a `pre` waiver at this head as allowing the PR (Task 9 step 8); `judgeMerge` treats a `post` waiver at the PR head as allowing the merge (Task 10). `statusText` prints one line: `` `${rec.branch} → ${rec.base}: ${rec.phase}${rec.postStatus ? ` (${rec.postStatus})` : ''}, ${usedRounds(rec)}/${rec.allowance + granted} rounds used, baseline ${post rounds}/2, ${unresolvedBlockers(rec).length} blocking open, ${verificationOwed(rec).length} owed. ${rec.message ?? ''}` `` plus the 0.3.1 pane-placement sentence.

`session.start`: after registering the command (its description becomes `'Run /pr-gate: pre-PR Codex review, then the PR\'s own reviews, under one budget (start, status, stop, resume, waive, allow, reset)'` and its `argumentHint` `'[base] | status | stop | resume | waive pre|post|<id> <reason> | allow <n> <reason> | reset'`), if no run is live, read the current branch's record; when `rec.phase === 'post'` and `rec.postStatus === undefined`, call `advance($, root, branch)` so collection resumes. Processed ids and recorded replies keep it from repeating work.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: scoped waivers, allow, resume, reset; a restart resumes post-PR collection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 14: The pane

**Files:**
- Create: `pr-lifecycle/hooks/pane.tsx` (code moved from `register.tsx`)
- Modify: `pr-lifecycle/hooks/register.tsx`
- Test: `pr-lifecycle/tests/gate.test.ts` (pane test), `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `export function renderPane($: Engine, e: UiRenderEvent, run: Run | null, rec: LifecycleRecord | undefined, now: number): JSX.Element` used by `register.tsx`'s `ui.render` handler. (Use the exact render-event type name from the host types; the 0.3.1 handler's `e`.)

- [ ] **Step 1: Write the failing test**

Append to `tests/flow.test.ts`:

```ts
test('the pane shows the phase, the shared budget, who is awaited, and reported vs verified fixes', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]","copilot"],"checks":[]}'
  await toPost($, w)
  await w.clock.advance(30_000)
  const ui = await $.ui.mount({
    plugin: 'pr-lifecycle',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr-lifecycle',
    props: { title: 'PR lifecycle', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 40, rows: 40 } as never, view: {} as never },
  })
  expect(await ui.find({ type: 'Text', text: 'post-PR · 1/4 rounds used · baseline 0/2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'waiting on claude[bot], copilot' })).toBeDefined()
  await ui.unmount()
})
```

Update the 0.3.1 pane test's expected texts: `'Round 1 · codex review — FAIL · 1 blocking'` stays; add `expect(await ui.find({ type: 'Text', text: 'pre-PR · 0/4 rounds used' })).toBeDefined()`.

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test .`
Expected: FAIL.

- [ ] **Step 3: Implement**

Move the body of the `ui.render` handler into `pane.tsx` as `renderPane`. In `register.tsx` the handler becomes:

```ts
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const run = await read($, runAtom)
    const now = await read($, tickAtom)
    const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
    const branch = top.isOk ? (await git($, top.out, ['rev-parse', '--abbrev-ref', 'HEAD'])).out : ''
    const rec = top.isOk ? await loadRecord($, top.out, run?.branch ?? branch) : undefined
    return renderPane($, e, run, rec, now)
  })
```

In `renderPane`, replace the second header line with the budget line:

```tsx
        <Text dimColor wrap="truncate-end">
          {rec === undefined ? '' : `${rec.phase === 'pre' ? 'pre-PR' : rec.phase === 'post' ? 'post-PR' : rec.phase} · ${usedRounds(rec)}/${rec.allowance + rec.grants.reduce((s, g) => s + g.n, 0)} rounds used${rec.phase === 'pre' ? '' : ` · baseline ${Math.min(2, rec.rounds.filter(r => r.phase === 'post' && r.kind === 'baseline' && r.isCompleted).length)}/2`}`}
        </Text>
        <Text dimColor wrap="truncate-end">
          round {run.round} · {run.tier} blast radius{run.lane === 'light' ? ' · light lane' : ''} · codex {run.effort} · active {elapsed(run.activeMs + (run.phase === 'collect' ? 0 : now - run.phaseStartedAt))}
          {run.activeMs > config.routineRoundMs ? ' (over the routine timebox)' : ''} · waiting {elapsed(run.waitMs + (run.phase === 'collect' ? now - run.phaseStartedAt : 0))}
        </Text>
```

The `headline` gains `run.phase === 'collect' ? 'collecting reviews, round N'` and `run.phase === 'triage' ? 'answering reviews, round N'`; the activity line already shows `waiting on claude[bot], copilot` (set by `poll`). The findings marks: `verified-fixed` ✔, `reported-fixed` ✓ with ` — reported fixed, unverified`, `rebutted` ↩, `deferred` ⏸, open blocking ●, open other ·; strikethrough only for `verified-fixed`. The heading reads `Findings (n, k blocking open, m owed verification)`. Rename the pane title in every `$.ui.open` to `'PR lifecycle'`.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle
git commit -m "pr-lifecycle: the pane shows phase, shared budget, baseline, waiting and verified fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

---

### Task 15: Remaining spec behaviors, docs and versions

**Files:**
- Modify: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/README.md`, `README.md`
- No code changes expected; if a test here fails, fix the owning module and say so in the commit.

- [ ] **Step 1: Add the last two behavior tests**

```ts
test('an exhausted pre-PR allowance still permits the protected post-PR baseline', async ($, on) => {
  const w = world(on, { allowanceStandard: 1 })
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'Off by one in pagination' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  expect(isHeld(await $.tool.call(createPr))).toBe(false) // onExhausted: open-pr, not security
  expect((await runOf(w)).phase).toBe('collect')
  expect((await runOf(w)).roundKind).toBe('baseline')
})

test('two repositories with different roster files each wait for their own reviewers', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["junie[bot]"],"checks":[]}'
  await toPost($, w)
  await w.clock.advance(30_000)
  expect((await runOf(w)).activity).toContain('junie[bot]')
  w.git.roster = '{"reviewers":["rovodev[bot]"],"checks":[]}'
  await w.clock.advance(30_000)
  expect((await runOf(w)).activity).toContain('rovodev[bot]')
})

test('existing pass-through cases still skip pre-PR Codex and still get post-PR round 1', async ($, on) => {
  const w = world(on)
  w.git.numstat = '3\t1\tdocs/guide.md'
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.spawned).toHaveLength(0)
  expect((await recordOf(w)).phase).toBe('post')
})
```

(The second test switches the roster file between polls to stand in for two repositories; the roster is read on every poll from the checked-out branch, which is what makes per-repository rosters work.)

- [ ] **Step 2: Map the spec's 13 behaviors to tests**

Run: `claude plugin test .` and check each behavior has a passing test:

| # | Behavior | Test (file: name) |
| --- | --- | --- |
| 1 | Clean pre-PR still enters post-PR | flow: a clean pre-PR result still enters post-PR review, and merging stays held |
| 2 | Exhausted pre-PR permits baseline | flow: an exhausted pre-PR allowance still permits the protected post-PR baseline |
| 3 | Clean first post-PR round, no second | flow: a clean first post-PR round does not force a second |
| 4 | Changes in post-PR round 1 need review | flow: code changes in the first post-PR round require review…; another agent pushing during triage… |
| 5 | Several reviewers = one round | flow: several reviewers in one cycle consume one round |
| 6 | Duplicates/polling consume nothing | flow: duplicate comments and polling consume no new round |
| 7 | Fix commits and restarts keep budget | flow: fix commits and a session restart keep the budget and the history |
| 8 | New scope invalidates affected evidence | flow: new scope invalidates only the affected evidence (Task 9); lifecycle: coverage… |
| 9 | Omitted findings not marked fixed | flow: omitted findings are not marked fixed |
| 10 | Timeout retries record effort only | flow: timeout retries record effort without recording a completed round |
| 11 | Pass-throughs still supported | flow: existing pass-through cases…; gate: the 0.3.1 pass-through tests |
| 12 | Different repos, different rosters | flow: two repositories with different roster files… |
| 13 | Exhaustion distinct from passing | flow: exhaustion is distinct from passing…; a security P1 left open… |

Expected: every row green. Run the type check and `claude plugin validate .`; both clean.

- [ ] **Step 3: Write `pr-lifecycle/README.md`**

Rewrite the 0.3.1 README for 1.0.0, keeping its voice and structure. First line: `Version 1.0.0. Part of [pr-gate](../README.md); MIT licensed, see [LICENSE](../LICENSE).` Sections:
- **What happens**: pre-PR rounds (as 0.3.1 steps 1–5, with the shared allowance), opening the PR as a phase change, post-PR rounds (collect, Codex fallback, triage, replies), the protected baseline, ready, the merge hold.
- **One round**: the spec's definition, verbatim from LIFECYCLE_SPEC.md "Agreed definition of one round".
- **The budget**: allowance by tier, reserve rule, baseline and final-head check outside it, `allow`, exhaustion.
- **Findings**: the five statuses and that omitted findings are never marked fixed.
- **Reviewers per repository**: `.github/pr-gate.json` with the example from the spec, and the no-roster rule.
- **What is held**: every route `readPrAction` knows, the fail-closed fallback for unknown GitHub tools, and what is not held.
- Keep **What counts as already reviewed**, **The light lane**, **Effort** from 0.3.1.
- **Commands**: the table from the spec section 5.
- **Options**, and **Migrating from codex-gate 0.3.1**: the option table from the spec; note that the store key changed (`lifecycle:<root>:<branch>` under plugin `pr-lifecycle`), so 0.3.1 pass records do not carry over, and that options set under `pluginConfigs["codex-gate"]` must be copied to `pluginConfigs["pr-lifecycle"]`.
- **Running it**: never together with `codex-gate`.

- [ ] **Step 4: Update the root `README.md`**

Add a row to the component table:

```markdown
| [pr-lifecycle](pr-lifecycle/) | 1.0.0   | `/pr-gate` across the PR lifecycle: pre-PR Codex rounds, then the PR's own reviews, under one review budget and record. [README](pr-lifecycle/README.md) |
```

Replace the "In planning" section with a "Which one to load" note: `codex-gate` 0.3.1 is the plugin in daily use; `pr-lifecycle` 1.0.0 replaces it once Adam switches `CLAUDE_CODE_PLUGIN_DIRS`; never load both, since both register `/pr-gate` and hold PR creation. Update the opening sentence ("Checks that run on a branch before its pull request is opened") to "Checks that run on a branch before and after its pull request is opened".

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle README.md
git commit -m "pr-lifecycle 1.0.0: remaining spec behaviors, README, version table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uo5tautwojx3MV7KCquhb"
```

- [ ] **Step 6: Tell Adam**

Report: tests passing (count), type check clean, the README migration notes, and that switching `CLAUDE_CODE_PLUGIN_DIRS` from `codex-gate` to `pr-lifecycle` is his call. Mention that `codex-gate` 0.3.1 still has the create-PR bypass through the github-graphql connector until he switches or asks for a fix there.
