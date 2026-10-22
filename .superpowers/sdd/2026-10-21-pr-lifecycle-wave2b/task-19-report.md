# Task 19 report: security findings open Jira tickets (spec §5.13.7, A9.7)

Status: DONE. Commit `43f37e4` on `wave2b/pr-lifecycle-1.5.0` (not pushed).

## Changes, file by file

- `pr-lifecycle/types/index.d.ts`
  - `Finding.jiraTicket?` (for example `KAN-512`) and `Finding.jiraError?` (acli's words).
  - `LifecycleRecord.isJiraLoginSaid?`, the once-per-lifecycle flag for the login notice.
- `pr-lifecycle/hooks/round.ts`
  - Config:
    - `Config.jiraProject` defaults to undefined in `configOf`.
    - `overrideConfig` parses it against `^[A-Z][A-Z0-9]+$`. Anything else is ignored with "not a Jira project key such as KAN".
  - Jira helpers:
    - `acli()` is one bounded call (30 s), and a throw becomes `{exitCode: 1, stderr}`.
    - `acliWords`, `jiraKeyIn` and `ticketIn` parse defensively: a missing or malformed key counts as a failure.
  - `fileTicket()` files one ticket:
    - On a retry (the finding has a `jiraError`), it first runs `acli jira workitem search --jql 'project = <key> AND summary ~ "\"<id>\""' --json`. A ticket whose summary matches exactly is reused. A failed search files nothing (`jiraError` "could not search Jira…").
    - Otherwise it writes the body to `<git-dir>/pr-gate-jira-<id>.txt` with `$.fs.write`. A failed write is a `jiraError`.
    - It then runs `acli jira workitem create --project --type Bug --summary <issueTitle> --description-file <file> --label security,severity-<peak> --json`.
    - In a `finally`, it removes the file with `rm -f` (30 s bound, failure swallowed).
  - `fileOnce` (the filing pass):
    - The plan gets `isJira = jiraProject set`.
    - After the GitHub items, a ticket loop runs. It checks for a move or a waiver before each ticket, restamps the run, and saves each answer under the lock as soon as acli answers.
    - It never replaces a `jiraTicket` that another pass already saved.
    - On the first failure in a lifecycle it sets `isJiraLoginSaid` and toasts the person once: "Run acli jira auth login; the gate retries on its next pass".
    - A failure is never a stop and never a GitHub issue.
  - `closeOnce`:
    - The filing at merge also runs when a holding security finding has no ticket. The plan then files tickets (merge kind) where `jiraProject` is set.
    - `apply` now copies `jiraTicket` and `jiraError`.
    - After the archive, the agent is told: "Security findings still holding at the merge, tracked by their Jira tickets, which never settle them: S2-1 → KAN-512 Critical [P1]. Tell the person now, naming each finding and its ticket." The person also gets a toast.
  - `checkIssuesAfterMerge`:
    - Its targets now include each holding security finding with a `jiraTicket`, read with `acli jira workitem view <key> --json`.
    - An answer with a key is logged ("Jira KAN-512 exists after the merge"), whatever the ticket's status.
    - A non-zero exit whose words say "does not exist" or "not found" (and not command-not-found, ENOENT or unauthorized) refiles the ticket through `fileTicket`, searching first after a `jiraError`. The result is saved at once through `keep`, which now also copies the Jira fields.
    - Any other failure is a failed check, so the record stays blocked.
- `pr-lifecycle/hooks/lifecycle.ts`
  - `isTicketable(f)` is the security mirror of `isFileable`: open, deferred with Codex's agreement, or disputed, and not linked or link-owed.
  - `ticketLine(f)` gives "S2-1 → KAN-512 Critical [P1]".
  - `untrackedSecurity` now leaves out a finding that has a `jiraTicket`. That covers `securityBlockedIds`, `isSecurityOnlyBlocked` and `isWatchable`.
  - `planIssues(..., isJira)` adds `tickets: TicketItem[]` (with an `isRetry` flag) to the `file` plan:
    - for ticketable findings at a filing point;
    - for every holding security finding at a merge.
    - It returns `file` when either list is non-empty, and `tickets` is absent when empty, so existing `toEqual`s hold.
  - `blockerOf`, the hold list:
    - A person-owned security finding with a ticket reads "S2-1 → KAN-512 Critical [P1], waiting for your waiver".
    - Otherwise the tag carries ` → KAN-512`, or "(Jira ticket not filed: <words>)" after a failure.
  - `mergeHolds`, `securityHolds` and `isSettledByIssue` are unchanged, so the ticket never settles a finding.
- `pr-lifecycle/hooks/core.ts`
  - `ticketsOf()` adds to `reportPrompt` and `heldPrompt` (post):
    - "Tracked by Jira, never settled by it: S2-1 → KAN-512 Critical [P1], waiting for the person's waiver";
    - for a failed ticket, a line with acli's words, telling the agent to have the person run `acli jira auth login` and never to file a GitHub issue for a security finding.
- `pr-lifecycle/hooks/register.tsx`
  - `/pr-gate status` names "G2-1 → KAN-512 Critical [P1], waiting for your waiver." for each ticketed holding security finding.
- `pr-lifecycle/tests/world.ts`
  - `w.acli` is an acli fake, routed before the git fallthrough.
    - Knobs `create`, `view` and `search` take `ok | fail | unauthorized | missing`, plus `lost` for create (it files the ticket but answers as a timeout).
    - 'missing' throws (no binary). For `view`, 'missing' means the ticket does not exist; so does any key the fake never filed.
    - It also keeps `calls`, `tickets` and `next` (512).
  - An `fs.write` hook plus `w.files`, `w.written` and the `isWriteBroken` knob; `rm` removes from `w.files`.
  - `rev-parse --absolute-git-dir` answers `/repo/.git`.
  - Toasts are recorded in `w.toasts`.
  - The engine stand-in has `fs.write`.

## Tests, and whether each failed before the change

I wrote the tests after the implementation. I then ran the whole suite with `hooks/` and `types/` stashed, which is the code before the change with the new tests and fakes in place: 546 pass, 10 fail. Each test below that is marked FAILED failed in that run.

| Test | Before the change |
|---|---|
| settings: A9.7 jiraProject parsing (default none, KAN/SEC2 kept, `kan`, `K`, `KAN-1`, `""`, `7` and `KAN AND x` ignored) | FAILED |
| lifecycle: A9.7 ticketable, planIssues tickets, untrackedSecurity, ticketLine, hold-list words, merge plan | FAILED (the file did not load: missing exports) |
| flow 1: with jiraProject, a security deferral files one ticket and still holds; checks argv, labels, the description file in `.git`, the body never on the command line, the file removed, no GH issue, report and status words; a second pass files no second ticket | FAILED |
| flow 2: without jiraProject, no acli call, no write, no GH issue, awaiting-decision as before | passed (the regression guard, as expected) |
| flow 3: unauthorized → `jiraError` and one login toast; second pass fails silently; third pass (ok) searches, then files KAN-512 | FAILED |
| flow 3b: acli missing, then a failed description write → `jiraError`, file removed, no stop, one toast, no GH issue | FAILED |
| flow 6: lost create, then a failed search files nothing; then the search finds KAN-512 and there is no second create; the JQL text is checked | FAILED |
| flow 4: website merge with the ticket filed → archived; the agent and the person are told "G2-1 → KAN-512 Critical [P1]"; view logged | FAILED |
| flow 4b: security finding open at a website merge, acli unauthorized → blocked as Task 18; after the login, resume files the ticket at the merge and archives | FAILED |
| flow 5a: after the merge, a ticket deleted in Jira is refiled (KAN-513), and the record archives | FAILED |
| flow 5b: after the merge, view unauthorized, then fail → blocked with acli's words and nothing filed; view ok → the next watcher beat archives | FAILED |

## Results

- `claude plugin test pr-lifecycle`: **664 pass, 0 fail** (211 s). It was 653 before: 11 new tests, 9 flow, 1 lifecycle and 1 settings.
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `claude plugin validate pr-lifecycle`: passed.
- codex-gate was not touched and not rerun.

## Concerns

1. **The spec and the brief disagree on where the key is stored.**
   - Spec §5.13.7 says the record keeps the key as `followUp` (with `followUpLabel` once both labels show).
   - The brief and the controller say `jiraTicket`. I used `jiraTicket`, because `followUp` is the agent's R85 issue link and would collide with a security finding's own follow-up.
   - The ticket's labels are therefore **not verified** from acli's answer, and there is no `followUpLabel` analogue. The spec text needs this reconciled.
2. **Where the description file goes.** The file is written under `git rev-parse --absolute-git-dir`, falling back to `<root>/.git`, rather than literally under `<root>/.git/`. In a worktree, `<root>/.git` is a file, so the literal path would fail every time.
3. **No fs delete.** `$.fs` has no delete, so the file is removed with `rm -f` through `$.process.run` (bounded, failure swallowed). If acli hangs, the file is still removed after the 30 s timeout.
4. **acli missing in tests.** In the test host, a hook that throws surfaces as "no implementation for process.run", not ENOENT. The test asserts that a `jiraError` exists, not ENOENT's words. How the real engine rejects a missing binary is not verified.
5. **Which findings get a ticket before a merge.** It is `isTicketable`, the security mirror of `isFileable`: open, agreed deferral or dispute. So an open security P1 at exhaustion also gets a ticket, not only a deferral. At a merge, every holding security finding gets one.
6. **What resets with a new answer.** `jiraError` is deliberately not cleared on a new answer, unlike `issueError`, so the search-first duplicate guard survives. A stale error costs only one search.
7. **Who is told about a failure.** The login notice goes to the person as a toast, once per lifecycle (`isJiraLoginSaid`). The agent's report names each failed ticket with acli's words. The toast always says "Run acli jira auth login", even when acli is missing or the write failed; for those cases that is the wrong instruction, and branching the text on acli's words is left as a follow-up.
8. **A blocked record needs the person.** A record blocked only on an untracked security finding is not the watcher's (Task 18). Once acli is logged in, the person's `/pr-gate resume`, or a waiver, files the ticket and archives the record. The 4b test uses resume.
9. **Refiling with no setting.** A refile after the merge uses `jiraProject`, or, when the setting was removed, the old key's project prefix.
10. **Checked after the commit.** Every place that copies findings field by field carries `jiraTicket` and `jiraError`: `apply` in round.ts:1067, the filing apply at round.ts:3721, and `keep`. The answer merge in lifecycle.ts spreads the finding, so it keeps both fields too. `rev-parse --absolute-git-dir` goes through `git()`, which is bounded at 30 s.
