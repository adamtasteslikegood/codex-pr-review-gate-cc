// One Durable Object per pull request (`owner/repo#pr`): the lifecycle record, its lease, its archives and its filing ledger
// (#29 Part B). A Durable Object runs one request at a time and every request here touches only its own storage, so each operation is
// atomic: the grant, the lease and the revision are checked in the same step that writes.

import { isAdmin, presetOf, type Principal } from './auth.ts'
import type { DurableObjectState, Env } from './types.ts'

/**
 * Who holds the lifecycle now (R74's owner, fenced). `token` is the public fence: each new holder gets a higher one. `secret` is the
 * holder's capability, returned only to the claim that made the lease and never by a read: a write under a live lease must come from the
 * same principal and carry it, so reading the lease grants nothing.
 */
export type Lease = { holder: string; principal: string; token: number; until: number; secret: string }

/** A filing claim belongs to the principal and checkout that made it: only they may complete it, and a completed one never changes. */
export type Filing = { state: 'claimed' | 'done'; actor: string; at: number; secret: string; result?: unknown }

type Write = { actor: string; op: string; at: number; rev: number }

type State = {
  rev: number
  record: unknown
  lease: Lease | null
  /** The last lease token handed out: each new holder gets a higher one, so a stale holder's writes are refused. */
  fence: number
  archives: { at: number; record: unknown }[]
  filings: Record<string, Filing>
  /** Who changed what, newest last. */
  writes: Write[]
}

/** How many archives a PR keeps (open decision 3: retention). */
export const ARCHIVE_CAP = 20
const WRITE_CAP = 100
/** R74: a session quiet for 2 minutes may be taken over. */
const LEASE_MS = 120_000

const empty = (): State => ({ rev: 0, record: null, lease: null, fence: 0, archives: [], filings: {}, writes: [] })

/** What anyone with `read` may see of a lease or a filing: everything but the capability. */
const shown = <T extends { secret: string }>(one: T | null | undefined): Omit<T, 'secret'> | null => {
  if (one === null || one === undefined) return null
  const { secret: _, ...rest } = one
  return rest
}

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Need = 'read' | 'operate' | 'admin'

const NEEDS: Record<string, Need> = {
  read: 'read',
  archives: 'read',
  filing: 'read',
  commit: 'operate',
  claim: 'operate',
  beat: 'operate',
  release: 'operate',
  fileClaim: 'operate',
  fileDone: 'operate',
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
    if (who === null) return reply(401, { error: 'no principal' })
    const body = (await request.json()) as { op?: string; [key: string]: unknown }
    const op = body.op ?? ''
    const need = NEEDS[op]
    if (need === undefined) return reply(400, { error: `unknown op ${op}` })
    const preset = presetOf(this.env, who, repo)
    const isAllowed = need === 'admin' ? isAdmin(this.env, who) : need === 'read' ? preset !== undefined : preset === 'operate'
    if (!isAllowed) return reply(403, { error: `${who.id} may not ${op} on ${repo}` })
    const now = Date.now()
    const s = (await this.state.storage.get<State>('state')) ?? empty()
    const leaseMs = Number(this.env.LEASE_MS ?? LEASE_MS)
    const isLive = (lease: Lease | null): lease is Lease => lease !== null && lease.until > now
    const isMine = (lease: Lease): boolean => lease.principal === who.id && typeof body.secret === 'string' && lease.secret === body.secret
    // A plain object inherits `__proto__` and `constructor`: a filing is only ever an own property.
    const filingOf = (key: string): Filing | undefined => (Object.hasOwn(s.filings, key) ? s.filings[key] : undefined)
    const save = async (next: State, what: string): Promise<void> => {
      next.writes = [...next.writes, { actor: who.id, op: what, at: now, rev: next.rev }].slice(-WRITE_CAP)
      await this.state.storage.put({ state: next })
    }

    switch (op) {
      case 'read':
        return reply(200, { rev: s.rev, record: s.record, lease: shown(s.lease), lastWrite: s.writes.at(-1) ?? null })
      case 'archives':
        return reply(200, { archives: s.archives })
      case 'filing':
        return reply(200, { filing: shown(filingOf(String(body.key))) })
      case 'commit': {
        // A commit names the revision it read: a stale one is refused with what is there now, never merged blindly.
        if (body.rev !== s.rev) return reply(409, { error: 'stale revision', rev: s.rev, record: s.record })
        if (isLive(s.lease) && !isMine(s.lease)) return reply(423, { error: 'the lease is held', lease: shown(s.lease) })
        const archives =
          typeof body.archiveAt === 'number' && s.record !== null ? [...s.archives, { at: body.archiveAt, record: s.record }].slice(-ARCHIVE_CAP) : s.archives
        const next = { ...s, rev: s.rev + 1, record: body.record ?? null, archives }
        await save(next, typeof body.archiveAt === 'number' ? 'commit+archive' : 'commit')
        return reply(200, { rev: next.rev })
      }
      case 'claim': {
        const holder = String(body.holder ?? '')
        if (holder === '') return reply(400, { error: 'claim needs a holder' })
        // A live lease is renewed only by its own holder, principal and capability; anyone else waits for it to lapse.
        if (isLive(s.lease) && (s.lease.holder !== holder || !isMine(s.lease))) return reply(423, { error: 'the lease is held', lease: shown(s.lease) })
        const isRenewal = isLive(s.lease)
        const token = isRenewal ? s.lease!.token : s.fence + 1
        const lease: Lease = { holder, principal: who.id, token, until: now + leaseMs, secret: isRenewal ? s.lease!.secret : crypto.randomUUID() }
        const next = { ...s, lease, fence: Math.max(s.fence, token) }
        await save(next, isRenewal ? 'claim (renewed)' : s.lease === null ? 'claim' : `claim (took over from ${s.lease.holder})`)
        return reply(200, { lease })
      }
      case 'beat': {
        // A lapsed lease is lost even to its holder: reviving it would block a takeover that is already allowed.
        if (!isLive(s.lease) || !isMine(s.lease)) return reply(409, { error: 'the lease is lost', lease: shown(s.lease) })
        const lease = { ...s.lease, until: now + leaseMs }
        await save({ ...s, lease }, 'beat')
        return reply(200, { lease })
      }
      case 'release': {
        if (!isLive(s.lease) || !isMine(s.lease)) return reply(409, { error: 'the lease is lost', lease: shown(s.lease) })
        await save({ ...s, lease: null }, 'release')
        return reply(200, {})
      }
      case 'breakLease':
        await save({ ...s, lease: null }, 'breakLease')
        return reply(200, {})
      case 'fileClaim': {
        // The claim key is `lifecycleId:findingId:attempt` (open decision 2): a second claim of it finds the first, never a new issue.
        const key = String(body.key ?? '')
        if (key === '') return reply(400, { error: 'fileClaim needs a key' })
        const known = filingOf(key)
        if (known !== undefined) return reply(200, { isFresh: false, filing: shown(known) })
        const filing: Filing = { state: 'claimed', actor: who.id, at: now, secret: crypto.randomUUID() }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileClaim ${key}`)
        return reply(200, { isFresh: true, filing })
      }
      case 'fileDone': {
        const key = String(body.key ?? '')
        const known = filingOf(key)
        if (known === undefined) return reply(409, { error: 'no claim to finish' })
        if (known.actor !== who.id || known.secret !== body.secret) return reply(403, { error: 'only the claimant may finish a filing', filing: shown(known) })
        // Done is terminal: the same answer again is a retry, a different one is refused. A rewrite is fileDelete, by an admin.
        if (known.state === 'done') {
          const isSame = JSON.stringify(known.result) === JSON.stringify(body.result)
          return reply(isSame ? 200 : 409, isSame ? { filing: shown(known) } : { error: 'the filing is done', filing: shown(known) })
        }
        const filing: Filing = { ...known, state: 'done', result: body.result, at: now }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileDone ${key}`)
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
