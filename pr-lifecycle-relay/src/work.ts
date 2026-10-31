// One Durable Object per repo (`owner/repo`): the repo's work claims (docs/superpowers/specs/2026-10-31-relay-work-claims-design.md). An
// agent claims a piece of work by its ref (`gh#12`), checkpoints where it pushed the work and its notes, and releases it. A claim whose
// lease lapses is taken over by the next session, on any runtime, which resumes from the last checkpoint. Each claim has its own storage
// key; a Durable Object runs one request at a time, so each op reads and writes its claim in one step.

import { isAdmin, type Preset, type Principal } from './auth.ts'
import { bodyOf, type DurableObjectState, type Env } from './types.ts'

export type WorkState = 'active' | 'paused' | 'done' | 'abandoned'
type Outcome = 'paused' | 'done' | 'abandoned'
const OUTCOMES = new Set<string>(['paused', 'done', 'abandoned'])

export type WorkLease = { holder: string; principal: string; runtime: string; token: number; until: number; verifier: string }

export type Step = { seq: number; at: number; kind: string; text: string; principal: string; holder: string; runtime: string; commit?: string }

export type Claim = {
  ref: string
  title?: string
  state: WorkState
  lease: WorkLease | null
  /** The last token handed out: each new holder gets a higher one. */
  fence: number
  branch?: string
  commit?: string
  notes?: string
  steps: Step[]
  stepsDropped: number
  seq: number
  created: number
  updated: number
  closedAt?: number
}

export const REF = /^[A-Za-z0-9][A-Za-z0-9_.:#/@-]{0,127}$/
export const STEP_CAP = 200
export const BOARD_CAP = 2000
const TEXT_MAX = 300
const FIELD_MAX = 200
const MIN_SECRET = 32
const LEASE_MS = 120_000
const RETENTION_MS = 7_776_000_000
/** How many recent steps `claim` returns in its resume. */
const RESUME_STEPS = 20

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Need = 'read' | 'operate' | 'admin'
const NEEDS: Record<string, Need> = {
  get: 'read',
  list: 'read',
  claim: 'operate',
  beat: 'operate',
  checkpoint: 'operate',
  release: 'operate',
  breakClaim: 'admin',
}

const verifierOf = async (secret: unknown): Promise<string | undefined> => {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) return undefined
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

const cut = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined)

/** What a response shows of a claim: never the verifier, and `lapsed` for an active claim whose lease ran out. */
const shown = (c: Claim, now: number, withSteps = true) => {
  const { verifier: _, ...lease } = c.lease ?? { verifier: '' }
  const isLapsed = c.state === 'active' && (c.lease === null || c.lease.until <= now)
  const { steps, ...rest } = c
  return {
    ...rest,
    state: isLapsed ? 'lapsed' : c.state,
    lease: c.lease === null ? null : lease,
    ...(withSteps ? { steps } : { lastStep: steps.at(-1) ?? null }),
  }
}

export class WorkBoard {
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
    const body = await bodyOf(request)
    if (body === undefined) return reply(400, { error: 'body is not a JSON object' })
    const op = typeof body.op === 'string' ? body.op : ''
    const need = NEEDS[op]
    if (need === undefined) return reply(400, { error: `unknown op ${op}` })
    // The Worker always overwrites this header with the GrantStore's answer; the object trusts it only for that reason.
    const given = request.headers.get('x-relay-preset')
    const preset: Preset | undefined = given === 'read' || given === 'operate' ? given : undefined
    const isAllowed = need === 'admin' ? isAdmin(this.env, who) : need === 'read' ? preset !== undefined : preset === 'operate'
    if (!isAllowed) return reply(403, { error: `${who.id} may not ${op} on ${repo}` })
    const now = Date.now()
    const storage = this.state.storage

    if (op === 'list') {
      const all = await storage.list<Claim>({ prefix: 'claim:' })
      const wanted = typeof body.state === 'string' ? body.state : undefined
      const claims = [...all.values()].map(c => shown(c, now, false)).filter(c => wanted === undefined || c.state === wanted)
      return reply(200, { claims })
    }

    const ref = typeof body.ref === 'string' ? body.ref : ''
    if (!REF.test(ref)) return reply(400, { error: 'ref must match ' + REF.source })
    // The digest comes before the claim is read: no await other than storage falls between the read and the write.
    const proof = await verifierOf(body.secret)
    const key = `claim:${ref}`
    const found = await storage.get<Claim>(key)
    const leaseMs = Number(this.env.LEASE_MS ?? LEASE_MS)
    const isLive = (c: Claim): boolean => c.lease !== null && c.lease.until > now
    /** The caller holds this claim's live lease: same principal, same secret and, when given, the current token. */
    const isHeld = (c: Claim): boolean =>
      isLive(c) && c.lease!.principal === who.id && proof !== undefined && c.lease!.verifier === proof &&
      (body.token === undefined || body.token === c.lease!.token)
    const step = (c: Claim, kind: string, text: string, lease: WorkLease | null, commit?: string): Claim => {
      const seq = c.seq + 1
      const one: Step = { seq, at: now, kind, text: text.slice(0, TEXT_MAX), principal: who.id, holder: lease?.holder ?? '', runtime: lease?.runtime ?? '' }
      if (commit !== undefined) one.commit = commit
      const steps = [...c.steps, one]
      const over = Math.max(0, steps.length - STEP_CAP)
      return { ...c, seq, steps: steps.slice(over), stepsDropped: c.stepsDropped + over, updated: now }
    }
    const save = async (c: Claim): Promise<void> => {
      await storage.put({ [key]: c })
      if (c.closedAt !== undefined) await this.arm(c.closedAt + this.retention())
    }

    switch (op) {
      case 'get':
        return found === undefined ? reply(404, { error: `no claim ${ref}` }) : reply(200, { claim: shown(found, now) })
      case 'claim': {
        const holder = cut(body.holder, FIELD_MAX)
        const runtime = cut(body.runtime, FIELD_MAX)
        if (holder === undefined || runtime === undefined) return reply(400, { error: 'claim needs a holder and a runtime' })
        if (proof === undefined) return reply(400, { error: `claim needs a secret of at least ${MIN_SECRET} characters` })
        if (found === undefined && (await storage.list({ prefix: 'claim:' })).size >= BOARD_CAP) return reply(409, { error: `the board holds ${BOARD_CAP} claims` })
        let c: Claim = found ?? { ref, state: 'active', lease: null, fence: 0, steps: [], stepsDropped: 0, seq: 0, created: now, updated: now }
        if (isLive(c)) {
          // Only the same holder, principal and secret renew a live claim; anyone else waits for it to lapse.
          if (!isHeld(c) || c.lease!.holder !== holder) return reply(423, { error: 'the claim is held', claim: shown(c, now, false) })
          const lease = { ...c.lease!, until: now + leaseMs }
          c = { ...c, lease, updated: now }
          await save(c)
          return reply(200, { claim: shown(c, now), token: lease.token, tookOver: false, resume: this.resumeOf(c) })
        }
        if ((c.state === 'done' || c.state === 'abandoned') && body.reopen !== true) {
          return reply(409, { error: `the claim is ${c.state}; pass reopen to claim it again`, claim: shown(c, now, false) })
        }
        const before = c.lease
        const tookOver = before !== null && c.state === 'active'
        // The old holder's last step is unknown: it is marked interrupted, and the next holder reads the notes rather than re-running it.
        if (tookOver) c = step(c, 'interrupted', `the lease of ${before.holder} (${before.runtime}) lapsed`, before, c.commit)
        const lease: WorkLease = { holder, principal: who.id, runtime, token: c.fence + 1, until: now + leaseMs, verifier: proof }
        c = { ...c, state: 'active', lease, fence: lease.token }
        delete c.closedAt
        const title = cut(body.title, TEXT_MAX)
        if (title !== undefined) c.title = title
        const branch = cut(body.branch, FIELD_MAX)
        if (branch !== undefined && c.branch === undefined) c.branch = branch
        const kind = found === undefined || tookOver ? 'claimed' : found.state === 'done' || found.state === 'abandoned' ? 'reopened' : 'resumed'
        c = step(c, kind, tookOver ? `took over from ${before.holder}` : kind, lease)
        await save(c)
        return reply(200, { claim: shown(c, now), token: lease.token, tookOver, resume: this.resumeOf(c) })
      }
      case 'beat':
      case 'checkpoint':
      case 'release': {
        if (found === undefined) return reply(404, { error: `no claim ${ref}` })
        // A lapsed lease is lost even to its holder: reviving it would block a takeover that is already allowed.
        if (typeof body.token !== 'number' || !isHeld(found)) return reply(409, { error: 'the claim is not held by this checkout', claim: shown(found, now, false) })
        let c = found
        if (op === 'beat') {
          c = { ...c, lease: { ...c.lease!, until: now + leaseMs }, updated: now }
        } else if (op === 'checkpoint') {
          const text = cut(body.text, TEXT_MAX)
          if (text === undefined) return reply(400, { error: 'checkpoint needs a text' })
          const commit = cut(body.commit, FIELD_MAX)
          for (const field of ['branch', 'notes', 'commit'] as const) {
            const value = cut(body[field], FIELD_MAX)
            if (value !== undefined) c = { ...c, [field]: value }
          }
          c = step({ ...c, lease: { ...c.lease!, until: now + leaseMs } }, 'checkpoint', text, c.lease, commit)
        } else {
          const outcome = typeof body.outcome === 'string' && OUTCOMES.has(body.outcome) ? (body.outcome as Outcome) : undefined
          if (outcome === undefined) return reply(400, { error: 'release needs an outcome: paused, done or abandoned' })
          c = step(c, outcome, cut(body.text, TEXT_MAX) ?? outcome, c.lease, c.commit)
          c = { ...c, state: outcome, lease: null }
          if (outcome !== 'paused') c.closedAt = now
        }
        await save(c)
        return reply(200, { claim: shown(c, now, op !== 'beat') })
      }
      case 'breakClaim': {
        if (found === undefined) return reply(404, { error: `no claim ${ref}` })
        let c = step(found, 'broken', cut(body.text, TEXT_MAX) ?? `broken by ${who.id}`, found.lease, found.commit)
        c = { ...c, state: found.state === 'active' ? 'paused' : found.state, lease: null }
        await save(c)
        return reply(200, { claim: shown(c, now) })
      }
    }
    return reply(400, { error: `unknown op ${op}` })
  }

  private resumeOf(c: Claim) {
    return { branch: c.branch ?? null, commit: c.commit ?? null, notes: c.notes ?? null, steps: c.steps.slice(-RESUME_STEPS) }
  }

  private retention(): number {
    return Number(this.env.RETENTION_MS ?? RETENTION_MS)
  }

  /** Sets the one alarm to `at` unless it is already due sooner. */
  private async arm(at: number): Promise<void> {
    const current = await this.state.storage.getAlarm()
    if (current === null || current > at) await this.state.storage.setAlarm(at)
  }

  /** Deletes each closed claim whose retention ran out, then sets the alarm for the next one. */
  async alarm(): Promise<void> {
    const now = Date.now()
    const retention = this.retention()
    let next: number | undefined
    for (const [key, c] of await this.state.storage.list<Claim>({ prefix: 'claim:' })) {
      if (c.closedAt === undefined) continue
      const due = c.closedAt + retention
      if (due <= now) await this.state.storage.delete(key)
      else next = next === undefined ? due : Math.min(next, due)
    }
    if (next !== undefined) await this.state.storage.setAlarm(next)
  }
}
