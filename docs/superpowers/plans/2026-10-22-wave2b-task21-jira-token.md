# Wave 2b Task 21: Jira through its REST API with a token (A9.8)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. This task extends Task 19 of
> `docs/superpowers/plans/2026-10-21-pr-lifecycle-wave2b.md`; read Task 19's text and the code it built first.

**Goal:** the gate files, finds and checks a security finding's Jira ticket through Jira's REST API with an API token and
email from the environment. `acli` stays as the fallback when those are unset.

**Why (Adam, 2026-10-22):** acli's saved login expired silently. `acli jira auth status` said "Authenticated" while every call
answered "unauthorized", so the gate could file no ticket. Adam: "the gate needs a jira key and email". AskUserQuestion answer:
"1.5.0, token first": the token path is the main one and acli the fallback.

**Spec:** `docs/superpowers/specs/2026-10-21-pr-lifecycle-wave2b-design.md` §5.13.7, amended by A9.8 below.

## A9.8 (spec amendment, add to §5.13.7)

- The gate reads three environment variables through `$.env.get`: `JIRA_BASE_URL` (for example
  `https://tasteslikegood.atlassian.net`), `JIRA_EMAIL` and `JIRA_API_TOKEN`. They are never read from `.github/pr-gate.json`
  or any other repo file: a repo setting must never choose where the token is sent.
- **All three set:** every Jira call goes over `$.http.fetch` to `<JIRA_BASE_URL>/rest/api/3/...` with
  `Authorization: Basic base64(<email>:<token>)`. acli is not called.
- **Any unset:** the calls go through acli as Task 19 built them.
- `JIRA_BASE_URL` must be `https://` and its host must end in `.atlassian.net`; anything else is refused as a ticket error
  ("JIRA_BASE_URL must be an https://<site>.atlassian.net address"), and acli is not tried in its place. A trailing `/` is dropped.
- The token and the Authorization header never appear in an error, a log line, a toast, a record field or an issue body.
- Each call is bounded at 30 s like an acli call; a timeout or a thrown fetch is a failed call with its words, never a wait.

### The three calls

| Call | REST | Answer the gate reads |
|---|---|---|
| create | `POST /rest/api/3/issue` with `{ fields: { project: { key }, issuetype: { name: 'Bug' }, summary, labels: ['security', 'severity-<peak>'], description: <ADF> } }` | `201` and `{ key }` |
| search (after a lost answer) | `POST /rest/api/3/search/jql` with `{ jql, fields: ['summary'], maxResults: 50 }` | `200` and `{ issues: [{ key, fields: { summary } }] }`: `ticketIn` already reads this shape |
| view (after the merge) | `GET /rest/api/3/issue/<key>?fields=summary` | `200` and `{ key }`; `404` is gone |

- The description is Atlassian Document Format: `{ type: 'doc', version: 1, content: [...] }`, one `paragraph` node per
  non-empty line of the body, each holding one `text` node. Code fences and markdown stay as plain text.
- **Errors:** a non-2xx answer becomes `Jira answered <status>: <first message of errorMessages or errors, or the body>`, on
  one line, cut to 200 characters. A body that echoes the request is never quoted.
- **Advice** (`jiraAdvice`, said once per lifecycle as before):
  - 401: "Jira refused JIRA_EMAIL and JIRA_API_TOKEN: make a new token at id.atlassian.com (Security, API tokens) and set it."
  - 403: "Jira's account for JIRA_EMAIL cannot create work items in <project>: grant it, or set jiraProject to a project it can use."
  - the acli advice stays for the acli path.
- **View after the merge:** `404` is gone (refile as Task 19 does). `401` and `403` are a failed check, never gone: a ticket the
  token can't see is not a deleted ticket (this also settles gate finding R3-1 for the REST path).

## Files

- Modify: `pr-lifecycle/hooks/round.ts`: the `acli` helper, `fileTicket`, the post-merge view (about line 3944).
- Modify: `pr-lifecycle/hooks/lifecycle.ts`: `jiraAdvice` with the 401 and 403 advice.
- Modify: `pr-lifecycle/tests/world.ts`: an `http.fetch` fake for Jira and an `env.get` fake, beside the acli fake.
- Modify: `pr-lifecycle/tests/round.test.ts` and `pr-lifecycle/tests/flow.test.ts`: the tests below.
- Modify: `pr-lifecycle/README.md` (settings and setup), the spec (A9.8 above, under §5.13.7), and the rulings doc (R96).

## Interfaces

- **Consumes:** `TicketItem`, `ticketIn`, `jiraKeyIn`, `SUMMARY_MAX`, `ACLI_NOT_STARTED`, `isAcliMissing`, `jiraAdvice` (Task 19).
- **Produces:**
  - `type JiraAuth = { base: string; email: string; token: string }`
  - `async function jiraAuth($: Engine): Promise<JiraAuth | { error: string } | undefined>`: undefined when any variable is
    unset; `{ error }` when `JIRA_BASE_URL` is refused.
  - `async function jiraRest($: Engine, auth: JiraAuth, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Ran>`:
    the answer in acli's `Ran` shape (`exitCode` 0 on 2xx; else 1 with the error words in `stderr`), so `fileTicket` and the
    view keep one code path after the call.
  - `export const adfOf = (text: string): object`

## Steps

- [ ] **Step 1: The test world.** In `world.ts`, add `jira: { env?: { base?: string; email?: string; token?: string };
  status?: { create?: number; view?: number; search?: number }; lost?: boolean; requests: { method: string; url: string;
  headers: Record<string, string>; body: string }[] }`. Hook `env.get` for the three names from `w.jira.env`, and `http.fetch`
  for URLs under `w.jira.env.base`. They answer from the same `w.acli.tickets` list, so a test can switch transports and keep its
  assertions. `lost` files the ticket and then throws `'fetch failed: timeout'`.
- [ ] **Step 2: Failing tests**, in `round.test.ts` unless named:
  1. With all three variables set, a security hold files its ticket by `POST /rest/api/3/issue`, the record gets the key, and
     `w.acli.calls` is empty.
  2. The request carries `Authorization: Basic <base64(email:token)>`, labels `['security', 'severity-P1']`, and an ADF
     description with one paragraph per line.
  3. With `JIRA_API_TOKEN` unset, the same hold goes through acli (Task 19's tests still pass unchanged).
  4. `JIRA_BASE_URL=http://evil.example` and `https://evil.example` are refused: no fetch and no acli call, a ticket error naming
     the variable, and the finding still holds.
  5. A 401 keeps the finding held with `Jira answered 401`. The advice names a new token, is said once, and the token's value
     appears nowhere in the record, the log or the toasts (search the serialized store for it).
  6. A lost answer (`lost: true`) is followed on the next pass by `POST /rest/api/3/search/jql`, which finds the ticket: one
     ticket filed, not two.
  7. (flow.test.ts) After the merge, a view that answers 404 refiles the ticket; one that answers 403 is a failed check, the
     record holds, and nothing is refiled.
  8. A fetch that never resolves ends after 30 s as a failed call (fake clock), never a stuck pass.
  9. `adfOf('a\n\nb')` is a doc with two paragraphs.
- [ ] **Step 3: Run them and see them fail.** `cd pr-lifecycle && claude plugin test` (or `npm run test` from the root).
- [ ] **Step 4: Implement.**
  - Add `jiraAuth` and `jiraRest`. Encode the Basic header with `btoa`, after UTF-8 encoding through `TextEncoder`. Bound the
    fetch with `Promise.race` against `$.clock.after(30_000)`.
  - In `fileTicket`, `const auth = await jiraAuth($)`. `{ error }` → return it. A `JiraAuth` → search and create through
    `jiraRest`, with no temp file. undefined → Task 19's acli path, unchanged.
  - The post-merge view does the same. Read the gone and failed cases from the status: 404 is gone, anything else non-2xx failed.
  - `jiraAdvice`: add the 401 and 403 cases before the acli ones. Match on `Jira answered 401` and `Jira answered 403`.
  - Run `claude plugin validate`: it must list `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` as variables the module reads.
- [ ] **Step 5: Run the full suite.** `npm run lint`, `npm run test`, `npm run typecheck`. Expect all to pass.
- [ ] **Step 6: Docs.**
  - README: a "Jira" section. Set the three variables in the shell profile or in `~/.claude/settings.json` under `env`, never
    in the repo. Make the token at id.atlassian.com, Security, API tokens. acli is the fallback.
  - Spec: A9.8. Rulings doc: R96 with Adam's words above.
  - CLAUDE.md: the test count.
- [ ] **Step 7: Commit** with the trailers, then push.
