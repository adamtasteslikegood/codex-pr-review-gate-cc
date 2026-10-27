# Persisted lifecycle filing identity — issue #29, local increment

Status: proposed for owner review. No implementation in this document.

## Intent and owner direction

Shared tooling in `codex-pr-review-gate-cc`, usable across Adam's projects, with
Plaza as the first consumer. Build the local identity component first, then
evaluate a shared Cloudflare Durable Object store. This is the A-then-B sequence
already described in GitHub issue #29; it does not replace Plaza's separate
DomainSessionStore or introduce a new standalone Python/SQLite service.

The local increment fixes a concrete correctness failure: two checkouts can
produce the same finding ordinal, PR number and generation. After a lost POST
answer, the second checkout can adopt and edit the first checkout's unrelated
issue. Generating an ID on each retry would merely change the failure.

## Approaches and selected sequence

- **A: persisted random lifecycle UUID**, using the existing TypeScript record
  and plugin store. Small correctness fix, no network dependency. This is the
  local-first direction requested by Adam and recommended in issue #29.
- **B: shared DO-backed lifecycle/filing ledger**, following A. Coordinates
  checkouts/machines, claims and driver leases. Requires its own auth, offline,
  concurrency, crash recovery and migration design/evidence.
- **C: GitHub comment/check-run claims**. Avoids new hosting, but does not provide
  an atomic cross-checkout claim; not proposed as a replacement for B.

## Local contract

1. Mint a random UUID for each fresh lifecycle, including a fresh PR adoption or
   reset. Persist it in `LifecycleRecord.lifecycleId` before any external filing.
   Reuse existing platform randomness; do not invent a central counter/service.
2. Ordinary stop/resume, session takeover, retries, changed heads and repeated
   reads retain that lifecycle's UUID. Archival retains the original record's
   identity and issue associations; a later fresh lifecycle gets a different ID.
3. Existing version-1 records without an ID are migrated through the existing
   serialized store update, durably saved before filing can proceed. A failed
   identity save permits no issue POST. Pure formatting functions never mint IDs.
4. New filing mark: `<!-- pr-gate filing: <finding-id> of #<pr> lc <uuid> -->`.
   Lost-answer adoption requires an exact mark match, including the lifecycle
   UUID. The existing finding ordinal remains useful for display, but is scoped
   by the UUID for external identity.
5. Generation-less marks and `gen <n>` marks are never adopted, including through
   a matching-title fallback. Existing truly unmarked issues retain the current
   title fallback, as specified by issue #29. Do not retitle an unrelated marked
   issue. Leave existing external issues intact; do not rewrite historical marks.
6. Preserve existing filing dispositions, security/Jira routing, generation
   cancellation checks, review budgets, owner takeover and archive behavior.
   The frozen `codex-gate/` component is outside this change.

## Verification

- Two distinct checkout roots, same repo/PR/finding ordinal/generation, shared
  simulated GitHub: the second filing/retry never adopts or edits the first
  checkout's issue.
- A lost response after issue creation reuses the same exact UUID mark on retry,
  rather than creating a duplicate or minting another identity.
- Re-read/restart preserves a persisted ID; fresh/reset lifecycle changes it;
  archived history keeps the prior one.
- Legacy record migration saves before external filing; save failure sends no
  POST; old-format marked issues cannot be adopted by title.
- Existing unmarked title fallback and post-merge follow-up checks still work.
- Run the repository's actual lint, test, validate and typecheck gates. Do not
  replace its plugin harness with an invented adapter and call that equivalent.

Preflight: the cloud PATH has no `claude`; the Plaza SDK's bundled CLI supports
plugin validation but its help does not expose this repo's `claude plugin test`
command. The actual plugin-test harness and generated types must be made
available or reported as a verification blocker; no passing suite is claimed.

## What this does not promise

A fixes cross-checkout *identity collisions*, not a shared lifecycle or exclusive
driver across machines. Existing local records remain local. It does not supply
an atomic remote issue-create transaction, exactly-once GitHub/Jira effects, a
DO deployment, or centralized session synchronization. Those belong to B.

## Next design: shared Durable Object state

Start B's evaluation in this repo behind the existing store boundary, keeping
the local lifecycle IDs. Candidate scope: one DO per canonical `owner/repo#pr`,
atomic versioned state/claims, an exclusive driver lease, retained filing results
and authenticated clients. A claim written before a POST does not by itself
solve a crash after the POST: exact-marker reconciliation is still required.
Decide lease fencing, retry identity, offline holds/fallback, authentication,
retention and migration before production use. Exercise live usage and compare
it with the prepaid Workers plan; hypothetical costs are not a reason to block
the bounded experiment. No cloud deployment is authorized by this local design.
