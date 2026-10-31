// pr-lifecycle's own store (hooks/store.ts, unchanged) against the https dev relay, from a real checkout whose base opts in: it reads
// the base's `.github/pr-gate.json`, the credential and the pin from the environment, and commits a record three ways. With no argument it
// makes a throwaway repo whose origin path ends in `adamtasteslikegood/td2do.git`, so the slug is one the dev relay grants.
//   TLS=1 npm run relay:dev
//   . pr-lifecycle-relay/.dev/gate.env && node --no-warnings --import ./pr-lifecycle-relay/dev/ts-ext.mjs pr-lifecycle-relay/dev/gate-store-live.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecord } from '../../pr-lifecycle/hooks/lifecycle.ts'
import { loadRecord, saveRecord, transact, updateRecord } from '../../pr-lifecycle/hooks/store.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
function throwaway(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-live-'))
  const origin = join(dir, 'adamtasteslikegood', 'td2do.git')
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const co = join(dir, 'co')
  git(dir, 'clone', '-q', origin, co)
  mkdirSync(join(co, '.github'))
  writeFileSync(join(co, '.github', 'pr-gate.json'), JSON.stringify({ sharedStore: { url: process.env.PR_GATE_RELAY_URL, aud: 'relay-dev' } }))
  git(co, 'add', '-A')
  git(co, '-c', 'user.name=gate-live', '-c', 'user.email=gate-live@dev.local', 'commit', '-qm', 'base opts in')
  git(co, 'push', '-q', 'origin', 'HEAD:main')
  git(co, 'checkout', '-q', '-b', `feat/live-${Date.now()}`)
  git(co, 'fetch', '-q', 'origin')
  return co
}
const root = process.argv[2] ?? throwaway()
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const store = new Map<string, unknown>()
const $ = {
  clock: {
    now: async () => Date.now(),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
    after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) } },
  },
  process: {
    run: async (argv: string[], opts: { cwd: string }) => {
      try {
        return { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), stderr: '' }
      } catch (e) {
        return { exitCode: 1, stdout: '', stderr: String(e) }
      }
    },
  },
  http: {
    fetch: async (url: string, init: RequestInit) => {
      const res = await fetch(url, init)
      return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() }
    },
  },
  store: {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)) },
    delete: async (k: string) => { store.delete(k) },
    keys: async () => [...store.keys()],
  },
  env: { get: async (name: string) => process.env[name] },
  session: { id: async () => 'live-session-1' },
} as never

const rec = newRecord({ root, branch, base: 'main', head, tier: 'standard', tierWhy: 'live', lane: 'full', allowance: 4, at: Date.now() })
await saveRecord($, rec)
await transact($, root, branch, async tx => {
  const one = (await tx.load())!
  await tx.save({ ...one, grants: [...one.grants, { n: 1, reason: 'live relay', head, at: Date.now() }] })
})
await updateRecord($, root, branch, (r: any) => ({ ...r, grants: [...r.grants, { n: 2, reason: 'second', head, at: Date.now() }] }), { isPure: true })
const loaded = (await loadRecord($, root, branch)) as any
console.log('local mirror: relayRev', loaded.relayRev, 'grants', loaded.grants.map((g: any) => g.reason), 'slug', loaded.slug)
console.log('log:', JSON.stringify((loaded.log ?? []).map((l: any) => l.text)))
if (loaded.relayRev !== 3) {
  console.error('FAIL: the record stayed local (see the log above)')
  process.exit(1)
}
console.log('PASS: the gate store committed to the relay')
