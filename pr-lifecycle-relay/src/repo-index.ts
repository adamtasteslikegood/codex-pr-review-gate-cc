// One Durable Object per repository (`owner/repo`, lowercased): an entry for each live record in it, so `liveRecords` can find what a
// per-PR object can't (spec §9). Each LifecycleObject sends it updates from its outbox; the Worker asks it for `list`. Nothing reaches it
// from outside the Worker: the repo route forwards only `list`, and `fault` and `update` come from a test-only admin route.

import type { DurableObjectState, Env } from './types.ts'

/** What `list` shows of one live record. `key` is the object's own key in the repo: `#<pr>` or `@<branch>` (R103). */
export type IndexEntry = { key: string; pr?: number; branch: string; phase: string; rev: number; updatedAt: number; lifecycleId: string }

/** One outbox entry, as an object sends it. `born` names the object's incarnation, so `(born, rev)` orders a key's updates across a deletion. */
export type IndexUpdate = { key: string; born: number; rev: number; entry: IndexEntry } | { key: string; born: number; rev: number; removed: true }

/** What the index keeps per key: the highest `(born, rev)` seen, and either the entry or, for a removal, when it was removed. */
type Held = { born: number; rev: number; entry?: IndexEntry; removedAt?: number }

/** A removal is kept this long, so a delayed update from before it can't bring the entry back (spec §8: 90 days). */
const RETENTION_MS = 7_776_000_000
const PREFIX = 'key:'

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Incarnation first, then revision: a recreated object's first update is above anything its old incarnation sent. */
const isAbove = (one: { born: number; rev: number }, held: Held | undefined): boolean =>
  held === undefined || one.born > held.born || (one.born === held.born && one.rev > held.rev)

export class RepoIndex {
  private readonly state: DurableObjectState
  private readonly env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { op?: unknown; [key: string]: unknown }
    const storage = this.state.storage
    const now = Date.now()
    const retention = Number(this.env.RETENTION_MS ?? RETENTION_MS)
    switch (body.op) {
      case 'list': {
        const all = await storage.list<Held>({ prefix: PREFIX })
        const entries: IndexEntry[] = []
        for (const [name, held] of all) {
          if (held.entry !== undefined) entries.push(held.entry)
          else if ((held.removedAt ?? 0) + retention <= now) await storage.delete(name)
        }
        return reply(200, { entries: entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) })
      }
      case 'fault':
        // Test-only (TEST_FAULTS): updates are refused until then, as when the index can't be reached.
        if (typeof body.until !== 'number') return reply(400, { error: 'fault needs { until }' })
        await storage.put({ fault: body.until })
        return reply(200, {})
      case 'update': {
        if (((await storage.get<number>('fault')) ?? 0) > now) return reply(503, { error: 'the index is faulted' })
        const { key, born, rev } = body
        const entry = body.entry as IndexEntry | undefined
        const isRemoved = body.removed === true
        if (typeof key !== 'string' || !/^[#@]/.test(key) || typeof born !== 'number' || typeof rev !== 'number') return reply(400, { error: 'update needs { key, born, rev }' })
        if (isRemoved === (entry !== undefined) || (entry !== undefined && (typeof entry !== 'object' || entry === null))) {
          return reply(400, { error: 'update carries an entry or removed: true' })
        }
        const held = await storage.get<Held>(PREFIX + key)
        // Not above what is held: a retry or a delayed update, ignored and acknowledged, so its sender stops retrying.
        if (!isAbove({ born, rev }, held)) return reply(200, { applied: false })
        const next: Held = isRemoved ? { born, rev, removedAt: now } : { born, rev, entry: { ...entry!, key, rev } }
        await storage.put({ [PREFIX + key]: next })
        return reply(200, { applied: true })
      }
    }
    return reply(400, { error: `unknown op ${String(body.op)}` })
  }
}
