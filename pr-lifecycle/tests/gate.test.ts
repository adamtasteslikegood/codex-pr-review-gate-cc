import { expect, test } from 'claude-code/testing'

import { createPr, done, isHeld, P1, P2, review, runOf, TRAILER, turn, world } from './world'
import type { World } from './world'
import type { LifecycleRecord } from '../types'

const recordOf = (w: World): LifecycleRecord => w.stored('lifecycle:/repo:feat/x') as LifecycleRecord

// Machine load: 1 engine step, no real wait (spec §7.3).
test('a PR to a gated base is held and starts the gate; a clean review opens it', { timeoutMs: 15_000 }, async ($, on) => {
  const w = world(on)
  const held = await $.tool.call(createPr)
  expect(held.deny ?? held.text).toContain('/pr-gate')
  expect(w.opened).toHaveLength(0)
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.prompt).toContain('skill "codex" and args "review --model')
  // A standard change starts at medium effort, on codexModel.
  expect(w.spawned[0]?.prompt).toContain(`args "review --model 'gpt-6-luna' --effort medium"`)
  expect(w.spawned[0]?.prompt).toContain('GSTACK_CODEX_EFFORT=medium')

  await done($, turn(review('r1-review', 'PASS')))
  const run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
  expect(w.prompts.at(-1)).toContain('collects the repository\'s reviews itself')

  const opened = await $.tool.call(createPr)
  expect(isHeld(opened)).toBe(false)
  expect(w.opened).toHaveLength(1)

  // A new commit after the pass is ungated again.
  w.git.head = 'c'.repeat(40)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('a blocking finding goes to the main agent, then Codex reviews again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1, P2])))

  let run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.findings.map(one => one.id)).toEqual(['R1-1', 'R1-2'])
  expect(w.prompts[0]).toContain('R1-1 [P1] Unvalidated redirect')

  w.git.head = 'd'.repeat(40)
  await done($,
    turn(
      `Fixed.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed', note: 'allow-list' }, { id: 'R1-2', action: 'rebutted', note: 'the name is the API' }] })}`,
    ),
  )
  run = await runOf(w)
  expect(run.round).toBe(2)
  expect(run.phase).toBe('review')
  expect(run.findings[0]?.status).toBe('reported-fixed')
  expect(w.spawned).toHaveLength(2)

  await done($, turn(review('r2-review', 'PASS')))
  run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(run.headSha).toBe('d'.repeat(40))
})

test('the shared allowance (4) without agreement ends the pre-PR gate as exhausted', { timeoutMs: 15_000 }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  for (let round = 1; round <= 4; round++) {
    await done($, turn(review(`r${round}-review`, 'FAIL', [P1])))
    w.git.head = String(round).repeat(40)
    // No answer, then none to the one re-prompt: the finding stays open and the round ends.
    await done($, turn('Tried.'))
    await done($, turn('Tried.'))
  }
  const run = await runOf(w)
  expect(run.status).toBe('exhausted')
  expect(run.round).toBe(4)
  expect(recordOf(w).preStatus).toBe('exhausted')
  expect(w.spawned).toHaveLength(4)
  expect(w.prompts.at(-1)).toContain('did not converge')
  expect(w.prompts.at(-1)).toContain('stays with this pull request')
  // The findings reach the main agent for the conversation; the pull request gets counts only.
  expect(w.prompts.at(-1)).toContain('do not paste a finding into it')
})

const fixed = (step: string, dispositions: object[]) => `Done.\n${TRAILER}\n${JSON.stringify({ step, dispositions })}`

test('advisory findings go to the main agent once nothing blocks, then Codex looks again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS', [P2])))
  let run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('fix')
  expect(run.fixKind).toBe('advisory')
  expect(w.prompts[0]).toContain('round 1, advisories')
  expect(w.prompts[0]).toContain('R1-1 [P2] Rename this')

  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('r1-fix', [{ id: 'R1-1', action: 'fixed', note: 'renamed' }])))
  run = await runOf(w)
  expect(run.round).toBe(2)
  expect(run.phase).toBe('review')

  await done($, turn(review('r2-review', 'PASS')))
  run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(recordOf(w).rounds.filter(one => one.isCompleted)).toHaveLength(2)
  expect(recordOf(w).rounds.at(-1)?.isAdvisory).toBe(true)
  expect(w.prompts.at(-1)).toContain('R1-1 [P2] Rename this')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
})

test('advisory re-reviews stop when the reserve rule would leave no round; the last advisories are still fixed before the PR opens', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  for (let round = 1; round <= 3; round++) {
    await done($, turn(review(`r${round}-review`, 'PASS', [P2])))
    // Every round's advisories go to the fixer, the last one's included.
    expect((await runOf(w)).phase).toBe('fix')
    w.git.head = String(round).repeat(40)
    await done($, turn(fixed(`r${round}-fix`, [{ id: `R${round}-1`, action: 'fixed' }])))
  }
  // Three rounds used, one left: an advisory round would leave none in reserve, so Codex does not look again.
  const run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(w.spawned).toHaveLength(3)
  expect(run.message).toContain('No high/critical finding after 3 rounds')
  expect(w.prompts.at(-1)).toContain('R3-1 [P2] Rename this')
})

test('an advisory rebuttal with no new commit opens the PR without another round', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS', [P2])))
  await done($, turn(fixed('r1-fix', [{ id: 'R1-1', action: 'rebutted', note: 'the name is the API' }])))
  const run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(recordOf(w).rounds.filter(one => one.isCompleted)).toHaveLength(1)
  expect(w.spawned).toHaveLength(1)
  expect(w.prompts.at(-1)).toContain('rebutted: the name is the API')
})

test('an advisory fix that adds a blocking finding goes back to the blocking rounds', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS', [P2])))
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('r1-fix', [{ id: 'R1-1', action: 'fixed' }])))
  await done($, turn(review('r2-review', 'FAIL', [P1])))
  const run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.fixKind).toBe('blocking')
  expect(w.prompts.at(-1)).toContain('R2-1 [P1] Unvalidated redirect')
})

test('a Codex timeout reruns the round one effort lower, and fails closed below low', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(`Codex stalled.\n${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"timeout"}`, 'agent-1'))
  let run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.round).toBe(1)
  expect(run.effort).toBe('low')
  expect(w.spawned).toHaveLength(2)
  expect(w.spawned[1]?.prompt).toContain(`args "review --model 'gpt-6-luna' --effort low"`)

  await done($, turn(`Timed out again.\n${TRAILER}\n{"step":"r1-review","gate":"ERROR"}`, 'agent-2'))
  run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('lowest')
})

test('the next run on a branch that timed out at low effort stays at low', { options: { highEffort: 'high' } }, async ($, on) => {
  const w = world(on)
  w.git.numstat = '30\t4\tserver/security.ts'
  await $.tool.call(createPr)
  expect(w.spawned[0]?.prompt).toContain('--effort high"')
  const timeout = (step: string, id: string) => turn(`${TRAILER}\n{"step":"${step}","gate":"ERROR","error":"timeout"}`, id)
  await done($, timeout('r1-review', 'agent-1'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-2'))
  expect((await runOf(w)).effort).toBe('medium')
  await done($, timeout('r1-review', 'agent-3'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-4'))
  await done($, timeout('r1-review', 'agent-5'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-6'))
  expect((await runOf(w)).status).toBe('error')

  await $.command.run({
    command: 'pr-gate',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(w.spawned.at(-2)?.prompt).toContain(`args "review --model 'gpt-6-astra' --effort low"`)
  expect(w.spawned.at(-1)?.prompt).toContain(`args "challenge --model 'gpt-6-astra' --effort low"`)
})

// Rereviews at the tier's own effort, so the carried effort alone decides (R69's rereviewEffort is tested in models.test.ts).
const asBefore = { options: { highEffort: 'high', rereviewEffort: 'high' } }

test('a branch keeps the effort a review last completed at after a timeout', asBefore, async ($, on) => {
  const w = world(on)
  w.git.numstat = '30\t4\tserver/security.ts'
  const rerun = () =>
    $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await $.tool.call(createPr)
  await done($, turn(`${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"timeout"}`, 'agent-1'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-2'))
  await done($, turn(review('r1-review', 'PASS'), 'agent-3'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-4'))
  expect((await runOf(w)).status).toBe('passed')

  // Passed at medium after a timeout at high: the next round, on a new commit, starts at medium.
  w.git.head = 'e'.repeat(40)
  await rerun()
  expect(w.spawned).toHaveLength(6)
  expect(w.spawned.at(-1)?.prompt).toContain('--effort medium')
  await done($, turn(review('r2-review', 'PASS'), `agent-${w.spawned.length - 1}`))
  await done($, turn(review('r2-challenge', 'PASS'), `agent-${w.spawned.length}`))
  expect((await runOf(w)).status).toBe('passed')
  // And keeps it on the round after that.
  w.git.head = 'f'.repeat(40)
  await rerun()
  expect(w.spawned).toHaveLength(8)
  expect(w.spawned.at(-1)?.prompt).toContain('--effort medium')
})

test('a branch that passed at its default effort starts at high once it grows into high blast radius', asBefore, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  expect(w.spawned.at(-1)?.prompt).toContain('--effort medium')
  await done($, turn(review('r1-review', 'PASS')))
  expect((await runOf(w)).status).toBe('passed')
  // The branch grows: a new commit touches a high blast-radius path.
  w.git.head = 'e'.repeat(40)
  w.git.numstat = '30\t4\tserver/security.ts'
  await $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.spawned.at(-1)?.prompt).toContain('--effort high')
})

test('a review that did not complete fails closed', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(`Codex could not authenticate.\n${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"other"}`))
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(w.prompts).toHaveLength(0)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('a high blast-radius change runs review and challenge in parallel and reviews the fix', async ($, on) => {
  const w = world(on)
  w.git.numstat = '30\t4\tserver/security.ts'
  await $.tool.call(createPr)
  expect(w.spawned.map(one => one.description)).toEqual(['pr-lifecycle r1 review', 'pr-lifecycle r1 challenge'])
  expect(w.spawned.every(one => !/args "\w+ --(xhigh|effort xhigh)/.test(one.prompt))).toBe(true)
  // Both start at highEffort (medium by default), not always at high (R69).
  expect(w.spawned.map(one => one.prompt.match(/--effort \w+/)?.[0])).toEqual(['--effort medium', '--effort medium'])

  await done($, turn(review('r1-review', 'PASS')))
  expect((await runOf(w)).phase).toBe('review')
  await done($, turn(review('r1-challenge', 'FAIL', [P1])))
  expect((await runOf(w)).phase).toBe('fix')

  w.git.head = 'e'.repeat(40)
  await done($, turn(`Fixed.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed' }] })}`))
  const run = await runOf(w)
  expect(run.phase).toBe('verify')
  expect(w.spawned.at(-1)?.description).toBe('pr-lifecycle r1 verify')
})

test('a docs-only change passes without Codex, and other bases are not gated', async ($, on) => {
  const w = world(on)
  w.git.numstat = '3\t1\tdocs/README.md'
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base release/1.x' })
  expect(w.opened).toHaveLength(1)
  expect(w.spawned).toHaveLength(0)

  // Docs only: the gate passes at once and the held call goes straight through, unprompted.
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.spawned).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
  expect(recordOf(w).preStatus).toBe('passed')
  // The PR opened, so the lifecycle went on into post-PR review.
  expect((await runOf(w)).lifecycle).toBe('post')
})

test('with allowanceLight 1, a chore/ branch gets one Codex round at low effort; its fix is reviewed after the PR opens', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/tidy-KAN-9'
  w.git.roster = '{"allowanceLight":1}'
  await $.tool.call(createPr)
  expect(w.spawned[0]?.prompt).toContain(`args "review --model 'gpt-6-luna' --effort low"`)
  await done($, turn(review('r1-review', 'FAIL', [P1, P2])))
  // A blocker is always fixed inside its round.
  expect((await runOf(w)).phase).toBe('fix')
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] Unvalidated redirect')
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('r1-fix', [{ id: 'R1-1', action: 'fixed' }, { id: 'R1-2', action: 'fixed' }])))
  expect((w.stored('lifecycle:/repo:chore/tidy-KAN-9') as LifecycleRecord).preStatus).toBe('exhausted')
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
  const run = await runOf(w)
  expect(run.lane).toBe('light')
  expect(run.status).toBe('exhausted')
  expect(w.spawned).toHaveLength(1)
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] Unvalidated redirect')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
})

test('with allowanceLight 1, a chore/ branch with only advisories opens the PR without an advisory round', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/tidy-KAN-9'
  w.git.roster = '{"allowanceLight":1}'
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS', [P2])))
  // The advisory is fixed inside the round; the light lane has no round left for Codex to look again.
  expect((await runOf(w)).phase).toBe('fix')
  w.git.head = 'd'.repeat(40)
  await done($, turn(fixed('r1-fix', [{ id: 'R1-1', action: 'fixed' }])))
  expect((await runOf(w)).status).toBe('passed')
  expect(w.spawned).toHaveLength(1)
  expect(w.prompts).toHaveLength(2)
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
})

test('a pointer bump to a landed submodule commit passes without Codex; an unlanded one is high', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/release-v1-KAN-9'
  w.git.numstat = '1\t1\tBackend\n2\t2\tCHANGELOG.md\n1\t1\tpackage.json\n2\t2\tpackage-lock.json'
  w.git.raw = `:160000 160000 ${'1'.repeat(40)} ${'2'.repeat(40)} M\tBackend`
  w.git.pkgDiff = '--- a/package.json\n+++ b/package.json\n@@ -3 +3 @@\n-  "version": "0.6.0",\n+  "version": "0.6.1",'
  w.git.isLanded = true
  // Run by hand, so no PR opens and the branch stays before its PR.
  await $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.spawned).toHaveLength(0)
  expect((await runOf(w)).status).toBe('passed')
  expect((await runOf(w)).tierWhy).toContain('already reviewed: Backend, package.json, package-lock.json')

  w.git.head = 'b'.repeat(40)
  w.git.since = '1\t1\tBackend'
  w.git.isLanded = false
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const run = await runOf(w)
  expect(run.tier).toBe('high')
  // highEffort, medium by default (R69).
  expect(run.effort).toBe('medium')
})

test('a branch whose every commit is already on another gated base passes without Codex', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/backsync-main-KAN-9'
  w.git.left = ''
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.spawned).toHaveLength(0)
  expect((await runOf(w)).tierWhy).toContain('every commit is on origin/main')
})

test('a promotion between gated bases is not gated', async ($, on) => {
  const w = world(on)
  w.git.branch = 'dev'
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --head dev' }))).toBe(false)
  expect(w.spawned).toHaveLength(0)
})

test('a promotion named by --head from a feature checkout is still not gated', async ($, on) => {
  const w = world(on)
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --head dev' }))).toBe(false)
  expect(w.spawned).toHaveLength(0)
})

test('R98 (#34): a create whose head is not the branch checked out here is held, and says to run it from that branch', async ($, on) => {
  const w = world(on)
  // PR #32: a worktree branch pushed under another name (git push origin HEAD:refs/heads/fix/x), then opened by that name.
  w.git.branch = 'worktree-bridge-cse_1'
  const commands = [
    'gh pr create --base dev --head fix/x --title t',
    'gh pr create -B dev -H me:fix/x --title t',
    'gh api repos/me/repo/pulls -f base=dev -f head=fix/x -f title=t',
  ]
  const mcp = { tool: 'mcp__plugin_github_github__create_pull_request' as const, owner: 'me', repo: 'repo', base: 'dev', head: 'fix/x', title: 't' }
  const results = []
  for (const command of commands) results.push(await $.tool.call({ tool: 'Bash', command }))
  results.push(await $.tool.call(mcp))
  for (const ran of results) {
    expect(isHeld(ran)).toBe(true)
    expect(ran.deny).toContain('fix/x')
    expect(ran.deny).toContain('worktree-bridge-cse_1')
    expect(ran.deny).toContain('Do not open the pull request another way')
  }
  // Held, not reviewed: no round starts for a branch the gate cannot see.
  expect(w.spawned).toHaveLength(0)
  // The same head, checked out here, goes to the gate as before.
  w.git.branch = 'fix/x'
  expect(isHeld(await $.tool.call({ tool: 'Bash', command: commands[0]! }))).toBe(true)
  expect(w.spawned.length).toBeGreaterThan(0)
})

test('a docs-only commit after the pass rides on it; a code commit does not', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  w.git.head = 'f'.repeat(40)
  w.git.since = '1\t0\tCHANGELOG.md'
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  w.git.head = '9'.repeat(40)
  w.git.since = '1\t0\tsrc/app.ts'
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('only the person waives the pre-PR review, and a waiver lets that commit open its PR', async ($, on) => {
  const w = world(on)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const presentation = { isFullscreen: false, columns: 120 }
  const asAgent = await $.command.run({ command: 'pr-gate', args: 'waive pre hotfix', origin: { kind: 'sdk' }, presentation })
  expect(asAgent.text).toContain('Only the person')
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const asPerson = await $.command.run({ command: 'pr-gate', args: 'waive pre hotfix', origin: { kind: 'composer' }, presentation })
  expect(asPerson.text).toContain('waived pre-PR review for feat/x')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.opened).toHaveLength(1)
})

test('the pane lists the to-dos and the findings on each surface', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-lifecycle',
      surface,
      component: 'Pane',
      requestId: 'pr-lifecycle',
      props: {
        title: 'PR lifecycle',
        isFocused: false,
        bodyColumns: 48,
        placement: 'dock',
        scroll: { top: 0, bodyRows: 40, rows: 40 } as never,
        view: {} as never,
      },
    })
    expect(await ui.find({ type: 'Text', text: 'in progress: fixing round 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'R1-1 [P1] Unvalidated redirect' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Round 1 · codex review — FAIL · 1 blocking' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'pre-PR · 0/4 rounds used' })).toBeDefined()
    if (surface === 'desktop') {
      await ui.press({ key: 'stop' })
      expect(await ui.find({ type: 'Text', text: 'STOPPED' })).toBeDefined()
    }
    await ui.unmount()
  }
  expect((await runOf(w)).status).toBe('stopped')
})

test('R81: the pane\'s Stop runs /pr-gate stop: logged as the person, and the agent is told', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  const ui = await $.ui.mount({
    plugin: 'pr-lifecycle',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pr-lifecycle',
    props: { title: 'PR lifecycle', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { top: 0, bodyRows: 40, rows: 40 } as never, view: {} as never },
  })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  await w.clock.advance(1000)
  expect((await runOf(w)).status).toBe('stopped')
  expect(w.prompts.at(-1)).toContain('the person stopped the gate')
  expect(recordOf(w).log?.some(one => one.kind === 'person' && one.text.includes('/pr-gate stop'))).toBe(true)
})
