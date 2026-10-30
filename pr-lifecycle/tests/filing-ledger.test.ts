import { expect, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { filingMark, newRecord } from '../hooks/lifecycle'
import { checkIssuesAfterMerge, configOf, fileIssues, setup as useConfig } from '../hooks/round'
import { claimLease, forgetLeases, forgetOptIns, recordKey, saveRecord } from '../hooks/store'
import type { Finding, LifecycleRecord } from '../types'
import { PRINCIPALS } from './contract'
import { fakeRelay, HEADERS_OF } from './relay-fake'
import type { FakeRelay } from './relay-fake'
import { world } from './world'
import type { World } from './world'

// #29 Part B, Task 9 (R101, spec §7, §8, §14): filing a finding's GitHub issue goes through the relay's filing ledger, so a finding
// is never filed twice. The exact-mark search comes first; then the claim, the POST and `fileDone`. The engine stand-in is
// shared-move.test.ts's, with the run state and the toasts a filing pass reads; another checkout is the same stand-in with its own store.

const URL_ = 'https://relay.example.org'
const SLUG = 'me/repo'
const KEY = recordKey('/repo', 'feat/x')
const PR = 7
const PR_OBJECT = `${SLUG}#${PR}`
const PR_PATH = `/v1/${SLUG}/${PR}`
const { ADAM, CODEX } = PRINCIPALS
const OTHER_SECRET = 'another-checkout-filing-secret-of-40-chars'
const MERGED = { kind: 'outside' } as const
const MINUTE = 60_000

type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

/** The mod's own engine as a filing pass sees it, for the session `sessionId` over `store`; `onSend` sees each relay call first. */
function engineOf(w: World, fetch: Fetch, store: Map<string, unknown>, sessionId: string, onSend?: (body: Record<string, unknown>) => void): never {
  const clock = w.clock as unknown as MockClock
  return {
    ...(w.engine as object),
    clock: {
      now: async () => clock.now(),
      sleep: (ms: number) => clock.sleep(ms),
      after: (ms: number, fn: () => void) => {
        let isLive = true
        void clock.sleep(ms).then(() => {
          if (isLive) fn()
        })
        return { cancel: () => { isLive = false } }
      },
    },
    http: {
      fetch: (url: string, init?: HttpInit) => {
        onSend?.(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
        return fetch(url, init)
      },
    },
    env: { get: async (name: string) => ({ PR_GATE_RELAY_TOKEN: 'adam-token' })[name] },
    session: { id: async () => sessionId },
    state: { get: async () => ({ value: null }), set: async () => ({ isSet: true }) },
    ui: { status: () => undefined, toast: () => undefined },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
  } as never
}

type Setup = { w: World; fake: FakeRelay; $: never; onSend: { fn?: (body: Record<string, unknown>) => void } }

/** A repo that opts in on its base, Adam's token in the environment, and his grant (and Codex's) on me/repo. */
function setup(on: Parameters<typeof world>[0]): Setup {
  forgetOptIns()
  forgetLeases()
  const w = world(on)
  w.git.roster = JSON.stringify({ sharedStore: { url: URL_, aud: 'aud-tag' } })
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate', [CODEX]: 'operate' } } })
  const onSend: Setup['onSend'] = {}
  const $ = engineOf(w, fake.fetch, w.store, w.sessionId, body => onSend.fn?.(body))
  return { w, fake, $, onSend }
}

const HELD: Finding = {
  id: 'R1-1',
  round: 1,
  source: 'codex-review',
  reviewer: 'codex',
  severity: 'P1',
  title: 'the cache is read before its lock',
  headSeen: 'a'.repeat(40),
  status: 'open',
  history: [],
}

/** A post-PR record of PR 7 with one P1 still holding, saved onto the relay. */
async function seeded($: never): Promise<LifecycleRecord> {
  const rec: LifecycleRecord = {
    ...newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 }),
    phase: 'post',
    pr: PR,
    slug: SLUG,
    findings: [HELD],
  }
  await saveRecord($, rec)
  return rec
}

/** Another checkout of the branch: the same relay, gh, git and clock, a copy of `from` as its own store, less this checkout's filing secrets. */
function checkoutOf(w: World, fake: FakeRelay, from: Map<string, unknown>, sessionId: string): { $: never; store: Map<string, unknown> } {
  const kept = [...from.entries()].filter(([key]) => !key.startsWith('relay-filing-secret:'))
  const store = new Map<string, unknown>(kept.map(([key, value]) => [key, structuredClone(value)]))
  return { $: engineOf(w, fake.fetch, store, sessionId), store }
}

const recordIn = (store: Map<string, unknown>): LifecycleRecord => store.get(KEY) as LifecycleRecord
const findingIn = (store: Map<string, unknown>): Finding | undefined => recordIn(store).findings.find(one => one.id === HELD.id)
const keyOf = (rec: LifecycleRecord, attempt = 1): string => `${rec.lifecycleId ?? ''}:${HELD.id}:${attempt}`
const filingAt = (fake: FakeRelay, key: string) => fake.objects.get(PR_OBJECT)?.filings[key]
const opsOf = (fake: FakeRelay, op: string): Record<string, unknown>[] =>
  fake.calls.map(one => one.body as Record<string, unknown>).filter(body => body.op === op)
const result = (n: number) => ({ number: n, url: `https://github.com/${SLUG}/issues/${n}` })

/** One call as another checkout of Adam's makes it, straight to the fake: its status. */
async function asOther(fake: FakeRelay, body: Record<string, unknown>): Promise<number> {
  const res = await fake.fetch(`${URL_}${PR_PATH}`, { method: 'POST', headers: { ...HEADERS_OF.ADAM, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.status
}

/** The issue another checkout filed for `rec`'s finding, with its exact mark, as GitHub lists it. */
const markedIssue = (w: World, rec: LifecycleRecord, number: number): void => {
  w.gh.issues.push({ number, title: '[P1] the cache is read before its lock', body: `filed elsewhere\n\n${filingMark(HELD.id, { pr: PR, lifecycleId: rec.lifecycleId ?? '' })}`, labels: ['severity:P1'] })
}

/** The first pass crashes right after its POST: the session ends as `fileDone` is about to go out. */
async function crashAfterPost(s: Setup): Promise<LifecycleRecord> {
  const rec = await seeded(s.$)
  let isCrash = true
  s.onSend.fn = body => {
    if (isCrash && body.op === 'fileDone') {
      isCrash = false
      throw new Error('the session ended')
    }
  }
  const crashed = await fileIssues(s.$, recordIn(s.w.store), MERGED).then(() => undefined, (error: unknown) => error)
  s.onSend.fn = undefined
  expect(crashed).toBeInstanceOf(Error)
  expect(s.w.gh.filed).toHaveLength(1)
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  return rec
}

test('a crash after the POST: a new session in the same checkout sends no second POST and leaves the ledger done', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await crashAfterPost(s)
  // The same checkout's store, a new session: its filing secret is the checkout's, so the claim is its own.
  const $2 = engineOf(s.w, s.fake.fetch, s.w.store, 'session-9')
  await fileIssues($2, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(1)
  const done = filingAt(s.fake, keyOf(rec))
  expect(done?.state).toBe('done')
  expect(done?.result).toEqual(result(21))
  expect(done?.adoptedBy).toBeUndefined()
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
  expect(findingIn(s.w.store)?.isFilingOwed).toBeUndefined()
})

test('the same restart from another checkout leaves it claimed, with no second POST', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await crashAfterPost(s)
  const other = checkoutOf(s.w, s.fake, s.w.store, 'session-2')
  const from = s.fake.calls.length
  await fileIssues(other.$, recordIn(other.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(1)
  // The claim is young and not its own: the issue its search found is used here, and the claimant may still finish.
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  const sent = s.fake.calls.slice(from).map(one => (one.body as { op?: string }).op)
  expect(sent).not.toContain('fileDone')
  expect(sent).not.toContain('fileAdopt')
  expect(findingIn(other.store)?.followUp).toBe('#21')
  expect(findingIn(other.store)?.isFilingOwed).toBe(true)
})

test('with the plugin store lost too, the lease holder adopts the marked issue with fileAdopt once the claim is stale: no second POST, no admin, the ledger ends done with adoptedBy', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await crashAfterPost(s)
  // The plugin store is gone with the filing secret in it; the record is found again, and the claim is older than the step timeout.
  const lost = checkoutOf(s.w, s.fake, s.w.store, 'session-3')
  await s.w.clock.advance(31 * MINUTE)
  expect('mine' in (await claimLease(lost.$, '/repo', 'feat/x', false))).toBe(true)
  await fileIssues(lost.$, recordIn(lost.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(1)
  const done = filingAt(s.fake, keyOf(rec))
  expect(done?.state).toBe('done')
  expect(done?.result).toEqual(result(21))
  expect(done?.adoptedBy).toBe(ADAM)
  expect(opsOf(s.fake, 'fileDelete')).toEqual([])
  expect(opsOf(s.fake, 'breakLease')).toEqual([])
  expect(findingIn(lost.store)?.followUp).toBe('#21')
  expect(findingIn(lost.store)?.isFilingOwed).toBeUndefined()
})

test('a stale claim with no marked issue is not adopted and waits for an admin\'s fileDelete', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  // Another checkout claimed the filing and never finished: its POST may still be on its way.
  expect(await asOther(s.fake, { op: 'fileClaim', key: keyOf(rec), secret: OTHER_SECRET })).toBe(200)
  await s.w.clock.advance(31 * MINUTE)
  expect('mine' in (await claimLease(s.$, '/repo', 'feat/x', false))).toBe(true)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toEqual([])
  expect(opsOf(s.fake, 'fileAdopt')).toEqual([])
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  expect(findingIn(s.w.store)?.issueError).toContain("waits for an admin's fileDelete")
  // An admin deletes the claim: the next pass claims it afresh, files, and finishes it.
  expect(await asOther(s.fake, { op: 'fileDelete', key: keyOf(rec) })).toBe(200)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(1)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
})

test('another checkout\'s live claim: no POST; read filing again on the next tick', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  expect(await asOther(s.fake, { op: 'fileClaim', key: keyOf(rec), secret: OTHER_SECRET })).toBe(200)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toEqual([])
  expect(findingIn(s.w.store)?.followUp).toBeUndefined()
  expect(findingIn(s.w.store)?.issueError).toContain('another checkout claimed')
  // The other checkout files its issue and finishes its claim.
  markedIssue(s.w, rec, 21)
  expect(await asOther(s.fake, { op: 'fileDone', key: keyOf(rec), result: result(21), secret: OTHER_SECRET })).toBe(200)
  const from = s.fake.calls.length
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  // The next pass reads the filing again (a claim of a key that exists writes nothing and answers it) and takes its result.
  expect(s.fake.calls.slice(from).filter(one => (one.body as { op?: string; key?: string }).op === 'fileClaim')).toHaveLength(1)
  expect(s.w.gh.filed).toEqual([])
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
  expect(findingIn(s.w.store)?.issueError).toBeUndefined()
  expect(findingIn(s.w.store)?.isFilingOwed).toBeUndefined()
})

test('a claim older than stepTimeoutMinutes shows as stuck', { timeoutMs: 15_000 }, async (_$, on) => {
  // A step timeout of 10 minutes: the claim shows as stuck after it, well before the relay's own 30-minute stale age.
  useConfig(configOf({ stepTimeoutMinutes: 10 }))
  try {
    const s = setup(on)
    const rec = await seeded(s.$)
    expect(await asOther(s.fake, { op: 'fileClaim', key: keyOf(rec), secret: OTHER_SECRET })).toBe(200)
    await fileIssues(s.$, recordIn(s.w.store), MERGED)
    const stuck = (): string[] => (recordIn(s.w.store).log ?? []).map(one => one.text).filter(one => one.includes('is stuck'))
    expect(stuck()).toEqual([])
    await s.w.clock.advance(11 * MINUTE)
    await fileIssues(s.$, recordIn(s.w.store), MERGED)
    await fileIssues(s.$, recordIn(s.w.store), MERGED)
    // One line per stuck claim, however many passes see it; the finding says why it holds.
    expect(stuck()).toHaveLength(1)
    expect(stuck()[0]).toContain(keyOf(rec))
    expect(findingIn(s.w.store)?.issueError).toContain('stuck')
    expect(s.w.gh.filed).toEqual([])
    expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  } finally {
    useConfig(configOf({}))
  }
})

test('two checkouts that both filed in fallback: on recovery the lowest-numbered issue is adopted and the other is reported, not closed', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  const other = checkoutOf(s.w, s.fake, s.w.store, 'session-2')
  // The relay is down: each checkout's search finds nothing yet, and each files the finding (#21 the other's, #22 this one's).
  s.fake.down = true
  await fileIssues(other.$, recordIn(other.store), MERGED)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(2)
  expect(findingIn(other.store)).toMatchObject({ followUp: '#21', isFilingOwed: true })
  expect(findingIn(s.w.store)).toMatchObject({ followUp: '#22', isFilingOwed: true })
  // The relay answers again: this checkout's next pass settles the ledger with the lowest-numbered marked issue.
  s.fake.down = false
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(2)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
  expect(findingIn(s.w.store)?.isFilingOwed).toBeUndefined()
  const lines = (recordIn(s.w.store).log ?? []).map(one => one.text)
  expect(lines.some(one => one.includes(`${SLUG}#22`) && one.includes('close by hand'))).toBe(true)
  // The duplicate is reported, never closed or edited.
  expect(s.w.gh.calls.filter(one => one.startsWith('issue close') || one.startsWith('issue edit 22'))).toEqual([])
  expect(s.w.gh.issueStates[22]).toBeUndefined()
})

test('attempt advances only after the earlier issue closed with the finding still holding', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  // A lost answer: GitHub filed #21, gh failed. The retry keeps attempt 1, finds #21 by its mark and finishes the same claim.
  s.w.gh.issueAnswer = 'lost'
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  s.w.gh.issueAnswer = 'ok'
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(1)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  expect(filingAt(s.fake, keyOf(rec, 2))).toBeUndefined()
  expect(findingIn(s.w.store)?.fileAttempt).toBeUndefined()
  // #21 is closed and can't be reopened, and the finding still holds the merge: it is filed anew as attempt 2.
  s.w.gh.issueStates[21] = 'CLOSED'
  s.w.gh.reopenAnswer = 'fail'
  const checked = await checkIssuesAfterMerge(s.$, recordIn(s.w.store))
  expect(checked.moved).toBeUndefined()
  expect(s.w.gh.filed).toHaveLength(2)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  expect(filingAt(s.fake, keyOf(rec, 2))).toMatchObject({ state: 'done', result: result(22) })
  expect(findingIn(s.w.store)).toMatchObject({ followUp: '#22', fileAttempt: 1 })
})
