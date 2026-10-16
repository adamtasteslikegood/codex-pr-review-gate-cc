import { expect, test } from 'claude-code/testing'

import { createPr, isHeld, P1, P2, review, runOf, TRAILER, turn, world } from './world'

test('a PR to a gated base is held and starts the gate; a clean review opens it', async ($, on) => {
  const w = world(on)
  const held = await $.tool.call(createPr)
  expect(held.deny ?? held.text).toContain('codex-gate')
  expect(w.opened).toHaveLength(0)
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.prompt).toContain('skill "codex" and args "review --effort')
  // A standard change starts at medium effort.
  expect(w.spawned[0]?.prompt).toContain('args "review --effort medium"')
  expect(w.spawned[0]?.prompt).toContain('GSTACK_CODEX_EFFORT=medium')

  await $.turn.complete(turn(review('r1-review', 'PASS')))
  const run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(w.prompts.at(-1)).toContain('open the pull request to dev')
  expect(w.prompts.at(-1)).toContain('the ones that are not required included')

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
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, P2])))

  let run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.findings.map(one => one.id)).toEqual(['R1-1', 'R1-2'])
  expect(w.prompts[0]).toContain('R1-1 [P1] Unvalidated redirect')

  w.git.head = 'd'.repeat(40)
  await $.turn.complete(
    turn(`Fixed.\n${TRAILER}\n${JSON.stringify({ dispositions: [{ id: 'R1-1', action: 'fixed', note: 'allow-list' }] })}`),
  )
  run = await runOf(w)
  expect(run.round).toBe(2)
  expect(run.phase).toBe('review')
  expect(run.findings[0]?.status).toBe('fixed')
  expect(w.spawned).toHaveLength(2)

  await $.turn.complete(turn(review('r2-review', 'PASS')))
  run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(run.headSha).toBe('d'.repeat(40))
})

test('five rounds without agreement end the gate as exhausted', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  for (let round = 1; round <= 5; round++) {
    await $.turn.complete(turn(review(`r${round}-review`, 'FAIL', [P1])))
    if (round < 5) {
      w.git.head = String(round).repeat(40)
      await $.turn.complete(turn('Tried.'))
    }
  }
  const run = await runOf(w)
  expect(run.status).toBe('exhausted')
  expect(run.round).toBe(5)
  expect(w.spawned).toHaveLength(5)
  expect(w.prompts.at(-1)).toContain('did not converge')
  expect(w.prompts.at(-1)).toContain('it carries on in the pull request')
  // The findings reach the main agent for the conversation; the pull request gets counts only.
  expect(w.prompts.at(-1)).toContain('do not paste a finding into it')
})

const fixed = (step: string, dispositions: object[]) => `Done.\n${TRAILER}\n${JSON.stringify({ step, dispositions })}`

test('advisory findings go to the main agent once nothing blocks, then Codex looks again', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS', [P2])))
  let run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.phase).toBe('fix')
  expect(run.fixKind).toBe('advisory')
  expect(w.prompts[0]).toContain('advisory round 1 of 3')
  expect(w.prompts[0]).toContain('R1-1 [P2] Rename this')

  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('r1-fix', [{ id: 'R1-1', action: 'fixed', note: 'renamed' }])))
  run = await runOf(w)
  expect(run.round).toBe(2)
  expect(run.phase).toBe('review')

  await $.turn.complete(turn(review('r2-review', 'PASS')))
  run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(run.advisoryRound).toBe(1)
  expect(w.prompts.at(-1)).toContain('R1-1 [P2] Rename this')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
})

test('advisory rounds stop at three, and the PR opens with what is left', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  for (let round = 1; round <= 4; round++) {
    await $.turn.complete(turn(review(`r${round}-review`, 'PASS', [P2])))
    if (round < 4) {
      expect((await runOf(w)).phase).toBe('fix')
      w.git.head = String(round).repeat(40)
      await $.turn.complete(turn(fixed(`r${round}-fix`, [{ id: `R${round}-1`, action: 'fixed' }])))
    }
  }
  const run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(run.advisoryRound).toBe(3)
  expect(w.spawned).toHaveLength(4)
  expect(run.message).toContain('1 advisory finding left after 3 advisory rounds')
  expect(w.prompts.at(-1)).toContain('R4-1 [P2] Rename this')
})

test('with the minimum at one advisory round, a rebuttal with no new commit opens the PR', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS', [P2])))
  await $.turn.complete(turn(fixed('r1-fix', [{ id: 'R1-1', action: 'rebutted', note: 'the name is the API' }])))
  const run = await runOf(w)
  expect(run.status).toBe('passed')
  expect(run.advisoryMin).toBe(1)
  expect(w.spawned).toHaveLength(1)
  expect(w.prompts.at(-1)).toContain('rebutted: the name is the API')
})

test('an advisory fix that adds a blocking finding goes back to the blocking rounds', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS', [P2])))
  w.git.head = 'd'.repeat(40)
  await $.turn.complete(turn(fixed('r1-fix', [{ id: 'R1-1', action: 'fixed' }])))
  await $.turn.complete(turn(review('r2-review', 'FAIL', [P1])))
  const run = await runOf(w)
  expect(run.phase).toBe('fix')
  expect(run.fixKind).toBe('blocking')
  expect(w.prompts.at(-1)).toContain('R2-1 [P1] Unvalidated redirect')
})

test('a Codex timeout reruns the round one effort lower, and fails closed below low', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(`Codex stalled.\n${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"timeout"}`, 'agent-1'))
  let run = await runOf(w)
  expect(run.status).toBe('running')
  expect(run.round).toBe(1)
  expect(run.effort).toBe('low')
  expect(w.spawned).toHaveLength(2)
  expect(w.spawned[1]?.prompt).toContain('args "review --effort low"')

  await $.turn.complete(turn(`Timed out again.\n${TRAILER}\n{"step":"r1-review","gate":"ERROR"}`, 'agent-2'))
  run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('lowest')
})

test('the next run on a branch that timed out at low effort stays at low', async ($, on) => {
  const w = world(on)
  w.git.numstat = '30\t4\tserver/security.ts'
  await $.tool.call(createPr)
  expect(w.spawned[0]?.prompt).toContain('args "review --effort high"')
  const timeout = (step: string, id: string) => turn(`${TRAILER}\n{"step":"${step}","gate":"ERROR","error":"timeout"}`, id)
  await $.turn.complete(timeout('r1-review', 'agent-1'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-2'))
  expect((await runOf(w)).effort).toBe('medium')
  await $.turn.complete(timeout('r1-review', 'agent-3'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-4'))
  await $.turn.complete(timeout('r1-review', 'agent-5'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-6'))
  expect((await runOf(w)).status).toBe('error')

  await $.command.run({
    command: 'pr-gate',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(w.spawned.at(-2)?.prompt).toContain('args "review --effort low"')
  expect(w.spawned.at(-1)?.prompt).toContain('args "challenge --effort low"')
})

test('a branch keeps the effort a review last completed at after a timeout', async ($, on) => {
  const w = world(on)
  w.git.numstat = '30\t4\tserver/security.ts'
  const rerun = () =>
    $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await $.tool.call(createPr)
  await $.turn.complete(turn(`${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"timeout"}`, 'agent-1'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-2'))
  await $.turn.complete(turn(review('r1-review', 'PASS'), 'agent-3'))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), 'agent-4'))
  expect((await runOf(w)).status).toBe('passed')

  // Passed at medium after a timeout at high: the next run starts at medium.
  await rerun()
  expect(w.spawned.at(-1)?.prompt).toContain('--effort medium')
  await $.turn.complete(turn(review('r1-review', 'PASS'), `agent-${w.spawned.length - 1}`))
  await $.turn.complete(turn(review('r1-challenge', 'PASS'), `agent-${w.spawned.length}`))
  expect((await runOf(w)).status).toBe('passed')
  // And keeps it on the run after that.
  await rerun()
  expect(w.spawned.at(-1)?.prompt).toContain('--effort medium')
})

test('a branch that passed at its default effort starts at high once it grows into high blast radius', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  expect(w.spawned.at(-1)?.prompt).toContain('--effort medium')
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  expect((await runOf(w)).status).toBe('passed')
  w.git.numstat = '30\t4\tserver/security.ts'
  await $.command.run({ command: 'pr-gate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.spawned.at(-1)?.prompt).toContain('--effort high')
})

test('a review that did not complete fails closed', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(`Codex could not authenticate.\n${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"other"}`))
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(w.prompts).toHaveLength(0)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('a high blast-radius change runs review and challenge in parallel and reviews the fix', async ($, on) => {
  const w = world(on)
  w.git.numstat = '30\t4\tserver/security.ts'
  await $.tool.call(createPr)
  expect(w.spawned.map(one => one.description)).toEqual(['codex-gate r1 review', 'codex-gate r1 challenge'])
  expect(w.spawned.every(one => !/args "\w+ --(xhigh|effort xhigh)/.test(one.prompt))).toBe(true)
  expect(w.spawned.map(one => one.prompt.match(/--effort \w+/)?.[0])).toEqual(["--effort high", "--effort high"])

  await $.turn.complete(turn(review('r1-review', 'PASS')))
  expect((await runOf(w)).phase).toBe('review')
  await $.turn.complete(turn(review('r1-challenge', 'FAIL', [P1])))
  expect((await runOf(w)).phase).toBe('fix')

  w.git.head = 'e'.repeat(40)
  await $.turn.complete(turn('Fixed.'))
  const run = await runOf(w)
  expect(run.phase).toBe('verify')
  expect(w.spawned.at(-1)?.description).toBe('codex-gate r1 verify')
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
  expect((await runOf(w)).status).toBe('passed')
})

test('a chore/ branch gets one Codex round at low effort, then the PR carries the rest', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/tidy-KAN-9'
  await $.tool.call(createPr)
  expect(w.spawned[0]?.prompt).toContain('args "review --effort low"')
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1, P2])))
  const run = await runOf(w)
  expect(run.lane).toBe('light')
  expect(run.status).toBe('exhausted')
  expect(w.spawned).toHaveLength(1)
  expect(w.prompts.at(-1)).toContain('R1-1 [P1] Unvalidated redirect')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
})

test('a chore/ branch with only advisories opens the PR without an advisory round', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/tidy-KAN-9'
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS', [P2])))
  expect((await runOf(w)).status).toBe('passed')
  expect(w.prompts).toHaveLength(1)
})

test('a pointer bump to a landed submodule commit passes without Codex; an unlanded one is high', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/release-v1-KAN-9'
  w.git.numstat = '1\t1\tBackend\n2\t2\tCHANGELOG.md\n1\t1\tpackage.json\n2\t2\tpackage-lock.json'
  w.git.raw = `:160000 160000 ${'1'.repeat(40)} ${'2'.repeat(40)} M\tBackend`
  w.git.pkgDiff = '--- a/package.json\n+++ b/package.json\n@@ -3 +3 @@\n-  "version": "0.6.0",\n+  "version": "0.6.1",'
  w.git.isLanded = true
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.spawned).toHaveLength(0)
  expect((await runOf(w)).tierWhy).toContain('already reviewed: Backend, package.json, package-lock.json')

  w.git.head = 'b'.repeat(40)
  w.git.since = '1\t1\tBackend'
  w.git.isLanded = false
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const run = await runOf(w)
  expect(run.tier).toBe('high')
  expect(run.effort).toBe('high')
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

test('a docs-only commit after the pass rides on it; a code commit does not', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'PASS')))
  w.git.head = 'f'.repeat(40)
  w.git.since = '1\t0\tCHANGELOG.md'
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  w.git.head = '9'.repeat(40)
  w.git.since = '1\t0\tsrc/app.ts'
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
})

test('only the person waives the gate, and a waiver lets that commit through', async ($, on) => {
  const w = world(on)
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const presentation = { isFullscreen: false, columns: 120 }
  const asAgent = await $.command.run({ command: 'pr-gate', args: 'waive hotfix', origin: { kind: 'sdk' }, presentation })
  expect(asAgent.text).toContain('Only the person')
  expect(isHeld(await $.tool.call(createPr))).toBe(true)
  const asPerson = await $.command.run({ command: 'pr-gate', args: 'waive hotfix', origin: { kind: 'composer' }, presentation })
  expect(asPerson.text).toContain('waived for feat/x')
  expect(isHeld(await $.tool.call(createPr))).toBe(false)
  expect(w.opened).toHaveLength(1)
})

test('the pane lists the to-dos and the findings on each surface', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await $.turn.complete(turn(review('r1-review', 'FAIL', [P1])))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-lifecycle',
      surface,
      component: 'Pane',
      requestId: 'pr-lifecycle',
      props: {
        title: 'Codex gate',
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
    if (surface === 'desktop') {
      await ui.press({ key: 'stop' })
      expect(await ui.find({ type: 'Text', text: 'STOPPED' })).toBeDefined()
    }
    await ui.unmount()
  }
  expect((await runOf(w)).status).toBe('stopped')
})
