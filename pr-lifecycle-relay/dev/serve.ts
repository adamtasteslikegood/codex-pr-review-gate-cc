// The relay on this machine, for testing with no Cloudflare account: the production Worker and objects under Miniflare, with their state
// kept on disk in `pr-lifecycle-relay/.dev/`, behind a stand-in for Cloudflare Access. The stand-in does what Access does in front of the
// real relay: it turns a service token's `CF-Access-Client-Id` and `CF-Access-Client-Secret`, or a `cf-access-token`, into a signed
// `Cf-Access-Jwt-Assertion`. Production code is unchanged; the Worker verifies the JWT against keys this script makes and serves.
//
//   node pr-lifecycle-relay/dev/serve.ts            # http://127.0.0.1:8787
//   TLS=1 node pr-lifecycle-relay/dev/serve.ts      # https://127.0.0.1:8443, for pr-lifecycle, which takes only an https relay
//   PORT=9000 DEV_REPOS=owner/a,owner/b node pr-lifecycle-relay/dev/serve.ts
//
// With TLS=1 it makes a local CA (`.dev/tls/ca.pem`) and a certificate for 127.0.0.1 and localhost, once, with openssl. A client trusts it
// with NODE_EXTRA_CA_CERTS (Node, Claude Code), SSL_CERT_FILE or a cafile (Python), or curl --cacert.
//
// On first start it makes one service token per runtime (`DEV_RUNTIMES`) and writes `.dev/<runtime>.env` with the three variables
// pr-lifecycle and `client/relay-work.ts` read. Every runtime and the dev person (`DEV_ADMIN`) get `operate` on each repo in `DEV_REPOS`.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { stripTypeScriptTypes } from 'node:module'

import { Miniflare } from 'miniflare'

const DIR = new URL('../.dev/', import.meta.url)
const TEAM = 'dev.cloudflareaccess.local'
const AUD = 'relay-dev'
const HOST = process.env.HOST ?? '127.0.0.1'
// Every dev runtime and the dev admin may operate on the seeded repos: this server is for one machine. Another address needs a choice.
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && process.env.DEV_EXPOSE !== '1') {
  console.error(`refusing HOST=${HOST}: the dev relay grants operate to every dev credential. Set DEV_EXPOSE=1 to serve beyond this machine.`)
  process.exit(2)
}
const IS_TLS = process.env.TLS === '1'
const PORT = Number(process.env.PORT ?? (IS_TLS ? 8443 : 8787))
const ADMIN = (process.env.DEV_ADMIN ?? 'adam@dev.local').toLowerCase()
const RUNTIMES = (process.env.DEV_RUNTIMES ?? 'tui,sandbox,vps,cloud,bridge,gate').split(',').map(one => one.trim()).filter(Boolean)
const REPOS = (process.env.DEV_REPOS ?? 'adamtasteslikegood/td2do,adamtasteslikegood/codex-pr-review-gate-cc,adamtasteslikegood/10110tasteslikegoodplaza')
  .split(',')
  .map(one => one.trim().toLowerCase())
  .filter(Boolean)

const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString('base64url')

type Saved = { privateJwk: JsonWebKey; publicJwk: JsonWebKey; tokens: Record<string, string> }

/** The signing keys and service tokens, made once and kept, so restarting the server keeps every runtime's credentials working. */
async function load(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey; tokens: Record<string, string> }> {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const file = new URL('keys.json', DIR)
  let saved: Saved
  if (existsSync(file)) {
    saved = JSON.parse(readFileSync(file, 'utf8')) as Saved
  } else {
    const pair = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
    saved = { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey), tokens: {} }
  }
  for (const runtime of RUNTIMES) saved.tokens[runtime] ??= randomBytes(24).toString('hex')
  writeFileSync(file, JSON.stringify(saved), { mode: 0o600 })
  const privateKey = await crypto.subtle.importKey('jwk', saved.privateJwk, algorithm, false, ['sign'])
  return { privateKey, publicJwk: { ...saved.publicJwk, kid: 'dev', alg: 'RS256' } as JsonWebKey, tokens: saved.tokens }
}

const { privateKey, publicJwk, tokens } = await load()

async function sign(claims: Record<string, unknown>, seconds = 3600): Promise<string> {
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'dev', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + seconds, ...claims }))
  const sig = await crypto.subtle.sign(algorithm, privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64(new Uint8Array(sig))}`
}

/** What Access would put in front of the Worker for this request, or undefined: then the Worker answers 401, as it would in production. */
async function assertionOf(headers: Record<string, string | string[] | undefined>): Promise<string | undefined> {
  const id = String(headers['cf-access-client-id'] ?? '')
  const secret = String(headers['cf-access-client-secret'] ?? '')
  const isSecret = (want: string): boolean => want.length === secret.length && timingSafeEqual(Buffer.from(want), Buffer.from(secret))
  if (id !== '' && Object.hasOwn(tokens, id) && isSecret(tokens[id])) return sign({ common_name: id })
  const token = headers['cf-access-token']
  return typeof token === 'string' && token !== '' ? token : undefined
}

const src = (name: string): string => stripTypeScriptTypes(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
const mf = new Miniflare({
  modules: ['index.ts', 'auth.ts', 'grants.ts', 'lifecycle.ts', 'repo-index.ts', 'types.ts', 'work.ts'].map(path => ({ type: 'ESModule' as const, path, contents: src(path) })),
  compatibilityDate: '2026-08-01',
  durableObjects: { LIFECYCLE: 'LifecycleObject', GRANTS: 'GrantStore', REPO_INDEX: 'RepoIndex', WORK: 'WorkBoard' },
  durableObjectsPersist: new URL('state', DIR).pathname,
  bindings: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMINS: ADMIN, ...(process.env.LEASE_MS === undefined ? {} : { LEASE_MS: process.env.LEASE_MS }) },
  outboundService: req =>
    new URL(req.url).href === `https://${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [publicJwk] }) : new Response('no', { status: 404 }),
})

const admin = await sign({ email: ADMIN })
for (const repo of REPOS) {
  for (const principal of [ADMIN, ...RUNTIMES]) {
    const res = await mf.dispatchFetch('https://relay/v1/admin/grants', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': admin },
      body: JSON.stringify({ op: 'grant', principal, repo, preset: 'operate' }),
    })
    if (!res.ok) throw new Error(`seeding ${principal} on ${repo}: ${res.status} ${await res.text()}`)
  }
}

const url = `${IS_TLS ? 'https' : 'http'}://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`
/** With TLS, each env file also trusts the local CA: NODE_EXTRA_CA_CERTS for Node and Claude Code, SSL_CERT_FILE for Python. */
const trust = IS_TLS ? `export NODE_EXTRA_CA_CERTS=${new URL('tls/ca.pem', DIR).pathname}\nexport SSL_CERT_FILE=${new URL('tls/ca.pem', DIR).pathname}\n` : ''
for (const runtime of RUNTIMES) {
  const env = `${trust}unset PR_GATE_RELAY_TOKEN\nexport PR_GATE_RELAY_URL=${url}\nexport PR_GATE_RELAY_CLIENT_ID=${runtime}\nexport PR_GATE_RELAY_CLIENT_SECRET=${tokens[runtime]}\nexport RELAY_RUNTIME=${runtime}\n`
  writeFileSync(new URL(`${runtime}.env`, DIR), env, { mode: 0o600 })
}

// Each env file clears the other credential form, so sourcing one after another never leaves the first in charge (a service token wins
// over a person's token). The dev person's own token, for admin ops such as `breakClaim` (`cf-access-token`, as `PR_GATE_RELAY_TOKEN`), good for 30 days.
const person = await sign({ email: ADMIN }, 30 * 86_400)
writeFileSync(new URL('admin.env', DIR), `${trust}unset PR_GATE_RELAY_CLIENT_ID PR_GATE_RELAY_CLIENT_SECRET\nexport PR_GATE_RELAY_URL=${url}\nexport PR_GATE_RELAY_TOKEN=${person}\nexport RELAY_RUNTIME=admin\n`, { mode: 0o600 })

/** A local CA and a leaf certificate for 127.0.0.1 and localhost, made once with openssl and kept in `.dev/tls/`. */
function tls(): { key: Buffer; cert: Buffer } {
  const dir = new URL('tls/', DIR).pathname
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const at = (name: string) => `${dir}${name}`
  if (!existsSync(at('cert.pem'))) {
    const run = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' })
    // The extensions Python 3.13's strict verification asks for: key usage on the CA, key identifiers on both.
    const ca = ['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash']
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-subj', '/CN=pr-gate relay dev CA', ...ca, '-keyout', at('ca.key'), '-out', at('ca.pem'))
    run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', at('key.pem'), '-out', at('req.csr'))
    const leaf = [
      'subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost',
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
    ]
    writeFileSync(at('ext.cnf'), leaf.join('\n') + '\n')
    run('x509', '-req', '-in', at('req.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial', '-days', '825', '-extfile', at('ext.cnf'), '-out', at('cert.pem'))
  }
  return { key: readFileSync(at('key.pem')), cert: readFileSync(at('cert.pem')) }
}

const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', async () => {
    try {
      const assertion = await assertionOf(req.headers)
      const answer = await mf.dispatchFetch(`https://relay${req.url ?? '/'}`, {
        method: req.method,
        headers: { 'content-type': 'application/json', ...(assertion === undefined ? {} : { 'Cf-Access-Jwt-Assertion': assertion }) },
        body: req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined,
      })
      const text = await answer.text()
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'text/plain' })
      res.end(text)
      console.log(`${new Date().toISOString()} ${req.headers['cf-access-client-id'] ?? '-'} ${req.method} ${req.url} ${answer.status}`)
    } catch (error) {
      // The error stays in this server's log; the caller gets a fixed plain-text line, never the exception's text.
      console.error(`${new Date().toISOString()} ${req.method} ${req.url} failed:`, error)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('relay dev server error')
    }
  })
}
const server = IS_TLS ? createTlsServer(tls(), handler) : createServer(handler)
server.listen(PORT, HOST, () => {
  console.log(`relay (dev) on ${url}; state in ${new URL('state', DIR).pathname}`)
  console.log(`admin person: ${ADMIN}; repos: ${REPOS.join(', ')}`)
  if (IS_TLS) console.log(`trust: NODE_EXTRA_CA_CERTS=${new URL('tls/ca.pem', DIR).pathname} (Python: SSL_CERT_FILE, curl: --cacert)`)
  console.log(`credentials: source ${new URL('.', DIR).pathname}<runtime>.env for one of ${RUNTIMES.join(', ')}, or admin.env`)
})
