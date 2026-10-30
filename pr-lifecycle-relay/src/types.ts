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
  /** How long an object is kept after its PR's archive commit (a PR key) or its last write (a branch key), in ms; 90 days when unset. */
  RETENTION_MS?: string
  /** The first delay before an object retries its index update, in ms, doubled on each failure up to 5 minutes; 1000 when unset. */
  INDEX_RETRY_MS?: string
  /** `'1'` in tests only: opens `POST /v1/admin/index`, which faults a repo's index or sends it an update. Unset in wrangler. */
  TEST_FAULTS?: string
  LIFECYCLE: DurableObjectNamespace
  /** The one GrantStore object (R104): who may read or operate on which repo. */
  GRANTS: DurableObjectNamespace
  /** One RepoIndex object per `owner/repo` (spec §9): the repo's live records, for `list`. */
  REPO_INDEX: DurableObjectNamespace
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
  get<T>(keys: string[]): Promise<Map<string, T>>
  /** Several keys in one atomic step. */
  put(entries: Record<string, unknown>): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
  deleteAll(): Promise<void>
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

export interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>
}
