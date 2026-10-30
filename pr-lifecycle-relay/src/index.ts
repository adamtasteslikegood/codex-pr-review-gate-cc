// pr-lifecycle-relay: the shared lifecycle store (#29 Part B). `POST /v1/<owner>/<repo>/<pr>` with `{ "op": ... }`.
// The Worker verifies who is calling, looks up that principal's preset on the repo in the GrantStore, and hands the call to that PR's
// Durable Object, which checks the preset and does the work. `POST /v1/admin/grants` edits the grants (admin only).

import { isAdmin, verifyAccess, type Principal } from './auth.ts'
import type { Env } from './types.ts'

export { GrantStore } from './grants.ts'
export { LifecycleObject } from './lifecycle.ts'

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const ADMIN_GRANT_OPS = ['grants', 'grant', 'revoke']

/** A branch name `git check-ref-format --branch` would accept, in 1 to 255 UTF-8 bytes (R103). */
export const isBranchName = (name: string): boolean => {
  const bytes = new TextEncoder().encode(name).length
  if (bytes < 1 || bytes > 255) return false
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (name === '@') return false
  return !/^[-/]|[/.]$|\.lock$/.test(name) && name.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'))
}

const refuse = (status: number, text: string): Response => new Response(text, { status })

/** An internal call: only headers the Worker built itself reach an object, never the caller's. */
const internal = (who: Principal, body: string, extra: Record<string, string> = {}): Request =>
  new Request('https://internal/', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'x-relay-principal': JSON.stringify(who), ...extra }),
    body,
  })

const grantStore = (env: Env) => env.GRANTS.get(env.GRANTS.idFromName('grants'))

async function adminGrants(request: Request, env: Env, who: Principal): Promise<Response> {
  if (!isAdmin(env, who)) return refuse(403, `${who.id} is not an admin`)
  const text = await request.text()
  let op: unknown
  try {
    op = (JSON.parse(text) as { op?: unknown }).op
  } catch {
    return refuse(400, 'body is not JSON')
  }
  if (typeof op !== 'string' || !ADMIN_GRANT_OPS.includes(op)) return refuse(400, `unknown op ${String(op)}`)
  return grantStore(env).fetch(internal(who, text))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/')
    const [, version, owner, repo, pr] = parts
    const isAdminGrants = url.pathname === '/v1/admin/grants'
    if (request.method !== 'POST') return refuse(404, 'not found')
    // `/v1/<owner>/<repo>/branch/<branch>`: the branch is one percent-encoded segment, decoded once and checked as git would.
    let branch: string | undefined
    if (!isAdminGrants && pr === 'branch') {
      if (parts.length !== 6) return refuse(404, 'not found')
      try {
        branch = decodeURIComponent(parts[5] ?? '')
      } catch {
        return refuse(404, 'not found')
      }
      if (!isBranchName(branch)) return refuse(404, 'not found')
    }
    const isShapeOk = branch !== undefined || /^[1-9][0-9]{0,9}$/.test(pr ?? '')
    if (!isAdminGrants && (version !== 'v1' || !NAME.test(owner ?? '') || !NAME.test(repo ?? '') || !isShapeOk)) {
      return refuse(404, 'not found')
    }
    const who = await verifyAccess(request, env, Date.now())
    if (who === undefined) return refuse(401, 'unauthenticated')
    if (isAdminGrants) return adminGrants(request, env, who)
    const name = `${owner}/${repo}`.toLowerCase()
    const asked = await grantStore(env).fetch(internal(who, JSON.stringify({ op: 'presetOf', principal: who.id, repo: name })))
    if (!asked.ok) return refuse(502, 'grant lookup failed')
    const { preset } = (await asked.json()) as { preset: string | null }
    const key = branch !== undefined ? `@${branch}` : `#${pr}`
    const stub = env.LIFECYCLE.get(env.LIFECYCLE.idFromName(`${name}${key}`))
    // Only what the Worker computed reaches the object: a header of the same name the caller sent is never copied.
    return stub.fetch(internal(who, await request.text(), { 'x-relay-repo': name, 'x-relay-preset': preset ?? '', 'x-relay-key': key }))
  },
}
