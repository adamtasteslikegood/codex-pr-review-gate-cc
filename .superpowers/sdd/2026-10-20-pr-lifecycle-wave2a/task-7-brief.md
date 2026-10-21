### Task 7: The merge guard renders from the standing (findings 27, 28)

**Files:**
- Modify: `pr-lifecycle/hooks/register.tsx:595-646` (`ciHold`), `:652-756` (`judgeMerge`), `:1021-1049` (the `waive post` reply)
- Test: `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `gatherStanding`, `holdText` (Tasks 5, 6).
- Produces: `ciHold($, action, pr, standing)`. CI's words come from the standing's `ci-*` blockers, and set-aside checks are named.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`; `merge` is defined at line 303):

```ts
test('R86: waive post sets aside a cancelled check GitHub does not require, and names it; a running required check still holds', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.hasPr = true
  w.gh.required = ['check']
  w.gh.checks = [
    { name: 'Independent Claude review', status: 'completed', conclusion: 'cancelled' },
    { name: 'check', status: 'in_progress', conclusion: null },
  ]
  const said = await say($, 'waive post reviewed by hand')
  expect(said.text).toContain('Set aside')
  expect(said.text).toContain('Independent Claude review')
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny ?? '').toContain('check')
  expect(held.deny ?? '').not.toContain('failing: Independent Claude review')
  w.gh.checks = [{ name: 'Independent Claude review', status: 'completed', conclusion: 'cancelled' }, { name: 'check', status: 'completed', conclusion: 'success' }]
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R79: one merge refusal names every blocker: findings and CI', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  w.gh.checks = [{ name: 'check', status: 'in_progress', conclusion: null }]
  const held = await $.tool.call(merge)
  const text = held.deny ?? ''
  expect(text).toContain('G2-1')
  expect(text).toContain('check check running')
})

test('R86: with the required checks unreadable, a waiver sets nothing aside', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.hasPr = true
  w.gh.garbage = '<html>proxy error</html>'
  w.gh.checks = [{ name: 'Independent Claude review', status: 'completed', conclusion: 'cancelled' }]
  await say($, 'waive post reviewed by hand')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})
```

`isHeld(result)` means the guard refused (`result.deny !== undefined`). If `flow.test.ts` has no helper by that name, define it at the top of these tests.

`gh.garbage` applies to every `gh api` call, so the rules call reads as unreadable. Check `toPost`'s state: `toPost` already opens the PR (`createPr` sets `hasPr`). Keep `w.gh.hasPr = true` only if a test needs it.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL. The waiver reply doesn't name the set-aside check, and the guard holds on the cancelled check.

- [ ] **Step 3: Rewrite `ciHold`** to take the standing:

```ts
/**
 * The CI hold on a merge the review lets through (R1-9, narrowed by R86): the standing's CI blockers. A required check that fails, is
 * cancelled or runs holds it, and so do checks gh can't read; under a post waiver a check GitHub does not require is set aside, named.
 */
const ciHold = (action: PrAction, pr: MergedPr, standing: Standing): string | undefined => {
  const ci = standing.blockers.filter(one => one.kind.startsWith('ci-'))
  if (ci.length === 0) return undefined
  const head = `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held`
  const short = pr.headRefOid.slice(0, 7)
  if (ci.some(one => one.kind === 'ci-unreadable')) {
    return [
      `${head}: the CI checks on ${short} could not be read, and a merge waits until they can.`,
      'Do not merge another way. Check gh auth status and the network, then try the merge again.',
    ].join('\n') + unknownNote(action)
  }
  const failing = ci.filter(one => one.kind === 'ci-failing').map(one => one.id ?? '?')
  const running = ci.filter(one => one.kind === 'ci-running').map(one => one.id ?? '?')
  const said = [...(failing.length === 0 ? [] : [`failing: ${failing.join(', ')}`]), ...(running.length === 0 ? [] : [`still running: ${running.join(', ')}`])]
  return [
    `${head}: CI on ${short} is not green (${said.join('; ')}).`,
    ...(standing.setAside.length === 0 ? [] : [`Set aside by the post waiver (GitHub does not require them): ${standing.setAside.join(', ')}.`]),
    'Do not merge another way.',
    ...(failing.length === 0
      ? []
      : ['Your next step: fix what the failing checks report and push, or rerun a check that failed for a flaky reason (gh run rerun <run-id> --failed).']),
    ...(running.length === 0
      ? []
      : [`${failing.length === 0 ? 'Your next step: wait' : 'Wait'} for the running checks (gh pr checks ${pr.number} --watch), then try the merge again.`]),
  ].join('\n') + unknownNote(action)
}
```

This keeps today's sentences ("CI on … is not green (failing: …; still running: …)"), so the existing R1-9 tests still match.

- [ ] **Step 4: Use it in `judgeMerge`.** After `isWaived` is computed, read the standing once, when there's a record:

```ts
  const standing = rec === undefined ? undefined : await gatherStanding($, rec, pr, action.repo)
```

- Replace `return ciHold($, root, action, pr)` in the waived branch with `return standing === undefined ? undefined : ciHold(action, pr, standing)`.
- In the ready branch, replace it with `return standing === undefined ? undefined : ciHold(action, pr, standing)`.
- In the final refusal, append the rest of the standing, skipping the ids the first line already names:

```ts
  const named = new Set(missing.match(/\b[RG]\d+-\d+\b/g) ?? [])
  const rest = standing === undefined ? '' : holdText(standing, named)
  return (
    [
      `pr-gate: ${action.via} (merge PR #${pr.number} into ${pr.baseRefName}) is held: the lifecycle review is not complete for ${short}: ${missing}.`,
      'Do not merge another way.',
      next,
      ...(rest === '' ? [] : ['', rest]),
    ].join('\n') + unknownNote(action)
  )
```

`MergedPr` wants `{ number, baseRefName, headRefOid }`. The `pr` read in `judgeMerge` has those fields, so pass it directly. Import `gatherStanding` from `./round`, `holdText` from `./lifecycle`, and the `Standing` type from `../types`.

- [ ] **Step 5: Name the set-aside checks in the `waive post` reply.** At the end of the `waive post` branch of `runCommand`, after the record is written:

```ts
  const after = await loadRecord($, root, branch)
  const standing = after !== undefined && pr !== undefined ? await gatherStanding($, after, pr) : undefined
  const aside = standing === undefined || standing.setAside.length === 0 ? '' : ` Set aside (GitHub does not require them): ${standing.setAside.join(', ')}.`
  return `/${COMMAND} waived post-PR review for ${branch} at ${at.slice(0, 7)}: ${reason}. This head may merge; a new commit needs a new review or waiver.${aside}`
```

`pr` here comes from `openPrOf($, root, branch)`. Check that its type has `number`, `baseRefName` and `headRefOid`; if not, build `{ number: pr.number, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid }`. Task 9 adds the agent message to this branch.

- [ ] **Step 6: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. Merge tests now make extra `gh pr checks` and `gh api …/rules` calls. A test that asserts an exact count of `w.gh.calls` should be updated to the new count.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: the merge guard names every blocker; waive post sets aside checks GitHub does not require (R79, R86)"
```

---

