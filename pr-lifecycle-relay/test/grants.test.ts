// The grants (#29 Part B, R104): stored in a GrantStore object, edited by admin ops, and passed to the objects in an internal header.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { ADAM, call, CODEX, grant, person, READER, service, sign, start, stop } from './harness.ts'

before(async () => {
  await start()
})

after(async () => {
  await stop()
})

const ADMIN = '/v1/admin/grants'
const asAdam = async () => sign(person(ADAM))
const list = async () => (await call(await asAdam(), { op: 'grants' }, ADMIN)).json as {
  rev: number
  grants: { principal: string; repo: string; preset: string }[]
  history: { actor: string; op: string; rev: number }[]
}

test('a principal with no grant gets 403', async () => {
  assert.equal((await call(await sign(person('new@example.org')), { op: 'read' })).status, 403)
})

test('after grant it gets through, after revoke it gets 403 on its next request', async () => {
  const adam = await asAdam()
  const token = await sign(person('temp@example.org'))
  assert.equal((await grant(adam, 'temp@example.org', 'owner/repo', 'read')).status, 200)
  assert.equal((await call(token, { op: 'read' })).status, 200)
  assert.equal((await call(adam, { op: 'revoke', principal: 'temp@example.org', repo: 'owner/repo' }, ADMIN)).status, 200)
  assert.equal((await call(token, { op: 'read' })).status, 403)
})

test('grant of an existing pair changes its preset', async () => {
  const adam = await asAdam()
  const token = await sign(person('change@example.org'))
  await grant(adam, 'change@example.org', 'owner/repo', 'read')
  assert.equal((await call(token, { op: 'claim', holder: 'h', secret: 'x'.repeat(40) })).status, 403)
  await grant(adam, 'change@example.org', 'owner/repo', 'operate')
  assert.equal((await list()).grants.filter(one => one.principal === 'change@example.org').length, 1)
  assert.equal((await call(token, { op: 'claim', holder: 'h', secret: 'x'.repeat(40) }, '/v1/owner/repo/21')).status, 200)
})

test("a non-admin's grant gets 403", async () => {
  const adam = await asAdam()
  await grant(adam, 'op@example.org', 'owner/repo', 'operate')
  const asOperator = await sign(person('op@example.org'))
  assert.equal((await grant(asOperator, 'op@example.org', 'owner/other', 'operate')).status, 403)
  assert.equal((await grant(await sign(service(CODEX)), READER, 'owner/other', 'operate')).status, 403)
  assert.equal((await call(asOperator, { op: 'grants' }, ADMIN)).status, 403)
  assert.equal((await call(undefined, { op: 'grants' }, ADMIN)).status, 401)
})

test("a caller's own x-relay-preset and x-relay-principal are replaced", async () => {
  await grant(await asAdam(), READER, 'owner/repo', 'read')
  const forged = { 'x-relay-preset': 'operate', 'x-relay-principal': JSON.stringify({ id: ADAM, isService: false }), 'x-relay-repo': 'owner/other' }
  assert.equal((await call(await sign(person(READER)), { op: 'claim', holder: 'h', secret: 'x'.repeat(40) }, '/v1/owner/repo/22', forged)).status, 403)
})

test('every grant change is in the history with its actor', async () => {
  const before = (await list()).history.length
  const adam = await asAdam()
  await grant(adam, 'h@example.org', 'owner/h', 'read')
  await grant(adam, 'h@example.org', 'owner/h', 'operate')
  await call(adam, { op: 'revoke', principal: 'h@example.org', repo: 'owner/h' }, ADMIN)
  const { history } = await list()
  const mine = history.slice(before)
  assert.equal(mine.length, 3)
  assert.deepEqual(
    mine.map(one => one.op),
    ['grant', 'grant', 'revoke'],
  )
  assert.ok(mine.every(one => one.actor === ADAM))
  assert.deepEqual(
    mine.map(one => one.rev),
    [mine[0].rev, mine[0].rev + 1, mine[0].rev + 2],
  )
})

test('a grant names one lowercased repo; a wildcard or a malformed repo is 400', async () => {
  const adam = await asAdam()
  assert.equal((await grant(adam, 'Case@Example.org', 'Owner/Repo2', 'read')).status, 200)
  assert.ok((await list()).grants.some(one => one.principal === 'case@example.org' && one.repo === 'owner/repo2'))
  assert.equal((await grant(adam, 'w@example.org', '*', 'read')).status, 400)
  assert.equal((await grant(adam, 'w@example.org', 'owner/*', 'read')).status, 400)
  assert.equal((await grant(adam, 'w@example.org', 'owner', 'read')).status, 400)
  assert.equal((await call(adam, { op: 'grant', principal: 'w@example.org', repo: 'owner/repo', preset: 'admin' }, ADMIN)).status, 400)
  assert.equal((await call(adam, { op: 'presetOf', principal: ADAM, repo: 'owner/repo' }, ADMIN)).status, 400)
})

test('history keeps the last 500', async () => {
  const adam = await asAdam()
  await call(adam, { op: 'grant', principal: 'bulk@example.org', repo: 'owner/bulk', preset: 'read' }, ADMIN)
  let last = 0
  for (let i = 0; i < 500; i++) last = ((await grant(adam, 'bulk@example.org', 'owner/bulk', 'read')).json as { rev: number }).rev
  const { history } = await list()
  assert.equal(history.length, 500)
  assert.equal(history[0].rev, last - 499)
})
