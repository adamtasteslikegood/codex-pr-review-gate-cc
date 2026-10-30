// The lifecycle record, kept in the plugin's store so a restart resumes it.
//
// The functions this module exports are the seam (#29 Part B): every read and write of a record, its owner and its archives goes
// through them, and a change of a live record goes through `transact`. Today's backend is the plugin's own store, with a lock per
// branch held in this process. A repo that opts in on its base keeps the record on the relay instead (#29 Part B, R102), with this
// store as its mirror and its fallback; see `transact`. (They stay function declarations: the engine follows $ only into those.)

import type { EngineInterface } from 'claude-code'

import { slugOf } from './core'
import { newLifecycleId } from './lifecycle'
import { keyPath, leaseSecret, NO_CREDENTIAL, relayAt, relayCall, sharedStoreOf } from './relay'
import type { Relay, RelayAnswer, SharedStore } from './relay'
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
  // A repo on the relay (a record of it there): the relay's index says which lifecycles are live, every checkout's (R106).
  const onRelay = found.filter(one => one.relayRev !== undefined)
  return onRelay.length === 0 ? found : relayRecords($, root, found, onRelay)
}

/**
 * The repo's live lifecycles as the relay's index lists them (R106), each read from its own object. A branch entry is dropped when a
 * PR entry carries its lifecycle (the index learns of a move after it), as is an object that is empty or archived by the time it is
 * read; a tombstone still holding its record (a move that stopped after `moveTo`) is its PR's lifecycle. A local record the relay
 * hasn't had (no `relayRev`, or a pending one it doesn't list) is added. A relay that can't be asked, or an object that can't be read,
 * leaves the local records as the answer, and a refusal leaves those the relay never had: the watcher goes on either way.
 */
async function relayRecords($: Engine, root: string, locals: LifecycleRecord[], onRelay: LifecycleRecord[]): Promise<LifecycleRecord[]> {
  let shared: Shared | undefined
  for (const one of onRelay) {
    const found = await sharedOf($, root, one)
    if (!('local' in found)) {
      shared = found
      break
    }
  }
  if (shared === undefined) return locals
  const listed = await relayCall($, shared.relay, `/v1/${shared.slug}`, { op: 'list' })
  if ('refused' in listed) return locals.filter(one => one.relayRev === undefined)
  if ('down' in listed || listed.status !== 200 || !Array.isArray(listed.json.entries)) return locals
  const entries = listed.json.entries as { key: string; branch: string; lifecycleId: string }[]
  const onPr = new Set(entries.filter(one => one.key.startsWith('#')).map(one => one.lifecycleId))
  const byBranch = new Map(locals.map(one => [one.branch, one]))
  const out: LifecycleRecord[] = []
  const seen = new Set<string>()
  const add = (rec: LifecycleRecord): void => {
    out.push(rec)
    if (rec.lifecycleId !== undefined) seen.add(rec.lifecycleId)
  }
  for (const entry of entries) {
    if (entry.key.startsWith('@') && onPr.has(entry.lifecycleId)) continue
    const mirror = byBranch.get(entry.branch)
    const answer = await relayCall($, shared.relay, keyPath(shared.slug, entry.key), { op: 'read' })
    if ('refused' in answer || 'down' in answer || answer.status !== 200) {
      if (mirror?.relayRev !== undefined && keyOf(mirror) === entry.key) add(mirror)
      continue
    }
    const tomb = tombOf(answer.json.record)
    let rec = (tomb === undefined ? answer.json.record : tomb.record) as LifecycleRecord | null | undefined
    if (tomb !== undefined && rec !== null && rec !== undefined && !onPr.has(tomb.lifecycleId)) rec = { ...rec, pr: tomb.movedTo }
    else if (tomb !== undefined) continue
    if (rec === null || rec === undefined || typeof rec !== 'object' || !Array.isArray(rec.findings) || rec.phase === 'archived') continue
    add({ ...restore(rec, mirror), root })
  }
  for (const one of locals) {
    if (one.lifecycleId !== undefined && seen.has(one.lifecycleId)) continue
    if (one.relayRev === undefined || (await $.store.get(pendingKey(root, one.branch))) === true) out.push(one)
  }
  return out
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

/**
 * A commit the relay refused because another writer, or a lease, got there first: `rev` and `record` are what the relay holds now. A
 * 423's `lease` says who holds the object until when (Task 8), so the session that stands down can say so; its `record` is then unknown.
 */
/** Why a commit or a move's claim met a 423: another checkout holds the lease. */
export const HELD = 'another checkout holds the lease'

export class StaleRecord extends Error {
  rev: number
  record: unknown
  lease: LeaseHeld | undefined
  /** A 423 (Task 8): another session holds the lease, and this one stands down. Any other stale commit keeps the run (spec §14). */
  isHeld: boolean
  constructor(rev: number, record: unknown, why: string, lease?: LeaseHeld) {
    super(`the shared lifecycle record moved on (rev ${rev}): ${why}; this change was not written`)
    this.name = 'StaleRecord'
    this.rev = rev
    this.record = record
    this.lease = lease
    this.isHeld = why === HELD
  }
}

/** The relay said no to this checkout's credential or grant (401 or 403): the store stands down and writes nothing. */
export class RelayRefused extends Error {
  constructor(why: string) {
    super(`the shared lifecycle store refused this checkout (${why}): nothing was written`)
    this.name = 'RelayRefused'
  }
}

/**
 * The branch's object moved to a PR under another lifecycle than the one this checkout holds (a tombstone whose `lifecycleId` isn't
 * the mirror's): this checkout's record is not that one, so it stands down and writes nothing (R103).
 */
export class RelayMoved extends Error {
  constructor(movedTo: unknown) {
    super(`the shared lifecycle record of this branch moved to PR #${String(movedTo)} under another lifecycle; this checkout stands down, so nothing was written`)
    this.name = 'RelayMoved'
  }
}

/** The title a security finding has on the relay (R107): its text never leaves the checkout that found it. */
export const SECURITY_PLACEHOLDER = '[security finding: text kept by the checkout that found it]'

/**
 * The fields a security finding keeps on the relay (R107, shape R(b)): what any checkout needs to hold the merge and rule on it. A
 * linked duplicate keeps its `duplicateOf` too, an id: it holds, and settles, with its original (R90).
 */
const SHARED_FIELDS = ['id', 'round', 'source', 'reviewer', 'severity', 'isSecurity', 'headSeen', 'status', 'duplicateOf'] as const

/** What any other string of the record becomes on the relay when it names a security finding (R107): the whole string, not a part of it. */
export const HELD_PLACEHOLDER = '[held locally: names a security finding]'

/** A text needle shorter than this (an id apart) is too likely a common word (`check`, `open`, `fix`) to say a string names a finding. */
const MIN_NEEDLE = 8

/**
 * The keys whose values are never free text, at any depth: enums (a log line's `kind`, a phase, a lane, a waiver's `scope`, a status, a
 * severity, a source, a tier, a role or step state), heads and other SHAs, and the record's own names for where it is (the relay's path
 * is built from them). The scrub never rewrites them: a needle that matched one would corrupt the record, and none holds a reviewer's words.
 */
const FIXED_KEYS = new Set([
  'kind', 'phase', 'lane', 'scope', 'status', 'severity', 'source', 'tier', 'role', 'state', 'bucket', 'effort', 'lifecycle',
  'head', 'headSha', 'headSeen', 'startHead', 'endHead', 'roundStartHead', 'diffBase', 'preHead', 'lapsedHead', 'lineHead', 'self',
  'root', 'branch', 'base', 'slug', 'lifecycleId', 'cwd', 'id', 'findingId', 'agentId', 'turnId', 'by', 'reviewer',
])

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The ids of the findings the relay holds as security (R107): each security finding, and each finding linked to one through its
 * `duplicateOf` chain (a link marks only the original as security, lifecycle.ts `withLinkedPeak`, yet names the same problem).
 */
const secureIdsOf = (findings: Finding[]): Set<string> => {
  const byId = new Map(findings.map(one => [one.id, one]))
  const isSecure = (one: Finding): boolean => {
    const seen = new Set<string>()
    for (let at: Finding | undefined = one; at !== undefined && !seen.has(at.id); at = at.duplicateOf === undefined ? undefined : byId.get(at.duplicateOf)) {
      if (at.isSecurity === true) return true
      seen.add(at.id)
    }
    return false
  }
  return new Set(findings.filter(isSecure).map(one => one.id))
}

/**
 * Whether a string names one of the `secure` findings: it holds one's title, detail, note, file, url or a Jira summary sent for it (each
 * of `MIN_NEEDLE` characters or more), or its id as a word of its own (`G1-1` is not in `G1-10`). A string that is exactly an id is a
 * reference (a waiver's `findingId`, an `asked` list), not text: the id is shared on the finding itself, and it stays.
 */
const namerOf = (secure: Finding[]): ((text: string) => boolean) | undefined => {
  if (secure.length === 0) return undefined
  const ids = new Set(secure.map(one => one.id))
  const texts = secure
    .flatMap(one => [one.title, one.detail, one.note, one.file, one.url, ...(one.jiraSummaries ?? [])])
    .filter((text): text is string => typeof text === 'string' && text.length >= MIN_NEEDLE && text !== SECURITY_PLACEHOLDER)
  const idRe = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...ids].map(escapeRe).join('|')})(?![A-Za-z0-9_-])`)
  return text => !ids.has(text) && (texts.some(needle => text.includes(needle)) || idRe.test(text))
}

/** Every free-text string under `value` that names a security finding, whole, as `HELD_PLACEHOLDER`; a `FIXED_KEYS` value, or any other, as it is. */
const scrub = (value: unknown, isNamed: (text: string) => boolean): unknown => {
  if (typeof value === 'string') return isNamed(value) ? HELD_PLACEHOLDER : value
  if (Array.isArray(value)) return value.map(one => scrub(one, isNamed))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, one]) => [name, FIXED_KEYS.has(name) ? one : scrub(one, isNamed)]))
  }
  return value
}

/**
 * The record as it may leave the checkout (R107): each security finding, and each linked to one, is cut to `SHARED_FIELDS`, a
 * placeholder title and `ref: 'local'` (no detail, note, file, line, url or history); every other free-text string that names one (a
 * message, a round's outstanding, a log line, a waiver's or grant's reason) becomes `HELD_PLACEHOLDER` whole; and `relayRev`, this
 * checkout's own bookkeeping, is dropped, as is `relayKey`.
 */
export const redact = (rec: LifecycleRecord): LifecycleRecord => {
  const { relayRev: _, relayKey: _key, findings: _findings, ...rest } = rec
  const secureIds = secureIdsOf(rec.findings)
  const isNamed = namerOf(rec.findings.filter(one => secureIds.has(one.id)))
  return {
    ...((isNamed === undefined ? rest : scrub(rest, isNamed)) as typeof rest),
    findings: rec.findings.map(one => {
      if (!secureIds.has(one.id)) return one
      const kept: Record<string, unknown> = {}
      for (const name of SHARED_FIELDS) if (one[name] !== undefined) kept[name] = one[name]
      return { ...kept, title: SECURITY_PLACEHOLDER, ref: 'local' } as unknown as Finding
    }),
  }
}

/**
 * The relay's record with this checkout's own security text put back (R107): a placeholder takes the text of the mirror's finding of the
 * same id, only when the mirror is of the same lifecycle, and the relay's fields (its status and ruling among them) win. Any other
 * placeholder stays one: another checkout found it. Only findings are put back: a `HELD_PLACEHOLDER` elsewhere stays as the relay has it
 * (the mirror of this checkout's own commit keeps the full text, so only a record another writer moved on loses it there).
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

/** Where a record lives on the relay: the relay, the repo's slug, the object's key (`#<pr>` once moved, else `@<branch>`) and its path. */
type Shared = { relay: Relay; slug: string; key: string; path: string }

/** The relay object a mirror is of: the one it was last committed at, else where a record of its kind lives. */
const keyOf = (rec: LifecycleRecord): string => rec.relayKey ?? (rec.pr !== undefined ? `#${rec.pr}` : `@${rec.branch}`)

const atKey = (shared: Shared, key: string): Shared => ({ ...shared, key, path: keyPath(shared.slug, key) })

/** A branch object's record once it moved (R103): where to, under which lifecycle, and the record itself until `moveDone`. */
type Tomb = { movedTo: number; lifecycleId: string; record?: unknown }

const tombOf = (record: unknown): Tomb | undefined => {
  const one = record as Partial<Tomb> | null | undefined
  return one !== null && typeof one === 'object' && typeof one.movedTo === 'number' ? (one as Tomb) : undefined
}

/** How long one answer to "does this repo opt in on its base" holds in this process: a change of the base is seen within a minute. */
export const OPT_IN_TTL_MS = 60_000

/** The answers, per root and base: what the base's `sharedStore` was, and when it was read. */
const optIns = new Map<string, { at: number; shared: SharedStore | undefined }>()

/** Forgets every answer `optInOf` holds: a test that changes the base's file within `OPT_IN_TTL_MS` calls it. */
export const forgetOptIns = (): void => optIns.clear()

/**
 * The relay for a branch to `base`, as `relayOf`, with the base's file read at most once per `OPT_IN_TTL_MS` for a root and base:
 * every transaction of every repo asks, under the lock, and the file is a `git show`. The credential is read from the environment each
 * time; a read of the file that throws is never kept.
 */
async function optInOf($: Engine, root: string, base: string): Promise<Relay | { local: string }> {
  const now = await $.clock.now()
  const key = `${root}\n${base}`
  const kept = optIns.get(key)
  if (kept !== undefined && now >= kept.at && now - kept.at < OPT_IN_TTL_MS) return relayAt($, kept.shared)
  const shared = await sharedStoreOf($, root, base)
  optIns.set(key, { at: now, shared })
  return relayAt($, shared)
}

/**
 * The relay `rec` lives on, or why it stays local: the repo doesn't opt in on its base, there is no credential, or no slug. A failure
 * to tell (git fails, an engine with no `process`) is local too; the caller of a record that has been on the relay falls back instead.
 */
async function sharedOf($: Engine, root: string, rec: LifecycleRecord): Promise<Shared | { local: string }> {
  try {
    const relay = await optInOf($, root, rec.base)
    if ('local' in relay) return relay
    let slug = rec.slug
    if (slug === undefined) {
      const ran = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 30_000 })
      slug = ran.exitCode === 0 ? slugOf(ran.stdout) : undefined
    }
    if (slug === undefined) return { local: 'no slug for origin' }
    const key = keyOf(rec)
    return { relay, slug, key, path: keyPath(slug, key) }
  } catch (error) {
    return { local: `the opt-in could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Set while the local mirror holds what the relay hasn't: a fallback's writes, or a note made on a recovery. */
const pendingKey = (root: string, branch: string): string => `${recordKey(root, branch)}:relay-pending`

async function setPending($: Engine, root: string, branch: string, isPending: boolean): Promise<void> {
  if (isPending) await $.store.set(pendingKey(root, branch), true)
  else if ((await $.store.get(pendingKey(root, branch))) !== undefined) await $.store.delete(pendingKey(root, branch))
}

/** The mirror of the relay's record at `rev` of the object `key`, written as it is (no `updatedAt` of its own). */
async function writeMirror($: Engine, rec: LifecycleRecord, rev: number, key: string): Promise<void> {
  await $.store.set(recordKey(rec.root, rec.branch), { ...rec, relayRev: rev, relayKey: key })
}

/** A call this checkout owes the relay (a snapshot, or a move's `moveDone`) that didn't land: sent again after the next one that does. */
type Owed = { path: string; body: Record<string, unknown> }

/** Kept beside the record, never under `:archived:` (`latestArchive` reads every key there as an archive). */
const owedKey = (root: string, branch: string): string => `${recordKey(root, branch)}:relay-owed`

async function owe($: Engine, root: string, branch: string, one: Owed): Promise<void> {
  const kept = ((await $.store.get(owedKey(root, branch))) as Owed[] | undefined) ?? []
  await $.store.set(owedKey(root, branch), [...kept, one])
}

/**
 * Sends what this checkout owes the relay, oldest first, after a call that landed. One that is down or refused is kept, with every one
 * after it; one the relay answered otherwise is done (a `moveDone` another checkout finished first answers 409).
 */
async function payOwed($: Engine, root: string, branch: string, relay: Relay): Promise<void> {
  const kept = (await $.store.get(owedKey(root, branch))) as Owed[] | undefined
  if (kept === undefined || kept.length === 0) return
  let paid = 0
  for (const one of kept) {
    const answer = await relayCall($, relay, one.path, one.body)
    if ('down' in answer || 'refused' in answer) break
    paid += 1
  }
  if (paid === kept.length) await $.store.delete(owedKey(root, branch))
  else await $.store.set(owedKey(root, branch), kept.slice(paid))
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

/**
 * A base that opts in, and an environment with no relay credential (Task 8): the lifecycle stays local, and its run log says why once,
 * so a person who expected the shared store sees it isn't used. Any other reason to stay local (no opt-in) says nothing.
 */
async function noteNoCredential($: Engine, root: string, branch: string, why: string): Promise<void> {
  if (why !== NO_CREDENTIAL) return
  await noteOnce($, root, branch, NO_CREDENTIAL, `${NO_CREDENTIAL}: the base opts in to the shared store, but neither PR_GATE_RELAY_CLIENT_ID and _SECRET nor PR_GATE_RELAY_TOKEN is set; this lifecycle stays in the local store`)
}

/** The relay didn't answer (spec §8): the lifecycle goes on in the local store, and the run log says why once. */
async function noteDown($: Engine, root: string, branch: string, why: string): Promise<void> {
  await noteOnce($, root, branch, 'relay down', `relay down (${why}): this lifecycle goes on in the local store, and is sent to the relay when it answers`)
  await setPending($, root, branch, true)
}

/**
 * Keeps a local record the relay's wins over (a fallback the relay moved on from, or a record from before the relay): whole in the
 * local store first, then in the relay's archives by `snapshot` (redacted). A snapshot that fails is owed: the local archive holds it,
 * `lines` says the relay's copy is missing, and it is sent again after the next call that lands.
 */
async function keepLocal($: Engine, shared: Shared, rec: LifecycleRecord, reason: 'fallback' | 'migration' | 'move'): Promise<{ at: number; lines: string[] }> {
  const at = await $.clock.now()
  await writeArchive($, rec, at)
  const body = { op: 'snapshot', at, record: redact({ ...rec, phase: 'archived' }), reason }
  const answer = await relayCall($, shared.relay, shared.path, body)
  const why = 'refused' in answer ? answer.refused : 'down' in answer ? answer.down : answer.status === 200 ? undefined : `HTTP ${answer.status}`
  if (why !== undefined) await owe($, rec.root, rec.branch, { path: shared.path, body })
  return {
    at,
    lines: why === undefined ? [] : [`relay snapshot missing (${why}): the relay has no copy of the archive of ${at} yet; the local store keeps it, and sends it again`],
  }
}

const withLines = (rec: LifecycleRecord, at: number, lines: string[]): LifecycleRecord => lines.reduce((one, text) => withLine(one, at, text), rec)

/** What a 409 handed back, for the one retry of a pure transaction: no second read. */
type Given = { rev: number; record: unknown }

async function runTx<T>($: Engine, root: string, branch: string, work: (tx: RecordTx) => Promise<T>, isPure: boolean): Promise<T> {
  const mirror = await loadRecord($, root, branch)
  const found = mirror === undefined ? undefined : await sharedOf($, root, mirror)
  if (mirror !== undefined && found !== undefined && 'local' in found) {
    // Today's local store, read afresh: the decision read the base's file, and a record may have changed meanwhile.
    if (mirror.relayRev === undefined) {
      await noteNoCredential($, root, branch, found.local)
      return work(localTx($, root, branch))
    }
    // A record that has been on the relay, and the opt-in can't be read now: a fallback, never plain local, so a relay that moved on
    // meanwhile archives these writes instead of overwriting them.
    await noteDown($, root, branch, found.local)
    return work(fallbackTx($, root, branch, mirror.relayRev, keyOf(mirror)))
  }
  let shared = found !== undefined && 'local' in found ? undefined : found
  let given: Given | undefined
  for (let attempt = 0; ; attempt += 1) {
    const ran = await relayTx($, root, branch, shared, work, given)
    if (!('retry' in ran)) return ran.value
    if (!isPure || attempt > 0) throw ran.retry.error
    given = ran.retry.given
    // A retry at another object: the PR's, after a move followed, or the branch's, for a new lifecycle after the PR's.
    if (ran.retry.shared !== undefined) shared = ran.retry.shared
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

/** The local store for a record that has been on the relay at `relayRev` of `relayKey`: each write keeps both and marks the mirror pending. */
function fallbackTx($: Engine, root: string, branch: string, relayRev: number, relayKey: string): RecordTx {
  return {
    load: () => loadRecord($, root, branch),
    save: async rec => {
      await writeRecord($, { ...rec, relayRev: rec.relayRev ?? relayRev, relayKey: rec.relayKey ?? relayKey })
      await setPending($, root, branch, true)
    },
    archive: (rec, at) => writeArchive($, rec, at),
  }
}

type Ran<T> = { value: T } | { retry: { error: StaleRecord; given?: Given; shared?: Shared } }

/** The mirror's rev of the object `key`, if it is a mirror of that object: a rev of one object says nothing about another's. */
const revAt = (rec: LifecycleRecord | undefined, key: string): number | undefined => (rec !== undefined && keyOf(rec) === key ? rec.relayRev : undefined)

/** A `read` of the object at `at`: its rev and record, or why it didn't answer. A refusal stands the store down. */
async function readAt($: Engine, root: string, branch: string, at: Shared): Promise<Given | { down: string }> {
  const answer = await relayCall($, at.relay, at.path, { op: 'read' })
  if ('refused' in answer) return standDown($, root, branch, answer.refused)
  if ('down' in answer) return answer
  if (answer.status !== 200) throw new Error(`the shared lifecycle store answered a read with HTTP ${answer.status}`)
  return { rev: Number(answer.json.rev), record: answer.json.record }
}

/**
 * Steps 2 and 3 of the move (R103): the record on the PR's object (a `commit` with `from`, under a claim of that object), then the
 * branch's tombstone cut to its pointer (`moveDone`). Answers the PR object's rev and record: `rec` itself, or what another checkout
 * placed there first (a 409, or a claim it holds). Another lifecycle there keeps this one by a snapshot on the branch's object. A
 * `moveDone` that doesn't land is owed; a claim or commit that doesn't is the caller's to note, and the next load finishes the move.
 */
async function publishMove(
  $: Engine,
  root: string,
  branch: string,
  from: Shared,
  to: Shared,
  rec: LifecycleRecord,
  isKept = false,
): Promise<Given | { down: string }> {
  const secret = await leaseSecret($)
  const holder = await $.session.id()
  const claimed = await relayCall($, to.relay, to.path, { op: 'claim', holder, secret })
  if ('refused' in claimed) return standDown($, root, branch, claimed.refused)
  if ('down' in claimed) return claimed
  let placed: Given
  if (claimed.status === 200) {
    const answer = await relayCall($, to.relay, to.path, { op: 'commit', rev: 0, record: redact(rec), from: from.key, secret })
    if ('refused' in answer) return standDown($, root, branch, answer.refused)
    if ('down' in answer) return answer
    if (answer.status === 200) placed = { rev: Number(answer.json.rev), record: rec }
    else if (answer.status === 409 && typeof answer.json.rev === 'number') placed = { rev: answer.json.rev, record: answer.json.record }
    else throw new Error(`the shared lifecycle store answered a move's commit with HTTP ${answer.status}`)
    // The mover's own move (`isKept`) keeps the claim as the driver's lease, so only it passes the next boundary on the PR's object
    // (Task 8): never released and claimed again, which another checkout could take in between. Any other claim here is released.
    const lease = leaseOf(claimed.json.lease)
    if (isKept && lease !== undefined && (placed.record as LifecycleRecord | null)?.lifecycleId === rec.lifecycleId) {
      await keepLease($, holder, root, branch, to.path, lease)
    } else {
      const release = { op: 'release', secret }
      const released = await relayCall($, to.relay, to.path, release)
      // A release that doesn't land is owed: else this checkout's own lease holds its next commit off the PR's object until it lapses.
      if ('down' in released) await owe($, root, branch, { path: to.path, body: release })
    }
  } else if (claimed.status === 423) {
    // Another checkout holds the PR's object: one that moved this lifecycle first, or is moving it now.
    const read = await readAt($, root, branch, to)
    if ('down' in read) return read
    if (read.record === null) throw new StaleRecord(read.rev, null, 'another checkout is moving this lifecycle to its PR')
    placed = read
  } else throw new Error(`the shared lifecycle store answered a move's claim with HTTP ${claimed.status}`)
  if ((placed.record as LifecycleRecord | null)?.lifecycleId !== rec.lifecycleId) {
    // Another lifecycle holds the PR's object already: this one is kept, locally and in the archives of the branch's object.
    await keepLocal($, from, rec, 'move')
  }
  const body = { op: 'moveDone', lifecycleId: rec.lifecycleId }
  const done = await relayCall($, from.relay, from.path, body)
  if ('refused' in done) return standDown($, root, branch, done.refused)
  if ('down' in done) await owe($, root, branch, { path: from.path, body })
  else if (done.status !== 200) throw new StaleRecord(placed.rev, placed.record, `the branch's object was not moved with this lifecycle (moveDone answered HTTP ${done.status})`)
  return placed
}

/** A tombstone of another lifecycle than this checkout's (spec §1): neither followed nor started over. The store stands down, writing nothing. */
async function standMoved($: Engine, root: string, branch: string, movedTo: number): Promise<never> {
  await noteOnce($, root, branch, 'relay moved:', `relay moved: this branch's object moved to PR #${movedTo} under another lifecycle; this checkout stands down`)
  throw new RelayMoved(movedTo)
}

/**
 * A branch's object that moved (R103), followed to its PR's: the move is finished first when the tombstone still holds the record
 * (a mover that stopped after `moveTo`), from that record. A tombstone of another lifecycle than the mirror's is not followed: the
 * store stands down and writes nothing.
 */
async function follow(
  $: Engine,
  root: string,
  branch: string,
  from: Shared,
  tomb: Tomb,
  local: LifecycleRecord | undefined,
): Promise<{ shared: Shared; remote: Given } | { down: string }> {
  if (local?.lifecycleId !== undefined && local.lifecycleId !== tomb.lifecycleId) return standMoved($, root, branch, tomb.movedTo)
  const to = atKey(from, `#${tomb.movedTo}`)
  const remote =
    tomb.record === undefined
      ? await readAt($, root, branch, to)
      : await publishMove($, root, branch, from, to, { ...restore(tomb.record as LifecycleRecord, local), root, branch, pr: tomb.movedTo })
  return 'down' in remote ? remote : { shared: to, remote }
}

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
  let rev = (start === undefined ? undefined : revAt(await loadRecord($, root, branch), start.key)) ?? 0
  let loaded: LifecycleRecord | undefined
  let isLoaded = false
  /** The mirror's own changes the relay hasn't had, committed with this transaction even if `work` saves nothing. */
  let owed: LifecycleRecord | undefined
  let saved: LifecycleRecord | undefined
  let archived: { rec: LifecycleRecord; at: number } | undefined

  let localWhy: string | undefined
  const decide = async (rec: LifecycleRecord): Promise<void> => {
    if (mode !== 'undecided') return
    const found = await sharedOf($, root, rec)
    localWhy = 'local' in found ? found.local : undefined
    shared = 'local' in found ? undefined : found
    mode = shared === undefined ? 'local' : 'relay'
  }
  const fallbackWrite = async (rec: LifecycleRecord): Promise<void> => {
    await writeRecord($, { ...rec, relayRev: rev, relayKey: shared?.key ?? keyOf(rec) })
    await setPending($, root, branch, true)
  }
  const toFallback = async (why: string): Promise<LifecycleRecord | undefined> => {
    mode = 'fallback'
    await noteDown($, root, branch, why)
    loaded = await loadRecord($, root, branch)
    return loaded
  }

  const load = async (): Promise<LifecycleRecord | undefined> => {
    if (mode !== 'relay' || shared === undefined) return loadRecord($, root, branch)
    if (isLoaded) return saved ?? loaded
    isLoaded = true
    let remote: Given
    if (given !== undefined) remote = given
    else {
      const read = await readAt($, root, branch, shared)
      if ('down' in read) return toFallback(read.down)
      await payOwed($, root, branch, shared.relay)
      remote = read
    }
    const tomb = tombOf(remote.record)
    if (tomb !== undefined) {
      // The branch's lifecycle moved to its PR (R103): it is read, and goes on, there.
      const to = await follow($, root, branch, shared, tomb, await loadRecord($, root, branch))
      if ('down' in to) return toFallback(to.down)
      shared = to.shared
      remote = to.remote
    }
    rev = remote.rev
    const local = await loadRecord($, root, branch)
    const isPending = (await $.store.get(pendingKey(root, branch))) === true
    const remoteRec = remote.record as LifecycleRecord | null
    // A mirror of another object (the branch's, before a move followed here) is never at this one's rev, whatever its number.
    const localRev = revAt(local, shared.key)
    if (remoteRec === null) {
      // An empty object: what this checkout holds goes up (a record from before the relay, or one the relay never had).
      loaded = local
      owed = local
    } else if (local === undefined) {
      loaded = { ...restore(remoteRec, undefined), root, branch, relayRev: rev, relayKey: shared.key }
      await writeMirror($, loaded, rev, shared.key)
    } else if (local.relayRev === undefined || (isPending && localRev !== rev)) {
      // Migration (a record from before the relay, met by one already there) or a fallback the relay moved on from: the relay's
      // record wins and is never overwritten, and the local one is kept, locally and in the relay's archives.
      const reason = local.relayRev === undefined ? 'migration' : 'fallback'
      const { at, lines } = await keepLocal($, shared, local, reason)
      const line =
        reason === 'migration'
          ? `relay migration: the relay already held this lifecycle (rev ${rev}); the local record from before it is kept in the archive of ${at}`
          : localRev === undefined
            ? `relay moved on (the lifecycle moved to ${shared.key}) while this checkout was in fallback; its record is kept in the archive of ${at}`
            : `relay moved on (rev ${local.relayRev} to ${rev}) while this checkout was in fallback; its record is kept in the archive of ${at}`
      loaded = withLines({ ...restore(remoteRec, local), root, branch, relayRev: rev, relayKey: shared.key }, await $.clock.now(), [line, ...lines])
      await writeMirror($, loaded, rev, shared.key)
      await setPending($, root, branch, true)
    } else if (isPending) {
      // The relay is where this checkout left it: the fallback's writes go up now.
      loaded = local
      owed = local
    } else if (localRev === rev) {
      loaded = local
    } else {
      loaded = { ...restore(remoteRec, local), root, branch, relayRev: rev, relayKey: shared.key }
      await writeMirror($, loaded, rev, shared.key)
    }
    // A record on the branch's object that has its PR is owed its move, even by a change that saves nothing: a mover stopped short.
    if (shared.key.startsWith('@') && loaded?.pr !== undefined && loaded.phase !== 'archived') owed ??= loaded
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
  if (localWhy !== undefined) await noteNoCredential($, root, branch, localWhy)
  if (mode !== 'relay' || shared === undefined) return { value }
  const next = saved ?? owed
  if (next === undefined) {
    if (archived !== undefined) await writeArchive($, archived.rec, archived.at)
    return { value }
  }
  const now = await $.clock.now()
  const { relayRev: _, relayKey: _key, ...bare } = next
  const lifecycleId = next.lifecycleId ?? newLifecycleId()
  const full: LifecycleRecord = { ...bare, root, branch, slug: shared.slug, lifecycleId, updatedAt: Math.max(next.updatedAt, now) }
  const keepArchive = async (): Promise<void> => {
    if (archived !== undefined) await writeArchive($, archived.rec, archived.at)
  }
  // Every commit carries this session's lease secret (Task 8): under its own live lease the relay takes it, under another's it is 423.
  const secret = await leaseSecret($)
  const bodyAt = (at: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    op: 'commit',
    rev: at,
    record: redact(full),
    ...(archived === undefined ? {} : { archive: { at: archived.at, record: redact({ ...archived.rec, phase: 'archived' }) } }),
    ...(secret === undefined ? {} : { secret }),
    ...extra,
  })

  /** The relay's answer to a commit of `full` at `at`, settled: undefined once committed, else the transaction's outcome. */
  const settle = async (at: Shared, answer: RelayAnswer): Promise<Ran<T> | undefined> => {
    if ('refused' in answer) return standDown($, root, branch, answer.refused)
    if ('down' in answer) {
      // A commit with no answer may still have been applied: the next read tells (spec §8, Review Focus 1), and nothing is lost either way.
      await fallbackWrite(full)
      await keepArchive()
      await noteDown($, root, branch, answer.down)
      return { value }
    }
    if (answer.status === 200) {
      // The mirror rule: every commit the relay took is kept locally whole, security text and all, at its new revision.
      await writeMirror($, full, Number(answer.json.rev), at.key)
      await setPending($, root, branch, false)
      await keepArchive()
      await payOwed($, root, branch, at.relay)
      return undefined
    }
    if (answer.status === 410) return moved(at, answer.json)
    if (answer.status === 409 && typeof answer.json.rev === 'number') {
      const theirs = { rev: answer.json.rev, record: answer.json.record }
      const local = await loadRecord($, root, branch)
      const remoteRec = theirs.record as LifecycleRecord | null | undefined
      if (remoteRec !== null && remoteRec !== undefined && typeof remoteRec === 'object' && Array.isArray(remoteRec.findings)) {
        const isPending = (await $.store.get(pendingKey(root, branch))) === true
        if (local !== undefined && (isPending || local.relayRev === undefined)) {
          // A fallback's writes, or a record from before the relay (a save with no load meets one already there): kept before the
          // relay's record replaces it, as on a load.
          const reason = local.relayRev === undefined ? 'migration' : 'fallback'
          const { at: kept, lines } = await keepLocal($, at, local, reason)
          const line =
            reason === 'migration'
              ? `relay migration: the relay already held this lifecycle (rev ${theirs.rev}); the local record from before it is kept in the archive of ${kept}`
              : `relay moved on (rev ${local.relayRev ?? 0} to ${theirs.rev}) before this checkout's changes reached it; its record is kept in the archive of ${kept}`
          await writeMirror($, withLines({ ...restore(remoteRec, local), root, branch }, now, [line, ...lines]), theirs.rev, at.key)
          await setPending($, root, branch, true)
        } else await writeMirror($, { ...restore(remoteRec, local), root, branch }, theirs.rev, at.key)
      }
      return { retry: { error: new StaleRecord(theirs.rev, theirs.record, 'another writer committed first'), given: theirs, shared: at } }
    }
    if (answer.status === 423) {
      // Another session holds the lease (spec §4): this session's kept lease is gone, so its next ownership check reads the relay.
      await dropLease($, root, branch)
      return { retry: { error: new StaleRecord(rev, undefined, HELD, leaseOf(answer.json.lease)) } }
    }
    // A fresh start the relay holds off: the old lifecycle's move isn't finished, and its frozen record stays in the tombstone.
    if (answer.status === 409) return { retry: { error: new StaleRecord(rev, answer.json, 'the old lifecycle has not finished its move to its PR') } }
    throw new Error(`the shared lifecycle store answered a commit with HTTP ${answer.status}`)
  }

  /**
   * A 410: the branch's object at `at` moved. Of this lifecycle (a stale checkout still driving the branch's object), the move is
   * followed and the change runs again at the PR's object. Of another, this record starts fresh over the tombstone (`isFresh`), and the
   * old PR's object is left as it is.
   */
  const moved = async (at: Shared, json: Record<string, unknown>): Promise<Ran<T>> => {
    const read = await readAt($, root, branch, at)
    if ('down' in read) return (await settle(at, read)) ?? { value }
    const tomb = tombOf(read.record)
    if (tomb === undefined) throw new Error(`the shared lifecycle store answered 410 for ${at.key}, and reads no tombstone there`)
    if (json.lifecycleId === full.lifecycleId) {
      const local = await loadRecord($, root, branch)
      const to = await follow($, root, branch, at, tomb, local)
      if ('down' in to) return (await settle(at, to)) ?? { value }
      await writeMirror($, { ...restore(to.remote.record as LifecycleRecord, local), root, branch }, to.remote.rev, to.shared.key)
      await setPending($, root, branch, false)
      const error = new StaleRecord(to.remote.rev, to.remote.record, `the lifecycle moved to PR #${tomb.movedTo}`)
      return { retry: { error, given: to.remote, shared: to.shared } }
    }
    // Of another lifecycle: a new one of this checkout's (a reset, or an adoption) starts over the tombstone. The mirror's own lifecycle,
    // which another checkout reset and moved on from, is never revived there (spec §1): the store stands down.
    const mirror = await loadRecord($, root, branch)
    if (mirror?.lifecycleId === full.lifecycleId) return standMoved($, root, branch, tomb.movedTo)
    return startOver(at, read, tomb, mirror)
  }

  /**
   * A new lifecycle's first commit on the branch's object at `at`, read as `read` (R103), over its tombstone with `isFresh`. A tombstone
   * that still holds the old lifecycle's record (a move that stopped after `moveTo`) has steps 2 and 3 run first, from that record, so it
   * is never lost: placed on its PR's object, or kept by a snapshot when another lifecycle holds that object. Until the old move's
   * `moveDone` lands the relay answers 409, and the frozen record stays where it is.
   */
  const startOver = async (at: Shared, read: Given, tomb: Tomb | undefined, mirror: LifecycleRecord | undefined): Promise<Ran<T>> => {
    if (tomb?.record !== undefined) {
      const old = { ...restore(tomb.record as LifecycleRecord, mirror), root, branch, pr: tomb.movedTo }
      const placed = await publishMove($, root, branch, at, atKey(at, `#${tomb.movedTo}`), old)
      if ('down' in placed) return (await settle(at, placed)) ?? { value }
    }
    rev = read.rev
    return (await settle(at, await relayCall($, at.relay, at.path, bodyAt(rev, tomb === undefined ? {} : { isFresh: true })))) ?? { value }
  }

  let at = shared
  if (at.key.startsWith('#') && full.pr === undefined && full.phase !== 'archived') {
    // A new lifecycle after its PR's (R103): it starts on the branch's object again, and the old PR's object is left as it is.
    at = atKey(shared, `@${branch}`)
    const read = await readAt($, root, branch, at)
    if ('down' in read) return (await settle(at, read)) ?? { value }
    const tomb = tombOf(read.record)
    const there = read.record as LifecycleRecord | null
    if (tomb === undefined && there !== null && there.phase !== 'archived' && there.lifecycleId !== full.lifecycleId) {
      throw new StaleRecord(read.rev, read.record, 'another lifecycle drives this branch')
    }
    return startOver(at, read, tomb, await loadRecord($, root, branch))
  }
  if (!at.key.startsWith('@') || full.pr === undefined) return (await settle(at, await relayCall($, at.relay, at.path, bodyAt(rev)))) ?? { value }

  // The move (R103, spec §1): the record has its PR. It is committed on the branch's object under a claim of it, then step 1 freezes
  // that object with the record in its tombstone, and `publishMove` takes steps 2 and 3. A step that doesn't land stops the move where
  // it is: the next load finds the record with its PR on the branch's object, or the tombstone, and finishes it.
  const claimed = await relayCall($, at.relay, at.path, { op: 'claim', holder: await $.session.id(), secret })
  if ('refused' in claimed || 'down' in claimed) return (await settle(at, claimed)) ?? { value }
  if (claimed.status === 410) return moved(at, claimed.json)
  if (claimed.status === 423) {
    await dropLease($, root, branch)
    return { retry: { error: new StaleRecord(rev, undefined, HELD, leaseOf(claimed.json.lease)) } }
  }
  if (claimed.status !== 200) throw new Error(`the shared lifecycle store answered a claim with HTTP ${claimed.status}`)
  const answer = await relayCall($, at.relay, at.path, bodyAt(rev, { secret }))
  if (!('refused' in answer) && !('down' in answer) && answer.status !== 200 && answer.status !== 410) {
    await relayCall($, at.relay, at.path, { op: 'release', secret })
  }
  const settled = await settle(at, answer)
  if (settled !== undefined) return settled
  const noteStop = (why: string): Promise<boolean> =>
    noteOnce($, root, branch, 'relay down', `relay down (${why}): the move to PR #${full.pr} stopped short; the next transaction on this lifecycle finishes it`)
  const froze = await relayCall($, at.relay, at.path, { op: 'moveTo', pr: full.pr, secret })
  if ('refused' in froze) return standDown($, root, branch, froze.refused)
  if ('down' in froze) await noteStop(froze.down)
  else if (froze.status !== 200) {
    await noteOnce($, root, branch, 'relay move refused', `relay move refused (HTTP ${froze.status}): the move to PR #${full.pr} did not start; the next transaction on this lifecycle tries again`)
  }
  if ('down' in froze || froze.status !== 200) return { value }
  const to = atKey(at, `#${full.pr}`)
  // This session froze the branch's object, so it drives the PR's: the claim the move takes there is kept as its lease (Task 8).
  const placed = await publishMove($, root, branch, at, to, full, true)
  if ('down' in placed) {
    await noteStop(placed.down)
    return { value }
  }
  const isOurs = placed.record === full
  await writeMirror($, isOurs ? full : { ...restore(placed.record as LifecycleRecord, full), root, branch }, placed.rev, to.key)
  return { value }
}

// ----------------------------------------------------------------- owner

/** The session that runs a record's lifecycle (#13), and when it last said so. Kept under its own key, so a beat never rewrites the record. */
export type Owner = { sessionId: string; beatAt: number }

/** How long an owner's last beat holds the record: after this, an interactive session may take it over (Adam, decision D). */
export const OWNER_STALE_MS = 120_000

const ownerKey = (root: string, branch: string): string => `${recordKey(root, branch)}:owner`

/** The owner a relay that refused this checkout stands for (spec §10): never this session, so it holds the record off. */
export const REFUSED_OWNER = 'relay-refused'

/**
 * The record's owner. On the relay (Task 8, R100) it is the object's lease, answered from this session's own kept lease while it
 * holds, else read: `beatAt` is the lease's `until` less OWNER_STALE_MS, so `isHeldByOther` reads it as it reads a local owner. A
 * relay that refuses is an owner that isn't this session; a relay that is down, or a record not on it, answers the local owner.
 */
export async function ownerOf($: Engine, root: string, branch: string): Promise<Owner | undefined> {
  const lease = await readLease($, root, branch)
  if ('mine' in lease) return ownerAt(lease.mine)
  if ('held' in lease && lease.held !== undefined) return ownerAt(lease.held)
  if ('free' in lease) return undefined
  if ('refused' in lease) return { sessionId: REFUSED_OWNER, beatAt: await $.clock.now() }
  const value = (await $.store.get(ownerKey(root, branch))) as Owner | undefined | null
  return value !== null && value !== undefined && typeof value.sessionId === 'string' ? value : undefined
}

/**
 * Makes `owner` the record's owner. On the relay (Task 8) that is its lease: `isTake` takes it (a person's session, R105: the same
 * principal moves it between its own sessions at once), else it is claimed (a headless session never takes a live one). The answer
 * says whether this session holds it; only a lease held, or a relay down or not in use, writes the local owner too.
 */
export async function setOwner($: Engine, root: string, branch: string, owner: Owner, opts: { isTake?: boolean } = {}): Promise<LeaseAnswer> {
  const lease = await claimLease($, root, branch, opts.isTake === true)
  if ('mine' in lease || 'local' in lease || 'down' in lease) await $.store.set(ownerKey(root, branch), owner)
  return lease
}

/** Another session beat for the record within `OWNER_STALE_MS` of `now`: it runs the lifecycle, not `me`. */
export const isHeldByOther = (owner: Owner | undefined, me: string, now: number): boolean =>
  owner !== undefined && owner.sessionId !== me && now - owner.beatAt < OWNER_STALE_MS

// ----------------------------------------------------------------- lease

/** A relay lease as a session sees it (spec §4): which session holds the object, by which principal, until when. */
export type LeaseHeld = { holder: string; principal?: string; token: number; until: number }

/**
 * What a lease call answered: this session holds it (`mine`), another holds it (`held`), nobody does (`free`), it is lost (a 409 or
 * 410: another session took it, or the object moved), `refused` (stand down, never fall back), `down` (the local owner instead), or
 * `local` (the record isn't on the relay: today's local owner).
 */
export type LeaseAnswer =
  | { mine: LeaseHeld }
  | { held: LeaseHeld }
  | { free: true }
  | { lost: string; held?: LeaseHeld }
  | { refused: string }
  | { down: string }
  | { local: true }

/** The lease the relay showed (its verifier never leaves it), or undefined for none. */
export const leaseOf = (value: unknown): LeaseHeld | undefined => {
  const one = value as Partial<LeaseHeld> | null | undefined
  if (one === null || typeof one !== 'object' || typeof one.holder !== 'string' || typeof one.until !== 'number') return undefined
  return { holder: one.holder, ...(typeof one.principal === 'string' ? { principal: one.principal } : {}), token: Number(one.token ?? 0), until: one.until }
}

const ownerAt = (lease: LeaseHeld): Owner => ({ sessionId: lease.holder, beatAt: lease.until - OWNER_STALE_MS })

/** A lease this process holds on the relay: the object's path, the holder, its fencing token, and until when it holds. */
type Kept = { key: string; holder: string; token: number; until: number }

/**
 * The lease cache (spec §4), per session and record: a session answers "is it mine" from it, with no read, while `until` is ahead.
 * Keyed by holder too, so two sessions in one process (a test's two checkouts) never read each other's.
 */
const leases = new Map<string, Kept>()

const keptKey = (holder: string, root: string, branch: string): string => `${holder}\0${recordKey(root, branch)}`

/** Forgets this session's kept lease on the record (a 409, 423 or stand-down, spec §4): its next ownership check reads the relay. */
export async function dropLease($: Engine, root: string, branch: string): Promise<void> {
  leases.delete(keptKey(await $.session.id(), root, branch))
}

/** Forgets every kept lease: a reload, or a test, starts with none. */
export const forgetLeases = (): void => leases.clear()

/**
 * Keeps a lease this session was given. It holds no longer than OWNER_STALE_MS from this clock's now, so a relay clock ahead of this
 * one never makes the cache outlive the lease. Not a function expression: the engine follows $ only into declarations.
 */
async function keepLease($: Engine, holder: string, root: string, branch: string, key: string, lease: LeaseHeld): Promise<void> {
  const until = Math.min(lease.until, (await $.clock.now()) + OWNER_STALE_MS)
  leases.set(keptKey(holder, root, branch), { key, holder, token: lease.token, until })
}

/** The relay object a record's lease is on: undefined for a record not on the relay, or why the relay can't be used now. */
async function leaseAt($: Engine, root: string, branch: string): Promise<Shared | { local: string } | undefined> {
  const mirror = await loadRecord($, root, branch)
  if (mirror?.relayRev === undefined) return undefined
  return sharedOf($, root, mirror)
}

/**
 * Claims the record's lease (`isTake`: takes it). A relay with no `take`, or that answers it with anything but a lease, a 423 or a
 * 410, is claimed instead. A 410 of this lifecycle's own move is followed once, to the PR's object.
 */
export async function claimLease($: Engine, root: string, branch: string, isTake: boolean): Promise<LeaseAnswer> {
  const at = await leaseAt($, root, branch)
  if (at === undefined) return { local: true }
  if ('local' in at) return { down: at.local }
  return claimAt($, root, branch, at, isTake, true)
}

async function claimAt($: Engine, root: string, branch: string, at: Shared, isTake: boolean, mayFollow: boolean): Promise<LeaseAnswer> {
  const holder = await $.session.id()
  // Saved before the first call that sends it (spec §6): a secret that can't be saved is never sent.
  const secret = await leaseSecret($)
  if (secret === undefined) return { down: 'the lease secret could not be saved' }
  let answer = await relayCall($, at.relay, at.path, { op: isTake ? 'take' : 'claim', holder, secret })
  if (isTake && 'status' in answer && answer.status !== 200 && answer.status !== 410 && answer.status !== 423) {
    answer = await relayCall($, at.relay, at.path, { op: 'claim', holder, secret })
  }
  if ('refused' in answer || 'down' in answer) return answer
  const lease = leaseOf(answer.json.lease)
  if (answer.status === 200 && lease !== undefined) {
    await keepLease($, holder, root, branch, at.path, lease)
    return { mine: lease }
  }
  leases.delete(keptKey(holder, root, branch))
  if (answer.status === 423) return lease === undefined ? { lost: 'the lease is held' } : { held: lease }
  if (answer.status === 410 && mayFollow && typeof answer.json.movedTo === 'number') {
    const mirror = await loadRecord($, root, branch)
    if (mirror?.lifecycleId !== undefined && mirror.lifecycleId === answer.json.lifecycleId) {
      return claimAt($, root, branch, atKey(at, `#${answer.json.movedTo}`), isTake, false)
    }
  }
  return { lost: answer.status === 410 ? 'the record moved' : `HTTP ${answer.status}` }
}

/**
 * The beat at an action boundary (spec §4): a `beat` of the lease this session keeps, or, with none kept for this object, a `claim`
 * (never a take). `mine` only on a 200; a 409, 423 or 410 empties this session's kept lease and answers `lost`.
 */
export async function beatLease(
  $: Engine,
  root: string,
  branch: string,
  mayClaim: () => Promise<boolean> = async () => true,
): Promise<LeaseAnswer | { unkept: true }> {
  const at = await leaseAt($, root, branch)
  if (at === undefined) return { local: true }
  if ('local' in at) return { down: at.local }
  const holder = await $.session.id()
  const kept = leases.get(keptKey(holder, root, branch))
  // With none kept for this object, `mayClaim` says whether to claim one (Task 8 review): `unkept` when it may not.
  if (kept === undefined || kept.key !== at.path) return (await mayClaim()) ? claimAt($, root, branch, at, false, true) : { unkept: true }
  const secret = await leaseSecret($)
  if (secret === undefined) return { down: 'the lease secret could not be saved' }
  const answer = await relayCall($, at.relay, at.path, { op: 'beat', secret })
  if ('down' in answer) return answer
  if ('refused' in answer) {
    leases.delete(keptKey(holder, root, branch))
    return answer
  }
  const lease = leaseOf(answer.json.lease)
  if (answer.status === 200 && lease !== undefined) {
    await keepLease($, holder, root, branch, at.path, lease)
    return { mine: lease }
  }
  leases.delete(keptKey(holder, root, branch))
  const now = await $.clock.now()
  const other = lease !== undefined && lease.until > now && lease.holder !== holder ? { held: lease } : {}
  return { lost: answer.status === 410 ? 'the record moved' : `the lease is lost (HTTP ${answer.status})`, ...other }
}

/** Who holds the record's lease: this session's kept lease while it holds, with no network read; else the object's, read. */
export async function readLease($: Engine, root: string, branch: string): Promise<LeaseAnswer> {
  const at = await leaseAt($, root, branch)
  if (at === undefined) return { local: true }
  if ('local' in at) return { down: at.local }
  const holder = await $.session.id()
  const now = await $.clock.now()
  const kept = leases.get(keptKey(holder, root, branch))
  if (kept !== undefined && kept.key === at.path && kept.until > now) return { mine: { holder, token: kept.token, until: kept.until } }
  const answer = await relayCall($, at.relay, at.path, { op: 'read' })
  if ('refused' in answer || 'down' in answer) return answer
  if (answer.status !== 200) return { down: `HTTP ${answer.status}` }
  const lease = leaseOf(answer.json.lease)
  if (lease === undefined || lease.until <= now) return { free: true }
  if (lease.holder !== holder) return { held: lease }
  await keepLease($, holder, root, branch, at.path, lease)
  return { mine: lease }
}

/**
 * Releases the lease this session keeps on the record, at the end of its run (spec §4): only one it claimed or took. A release that
 * doesn't land is owed, as a move's is; one the relay answers otherwise (the lease lapsed or was taken) is done.
 */
export async function releaseLease($: Engine, root: string, branch: string): Promise<void> {
  const holder = await $.session.id()
  const kept = leases.get(keptKey(holder, root, branch))
  if (kept === undefined) return
  leases.delete(keptKey(holder, root, branch))
  const at = await leaseAt($, root, branch)
  if (at === undefined || 'local' in at) return
  const secret = await leaseSecret($)
  if (secret === undefined) return
  const body = { op: 'release', secret }
  const answer = await relayCall($, at.relay, kept.key, body)
  if ('down' in answer) await owe($, root, branch, { path: kept.key, body })
}

// ------------------------------------------------------------------- log

/** How many run-log lines a record keeps: the oldest go first. */
export const LOG_CAP = 200

/** Adds a line to the record's run log (`/pr-gate log`). Takes the record's lock: never call it from inside `updateRecord`. */
export async function logEvent($: Engine, root: string, branch: string, kind: LogEntry['kind'], text: string): Promise<void> {
  const at = await $.clock.now()
  if (await lockRecord(root, branch, () => logOnRelay($, root, branch, at, kind, text))) return
  await updateRecord($, root, branch, rec => ({ ...rec, log: [...(rec.log ?? []), { at, kind, text: text.slice(0, 300) }].slice(-LOG_CAP) }), { isPure: true })
}

/**
 * A line of a record on the relay goes to its object's own log (R106): apart from the record, so with no rev and no lease, and a
 * checkout that doesn't hold the lease logs too. Its text is scrubbed as the record's is (R107). A line the relay doesn't take is kept
 * in the local record's log and the round goes on; a refusal stands the store down. False for a record not on the relay.
 */
async function logOnRelay($: Engine, root: string, branch: string, at: number, kind: LogEntry['kind'], text: string): Promise<boolean> {
  const mirror = await loadRecord($, root, branch)
  if (mirror?.relayRev === undefined) return false
  const shared = await sharedOf($, root, mirror)
  if ('local' in shared) return false
  const line = text.slice(0, 300)
  const secureIds = secureIdsOf(mirror.findings)
  const isNamed = namerOf(mirror.findings.filter(one => secureIds.has(one.id)))
  const sent = isNamed === undefined ? line : (scrub(line, isNamed) as string)
  const answer = await relayCall($, shared.relay, shared.path, { op: 'log', at, kind, text: sent, holder: await $.session.id() })
  if ('refused' in answer) return standDown($, root, branch, answer.refused)
  if (!('down' in answer) && answer.status === 200) {
    await payOwed($, root, branch, shared.relay)
    return true
  }
  await $.store.set(recordKey(root, branch), { ...mirror, log: [...(mirror.log ?? []), { at, kind, text: line }].slice(-LOG_CAP) })
  if ('down' in answer) {
    await noteOnce($, root, branch, 'relay down', `relay down (${answer.down}): this lifecycle's run log goes on in the local store meanwhile`)
  }
  return true
}

/** A relay object's run log (R106): its lines, oldest first, and how many earlier lines its cap of 1000 dropped. */
export type RelayLog = { lines: LogEntry[]; dropped: number }

/**
 * The branch lifecycle's run log as the relay keeps it, for `/pr-gate log`: the object's log, and for a lifecycle that moved to its
 * PR, the branch object's log from before the move as `movedFrom`. A record not on the relay, or a relay that can't be asked, answers
 * the local record's own log; a refusal stands the store down.
 */
export async function relayLog($: Engine, root: string, branch: string): Promise<RelayLog & { movedFrom?: RelayLog }> {
  const mirror = await loadRecord($, root, branch)
  const own: RelayLog = { lines: mirror?.log ?? [], dropped: 0 }
  if (mirror?.relayRev === undefined) return own
  const found = await sharedOf($, root, mirror)
  if ('local' in found) return own
  const read = async (at: Shared): Promise<{ log: RelayLog; record: unknown } | undefined> => {
    const answer = await relayCall($, at.relay, at.path, { op: 'read' })
    if ('refused' in answer) return standDown($, root, branch, answer.refused)
    if ('down' in answer || answer.status !== 200) return undefined
    const lines = (Array.isArray(answer.json.log) ? answer.json.log : []) as { at: number; kind: LogEntry['kind']; text: string }[]
    const log = { lines: lines.map(one => ({ at: one.at, kind: one.kind, text: one.text })), dropped: Number(answer.json.logDropped ?? 0) }
    return { log, record: answer.json.record }
  }
  const here = await read(found)
  if (here === undefined) return own
  const tomb = tombOf(here.record)
  if (tomb !== undefined && tomb.lifecycleId === mirror.lifecycleId) {
    // The branch's object, moved since this checkout last read it: its log comes first, the PR's after.
    const after = await read(atKey(found, `#${tomb.movedTo}`))
    return after === undefined ? { ...own, movedFrom: here.log } : { ...after.log, movedFrom: here.log }
  }
  if (!found.key.startsWith('#')) return here.log
  const before = await read(atKey(found, `@${branch}`))
  const was = before === undefined ? undefined : tombOf(before.record)
  const isMoved = before !== undefined && was !== undefined && `#${was.movedTo}` === found.key && was.lifecycleId === mirror.lifecycleId
  return isMoved ? { ...here.log, movedFrom: before.log } : here.log
}

/**
 * The branch's newest archived record (R47), for a log asked for after the lifecycle closed. A record on the relay reads its object's
 * `archives` too, and the branch object's for one that moved to its PR: the newest of all wins, a local copy over the relay's of the
 * same time (it keeps the security text).
 */
export async function latestArchive($: Engine, root: string, branch: string): Promise<LifecycleRecord | undefined> {
  const prefix = `${recordKey(root, branch)}:archived:`
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix))
  const newest = keys.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))).at(-1)
  const kept = newest === undefined ? undefined : ((await $.store.get(newest)) as LifecycleRecord | undefined)
  const mirror = await loadRecord($, root, branch)
  if (mirror?.relayRev === undefined) return kept
  const found = await sharedOf($, root, mirror)
  if ('local' in found) return kept
  let best = { at: newest === undefined ? -Infinity : Number(newest.slice(prefix.length)), record: kept }
  for (const at of found.key.startsWith('#') ? [found, atKey(found, `@${branch}`)] : [found]) {
    const answer = await relayCall($, at.relay, at.path, { op: 'archives' })
    if ('refused' in answer) return standDown($, root, branch, answer.refused)
    if ('down' in answer || answer.status !== 200 || !Array.isArray(answer.json.archives)) continue
    for (const one of answer.json.archives as { at: number; record: LifecycleRecord }[]) {
      if (one.at > best.at) best = { at: one.at, record: { ...restore(one.record, mirror), root, branch } }
    }
  }
  return best.record
}
