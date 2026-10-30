// Spec §12 and §14: the requests one active lifecycle-hour makes, counted at the Miniflare boundary. The relay runs unchanged behind a
// test-only entry (count-entry.ts) that counts each Worker request and each request every object receives: from the Worker, and from
// another object (a LifecycleObject's outbox alarm sending its index update to the RepoIndex).

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { ADAM, call, person, seed, sign, start, stop } from './harness.ts'

const SECRET = 'c'.repeat(40)
const PATH = '/v1/owner/repo/900'
const BEATS = 60
const CHANGES = 10
const LINES = 20
const FILINGS = 3
let adam: string

type Counts = { worker: number; objects: Record<string, number> }
const counts = async (op: 'count' | 'reset'): Promise<Counts> => (await call(undefined, '', `/__${op}`)).json as unknown as Counts
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** Waits until the RepoIndex has received `n` index updates in all. */
async function delivered(n: number): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    if (((await counts('count')).objects.RepoIndex ?? 0) >= n) return
    await wait(10)
  }
  assert.fail(`the RepoIndex never received index update ${n}`)
}

before(async () => {
  await start({}, 'count-entry.ts')
  await seed()
  adam = await sign(person(ADAM))
})

after(async () => {
  await stop()
})

test('one lifecycle-hour: Durable Object requests are about twice the Worker requests', async () => {
  await counts('reset')
  const ok = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const answer = await call(adam, body)
    assert.equal(answer.status, 200, `${String(body.op)}: ${JSON.stringify(answer.json)}`)
    return answer.json
  }
  const steps: { source: string; worker: number; objects: number }[] = []
  let last = await counts('count')
  const step = async (source: string, run: () => Promise<void>): Promise<void> => {
    await run()
    const now = await counts('count')
    const sum = (c: Counts) => Object.values(c.objects).reduce((a, b) => a + b, 0)
    steps.push({ source, worker: now.worker - last.worker, objects: sum(now) - sum(last) })
    last = now
  }
  // The hour, as one driving session sends it (the beats' 60 s apart is simulated: they are sent back to back).
  await step('claim', async () => void (await ok({ op: 'claim', holder: 'session-1', secret: SECRET })))
  await step(`beat × ${BEATS} (one per 60 s)`, async () => {
    for (let n = 0; n < BEATS; n++) await ok({ op: 'beat', secret: SECRET })
  })
  // A change is the client's `transact`: a `read` for the rev, then the `commit` (§12: about 2 per change).
  let rev = 0
  await step(`record change × ${CHANGES} (read + commit)`, async () => {
    for (let n = 0; n < CHANGES; n++) {
      rev = Number((await ok({ op: 'read' })).rev)
      const record = { lifecycleId: 'L1', branch: 'feat/x', phase: 'post', pr: 900, round: n }
      rev = Number((await ok({ op: 'commit', rev, record, secret: SECRET })).rev ?? rev + 1)
      // Each commit's outbox is delivered before the next: two commits inside one alarm's delay would share one delivery (the outbox
      // keeps the latest entry only), and the count below would no longer be exact.
      await delivered(n + 1)
    }
  })
  await step(`log × ${LINES}`, async () => {
    for (let n = 0; n < LINES; n++) await ok({ op: 'log', at: Date.now(), kind: 'info', text: `line ${n}`, holder: 'session-1' })
  })
  await step(`filing × ${FILINGS} (fileClaim + fileDone)`, async () => {
    for (let n = 0; n < FILINGS; n++) {
      await ok({ op: 'fileClaim', key: `L1:R1-${n}:1`, secret: SECRET })
      await ok({ op: 'fileDone', key: `L1:R1-${n}:1`, result: { number: 21 + n }, secret: SECRET })
    }
  })
  // The outbox: each commit's index update is delivered by the object's alarm, to the RepoIndex. Wait until it settles.
  await step('outbox alarms → RepoIndex (object to object)', async () => {
    let seen = -1
    for (let n = 0; n < 50; n++) {
      await wait(50)
      const now = await counts('count')
      const total = Object.values(now.objects).reduce((a, b) => a + b, 0)
      if (total === seen) break
      seen = total
    }
  })
  const end = await counts('count')
  const fromWorker = (end.objects.GrantStore ?? 0) + (end.objects.LifecycleObject ?? 0)
  const all = Object.values(end.objects).reduce((a, b) => a + b, 0)

  const rows = [
    '| Source | Worker requests | Durable Object requests |',
    '| --- | --- | --- |',
    ...steps.map(one => `| ${one.source} | ${one.worker} | ${one.objects} |`),
    `| **Total** | **${end.worker}** | **${all}** |`,
    '',
    `By object: ${Object.entries(end.objects).map(([name, n]) => `${name} ${n}`).join(', ')}.`,
    `Ratio, all object requests / Worker requests: ${(all / end.worker).toFixed(3)}; from the Worker only: ${(fromWorker / end.worker).toFixed(3)}.`,
  ]
  console.log(`\n§12 request count, one scripted lifecycle-hour (Miniflare)\n\n${rows.join('\n')}\n`)

  // Every caller request costs one Worker request and two object requests: the GrantStore lookup (R104), then the lifecycle object.
  const worker = 1 + BEATS + 2 * CHANGES + LINES + 2 * FILINGS
  assert.equal(end.worker, worker)
  assert.equal(end.objects.GrantStore, worker)
  assert.equal(end.objects.LifecycleObject, worker)
  // On top, each commit writes one outbox entry, which costs one alarm invocation of its object and one update to the RepoIndex. So the
  // object requests are exactly 2·W + 2·commits, and the ratio is 2 + 2·commits / W: 2 + 20/107 here. It passes 2.2 once commits are
  // more than a tenth of the Worker requests, as in a round-transition burst; §12's "about twice" is the floor.
  assert.equal(end.objects['LifecycleObject alarm'], CHANGES)
  assert.equal(end.objects.RepoIndex, CHANGES)
  assert.equal(all, 2 * worker + 2 * CHANGES)
  // A sanity bound for this script only, §12's estimate within 10 %; the identity above is the assertion.
  const ratio = all / end.worker
  assert.ok(ratio >= 1.8 && ratio <= 2.2, `object requests / Worker requests is ${ratio.toFixed(3)}`)
})
