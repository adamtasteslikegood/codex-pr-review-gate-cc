// The relay's contract (#29 Part B, Task 5): one transcript of calls and the answers they get, replayed against the relay under Miniflare
// (pr-lifecycle-relay/test/contract.test.ts) and against the plugin's fake (tests/relay.test.ts), so the fake can't drift from the relay.
// Pure data and erasable types only: Node runs this file with its types stripped, and the plugin's test kit loads it too.
//
// `as` names who calls; each side maps it to its own credentials. `match` is a partial deep match: an object matches on the keys listed,
// an array by its length and each element, anything else by equality. Nothing volatile is matched (a lease's `until`, a filing's or a
// write's `at`, a secret). Both sides check every step's status and whether its body is text; the fake's side also checks what the
// plugin's client makes of it: 401 and 403 are `{ refused }`, a 5xx or a text body `{ down }`, anything else an answer.

export const PRINCIPALS = { ADAM: 'adam@example.org', CODEX: 'codex-service.access', READER: 'reader@example.org' } as const

/**
 * The times both sides run the transcript with. A long lease and retention, so neither runs out under load mid-case; a filing claim goes
 * stale after 2 s, which a step's `waitMs` lets pass (real time on the relay, the mocked clock on the fake).
 */
export const TIMES = { leaseMs: 600_000, retentionMs: 600_000, filingStaleMs: 2_000 } as const

/** Who calls: a person, the Codex service token, a person who may only read, or no credential at all. */
export type As = 'ADAM' | 'CODEX' | 'READER' | 'NOBODY'

export type Step = {
  as: As
  path: string
  body: Record<string, unknown>
  status: number
  match?: Record<string, unknown>
  /** The relay answers in plain text (a route refusal), not JSON. */
  isText?: true
  /** Sent as the body instead of `body` as JSON: a body that isn't a JSON object. The plugin's client never sends one. */
  raw?: string
  /** How long passes before the call. */
  waitMs?: number
  /** The answer comes from the repo's index, which the relay updates after the write: the relay side polls until it matches. */
  isEventual?: true
}

export type Case = { name: string; grants?: { as: Exclude<As, 'NOBODY'>; repo: string; preset: 'read' | 'operate' }[]; steps: Step[] }

const { ADAM, CODEX } = PRINCIPALS
/** Each checkout's capability: long enough for the relay (32 characters at least). */
export const SECRET_A = 'a'.repeat(40)
export const SECRET_B = 'b'.repeat(40)
export const SECRET_C = 'c'.repeat(40)

/** Whether `actual` holds what `expected` lists (see the header). */
export function isMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((one, i) => isMatch(actual[i], one))
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, one]) => isMatch((actual as Record<string, unknown>)[key], one))
  }
  return Object.is(actual, expected)
}

const pr = (n: number, repo = 'owner/repo'): string => `/v1/${repo}/${n}`
const branch = (name: string, repo = 'owner/repo'): string => `/v1/${repo}/branch/${encodeURIComponent(name)}`

const MOVE = 'feat/move'
const moved = { lifecycleId: 'L6', branch: MOVE, phase: 'review' }

export const CONTRACT: Case[] = [
  {
    name: 'claim, commit, read, beat and release',
    steps: [
      { as: 'ADAM', path: pr(501), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 200, match: { lease: { holder: 'session-a', principal: ADAM, token: 1 } } },
      { as: 'ADAM', path: pr(501), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L1', phase: 'review' }, secret: SECRET_A }, status: 200, match: { rev: 1 } },
      {
        as: 'READER',
        path: pr(501),
        body: { op: 'read' },
        status: 200,
        match: { rev: 1, record: { lifecycleId: 'L1', phase: 'review' }, lease: { holder: 'session-a', principal: ADAM, token: 1 }, lastWrite: { actor: ADAM, op: 'commit', rev: 1 } },
      },
      { as: 'READER', path: pr(501), body: { op: 'commit', rev: 1, record: {} }, status: 403 },
      { as: 'NOBODY', path: pr(501), body: { op: 'read' }, status: 401, isText: true },
      { as: 'ADAM', path: pr(501), body: { op: 'beat', secret: SECRET_A }, status: 200, match: { lease: { holder: 'session-a', token: 1 } } },
      { as: 'ADAM', path: pr(501), body: { op: 'beat', secret: SECRET_B }, status: 409 },
      { as: 'ADAM', path: pr(501), body: { op: 'release', secret: SECRET_A }, status: 200, match: {} },
      { as: 'ADAM', path: pr(501), body: { op: 'release', secret: SECRET_A }, status: 409, match: { lease: null } },
      { as: 'READER', path: pr(501), body: { op: 'read' }, status: 200, match: { rev: 1, lease: null, lastWrite: { op: 'release', rev: 1 } } },
      { as: 'ADAM', path: pr(501), body: { op: 'nope' }, status: 400 },
    ],
  },
  {
    name: 'a stale commit is 409 and a commit under another holder\'s lease is 423',
    steps: [
      { as: 'ADAM', path: pr(502), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L2', phase: 'review' } }, status: 200, match: { rev: 1 } },
      { as: 'ADAM', path: pr(502), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L2', phase: 'fix' } }, status: 409, match: { rev: 1, record: { phase: 'review' } } },
      { as: 'CODEX', path: pr(502), body: { op: 'claim', holder: 'codex-a', secret: SECRET_C }, status: 200, match: { lease: { holder: 'codex-a', principal: CODEX, token: 1 } } },
      { as: 'ADAM', path: pr(502), body: { op: 'commit', rev: 1, record: { lifecycleId: 'L2', phase: 'fix' }, secret: SECRET_A }, status: 423, match: { lease: { holder: 'codex-a', token: 1 } } },
      { as: 'ADAM', path: pr(502), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 423, match: { lease: { holder: 'codex-a' } } },
      { as: 'CODEX', path: pr(502), body: { op: 'commit', rev: 1, record: { lifecycleId: 'L2', phase: 'fix' }, secret: SECRET_C }, status: 200, match: { rev: 2 } },
      { as: 'CODEX', path: pr(502), body: { op: 'claim', holder: 'codex-a', secret: SECRET_C }, status: 200, match: { lease: { holder: 'codex-a', token: 1 } } },
    ],
  },
  {
    name: 'take, by the same principal and by a different one',
    steps: [
      { as: 'ADAM', path: pr(503), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 200, match: { lease: { holder: 'session-a', token: 1 } } },
      { as: 'ADAM', path: pr(503), body: { op: 'take', holder: 'session-b', secret: SECRET_B }, status: 200, match: { lease: { holder: 'session-b', principal: ADAM, token: 2 } } },
      { as: 'ADAM', path: pr(503), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L3' }, secret: SECRET_A }, status: 423, match: { lease: { holder: 'session-b', token: 2 } } },
      { as: 'CODEX', path: pr(503), body: { op: 'take', holder: 'codex-a', secret: SECRET_C }, status: 423, match: { lease: { holder: 'session-b', principal: ADAM } } },
      { as: 'ADAM', path: pr(503), body: { op: 'take', holder: 'session-c', secret: 'short' }, status: 400 },
      { as: 'ADAM', path: pr(503), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L3' }, secret: SECRET_B }, status: 200, match: { rev: 1 } },
    ],
  },
  {
    name: 'log and logSince by seq',
    steps: [
      { as: 'ADAM', path: pr(504), body: { op: 'log', at: 10, kind: 'round', text: 'one', holder: 'session-a' }, status: 200, match: { logDropped: 0 } },
      { as: 'CODEX', path: pr(504), body: { op: 'log', at: 10, kind: 'standDown', text: 'x'.repeat(320) }, status: 200, match: { logDropped: 0 } },
      { as: 'ADAM', path: pr(504), body: { op: 'log', at: 11, kind: 'round', text: 'three', holder: 'session-a' }, status: 200, match: { logDropped: 0 } },
      { as: 'ADAM', path: pr(504), body: { op: 'log', at: 'soon', kind: 'round', text: 'bad' }, status: 400 },
      { as: 'READER', path: pr(504), body: { op: 'log', at: 12, kind: 'round', text: 'no' }, status: 403 },
      {
        as: 'READER',
        path: pr(504),
        body: { op: 'read' },
        status: 200,
        match: {
          rev: 0,
          record: null,
          log: [
            { seq: 1, at: 10, kind: 'round', text: 'one', principal: ADAM, holder: 'session-a' },
            { seq: 2, at: 10, kind: 'standDown', text: 'x'.repeat(300), principal: CODEX, holder: '' },
            { seq: 3, at: 11, kind: 'round', text: 'three', principal: ADAM, holder: 'session-a' },
          ],
          logDropped: 0,
          logSeq: 3,
        },
      },
      { as: 'READER', path: pr(504), body: { op: 'read', logSince: 2 }, status: 200, match: { log: [{ seq: 3, text: 'three' }], logSeq: 3 } },
      { as: 'READER', path: pr(504), body: { op: 'read', logSince: 3 }, status: 200, match: { log: [], logSeq: 3 } },
    ],
  },
  {
    name: 'snapshot',
    steps: [
      { as: 'ADAM', path: pr(505), body: { op: 'snapshot', at: 20, record: { lifecycleId: 'L5', phase: 'review' }, reason: 'fallback' }, status: 200, match: {} },
      { as: 'ADAM', path: pr(505), body: { op: 'snapshot', at: 21, record: { lifecycleId: 'L5' }, reason: 'whim' }, status: 400 },
      { as: 'ADAM', path: pr(505), body: { op: 'snapshot', at: 21, reason: 'migration' }, status: 400 },
      {
        as: 'READER',
        path: pr(505),
        body: { op: 'archives' },
        status: 200,
        match: { archives: [{ at: 20, record: { lifecycleId: 'L5', phase: 'review' }, actor: ADAM, reason: 'fallback' }] },
      },
      { as: 'READER', path: pr(505), body: { op: 'read' }, status: 200, match: { rev: 0, record: null } },
    ],
  },
  {
    name: 'moveTo, then 410, moveDone, then a fresh start',
    steps: [
      { as: 'ADAM', path: branch(MOVE), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 200, match: { lease: { holder: 'session-a', token: 1 } } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'commit', rev: 0, record: moved, secret: SECRET_A }, status: 200, match: { rev: 1 } },
      { as: 'ADAM', path: pr(506), body: { op: 'moveTo', pr: 506, secret: SECRET_A }, status: 404 },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'moveTo', pr: 0, secret: SECRET_A }, status: 400 },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'moveTo', pr: 506, secret: SECRET_A }, status: 200, match: { rev: 2 } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'commit', rev: 2, record: moved, secret: SECRET_A }, status: 410, match: { movedTo: 506, lifecycleId: 'L6' } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 410, match: { movedTo: 506, lifecycleId: 'L6' } },
      { as: 'READER', path: branch(MOVE), body: { op: 'read' }, status: 200, match: { rev: 2, record: { movedTo: 506, lifecycleId: 'L6', record: moved }, lease: null } },
      { as: 'ADAM', path: pr(506), body: { op: 'commit', rev: 0, from: `@${MOVE}`, record: { ...moved, pr: 506 } }, status: 200, match: { rev: 1 } },
      { as: 'ADAM', path: pr(506), body: { op: 'commit', rev: 0, from: `@${MOVE}`, record: { ...moved, pr: 506 } }, status: 409, match: { rev: 1, record: { lifecycleId: 'L6' } } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'commit', rev: 2, isFresh: true, record: { lifecycleId: 'L7', branch: MOVE, phase: 'pre-pr' } }, status: 409, match: { movedTo: 506, lifecycleId: 'L6' } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'moveDone', lifecycleId: 'L-other' }, status: 409 },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'moveDone', lifecycleId: 'L6' }, status: 200, match: {} },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'moveDone', lifecycleId: 'L6' }, status: 200, match: {} },
      { as: 'READER', path: branch(MOVE), body: { op: 'read' }, status: 200, match: { rev: 2, record: { movedTo: 506, lifecycleId: 'L6', record: undefined } } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'commit', rev: 2, isFresh: true, record: moved }, status: 410, match: { movedTo: 506, lifecycleId: 'L6' } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'commit', rev: 2, isFresh: true, record: { lifecycleId: 'L7', branch: MOVE, phase: 'pre-pr' } }, status: 200, match: { rev: 3 } },
      { as: 'READER', path: branch(MOVE), body: { op: 'read' }, status: 200, match: { rev: 3, record: { lifecycleId: 'L7', phase: 'pre-pr' } } },
      { as: 'ADAM', path: branch(MOVE), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 200, match: { lease: { holder: 'session-a', token: 2 } } },
    ],
  },
  {
    name: 'fileClaim, fileDone and filing',
    steps: [
      { as: 'READER', path: pr(507), body: { op: 'filing', key: 'L1:f1:1' }, status: 200, match: { filing: null } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileClaim', key: 'L1:f1:1', secret: SECRET_A }, status: 200, match: { isFresh: true, isMine: true, filing: { state: 'claimed', actor: ADAM } } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileClaim', key: 'L1:f1:1', secret: SECRET_A }, status: 200, match: { isFresh: false, isMine: true, filing: { state: 'claimed', actor: ADAM } } },
      { as: 'CODEX', path: pr(507), body: { op: 'fileClaim', key: 'L1:f1:1', secret: SECRET_C }, status: 200, match: { isFresh: false, isMine: false, filing: { actor: ADAM } } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileClaim', key: '', secret: SECRET_A }, status: 400 },
      { as: 'CODEX', path: pr(507), body: { op: 'fileDone', key: 'L1:f1:1', secret: SECRET_C, result: { issue: 9 } }, status: 409, match: { error: 'only the claimant may finish a filing' } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileDone', key: 'L1:f1:1', secret: SECRET_A, result: { issue: 9 } }, status: 200, match: { filing: { state: 'done', actor: ADAM, result: { issue: 9 } } } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileDone', key: 'L1:f1:1', secret: SECRET_A, result: { issue: 9 } }, status: 200, match: { filing: { state: 'done', result: { issue: 9 } } } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileDone', key: 'L1:f1:1', secret: SECRET_A, result: { issue: 10 } }, status: 409, match: { filing: { result: { issue: 9 } } } },
      { as: 'ADAM', path: pr(507), body: { op: 'fileDone', key: 'L1:f2:1', secret: SECRET_A, result: { issue: 11 } }, status: 409 },
      { as: 'READER', path: pr(507), body: { op: 'filing', key: 'L1:f1:1' }, status: 200, match: { filing: { state: 'done', actor: ADAM, result: { issue: 9 } } } },
    ],
  },
  {
    name: 'a branch with / or % is one segment, and a bad path is not found',
    steps: [
      { as: 'ADAM', path: branch('feat/50%'), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L8', branch: 'feat/50%', phase: 'pre-pr' } }, status: 200, match: { rev: 1 } },
      { as: 'READER', path: '/v1/owner/repo/branch/feat%2F50%25', body: { op: 'read' }, status: 200, match: { rev: 1, record: { branch: 'feat/50%' } } },
      { as: 'ADAM', path: '/v1/owner/repo/branch/feat/50', body: { op: 'read' }, status: 404, isText: true },
      { as: 'ADAM', path: '/v1/owner/repo/branch/%E0%A4%A', body: { op: 'read' }, status: 404, isText: true },
      { as: 'ADAM', path: branch('feat..x'), body: { op: 'read' }, status: 404, isText: true },
      { as: 'ADAM', path: pr(0), body: { op: 'read' }, status: 404, isText: true },
      { as: 'ADAM', path: '/v1/owner/re po/7', body: { op: 'read' }, status: 404, isText: true },
    ],
  },
  {
    name: 'a body that isn\'t a JSON object is 400',
    steps: [
      { as: 'ADAM', path: pr(508), body: {}, raw: 'not json', status: 400, match: { error: 'body is not a JSON object' } },
      { as: 'ADAM', path: pr(508), body: {}, raw: 'null', status: 400, match: { error: 'body is not a JSON object' } },
      { as: 'ADAM', path: pr(508), body: {}, raw: '[{"op":"read"}]', status: 400, match: { error: 'body is not a JSON object' } },
      { as: 'NOBODY', path: pr(508), body: {}, raw: 'not json', status: 401, isText: true },
      { as: 'READER', path: '/v1/owner/repo', body: {}, raw: 'not json', status: 400, isText: true },
      { as: 'READER', path: pr(508), body: { op: 'read' }, status: 200, match: { rev: 0, record: null } },
    ],
  },
  {
    name: 'fileAdopt: only the lease holder, only a stale claim, recorded as adoptedBy',
    steps: [
      { as: 'ADAM', path: pr(509), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 200 },
      { as: 'CODEX', path: pr(509), body: { op: 'fileClaim', key: 'L2:f1:1', secret: SECRET_C }, status: 200, match: { isFresh: true } },
      { as: 'ADAM', path: pr(509), body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_A, result: { issue: 20 } }, status: 409, match: { error: 'the claim is not stale yet', filing: { state: 'claimed' } } },
      { as: 'CODEX', path: pr(509), body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_C, result: { issue: 20 } }, status: 423, match: { lease: { holder: 'session-a' } } },
      { as: 'ADAM', path: pr(509), body: { op: 'fileAdopt', key: 'L2:f9:1', secret: SECRET_A, result: { issue: 20 } }, status: 409, match: { error: 'no claim to adopt' } },
      { as: 'ADAM', path: pr(509), body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_A }, status: 400 },
      // Stale now, and its claimant asks: another principal's live lease still holds it out.
      {
        as: 'CODEX',
        path: pr(509),
        body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_C, result: { issue: 20 } },
        waitMs: TIMES.filingStaleMs + 200,
        status: 423,
        match: { error: 'only the lease holder adopts a filing', lease: { holder: 'session-a' } },
      },
      {
        as: 'ADAM',
        path: pr(509),
        body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_A, result: { issue: 20 } },
        status: 200,
        match: { filing: { state: 'done', actor: CODEX, adoptedBy: ADAM, result: { issue: 20 } } },
      },
      { as: 'ADAM', path: pr(509), body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_A, result: { issue: 20 } }, status: 200, match: { filing: { adoptedBy: ADAM } } },
      { as: 'ADAM', path: pr(509), body: { op: 'fileAdopt', key: 'L2:f1:1', secret: SECRET_A, result: { issue: 21 } }, status: 409, match: { filing: { result: { issue: 20 } } } },
      { as: 'READER', path: pr(509), body: { op: 'filing', key: 'L2:f1:1' }, status: 200, match: { filing: { state: 'done', actor: CODEX, adoptedBy: ADAM } } },
    ],
  },
  {
    name: 'breakLease and fileDelete are an admin\'s, a person\'s only',
    steps: [
      { as: 'CODEX', path: pr(510), body: { op: 'claim', holder: 'session-c', secret: SECRET_C }, status: 200, match: { lease: { token: 1 } } },
      { as: 'CODEX', path: pr(510), body: { op: 'breakLease' }, status: 403, match: { error: `${CODEX} may not breakLease on owner/repo` } },
      { as: 'READER', path: pr(510), body: { op: 'breakLease' }, status: 403 },
      { as: 'ADAM', path: pr(510), body: { op: 'breakLease' }, status: 200 },
      { as: 'READER', path: pr(510), body: { op: 'read' }, status: 200, match: { lease: null, lastWrite: { actor: ADAM, op: 'breakLease' } } },
      { as: 'ADAM', path: pr(510), body: { op: 'claim', holder: 'session-a', secret: SECRET_A }, status: 200, match: { lease: { holder: 'session-a', token: 2 } } },
      { as: 'CODEX', path: pr(510), body: { op: 'fileClaim', key: 'L3:f1:1', secret: SECRET_C }, status: 200, match: { isFresh: true } },
      { as: 'CODEX', path: pr(510), body: { op: 'fileDelete', key: 'L3:f1:1' }, status: 403 },
      { as: 'ADAM', path: pr(510), body: { op: 'fileDelete', key: 'L3:f1:1' }, status: 200 },
      { as: 'READER', path: pr(510), body: { op: 'filing', key: 'L3:f1:1' }, status: 200, match: { filing: null } },
      { as: 'CODEX', path: pr(510), body: { op: 'fileClaim', key: 'L3:f1:1', secret: SECRET_C }, status: 200, match: { isFresh: true } },
    ],
  },
  {
    name: 'a commit or snapshot body over 128 KiB is 413, and changes nothing',
    steps: [
      { as: 'ADAM', path: pr(511), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L9', pad: 'x'.repeat(100 * 1024) } }, status: 200, match: { rev: 1 } },
      { as: 'ADAM', path: pr(511), body: { op: 'commit', rev: 1, record: { lifecycleId: 'L9', pad: 'x'.repeat(129 * 1024) } }, status: 413 },
      { as: 'ADAM', path: pr(511), body: { op: 'snapshot', at: 1, record: { pad: 'x'.repeat(129 * 1024) }, reason: 'fallback' }, status: 413 },
      { as: 'READER', path: pr(511), body: { op: 'read' }, status: 200, match: { rev: 1 } },
      { as: 'READER', path: pr(511), body: { op: 'archives' }, status: 200, match: { archives: [] } },
    ],
  },
  {
    name: 'list',
    grants: [
      { as: 'ADAM', repo: 'owner/listed', preset: 'operate' },
      { as: 'READER', repo: 'owner/listed', preset: 'read' },
    ],
    steps: [
      { as: 'ADAM', path: pr(1, 'owner/listed'), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L9', branch: 'feat/l', phase: 'review', updatedAt: 30 } }, status: 200, match: { rev: 1 } },
      { as: 'ADAM', path: branch('feat/l2', 'owner/listed'), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L10', phase: 'pre-pr', updatedAt: 31 } }, status: 200, match: { rev: 1 } },
      { as: 'ADAM', path: pr(2, 'owner/listed'), body: { op: 'commit', rev: 0, record: { lifecycleId: 'L11', branch: 'feat/m', phase: 'archived', updatedAt: 32 } }, status: 200, match: { rev: 1 } },
      {
        as: 'READER',
        path: '/v1/owner/listed',
        body: { op: 'list' },
        status: 200,
        isEventual: true,
        match: {
          entries: [
            { key: '#1', pr: 1, branch: 'feat/l', phase: 'review', rev: 1, updatedAt: 30, lifecycleId: 'L9' },
            { key: '@feat/l2', branch: 'feat/l2', phase: 'pre-pr', rev: 1, updatedAt: 31, lifecycleId: 'L10' },
          ],
        },
      },
      { as: 'READER', path: '/v1/OWNER/Listed', body: { op: 'list' }, status: 200, isEventual: true, match: { entries: [{ key: '#1' }, { key: '@feat/l2' }] } },
      { as: 'READER', path: '/v1/owner/listed', body: { op: 'read' }, status: 400, isText: true },
      { as: 'CODEX', path: '/v1/owner/listed', body: { op: 'list' }, status: 403, isText: true },
    ],
  },
]
