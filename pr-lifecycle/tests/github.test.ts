import { expect, test } from 'claude-code/testing'

import { collectionDone, readCheckRuns, readInlineComments, readIssueComments, readJsonList, readReviews, readRoster, severityHint } from '../hooks/github'

const at = (iso: string) => Date.parse(iso)

test('paginated gh output is read as one list', async () => {
  expect(readJsonList('[{"id":1}]\n[{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  expect(readJsonList('')).toEqual([])
  expect(() => readJsonList('not json')).toThrow()
  // A page's body may hold `] [`: only a page boundary splits the text.
  const pages = readJsonList('[{"id":1,"body":"a ] [ b"}][{"id":2,"body":"c"}]')
  expect(pages).toHaveLength(2)
  expect((pages[0] as { body: string }).body).toBe('a ] [ b')
  // Escaped quotes and braces inside a string are data, not boundaries.
  const escaped = readJsonList('[{"body":"say \\"}{\\" ok"}][{"body":"x"}]')
  expect(escaped).toHaveLength(2)
  expect((escaped[0] as { body: string }).body).toBe('say "}{" ok')
  // Consecutive top-level objects are separate pages too.
  expect(readJsonList('{"id":1}{"id":2}')).toEqual([{ id: 1 }, { id: 2 }])
})

test('unreadable gh output fails loudly; blank output is still nothing', async () => {
  expect(() => readJsonList('oops')).toThrow('unreadable JSON from gh')
  expect(() => readReviews('oops')).toThrow()
  expect(() => readCheckRuns('oops')).toThrow()
  expect(readCheckRuns('')).toEqual([])
  expect(readReviews('  \n')).toEqual([])
})

test('check runs from paginated pages, or one unpaginated object', async () => {
  const pages = '{"total_count":2,"check_runs":[{"name":"a","status":"completed","conclusion":"success"}]}'
    + '{"total_count":2,"check_runs":[{"name":"b","status":"in_progress","conclusion":null}]}'
  expect(readCheckRuns(pages)).toEqual([
    { name: 'a', status: 'completed', conclusion: 'success' },
    { name: 'b', status: 'in_progress', conclusion: null },
  ])
})

test('reviews, inline comments and issue comments become feedback with stable ids', async () => {
  const reviews = readReviews(JSON.stringify([
    { id: 7, user: { login: 'copilot-pull-request-reviewer[bot]' }, body: 'Looks fine', state: 'COMMENTED', commit_id: 'b', submitted_at: '2026-10-16T10:00:00Z', html_url: 'u' },
    { id: 8, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: 'b', submitted_at: '2026-10-16T10:01:00Z' },
  ]))
  expect(reviews.map(one => [one.id, one.reviewer, one.head, one.isFinding])).toEqual([
    ['review:7', 'copilot-pull-request-reviewer[bot]', 'b', true],
    ['review:8', 'claude[bot]', 'b', false],
  ])
  const inline = readInlineComments(JSON.stringify([
    { id: 11, user: { login: 'claude[bot]' }, body: '**P1** SQL injection', path: 'src/db.ts', line: 4, commit_id: 'b', created_at: '2026-10-16T10:02:00Z', html_url: 'u2' },
    { id: 12, user: { login: 'me' }, body: 'Fixed in c', path: 'src/db.ts', line: 4, in_reply_to_id: 11, commit_id: 'b', created_at: '2026-10-16T10:03:00Z' },
  ]))
  expect(inline[0]).toMatchObject({ id: 'inline:11', file: 'src/db.ts', line: 4, threadId: '11', isFinding: true, at: at('2026-10-16T10:02:00Z') })
  expect(inline[1]).toMatchObject({ id: 'inline:12', threadId: '11' })
  const comments = readIssueComments(JSON.stringify([{ id: 21, user: { login: 'rovo[bot]' }, body: 'nit: typo', created_at: '2026-10-16T10:04:00Z' }]))
  expect(comments[0]).toMatchObject({ id: 'comment:21', reviewer: 'rovo[bot]', isFinding: true })
  expect(comments[0]?.head).toBeUndefined()
})

test('check runs and the roster file are read; a bad roster is ignored', async () => {
  expect(readCheckRuns(JSON.stringify({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }))).toEqual([
    { name: 'ci', status: 'completed', conclusion: 'success' },
  ])
  expect(readRoster('{"reviewers":["claude[bot]"],"checks":["ci"],"quietMinutes":2}')).toEqual({
    reviewers: ['claude[bot]'],
    checks: ['ci'],
    requestReview: [],
    quietMinutes: 2,
  })
  expect(readRoster('{')).toBeUndefined()
  expect(readRoster('')).toBeUndefined()
})

test('a severity is read from the reviewer\'s own words, P2 when it says none', async () => {
  expect(severityHint('**P1** SQL injection')).toEqual({ severity: 'P1', isSecurity: true })
  expect(severityHint('Critical: crashes on empty input')).toEqual({ severity: 'P1', isSecurity: false })
  expect(severityHint('nit: typo')).toEqual({ severity: 'P3', isSecurity: false })
  // A security hint never drops below P2 unless the reviewer tagged a severity itself.
  expect(severityHint('minor: possible XSS here')).toEqual({ severity: 'P2', isSecurity: true })
  expect(severityHint('Consider renaming')).toEqual({ severity: 'P2', isSecurity: false })
})

const base = { head: 'b', headAt: 0, startedAt: 0, lastArrivalAt: 0, quietMs: 180_000, capMs: 1_200_000 }
const fb = (reviewer: string, head?: string, when = 10) => ({ id: `review:${reviewer}`, kind: 'review' as const, reviewer, body: '', head, at: when, isFinding: false })

test('with a roster, collection ends once every listed reviewer covered the head and every listed check finished', async () => {
  const roster = { reviewers: ['claude[bot]', 'copilot'], checks: ['ci'], requestReview: [] }
  const checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b')], checks, now: 60_000 })).toMatchObject({ isDone: false, missing: ['copilot'] })
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('copilot', 'b')], checks, now: 60_000 })).toMatchObject({ isDone: true, isComplete: true })
  // A review of an older head does not cover this one.
  expect(collectionDone({ ...base, roster, feedback: [fb('claude[bot]', 'b'), fb('copilot', 'a')], checks, now: 60_000 }).isDone).toBe(false)
})

test('without a roster, collection ends when checks are done and feedback has gone quiet', async () => {
  const running = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  const done = [{ name: 'ci', status: 'completed', conclusion: 'failure' }]
  expect(collectionDone({ ...base, feedback: [], checks: running, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 500_000, now: 600_000 }).isDone).toBe(false)
  expect(collectionDone({ ...base, feedback: [], checks: done, lastArrivalAt: 400_000, now: 600_000 })).toMatchObject({ isDone: true, isComplete: true })
})

test('the wait cap ends collection with what arrived, marked incomplete', async () => {
  const roster = { reviewers: ['copilot'], checks: [], requestReview: [] }
  expect(collectionDone({ ...base, roster, feedback: [], checks: [], now: 1_200_000 })).toEqual({ isDone: true, isComplete: false, missing: ['copilot'], covered: [] })
})
