import { expect, test } from 'claude-code/testing'

import { createPr, isHeld, P1, P2, review, runOf, TRAILER, turn, world } from './world'
import type { LifecycleRecord } from '../types'

const recordOf = async (w: ReturnType<typeof world>): Promise<LifecycleRecord> => w.stored('lifecycle:/repo:feat/x') as LifecycleRecord
const fixed = (id: string, note = 'done') => `Fixed.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id, action: 'fixed', note }] })}`

test('several reviewers in one cycle consume one round', async ($, on) => {
  const w = world(on)
  w.git.numstat = '10\t2\tsrc/auth/login.ts' // high: review and challenge run in parallel
  await $.tool.call(createPr)
  expect(w.spawned).toHaveLength(2)
  await $.turn.complete(turn(review('r1-review', 'PASS'), 'agent-1'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-2'))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(rec.rounds[0]?.evidence.map(one => one.reviewer)).toEqual(['codex', 'codex-challenge'])
})

test('omitted findings are not marked fixed', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, P2])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  // R1-2 had no answer: the fix step is asked once more, and says nothing again.
  await $.turn.complete(turn('Nothing more.'))
  // Round 2: Codex raises nothing and confirms nothing.
  await $.turn.complete(turn(review('r2-review', 'PASS')))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-1')?.status).toBe('reported-fixed')
  expect(rec.findings.find(one => one.id === 'R1-2')?.status).toBe('open')
})

test('a fix Codex confirms is verified; a rebuttal Codex holds is open again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, { ...P1, title: 'Second', line: 40 }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'rebutted', note: 'guarded at :38' }] })}`))
  expect(w.spawned.at(-1)?.prompt).toContain('R1-2 [P1] Second')
  await $.turn.complete(turn(review('r2-review', 'PASS', [], { verified: ['R1-1'], held: ['R1-2'] })))
  const rec = await recordOf(w)
  expect(rec.findings.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'verified-fixed'],
    ['R1-2', 'open'],
  ])
})

test('a held blocker goes back to the fixer instead of letting the PR open', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'rebutted', note: 'guarded at :10' }] })}`))
  await $.turn.complete(turn(review('r2-review', 'PASS', [], { held: ['R1-1'] })))
  const run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('fix')
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] Unvalidated redirect')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
})

test('a security P1 only reported fixed does not let an exhausted gate open the PR', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  const rec = await recordOf(w)
  expect(rec.findings[0]?.isSecurity).toBe(true)
  expect(rec.preStatus).toBe('exhausted')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('new scope invalidates only the affected evidence', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, { ...P2, file: 'src/other.ts' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(
    turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'rebutted', note: 'fine as is' }] })}`),
  )
  await $.turn.complete(turn(review('r2-review', 'PASS'), 'agent-2'))
  // A new commit touches src/app.ts only, and the person runs the gate again.
  w.git.head = 'f'.repeat(40)
  w.git.changed = 'src/app.ts'
  await $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-1')?.needsRecheck).toBe(true)
  expect(rec.findings.find(one => one.id === 'R1-2')?.needsRecheck).toBeUndefined()
  // History stays, and the new head gets its own round.
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(2)
  expect(w.spawned.at(-1)?.prompt).toContain('R1-1')
})

test('timeout retries record effort without recording a completed round', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(`${TRAILER}\n${JSON.stringify({ step: 'r1-review', gate: 'ERROR', error: 'timeout' })}`))
  await $.turn.complete(turn(review('r1-review', 'PASS'), 'agent-2'))
  const rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(rec.rounds[0]?.isCompleted).toBe(false)
})

test('advisories are fixed even when the reserve rule leaves no Codex round for them', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS', [P2])))
  const run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.fixKind).toBe('advisory')
  expect(w.prompts.at(-1)).toContain('R1-1 [P2] Rename this')
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1', 'renamed')))
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
  expect(w.spawned).toHaveLength(1)
  expect((await runOf(w)).status).toBe('passed')
})

test('a finding left without an answer is asked about once more, then stays open', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, P2])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  // The re-prompt names the finding that had no answer, and uses no round.
  expect(w.prompts.at(-1)).toContain('These findings have no answer yet: R1-2')
  expect(w.spawned).toHaveLength(1)
  expect((await recordOf(w)).rounds).toHaveLength(0)
  await $.turn.complete(turn(fixed('R1-1', 'still done')))
  // The round ends; Codex looks at the fix and passes it, and the PR opens with R1-2 still open.
  expect(w.spawned).toHaveLength(2)
  await $.turn.complete(turn(review('r2-review', 'PASS')))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-2')?.status).toBe('open')
  expect(rec.preStatus).toBe('passed')
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
  expect(w.prompts.at(-1)).toContain('R1-2 [P2] Rename this')
  expect(w.prompts.at(-1)).toContain('1 advisory finding not fixed')
})

// ------------------------------------------------------------- fix round 1

const run$ = (args: string) => ({ command: 'pr-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never

test('an open security blocker that a later review leaves out never lets the gate pass', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn('Tried.'))
  await $.turn.complete(turn('Tried.'))
  await $.turn.complete(turn(review('r2-review', 'PASS')))
  const rec = await recordOf(w)
  expect(rec.preStatus).not.toBe('passed')
  expect(rec.findings.find(one => one.id === 'R1-1')?.status).toBe('open')
  // The carried blocker goes back to the fixer with round 2.
  expect((await runOf(w)).phase).toBe('fix')
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] SQL injection in search')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('a rerun after uncommitted fixer changes numbers its findings after the ones already raised', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  w.git.dirty = ' M src/app.ts'
  await $.turn.complete(turn(fixed('R1-1')))
  expect((await runOf(w)).status).toBe('error')
  w.git.dirty = ''
  w.git.head = 'e'.repeat(40)
  await $.command.run(run$('resume'))
  const run = await runOf(w)
  await $.turn.complete(turn(review(`r${run.round}-review`, 'FAIL', [{ ...P1, title: 'Another thing', line: 80 }]), `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.map(one => [one.id, one.title])).toEqual([
    ['R1-1', 'Unvalidated redirect'],
    ['R1-2', 'Another thing'],
  ])
  expect(rec.findings[0]?.status).toBe('reported-fixed')
})

test('a stop and resume keeps the earlier findings under their ids, and records the attempt', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  await $.command.run(run$('stop'))
  expect((await recordOf(w)).attempts).toBe(1)
  await $.command.run(run$('resume'))
  const run = await runOf(w)
  await $.turn.complete(turn(review(`r${run.round}-review`, 'PASS', [{ ...P1, severity: 'P2', title: 'Other nit', line: 90 }]), `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.map(one => [one.id, one.severity, one.title])).toEqual([
    ['R1-1', 'P1', 'Unvalidated redirect'],
    ['R1-2', 'P2', 'Other nit'],
  ])
})

test('a fix step that times out records an attempt', { options: { stepTimeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  await w.clock?.advance(62_000)
  expect((await runOf(w)).status).toBe('error')
  expect((await recordOf(w)).attempts).toBe(1)
})

test('an exhausted gate that holds the PR says why, with the findings and the next steps', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  const run = await runOf(w)
  // The count is the same set the security check reads: unresolved and unverified.
  expect(run.message).toContain('1 high/critical finding')
  expect(run.steps.find(one => one.id === 'pr')?.state).not.toBe('pending')
  const held = w.prompts.at(-1) ?? ''
  expect(held).toContain('held')
  expect(held).toContain('R1-1 [P1] SQL injection in search')
  expect(held).toContain('pr-gate resume')
  expect(held).toContain('waive')
  expect(held).toContain('allow')
  expect(held).not.toContain('open the pull request')
  expect(held.startsWith('/')).toBe(false)
  // Asking again starts no round, and the refusal says the PR is held and why.
  const again = await $.tool.call(createPr)
  expect(again.deny).toContain('held')
  expect(again.deny).not.toContain('prompts you to open')
})

test('with onExhausted stop, a spent allowance holds the PR and says so', { options: { allowanceStandard: 1, onExhausted: 'stop' } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn('Tried.'))
  await $.turn.complete(turn('Tried.'))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  expect(w.prompts.at(-1)).toContain('held')
  expect(w.prompts.at(-1)).not.toContain('open the pull request')
})

test('a pre-PR block is explained without a PR number or merge advice', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  // No commit and no rebuttal: another round would say the same.
  await $.turn.complete(turn('Tried.'))
  await $.turn.complete(turn('Tried.'))
  expect((await recordOf(w)).preStatus).toBe('blocked')
  const text = w.prompts.at(-1) ?? ''
  expect(text).toContain('R1-1')
  expect(text).not.toContain('PR #undefined')
  expect(text).not.toContain('Do not merge')
})

// ------------------------------------------------------------- fix round 2

test('a security fix Codex does not confirm is not a pass', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  // Round 2: Codex passes but does not list R1-1 under verified.
  await $.turn.complete(turn(review('r2-review', 'PASS')))
  expect((await recordOf(w)).preStatus).not.toBe('passed')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
  // Another round asks Codex to verify it.
  expect(w.spawned).toHaveLength(3)
  expect(w.spawned.at(-1)?.prompt).toContain('R1-1 [P1] SQL injection in search')
})

test('a security fix still unverified when the allowance is spent holds the PR and says why', { options: { allowanceStandard: 2 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('R1-1')))
  await $.turn.complete(turn(review('r2-review', 'PASS')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  const held = w.prompts.at(-1) ?? ''
  expect(held).toContain('security fix not yet verified')
  expect(held).not.toContain('open the pull request')
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

// ------------------------------------------------- every route; post-PR; merge hold

const GRAPHQL = 'mcp__claude_ai_github-graphql-mcp__manage_pull_requests'
const merge = { tool: 'Bash' as const, command: 'gh pr merge 1 --squash' }

test('a clean pre-PR result still enters post-PR review, and merging stays held', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  const rec = await recordOf(w)
  expect(rec.phase).toBe('post')
  expect(rec.pr).toBe(1)
  expect((await runOf(w)).phase).toBe('collect')
  const held = await $.tool.call(merge)
  expect(held.deny).toContain('post-PR round 1 owed')
})

test('the github-graphql connector cannot open or merge around the gate', async ($, on) => {
  const w = world(on)
  const created = await $.tool.call({ tool: GRAPHQL, action: 'create', repo: 'me/repo', base: 'dev', head: 'feat/x', title: 't' } as never)
  expect(created.deny).toContain('/pr-gate')
  expect(w.spawned).toHaveLength(1)
  for (const action of ['merge', 'enqueue']) {
    const held = await $.tool.call({ tool: GRAPHQL, action, repo: 'me/repo', number: 1 } as never)
    expect(held.deny).toContain('merge')
  }
})

test('gh api merges and unknown GitHub tools are held', async ($, on) => {
  world(on)
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh api -X PUT repos/me/repo/pulls/1/merge' }))).toBe(true)
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'" }))).toBe(true)
  const unknown = await $.tool.call({ tool: 'mcp__acme-github__merge_pr', number: 1 } as never)
  expect(unknown.deny).toContain('mcp__acme-github__merge_pr')
})

test('a merge to an ungated base, or of a promotion, is not held', async ($, on) => {
  const w = world(on)
  w.gh.base = 'release'
  expect(isHeld(await $.tool.call(merge))).toBe(false)
  w.gh.base = 'main'
  w.gh.headRef = 'dev'
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('a ready lifecycle lets its own head merge; a later push holds it again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  w.store.set('lifecycle:/repo:feat/x', { ...(await recordOf(w)), phase: 'ready' })
  expect(isHeld(await $.tool.call(merge))).toBe(false)
  w.gh.prHead = 'e'.repeat(40)
  const held = await $.tool.call(merge)
  expect(held.deny).toContain('eeeeeee was pushed after the review completed at aaaaaaa')
  expect(held.deny?.startsWith('/')).toBe(false)
})

test('a merge gh cannot resolve is held, and the agent is told what to check', async ($, on) => {
  const w = world(on)
  w.gh.isAuthed = false
  const held = await $.tool.call(merge)
  expect(held.deny).toContain('gh could not say which pull request')
  expect(held.deny).toContain('gh auth status')
})

test('a merge while post-PR review runs tells the agent to wait, not the person to waive', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  const held = (await $.tool.call(merge)).deny ?? ''
  expect(held).toContain('End your turn')
  expect(held).not.toContain('waive')
  expect(w.opened.some(one => one.includes('gh pr merge'))).toBe(false)
})

test('a PR opened for another branch does not move this branch into post-PR review', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --head dev --title release' }))).toBe(false)
  expect((await recordOf(w)).phase).toBe('pre')
})
