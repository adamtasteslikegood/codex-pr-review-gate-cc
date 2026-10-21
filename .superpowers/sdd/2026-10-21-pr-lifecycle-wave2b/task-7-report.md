# Task 7 report: one finding per problem (R90, spec §3)

Status: DONE_WITH_CONCERNS. Commits: 669fa51 (Steps 1-5 and 5a, plus the loop ruling), f022ed6 (fix: a linked item counts as processed).

## Changes per file

- `types/index.d.ts`: `Finding.duplicateOf`, `linkBy`, `isLinkChecked`; `FindingEvent.refusedLink` (the refusal record for the loop ruling);
  `Blocker.kind` gets `'link-unchecked'`.
- `hooks/lifecycle.ts`:
  - `triage` now compares with every finding, open ones included, and links to the original (`duplicateOf ?? id`). A3: R33 (`isAnswerTo`)
    and `needsRecheck` are read on both the candidate and its original. `ANSWERED` was removed because nothing reads it now.
  - New helpers: `isLinked`, `isLinkOwed`, `linkTo`, `dropLink`, `refuseLink`, `withLinkedPeak` (A1: it carries security too, even when
    a peak is unknown), `alsoOf`, `LinkProposal` and `applyLinks`.
    - `applyLinks` is the A2 validator over the whole batch. It drops a link whose id or target is not on the list, and a link to an
      original Codex refused before (compared through `canon()`, so a link to an alias of that original is refused too). It then drops
      every proposed link on a cycle, including self-links. It repeats this until nothing is cyclic, because restoring a rejected
      finding's existing edge could close a new cycle.
    - The links that survive point at their final root. Aliases of an original that was linked again are re-pointed in the same
      result. Only the links made in that call raise their original's peak and security.
  - `isChargedRound` leaves out linked findings (`duplicateOf !== undefined`) and any Codex event that carries `refusedLink`.
  - `mergeHolds` leaves out `isLinked`. `checksOwed` adds `isLinkOwed`.
  - `blockerOf(f, also)` shows "G2-1 (also G2-2)". A `link-unchecked` blocker is owned by Codex, and `standingOf` passes `alsoOf`.
  - `decidePost` adds link-owed items to `unchecked`, and adds a "Codex has not checked the link of …" line and the 'the link' kind word.
    Link-owed items are left out of `open`, `deferred`, `lowered`, `answered` and `reverify`.
  - Beyond the brief: `unresolvedBlockers` and `verificationOwed` also leave out `isLinked`, following §3.2 ("holds while the original
    holds", listed once). No test covers this directly.
- `hooks/core.ts`:
  - `readTriage` skips rows that have `duplicateOf`, and `TriageAnswer` no longer has the field. New `LinkAnswer` and `readLinks`.
  - `triagePrompt`: the duplicate wording, the "same problem as G2-1" line, the new step-2 sentence and the second trailer example row.
  - `verifyPrompt`: a links section ("Same as: …"). Links are left out of argued, reported and fixes.
- `hooks/round.ts`:
  - `beginTriage` triages against the batch so far as well. A gate match becomes `linkTo(…, 'gate')`, and the original's peak is raised
    in the batch (`fresh`) or in the ledger (`raised`, merged into the run and into `carried`). The changed-file base is looked up in
    the batch too.
  - `afterTriage` reads the links and runs `applyLinks` over the record merged with the run. The findings it changed join the run, so a
    finding only the record holds is updated too.
    - An item answered on its own has its link dropped with `dropLink` before `applyAnswer`. That is how the agent refuses the gate's link.
    - Accepted links count as answers: their reply ids are recorded in `replies`, and they are excluded from `unanswered`.
    - `processed` uses `status !== 'open' || duplicateOf !== undefined`, as the brief says (fixed in f022ed6, see Self-review).
  - `afterRebuttalCheck` checks the `isLinkOwed` branch first. If Codex agrees, the link gets `isLinkChecked: true`. If Codex refuses,
    `refuseLink` runs.

## Where I placed things differently from the brief

There is no disagreement with the spec, only placement details:

- In `afterRebuttalCheck`, the `isLinkOwed` branch comes first, not "before isLoweringOwed". `linkTo` keeps `f.status`, so a
  `reported-fixed` item the agent linked would otherwise reach the fix-verdict branch.
- `verifyPrompt` leaves links out of `reported` and `fixes` as well as `argued`, so no item is listed twice.
- `decidePost`'s `open` filter leaves out link-owed items. Without that, brief test 3 got `answer` instead of `recheck`.

## Loop ruling (the gate can't get stuck)

The refusal is recorded as `FindingEvent.refusedLink` (the canonical original) on Codex's `open` event, which `refuseLink` writes. A
later proposal from that item to the same canonical id, directly or through an alias, is dropped by `applyLinks`. The item then stays
unanswered and is asked again under the existing `hasReprompted` bound. `isChargedRound` skips the refusal event, so a refused link is
never charged, even when the item had a rebuttable status before.

Pinned by the lifecycle test "R90: a link Codex refused is recorded, charges nothing, and linking there again is no answer". The flow
test for self-links shows the re-ask path.

## Existing tests I adapted, each against spec §3

1. `lifecycle.test.ts` "the triage answer carries dispositions, severities, reply ids and duplicates". The G3-2 row has `duplicateOf`,
   so it is now a link whatever its action (§3.3, the brief's ruling). The test now expects `readTriage` to return G3-1 only, and
   `readLinks` to return G3-2 with its reply id.
2. `flow.test.ts` "R33: in the protected round, a comment on the lines just fixed is not called a duplicate". The class wording
   changed (§3.1). It asserted `not.toContain('duplicate of an answered finding')` and now asserts `not.toContain('same problem as G2-1;')`,
   the item-line form. A bare 'same problem as' would match the new step-2 instruction text.

No flow test setup needed changing (no `w.gh.required` changes). The settings test "a roster on the base is used…" timed out at 5 s
once, in the first full run. It passed at 3.5 s on the rerun and in every run after. It is unchanged; the cause is machine load (§7.3).

## New tests

- Brief, `lifecycle.test.ts` (4): linking to open findings and no chains; holds and settles with the original, "(also …)", peak; the
  agent's link waits for Codex at no cost; a `duplicateOf` row is a link.
- Brief, `flow.test.ts` (2): the gate's link, a pointer reply, one hold; the agent refuses the gate's link by answering on its own.
- A1, "R90 A1: a link carries security to the original, both ways, and nothing clears it". A non-security P3 deferral, settled by its
  issue, gets a security duplicate. It becomes security, stops settling (`isSettledDeferral` false), still holds in `mergeHolds`, and is
  owned by the person. `dropLink` keeps it security, an unknown peak keeps it security, and a security original stays security
  (`withLinkedPeak` and `applyLinks`).
- A2, "R90 A2: … no self-link, no cycle, no chain":
  - B linked to A, and `A dup B`: no answer, both unchanged, A holds.
  - Self-links and unknown ids: no answer.
  - B linked to A, and `A dup C`: A and B both point at C, as the agent's, and are owed a check.
  - `A dup C` with `C dup A`: neither applied, both hold, no link check owed.
  - A three-finding cycle: none applied.
  - A→C→D: both point at D.
  - The gate's own link confirmed: unchanged, and counted as answered.
- A3, "R90 A3: R33 is read on a candidate's original": A's rebuttal is accepted, B is linked to A and open, and a later objection C
  that matches B is `new-on-reviewed`. Before the rebuttal it is a duplicate of A. A recheck on A also keeps it new.
- Loop ruling, unit: as above.
- Flow, "R90: the agent's link goes to Codex at no round's cost; a self-link is no answer and the item is asked again":
  - A self-link gets the reprompt.
  - The agent's link reaches Codex's check ("Same as: G2-1"), and Codex agrees: `isLinkChecked`, reply recorded, no holds.
  - No charged round.

## Checks

- `npm run test`: codex-gate 22/22, pr-lifecycle 555/555. That is 11 new tests: 4 brief lifecycle, 2 brief flow, 4 lifecycle tests for
  A1-A3 and the loop ruling, and 1 flow.
- `npm run lint`: 0 problems.
- `npm run typecheck`: 0 errors.

## Self-review

- First commit: `processed` used `linked.includes(f.id)` in place of the brief's `duplicateOf !== undefined`. A gate-linked item the
  agent never answered would never be processed, and would be listed again as fresh feedback every round. f022ed6 restores the
  brief's predicate (spec §1.1: fresh feedback is "not linked to a finding"). No test catches the difference, because both brief flow
  tests answer G2-2 by its link.
- A1: `isFileable` (Task 12) is not built yet. When it is, add `expect(isFileable(raised)).toBe(false)` to the A1 test, next to the
  `isSettledDeferral` and `mergeHolds` assertions.

## Concerns (each with its cost if wrong)

1. `applyLinks` raises the original's peak and security on an unchecked agent link, as the brief says. A link Codex later refuses leaves
   them raised. This fails closed: at worst the original is labelled higher, or waits for the person because of security.
2. Aliases re-pointed by an agent link become `linkBy: 'agent'` and unchecked, so Codex checks them too. That was my choice, and it
   fails closed. Cost: an extra check verdict per alias.
3. `refuseLink` reopens the item whatever its earlier status (§3.4, "asked about again"). An item reported fixed, then linked by the
   agent, then refused, loses its fix report, and the agent answers it again.
4. `triage`'s canonical resolution also follows an unchecked agent link. A gate match on a link-owed candidate links the new item to
   the agent's unconfirmed target. If Codex then refuses that link, the new item still points at that target, the wrong original. It
   holds with that original, so it could settle with the wrong finding.
5. The history event for an agreed link reuses `f.status`. For a `rebutted` item, that event reads as `isAcceptedRebuttal`. This has
   no effect while the item stays linked (`mergeHolds` leaves it out), and the only ways a link is dropped add a later event.
6. A finding only the record holds, which a link moves or raises, joins the run through `changed` in `afterTriage`. The run's ledger
   can therefore grow by such findings. This is harmless, since the record is merged from the run.
