### Task 8: No hold after a waiver (finding 29), and post-PR prompts list the whole standing

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (`endRound` guard at line 1851; `advance` post branch at line 2075; the queue in `say` and `holdingPrompts`, lines 393-435)
- Modify: `pr-lifecycle/hooks/core.ts` (`reportPrompt` and `heldPrompt` take an optional `standing`)
- Modify: `pr-lifecycle/tests/world.ts` (`onFetch` may be async)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `reportPrompt(rec, next, standing?: Standing)` and `heldPrompt(rec, why, nextStep, standing?: Standing)`. In the post phase, `holdText(standing, idsAlreadyListed)` is appended before the "Do not merge" lines.
- Produces: `say($, key, text, isNote = false)`. A queued note merges into a prompt queued by the same command (batch) for the same record (used by Task 9).
- Produces: `export function mergeNotes(held: readonly Queued[]): Queued[]`, where `type Queued = { text: string; key: RecordKey; batch: number; isNote?: boolean }`.
- Produces: `export function dropQueued(key: RecordKey): void`: drops undelivered prompts and notes about `key`'s record that earlier commands queued (used by stop and reset in Task 9).

- [ ] **Step 1: Make `onFetch` awaitable** in `tests/world.ts`. Change the type to `onFetch?: () => void | Promise<void>`. Change the handler to async (`on('process.run', async (_$, e) => {`) and call `await w.git.onFetch?.()`.

- [ ] **Step 2: Write the failing tests** (`flow.test.ts`):

```ts
test('R80: a waive post given while a round is finishing is followed by no hold and no new round', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const moved = 'f'.repeat(40)
  w.gh.prHead = moved
  w.git.head = moved
  w.git.isAncestor = true
  w.gh.reviews = covers(moved)
  let waived = ''
  w.git.onFetch = async () => {
    if (waived === '') waived = String((await say($, 'waive post reviewed by hand')).text)
  }
  const prompts = w.prompts.length
  const spawned = w.spawned.length
  await w.clock.advance(30_000)
  await w.clock.advance(1000)
  expect(waived).toContain('waived post-PR review')
  expect((await runOf(w)).status).toBe('waived')
  expect(w.spawned).toHaveLength(spawned)
  const sent = w.prompts.slice(prompts)
  expect(sent.some(one => one.includes('stopped short of ready'))).toBe(false)
  expect(sent.some(one => one.includes('post-PR round'))).toBe(false)
})

test('R80: after waive post, a resume says the waiver covers the head instead of sending the hold', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'waive post the rename is cosmetic')
  await w.clock.advance(1000)
  const prompts = w.prompts.length
  await say($, 'resume')
  await w.clock.advance(1000)
  const sent = w.prompts.slice(prompts)
  expect(sent.some(one => one.includes('stopped short of ready'))).toBe(false)
  expect(sent.at(-1)).toContain("the person's post waiver covers")
})

test('R79: a post-PR hold prompt lists CI next to the findings', async ($, on) => {
  const w = world(on)
  w.gh.checks = [{ name: 'check', status: 'in_progress', conclusion: null }]
  await toAwaiting($, w)
  expect(w.prompts.at(-1)).toContain('check check running')
})
```

The first test relies on `beginTriage` fetching when the PR head moved (`got.prHead !== rec.head`). If the fake doesn't reach that fetch, trace `pollOnce` → `endCollect` → `beginTriage` with the fakes and move `w.gh.prHead` at the point the fetch is reached. The test must make the waiver land while `beginTriage` awaits, then show the late `endRound` doing nothing.

- [ ] **Step 3: Run them to verify they fail.** Expected: FAIL. The late round sends a hold or starts a round; resume sends "stopped short of ready"; the prompt lacks CI.

- [ ] **Step 4: Guard `endRound`.** At the top of `endRound` (round.ts:1851):

```ts
  // A run stopped or waived while this step awaited git or gh records nothing more and decides nothing (finding 29, R80).
  const live = await getRun($)
  if (live === null || live.id !== run.id || live.status !== 'running') return
```

Then check each `endRound` caller (lines 1260, 1464, 1558, 1609, 2231, 2336, 2363) and confirm none calls it after finishing its own run. If one does, call `finish` after `endRound` there instead.

- [ ] **Step 5: `advance` honours a post waiver before it dispatches any work.** In `advance` (round.ts:1972), right after the `isStillMine` check (line 1976) and **before** the first branch that dispatches work (`startRound` at 1993, and later `startAnswer` and `startRecheck`), add:

```ts
  // A post waiver covering this head ends review work for it (R80): checked before any branch that starts triage, a recheck or a round
  // (PR #19 review), so a waived head gets what the waiver covers and what CI still holds, never the hold or more review.
  const waived = rec.phase !== 'pre' && rec.pr !== undefined && securityHolds(rec).length === 0 && rec.waivers.some(one => one.scope === 'post' && one.head === rec.head)
  if (waived && rec.pr !== undefined) {
    const standing = await gatherStanding($, rec, { number: rec.pr, baseRefName: rec.base, headRefOid: rec.head })
    await say($, rec, `pr-gate: the person's post waiver covers PR #${rec.pr} at ${rec.head.slice(0, 7)}.\n\n${holdText(standing)}`)
    return
  }
```

Then, at the end of the post branch, pass the standing to the report: replace `await say($, saved, reportPrompt(saved, next))` with:

```ts
  const pr = saved.pr === undefined ? undefined : { number: saved.pr, baseRefName: saved.base, headRefOid: saved.head }
  await say($, saved, reportPrompt(saved, next, pr === undefined ? undefined : await gatherStanding($, saved, pr)))
```

Add the regression the PR #19 review asked for (`flow.test.ts`; `reopenedApproval` and `KEY` are defined in the file by Task 3):

```ts
test('R80: after waive post, resume starts no triage, recheck or review round on the waived head (PR #19 review)', async ($, on) => {
  for (const [label, over] of [
    ['an open P2 the agent can answer', { status: 'open' }],
    ['a fix awaiting verification', { status: 'reported-fixed' }],
  ] as const) {
    const w = world(on)
    await toPost($, w)
    const rec = await recordOf(w)
    w.store.set(KEY, { ...rec, findings: [{ ...reopenedApproval(), history: [], ...over }] })
    await say($, 'waive post reviewed by hand')
    await w.clock.advance(1000)
    const prompts = w.prompts.length
    const spawned = w.spawned.length
    await say($, 'resume')
    await w.clock.advance(1000)
    expect(w.spawned, label).toHaveLength(spawned)
    const sent = w.prompts.slice(prompts)
    expect(sent.some(one => one.includes('New review feedback') || one.includes('stopped short of ready')), label).toBe(false)
    expect(sent.at(-1), label).toContain("the person's post waiver covers")
  }
})
```

Add a third case where a review round is owed on the waived head: build a record for which `decideNext(rec).kind === 'round'` (assert that precondition in the test before waiving), and expect the same. If two worlds per test are refused, split the cases into separate tests. If `expect` takes no message argument here, drop the labels.

- [ ] **Step 6: Append the standing to post prompts.** In `core.ts` `reportPrompt`, after the "What holds the merge" block:

```ts
  if (standing !== undefined) {
    const rest = holdText(standing, new Set(holding.map(one => one.id)))
    if (rest !== '') lines.push('', rest)
  }
```

Do the same in the post branch of `heldPrompt` (with `holds`). Add the optional `standing?: Standing` parameter to both, and import `holdText` and the type. Where `advance` calls `heldPrompt` for a post record, pass the standing if one was gathered; the pre-PR branch is unchanged.

- [ ] **Step 7: Notes merge only within one command's batch.** The queue is global and flushed a second later, so two commands can queue before one flush (PR #19 review). Each outermost `holdingPrompts` call gets a batch id; entries carry it, the flush sends only its own batch, and merging never crosses batches. Replace `queued`, `holdingPrompts` and `say` (round.ts:393-433) with:

```ts
type Queued = { text: string; key: RecordKey; batch: number; isNote?: boolean }
let holdDepth = 0
let batch = 0
let queued: Queued[] = []

const sameRecord = (a: RecordKey, b: RecordKey): boolean => a.root === b.root && a.branch === b.branch

/** Within one command's batch, an action's note and a prompt for the same record become one prompt: the note's first line leads it (R81). */
export function mergeNotes(held: readonly Queued[]): Queued[] {
  const isPair = (a: Queued, b: Queued): boolean => a.batch === b.batch && sameRecord(a.key, b.key)
  return held.flatMap(one => {
    if (one.isNote === true) return held.some(each => each.isNote !== true && isPair(each, one)) ? [] : [one]
    const note = held.find(each => each.isNote === true && isPair(each, one))
    return [note === undefined ? one : { ...one, text: `${note.text.split('\n')[0] ?? ''}\n\n${one.text}` }]
  })
}

/** Drops what earlier commands queued about `key`'s record and haven't sent: a stop or reset supersedes it (R81, PR #19 review). */
export function dropQueued(key: RecordKey): void {
  queued = queued.filter(one => one.batch === batch || !sameRecord(one.key, key))
}

/** Runs `body` with the prompts it decides held back; once it has returned, its own batch is sent one second later, in order. */
export async function holdingPrompts<T>($: Engine, body: () => Promise<T>): Promise<T> {
  if (holdDepth === 0) batch += 1
  const mine = batch
  holdDepth += 1
  try {
    return await body()
  } finally {
    holdDepth -= 1
    if (holdDepth === 0 && queued.some(one => one.batch === mine)) {
      $.clock.after(1000, () => {
        const held = mergeNotes(queued.filter(one => one.batch === mine))
        queued = queued.filter(one => one.batch !== mine)
        void (async () => {
          for (const one of held) await deliver($, one.key, one.text)
        })()
      })
    }
  }
}

export async function say($: Engine, key: RecordKey, text: string, isNote = false): Promise<void> {
  if (holdDepth > 0) {
    queued.push({ text, key, batch, ...(isNote ? { isNote } : {}) })
    return
  }
  await deliver($, key, text)
}
```

Keep the existing doc comments on `RecordKey`, `deliver` and `say`.

Add a unit test (in `lifecycle.test.ts`, or a new `tests/round.test.ts` if importing `round.ts` there is cleaner):

```ts
test('R81: a note merges into a prompt of the same batch and record only', async () => {
  const a = { root: '/repo', branch: 'feat/x' }
  const b = { root: '/repo', branch: 'feat/y' }
  const out = mergeNotes([
    { text: 'pr-gate: the person allowed 1 more round: x.\n\nmore', key: a, batch: 1, isNote: true },
    { text: 'pr-gate: round prompt', key: a, batch: 1 },
    { text: 'pr-gate: the person stopped the gate.', key: b, batch: 1, isNote: true },
    { text: 'pr-gate: the person reset the lifecycle of feat/x.', key: a, batch: 2, isNote: true },
  ])
  expect(out.map(one => one.text)).toEqual([
    'pr-gate: the person allowed 1 more round: x.\n\npr-gate: round prompt',
    'pr-gate: the person stopped the gate.',
    'pr-gate: the person reset the lifecycle of feat/x.',
  ])
})
```

- [ ] **Step 8: Run the suite.** Expected: PASS. Prompts that assert `toContain` on hold texts still pass because the standing is appended.

- [ ] **Step 9: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/tests
git commit -m "pr-lifecycle: no hold after a waiver, a late round decides nothing, post prompts list CI (R79, R80)"
```

---

