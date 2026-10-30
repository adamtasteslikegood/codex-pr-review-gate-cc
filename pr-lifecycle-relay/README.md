# pr-lifecycle-relay

A prototype of the shared lifecycle store for pr-lifecycle (#29 Part B). It runs only under Miniflare, in tests. **Nothing is deployed**, and
no Cloudflare resource or Access application exists for it. pr-lifecycle does not call it yet.

## Shape

- `POST /v1/<owner>/<repo>/<pr>` with a JSON body `{ "op": ... }`.
- The Worker (`src/index.ts`) verifies the Cloudflare Access JWT in `Cf-Access-Jwt-Assertion` (`src/auth.ts`): RS256 against the team's
  published keys, then issuer, audience, `exp` and `nbf`. A person is their `email`; a service token is its `common_name`. A header value
  alone is never an identity.
- It hands the call to one Durable Object per `owner/repo#pr` (`src/lifecycle.ts`), which checks the grant, the lease and the revision in
  the same step that writes.

| Op | Needs | What it does |
| --- | --- | --- |
| `read`, `archives`, `filing` | `read` | The record, its revision and lease, the last write; the archives; one filing. |
| `commit` | `operate` | Writes the record if `rev` is current (else 409 with the current record) and no lease is live that the caller doesn't hold (else 423). `archive: { at, record }` keeps the record the caller archived (as the local store's `tx.archive` does), not the one stored. |
| `claim`, `beat`, `release` | `operate` | The lease. A new holder gets a higher public fence `token`. Its checkout makes its own `secret` (32 characters or more) and sends it with each call; the object keeps only its SHA-256 and never returns it. A live lease is renewed, beaten, released or written under only by the same principal with the same secret; a lapsed one is lost even to its holder. |
| `fileClaim`, `fileDone` | `operate` | The filing ledger. A second claim of a key finds the first. The claim takes the checkout's secret the same way: a retry with it answers `isMine: true`, so a lost answer is no dead end. Only the claimant finishes it; a done filing never changes. |
| `breakLease`, `fileDelete` | admin | Held by people listed in `ADMINS`, never by a service principal. |

Every write, a heartbeat included, records its principal. Principals, grants and admins are compared in lower case.

## Provisional

Adam's open decisions are filled in for the prototype only: a 2-minute lease (R74), the filing key `lifecycleId:findingId:attempt`,
20 archives per PR, and grants as JSON in the `GRANTS` variable.

## Checks

```bash
npm run test:relay       # node --test, the Worker under Miniflare
npm run typecheck:relay  # tsc -p pr-lifecycle-relay
```

`wrangler.jsonc` is for reference only.
