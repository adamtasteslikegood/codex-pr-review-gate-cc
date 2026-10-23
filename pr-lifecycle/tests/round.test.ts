import { expect, test } from 'claude-code/testing'

import { jiraAdvice } from '../hooks/lifecycle'
import { dropQueued, holdingPrompts, mergeNotes, patch, say, ticketIn } from '../hooks/round'

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
    'pr-gate: the person allowed 1 more round: x.\n\npr-gate: round prompt\n\nmore',
    'pr-gate: the person stopped the gate.',
    'pr-gate: the person reset the lifecycle of feat/x.',
  ])
})

test('gate R2-4: a ready prompt merged with a waiver note keeps what still holds the merge, not the note\'s next step', async () => {
  const a = { root: '/repo', branch: 'feat/x' }
  const note = 'pr-gate: the person waived G2-1: fine.\n\nEverything between abc1234 and the merge:\n- check ci failing (yours: fix it)\n\nYour next step: answer what is yours.'
  const out = mergeNotes([
    { text: note, key: a, batch: 1, isNote: true },
    { text: 'pr-gate: ready for the merge decision.', key: a, batch: 1 },
  ])
  expect(out.map(one => one.text)).toEqual([
    'pr-gate: the person waived G2-1: fine.\n\npr-gate: ready for the merge decision.\n\nEverything between abc1234 and the merge:\n- check ci failing (yours: fix it)',
  ])
})

/** An engine with only the run's state, in memory: what `patch` reads and writes. */
const holding = (value: object) => {
  let held = { value, version: 1 }
  const state = {
    get: async () => held,
    set: async (_ref: unknown, next: object, options?: { ifVersion?: number }) => {
      if (options?.ifVersion !== undefined && options.ifVersion !== held.version) return { isSet: false, version: held.version }
      held = { value: next, version: held.version + 1 }
      return { isSet: true, version: held.version }
    },
  }
  return { $: { state } as never, read: () => held.value as { activity?: string } }
}

test('M2: patch changes only the running run it names, and returns null for any other (final review)', async () => {
  const running = holding({ id: 'r1', status: 'running', activity: 'a' })
  expect((await patch(running.$, 'r1', one => ({ ...one, activity: 'b' })))?.activity).toBe('b')
  expect(running.read().activity).toBe('b')
  const stopped = holding({ id: 'r1', status: 'stopped', activity: 'a' })
  expect(await patch(stopped.$, 'r1', one => ({ ...one, activity: 'b' }))).toBeNull()
  expect(stopped.read().activity).toBe('a')
  const other = holding({ id: 'r2', status: 'running', activity: 'a' })
  expect(await patch(other.$, 'r1', one => ({ ...one, activity: 'b' }))).toBeNull()
  expect(other.read().activity).toBe('a')
})

test('gate R4-5: a stop run during another command\'s hold drops that command\'s queued prompt', async () => {
  const key = { root: '/repo', branch: 'feat/x' }
  const timers: (() => void)[] = []
  const sent: string[] = []
  const $ = {
    clock: { now: async () => 0, after: (_ms: number, fn: () => void) => void timers.push(fn) },
    session: { id: async () => 'session-1' },
    store: { get: async () => undefined },
    prompt: { submit: async (e: { text: string }) => void sent.push(e.text) },
  } as never
  const flush = async () => {
    for (const fn of timers.splice(0)) fn()
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  await holdingPrompts($, async () => {
    await say($, key, 'pr-gate: a stale prompt')
    // The stop shares the outer command's batch: what that command queued is dropped all the same.
    await holdingPrompts($, async () => dropQueued(key))
  })
  await flush()
  expect(sent).toEqual([])
  // A prompt queued after the drop is still sent.
  await holdingPrompts($, async () => say($, key, 'pr-gate: a fresh prompt'))
  await flush()
  expect(sent).toEqual(['pr-gate: a fresh prompt'])
})

test('A9.7: acli search answers as an array, or an object holding it under issues or values; any other shape is a failed search', async () => {
  const title = 'G2-1 Critical [P1] Token logged (#1, feat/x)'
  const items = [{ key: 'KAN-9', fields: { summary: `${title} more` } }, { key: 'KAN-12', fields: { summary: title } }]
  expect(ticketIn(JSON.stringify(items), title)).toEqual({ key: 'KAN-12' })
  expect(ticketIn(JSON.stringify({ issues: items, total: 2 }), title)).toEqual({ key: 'KAN-12' })
  expect(ticketIn(JSON.stringify({ values: items }), title)).toEqual({ key: 'KAN-12' })
  // A list with no exact summary: nothing found, and the caller files the ticket.
  expect(ticketIn(JSON.stringify({ issues: [items[0]] }), title)).toEqual({})
  expect(ticketIn('[]', title)).toEqual({})
  // Anything else files nothing: the next pass searches again.
  for (const other of ['{"issues":"KAN-12"}', '{"key":"KAN-12"}', '"KAN-12"', 'null', 'not json', '']) {
    expect(ticketIn(other, title)).toEqual({ error: 'acli did not answer with a list of work items' })
  }
  // A malformed key is never taken.
  expect(ticketIn(JSON.stringify([{ key: 'kan-12', fields: { summary: title } }]), title)).toEqual({})
  // A set of summaries (PR #28 review): the ticket an earlier attempt filed at another peak is found by any of them.
  expect(ticketIn(JSON.stringify(items), ['G2-1 Critical [P1] other', title])).toEqual({ key: 'KAN-12' })
  expect(ticketIn(JSON.stringify(items), ['G2-1 Critical [P1] other'])).toEqual({})
})

test('A9.7 ruling (b): a missing acli is told to install it, unauthorized to log in, and anything else gets only acli\'s words', async () => {
  const install = 'Install acli (the Atlassian CLI), then run acli jira auth login. '
  expect(jiraAdvice('acli could not be started (spawn acli ENOENT)')).toBe(install)
  expect(jiraAdvice('exec: "acli": executable file not found in $PATH')).toBe(install)
  expect(jiraAdvice('fork/exec /usr/bin/acli: no such file or directory')).toBe(install)
  expect(jiraAdvice('sh: acli: command not found')).toBe(install)
  expect(jiraAdvice("unauthorized: use 'acli [product] auth login' to authenticate")).toBe('Run acli jira auth login. ')
  expect(jiraAdvice('Error: the Jira site answered 502 Bad Gateway')).toBe('')
  // A description that could not be written is not acli's fault, whatever the file system said.
  expect(jiraAdvice("could not write the ticket's description to /repo/.git/x.txt: ENOENT: no such file or directory")).toBe('')
})
