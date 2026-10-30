// The relay client (#29 Part B): where a repo's shared lifecycle store is, the credential that reaches it, one call to it, and the
// secrets a checkout proves itself with. A repo opts in on its base branch (`sharedStore` in `.github/pr-gate.json`); the credential is
// the person's or service's own, from the environment, never from plugin options, and goes only to the relay the machine pinned
// (`PR_GATE_RELAY_URL`, final review I1). Only what keeps the relay from answering (a network
// error, a 5xx, a timeout, a body that isn't JSON) is `down`, the one case the caller may fall back to the local store (spec §8). A 401 or
// 403 is `refused`: a revoked or read-only principal is cut off on its next request (spec §10), never let fall back and keep acting.
//
// This file imports nothing of round.ts: store.ts will call it, and round.ts imports store.ts. That is why `baseFileOf` lives here.

import type { EngineInterface } from 'claude-code'

import { readRoster } from './github'

type Engine = EngineInterface

/** Where the relay is, the Access audience it sits behind, and the credential headers every call carries. */
export type Relay = { url: string; aud: string; headers: Record<string, string> }

/**
 * The relay's answer to one call: an answer (any status but 401, 403 and 5xx, as JSON), `refused` (401 or 403: the credential or the grant
 * says no), or `down` (no answer: a network error, a 5xx, a timeout, a body that isn't JSON).
 */
// The caller stands down on `refused` and never falls back: only `down` lets a lifecycle go on in the local store.
export type RelayAnswer = { status: number; json: Record<string, unknown> } | { refused: string } | { down: string }

/** Spec §8: a call the relay hasn't answered in 5 s is down. */
export const RELAY_TIMEOUT_MS = 5_000

/**
 * `.github/pr-gate.json` as the base has it (R67, `refs/remotes/origin/<base>`), never as the branch's own HEAD has it: a PR must not
 * loosen its own gate, add a bot to the trusted roster (R1-8) or lower its allowance. Read from the ref the last fetch left, with no
 * fetch of its own; a base with no such file, or no fetched ref, has none.
 */
export async function baseFileOf($: Engine, root: string, base: string): Promise<string | undefined> {
  if (base === '') return undefined
  // The remote-tracking ref by its full name (M4): a local tag or branch called origin/<base> would win over a bare origin/<base>.
  const ran = await $.process.run(['git', 'show', `refs/remotes/origin/${base}:.github/pr-gate.json`], { cwd: root, timeoutMs: 30_000 })
  return ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

/**
 * The relay for a branch to `base`, or why the lifecycle stays local. The repo opts in on its base, and the credential is a Cloudflare
 * Access service token (`PR_GATE_RELAY_CLIENT_ID` and `PR_GATE_RELAY_CLIENT_SECRET`) or a person's Access token (`PR_GATE_RELAY_TOKEN`).
 * A service token wins when both are set, and half of one is no credential.
 */
export async function relayOf($: Engine, root: string, base: string): Promise<Relay | { local: string }> {
  return relayAt($, await sharedStoreOf($, root, base))
}

/** Where the base says the shared store is (`sharedStore` in its `.github/pr-gate.json`), or undefined when it doesn't opt in. */
export async function sharedStoreOf($: Engine, root: string, base: string): Promise<SharedStore | undefined> {
  const file = await baseFileOf($, root, base)
  return file === undefined ? undefined : readRoster(file)?.sharedStore
}

export type SharedStore = { url: string; aud: string }

/** Why a base that opts in stays local: the environment has no credential for the relay. */
export const NO_CREDENTIAL = 'no relay credential'

/** Why a base that opts in stays local: the machine's pin (`PR_GATE_RELAY_URL`) is unset, or names another origin than the base's. */
export const NOT_PINNED = 'relay not pinned'

/** A URL's origin (scheme, host and port), or undefined for one that doesn't parse. */
const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * As `relayOf`, for a `sharedStore` already read: the credential comes from the environment each time. It goes only to the relay this
 * machine pinned (`PR_GATE_RELAY_URL`): the base's file is anyone's who can push to the base, and must never choose where a credential
 * is sent (final review I1). A pin unset or of another origin keeps the lifecycle local, and the reason names both origins, never a
 * credential.
 */
export async function relayAt($: Engine, shared: SharedStore | undefined): Promise<Relay | { local: string }> {
  if (shared === undefined) return { local: 'no sharedStore in .github/pr-gate.json' }
  const id = await $.env.get('PR_GATE_RELAY_CLIENT_ID')
  const secret = await $.env.get('PR_GATE_RELAY_CLIENT_SECRET')
  const token = await $.env.get('PR_GATE_RELAY_TOKEN')
  const headers: Record<string, string> | undefined =
    id !== undefined && id !== '' && secret !== undefined && secret !== ''
      ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
      : token !== undefined && token !== ''
        ? { 'cf-access-token': token }
        : undefined
  if (headers === undefined) return { local: NO_CREDENTIAL }
  const pin = await $.env.get('PR_GATE_RELAY_URL')
  const pinned = pin === undefined || pin === '' ? undefined : originOf(pin)
  const named = originOf(shared.url)
  if (pinned === undefined) return { local: `${NOT_PINNED}: PR_GATE_RELAY_URL is ${pin === undefined || pin === '' ? 'not set' : 'not a URL'}` }
  if (named !== pinned) return { local: `${NOT_PINNED}: the base names ${named ?? 'no valid URL'}, PR_GATE_RELAY_URL ${pinned}` }
  return { url: shared.url.replace(/\/+$/, ''), aud: shared.aud, headers }
}

/**
 * The path of one object: `#<pr>` is `/v1/<owner>/<repo>/<pr>`, `@<branch>` is `/v1/<owner>/<repo>/branch/<branch>`, the branch one
 * percent-encoded segment (a `/` or `%` in it stays inside it). `slug` is `owner/repo`.
 */
export function keyPath(slug: string, key: string): string {
  return key.startsWith('@') ? `/v1/${slug}/branch/${encodeURIComponent(key.slice(1))}` : `/v1/${slug}/${key.replace(/^#/, '')}`
}

/** What the relay answered, read: 401 and 403 are refused; the relay's own failures are down, as is anything but a JSON object. */
const answerOf = (res: { status: number; text: string }): RelayAnswer => {
  if (res.status === 401 || res.status === 403) return { refused: `HTTP ${res.status}` }
  if (res.status >= 500) return { down: `HTTP ${res.status}` }
  try {
    const json = JSON.parse(res.text) as unknown
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? { status: res.status, json: json as Record<string, unknown> } : { down: 'not JSON' }
  } catch {
    return { down: 'not JSON' }
  }
}

/** One call to the relay, `POST <url><path>` with `body` as JSON, raced against RELAY_TIMEOUT_MS. A late answer lands on nothing. */
export async function relayCall($: Engine, relay: Relay, path: string, body: Record<string, unknown>): Promise<RelayAnswer> {
  let settle: (answer: RelayAnswer) => void = () => undefined
  const timedOut = new Promise<RelayAnswer>(resolve => {
    settle = resolve
  })
  const timer = $.clock.after(RELAY_TIMEOUT_MS, () => settle({ down: 'timeout' }))
  const sent = $.http
    .fetch(`${relay.url}${path}`, { method: 'POST', headers: { ...relay.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(answerOf, (error: unknown) => ({ down: `network: ${error instanceof Error ? error.message : String(error)}` }))
  try {
    return await Promise.race([sent, timedOut])
  } finally {
    timer.cancel()
  }
}

/** Two random UUIDs, 72 characters: well past the relay's 32, and never guessed. */
const newSecret = (): string => crypto.randomUUID() + crypto.randomUUID()

/** The secret stored under `key`, made and saved once; undefined when it can't be saved, so it is never sent unsaved (spec §6). */
async function secretAt($: Engine, key: string): Promise<string | undefined> {
  const kept = await $.store.get(key)
  if (typeof kept === 'string' && kept !== '') return kept
  const secret = newSecret()
  try {
    await $.store.set(key, secret)
  } catch {
    return undefined
  }
  return secret
}

/** This session's lease capability: what proves a claim, beat, take or commit under the lease is this checkout's. */
export async function leaseSecret($: Engine): Promise<string | undefined> {
  return secretAt($, `relay-secret:${await $.session.id()}`)
}

/** The capability for this checkout's filing claims of one lifecycle: only it may finish them. */
export async function filingSecret($: Engine, root: string, lifecycleId: string): Promise<string | undefined> {
  return secretAt($, `relay-filing-secret:${root}:${lifecycleId}`)
}
