// The relay's contract (Task 5), replayed against the relay under Miniflare. The same transcript holds the plugin's fake relay to these
// answers (pr-lifecycle/tests/relay.test.ts), so a step that fails here is a relay bug or a transcript bug, never a fake to be fixed.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { type As, CONTRACT, isMatch, PRINCIPALS, type Step } from '../../pr-lifecycle/tests/contract.ts'
import { ADAM, call, CODEX, grant, person, READER, seed, service, sign, start, stop } from './harness.ts'

const tokens = new Map<As, string | undefined>()
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

before(async () => {
  // A case runs several steps on one object: a long lease and retention, so neither runs out under load mid-case.
  await start({ RETENTION_MS: '600000', LEASE_MS: '600000' })
  await seed()
  tokens.set('ADAM', await sign(person(ADAM)))
  tokens.set('CODEX', await sign(service(CODEX)))
  tokens.set('READER', await sign(person(READER)))
  tokens.set('NOBODY', undefined)
})

after(async () => {
  await stop()
})

/** One step's answer, polled for up to 3 s when it comes from the index. */
async function replay(step: Step) {
  const deadline = Date.now() + 3000
  for (;;) {
    const res = await call(tokens.get(step.as), step.body, step.path)
    const isOk = res.status === step.status && (step.isText !== true || typeof res.json.text === 'string') && isMatch(res.json, step.match ?? {})
    if (isOk || step.isEventual !== true || Date.now() > deadline) return { res, isOk }
    await pause(25)
  }
}

test('the transcript names the harness\'s principals', () => {
  assert.deepEqual(PRINCIPALS, { ADAM, CODEX, READER })
})

for (const one of CONTRACT) {
  test(`contract: ${one.name}`, async () => {
    for (const given of one.grants ?? []) {
      const res = await grant(tokens.get('ADAM')!, PRINCIPALS[given.as], given.repo, given.preset)
      assert.equal(res.status, 200)
    }
    for (const [n, step] of one.steps.entries()) {
      const { res, isOk } = await replay(step)
      assert.ok(isOk, `step ${n} (${step.as} ${String(step.body.op)} ${step.path}): expected ${step.status} ${JSON.stringify(step.match ?? {})}, got ${res.status} ${JSON.stringify(res.json)}`)
    }
  })
}
