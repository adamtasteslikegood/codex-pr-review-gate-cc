// The few Workers runtime types the relay uses, declared here so it needs no @cloudflare/workers-types.

export type Env = {
  /** The Access team's domain, e.g. `example.cloudflareaccess.com`: the JWT's issuer and where its keys are published. */
  ACCESS_TEAM_DOMAIN: string
  /** The Access application's AUD tag. */
  ACCESS_AUD: string
  /** Comma-separated people who hold admin. */
  ADMINS?: string
  /** How long a lease lasts without a beat, in ms; R74's 2 minutes when unset. */
  LEASE_MS?: string
  /** How old a filing claim must be before the lease holder may adopt it, in ms; 30 minutes when unset. */
  FILING_STALE_MS?: string
  LIFECYCLE: DurableObjectNamespace
  /** The one GrantStore object (R104): who may read or operate on which repo. */
  GRANTS: DurableObjectNamespace
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
