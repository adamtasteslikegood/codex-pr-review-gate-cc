// One Durable Object per pull request (`owner/repo#pr`): the lifecycle record, its lease, its archives and its filing ledger
// (#29 Part B). A Durable Object runs one request at a time and every request here touches only its own storage, so each operation is
// atomic: the grant, the lease and the revision are checked in the same step that writes.

import { isAdmin, presetOf, type Principal } from './auth.ts'
import type { DurableObjectState, Env } from './types.ts'

/** Who holds the lifecycle now (R74's owner, fenced): a write must carry the live lease's token. */
export type Lease = { holder: string; token: number; until: number }

export type Filing = { state: 'claimed' | 'done'; actor: string; at: number; result?: unknown }

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
    const save = async (next: State, what: string): Promise<void> => {
      next.writes = [...next.writes, { actor: who.id, op: what, at: now, rev: next.rev }].slice(-WRITE_CAP)
      await this.state.storage.put({ state: next })
    }

    switch (op) {
      case 'read':
        return reply(200, { rev: s.rev, record: s.record, lease: s.lease, lastWrite: s.writes.at(-1) ?? null })
      case 'archives':
        return reply(200, { archives: s.archives })
      case 'filing':
        return reply(200, { filing: s.filings[String(body.key)] ?? null })
      case 'commit': {
        // A commit names the revision it read: a stale one is refused with what is there now, never merged blindly.
        if (body.rev !== s.rev) return reply(409, { error: 'stale revision', rev: s.rev, record: s.record })
        if (isLive(s.lease) && s.lease.token !== body.token) return reply(423, { error: 'the lease is held', lease: s.lease })
        const archives =
          typeof body.archiveAt === 'number' && s.record !== null ? [...s.archives, { at: body.archiveAt, record: s.record }].slice(-ARCHIVE_CAP) : s.archives
        const next = { ...s, rev: s.rev + 1, record: body.record ?? null, archives }
        await save(next, typeof body.archiveAt === 'number' ? 'commit+archive' : 'commit')
        return reply(200, { rev: next.rev })
      }
      case 'claim': {
        const holder = String(body.holder ?? '')
        if (holder === '') return reply(400, { error: 'claim needs a holder' })
        if (isLive(s.lease) && s.lease.holder !== holder) return reply(423, { error: 'the lease is held', lease: s.lease })
        const isRenewal = isLive(s.lease) && s.lease.holder === holder
        const token = isRenewal ? s.lease!.token : s.fence + 1
        const lease = { holder, token, until: now + leaseMs }
        const next = { ...s, lease, fence: Math.max(s.fence, token) }
        await save(next, isRenewal ? 'claim (renewed)' : s.lease === null ? 'claim' : `claim (took over from ${s.lease.holder})`)
        return reply(200, { lease })
      }
      case 'beat': {
        if (s.lease === null || s.lease.token !== body.token) return reply(409, { error: 'the lease is lost', lease: s.lease })
        const lease = { ...s.lease, until: now + leaseMs }
        await this.state.storage.put({ state: { ...s, lease } })
        return reply(200, { lease })
      }
      case 'release': {
        if (s.lease === null || s.lease.token !== body.token) return reply(409, { error: 'the lease is lost', lease: s.lease })
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
        const known = s.filings[key]
        if (known !== undefined) return reply(200, { isFresh: false, filing: known })
        const filing: Filing = { state: 'claimed', actor: who.id, at: now }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileClaim ${key}`)
        return reply(200, { isFresh: true, filing })
      }
      case 'fileDone': {
        const key = String(body.key ?? '')
        const known = s.filings[key]
        if (known === undefined) return reply(409, { error: 'no claim to finish' })
        const filing: Filing = { ...known, state: 'done', result: body.result, at: now }
        await save({ ...s, filings: { ...s.filings, [key]: filing } }, `fileDone ${key}`)
        return reply(200, { filing })
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
