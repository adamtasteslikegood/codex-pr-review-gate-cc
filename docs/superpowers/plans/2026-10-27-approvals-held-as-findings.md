# Investigation: approvals held as P1/P2 findings (discussion #15, items 30, 32, 33)

2026-10-27. Read-only investigation of pr-lifecycle 1.5.0. No code changed.

Symptom, in Adam's words (discussion #15, items 30 and 33): reviews whose
conclusion is "no blocking findings" or "no changes needed" are triaged as
findings, rated P1, flagged security, refuse the `acknowledged` answer the
round's own prompt offers, hold the merge until a person-only waiver, and after
the merge either keep the lifecycle open as an unticketed security hold or get
filed as public `severity:P2` "Major" issues whose bodies say "answered as P3".

## Reproduction

`isNoAction` and `severityHint` from `pr-lifecycle/hooks/github.ts` were run
over the real review and comment JSON of the three cited cookbook PRs
(`gh api repos/.../pulls/{3785,3748,3749}/reviews` and `/issues/{...}/comments`).

**`isFinding` was `true` for all 46 non-empty items.** Many of those should be
findings (the Codex summaries, "Junie is failed!"), so the count alone is not
the claim. The claim is the table: all eight approvals Adam named classified as
findings, five of them as security P1.

| PR | item | kind | verdict |
|----|------|------|---------|
| 3785 | `## Review: no blocking findings` (G3-1) | review COMMENTED | finding, **P1, security** |
| 3785 | `## Follow-up review: no blocking findings remain` | review COMMENTED | finding, **P1, security** |
| 3785 | claude[bot] `No changes needed on this delta.` (G3-5) | issue comment | finding, **P1, security** |
| 3785 | junie `Ready to merge; no actionable issues were found.` | issue comment | finding, P2 |
| 3748 | `No blocking findings.` (G2-1) | review COMMENTED | finding, **P1, security** |
| 3748 | claude[bot] `No changes needed — reviewed the diff …` (G2-3) | issue comment | finding, **P1, security** |
| 3749 | `No blocking findings remain at 8dba6cb.` | review COMMENTED | finding, P2 → issue #3786 |
| 3749 | claude[bot] `No changes needed in the delta …` | issue comment | finding, P2 → issue #3787 |

The agent's own acknowledgement replies are also flagged `isFinding` by the
mapper (item 25's shape). Whether R91's `ownReplies` filter drops them further
down the pipeline was not traced; item 25 is out of scope here.

## Root cause: five independent breakpoints

Each one alone produces a symptom. They compound.

### 1. `isNoAction` never runs on comments — `hooks/github.ts:107`

`isFinding` consults `isNoAction` only in `readReviews`. `readInlineComments`
(`github.ts:120`) and `readIssueComments` (`github.ts:138`) set
`isFinding: body.trim() !== ''`. The Independent Claude review and the Codex
status note arrive as **issue comments**, so no wording could ever settle them.
`isNoAction` also returns `false` for an undefined `state`, so even if it were
called there it would refuse every comment.

### 2. `SETTLES` is too literal — `hooks/github.ts:260-264`

```
^no (?:actionable|blocking) (?:findings|issues|comments)<scope>$
```

and the scope group only admits `in/for this … diff|pr|changes|commit|…`. So:
- "No blocking findings remain at `8dba6cb`" fails on ` remain at …`
- "No changes needed" matches nothing at all
- "no additional branch change is needed" matches nothing

Worse, `isNoAction` requires **every** sentence to be a settling or polite form
(`github.ts:283`). PR #3748's review opens with the exact phrase
"No blocking findings." and still fails, because the body goes on to list the
validation it ran. A real review that shows its work can never settle.

### 3. `SECURITY` is negation-blind — `hooks/github.ts:227`

```
/\b(security|injection|xss|csrf|ssrf|secret|credential|auth(entication|orization)? bypass|rce|path traversal)\b/i
```

It fires on "no touches to security/proxy/validation, auth, Dockerfiles, CI" and
on "no blocking correctness, **security**, regression, testing, or
maintainability findings". A sentence stating security paths were *not* touched
sets `isSecurity: true`. This is Adam's own suggested fix in item 33.

### 4. Untagged bodies default to P1 when security fires — `hooks/github.ts:257`

`severityHint` falls through to `isSecurity ? 'P1' : 'P2'`. Defensible for a
finding. For an approval that slipped past (1) and (2), combined with (3), it
mints a security P1 out of a review that says the change is clean. That is
exactly G3-1/G3-5 rated P1 in item 30 and #3748's G2-1/G2-3 in item 33.

### 5. A refused `acknowledged` is dropped silently — `hooks/round.ts:2425-2428`

```ts
if (one === undefined || !mayAcknowledge(one) || each.replyId === undefined) return []
```

`mayAcknowledge` (`hooks/lifecycle.ts:184-186`) refuses anything with
`isSecurity === true`. So (3)+(4) make the approval unacknowledgeable, and
`afterTriage` **discards the answer with no message to the agent**. The loop
Adam hit:

1. agent answers `acknowledged` with a reply id → dropped → the id lands in
   `unanswered` (`round.ts:2516`) → "These review items have no answer yet"
   (`round.ts:2533`). That prompt's prose offers only "fix it, rebut it, or
   defer it"; `acknowledged` survives only in the JSON shape on the next line.
2. agent answers again → dropped again → `hasReprompted` is already `true`
   (`round.ts:2517`), so there is no third ask. The finding stays `open`.
3. the pre-merge backstop fires: "left open at 2bf6a51 with no fix or rebuttal,
   so another round would say the same" (`hooks/lifecycle.ts:1241`).
4. a security P1 is released only by a waiver naming it (`hooks/core.ts:911`),
   and waivers are person-only. Adam merged on GitHub.

### Post-merge consequences, same root

- **Unticketed security hold (#3748, six days after the merge).** `isFileable`
  (`lifecycle.ts:750`) and `isTicketable` (`lifecycle.ts:768`) split on
  `isSecurity`. A fake security finding is excluded from GitHub issue filing and
  can only go to Jira where `jiraProject` is set, which the cookbook does not
  set. The lifecycle stays open with nothing tracking it, and the only release
  is `/pr-gate waive <branch>:<id>` "from this worktree" — which finding 13
  makes unreachable once the branch is gone.
- **`severity:P2` "Major" issues bodies saying "answered as P3" (#3786, #3787).**
  `applyAnswer` (`lifecycle.ts:246`) keeps `peakSeverity: higher(peakOf(f), severity)`
  unconditionally, so the regex's own P2 guess becomes the peak. `filingPeak`
  (`lifecycle.ts:736`) labels the issue by the peak, `SEVERITY_NAMES.P2` is
  "Major" (`lifecycle.ts:730`). The agent's P3 answer is recorded in the body and
  ignored by the label. R85 and R92 assume a peak set by a reviewer tag or
  Codex, never by the gate's own fallback guess.
- **Item 32, a deferral held after the person decided.** Confirmed as a gap, not
  a bug: `holding` keeps a Codex-agreed deferral (`lifecycle.ts:1204`), and
  nothing reads a ruling the person recorded as a PR comment. Only a waiver or a
  filed issue (`isSettledByIssue`, `lifecycle.ts:757`) clears it.

## Fixes, split by whether they need a ruling

Three are mechanical; two more look mechanical but reverse a stated rule and
need a ruling. All five live in `hooks/github.ts`.

**Mechanical, no new behaviour decision:**

1. Call the no-action classifier on comments and inline comments too, with the
   `state` gate relaxed for the comment kinds.
2. Widen `SETTLES`: allow a trailing head reference ("remain at `<sha>`",
   "at `<sha>`"), accept "no changes needed", "nothing to fix in the delta",
   "no additional … change is needed", "ready to merge", "no actionable issues
   were found".
3. Make `SECURITY` negation-aware: a security word inside "no …", "not …",
   "no touches to …", "no changes to …" does not set the flag.

**Needs Adam's ruling:**

0a. **Judge the body by its conclusion, not by every sentence**, so a review
   that lists the validation it ran can still settle. This reverses
   `tests/github.test.ts:409` ("… No actionable findings in this roadmap-only
   diff.\n\nScope: docs only." asserted *not* no-action) and with it R83's
   positive-evidence-only rule, whose comment cites PR #19 review G2-2. A
   conclusion-scoped read (the last non-empty sentence, plus an explicit
   "Conclusion:" line where one exists) keeps "LGTM but fix X" out, but the rule
   change is Adam's.
0b. **Stop defaulting an untagged body to a security P1.** `github.ts:255` says
   a security hint never drops below P2 unless the reviewer tagged it, and the
   P1 fall-through is deliberate. Fix 3 removes most of the need for this, so it
   may not be wanted at all.

A. **Peak for a hint-sourced severity.** Should `applyAnswer` let the peak fall
   to the agent's answer when `severitySource === 'hint'` and no reviewer tag or
   Codex rating ever set a floor? Adam's item 33 says "a severity the agent
   assigned in triage should not be silently raised when the item is filed",
   which points at yes, but R85/R92 were written the other way.

B. **Surfacing a refused acknowledgement.** `afterTriage` should not drop an
   answer. Tell the agent why (`G3-1 cannot be acknowledged: it is flagged
   security`) so it can rebut instead, and do not count a refused answer as "no
   answer yet". Cheap, but it changes a prompt contract.

C. **How Codex verifies an acknowledgement.** An ack is stored as `rebutted`
   (`lifecycle.ts:220`), so Codex is asked "does the rebuttal still hold"
   (`core.ts:636`) and, for an approval, grades the *reviewer* rather than the
   code — item 32's G2-1 ("the review never assessed whether that blanket
   dependency is valid"). An approval that settles itself should not reach that
   question at all. The probe supports this as a path distinct from item 30's
   drop: item 32's G2-1 (claude[bot]'s "low effort" comment) rates **P2,
   non-security**, so `mayAcknowledge` passed, the ack *was* recorded as
   `rebutted`, and Codex refused it.

D. **A deferral the person ruled on.** Item 32 wants the person's recorded
   ruling to clear the hold. Needs a mechanism: a `/pr-gate decided <id>`
   subcommand, or reading the ruling from the thread.

## Scope note

`fix/29-lifecycle-id` (PR #31, the other live session) touches
`pr-lifecycle/hooks/lifecycle.ts` and `hooks/round.ts`. The mechanical fixes
above are confined to `hooks/github.ts` plus `tests/github.test.ts`, which PR
#31 does not touch. Rulings A–C would land in `lifecycle.ts` / `round.ts` and
should wait for #31 to merge.
