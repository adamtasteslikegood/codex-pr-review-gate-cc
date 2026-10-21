### Task 3: Finding 21: carried by the round raised in; `acknowledged`, replied and checked

**Files:**
- Modify: `pr-lifecycle/hooks/round.ts:1242` (carried list), `afterTriage` (`round.ts:1340-1362`), the reprompt template (`round.ts:1398`)
- Modify: `pr-lifecycle/hooks/core.ts:184-221` (`readTriage`, `readDispositions`), `:686-700` (triage prompt text)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (add `mayAcknowledge`)
- Test: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `Answer.action` includes `'acknowledged'`, and `applyAnswer` stores it as `'rebutted'` (Task 2).
- Produces: `export const mayAcknowledge = (f: Finding): boolean` in `lifecycle.ts`. `TriageAnswer` can now carry `action: 'acknowledged'`. `readDispositions` (the pre-PR fix step) drops `acknowledged` answers.

- [ ] **Step 1: Write the failing tests.** `KEY`, `roster`, `inline`, `covers`, `triaged`, `accept` and `toPost` are already defined in `flow.test.ts`. Append:

```ts
/** Finding 21's shape (cookbook PR 3706, G2-11): an approval answered "fixed", which Codex could not verify and reopened. */
const reopenedApproval = (): Finding => ({
  id: 'G1-1', round: 1, source: 'github', reviewer: 'claude[bot]', externalId: 'inline:7', threadId: '7', severity: 'P2',
  title: 'No blocking findings', headSeen: 'a'.repeat(40), status: 'open',
  history: [
    { round: 1, status: 'open', by: 'claude[bot]', at: 1 },
    { round: 1, status: 'reported-fixed', note: 'nothing to fix', by: 'main', at: 2 },
    { round: 2, status: 'open', note: 'Codex: no fix to verify', by: 'codex', at: 3 },
  ],
})

test('finding 21: an earlier round\'s finding Codex reopened this round is carried into triage', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const rec = await recordOf(w)
  w.store.set(KEY, { ...rec, findings: [reopenedApproval()], processed: ['inline:7'] })
  w.gh.comments = [inline(11, 'nit: rename this', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('Carried from earlier rounds, still open')
  expect(said).toContain('G1-1')
  expect((await runOf(w)).asked).toContain('G1-1')
})

test('R82: acknowledged, with a reply, goes to the Codex check and settles when Codex upholds it', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Looks fine to me; the retry loop is the same as before.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', severity: 'P3', note: 'a status note, nothing asked', replyId: '992' }]))
  const run = await runOf(w)
  expect(run.findings.find(one => one.id === 'G2-1')?.note).toContain('No change requested:')
  expect(run.phase).toBe('verify')
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
})

test('R82: acknowledged without a reply, or on a tagged P2 or security finding, is unanswered and asked again', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'P2: the cache is never cleared')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', note: 'fine', replyId: '992' }]))
  expect(w.prompts.at(-1)).toContain('These review items have no answer yet: G2-1')
  const w2 = world(on)
  await toTriage($, w2, 'Looks fine to me.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', note: 'fine' }]))
  expect(w2.prompts.at(-1)).toContain('These review items have no answer yet: G2-1')
})

test('R82: Codex rejecting an acknowledgement reopens the item with its reason', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Looks fine, though the retry loop now never stops.')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'acknowledged', note: 'nothing asked', replyId: '992' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'it reports a loop that never stops' }))
  const found = (await recordOf(w)).findings.find(one => one.id === 'G2-1')
  expect(found?.status).toBe('open')
  expect(found?.history.at(-1)?.note).toContain('never stops')
})
```

Calling `world(on)` twice in one test makes a second world on the same engine. If the harness doesn't allow that, split the second half into its own `test(...)`.

Append to `tests/lifecycle.test.ts` (import `mayAcknowledge`):

```ts
test('R82: only an untagged-or-P3, non-security GitHub finding may be acknowledged', async () => {
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P2', severitySource: 'hint' }))).toBe(true)
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P3', severitySource: 'tag' }))).toBe(true)
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P2', severitySource: 'tag' }))).toBe(false)
  expect(mayAcknowledge(finding({ source: 'github', severity: 'P2', severitySource: 'hint', isSecurity: true }))).toBe(false)
  expect(mayAcknowledge(finding())).toBe(false)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`
Expected: FAIL. The finding 21 test fails because `G1-1` isn't asked. The R82 tests fail because `readTriage` drops `acknowledged`. `mayAcknowledge` is undefined.

- [ ] **Step 3: Carry by the round raised in.** In `round.ts` `beginTriage` (line 1242), change the carried filter:

```ts
  const carried = mergeHolds({ findings: mergeFindings(ledger, fresh), waivers: rec.waivers }).filter(
    // By the round it was raised in, not "touched this round": Codex reopening an earlier finding must not hide it (finding 21, R82).
    one => one.status === 'open' && one.round !== run.round && !listedIds.has(one.id),
  )
```

- [ ] **Step 4: `mayAcknowledge`** in `lifecycle.ts`, next to `isBlocking`:

```ts
/** A GitHub item the agent may answer "no change requested" (R82): no security flag, and no explicit P0-P2 from the reviewer. */
export const mayAcknowledge = (f: Finding): boolean =>
  f.source === 'github' && f.isSecurity !== true && !(f.severitySource === 'tag' && RANK[f.severity] <= 2)
```

Move `RANK` above it if needed.

- [ ] **Step 5: Parse it.** In `core.ts` `readTriage`, change the action check:

```ts
    if (id === undefined || !['fixed', 'rebutted', 'deferred', 'acknowledged'].includes(action)) continue
```

Cast where `action` is pushed: `action: action as Answer['action']`. Change `readDispositions`, which the pre-PR fix step uses:

```ts
/** What the fixer said it did with each finding; "acknowledged" is a post-PR triage answer only (R82). */
export const readDispositions = (answer: string): Answer[] => readTriage(answer).filter(one => one.action !== 'acknowledged')
```

- [ ] **Step 6: Accept it only with a reply, and store it as a rebuttal.** In `round.ts` `afterTriage`, replace the first line that reads `said`:

```ts
  // "acknowledged" counts only with a reply in the thread, on an item that may take it (R82); stored as a rebuttal, so Codex checks it.
  const said = readTriage(run.pending[0]?.answer ?? '').flatMap(each => {
    if (each.action !== 'acknowledged') return [each]
    const one = run.findings.find(f => f.id === each.id)
    if (one === undefined || !mayAcknowledge(one) || each.replyId === undefined) return []
    return [{ ...each, note: `No change requested: ${each.note ?? 'the comment asks for no change'}` }]
  })
```

`applyAnswer` turns `acknowledged` into `rebutted` (Task 2). `rebuttalsOwed` → `checksOwed` then includes it, and `afterTriage` ends in `checkRebuttals`.

Check that `verifyPrompt` (core.ts) shows each rebutted finding's `note`. If it shows only the title, add the note to the line it prints for rebuttals, so Codex sees "No change requested: …".

- [ ] **Step 7: Tell the agent.** In `core.ts` triage prompt step 2 (line 686), replace the string with:

```ts
    '2. Give each item one answer: fix it (smallest change, with a test where one fits), rebut it with file:line, test or requirement evidence, defer it with the reason, or acknowledge it when the comment asks for no change (an approval with notes, a status note): reply in its thread saying so, and Codex confirms it. A duplicate gets a reply pointing to the earlier answer, not a new argument.',
```

In the trailer example (line 699) and the reprompt in `round.ts:1398`, replace `fixed|rebutted|deferred` with `fixed|rebutted|deferred|acknowledged`, in post-PR triage texts only. The pre-PR fix prompts at `core.ts:519` and `:556` stay as they are.

- [ ] **Step 8: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. A test that asserts the exact old trailer example text should be updated to the new one.

- [ ] **Step 9: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/tests
git commit -m "pr-lifecycle: triage carries findings by the round raised in (finding 21); acknowledged needs a reply and a Codex check (R82)"
```

---

