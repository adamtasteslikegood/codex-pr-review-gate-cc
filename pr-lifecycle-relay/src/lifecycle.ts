// One Durable Object per pull request (`owner/repo#pr`): the lifecycle record, its lease, its archives and its filing ledger
// (#29 Part B). A Durable Object runs one request at a time and every request here touches only its own storage, so each operation is
// atomic: the grant, the lease and the revision are checked in the same step that writes.

import { isAdmin, type Preset, type Principal } from './auth.ts'
import type { DurableObjectState, Env } from './types.ts'

/**
 * Who holds the lifecycle now (R74's owner, fenced). `token` is the public fence: each new holder gets a higher one. The holder's
 * capability is a secret its checkout makes and sends with each call; the object keeps only its SHA-256 `verifier` and never returns it.
 * A write under a live lease must come from the same principal proving the same secret, so neither reading the lease nor seeing any
 * response grants anything, and a checkout that lost a response retries with the secret it already has.
 */
export type Lease = { holder: string; principal: string; token: number; until: number; verifier: string }

/**
 * A filing claim belongs to the principal and checkout (its secret) that made it: only they complete it, and a completed one never changes.
 * The one exception is `fileAdopt`: once a claim is stale, the lease holder finishes it with the issue it found, recorded as `adoptedBy`.
 */
export type Filing = { state: 'claimed' | 'done'; actor: string; at: number; verifier: string; result?: unknown; adoptedBy?: string }

type Write = { actor: string; op: string; at: number; rev: number }

type State = {
  rev: number
  record: unknown
  lease: Lease | null
  /** The last lease token handed out: each new holder gets a higher one, so a stale holder's writes are refused. */
  fence: number
  archives: { at: number; record: unknown; actor?: string; reason?: string }[]
  filings: Record<string, Filing>
  /** Who changed what, newest last. */
  writes: Write[]
  /** Set once the record has moved to that PR's object: `record` is then a Tombstone and the branch cannot be driven (R103). */
  movedTo?: number
}

/** One line of the run log (R106): `seq` is the object's counter, so a cursor on it loses no line even when many share an `at`. */
export type LogLine = { seq: number; at: number; kind: string; text: string; principal: string; holder: string }

/** The log has its own storage key, so a long log never makes a record commit larger. */
type LogStore = { lines: LogLine[]; dropped: number; seq: number }

/** What a frozen branch object holds as its record. `record` stays from `moveTo` until `moveDone`. */
export type Tombstone = { movedTo: number; lifecycleId: string; record?: unknown }

/** The ops a tombstone refuses with 410, apart from a fresh start: every record and lease op, so no boundary beat succeeds on the source. */
const FROZEN_OPS = new Set(['commit', 'claim', 'beat', 'take', 'release', 'moveTo'])

/** R106: the relay keeps the last 1000 log lines per object; older ones are counted in `logDropped`. */
export const RELAY_LOG_CAP = 1000
const LOG_TEXT_MAX = 300
const SNAPSHOT_REASONS = new Set(['fallback', 'migration', 'move'])

/** How many archives a PR keeps (open decision 3: retention). */
export const ARCHIVE_CAP = 20
const WRITE_CAP = 100
/** R74: a session quiet for 2 minutes may be taken over. */
const LEASE_MS = 120_000
/** A filing claim older than the step timeout (30 minutes) may be adopted by the lease holder (PR #51 review, G1-2). */
export const FILING_STALE_MS = 1_800_000

const empty = (): State => ({ rev: 0, record: null, lease: null, fence: 0, archives: [], filings: {}, writes: [] })

/** What any response shows of a lease or a filing: everything but the capability's verifier. */
const shown = <T extends { verifier: string }>(one: T | null | undefined): Omit<T, 'verifier'> | null => {
  if (one === null || one === undefined) return null
  const { verifier: _, ...rest } = one
  return rest
}

/** A caller's secret must be long enough not to be guessed; its verifier is the hex SHA-256. */
const MIN_SECRET = 32

const verifierOf = async (secret: unknown): Promise<string | undefined> => {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) return undefined
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Need = 'read' | 'operate' | 'admin'

const NEEDS: Record<string, Need> = {
  read: 'read',
  archives: 'read',
  filing: 'read',
  commit: 'operate',
  claim: 'operate',
  take: 'operate',
  log: 'operate',
  snapshot: 'operate',
  beat: 'operate',
  release: 'operate',
  moveTo: 'operate',
  moveDone: 'operate',
  fileClaim: 'operate',
  fileDone: 'operate',
  fileAdopt: 'operate',
  breakLease: 'admin',
  fileDelete: 'admin',
}

export class LifecycleObject {
  private readonly state: DurableObjectState
  private readonly env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const who = JSON.parse(request.headers.get('x-relay-principal') ?? 'null') as Principal | null
    const repo = request.headers.get('x-relay-repo') ?? ''
    const isBranch = (request.headers.get('x-relay-key') ?? '').startsWith('@')
    if (who === null) return reply(401, { error: 'no principal' })
    const body = (await request.json()) as { op?: string; [key: string]: unknown }
    const op = body.op ?? ''
    const need = NEEDS[op]
    if (need === undefined) return reply(400, { error: `unknown op ${op}` })
    // The Worker always overwrites this header with the GrantStore's answer; the object trusts it only for that reason.
    const given = request.headers.get('x-relay-preset')
    const preset: Preset | undefined = given === 'read' || given === 'operate' ? given : undefined
    const isAllowed = need === 'admin' ? isAdmin(this.env, who) : need === 'read' ? preset !== undefined : preset === 'operate'
    if (!isAllowed) return reply(403, { error: `${who.id} may not ${op} on ${repo}` })
    const now = Date.now()
    const s = (await this.state.storage.get<State>('state')) ?? empty()
    const leaseMs = Number(this.env.LEASE_MS ?? LEASE_MS)
    const isLive = (lease: Lease | null): lease is Lease => lease !== null && lease.until > now
    const proof = await verifierOf(body.secret)
    const isMine = (one: { principal?: string; actor?: string; verifier: string }): boolean =>
      (one.principal ?? one.actor) === who.id && proof !== undefined && one.verifier === proof
    // A plain object inherits `__proto__` and `constructor`: a filing is only ever an own property.
    const filingOf = (key: string): Filing | undefined => (Object.hasOwn(s.filings, key) ? s.filings[key] : undefined)
    const save = async (next: State, what: string): Promise<void> => {
      next.writes = [...next.writes, { actor: who.id, op: what, at: now, rev: next.rev }].slice(-WRITE_CAP)
      await this.state.storage.put({ state: next })
    }

    const logOf = async (): Promise<LogStore> => (await this.state.storage.get<LogStore>('log')) ?? { lines: [], dropped: 0, seq: 0 }

    const tomb = s.movedTo !== undefined ? (s.record as Tombstone) : undefined
    const frozen = tomb === undefined ? undefined : reply(410, { movedTo: tomb.movedTo, lifecycleId: tomb.lifecycleId })
    // A fresh start (a new lifecycle over the old name) is the one commit a tombstone takes; every other record or lease op is refused.
    if (frozen !== undefined && FROZEN_OPS.has(op) && !(op === 'commit' && body.isFresh === true)) return frozen

    switch (op) {
      case 'read':
      {
        const log = await logOf()
        const since = typeof body.logSince === 'number' ? body.logSince : 0
        const lines = since > 0 ? log.lines.filter(line => line.seq > since) : log.lines
        const lastWrite = s.writes.at(-1) ?? null
        return reply(200, { rev: s.rev, record: s.record, lease: shown(s.lease), lastWrite, log: lines, logDropped: log.dropped, logSeq: log.seq })
      }
      case 'archives':
        return reply(200, { archives: s.archives })
      case 'filing':
        return reply(200, { filing: shown(filingOf(String(body.key))) })
      case 'commit': {
        // `from` names the branch a record moves from: it only ever lands on an empty PR object. A non-empty one answers with its record,
        // whose lifecycleId tells the client whether an earlier move got this far.
        if (body.from !== undefined) {
          if (isBranch || typeof body.from !== 'string' || !body.from.startsWith('@')) return reply(400, { error: 'from is a branch key, on a PR object only' })
          if (s.rev !== 0 || s.record !== null) return reply(409, { error: 'the PR object is not empty', rev: s.rev, record: s.record })
        }
        if (frozen !== undefined) {
          const id = (body.record as { lifecycleId?: unknown } | null | undefined)?.lifecycleId
          if (typeof id !== 'string') return reply(400, { error: 'a fresh start needs a record with a lifecycleId' })
          if (id === tomb!.lifecycleId) return frozen
          // Until moveDone, the tombstone holds the only copy of a record the PR object may not have yet.
          if (tomb!.record !== undefined) return reply(409, { error: 'the move is not finished', movedTo: tomb!.movedTo, lifecycleId: tomb!.lifecycleId })
        }
        // A commit names the revision it read: a stale one is refused with what is there now, never merged blindly.
        if (body.rev !== s.rev) return reply(409, { error: 'stale revision', rev: s.rev, record: s.record })
        if (isLive(s.lease) && !isMine(s.lease)) return reply(423, { error: 'the lease is held', lease: shown(s.lease) })
        // An archive keeps the record the caller archived (the local store's `tx.archive(rec, at)`), not whatever is stored now.
        const archive = body.archive as { at?: unknown; record?: unknown } | null | undefined
        if (archive !== undefined && (archive === null || typeof archive.at !== 'number' || archive.record === undefined)) return reply(400, { error: 'archive needs { at, record }' })
        const archives = archive !== undefined ? [...s.archives, { at: archive.at as number, record: archive.record }].slice(-ARCHIVE_CAP) : s.archives
        const next: State = { ...s, rev: s.rev + 1, record: body.record ?? null, archives }
        delete next.movedTo
        await save(next, archive !== undefined ? 'commit+archive' : 'commit')
        return reply(200, { rev: next.rev })
      }
      case 'claim': {
        const holder = String(body.holder ?? '')
        if (holder === '') return reply(400, { error: 'claim needs a holder' })
        if (proof === undefined) return reply(400, { error: `claim needs a secret of at least ${MIN_SECRET} characters` })
        // A live lease is renewed only by its own holder, principal and capability; anyone else waits for it to lapse.
        if (isLive(s.lease) && (s.lease.holder !== holder || !isMine(s.lease))) return reply(423, { error: 'the lease is held', lease: shown(s.lease) })
        const isRenewal = isLive(s.lease)
        const token = isRenewal ? s.lease!.token : s.fence + 1
        const lease: Lease = { holder, principal: who.id, token, until: now + leaseMs, verifier: proof }
        const next = { ...s, lease, fence: Math.max(s.fence, token) }
        await save(next, isRenewal ? 'claim (renewed)' : s.lease === null ? 'claim' : `claim (took over from ${s.lease.holder})`)
        return reply(200, { lease: shown(lease) })
      }
      case 'take': {
        // Decision P(b): the same principal moves between its own sessions at once, with a new token that fences the old one out.
        // Another principal waits for a lapse or an admin; a lapsed or empty lease is simply claimed.
        const holder = String(body.holder ?? '')
        if (holder === '') return reply(400, { error: 'take needs a holder' })
        if (proof === undefined) return reply(400, { error: `take needs a secret of at least ${MIN_SECRET} characters` })
        if (isLive(s.lease) && s.lease.principal !== who.id) return reply(423, { error: 'the lease is held by another principal', lease: shown(s.lease) })
        const token = s.fence + 1
        const lease: Lease = { holder, principal: who.id, token, until: now + leaseMs, verifier: proof }
        await save({ ...s, lease, fence: token }, isLive(s.lease) ? `take from ${s.lease.holder}` : 'take')
        return reply(200, { lease: shown(lease) })
      }
      case 'log': {
        // Lease-free: standDown and takeover lines are logged by sessions that do not hold the lease. No rev, no write history.
        if (typeof body.at !== 'number' || typeof body.kind !== 'string' || typeof body.text !== 'string') return reply(400, { error: 'log needs { at, kind, text }' })
        const log = await logOf()
        const seq = log.seq + 1
        const line: LogLine = { seq, at: body.at, kind: body.kind, text: body.text.slice(0, LOG_TEXT_MAX), principal: who.id, holder: String(body.holder ?? '') }
        const lines = [...log.lines, line]
        const over = Math.max(0, lines.length - RELAY_LOG_CAP)
        const next: LogStore = { lines: lines.slice(over), dropped: log.dropped + over, seq }
        await this.state.storage.put({ log: next })
        return reply(200, { logDropped: next.dropped })
      }
      case 'snapshot': {
        if (typeof body.at !== 'number' || body.record === undefined || typeof body.reason !== 'string' || !SNAPSHOT_REASONS.has(body.reason)) {
          return reply(400, { error: 'snapshot needs { at, record, reason: fallback | migration | move }' })
        }
        const archives = [...s.archives, { at: body.at, record: body.record, actor: who.id, reason: body.reason }].slice(-ARCHIVE_CAP)
        await save({ ...s, archives }, `snapshot (${body.reason})`)
        return reply(200, {})
      }
      case 'beat': {
        // A lapsed lease is lost even to its holder: reviving it would block a takeover that is already allowed.
        if (!isLive(s.lease) || !isMine(s.lease)) return reply(409, { error: 'the lease is lost', lease: shown(s.lease) })
        const lease = { ...s.lease, until: now + leaseMs }
        await save({ ...s, lease }, 'beat')
        return reply(200, { lease: shown(lease) })
      }
      case 'release': {
        if (!isLive(s.lease) || !isMine(s.lease)) return reply(409, { error: 'the lease is lost', lease: shown(s.lease) })
        await save({ ...s, lease: null }, 'release')
        return reply(200, {})
      }
      case 'moveTo': {
        if (!isBranch) return reply(404, { error: 'only a branch object moves' })
        if (!isLive(s.lease) || !isMine(s.lease)) return reply(409, { error: 'the lease is lost', lease: shown(s.lease) })
        const pr = body.pr
        if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return reply(400, { error: 'moveTo needs a pr number' })
        const id = (s.record as { lifecycleId?: unknown } | null)?.lifecycleId
        if (typeof id !== 'string') return reply(409, { error: 'no record with a lifecycleId to move' })
        const tombstone: Tombstone = { movedTo: pr, lifecycleId: id, record: s.record }
        const next: State = { ...s, rev: s.rev + 1, record: tombstone, lease: null, movedTo: pr }
        await save(next, `moveTo #${pr}`)
        return reply(200, { rev: next.rev })
      }
      case 'moveDone': {
        if (!isBranch) return reply(404, { error: 'only a branch object moves' })
        if (tomb === undefined || tomb.lifecycleId !== body.lifecycleId) return reply(409, { error: 'not moved with that lifecycleId' })
        // Again is a no-op. The lease was released by moveTo, so this needs operate only.
        if (tomb.record === undefined) return reply(200, {})
        const bare: Tombstone = { movedTo: tomb.movedTo, lifecycleId: tomb.lifecycleId }
        await save({ ...s, record: bare }, 'moveDone')
        return reply(200, {})
      }
      case 'breakLease':
        await save({ ...s, lease: null }, 'breakLease')
        return reply(200, {})
      case 'fileClaim': {
        // The claim key is `lifecycleId:findingId:attempt` (open decision 2): a second claim of it finds the first, never a new issue.
        const key = String(body.key ?? '')
        if (key === '') return reply(400, { error: 'fileClaim needs a key' })
        if (proof === undefined) return reply(400, { error: `fileClaim needs a secret of at least ${MIN_SECRET} characters` })
        const known = filingOf(key)
        // A retry by the claimant (same principal, same secret) learns the claim is its own, so a lost first answer is no dead end.
        if (known !== undefined) return reply(200, { isFresh: false, isMine: isMine(known), filing: shown(known) })
        const filing: Filing = { state: 'claimed', actor: who.id, at: now, verifier: proof }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileClaim ${key}`)
        return reply(200, { isFresh: true, isMine: true, filing: shown(filing) })
      }
      case 'fileDone': {
        const key = String(body.key ?? '')
        const known = filingOf(key)
        if (known === undefined) return reply(409, { error: 'no claim to finish' })
        if (!isMine(known)) return reply(403, { error: 'only the claimant may finish a filing', filing: shown(known) })
        // Done is terminal: the same answer again is a retry, a different one is refused. A rewrite is fileDelete, by an admin.
        if (known.state === 'done') {
          const isSame = JSON.stringify(known.result) === JSON.stringify(body.result)
          return reply(isSame ? 200 : 409, isSame ? { filing: shown(known) } : { error: 'the filing is done', filing: shown(known) })
        }
        const filing: Filing = { ...known, state: 'done', result: body.result, at: now }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileDone ${key}`)
        return reply(200, { filing: shown(filing) })
      }
      case 'fileAdopt': {
        // A claimant whose secret is lost can never finish its claim. Once the claim is stale, the driver (the live lease's holder)
        // finishes it with the issue the exact-mark search found. The claimant stays the actor; the adopter is recorded beside it.
        const key = String(body.key ?? '')
        const known = filingOf(key)
        if (!isLive(s.lease) || !isMine(s.lease)) return reply(423, { error: 'only the lease holder adopts a filing', lease: shown(s.lease) })
        if (known === undefined) return reply(409, { error: 'no claim to adopt' })
        if (body.result === undefined) return reply(400, { error: 'fileAdopt needs a result' })
        if (known.state === 'done') {
          const isSame = JSON.stringify(known.result) === JSON.stringify(body.result)
          return reply(isSame ? 200 : 409, isSame ? { filing: shown(known) } : { error: 'the filing is done', filing: shown(known) })
        }
        if (now - known.at < Number(this.env.FILING_STALE_MS ?? FILING_STALE_MS)) return reply(409, { error: 'the claim is not stale yet', filing: shown(known) })
        const filing: Filing = { ...known, state: 'done', result: body.result, at: now, adoptedBy: who.id }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileAdopt ${key}`)
        return reply(200, { filing: shown(filing) })
      }
      case 'fileDelete': {
        const key = String(body.key ?? '')
        const filings = { ...s.filings }
        delete filings[key]
        await save({ ...s, filings }, `fileDelete ${key}`)
        return reply(200, {})
      }
    }
    return reply(400, { error: `unknown op ${op}` })
  }
}
