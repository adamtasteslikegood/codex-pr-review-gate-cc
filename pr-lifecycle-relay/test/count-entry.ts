// Test-only entry for request-count.test.ts: the relay's own Worker and objects, unchanged, each wrapped to count what it receives. The
// harness loads it as the main module in place of index.ts, so production code has no counter and no extra route. The counts live in this
// module's scope, which the Worker and its objects share under Miniflare (one isolate); `/__count` reads them and `/__reset` clears them.

import relay, { GrantStore as Grants, LifecycleObject as Lifecycle, RepoIndex as Index } from '../src/index.ts'
import type { Env } from '../src/types.ts'

type Counts = { worker: number; objects: Record<string, number> }
let counts: Counts = { worker: 0, objects: {} }
const hit = (name: string): void => {
  counts.objects[name] = (counts.objects[name] ?? 0) + 1
}

export class LifecycleObject extends Lifecycle {
  override async fetch(request: Request): Promise<Response> {
    hit('LifecycleObject')
    return super.fetch(request)
  }

  override async alarm(): Promise<void> {
    hit('LifecycleObject alarm')
    return super.alarm()
  }
}

export class GrantStore extends Grants {
  override async fetch(request: Request): Promise<Response> {
    hit('GrantStore')
    return super.fetch(request)
  }
}

export class RepoIndex extends Index {
  override async fetch(request: Request): Promise<Response> {
    hit('RepoIndex')
    return super.fetch(request)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/__count') return Response.json(counts)
    if (path === '/__reset') {
      counts = { worker: 0, objects: {} }
      return Response.json(counts)
    }
    counts.worker++
    return relay.fetch(request, env)
  },
}
