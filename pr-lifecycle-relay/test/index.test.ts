// The RepoIndex (spec §9), fed by each object's outbox and alarm, its `list` op, and retention (§8). Alarms run in real time under
// Miniflare, so each test polls `list` (every 25 ms, for up to 3 s) or `read` until the change it waits for has landed. The index tests run
// with a long retention, so a branch object never vanishes under a faulted index; the retention tests run with the harness's 400 ms.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ADAM, call, person, READER, RETENTION_MS, seed, sign, start, stop } from './harness.ts'

const SECRET = 'i'.repeat(40)
let adam: string
let reader: string

/** A fresh Miniflare for one group of tests. */
const startWith = (bindings: Record<string, string>) => async () => {
  await start(bindings)
  await seed()
  adam = await sign(person(ADAM))
  reader = await sign(person(READER))
}

type Entry = { key: string; pr?: number; branch?: string; phase?: string; rev: number; lifecycleId?: string }
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const prPath = (pr: number, repo: string): string => `/v1/${repo}/${pr}`
const branchPath = (branch: string, repo: string): string => `/v1/${repo}/branch/${encodeURIComponent(branch)}`

/** The index's entries, or undefined while it does not answer 200. */
async function list(repo: string, token = adam): Promise<Entry[] | undefined> {
  const res = await call(token, { op: 'list' }, `/v1/${repo}`)
  return res.status === 200 ? (res.json.entries as Entry[]) : undefined
}

/** Polls `list` every 25 ms for up to 3 s until `isDone` holds; answers those entries and when the poll that saw them was sent. */
async function settled(repo: string, isDone: (entries: Entry[]) => boolean): Promise<{ entries: Entry[]; at: number }> {
  let last: Entry[] = []
  for (const end = Date.now() + 3000; Date.now() < end; await pause(25)) {
    const at = Date.now()
    last = (await list(repo)) ?? last
    if (isDone(last)) return { entries: last, at }
  }
  assert.fail(`the index never settled: ${JSON.stringify(last)}`)
}
const until = async (repo: string, isDone: (entries: Entry[]) => boolean): Promise<Entry[]> => (await settled(repo, isDone)).entries

/** Polls `read` every 25 ms for up to 3 s until the object is empty (deleted), and asserts it is. */
async function deleted(path: string): Promise<void> {
  for (const end = Date.now() + 3000; Date.now() < end && (await call(adam, { op: 'read' }, path)).json.rev !== 0;) await pause(25)
  assert.equal((await call(adam, { op: 'read' }, path)).json.rev, 0)
}

const keysOf = (entries: Entry[]): string[] => entries.map(one => one.key).sort()
/** Each test owns a repo of its own, so its index starts empty. */
const grantRepo = async (repo: string): Promise<void> => {
  const res = await call(adam, { op: 'grant', principal: ADAM, repo, preset: 'operate' }, '/v1/admin/grants')
  assert.equal(res.status, 200)
}
const fault = (repo: string, ms: number) => call(adam, { op: 'fault', repo, until: Date.now() + ms }, '/v1/admin/index')
const update = (repo: string, body: Record<string, unknown>) => call(adam, { op: 'update', repo, ...body }, '/v1/admin/index')

/** Commits `record` at the object's current rev and answers the new rev. */
async function commit(path: string, record: unknown, extra: Record<string, unknown> = {}): Promise<number> {
  const { rev } = (await call(adam, { op: 'read' }, path)).json as { rev: number }
  const done = await call(adam, { op: 'commit', rev, record, secret: SECRET, ...extra }, path)
  assert.equal(done.status, 200, JSON.stringify(done.json))
  return done.json.rev as number
}
const live = (lifecycleId: string, extra: Record<string, unknown> = {}) => ({ lifecycleId, phase: 'post', updatedAt: 1, ...extra })

/** A branch object holding a live record, its lease claimed, then moved to `pr`, whose object gets the record by `from`. */
async function move(repo: string, branch: string, pr: number, lifecycleId: string): Promise<void> {
  const path = branchPath(branch, repo)
  assert.equal((await call(adam, { op: 'claim', holder: 'h', secret: SECRET }, path)).status, 200)
  assert.equal((await call(adam, { op: 'moveTo', pr, secret: SECRET }, path)).status, 200)
  await commit(prPath(pr, repo), live(lifecycleId, { pr, branch }), { from: `@${branch}` })
}

describe('the index', () => {
  before(startWith({ RETENTION_MS: '600000' }))
  after(stop)

  test('list through the index matches the objects', async () => {
    const repo = 'idx/one'
    await grantRepo(repo)
    await commit(prPath(7, repo), live('L7', { pr: 7, branch: 'a' }))
    await commit(prPath(8, repo), live('L8', { pr: 8, branch: 'b' }))
    await commit(prPath(8, repo), live('L8', { pr: 8, branch: 'b', n: 2 }))
    await commit(branchPath('feat/x', repo), live('LX', { phase: 'pre' }))
    const entries = await until(repo, all => all.length === 3 && all.find(one => one.key === '#8')?.rev === 2)
    assert.deepEqual(keysOf(entries), ['#7', '#8', '@feat/x'])
    const byKey = Object.fromEntries(entries.map(one => [one.key, one]))
    assert.deepEqual([byKey['#7']!.rev, byKey['#7']!.lifecycleId, byKey['#7']!.pr], [1, 'L7', 7])
    assert.deepEqual([byKey['#8']!.rev, byKey['#8']!.lifecycleId], [2, 'L8'])
    assert.deepEqual([byKey['@feat/x']!.rev, byKey['@feat/x']!.lifecycleId, byKey['@feat/x']!.branch, byKey['@feat/x']!.phase], [1, 'LX', 'feat/x', 'pre'])
  })

  test('a failed first registration converges with no further commit (#53)', async () => {
    const repo = 'idx/two'
    await grantRepo(repo)
    // Taken before the fault is set, so the fault's own end is no earlier than this.
    const faultEnds = Date.now() + 300
    assert.equal((await fault(repo, 300)).status, 200)
    await commit(prPath(7, repo), live('L1'))
    // While the index refuses updates, nothing is listed; once it answers again, the alarm's retry lands it without another commit.
    assert.deepEqual(await list(repo), [])
    const { entries, at } = await settled(repo, all => all.length === 1)
    assert.ok(at >= faultEnds, `listed ${faultEnds - at} ms before the fault ended`)
    assert.deepEqual([entries[0]!.key, entries[0]!.rev, entries[0]!.lifecycleId], ['#7', 1, 'L1'])
  })

  test('a delayed old update never brings back a removed or older entry', async () => {
    const repo = 'idx/three'
    await grantRepo(repo)
    const entry = { key: '#5', pr: 5, branch: 'z', phase: 'post', rev: 3, updatedAt: 1, lifecycleId: 'L5' }
    assert.equal((await update(repo, { key: '#5', born: 10, rev: 3, entry })).status, 200)
    assert.equal((await update(repo, { key: '#5', born: 10, rev: 2, entry: { ...entry, rev: 2 } })).status, 200)
    assert.deepEqual((await call(adam, { op: 'list' }, `/v1/${repo}`)).json.entries, [entry])
    assert.equal((await update(repo, { key: '#5', born: 10, rev: 4, removed: true })).status, 200)
    assert.equal((await update(repo, { key: '#5', born: 10, rev: 3, entry })).status, 200)
    assert.deepEqual(await list(repo), [])
    // An older incarnation, even at a higher rev, is older still.
    assert.equal((await update(repo, { key: '#5', born: 9, rev: 50, entry: { ...entry, rev: 50 } })).status, 200)
    assert.deepEqual(await list(repo), [])
  })

  test('the move leaves only the PR entry', async () => {
    const repo = 'idx/four'
    await grantRepo(repo)
    await commit(branchPath('feat/x', repo), live('LM', { phase: 'pre' }))
    await until(repo, all => keysOf(all).join() === '@feat/x')
    await move(repo, 'feat/x', 7, 'LM')
    const entries = await until(repo, all => keysOf(all).join() === '#7')
    assert.equal(entries[0]!.lifecycleId, 'LM')
  })

  test('two branches at the same rev both register, and moving one removes only its own entry', async () => {
    const repo = 'idx/five'
    await grantRepo(repo)
    assert.equal(await commit(branchPath('a', repo), live('LA', { phase: 'pre' })), 1)
    assert.equal(await commit(branchPath('b', repo), live('LB', { phase: 'pre' })), 1)
    assert.equal((await fault(repo, 300)).status, 200)
    await move(repo, 'a', 9, 'LA')
    const entries = await until(repo, all => keysOf(all).join() === '#9,@b')
    assert.deepEqual(entries.map(one => [one.key, one.lifecycleId]).sort(), [['#9', 'LA'], ['@b', 'LB']])
  })

  test('list needs read', async () => {
    const stranger = await sign(person('nobody@example.org'))
    assert.equal((await call(stranger, { op: 'list' }, '/v1/owner/repo')).status, 403)
    assert.equal((await call(reader, { op: 'list' }, '/v1/owner/repo')).status, 200)
    assert.equal((await call(undefined, { op: 'list' }, '/v1/owner/repo')).status, 401)
    // The repo route takes `list` only: an index update never comes from outside the Worker.
    assert.equal((await call(adam, { op: 'update', key: '#1', born: 1, rev: 1, removed: true }, '/v1/owner/repo')).status, 400)
  })

  test('the fault and update routes are admin only', async () => {
    assert.equal((await call(reader, { op: 'fault', repo: 'owner/repo', until: Date.now() + 1000 }, '/v1/admin/index')).status, 403)
    assert.equal((await call(adam, { op: 'nope', repo: 'owner/repo' }, '/v1/admin/index')).status, 400)
  })

  test('owner admin is reserved: /v1/admin/... never reaches owner/repo routing', async () => {
    for (const path of ['/v1/admin/repo', '/v1/admin/repo/7', '/v1/admin/repo/branch/main', '/v1/admin/other']) {
      assert.equal((await call(adam, { op: 'read' }, path)).status, 404, path)
    }
  })
})

describe('retention', () => {
  before(startWith({}))
  after(stop)

  test('an archived PR object is deleted after RETENTION_MS', async () => {
    const repo = 'idx/six'
    await grantRepo(repo)
    const path = prPath(7, repo)
    await commit(path, live('LR'))
    await until(repo, all => all.length === 1)
    const archived = { ...live('LR'), phase: 'archived' }
    await commit(path, archived, { archive: { at: 5, record: live('LR') } })
    await until(repo, all => all.length === 0)
    // Retention runs from the archive commit, not from the object's first write.
    assert.equal((await call(adam, { op: 'read' }, path)).json.rev, 2)
    await deleted(path)
    assert.deepEqual((await call(adam, { op: 'archives' }, path)).json.archives, [])
  })

  test('a live PR object is not deleted', async () => {
    const repo = 'idx/seven'
    await grantRepo(repo)
    const path = prPath(7, repo)
    await commit(path, live('LL'))
    await pause(RETENTION_MS + 300)
    assert.equal((await call(adam, { op: 'read' }, path)).json.rev, 1)
    assert.equal((await list(repo))!.length, 1)
  })

  test('a branch object is deleted RETENTION_MS after its last write', async () => {
    const repo = 'idx/eight'
    await grantRepo(repo)
    const path = branchPath('feat/y', repo)
    await commit(path, live('LY', { phase: 'pre' }))
    await pause(RETENTION_MS * 0.75)
    // A later write moves the deadline: checked past the first deadline, with most of the second one still to run.
    await commit(path, live('LY', { phase: 'pre', n: 2 }))
    await pause(RETENTION_MS * 0.375)
    assert.equal((await call(adam, { op: 'read' }, path)).json.rev, 2)
    await deleted(path)
    await until(repo, all => all.length === 0)
  })

  test("a recreated branch is found at once, and an update from before its deletion can't replace it", async () => {
    const repo = 'idx/nine'
    await grantRepo(repo)
    const path = branchPath('x', repo)
    const before = Date.now()
    for (let n = 1; n <= 8; n++) await commit(path, live('L1', { phase: 'pre', n }))
    await until(repo, all => all[0]?.rev === 8)
    await deleted(path)
    assert.equal(await commit(path, live('L2', { phase: 'pre' })), 1)
    const entries = await until(repo, all => all[0]?.lifecycleId === 'L2')
    assert.deepEqual(entries.map(one => [one.key, one.rev, one.lifecycleId]), [['@x', 1, 'L2']])
    // `before` is no later than the old incarnation's `born`, so this is an update from before the deletion.
    const old = { key: '@x', branch: 'x', phase: 'pre', rev: 8, updatedAt: 1, lifecycleId: 'L1' }
    assert.equal((await update(repo, { key: '@x', born: before, rev: 8, entry: old })).status, 200)
    assert.deepEqual((await list(repo))!.map(one => [one.key, one.rev, one.lifecycleId]), [['@x', 1, 'L2']])
  })
})

describe('without TEST_FAULTS', () => {
  before(startWith({ TEST_FAULTS: '' }))
  after(stop)

  test('/v1/admin/index answers 404', async () => {
    assert.equal((await call(adam, { op: 'fault', repo: 'owner/repo', until: Date.now() + 1000 }, '/v1/admin/index')).status, 404)
    assert.equal((await call(adam, { op: 'update', repo: 'owner/repo', key: '#1', born: 1, rev: 1, removed: true }, '/v1/admin/index')).status, 404)
  })
})
