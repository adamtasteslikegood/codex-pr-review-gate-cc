// The lifecycle record, kept in the plugin's store so a restart resumes it.
//
// The functions this module exports are the seam (#29 Part B): every read and write of a record, its owner and its archives goes
// through them, and a change of a live record goes through `transact`. Today's backend is the plugin's own store, with a lock per
// branch held in this process. A repo that opts in on its base keeps the record on the relay instead (#29 Part B, R102), with this
// store as its mirror and its fallback; see `transact`. (They stay function declarations: the engine follows $ only into those.)

import type { EngineInterface } from 'claude-code'

import { slugOf } from './core'
import { newLifecycleId } from './lifecycle'
import { keyPath, relayCall, relayOf } from './relay'
import type { Relay } from './relay'
import type { Finding, LifecycleRecord, LogEntry } from '../types'

type Engine = EngineInterface

/** The steps a `transact` may take on one branch's record, all inside its atomic boundary. */
export interface RecordTx {
  load(): Promise<LifecycleRecord | undefined>
  save(rec: LifecycleRecord): Promise<void>
  /** Keeps `rec` whole as an archive taken at `at` (R47); the branch's own key is left to `save`. */
  archive(rec: LifecycleRecord, at: number): Promise<void>
}

export const recordKey = (root: string, branch: string): string => `lifecycle:${root}:${branch}`

/** The lock per branch (R1-6): a promise chain per root and branch, held in this process. */
const locks = new Map<string, Promise<void>>()

async function lockRecord<T>(root: string, branch: string, work: () => Promise<T>): Promise<T> {
  const key = recordKey(root, branch)
  const held = (locks.get(key) ?? Promise.resolve()).then(work)
  const tail = held.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, tail)
  try {
    return await held
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

export async function loadRecord($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const value = (await $.store.get(recordKey(root, branch))) as LifecycleRecord | undefined | null
  return value !== null && value !== undefined && value.version === 1 ? value : undefined
}

/**
 * Every live lifecycle record under the repository's `root` (spec §5.13.4), whichever branch is checked out: the keys
 * `lifecycle:<root>:<branch>`, never an owner or an archive key (a branch name holds no ':'), and never an archived seed.
 */
export async function liveRecords($: Engine, root: string): Promise<LifecycleRecord[]> {
  const prefix = recordKey(root, '')
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes(':'))
  const found: LifecycleRecord[] = []
  for (const key of keys) {
    const value = (await $.store.get(key)) as LifecycleRecord | undefined | null
    if (value !== null && value !== undefined && value.version === 1 && value.phase !== 'archived' && recordKey(value.root, value.branch) === key) found.push(value)
  }
  return found
}

async function writeRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, updatedAt: Math.max(rec.updatedAt, await $.clock.now()) })
}

/**
 * Keeps a reset record whole under its own key (R47): `lifecycle:<root>:<branch>:archived:<at>`. `loadRecord` reads only the
 * branch's own key, so an archive is never read as the live record.
 */
async function writeArchive($: Engine, rec: LifecycleRecord, at: number): Promise<void> {
  await $.store.set(`${recordKey(rec.root, rec.branch)}:archived:${at}`, { ...rec, phase: 'archived' })
}

/** Writes the record in a transaction of its own: a seed or a test. A change that reads the record first goes through `transact`. */
export async function saveRecord($: Engine, rec: LifecycleRecord): Promise<void> {
  await transact($, rec.root, rec.branch, tx => tx.save(rec))
}

/** How a transaction runs: `isPure` says its work reads nothing but the record (no `$`, git, gh, agent or filing), so it may run twice. */
export type TxOptions = { isPure?: boolean }

/**
 * Runs `work` as one atomic change of the branch's record (R1-6): no other transaction on it interleaves, and the record is released
 * whether `work` returns or throws. Not re-entrant: `work` must not open another transaction on the same record (no `updateRecord`,
 * `advance` or `finish` inside it).
 *
 * A repo that opts in on its base (`sharedStore`) keeps the record on the relay (#29 Part B, R102): `load` reads it, `save` and
 * `archive` are held until `work` returns and sent as one commit at the revision read. A commit another writer beat (409) or a lease
 * holds off (423) runs a pure `work` once more and throws `StaleRecord` for any other. Every other repo keeps today's local store.
 */
export async function transact<T>($: Engine, root: string, branch: string, work: (tx: RecordTx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return lockRecord(root, branch, () => runTx($, root, branch, work, opts.isPure === true))
}

/** Reads, changes and writes the record atomically; undefined when there is none. A change that returns the record it was given writes nothing. */
export async function updateRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord) => LifecycleRecord | Promise<LifecycleRecord>,
  opts: TxOptions = {},
): Promise<LifecycleRecord | undefined> {
  return transact(
    $,
    root,
    branch,
    async tx => {
      const rec = await tx.load()
      if (rec === undefined) return undefined
      const next = await change(rec)
      if (next !== rec) await tx.save(next)
      return next
    },
    opts,
  )
}

/**
 * As `updateRecord`, for a change that may start the record: `change` sees undefined when there is none, and returns what to write,
 * or undefined to write nothing (a check on the read inside the transaction refused it).
 */
export async function upsertRecord(
  $: Engine,
  root: string,
  branch: string,
  change: (rec: LifecycleRecord | undefined) => LifecycleRecord | undefined | Promise<LifecycleRecord | undefined>,
  opts: TxOptions = {},
): Promise<LifecycleRecord | undefined> {
  return transact(
    $,
    root,
    branch,
    async tx => {
      const next = await change(await tx.load())
      if (next !== undefined) await tx.save(next)
      return next
    },
    opts,
  )
}

// ------------------------------------------------------------ the relay

/** A commit the relay refused because another writer, or a lease, got there first: `rev` and `record` are what the relay holds now. */
export class StaleRecord extends Error {
  rev: number
  record: unknown
  constructor(rev: number, record: unknown, why: string) {
    super(`the shared lifecycle record moved on (rev ${rev}): ${why}; this change was not written`)
    this.name = 'StaleRecord'
    this.rev = rev
    this.record = record
  }
}

/** The relay said no to this checkout's credential or grant (401 or 403): the store stands down and writes nothing. */
export class RelayRefused extends Error {
  constructor(why: string) {
    super(`the shared lifecycle store refused this checkout (${why}): nothing was written`)
    this.name = 'RelayRefused'
  }
}

/** The relay's object for the branch has moved to its PR (410, or a tombstone read): following a move is Task 7's, not built yet. */
export class RelayMoved extends Error {
  constructor(movedTo: unknown) {
    super(`the shared lifecycle record moved to PR #${String(movedTo)}; following a move is not built yet, so nothing was written`)
    this.name = 'RelayMoved'
  }
}

/** The title a security finding has on the relay (R107): its text never leaves the checkout that found it. */
export const SECURITY_PLACEHOLDER = '[security finding: text kept by the checkout that found it]'

/** The fields a security finding keeps on the relay (R107, shape R(b)): what any checkout needs to hold the merge and rule on it. */
const SHARED_FIELDS = ['id', 'round', 'source', 'reviewer', 'severity', 'isSecurity', 'headSeen', 'status'] as const

/**
 * The record as it may leave the checkout (R107): each security finding is cut to `SHARED_FIELDS`, a placeholder title and `ref: 'local'`
 * (no detail, note, file, line, url or history), and `relayRev`, this checkout's own bookkeeping, is dropped.
 */
export const redact = (rec: LifecycleRecord): LifecycleRecord => {
  const { relayRev: _, ...rest } = rec
  return {
    ...rest,
    findings: rec.findings.map(one => {
      if (one.isSecurity !== true) return one
      const kept: Record<string, unknown> = {}
      for (const name of SHARED_FIELDS) if (one[name] !== undefined) kept[name] = one[name]
      return { ...kept, title: SECURITY_PLACEHOLDER, ref: 'local' } as unknown as Finding
    }),
  }
}

/**
 * The relay's record with this checkout's own security text put back (R107): a placeholder takes the text of the mirror's finding of the
 * same id, only when the mirror is of the same lifecycle, and the relay's fields (its status and ruling among them) win. Any other
 * placeholder stays one: another checkout found it.
 */
export const restore = (remote: LifecycleRecord, local: LifecycleRecord | undefined): LifecycleRecord => {
  const isSame = local !== undefined && remote.lifecycleId !== undefined && local.lifecycleId === remote.lifecycleId
  const own = new Map((isSame ? local.findings : []).map(one => [one.id, one]))
  return {
    ...remote,
    findings: remote.findings.map(one => {
      if (one.ref !== 'local') return one
      const mine = own.get(one.id)
      if (mine === undefined) return { ...one, history: one.history ?? [] }
      const { ref: _, title: _title, ...shared } = one
      return { ...mine, ...shared }
    }),
  }
}

/** Where a record lives on the relay: the relay, the repo's slug, and the object's path (`#<pr>` once it has one, else `@<branch>`). */
type Shared = { relay: Relay; slug: string; path: string }

/**
 * The relay `rec` lives on, or undefined to keep it local: the repo doesn't opt in on its base, there is no credential, or no slug.
 * A failure to tell (an engine with no `process`) is local too.
 */
async function sharedOf($: Engine, root: string, rec: LifecycleRecord): Promise<Shared | undefined> {
  try {
    const relay = await relayOf($, root, rec.base)
    if ('local' in relay) return undefined
    let slug = rec.slug
    if (slug === undefined) {
      const ran = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 30_000 })
      slug = ran.exitCode === 0 ? slugOf(ran.stdout) : undefined
    }
    if (slug === undefined) return undefined
    return { relay, slug, path: keyPath(slug, rec.pr !== undefined ? `#${rec.pr}` : `@${rec.branch}`) }
  } catch {
    return undefined
  }
}

/** Set while the local mirror holds what the relay hasn't: a fallback's writes, or a note made on a recovery. */
const pendingKey = (root: string, branch: string): string => `${recordKey(root, branch)}:relay-pending`

async function setPending($: Engine, root: string, branch: string, isPending: boolean): Promise<void> {
  if (isPending) await $.store.set(pendingKey(root, branch), true)
  else if ((await $.store.get(pendingKey(root, branch))) !== undefined) await $.store.delete(pendingKey(root, branch))
}

/** The mirror of the relay's record at `rev`, written as it is (no `updatedAt` of its own). */
async function writeMirror($: Engine, rec: LifecycleRecord, rev: number): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, relayRev: rev })
}

const withLine = (rec: LifecycleRecord, at: number, text: string): LifecycleRecord => ({
  ...rec,
  log: [...(rec.log ?? []), { at, kind: 'session' as const, text: text.slice(0, 300) }].slice(-LOG_CAP),
})

/**
 * Adds `text` to the local record's run log once per lifecycle: not when a line starting `start` is there already. Written as it is,
 * outside `transact` (the lock is held) and never through `logEvent`, which would open another transaction.
 */
async function noteOnce($: Engine, root: string, branch: string, start: string, text: string): Promise<boolean> {
  const rec = await loadRecord($, root, branch)
  if (rec === undefined || (rec.log ?? []).some(one => one.text.startsWith(start))) return false
  await $.store.set(recordKey(root, branch), withLine(rec, await $.clock.now(), text))
  return true
}

/**
 * A 401 or 403 (spec §10): the credential is revoked or the grant is read only. The store stands down: no fallback (a cut-off
 * principal must not go on acting), nothing written locally as if committed, and the transaction throws `RelayRefused`. The run log
 * says why once per lifecycle; that line is the only local write.
 */
async function standDown($: Engine, root: string, branch: string, why: string): Promise<never> {
  await noteOnce($, root, branch, 'relay refused', `relay refused (${why}): this checkout stands down and writes nothing until its grant is restored`)
  throw new RelayRefused(why)
}

/** The relay didn't answer (spec §8): the lifecycle goes on in the local store, and the run log says why once. */
async function noteDown($: Engine, root: string, branch: string, why: string): Promise<void> {
  if (await noteOnce($, root, branch, 'relay down', `relay down (${why}): this lifecycle goes on in the local store, and is sent to the relay when it answers`)) {
    await setPending($, root, branch, true)
  }
}

/**
 * Keeps a local record the relay's wins over (a fallback the relay moved on from, or a record from before the relay): whole in the
 * local store first, then in the relay's archives by `snapshot` (redacted). A snapshot that fails is not retried: the local archive holds it.
 */
async function keepLocal($: Engine, shared: Shared, rec: LifecycleRecord, reason: 'fallback' | 'migration'): Promise<number> {
  const at = await $.clock.now()
  await writeArchive($, rec, at)
  await relayCall($, shared.relay, shared.path, { op: 'snapshot', at, record: redact({ ...rec, phase: 'archived' }), reason })
  return at
}

/** What a 409 handed back, for the one retry of a pure transaction: no second read. */
type Given = { rev: number; record: unknown }

async function runTx<T>($: Engine, root: string, branch: string, work: (tx: RecordTx) => Promise<T>, isPure: boolean): Promise<T> {
  const mirror = await loadRecord($, root, branch)
  const shared = mirror === undefined ? undefined : await sharedOf($, root, mirror)
  // Today's local store, read afresh: the decision read the base's file, and a record may have changed meanwhile.
  if (mirror !== undefined && shared === undefined) return work(localTx($, root, branch))
  let given: Given | undefined
  for (let attempt = 0; ; attempt += 1) {
    const ran = await relayTx($, root, branch, shared, work, given)
    if (!('retry' in ran)) return ran.value
    if (!isPure || attempt > 0) throw ran.retry.error
    given = ran.retry.given
  }
}

/** Today's local store: every step at once, as it always was. */
function localTx($: Engine, root: string, branch: string): RecordTx {
  return {
    load: () => loadRecord($, root, branch),
    save: rec => writeRecord($, rec),
    archive: (rec, at) => writeArchive($, rec, at),
  }
}

type Ran<T> = { value: T } | { retry: { error: StaleRecord; given?: Given } }

/**
 * One run of `work` against the relay. With no local record yet (`shared` undefined), the first save or archive says where the record
 * lives: a repo that doesn't opt in writes it locally, as today.
 */
async function relayTx<T>(
  $: Engine,
  root: string,
  branch: string,
  start: Shared | undefined,
  work: (tx: RecordTx) => Promise<T>,
  given: Given | undefined,
): Promise<Ran<T>> {
  let shared = start
  let mode: 'undecided' | 'local' | 'relay' | 'fallback' = start === undefined ? 'undecided' : 'relay'
  let rev = (await loadRecord($, root, branch))?.relayRev ?? 0
  let loaded: LifecycleRecord | undefined
  let isLoaded = false
  /** The mirror's own changes the relay hasn't had, committed with this transaction even if `work` saves nothing. */
  let owed: LifecycleRecord | undefined
  let saved: LifecycleRecord | undefined
  let archived: { rec: LifecycleRecord; at: number } | undefined

  const decide = async (rec: LifecycleRecord): Promise<void> => {
    if (mode !== 'undecided') return
    shared = await sharedOf($, root, rec)
    mode = shared === undefined ? 'local' : 'relay'
  }
  const fallbackWrite = async (rec: LifecycleRecord): Promise<void> => {
    await writeRecord($, { ...rec, relayRev: rev })
    await setPending($, root, branch, true)
  }

  const load = async (): Promise<LifecycleRecord | undefined> => {
    if (mode !== 'relay' || shared === undefined) return loadRecord($, root, branch)
    if (isLoaded) return saved ?? loaded
    isLoaded = true
    let remote: Given
    if (given !== undefined) remote = given
    else {
      const answer = await relayCall($, shared.relay, shared.path, { op: 'read' })
      if ('refused' in answer) return standDown($, root, branch, answer.refused)
      if ('down' in answer) {
        mode = 'fallback'
        await noteDown($, root, branch, answer.down)
        loaded = await loadRecord($, root, branch)
        return loaded
      }
      if (answer.status === 410) throw new RelayMoved(answer.json.movedTo)
      if (answer.status !== 200) throw new Error(`the shared lifecycle store answered a read with HTTP ${answer.status}`)
      remote = { rev: Number(answer.json.rev), record: answer.json.record }
    }
    const tomb = remote.record as { movedTo?: unknown } | null
    if (tomb !== null && typeof tomb === 'object' && tomb.movedTo !== undefined) throw new RelayMoved(tomb.movedTo)
    rev = remote.rev
    const local = await loadRecord($, root, branch)
    const isPending = (await $.store.get(pendingKey(root, branch))) === true
    const remoteRec = remote.record as LifecycleRecord | null
    if (remoteRec === null) {
      // An empty object: what this checkout holds goes up (a record from before the relay, or one the relay never had).
      loaded = local
      owed = local
    } else if (local === undefined) {
      loaded = { ...restore(remoteRec, undefined), root, branch, relayRev: rev }
      await writeMirror($, loaded, rev)
    } else if (local.relayRev === undefined || (isPending && local.relayRev !== rev)) {
      // Migration (a record from before the relay, met by one already there) or a fallback the relay moved on from: the relay's
      // record wins and is never overwritten, and the local one is kept, locally and in the relay's archives.
      const reason = local.relayRev === undefined ? 'migration' : 'fallback'
      const at = await keepLocal($, shared, local, reason)
      const line =
        reason === 'migration'
          ? `relay migration: the relay already held this lifecycle (rev ${rev}); the local record from before it is kept in the archive of ${at}`
          : `relay moved on (rev ${local.relayRev} to ${rev}) while this checkout was in fallback; its record is kept in the archive of ${at}`
      loaded = withLine({ ...restore(remoteRec, local), root, branch, relayRev: rev }, await $.clock.now(), line)
      await writeMirror($, loaded, rev)
      await setPending($, root, branch, true)
    } else if (isPending) {
      // The relay is where this checkout left it: the fallback's writes go up now.
      loaded = local
      owed = local
    } else if (local.relayRev === rev) {
      loaded = local
    } else {
      loaded = { ...restore(remoteRec, local), root, branch, relayRev: rev }
      await writeMirror($, loaded, rev)
    }
    return loaded
  }

  const tx: RecordTx = {
    load,
    save: async rec => {
      await decide(rec)
      if (mode === 'local') return writeRecord($, rec)
      if (mode === 'fallback') return fallbackWrite(rec)
      saved = rec
    },
    archive: async (rec, at) => {
      await decide(rec)
      if (mode === 'local' || mode === 'fallback') return writeArchive($, rec, at)
      archived = { rec, at }
    },
  }
  const value = await work(tx)
  if (mode !== 'relay' || shared === undefined) return { value }
  const next = saved ?? owed
  if (next === undefined) {
    if (archived !== undefined) await writeArchive($, archived.rec, archived.at)
    return { value }
  }
  const now = await $.clock.now()
  const { relayRev: _, ...bare } = next
  const lifecycleId = next.lifecycleId ?? newLifecycleId()
  const full: LifecycleRecord = { ...bare, root, branch, slug: shared.slug, lifecycleId, updatedAt: Math.max(next.updatedAt, now) }
  const body: Record<string, unknown> = { op: 'commit', rev, record: redact(full) }
  if (archived !== undefined) body.archive = { at: archived.at, record: redact({ ...archived.rec, phase: 'archived' }) }
  const answer = await relayCall($, shared.relay, shared.path, body)
  if ('refused' in answer) return standDown($, root, branch, answer.refused)
  if ('down' in answer) {
    // A commit with no answer may still have been applied: the next read tells (spec §8, Review Focus 1), and nothing is lost either way.
    await fallbackWrite(full)
    if (archived !== undefined) await writeArchive($, archived.rec, archived.at)
    await noteDown($, root, branch, answer.down)
    return { value }
  }
  if (answer.status === 200) {
    // The mirror rule: every commit the relay took is kept locally whole, security text and all, at its new revision.
    await writeMirror($, full, Number(answer.json.rev))
    await setPending($, root, branch, false)
    if (archived !== undefined) await writeArchive($, archived.rec, archived.at)
    return { value }
  }
  if (answer.status === 410) throw new RelayMoved(answer.json.movedTo)
  if (answer.status === 409 && typeof answer.json.rev === 'number') {
    const theirs = { rev: answer.json.rev, record: answer.json.record }
    const local = await loadRecord($, root, branch)
    const remoteRec = theirs.record as LifecycleRecord | null | undefined
    if (remoteRec !== null && remoteRec !== undefined && typeof remoteRec === 'object' && Array.isArray(remoteRec.findings)) {
      if (local !== undefined && (await $.store.get(pendingKey(root, branch))) === true) {
        const at = await keepLocal($, shared, local, 'fallback')
        const line = `relay moved on (rev ${local.relayRev ?? 0} to ${theirs.rev}) before this checkout's changes reached it; its record is kept in the archive of ${at}`
        await writeMirror($, withLine({ ...restore(remoteRec, local), root, branch }, now, line), theirs.rev)
      } else await writeMirror($, { ...restore(remoteRec, local), root, branch }, theirs.rev)
    }
    return { retry: { error: new StaleRecord(theirs.rev, theirs.record, 'another writer committed first'), given: theirs } }
  }
  if (answer.status === 423) return { retry: { error: new StaleRecord(rev, answer.json.lease, 'another checkout holds the lease') } }
  throw new Error(`the shared lifecycle store answered a commit with HTTP ${answer.status}`)
}

// ----------------------------------------------------------------- owner

/** The session that runs a record's lifecycle (#13), and when it last said so. Kept under its own key, so a beat never rewrites the record. */
export type Owner = { sessionId: string; beatAt: number }

/** How long an owner's last beat holds the record: after this, an interactive session may take it over (Adam, decision D). */
export const OWNER_STALE_MS = 120_000

const ownerKey = (root: string, branch: string): string => `${recordKey(root, branch)}:owner`

export async function ownerOf($: Engine, root: string, branch: string): Promise<Owner | undefined> {
  const value = (await $.store.get(ownerKey(root, branch))) as Owner | undefined | null
  return value !== null && value !== undefined && typeof value.sessionId === 'string' ? value : undefined
}

export async function setOwner($: Engine, root: string, branch: string, owner: Owner): Promise<void> {
  await $.store.set(ownerKey(root, branch), owner)
}

/** Another session beat for the record within `OWNER_STALE_MS` of `now`: it runs the lifecycle, not `me`. */
export const isHeldByOther = (owner: Owner | undefined, me: string, now: number): boolean =>
  owner !== undefined && owner.sessionId !== me && now - owner.beatAt < OWNER_STALE_MS

// ------------------------------------------------------------------- log

/** How many run-log lines a record keeps: the oldest go first. */
export const LOG_CAP = 200

/** Adds a line to the record's run log (`/pr-gate log`). Takes the record's lock: never call it from inside `updateRecord`. */
export async function logEvent($: Engine, root: string, branch: string, kind: LogEntry['kind'], text: string): Promise<void> {
  const at = await $.clock.now()
  await updateRecord($, root, branch, rec => ({ ...rec, log: [...(rec.log ?? []), { at, kind, text: text.slice(0, 300) }].slice(-LOG_CAP) }), { isPure: true })
}

/** The branch's newest archived record (R47), for a log asked for after the lifecycle closed. */
export async function latestArchive($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const prefix = `${recordKey(root, branch)}:archived:`
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix))
  const newest = keys.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))).at(-1)
  return newest === undefined ? undefined : ((await $.store.get(newest)) as LifecycleRecord | undefined)
}
