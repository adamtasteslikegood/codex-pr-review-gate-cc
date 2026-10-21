### Task 4: A P3 deferral with a recorded follow-up settles (decision I)

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Finding.followUp?: string`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (`Answer.followUp`, `applyAnswer`, new `isSettledDeferral`, `mergeHolds`)
- Modify: `pr-lifecycle/hooks/core.ts` (`readTriage` parses `followUp`; triage prompt text)
- Test: `pr-lifecycle/tests/flow.test.ts`, `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Produces: `export const isSettledDeferral = (f: Finding): boolean`. `mergeHolds` excludes such findings.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`):

```ts
const ISSUE = 'https://github.com/me/repo/issues/9'

test('R85: a P3 deferred with a recorded follow-up settles without a waiver', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'cosmetic', followUp: ISSUE, replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  expect(rec.findings.find(one => one.id === 'G2-1')?.followUp).toBe(ISSUE)
})

test('R85: a P2 deferral, a P3 one without a follow-up, and a security P3 still wait for the person', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w, 'Consider renaming this', { severity: 'P2', followUp: ISSUE })
  const w2 = world(on)
  await toAwaiting($, w2, 'Consider renaming this', { severity: 'P3' })
  const w3 = world(on)
  await toAwaiting($, w3, 'Consider renaming the token variable', { severity: 'P3', isSecurity: true, followUp: ISSUE })
})
```

`toAwaiting` already asserts `postStatus === 'awaiting-decision'`, which is the expectation here. If two worlds per test are refused, split them into three tests.

`lifecycle.test.ts`:

```ts
test('R85: isSettledDeferral needs deferred, P3, a follow-up and no security flag', async () => {
  const base = finding({ source: 'github', status: 'deferred', severity: 'P3', followUp: 'https://x/issues/1' })
  expect(isSettledDeferral(base)).toBe(true)
  expect(isSettledDeferral({ ...base, severity: 'P2' })).toBe(false)
  expect(isSettledDeferral({ ...base, followUp: undefined })).toBe(false)
  expect(isSettledDeferral({ ...base, isSecurity: true })).toBe(false)
  expect(isSettledDeferral({ ...base, status: 'open' })).toBe(false)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`. Expected: FAIL.

- [ ] **Step 3: Implement**
- `types/index.d.ts`: on `Finding`, add `/** Where a P3 deferral's follow-up is recorded (R85): an issue or comment URL, or #<n>. */ followUp?: string`.
- `lifecycle.ts`: add `followUp?: string` to `Answer`. In `applyAnswer`, add `...(a.action === 'deferred' && a.followUp !== undefined ? { followUp: a.followUp } : {})` to the returned object.
- Add, above `mergeHolds`:

```ts
/** A P3 deferred with its follow-up recorded, not security: settled without the person's waiver (R85, decision I). */
export const isSettledDeferral = (f: Finding): boolean =>
  f.status === 'deferred' && f.severity === 'P3' && f.isSecurity !== true && f.followUp !== undefined && f.followUp.trim() !== ''
```

- In `mergeHolds`, add `&& !isSettledDeferral(one)` to the filter.
- `core.ts` `readTriage`: add `...(text(row.followUp) === undefined ? {} : { followUp: text(row.followUp)?.slice(0, 500) }),`.
- In the triage prompt step 2 string from Task 3, replace "defer it with the reason" with "defer it with the reason (only what the person must rule on; a P3 with followUp, the issue or comment URL where it is tracked, needs no waiver)". Add `"followUp":"https://… for a P3 deferral"` to the post-PR trailer example.

- [ ] **Step 4: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. The existing "R39: a deferred P3 after the PR opened is not ready" test has no `followUp`, so it still holds.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks pr-lifecycle/types/index.d.ts pr-lifecycle/tests
git commit -m "pr-lifecycle: a P3 deferral with a recorded follow-up settles without a waiver (R85)"
```

---

