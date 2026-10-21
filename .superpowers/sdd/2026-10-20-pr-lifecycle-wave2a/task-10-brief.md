### Task 10: The pane's Stop goes through the command

**Files:**
- Modify: `pr-lifecycle/hooks/pane.tsx:86` (`renderPane` signature), `:230-234` (the Button)
- Modify: `pr-lifecycle/hooks/register.tsx:1176-1186` (the `ui.render` handler)
- Test: `pr-lifecycle/tests/gate.test.ts`

**Interfaces:**
- Produces: `renderPane($, e, run, rec, now, actions: { stop: () => Promise<void> })`.

- [ ] **Step 1: Write the failing test** (append to `gate.test.ts`):

```ts
test('R81: the pane\'s Stop runs /pr-gate stop: logged as the person, and the agent is told', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  const ui = await $.ui.mount({
    plugin: 'pr-lifecycle',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pr-lifecycle',
    props: { title: 'PR lifecycle', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { top: 0, bodyRows: 40, rows: 40 } as never, view: {} as never },
  })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  await w.clock.advance(1000)
  expect((await runOf(w)).status).toBe('stopped')
  expect(w.prompts.at(-1)).toContain('the person stopped the gate')
  expect((await recordOf(w)).log?.some(one => one.kind === 'person' && one.text.includes('/pr-gate stop'))).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL. No prompt, no log line.

- [ ] **Step 3: Implement.** In `pane.tsx`, add the parameter `actions: { stop: () => Promise<void> }` to `renderPane`, and change the Button:

```tsx
          <Button key="stop" label="Stop the gate" onPress={() => void actions.stop()} />
```

Drop `finish` from the pane's import from `./round` if nothing else uses it, and update the file's header comment: the Stop button runs `/pr-gate stop`.

In `register.tsx`, in the `ui.render` handler:

```tsx
    // The pane's Stop is the person's /pr-gate stop (R81): the owner check, the log line and the agent's message come with it.
    const stop = async (): Promise<void> => {
      const text = await holdingPrompts($, () => runCommand($, 'stop', 'pane'))
      await logCommand($, 'stop', text, 'pane').catch(() => undefined)
    }
    return renderPane($, e, run, rec, now, { stop })
```

- [ ] **Step 4: Run the suite.** Expected: PASS, including the existing pane test at `gate.test.ts:391`.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/hooks/pane.tsx pr-lifecycle/hooks/register.tsx pr-lifecycle/tests/gate.test.ts
git commit -m "pr-lifecycle: the pane's Stop runs /pr-gate stop, so it is logged and the agent is told (R81)"
```

---

