// Who may do what on which repository (#29 Part B, R104). One GrantStore object holds every grant and a capped history of who changed them.
// The Worker is its only caller: `grants`, `grant` and `revoke` come from the admin route after the Worker checked admin, and `presetOf` is the
// Worker's own lookup on every relay call. Nothing here is reachable from outside the Worker.

import type { Preset, Principal } from './auth.ts'
import { bodyOf, type DurableObjectState, type Env } from './types.ts'

export type Grant = { principal: string; repo: string; preset: Preset }

type Change = { actor: string; op: string; at: number; rev: number; grant: Grant | { principal: string; repo: string } }

type State = { rev: number; grants: Grant[]; history: Change[] }

const HISTORY_CAP = 500
const REPO = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export class GrantStore {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const body = await bodyOf(request)
    if (body === undefined) return reply(400, { error: 'body is not a JSON object' })
    const actor = (JSON.parse(request.headers.get('x-relay-principal') ?? 'null') as Principal | null)?.id ?? ''
    const s = (await this.state.storage.get<State>('state')) ?? { rev: 0, grants: [], history: [] }
    if (body.op === 'grants') return reply(200, s)
    const principal = typeof body.principal === 'string' ? body.principal.trim().toLowerCase() : ''
    const repo = typeof body.repo === 'string' ? body.repo.trim().toLowerCase() : ''
    if (principal === '' || !REPO.test(repo)) return reply(400, { error: 'a grant names one principal and one repo as owner/name' })
    const found = s.grants.find(one => one.principal === principal && one.repo === repo)
    if (body.op === 'presetOf') return reply(200, { preset: found?.preset ?? null })
    const write = async (op: string, grants: Grant[], grant: Change['grant']): Promise<Response> => {
      const rev = s.rev + 1
      const history = [...s.history, { actor, op, at: Date.now(), rev, grant }].slice(-HISTORY_CAP)
      await this.state.storage.put({ state: { rev, grants, history } })
      return reply(200, { rev })
    }
    if (body.op === 'grant') {
      if (body.preset !== 'read' && body.preset !== 'operate') return reply(400, { error: 'preset is read or operate' })
      const grant: Grant = { principal, repo, preset: body.preset }
      return write('grant', [...s.grants.filter(one => one !== found), grant], grant)
    }
    if (body.op === 'revoke') {
      if (found === undefined) return reply(404, { error: 'no such grant' })
      return write('revoke', s.grants.filter(one => one !== found), { principal, repo })
    }
    return reply(400, { error: `unknown op ${String(body.op)}` })
  }
}
