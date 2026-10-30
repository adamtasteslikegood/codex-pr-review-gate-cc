// The relay under Miniflare, shared by the relay tests. The tests sign their own Access JWTs with a local key pair, which the outbound fetch
// serves as the team's published keys: the production verifier runs unchanged.

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

import { Miniflare } from 'miniflare'

export const TEAM = 'team.cloudflareaccess.com'
export const AUD = 'aud-tag'
export const ADAM = 'adam@example.org'
export const CODEX = 'codex-service.access'
export const READER = 'reader@example.org'
export const LEASE_MS = 600
export const FILING_STALE_MS = 300
export const INDEX_RETRY_MS = 50
/** Short, so the retention tests run in real time; a file that waits past it on branch keys passes a longer one to `start`. */
export const RETENTION_MS = 400

const enc = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
let team: CryptoKeyPair
export let stranger: CryptoKeyPair
let mf: Miniflare

export async function sign(claims: Record<string, unknown>, keys: CryptoKeyPair = team, kid = 'k1'): Promise<string> {
  const head = enc(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = enc(JSON.stringify(claims))
  const sig = await crypto.subtle.sign(algorithm, keys.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${enc(new Uint8Array(sig))}`
}

export const now = (): number => Math.floor(Date.now() / 1000)
const claimsOf = (who: Record<string, string>, extra: Record<string, unknown> = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: now() + 600, ...who, ...extra })
export const person = (email: string) => claimsOf({ email })
export const service = (id: string) => claimsOf({ common_name: id })

/** One call; a string `body` is sent as it is, to test a body that isn't JSON. */
export async function call(token: string | undefined, body: Record<string, unknown> | string, path = '/v1/owner/repo/7', headers: Record<string, string> = {}) {
  const res = await mf.dispatchFetch(`https://relay${path}`, {
    method: 'POST',
    headers: { ...(token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = { text }
  }
  return { status: res.status, json }
}

/** An admin edit of the grants: `adminToken` is a signed JWT. */
export const grant = (adminToken: string, principal: string, repo: string, preset: 'read' | 'operate') =>
  call(adminToken, { op: 'grant', principal, repo, preset }, '/v1/admin/grants')

/** The grants the tests of owner/repo start from: Adam and the Codex service operate, the reader reads. */
export async function seed(): Promise<void> {
  const adam = await sign(person(ADAM))
  await grant(adam, ADAM, 'owner/repo', 'operate')
  await grant(adam, CODEX, 'owner/repo', 'operate')
  await grant(adam, READER, 'owner/repo', 'read')
}

const source = (name: string): string => stripTypeScriptTypes(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
/** A test-only module, served beside the relay's: its `../src/` imports name the relay's modules where Miniflare serves them. */
const tested = (name: string): string => stripTypeScriptTypes(readFileSync(new URL(name, import.meta.url), 'utf8')).replaceAll("from '../src/", "from './")

/**
 * Starts the relay. `entry`, a file in this folder, becomes the main module in front of the relay's own: a test-only wrapper that imports
 * `../src/<name>` and re-exports the Worker and the object classes (request-count.test.ts counts requests this way).
 */
export async function start(bindings: Record<string, string> = {}, entry?: string): Promise<void> {
  team = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  stranger = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', team.publicKey)), kid: 'k1', alg: 'RS256' }
  mf = new Miniflare({
    modules: [
      ...(entry === undefined ? [] : [{ type: 'ESModule' as const, path: entry, contents: tested(entry) }]),
      ...['index.ts', 'auth.ts', 'grants.ts', 'lifecycle.ts', 'repo-index.ts', 'types.ts'].map(path => ({ type: 'ESModule' as const, path, contents: source(path) })),
    ],
    compatibilityDate: '2026-08-01',
    durableObjects: { LIFECYCLE: 'LifecycleObject', GRANTS: 'GrantStore', REPO_INDEX: 'RepoIndex' },
    bindings: {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ADMINS: ` ${ADAM.toUpperCase()} , ${CODEX}`,
      LEASE_MS: String(LEASE_MS),
      FILING_STALE_MS: String(FILING_STALE_MS),
      INDEX_RETRY_MS: String(INDEX_RETRY_MS),
      RETENTION_MS: String(RETENTION_MS),
      TEST_FAULTS: '1',
      ...bindings,
    },
    outboundService: req =>
      new URL(req.url).href === `https://${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('no', { status: 404 }),
  })
}

export async function stop(): Promise<void> {
  await mf.dispose()
}
