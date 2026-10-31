// Branch keys, the move to the PR key and the tombstone (R103). Pre-PR records live at `owner/repo@<branch>`; `moveTo` freezes the branch.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { ADAM, call, person, READER, seed, sign, start, stop } from './harness.ts'

const SECRET = 'b'.repeat(40)
const url = (branch: string, repo = 'owner/repo'): string => `/v1/${repo}/branch/${branch}`
let adam: string

before(async () => {
  // Branch objects are deleted RETENTION_MS after their last write; these tests are not about retention (index.test.ts is).
  await start({ RETENTION_MS: '600000' })
  await seed()
  adam = await sign(person(ADAM))
})

after(async () => {
  await stop()
})

const read = (path: string) => call(adam, { op: 'read' }, path)
const claim = (path: string) => call(adam, { op: 'claim', holder: 'h1', secret: SECRET }, path)
/** Claim, commit `record` and return the rev after it. */
async function seedBranch(path: string, record: unknown = { lifecycleId: 'L1', n: 1 }): Promise<number> {
  assert.equal((await claim(path)).status, 200)
  const { rev } = (await read(path)).json as { rev: number }
  const done = await call(adam, { op: 'commit', rev, record, secret: SECRET }, path)
  assert.equal(done.status, 200)
  return done.json.rev as number
}
const moveTo = (path: string, pr = 7) => call(adam, { op: 'moveTo', pr, secret: SECRET }, path)
/** A branch frozen as `L1` and moved to PR 7. */
async function frozen(branch: string): Promise<string> {
  const path = url(branch)
  await seedBranch(path)
  assert.equal((await moveTo(path)).status, 200)
  return path
}

test('a branch with / round-trips', async () => {
  const path = url('feat%2Fa%2Fb')
  await seedBranch(path, { lifecycleId: 'L1', at: 'deep' })
  assert.deepEqual((await read(path)).json.record, { lifecycleId: 'L1', at: 'deep' })
  assert.equal((await read(url('feat'))).json.rev, 0)
})

test('awkward names round-trip', async () => {
  await seedBranch(url('fix-%C3%BC'), { lifecycleId: 'u' })
  assert.deepEqual((await read(url('fix-%C3%BC'))).json.record, { lifecycleId: 'u' })
  await seedBranch(url('100%25'), { lifecycleId: 'pct' })
  assert.deepEqual((await read(url('100%25'))).json.record, { lifecycleId: 'pct' })
  // %252F is the literal text %2F, not a slash.
  await seedBranch(url('a%252Fb'), { lifecycleId: 'lit' })
  assert.deepEqual((await read(url('a%252Fb'))).json.record, { lifecycleId: 'lit' })
  assert.equal((await read(url('a%2Fb'))).json.rev, 0)
})

test('a name git would refuse gets 404', async () => {
  for (const name of ['a..b', '-x', 'x.lock', 'x/', 'a%20b', 'a~b', 'a%5Cb', 'a@%7Bb', 'a%2F%2Fb', 'x.', '@', '.x', 'a%2F.b', 'a.lock%2Fb', '%2Fx', 'a%00b', 'a:b', 'a%3Fb', 'a*b', 'a%5Bb', 'a^b', '']) {
    assert.equal((await read(url(name))).status, 404, `branch ${JSON.stringify(name)}`)
  }
  assert.equal((await read(url('%E0%A4%A'))).status, 404, 'a bad percent escape')
  assert.equal((await read(url('a'.repeat(256)))).status, 404, '256 bytes')
  assert.equal((await read(url('a'.repeat(255)))).status, 200, '255 bytes')
  assert.equal((await read(url('%C3%BC'.repeat(128)))).status, 404, '256 bytes in 128 characters')
})

test('owner and repo are case-folded, the branch is not', async () => {
  await seedBranch('/v1/Owner/Repo/branch/Feat', { lifecycleId: 'case' })
  assert.deepEqual((await read('/v1/owner/repo/branch/Feat')).json.record, { lifecycleId: 'case' })
  assert.equal((await read('/v1/owner/repo/branch/feat')).json.rev, 0)
})

test('a branch object and a PR object are different objects', async () => {
  await seedBranch(url('seven'), { lifecycleId: 'b7' })
  assert.notDeepEqual((await read('/v1/owner/repo/7')).json.record, { lifecycleId: 'b7' })
})

test('moveTo needs the lease, freezes the record and releases the lease', async () => {
  const path = url('mv-1')
  const rev = await seedBranch(path)
  const other = await sign(person('codex@example.org'))
  // No grant: refused; the reader may not; without our secret there is no lease.
  assert.equal((await call(await sign(person(READER)), { op: 'moveTo', pr: 7, secret: SECRET }, path)).status, 403)
  assert.equal((await call(adam, { op: 'moveTo', pr: 7, secret: 'z'.repeat(40) }, path)).status, 409)
  assert.equal((await call(other, { op: 'moveTo', pr: 7, secret: SECRET }, path)).status, 403)
  const moved = await moveTo(path)
  assert.equal(moved.status, 200)
  assert.equal(moved.json.rev, rev + 1)
  const after = (await read(path)).json
  assert.deepEqual(after.record, { movedTo: 7, lifecycleId: 'L1', record: { lifecycleId: 'L1', n: 1 } })
  assert.equal(after.lease, null)
  assert.equal(after.rev, rev + 1)
})

test('moveTo without a lease is 409, and a record without a lifecycleId cannot move', async () => {
  const path = url('mv-2')
  assert.equal((await moveTo(path)).status, 409)
  await seedBranch(path, { n: 1 })
  assert.equal((await moveTo(path)).status, 409)
})

test('moveDone drops the copy and is idempotent', async () => {
  const path = await frozen('md-1')
  assert.equal((await call(adam, { op: 'moveDone', lifecycleId: 'L1' }, path)).status, 200)
  assert.equal((await call(adam, { op: 'moveDone', lifecycleId: 'L1' }, path)).status, 200)
  assert.deepEqual((await read(path)).json.record, { movedTo: 7, lifecycleId: 'L1' })
  assert.equal((await call(adam, { op: 'moveDone', lifecycleId: 'L9' }, path)).status, 409)
  assert.equal((await call(await sign(person(READER)), { op: 'moveDone', lifecycleId: 'L1' }, path)).status, 403)
  // Not moved yet: 409.
  const live = url('md-2')
  await seedBranch(live)
  assert.equal((await call(adam, { op: 'moveDone', lifecycleId: 'L1' }, live)).status, 409)
})

test('record and lease ops on a tombstone answer 410', async () => {
  const path = await frozen('gone-1')
  const { rev } = (await read(path)).json as { rev: number }
  const ops: Record<string, unknown>[] = [
    { op: 'commit', rev, record: { lifecycleId: 'L1' }, secret: SECRET },
    { op: 'claim', holder: 'h2', secret: SECRET },
    { op: 'beat', secret: SECRET },
    { op: 'release', secret: SECRET },
    { op: 'moveTo', pr: 8, secret: SECRET },
  ]
  for (const body of ops) {
    const res = await call(adam, body, path)
    assert.equal(res.status, 410, String(body.op))
    assert.deepEqual(res.json, { movedTo: 7, lifecycleId: 'L1' })
  }
})

test('archives, filing and moveDone still work on a tombstone', async () => {
  const path = await frozen('gone-2')
  assert.equal((await call(adam, { op: 'archives' }, path)).status, 200)
  assert.equal((await call(adam, { op: 'filing', key: 'L1:f1:1' }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileClaim', key: 'L1:f1:1', secret: SECRET }, path)).status, 200)
  assert.equal((await call(adam, { op: 'moveDone', lifecycleId: 'L1' }, path)).status, 200)
  assert.equal((await read(path)).status, 200)
})

test('take on a tombstone answers 410; log and snapshot answer 200', async () => {
  const path = await frozen('gone-4')
  const taken = await call(adam, { op: 'take', holder: 'h2', secret: SECRET }, path)
  assert.equal(taken.status, 410)
  assert.deepEqual(taken.json, { movedTo: 7, lifecycleId: 'L1' })
  assert.equal((await call(adam, { op: 'log', at: 1, kind: 'info', text: 'after the move', holder: 'h1' }, path)).status, 200)
  assert.equal((await call(adam, { op: 'snapshot', at: 2, record: { lifecycleId: 'L1' }, reason: 'move' }, path)).status, 200)
  assert.equal((await read(path)).json.logSeq, 1)
})

test('a frozen branch takes no beat', async () => {
  const path = url('gone-3')
  await seedBranch(path)
  assert.equal((await call(adam, { op: 'beat', secret: SECRET }, path)).status, 200)
  assert.equal((await moveTo(path)).status, 200)
  assert.equal((await call(adam, { op: 'beat', secret: SECRET }, path)).status, 410)
})

const moveDone = (path: string, lifecycleId = 'L1') => call(adam, { op: 'moveDone', lifecycleId }, path)

test('a fresh start over a tombstone', async () => {
  const path = await frozen('fresh-1')
  assert.equal((await moveDone(path)).status, 200)
  const { rev } = (await read(path)).json as { rev: number }
  // A stale revision is still refused.
  assert.equal((await call(adam, { op: 'commit', rev: rev - 1, record: { lifecycleId: 'L2' }, isFresh: true }, path)).status, 409)
  const fresh = await call(adam, { op: 'commit', rev, record: { lifecycleId: 'L2' }, isFresh: true }, path)
  assert.equal(fresh.status, 200)
  const after = (await read(path)).json
  assert.deepEqual(after.record, { lifecycleId: 'L2' })
  // Live again: it can be claimed.
  assert.equal((await claim(path)).status, 200)
  assert.equal((await moveDone(path, 'L2')).status, 409)
})

test('a fresh start before moveDone is 409 and keeps the frozen record', async () => {
  const path = await frozen('fresh-4')
  const before = (await read(path)).json as { rev: number; record: unknown }
  const res = await call(adam, { op: 'commit', rev: before.rev, record: { lifecycleId: 'L2' }, isFresh: true }, path)
  assert.equal(res.status, 409)
  assert.deepEqual(res.json, { error: 'the move is not finished', movedTo: 7, lifecycleId: 'L1' })
  const after = (await read(path)).json
  assert.deepEqual(after.record, { movedTo: 7, lifecycleId: 'L1', record: { lifecycleId: 'L1', n: 1 } })
  assert.equal(after.rev, before.rev)
})

test('a fresh start leaves the PR object alone', async () => {
  const path = await frozen('fresh-2')
  // Step 2 of the move: publish the record to PR 7, then finish.
  const pr = '/v1/owner/repo/7'
  assert.equal((await claim(pr)).status, 200)
  const published = await call(adam, { op: 'commit', rev: 0, record: { lifecycleId: 'L1', n: 1 }, from: '@fresh-2', secret: SECRET }, pr)
  assert.equal(published.status, 200)
  assert.equal((await moveDone(path)).status, 200)
  const before = (await read(pr)).json
  const { rev } = (await read(path)).json as { rev: number }
  assert.equal((await call(adam, { op: 'commit', rev, record: { lifecycleId: 'L2' }, isFresh: true }, path)).status, 200)
  const after = (await read(pr)).json
  assert.deepEqual(after.record, { lifecycleId: 'L1', n: 1 })
  assert.equal(after.rev, 1)
  assert.deepEqual(after, before)
})

test("isFresh with the tombstone's own lifecycleId is 410", async () => {
  const path = await frozen('fresh-3')
  const { rev } = (await read(path)).json as { rev: number }
  const res = await call(adam, { op: 'commit', rev, record: { lifecycleId: 'L1' }, isFresh: true }, path)
  assert.equal(res.status, 410)
  assert.deepEqual(res.json, { movedTo: 7, lifecycleId: 'L1' })
  assert.equal((await call(adam, { op: 'commit', rev, record: {}, isFresh: true }, path)).status, 400)
})

test('moveTo and moveDone on a PR key are 404', async () => {
  assert.equal((await call(adam, { op: 'moveTo', pr: 9, secret: SECRET }, '/v1/owner/repo/8')).status, 404)
  assert.equal((await call(adam, { op: 'moveDone', lifecycleId: 'L1' }, '/v1/owner/repo/8')).status, 404)
})

test('commit with from on a non-empty PR object is 409 with its record', async () => {
  const path = '/v1/owner/repo/52'
  assert.equal((await claim(path)).status, 200)
  const first = await call(adam, { op: 'commit', rev: 0, record: { lifecycleId: 'L1' }, from: '@feat', secret: SECRET }, path)
  assert.equal(first.status, 200)
  const again = await call(adam, { op: 'commit', rev: 0, record: { lifecycleId: 'L1' }, from: '@feat', secret: SECRET }, path)
  assert.equal(again.status, 409)
  assert.deepEqual(again.json.record, { lifecycleId: 'L1' })
  assert.equal(again.json.rev, 1)
  // Even with the current rev, from never overwrites.
  const over = await call(adam, { op: 'commit', rev: 1, record: { lifecycleId: 'L9' }, from: '@feat', secret: SECRET }, path)
  assert.equal(over.status, 409)
  assert.deepEqual((await read(path)).json.record, { lifecycleId: 'L1' })
  // from names a branch key and belongs on a PR object.
  assert.equal((await call(adam, { op: 'commit', rev: 1, record: {}, from: 'feat', secret: SECRET }, path)).status, 400)
  const branch = url('from-on-branch')
  assert.equal((await call(adam, { op: 'commit', rev: 0, record: {}, from: '@x', secret: SECRET }, branch)).status, 400)
})
