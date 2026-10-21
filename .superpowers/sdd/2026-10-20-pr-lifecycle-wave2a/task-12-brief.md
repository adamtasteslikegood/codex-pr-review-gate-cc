### Task 12: A hold on a chained command says nothing in it ran (R87, spec §5a)

Added 2026-10-20 from live use (cookbook PRs #3732, #3741). Run it after Task 10 and before Task 11, so Task 11 records R87 with the rest.

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (add `hasOtherSteps`, next to `readBash`)
- Modify: `pr-lifecycle/hooks/register.tsx` (the `tool.call` hook and its `.catch`)
- Test: `pr-lifecycle/tests/github.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Produces: `export function hasOtherSteps(command: string): boolean` (`github.ts`).

- [ ] **Step 1: Write the failing unit test** (`github.test.ts`, import `hasOtherSteps`):

```ts
test('R87: hasOtherSteps sees steps chained with a PR command, not text inside quotes, $(…) or a heredoc body', async () => {
  expect(hasOtherSteps('gh pr create --base dev --title "a; b && c"')).toBe(false)
  expect(hasOtherSteps('gh pr create --base dev --body "$(cat body.md)"')).toBe(false)
  expect(hasOtherSteps('cd /repo && gh pr create --base dev')).toBe(false)
  expect(hasOtherSteps("gh pr create --base dev --body-file - <<'EOF'\nline one; two\nEOF")).toBe(false)
  expect(hasOtherSteps("cat > body.md <<'EOF'\nSummary\nEOF\ngh pr create --base dev --body-file body.md")).toBe(true)
  expect(hasOtherSteps('git push -u origin HEAD && gh pr create --base dev')).toBe(true)
  expect(hasOtherSteps('gh pr merge 1 --squash; git checkout dev')).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL, `hasOtherSteps` not exported.

- [ ] **Step 3: Implement** (`github.ts`, after `readBash`):

```ts
/**
 * Whether a Bash command does more than its PR action (R87). A hook allows or refuses the whole command, so a held `gh pr create`
 * also stops the file write or push chained with it. Quoted text, `$(…)` and heredoc bodies belong to their step; a bare `cd` is no step.
 */
export function hasOtherSteps(command: string): boolean {
  const bare = dropHeredocs(command.replace(/\\\r?\n/g, ' '))
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q')
    .replace(/\$\([^()]*\)/g, 'S')
  const steps = bare
    .split(/;|&&|\|\||\||\n/)
    .map(one => one.trim())
    .filter(one => one !== '' && !/^cd\s+\S+$/.test(one))
  return steps.length > 1
}
```

- [ ] **Step 4: Write the failing flow test** (`flow.test.ts`):

```ts
test('R87: a hold on a chained command says nothing in it ran; a lone PR command gets no such line', async ($, on) => {
  world(on)
  const chained = { tool: 'Bash' as const, command: `cat > /tmp/body.md <<'EOF'\nSummary\nEOF\n${createPr.command} --body-file /tmp/body.md` }
  const held = await $.tool.call(chained)
  expect(isHeld(held)).toBe(true)
  expect(held.deny ?? '').toContain('Nothing in this Bash command ran')
  expect(held.deny ?? '').toContain('Write tool')
  const lone = await $.tool.call(createPr)
  expect(isHeld(lone)).toBe(true)
  expect(lone.deny ?? '').not.toContain('Nothing in this Bash command ran')
  const chainedMerge = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --squash && git checkout dev' })
  expect(isHeld(chainedMerge)).toBe(true)
  expect(chainedMerge.deny ?? '').toContain('Nothing in this Bash command ran')
})
```

If the first chained create starts the round and the lone create is then held for the running round, that's the intended setup. If the chained merge isn't held in this state, drive the world to post-PR the way the neighbouring merge tests do, and say so in the report.

- [ ] **Step 5: Wire it into the `tool.call` hook** (`register.tsx`). Import `hasOtherSteps` from `./github`. Add near `asHold`:

```ts
/** The line a hold on a chained Bash command ends with (R87): nothing in it ran, so the agent redoes the other steps on their own. */
const CHAINED =
  '\nNothing in this Bash command ran: a hold refuses the whole command, so the steps chained with the PR command did not run either. ' +
  'Run those on their own (write a PR body file with the Write tool), and keep the PR command in a Bash call by itself.'

/** What a refusal adds for this call: the R87 line when it is a Bash command with other steps. */
const chainedOf = (tool: string, e: unknown): string => {
  const command = (e as Record<string, unknown>).command
  return tool === 'Bash' && typeof command === 'string' && hasOtherSteps(command) ? CHAINED : ''
}
```

In the `tool.call` handler, after `if (action === undefined) return next(e)`, compute `const tail = chainedOf(String(e.tool), e)` and append `tail` to every `asHold(…)` the handler returns: the merge refusal, `outsideText`, `noBaseText` and the create refusal. In the `.catch` handler, append `chainedOf(String(e.tool), e)` to its `asHold(…)` too. The R77 opening stays first; the line goes last.

- [ ] **Step 6: Run the suite.** Run: `claude plugin test pr-lifecycle`. Expected: PASS. An existing test that asserts a hold's whole text with `toBe` on a chained command needs the line added; say which in the report.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/github.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: a hold on a chained Bash command says nothing in it ran (R87)"
```

---

