### Task 2: A triaged severity replaces a guessed one

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (`Finding` gains `severitySource?: 'tag' | 'hint'`; `FindingEvent` gains `severity?: Severity`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts:133-139` (`applyAnswer`)
- Modify: `pr-lifecycle/hooks/round.ts` (`beginTriage`, finding creation around line 1216)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`, `pr-lifecycle/tests/flow.test.ts`

**Interfaces:**
- Consumes: `severityHint(...).isTagged` from Task 1.
- Produces: `Finding.severitySource`. A GitHub finding is `'tag'` (the reviewer's own words) or `'hint'` (guessed). Codex findings leave it undefined, which behaves like `'tag'`.

- [ ] **Step 1: Write the failing tests** (`tests/lifecycle.test.ts`, append):

```ts
test('R84: a triaged severity replaces a guessed one, up or down, and the change is in the history', async () => {
  const guessed = finding({ source: 'github', severity: 'P2', severitySource: 'hint' })
  const lowered = applyAnswer(guessed, { id: 'R1-1', action: 'deferred', severity: 'P3' }, 2, 'main', 5)
  expect(lowered.severity).toBe('P3')
  expect(lowered.history.at(-1)?.severity).toBe('P3')
  expect(applyAnswer(guessed, { id: 'R1-1', action: 'fixed', severity: 'P1' }, 2, 'main', 5).severity).toBe('P1')
})

test('R84: a reviewer\'s own tag and a Codex severity are never lowered', async () => {
  const tagged = finding({ source: 'github', severity: 'P2', severitySource: 'tag' })
  expect(applyAnswer(tagged, { id: 'R1-1', action: 'deferred', severity: 'P3' }, 2, 'main', 5).severity).toBe('P2')
  expect(applyAnswer(finding({ severity: 'P2' }), { id: 'R1-1', action: 'deferred', severity: 'P3' }, 2, 'main', 5).severity).toBe('P2')
})
```

Append to `tests/flow.test.ts`:

```ts
test('R84: a guessed P2 the agent triages as P3 shows as P3 in the hold', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w, 'Consider renaming this', { severity: 'P3' })
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.severity).toBe('P3')
  expect(w.prompts.at(-1)).toContain('G2-1 [P3]')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `claude plugin test pr-lifecycle`
Expected: FAIL on the severity expectations.

- [ ] **Step 3: Implement**

In `types/index.d.ts`:
- add `severitySource?: 'tag' | 'hint'` to `Finding`, after `isSecurity`, with the comment `/** GitHub: the reviewer's own words ('tag') or a guess from them ('hint', R84). */`;
- add `severity?: Severity` to `FindingEvent`.

In `lifecycle.ts`, replace `applyAnswer`:

```ts
/**
 * The fixer's word: fixed is only reported until a check confirms it. A fixer cannot lower a severity a reviewer or Codex set;
 * disagreement is a rebuttal. A severity only guessed from a GitHub comment's words takes the triaged one, up or down (R84).
 */
export function applyAnswer(f: Finding, a: Answer, round: number, by: string, at: number): Finding {
  const status: FindingStatus = a.action === 'fixed' ? 'reported-fixed' : a.action === 'acknowledged' ? 'rebutted' : a.action
  const next = moved(f, status, round, by, at, a.note, a.evidence)
  const isGuessed = f.severitySource === 'hint'
  const severity =
    a.severity === undefined ? f.severity : isGuessed || RANK[a.severity] < RANK[f.severity] ? a.severity : f.severity
  const security = f.isSecurity === true || a.isSecurity === true
  const history = severity === f.severity ? next.history : [...next.history.slice(0, -1), { ...next.history.at(-1)!, severity }]
  return { ...next, severity, history, ...(security ? { isSecurity: true } : {}) }
}
```

The `'acknowledged'` branch is used from Task 3. Add `'acknowledged'` to `Answer['action']` now so this compiles: `action: 'fixed' | 'rebutted' | 'deferred' | 'acknowledged'`. If the linter rejects the non-null assertion `!`, use `next.history.map((one, i) => i === next.history.length - 1 ? { ...one, severity } : one)` instead.

In `round.ts` `beginTriage`, in the `finding: Finding = { ... }` literal, after `severity: hint.severity,`, add:

```ts
      severitySource: hint.isTagged ? 'tag' : 'hint',
```

- [ ] **Step 4: Run the suite**

Run: `claude plugin test pr-lifecycle`
Expected: PASS. Existing tests compare history entries with `toEqual`; they still pass because `severity` is only added when it changes.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/lifecycle.test.ts pr-lifecycle/tests/flow.test.ts
git commit -m "pr-lifecycle: a triaged severity replaces one guessed from a comment's words (R84)"
```

---

