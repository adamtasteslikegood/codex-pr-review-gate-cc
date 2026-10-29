// Who is calling (#29 Part B, "Identity and access"). A principal comes only from a Cloudflare Access JWT whose signature, issuer,
// audience and validity times check out against the team's published keys. A header value alone is never an identity.

import type { Env } from './types.ts'

export type Principal = { id: string; isService: boolean }

/** What a principal may do on one repository: `read` (records, history, the filing ledger) or `operate` (also lease and mutate). */
export type Preset = 'read' | 'operate'

export type Grant = { principal: string; repo: string; preset: Preset }

const b64url = (text: string): Uint8Array<ArrayBuffer> => {
  const base = text.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base + '='.repeat((4 - (base.length % 4)) % 4))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

const json = (bytes: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>

type Jwk = JsonWebKey & { kid?: string }

/** The team's signing keys, from Access's certs endpoint; cached for the isolate's life, refetched once on an unknown `kid`. */
let cached: { url: string; keys: Jwk[] } | undefined

async function keysOf(url: string, isFresh: boolean): Promise<Jwk[]> {
  if (!isFresh && cached?.url === url) return cached.keys
  const res = await fetch(url)
  if (!res.ok) return []
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? []
  cached = { url, keys }
  return keys
}

/** The principal of a verified Access JWT, or undefined: missing, malformed, badly signed, wrong issuer or audience, or out of date. */
export async function verifyAccess(request: Request, env: Env, now: number): Promise<Principal | undefined> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (token === null) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = json(b64url(parts[0]))
    claims = json(b64url(parts[1]))
  } catch {
    return undefined
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return undefined
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`
  let key = (await keysOf(`${issuer}/cdn-cgi/access/certs`, false)).find(one => one.kid === header.kid)
  key ??= (await keysOf(`${issuer}/cdn-cgi/access/certs`, true)).find(one => one.kid === header.kid)
  if (key === undefined) return undefined
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  let isSigned = false
  try {
    const verifier = await crypto.subtle.importKey('jwk', key, algorithm, false, ['verify'])
    isSigned = await crypto.subtle.verify(algorithm, verifier, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    return undefined
  }
  if (!isSigned) return undefined
  const aud = claims.aud
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (claims.iss !== issuer || !audiences.includes(env.ACCESS_AUD)) return undefined
  const seconds = now / 1000
  if (typeof claims.exp !== 'number' || claims.exp <= seconds) return undefined
  if (typeof claims.nbf === 'number' && claims.nbf > seconds) return undefined
  // A person signs in with an email; a service token carries its client id as common_name.
  if (typeof claims.email === 'string' && claims.email !== '') return { id: claims.email, isService: false }
  if (typeof claims.common_name === 'string' && claims.common_name !== '') return { id: claims.common_name, isService: true }
  return undefined
}

/** The v1 grants, from the Worker's configuration (decision 5 still open: where they live for good). */
export const grantsOf = (env: Env): Grant[] => {
  try {
    const read = JSON.parse(env.GRANTS ?? '[]') as unknown
    return Array.isArray(read) ? (read as Grant[]).filter(one => one.preset === 'read' || one.preset === 'operate') : []
  } catch {
    return []
  }
}

/** Admin is a capability of its own, held only by people (never a service principal), and never implied by `operate`. */
export const isAdmin = (env: Env, who: Principal): boolean =>
  !who.isService &&
  (env.ADMINS ?? '')
    .split(',')
    .map(one => one.trim())
    .includes(who.id)

export const presetOf = (env: Env, who: Principal, repo: string): Preset | undefined => {
  const mine = grantsOf(env).filter(one => one.principal === who.id && String(one.repo).toLowerCase() === repo)
  return mine.some(one => one.preset === 'operate') ? 'operate' : mine.length > 0 ? 'read' : undefined
}
