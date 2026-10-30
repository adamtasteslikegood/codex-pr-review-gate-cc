import { expect, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { newRecord } from '../hooks/lifecycle'
import { isKeptBy, isOwnedElsewhere, isStoodDownBy, setSession } from '../hooks/round'
import { beatLease, claimLease, forgetLeases, forgetOptIns, readLease, recordKey, saveRecord, StaleRecord, updateRecord } from '../hooks/store'
import type { LifecycleRecord } from '../types'
import { PRINCIPALS } from './contract'
import { fakeRelay, HEADERS_OF } from './relay-fake'
import type { FakeRelay } from './relay-fake'
import { createPr, done, P1, review, turn, world } from './world'
import type { World } from './world'

// #29 Part B, Task 8 (R100, R105): the driver holds the relay's lease. It beats every 60 s and at each action boundary (an agent
// turn, a spawn, a gh write), answers "is it mine" from its kept lease, and stands down when it lost it. A person's session takes
// the lease within one principal; a headless one only claims. The flows run the mod itself, its fetches answered by the fake relay.

const URL_ = 'https://relay.example.org'
const SHARED = JSON.stringify({ sharedStore: { url: URL_, aud: 'aud-tag' } })
const SLUG = 'me/repo'
const OBJECT = `${SLUG}@feat/x`
const PATH = `/v1/${SLUG}/branch/feat%2Fx`
const KEY = recordKey('/repo', 'feat/x')
const OWNER = `${KEY}:owner`
const { ADAM, CODEX } = PRINCIPALS
const BEA = 'bea@example.org'
const SECRET_2 = 'session-2-secret-of-at-least-32-characters'

type Dispatch = Parameters<TestBody>[0]
type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>
/** One call the relay answered: its op, the object it went to (`@` the branch's, `#` a PR's), its answer, when, and what it carried. */
type Seen = { op: string; at: string; status: number; when: number; secret?: string; text?: string }
type Relayed = {
  w: World
  fake: FakeRelay
  seen: Seen[]
  env: Record<string, string>
  after: { fn?: (one: Seen) => Promise<void> }
  /** Session 2's take of the branch object's lease, as Adam: straight to the relay's route, as another checkout's mod sends it. */
  takeAs2: () => Promise<number>
}

const asPerson = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const say = ($: Dispatch, args: string) => $.command.run({ command: 'pr-gate', args, ...asPerson } as never) as Promise<{ text: string }>

/**
 * A repo whose base opts in, Adam's token in the environment (`env` changes it mid-test), and the relay tapped: `seen` records each
 * answer to the mod, and `after.fn` runs right after one, before the mod reads it.
 */
function relayed(on: Parameters<typeof world>[0], isShared = true): Relayed {
  forgetOptIns()
  forgetLeases()
  const w = world(on)
  if (isShared) w.git.roster = SHARED
  const clock = w.clock as unknown as MockClock
  const fake = fakeRelay(on, {
    clock,
    people: { 'adam-token': ADAM, 'bea-token': BEA },
    grants: { [SLUG]: { [ADAM]: 'operate', [CODEX]: 'operate', [BEA]: 'operate' } },
  })
  const env: Record<string, string> = { PR_GATE_RELAY_TOKEN: 'adam-token' }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  const seen: Seen[] = []
  const after: Relayed['after'] = {}
  const real: Fetch = fake.fetch
  reals.set(fake, real)
  fake.fetch = async (url, init) => {
    const answer = await real(url, init)
    const body = JSON.parse(init?.body ?? '{}') as { op?: string; secret?: string; text?: string }
    const one: Seen = {
      op: body.op ?? '',
      at: url.includes('/branch/') ? '@' : '#',
      status: answer.status,
      when: clock.now(),
      ...(body.secret === undefined ? {} : { secret: body.secret }),
      ...(body.text === undefined ? {} : { text: body.text }),
    }
    seen.push(one)
    await after.fn?.(one)
    return answer
  }
  const headers = { ...HEADERS_OF.ADAM, 'content-type': 'application/json' }
  const takeAs2 = async (): Promise<number> =>
    (await real(`${URL_}${PATH}`, { method: 'POST', headers, body: JSON.stringify({ op: 'take', holder: 'session-2', secret: SECRET_2 }) })).status
  return { w, fake, seen, env, after, takeAs2 }
}

const reals = new WeakMap<FakeRelay, Fetch>()
const realOf = (fake: FakeRelay): Fetch => reals.get(fake) as Fetch

/** The lease secret a session of this checkout sends. */
const secretOf = (w: World, sessionId = 'session-1'): string | undefined => w.store.get(`relay-secret:${sessionId}`) as string | undefined
const opsOf = (seen: Seen[]): string[] => seen.map(one => `${one.op}${one.at}`)

test('the relay holder beats every 60 s, and its ownership checks make no network read while the lease holds', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen } = relayed(on)
  await $.tool.call(createPr)
  // The pre-PR review's result: the result itself and the controller after it check ownership (#13), from the kept lease.
  const from = seen.length
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  const during = seen.slice(from)
  // Each read is a transaction's load, followed by its commit: no ownership check went to the relay.
  expect(during.filter(one => one.op === 'read')).toHaveLength(during.filter(one => one.op === 'commit').length)
  for (const [i, one] of during.entries()) if (one.op === 'read') expect(during[i + 1]?.op).toBe('commit')
  expect(w.prompts.at(-1)).toContain('R1-1')
  // While the fix runs, the ticker beats the lease once a minute, never at the local 30 s, and reads nothing.
  const quiet = seen.length
  await w.clock.advance(185_000)
  const beats = seen.slice(quiet).filter(one => one.op === 'beat')
  expect(beats.length).toBeGreaterThanOrEqual(3)
  expect(beats.every(one => one.status === 200)).toBe(true)
  for (let i = 1; i < beats.length; i += 1) expect((beats[i]?.when ?? 0) - (beats[i - 1]?.when ?? 0)).toBe(60_000)
  expect(seen.slice(quiet).filter(one => one.op === 'read')).toEqual([])
  expect(fake.objects.get(OBJECT)?.lease?.holder).toBe('session-1')
})

test('a take right after the old driver\'s beat: the old driver\'s next commit gets 423, it stands down, and nothing is dispatched', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen, after, takeAs2 } = relayed(on)
  await $.tool.call(createPr)
  const spawned = w.spawned.length
  const prompts = w.prompts.length
  // Session 2 (Adam's too, at the keyboard) takes the lease the moment the ticker's beat lands.
  let took: number | undefined
  after.fn = async one => {
    if (one.op !== 'beat' || one.status !== 200 || took !== undefined) return
    took = await takeAs2()
  }
  await w.clock.advance(61_000)
  after.fn = undefined
  expect(took).toBe(200)
  const from = seen.length
  // The review's result: the old driver's next step on the record is its change, under a lease that is no longer its own.
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  const mine = seen.slice(from).filter(one => one.secret === undefined || one.secret === secretOf(w))
  expect(mine.find(one => one.op === 'commit')?.status).toBe(423)
  expect(mine.filter(one => one.op === 'commit' && one.status === 200)).toEqual([])
  // It stood down: no run, no prompt to its agent, no sub-agent; the lease is session 2's.
  expect(w.run).toBeNull()
  expect(w.prompts).toHaveLength(prompts)
  expect(w.spawned).toHaveLength(spawned)
  expect(fake.objects.get(OBJECT)?.lease?.holder).toBe('session-2')
  const lines = fake.objects.get(OBJECT)?.log.lines.map(one => one.text) ?? []
  expect(lines.filter(one => one.includes('stood down') && one.includes(`of ${ADAM} holds this lifecycle until`))).toHaveLength(1)
})

test('a take between the driver\'s change and its next boundary: that beat is lost (409), and nothing is dispatched', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, seen, after, takeAs2 } = relayed(on)
  await $.tool.call(createPr)
  const prompts = w.prompts.length
  // Session 2 takes the lease right after the round's result is committed, before the fix prompt's boundary.
  let took: number | undefined
  let at = 0
  after.fn = async one => {
    if (one.op !== 'commit' || one.status !== 200 || took !== undefined) return
    took = await takeAs2()
    at = seen.length
  }
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  after.fn = undefined
  expect(took).toBe(200)
  // The relay answers a beat of a lease that is not this checkout's 409 (the contract pins it); the boundary is false.
  expect(seen.slice(at).find(one => one.op === 'beat')?.status).toBe(409)
  expect(w.prompts).toHaveLength(prompts)
  expect(w.run).toBeNull()
})

test('a headless second session never takes a live lease; an interactive one by the same principal does', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen } = relayed(on)
  await $.tool.call(createPr)
  const lease = fake.objects.get(OBJECT)?.lease
  expect(lease?.holder).toBe('session-1')
  // A hook's `claude -p` child in the same checkout.
  w.clearState()
  w.sessionId = 'child'
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  const from = seen.length
  expect((await say($, 'start')).text).toContain('Not started')
  expect(seen.slice(from).filter(one => one.op === 'take' || one.op === 'claim' || one.op === 'commit')).toEqual([])
  expect(fake.objects.get(OBJECT)?.lease).toEqual(lease)
  // A person's second session, as Adam: the take moves the lease to it at once, with a new fencing token.
  w.clearState()
  w.sessionId = 'second'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect((await say($, 'start')).text).not.toContain('Not started')
  expect(seen.filter(one => one.op === 'take' && one.secret === secretOf(w, 'second')).map(one => one.status)).toEqual([200])
  expect(fake.objects.get(OBJECT)?.lease).toMatchObject({ holder: 'second', principal: ADAM })
  expect(fake.objects.get(OBJECT)?.lease?.token).toBeGreaterThan(lease?.token ?? Infinity)
})

test('a different principal\'s take gets 423 and the person is told who holds it until when', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen, env } = relayed(on)
  await $.tool.call(createPr)
  const lease = fake.objects.get(OBJECT)?.lease
  // Bea, at her own keyboard in her own checkout of the branch, with her own token.
  env.PR_GATE_RELAY_TOKEN = 'bea-token'
  w.clearState()
  w.sessionId = 'bea-session'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const from = seen.length
  const reply = (await say($, 'start')).text
  expect(seen.slice(from).filter(one => one.op === 'take').map(one => one.status)).toEqual([423])
  expect(seen.slice(from).filter(one => one.op === 'claim' || one.op === 'commit')).toEqual([])
  expect(reply).toContain(`Not started: session session- of ${ADAM} holds this lifecycle until ${new Date(lease?.until ?? 0).toISOString()}.`)
  expect(fake.objects.get(OBJECT)?.lease).toEqual(lease)
})

/** The mod's engine as the store sees it, for session `sessionId` over `store` (shared-store.test.ts has the same). */
function engineOf(w: World, fake: FakeRelay, store: Map<string, unknown>, sessionId: string): never {
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
    http: { fetch: (url: string, init?: HttpInit) => fake.fetch(url, init) },
    env: { get: async (name: string) => ({ PR_GATE_RELAY_TOKEN: 'adam-token' })[name] },
    session: { id: async () => sessionId },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
  } as never
}

const seed = (): LifecycleRecord =>
  newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 })
const grant = (reason: string) => async (rec: LifecycleRecord): Promise<LifecycleRecord> =>
  ({ ...rec, grants: [...rec.grants, { n: 1, reason, head: rec.head, at: 1 }] })

test('a takeover after a lapse fences out the old holder\'s commit', async (_$, on) => {
  const { w, fake } = relayed(on)
  const one = engineOf(w, fake, w.store, 'session-1')
  await saveRecord(one, seed())
  const first = await claimLease(one, '/repo', 'feat/x', false)
  expect('mine' in first && first.mine.token).toBe(1)
  // Session 1 goes quiet (a sleeping laptop): its lease lapses, and session 2 takes the lifecycle over.
  await w.clock.advance(121_000)
  const store = new Map<string, unknown>([[KEY, structuredClone(w.store.get(KEY))]])
  const two = engineOf(w, fake, store, 'session-2')
  const taken = await claimLease(two, '/repo', 'feat/x', true)
  expect('mine' in taken && taken.mine.token).toBe(2)
  // Session 1 wakes and writes what it had: the relay refuses its commit (423), and the session learns who holds the lease.
  const rev = fake.objects.get(OBJECT)?.rev
  const error = await updateRecord(one, '/repo', 'feat/x', grant('stale')).then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(StaleRecord)
  expect((error as StaleRecord).lease).toMatchObject({ holder: 'session-2', principal: ADAM, token: 2 })
  expect(fake.objects.get(OBJECT)?.rev).toBe(rev)
  // The 423 emptied its kept lease: its next boundary claims, and meets session 2's lease. Session 2's own change is taken.
  expect(await beatLease(one, '/repo', 'feat/x')).toMatchObject({ held: { holder: 'session-2' } })
  await updateRecord(two, '/repo', 'feat/x', grant('driver'))
  expect((fake.objects.get(OBJECT)?.record as LifecycleRecord).grants.map(g => g.reason)).toEqual(['driver'])
})

test('standDown logs through log, not a commit', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen, after, takeAs2 } = relayed(on)
  await $.tool.call(createPr)
  let took: number | undefined
  let at = 0
  after.fn = async one => {
    if (one.op !== 'commit' || one.status !== 200 || took !== undefined) return
    took = await takeAs2()
    at = seen.length
  }
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  after.fn = undefined
  expect(took).toBe(200)
  // After the take, session 1 beat (lost), then wrote its line with the lease-free `log`: never a commit, nothing to a local log.
  expect(opsOf(seen.slice(at))).toEqual(['beat@', 'log@'])
  expect(seen.at(-1)?.text).toContain('stood down: another session runs the record')
  expect(fake.objects.get(OBJECT)?.log.lines.at(-1)?.holder).toBe('session-1')
  expect(((w.store.get(KEY) as LifecycleRecord).log ?? []).filter(one => one.text.includes('stood down'))).toEqual([])
})

test('the claim the move takes on the PR\'s object is the driver\'s lease: never released, and its next beat renews it', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen } = relayed(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  const from = seen.length
  await $.tool.call(createPr)
  const moved = seen.slice(from)
  expect(opsOf(moved)).toContain('moveTo@')
  expect(moved.filter(one => one.at === '#' && one.op === 'release')).toEqual([])
  expect(fake.objects.get(`${SLUG}#1`)?.lease?.holder).toBe('session-1')
  // Post-PR collection: the ticker beats the PR object's lease; nothing claims it again, and every change is taken.
  const quiet = seen.length
  await w.clock.advance(61_000)
  const later = seen.slice(quiet)
  expect(later.filter(one => one.op === 'beat')).not.toHaveLength(0)
  expect(later.filter(one => one.op === 'beat' || one.op === 'claim').every(one => one.at === '#' && one.op === 'beat' && one.status === 200)).toBe(true)
  expect(later.filter(one => one.op === 'commit').every(one => one.status === 200)).toBe(true)
  expect(w.run?.phase).toBe('collect')
})

test('a base that opts in, with no relay credential, stays local and its run log says so once', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, env } = relayed(on)
  delete env.PR_GATE_RELAY_TOKEN
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  expect(fake.calls).toEqual([])
  const lines = ((w.store.get(KEY) as LifecycleRecord).log ?? []).filter(one => one.text.startsWith('no relay credential'))
  expect(lines).toHaveLength(1)
  expect(lines[0]?.text).toContain('PR_GATE_RELAY_TOKEN')
})

test('the local backend is unchanged', { timeoutMs: 15_000 }, async ($, on) => {
  // The #13 owner tests in flow.test.ts pass as they are. Here, a repo that does not opt in never reaches the relay, and its
  // ticker beats the local owner every 30 s.
  const { w, fake } = relayed(on, false)
  await $.tool.call(createPr)
  await w.clock.advance(1_000)
  const first = (w.stored(OWNER) as { beatAt: number }).beatAt
  await w.clock.advance(31_000)
  expect(w.stored(OWNER)).toMatchObject({ sessionId: 'session-1' })
  expect((w.stored(OWNER) as { beatAt: number }).beatAt - first).toBe(30_000)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  expect(w.prompts.at(-1)).toContain('R1-1')
  expect(fake.calls).toEqual([])
})


// ------------------------------------------------------------------ Task 8 review, fix round 1

test('a commit refused with 423 empties the kept lease: the next ownership check reads the relay, so the merge watcher takes nothing', async (_$, on) => {
  const { w, fake } = relayed(on)
  const one = engineOf(w, fake, w.store, 'session-1')
  await saveRecord(one, seed())
  expect('mine' in (await claimLease(one, '/repo', 'feat/x', false))).toBe(true)
  // Session 2, Adam's at the keyboard, takes the live lease; session 1's next commit meets it.
  const two = engineOf(w, fake, new Map<string, unknown>([[KEY, structuredClone(w.store.get(KEY))]]), 'session-2')
  expect('mine' in (await claimLease(two, '/repo', 'feat/x', true))).toBe(true)
  const error = await updateRecord(one, '/repo', 'feat/x', grant('stale')).then(() => undefined, (e: unknown) => e)
  expect((error as StaleRecord).isHeld).toBe(true)
  // Session 1 answers no ownership check from its cache: it reads the relay and sees session 2's lease (spec §4).
  const calls = fake.calls.length
  expect(await readLease(one, '/repo', 'feat/x')).toMatchObject({ held: { holder: 'session-2' } })
  expect(fake.calls.slice(calls).map(call => (call.body as { op?: string }).op)).toEqual(['read'])
  // The merge watcher skips a record owned elsewhere (watchBeat's first check), so it never claims or takes this one.
  setSession(true)
  expect(await isOwnedElsewhere(one, '/repo', 'feat/x')).toBe(true)
  expect(fake.calls.slice(calls).filter(call => ['take', 'claim'].includes(String((call.body as { op?: string }).op)))).toEqual([])
  expect(fake.objects.get(OBJECT)?.lease?.holder).toBe('session-2')
})

test('after a pre-PR pass ends, the relay holds no lease, and a headless start in the same checkout is not refused', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, fake, seen } = relayed(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  await w.clock.advance(1_000)
  // The run's end released its lease, and the ready prompt after it claimed none.
  const lease = fake.objects.get(OBJECT)?.lease
  expect(lease === null || lease === undefined).toBe(true)
  const released = seen.findLastIndex(one => one.op === 'release')
  expect(released).toBeGreaterThan(-1)
  expect(seen.slice(released + 1).filter(one => one.op === 'claim' || one.op === 'take')).toEqual([])
  // A hook's `claude -p` child, within the 120 s a lingering lease would have held: it is not told another session runs it.
  w.clearState()
  w.sessionId = 'child'
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  expect((await say($, 'start')).text).not.toContain('another session')
})

test('a refused credential at a claim says the relay refused this checkout, not that another session runs it', { timeoutMs: 15_000 }, async ($, on) => {
  const { w, env } = relayed(on)
  await $.tool.call(createPr)
  // A person's second session whose token the relay does not know.
  env.PR_GATE_RELAY_TOKEN = 'nobody-token'
  w.clearState()
  w.sessionId = 'second'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const reply = (await say($, 'start')).text
  expect(reply).toContain('Not started: the shared lifecycle store refused this checkout')
  expect(reply).not.toContain('another session runs this lifecycle')
})

test('a plain stale commit (409) at a non-pure site keeps the run; only a 423, a moved record or a refusal stands down', async (_$, on) => {
  const { w, fake } = relayed(on)
  const one = engineOf(w, fake, w.store, 'session-1')
  const plain = new StaleRecord(3, null, 'another writer committed first')
  expect(isKeptBy(plain)).toBe(true)
  // Not stood down: no stand-down line, and nothing reaches the relay; the next tick works from the relay's record (spec §14).
  expect(await isStoodDownBy(one, { root: '/repo', branch: 'feat/x' }, plain)).toBe(false)
  expect(fake.calls).toEqual([])
  expect(isKeptBy(new StaleRecord(3, undefined, 'another checkout holds the lease'))).toBe(false)
})
