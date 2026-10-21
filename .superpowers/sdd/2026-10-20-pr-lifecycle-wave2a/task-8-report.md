# Task 8 report: no hold after a waiver (finding 29), post prompts list the standing, per-command batches

Status: DONE
Commits: `98f8b48` (implementation and tests), `ba79873` (one more resume case: a fix awaiting verification)

## What I implemented

- `tests/world.ts`: `onFetch?: () => void | Promise<void>`. The `fake` is now async and awaits `onFetch` on each `git fetch`. The `process.run` handler and the `w.engine` stand-in await it.
- `round.ts`, `endRound`: the guard comes first. It re-reads the run and returns when the run is gone, was replaced, or is no longer `running` (finding 29, R80).
- `round.ts`, `advance`: the post-waiver branch sits right after `isStillMine` and before `decideNext` and every dispatching branch (`startRound`, `startLateTriage`, `startAnswer`, `startRecheck`).
  - It applies when the phase is not `pre`, the PR is known, there's no security P1, and a post waiver covers `rec.head`.
  - It gathers the standing and sends `pr-gate: the person's post waiver covers PR #N at <sha>.` followed by `holdText(standing)`. Set-aside checks come only from `holdText`, so they aren't named twice.
- `round.ts`, `advance` post branch: `reportPrompt(saved, next, await gatherStanding(...))`.
- `core.ts`: `reportPrompt(rec, next, standing?)` and `heldPrompt(rec, why, nextStep, standing?)` (post branch only). Each appends `holdText(standing, ids already listed)` after the "What holds" block, and only when that text isn't empty.
- `round.ts` queue, as the brief gives it:
  - the `Queued` type, with `batch` and `isNote`;
  - a batch id per outermost `holdingPrompts`, whose flush sends only its own batch;
  - `mergeNotes`, exported;
  - `dropQueued(key)`, exported;
  - `say($, key, text, isNote = false)`.

  The doc comments on `RecordKey`, `deliver` and `say` are kept.

## TDD evidence

RED: `claude plugin test pr-lifecycle`, after the tests and before any implementation. Output saved in the scratchpad (`red.txt`):

```
(fail) R80: a waive post given while a round is finishing is followed by no hold and no new round   — Expected false, Received true
(fail) R80: after waive post, a resume says the waiver covers the head instead of sending the hold — Expected false, Received true ("stopped short of ready" sent)
(fail) R79: a post-PR hold prompt lists CI next to the findings — Expected containing "check check running"; the report had no CI
(fail) R80: after waive post, resume starts no triage for an open P2 ...  — Expected not "running", Received "running" (startAnswer ran)
(fail) R80: after waive post, resume starts no Codex recheck of a rebuttal ... — Expected length 1, Received length 2 (Codex spawned)
(fail) R80: after waive post, resume starts no review round owed ... — Expected not "running", Received "running" (startRound ran)
(fail) tests/round.test.ts: the file did not load — Export named 'mergeNotes' not found
 446 pass / 7 fail
```

On the first test before the fix, the late `endRound` recorded post round 2 and sent the ready prompt ("…1 pre-PR and 1 post-PR rounds…"). The brief's `'post-PR round'` substring caught that only by coincidence. So I added two direct assertions:
- no prompt says `ready for the merge decision`;
- the record holds no post-phase round.

GREEN: `claude plugin test pr-lifecycle` gives `454 pass, 0 fail` (the 446 existing tests plus 8 new). `npm run lint` and `npm run typecheck` are both clean, with no output beyond npm's notices.

Ablations, with the tree restored after each:
- **`endRound` guard disabled** (`void live`): only the first R80 test fails. The guard alone carries that test; `advance`'s waiver branch alone doesn't satisfy it.
- **`advance` waiver branch disabled** (`if (false && waived …)`): all 5 resume tests fail.

## Files changed

- `pr-lifecycle/hooks/round.ts`
- `pr-lifecycle/hooks/core.ts`
- `pr-lifecycle/tests/world.ts`
- `pr-lifecycle/tests/flow.test.ts`
- `pr-lifecycle/tests/round.test.ts` (new)

## Adaptations and why

1. **The brief's "fix awaiting verification" case.** `{ status: 'reported-fixed' }` doesn't reach `startRecheck`: `decidePost` returns `round` for a reported fix (`owed.length > 0`). I made two cases out of it:
   - a rebuttal Codex hasn't checked (`{ status: 'rebutted' }`). Its precondition is `next.recheck` equal to `['G1-1']`, and it reaches `startRecheck`;
   - the reported-fixed case, kept with the precondition `kind === 'round'`.
2. **Preconditions.** The finding cases build on `toAwaiting`, because a completed post round is needed or `decideNext` says `round`. The round case builds on `toPost`. Each asserts its precondition before the waiver:
   - `next.answer` or `next.recheck` equals `['G1-1']`;
   - or `kind === 'round'`.
3. **Separate tests, no labels.** Two `world(on)` in one test would register the same handlers twice. Each case is its own test through the `resumeAfterPostWaiver` helper.
4. **An extra assertion.** The resume tests also check `runOf(w).status !== 'running'`. A post round collects before it spawns anything, so a spawn count alone missed `startRound`.
5. **The first R80 test.** It records which fetch the waiver lands in and asserts `during === 'fetch --quiet origin'`. That fetch is `beginTriage`'s `fetchTwice` of the moved head; the other `fetchTwice` calls always name a branch.
6. **`heldPrompt` and the standing.** Both `heldPrompt` calls in `advance` are pre-PR, so the brief's "where `advance` calls `heldPrompt` for a post record" matched none. The only post-phase caller is `holdPost`, which now gathers and passes the standing. This adds one `gh pr checks` read (and the required-checks read) when a rebuttal check is held.
7. **Line length.** The `waived` line from the brief ran to about 175 columns, so I wrapped it.
8. **The R81 unit test** is in a new `tests/round.test.ts`.

## How the first R80 test's timing works

The test runs this sequence:
1. `toPost` starts the post run collecting.
2. It moves the PR head and the local head to `f…f`, sets `covers(f…f)` with the roster, and sets `isAncestor`.
3. `clock.advance(30_000)` runs `pollOnce`. It sees the new head (`onNewHead`), and collection is done because the head is covered.
4. `endCollect` finds the head covered and calls `beginTriage`.
5. `beginTriage` finds `got.prHead (f…f) !== rec.head (a…a)`, so it awaits `fetchTwice(['--quiet','origin'])`.

The now-async fake awaits `onFetch`, which runs the `waive post` command. The command takes the record, appends the waiver at `f…f`, and finishes the run as `waived`.

The fetch then returns, `git log` prints nothing, nothing is asked, and `beginTriage` calls `endRound`. The guard re-reads the run, finds it `waived` and returns, so no round is written and `advance` isn't called. `clock.advance(1000)` flushes the queue; the waiver command queued nothing.

## `endRound` caller audit

None of them calls `finish` before `endRound`, so I changed no order.

| Caller | What it does before `endRound` |
| --- | --- |
| `beginTriage` | `endRound(run)`, after the fetch and `git log` awaits. No finish. This is the window of finding 29. |
| `afterTriage` | Re-reads the run and bails if it isn't running, then calls `endRound`, so the guard is a second check here. No finish. |
| `afterRebuttalCheck`, no-verdict path | Logs, and on purpose doesn't `noteAttempt` or `finish`, then calls `endRound`. |
| `afterRebuttalCheck`, end | `endRound(after)` with a patched live run. No finish. |
| `afterReview`, pre-PR with nothing to fix | `endRound(after)`. No finish. |
| `afterFix` | `endRound(after)`. Its early returns that `finish` the run all `return` first. |
| `afterVerify` | `endRound(after)` when the fix holds or no verdict was read. No finish. |

`finish` happens inside `advance`, which `endRound` calls after the guard.

## Self-review and concerns

1. **The waiver head and `rec.head` can differ.** `advance` checks the waiver against `rec.head`. When the waiver lands in the window of finding 29, the late round records nothing, so `rec.head` stays at the old head while the waiver names the PR head `f…f`. A later `resume` then finds no waiver covering `rec.head`, and `decideNext` starts a round on the moved head. That's more review, not a hold, so the R80 tests pass, but the waived PR head gets reviewed again.
   - Possible fixes: the `waive post` command could also set `rec.head` to the PR head, or `advance` could read the PR head.
   - I left it alone because it's outside this brief (`register.tsx`). The controller should decide.
2. **A new session re-sends the waiver message.** A waived post record keeps `postStatus` undefined. Each new interactive session's `advance` (`register.tsx`, session start) therefore sends "the person's post waiver covers…" again. That beats the old round or hold. Spec §1's "only if the command hasn't already sent it" is Task 9's to settle.
3. **An exhausted post report says its reason twice.** `standingOf` adds a `head-unreviewed` blocker whose `said` is `next.why`, and `reportPrompt` already leads with `next.why`. So the prompt says it twice, the second time under "Also holding:". No test asserts on that prompt's shape. Note it for Task 9 or the spec.
4. **`holdPost` reads gh more.** It now makes one or two more reads per held rebuttal check. A failed read shows as a `ci-unreadable` blocker in the prompt and doesn't throw.
5. **`dropQueued` isn't called yet.** Task 9 wires it into stop and reset, as planned.
