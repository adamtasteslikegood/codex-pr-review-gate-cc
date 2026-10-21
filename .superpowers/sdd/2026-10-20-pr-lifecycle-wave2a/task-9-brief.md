### Task 9: Every manual action tells the agent (decision E)

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts` (add `tellAgent`)
- Modify: `pr-lifecycle/hooks/register.tsx:840-1049` (`logCommand`; the `runCommand` branches stop, reset, allow, waive finding, waive pre, waive post)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `say($, key, text, true)` and `mergeNotes` (Task 8), `gatherStanding` and `holdText` (Tasks 5, 6).
- Produces: `export async function tellAgent($: Engine, key: RecordKey, did: string, next: string, standing?: Standing): Promise<void>`.
- Produces: `const isPerson = (origin: string): boolean => origin === 'composer' || origin === 'bridge' || origin === 'pane'` in `register.tsx`.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`):

```ts
test('R81: waive post tells the agent what it covers and what still holds', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  await say($, 'waive post reviewed by hand')
  await w.clock.advance(1000)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('pr-gate: the person waived post-PR review of PR #1')
  expect(said).toContain('Nothing else holds the merge')
  expect(said).toContain("the merge decision, which is the person's")
})

test('R81: the person\'s stop tells the agent to stop waiting; an agent\'s stop says nothing', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  const prompts = w.prompts.length
  await say($, 'stop', { ...asPerson, origin: { kind: 'sdk' } })
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts)
  await say($, 'resume')
  await w.clock.advance(1000)
  const before = w.prompts.length
  await say($, 'stop')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(before + 1)
  expect(w.prompts.at(-1)).toContain('the person stopped the gate')
  expect(w.prompts.at(-1)).toContain('Stop waiting on it')
})

test('R81: an allow that leads to a prompt sends one message, the action line first', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const prompts = w.prompts.length
  await say($, 'allow 2 more review')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts + 1)
  expect(w.prompts.at(-1)?.startsWith('pr-gate: the person allowed 2 more rounds')).toBe(true)
  expect(w.prompts.at(-1)).toContain('Their options:')
})

test('R81: waiving a finding tells the agent what still holds; a refused waiver sends nothing', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const prompts = w.prompts.length
  await say($, 'waive G9-9 because')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts)
  await say($, 'waive G2-1 the rename lands with KAN-9')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts + 1)
  expect(w.prompts.at(-1)?.startsWith('pr-gate: the person waived G2-1')).toBe(true)
  expect(w.prompts.at(-1)).toContain('ready for the merge decision')
})

test('R81: waive pre tells the agent to open the PR even with openPr off', { options: { openPr: false } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await say($, 'waive pre hotfix for the outage')
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('the person waived the pre-PR review')
  expect(w.prompts.at(-1)).toContain('open the pull request')
})

test('R81: reset tells the agent the lifecycle was archived', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'reset')
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('the person reset the lifecycle of feat/x')
})
```

Check the plugin option name for `openPr` in `pr-lifecycle/.claude-plugin/plugin.json` and `configOf` (round.ts:138). Use whatever key `configOf` reads for `config.openPr`.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL. No messages are sent.

- [ ] **Step 3: `tellAgent`** in `round.ts`, after `say`:

```ts
/** The person's action, told to the agent (R81): what they did, what still holds, and the agent's next step. Queued as a note. */
export async function tellAgent($: Engine, key: RecordKey, did: string, next: string, standing?: Standing): Promise<void> {
  const lines = [`pr-gate: the person ${did}.`]
  if (standing !== undefined) lines.push('', holdText(standing))
  lines.push('', `Your next step: ${next}`)
  await say($, key, lines.join('\n'), true)
}
```

- [ ] **Step 4: Wire the actions** in `register.tsx` `runCommand`. Add `isPerson` near the top of the file.
- **stop** (lines 859-863), replacing the body after the `not running` check:

```ts
    if (isPerson(origin)) await claimRecord($, run.root, run.branch)
    dropQueued(run)
    await finish($, run.id, 'stopped', 'Stopped by the person.')
    if (isPerson(origin)) {
      await tellAgent($, run, 'stopped the gate', 'stop waiting on it. Opening and merging stay held; /pr-gate resume continues it.')
    }
    return `/${COMMAND} stopped. The record stays: /${COMMAND} resume continues it. Opening and merging stay held.`
```

- **reset**: after `archiveLifecycle(...)`:

```ts
    dropQueued({ root, branch })
    await tellAgent($, { root, branch }, `reset the lifecycle of ${branch}: it is archived, its history kept`,
      `nothing for the old review. /${COMMAND} starts a fresh one; opening and merging stay held until it completes.`)
```

- **allow**: right after `updateRecord(... grants ...)`, before `advance`:

```ts
    await tellAgent($, { root, branch }, `allowed ${n} more round${n === 1 ? '' : 's'}: ${reason}`,
      'the gate continues the review. Leave the branch alone until it sends you what needs an answer.')
```

- **waive <findingId>**: after the `sayOpenPr` block, before `return`:

```ts
    const now2 = await loadRecord($, root, branch)
    const pr = now2?.phase !== 'pre' && now2?.pr !== undefined ? { number: now2.pr, baseRefName: now2.base, headRefOid: now2.head } : undefined
    const standing = now2 !== undefined && pr !== undefined ? await gatherStanding($, now2, pr) : undefined
    await tellAgent($, { root, branch }, `waived ${scope}: ${reason}`,
      standing === undefined
        ? 'the pre-PR review continues.'
        : standing.mayProceed
          ? "nothing holds the merge. It is ready for the merge decision, which is the person's: tell them, and do not merge unless they ask."
          : 'answer what is yours in the list above, and leave the rest to who it names.',
      standing)
```

- **waive pre**: replace `await sayOpenPr($, waived, 'waived', now)` with:

```ts
    await sayOpenPr($, waived, 'waived', now)
    await tellAgent($, waived, `waived the pre-PR review of ${branch} at ${head.slice(0, 7)}: ${reason}`,
      `open the pull request for ${branch} → ${waived.base}; the guard lets it through, and post-PR review runs once it opens.`)
```

When `openPr` is on, `sayOpenPr` queues the open-PR prompt and the note merges into its front (Task 8). When it's off, the note goes alone.
- **waive post**: after the reply's `standing` is computed (Task 7, Step 5):

```ts
  await tellAgent($, { root, branch }, `waived post-PR review of PR #${pr?.number ?? '?'} at ${at.slice(0, 7)}: ${reason}`,
    standing === undefined || standing.mayProceed
      ? "nothing else holds the merge. It is ready for the merge decision, which is the person's: tell them, and do not merge unless they ask."
      : 'the waiver covers the review only: wait for what is listed, then tell the person.',
    standing)
```

- **resume** sends no note. Its restarted step's prompt says what it needs.

- [ ] **Step 4b: The regression for superseded prompts** (PR #19 review), in `flow.test.ts`:

```ts
test('R81: a reset before the flush drops the earlier command\'s open-PR prompt and keeps its own note (PR #19 review)', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  const prompts = w.prompts.length
  await say($, 'waive pre hotfix for the outage')
  await say($, 'reset')
  await w.clock.advance(1000)
  const sent = w.prompts.slice(prompts)
  expect(sent.some(one => one.includes('open the pull request'))).toBe(false)
  expect(sent.at(-1)).toContain('the person reset the lifecycle')
})
```

- [ ] **Step 5: Log the pane as the person.** In `logCommand` (line 843), replace `(origin !== 'composer' && origin !== 'bridge')` with `!isPerson(origin)`. In `runCommand` line 866, keep `waive`, `allow` and `reset` to `composer` and `bridge` as today. `pane` gains them in wave 3, when its links exist.

- [ ] **Step 6: Run the suite.** Expected: PASS. Existing tests that count prompts after a person's command may now see one more message. Update those counts only where the new message is the intended R81 note, and keep each test's own assertion about the text it checks.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/tests
git commit -m "pr-lifecycle: every manual action tells the agent what happened and what to do next (R81)"
```

---

