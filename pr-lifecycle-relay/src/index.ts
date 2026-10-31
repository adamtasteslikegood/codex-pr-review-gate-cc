// pr-lifecycle-relay: the shared lifecycle store (#29 Part B). `POST /v1/<owner>/<repo>/<pr>` with `{ "op": ... }`.
// The Worker verifies who is calling, looks up that principal's preset on the repo in the GrantStore, and hands the call to that PR's
// Durable Object, which checks the preset and does the work. `POST /v1/<owner>/<repo>` with `{ "op": "list" }` reads the repo's index (needs
// read). `POST /v1/admin/grants` edits the grants (admin only). The owner `admin` is reserved: `/v1/admin/...` never reaches a repo.

import { isAdmin, verifyAccess, type Principal } from './auth.ts'
import type { Env } from './types.ts'

export { GrantStore } from './grants.ts'
export { LifecycleObject } from './lifecycle.ts'
export { RepoIndex } from './repo-index.ts'

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const ADMIN_GRANT_OPS = ['grants', 'grant', 'revoke']
const ADMIN_INDEX_OPS = ['fault', 'update']
const REPO = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/

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
const repoIndex = (env: Env, repo: string) => env.REPO_INDEX.get(env.REPO_INDEX.idFromName(repo))

/** The body as JSON, or undefined when it is not a JSON object. */
const parse = (text: string): { op?: unknown; [key: string]: unknown } | undefined => {
  try {
    const body = JSON.parse(text) as unknown
    return typeof body === 'object' && body !== null ? (body as { op?: unknown }) : undefined
  } catch {
    return undefined
  }
}

async function adminGrants(request: Request, env: Env, who: Principal): Promise<Response> {
  if (!isAdmin(env, who)) return refuse(403, `${who.id} is not an admin`)
  const text = await request.text()
  const body = parse(text)
  if (body === undefined) return refuse(400, 'body is not JSON')
  if (typeof body.op !== 'string' || !ADMIN_GRANT_OPS.includes(body.op)) return refuse(400, `unknown op ${String(body.op)}`)
  return grantStore(env).fetch(internal(who, text))
}

/** Test-only (`TEST_FAULTS` is '1'): fault a repo's index, or send it an update as an object would, delayed or not. */
async function adminIndex(request: Request, env: Env, who: Principal): Promise<Response> {
  if (!isAdmin(env, who)) return refuse(403, `${who.id} is not an admin`)
  const body = parse(await request.text())
  if (body === undefined) return refuse(400, 'body is not JSON')
  if (typeof body.op !== 'string' || !ADMIN_INDEX_OPS.includes(body.op)) return refuse(400, `unknown op ${String(body.op)}`)
  const { repo, ...rest } = body
  const name = typeof repo === 'string' ? repo.toLowerCase() : ''
  if (!REPO.test(name)) return refuse(400, 'repo is owner/name')
  return repoIndex(env, name).fetch(internal(who, JSON.stringify(rest)))
}

/** `/v1/admin/...`: only the admin routes, each after the caller is verified. Anything else there is 404, never a repo named `admin/...`. */
async function admin(request: Request, env: Env, path: string): Promise<Response> {
  const route = path === '/v1/admin/grants' ? adminGrants : path === '/v1/admin/index' && env.TEST_FAULTS === '1' ? adminIndex : undefined
  if (route === undefined) return refuse(404, 'not found')
  const who = await verifyAccess(request, env, Date.now())
  if (who === undefined) return refuse(401, 'unauthenticated')
  return route(request, env, who)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/')
    const [, version, owner, repo, pr] = parts
    if (request.method !== 'POST') return refuse(404, 'not found')
    if (version === 'v1' && owner?.toLowerCase() === 'admin') return admin(request, env, url.pathname)
    const isList = parts.length === 4
    // `/v1/<owner>/<repo>/branch/<branch>`: the branch is one percent-encoded segment, decoded once and checked as git would.
    let branch: string | undefined
    if (pr === 'branch') {
      if (parts.length !== 6) return refuse(404, 'not found')
      try {
        branch = decodeURIComponent(parts[5] ?? '')
      } catch {
        return refuse(404, 'not found')
      }
      if (!isBranchName(branch)) return refuse(404, 'not found')
    }
    const isShapeOk = isList || branch !== undefined || /^[1-9][0-9]{0,9}$/.test(pr ?? '')
    if (version !== 'v1' || !NAME.test(owner ?? '') || !NAME.test(repo ?? '') || !isShapeOk) return refuse(404, 'not found')
    const who = await verifyAccess(request, env, Date.now())
    if (who === undefined) return refuse(401, 'unauthenticated')
    const name = `${owner}/${repo}`.toLowerCase()
    const asked = await grantStore(env).fetch(internal(who, JSON.stringify({ op: 'presetOf', principal: who.id, repo: name })))
    if (!asked.ok) return refuse(502, 'grant lookup failed')
    const { preset } = (await asked.json()) as { preset: string | null }
    if (isList) {
      // The repo route takes `list` only: an index update comes from an object inside the Worker, never from a caller.
      if (parse(await request.text())?.op !== 'list') return refuse(400, 'the repo route takes { "op": "list" } only')
      if (preset !== 'read' && preset !== 'operate') return refuse(403, `${who.id} may not list ${name}`)
      return repoIndex(env, name).fetch(internal(who, JSON.stringify({ op: 'list' }), { 'x-relay-repo': name, 'x-relay-preset': preset }))
    }
    const key = branch !== undefined ? `@${branch}` : `#${pr}`
    const stub = env.LIFECYCLE.get(env.LIFECYCLE.idFromName(`${name}${key}`))
    // Only what the Worker computed reaches the object: a header of the same name the caller sent is never copied.
    return stub.fetch(internal(who, await request.text(), { 'x-relay-repo': name, 'x-relay-preset': preset ?? '', 'x-relay-key': key }))
  },
}
