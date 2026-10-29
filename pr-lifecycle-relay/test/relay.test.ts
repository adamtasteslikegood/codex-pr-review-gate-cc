// The relay under Miniflare, locally only (#29 Part B spike step 2). The tests sign their own Access JWTs with a local key pair,
// which the outbound fetch serves as the team's published keys: the production verifier runs unchanged.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { after, before, test } from 'node:test'

import { Miniflare } from 'miniflare'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'aud-tag'
const ADAM = 'adam@example.org'
const CODEX = 'codex-service.access'
const READER = 'reader@example.org'
const LEASE_MS = 600

const enc = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
let team: CryptoKeyPair
let stranger: CryptoKeyPair
let mf: Miniflare

async function sign(claims: Record<string, unknown>, keys: CryptoKeyPair = team, kid = 'k1'): Promise<string> {
  const head = enc(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = enc(JSON.stringify(claims))
  const sig = await crypto.subtle.sign(algorithm, keys.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${enc(new Uint8Array(sig))}`
}

const now = (): number => Math.floor(Date.now() / 1000)
const claimsOf = (who: Record<string, string>, extra: Record<string, unknown> = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: now() + 600, ...who, ...extra })
const person = (email: string) => claimsOf({ email })
const service = (id: string) => claimsOf({ common_name: id })

async function call(token: string | undefined, body: Record<string, unknown>, path = '/v1/owner/repo/7', headers: Record<string, string> = {}) {
  const res = await mf.dispatchFetch(`https://relay${path}`, {
    method: 'POST',
    headers: { ...(token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token }), ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = { text }
  }
  return { status: res.status, json }
}

const source = (name: string): string => stripTypeScriptTypes(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))

before(async () => {
  team = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  stranger = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', team.publicKey)), kid: 'k1', alg: 'RS256' }
  mf = new Miniflare({
    modules: [
      { type: 'ESModule', path: 'index.ts', contents: source('index.ts') },
      { type: 'ESModule', path: 'auth.ts', contents: source('auth.ts') },
      { type: 'ESModule', path: 'lifecycle.ts', contents: source('lifecycle.ts') },
      { type: 'ESModule', path: 'types.ts', contents: source('types.ts') },
    ],
    compatibilityDate: '2026-08-01',
    durableObjects: { LIFECYCLE: 'LifecycleObject' },
    bindings: {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ADMINS: `${ADAM},${CODEX}`,
      LEASE_MS: String(LEASE_MS),
      GRANTS: JSON.stringify([
        { principal: ADAM, repo: 'owner/repo', preset: 'operate' },
        { principal: CODEX, repo: 'owner/repo', preset: 'operate' },
        { principal: READER, repo: 'owner/repo', preset: 'read' },
      ]),
    },
    outboundService: req =>
      new URL(req.url).href === `https://${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('no', { status: 404 }),
  })
})

after(async () => {
  await mf.dispose()
})

// ------------------------------------------------------------- identity

test('a call with no identity, or with only an identity header, is refused', async () => {
  assert.equal((await call(undefined, { op: 'read' })).status, 401)
  assert.equal((await call(undefined, { op: 'read' }, undefined, { 'Cf-Access-Authenticated-User-Email': ADAM })).status, 401)
  assert.equal((await call(undefined, { op: 'read' }, undefined, { 'x-relay-principal': JSON.stringify({ id: ADAM, isService: false }) })).status, 401)
})

test('a token with a bad signature, the wrong audience or issuer, or outside its validity times is refused', async () => {
  assert.equal((await call(await sign(person(ADAM), stranger), { op: 'read' })).status, 401)
  assert.equal((await call(await sign(person(ADAM), stranger, 'k2'), { op: 'read' })).status, 401)
  assert.equal((await call(await sign({ ...person(ADAM), aud: ['other'] }), { op: 'read' })).status, 401)
  assert.equal((await call(await sign({ ...person(ADAM), iss: 'https://evil.cloudflareaccess.com' }), { op: 'read' })).status, 401)
  assert.equal((await call(await sign({ ...person(ADAM), exp: now() - 5 }), { op: 'read' })).status, 401)
  assert.equal((await call(await sign({ ...person(ADAM), nbf: now() + 600 }), { op: 'read' })).status, 401)
  assert.equal((await call(await sign(person(ADAM)), { op: 'read' })).status, 200)
})

// ---------------------------------------------------------------- grants

test('a principal with no grant is refused, read cannot mutate, and operate on one repo cannot touch another', async () => {
  assert.equal((await call(await sign(person('nobody@example.org')), { op: 'read' })).status, 403)
  const reader = await sign(person(READER))
  assert.equal((await call(reader, { op: 'read' }, '/v1/owner/repo/8')).status, 200)
  assert.equal((await call(reader, { op: 'commit', rev: 0, record: { x: 1 } }, '/v1/owner/repo/8')).status, 403)
  assert.equal((await call(await sign(person(ADAM)), { op: 'read' }, '/v1/owner/other/8')).status, 403)
})

test('a service principal cannot run an admin operation, even when listed as an admin', async () => {
  assert.equal((await call(await sign(service(CODEX)), { op: 'breakLease' }, '/v1/owner/repo/9')).status, 403)
  assert.equal((await call(await sign(person(ADAM)), { op: 'breakLease' }, '/v1/owner/repo/9')).status, 200)
})

test('each write records the principal that made it', async () => {
  const path = '/v1/owner/repo/10'
  assert.equal((await call(await sign(service(CODEX)), { op: 'commit', rev: 0, record: { by: 'codex' } }, path)).status, 200)
  const read = await call(await sign(person(READER)), { op: 'read' }, path)
  assert.deepEqual((read.json.lastWrite as { actor: string; op: string }).actor, CODEX)
})

// ------------------------------------------------------------- revisions

test('two clients read revision R; the second commit is refused as stale, and retried on the fresh read neither update is lost', async () => {
  const path = '/v1/owner/repo/11'
  const adam = await sign(person(ADAM))
  const codex = await sign(service(CODEX))
  await call(adam, { op: 'commit', rev: 0, record: { grants: [] } }, path)
  const one = await call(adam, { op: 'read' }, path)
  const two = await call(codex, { op: 'read' }, path)
  assert.equal(one.json.rev, two.json.rev)
  const r = one.json.rev as number
  const first = await call(adam, { op: 'commit', rev: r, record: { grants: ['one'] } }, path)
  assert.equal(first.status, 200)
  const stale = await call(codex, { op: 'commit', rev: r, record: { grants: ['two'] } }, path)
  assert.equal(stale.status, 409)
  assert.deepEqual(stale.json.record, { grants: ['one'] })
  const retry = await call(codex, { op: 'commit', rev: stale.json.rev, record: { grants: [...(stale.json.record as { grants: string[] }).grants, 'two'] } }, path)
  assert.equal(retry.status, 200)
  assert.deepEqual((await call(adam, { op: 'read' }, path)).json.record, { grants: ['one', 'two'] })
})

test('a commit that archives keeps the record it replaces, newest last', async () => {
  const path = '/v1/owner/repo/12'
  const adam = await sign(person(ADAM))
  await call(adam, { op: 'commit', rev: 0, record: { generation: 0 } }, path)
  await call(adam, { op: 'commit', rev: 1, record: { generation: 1 }, archiveAt: 5 }, path)
  const archives = (await call(await sign(person(READER)), { op: 'archives' }, path)).json.archives as { at: number; record: unknown }[]
  assert.deepEqual(archives, [{ at: 5, record: { generation: 0 } }])
})

// ----------------------------------------------------------------- lease

test('a live lease holds out another holder; after it lapses the other takes over, and the old holder can neither write nor beat', async () => {
  const path = '/v1/owner/repo/13'
  const adam = await sign(person(ADAM))
  const codex = await sign(service(CODEX))
  const mine = (await call(adam, { op: 'claim', holder: 'session-a' }, path)).json.lease as { token: number }
  assert.equal((await call(codex, { op: 'claim', holder: 'session-b' }, path)).status, 423)
  assert.equal((await call(codex, { op: 'commit', rev: 0, record: { x: 1 } }, path)).status, 423)
  assert.equal((await call(adam, { op: 'commit', rev: 0, record: { x: 1 }, token: mine.token }, path)).status, 200)
  await new Promise(done => setTimeout(done, LEASE_MS + 100))
  const theirs = await call(codex, { op: 'claim', holder: 'session-b' }, path)
  assert.equal(theirs.status, 200)
  assert.ok((theirs.json.lease as { token: number }).token > mine.token)
  assert.equal((await call(adam, { op: 'commit', rev: 1, record: { x: 2 }, token: mine.token }, path)).status, 423)
  assert.equal((await call(adam, { op: 'beat', token: mine.token }, path)).status, 409)
})

test('a beat keeps the lease alive past its first term', async () => {
  const path = '/v1/owner/repo/14'
  const adam = await sign(person(ADAM))
  const mine = (await call(adam, { op: 'claim', holder: 'session-a' }, path)).json.lease as { token: number }
  await new Promise(done => setTimeout(done, LEASE_MS / 2))
  assert.equal((await call(adam, { op: 'beat', token: mine.token }, path)).status, 200)
  await new Promise(done => setTimeout(done, LEASE_MS / 2 + 50))
  assert.equal((await call(await sign(service(CODEX)), { op: 'claim', holder: 'session-b' }, path)).status, 423)
})

// ---------------------------------------------------------------- filing

test('a filing claim is idempotent: the second claim of a key finds the first, and its result once done', async () => {
  const path = '/v1/owner/repo/15'
  const adam = await sign(person(ADAM))
  const key = 'lc-1:R1-1:1'
  assert.equal((await call(adam, { op: 'fileClaim', key }, path)).json.isFresh, true)
  const again = await call(await sign(service(CODEX)), { op: 'fileClaim', key }, path)
  assert.equal(again.json.isFresh, false)
  await call(adam, { op: 'fileDone', key, result: { issue: 42 } }, path)
  const read = await call(await sign(person(READER)), { op: 'filing', key }, path)
  assert.deepEqual((read.json.filing as { state: string; result: unknown }).result, { issue: 42 })
  assert.equal((await call(await sign(service(CODEX)), { op: 'fileDelete', key }, path)).status, 403)
})
