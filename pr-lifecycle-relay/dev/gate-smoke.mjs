// A smoke test of what pr-lifecycle sends, over https to the dev relay: its headers (the service token pair), its lease, a record
// commit, the run log, a filing claim, a stale commit refused, and the repo list.
//   TLS=1 npm run relay:dev            # in one terminal
//   . pr-lifecycle-relay/.dev/gate.env && node pr-lifecycle-relay/dev/gate-smoke.mjs
const url = process.env.PR_GATE_RELAY_URL
const headers = { 'CF-Access-Client-Id': process.env.PR_GATE_RELAY_CLIENT_ID, 'CF-Access-Client-Secret': process.env.PR_GATE_RELAY_CLIENT_SECRET, 'content-type': 'application/json' }
const repo = process.env.REPO ?? 'adamtasteslikegood/codex-pr-review-gate-cc'
const call = async (path, body) => {
  const res = await fetch(`${url}/v1/${repo}${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' })
  return { status: res.status, json: await res.json() }
}
const secret = crypto.randomUUID() + crypto.randomUUID()
const key = '/branch/' + encodeURIComponent('feat/relay-check')
const show = (name, a) => console.log(name.padEnd(28), a.status, JSON.stringify(a.json).slice(0, 110))
show('claim lease', await call(key, { op: 'claim', holder: 'gate-session', secret }))
const read0 = await call(key, { op: 'read' }); show('read', read0)
show('commit record', await call(key, { op: 'commit', rev: read0.json.rev, secret, record: { lifecycleId: 'lc-1', phase: 'pre-pr', branch: 'feat/relay-check' } }))
show('log', await call(key, { op: 'log', at: Date.now(), kind: 'round', text: 'round 1 started', holder: 'gate-session' }))
show('fileClaim', await call(key, { op: 'fileClaim', key: 'lc-1:f1:1', secret }))
show('stale commit refused', await call(key, { op: 'commit', rev: 0, secret, record: {} }))
show('repo list', await call('', { op: 'list' }))
show('release lease', await call(key, { op: 'release', secret }))
