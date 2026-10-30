import { expect, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { readRoster } from '../hooks/github'
import { filingSecret, keyPath, leaseSecret, RELAY_TIMEOUT_MS, relayCall, relayOf } from '../hooks/relay'
import type { Relay, RelayAnswer } from '../hooks/relay'
import { CONTRACT, isMatch, PRINCIPALS, TIMES } from './contract'
import { fakeRelay, HEADERS_OF } from './relay-fake'
import { world } from './world'
import type { World } from './world'

const URL_ = 'https://relay.example.org'
const SHARED = { sharedStore: { url: URL_, aud: 'aud-tag' } }
const roster = (extra: object = {}): string => JSON.stringify({ reviewers: ['alice'], ...extra })
const relayAs = (as: keyof typeof HEADERS_OF): Relay => ({ url: URL_, aud: 'aud-tag', headers: HEADERS_OF[as] })

type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

/**
 * The mod's own engine, as the relay helpers see it. The test's `$` has no `http`, `env` or `clock` until a flow of the mod calls them,
 * so the helpers run on this stand-in: `process` is world's fake git, `clock` the test's mocked one, and the store honours `w.failSet`.
 */
function engineOf(w: World, fetch: Fetch, env: Record<string, string> = {}): never {
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
    env: { get: async (name: string) => env[name] },
    session: { id: async () => w.sessionId },
    store: {
      get: async (key: string) => w.store.get(key),
      set: async (key: string, value: unknown) => {
        if (w.failSet?.(key, value, w.store.get(key)) === true) throw new Error('store write failed')
        w.store.set(key, value)
      },
      delete: async (key: string) => void w.store.delete(key),
      keys: async () => [...w.store.keys()],
    },
  } as never
}

const answer = (status: number, text: string): Promise<HttpResponse> => Promise.resolve({ status, ok: status >= 200 && status < 300, headers: {}, text })

/** What the client makes of a step's answer: 401 and 403 refused, a 5xx or a text body down, anything else the answer itself. */
const clientOf = (status: number, isText: boolean): 'refused' | 'down' | 'answer' =>
  status === 401 || status === 403 ? 'refused' : status >= 500 || isText ? 'down' : 'answer'

test('the fake relay passes the contract', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, leaseMs: TIMES.leaseMs, filingStaleMs: TIMES.filingStaleMs })
  // The raw answer of each call, beside what the client made of it.
  let raw: HttpResponse | undefined
  const $ = engineOf(w, async (url, init) => (raw = await fake.fetch(url, init)))
  const failures: string[] = []
  for (const one of CONTRACT) {
    for (const given of one.grants ?? []) fake.grant(PRINCIPALS[given.as], given.repo, given.preset)
    for (const [n, step] of one.steps.entries()) {
      if (step.waitMs !== undefined) await w.clock.advance(step.waitMs)
      // The client never sends a body that isn't JSON: such a step goes to the fake as it is.
      const init = { method: 'POST', headers: { ...HEADERS_OF[step.as], 'content-type': 'application/json' }, body: step.raw ?? '' }
      const got: RelayAnswer | undefined = step.raw === undefined ? await relayCall($, relayAs(step.as), step.path, step.body) : undefined
      if (step.raw !== undefined) raw = await fake.fetch(`${URL_}${step.path}`, init)
      let json: unknown
      try {
        json = JSON.parse(raw?.text ?? '')
      } catch {
        json = undefined
      }
      const isText = json === undefined
      const where = `${one.name}, step ${n} (${step.as} ${String(step.body.op ?? step.raw)} ${step.path})`
      if (raw?.status !== step.status || isText !== (step.isText === true) || (!isText && !isMatch(json, step.match ?? {}))) {
        failures.push(`${where}: expected ${step.status}${step.isText === true ? ' text' : ''} ${JSON.stringify(step.match ?? {})}, got ${raw?.status} ${raw?.text}`)
      }
      if (got === undefined) continue
      const kind = clientOf(step.status, step.isText === true)
      const isRead = kind === 'answer' ? 'status' in got && got.status === step.status : kind in got
      if (!isRead) failures.push(`${where}: the client should read ${kind}, got ${JSON.stringify(got)}`)
    }
  }
  expect(failures).toEqual([])
})

test('no sharedStore or no credential stays local and says why', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const token = { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ }
  // No file on the base at all.
  expect(await relayOf(engineOf(w, fake.fetch, token), '/repo', 'dev')).toEqual({ local: 'no sharedStore in .github/pr-gate.json' })
  // A file without one, one that isn't https, and one with no aud.
  for (const sharedStore of [undefined, { url: 'http://relay.example.org', aud: 'aud-tag' }, { url: URL_ }, { url: 'not a url', aud: 'aud-tag' }, 'https://relay.example.org']) {
    w.git.roster = roster(sharedStore === undefined ? {} : { sharedStore })
    expect(await relayOf(engineOf(w, fake.fetch, token), '/repo', 'dev')).toEqual({ local: 'no sharedStore in .github/pr-gate.json' })
  }
  expect(readRoster(roster({ sharedStore: { url: 'http://relay.example.org', aud: 'aud-tag' } }))).toEqual({ reviewers: ['alice'], checks: [], requestReview: [], trusted: [] })
  expect(readRoster(roster(SHARED))?.sharedStore).toEqual(SHARED.sharedStore)
  // A query or a fragment would swallow the path the client appends; a trailing `/` is cut.
  for (const url of [`${URL_}/?x=1`, `${URL_}?`, `${URL_}#top`, `${URL_}/relay#`]) expect(readRoster(roster({ sharedStore: { url, aud: 'aud-tag' } }))?.sharedStore).toBeUndefined()
  expect(readRoster(roster({ sharedStore: { url: `${URL_}/relay//`, aud: 'aud-tag' } }))?.sharedStore).toEqual({ url: `${URL_}/relay`, aud: 'aud-tag' })
  w.git.roster = roster(SHARED)
  expect(await relayOf(engineOf(w, fake.fetch), '/repo', 'dev')).toEqual({ local: 'no relay credential' })
  // Half a service token is no credential.
  expect(await relayOf(engineOf(w, fake.fetch, { PR_GATE_RELAY_CLIENT_ID: 'codex-service.access' }), '/repo', 'dev')).toEqual({ local: 'no relay credential' })
  expect(await relayOf(engineOf(w, fake.fetch, { PR_GATE_RELAY_CLIENT_SECRET: 'codex-secret' }), '/repo', 'dev')).toEqual({ local: 'no relay credential' })
  expect(await relayOf(engineOf(w, fake.fetch, token), '/repo', 'dev')).toEqual({ url: URL_, aud: 'aud-tag', headers: { 'cf-access-token': 'adam-token' } })
  // An empty base names no file at all.
  expect(await relayOf(engineOf(w, fake.fetch, token), '/repo', '')).toEqual({ local: 'no sharedStore in .github/pr-gate.json' })
  expect(fake.calls).toEqual([])
})

test('sharedStore is read from the base, never the HEAD', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const $ = engineOf(w, fake.fetch, { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ })
  w.git.roster = roster()
  w.git.headRoster = roster(SHARED)
  expect(await relayOf($, '/repo', 'dev')).toEqual({ local: 'no sharedStore in .github/pr-gate.json' })
  // The base's own is read from its remote-tracking ref, for that base only.
  w.git.byBase = { main: roster({ sharedStore: { url: `${URL_}/`, aud: 'main-aud' } }) }
  w.git.roster = ''
  expect(await relayOf($, '/repo', 'main')).toEqual({ url: URL_, aud: 'main-aud', headers: { 'cf-access-token': 'adam-token' } })
})

test('the credential goes only to the relay this machine pinned: a pin unset, unreadable or of another origin stays local', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const token = { PR_GATE_RELAY_TOKEN: 'adam-token' }
  w.git.roster = roster(SHARED)
  expect(await relayOf(engineOf(w, fake.fetch, token), '/repo', 'dev')).toEqual({ local: 'relay not pinned: PR_GATE_RELAY_URL is not set' })
  expect(await relayOf(engineOf(w, fake.fetch, { ...token, PR_GATE_RELAY_URL: '' }), '/repo', 'dev')).toEqual({ local: 'relay not pinned: PR_GATE_RELAY_URL is not set' })
  expect(await relayOf(engineOf(w, fake.fetch, { ...token, PR_GATE_RELAY_URL: 'relay.example.org' }), '/repo', 'dev')).toEqual({ local: 'relay not pinned: PR_GATE_RELAY_URL is not a URL' })
  // Another host, a subdomain, another port or another scheme is another origin: the base's file never chooses where a credential goes.
  for (const url of ['https://evil.example.org', 'https://relay.example.org.evil.example', 'https://x.relay.example.org', 'https://relay.example.org:8443']) {
    w.git.roster = roster({ sharedStore: { url, aud: 'aud-tag' } })
    const local = await relayOf(engineOf(w, fake.fetch, { ...token, PR_GATE_RELAY_URL: URL_ }), '/repo', 'dev')
    expect(local).toEqual({ local: `relay not pinned: the base names ${new URL(url).origin}, PR_GATE_RELAY_URL ${URL_}` })
    expect(JSON.stringify(local)).not.toContain('adam-token')
  }
  w.git.roster = roster(SHARED)
  expect(await relayOf(engineOf(w, fake.fetch, { ...token, PR_GATE_RELAY_URL: 'http://relay.example.org' }), '/repo', 'dev')).toEqual({
    local: `relay not pinned: the base names ${URL_}, PR_GATE_RELAY_URL http://relay.example.org`,
  })
  // The pin is an origin: a path on either side, or a trailing `/`, still matches.
  w.git.roster = roster({ sharedStore: { url: `${URL_}/relay`, aud: 'aud-tag' } })
  expect(await relayOf(engineOf(w, fake.fetch, { ...token, PR_GATE_RELAY_URL: `${URL_}/` }), '/repo', 'dev')).toEqual({ url: `${URL_}/relay`, aud: 'aud-tag', headers: { 'cf-access-token': 'adam-token' } })
  expect(fake.calls).toEqual([])
})

test('a service token is sent as CF-Access-Client-Id and -Secret, a person token as cf-access-token', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const sent: { url: string; init?: HttpInit }[] = []
  const fetch: Fetch = (url, init) => {
    sent.push({ url, init })
    return fake.fetch(url, init)
  }
  w.git.roster = roster(SHARED)
  const service = { PR_GATE_RELAY_CLIENT_ID: 'codex-service.access', PR_GATE_RELAY_CLIENT_SECRET: 'codex-secret', PR_GATE_RELAY_URL: URL_ }
  // A service token wins over a person's when both are set: a service runs where no person signs in.
  for (const env of [service, { ...service, PR_GATE_RELAY_TOKEN: 'adam-token' }]) {
    const $ = engineOf(w, fetch, env)
    const relay = await relayOf($, '/repo', 'dev')
    expect(relay).toEqual({ url: URL_, aud: 'aud-tag', headers: { 'CF-Access-Client-Id': 'codex-service.access', 'CF-Access-Client-Secret': 'codex-secret' } })
    expect(await relayCall($, relay as Relay, keyPath('owner/repo', '#7'), { op: 'claim', holder: 'h', secret: 's'.repeat(40) })).toMatchObject({
      status: 200,
      json: { lease: { principal: PRINCIPALS.CODEX } },
    })
    await relayCall($, relay as Relay, keyPath('owner/repo', '#7'), { op: 'release', secret: 's'.repeat(40) })
  }
  const $ = engineOf(w, fetch, { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ })
  const relay = (await relayOf($, '/repo', 'dev')) as Relay
  expect(relay.headers).toEqual({ 'cf-access-token': 'adam-token' })
  expect(await relayCall($, relay, keyPath('owner/repo', '#7'), { op: 'claim', holder: 'h', secret: 't'.repeat(40) })).toMatchObject({
    status: 200,
    json: { lease: { principal: PRINCIPALS.ADAM } },
  })
  expect(sent.at(-1)).toEqual({
    url: `${URL_}/v1/owner/repo/7`,
    init: {
      method: 'POST',
      headers: { 'cf-access-token': 'adam-token', 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'claim', holder: 'h', secret: 't'.repeat(40) }),
      redirect: 'manual',
    },
  })
  expect(fake.principalOf({ 'cf-access-client-id': 'Codex-Service.Access', 'cf-access-client-secret': 'codex-secret' })).toEqual({ id: 'codex-service.access', isService: true })
  expect(fake.principalOf({ 'CF-Access-Client-Id': 'codex-service.access', 'CF-Access-Client-Secret': 'wrong' })).toBeUndefined()
})

test('a 5 s timeout is down', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const $ = engineOf(w, fake.fetch)
  expect(RELAY_TIMEOUT_MS).toBe(5_000)
  fake.delayNext(6_000)
  let got: RelayAnswer | undefined
  const pending = relayCall($, relayAs('ADAM'), keyPath('owner/repo', '#7'), { op: 'read' }).then(one => (got = one))
  await w.clock.advance(4_999)
  expect(got).toBeUndefined()
  await w.clock.advance(1)
  expect(await pending).toEqual({ down: 'timeout' })
  // The late answer lands on nothing; the next call is answered at once.
  await w.clock.advance(1_000)
  expect(got).toEqual({ down: 'timeout' })
  expect(await relayCall($, relayAs('ADAM'), keyPath('owner/repo', '#7'), { op: 'read' })).toMatchObject({ status: 200, json: { rev: 0 } })
})

test('401 and 403 are refused, not down', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const path = keyPath('owner/repo', '#7')
  const $ = engineOf(w, fake.fetch)
  // Spec §8 and §10: a revoked or read-only principal is cut off, never let fall back to the local store and keep acting.
  const stranger: Relay = { url: URL_, aud: 'aud-tag', headers: { 'cf-access-token': 'stranger' } }
  expect(await relayCall($, stranger, path, { op: 'read' })).toEqual({ refused: 'HTTP 401' })
  expect(await relayCall($, relayAs('READER'), path, { op: 'commit', rev: 0, record: {} })).toEqual({ refused: 'HTTP 403' })
  expect(await relayCall($, relayAs('CODEX'), path, { op: 'breakLease' })).toEqual({ refused: 'HTTP 403' })
  // Whatever the body says: Access's own 403 page is HTML, the relay's is JSON.
  for (const [status, text] of [[401, '<html>Sign in</html>'], [403, '{"error":"no"}'], [403, '']] as const) {
    expect(await relayCall(engineOf(w, () => answer(status, text)), relayAs('ADAM'), path, { op: 'read' })).toEqual({ refused: `HTTP ${status}` })
  }
})

test('a redirect or an HTML page (Access\'s login) is refused, never down; a 5xx HTML page is still down', async (_$, on) => {
  const w = world(on)
  const path = keyPath('owner/repo', '#7')
  const page = (status: number, headers: Record<string, string>, text: string) => () =>
    Promise.resolve({ status, ok: status >= 200 && status < 300, headers, text })
  const login = 'https://team.cloudflareaccess.com/cdn-cgi/access/login'
  for (const [status, headers, text] of [
    [302, { location: login }, ''],
    [307, { location: login, 'content-type': 'text/html' }, '<html>Moved</html>'],
    [200, { 'content-type': 'text/html; charset=UTF-8' }, '<html>Sign in with Cloudflare Access</html>'],
  ] as const) {
    const got = await relayCall(engineOf(w, page(status, headers, text)), relayAs('ADAM'), path, { op: 'read' })
    expect('refused' in got && got.refused.startsWith(`HTTP ${status}: `)).toBe(true)
  }
  expect(await relayCall(engineOf(w, page(502, { 'content-type': 'text/html' }, '<html>Bad gateway</html>')), relayAs('ADAM'), path, { op: 'read' })).toEqual({ down: 'HTTP 502' })
  // An HTML page with another 4xx (an edge 404: a mistyped url, a Worker not on the route) is down, not a credential problem (N2).
  expect(await relayCall(engineOf(w, page(404, { 'content-type': 'text/html' }, '<html>Not found</html>')), relayAs('ADAM'), path, { op: 'read' })).toEqual({ down: 'not JSON' })
  // 401 and 403 stay refused, HTML or not.
  for (const status of [401, 403]) {
    expect(await relayCall(engineOf(w, page(status, { 'content-type': 'text/html' }, '<html>Forbidden</html>')), relayAs('ADAM'), path, { op: 'read' })).toEqual({ refused: `HTTP ${status}` })
  }
  // The request asks the host not to follow a redirect, so the credential never leaves the pinned host.
  const inits: unknown[] = []
  await relayCall(engineOf(w, (_url: string, init?: unknown) => {
    inits.push(init)
    return answer(200, '{}')
  }), relayAs('ADAM'), path, { op: 'read' })
  expect(inits.map(one => (one as { redirect?: string }).redirect)).toEqual(['manual'])
})

test('502 and a body that isn\'t JSON are down', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const path = keyPath('owner/repo', '#7')
  const $ = engineOf(w, fake.fetch)
  for (const [status, text, down] of [
    [502, 'bad gateway', 'HTTP 502'],
    [503, '{"error":"busy"}', 'HTTP 503'],
    [200, '<html>Sign in</html>', 'not JSON'],
    [200, 'null', 'not JSON'],
    [200, '[1, 2]', 'not JSON'],
  ] as const) {
    expect(await relayCall(engineOf(w, () => answer(status, text)), relayAs('ADAM'), path, { op: 'read' })).toEqual({ down })
  }
  const refused = await relayCall(engineOf(w, () => Promise.reject(new Error('connect ECONNREFUSED'))), relayAs('ADAM'), path, { op: 'read' })
  expect(refused).toEqual({ down: 'network: connect ECONNREFUSED' })
  fake.down = true
  expect(await relayCall($, relayAs('ADAM'), path, { op: 'read' })).toMatchObject({ down: expect.stringMatching(/^network: /) })
  fake.down = false
  // A refusal of the call itself is an answer, not the relay being down.
  expect(await relayCall($, relayAs('ADAM'), path, { op: 'commit', rev: 3, record: {} })).toEqual({ status: 409, json: { error: 'stale revision', rev: 0, record: null } })
})

test('a secret is saved before the first call that sends it, and a failed save sends nothing', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const $ = engineOf(w, fake.fetch)
  const path = keyPath('owner/repo', '#7')
  /** What a caller does: no secret, no call. */
  const claim = async (): Promise<RelayAnswer | undefined> => {
    const secret = await leaseSecret($)
    return secret === undefined ? undefined : relayCall($, relayAs('ADAM'), path, { op: 'claim', holder: w.sessionId, secret })
  }
  let isFailing = true
  w.failSet = key => {
    if (!isFailing || !key.startsWith('relay-secret:')) return false
    isFailing = false
    return true
  }
  expect(await claim()).toBeUndefined()
  expect(fake.calls).toEqual([])
  expect([...w.store.keys()].filter(key => key.startsWith('relay-'))).toEqual([])
  // Once saved, the same secret every time: the lease's capability survives a lost answer and a restart.
  const secret = await leaseSecret($)
  expect(secret).toHaveLength(72)
  expect(w.store.get('relay-secret:session-1')).toBe(secret)
  expect(await claim()).toMatchObject({ status: 200 })
  expect(fake.calls).toEqual([{ path, body: { op: 'claim', holder: 'session-1', secret } }])
  expect(await leaseSecret($)).toBe(secret)
  // A filing's secret is its own, per checkout and lifecycle.
  const filing = await filingSecret($, '/repo', 'L1')
  expect(filing).toHaveLength(72)
  expect(filing).not.toBe(secret)
  expect(w.store.get('relay-filing-secret:/repo:L1')).toBe(filing)
  expect(await filingSecret($, '/repo', 'L1')).toBe(filing)
  expect(await filingSecret($, '/repo', 'L2')).not.toBe(filing)
  w.failSet = key => key.startsWith('relay-filing-secret:')
  expect(await filingSecret($, '/repo', 'L3')).toBeUndefined()
  expect(w.store.has('relay-filing-secret:/repo:L3')).toBe(false)
})

test('a branch with / or % encodes as one segment', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock })
  const $ = engineOf(w, fake.fetch)
  expect(keyPath('owner/repo', '#7')).toBe('/v1/owner/repo/7')
  expect(keyPath('owner/repo', '@feat/50%')).toBe('/v1/owner/repo/branch/feat%2F50%25')
  expect(keyPath('owner/repo', '@a#b?c')).toBe('/v1/owner/repo/branch/a%23b%3Fc')
  const record = { lifecycleId: 'L1', branch: 'feat/50%', phase: 'pre-pr' }
  expect(await relayCall($, relayAs('ADAM'), keyPath('owner/repo', '@feat/50%'), { op: 'commit', rev: 0, record })).toEqual({ status: 200, json: { rev: 1 } })
  expect([...fake.objects.keys()]).toEqual(['owner/repo@feat/50%'])
  expect(fake.index.get('owner/repo')?.get('@feat/50%')).toMatchObject({ key: '@feat/50%', branch: 'feat/50%', phase: 'pre-pr', rev: 1 })
  expect(await relayCall($, relayAs('ADAM'), '/v1/owner/repo/branch/feat/50%25', { op: 'read' })).toEqual({ down: 'not JSON' })
})

test('the fake: a beat after the lease lapsed is 409, even from its holder', async (_$, on) => {
  const w = world(on)
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, leaseMs: 1_000 })
  const $ = engineOf(w, fake.fetch)
  const path = keyPath('owner/repo', '#7')
  const secret = 's'.repeat(40)
  expect(await relayCall($, relayAs('ADAM'), path, { op: 'claim', holder: 'h', secret })).toMatchObject({ status: 200 })
  await w.clock.advance(600)
  expect(await relayCall($, relayAs('ADAM'), path, { op: 'beat', secret })).toMatchObject({ status: 200 })
  await w.clock.advance(1_100)
  expect(await relayCall($, relayAs('ADAM'), path, { op: 'beat', secret })).toMatchObject({ status: 409, json: { error: 'the lease is lost' } })
  expect(await relayCall($, relayAs('ADAM'), path, { op: 'release', secret })).toMatchObject({ status: 409 })
  // Lapsed, it is anyone's to claim: another principal, with a token that fences the old holder out.
  expect(await relayCall($, relayAs('CODEX'), path, { op: 'claim', holder: 'c', secret: 'c'.repeat(40) })).toMatchObject({ status: 200, json: { lease: { token: 2 } } })
})
