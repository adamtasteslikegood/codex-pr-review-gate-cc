import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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
  const autoMerge = "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'"
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: autoMerge }))).toBe(true)
  const unknown = await $.tool.call({ tool: 'mcp__acme-github__merge_pr', number: 1 } as never)
  expect(unknown.deny).toContain('mcp__acme-github__merge_pr')
})

test('a merge to an ungated base, or of a promotion, is not held', async ($, on) => {
  const w = world(on)
  w.gh.hasPr = true
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

// ------------------------------------------------- fix round 1: a real PR, an adopted PR

const cmd = (args: string) => ({ command: 'pr-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never

test('a create gh cannot confirm leaves the branch before its PR', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  w.gh.isAuthed = false
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect((await recordOf(w)).phase).toBe('pre')
  expect((await runOf(w)).phase).not.toBe('collect')
})

test('a graphql create whose PR comes from another branch does not move this one into post-PR', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  w.gh.headRef = 'dev'
  const create = "gh api graphql -f query='mutation { createPullRequest(input: {}) { pullRequest { number } } }'"
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: create }))).toBe(false)
  expect((await recordOf(w)).phase).toBe('pre')
})

test('a PR the gate never saw opened is adopted into post-PR review', async ($, on) => {
  const w = world(on)
  w.gh.hasPr = true
  await $.command.run(cmd(''))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('post')
  expect(rec.pr).toBe(1)
  expect(rec.slug).toBe('me/repo')
  expect(rec.self).toBe('me')
  const run = await runOf(w)
  expect(run.lifecycle).toBe('post')
  expect(run.phase).toBe('collect')
  expect(w.spawned).toHaveLength(0)
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
})

test('a merge with no record is held when its branch is here, and says how to adopt it', async ($, on) => {
  const w = world(on)
  w.gh.hasPr = true
  w.gh.headRef = 'feat/y'
  w.git.locals = ['feat/y']
  const held = await $.tool.call(merge)
  expect(held.deny).toContain('check out feat/y and run /pr-gate')
})

test('a merge with no record of a branch not checked out here is not intercepted', async ($, on) => {
  const w = world(on)
  w.gh.hasPr = true
  w.gh.headRef = 'feat/z'
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('an exhausted post-PR review says so when a merge is held', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  await $.command.run(cmd('stop'))
  w.store.set('lifecycle:/repo:feat/x', { ...(await recordOf(w)), postStatus: 'exhausted', message: 'R1-1 unresolved and the review allowance is spent' })
  const held = (await $.tool.call(merge)).deny ?? ''
  expect(held).toContain('exhausted: R1-1 unresolved')
  expect(held).toContain('waive post')
})

test('a stopped post-PR review tells the agent which branch to resume', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  await $.command.run(cmd('stop'))
  const held = (await $.tool.call(merge)).deny ?? ''
  expect(held).toContain('check out feat/x and run /pr-gate resume')
  expect(w.opened.some(one => one.includes('pr merge'))).toBe(false)
})

test('a merge given by URL reads that repository', async ($, on) => {
  const w = world(on)
  w.gh.hasPr = true
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge https://github.com/other/thing/pull/1' }))).toBe(false)
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge https://github.com/me/repo/pull/1' })
  expect(w.gh.calls.filter(one => one.startsWith('pr view')).at(-1)).toContain('me/repo')
})

test('a merge whose guard fails is held, and the person is offered waive post', async ($, on) => {
  const w = world(on)
  w.gh.isBroken = true
  const held = (await $.tool.call(merge)).deny ?? ''
  expect(held).toContain('guard failed')
  expect(held).toContain('waive post')
})

/** Pre-PR passes clean and the PR opens: the lifecycle is collecting post-PR round 1. */
const toPost = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>) => {
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
}

test('with a roster, collection waits for the listed reviewers, then needs no Codex', async ($, on) => {
  const w = world(on)
  const clock = w.clock
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":["ci"]}'
  await toPost($, w)
  await clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('collect')
  w.gh.checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }]
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  const spawned = w.spawned.length
  await clock.advance(30_000)
  // Clean: the round completes with nothing to triage, and no Codex fallback ran.
  expect(w.spawned).toHaveLength(spawned)
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(1)
  expect(rec.phase).toBe('ready')
})

test('when no reviewer covers the head by the wait cap, Codex reviews the delta', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  // A push after the PR opened: a head no review has covered (the pre-PR round reviewed a...a), checked out here.
  w.gh.prHead = 'b'.repeat(40)
  w.git.head = 'b'.repeat(40)
  await w.clock.advance(20 * 60_000)
  const last = w.spawned.at(-1)
  expect(last?.prompt).toContain('codex')
  expect(last?.prompt).toContain('after it opened')
  const run = await runOf(w)
  expect(run.phase).toBe('review')
  // A non-empty range: from the last reviewed head to the PR head.
  expect(run.diffBase).toBe('a'.repeat(40))
  expect(run.headSha).toBe('b'.repeat(40))
})

test('a head the pre-PR Codex review already covered needs no fallback when no reviewer posts', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const spawned = w.spawned.length
  await w.clock.advance(20 * 60_000)
  expect(w.spawned).toHaveLength(spawned)
  expect((await recordOf(w)).phase).toBe('ready')
})

test('gh failing mid-collect records an incomplete attempt, uses no round, and resume continues', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.isAuthed = false
  await w.clock.advance(30_000)
  const rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(0)
  expect(rec.postStatus).toBe('error')
  expect((await runOf(w)).message).toContain('gh auth login')
  // green in Task 13
  // w.gh.isAuthed = true
  // const presentation = { isFullscreen: false, columns: 120 }
  // await $.command.run({ command: 'pr-gate', args: 'resume', origin: { kind: 'composer' }, presentation })
  // expect((await runOf(w)).phase).toBe('collect')
  // rec = await recordOf(w)
  // expect(rec.postStatus).toBeUndefined()
})

test('gh printing an error page instead of JSON fails the poll closed', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":[]}'
  await toPost($, w)
  w.gh.garbage = '<html>502</html>'
  await w.clock.advance(30_000)
  const rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(0)
  expect(rec.postStatus).toBe('error')
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('unreadable output')
})

test('an adopted PR is judged on its own head, not the local one', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":[]}'
  w.gh.hasPr = true
  w.gh.prHead = 'c'.repeat(40)
  await $.command.run(cmd(''))
  // A review of the local head does not cover the PR's head.
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.git.head, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('collect')
  expect((await runOf(w)).activity).toBe('waiting on claude[bot]')
  w.gh.reviews = [{ id: 6, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  const round = (await recordOf(w)).rounds.find(one => one.phase === 'post' && one.isCompleted)
  expect(round?.startHead).toBe('c'.repeat(40))
  expect(round?.evidence).toEqual([{ source: 'github', reviewer: 'claude[bot]', head: 'c'.repeat(40), isComplete: true }])
})

const KEY = 'lifecycle:/repo:feat/x'

test('an adopted PR whose reviewer approved its head ends ready after one round, whatever is checked out', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":[]}'
  w.gh.hasPr = true
  w.gh.prHead = 'c'.repeat(40)
  await $.command.run(cmd(''))
  w.gh.reviews = [{ id: 6, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post')).toHaveLength(1)
  expect(rec.rounds[0]?.endHead).toBe('c'.repeat(40))
  expect(rec.phase).toBe('ready')
})

test('the Codex fallback does not review a local checkout that is not the PR head', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.prHead = 'b'.repeat(40) // pushed elsewhere; the local checkout is still a...a
  const spawned = w.spawned.length
  await w.clock.advance(20 * 60_000)
  expect(w.spawned).toHaveLength(spawned)
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain(`the local checkout aaaaaaa is not the PR head bbbbbbb: pull (or push), then run pr-gate resume`)
  expect((await recordOf(w)).attempts).toBe(1)
})

test('a gh call that throws fails the poll closed', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.isBroken = true
  await w.clock.advance(45 * 60_000)
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('gh')
  expect((await recordOf(w)).attempts).toBe(1)
})

test('a lifecycle record gone mid-collection ends the run with an error', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.store.delete(KEY)
  await w.clock.advance(30_000)
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('record')
})

test('a new head mid-collection restarts the quiet period', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.checks = [{ name: 'ci', status: 'in_progress', conclusion: null }]
  await w.clock.advance(4 * 60_000)
  const before = await runOf(w)
  expect(before.phase).toBe('collect')
  // Nothing arrived for longer than the quiet period: only the pending check keeps collection open.
  const lastArrivalAt = before.collect?.lastArrivalAt ?? 0
  expect(before.collect?.polledAt ?? 0).toBeGreaterThanOrEqual(lastArrivalAt + 3 * 60_000)
  // A push: the new head has no checks registered yet, so by the old quiet period collection would end on this poll.
  w.gh.prHead = 'b'.repeat(40)
  w.git.head = 'b'.repeat(40)
  w.gh.checks = []
  await w.clock.advance(30_000)
  const after = await runOf(w)
  expect(after.phase).toBe('collect')
  expect(after.roundStartHead).toBe('b'.repeat(40))
  expect(after.collect?.lastArrivalAt ?? 0).toBeGreaterThan(lastArrivalAt)
  expect(w.spawned.filter(one => one.prompt.includes('after it opened'))).toHaveLength(0)
})

test('a pass-through round whose only feedback is a human comment sends it to triage, not to an error', async ($, on) => {
  const w = world(on)
  w.git.numstat = '3\t1\tdocs/guide.md'
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect((await recordOf(w)).passThrough).toBeDefined()
  w.gh.issueComments = [{ id: 31, user: { login: 'alice' }, body: 'This paragraph contradicts the API docs.', created_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(20 * 60_000)
  const run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('triage')
  expect(run.triaged).toEqual(['comment:31'])
  expect(w.spawned).toHaveLength(0)
})

test('at the wait cap with nobody covering the head, fresh findings still go to triage', async ($, on) => {
  const w = world(on)
  w.git.numstat = '3\t1\tdocs/guide.md'
  w.git.roster = '{"reviewers":["copilot"],"checks":[]}'
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  w.gh.issueComments = [{ id: 32, user: { login: 'alice' }, body: 'Typo in the heading.', created_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(21 * 60_000)
  const run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('triage')
})

test('when Codex also runs, the round keeps the GitHub evidence', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":[]}'
  await toPost($, w)
  // A blocker reported fixed and not yet verified: Codex runs even though the reviewer covered the head.
  const rec = (await recordOf(w)) as LifecycleRecord
  const owed = {
    id: 'R1-1', severity: 'P1', title: 'x', file: 'src/app.ts', line: 1, round: 1,
    source: 'codex-review', reviewer: 'codex', headSeen: 'a'.repeat(40), status: 'reported-fixed', history: [],
  }
  w.store.set(KEY, { ...rec, findings: [owed] })
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('review')
  await $.turn.complete(turn(review('r2-review', 'PASS', [], { verified: ['R1-1'] }), `agent-${w.spawned.length}`))
  // Nothing left to triage: the round is recorded with both.
  const round = (await recordOf(w)).rounds.find(one => one.phase === 'post' && one.isCompleted)
  const sources = (round?.evidence ?? []).map(one => `${one.source}:${one.reviewer}`)
  expect(sources).toEqual(['github:claude[bot]', 'codex:codex'])
})

test('a roster reviewer who never posted is recorded as missing evidence', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]","copilot"],"checks":[]}'
  await toPost($, w)
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(21 * 60_000)
  const round = (await recordOf(w)).rounds.find(one => one.phase === 'post')
  expect(round?.evidence).toEqual([
    { source: 'github', reviewer: 'claude[bot]', head: 'a'.repeat(40), isComplete: true },
    { source: 'github', reviewer: 'copilot', head: 'a'.repeat(40), isComplete: false },
  ])
})

test('an unknown gh login is looked up again, and the poll fails closed when it stays unknown', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const rec = (await recordOf(w)) as LifecycleRecord
  w.store.set(KEY, { ...rec, self: undefined })
  w.gh.self = ''
  await w.clock.advance(30_000)
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('gh login')
  expect((await recordOf(w)).attempts).toBe(1)
})

test('an unknown gh login found again is kept on the record', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const rec = (await recordOf(w)) as LifecycleRecord
  w.store.set(KEY, { ...rec, self: undefined })
  await w.clock.advance(30_000)
  expect((await recordOf(w)).self).toBe('me')
})

const inline = (id: number, body: string, head: string, line = 4) => ({
  id, user: { login: 'claude[bot]' }, body, path: 'src/app.ts', line, commit_id: head, created_at: '1970-01-01T00:01:00Z', html_url: `u${id}`,
})
const roster = '{"reviewers":["claude[bot]"],"checks":[]}'
const covers = (head: string) => [
  { id: 5, user: { login: 'claude[bot]' }, body: '', state: 'COMMENTED', commit_id: head, submitted_at: '1970-01-01T00:01:00Z' },
]

/** Round 1 ends with the reviewer's feedback handed to the main agent. */
const toTriage = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>, body = '**P1** SQL injection') => {
  w.git.roster = roster
  await toPost($, w)
  w.gh.comments = [inline(11, body, w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
}

const triaged = (step: string, dispositions: object[]) => turn(`ok\n${TRAILER}\n${JSON.stringify({ step, dispositions })}`)

test('code changes in the first post-PR round require review of the resulting head', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  expect(w.prompts.at(-1)).toContain('G')
  expect(w.prompts.at(-1)).toContain('reply to thread 11')
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', isSecurity: true, replyId: '991' }]))
  const rec = await recordOf(w)
  expect(rec.replies['inline:11']).toBe('991')
  expect(rec.processed).toContain('inline:11')
  expect(rec.findings.find(one => one.externalId === 'inline:11')?.status).toBe('reported-fixed')
  // Round 2, the protected one, is collecting on the new head.
  const run = await runOf(w)
  expect(run.phase).toBe('collect')
  expect(run.roundKind).toBe('baseline')
  expect(rec.phase).toBe('post')
})

test('a clean first post-PR round does not force a second', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', note: 'name matches the API', replyId: '992' }]))
  expect((await recordOf(w)).phase).toBe('ready')
  expect(w.prompts.at(-1)).toContain('ready for the merge decision')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --squash' }))).toBe(false)
})

test('another agent pushing during triage makes the PR head the round\'s end head', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  w.gh.prHead = '7'.repeat(40) // pushed by someone else; local HEAD unchanged
  w.git.isAncestor = true
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post').at(-1)?.endHead).toBe('7'.repeat(40))
  expect((await runOf(w)).roundKind).toBe('baseline')
})

test('duplicate comments and polling consume no new round', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  const before = await recordOf(w)
  await w.clock.advance(10 * 60_000) // ready: nothing polls, nothing counts
  const after = await recordOf(w)
  expect(after.rounds).toHaveLength(before.rounds.length)
  expect(w.prompts.filter(one => one.includes('New review feedback'))).toHaveLength(1)
})

test('fresh GitHub finding ids number after the ones the round already has', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  // An earlier attempt of this round already raised G2-1 for other feedback.
  const rec = await recordOf(w)
  const earlier = {
    id: 'G2-1', round: 2, source: 'github', reviewer: 'alice', externalId: 'comment:77', severity: 'P1', title: 'x',
    headSeen: 'a'.repeat(40), status: 'rebutted', history: [],
  }
  w.store.set(KEY, { ...rec, findings: [earlier], processed: ['comment:77'] })
  w.gh.comments = [inline(11, '**P1** SQL injection', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  expect(w.prompts.at(-1)).toContain('G2-2 from claude[bot]')
  expect((await runOf(w)).findings.find(one => one.externalId === 'inline:11')?.id).toBe('G2-2')
})

test('commits the PR does not have end triage as an attempt, keeping the replies', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  w.git.head = 'e'.repeat(40) // committed here, never pushed
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('commits on feat/x are not on the PR: pull or push, then pr-gate resume')
  const rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(0)
  expect(rec.replies['inline:11']).toBe('991')
  expect(rec.processed).toContain('inline:11')
})

test('uncommitted changes after triage still record the replies, so none is posted twice', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  w.git.dirty = ' M src/app.ts'
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  expect((await runOf(w)).status).toBe('error')
  const rec = await recordOf(w)
  expect(rec.replies['inline:11']).toBe('991')
  expect(rec.processed).toContain('inline:11')
  expect(rec.findings.filter(one => one.externalId === 'inline:11')).toHaveLength(1)
})

test('GitHub findings in a final-head check enter the ledger and can make it exhausted, never ready', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  // Round 2: the P1 is fixed and pushed.
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  // Round 3, the protected one: Codex verifies the fix, a nit is fixed and pushed.
  w.gh.comments = [inline(11, '**P1** SQL injection', 'a'.repeat(40)), inline(12, 'nit: rename this', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('review')
  await $.turn.complete(turn(review('r3-review', 'PASS', [], { verified: ['G2-1'] }), `agent-${w.spawned.length}`))
  expect((await runOf(w)).phase).toBe('triage')
  await w.clock.advance(1000) // the triage prompt enters the main agent's queue
  w.git.head = 'f'.repeat(40)
  w.gh.prHead = 'f'.repeat(40)
  await $.turn.complete(triaged('r3-triage', [{ id: 'G3-1', action: 'fixed', severity: 'P3', replyId: '993' }]))
  // The allowance is spent: round 4 is the final-head check, and a reviewer raises a P1 on it.
  expect((await runOf(w)).roundKind).toBe('final-head-check')
  w.gh.comments = [...w.gh.comments, inline(13, '**P1** token leaks into logs', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  await $.turn.complete(turn(review('r4-review', 'PASS'), `agent-${w.spawned.length}`))
  expect(w.prompts.at(-1)).toContain('G4-1')
  await w.clock.advance(1000)
  await $.turn.complete(triaged('r4-triage', []))
  // Asked once more (R34), and left unanswered again.
  await w.clock.advance(1000)
  await $.turn.complete(triaged('r4-triage', []))
  const rec = await recordOf(w)
  const raised = rec.findings.find(one => one.externalId === 'inline:13')
  expect(raised?.severity).toBe('P1')
  expect(raised?.status).toBe('open')
  expect(rec.processed).not.toContain('inline:13')
  expect(rec.phase).not.toBe('ready')
  expect(rec.postStatus).toBe('exhausted')
})

// ------------------------------------------------------------- task 12 fix round 1

test('R32: an open blocker left unanswered on an unchanged head blocks with the agent\'s next step, spending nothing', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await $.turn.complete(triaged('r2-triage', []))
  await w.clock.advance(1000)
  await $.turn.complete(triaged('r2-triage', []))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(1)
  expect(rec.rounds.filter(one => one.kind === 'discretionary' && one.isCompleted)).toHaveLength(1) // the pre-PR round only
  expect(rec.postStatus).toBe('blocked')
  expect((await runOf(w)).status).toBe('blocked')
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('G2-1')
  expect(said).toContain('Your next step: fix or rebut G2-1, then pr-gate resume')
})

test('R32: an open blocker from an earlier round is carried into triage', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const rec = await recordOf(w)
  const open = {
    id: 'R1-1', round: 1, source: 'codex-review', reviewer: 'codex', severity: 'P1', title: 'Unvalidated redirect', file: 'src/app.ts', line: 12,
    headSeen: 'a'.repeat(40), status: 'open', history: [],
  }
  w.store.set(KEY, { ...rec, findings: [open] })
  w.gh.comments = [inline(11, 'nit: rename this', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('Carried from earlier rounds, still open')
  expect(said).toContain('R1-1 [P1] Unvalidated redirect')
})

test('R33: in the protected round, a comment on the lines just fixed is not called a duplicate', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  w.gh.comments = [inline(11, '**P1** SQL injection', 'a'.repeat(40)), inline(12, '**P1** SQL injection still here', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  await $.turn.complete(turn(review('r3-review', 'PASS'), `agent-${w.spawned.length}`))
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('G3-1')
  expect(said).not.toContain('duplicate of an answered finding')
})

test('R34: an item left without an answer is asked about once more, and does not reach ready silently', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await $.turn.complete(triaged('r2-triage', []))
  expect(w.prompts.at(-1)).toContain('These review items have no answer yet: G2-1')
  await w.clock.advance(1000)
  await $.turn.complete(triaged('r2-triage', []))
  const rec = await recordOf(w)
  expect(rec.phase).not.toBe('ready')
  expect(rec.processed).not.toContain('inline:11')
  expect(w.prompts.at(-1)).toContain('G2-1')
})

test('R35: feedback this machine already replied to is not asked to be replied to again', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const mine = { ...inline(12, 'Fixed in 1234567.', w.gh.prHead), user: { login: 'me' }, in_reply_to_id: 11, created_at: '1970-01-01T00:02:00Z' }
  w.gh.comments = [inline(11, '**P1** SQL injection', w.gh.prHead), mine]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('G2-1')
  expect(said).not.toContain('reply to thread 11')
  expect(said).toContain('check the thread for a reply of yours')
  expect((await recordOf(w)).replies['inline:11']).toBe('12')
})

test('R36: a rebutted security blocker is not ready until Codex checks the rebuttal', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  const spawned = w.spawned.length
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'the query is parameterised at src/db.ts:4', replyId: '991' }]))
  expect((await recordOf(w)).phase).not.toBe('ready')
  expect(w.spawned).toHaveLength(spawned + 1)
  expect(w.spawned.at(-1)?.prompt).toContain('rebutted')
  await $.turn.complete(turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-verify', ok: true })}`, `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('rebutted')
  expect(rec.phase).toBe('ready')
})

test('R36: a rebuttal Codex does not accept reopens the security blocker and goes back to the agent', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  const verdict = JSON.stringify({ step: 'r2-verify', ok: false, notes: 'G2-1: reachable from /search' })
  await $.turn.complete(turn(`no\n${TRAILER}\n${verdict}`, `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('open')
  expect(rec.phase).not.toBe('ready')
  expect(w.prompts.at(-1)).toContain('G2-1')
})

test('R36: a rebuttal check that cannot finish holds the PR', { options: { stepTimeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  await w.clock.advance(2 * 60_000)
  const rec = await recordOf(w)
  expect(rec.phase).not.toBe('ready')
  expect(rec.postStatus).toBe('blocked')
  expect(w.prompts.at(-1)).toContain('is held')
})

test('a ready record that is no longer ready goes back to post', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await $.turn.complete(triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  const open = { ...rec.findings[0], id: 'X-1', severity: 'P1', status: 'open' }
  w.store.set(KEY, { ...rec, findings: [...rec.findings, open] })
  await $.command.run(cmd('resume'))
  expect((await recordOf(w)).phase).toBe('post')
})
