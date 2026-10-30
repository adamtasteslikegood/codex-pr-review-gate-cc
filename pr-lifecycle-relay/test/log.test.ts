// `take` within one principal, the lease-free log (R106), `snapshot` and `fileAdopt`'s refusals.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { ADAM, call, CODEX, FILING_STALE_MS, person, READER, seed, service, sign, start, stop } from './harness.ts'

const S1 = 'a'.repeat(40)
const S2 = 'b'.repeat(40)
let adam: string
let codex: string
let reader: string
let n = 100
const fresh = (): string => `/v1/owner/repo/${n++}`
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

before(async () => {
  await start()
  await seed()
  adam = await sign(person(ADAM))
  codex = await sign(service(CODEX))
  reader = await sign(person(READER))
})

after(async () => {
  await stop()
})

type Line = { seq: number; at: number; principal: string; holder: string; text: string }
type Read = { rev: number; record: unknown; lease: { token: number; holder: string } | null; log: Line[]; logDropped: number; logSeq: number }
const read = async (path: string, extra: Record<string, unknown> = {}): Promise<Read> => (await call(adam, { op: 'read', ...extra }, path)).json as unknown as Read
const line = (path: string, at: number, text = 'x', who = adam, holder = 'h') => call(who, { op: 'log', at, kind: 'info', text, holder }, path)

// ------------------------------------------------------------------ take

test('take by the same principal issues a new token and fences out the old holder', async () => {
  const path = fresh()
  const first = await call(adam, { op: 'claim', holder: 's1', secret: S1 }, path)
  const token = (first.json.lease as { token: number }).token
  const taken = await call(adam, { op: 'take', holder: 's2', secret: S2 }, path)
  assert.equal(taken.status, 200)
  const lease = taken.json.lease as { token: number; holder: string; principal: string }
  assert.ok(lease.token > token)
  assert.equal(lease.holder, 's2')
  assert.equal(JSON.stringify(taken.json).includes('verifier'), false)
  assert.equal((await call(adam, { op: 'beat', secret: S1 }, path)).status, 409)
  assert.equal((await call(adam, { op: 'commit', rev: 0, record: { a: 1 }, secret: S1 }, path)).status, 423)
  assert.equal((await call(adam, { op: 'beat', secret: S2 }, path)).status, 200)
  assert.equal((await call(adam, { op: 'commit', rev: 0, record: { a: 1 }, secret: S2 }, path)).status, 200)
})

test('take by a different principal gets 423', async () => {
  const path = fresh()
  await call(adam, { op: 'claim', holder: 's1', secret: S1 }, path)
  const res = await call(codex, { op: 'take', holder: 'c1', secret: S2 }, path)
  assert.equal(res.status, 423)
  assert.equal((await call(adam, { op: 'beat', secret: S1 }, path)).status, 200)
  assert.equal((await call(reader, { op: 'take', holder: 'r', secret: S2 }, path)).status, 403)
})

test('take of a lapsed or empty lease acts as claim', async () => {
  const empty = fresh()
  const one = await call(codex, { op: 'take', holder: 'c1', secret: S1 }, empty)
  assert.equal(one.status, 200)
  assert.equal((one.json.lease as { token: number }).token, 1)
  const lapsed = fresh()
  await call(adam, { op: 'claim', holder: 's1', secret: S1 }, lapsed)
  await wait(700)
  const res = await call(codex, { op: 'take', holder: 'c1', secret: S2 }, lapsed)
  assert.equal(res.status, 200)
  assert.equal((res.json.lease as { token: number }).token, 2)
  assert.equal((await call(codex, { op: 'take', holder: 'c1', secret: 'short' }, fresh())).status, 400)
})

// ------------------------------------------------------------------- log

test("a non-holder's log succeeds and its commit gets 423", async () => {
  const path = fresh()
  await call(adam, { op: 'claim', holder: 's1', secret: S1 }, path)
  assert.equal((await line(path, 5, 'stood down', codex, 'c1')).status, 200)
  assert.equal((await call(codex, { op: 'commit', rev: 0, record: { x: 1 }, secret: S2 }, path)).status, 423)
})

test('log needs operate', async () => {
  const path = fresh()
  assert.equal((await line(path, 1, 'x', reader)).status, 403)
  assert.equal((await call(adam, { op: 'log', text: 'no at' }, path)).status, 400)
})

test('log does not bump rev, and writes nothing to the write history', async () => {
  const path = fresh()
  await call(adam, { op: 'claim', holder: 's1', secret: S1 }, path)
  await call(adam, { op: 'commit', rev: 0, record: { a: 1 }, secret: S1 }, path)
  const before = (await call(adam, { op: 'read' }, path)).json
  await line(path, 1)
  await line(path, 2)
  const after = (await call(adam, { op: 'read' }, path)).json
  assert.equal(after.rev, before.rev)
  assert.deepEqual(after.lastWrite, before.lastWrite)
  assert.deepEqual(after.record, before.record)
})

test('line 1001 drops the oldest line and logDropped counts it', async () => {
  const path = fresh()
  // Lines 1 and 2 go in order, so the survivors are known; the rest go in chunks of 50.
  await line(path, 1)
  await line(path, 2)
  for (let i = 3; i <= 1001; i += 50) await Promise.all(Array.from({ length: Math.min(50, 1002 - i) }, (_, k) => line(path, i + k)))
  const got = await read(path)
  assert.equal(got.log.length, 1000)
  assert.equal(got.logDropped, 1)
  assert.equal(got.logSeq, 1001)
  assert.equal(got.log[0]!.seq, 2)
  assert.equal(got.log[0]!.at, 2)
})

test('logSince returns only lines after the cursor', async () => {
  const path = fresh()
  for (const at of [10, 20, 30]) await line(path, at)
  const got = await read(path, { logSince: 2 })
  assert.deepEqual(got.log.map(l => l.seq), [3])
  assert.equal(got.logSeq, 3)
  assert.equal((await read(path, { logSince: 3 })).log.length, 0)
  assert.equal((await read(path)).log.length, 3)
})

test('a frozen clock loses no line', async () => {
  const path = fresh()
  await line(path, 7, 'A')
  const first = await read(path)
  await line(path, 7, 'B')
  const next = await read(path, { logSince: first.logSeq })
  assert.deepEqual(next.log.map(l => l.text), ['B'])
  const big = fresh()
  for (let i = 1; i <= 1001; i += 50) await Promise.all(Array.from({ length: Math.min(50, 1002 - i) }, () => line(big, 7)))
  const got = await read(big)
  assert.equal(got.logSeq, 1001)
  assert.equal(got.logDropped, 1)
})

test('each line records the principal and the holder, and its text is cut to 300 characters', async () => {
  const path = fresh()
  await line(path, 1, 'y'.repeat(400), codex, 'session-c')
  const [one] = (await read(path)).log
  assert.equal(one!.principal, CODEX)
  assert.equal(one!.holder, 'session-c')
  assert.equal(one!.text.length, 300)
})

// -------------------------------------------------------------- fileAdopt

test('fileAdopt finishes a stale claim under the lease, without impersonating', async () => {
  const path = fresh()
  const key = 'lc-9:f1:1'
  const issue = { number: 5, url: 'https://github.com/owner/repo/issues/5' }
  assert.equal((await call(codex, { op: 'fileClaim', key, secret: S1 }, path)).status, 200)
  await call(adam, { op: 'claim', holder: 's2', secret: S2 }, path)
  await wait(FILING_STALE_MS + 50)
  const adopted = await call(adam, { op: 'fileAdopt', key, secret: S2, result: issue }, path)
  assert.equal(adopted.status, 200)
  const filing = (await call(adam, { op: 'filing', key }, path)).json.filing
  assert.deepEqual(filing, { ...(filing as object), state: 'done', actor: CODEX, adoptedBy: ADAM, result: issue })
  const last = (await call(adam, { op: 'read' }, path)).json.lastWrite as { op: string; actor: string }
  assert.deepEqual([last.actor, last.op], [ADAM, `fileAdopt ${key}`])
})

test('fileAdopt is refused without the live lease, on a young or missing claim and on a done filing with another result', async () => {
  const path = fresh()
  const key = 'lc-10:f1:1'
  const issue = { number: 5, url: 'u' }
  await call(codex, { op: 'fileClaim', key, secret: S1 }, path)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: S2, result: issue }, path)).status, 423)
  await call(adam, { op: 'claim', holder: 's2', secret: S2 }, path)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: S2, result: issue }, path)).status, 409)
  assert.equal((await call(adam, { op: 'fileAdopt', key: 'lc-10:none:1', secret: S2, result: issue }, path)).status, 409)
  await wait(FILING_STALE_MS + 50)
  await call(adam, { op: 'beat', secret: S2 }, path)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: S2, result: issue }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: S2, result: issue }, path)).status, 200)
  assert.equal((await call(adam, { op: 'fileAdopt', key, secret: S2, result: { number: 6, url: 'v' } }, path)).status, 409)
})

// -------------------------------------------------------------- snapshot

test('snapshot appends to archives without touching record or rev', async () => {
  const path = fresh()
  await call(adam, { op: 'claim', holder: 's1', secret: S1 }, path)
  await call(adam, { op: 'commit', rev: 0, record: { keep: true }, secret: S1 }, path)
  const before = await read(path)
  const res = await call(codex, { op: 'snapshot', at: 9, record: { was: 'copy' }, reason: 'fallback' }, path)
  assert.equal(res.status, 200)
  const after = await read(path)
  assert.equal(after.rev, before.rev)
  assert.deepEqual(after.record, before.record)
  const archives = (await call(adam, { op: 'archives' }, path)).json.archives as { at: number; record: unknown; actor: string; reason: string }[]
  assert.deepEqual(archives.at(-1), { at: 9, record: { was: 'copy' }, actor: CODEX, reason: 'fallback' })
  assert.equal((await call(reader, { op: 'snapshot', at: 9, record: {}, reason: 'fallback' }, path)).status, 403)
  assert.equal((await call(adam, { op: 'snapshot', at: 9, record: {}, reason: 'nope' }, path)).status, 400)
})

test('snapshot keeps at most ARCHIVE_CAP archives', async () => {
  const path = fresh()
  for (let i = 1; i <= 22; i++) await call(adam, { op: 'snapshot', at: i, record: { i }, reason: 'move' }, path)
  const archives = (await call(adam, { op: 'archives' }, path)).json.archives as { at: number }[]
  assert.equal(archives.length, 20)
  assert.equal(archives[0]!.at, 3)
})
