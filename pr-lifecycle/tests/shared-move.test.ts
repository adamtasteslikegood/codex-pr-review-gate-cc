import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { newRecord } from '../hooks/lifecycle'
import { boundary } from '../hooks/round'
import {
  forgetLeases,
  forgetOptIns,
  HELD_PLACEHOLDER,
  latestArchive,
  liveRecords,
  logEvent,
  recordKey,
  relayLog,
  RelayMoved,
  releaseLease,
  saveRecord,
  StaleRecord,
  updateRecord,
  upsertRecord,
} from '../hooks/store'
import type { Finding, LifecycleRecord } from '../types'
import { PRINCIPALS } from './contract'
import { fakeRelay, HEADERS_OF } from './relay-fake'
import type { FakeRelay } from './relay-fake'
import { createPr, done, review, turn, world } from './world'
import type { World } from './world'

// #29 Part B, Task 7 (R103, R106): a pre-PR record moves from its branch's object to its PR's; the run log, discovery and archives
// come from the relay. The engine stand-in is shared-store.test.ts's; a second checkout is the same stand-in with its own store and session.

const URL_ = 'https://relay.example.org'
const SHARED = JSON.stringify({ sharedStore: { url: URL_, aud: 'aud-tag' } })
const SLUG = 'me/repo'
const OBJECT = `${SLUG}@feat/x`
const PATH = `/v1/${SLUG}/branch/feat%2Fx`
const KEY = recordKey('/repo', 'feat/x')
const PR = 7
const PR_OBJECT = `${SLUG}#${PR}`
const PR_PATH = `/v1/${SLUG}/${PR}`
const { ADAM, CODEX } = PRINCIPALS

type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

/** The mod's own engine as the store sees it (shared-store.test.ts has the same), for the session `sessionId` over `store`. */
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
  w.git.roster = SHARED
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate', [CODEX]: 'operate' } } })
  const onSend: Setup['onSend'] = {}
  const $ = engineOf(w, fake.fetch, w.store, w.sessionId, body => onSend.fn?.(body))
  return { w, fake, $, onSend }
}

/** Another checkout of the same branch (session-2), holding a copy of `held`: the same relay, git and clock, its own store. */
function checkoutOf(w: World, fake: FakeRelay, held: Record<string, unknown>): { $: never; store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(held).map(([key, value]) => [key, structuredClone(value)]))
  return { $: engineOf(w, fake.fetch, store, 'session-2'), store }
}

const seed = (extra: Partial<LifecycleRecord> = {}): LifecycleRecord => ({
  ...newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 }),
  ...extra,
})

const SECRET: Finding = {
  id: 'R1-1',
  round: 1,
  source: 'codex-review',
  reviewer: 'codex',
  severity: 'P1',
  title: 'SECRET-TITLE sql injection',
  headSeen: 'a'.repeat(40),
  status: 'open',
  history: [],
  isSecurity: true,
}

const grant = (reason: string) => (rec: LifecycleRecord): LifecycleRecord => ({ ...rec, grants: [...rec.grants, { n: 1, reason, head: rec.head, at: 1 }] })
const reasons = (rec: unknown): string[] => ((rec as LifecycleRecord | undefined)?.grants ?? []).map(one => one.reason)
const opened = (pr: number) => (rec: LifecycleRecord): LifecycleRecord => ({ ...rec, phase: 'post', pr })
const local = (w: World, key = KEY): LifecycleRecord => w.store.get(key) as LifecycleRecord
const recordAt = (fake: FakeRelay, id: string): LifecycleRecord => fake.objects.get(id)?.record as LifecycleRecord
const opsOf = (fake: FakeRelay, op: string): Record<string, unknown>[] =>
  fake.calls.map(one => one.body as Record<string, unknown>).filter(body => body.op === op)
const thrown = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error)
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(stringsOf)
        : []

/** One call as Codex's service makes it, straight to the fake: its status and JSON body. */
async function codex(fake: FakeRelay, path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fake.fetch(`${URL_}${path}`, { method: 'POST', headers: { ...HEADERS_OF.CODEX, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: JSON.parse(res.text) as Record<string, unknown> }
}

const CODEX_SECRET = 'c'.repeat(40)

/** Codex's checkout moves feat/x's lifecycle to PR `pr`, every step of it, as the store would. */
async function codexMoves(fake: FakeRelay, pr: number): Promise<void> {
  const s = fake.objects.get(OBJECT)
  const record = { ...(s?.record as LifecycleRecord), phase: 'post', pr }
  const to = `/v1/${SLUG}/${pr}`
  const steps: [string, Record<string, unknown>][] = [
    [PATH, { op: 'claim', holder: 'codex-1', secret: CODEX_SECRET }],
    [PATH, { op: 'commit', rev: s?.rev ?? 0, record, secret: CODEX_SECRET }],
    [PATH, { op: 'moveTo', pr, secret: CODEX_SECRET }],
    [to, { op: 'claim', holder: 'codex-1', secret: CODEX_SECRET }],
    [to, { op: 'commit', rev: 0, record, from: '@feat/x', secret: CODEX_SECRET }],
    [to, { op: 'release', secret: CODEX_SECRET }],
    [PATH, { op: 'moveDone', lifecycleId: record.lifecycleId }],
  ]
  for (const [path, body] of steps) expect((await codex(fake, path, body)).status).toBe(200)
}

test('a pre-PR record lives on the branch key and moves to the PR key on onOpened', { timeoutMs: 15_000 }, async ($, on) => {
  forgetOptIns()
  const w = world(on)
  w.git.roster = SHARED
  mock.env(on, { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ })
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate' } } })
  await $.tool.call(createPr)
  // Before the PR: the record is on the branch's object, and no PR object exists.
  const pre = recordAt(fake, OBJECT)
  expect(pre.phase).toBe('pre')
  expect(pre.pr).toBeUndefined()
  expect(fake.objects.has(`${SLUG}#1`)).toBe(false)
  expect(local(w).relayKey).toBe('@feat/x')
  await done($, turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  // onOpened: the branch's object is a tombstone pointing at PR #1, cut to its pointer, and the record goes on there.
  const branch = fake.objects.get(OBJECT)
  expect(branch?.movedTo).toBe(1)
  expect(branch?.record).toEqual({ movedTo: 1, lifecycleId: pre.lifecycleId })
  const post = recordAt(fake, `${SLUG}#1`)
  expect(post.lifecycleId).toBe(pre.lifecycleId)
  expect(post.pr).toBe(1)
  expect(post.phase).toBe('post')
  expect(opsOf(fake, 'commit').filter(body => body.from === '@feat/x')).toHaveLength(1)
  expect(local(w).relayKey).toBe('#1')
  expect(local(w).relayRev).toBe(fake.objects.get(`${SLUG}#1`)?.rev)
  // The run log reads the PR's object, with the branch's from before the move.
  const log = await relayLog(engineOf(w, fake.fetch, w.store, w.sessionId), '/repo', 'feat/x')
  expect(log.movedFrom).toBeDefined()
})

test('a stale checkout still driving the branch key follows the 410', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed())
  let isMoved = false
  const saved = await updateRecord(
    $,
    '/repo',
    'feat/x',
    async rec => {
      // Another checkout moves the lifecycle to its PR between this one's read and its commit.
      if (!isMoved) {
        isMoved = true
        await codexMoves(fake, PR)
      }
      return grant('mine')(rec)
    },
    { isPure: true },
  )
  expect(saved?.pr).toBe(PR)
  // The branch's object answered 410 and was left as the move left it; the change ran again on the PR's object.
  expect(fake.objects.get(OBJECT)?.record).toEqual({ movedTo: PR, lifecycleId: saved?.lifecycleId })
  expect(reasons(recordAt(fake, PR_OBJECT))).toEqual(['mine'])
  expect(fake.objects.get(PR_OBJECT)?.rev).toBe(2)
})

test('a crash after each move step is finished by the next load, and only the PR driver dispatches', { timeoutMs: 15_000 }, async (_t, on) => {
  const { w, fake, $, onSend } = setup(on)
  // Each step, and whether session 2's boundary passes after a crash right after it: the dead process's claim on the PR's object, taken
  // after `moveTo`, holds it off until it lapses.
  const steps: [string, (body: Record<string, unknown>) => boolean, boolean][] = [
    ['moveTo', body => body.op === 'moveTo', true],
    ['commit from', body => body.op === 'commit' && body.from !== undefined, false],
    ['moveDone', body => body.op === 'moveDone', false],
  ]
  for (const [i, [, isStep, isFree]] of steps.entries()) {
    const branch = `feat/${'abc'[i]}`
    const pr = PR + i
    const key = recordKey('/repo', branch)
    const branchId = `${SLUG}@${branch}`
    const prId = `${SLUG}#${pr}`
    await saveRecord($, seed({ branch }))
    // Session 2 is a checkout of this lifecycle from before the move, still driving the branch's object.
    const other = checkoutOf(w, fake, { [key]: local(w, key) })
    // The process dies right after the step's call lands: nothing after it reaches the relay, nor the local store.
    let snap: Map<string, unknown> | undefined
    onSend.fn = body => {
      if (snap !== undefined) fake.down = true
      else if (isStep(body)) snap = new Map([...w.store].map(([one, value]) => [one, structuredClone(value)]))
    }
    await updateRecord($, '/repo', branch, opened(pr), { isPure: true })
    onSend.fn = undefined
    fake.down = false
    expect(snap).toBeDefined()
    w.store.clear()
    for (const [one, value] of snap ?? []) w.store.set(one, value)
    expect(fake.objects.get(branchId)?.movedTo).toBe(pr)

    // The stale checkout's commit meets the tombstone: it finishes what the move left, follows it, and its work doesn't run again.
    const revBefore = fake.objects.get(branchId)?.rev
    const error = await thrown(saveRecord(other.$, grant('stale')(other.store.get(key) as LifecycleRecord)))
    expect(error).toBeInstanceOf(StaleRecord)
    expect(fake.objects.get(branchId)?.rev).toBe(revBefore)
    expect((other.store.get(key) as LifecycleRecord).relayKey).toBe(`#${pr}`)
    // Only the holder of the PR object's lease passes a boundary and dispatches (Task 8): while the dead process's claim there is
    // live, session 2 stands down; with none, its boundary claims the lease and it may go on.
    // Session 2 has no run of its own here: a stand-down drops none, and its status line goes nowhere.
    const state = { get: async () => ({ value: null }), set: async () => ({ isSet: true }) }
    const session2 = { ...(other.$ as object), state, ui: { status: () => undefined } }
    expect(await boundary(session2 as never, { root: '/repo', branch })).toBe(isFree)
    expect(reasons(recordAt(fake, prId))).toEqual([])

    // A lease the dead process left on the PR's object lapses; then the next load of the first checkout lands on the PR's object.
    await w.clock.advance(120_000)
    await updateRecord($, '/repo', branch, grant('driver'), { isPure: true })
    expect(reasons(recordAt(fake, prId))).toEqual(['driver'])
    expect(recordAt(fake, prId).pr).toBe(pr)
    expect(fake.objects.get(branchId)?.record).toEqual({ movedTo: pr, lifecycleId: local(w, key).lifecycleId })
    expect(local(w, key).relayKey).toBe(`#${pr}`)
  }
  const live = await liveRecords($, '/repo')
  expect(live.map(one => one.pr).sort()).toEqual([PR, PR + 1, PR + 2])
  expect(live.map(one => one.branch).sort()).toEqual(['feat/a', 'feat/b', 'feat/c'])
})

test('the index ends with only the PR entry', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed())
  expect([...(fake.index.get(SLUG)?.keys() ?? [])]).toEqual(['@feat/x'])
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  expect([...(fake.index.get(SLUG)?.keys() ?? [])]).toEqual([`#${PR}`])
  // An index that learns of the move late still lists the branch: discovery reads the lifecycle once, from its PR's object.
  const entry = fake.index.get(SLUG)?.get(`#${PR}`)
  fake.index.get(SLUG)?.set('@feat/x', { key: '@feat/x', branch: 'feat/x', phase: 'pre', rev: 1, updatedAt: 1, lifecycleId: entry?.lifecycleId ?? '' })
  const live = await liveRecords($, '/repo')
  expect(live).toHaveLength(1)
  expect(live[0]?.pr).toBe(PR)
})

test('a fresh start over the tombstone leaves the old PR\'s object alone', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed())
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  await updateRecord($, '/repo', 'feat/x', rec => ({ ...rec, phase: 'archived' }), { isPure: true })
  const old = structuredClone(fake.objects.get(PR_OBJECT))
  expect((old?.record as LifecycleRecord).phase).toBe('archived')
  const fresh = seed()
  // A pending mark from the old lifecycle is cleared by the record that replaces it.
  w.store.set(`${KEY}:relay-pending`, true)
  await upsertRecord($, '/repo', 'feat/x', () => fresh)
  // The new lifecycle is on the branch's object again, started over the tombstone; the old PR's object is as it was.
  expect(fake.objects.get(PR_OBJECT)).toEqual(old)
  expect(fake.objects.get(OBJECT)?.movedTo).toBeUndefined()
  expect(recordAt(fake, OBJECT).lifecycleId).toBe(fresh.lifecycleId)
  expect(opsOf(fake, 'commit').filter(body => body.isFresh === true)).toHaveLength(1)
  expect(local(w).relayKey).toBe('@feat/x')
  expect(local(w).lifecycleId).toBe(fresh.lifecycleId)
  expect(w.store.get(`${KEY}:relay-pending`)).toBeUndefined()
})

test('a non-holder\'s logEvent lands while its commit would get 423', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed())
  // Codex's checkout holds the branch object's lease.
  expect((await codex(fake, PATH, { op: 'claim', holder: 'codex-1', secret: CODEX_SECRET })).status).toBe(200)
  await logEvent($, '/repo', 'feat/x', 'session', 'a note from the checkout without the lease')
  const line = fake.objects.get(OBJECT)?.log.lines.at(-1)
  expect(line?.text).toBe('a note from the checkout without the lease')
  expect(line?.holder).toBe(w.sessionId)
  expect((local(w).log ?? []).some(one => one.text.startsWith('a note'))).toBe(false)
  const error = await thrown(saveRecord($, grant('mine')(local(w))))
  expect(error).toBeInstanceOf(StaleRecord)
  expect(reasons(recordAt(fake, OBJECT))).toEqual([])
})

test('a log line the relay can\'t take stays in the local log, and the round goes on', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed())
  fake.down = true
  await logEvent($, '/repo', 'feat/x', 'session', 'kept here')
  fake.down = false
  expect((local(w).log ?? []).map(one => one.text)).toContain('kept here')
  expect((local(w).log ?? []).filter(one => one.text.startsWith('relay down'))).toHaveLength(1)
})

test('the 1001st line drops the oldest and /pr-gate log says how many earlier lines are gone', { timeoutMs: 15_000 }, async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed())
  for (let i = 0; i < 1001; i += 1) await logEvent($, '/repo', 'feat/x', 'session', `line ${i}`)
  expect(fake.objects.get(OBJECT)?.log.lines).toHaveLength(1000)
  const log = await relayLog($, '/repo', 'feat/x')
  expect(log.lines).toHaveLength(1000)
  expect(log.dropped).toBe(1)
  expect(log.lines[0]?.text).toBe('line 1')
  expect(log.lines.at(-1)?.text).toBe('line 1000')
  expect(log.movedFrom).toBeUndefined()
})

test('liveRecords through the index matches the per-PR objects', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed())
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  // Another checkout's lifecycle on feat/y, PR 8, that this one has never held.
  const theirs = seed({ branch: 'feat/y', phase: 'post', pr: PR + 1, slug: SLUG })
  expect((await codex(fake, `/v1/${SLUG}/${PR + 1}`, { op: 'commit', rev: 0, record: theirs })).status).toBe(200)
  const live = await liveRecords($, '/repo')
  expect(live.map(one => one.pr).sort()).toEqual([PR, PR + 1])
  for (const one of live) {
    expect(one.root).toBe('/repo')
    expect(one.lifecycleId).toBe(recordAt(fake, `${SLUG}#${one.pr}`).lifecycleId)
    expect(one.branch).toBe(recordAt(fake, `${SLUG}#${one.pr}`).branch)
  }
})

test('latestArchive reads the relay\'s newest archive', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed())
  // A local archive, and a newer one another checkout put on the relay.
  w.store.set(`${KEY}:archived:100`, { ...local(w), phase: 'archived', head: 'b'.repeat(40) })
  const s = fake.objects.get(OBJECT)
  const newer = { ...(s?.record as LifecycleRecord), phase: 'archived', head: 'f'.repeat(40) }
  expect((await codex(fake, PATH, { op: 'commit', rev: s?.rev, record: s?.record, archive: { at: 5_000, record: newer } })).status).toBe(200)
  expect((await latestArchive($, '/repo', 'feat/x'))?.head).toBe('f'.repeat(40))
  // After the move, the branch object's archives are still read.
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  const found = await latestArchive($, '/repo', 'feat/x')
  expect(found?.head).toBe('f'.repeat(40))
  expect(found?.root).toBe('/repo')
  expect(found?.branch).toBe('feat/x')
})

test('a mirror of the branch\'s object is never taken for the PR object\'s revision of the same number', async (_t, on) => {
  const { w, fake, $, onSend } = setup(on)
  await saveRecord($, seed())
  // Session 2 holds the branch object's rev 2, the record with its PR, as it was just before the move froze that object.
  let held: unknown
  onSend.fn = body => {
    if (body.op === 'moveTo') held = structuredClone(w.store.get(KEY))
  }
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  onSend.fn = undefined
  const other = checkoutOf(w, fake, { [KEY]: held })
  expect((other.store.get(KEY) as LifecycleRecord).relayRev).toBe(2)
  expect((other.store.get(KEY) as LifecycleRecord).pr).toBe(PR)
  // The PR object's rev 2 then holds the first checkout's grant: the same number, of another object.
  await updateRecord($, '/repo', 'feat/x', grant('first'), { isPure: true })
  expect(fake.objects.get(PR_OBJECT)?.rev).toBe(2)
  // The first checkout's run ends: the lease its move kept goes back (Task 8), and session 2 may write.
  await releaseLease($, '/repo', 'feat/x')
  await updateRecord(other.$, '/repo', 'feat/x', grant('second'), { isPure: true })
  expect(reasons(recordAt(fake, PR_OBJECT))).toEqual(['first', 'second'])
  expect((other.store.get(KEY) as LifecycleRecord).relayKey).toBe(`#${PR}`)
})

test('a snapshot that fails is sent again after the next call that lands', async (_t, on) => {
  const { w, fake, $, onSend } = setup(on)
  // The relay holds this lifecycle already; the local record is from before the relay.
  const before = seed()
  expect((await codex(fake, PATH, { op: 'commit', rev: 0, record: { ...before, slug: SLUG } })).status).toBe(200)
  w.store.set(KEY, { ...before, grants: [{ n: 1, reason: 'from before', head: before.head, at: 1 }] })
  let isFirst = true
  onSend.fn = body => {
    fake.down = body.op === 'snapshot' && isFirst
    if (body.op === 'snapshot') isFirst = false
  }
  await updateRecord($, '/repo', 'feat/x', grant('after'), { isPure: true })
  onSend.fn = undefined
  fake.down = false
  const archives = fake.objects.get(OBJECT)?.archives ?? []
  expect(archives.filter(one => one.reason === 'migration')).toHaveLength(1)
  expect(reasons(archives.find(one => one.reason === 'migration')?.record)).toEqual(['from before'])
  expect(w.store.get(`${KEY}:relay-owed`)).toBeUndefined()
  expect((local(w).log ?? []).filter(one => one.text.startsWith('relay snapshot missing'))).toHaveLength(1)
  expect(reasons(recordAt(fake, OBJECT))).toEqual(['after'])
})

test('a security title in a logEvent line never appears in any log body', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed({ findings: [SECRET] }))
  await logEvent($, '/repo', 'feat/x', 'session', `fixing ${SECRET.title} now`)
  await logEvent($, '/repo', 'feat/x', 'session', 'a line that names nothing')
  const bodies = opsOf(fake, 'log')
  expect(bodies).toHaveLength(2)
  expect(bodies.flatMap(stringsOf).some(one => one.includes('SECRET-TITLE'))).toBe(false)
  expect(stringsOf(fake.objects.get(OBJECT)?.log).some(one => one.includes('SECRET-TITLE'))).toBe(false)
  expect(fake.objects.get(OBJECT)?.log.lines.map(one => one.text)).toEqual([HELD_PLACEHOLDER, 'a line that names nothing'])
})

// ------------------------------------------------------------------ fix round 1

const linesOf = (rec: LifecycleRecord, start: string): string[] => (rec.log ?? []).map(one => one.text).filter(text => text.startsWith(start))

/** Codex's checkout resets feat/x to a new lifecycle and moves that one to PR `pr`: the branch's object is its tombstone. */
async function codexResetsAndMoves(fake: FakeRelay, pr: number): Promise<LifecycleRecord> {
  const reset = { ...seed(), slug: SLUG }
  expect((await codex(fake, PATH, { op: 'commit', rev: fake.objects.get(OBJECT)?.rev ?? 0, record: reset })).status).toBe(200)
  await codexMoves(fake, pr)
  return reset
}

/** The first checkout's move of feat/x to PR 7, with every relay call after the step `isStep` down: the move stops right there. */
async function movesUntil(s: Setup, isStep: (body: Record<string, unknown>) => boolean): Promise<void> {
  let isPast = false
  s.onSend.fn = body => {
    if (isPast) s.fake.down = true
    else if (isStep(body)) isPast = true
  }
  await updateRecord(s.$, '/repo', 'feat/x', opened(PR), { isPure: true })
  s.onSend.fn = undefined
  s.fake.down = false
}

test('a mismatched tombstone on the commit path stands down, and the relay is unchanged', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed())
  const mine = local(w)
  await codexResetsAndMoves(fake, 9)
  const before = structuredClone([...fake.objects])
  // This checkout's save, with no load, of the lifecycle another checkout reset: never revived over the other's tombstone.
  expect(await thrown(saveRecord($, grant('stale')(mine)))).toBeInstanceOf(RelayMoved)
  expect([...fake.objects]).toEqual(before)
  expect(opsOf(fake, 'commit').filter(body => body.isFresh === true)).toHaveLength(0)
  expect(linesOf(local(w), 'relay moved:')).toHaveLength(1)
  expect(reasons(local(w))).toEqual([])
})

test('a real reset over a tombstone fresh-starts', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed())
  await codexResetsAndMoves(fake, 9)
  const theirs = structuredClone(fake.objects.get(`${SLUG}#9`))
  const fresh = seed()
  await saveRecord($, fresh)
  expect(recordAt(fake, OBJECT).lifecycleId).toBe(fresh.lifecycleId)
  expect(fake.objects.get(OBJECT)?.movedTo).toBeUndefined()
  expect(fake.objects.get(`${SLUG}#9`)).toEqual(theirs)
  expect(local(w).relayKey).toBe('@feat/x')
})

test('a fresh start over a tombstone still holding its record runs the move\'s steps 2 and 3 first', async (_t, on) => {
  const s = setup(on)
  const { w, fake, $ } = s
  await saveRecord($, seed())
  const old = local(w).lifecycleId
  await movesUntil(s, body => body.op === 'moveTo')
  expect((fake.objects.get(OBJECT)?.record as { record?: unknown }).record).toBeDefined()
  expect(fake.objects.has(PR_OBJECT)).toBe(false)
  const fresh = seed()
  await saveRecord($, fresh)
  // The old lifecycle is on its PR's object, and the new one on the branch's.
  expect(recordAt(fake, PR_OBJECT).lifecycleId).toBe(old)
  expect(recordAt(fake, PR_OBJECT).pr).toBe(PR)
  expect(recordAt(fake, OBJECT).lifecycleId).toBe(fresh.lifecycleId)
  expect(fake.objects.get(OBJECT)?.movedTo).toBeUndefined()
})

test('a fresh start over a tombstone whose PR object holds another lifecycle keeps the frozen record by a move snapshot', async (_t, on) => {
  const s = setup(on)
  const { w, fake, $ } = s
  await saveRecord($, seed())
  const old = local(w).lifecycleId
  await movesUntil(s, body => body.op === 'moveTo')
  const other = { ...seed({ phase: 'post', pr: PR }), slug: SLUG }
  expect((await codex(fake, PR_PATH, { op: 'commit', rev: 0, record: other })).status).toBe(200)
  const fresh = seed()
  await saveRecord($, fresh)
  expect(recordAt(fake, PR_OBJECT).lifecycleId).toBe(other.lifecycleId)
  const kept = (fake.objects.get(OBJECT)?.archives ?? []).filter(one => one.reason === 'move')
  expect(kept.map(one => (one.record as LifecycleRecord).lifecycleId)).toEqual([old])
  expect(recordAt(fake, OBJECT).lifecycleId).toBe(fresh.lifecycleId)
})

test('a fresh start from the PR key over an unfinished move meets the relay\'s 409 and loses nothing', async (_t, on) => {
  const s = setup(on)
  const { w, fake, $, onSend } = s
  await saveRecord($, seed())
  const old = local(w).lifecycleId
  // The move stops after its commit to the PR's object: the mirror is there, and the tombstone still holds the record.
  await movesUntil(s, body => body.op === 'commit' && body.from !== undefined)
  expect(local(w).relayKey).toBe(`#${PR}`)
  // The new lifecycle's moveDone of the old move doesn't land: its fresh commit is held off with a 409.
  onSend.fn = body => {
    fake.down = body.op === 'moveDone'
  }
  const fresh = seed()
  expect(await thrown(saveRecord($, fresh))).toBeInstanceOf(StaleRecord)
  onSend.fn = undefined
  fake.down = false
  expect((fake.objects.get(OBJECT)?.record as { record?: LifecycleRecord }).record?.lifecycleId).toBe(old)
  expect(recordAt(fake, PR_OBJECT).lifecycleId).toBe(old)
  // Once the relay answers, the move finishes and the new lifecycle starts.
  await saveRecord($, fresh)
  expect(fake.objects.get(OBJECT)?.record).toMatchObject({ lifecycleId: fresh.lifecycleId })
  expect(recordAt(fake, PR_OBJECT).lifecycleId).toBe(old)
})

test('the claim the move takes is kept as the mover\'s lease; a lost release of it at the run\'s end is owed, and sent after the next call that lands', async (_t, on) => {
  const { w, fake, $, onSend } = setup(on)
  await saveRecord($, seed())
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  // Task 8: the move's claim on the PR object is this session's lease, never released and claimed again, and never locks it out.
  expect(opsOf(fake, 'release')).toHaveLength(0)
  expect(fake.objects.get(PR_OBJECT)?.lease?.holder).toBe(w.sessionId)
  await updateRecord($, '/repo', 'feat/x', grant('kept'), { isPure: true })
  expect(reasons(recordAt(fake, PR_OBJECT))).toEqual(['kept'])
  // The run ends with the relay down: its release is owed.
  onSend.fn = body => {
    fake.down = body.op === 'release'
  }
  await releaseLease($, '/repo', 'feat/x')
  onSend.fn = undefined
  fake.down = false
  expect(fake.objects.get(PR_OBJECT)?.lease).not.toBeNull()
  expect((w.store.get(`${KEY}:relay-owed`) as { body: { op: string } }[]).map(one => one.body.op)).toEqual(['release'])
  // No wait for the lease to lapse: the load's read lands, the release goes after it, and the commit is taken.
  await updateRecord($, '/repo', 'feat/x', grant('next'), { isPure: true })
  expect(reasons(recordAt(fake, PR_OBJECT))).toEqual(['kept', 'next'])
  expect(w.store.get(`${KEY}:relay-owed`)).toBeUndefined()
})

test('a moveTo the relay refuses says so in the run log', async (_t, on) => {
  const { w, fake, $, onSend } = setup(on)
  await saveRecord($, seed())
  // The branch's lease is lost just before the moveTo: the relay answers 409.
  onSend.fn = body => {
    const s = fake.objects.get(OBJECT)
    if (body.op === 'moveTo' && s !== undefined) s.lease = null
  }
  await updateRecord($, '/repo', 'feat/x', opened(PR), { isPure: true })
  onSend.fn = undefined
  expect(fake.objects.get(OBJECT)?.movedTo).toBeUndefined()
  expect(linesOf(local(w), 'relay move refused (HTTP 409)')).toHaveLength(1)
})
