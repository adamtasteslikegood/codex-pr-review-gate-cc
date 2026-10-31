// Work claims (docs/superpowers/specs/2026-10-31-relay-work-claims-design.md): claim, checkpoint, lapse, takeover and resume, release,
// reopen, list, admin break and retention, under Miniflare with the relay's own Access verification.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { ADAM, call, CODEX, LEASE_MS, person, READER, seed, service, sign, start, stop } from './harness.ts'

const PATH = '/v1/owner/repo/work'
const SANDBOX = 'sandbox-secret-0123456789abcdef0123456789'
const LAPTOP = 'laptop-secret-0123456789abcdef0123456789ab'
/** Longer than the harness's: a claim untouched for its retention is deleted, and a takeover test waits out a lease first. */
const RETENTION_MS = 2000
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let adam: string
let codex: string
let reader: string
const work = (token: string, body: Record<string, unknown>) => call(token, body, PATH)
type Resume = { branch: string | null; commit: string | null; notes: string | null; steps: { kind: string }[] }
type Claimed = { claim: Record<string, unknown>; token: number; tookOver: boolean; resume: Resume }

before(async () => {
  await start({ RETENTION_MS: String(RETENTION_MS) })
  await seed()
  adam = await sign(person(ADAM))
  codex = await sign(service(CODEX))
  reader = await sign(person(READER))
})

after(async () => {
  await stop()
})

test('a claim is held: another session gets 423, a reader may read but not claim, and a bad ref or short secret is 400', async () => {
  const first = await work(codex, { op: 'claim', ref: 'gh#1', holder: 'sandbox-1', runtime: 'workers-sandbox', secret: SANDBOX, title: 'retry on 429' })
  assert.equal(first.status, 200)
  const { token, claim, tookOver } = first.json as unknown as Claimed
  assert.equal(token, 1)
  assert.equal(tookOver, false)
  assert.equal(claim.state, 'active')
  assert.equal((claim.lease as Record<string, unknown>).verifier, undefined)
  assert.equal((await work(adam, { op: 'claim', ref: 'gh#1', holder: 'tui', runtime: 'tui', secret: LAPTOP })).status, 423)
  assert.equal((await work(reader, { op: 'claim', ref: 'gh#1', holder: 'r', runtime: 'tui', secret: LAPTOP })).status, 403)
  assert.equal((await work(reader, { op: 'get', ref: 'gh#1' })).status, 200)
  assert.equal((await work(adam, { op: 'claim', ref: '-bad ref', holder: 'tui', runtime: 'tui', secret: LAPTOP })).status, 400)
  assert.equal((await work(adam, { op: 'claim', ref: 'gh#2', holder: 'tui', runtime: 'tui', secret: 'short' })).status, 400)
  // The holder renews its own live claim with the same token.
  const again = (await work(codex, { op: 'claim', ref: 'gh#1', holder: 'sandbox-1', runtime: 'workers-sandbox', secret: SANDBOX })).json as unknown as Claimed
  assert.equal(again.token, 1)
})

test('checkpoints need the holder, its secret and token; a lapsed claim is taken over and resumes from the last checkpoint', async () => {
  const { token } = (await work(codex, { op: 'claim', ref: 'gh#3', holder: 'sandbox-1', runtime: 'workers-sandbox', secret: SANDBOX })).json as unknown as Claimed
  const point = { op: 'checkpoint', ref: 'gh#3', secret: SANDBOX, token, text: 'parser done', branch: 'work/gh-3', commit: 'abc123', notes: 'notes/gh-3.md' }
  assert.equal((await work(codex, { ...point, secret: LAPTOP })).status, 409)
  assert.equal((await work(codex, { ...point, token: token + 1 })).status, 409)
  assert.equal((await work(adam, point)).status, 409)
  assert.equal((await work(codex, point)).status, 200)
  assert.equal((await work(codex, { op: 'beat', ref: 'gh#3', secret: SANDBOX, token })).status, 200)
  await wait(LEASE_MS + 100)
  // The sandbox died: its lease lapsed, and it is lost even to its holder.
  assert.equal((await work(codex, { op: 'beat', ref: 'gh#3', secret: SANDBOX, token })).status, 409)
  const listed = (await work(reader, { op: 'list' })).json as { claims: { ref: string; state: string }[] }
  assert.equal(listed.claims.find(c => c.ref === 'gh#3')?.state, 'lapsed')
  const taken = (await work(adam, { op: 'claim', ref: 'gh#3', holder: 'tui', runtime: 'tui', secret: LAPTOP })).json as unknown as Claimed
  assert.equal(taken.tookOver, true)
  assert.equal(taken.token, token + 1)
  assert.deepEqual([taken.resume.branch, taken.resume.commit, taken.resume.notes], ['work/gh-3', 'abc123', 'notes/gh-3.md'])
  assert.deepEqual(taken.resume.steps.map(s => s.kind), ['claimed', 'checkpoint', 'interrupted', 'claimed'])
  // The interrupted step is about the old holder, and names it: its principal, holder and runtime.
  const interrupted = taken.resume.steps[2] as unknown as Record<string, string>
  assert.deepEqual([interrupted.principal, interrupted.holder, interrupted.runtime], [CODEX, 'sandbox-1', 'workers-sandbox'])
  // The old holder is fenced out even with its secret; the new one finishes.
  assert.equal((await work(codex, { op: 'checkpoint', ref: 'gh#3', secret: SANDBOX, token, text: 'late' })).status, 409)
  const done = await work(adam, { op: 'release', ref: 'gh#3', secret: LAPTOP, token: taken.token, outcome: 'done', text: 'PR opened' })
  assert.equal(done.status, 200)
  assert.equal((done.json.claim as Record<string, unknown>).state, 'done')
  assert.equal((await work(codex, { op: 'claim', ref: 'gh#3', holder: 'sandbox-2', runtime: 'workers-sandbox', secret: SANDBOX })).status, 409)
  const reopened = (await work(codex, { op: 'claim', ref: 'gh#3', holder: 'sandbox-2', runtime: 'workers-sandbox', secret: SANDBOX, reopen: true })).json as unknown as Claimed
  assert.equal(reopened.tookOver, false)
  assert.equal(reopened.resume.steps.at(-1)?.kind, 'reopened')
})

test('release needs an outcome; a paused claim is resumed by anyone with operate; list filters by state', async () => {
  const { token } = (await work(adam, { op: 'claim', ref: 'td2do:abcd', holder: 'vps', runtime: 'hetzner-vps', secret: LAPTOP })).json as unknown as Claimed
  assert.equal((await work(adam, { op: 'release', ref: 'td2do:abcd', secret: LAPTOP, token, outcome: 'gone' })).status, 400)
  assert.equal((await work(adam, { op: 'release', ref: 'td2do:abcd', secret: LAPTOP, token, outcome: 'paused' })).status, 200)
  const resumed = (await work(codex, { op: 'claim', ref: 'td2do:abcd', holder: 'cloud', runtime: 'claude-cloud', secret: SANDBOX })).json as unknown as Claimed
  assert.equal(resumed.tookOver, false)
  assert.equal(resumed.resume.steps.at(-1)?.kind, 'resumed')
  const active = (await work(reader, { op: 'list', state: 'active' })).json as { claims: { ref: string; lastStep: unknown; steps?: unknown }[] }
  assert.ok(active.claims.some(c => c.ref === 'td2do:abcd'))
  assert.ok(active.claims.every(c => c.steps === undefined && c.lastStep !== undefined))
})

test('a branch git would refuse, such as an option-shaped one, is 400 on claim and checkpoint', async () => {
  for (const branch of ['--force', '-b', 'a..b', 'x.lock', 'has space']) {
    assert.equal((await work(adam, { op: 'claim', ref: 'gh#20', holder: 'tui', runtime: 'tui', secret: LAPTOP, branch })).status, 400)
  }
  const { token } = (await work(adam, { op: 'claim', ref: 'gh#20', holder: 'tui', runtime: 'tui', secret: LAPTOP, branch: 'work/gh-20' })).json as unknown as Claimed
  assert.equal((await work(adam, { op: 'checkpoint', ref: 'gh#20', secret: LAPTOP, token, text: 't', branch: '--orphan=x' })).status, 400)
  assert.equal((await work(adam, { op: 'checkpoint', ref: 'gh#20', secret: LAPTOP, token, text: 't', branch: 'work/gh-20b' })).status, 200)
})

test('only an admin person deletes a claim', async () => {
  await work(codex, { op: 'claim', ref: 'gh#21', holder: 'sandbox-1', runtime: 'workers-sandbox', secret: SANDBOX })
  assert.equal((await work(codex, { op: 'deleteClaim', ref: 'gh#21' })).status, 403)
  assert.equal((await work(adam, { op: 'deleteClaim', ref: 'gh#21' })).status, 200)
  assert.equal((await work(reader, { op: 'get', ref: 'gh#21' })).status, 404)
})

test('only an admin person breaks a claim; it is paused and logged', async () => {
  await work(codex, { op: 'claim', ref: 'gh#5', holder: 'sandbox-1', runtime: 'workers-sandbox', secret: SANDBOX })
  assert.equal((await work(codex, { op: 'breakClaim', ref: 'gh#5' })).status, 403)
  const broken = await work(adam, { op: 'breakClaim', ref: 'gh#5' })
  assert.equal(broken.status, 200)
  assert.equal((broken.json.claim as Record<string, unknown>).state, 'paused')
  assert.equal((await work(adam, { op: 'claim', ref: 'gh#5', holder: 'tui', runtime: 'tui', secret: LAPTOP })).status, 200)
})

test('a claim untouched for its retention is deleted whatever its state, so junk never fills the board', async () => {
  const { token } = (await work(adam, { op: 'claim', ref: 'gh#9', holder: 'tui', runtime: 'tui', secret: LAPTOP })).json as unknown as Claimed
  await work(adam, { op: 'release', ref: 'gh#9', secret: LAPTOP, token, outcome: 'done' })
  const paused = (await work(adam, { op: 'claim', ref: 'gh#10', holder: 'tui', runtime: 'tui', secret: LAPTOP })).json as unknown as Claimed
  await work(adam, { op: 'release', ref: 'gh#10', secret: LAPTOP, token: paused.token, outcome: 'paused' })
  await work(adam, { op: 'claim', ref: 'gh#11', holder: 'tui', runtime: 'tui', secret: LAPTOP })
  assert.equal((await work(reader, { op: 'get', ref: 'gh#9' })).status, 200)
  await wait(RETENTION_MS + 500)
  for (const ref of ['gh#9', 'gh#10', 'gh#11']) assert.equal((await work(reader, { op: 'get', ref })).status, 404, ref)
})

test('an unknown op is 400 and no caller reaches the board without a verified identity', async () => {
  assert.equal((await work(adam, { op: 'nope', ref: 'gh#1' })).status, 400)
  assert.equal((await call(undefined, { op: 'list' }, PATH)).status, 401)
  assert.equal((await call(adam, { op: 'list' }, '/v1/owner/repo/work/extra')).status, 404)
})
