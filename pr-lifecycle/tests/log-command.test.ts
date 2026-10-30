import { expect, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { logSummary, newRecord } from '../hooks/lifecycle'
import { forgetLeases, forgetOptIns, liveRecords, logEvent, recordKey, saveRecord, updateRecord } from '../hooks/store'
import type { Finding, LifecycleRecord } from '../types'
import { PRINCIPALS } from './contract'
import { fakeRelay, HEADERS_OF } from './relay-fake'
import type { FakeRelay } from './relay-fake'
import { world } from './world'
import type { World } from './world'

// #29 Part B, Task 10 (spec §5, §7.2, §9): `/pr-gate log` reads the relay's run log, across a move, and lists stuck filings; a fresh
// checkout of an opted-in repo discovers the relay's records. The engine stand-in is shared-move.test.ts's, over the world's store.

const URL_ = 'https://relay.example.org'
const SHARED = JSON.stringify({ sharedStore: { url: URL_, aud: 'aud-tag' } })
const SLUG = 'me/repo'
const OBJECT = `${SLUG}@feat/x`
const PR = 7
const PR_OBJECT = `${SLUG}#${PR}`
const PR_PATH = `/v1/${SLUG}/${PR}`
const KEY = recordKey('/repo', 'feat/x')
const { ADAM, CODEX } = PRINCIPALS
const STEP_MS = 30 * 60_000

type Dispatch = Parameters<TestBody>[0]
type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

const asPerson = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const say = async ($: Dispatch, args: string): Promise<string> => String(((await $.command.run({ command: 'pr-gate', args, ...asPerson } as never)) as { text?: string }).text ?? '')

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

type Setup = { w: World; fake: FakeRelay; $: never; env: Record<string, string> }

/** A repo that opts in on its base, Adam's token in the environment of the mod and of the stand-in, and his grant on me/repo. */
function setup(on: Parameters<typeof world>[0], isShared = true): Setup {
  forgetOptIns()
  forgetLeases()
  const w = world(on)
  if (isShared) w.git.roster = SHARED
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate', [CODEX]: 'operate' } } })
  const env: Record<string, string> = { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  return { w, fake, $: engineOf(w, fake.fetch, w.store, w.sessionId), env }
}

const seed = (extra: Partial<LifecycleRecord> = {}): LifecycleRecord => ({
  ...newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 }),
  ...extra,
})

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
  followUp: 'queued',
}

const opened = (rec: LifecycleRecord): LifecycleRecord => ({ ...rec, phase: 'post', pr: PR })
const CLAIMER = 'c'.repeat(40)

/** Codex's checkout claims a filing on the PR object, as another checkout's filing pass does. */
async function codexClaims(fake: FakeRelay, key: string): Promise<void> {
  const res = await fake.fetch(`${URL_}${PR_PATH}`, { method: 'POST', headers: { ...HEADERS_OF.CODEX, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'fileClaim', key, secret: CLAIMER }) })
  expect(res.status).toBe(200)
}

test('a repo not on the relay prints as before', async ($, on) => {
  const { w } = setup(on, false)
  const rec = seed({ log: [{ at: 1_000, kind: 'person', text: '/pr-gate resume → ok' }] })
  w.store.set(KEY, rec)
  expect(await say($, 'log')).toBe(`/pr-gate log: ${logSummary(rec, false)}`)
})

test('a record on the relay prints the relay\'s lines with their principal and short session id', async ($, on) => {
  const { w, $: engine } = setup(on)
  await saveRecord(engine, seed())
  await logEvent(engine, '/repo', 'feat/x', 'session', 'a line from the relay')
  const out = await say($, 'log')
  expect(out).toContain('feat/x → dev: ')
  expect(out).toMatch(new RegExp(`session +\\[${ADAM} ${w.sessionId.slice(0, 8)}\\] a line from the relay`))
  expect(out).not.toContain('earlier lines dropped')
  expect(out).not.toContain('stuck filings')
})

test('a log the relay cut says how many earlier lines are gone', async ($, on) => {
  const { fake, $: engine } = setup(on)
  await saveRecord(engine, seed())
  await logEvent(engine, '/repo', 'feat/x', 'session', 'kept')
  const object = fake.objects.get(OBJECT)!
  fake.objects.set(OBJECT, { ...object, log: { ...object.log, dropped: 3 } })
  expect(await say($, 'log')).toContain('3 earlier lines dropped')
})

test('a lifecycle that moved shows a branch section, then a PR section', async ($, on) => {
  const { $: engine } = setup(on)
  await saveRecord(engine, seed())
  await logEvent(engine, '/repo', 'feat/x', 'session', 'before the move')
  await updateRecord(engine, '/repo', 'feat/x', opened, { isPure: true })
  await logEvent(engine, '/repo', 'feat/x', 'session', 'after the move')
  const out = await say($, 'log')
  const branch = out.indexOf('branch feat/x')
  const pr = out.indexOf(`PR #${PR}`, branch)
  expect(branch).toBeGreaterThan(-1)
  expect(pr).toBeGreaterThan(branch)
  expect(out.indexOf('before the move')).toBeGreaterThan(branch)
  expect(out.indexOf('before the move')).toBeLessThan(pr)
  expect(out.indexOf('after the move')).toBeGreaterThan(pr)
})

test('stuck filings are listed with their key and claimant; a young claim and a finished one are not', async ($, on) => {
  const { w, fake, $: engine } = setup(on)
  const other: Finding = { ...HELD, id: 'R1-2' }
  const young: Finding = { ...HELD, id: 'R1-3' }
  await saveRecord(engine, seed({ phase: 'post', pr: PR, slug: SLUG, findings: [HELD, other, young] }))
  const id = (w.store.get(KEY) as LifecycleRecord).lifecycleId ?? ''
  await codexClaims(fake, `${id}:R1-1:1`)
  await codexClaims(fake, `${id}:R1-2:1`)
  const done = await fake.fetch(`${URL_}${PR_PATH}`, {
    method: 'POST',
    headers: { ...HEADERS_OF.CODEX, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'fileDone', key: `${id}:R1-2:1`, result: { number: 5, url: `https://github.com/${SLUG}/issues/5` }, secret: CLAIMER }),
  })
  expect(done.status).toBe(200)
  await w.clock.advance(STEP_MS + 60_000)
  await codexClaims(fake, `${id}:R1-3:1`)
  const out = await say($, 'log')
  expect(out).toContain('stuck filings')
  expect(out).toContain(`${id}:R1-1:1 claimed by ${CODEX}`)
  expect(out).not.toContain(`${id}:R1-2:1`)
  expect(out).not.toContain(`${id}:R1-3:1`)
  expect(out).toContain("the driver adopts it once its issue is found; otherwise an admin's fileDelete frees it")
  expect(fake.objects.get(PR_OBJECT)?.filings[`${id}:R1-1:1`]?.state).toBe('claimed')
})

test('a relay that is down prints the local log and says it was unreachable', async ($, on) => {
  const { fake, $: engine } = setup(on)
  await saveRecord(engine, seed())
  fake.down = true
  const out = await say($, 'log')
  expect(out).toContain('feat/x → dev: ')
  expect(out).toContain('The relay was unreachable (')
  expect(out).not.toContain('stuck filings')
})

test('a relay that refuses the checkout says so', async ($, on) => {
  const { env, $: engine } = setup(on)
  await saveRecord(engine, seed())
  env.PR_GATE_RELAY_TOKEN = 'a-token-access-does-not-know'
  const out = await say($, 'log')
  expect(out).toContain('The relay refused this checkout')
})

test('a fresh checkout of an opted-in repo discovers the relay\'s live record (spec §9)', async (_t, on) => {
  const { w, fake, $: engine } = setup(on)
  await saveRecord(engine, seed({ phase: 'post', pr: PR, slug: SLUG }))
  const theirs = (w.store.get(KEY) as LifecycleRecord)
  // A second checkout of the repo: its own store, with no record of the lifecycle at all.
  const fresh = engineOf(w, fake.fetch, new Map<string, unknown>(), 'session-2')
  const live = await liveRecords(fresh, '/repo')
  expect(live.map(one => one.lifecycleId)).toEqual([theirs.lifecycleId])
  expect(live[0]?.pr).toBe(PR)
  expect(live[0]?.root).toBe('/repo')
})

test('a fresh checkout whose relay is down discovers only its local records', async (_t, on) => {
  const { w, fake, $: engine } = setup(on)
  await saveRecord(engine, seed({ phase: 'post', pr: PR, slug: SLUG }))
  fake.down = true
  expect(await liveRecords(engineOf(w, fake.fetch, new Map<string, unknown>(), 'session-2'), '/repo')).toEqual([])
})

test('a repo that does not opt in lists no relay', async (_t, on) => {
  const { w, fake } = setup(on, false)
  expect(await liveRecords(engineOf(w, fake.fetch, new Map<string, unknown>(), 'session-2'), '/repo')).toEqual([])
  expect(fake.calls).toEqual([])
})

test('a fresh checkout looks in the configured bases, in their order', async (_t, on) => {
  const { w, fake, $: engine } = setup(on)
  w.git.rosterOn = 'develop'
  await saveRecord(engine, seed({ phase: 'post', pr: PR, slug: SLUG, base: 'develop' }))
  const fresh = engineOf(w, fake.fetch, new Map<string, unknown>(), 'session-2')
  expect(await liveRecords(fresh, '/repo')).toEqual([])
  forgetOptIns()
  expect((await liveRecords(fresh, '/repo', ['develop', 'main'])).map(one => one.pr)).toEqual([PR])
})

test('a claim made before any issue was named shows as stuck once old', async ($, on) => {
  const { w, fake, $: engine } = setup(on)
  const bare: Finding = { ...HELD, id: 'R1-4', followUp: undefined }
  await saveRecord(engine, seed({ phase: 'post', pr: PR, slug: SLUG, findings: [bare] }))
  const id = (w.store.get(KEY) as LifecycleRecord).lifecycleId ?? ''
  await codexClaims(fake, `${id}:R1-4:1`)
  await w.clock.advance(STEP_MS + 60_000)
  const out = await say($, 'log')
  expect(out).toContain('stuck filings (known findings only)')
  expect(out).toContain(`${id}:R1-4:1 claimed by ${CODEX}`)
})

test('the stuck probe is read-only and stops at a relay that stops answering', async ($, on) => {
  const { w, fake, $: engine } = setup(on)
  await saveRecord(engine, seed({ phase: 'post', pr: PR, slug: SLUG, findings: [HELD, { ...HELD, id: 'R1-2' }] }))
  const real = fake.fetch
  let probes = 0
  fake.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as { op?: string }
    if (body.op === 'filing') {
      probes += 1
      throw new Error('connection reset')
    }
    return real(url, init)
  }
  const out = await say($, 'log')
  expect(probes).toBe(1)
  expect(out).toContain('The relay was unreachable (')
  expect(out).toContain('stuck filings could not all be checked')
  expect(w.store.get(`${KEY}:relay-pending`)).toBeUndefined()
})
