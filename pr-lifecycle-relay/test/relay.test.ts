// The relay under Miniflare, locally only (#29 Part B spike step 2). The tests sign their own Access JWTs with a local key pair,
// which the outbound fetch serves as the team's published keys: the production verifier runs unchanged.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { ADAM, call, CODEX, FILING_STALE_MS, LEASE_MS, now, person, READER, seed, service, sign, start, stop, stranger } from './harness.ts'

before(async () => {
  await start()
  await seed()
})

after(async () => {
  await stop()
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

test('a forged x-relay-principal naming an admin is replaced: breakLease from a non-admin still answers 403', async () => {
  const forged = { 'x-relay-principal': JSON.stringify({ id: ADAM, isService: false }), 'x-relay-preset': 'operate' }
  assert.equal((await call(await sign(person(READER)), { op: 'breakLease' }, '/v1/owner/repo/9', forged)).status, 403)
  assert.equal((await call(await sign(service(CODEX)), { op: 'breakLease' }, '/v1/owner/repo/9', forged)).status, 403)
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

test('a commit that archives keeps the record it was given, not the one stored, newest last', async () => {
  const path = '/v1/owner/repo/12'
  const adam = await sign(person(ADAM))
  await call(adam, { op: 'commit', rev: 0, record: { generation: 0 } }, path)
  const kept = { generation: 0, phase: 'archived', findings: ['local'] }
  assert.equal((await call(adam, { op: 'commit', rev: 1, record: { generation: 1 }, archive: { at: 5, record: kept } }, path)).status, 200)
  assert.equal((await call(adam, { op: 'commit', rev: 2, record: { generation: 2 }, archive: { at: 'soon', record: kept } }, path)).status, 400)
  assert.equal((await call(adam, { op: 'commit', rev: 2, record: { generation: 2 }, archive: null }, path)).status, 400)
  assert.equal((await call(adam, { op: 'read' }, path)).json.rev, 2)
  const archives = (await call(await sign(person(READER)), { op: 'archives' }, path)).json.archives as { at: number; record: unknown }[]
  assert.deepEqual(archives, [{ at: 5, record: kept }])
})

test('archives are trimmed oldest first to 1 MiB, so the stored value stays under 2 MB (final review M6)', async () => {
  const path = '/v1/owner/repo/30'
  const adam = await sign(person(ADAM))
  for (let at = 1; at <= 12; at += 1) {
    assert.equal((await call(adam, { op: 'snapshot', at, record: { pad: 'x'.repeat(120 * 1024) }, reason: 'fallback' }, path)).status, 200)
  }
  const archives = (await call(adam, { op: 'archives' }, path)).json.archives as { at: number }[]
  assert.ok(archives.length < 12 && archives.length >= 7, `kept ${archives.length}`)
  assert.equal(archives.at(-1)?.at, 12)
  assert.ok(new TextEncoder().encode(JSON.stringify(archives)).length <= 1024 * 1024)
})

// ----------------------------------------------------------------- lease

type Held = { token: number; holder: string; principal: string }
const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
/** A checkout's own capability: made on its side, never returned by the relay. */
const secretOf = (): string => crypto.randomUUID() + crypto.randomUUID()

test('a live lease holds out another holder; after it lapses the other takes over, and the old holder can neither write nor beat', async () => {
  const path = '/v1/owner/repo/13'
  const adam = await sign(person(ADAM))
  const codex = await sign(service(CODEX))
  const [a, b] = [secretOf(), secretOf()]
  const mine = (await call(adam, { op: 'claim', holder: 'session-a', secret: a }, path)).json.lease as Held
  assert.equal((await call(codex, { op: 'claim', holder: 'session-b', secret: b }, path)).status, 423)
  assert.equal((await call(codex, { op: 'commit', rev: 0, record: { x: 1 }, secret: b }, path)).status, 423)
  assert.equal((await call(adam, { op: 'commit', rev: 0, record: { x: 1 }, secret: a }, path)).status, 200)
  await wait(LEASE_MS + 100)
  const theirs = await call(codex, { op: 'claim', holder: 'session-b', secret: b }, path)
  assert.equal(theirs.status, 200)
  assert.ok((theirs.json.lease as Held).token > mine.token)
  assert.equal((await call(adam, { op: 'commit', rev: 1, record: { x: 2 }, secret: a }, path)).status, 423)
  assert.equal((await call(adam, { op: 'beat', secret: a }, path)).status, 409)
})

test('a claim needs a secret, and no response ever carries it or its verifier', async () => {
  const path = '/v1/owner/repo/21'
  const adam = await sign(person(ADAM))
  assert.equal((await call(adam, { op: 'claim', holder: 'session-a' }, path)).status, 400)
  assert.equal((await call(adam, { op: 'claim', holder: 'session-a', secret: 'short' }, path)).status, 400)
  const secret = secretOf()
  const answers = [
    await call(adam, { op: 'claim', holder: 'session-a', secret }, path),
    await call(adam, { op: 'beat', secret }, path),
    await call(adam, { op: 'read' }, path),
    await call(adam, { op: 'fileClaim', key: 'k', secret }, path),
    await call(adam, { op: 'fileClaim', key: 'k', secret }, path),
    await call(adam, { op: 'fileDone', key: 'k', secret, result: 1 }, path),
    await call(adam, { op: 'filing', key: 'k' }, path),
  ]
  for (const one of answers) {
    assert.equal(one.status, 200)
    const text = JSON.stringify(one.json)
    assert.ok(!text.includes(secret) && !text.includes('verifier'), text)
  }
})

test('a beat keeps the lease alive past its first term and is recorded; a failed beat records nothing', async () => {
  const path = '/v1/owner/repo/14'
  const adam = await sign(person(ADAM))
  const reader = await sign(person(READER))
  const secret = secretOf()
  await call(adam, { op: 'claim', holder: 'session-a', secret }, path)
  await wait(LEASE_MS / 2)
  assert.equal((await call(adam, { op: 'beat', secret }, path)).status, 200)
  const beat = (await call(reader, { op: 'read' }, path)).json.lastWrite as { actor: string; op: string; at: number }
  assert.deepEqual([beat.actor, beat.op], [ADAM, 'beat'])
  assert.equal((await call(adam, { op: 'beat', secret: secretOf() }, path)).status, 409)
  assert.deepEqual((await call(reader, { op: 'read' }, path)).json.lastWrite, beat)
  await wait(LEASE_MS / 2 + 50)
  assert.equal((await call(await sign(service(CODEX)), { op: 'claim', holder: 'session-b', secret: secretOf() }, path)).status, 423)
})

test('a lapsed lease cannot be revived or released by its old holder', async () => {
  const path = '/v1/owner/repo/16'
  const adam = await sign(person(ADAM))
  const secret = secretOf()
  await call(adam, { op: 'claim', holder: 'session-a', secret }, path)
  await wait(LEASE_MS + 100)
  assert.equal((await call(adam, { op: 'beat', secret }, path)).status, 409)
  assert.equal((await call(adam, { op: 'release', secret }, path)).status, 409)
  assert.equal((await call(await sign(service(CODEX)), { op: 'claim', holder: 'session-b', secret: secretOf() }, path)).status, 200)
})

test('what a read shows of a lease grants nothing: another principal or checkout copying it cannot commit, beat, renew or release', async () => {
  const path = '/v1/owner/repo/17'
  const adam = await sign(person(ADAM))
  const codex = await sign(service(CODEX))
  const secret = secretOf()
  const mine = (await call(adam, { op: 'claim', holder: 'checkout-a', secret }, path)).json.lease as Held
  const seen = (await call(codex, { op: 'read' }, path)).json.lease as Record<string, unknown>
  assert.equal(seen.token, mine.token)
  for (const who of [codex, adam]) {
    const copied = { token: seen.token, holder: seen.holder, secret: secretOf() }
    assert.equal((await call(who, { op: 'commit', rev: 0, record: { x: 1 }, ...copied }, path)).status, 423)
    assert.equal((await call(who, { op: 'beat', ...copied }, path)).status, 409)
    assert.equal((await call(who, { op: 'release', ...copied }, path)).status, 409)
    assert.equal((await call(who, { op: 'claim', ...copied }, path)).status, 423)
  }
  // Another principal holding the very secret is still not the holder.
  assert.equal((await call(codex, { op: 'claim', holder: 'checkout-a', secret }, path)).status, 423)
  assert.equal((await call(codex, { op: 'release', secret }, path)).status, 409)
  const renewed = await call(adam, { op: 'claim', holder: 'checkout-a', secret }, path)
  assert.equal(renewed.status, 200)
  assert.equal((renewed.json.lease as Held).token, mine.token)
  assert.equal((await call(adam, { op: 'release', secret }, path)).status, 200)
})

// ---------------------------------------------------------------- filing

test('a filing claim is idempotent: the second claim of a key finds the first, and its result once done', async () => {
  const path = '/v1/owner/repo/15'
  const adam = await sign(person(ADAM))
  const key = 'lc-1:R1-1:1'
  const secret = secretOf()
  assert.equal((await call(adam, { op: 'fileClaim', key, secret }, path)).json.isFresh, true)
  const again = await call(await sign(service(CODEX)), { op: 'fileClaim', key, secret: secretOf() }, path)
  assert.deepEqual([again.json.isFresh, again.json.isMine], [false, false])
  assert.equal((await call(adam, { op: 'fileDone', key, secret, result: { issue: 42 } }, path)).status, 200)
  const read = await call(await sign(person(READER)), { op: 'filing', key }, path)
  assert.deepEqual((read.json.filing as { state: string; result: unknown }).result, { issue: 42 })
  assert.equal((await call(await sign(service(CODEX)), { op: 'fileDelete', key }, path)).status, 403)
})

test('a lost fileClaim answer is no dead end: the retry with the same secret finds its own claim and completes it once; another checkout cannot', async () => {
  const path = '/v1/owner/repo/22'
  const adam = await sign(person(ADAM))
  const key = 'lc-2:G6-2:1'
  const secret = secretOf()
  await call(adam, { op: 'fileClaim', key, secret }, path) // saved, but say its answer never arrived
  const retry = await call(adam, { op: 'fileClaim', key, secret }, path)
  assert.deepEqual([retry.json.isFresh, retry.json.isMine], [false, true])
  // The same principal as another checkout (another secret) is not the claimant.
  const other = await call(adam, { op: 'fileClaim', key, secret: secretOf() }, path)
  assert.deepEqual([other.json.isFresh, other.json.isMine], [false, false])
  // Not the claimant is a conflict (409), never a refusal (403) that would stand a granted session down (final review M3).
  assert.equal((await call(adam, { op: 'fileDone', key, secret: secretOf(), result: { issue: 7 } }, path)).status, 409)
  assert.equal((await call(adam, { op: 'fileDone', key, secret, result: { issue: 7 } }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileDone', key, secret, result: { issue: 8 } }, path)).status, 409)
})

test('only the claimant finishes a filing, and a done filing never changes: the same answer is a retry, another is refused', async () => {
  const path = '/v1/owner/repo/18'
  const adam = await sign(person(ADAM))
  const codex = await sign(service(CODEX))
  const key = 'lc-1:G1-1:1'
  const secret = secretOf()
  await call(adam, { op: 'fileClaim', key, secret }, path)
  assert.equal((await call(codex, { op: 'fileDone', key, secret: secretOf(), result: { issue: 99 } }, path)).status, 409)
  assert.equal((await call(codex, { op: 'fileDone', key, secret, result: { issue: 99 } }, path)).status, 409)
  assert.equal((await call(adam, { op: 'fileDone', key, result: { issue: 99 } }, path)).status, 409)
  assert.equal((await call(adam, { op: 'fileDone', key, secret, result: { issue: 42 } }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileDone', key, secret, result: { issue: 42 } }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileDone', key, secret, result: { issue: 99 } }, path)).status, 409)
  const filing = (await call(await sign(person(READER)), { op: 'filing', key }, path)).json.filing as { actor: string; result: unknown }
  assert.deepEqual([filing.actor, filing.result], [ADAM, { issue: 42 }])
})

test('a stale claim whose secret is lost is adopted by the lease holder, with the claimant kept and the adopter recorded', async () => {
  const path = '/v1/owner/repo/23'
  const adam = await sign(person(ADAM))
  const codex = await sign(service(CODEX))
  const key = 'lc-3:G1-2:1'
  const lease = secretOf()
  const issue = { number: 5, url: 'https://github.com/owner/repo/issues/5' }
  await call(codex, { op: 'fileClaim', key, secret: secretOf() }, path) // its POST went out, then its checkout and secret were lost
  assert.equal((await call(adam, { op: 'claim', holder: 's2', secret: lease }, path)).status, 200)
  // Too young: its POST may still be on its way.
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: lease, result: issue }, path)).status, 409)
  await wait(FILING_STALE_MS + 50)
  // Only the lease holder adopts: another principal, or the holder's principal with another secret, is refused.
  assert.equal((await call(codex, { op: 'fileAdopt', key, secret: secretOf(), result: issue }, path)).status, 423)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: secretOf(), result: issue }, path)).status, 423)
  assert.equal((await call(adam, { op: 'fileAdopt', key: 'lc-3:none:1', secret: lease, result: issue }, path)).status, 409)
  const adopted = await call(adam, { op: 'fileAdopt', key, secret: lease, result: issue }, path)
  assert.equal(adopted.status, 200)
  assert.deepEqual(adopted.json.filing, { ...(adopted.json.filing as object), state: 'done', actor: CODEX, adoptedBy: ADAM, result: issue })
  assert.equal(JSON.stringify(adopted.json).includes('verifier'), false)
  // Done is terminal: the same result again is a retry, another is refused, and fileDone can't rewrite it either.
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: lease, result: issue }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: lease, result: { number: 6 } }, path)).status, 409)
  const read = await call(adam, { op: 'read' }, path)
  assert.deepEqual(read.json.lastWrite, { ...(read.json.lastWrite as object), actor: ADAM, op: `fileAdopt ${key}` })
})

test('a filing key named like an inherited property is claimed like any other', async () => {
  const path = '/v1/owner/repo/19'
  const adam = await sign(person(ADAM))
  const secret = secretOf()
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await call(adam, { op: 'fileClaim', key, secret }, path)).json.isFresh, true, key)
    assert.equal((await call(adam, { op: 'fileClaim', key, secret }, path)).json.isFresh, false, key)
  }
  assert.equal((await call(adam, { op: 'filing', key: 'hasOwnProperty' }, path)).json.filing, null)
})

// --------------------------------------------------------------- casing

test('a principal matches its grant and admin entry whatever the casing of its email', async () => {
  const shouty = await sign(person(ADAM.toUpperCase()))
  assert.equal((await call(shouty, { op: 'read' }, '/v1/owner/repo/20')).status, 200)
  assert.equal((await call(shouty, { op: 'breakLease' }, '/v1/owner/repo/20')).status, 200)
})
