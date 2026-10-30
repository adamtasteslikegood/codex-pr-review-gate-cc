import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import { isLinked, isLinkOwed, isReverifyOwed, mergeHolds, newRecord, verificationOwed } from '../hooks/lifecycle'
import { RELAY_TIMEOUT_MS } from '../hooks/relay'
import { forgetOptIns, HELD_PLACEHOLDER, loadRecord, OPT_IN_TTL_MS, recordKey, redact, RelayRefused, restore, saveRecord, StaleRecord, transact, updateRecord, upsertRecord } from '../hooks/store'
import type { Finding, LifecycleRecord, LogEntry } from '../types'
import { PRINCIPALS } from './contract'
import { fakeRelay, HEADERS_OF } from './relay-fake'
import type { FakeRelay } from './relay-fake'
import { createPr, done, P1, review, runOf, turn, world } from './world'
import type { World } from './world'

const URL_ = 'https://relay.example.org'
const SHARED = JSON.stringify({ sharedStore: { url: URL_, aud: 'aud-tag' } })
/** world's origin is github.com/me/repo, so the store names that slug. */
const SLUG = 'me/repo'
const OBJECT = `${SLUG}@feat/x`
const PATH = `/v1/${SLUG}/branch/feat%2Fx`
const KEY = recordKey('/repo', 'feat/x')
const PLACEHOLDER = '[security finding: text kept by the checkout that found it]'
const { ADAM, CODEX } = PRINCIPALS

type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

/**
 * The mod's own engine, as the store sees it, over world's fake git and store and the test's mocked clock (relay.test.ts has the same
 * stand-in). `onSend` sees each call's body before it reaches the fake: a test delays or counts one there.
 */
function engineOf(w: World, fetch: Fetch, env: Record<string, string> = { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ }, onSend?: (body: Record<string, unknown>) => void): never {
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
    http: {
      fetch: (url: string, init?: HttpInit) => {
        onSend?.(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
        return fetch(url, init)
      },
    },
    env: { get: async (name: string) => env[name] },
    session: { id: async () => w.sessionId },
  } as never
}

type Setup = { w: World; fake: FakeRelay; $: never; sends: Record<string, unknown>[]; onSend: { fn?: (body: Record<string, unknown>) => void } }

/** A repo that opts in on its base, Adam's token in the environment, and his grant (and Codex's) on me/repo. */
function setup(on: Parameters<typeof world>[0]): Setup {
  // Each test is its own repo: no answer about the base's opt-in is kept from another.
  forgetOptIns()
  const w = world(on)
  w.git.roster = SHARED
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate', [CODEX]: 'operate' } } })
  const sends: Record<string, unknown>[] = []
  const onSend: Setup['onSend'] = {}
  const $ = engineOf(w, fake.fetch, undefined, body => {
    sends.push(body)
    onSend.fn?.(body)
  })
  return { w, fake, $, sends, onSend }
}

const seed = (extra: Partial<LifecycleRecord> = {}): LifecycleRecord => ({
  ...newRecord({ root: '/repo', branch: 'feat/x', base: 'dev', head: 'a'.repeat(40), tier: 'standard', tierWhy: 'x', lane: 'full', allowance: 4, at: 1 }),
  ...extra,
})

const finding = (id: string, title: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  round: 1,
  source: 'codex-review',
  reviewer: 'codex',
  severity: 'P1',
  title,
  headSeen: 'a'.repeat(40),
  status: 'open',
  history: [],
  ...extra,
})

const SECRET: Finding = finding('R1-1', 'SECRET-TITLE sql injection', {
  isSecurity: true,
  detail: 'SECRET-DETAIL the query concatenates',
  note: 'SECRET-NOTE',
  file: 'src/SECRET-FILE.ts',
  line: 12,
  url: 'https://example.org/SECRET-URL',
  history: [{ round: 1, status: 'open', note: 'SECRET-HISTORY', by: 'codex', at: 1 }],
  jiraSummaries: ['KAN: SECRET-JIRA summary'],
})
const SECRET_TEXT = ['SECRET-TITLE', 'SECRET-DETAIL', 'SECRET-NOTE', 'SECRET-FILE', 'SECRET-URL', 'SECRET-HISTORY', 'SECRET-JIRA']

/** Every string anywhere under `value`. */
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(stringsOf)
        : []

const grant = (reason: string) => (rec: LifecycleRecord): LifecycleRecord => ({ ...rec, grants: [...rec.grants, { n: 1, reason, head: rec.head, at: 1 }] })
const reasons = (rec: unknown): string[] => ((rec as LifecycleRecord | undefined)?.grants ?? []).map(one => one.reason)
const titles = (rec: unknown): string[] => ((rec as LifecycleRecord | undefined)?.findings ?? []).map(one => one.title)
const relayed = (fake: FakeRelay): LifecycleRecord => fake.objects.get(OBJECT)?.record as LifecycleRecord
const local = (w: World): LifecycleRecord => w.store.get(KEY) as LifecycleRecord
const linesOf = (rec: LifecycleRecord, start: string): LogEntry[] => (rec.log ?? []).filter(one => one.text.startsWith(start))
const opsOf = (fake: FakeRelay, op: string): Record<string, unknown>[] =>
  fake.calls.map(one => one.body as Record<string, unknown>).filter(body => body.op === op)

/** Another checkout (Codex's service) commits the relay's record, changed by `change`, at its current rev. */
async function otherCommits(fake: FakeRelay, change: (rec: LifecycleRecord) => LifecycleRecord): Promise<void> {
  const s = fake.objects.get(OBJECT)
  const body = { op: 'commit', rev: s?.rev ?? 0, record: change(s?.record as LifecycleRecord) }
  const res = await fake.fetch(`${URL_}${PATH}`, { method: 'POST', headers: { ...HEADERS_OF.CODEX, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(res.status).toBe(200)
}

/** The test's clock, as the store reads it. */
const nowOf = (w: World): number => (w.clock as unknown as MockClock).now()

const thrown = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error)

test('a pure update retries once on 409, against the returned record', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await saveRecord($, seed())
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  let runs = 0
  const got = await updateRecord($, '/repo', 'feat/x', async rec => {
    runs += 1
    // A second writer lands between this read and its commit.
    if (runs === 1) await otherCommits(fake, grant('theirs'))
    return grant('mine')(rec)
  }, { isPure: true })
  expect(runs).toBe(2)
  expect(reasons(got)).toEqual(['theirs', 'mine'])
  expect(fake.objects.get(OBJECT)?.rev).toBe(3)
  expect(reasons(relayed(fake))).toEqual(['theirs', 'mine'])
  // The retry ran against the 409's record: the seed sent no read, and the update one only.
  expect(opsOf(fake, 'read')).toHaveLength(1)
  expect(local(w).relayRev).toBe(3)
})

test('a transact whose work ran git is not retried: it throws StaleRecord', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed())
  let runs = 0
  const error = await thrown(transact($, '/repo', 'feat/x', async tx => {
    runs += 1
    const rec = await tx.load()
    await otherCommits(fake, grant('theirs'))
    await tx.save(grant('mine')(rec!))
  }))
  expect(error).toBeInstanceOf(StaleRecord)
  expect((error as StaleRecord).rev).toBe(2)
  expect(reasons((error as StaleRecord).record)).toEqual(['theirs'])
  expect(runs).toBe(1)
  // updateRecord without isPure is not retried either, and saveRecord throws.
  runs = 0
  const again = await thrown(updateRecord($, '/repo', 'feat/x', async rec => {
    runs += 1
    await otherCommits(fake, grant('again'))
    return grant('mine')(rec)
  }))
  expect(again).toBeInstanceOf(StaleRecord)
  expect(runs).toBe(1)
  await otherCommits(fake, grant('more'))
  expect(await thrown(saveRecord($, seed()))).toBeInstanceOf(StaleRecord)
  expect(reasons(relayed(fake))).toEqual(['theirs', 'again', 'more'])
})

test('the last of two saves is the one committed', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed())
  await transact($, '/repo', 'feat/x', async tx => {
    const rec = (await tx.load())!
    await tx.save(grant('first')(rec))
    await tx.save(grant('second')(rec))
  })
  expect(opsOf(fake, 'commit')).toHaveLength(2)
  expect(reasons(relayed(fake))).toEqual(['second'])
  expect(fake.objects.get(OBJECT)?.rev).toBe(2)
})

test('an archive with a save is one commit carrying { at, record } with phase archived', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await saveRecord($, seed({ findings: [finding('R1-1', 'kept in the archive')] }))
  await transact($, '/repo', 'feat/x', async tx => {
    const last = (await tx.load())!
    await tx.archive(last, 5_000)
    await tx.save({ ...seed(), phase: 'archived', generation: 1 })
  })
  const commits = opsOf(fake, 'commit')
  expect(commits).toHaveLength(2)
  const archive = commits[1]?.archive as { at: number; record: LifecycleRecord }
  expect(archive.at).toBe(5_000)
  expect(archive.record.phase).toBe('archived')
  expect(titles(archive.record)).toEqual(['kept in the archive'])
  expect(commits[0]?.archive).toBeUndefined()
  expect(fake.objects.get(OBJECT)?.archives.map(one => one.at)).toEqual([5_000])
  expect(relayed(fake).generation).toBe(1)
  // The local store keeps it too, under today's archive key.
  expect(titles(w.store.get(`${KEY}:archived:5000`))).toEqual(['kept in the archive'])
})

test('every relay commit mirrors the full record locally with relayRev', async (_t, on) => {
  const { fake, $, w } = setup(on)
  const rec = seed({ findings: [SECRET] })
  delete rec.lifecycleId
  await saveRecord($, rec)
  const mirror = local(w)
  expect(mirror.relayRev).toBe(1)
  // The full record, security text included, with the slug and lifecycleId the store gave it before its first commit.
  expect(mirror.findings).toEqual([SECRET])
  expect(mirror.slug).toBe(SLUG)
  expect(typeof mirror.lifecycleId).toBe('string')
  expect(relayed(fake).lifecycleId).toBe(mirror.lifecycleId)
  expect(relayed(fake).slug).toBe(SLUG)
  expect(relayed(fake).relayRev).toBeUndefined()
  await updateRecord($, '/repo', 'feat/x', grant('two'), { isPure: true })
  expect(local(w).relayRev).toBe(2)
  expect(reasons(local(w))).toEqual(['two'])
  expect(local(w).findings).toEqual([SECRET])
})

test('relay down mid-round: the round goes on locally and the log says so once', async ($, on) => {
  forgetOptIns()
  const w = world(on)
  w.git.roster = SHARED
  mock.env(on, { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ })
  const fake = fakeRelay(on, { clock: w.clock as unknown as MockClock, grants: { [SLUG]: { [ADAM]: 'operate' } } })
  await $.tool.call(createPr)
  // The branch's object, or the PR's once the record has its number.
  const id = (): string => (local(w).pr !== undefined ? `${SLUG}#${local(w).pr}` : OBJECT)
  expect(fake.objects.get(id())?.rev).toBeGreaterThan(0)
  const rev = fake.objects.get(id())?.rev
  fake.down = true
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  // The round went on: its finding is recorded locally, and the fixer was asked.
  expect((await runOf(w)).phase).toBe('fix')
  expect(titles(local(w))).toEqual([P1.title])
  expect(local(w).relayRev).toBe(rev)
  expect(linesOf(local(w), 'relay down')).toHaveLength(1)
  expect(linesOf(local(w), 'relay down')[0]?.kind).toBe('session')
  w.git.head = 'd'.repeat(40)
  await done($, turn(`Fixed.\nPR-GATE-RESULT\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }] })}`))
  expect(linesOf(local(w), 'relay down')).toHaveLength(1)
  expect(fake.objects.get(id())?.rev).toBe(rev)
})

test('recovery when nobody else wrote: the local changes are committed at relayRev', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await saveRecord($, seed())
  fake.down = true
  await updateRecord($, '/repo', 'feat/x', grant('offline'), { isPure: true })
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  expect(local(w).relayRev).toBe(1)
  expect(reasons(local(w))).toEqual(['offline'])
  fake.down = false
  // A change that writes nothing still sends the local changes up.
  await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(fake.objects.get(OBJECT)?.rev).toBe(2)
  expect(reasons(relayed(fake))).toEqual(['offline'])
  expect(linesOf(relayed(fake), 'relay down')).toHaveLength(1)
  expect(local(w).relayRev).toBe(2)
  expect(opsOf(fake, 'snapshot')).toEqual([])
  await updateRecord($, '/repo', 'feat/x', grant('back'), { isPure: true })
  expect(reasons(relayed(fake))).toEqual(['offline', 'back'])
  expect(fake.objects.get(OBJECT)?.rev).toBe(3)
})

test('recovery when the relay moved on: relay record and rev unchanged, local findings kept in the local archive and in a snapshot', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await saveRecord($, seed({ findings: [finding('R1-1', 'both had this')] }))
  fake.down = true
  await updateRecord($, '/repo', 'feat/x', rec => ({ ...rec, findings: [...rec.findings, finding('R1-2', 'LOCAL-ONLY found offline')] }), { isPure: true })
  fake.down = false
  await otherCommits(fake, rec => ({ ...rec, findings: [...rec.findings, finding('R1-2', 'RELAY-ONLY found by the other checkout')] }))
  const before = JSON.stringify(fake.objects.get(OBJECT)?.record)
  await w.clock.advance(1_000)
  const at = nowOf(w)
  const got = await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  // The relay's record wins and is never overwritten.
  expect(fake.objects.get(OBJECT)?.rev).toBe(2)
  expect(JSON.stringify(fake.objects.get(OBJECT)?.record)).toBe(before)
  expect(titles(got)).toEqual(['both had this', 'RELAY-ONLY found by the other checkout'])
  expect(titles(local(w))).toEqual(['both had this', 'RELAY-ONLY found by the other checkout'])
  expect(local(w).relayRev).toBe(2)
  // The local record is kept twice: locally first, then in the relay's archives by snapshot.
  expect(titles(w.store.get(`${KEY}:archived:${at}`))).toEqual(['both had this', 'LOCAL-ONLY found offline'])
  const snapshots = opsOf(fake, 'snapshot')
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]?.reason).toBe('fallback')
  expect(titles(snapshots[0]?.record)).toEqual(['both had this', 'LOCAL-ONLY found offline'])
  expect(fake.objects.get(OBJECT)?.archives.map(one => one.reason)).toEqual(['fallback'])
  expect(linesOf(local(w), 'relay moved on')).toHaveLength(1)
})

test('a commit that timed out but was applied: recovery keeps the relay\'s record and snapshots the local one, losing nothing', async (_t, on) => {
  const { fake, $, w, onSend } = setup(on)
  await saveRecord($, seed())
  // The commit reaches the relay a second after the client gave up on it.
  let sent: () => void = () => undefined
  const isSent = new Promise<void>(resolve => {
    sent = resolve
  })
  onSend.fn = body => {
    if (body.op !== 'commit') return
    fake.delayNext(RELAY_TIMEOUT_MS + 1_000)
    sent()
  }
  const pending = updateRecord($, '/repo', 'feat/x', rec => ({ ...grant('sent')(rec), findings: [finding('R1-1', 'LOST-ANSWER finding')] }), { isPure: true })
  await isSent
  await w.clock.advance(RELAY_TIMEOUT_MS)
  await pending
  onSend.fn = undefined
  expect(local(w).relayRev).toBe(1)
  expect(linesOf(local(w), 'relay down')).toHaveLength(1)
  await w.clock.advance(1_000)
  // The relay applied it after all.
  expect(fake.objects.get(OBJECT)?.rev).toBe(2)
  const before = JSON.stringify(fake.objects.get(OBJECT)?.record)
  const at = nowOf(w)
  await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(fake.objects.get(OBJECT)?.rev).toBe(2)
  expect(JSON.stringify(fake.objects.get(OBJECT)?.record)).toBe(before)
  expect(titles(relayed(fake))).toEqual(['LOST-ANSWER finding'])
  expect(titles(w.store.get(`${KEY}:archived:${at}`))).toEqual(['LOST-ANSWER finding'])
  const snapshots = opsOf(fake, 'snapshot')
  expect(snapshots.map(one => one.reason)).toEqual(['fallback'])
  expect(titles(snapshots[0]?.record)).toEqual(['LOST-ANSWER finding'])
  expect(reasons(local(w))).toEqual(['sent'])
  expect(local(w).relayRev).toBe(2)
})

test('migration into an empty object pushes the local record', async (_t, on) => {
  const { fake, $, w } = setup(on)
  const rec = seed({ findings: [finding('R1-1', 'from before the relay')] })
  delete rec.lifecycleId
  // Written while the repo did not opt in: no relayRev, no slug.
  w.store.set(KEY, rec)
  await updateRecord($, '/repo', 'feat/x', grant('first change'), { isPure: true })
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  expect(titles(relayed(fake))).toEqual(['from before the relay'])
  expect(reasons(relayed(fake))).toEqual(['first change'])
  expect(typeof relayed(fake).lifecycleId).toBe('string')
  expect(local(w).lifecycleId).toBe(relayed(fake).lifecycleId)
  expect(local(w).relayRev).toBe(1)
  expect(opsOf(fake, 'snapshot')).toEqual([])
})

test('migration into a non-empty object adopts the relay\'s, archives and snapshots the local one', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await otherCommits(fake, () => seed({ lifecycleId: 'relay-lifecycle', findings: [finding('R1-1', 'RELAY-ONLY')] }))
  w.store.set(KEY, seed({ lifecycleId: 'local-lifecycle', findings: [finding('R1-1', 'LOCAL-ONLY')] }))
  const at = nowOf(w)
  const got = await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(titles(got)).toEqual(['RELAY-ONLY'])
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  expect(titles(relayed(fake))).toEqual(['RELAY-ONLY'])
  expect(local(w).lifecycleId).toBe('relay-lifecycle')
  expect(local(w).relayRev).toBe(1)
  expect(titles(w.store.get(`${KEY}:archived:${at}`))).toEqual(['LOCAL-ONLY'])
  const snapshots = opsOf(fake, 'snapshot')
  expect(snapshots.map(one => one.reason)).toEqual(['migration'])
  expect(titles(snapshots[0]?.record)).toEqual(['LOCAL-ONLY'])
  expect(linesOf(local(w), 'relay migration')).toHaveLength(1)
})

test('no security finding\'s text reaches the relay, in any field of any commit, archive or snapshot', async (_t, on) => {
  const { fake, $, w } = setup(on)
  const at = 1
  const plain = finding('R1-10', 'plain finding')
  // A plain finding whose words quote R1-1's detail, and whose history names it (PR #54 G1-3).
  const quoting = finding('G1-2', 'another plain finding', {
    source: 'github',
    reviewer: 'alice',
    detail: `same as ${SECRET.detail}`,
    history: [{ round: 1, status: 'rebutted', note: 'see R1-1', by: 'agent', at: 2 }],
  })
  // The text a MERGE_SECURITY block, a round's outstanding, a log line, a waiver's and a grant's reason carry: each names R1-1.
  const named = `${SECRET.id} [${SECRET.severity}] ${SECRET.title}`
  const leaky = seed({
    lifecycleId: 'L1',
    findings: [SECRET, plain, quoting],
    message: `Merge held for security: ${named}`,
    rounds: [{ outstanding: `R1-1 still open`, evidence: [] } as unknown as LifecycleRecord['rounds'][number]],
    log: [
      { at, kind: 'stop', text: `stopped on ${named}` },
      { at, kind: 'session', text: 'a line about src/SECRET-FILE.ts' },
      { at, kind: 'session', text: 'filed KAN: SECRET-JIRA summary' },
      { at, kind: 'session', text: 'R1-10 is plain and stays' },
    ],
    waivers: [{ scope: 'finding', findingId: 'R1-1', head: 'a'.repeat(40), reason: 'accepted: SECRET-DETAIL the query concatenates', by: 'adam', at }],
    grants: [{ n: 1, reason: 'one more round for R1-1', head: 'a'.repeat(40), at }],
  })
  // A commit, a commit carrying an archive, a fallback, and the snapshot its recovery sends.
  await saveRecord($, leaky)
  await transact($, '/repo', 'feat/x', async tx => {
    const last = (await tx.load())!
    await tx.archive(last, 7)
    await tx.save({ ...last, generation: 1 })
  })
  fake.down = true
  await updateRecord($, '/repo', 'feat/x', grant('offline'), { isPure: true })
  fake.down = false
  await otherCommits(fake, grant('theirs'))
  await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  const bodies = fake.calls.map(one => one.body as Record<string, unknown>).filter(body => body.op === 'commit' || body.op === 'snapshot')
  expect(bodies.map(one => [one.op, one.archive !== undefined])).toEqual([['commit', false], ['commit', true], ['commit', false], ['snapshot', false]])
  const isId = /(?<![A-Za-z0-9_-])R1-1(?![A-Za-z0-9_-])/
  for (const body of bodies) {
    const strings = stringsOf(body)
    for (const secret of SECRET_TEXT) expect(strings.filter(one => one.includes(secret))).toEqual([])
    // The id is shared on the finding and as a waiver's reference, and in no text.
    expect(strings.filter(one => one !== 'R1-1' && isId.test(one))).toEqual([])
    expect(strings).toContain(PLACEHOLDER)
    expect(strings).toContain(HELD_PLACEHOLDER)
    expect(strings).toContain('plain finding')
    expect(strings).toContain('R1-10 is plain and stays')
  }
  // The record's own fields, as the first commit sent them: each string that named R1-1 is held whole; a reference stays.
  const sent = bodies[0]?.record as LifecycleRecord
  expect(sent.message).toBe(HELD_PLACEHOLDER)
  expect(sent.rounds[0]?.outstanding).toBe(HELD_PLACEHOLDER)
  expect((sent.log ?? []).map(one => one.text)).toEqual([HELD_PLACEHOLDER, HELD_PLACEHOLDER, HELD_PLACEHOLDER, 'R1-10 is plain and stays'])
  expect(sent.waivers[0]).toEqual({ ...leaky.waivers[0], reason: HELD_PLACEHOLDER })
  expect(sent.grants[0]?.reason).toBe(HELD_PLACEHOLDER)
  expect(sent.branch).toBe('feat/x')
  expect(sent.findings[2]).toEqual({ ...quoting, detail: HELD_PLACEHOLDER, history: [{ ...quoting.history[0]!, note: HELD_PLACEHOLDER }] })
  // The sent shape is R(b)'s: no detail, note, file, line, url or Jira summary, and a history without its notes (PR #54 G1-2).
  expect(sent.findings[0]).toEqual({
    id: 'R1-1', round: 1, source: 'codex-review', reviewer: 'codex', severity: 'P1', isSecurity: true, headSeen: 'a'.repeat(40), status: 'open',
    history: [{ round: 1, status: 'open', by: 'codex', at: 1 }], title: PLACEHOLDER, ref: 'local',
  })
  // Locally, the text is all still there.
  expect(local(w).findings[0]).toEqual(SECRET)
  expect(local(w).findings[2]).toEqual(quoting)
  expect(restore(sent, leaky).findings).toEqual(leaky.findings)
})

test('a security finding\'s control fields survive the relay: another checkout still holds the merge on a recheck owed and an unchecked link (PR #54 G1-2)', async () => {
  const owed = finding('R1-1', 'SECRET-TITLE long enough to be a needle', { isSecurity: true, status: 'verified-fixed', needsRecheck: true })
  const link = finding('G2-1', 'a second report of SECRET-TITLE long enough to be a needle', {
    source: 'github', reviewer: 'alice', isSecurity: true, duplicateOf: 'R1-1', linkBy: 'agent',
  })
  const mirror = seed({ lifecycleId: 'L1', findings: [owed, link] })
  // Another checkout has no mirror of it: what it reads is the relay's record alone.
  const theirs = restore(redact(mirror), undefined)
  expect(theirs.findings.map(one => [one.id, one.status, one.needsRecheck, one.linkBy, one.isLinkChecked])).toEqual([
    ['R1-1', 'verified-fixed', true, undefined, undefined],
    ['G2-1', 'open', undefined, 'agent', undefined],
  ])
  expect(isReverifyOwed(theirs.findings[0]!)).toBe(true)
  expect(isLinked(theirs.findings[1]!)).toBe(false)
  expect(isLinkOwed(theirs.findings[1]!)).toBe(true)
  expect(verificationOwed(theirs).map(one => one.id)).toEqual(verificationOwed(mirror).map(one => one.id))
  expect(mergeHolds(theirs).map(one => one.id)).toEqual(mergeHolds(mirror).map(one => one.id))
  expect(mergeHolds(theirs).map(one => one.id)).toContain('R1-1')
})

test('a finding linked to a security finding is redacted with it, and restored with it', async (_t, on) => {
  const { fake, $, w } = setup(on)
  const linked = finding('G2-1', 'query in src/SECRET-FILE.ts concatenates input', {
    source: 'github',
    reviewer: 'alice',
    file: 'src/SECRET-FILE.ts',
    detail: 'LINKED-DETAIL the caller passes raw input',
    duplicateOf: 'R1-1',
  })
  const texts = [...SECRET_TEXT, 'query in src/SECRET-FILE.ts concatenates input', 'LINKED-DETAIL']
  await saveRecord($, seed({ lifecycleId: 'L1', findings: [SECRET, linked], log: [{ at: 1, kind: 'session', text: `linked ${linked.title}` }] }))
  fake.down = true
  await updateRecord($, '/repo', 'feat/x', grant('offline'), { isPure: true })
  fake.down = false
  await otherCommits(fake, grant('theirs'))
  await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  const bodies = fake.calls.map(one => one.body as Record<string, unknown>).filter(body => body.op === 'commit' || body.op === 'snapshot')
  expect(bodies.map(one => one.op)).toEqual(['commit', 'commit', 'snapshot'])
  for (const body of bodies) {
    const strings = stringsOf(body)
    for (const text of texts) expect(strings.filter(one => one.includes(text))).toEqual([])
  }
  const sent = (bodies[0]?.record as LifecycleRecord).findings[1]
  expect(sent).toEqual({ id: 'G2-1', round: 1, source: 'github', reviewer: 'alice', severity: 'P1', headSeen: 'a'.repeat(40), status: 'open', duplicateOf: 'R1-1', history: [], title: PLACEHOLDER, ref: 'local' })
  // This checkout, of the same lifecycle, has both back whole; the relay keeps the placeholders.
  expect(local(w).findings.map(one => one.title)).toEqual([SECRET.title, linked.title])
  expect(local(w).findings[1]?.detail).toBe(linked.detail)
  expect(titles(relayed(fake))).toEqual([PLACEHOLDER, PLACEHOLDER])
  const mirror = seed({ lifecycleId: 'L1', findings: [SECRET, linked] })
  expect(restore(redact(mirror), mirror).findings).toEqual(mirror.findings)
  expect(restore(redact(mirror), { ...mirror, lifecycleId: 'L2' }).findings.map(one => one.title)).toEqual([PLACEHOLDER, PLACEHOLDER])
})

test('the scrub leaves fixed-value fields alone and cuts free text only', async () => {
  const short = finding('R1-1', 'SECRET-TITLE long enough to be a needle', { isSecurity: true, note: 'check', file: 'a.ts' })
  const rec = seed({
    lifecycleId: 'L1',
    findings: [short],
    log: [
      { at: 1, kind: 'check', text: 'check passed' },
      { at: 2, kind: 'session', text: 'saw SECRET-TITLE long enough to be a needle again' },
    ],
  })
  const sent = redact(rec)
  expect(sent.log).toEqual([{ at: 1, kind: 'check', text: 'check passed' }, { at: 2, kind: 'session', text: HELD_PLACEHOLDER }])
  expect(sent.phase).toBe(rec.phase)
  expect(sent.lane).toBe(rec.lane)
  expect(sent.head).toBe(rec.head)
  expect(sent.branch).toBe('feat/x')
})

test('a FIXED_KEYS field that names a security finding is kept, and a free-text field that names it is scrubbed (R107)', async () => {
  const secret = finding('R1-1', 'SECRET-TITLE long enough to be a needle', { isSecurity: true })
  const rec = seed({
    lifecycleId: 'L1',
    findings: [secret],
    log: [
      // `kind` and `by` are FIXED_KEYS: a needle that matched them would corrupt the record, so they pass as they are.
      { at: 1, kind: `stop on ${secret.id}`, by: secret.title, text: `fix ${secret.id} first` } as never,
      { at: 2, kind: 'session', text: `saw ${secret.title}` },
    ],
  })
  const sent = redact(rec)
  expect(sent.log).toEqual([
    { at: 1, kind: `stop on ${secret.id}`, by: secret.title, text: HELD_PLACEHOLDER },
    { at: 2, kind: 'session', text: HELD_PLACEHOLDER },
  ])
})

test('restore puts text back into findings only, and the mirror of an own commit keeps every field whole', async (_t, on) => {
  const { $, w } = setup(on)
  const full = seed({ lifecycleId: 'L1', findings: [SECRET], message: `held: ${SECRET.title}`, log: [{ at: 1, kind: 'stop', text: `on ${SECRET.id}` }] })
  await saveRecord($, full)
  expect(local(w).message).toBe(full.message)
  expect(local(w).log).toEqual(full.log)
  const back = restore(redact(full), full)
  expect(back.findings).toEqual(full.findings)
  expect(back.message).toBe(HELD_PLACEHOLDER)
  expect(back.log?.[0]?.text).toBe(HELD_PLACEHOLDER)
  // No finding field takes the other placeholder, and no text is made up outside the findings.
  expect(stringsOf(back.findings).filter(one => one === HELD_PLACEHOLDER)).toEqual([])
  expect(stringsOf({ ...back, findings: [] }).filter(one => SECRET_TEXT.some(secret => one.includes(secret)))).toEqual([])
})

test('a redacted finding is restored from the local mirror on load, and one found by another checkout shows the placeholder title', async (_t, on) => {
  const { fake, $ } = setup(on)
  await saveRecord($, seed({ lifecycleId: 'L1', findings: [SECRET] }))
  // The other checkout raises its own security finding, and rules on ours.
  await otherCommits(fake, rec => ({
    ...rec,
    findings: [
      { ...rec.findings[0]!, status: 'verified-fixed' },
      { id: 'G2-1', round: 2, source: 'github', reviewer: 'alice', severity: 'P0', isSecurity: true, headSeen: 'b'.repeat(40), status: 'open', title: PLACEHOLDER, ref: 'local' } as unknown as Finding,
    ],
  }))
  const got = await transact($, '/repo', 'feat/x', tx => tx.load())
  const [ours, theirs] = got?.findings ?? []
  expect(ours?.title).toBe(SECRET.title)
  expect(ours?.detail).toBe(SECRET.detail)
  expect(ours?.status).toBe('verified-fixed')
  expect(ours?.ref).toBeUndefined()
  expect(theirs?.title).toBe(PLACEHOLDER)
  expect(theirs?.ref).toBe('local')
  expect(theirs?.history).toEqual([])
})

test('restore needs the same lifecycle', async () => {
  const mirror = seed({ lifecycleId: 'L1', findings: [{ ...SECRET, id: 'G1-1' }] })
  const placeholder = { id: 'G1-1', round: 1, source: 'github', reviewer: 'bob', severity: 'P1', isSecurity: true, headSeen: 'c'.repeat(40), status: 'rebutted', title: PLACEHOLDER, ref: 'local' } as unknown as Finding
  const other = restore(seed({ lifecycleId: 'L2', findings: [placeholder] }), mirror)
  expect(other.findings[0]?.title).toBe(PLACEHOLDER)
  expect(other.findings[0]?.history).toEqual([])
  for (const secret of SECRET_TEXT) expect(JSON.stringify(other).includes(secret)).toBe(false)
  const same = restore(seed({ lifecycleId: 'L1', findings: [placeholder] }), mirror)
  expect(same.findings[0]?.title).toBe(SECRET.title)
  expect(same.findings[0]?.detail).toBe(SECRET.detail)
  expect(same.findings[0]?.url).toBe(SECRET.url)
  expect(same.findings[0]?.status).toBe('rebutted')
  expect(same.findings[0]?.reviewer).toBe('bob')
  expect(restore(seed({ lifecycleId: 'L1', findings: [placeholder] }), undefined).findings[0]?.title).toBe(PLACEHOLDER)
  // redact and restore are inverses for the checkout that found it.
  expect(restore(redact(mirror), mirror).findings).toEqual(mirror.findings)
})

test('a commit over the relay\'s size bound (413) keeps the lifecycle in the local store, says so once, and never throws (final review N1)', async (_t, on) => {
  const { w, fake, $ } = setup(on)
  await saveRecord($, seed({ lifecycleId: 'L1' }))
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  fake.bodyMax = 4 * 1024
  const big = { ...local(w), message: 'x'.repeat(8 * 1024) }
  await saveRecord($, big)
  await saveRecord($, { ...big, message: `${big.message}y` })
  expect(local(w).message).toBe(`${big.message}y`)
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  expect((local(w).log ?? []).filter(one => one.text.startsWith('relay too large'))).toHaveLength(1)
  expect((local(w).log ?? []).some(one => one.text.startsWith('relay down'))).toBe(false)
  // Once the record fits again, the relay takes it: the lifecycle was never stood down.
  fake.bodyMax = 512 * 1024
  await saveRecord($, { ...big, message: 'small again' })
  expect((fake.objects.get(OBJECT)?.record as LifecycleRecord).message).toBe('small again')
})

test('a 403 stands down: no local write, no fallback, the log says so once', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await saveRecord($, seed())
  // The grant is cut to read: reads still answer, commits are refused.
  fake.grant(ADAM, SLUG, 'read')
  const before = local(w)
  for (let n = 0; n < 2; n++) {
    const error = await thrown(updateRecord($, '/repo', 'feat/x', grant('refused'), { isPure: true }))
    expect(error).toBeInstanceOf(RelayRefused)
  }
  const after = local(w)
  expect({ ...after, log: undefined }).toEqual({ ...before, log: undefined })
  expect(linesOf(after, 'relay refused')).toHaveLength(1)
  expect(linesOf(after, 'relay refused')[0]?.kind).toBe('session')
  expect(linesOf(after, 'relay down')).toEqual([])
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  expect(reasons(relayed(fake))).toEqual([])
  // No grant at all: the read itself is refused, and nothing changes either.
  const reader = engineOf(w, fake.fetch, { PR_GATE_RELAY_TOKEN: 'reader-token', PR_GATE_RELAY_URL: URL_ })
  expect(await thrown(upsertRecord(reader, '/repo', 'feat/x', one => one && grant('x')(one), { isPure: true }))).toBeInstanceOf(RelayRefused)
  expect({ ...local(w), log: undefined }).toEqual({ ...before, log: undefined })
  expect(linesOf(local(w), 'relay refused')).toHaveLength(1)
})

test('a repo that does not opt in behaves exactly as before', async ($, on) => {
  forgetOptIns()
  const w = world(on)
  mock.env(on, { PR_GATE_RELAY_TOKEN: 'adam-token', PR_GATE_RELAY_URL: URL_ })
  let fetched = 0
  on('http.fetch', () => {
    fetched += 1
    return { value: { status: 500, ok: false, headers: {}, text: '' } }
  })
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  expect((await runOf(w)).phase).toBe('fix')
  expect(fetched).toBe(0)
  const rec = local(w)
  expect(rec.relayRev).toBeUndefined()
  expect(rec.slug).toBeUndefined()
  expect((rec.log ?? []).some(one => one.text.startsWith('relay'))).toBe(false)
  // The store's helpers, called directly, make no call either, and read the base's file at most once a minute.
  let direct = 0
  const shows: string[] = []
  const plain = engineOf(w, async () => {
    direct += 1
    throw new Error('no relay here')
  })
  const run = (plain as unknown as { process: { run: (argv: readonly string[], init?: object) => Promise<unknown> } }).process.run
  const $$ = {
    ...(plain as object),
    process: {
      run: (argv: readonly string[], init?: object) => {
        if (argv.join(' ').includes('pr-gate.json')) shows.push(argv.join(' '))
        return run(argv, init)
      },
    },
  } as never
  forgetOptIns()
  await updateRecord($$, '/repo', 'feat/x', grant('local'), { isPure: true })
  await transact($$, '/repo', 'feat/x', async tx => {
    const last = (await tx.load())!
    await tx.archive(last, 9)
    await tx.save(last)
  })
  for (let n = 0; n < 5; n++) await updateRecord($$, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(direct).toBe(0)
  expect(shows).toHaveLength(1)
  await w.clock.advance(OPT_IN_TTL_MS)
  await updateRecord($$, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(shows).toHaveLength(2)
  expect(reasons(await loadRecord($$, '/repo', 'feat/x'))).toEqual(['local'])
  expect(local(w).relayRev).toBeUndefined()
  expect(w.store.get(`${KEY}:relay-pending`)).toBeUndefined()
})

test('an opt-in that can\'t be read for a record that has been on the relay is a fallback, not plain local', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await saveRecord($, seed())
  expect(local(w).relayRev).toBe(1)
  // The base's file can't be read (git show fails), then the credential is gone: each is a fallback that keeps relayRev.
  w.git.roster = ''
  forgetOptIns()
  await updateRecord($, '/repo', 'feat/x', grant('no file'), { isPure: true })
  w.git.roster = SHARED
  forgetOptIns()
  await updateRecord(engineOf(w, fake.fetch, {}), '/repo', 'feat/x', grant('no credential'), { isPure: true })
  expect(local(w).relayRev).toBe(1)
  expect(reasons(local(w))).toEqual(['no file', 'no credential'])
  expect(w.store.get(`${KEY}:relay-pending`)).toBe(true)
  expect(linesOf(local(w), 'relay down')).toHaveLength(1)
  expect(fake.objects.get(OBJECT)?.rev).toBe(1)
  // Meanwhile the relay moved on: the fallback's writes are archived and snapshotted, never overwritten without a copy.
  await otherCommits(fake, grant('theirs'))
  await w.clock.advance(1_000)
  const at = nowOf(w)
  await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(reasons(relayed(fake))).toEqual(['theirs'])
  expect(reasons(local(w))).toEqual(['theirs'])
  expect(reasons(w.store.get(`${KEY}:archived:${at}`))).toEqual(['no file', 'no credential'])
  expect(opsOf(fake, 'snapshot').map(one => one.reason)).toEqual(['fallback'])
  expect(linesOf(local(w), 'relay moved on')).toHaveLength(1)
})

test('a snapshot the relay does not take says so in the log', async (_t, on) => {
  const { fake, $, w, onSend } = setup(on)
  await otherCommits(fake, () => seed({ lifecycleId: 'relay-lifecycle', findings: [finding('R1-1', 'RELAY-ONLY')] }))
  w.store.set(KEY, seed({ lifecycleId: 'local-lifecycle', findings: [finding('R1-1', 'LOCAL-ONLY')] }))
  onSend.fn = body => {
    fake.down = body.op === 'snapshot'
  }
  const at = nowOf(w)
  await updateRecord($, '/repo', 'feat/x', rec => rec, { isPure: true })
  expect(titles(w.store.get(`${KEY}:archived:${at}`))).toEqual(['LOCAL-ONLY'])
  expect(fake.objects.get(OBJECT)?.archives).toEqual([])
  expect(linesOf(local(w), 'relay snapshot missing')).toHaveLength(1)
  expect(linesOf(local(w), 'relay migration')).toHaveLength(1)
})

test('a save with no load that meets the relay\'s record keeps the local one from before the relay first', async (_t, on) => {
  const { fake, $, w } = setup(on)
  await otherCommits(fake, () => seed({ lifecycleId: 'relay-lifecycle', findings: [finding('R1-1', 'RELAY-ONLY')] }))
  w.store.set(KEY, seed({ lifecycleId: 'local-lifecycle', findings: [finding('R1-1', 'LOCAL-ONLY')] }))
  const at = nowOf(w)
  const error = await thrown(transact($, '/repo', 'feat/x', tx => tx.save(seed({ lifecycleId: 'local-lifecycle', findings: [finding('R1-1', 'SAVED')] }))))
  expect(error).toBeInstanceOf(StaleRecord)
  expect(titles(relayed(fake))).toEqual(['RELAY-ONLY'])
  expect(titles(w.store.get(`${KEY}:archived:${at}`))).toEqual(['LOCAL-ONLY'])
  const snapshots = opsOf(fake, 'snapshot')
  expect(snapshots.map(one => one.reason)).toEqual(['migration'])
  expect(titles(snapshots[0]?.record)).toEqual(['LOCAL-ONLY'])
  expect(titles(local(w))).toEqual(['RELAY-ONLY'])
  expect(local(w).relayRev).toBe(1)
  expect(linesOf(local(w), 'relay migration')).toHaveLength(1)
})
