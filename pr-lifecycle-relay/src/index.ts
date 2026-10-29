// pr-lifecycle-relay: the shared lifecycle store (#29 Part B). `POST /v1/<owner>/<repo>/<pr>` with `{ "op": ... }`.
// The Worker verifies who is calling and hands the call to that PR's Durable Object, which checks the grant and does the work.

import { verifyAccess } from './auth.ts'
import type { Env } from './types.ts'

export { LifecycleObject } from './lifecycle.ts'

const NAME = /^[A-Za-z0-9_.-]{1,100}$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const [, version, owner, repo, pr] = url.pathname.split('/')
    if (request.method !== 'POST' || version !== 'v1' || !NAME.test(owner ?? '') || !NAME.test(repo ?? '') || !/^[1-9][0-9]{0,9}$/.test(pr ?? '')) {
      return new Response('not found', { status: 404 })
    }
    const who = await verifyAccess(request, env, Date.now())
    if (who === undefined) return new Response('unauthenticated', { status: 401 })
    const name = `${owner}/${repo}`.toLowerCase()
    const stub = env.LIFECYCLE.get(env.LIFECYCLE.idFromName(`${name}#${pr}`))
    // Only the verified principal reaches the object: any header of the same name the caller sent is replaced.
    const headers = new Headers({ 'content-type': 'application/json', 'x-relay-principal': JSON.stringify(who), 'x-relay-repo': name })
    return stub.fetch(new Request('https://lifecycle/', { method: 'POST', headers, body: await request.text() }))
  },
}
