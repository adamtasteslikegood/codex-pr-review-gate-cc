import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { createPr, done, isHeld, P1, P2, review, runOf, TRAILER, turn, world } from './world'
import { invalidate, isAcceptedRebuttal, mergeHolds, unresolvedBlockers } from '../hooks/lifecycle'
import type { Finding, FindingEvent, LifecycleRecord } from '../types'

const recordOf = async (w: ReturnType<typeof world>): Promise<LifecycleRecord> => w.stored('lifecycle:/repo:feat/x') as LifecycleRecord
const fixed = (id: string, note = 'done') => `Fixed.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id, action: 'fixed', note }] })}`

test('several reviewers in one cycle consume one round', async ($, on) => {
  const w = world(on)
  w.git.numstat = '10\t2\tsrc/auth/login.ts' // high: review and challenge run in parallel
  await $.tool.call(createPr)
  expect(w.spawned).toHaveLength(2)
  await done($, turn(review('r1-review', 'PASS'), 'agent-1'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-2'))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(rec.rounds[0]?.evidence.map(one => one.reviewer)).toEqual(['codex', 'codex-challenge'])
})

test('omitted findings are not marked fixed', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1, P2])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  // R1-2 had no answer: the fix step is asked once more, and says nothing again.
  await done($, turn('Nothing more.'))
  // Round 2: Codex raises nothing and confirms nothing.
  await done($, turn(review('r2-review', 'PASS')))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-1')?.status).toBe('reported-fixed')
  expect(rec.findings.find(one => one.id === 'R1-2')?.status).toBe('open')
})

test('a fix Codex confirms is verified; a rebuttal Codex holds is open again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1, { ...P1, title: 'Second', line: 40 }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'rebutted', note: 'guarded at :38' }] })}`))
  expect(w.spawned.at(-1)?.prompt).toContain('R1-2 [P1] Second')
  await done($, turn(review('r2-review', 'PASS', [], { verified: ['R1-1'], held: ['R1-2'] })))
  const rec = await recordOf(w)
  expect(rec.findings.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'verified-fixed'],
    ['R1-2', 'open'],
  ])
})

test('a held blocker goes back to the fixer instead of letting the PR open', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'rebutted', note: 'guarded at :10' }] })}`))
  await done($, turn(review('r2-review', 'PASS', [], { held: ['R1-1'] })))
  const run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('fix')
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] Unvalidated redirect')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
})

test('a security P1 only reported fixed does not let an exhausted gate open the PR', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  const rec = await recordOf(w)
  expect(rec.findings[0]?.isSecurity).toBe(true)
  expect(rec.preStatus).toBe('exhausted')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('new scope invalidates only the affected evidence', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1, { ...P2, file: 'src/other.ts' }])))
  w.git.head = 'd'.repeat(40)
  await done($, 
    turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'rebutted', note: 'fine as is' }] })}`),
  )
  await done($, turn(review('r2-review', 'PASS'), 'agent-2'))
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
  await done($, turn(`${TRAILER}\n${JSON.stringify({ step: 'r1-review', gate: 'ERROR', error: 'timeout' })}`))
  await done($, turn(review('r1-review', 'PASS'), 'agent-2'))
  const rec = await recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(rec.rounds[0]?.isCompleted).toBe(false)
})

test('advisories are fixed even when the reserve rule leaves no Codex round for them', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS', [P2])))
  const run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.fixKind).toBe('advisory')
  expect(w.prompts.at(-1)).toContain('R1-1 [P2] Rename this')
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1', 'renamed')))
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
  expect(w.spawned).toHaveLength(1)
  expect((await runOf(w)).status).toBe('passed')
})

test('a finding left without an answer is asked about once more, then stays open', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1, P2])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  // The re-prompt names the finding that had no answer, and uses no round.
  expect(w.prompts.at(-1)).toContain('These findings have no answer yet: R1-2')
  expect(w.spawned).toHaveLength(1)
  expect((await recordOf(w)).rounds).toHaveLength(0)
  await done($, turn(fixed('R1-1', 'still done')))
  // The round ends; Codex looks at the fix and passes it, and the PR opens with R1-2 still open.
  expect(w.spawned).toHaveLength(2)
  await done($, turn(review('r2-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
  await done($, turn(review('r2-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  w.git.dirty = ' M src/app.ts'
  await done($, turn(fixed('R1-1')))
  expect((await runOf(w)).status).toBe('error')
  w.git.dirty = ''
  w.git.head = 'e'.repeat(40)
  await $.command.run(run$('resume'))
  const run = await runOf(w)
  await done($, turn(review(`r${run.round}-review`, 'FAIL', [{ ...P1, title: 'Another thing', line: 80 }]), `agent-${w.spawned.length}`))
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
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await $.command.run(run$('stop'))
  expect((await recordOf(w)).attempts).toBe(1)
  await $.command.run(run$('resume'))
  const run = await runOf(w)
  await done($, turn(review(`r${run.round}-review`, 'PASS', [{ ...P1, severity: 'P2', title: 'Other nit', line: 90 }]), `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.map(one => [one.id, one.severity, one.title])).toEqual([
    ['R1-1', 'P1', 'Unvalidated redirect'],
    ['R1-2', 'P2', 'Other nit'],
  ])
})

test('a fix step that times out records an attempt', { options: { stepTimeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await w.clock?.advance(62_000)
  expect((await runOf(w)).status).toBe('error')
  expect((await recordOf(w)).attempts).toBe(1)
})

test('an exhausted gate that holds the PR says why, with the findings and the next steps', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  const run = await runOf(w)
  // The count is the same set the security check reads: unresolved and unverified.
  expect(run.message).toContain('1 high/critical finding')
  expect(run.steps.find(one => one.id === 'pr')?.state).not.toBe('pending')
  const held = w.prompts.at(-1) ?? ''
  expect(held).toContain('held')
  expect(held).toContain('R1-1 [P1] SQL injection in search')
  expect(held).not.toContain('pr-gate resume')
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
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  expect(w.prompts.at(-1)).toContain('held')
  expect(w.prompts.at(-1)).not.toContain('open the pull request')
})

test('a pre-PR block is explained without a PR number or merge advice', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  // No commit and no rebuttal: another round would say the same.
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
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
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  // Round 2: Codex passes but does not list R1-1 under verified.
  await done($, turn(review('r2-review', 'PASS')))
  expect((await recordOf(w)).preStatus).not.toBe('passed')
  expect(w.prompts.some(one => one.includes('open the pull request'))).toBe(false)
  // Another round asks Codex to verify it.
  expect(w.spawned).toHaveLength(3)
  expect(w.spawned.at(-1)?.prompt).toContain('R1-1 [P1] SQL injection in search')
})

test('a security fix still unverified when the allowance is spent holds the PR and says why', { options: { allowanceStandard: 2 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  await done($, turn(review('r2-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  const held = (await $.tool.call(merge)).deny ?? ''
  expect(held).toContain('End your turn')
  expect(held).not.toContain('waive')
  expect(w.opened.some(one => one.includes('gh pr merge'))).toBe(false)
})

test('a PR opened for another branch does not move this branch into post-PR review', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --head dev --title release' }))).toBe(false)
  expect((await recordOf(w)).phase).toBe('pre')
})

// ------------------------------------------------- fix round 1: a real PR, an adopted PR

const cmd = (args: string) => ({ command: 'pr-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never

test('a create gh cannot confirm leaves the branch before its PR', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  w.gh.isAuthed = false
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect((await recordOf(w)).phase).toBe('pre')
  expect((await runOf(w)).phase).not.toBe('collect')
})

test('a graphql create whose PR comes from another branch does not move this one into post-PR', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'PASS')))
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
  await done($, turn(review('r1-review', 'PASS')))
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
  w.gh.isAuthed = true
  const presentation = { isFullscreen: false, columns: 120 }
  await $.command.run({ command: 'pr-gate', args: 'resume', origin: { kind: 'composer' }, presentation })
  expect((await runOf(w)).phase).toBe('collect')
  const after = await recordOf(w)
  expect(after.postStatus).toBeUndefined()
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
  expect(run.message).toContain(`the local checkout aaaaaaa is not the PR head bbbbbbb: pull (or push), then run /pr-gate resume`)
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
  await done($, turn(review('r2-review', 'PASS', [], { verified: ['R1-1'] }), `agent-${w.spawned.length}`))
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
/** Codex's rebuttal check: one verdict per finding id (R41); true holds, a string is why it fails. */
const accept = (step: string, w: ReturnType<typeof world>, said: Record<string, true | string> = { 'G2-1': true }) => {
  const verdicts = Object.entries(said).map(([id, one]) => (one === true ? { id, holds: true } : { id, holds: false, note: one }))
  return turn(`v\n${TRAILER}\n${JSON.stringify({ step, verdicts })}`, `agent-${w.spawned.length}`)
}

test('code changes in the first post-PR round require review of the resulting head', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  expect(w.prompts.at(-1)).toContain('G')
  expect(w.prompts.at(-1)).toContain('reply to thread 11')
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', isSecurity: true, replyId: '991' }]))
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
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', note: 'name matches the API', replyId: '992' }]))
  // R39: Codex checks the rebuttal on the same head first.
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
  expect(w.prompts.at(-1)).toContain('ready for the merge decision')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --squash' }))).toBe(false)
})

test('another agent pushing during triage makes the PR head the round\'s end head', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  w.gh.prHead = '7'.repeat(40) // pushed by someone else; local HEAD unchanged
  w.git.isAncestor = true
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post').at(-1)?.endHead).toBe('7'.repeat(40))
  expect((await runOf(w)).roundKind).toBe('baseline')
})

test('duplicate comments and polling consume no new round', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
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
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('commits on feat/x are not on the PR: pull or push, then /pr-gate resume')
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
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  expect((await runOf(w)).status).toBe('error')
  const rec = await recordOf(w)
  expect(rec.replies['inline:11']).toBe('991')
  expect(rec.processed).toContain('inline:11')
  expect(rec.findings.filter(one => one.externalId === 'inline:11')).toHaveLength(1)
})

test('GitHub findings in a final-head check enter the ledger and are never ready; left open on its head, they go back to the agent', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  // Round 2: the P1 is fixed and pushed.
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  // Round 3, the protected one: Codex verifies the fix, a nit is fixed and pushed.
  w.gh.comments = [inline(11, '**P1** SQL injection', 'a'.repeat(40)), inline(12, 'nit: rename this', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  expect((await runOf(w)).phase).toBe('review')
  await done($, turn(review('r3-review', 'PASS', [], { verified: ['G2-1'] }), `agent-${w.spawned.length}`))
  expect((await runOf(w)).phase).toBe('triage')
  await w.clock.advance(1000) // the triage prompt enters the main agent's queue
  w.git.head = 'f'.repeat(40)
  w.gh.prHead = 'f'.repeat(40)
  await done($, triaged('r3-triage', [{ id: 'G3-1', action: 'fixed', severity: 'P3', replyId: '993' }]))
  // The allowance is spent: round 4 is the final-head check, and a reviewer raises a P1 on it.
  expect((await runOf(w)).roundKind).toBe('final-head-check')
  w.gh.comments = [...w.gh.comments, inline(13, '**P1** token leaks into logs', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  // R58: f touched G2-1's file after Codex verified it; the final-head check's review re-verifies it.
  await done($, turn(review('r4-review', 'PASS', [], { verified: ['G2-1'] }), `agent-${w.spawned.length}`))
  expect(w.prompts.at(-1)).toContain('G4-1')
  await w.clock.advance(1000)
  await done($, triaged('r4-triage', []))
  // Asked once more (R34), and left unanswered again.
  await w.clock.advance(1000)
  await done($, triaged('r4-triage', []))
  const rec = await recordOf(w)
  const raised = rec.findings.find(one => one.externalId === 'inline:13')
  expect(raised?.severity).toBe('P1')
  expect(raised?.status).toBe('open')
  expect(rec.processed).not.toContain('inline:13')
  expect(rec.phase).not.toBe('ready')
  // R43: on the same head the answerable block comes before exhaustion; the agent can still answer it.
  expect(rec.postStatus).toBe('blocked')
  expect(w.prompts.at(-1)).toContain('G4-1')
})

// ------------------------------------------------------------- task 12 fix round 1

test('R32: an open blocker left unanswered on an unchanged head blocks with the agent\'s next step, spending nothing', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await done($, triaged('r2-triage', []))
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', []))
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(1)
  expect(rec.rounds.filter(one => one.kind === 'discretionary' && one.isCompleted)).toHaveLength(1) // the pre-PR round only
  expect(rec.postStatus).toBe('blocked')
  expect((await runOf(w)).status).toBe('blocked')
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('G2-1')
  expect(said).toContain('Your next step: fix or rebut G2-1, then /pr-gate resume')
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
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  w.gh.comments = [inline(11, '**P1** SQL injection', 'a'.repeat(40)), inline(12, '**P1** SQL injection still here', w.gh.prHead)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  await done($, turn(review('r3-review', 'PASS'), `agent-${w.spawned.length}`))
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('G3-1')
  expect(said).not.toContain('duplicate of an answered finding')
})

test('R34: an item left without an answer is asked about once more, and does not reach ready silently', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', []))
  expect(w.prompts.at(-1)).toContain('These review items have no answer yet: G2-1')
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', []))
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
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'the query is parameterised at src/db.ts:4', replyId: '991' }]))
  expect((await recordOf(w)).phase).not.toBe('ready')
  expect(w.spawned).toHaveLength(spawned + 1)
  expect(w.spawned.at(-1)?.prompt).toContain('rebutted')
  await done($, accept('r2-verify', w))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('rebutted')
  expect(rec.phase).toBe('ready')
})

test('R36: a rebuttal Codex does not accept reopens the security blocker and goes back to the agent', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'G2-1: reachable from /search' }))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('open')
  expect(rec.phase).not.toBe('ready')
  expect(w.prompts.at(-1)).toContain('G2-1')
})

test('R36: a rebuttal check that cannot finish holds the PR', { options: { stepTimeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  await w.clock.advance(2 * 60_000)
  const rec = await recordOf(w)
  expect(rec.phase).not.toBe('ready')
  expect(rec.postStatus).toBe('blocked')
  expect(w.prompts.at(-1)).toContain('is held')
})

test('a ready record that is no longer ready goes back to post', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  const open = { ...rec.findings[0], id: 'X-1', severity: 'P1', status: 'open' }
  w.store.set(KEY, { ...rec, findings: [...rec.findings, open] })
  await $.command.run(cmd('resume'))
  expect((await recordOf(w)).phase).toBe('post')
})

test('R36: after a held rebuttal check, a resumed round checks the rebuttal again before ready', { options: { stepTimeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  await w.clock.advance(2 * 60_000)
  expect((await recordOf(w)).postStatus).toBe('blocked')
  const spawned = w.spawned.length
  await $.command.run(cmd('resume'))
  await w.clock.advance(30_000)
  expect((await recordOf(w)).phase).not.toBe('ready')
  expect(w.spawned).toHaveLength(spawned + 1)
  expect((await runOf(w)).phase).toBe('verify')
})

// ------------------------------------------------------------- task 12 fix round 2

const postRounds = (rec: LifecycleRecord) => rec.rounds.filter(one => one.phase === 'post' && one.isCompleted).length

/** Probe A: the P1 is left unanswered twice, so the post-PR review blocks on the same head. */
const toBlocked = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>, body = '**P1** SQL injection') => {
  await toTriage($, w, body)
  await done($, triaged('r2-triage', []))
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', []))
  expect((await recordOf(w)).postStatus).toBe('blocked')
}

test('R37: resuming a blocked post-PR review re-opens triage; a security rebuttal goes to Codex, then ready, with no round', async ($, on) => {
  const w = world(on)
  await toBlocked($, w)
  const before = postRounds(await recordOf(w))
  await $.command.run(cmd('resume'))
  const run = await runOf(w)
  expect(run.phase).toBe('triage')
  await w.clock.advance(1000)
  // The ticker sends the prompt once the command has returned.
  expect(w.prompts.at(-1)).toContain('resumed on the same head')
  expect(w.prompts.at(-1)).toContain('G2-1 in thread 11')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'parameterised at src/db.ts:4', replyId: '995' }]))
  expect((await recordOf(w)).findings.find(one => one.id === 'G2-1')?.status).toBe('rebutted')
  expect((await recordOf(w)).replies['inline:11']).toBe('995')
  expect((await runOf(w)).phase).toBe('verify')
  await done($, accept('r2-verify', w))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  expect(postRounds(rec)).toBe(before)
  expect(rec.rounds.filter(one => one.kind === 'discretionary' && one.isCompleted)).toHaveLength(1)
})

test('R37: a deferred P2 answered on resume ends awaiting the person\'s decision, with no new round', async ($, on) => {
  const w = world(on)
  await toBlocked($, w, 'Consider renaming this')
  const before = postRounds(await recordOf(w))
  await $.command.run(cmd('resume'))
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', note: 'tracked in KAN-9', replyId: '996' }]))
  const rec = await recordOf(w)
  // R39: a deferral is an answer, but only the person's waiver lets it into the merge.
  expect(rec.phase).not.toBe('ready')
  expect(rec.postStatus).toBe('awaiting-decision')
  expect(rec.processed).toContain('inline:11')
  expect(postRounds(rec)).toBe(before)
})

test('M2: a rebuttal Codex rejects is reported as rejected, not as unanswered', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'not reachable', replyId: '991' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'reachable from /search' }))
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('Codex did not accept the rebuttal of G2-1: reachable from /search')
  expect(said).not.toContain('with no fix or rebuttal')
})

test('R38: one reply of this machine answers one reviewer comment in its thread', async ($, on) => {
  const w = world(on)
  w.git.roster = roster
  await toPost($, w)
  const later = { ...inline(13, '**P1** and the second query too', w.gh.prHead), in_reply_to_id: 11, created_at: '1970-01-01T00:01:30Z' }
  const mine = { ...inline(12, 'Fixed in 1234567.', w.gh.prHead), user: { login: 'me' }, in_reply_to_id: 11, created_at: '1970-01-01T00:02:00Z' }
  w.gh.comments = [inline(11, '**P1** SQL injection', w.gh.prHead), later, mine]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  const replies = (await recordOf(w)).replies
  expect(Object.keys(replies)).toEqual(['inline:13'])
  expect(w.prompts.at(-1)).toContain('if your reply there does not address this comment, reply')
})

test('M3: resuming a post-PR record reports the post-PR status', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  const said = await $.command.run(cmd('resume'))
  expect(JSON.stringify(said)).toContain('post-PR review')
  expect(JSON.stringify(said)).not.toContain('pre-PR gate stands')
})

// ------------------------------------------------------------- task 12 fix round 3 (R39)

test('R39: a deferred P3 after the PR opened is not ready, and the merge is held naming it', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'follow-up KAN-9', replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.phase).not.toBe('ready')
  expect(rec.postStatus).toBe('awaiting-decision')
  expect(w.prompts.at(-1)).toContain('G2-1')
  expect(w.prompts.at(-1)).toContain('Their options:')
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny).toContain('G2-1 [P3] deferred')
})

test('R39: a rebutted P2 that Codex accepts reaches ready', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  const spawned = w.spawned.length
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'the name is the API\'s', replyId: '992' }]))
  expect((await recordOf(w)).phase).not.toBe('ready')
  expect(w.spawned).toHaveLength(spawned + 1)
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R39: a rebutted P2 that Codex rejects is open again', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'fine as is', replyId: '992' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'G2-1: the name misleads' }))
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('open')
  expect(rec.phase).not.toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})

test('R39: a pre-PR deferred advisory carried into the PR holds the merge', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS', [P2])))
  await done($, turn(`Deferred.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'deferred', note: 'out of scope' }] })}`))
  expect((await recordOf(w)).preStatus).toBe('passed')
  await $.tool.call(createPr)
  await w.clock.advance(21 * 60_000)
  const rec = await recordOf(w)
  expect(rec.rounds.filter(one => one.phase === 'post' && one.isCompleted)).toHaveLength(1)
  expect(rec.phase).not.toBe('ready')
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny).toContain('R1-1 [P2] deferred')
})

// ------------------------------------------------------------- task 12 fix round 4 (R40–R44)

/** Round 1 ends with two reviewer comments handed to the main agent: G2-1 and G2-2. */
const toTwo = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>) => {
  w.git.roster = roster
  await toPost($, w)
  w.gh.comments = [inline(11, 'Consider renaming this', w.gh.prHead), inline(12, 'Consider a guard on the empty list', w.gh.prHead, 40)]
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
}

const bothRebutted = triaged('r2-triage', [
  { id: 'G2-1', action: 'rebutted', note: 'the name is the API\'s', replyId: '991' },
  { id: 'G2-2', action: 'rebutted', note: 'guarded at src/app.ts:38', replyId: '992' },
])

test('R41: two rebuttals get one verdict each, and are settled independently', async ($, on) => {
  const w = world(on)
  await toTwo($, w)
  await done($, bothRebutted)
  expect(w.spawned.at(-1)?.prompt).toContain('"verdicts"')
  await done($, accept('r2-verify', w, { 'G2-1': true, 'G2-2': 'G2-2: no guard on /search' }))
  const rec = await recordOf(w)
  const one = rec.findings.find(f => f.id === 'G2-1')
  const two = rec.findings.find(f => f.id === 'G2-2')
  expect(one?.status).toBe('rebutted')
  expect(one?.history.at(-1)?.by).toBe('codex')
  expect(two?.status).toBe('open')
  // R44: the note is stored without the id Codex put in front of it.
  expect(two?.history.at(-1)?.note).toBe('no guard on /search')
  expect(w.prompts.at(-1)).toContain('Codex did not accept the rebuttal of G2-2: no guard on /search')
  expect(w.prompts.at(-1)).not.toContain('G2-2: G2-2')
  expect(mergeHolds(rec).map(f => f.id)).toEqual(['G2-2'])
})

test('R41: a verdict missing for one id holds that id only', async ($, on) => {
  const w = world(on)
  await toTwo($, w)
  await done($, bothRebutted)
  await done($, accept('r2-verify', w, { 'G2-1': true }))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.history.at(-1)?.by).toBe('codex')
  const two = rec.findings.find(f => f.id === 'G2-2')
  expect(two?.status).toBe('rebutted')
  expect(two?.history.at(-1)?.by).toBe('main')
  expect(rec.phase).not.toBe('ready')
  expect(mergeHolds(rec).map(f => f.id)).toEqual(['G2-2'])
})

test('R40: rebut, reject, rebut again costs one Codex check, and the dispute goes to the person', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  const spawned = w.spawned.length
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'the name is the API\'s', replyId: '992' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'the name misleads callers' }))
  // After one rejection, the agent's step offers only fix or defer.
  expect(w.prompts.at(-1)).toContain('fix or defer G2-1')
  expect(w.prompts.at(-1)).not.toContain('fix or rebut G2-1')
  await $.command.run(cmd('resume'))
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('fix it or defer it')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'renaming breaks the public API', replyId: '993' }]))
  expect(w.spawned).toHaveLength(spawned + 1)
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.status).toBe('rebutted')
  expect(rec.postStatus).toBe('awaiting-decision')
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('renaming breaks the public API')
  expect(said).toContain('the name misleads callers')
  expect(said).toContain('/pr-gate waive G2-1 <reason>')
  expect(said).not.toContain('allow 1')
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny).toContain('disputed')
})

test('a re-check flag is cleared only for this run\'s answers: an accepted rebuttal whose file a later fix touched is checked again', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', note: 'the name is the API\'s', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  const ready = await recordOf(w)
  expect(ready.phase).toBe('ready')
  const g1 = ready.findings[0]!
  const g2 = { ...g1, id: 'G2-2', source: 'codex-review' as const, reviewer: 'codex', externalId: undefined, threadId: undefined, severity: 'P2' as const,
    status: 'open' as const, note: undefined, history: [{ round: 2, status: 'open' as const, by: 'codex', at: 1 }] }
  w.store.set(KEY, { ...ready, findings: [...ready.findings, g2] })
  await $.command.run(cmd('resume'))
  await w.clock.advance(1000)
  expect((await runOf(w)).isAnswer).toBe(true)
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  w.git.changed = 'src/app.ts'
  await done($, triaged('r2-triage', [{ id: 'G2-2', action: 'fixed', note: 'guarded' }]))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.needsRecheck).toBe(true)
  expect(mergeHolds(rec).map(f => f.id)).toContain('G2-1')
})

test('a record that goes ready keeps no stale message', async ($, on) => {
  const w = world(on)
  await toBlocked($, w)
  expect((await recordOf(w)).message).toBeDefined()
  await $.command.run(cmd('resume'))
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'parameterised at src/db.ts:4', replyId: '995' }]))
  await done($, accept('r2-verify', w))
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  expect(rec.message).toBeUndefined()
})

test('R44: before the PR, a rebuttal Codex accepts stays rebutted with Codex\'s entry, settles the gate, and lapses on a file change', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await done($, turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'rebutted', note: 'validated at :10' }] })}`))
  await done($, turn(review('r2-review', 'PASS', [], { verified: ['R1-1'] })))
  const rec = await recordOf(w)
  const one = rec.findings.find(f => f.id === 'R1-1')!
  expect(one.status).toBe('rebutted')
  expect(one.history.at(-1)).toMatchObject({ status: 'rebutted', by: 'codex' })
  expect(isAcceptedRebuttal(one)).toBe(true)
  expect(rec.preStatus).toBe('passed')
  expect(isAcceptedRebuttal(invalidate([one], new Set(['src/app.ts']))[0]!)).toBe(false)
})

test('R40: a dispute a later Codex review rules on stays the person\'s', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'the name is the API\'s', replyId: '992' }]))
  await done($, accept('r2-verify', w, { 'G2-1': 'the name misleads callers' }))
  await $.command.run(cmd('resume'))
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'renaming breaks the public API', replyId: '993' }]))
  expect((await recordOf(w)).postStatus).toBe('awaiting-decision')
  // Someone pushes; no reviewer covers the new head, so Codex reviews it and holds G2-1 again.
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await $.command.run(cmd('resume'))
  await w.clock.advance(21 * 60_000)
  expect((await runOf(w)).phase).toBe('review')
  expect(w.spawned.at(-1)?.prompt).not.toContain('G2-1')
  await done($, turn(review('r3-review', 'PASS', [], { held: ['G2-1'] }), `agent-${w.spawned.length}`))
  const one = (await recordOf(w)).findings.find(f => f.id === 'G2-1')
  expect(one?.status).toBe('rebutted')
  expect(one?.history.at(-1)?.by).toBe('main')
})

test('R45: a deferral a later Codex review calls verified stays deferred, and the merge stays held', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', note: 'tracked in KAN-9', replyId: '992' }]))
  expect((await recordOf(w)).postStatus).toBe('awaiting-decision')
  // Someone pushes; no reviewer covers the new head, so Codex reviews it and calls G2-1 verified.
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await $.command.run(cmd('resume'))
  await w.clock.advance(21 * 60_000)
  expect((await runOf(w)).phase).toBe('review')
  expect(w.spawned.at(-1)?.prompt).not.toContain('G2-1')
  await done($, turn(review('r3-review', 'PASS', [], { verified: ['G2-1'] }), `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.status).toBe('deferred')
  expect(rec.phase).not.toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})

test('R46: a P2 rebuttal with an unreadable verdict gives the agent /pr-gate resume, not the person', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'Consider renaming this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', note: 'the name is the API\'s', replyId: '992' }]))
  await done($, turn(`v\n${TRAILER}\n{"step":"r2-verify","verdicts":"maybe"}`, `agent-${w.spawned.length}`))
  expect((await recordOf(w)).postStatus).toBe('blocked')
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('is held')
  expect(said).toContain('G2-1 [P2]')
  expect(said).toContain('rebutted')
  expect(said).toContain('/pr-gate resume')
  expect(said).not.toContain('person')
  expect(said).not.toContain('allow')
})

// ------------------------------------------------------------- task 13: commands, waivers, resume, restarts

const asPerson = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const say = ($: Parameters<TestBody>[0], args: string, as: object = asPerson) => $.command.run({ command: 'pr-gate', args, ...as } as never)

test('a pre-PR waiver does not waive the post-PR lifecycle', async ($, on) => {
  const w = world(on)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  expect((await say($, 'waive pre hotfix for the outage')).text).toContain('post-PR review still runs')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect((await recordOf(w)).phase).toBe('post')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1' }))).toBe(true)
  await say($, 'waive post reviewed by hand')
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1' }))).toBe(false)
  const waivers = (await recordOf(w)).waivers
  expect(waivers.map(one => [one.scope, one.reason, one.by])).toEqual([
    ['pre', 'hotfix for the outage', 'composer'],
    ['post', 'reviewed by hand', 'composer'],
  ])
})

test('only the person waives, allows or resets', async ($, on) => {
  world(on)
  for (const args of ['waive pre x', 'waive post x', 'allow 1 x', 'reset']) {
    expect((await say($, args, { ...asPerson, origin: { kind: 'sdk' } })).text).toContain('Only the person')
  }
  expect((await say($, 'waive hotfix')).text).toContain('waive pre|post|<findingId> <reason>')
})

test('exhaustion is distinct from passing, and the person can allow one more round', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  expect((await runOf(w)).status).toBe('exhausted')
  const before = w.spawned.length
  await say($, 'allow 1 the fix is small')
  expect(w.spawned.length).toBeGreaterThan(before)
  expect((await recordOf(w)).grants).toHaveLength(1)
})

test('fix commits and a session restart keep the budget and the history', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  await done($, turn(review('r2-review', 'PASS'), 'agent-2'))
  await $.tool.call(createPr)
  const before = await recordOf(w)
  // A new session: the session state is gone, the store is not.
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const after = await recordOf(w)
  expect(after.rounds).toEqual(before.rounds)
  expect(after.findings).toEqual(before.findings)
  expect((await runOf(w)).phase).toBe('collect')
})

test('a restart during triage neither re-triages nor replies twice', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }] })}`))
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  // The new session goes on collecting the PR's reviews.
  expect((await runOf(w)).lifecycle).toBe('post')
  await w.clock.advance(60_000)
  expect(w.prompts.filter(one => one.includes('New review feedback'))).toHaveLength(1)
})

test('a session start leaves a ready, held or awaiting record alone', async ($, on) => {
  const w = world(on)
  await toBlocked($, w, 'Consider renaming this')
  await say($, 'resume')
  await w.clock.advance(1000)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', note: 'tracked in KAN-9', replyId: '996' }]))
  expect((await recordOf(w)).postStatus).toBe('awaiting-decision')
  const prompts = w.prompts.length
  const spawned = w.spawned.length
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(60_000)
  expect(w.prompts).toHaveLength(prompts)
  expect(w.spawned).toHaveLength(spawned)
  expect((await recordOf(w)).postStatus).toBe('awaiting-decision')
})

/** Probe: a deferred finding after the PR opened leaves the record awaiting the person's decision. */
const toAwaiting = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>, body = 'Consider renaming this', extra: object = {}) => {
  await toTriage($, w, body)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', note: 'tracked in KAN-9', replyId: '992', ...extra }]))
  expect((await recordOf(w)).postStatus).toBe('awaiting-decision')
}

test('a resume that ends awaiting the person\'s decision delivers its report once the command returns', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const prompts = w.prompts.length
  await say($, 'resume')
  await w.clock.advance(1000)
  expect(w.prompts).toHaveLength(prompts + 1)
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('G2-1')
  expect(said).toContain('Their options:')
  expect(said.startsWith('/')).toBe(false)
})

test('waiving the last deferral makes the record ready, delivers the ready prompt, and lets the merge through', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  expect(isHeld(await $.tool.call(merge))).toBe(true)
  const said = await say($, 'waive G2-1 the rename lands with KAN-9')
  expect(said.text).toBe('/pr-gate waived G2-1 for feat/x: the rename lands with KAN-9.')
  const rec = await recordOf(w)
  expect(rec.phase).toBe('ready')
  expect(rec.postStatus).toBeUndefined()
  expect(rec.waivers.map(one => [one.scope, one.findingId, one.by])).toEqual([['finding', 'G2-1', 'composer']])
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('ready for the merge decision')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('a finding waiver for an id that does not exist, or one already settled, is refused', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
  expect((await say($, 'waive G9-9 because')).text).toContain('no finding G9-9')
  expect((await say($, 'waive G2-1 because')).text).toContain('G2-1 is already settled')
  expect((await recordOf(w)).waivers).toHaveLength(0)
})

test('allow adds rounds but settles no deferral: the record stays awaiting, and its report is delivered', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const spawned = w.spawned.length
  const said = await say($, 'allow 2 more review')
  expect(said.text).toContain('2 more rounds allowed')
  expect(said.text).toContain('/pr-gate waive G2-1 <reason>')
  const rec = await recordOf(w)
  expect(rec.grants).toHaveLength(1)
  expect(rec.postStatus).toBe('awaiting-decision')
  expect(rec.findings.find(one => one.id === 'G2-1')?.status).toBe('deferred')
  expect(w.spawned).toHaveLength(spawned)
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('Their options:')
})

test('a deferred security P1 is released only by a waiver naming it, not by waive post', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w, '**P1** SQL injection', { isSecurity: true })
  const post = await say($, 'waive post shipping today')
  expect(post.text).toContain('G2-1')
  expect(post.text).toContain('/pr-gate waive G2-1 <reason>')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
  await say($, 'waive G2-1 the query is internal only')
  expect((await recordOf(w)).phase).toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('before the PR, waiving a deferred blocker lets the gate pass', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await done($, turn(`Deferred.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'deferred', note: 'needs the auth service' }] })}`))
  expect((await recordOf(w)).preStatus).toBe('blocked')
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  expect((await say($, 'waive R1-1 tracked in KAN-7')).text).toBe('/pr-gate waived R1-1 for feat/x: tracked in KAN-7.')
  expect((await recordOf(w)).preStatus).toBe('passed')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
})

test('reset archives the record, and an archived record lets nothing through', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  expect((await recordOf(w)).preStatus).toBe('passed')
  expect((await say($, 'reset')).text).toContain('archived')
  expect((await recordOf(w)).phase).toBe('archived')
  // Nothing to resume after a reset: only a fresh start.
  expect((await say($, 'resume')).text).toContain('there is no lifecycle for feat/x yet')
  // The reset record's pass no longer lets the PR open: the create starts a fresh lifecycle instead.
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const fresh = await recordOf(w)
  expect(fresh.phase).toBe('pre')
  expect(fresh.preStatus).toBeUndefined()
  expect(fresh.rounds).toHaveLength(0)
})

test('status names the phase, the budget, the baseline and what is open', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  const said = (await say($, 'status')).text
  expect(said).toContain('feat/x → dev: post (awaiting-decision)')
  expect(said).toContain('baseline 1/2')
  expect(said).toContain('1 holding the merge')
  expect(said).toContain('The pane is open.')
})

test('the pre-PR held texts name the waiver the parser takes', { options: { allowanceStandard: 1, onExhausted: 'stop' } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect(w.prompts.at(-1)).toContain('/pr-gate waive pre <reason>')
  const held = (await $.tool.call(createPr)).deny ?? ''
  expect(held).toContain('/pr-gate waive pre <reason>')
  expect(held).not.toMatch(/waive <reason>/)
})

test('R49: a security P1 on a spent allowance offers its own waiver, not a pre waiver', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('/pr-gate waive R1-1 <reason>')
  expect(said).toContain('/pr-gate allow 1 <reason>')
  expect(said).not.toContain('waive pre')
  const step = said.split('\n').find(one => one.startsWith('Your next step:')) ?? ''
  expect(step).not.toContain('/pr-gate allow')
})

// ------------------------------------------------------------- task 13 fix round 1 (R47–R50)

test('R47: reset keeps the old record under its own key, and the fresh lifecycle answers no old feedback again', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  const before = await recordOf(w)
  const triages = w.prompts.filter(one => one.includes('New review feedback')).length
  await say($, 'reset')
  const archived = [...w.store.entries()].filter(([key]) => key.startsWith(`${KEY}:archived:`)).map(([, one]) => one as LifecycleRecord)
  expect(archived).toHaveLength(1)
  expect(archived[0]?.findings).toEqual(before.findings)
  expect(archived[0]?.rounds).toEqual(before.rounds)
  // A fresh start adopts the open PR; what was processed and replied to carries over.
  await say($, '')
  const fresh = await recordOf(w)
  expect(fresh.findings).toHaveLength(0)
  expect(fresh.processed).toEqual(before.processed)
  expect(fresh.replies).toEqual(before.replies)
  await w.clock.advance(60_000)
  expect(w.prompts.filter(one => one.includes('New review feedback'))).toHaveLength(triages)
})

test('R48: waiving the only hold of a held pre-PR gate sends the agent to open the PR', { options: { allowanceStandard: 1, onExhausted: 'stop' } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  const opens = () => w.prompts.filter(one => one.includes('Now open the pull request')).length
  expect(opens()).toBe(0)
  await say($, 'waive R1-1 checked by hand')
  await w.clock.advance(1000)
  expect(opens()).toBe(1)
  expect((await recordOf(w)).preStatus).toBe('passed')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
})

test('R48: a pre waiver sends the agent to open the PR', async ($, on) => {
  const w = world(on)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  await say($, 'waive pre hotfix')
  await w.clock.advance(1000)
  const said = w.prompts.filter(one => one.includes('Now open the pull request'))
  expect(said).toHaveLength(1)
  expect(said[0]).toContain('pr-gate was waived for feat/x')
})

test('R49: a deferred blocker before the PR names the person with its own waiver, and offers no allow', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await done($, turn(`Deferred.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'deferred', note: 'needs the auth service' }] })}`))
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('/pr-gate waive R1-1 <reason>')
  expect(said).not.toContain('allow')
  expect(said).not.toContain('fix or rebut the open findings')
  const step = said.split('\n').find(one => one.startsWith('Your next step:')) ?? ''
  expect(step).toContain('tell the person')
  expect(step).not.toContain('/pr-gate waive')
  const held = (await $.tool.call(createPr)).deny ?? ''
  expect(held).toContain('/pr-gate waive R1-1 <reason>')
  expect(held).not.toContain('allow')
})

test('R49: a plain blocked round before the PR gives the agent its step and does not name the person', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('Your next step: fix or rebut R1-1, then /pr-gate resume')
  expect(said).not.toContain('person')
  expect(said).not.toContain('allow')
  const held = (await $.tool.call(createPr)).deny ?? ''
  expect(held).toContain('fix or rebut R1-1')
  expect(held).not.toContain('person')
})

test('R50: a finding waiver lapses when the finding\'s file changes', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'waive G2-1 the rename lands with KAN-9')
  expect((await recordOf(w)).phase).toBe('ready')
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  w.git.changed = 'src/app.ts'
  await say($, 'resume')
  const rec = await recordOf(w)
  expect(mergeHolds(rec).map(one => one.id)).toContain('G2-1')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
  // Waived again by the person at the new head, it is released again.
  await say($, 'waive G2-1 still lands with KAN-9')
  expect(mergeHolds(await recordOf(w)).map(one => one.id)).not.toContain('G2-1')
})

test('a finding waived while its round runs is not asked about again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1, { ...P1, title: 'Second', line: 40 }])))
  await say($, 'waive R1-2 out of scope')
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect(w.prompts.some(one => one.includes('have no answer yet'))).toBe(false)
  expect((await runOf(w)).phase).not.toBe('fix')
})

test('a new session resumes a post-PR review that stopped on an error, and leaves a stopped one alone', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.isAuthed = false
  await w.clock.advance(30_000)
  expect((await recordOf(w)).postStatus).toBe('error')
  w.gh.isAuthed = true
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect((await runOf(w)).phase).toBe('collect')
  expect((await recordOf(w)).postStatus).toBeUndefined()
  await say($, 'stop')
  expect((await recordOf(w)).postStatus).toBe('stopped')
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(w.run).toBeUndefined()
})

// ------------------------------------------------------------- task 13 fix round 1 (R51)

test('R51: a main turn that ends before the triage turn starts is not the answer, and asks nothing again', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  const asked = w.prompts.length
  // A turn already running when the prompt was sent: its text is someone else's, and it ends first.
  await $.turn.start({ text: 'refactor the parser', turnId: 'turn-before' })
  await $.turn.complete({ ...triaged('r2-triage', []), turnId: 'turn-before' })
  expect((await runOf(w)).phase).toBe('triage')
  expect(w.prompts).toHaveLength(asked)
  // The step's own turn starts with its prompt, and its answer counts.
  await $.turn.start({ text: w.prompts.at(-1) ?? '', turnId: 'turn-triage' })
  await $.turn.complete({ ...triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', note: 'parameterised', replyId: '991' }]), turnId: 'turn-triage' })
  expect((await recordOf(w)).findings.find(one => one.id === 'G2-1')?.status).toBe('reported-fixed')
})

test('R51: a main turn that ends before the fix turn starts is not the fix', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1]), 'agent-1'))
  await $.turn.start({ text: 'something else', turnId: 'turn-before' })
  await $.turn.complete({ ...turn(fixed('R1-1')), turnId: 'turn-before' })
  const run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.findings.find(one => one.id === 'R1-1')?.status).toBe('open')
  expect(w.prompts.some(one => one.includes('have no answer yet'))).toBe(false)
})

// ------------------------------------------------------------- task 13 fix round 2 (R52–R54)

test('R52: a blocker waived during its fix step, then a new head, still gets the next round', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  const spawned = w.spawned.length
  await say($, 'waive R1-1 checked by hand')
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).not.toBe('passed')
  expect(w.spawned.length).toBeGreaterThan(spawned)
  expect((await runOf(w)).round).toBe(2)
})

const openPrOnce = { options: { allowanceStandard: 1, onExhausted: 'open-pr' } }

test('R53: a waived open blocker holds again before the PR when its file changes', openPrOnce, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
  await say($, 'waive R1-1 the input is a constant')
  expect((await recordOf(w)).preStatus).toBe('passed')
  w.git.head = 'e'.repeat(40)
  w.git.changed = 'src/app.ts'
  const held = await $.tool.call(createPr)
  expect(isHeld(held)).toBe(true)
  expect(held.deny ?? '').toContain('R1-1')
})

test('R53: a waived open finding holds the merge again when its file changes', async ($, on) => {
  const w = world(on)
  await toBlocked($, w)
  await say($, 'waive G2-1 the input is a constant')
  expect(mergeHolds(await recordOf(w)).map(one => one.id)).not.toContain('G2-1')
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  w.git.changed = 'src/app.ts'
  await say($, 'resume')
  expect(mergeHolds(await recordOf(w)).map(one => one.id)).toContain('G2-1')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})

test('R54: a pre waiver is refused while a security blocker holds; it names the finding waiver', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'SQL injection in search' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  const said = (await say($, 'waive pre ship it')).text ?? ''
  expect(said).toContain('/pr-gate waive R1-1 <reason>')
  expect((await recordOf(w)).waivers.some(one => one.scope === 'pre')).toBe(false)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

const stopOnce = { options: { allowanceStandard: 1, onExhausted: 'stop' } }

test('an exhausted pre-PR hold offers a waiver for each holding finding, with no resume line', stopOnce, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  const held = w.prompts.at(-1) ?? ''
  expect(held).toContain('/pr-gate waive R1-1 <reason>')
  expect(held).toContain('why R1-1 still holds the PR')
  expect(held).not.toContain('pr-gate resume')
})

test('the open-PR prompt after a finding waiver names the waiver', stopOnce, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  await say($, 'waive R1-1 checked by hand')
  await w.clock.advance(1000)
  const said = w.prompts.find(one => one.includes('Now open the pull request')) ?? ''
  expect(said).toContain('R1-1 waived by the person: checked by hand')
  expect(said).not.toContain('no high/critical finding left')
})

test('R51: a second turn with the step\'s text does not take over a step already armed', async ($, on) => {
  const w = world(on)
  await toTriage($, w)
  const asked = w.prompts.at(-1) ?? ''
  await $.turn.start({ text: asked, turnId: 'turn-triage' })
  await $.turn.start({ text: asked, turnId: 'turn-again' })
  await $.turn.complete({ ...triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', note: 'parameterised', replyId: '991' }]), turnId: 'turn-triage' })
  expect((await recordOf(w)).findings.find(one => one.id === 'G2-1')?.status).toBe('reported-fixed')
})

test('a main step whose turn never started times out saying so', { options: { stepTimeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await w.clock.advance(62_000)
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('turn was never seen')
})

// ------------------------------------------------------------- task 13 fix round 3 (R55)

test('R55: a lapsed waiver stays lapsed through a clean round, until the person waives again', { options: { allowanceStandard: 4 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
  await say($, 'waive R1-1 the redirect target is fixed')
  expect((await recordOf(w)).preStatus).toBe('passed')
  w.git.head = 'e'.repeat(40)
  w.git.changed = 'src/app.ts'
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  await done($, turn(review('r2-review', 'PASS')))
  // A clean review does not bring the waiver back: R1-1 still holds, and the fixer is asked about it.
  const run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('fix')
  expect(w.prompts.at(-1)).toContain('R1-1')
  const rec = await recordOf(w)
  expect(rec.waivers.find(one => one.findingId === 'R1-1')?.lapsedHead).toBe('e'.repeat(40))
  expect(unresolvedBlockers(rec).map(one => one.id)).toContain('R1-1')
  // Waived again at the new head, by the person: the round ends and the gate passes.
  await say($, 'waive R1-1 still a fixed target')
  await done($, turn('Nothing to change.'))
  expect((await recordOf(w)).preStatus).toBe('passed')
})

test('R55: after the PR, a lapsed waiver keeps the merge held through a clean post round', async ($, on) => {
  const w = world(on)
  await toBlocked($, w)
  await say($, 'waive G2-1 the input is a constant')
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  w.git.changed = 'src/app.ts'
  await say($, 'resume')
  w.gh.reviews = covers(w.gh.prHead)
  await w.clock.advance(30_000)
  await w.clock.advance(30_000)
  const rec = await recordOf(w)
  expect(rec.waivers.find(one => one.findingId === 'G2-1')?.lapsedHead).toBe('e'.repeat(40))
  expect(mergeHolds(rec).map(one => one.id)).toContain('G2-1')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})

/**
 * R56: a ready record; push B, on another file, is resumed into post round 3, and push C, touching `file`, arrives while
 * that round collects. Then the round's reviewer covers C and nothing new is said.
 */
const pushMidCollect = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>, file: string) => {
  w.git.head = 'b'.repeat(40)
  w.gh.prHead = 'b'.repeat(40)
  w.git.changed = 'src/other.ts'
  await say($, 'resume')
  const collecting = await runOf(w)
  expect([collecting.status, collecting.phase, collecting.round, collecting.roundStartHead]).toEqual(['running', 'collect', 3, 'b'.repeat(40)])
  w.git.head = 'c'.repeat(40)
  w.gh.prHead = 'c'.repeat(40)
  w.git.changed = file
  await w.clock.advance(30_000)
  expect((await runOf(w)).roundStartHead).toBe('c'.repeat(40))
  w.gh.reviews = covers(w.gh.prHead)
  for (let i = 0; i < 12 && (await runOf(w)).phase === 'collect'; i += 1) await w.clock.advance(30_000)
  expect((await runOf(w)).phase).not.toBe('collect')
}

/** G2-1 is rebutted, Codex accepts the rebuttal, and the record is ready. */
const toAccepted = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>) => {
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'rebutted', severity: 'P3', note: 'the name is the API\'s', replyId: '992' }]))
  await done($, accept('r2-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
}

test('R56: a push picked up mid-collection that touches an accepted rebuttal\'s file has Codex check it again', async ($, on) => {
  const w = world(on)
  await toAccepted($, w)
  const spawned = w.spawned.length
  await pushMidCollect($, w, 'src/app.ts')
  const rec = await recordOf(w)
  expect(rec.phase).not.toBe('ready')
  expect(rec.findings.find(f => f.id === 'G2-1')?.needsRecheck).toBe(true)
  expect(mergeHolds(rec).map(f => f.id)).toContain('G2-1')
  // The round's end goes to Codex's rebuttal check of G2-1, on C.
  expect(w.spawned.slice(spawned).some(one => one.prompt.includes('G2-1'))).toBe(true)
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})

test('R56: a push picked up mid-collection that touches a waived finding\'s file lapses the waiver', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'waive G2-1 the rename lands with KAN-9')
  expect((await recordOf(w)).phase).toBe('ready')
  await pushMidCollect($, w, 'src/app.ts')
  const rec = await recordOf(w)
  expect(rec.waivers.find(one => one.findingId === 'G2-1')?.lapsedHead).toBe('c'.repeat(40))
  expect(rec.phase).not.toBe('ready')
  expect(rec.postStatus).toBe('awaiting-decision')
  expect(mergeHolds(rec).map(f => f.id)).toContain('G2-1')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
  // A new waiver from the person settles it again.
  await say($, 'waive G2-1 still lands with KAN-9')
  expect(mergeHolds(await recordOf(w)).map(f => f.id)).not.toContain('G2-1')
})

test('R56: a push mid-collection on another file leaves an accepted rebuttal settled', async ($, on) => {
  const w = world(on)
  await toAccepted($, w)
  await pushMidCollect($, w, 'src/other.ts')
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.needsRecheck).toBeUndefined()
  expect(isAcceptedRebuttal(rec.findings.find(f => f.id === 'G2-1')!)).toBe(true)
  expect(rec.phase).toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R56: a push mid-collection on another file leaves a waiver standing', async ($, on) => {
  const w = world(on)
  await toAwaiting($, w)
  await say($, 'waive G2-1 the rename lands with KAN-9')
  await pushMidCollect($, w, 'src/other.ts')
  const rec = await recordOf(w)
  expect(rec.waivers.find(one => one.findingId === 'G2-1')?.lapsedAt).toBeUndefined()
  expect(rec.phase).toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R57: status during a new pre-PR run on a moved head does not say passed', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  expect((await recordOf(w)).preStatus).toBe('passed')
  w.git.head = 'b'.repeat(40)
  await say($, '')
  const run = await runOf(w)
  expect([run.status, run.lifecycle, run.round]).toEqual(['running', 'pre', 2])
  const rec = await recordOf(w)
  expect(rec.preStatus).toBeUndefined()
  expect(rec.preHead).toBeUndefined()
  const said = (await say($, 'status')) as { text: string }
  expect(said.text).toContain('feat/x → dev: pre,')
  expect(said.text).not.toContain('passed')
})

// ------------------------------------------------------------- task 13 fix round 5 (R58)

/** G2-1 is verified fixed after the PR opened (Codex confirmed it), and the record is ready. */
const toVerified = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>) => {
  await toAccepted($, w)
  const ready = await recordOf(w)
  const verified = { round: 2, status: 'verified-fixed' as const, by: 'codex', at: 2 }
  const findings = ready.findings.map(f => (f.id === 'G2-1' ? { ...f, status: 'verified-fixed' as const, history: [...f.history, verified] } : f))
  w.store.set(KEY, { ...ready, findings })
  expect(mergeHolds(await recordOf(w))).toEqual([])
}

/** A push touching `file`, resumed into post round 3, which the repo's reviewer covers with nothing new to say. */
const pushCovered = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>, file: string) => {
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  w.git.changed = file
  await say($, 'resume')
  w.gh.reviews = covers(w.gh.prHead)
  for (let i = 0; i < 12 && (await runOf(w)).phase === 'collect'; i += 1) await w.clock.advance(30_000)
  expect((await runOf(w)).phase).not.toBe('collect')
}

test('R58: a verified fix whose file a push touched holds the merge until Codex re-verifies it, then goes ready', async ($, on) => {
  const w = world(on)
  await toVerified($, w)
  const spawned = w.spawned.length
  const rounds = (await recordOf(w)).rounds.length
  await pushCovered($, w, 'src/app.ts')
  const rec = await recordOf(w)
  expect(rec.phase).not.toBe('ready')
  expect(rec.findings.find(f => f.id === 'G2-1')?.needsRecheck).toBe(true)
  expect(mergeHolds(rec).map(f => f.id)).toEqual(['G2-1'])
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny).toContain('G2-1 [P3] fixed, re-verify owed (file changed)')
  // Codex re-verifies G2-1 on the same head, as the rebuttal check does.
  const check = w.spawned.slice(spawned).at(-1)
  expect(check?.prompt).toContain('G2-1')
  expect(check?.prompt).toContain('"verdicts"')
  expect(check?.prompt).toContain('verified fixed, but their file changed since')
  expect(check?.prompt).not.toContain('rebutted these findings')
  await done($, accept('r3-verify', w))
  const after = await recordOf(w)
  const g = after.findings.find(f => f.id === 'G2-1')
  expect(g?.status).toBe('verified-fixed')
  expect(g?.needsRecheck).toBeUndefined()
  expect(g?.history.at(-1)?.by).toBe('codex')
  expect(after.phase).toBe('ready')
  // The check spent no round beyond the one the push itself owed.
  expect(after.rounds.filter(one => one.isCompleted).length).toBe(rounds + 1)
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R58: a re-verify Codex rejects reopens the finding and sends it back to the agent', async ($, on) => {
  const w = world(on)
  await toVerified($, w)
  await pushCovered($, w, 'src/app.ts')
  await done($, accept('r3-verify', w, { 'G2-1': 'the new branch skips the guard' }))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.status).toBe('open')
  expect(rec.phase).not.toBe('ready')
  expect(w.prompts.at(-1)).toContain('fix or rebut G2-1')
  expect(isHeld(await $.tool.call(merge))).toBe(true)
})

test('R58: a re-verify that cannot run holds the merge with the agent\'s /pr-gate resume', async ($, on) => {
  const w = world(on)
  await toVerified($, w)
  await pushCovered($, w, 'src/app.ts')
  await done($, turn(`v\n${TRAILER}\n{"step":"r3-verify","verdicts":"maybe"}`, `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.postStatus).toBe('blocked')
  const said = w.prompts.at(-1) ?? ''
  expect(said).toContain('is held')
  expect(said).toContain('fixed, re-verify owed (file changed)')
  expect(said).toContain('run /pr-gate resume to have Codex check G2-1 again')
  expect(said).not.toContain('person')
  const held = await $.tool.call(merge)
  expect(isHeld(held)).toBe(true)
  expect(held.deny).toContain('G2-1 [P3] fixed, re-verify owed (file changed)')
  // The agent's resume runs the check again, using no round.
  const spawned = w.spawned.length
  await say($, 'resume')
  await w.clock.advance(1000)
  expect(w.spawned).toHaveLength(spawned + 1)
  expect(w.spawned.at(-1)?.prompt).toContain('G2-1')
  await done($, accept('r3-verify', w))
  expect((await recordOf(w)).phase).toBe('ready')
})

test('R58: a push on another file leaves a verified fix settled', async ($, on) => {
  const w = world(on)
  await toVerified($, w)
  await pushCovered($, w, 'src/other.ts')
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'G2-1')?.needsRecheck).toBeUndefined()
  expect(rec.phase).toBe('ready')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
})

test('R58: before the PR, a flagged verified fix blocks the pass until a Codex review re-verifies it', { options: { allowanceStandard: 4 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  await done($, turn(review('r2-review', 'PASS', [], { verified: ['R1-1'] })))
  expect((await recordOf(w)).preStatus).toBe('passed')
  // A new commit touches the fixed file: the next review carries the re-verify note.
  w.git.head = 'f'.repeat(40)
  w.git.changed = 'src/app.ts'
  await say($, '')
  expect((await recordOf(w)).findings.find(f => f.id === 'R1-1')?.needsRecheck).toBe(true)
  expect(w.spawned.at(-1)?.prompt).toContain('re-verify')
  // A review that says nothing of it leaves it owed: the gate does not pass.
  await done($, turn(review('r3-review', 'PASS'), `agent-${w.spawned.length}`))
  let rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'R1-1')?.needsRecheck).toBe(true)
  expect(rec.preStatus).not.toBe('passed')
  // The next review's verified ruling clears it, and the gate passes.
  await done($, turn(review('r4-review', 'PASS', [], { verified: ['R1-1'] }), `agent-${w.spawned.length}`))
  rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'R1-1')?.needsRecheck).toBeUndefined()
  expect(rec.preStatus).toBe('passed')
})

// ------------------------------------------------------------- R59

/** A high-tier branch: round 1 fails with R1-1, the fix lands at d, and the fix reviewer is running on d. */
const toFixReview = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>) => {
  w.git.numstat = '10\t2\tsrc/auth/login.ts'
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1]), 'agent-1'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-2'))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect((await runOf(w)).phase).toBe('verify')
}

test('R59: a fix-review verify exempts only the head it read: a commit that landed while it ran leaves the fix owed', { options: { allowanceStandard: 4 } }, async ($, on) => {
  const w = world(on)
  await toFixReview($, w)
  // The reviewer read d; commit g, on the same file, landed before the round ended.
  w.git.head = 'g'.repeat(40)
  w.git.changed = 'src/app.ts'
  await done($, turn(`The fix holds.\n${TRAILER}\n{"step":"r1-verify","ok":true}`))
  expect((await recordOf(w)).findings.find(f => f.id === 'R1-1')?.needsRecheck).toBe(true)
  // Round 2's reviewers say nothing of R1-1: the gate does not pass.
  await done($, turn(review('r2-review', 'PASS'), `agent-${w.spawned.length - 1}`))
  await done($, turn(review('r2-challenge', 'PASS'), `agent-${w.spawned.length}`))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'R1-1')?.needsRecheck).toBe(true)
  expect(rec.preStatus).not.toBe('passed')
})

test('R59: with no commit after the fix, the fix-review verify stands and R1-1 is not flagged', { options: { allowanceStandard: 4 } }, async ($, on) => {
  const w = world(on)
  await toFixReview($, w)
  w.git.changed = 'src/app.ts'
  await done($, turn(`The fix holds.\n${TRAILER}\n{"step":"r1-verify","ok":true}`))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'R1-1')?.status).toBe('verified-fixed')
  expect(rec.findings.find(f => f.id === 'R1-1')?.needsRecheck).toBeUndefined()
})

// ------------------------------------------------------------- task 14 (the pane)

const mountPane = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({
    plugin: 'pr-lifecycle',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr-lifecycle',
    props: {
      title: 'PR lifecycle',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { top: 0, bodyRows: 40, rows: 40 } as never,
      view: {} as never,
    },
  })

const paneFinding = (id: string, change: Partial<Finding>): Finding => ({
  id,
  round: 1,
  source: 'github',
  reviewer: 'claude[bot]',
  severity: 'P2',
  title: `Title of ${id}`,
  headSeen: 'a'.repeat(40),
  status: 'open',
  history: [],
  ...change,
})

const codexSaid = (status: 'rebutted' | 'open'): FindingEvent => ({ round: 2, status, note: 'checked', by: 'codex', at: 1 })
const agentRebutted: FindingEvent = { round: 2, status: 'rebutted', note: 'not reachable', by: 'agent', at: 1 }

test('the pane shows the phase, the shared budget, who is awaited, and reported vs verified fixes', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["claude[bot]","copilot"],"checks":[]}'
  await toPost($, w)
  await w.clock.advance(30_000)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'post-PR · 1/4 rounds used · baseline 0/2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'waiting on claude[bot], copilot' })).toBeDefined()
  await ui.unmount()
})

test('the pane counts a deferred P3 as holding the merge and says what the person is awaited for', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'follow-up KAN-9', replyId: '992' }]))
  const rec = await recordOf(w)
  expect(rec.postStatus).toBe('awaiting-decision')
  expect(mergeHolds(rec)).toHaveLength(1)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Findings (1, 1 holding the merge' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'awaiting your decision on G2-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'G2-1 [P3]' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '— deferred' })).toBeDefined()
  await ui.unmount()
})

test('the pane names each finding state, and its hold count is what mergeHolds returns', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const key = 'lifecycle:/repo:feat/x'
  const rec = await recordOf(w)
  const head = rec.head
  const next: LifecycleRecord = {
    ...rec,
    findings: [
      paneFinding('A1', { status: 'verified-fixed', needsRecheck: true, severity: 'P1' }),
      paneFinding('A2', { status: 'verified-fixed' }),
      paneFinding('A3', { status: 'reported-fixed', severity: 'P1' }),
      paneFinding('A4', { status: 'rebutted', history: [agentRebutted, codexSaid('rebutted')] }),
      paneFinding('A5', { status: 'rebutted', needsRecheck: true, history: [agentRebutted, codexSaid('rebutted')] }),
      paneFinding('A6', { status: 'rebutted', history: [agentRebutted] }),
      paneFinding('A7', { status: 'rebutted', history: [agentRebutted, codexSaid('open'), agentRebutted] }),
      paneFinding('A8', { status: 'deferred' }),
      paneFinding('A9', { status: 'deferred' }),
      paneFinding('B1', { status: 'deferred', severity: 'P3' }),
    ],
    waivers: [
      { scope: 'finding', findingId: 'A8', head, reason: 'tracked in KAN-9', by: 'composer', at: 1 },
      { scope: 'finding', findingId: 'A9', head, reason: 'old reason', by: 'composer', at: 1, lapsedAt: 2, lapsedHead: head },
    ],
  }
  w.store.set(key, next)
  const holds = mergeHolds(next).map(one => one.id)
  // A2 and A4 settled, A8 waived; the rest hold.
  expect(holds).toEqual(['A1', 'A3', 'A5', 'A6', 'A7', 'A9', 'B1'])
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Findings (10, 7 holding the merge' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A1 [P1] Title of A1 — re-verify owed (file changed)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A2 [P2] Title of A2 — verified fixed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A3 [P1] Title of A3 — reported fixed, unverified' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A4 [P2] Title of A4 — rebuttal accepted' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A5 [P2] Title of A5 — re-verify owed (file changed)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A6 [P2] Title of A6 — rebuttal awaiting Codex' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A7 [P2] Title of A7 — disputed: awaiting the person' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A8 [P2] Title of A8 — waived: tracked in KAN-9' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A9 [P2] Title of A9 — deferred (waiver lapsed)' })).toBeDefined()
  await ui.unmount()
})

test('the pane shows the record\'s message, truncated', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const key = 'lifecycle:/repo:feat/x'
  w.store.set(key, { ...(await recordOf(w)), message: `Stopped for a reason. ${'long '.repeat(80)}` })
  const midRound = await mountPane($)
  expect(await midRound.find({ type: 'Text', text: /Stopped for a reason/ })).toBeUndefined()
  await midRound.unmount()
  await $.command.run(cmd('stop'))
  const ui = await mountPane($)
  const shown = (await ui.find({ type: 'Text', text: /Stopped for a reason\./ }))?.text ?? ''
  expect(shown).toContain('…')
  expect(shown.length).toBeLessThan(250)
  await ui.unmount()
})

test('rendering the pane starts no run and writes no state', async ($, on) => {
  const w = world(on)
  await toTriage($, w, 'nit: rename this')
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'deferred', severity: 'P3', note: 'follow-up KAN-9', replyId: '992' }]))
  const snapshot = (): string => JSON.stringify({ store: [...w.store.entries()], run: w.run, spawned: w.spawned.length, prompts: w.prompts, opened: w.opened })
  const before = snapshot()
  const ui = await mountPane($)
  await ui.find({ type: 'Text', text: 'Findings' })
  await w.clock.advance(5_000)
  await ui.unmount()
  expect(snapshot()).toBe(before)
})

test('the pane does not say it awaits a decision when every hold is waived', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  await $.command.run(cmd('stop'))
  const rec = await recordOf(w)
  const waiver = { scope: 'finding', findingId: 'A8', head: rec.head, reason: 'tracked', by: 'composer', at: 1 } as const
  w.store.set('lifecycle:/repo:feat/x', { ...rec, postStatus: 'awaiting-decision', findings: [paneFinding('A8', { status: 'deferred' })], waivers: [waiver] })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /awaiting your decision/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'A8 [P2] Title of A8 — waived: tracked' })).toBeDefined()
  await ui.unmount()
})

test('only a verified fix not owed a re-verify is struck through', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const rec = await recordOf(w)
  const findings = [
    paneFinding('S1', { status: 'verified-fixed' }),
    paneFinding('S2', { status: 'verified-fixed', needsRecheck: true }),
    paneFinding('S3', { status: 'reported-fixed' }),
  ]
  w.store.set('lifecycle:/repo:feat/x', { ...rec, findings })
  const ui = await mountPane($)
  const struck = async (id: string): Promise<unknown> => (await ui.find({ type: 'Text', text: new RegExp(`${id} \\[`) }))?.props?.strikethrough
  expect(await struck('S1')).toBe(true)
  expect(await struck('S2')).toBeFalsy()
  expect(await struck('S3')).toBeFalsy()
  await ui.unmount()
})

test('the heading counts every row owed a verification, whatever its severity', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const rec = await recordOf(w)
  const findings = [
    paneFinding('V1', { status: 'verified-fixed', needsRecheck: true, severity: 'P3' }),
    paneFinding('V2', { status: 'reported-fixed', severity: 'P3' }),
    paneFinding('V3', { status: 'verified-fixed' }),
  ]
  w.store.set('lifecycle:/repo:feat/x', { ...rec, findings })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /2 owed verification/ })).toBeDefined()
  await ui.unmount()
})

test('with no run, a pre-PR record shows its verdict, not PRE', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  const rec = await recordOf(w)
  expect(rec.phase).toBe('pre')
  w.store.set('lifecycle:/repo:feat/x', { ...rec, preStatus: 'exhausted' })
  w.clearState()
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'EXHAUSTED' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PRE' })).toBeUndefined()
  await ui.unmount()
})

test('an exhausted pre-PR allowance still permits the protected post-PR baseline', { options: { allowanceStandard: 1 } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [{ ...P1, title: 'Off by one in pagination' }])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('R1-1')))
  expect((await recordOf(w)).preStatus).toBe('exhausted')
  expect(isHeld(await $.tool.call(createPr))).toBe(false) // onExhausted: open-pr, not security
  expect((await runOf(w)).phase).toBe('collect')
  expect((await runOf(w)).roundKind).toBe('baseline')
})

test('two repositories with different roster files each wait for their own reviewers', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewers":["junie[bot]"],"checks":[]}'
  await toPost($, w)
  await w.clock.advance(30_000)
  expect((await runOf(w)).activity).toContain('junie[bot]')
  w.git.roster = '{"reviewers":["rovodev[bot]"],"checks":[]}'
  await w.clock.advance(30_000)
  expect((await runOf(w)).activity).toContain('rovodev[bot]')
})

test('existing pass-through cases still skip pre-PR Codex and still get post-PR round 1', async ($, on) => {
  const w = world(on)
  w.git.numstat = '3\t1\tdocs/guide.md'
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.spawned).toHaveLength(0)
  expect((await recordOf(w)).phase).toBe('post')
})

// ------------------------------------------------------------- codex-gate round 1 on this branch (R1-1, R1-2)

test('a fix review with no readable verdict leaves the fix unverified, and the gate does not pass on it', { options: { allowanceStandard: 4 } }, async ($, on) => {
  const w = world(on)
  await toFixReview($, w)
  await done($, turn('I looked at it, seems fine.'))
  const rec = await recordOf(w)
  expect(rec.findings.find(f => f.id === 'R1-1')?.status).not.toBe('verified-fixed')
  expect(rec.findings.find(f => f.id === 'R1-1')?.history.some(one => one.by === 'fix-reviewer')).toBe(false)
  expect(rec.preStatus).not.toBe('passed')
})

test('a pass against one base does not open a PR against another', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  expect((await recordOf(w)).preStatus).toBe('passed')
  const toMain = { tool: 'Bash' as const, command: createPr.command.replace('--base dev', '--base main') }
  const res = await $.tool.call(toMain)
  expect(isHeld(res)).toBe(true)
  const rec = await recordOf(w)
  expect(rec.base).toBe('main')
  expect(rec.preStatus).toBeUndefined()
})

test('a resume keeps the base the lifecycle was started for', async ($, on) => {
  const w = world(on)
  const toMain = { tool: 'Bash' as const, command: createPr.command.replace('--base dev', '--base main') }
  await $.tool.call(toMain)
  expect((await recordOf(w)).base).toBe('main')
  await $.command.run({ command: 'pr-gate', args: 'stop', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  await $.command.run({ command: 'pr-gate', args: 'resume', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect((await recordOf(w)).base).toBe('main')
})

// ------------------------------------------------------------- final fix wave (R60-R65)

test('R60: the post-PR Codex fallback reviews from the last head a review covered, not one pushed during triage', async ($, on) => {
  const w = world(on)
  // A reviewer comments on a...a; the agent pushes e...e while it answers.
  await toTriage($, w)
  w.git.head = 'e'.repeat(40)
  w.gh.prHead = 'e'.repeat(40)
  await done($, triaged('r2-triage', [{ id: 'G2-1', action: 'fixed', severity: 'P1', replyId: '991' }]))
  expect((await runOf(w)).roundKind).toBe('baseline')
  // Nobody reviews e...e by the wait cap: Codex falls back, on the range nobody read.
  await w.clock.advance(21 * 60_000)
  const run = await runOf(w)
  expect(run.phase).toBe('review')
  expect(run.diffBase).toBe('a'.repeat(40))
  expect(w.spawned.at(-1)?.prompt).toContain(`The base is ${'a'.repeat(40)}`)
})

test('R61: a merge naming a PR or a repository outside a checkout is held, and the agent is told where to run it', async ($, on) => {
  const w = world(on)
  w.gh.hasPr = true
  const held = (await $.tool.call({ tool: 'Bash', command: 'cd /tmp && gh pr merge 5 -R me/repo' })).deny ?? ''
  expect(held).toContain("run it from the repository's checkout so the gate can check it")
  expect(held.startsWith('/')).toBe(false)
  expect(w.opened.some(one => one.includes('pr merge'))).toBe(false)
})

test('R61: a create naming a repository outside a checkout is held', async ($, on) => {
  const w = world(on)
  const held = (await $.tool.call({ tool: 'Bash', command: `cd /tmp && ${createPr.command} -R me/repo` })).deny ?? ''
  expect(held).toContain("run it from the repository's checkout so the gate can check it")
  expect(w.opened).toHaveLength(0)
})

test('R61: a GitHub MCP create outside a checkout is held', async ($, on) => {
  const w = world(on)
  w.git.isOutside = true
  const held = (await $.tool.call({ tool: 'mcp__plugin_github_github__create_pull_request', base: 'dev', head: 'feat/x', title: 'x' } as never)).deny ?? ''
  expect(held).toContain("run it from the repository's checkout so the gate can check it")
})

test('R62: waive post during collection ends the run, and the merge goes through', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  expect((await runOf(w)).phase).toBe('collect')
  await $.command.run(cmd('waive post hotfix'))
  expect((await runOf(w)).status).not.toBe('running')
  expect(isHeld(await $.tool.call(merge))).toBe(false)
  const spawned = w.spawned.length
  await w.clock.advance(30 * 60_000)
  expect(w.spawned).toHaveLength(spawned)
  expect((await runOf(w)).status).not.toBe('running')
})

test('R62: a poll that reads the PR merged archives the record and ends the run', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  const before = await recordOf(w)
  w.gh.state = 'MERGED'
  await w.clock.advance(30_000)
  const run = await runOf(w)
  expect(run.status).not.toBe('running')
  expect(run.message).toContain('merged')
  expect((await recordOf(w)).phase).toBe('archived')
  const archived = [...w.store.keys()].filter(key => key.startsWith(`${KEY}:archived:`))
  expect(archived).toHaveLength(1)
  expect((w.stored(archived[0] ?? '') as LifecycleRecord).pr).toBe(before.pr)
  expect((await recordOf(w)).postStatus).toBeUndefined()
})

test('R62: a session start does not collect again for a closed PR: it archives the record', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.state = 'CLOSED'
  w.clearState()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(w.run?.status === 'running').toBe(false)
  expect((await recordOf(w)).phase).toBe('archived')
})

test('R62: a bare /pr-gate does not collect again for a merged PR: it archives the record', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  await $.command.run(cmd('stop'))
  w.gh.state = 'MERGED'
  const said = await $.command.run(cmd(''))
  expect(JSON.stringify(said)).toContain('merged')
  expect((await runOf(w)).status).not.toBe('running')
  expect((await recordOf(w)).phase).toBe('archived')
})

test('R63: resuming a pre-PR block on the same head re-opens the fix step; a rebuttal then goes to Codex in the next round', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  await done($, turn('Tried.'))
  await done($, turn('Tried.'))
  expect((await recordOf(w)).preStatus).toBe('blocked')
  const rounds = (await recordOf(w)).rounds.length
  const spawned = w.spawned.length
  await $.command.run(cmd('resume'))
  // The resume itself starts no round and spends nothing: it re-opens the fix step for R1-1.
  expect((await recordOf(w)).rounds).toHaveLength(rounds)
  expect(w.spawned).toHaveLength(spawned)
  const run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('fix')
  await w.clock.advance(1000)
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] Unvalidated redirect')
  expect(w.prompts.at(-1)?.startsWith('/')).toBe(false)
  await done($, turn(`ok\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'rebutted', note: 'validated at :8' }] })}`))
  // The record moves on: R1-1 is rebutted, and Codex rules on it in round 2.
  const rec = await recordOf(w)
  expect(rec.findings.find(one => one.id === 'R1-1')?.status).toBe('rebutted')
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect((await runOf(w)).phase).toBe('review')
  expect(w.spawned).toHaveLength(spawned + 1)
  expect(w.spawned.at(-1)?.prompt).toContain('R1-1')
  expect((await runOf(w)).round).toBe(2)
})

test('R64: the person\'s own top-level comment reaches triage; the mod\'s recorded reply and inline replies do not', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.store.set(KEY, { ...(await recordOf(w)), replies: { 'inline:9': '41' } })
  w.gh.issueComments = [
    { id: 40, user: { login: 'me' }, body: 'Also handle the empty list.', created_at: '1970-01-01T00:01:00Z' },
    { id: 41, user: { login: 'me' }, body: 'Fixed in abc1234.', created_at: '1970-01-01T00:01:00Z' },
  ]
  w.gh.comments = [{ ...inline(42, 'Done, thanks.', w.gh.prHead), user: { login: 'me' }, in_reply_to_id: 9 }]
  await w.clock.advance(20 * 60_000)
  const run = await runOf(w)
  expect(run.phase).toBe('triage')
  expect(run.triaged).toEqual(['comment:40'])
  expect(w.prompts.at(-1)).toContain('Also handle the empty list.')
})

test('R64: the person\'s own approval does not cover a head', async ($, on) => {
  const w = world(on)
  await toPost($, w)
  w.gh.prHead = 'b'.repeat(40)
  w.git.head = 'b'.repeat(40)
  w.gh.reviews = [{ id: 7, user: { login: 'me' }, body: '', state: 'APPROVED', commit_id: w.gh.prHead, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(20 * 60_000)
  expect((await runOf(w)).phase).toBe('review')
  expect((await runOf(w)).evidence.some(one => one.reviewer === 'me')).toBe(false)
})
