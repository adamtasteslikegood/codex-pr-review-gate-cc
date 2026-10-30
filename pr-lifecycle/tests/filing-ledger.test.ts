import { expect, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { filingMark, newRecord } from '../hooks/lifecycle'
import { checkIssuesAfterMerge, configOf, fileIssues, setup as useConfig } from '../hooks/round'
import { claimLease, forgetLeases, forgetOptIns, HELD_PLACEHOLDER, logEvent, recordKey, saveRecord, updateRecord } from '../hooks/store'
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
    env: { get: async (name: string) => ({ PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ })[name] },
    session: { id: async () => sessionId },
    state: { get: async () => ({ value: null }), set: async () => ({ isSet: true }) },
    ui: { status: () => undefined, toast: (text: string) => void w.toasts.push(text) },
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

// Fix round 1 (Task 9 review).

const relayLines = (fake: FakeRelay): string[] => (fake.objects.get(PR_OBJECT)?.log.lines ?? []).map(one => one.text)

test('an owed call the relay refuses is dropped with a run-log line, and the calls owed after it are still paid', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  // An admin deleted this checkout's claim and another checkout claimed the key again: the fileDone still owed here is not the
  // claimant's, a conflict (409, final review M3), paid with no refusal line. One owed where the grant went answers 403, and is dropped.
  expect(await asOther(s.fake, { op: 'fileClaim', key: keyOf(rec), secret: OTHER_SECRET })).toBe(200)
  s.w.store.set(`${KEY}:relay-owed`, [
    { path: PR_PATH, body: { op: 'fileDone', key: keyOf(rec), result: result(21), secret: 'this-checkout-filing-secret-of-40-chars!!' } },
    { path: PR_PATH, body: { op: 'fileDone', key: keyOf(rec), result: result(22), secret: 'this-checkout-filing-secret-of-40-chars!!' } },
    { path: PR_PATH, body: { op: 'log', at: 1, kind: 'session', text: 'an owed line', holder: 'session-1' } },
  ])
  // The second fileDone meets a grant cut to read (403); it is back to operate by the call after it.
  s.onSend.fn = body => {
    const isSecond = body.op === 'fileDone' && (body.result as { number?: number } | undefined)?.number === 22
    s.fake.grant(ADAM, SLUG, isSecond ? 'read' : 'operate')
  }
  await logEvent(s.$, '/repo', 'feat/x', 'check', 'a line that lands')
  s.onSend.fn = undefined
  expect(s.w.store.get(`${KEY}:relay-owed`)).toBeUndefined()
  const lines = relayLines(s.fake)
  expect(lines.filter(one => one.includes('refused') && one.includes(`fileDone ${keyOf(rec)}`))).toHaveLength(1)
  expect(lines).toContain('an owed line')
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
})

test('adoption waits for the relay\'s own stale age: a step timeout shorter than it sends no fileAdopt that would be refused', { timeoutMs: 15_000 }, async (_$, on) => {
  useConfig(configOf({ stepTimeoutMinutes: 10 }))
  try {
    const s = setup(on)
    const rec = await seeded(s.$)
    expect(await asOther(s.fake, { op: 'fileClaim', key: keyOf(rec), secret: OTHER_SECRET })).toBe(200)
    markedIssue(s.w, rec, 21)
    await s.w.clock.advance(11 * MINUTE)
    expect('mine' in (await claimLease(s.$, '/repo', 'feat/x', false))).toBe(true)
    await fileIssues(s.$, recordIn(s.w.store), MERGED)
    expect(opsOf(s.fake, 'fileAdopt')).toEqual([])
    expect(findingIn(s.w.store)).toMatchObject({ followUp: '#21', isFilingOwed: true })
    // Past the relay's 30 minutes, the owed finding's next pass adopts the issue.
    await s.w.clock.advance(20 * MINUTE)
    expect('mine' in (await claimLease(s.$, '/repo', 'feat/x', false))).toBe(true)
    await fileIssues(s.$, recordIn(s.w.store), MERGED)
    expect(opsOf(s.fake, 'fileAdopt')).toHaveLength(1)
    expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21), adoptedBy: ADAM })
    expect(findingIn(s.w.store)?.isFilingOwed).toBeUndefined()
    expect(s.w.gh.filed).toEqual([])
  } finally {
    useConfig(configOf({}))
  }
})

test('a filing in a repo with no shared store keeps no filing secret and calls no relay', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  s.w.git.roster = '{}'
  await seeded(s.$)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(1)
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
  expect([...s.w.store.keys()].filter(key => key.startsWith('relay-filing-secret:'))).toEqual([])
  expect(s.fake.calls).toEqual([])
})

test('a fresh claim a pass leaves with no POST is named in the run log, so an admin knows a fileDelete is safe', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  // A waiver lands while the claim goes out: the pass files nothing more, and the claim stays. (A finding turned security meanwhile
  // leaves too, but its line names a security finding, so it is held locally and never sent.)
  s.onSend.fn = body => {
    if (body.op !== 'fileClaim') return
    const mirror = recordIn(s.w.store)
    s.w.store.set(KEY, { ...mirror, waivers: [...mirror.waivers, { scope: 'post', head: 'a'.repeat(40), reason: 'x', by: 'composer', at: 2 }] })
  }
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  s.onSend.fn = undefined
  expect(s.w.gh.filed).toEqual([])
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  expect(relayLines(s.fake).some(one => one.includes(keyOf(rec)) && one.includes("an admin's fileDelete on the relay is safe"))).toBe(true)
})

/** At the mark saved before the POST (`markSent`), another writer changes the relay's record first: `change` makes its new state. */
function changedAtMark(s: Setup, change: (rec: LifecycleRecord) => LifecycleRecord): void {
  let isArmed = true
  s.onSend.fn = body => {
    const sent = (body.record as LifecycleRecord | undefined)?.findings?.some(one => one.isIssueSent === true)
    if (!isArmed || body.op !== 'commit' || sent !== true) return
    isArmed = false
    const object = s.fake.objects.get(PR_OBJECT)
    if (object === undefined) return
    object.record = change(object.record as LifecycleRecord)
    object.rev += 1
  }
}

test('a claim left because the lifecycle was reset at the mark before the POST is named in a toast (final review, Task 9)', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  changedAtMark(s, one => ({ ...one, generation: (one.generation ?? 0) + 1 }))
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  s.onSend.fn = undefined
  expect(s.w.gh.filed).toEqual([])
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  expect(s.w.toasts.some(one => one.includes(keyOf(rec)) && one.includes('reset or replaced') && one.includes('fileDelete on the relay is safe'))).toBe(true)
  // The new lifecycle's log never names the old one's claim (gate G7-8).
  expect(relayLines(s.fake).some(one => one.includes(keyOf(rec)))).toBe(false)
})

test('a claim left because the finding turned security at the mark before the POST is logged, scrubbed whole (final review, Task 9)', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  changedAtMark(s, one => ({ ...one, findings: one.findings.map(f => (f.id === HELD.id ? { ...f, isSecurity: true } : f)) }))
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  s.onSend.fn = undefined
  expect(s.w.gh.filed).toEqual([])
  expect(filingAt(s.fake, keyOf(rec))?.state).toBe('claimed')
  // The line names a security finding (its key holds the id): the relay's log takes it as the placeholder, whole (R107).
  expect(relayLines(s.fake)).toContain(HELD_PLACEHOLDER)
  expect(relayLines(s.fake).some(one => one.includes(keyOf(rec)))).toBe(false)
})

test('a young claim\'s issue, used here and owed, settles to done once the claimant finishes it', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  expect(await asOther(s.fake, { op: 'fileClaim', key: keyOf(rec), secret: OTHER_SECRET })).toBe(200)
  markedIssue(s.w, rec, 21)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(findingIn(s.w.store)).toMatchObject({ followUp: '#21', isFilingOwed: true })
  expect(await asOther(s.fake, { op: 'fileDone', key: keyOf(rec), result: result(21), secret: OTHER_SECRET })).toBe(200)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
  expect(findingIn(s.w.store)?.isFilingOwed).toBeUndefined()
  expect(s.w.gh.filed).toEqual([])
  expect(opsOf(s.fake, 'fileAdopt')).toEqual([])
})

test('a fileDone the relay could not take after the POST is owed, and paid on the next relay call that lands', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  // The relay is down for the fileDone alone: the record's save right after it lands, and pays it.
  let state: 'armed' | 'down' | 'done' = 'armed'
  let sent = 0
  s.onSend.fn = body => {
    if (body.op === 'fileDone') sent += 1
    if (state === 'armed' && body.op === 'fileDone') {
      state = 'down'
      s.fake.down = true
    } else if (state === 'down') {
      state = 'done'
      s.fake.down = false
    }
  }
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  s.onSend.fn = undefined
  expect(state).toBe('done')
  expect(s.w.gh.filed).toHaveLength(1)
  expect(sent).toBe(2)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  expect(s.w.store.get(`${KEY}:relay-owed`)).toBeUndefined()
  expect(findingIn(s.w.store)?.followUp).toBe('#21')
})

test('a filing pass never adopts the ledger\'s closed issue again: a finding holding again with no issue named files the next attempt', { timeoutMs: 15_000 }, async (_$, on) => {
  const s = setup(on)
  const rec = await seeded(s.$)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  // #21 is closed, and an answer replaced the follow-up with words that name no issue: the finding holds and is planned again.
  s.w.gh.issueStates[21] = 'CLOSED'
  await updateRecord(s.$, '/repo', 'feat/x', r => ({ ...r, findings: r.findings.map(f => ({ ...f, followUp: 'see the design doc', followUpLabel: undefined })) }))
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(2)
  expect(filingAt(s.fake, keyOf(rec, 2))).toMatchObject({ state: 'done', result: result(22) })
  expect(findingIn(s.w.store)).toMatchObject({ followUp: '#22', fileAttempt: 1 })
})

// Final review I2: a refile made while the relay was down, after the ledger's issue closed, settles on the new issue.

/** #21 is filed and done in the ledger, then `gone` (closed, or deleted or transferred so it isn't listed), and the finding holds again. */
async function refiledWhileDown(on: Parameters<typeof world>[0], gone: 'CLOSED' | 'missing') {
  const s = setup(on)
  const rec = await seeded(s.$)
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  s.w.gh.issueStates[21] = gone
  await updateRecord(s.$, '/repo', 'feat/x', r => ({ ...r, findings: r.findings.map(f => ({ ...f, followUp: 'see the design doc', followUpLabel: undefined })) }))
  // The relay is down for the refile: #22 is filed locally, and its ledger entry is owed.
  s.fake.down = true
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(2)
  expect(findingIn(s.w.store)).toMatchObject({ followUp: '#22', isFilingOwed: true })
  expect(findingIn(s.w.store)?.fileAttempt).toBeUndefined()
  // The relay answers again: the owed finding settles on #22 as attempt 2, never back on #21.
  s.fake.down = false
  await fileIssues(s.$, recordIn(s.w.store), MERGED)
  expect(s.w.gh.filed).toHaveLength(2)
  expect(filingAt(s.fake, keyOf(rec))).toMatchObject({ state: 'done', result: result(21) })
  expect(filingAt(s.fake, keyOf(rec, 2))).toMatchObject({ state: 'done', result: result(22) })
  expect(findingIn(s.w.store)).toMatchObject({ followUp: '#22', fileAttempt: 1 })
  expect(findingIn(s.w.store)?.isFilingOwed).toBeUndefined()
  const lines = (recordIn(s.w.store).log ?? []).map(one => one.text)
  expect(lines.filter(one => one.includes('close by hand') || one.includes(`moved from #22`))).toEqual([])
  expect(s.w.gh.calls.filter(one => one.startsWith('issue edit 21'))).toEqual([])
}

test('a refile while the relay was down, after the ledger\'s issue closed, settles on the new issue as the next attempt, with no duplicate reported', { timeoutMs: 15_000 }, async (_$, on) => {
  await refiledWhileDown(on, 'CLOSED')
})

test('the same refile after the ledger\'s issue was deleted or transferred (not listed at all) settles on the new issue too', { timeoutMs: 15_000 }, async (_$, on) => {
  await refiledWhileDown(on, 'missing')
})
