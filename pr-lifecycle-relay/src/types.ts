// The few Workers runtime types the relay uses, declared here so it needs no @cloudflare/workers-types.

export type Env = {
  /** The Access team's domain, e.g. `example.cloudflareaccess.com`: the JWT's issuer and where its keys are published. */
  ACCESS_TEAM_DOMAIN: string
  /** The Access application's AUD tag. */
  ACCESS_AUD: string
  /** The v1 grants, as JSON: `[{ "principal", "repo": "owner/name", "preset": "read" | "operate" }]`. */
  GRANTS?: string
  /** Comma-separated people who hold admin. */
  ADMINS?: string
  /** How long a lease lasts without a beat, in ms; R74's 2 minutes when unset. */
  LEASE_MS?: string
  LIFECYCLE: DurableObjectNamespace
}

export interface DurableObjectId {
  toString(): string
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(entries: Record<string, unknown>): Promise<void>
}

export interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>
}
