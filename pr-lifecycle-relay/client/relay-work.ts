// relay-work: claim, checkpoint and release work on the relay from any runtime (the TUI, a Workers sandbox, a VPS, Claude cloud, the game
// bridge). Node 22 or later, no dependencies. It reads the same variables as pr-lifecycle: `PR_GATE_RELAY_URL`, then either
// `PR_GATE_RELAY_CLIENT_ID` and `PR_GATE_RELAY_CLIENT_SECRET` (an Access service token) or `PR_GATE_RELAY_TOKEN` (a person's token).
// The checkout's secret and each claim's token are kept under `<git dir>/relay-work/`, so a claim is held by this checkout only.
//
//   relay-work claim gh#12 [--title T] [--branch B] [--reopen] [--checkout]
//   relay-work beat gh#12 | keepalive gh#12 [--every 30]
//   relay-work checkpoint gh#12 --text T [--notes notes/gh-12.md] [--push] [--commit SHA] [--branch B]
//   relay-work release gh#12 --outcome done|paused|abandoned [--text T]
//   relay-work get gh#12 | list [--state active|lapsed|paused|done|abandoned]
//   relay-work break gh#12 [--text T]                 # admin people only
//
// Global flags: --repo owner/name (default: the origin remote), --runtime R (default: $RELAY_RUNTIME, else `local`), --holder H.
// Prints the relay's JSON answer. Exit codes: 0 done, 1 refused (held, lost, not allowed, not found), 2 usage, 3 the relay did not answer.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'

const USAGE = 'usage: relay-work claim|beat|keepalive|checkpoint|release|get|list|break <ref> [flags] (see the header of client/relay-work.ts)'

const fail = (code: number, text: string): never => {
  console.error(text)
  process.exit(code)
}

const git = (...args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/** Flags as `--name value` or a bare `--name` (true); the rest are positional. */
function parse(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      pos.push(arg)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[arg.slice(2)] = true
    else flags[arg.slice(2)] = argv[++i]
  }
  return { pos, flags }
}

/** `owner/name` from a GitHub remote URL (https or ssh). */
const repoOf = (remote: string | undefined): string | undefined => remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]?.toLowerCase()

const { pos, flags } = parse(process.argv.slice(2))
const [command, ref] = pos
const str = (name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)
if (command === undefined) fail(2, USAGE)

const url = process.env.PR_GATE_RELAY_URL?.replace(/\/+$/, '')
if (url === undefined || url === '') fail(2, 'PR_GATE_RELAY_URL is not set')
const id = process.env.PR_GATE_RELAY_CLIENT_ID
const secretOfToken = process.env.PR_GATE_RELAY_CLIENT_SECRET
const person = process.env.PR_GATE_RELAY_TOKEN
const auth: Record<string, string> =
  id && secretOfToken ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secretOfToken } : person ? { 'cf-access-token': person } : {}
if (Object.keys(auth).length === 0) fail(2, 'set PR_GATE_RELAY_CLIENT_ID and PR_GATE_RELAY_CLIENT_SECRET, or PR_GATE_RELAY_TOKEN')

const repo = str('repo')?.toLowerCase() ?? repoOf(git('remote', 'get-url', 'origin'))
if (repo === undefined || !/^[^/]+\/[^/]+$/.test(repo)) fail(2, 'no repo: pass --repo owner/name or run inside a checkout with a GitHub origin')
const runtime = str('runtime') ?? process.env.RELAY_RUNTIME ?? 'local'
const top = git('rev-parse', '--show-toplevel')
const holder = str('holder') ?? `${runtime}@${hostname()}:${top === undefined ? process.cwd() : basename(top)}`

// The checkout's secret, made once; and the token of each claim it holds.
const gitDir = git('rev-parse', '--absolute-git-dir')
const home = gitDir === undefined ? join(homedir(), '.relay-work') : join(gitDir, 'relay-work')
mkdirSync(home, { recursive: true, mode: 0o700 })
const secretFile = join(home, 'secret')
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 })
const secret = readFileSync(secretFile, 'utf8').trim()
const tokenFile = (one: string) => join(home, `${repo!.replace('/', '__')}__${one.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
const tokenOf = (one: string): number => {
  try {
    return (JSON.parse(readFileSync(tokenFile(one), 'utf8')) as { token: number }).token
  } catch {
    return fail(1, `this checkout holds no claim on ${one}: run relay-work claim ${one} first`)
  }
}

async function send(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(`${url}/v1/${repo}/work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    })
  } catch (error) {
    return fail(3, `the relay did not answer: ${String(error)}`)
  }
  const text = await res.text()
  if (res.status >= 500) fail(3, `the relay answered ${res.status}: ${text.slice(0, 300)}`)
  // Access answers a missing or expired credential with a redirect or its login page, never JSON.
  if (res.status >= 300 && res.status < 400) fail(1, `refused by Access (${res.status}): check the credential`)
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return fail(1, `refused (${res.status}): ${text.slice(0, 300)}`)
  }
}

const done = (answer: { status: number; json: Record<string, unknown> }): void => {
  console.log(JSON.stringify(answer.json, null, 2))
  if (answer.status !== 200) process.exit(answer.status === 400 ? 2 : 1)
}

const needRef = (): string => ref ?? fail(2, `${command} needs a ref, e.g. gh#12`)

switch (command) {
  case 'claim': {
    const one = needRef()
    const answer = await send({ op: 'claim', ref: one, holder, runtime, secret, title: str('title'), branch: str('branch'), reopen: flags.reopen === true })
    if (answer.status === 200) {
      writeFileSync(tokenFile(one), JSON.stringify({ token: answer.json.token, holder }), { mode: 0o600 })
      const branch = (answer.json.resume as { branch?: string | null } | undefined)?.branch
      // On a takeover, `--checkout` puts this checkout on the branch the last holder pushed, ready to read its notes and go on.
      if (flags.checkout === true && typeof branch === 'string' && branch !== '') {
        if (git('fetch', 'origin', branch) === undefined || git('checkout', branch) === undefined) console.error(`could not check out ${branch}`)
      }
    }
    done(answer)
    break
  }
  case 'beat':
    done(await send({ op: 'beat', ref: needRef(), secret, token: tokenOf(needRef()) }))
    break
  case 'keepalive': {
    // Beats until the claim is lost or released, so an agent runs `relay-work keepalive gh#12 &` beside its work.
    const one = needRef()
    const every = Number(str('every') ?? 30) * 1000
    for (;;) {
      const answer = await send({ op: 'beat', ref: one, secret, token: tokenOf(one) })
      if (answer.status !== 200) {
        console.error(`keepalive stopped: ${answer.status} ${JSON.stringify(answer.json.error ?? '')}`)
        process.exit(1)
      }
      await new Promise(resolve => setTimeout(resolve, every))
    }
  }
  case 'checkpoint': {
    const one = needRef()
    const text = str('text') ?? fail(2, 'checkpoint needs --text')
    if (flags.push === true && git('push', '-u', 'origin', 'HEAD') === undefined) fail(1, 'git push failed: nothing was recorded')
    const branch = str('branch') ?? git('rev-parse', '--abbrev-ref', 'HEAD')
    const commit = str('commit') ?? git('rev-parse', 'HEAD')
    const fallback = `notes/${one.replace(/[^A-Za-z0-9_.-]/g, '-')}.md`
    const notes = str('notes') ?? (top !== undefined && existsSync(join(top, fallback)) ? fallback : undefined)
    done(await send({ op: 'checkpoint', ref: one, secret, token: tokenOf(one), text, branch, commit, notes }))
    break
  }
  case 'release':
    done(await send({ op: 'release', ref: needRef(), secret, token: tokenOf(needRef()), outcome: str('outcome'), text: str('text') }))
    break
  case 'get':
    done(await send({ op: 'get', ref: needRef() }))
    break
  case 'list':
    done(await send({ op: 'list', state: str('state') }))
    break
  case 'break':
    done(await send({ op: 'breakClaim', ref: needRef(), text: str('text') }))
    break
  default:
    fail(2, USAGE)
}
