import { expect, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { newRecord } from '../hooks/lifecycle'
import { fileIssues, isStoodDownBy } from '../hooks/round'
import { claimLease, forgetLeases, forgetOptIns, recordKey, releaseLease, saveRecord, StaleRecord, updateRecord } from '../hooks/store'
import type { Finding, LifecycleRecord } from '../types'
import { PRINCIPALS } from './contract'
import { fakeRelay } from './relay-fake'
import type { FakeRelay } from './relay-fake'
import { createPr, done, P1, review, TRAILER, turn, world } from './world'
import type { World } from './world'

// #29 Part B, Task 11 (spec §4, §7, §14): two controllers run one PR through the relay. Checkout A (`/repo`, session-1) and checkout B
// (`/repo-2`, session-2) share one fake relay, one fake GitHub and one clock, each with its own plugin store. A is the mod itself,
// driven through the test's `$`; B is the mod's own store and round code over its own engine stand-in. Where B must drive (dispatch a
// step), `$` is handed over to it: the world's store, session id and checkout root become B's, as a second session's mod would see them.
// Both sign in as Adam, so a person's take moves the lease between them (P(b)).

const URL_ = 'https://relay.example.org'
const SHARED = JSON.stringify({ sharedStore: { url: URL_, aud: 'aud-tag' } })
const SLUG = 'me/repo'
const BRANCH = 'feat/x'
const OBJECT = `${SLUG}@${BRANCH}`
const ROOT_A = '/repo'
const ROOT_B = '/repo-2'
const PR = 7
const PR_BRANCH = 'feat/y'
const PR_OBJECT = `${SLUG}#${PR}`
const MERGED = { kind: 'outside' } as const
const { ADAM, CODEX } = PRINCIPALS

type Dispatch = Parameters<TestBody>[0]
type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>
/** One call the relay answered: the session that sent it, its op, the object (`@` a branch's, `#` a PR's) and the answer's status. */
type Seen = { by: string; op: string; at: string; status: number }
/** One checkout: its root, its session, its own plugin store, and the mod's engine as its store and round code see it. */
type Checkout = { root: string; sessionId: string; store: Map<string, unknown>; $: never }
type Two = { w: World; fake: FakeRelay; seen: Seen[]; after: { fn?: (one: Seen) => Promise<void> }; a: Checkout; b: Checkout }

/** The mod's own engine for `sessionId` over `store` (filing-ledger.test.ts has the same), with its relay calls through `fetch`. */
function engineOf(w: World, fetch: Fetch, store: Map<string, unknown>, sessionId: string): never {
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
    http: { fetch },
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

/**
 * Two checkouts of one repo that opts in on its base, on one relay and one GitHub. Every relay answer is tapped into `seen`, with the
 * session that asked, and `after.fn` runs right after one, before its caller reads it. A is the world's own session at first.
 */
function twoWorlds(on: Parameters<typeof world>[0]): Two {
  forgetOptIns()
  forgetLeases()
  const w = world(on)
  w.git.roster = SHARED
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate', [CODEX]: 'operate' } } })
  on('env.get', (_$, e) => ({ value: ({ PR_GATE_RELAY_TOKEN: 'adam-token' } as Record<string, string>)[e.name] }))
  const seen: Seen[] = []
  const after: Two['after'] = {}
  const real: Fetch = fake.fetch
  const tapped = (by: () => string): Fetch => async (url, init) => {
    const answer = await real(url, init)
    const op = (JSON.parse(init?.body ?? '{}') as { op?: string }).op ?? ''
    const one: Seen = { by: by(), op, at: url.includes('/branch/') ? '@' : '#', status: answer.status }
    seen.push(one)
    await after.fn?.(one)
    return answer
  }
  // The mod's own fetches, as whichever session `$` is now.
  fake.fetch = tapped(() => w.sessionId)
  const a: Checkout = { root: ROOT_A, sessionId: 'session-1', store: w.store, $: undefined as never }
  a.$ = engineOf(w, tapped(() => a.sessionId), a.store, a.sessionId)
  const b: Checkout = { root: ROOT_B, sessionId: 'session-2', store: new Map(), $: undefined as never }
  b.$ = engineOf(w, tapped(() => b.sessionId), b.store, b.sessionId)
  return { w, fake, seen, after, a, b }
}

/** B's checkout learns the lifecycle: A's mirror of `branch`, as B's own (its root, none of A's secrets or kept state). */
function mirror(from: Checkout, to: Checkout, branch = BRANCH): void {
  const rec = from.store.get(recordKey(from.root, branch)) as LifecycleRecord
  to.store.set(recordKey(to.root, branch), { ...structuredClone(rec), root: to.root })
}

/** `$` becomes B's session: the mod now reads B's store, B's session id and B's checkout root, with no run of its own yet. */
async function handOver($: Dispatch, two: Two): Promise<void> {
  two.w.store = two.b.store
  two.w.git.toplevel = ROOT_B
  two.w.clearState()
  two.w.sessionId = two.b.sessionId
  await $.session.start({ cwd: ROOT_B, surface: 'terminal', isInteractive: true } as never)
}

const asPerson = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const say = ($: Dispatch, args: string) => $.command.run({ command: 'pr-gate', args, ...asPerson } as never) as Promise<{ text: string }>
const by = (seen: Seen[], sessionId: string): Seen[] => seen.filter(one => one.by === sessionId)
const opsOf = (seen: Seen[]): string[] => seen.map(one => `${one.op}${one.at}=${one.status}`)
const linesOf = (fake: FakeRelay, id = OBJECT) => fake.objects.get(id)?.log.lines ?? []
const fixed = (id: string) => `Fixed.\n${TRAILER}\n${JSON.stringify({ step: 'r1-fix', dispositions: [{ id, action: 'fixed', note: 'done' }] })}`
const grant = (reason: string) => (rec: LifecycleRecord): LifecycleRecord => ({ ...rec, grants: [...rec.grants, { n: 1, reason, head: rec.head, at: 1 }] })
const reasons = (rec: unknown): string[] => ((rec as LifecycleRecord | undefined)?.grants ?? []).map(one => one.reason)

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

const seed = (root: string, branch = BRANCH): LifecycleRecord =>
  newRecord({ root, branch, base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 })

/** A post-PR record of PR 7 (branch feat/y) with one P1 still holding, saved onto the relay by A, and A's claim of its lease. */
async function postPr(two: Two): Promise<LifecycleRecord> {
  const rec: LifecycleRecord = { ...seed(ROOT_A, PR_BRANCH), phase: 'post', pr: PR, slug: SLUG, findings: [HELD] }
  await saveRecord(two.a.$, rec)
  expect('mine' in (await claimLease(two.a.$, ROOT_A, PR_BRANCH, false))).toBe(true)
  return two.a.store.get(recordKey(ROOT_A, PR_BRANCH)) as LifecycleRecord
}

const recordIn = (c: Checkout, branch = PR_BRANCH): LifecycleRecord => c.store.get(recordKey(c.root, branch)) as LifecycleRecord
const findingIn = (c: Checkout): Finding | undefined => recordIn(c).findings.find(one => one.id === HELD.id)
const filingOf = (fake: FakeRelay, rec: LifecycleRecord) => fake.objects.get(PR_OBJECT)?.filings[`${rec.lifecycleId ?? ''}:${HELD.id}:1`]

test('no new dispatch after a takeover; an acknowledged action may finish, its commit is refused, its filing goes through the ledger', { timeoutMs: 15_000 }, async ($, on) => {
  const two = twoWorlds(on)
  const { w, fake, seen, after, a, b } = two
  await $.session.start({ cwd: ROOT_A, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call(createPr)
  expect(w.spawned).toHaveLength(1)
  // B, Adam at his other checkout, takes the lease the moment A's boundary beat before the fix prompt is acknowledged.
  let took: unknown
  let isCommitted = false
  after.fn = async one => {
    if (one.by !== a.sessionId || took !== undefined) return
    if (one.op === 'commit' && one.status === 200) isCommitted = true
    else if (isCommitted && one.op === 'beat' && one.status === 200) {
      mirror(a, b)
      took = await claimLease(b.$, ROOT_B, BRANCH, true)
    }
  }
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  after.fn = undefined
  expect(took).toMatchObject({ mine: { holder: b.sessionId, principal: ADAM, token: 2 } })
  // The acknowledged action went out: A's fix prompt, sent under the beat the relay answered before the take.
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('R1-1')
  // It finishes. A's next commit is refused (423), and A starts nothing more: no prompt, no sub-agent, no run.
  const from = seen.length
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  const late = by(seen.slice(from), a.sessionId)
  expect(late.filter(one => one.op === 'commit').map(one => one.status)).toEqual([423])
  expect(late.filter(one => ['take', 'claim'].includes(one.op))).toEqual([])
  expect(w.prompts).toHaveLength(1)
  expect(w.spawned).toHaveLength(1)
  expect(w.run).toBeNull()
  expect(fake.objects.get(OBJECT)?.lease).toMatchObject({ holder: b.sessionId, token: 2 })
  // The new holder dispatches: B's mod resumes the lifecycle from the relay's record and spawns its review.
  await handOver($, two)
  const resumed = seen.length
  expect((await say($, 'start')).text).toContain('Lifecycle resumed for feat/x')
  expect(w.spawned).toHaveLength(2)
  expect(w.run?.root).toBe(ROOT_B)
  expect(by(seen.slice(resumed), b.sessionId).filter(one => one.op === 'commit' || one.op === 'beat').every(one => one.status === 200)).toBe(true)

  // The filing: A holds PR 7's lease and files the finding; B takes the lease while A's POST is in flight (its boundary acknowledged).
  const rec = await postPr(two)
  let isTaken = false
  w.gh.onIssue = async () => {
    if (isTaken) return
    isTaken = true
    mirror(a, b, PR_BRANCH)
    expect(await claimLease(b.$, ROOT_B, PR_BRANCH, true)).toMatchObject({ mine: { holder: b.sessionId } })
  }
  const filing = seen.length
  expect(await fileIssues(a.$, recordIn(a), MERGED)).toBeUndefined()
  w.gh.onIssue = undefined
  // A's POST and its fileDone landed (the ledger is fenced by the filing secret, not the lease); its record's save was refused (423).
  expect(w.gh.filed).toHaveLength(1)
  expect(filingOf(fake, rec)).toMatchObject({ state: 'done', result: { number: 21 } })
  const mine = by(seen.slice(filing), a.sessionId)
  expect(mine.filter(one => one.op === 'fileDone').map(one => one.status)).toEqual([200])
  expect(mine.filter(one => one.op === 'commit').at(-1)?.status).toBe(423)
  // B's own pass finds A's issue by its mark and the ledger's done filing: no second POST, and B's record names #21.
  await fileIssues(b.$, recordIn(b), MERGED)
  expect(w.gh.filed).toHaveLength(1)
  expect(findingIn(b)?.followUp).toBe('#21')
  expect(filingOf(fake, rec)).toMatchObject({ state: 'done', result: { number: 21 } })
})

test('the other stands down', { timeoutMs: 15_000 }, async ($, on) => {
  const two = twoWorlds(on)
  const { w, fake, seen, a, b } = two
  await $.session.start({ cwd: ROOT_A, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call(createPr)
  expect(w.spawned).toHaveLength(1)
  // B, a headless session in its own checkout, only claims: A's live lease holds it off, B's change is refused, and B stands down.
  mirror(a, b)
  const lease = fake.objects.get(OBJECT)?.lease
  expect(await claimLease(b.$, ROOT_B, BRANCH, false)).toMatchObject({ held: { holder: a.sessionId } })
  const error = await updateRecord(b.$, ROOT_B, BRANCH, grant('b')).then(() => undefined, (e: unknown) => e)
  expect((error as StaleRecord).isHeld).toBe(true)
  expect(await isStoodDownBy(b.$, { root: ROOT_B, branch: BRANCH }, error)).toBe(true)
  expect(fake.objects.get(OBJECT)?.lease).toEqual(lease)
  expect(reasons(fake.objects.get(OBJECT)?.record)).toEqual([])
  expect(linesOf(fake).filter(one => one.text.includes('stood down')).map(one => one.holder)).toEqual([b.sessionId])
  // A drives on: its review's result is taken, and its fix prompt goes out.
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  expect(w.prompts).toHaveLength(1)
  expect(w.run?.status).toBe('running')
  // Then Adam, at B's checkout, takes the lease. A's ticker's next beat is lost (409): A stands down, through `log`, and starts nothing.
  expect(await claimLease(b.$, ROOT_B, BRANCH, true)).toMatchObject({ mine: { holder: b.sessionId } })
  const from = seen.length
  await w.clock.advance(61_000)
  const lost = by(seen.slice(from), a.sessionId)
  expect(opsOf(lost.filter(one => ['beat', 'commit', 'log'].includes(one.op)))).toEqual(['beat@=409', 'log@=200'])
  expect(w.run).toBeNull()
  expect(w.prompts).toHaveLength(1)
  expect(w.spawned).toHaveLength(1)
  expect(linesOf(fake).filter(one => one.text.includes('stood down')).map(one => one.holder)).toEqual([b.sessionId, a.sessionId])
  // B now drives alone: its mod resumes the lifecycle and dispatches, and every beat and commit it sends is taken.
  await handOver($, two)
  const resumed = seen.length
  await say($, 'start')
  expect(w.spawned).toHaveLength(2)
  await w.clock.advance(61_000)
  const driving = seen.slice(resumed)
  expect(driving.every(one => one.by === b.sessionId)).toBe(true)
  expect(driving.filter(one => one.op === 'commit' || one.op === 'beat').every(one => one.status === 200)).toBe(true)
  expect(fake.objects.get(OBJECT)?.lease?.holder).toBe(b.sessionId)
})

test('a takeover after a lapse fences out the old holder\'s commit', { timeoutMs: 15_000 }, async (_$, on) => {
  // Both checkouts through the mod's store code (the mod's own ticker would never let A's lease lapse while the clock runs).
  const { w, fake, a, b } = twoWorlds(on)
  await saveRecord(a.$, seed(ROOT_A))
  expect(await claimLease(a.$, ROOT_A, BRANCH, false)).toMatchObject({ mine: { token: 1 } })
  // A goes quiet (a sleeping laptop): its lease lapses, and B, in its own checkout, takes the lifecycle over with a higher token.
  await w.clock.advance(121_000)
  mirror(a, b)
  expect(await claimLease(b.$, ROOT_B, BRANCH, false)).toMatchObject({ mine: { holder: b.sessionId, token: 2 } })
  // A wakes and writes what it had: refused (423) with B's lease named, and the relay's record and rev stay as they were.
  const rev = fake.objects.get(OBJECT)?.rev
  const error = await updateRecord(a.$, ROOT_A, BRANCH, grant('stale')).then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(StaleRecord)
  expect((error as StaleRecord).isHeld).toBe(true)
  expect((error as StaleRecord).lease).toMatchObject({ holder: b.sessionId, principal: ADAM, token: 2 })
  expect(fake.objects.get(OBJECT)?.rev).toBe(rev)
  // A's own claim now meets B's lease; B's change lands, and only B's.
  expect(await claimLease(a.$, ROOT_A, BRANCH, false)).toMatchObject({ held: { holder: b.sessionId } })
  await updateRecord(b.$, ROOT_B, BRANCH, grant('driver'))
  expect(reasons(fake.objects.get(OBJECT)?.record)).toEqual(['driver'])
  expect(fake.objects.get(OBJECT)?.rev).toBe((rev ?? 0) + 1)
})

test('neither files a finding twice', { timeoutMs: 15_000 }, async (_$, on) => {
  const two = twoWorlds(on)
  const { w, fake, seen, a, b } = two
  const rec = await postPr(two)
  // Both checkouts run a filing pass at once: B's starts while A's POST is in flight. B holds no lease, so it files nothing.
  let isRacing = false
  w.gh.onIssue = async () => {
    if (isRacing) return
    isRacing = true
    mirror(a, b, PR_BRANCH)
    expect(await fileIssues(b.$, recordIn(b), MERGED)).toBeUndefined()
  }
  await fileIssues(a.$, recordIn(a), MERGED)
  w.gh.onIssue = undefined
  expect(isRacing).toBe(true)
  expect(w.gh.filed).toHaveLength(1)
  expect(findingIn(a)?.followUp).toBe('#21')
  expect(filingOf(fake, rec)).toMatchObject({ state: 'done', result: { number: 21 } })
  // A's run ends and releases the lease; B claims it and runs its pass again, and A runs another without the lease. Neither POSTs.
  await releaseLease(a.$, ROOT_A, PR_BRANCH)
  expect(await claimLease(b.$, ROOT_B, PR_BRANCH, false)).toMatchObject({ mine: { holder: b.sessionId } })
  const from = seen.length
  await fileIssues(b.$, recordIn(b), MERGED)
  await fileIssues(a.$, recordIn(a), MERGED)
  expect(w.gh.filed).toHaveLength(1)
  expect(findingIn(b)?.followUp).toBe('#21')
  expect(seen.slice(from).filter(one => one.op === 'fileDone')).toEqual([])
  expect(filingOf(fake, rec)).toMatchObject({ state: 'done', result: { number: 21 } })
  expect(Object.keys(fake.objects.get(PR_OBJECT)?.filings ?? {})).toHaveLength(1)
})

test('a stale startGate commit (409) is not retried and the next tick recovers', { timeoutMs: 15_000 }, async ($, on) => {
  const two = twoWorlds(on)
  const { w, fake, seen, after, a, b } = two
  // B started the lifecycle earlier and left it; A's checkout holds a mirror of it at the relay's rev 1.
  await saveRecord(b.$, seed(ROOT_B))
  mirror(b, a)
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  await $.session.start({ cwd: ROOT_A, surface: 'terminal', isInteractive: true } as never)
  // Between A's start taking the lease and reading the record, and its commit, B takes the lease, commits a change and releases it again.
  let isWritten = false
  let hasTaken = false
  after.fn = async one => {
    if (one.by !== a.sessionId || isWritten) return
    if (one.op === 'take' || one.op === 'claim') hasTaken = true
    if (one.op !== 'read' || !hasTaken) return
    isWritten = true
    expect(await claimLease(b.$, ROOT_B, BRANCH, true)).toMatchObject({ mine: { holder: b.sessionId } })
    await updateRecord(b.$, ROOT_B, BRANCH, grant('b'))
    await releaseLease(b.$, ROOT_B, BRANCH)
  }
  const from = seen.length
  const reply = (await say($, 'start')).text
  after.fn = undefined
  expect(isWritten).toBe(true)
  // A's commit met rev 2 (409). It is not sent again: nothing is saved, nothing is dispatched, and the person is told to start again.
  expect(by(seen.slice(from), a.sessionId).filter(one => one.op === 'commit').map(one => one.status)).toEqual([409])
  expect(reply).toContain('Not started: another writer changed the shared lifecycle record meanwhile')
  expect(w.spawned).toEqual([])
  expect(fake.objects.get(OBJECT)?.rev).toBe(2)
  expect(reasons(fake.objects.get(OBJECT)?.record)).toEqual(['b'])
  // The next start works from the relay's record, B's change in it: A's commit lands at rev 3 and its review is dispatched.
  const next = seen.length
  expect((await say($, 'start')).text).toContain('Lifecycle resumed for feat/x')
  expect(by(seen.slice(next), a.sessionId).filter(one => one.op === 'commit').map(one => one.status)).toEqual([200])
  expect(fake.objects.get(OBJECT)?.rev).toBe(3)
  expect(reasons(fake.objects.get(OBJECT)?.record)).toEqual(['b'])
  expect(w.spawned).toHaveLength(1)
  expect(fake.objects.get(OBJECT)?.lease?.holder).toBe(a.sessionId)
})
