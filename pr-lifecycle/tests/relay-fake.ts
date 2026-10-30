// An in-process relay for the plugin's tests (#29 Part B): the Worker's routes and refusals, Access in front of it, and every op of the
// LifecycleObject and the RepoIndex, held to the relay's own answers by tests/contract.ts. It mirrors pr-lifecycle-relay/src/index.ts and
// src/lifecycle.ts check for check; a change there is a change here, and the contract replay on both sides catches the one forgotten.
// Two simplifications: the index is updated in the same step as the write (the relay's arrives after, by its alarm), and nothing is
// retired. A capability's verifier is the secret itself, never shown, where the relay keeps its SHA-256.

import type { HttpInit, HttpResponse, On } from 'claude-code'

import { PRINCIPALS } from './contract'

type Principal = { id: string; isService: boolean }
type Preset = 'read' | 'operate'
type Lease = { holder: string; principal: string; token: number; until: number; verifier: string }
type Filing = { state: 'claimed' | 'done'; actor: string; at: number; verifier: string; result?: unknown; adoptedBy?: string }
type Tombstone = { movedTo: number; lifecycleId: string; record?: unknown }
type LogLine = { seq: number; at: number; kind: string; text: string; principal: string; holder: string }

/** One object's storage, as the relay keeps it. */
export type FakeState = {
  rev: number
  record: unknown
  lease: Lease | null
  fence: number
  archives: { at: number; record: unknown; actor?: string; reason?: string }[]
  filings: Record<string, Filing>
  writes: { actor: string; op: string; at: number; rev: number }[]
  movedTo?: number
  log: { lines: LogLine[]; dropped: number; seq: number }
}

export type IndexEntry = { key: string; pr?: number; branch: string; phase: string; rev: number; updatedAt: number; lifecycleId: string }

export type FakeRelay = {
  /** Each object's state, by `owner/repo#<pr>` or `owner/repo@<branch>`. */
  objects: Map<string, FakeState>
  /** Each repo's index: its listed entries by key. */
  index: Map<string, Map<string, IndexEntry>>
  /** Every call that reached the relay (Access let it through), in order. */
  calls: { path: string; body: unknown }[]
  /** Set: every call fails as a network error would. */
  down: boolean
  /** The bound on a `commit` or `snapshot` body, `BODY_MAX` unless a test lowers it to meet a 413. */
  bodyMax: number
  /** The next call answers `ms` later on the test's clock. */
  delayNext: (ms: number) => void
  /** Who a call's credential headers sign in as, as Access would tell the relay; undefined when Access refuses them. */
  principalOf: (headers: Record<string, string>) => Principal | undefined
  /** An admin's grant of `preset` on `repo` to `principal`. */
  grant: (principal: string, repo: string, preset: Preset) => void
  /** The relay's answer to one call, as `$.http.fetch` resolves it: what the `http.fetch` hook answers, and a stand-in engine calls. */
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
}

export type FakeRelayOptions = {
  /** The test's clock: lease times read it, and `delayNext` waits on it. */
  clock?: { now: () => number; sleep: (ms: number) => Promise<void> }
  /** Person tokens (`cf-access-token`) by the email each signs in as. */
  people?: Record<string, string>
  /** Service tokens: each client id's secret. */
  services?: Record<string, string>
  /** Grants by repo, then by principal. */
  grants?: Record<string, Record<string, Preset>>
  admins?: string[]
  leaseMs?: number
  filingStaleMs?: number
}

const { ADAM, CODEX, READER } = PRINCIPALS

/** The headers each name of the contract signs in with, against the fake's default credentials. */
export const HEADERS_OF: Record<'ADAM' | 'CODEX' | 'READER' | 'NOBODY', Record<string, string>> = {
  ADAM: { 'cf-access-token': 'adam-token' },
  CODEX: { 'CF-Access-Client-Id': CODEX, 'CF-Access-Client-Secret': 'codex-secret' },
  READER: { 'cf-access-token': 'reader-token' },
  NOBODY: {},
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const RELAY_LOG_CAP = 1000
const LOG_TEXT_MAX = 300
const LOG_FIELD_MAX = 200
const SNAPSHOT_REASONS = new Set(['fallback', 'migration', 'move'])
const ARCHIVE_CAP = 20
const BODY_MAX = 512 * 1024
const BOUNDED_OPS = new Set(['commit', 'snapshot'])
const ARCHIVE_BYTES = 1024 * 1024
const trimmed = <T>(archives: T[]): T[] => {
  let kept = archives.slice(-ARCHIVE_CAP)
  while (kept.length > 1 && new TextEncoder().encode(JSON.stringify(kept)).length > ARCHIVE_BYTES) kept = kept.slice(1)
  return kept
}
const WRITE_CAP = 100
const MIN_SECRET = 32
const FROZEN_OPS = new Set(['commit', 'claim', 'beat', 'take', 'release', 'moveTo'])
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

/** The relay's own check, copied: a branch name `git check-ref-format --branch` would accept, in 1 to 255 UTF-8 bytes (R103). */
const isBranchName = (name: string): boolean => {
  const bytes = new TextEncoder().encode(name).length
  if (bytes < 1 || bytes > 255) return false
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (name === '@') return false
  return !/^[-/]|[/.]$|\.lock$/.test(name) && name.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'))
}

const empty = (): FakeState => ({ rev: 0, record: null, lease: null, fence: 0, archives: [], filings: {}, writes: [], log: { lines: [], dropped: 0, seq: 0 } })

const shown = <T extends { verifier: string }>(one: T | null | undefined): Omit<T, 'verifier'> | null => {
  if (one === null || one === undefined) return null
  const { verifier: _, ...rest } = one
  return rest
}

const json = (status: number, body: unknown): HttpResponse => ({ status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) })
const refuse = (status: number, text: string): HttpResponse => ({ status, ok: false, headers: {}, text })
/** A JSON copy, so no answer shares an object with the fake's state. */
const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))

export function fakeRelay(on: On, opts: FakeRelayOptions = {}): FakeRelay {
  const clock = opts.clock ?? { now: () => 0, sleep: () => Promise.resolve() }
  const people = opts.people ?? { 'adam-token': ADAM, 'reader-token': READER }
  const services = opts.services ?? { [CODEX]: 'codex-secret' }
  const grants = new Map<string, Map<string, Preset>>(
    Object.entries(opts.grants ?? { 'owner/repo': { [ADAM]: 'operate', [CODEX]: 'operate', [READER]: 'read' } }).map(([repo, by]) => [repo, new Map(Object.entries(by))]),
  )
  const admins = (opts.admins ?? [ADAM]).map(one => one.toLowerCase())
  const leaseMs = opts.leaseMs ?? 120_000
  const filingStaleMs = opts.filingStaleMs ?? 1_800_000
  let delay = 0

  const principalOf = (headers: Record<string, string>): Principal | undefined => {
    const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
    const id = lower.get('cf-access-client-id')
    const secret = lower.get('cf-access-client-secret')
    if (id !== undefined && secret !== undefined) {
      const known = Object.entries(services).find(([one]) => one.toLowerCase() === id.toLowerCase())
      return known !== undefined && known[1] === secret ? { id: id.toLowerCase(), isService: true } : undefined
    }
    const token = lower.get('cf-access-token')
    const email = token === undefined ? undefined : people[token]
    return email === undefined ? undefined : { id: email.toLowerCase(), isService: false }
  }

  const fake: FakeRelay = {
    objects: new Map(),
    index: new Map(),
    calls: [],
    down: false,
    bodyMax: BODY_MAX,
    delayNext: ms => {
      delay = ms
    },
    principalOf,
    grant: (principal, repo, preset) => {
      const by = grants.get(repo) ?? new Map<string, Preset>()
      by.set(principal.toLowerCase(), preset)
      grants.set(repo, by)
    },
    fetch: async (url, init) => {
      const wait = delay
      delay = 0
      if (wait > 0) await clock.sleep(wait)
      if (fake.down) throw new Error('connect ECONNREFUSED relay')
      return route(url, init)
    },
  }

  const isListed = (s: FakeState): boolean =>
    s.movedTo === undefined && typeof s.record === 'object' && s.record !== null && (s.record as { phase?: unknown }).phase !== 'archived'

  const reindex = (repo: string, key: string, s: FakeState, now: number): void => {
    const entries = fake.index.get(repo) ?? new Map<string, IndexEntry>()
    fake.index.set(repo, entries)
    if (!isListed(s)) {
      entries.delete(key)
      return
    }
    const r = s.record as { pr?: unknown; branch?: unknown; phase?: unknown; updatedAt?: unknown; lifecycleId?: unknown }
    const pr = key.startsWith('#') ? Number(key.slice(1)) : typeof r.pr === 'number' ? r.pr : undefined
    entries.set(key, {
      key,
      ...(pr === undefined ? {} : { pr }),
      branch: typeof r.branch === 'string' ? r.branch : key.startsWith('@') ? key.slice(1) : '',
      phase: typeof r.phase === 'string' ? r.phase : '',
      rev: s.rev,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
      lifecycleId: typeof r.lifecycleId === 'string' ? r.lifecycleId : '',
    })
  }

  /** The Worker: the route, Access, the grant lookup, then the repo's index or the object. */
  const route = (url: string, init?: HttpInit): HttpResponse => {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/')
    const [, version, owner, repo, pr] = parts
    if ((init?.method ?? 'GET') !== 'POST') return refuse(404, 'not found')
    // The admin routes edit grants; the plugin never calls them, and a test grants through `fake.grant`.
    if (version === 'v1' && owner?.toLowerCase() === 'admin') return refuse(404, 'not found')
    const isList = parts.length === 4
    let branch: string | undefined
    if (pr === 'branch') {
      if (parts.length !== 6) return refuse(404, 'not found')
      try {
        branch = decodeURIComponent(parts[5] ?? '')
      } catch {
        return refuse(404, 'not found')
      }
      if (!isBranchName(branch)) return refuse(404, 'not found')
    }
    const isShapeOk = isList || branch !== undefined || /^[1-9][0-9]{0,9}$/.test(pr ?? '')
    if (version !== 'v1' || !NAME.test(owner ?? '') || !NAME.test(repo ?? '') || !isShapeOk) return refuse(404, 'not found')
    const who = principalOf(init?.headers ?? {})
    if (who === undefined) return refuse(401, 'unauthenticated')
    const name = `${owner}/${repo}`.toLowerCase()
    const preset = grants.get(name)?.get(who.id)
    let body: { op?: unknown; [key: string]: unknown } | undefined
    try {
      const read = JSON.parse(init?.body ?? '') as unknown
      body = typeof read === 'object' && read !== null && !Array.isArray(read) ? (read as { op?: unknown }) : undefined
    } catch {
      body = undefined
    }
    fake.calls.push({ path: parsed.pathname, body: copy(body) })
    if (isList) {
      if (body?.op !== 'list') return refuse(400, 'the repo route takes { "op": "list" } only')
      if (preset === undefined) return refuse(403, `${who.id} may not list ${name}`)
      const entries = [...(fake.index.get(name)?.values() ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      return json(200, { entries: copy(entries) })
    }
    // The object reads the body itself, after the Worker found the caller: what isn't a JSON object is 400, as JSON.
    if (body === undefined) return json(400, { error: 'body is not a JSON object' })
    const key = branch !== undefined ? `@${branch}` : `#${pr}`
    return object(name, key, who, preset, body)
  }

  /** One LifecycleObject's answer, check for check as the relay's. */
  const object = (repo: string, key: string, who: Principal, preset: Preset | undefined, body: { op?: unknown; [key: string]: unknown }): HttpResponse => {
    const isBranch = key.startsWith('@')
    const op = typeof body.op === 'string' ? body.op : ''
    const need = Object.hasOwn(NEEDS, op) ? NEEDS[op] : undefined
    if (need === undefined) return json(400, { error: `unknown op ${op}` })
    const isAllowed = need === 'admin' ? !who.isService && admins.includes(who.id) : need === 'read' ? preset !== undefined : preset === 'operate'
    if (!isAllowed) return json(403, { error: `${who.id} may not ${op} on ${repo}` })
    if (BOUNDED_OPS.has(op) && new TextEncoder().encode(JSON.stringify(body)).length > fake.bodyMax) return json(413, { error: `${op} body over ${fake.bodyMax} bytes` })
    const now = clock.now()
    const id = `${repo}${key}`
    const s = copy(fake.objects.get(id)) ?? empty()
    const isLive = (lease: Lease | null): lease is Lease => lease !== null && lease.until > now
    const proof = typeof body.secret === 'string' && body.secret.length >= MIN_SECRET ? body.secret : undefined
    const isMine = (one: { principal?: string; actor?: string; verifier: string }): boolean =>
      (one.principal ?? one.actor) === who.id && proof !== undefined && one.verifier === proof
    const filingOf = (name: string): Filing | undefined => (Object.hasOwn(s.filings, name) ? s.filings[name] : undefined)
    const save = (next: FakeState, what: string, isIndexed = false): void => {
      next.writes = [...next.writes, { actor: who.id, op: what, at: now, rev: next.rev }].slice(-WRITE_CAP)
      fake.objects.set(id, next)
      if (isIndexed) reindex(repo, key, next, now)
    }
    const tomb = s.movedTo !== undefined ? (s.record as Tombstone) : undefined
    const frozen = tomb === undefined ? undefined : json(410, { movedTo: tomb.movedTo, lifecycleId: tomb.lifecycleId })
    if (frozen !== undefined && FROZEN_OPS.has(op) && !(op === 'commit' && body.isFresh === true)) return frozen

    switch (op) {
      case 'read': {
        const since = typeof body.logSince === 'number' ? body.logSince : 0
        const lines = since > 0 ? s.log.lines.filter(line => line.seq > since) : s.log.lines
        const lastWrite = s.writes.at(-1) ?? null
        return json(200, { rev: s.rev, record: s.record, lease: shown(s.lease), lastWrite, log: lines, logDropped: s.log.dropped, logSeq: s.log.seq })
      }
      case 'archives':
        return json(200, { archives: s.archives })
      case 'filing':
        return json(200, { filing: shown(filingOf(String(body.key))) })
      case 'commit': {
        if (body.from !== undefined) {
          if (isBranch || typeof body.from !== 'string' || !body.from.startsWith('@')) return json(400, { error: 'from is a branch key, on a PR object only' })
          if (s.rev !== 0 || s.record !== null) return json(409, { error: 'the PR object is not empty', rev: s.rev, record: s.record })
        }
        if (frozen !== undefined) {
          const lifecycleId = (body.record as { lifecycleId?: unknown } | null | undefined)?.lifecycleId
          if (typeof lifecycleId !== 'string') return json(400, { error: 'a fresh start needs a record with a lifecycleId' })
          if (lifecycleId === tomb!.lifecycleId) return frozen
          if (tomb!.record !== undefined) return json(409, { error: 'the move is not finished', movedTo: tomb!.movedTo, lifecycleId: tomb!.lifecycleId })
        }
        if (body.rev !== s.rev) return json(409, { error: 'stale revision', rev: s.rev, record: s.record })
        if (isLive(s.lease) && !isMine(s.lease)) return json(423, { error: 'the lease is held', lease: shown(s.lease) })
        const archive = body.archive as { at?: unknown; record?: unknown } | null | undefined
        if (archive !== undefined && (archive === null || typeof archive.at !== 'number' || archive.record === undefined)) return json(400, { error: 'archive needs { at, record }' })
        const archives = archive !== undefined ? trimmed([...s.archives, { at: archive.at as number, record: archive.record }]) : s.archives
        const next: FakeState = { ...s, rev: s.rev + 1, record: body.record ?? null, archives }
        delete next.movedTo
        save(next, archive !== undefined ? 'commit+archive' : 'commit', true)
        return json(200, { rev: next.rev })
      }
      case 'claim': {
        const holder = String(body.holder ?? '')
        if (holder === '') return json(400, { error: 'claim needs a holder' })
        if (proof === undefined) return json(400, { error: `claim needs a secret of at least ${MIN_SECRET} characters` })
        if (isLive(s.lease) && (s.lease.holder !== holder || !isMine(s.lease))) return json(423, { error: 'the lease is held', lease: shown(s.lease) })
        const isRenewal = isLive(s.lease)
        const token = isRenewal ? s.lease!.token : s.fence + 1
        const lease: Lease = { holder, principal: who.id, token, until: now + leaseMs, verifier: proof }
        save({ ...s, lease, fence: Math.max(s.fence, token) }, isRenewal ? 'claim (renewed)' : s.lease === null ? 'claim' : `claim (took over from ${s.lease.holder})`)
        return json(200, { lease: shown(lease) })
      }
      case 'take': {
        const holder = String(body.holder ?? '')
        if (holder === '') return json(400, { error: 'take needs a holder' })
        if (proof === undefined) return json(400, { error: `take needs a secret of at least ${MIN_SECRET} characters` })
        if (isLive(s.lease) && s.lease.principal !== who.id) return json(423, { error: 'the lease is held by another principal', lease: shown(s.lease) })
        const token = s.fence + 1
        const lease: Lease = { holder, principal: who.id, token, until: now + leaseMs, verifier: proof }
        save({ ...s, lease, fence: token }, isLive(s.lease) ? `take from ${s.lease.holder}` : 'take')
        return json(200, { lease: shown(lease) })
      }
      case 'log': {
        if (typeof body.at !== 'number' || typeof body.kind !== 'string' || typeof body.text !== 'string') return json(400, { error: 'log needs { at, kind, text }' })
        const seq = s.log.seq + 1
        const holder = String(body.holder ?? '').slice(0, LOG_FIELD_MAX)
        const line: LogLine = { seq, at: body.at, kind: body.kind.slice(0, LOG_FIELD_MAX), text: body.text.slice(0, LOG_TEXT_MAX), principal: who.id, holder }
        const lines = [...s.log.lines, line]
        const over = Math.max(0, lines.length - RELAY_LOG_CAP)
        // The log is stored apart from the state: no write history, no rev.
        fake.objects.set(id, { ...s, log: { lines: lines.slice(over), dropped: s.log.dropped + over, seq } })
        return json(200, { logDropped: s.log.dropped + over })
      }
      case 'snapshot': {
        if (typeof body.at !== 'number' || body.record === undefined || typeof body.reason !== 'string' || !SNAPSHOT_REASONS.has(body.reason)) {
          return json(400, { error: 'snapshot needs { at, record, reason: fallback | migration | move }' })
        }
        const archives = trimmed([...s.archives, { at: body.at, record: body.record, actor: who.id, reason: body.reason }])
        save({ ...s, archives }, `snapshot (${body.reason})`)
        return json(200, {})
      }
      case 'beat': {
        if (!isLive(s.lease) || !isMine(s.lease)) return json(409, { error: 'the lease is lost', lease: shown(s.lease) })
        const lease = { ...s.lease, until: now + leaseMs }
        save({ ...s, lease }, 'beat')
        return json(200, { lease: shown(lease) })
      }
      case 'release': {
        if (!isLive(s.lease) || !isMine(s.lease)) return json(409, { error: 'the lease is lost', lease: shown(s.lease) })
        save({ ...s, lease: null }, 'release')
        return json(200, {})
      }
      case 'moveTo': {
        if (!isBranch) return json(404, { error: 'only a branch object moves' })
        if (!isLive(s.lease) || !isMine(s.lease)) return json(409, { error: 'the lease is lost', lease: shown(s.lease) })
        const to = body.pr
        if (typeof to !== 'number' || !Number.isInteger(to) || to < 1) return json(400, { error: 'moveTo needs a pr number' })
        const lifecycleId = (s.record as { lifecycleId?: unknown } | null)?.lifecycleId
        if (typeof lifecycleId !== 'string') return json(409, { error: 'no record with a lifecycleId to move' })
        const next: FakeState = { ...s, rev: s.rev + 1, record: { movedTo: to, lifecycleId, record: s.record }, lease: null, movedTo: to }
        save(next, `moveTo #${to}`, true)
        return json(200, { rev: next.rev })
      }
      case 'moveDone': {
        if (!isBranch) return json(404, { error: 'only a branch object moves' })
        if (tomb === undefined || tomb.lifecycleId !== body.lifecycleId) return json(409, { error: 'not moved with that lifecycleId' })
        if (tomb.record === undefined) return json(200, {})
        save({ ...s, record: { movedTo: tomb.movedTo, lifecycleId: tomb.lifecycleId } }, 'moveDone')
        return json(200, {})
      }
      case 'breakLease':
        save({ ...s, lease: null }, 'breakLease')
        return json(200, {})
      case 'fileClaim': {
        const name = String(body.key ?? '')
        if (name === '') return json(400, { error: 'fileClaim needs a key' })
        if (proof === undefined) return json(400, { error: `fileClaim needs a secret of at least ${MIN_SECRET} characters` })
        const known = filingOf(name)
        if (known !== undefined) return json(200, { isFresh: false, isMine: isMine(known), filing: shown(known) })
        const filing: Filing = { state: 'claimed', actor: who.id, at: now, verifier: proof }
        save({ ...s, filings: { ...s.filings, [name]: filing } }, `fileClaim ${name}`)
        return json(200, { isFresh: true, isMine: true, filing: shown(filing) })
      }
      case 'fileDone': {
        const name = String(body.key ?? '')
        const known = filingOf(name)
        if (known === undefined) return json(409, { error: 'no claim to finish' })
        if (!isMine(known)) return json(409, { error: 'only the claimant may finish a filing', filing: shown(known) })
        if (known.state === 'done') {
          const isSame = JSON.stringify(known.result) === JSON.stringify(body.result)
          return json(isSame ? 200 : 409, isSame ? { filing: shown(known) } : { error: 'the filing is done', filing: shown(known) })
        }
        const filing: Filing = { ...known, state: 'done', result: body.result, at: now }
        save({ ...s, filings: { ...s.filings, [name]: filing } }, `fileDone ${name}`)
        return json(200, { filing: shown(filing) })
      }
      case 'fileAdopt': {
        const name = String(body.key ?? '')
        const known = filingOf(name)
        if (!isLive(s.lease) || !isMine(s.lease)) return json(423, { error: 'only the lease holder adopts a filing', lease: shown(s.lease) })
        if (known === undefined) return json(409, { error: 'no claim to adopt' })
        if (body.result === undefined) return json(400, { error: 'fileAdopt needs a result' })
        if (known.state === 'done') {
          const isSame = JSON.stringify(known.result) === JSON.stringify(body.result)
          return json(isSame ? 200 : 409, isSame ? { filing: shown(known) } : { error: 'the filing is done', filing: shown(known) })
        }
        if (now - known.at < filingStaleMs) return json(409, { error: 'the claim is not stale yet', filing: shown(known) })
        const filing: Filing = { ...known, state: 'done', result: body.result, at: now, adoptedBy: who.id }
        save({ ...s, filings: { ...s.filings, [name]: filing } }, `fileAdopt ${name}`)
        return json(200, { filing: shown(filing) })
      }
      case 'fileDelete': {
        const filings = { ...s.filings }
        delete filings[String(body.key ?? '')]
        save({ ...s, filings }, `fileDelete ${String(body.key ?? '')}`)
        return json(200, {})
      }
    }
    return json(400, { error: `unknown op ${op}` })
  }

  // A flow of the mod's own reaches the fake here; a helper called directly reaches it through `fake.fetch` on a stand-in engine.
  on('http.fetch', async (_$, e) => ({ value: await fake.fetch(e.url, e.init) }))
  return fake
}
