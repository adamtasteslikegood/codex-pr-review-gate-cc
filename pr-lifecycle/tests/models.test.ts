import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { createPr, done, P1, review, runOf, TRAILER, turn, world } from './world'
import type { World } from './world'
import { configOf, overrideConfig } from '../hooks/round'
import { readReview } from '../hooks/core'
import type { LifecycleRecord } from '../types'

// #10: the Claude model of each sub-agent (R68). #11: the Codex model and effort per tier (R69). Both are plugin options a
// repository's .github/pr-gate.json on the base can override (R67).

type Dispatch = Parameters<TestBody>[0]

const recordOf = (w: World): LifecycleRecord => w.stored('lifecycle:/repo:feat/x') as LifecycleRecord
const cmd = (args: string) => ({ command: 'pr-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never
const fixed = (step: string, id: string) => `Fixed.\n${TRAILER}\n${JSON.stringify({ step, dispositions: [{ id, action: 'fixed', note: 'done' }] })}`
const HIGH = '30\t4\tserver/security.ts'

/** A high blast-radius change whose fix goes to a sub-agent: review, challenge, fix and fix review are all spawned. */
const toVerify = async ($: Dispatch, w: World, fixer?: string): Promise<void> => {
  w.git.numstat = HIGH
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1]), 'agent-1'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-2'))
  w.git.head = 'e'.repeat(40)
  await done($, turn(fixed('r1-fix', 'R1-1'), fixer))
}

// ------------------------------------------------------------------ #10: the Claude model of each sub-agent

test('#10: the Codex runners get runnerModel (sonnet), the fixer and the fix reviewer fixAgentModel (opus)', { options: { fixer: 'subagent' } }, async ($, on) => {
  const w = world(on)
  await toVerify($, w, 'agent-3')
  expect(w.spawned.map(one => [one.description, one.model])).toEqual([
    ['pr-lifecycle r1 review', 'sonnet'],
    ['pr-lifecycle r1 challenge', 'sonnet'],
    ['pr-lifecycle r1 fix', 'opus'],
    ['pr-lifecycle r1 verify', 'opus'],
  ])
})

test('#10: with the main agent fixing, the fix reviewer still gets fixAgentModel', async ($, on) => {
  const w = world(on)
  await toVerify($, w)
  expect(w.spawned.map(one => [one.description, one.model])).toEqual([
    ['pr-lifecycle r1 review', 'sonnet'],
    ['pr-lifecycle r1 challenge', 'sonnet'],
    ['pr-lifecycle r1 verify', 'opus'],
  ])
})

test('#10: runnerModel and fixAgentModel from the options', { options: { fixer: 'subagent', runnerModel: 'haiku', fixAgentModel: 'claude-opus-5-5' } }, async ($, on) => {
  const w = world(on)
  await toVerify($, w, 'agent-3')
  expect(w.spawned.map(one => one.model)).toEqual(['haiku', 'haiku', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('#10: an empty model passes none, so the sub-agent runs on the session model', { options: { fixer: 'subagent', runnerModel: '', fixAgentModel: '' } }, async ($, on) => {
  const w = world(on)
  await toVerify($, w, 'agent-3')
  expect(w.spawned).toHaveLength(4)
  expect(w.spawned.every(one => !('model' in one))).toBe(true)
})

test('#10: an invalid model option is ignored and reported; the default applies', { options: { runnerModel: 'sonnet; rm -rf /' } }, async ($, on) => {
  const w = world(on)
  const said = await $.command.run(cmd(''))
  expect(w.spawned[0]?.model).toBe('sonnet')
  expect(said.text).toContain('runnerModel')
  expect((await runOf(w)).steps.find(one => one.id === 'scope')?.detail).toContain('runnerModel')
})

test('#10: a model id is a short alias or id: letters, digits, dots and dashes', async () => {
  const ok = configOf({ runnerModel: 'claude-sonnet-5.5', fixAgentModel: 'Opus' })
  expect([ok.runnerModel, ok.fixAgentModel]).toEqual(['claude-sonnet-5.5', 'Opus'])
  for (const bad of ['-opus', 'opus 5', "opus'", 'a/b', 7]) expect(configOf({ runnerModel: bad }).runnerModel).toBe('sonnet')
  expect(configOf({ runnerModel: 'a/b' }).badOptions).toEqual(['runnerModel (not a model id)'])
  expect(configOf({}).badOptions).toEqual([])
})

/** Post-PR: a reviewer's P1 handed to the main agent, which rebuts it; Codex's rebuttal check is spawned. */
const toRebuttalCheck = async ($: Dispatch, w: World): Promise<void> => {
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":[]}'
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  const head = w.gh.prHead
  w.gh.comments = [
    { id: 11, user: { login: 'claude[bot]' }, body: '**P1** SQL injection', path: 'src/app.ts', line: 4, commit_id: head, created_at: '1970-01-01T00:01:00Z', html_url: 'u11' },
  ]
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'COMMENTED', commit_id: head, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  const rebutted = { step: 'r2-triage', dispositions: [{ id: 'G2-1', action: 'rebutted', note: 'parameterised at src/db.ts:4', replyId: '991' }] }
  await done($, turn(`ok\n${TRAILER}\n${JSON.stringify(rebutted)}`))
}

test('#10: the post-PR rebuttal check runs on runnerModel', { options: { runnerModel: 'haiku', fixAgentModel: 'opus' } }, async ($, on) => {
  const w = world(on)
  await toRebuttalCheck($, w)
  expect(w.spawned.at(-1)?.description).toBe('pr-lifecycle r2 verify')
  expect(w.spawned.at(-1)?.prompt).toContain('rebutted')
  expect(w.spawned.at(-1)?.model).toBe('haiku')
})

test('#10: the repository file overrides runnerModel and fixAgentModel; an empty one inherits', { options: { fixer: 'subagent' } }, async ($, on) => {
  const w = world(on)
  w.git.roster = '{"runnerModel":"haiku","fixAgentModel":""}'
  await toVerify($, w, 'agent-3')
  expect(w.spawned.map(one => one.model)).toEqual(['haiku', 'haiku', undefined, undefined])
})

test('#10: an invalid model in the repository file is ignored and named; the option applies', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"runnerModel":"$(whoami)","codexModel":"gpt 6"}'
  const said = await $.command.run(cmd(''))
  expect(said.text).toContain('ignored runnerModel (not a model id), codexModel (not a model id)')
  expect(w.spawned[0]?.model).toBe('sonnet')
  expect(w.spawned[0]?.prompt).toContain("--model 'gpt-6-luna'")
})

// ------------------------------------------------------------------ #11: the Codex model and effort per tier

const argsOf = (w: World, at = -1): string => w.spawned.at(at)?.prompt.match(/args "([^"]*)"/)?.[1] ?? ''

test('#11: a standard change names codexModel and reviewEffort in the skill args and the dispatch prefix', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort medium")
  expect(w.spawned[0]?.prompt).toContain('GSTACK_CODEX_MODEL=gpt-6-luna GSTACK_CODEX_EFFORT=medium')
  expect((await runOf(w)).codexModel).toBe('gpt-6-luna')
})

test('#11: a light-lane branch names codexModel at lightEffort', async ($, on) => {
  const w = world(on)
  w.git.branch = 'chore/tidy-KAN-9'
  await $.tool.call(createPr)
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort low")
})

test('#11: a high blast-radius change names codexModelHigh at highEffort (medium), never always high', async ($, on) => {
  const w = world(on)
  w.git.numstat = HIGH
  await $.tool.call(createPr)
  expect([argsOf(w, 0), argsOf(w, 1)]).toEqual(["review --model 'gpt-6-astra' --effort medium", "challenge --model 'gpt-6-astra' --effort medium"])
  expect(w.spawned[1]?.prompt).toContain('GSTACK_CODEX_MODEL=gpt-6-astra GSTACK_CODEX_EFFORT=medium')
  expect((await runOf(w)).effort).toBe('medium')
})

test('#11: highEffort sets where a high blast-radius change starts', { options: { highEffort: 'high', codexModelHigh: 'gpt-6.1-sol' } }, async ($, on) => {
  const w = world(on)
  w.git.numstat = HIGH
  await $.tool.call(createPr)
  expect(argsOf(w)).toBe("challenge --model 'gpt-6.1-sol' --effort high")
})

test('#11: an effort is low, medium or high: xhigh falls back to the default', async () => {
  const c = configOf({ highEffort: 'xhigh', rereviewEffort: 'xhigh', reviewEffort: 'xhigh' })
  expect([c.highEffort, c.rereviewEffort, c.effort]).toEqual(['medium', 'low', 'medium'])
  expect(overrideConfig(configOf({}), '{"highEffort":"xhigh"}').ignored).toEqual(['highEffort (not low, medium or high)'])
})

test('#11: an empty codexModel names no model, so gstack\'s own order applies', { options: { codexModel: '' } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  expect(argsOf(w)).toBe('review --effort medium')
  expect(w.spawned[0]?.prompt).not.toContain('GSTACK_CODEX_MODEL=')
  expect(w.spawned[0]?.prompt).toContain('GSTACK_CODEX_EFFORT=medium')
  expect((await runOf(w)).codexModel).toBeUndefined()
})

test('#11: every Codex dispatch after the first review round runs at rereviewEffort (low)', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'e'.repeat(40)
  await done($, turn(fixed('r1-fix', 'R1-1')))
  expect(w.spawned).toHaveLength(2)
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort low")
  // The consult of the earlier answers runs inside this step, at the same effort.
  expect(w.spawned[1]?.prompt).toContain('consult included')
})

test('#11: a rerun of the first round after an incomplete attempt keeps the starting effort', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(`${TRAILER}\n{"step":"r1-review","gate":"ERROR","error":"other","note":"auth"}`))
  expect((await runOf(w)).status).toBe('error')
  await $.command.run(cmd('resume'))
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort medium")
})

test('#11: rereviewEffort is never above the tier\'s starting effort', { options: { rereviewEffort: 'high', lightEffort: 'low' } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1])))
  w.git.head = 'e'.repeat(40)
  await done($, turn(fixed('r1-fix', 'R1-1')))
  // Standard: starts at medium, so a rereview at high is capped at medium.
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort medium")
})

test('#11: the post-PR Codex fallback re-review runs at rereviewEffort', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  w.gh.prHead = 'b'.repeat(40)
  w.git.head = 'b'.repeat(40)
  await w.clock.advance(20 * 60_000)
  expect((await runOf(w)).phase).toBe('review')
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort low")
})

test('#11: the repository file sets each Codex key', async ($, on) => {
  const w = world(on)
  w.git.numstat = HIGH
  w.git.roster = '{"codexModelHigh":"gpt-6.1-sol","highEffort":"low","rereviewEffort":"low"}'
  await $.tool.call(createPr)
  expect(argsOf(w)).toBe("challenge --model 'gpt-6.1-sol' --effort low")
  const c = overrideConfig(configOf({}), '{"codexModel":"gpt-6-nova","codexModelHigh":"","reviewEffort":"low","lightEffort":"high","highEffort":"high","rereviewEffort":"medium"}')
  expect(c.ignored).toEqual([])
  expect([c.config.codexModel, c.config.codexModelHigh]).toEqual(['gpt-6-nova', undefined])
  expect([c.config.effort, c.config.lightEffort, c.config.highEffort, c.config.rereviewEffort]).toEqual(['low', 'high', 'high', 'medium'])
  const models = overrideConfig(configOf({}), '{"runnerModel":"haiku","fixAgentModel":"","codexModel":7}')
  expect([models.config.runnerModel, models.config.fixAgentModel, models.config.codexModel]).toEqual(['haiku', undefined, 'gpt-6-luna'])
  expect(models.ignored).toEqual(['codexModel (not a model id)'])
})

test('#11: a repository file standard reviewEffort applies at the start', async ($, on) => {
  const w = world(on)
  w.git.roster = '{"reviewEffort":"low","codexModel":"gpt-6-nova"}'
  await $.tool.call(createPr)
  expect(argsOf(w)).toBe("review --model 'gpt-6-nova' --effort low")
})

// ------------------------------------------------------------------ what ran is recorded

test('#11: the model on the CODEX_MODEL: line is recorded on the round, beside its effort, and shown in the pane', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'FAIL', [P1], { model: 'gpt-6-luna-2026-09' })))
  expect((await runOf(w)).codexModel).toBe('gpt-6-luna-2026-09')
  const ui = await $.ui.mount({
    plugin: 'pr-lifecycle',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr-lifecycle',
    props: { title: 'PR lifecycle', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { top: 0, bodyRows: 40, rows: 40 } as never, view: {} as never },
  })
  expect(await ui.find({ type: 'Text', text: 'codex gpt-6-luna-2026-09 medium' })).toBeDefined()
  await ui.unmount()
  w.git.head = 'e'.repeat(40)
  await done($, turn(fixed('r1-fix', 'R1-1')))
  const round = recordOf(w).rounds.find(one => one.n === 1)
  expect([round?.effort, round?.codexModel]).toEqual(['medium', 'gpt-6-luna-2026-09'])
})

test('#11: the reviewer reports the model in its trailer, or the CODEX_MODEL: line is read from its answer', async () => {
  expect(readReview(review('r1-review', 'PASS', [], { model: 'gpt-6-astra' })).model).toBe('gpt-6-astra')
  expect(readReview(`CODEX_MODEL: gpt-6-luna (gpt; source: config.toml)\n${TRAILER}\n{"step":"r1-review","gate":"PASS"}`).model).toBe('gpt-6-luna')
  expect(readReview(review('r1-review', 'PASS', [], { model: 'not a model' })).model).toBeUndefined()
  expect(readReview(review('r1-review', 'PASS')).model).toBeUndefined()
})

test('#11: a record from before 1.2.0, with no model on its rounds, still loads and runs', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  const rec = recordOf(w)
  // Without a reported model, the round records the model the gate asked for.
  expect(rec.rounds[0]?.codexModel).toBe('gpt-6-luna')
  const rounds = rec.rounds.map(one => {
    const copy: Record<string, unknown> = { ...one }
    delete copy.codexModel
    delete copy.effort
    return copy
  })
  const old = { ...rec, rounds }
  w.store.set('lifecycle:/repo:feat/x', old)
  w.git.head = 'e'.repeat(40)
  await $.command.run(cmd(''))
  expect((await runOf(w)).status).toBe('running')
  expect(argsOf(w)).toBe("review --model 'gpt-6-luna' --effort low")
})

// ------------------------------------------------------------------ an unavailable model

const unusable = (step: string, agentId?: string) =>
  turn(
    `CODEX_MODEL: gpt-6-luna (gpt; source: request)\nMODEL_UNUSABLE\n${TRAILER}\n` +
      JSON.stringify({ step, gate: 'ERROR', error: 'model', note: "HINT: the 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account" }),
    agentId,
  )

test('#11: an unavailable model stops the round as an incomplete attempt, spends no round, and names the setting', async ($, on) => {
  const w = world(on)
  await $.tool.call(createPr)
  await done($, unusable('r1-review'))
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain("the 'gpt-6-luna' model is not supported")
  expect(run.message).toContain('codexModel')
  expect(run.message).toContain('plugin option')
  expect(run.message).not.toContain('codexModelHigh')
  // No step-down and no other model: nothing more was spawned.
  expect(w.spawned).toHaveLength(1)
  const rec = recordOf(w)
  expect(rec.attempts).toBe(1)
  expect(rec.rounds.filter(one => one.isCompleted)).toHaveLength(0)
  expect(rec.effort).toBe('medium')
  expect(rec.hasTimedOut).toBeUndefined()
})

test('#11: on a high blast-radius change, the stop names codexModelHigh, and the repository file when it set it', async ($, on) => {
  const w = world(on)
  w.git.numstat = HIGH
  w.git.roster = '{"codexModelHigh":"gpt-6-luna"}'
  await $.tool.call(createPr)
  await done($, unusable('r1-review', 'agent-1'))
  await done($, turn(review('r1-challenge', 'PASS'), 'agent-2'))
  const run = await runOf(w)
  expect(run.status).toBe('error')
  expect(run.message).toContain('codexModelHigh')
  expect(run.message).toContain('.github/pr-gate.json')
  expect(w.spawned).toHaveLength(2)
  expect(recordOf(w).rounds.filter(one => one.isCompleted)).toHaveLength(0)
})

// ------------------------------------------------------------------ fix round

/** Post-PR: a reviewer's P1 left unanswered twice, so the review blocks on the same head and a resume answers it (R37). */
const toBlockedPost = async ($: Dispatch, w: World): Promise<void> => {
  w.git.roster = '{"reviewers":["claude[bot]"],"checks":[]}'
  await $.tool.call(createPr)
  await done($, turn(review('r1-review', 'PASS')))
  await $.tool.call(createPr)
  const head = w.gh.prHead
  w.gh.comments = [
    { id: 11, user: { login: 'claude[bot]' }, body: '**P1** SQL injection', path: 'src/app.ts', line: 4, commit_id: head, created_at: '1970-01-01T00:01:00Z', html_url: 'u11' },
  ]
  w.gh.reviews = [{ id: 5, user: { login: 'claude[bot]' }, body: '', state: 'COMMENTED', commit_id: head, submitted_at: '1970-01-01T00:01:00Z' }]
  await w.clock.advance(30_000)
  const none = turn(`ok\n${TRAILER}\n${JSON.stringify({ step: 'r2-triage', dispositions: [] })}`)
  await done($, none)
  await w.clock.advance(1000)
  await done($, none)
  expect(recordOf(w).postStatus).toBe('blocked')
}

test('M3: an answer run takes the tier\'s own effort and Codex model from the base\'s settings', { options: { highEffort: 'low' } }, async ($, on) => {
  const w = world(on)
  await toBlockedPost($, w)
  const rec = recordOf(w)
  w.store.set('lifecycle:/repo:feat/x', { ...rec, tier: 'high', effort: undefined })
  await $.command.run(cmd('resume'))
  const run = await runOf(w)
  expect(run.isAnswer).toBe(true)
  expect(run.effort).toBe('low')
  expect(run.codexModel).toBe('gpt-6-astra')
})

test('M3: a pass-through run shows the base\'s effort for its tier', async ($, on) => {
  const w = world(on)
  w.git.numstat = '3\t1\tdocs/README.md'
  w.git.roster = '{"reviewEffort":"low"}'
  await $.command.run(cmd(''))
  expect((await runOf(w)).effort).toBe('low')
})
