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

export async function call(token: string | undefined, body: Record<string, unknown>, path = '/v1/owner/repo/7', headers: Record<string, string> = {}) {
  const res = await mf.dispatchFetch(`https://relay${path}`, {
    method: 'POST',
    headers: { ...(token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token }), ...headers },
    body: JSON.stringify(body),
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

export async function start(bindings: Record<string, string> = {}): Promise<void> {
  team = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  stranger = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', team.publicKey)), kid: 'k1', alg: 'RS256' }
  mf = new Miniflare({
    modules: ['index.ts', 'auth.ts', 'grants.ts', 'lifecycle.ts', 'types.ts'].map(path => ({ type: 'ESModule', path, contents: source(path) })),
    compatibilityDate: '2026-08-01',
    durableObjects: { LIFECYCLE: 'LifecycleObject', GRANTS: 'GrantStore' },
    bindings: {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ADMINS: ` ${ADAM.toUpperCase()} , ${CODEX}`,
      LEASE_MS: String(LEASE_MS),
      FILING_STALE_MS: String(FILING_STALE_MS),
      ...bindings,
    },
    outboundService: req =>
      new URL(req.url).href === `https://${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('no', { status: 404 }),
  })
}

export async function stop(): Promise<void> {
  await mf.dispose()
}
