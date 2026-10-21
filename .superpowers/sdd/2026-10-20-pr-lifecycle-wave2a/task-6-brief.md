### Task 6: Required checks and `gatherStanding`

**Files:**
- Modify: `pr-lifecycle/hooks/github.ts` (add `readRequired`)
- Modify: `pr-lifecycle/hooks/round.ts` (add `readChecks`, `requiredChecksOf`, `gatherStanding`)
- Modify: `pr-lifecycle/tests/world.ts` (fake the rules and protection endpoints)
- Test: `pr-lifecycle/tests/github.test.ts`

**Interfaces:**
- Produces: `export function readRequired(rules: string, protection: string | undefined): string[] | undefined` (`github.ts`). It returns `undefined` when the rules text isn't a JSON array.
- Produces (`round.ts`):
  - `export async function readChecks($: Engine, root: string, pr: number, repo?: string): Promise<{ name: string; bucket: string }[] | 'unreadable'>`
  - `export async function requiredChecksOf($: Engine, root: string, slug: string | undefined, base: string): Promise<Set<string> | 'unknown'>`
  - `export async function gatherStanding($: Engine, rec: LifecycleRecord, pr: { number: number; baseRefName: string; headRefOid: string }, repo?: string): Promise<Standing>`

- [ ] **Step 1: Write the failing unit test** (`github.test.ts`, import `readRequired`):

```ts
test('R86: required checks come from the ruleset and classic protection; anything unreadable is undefined', async () => {
  const rules = JSON.stringify([
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'check' }, { context: 'analyze (actions)' }] } },
  ])
  expect(readRequired(rules, undefined)).toEqual(['check', 'analyze (actions)'])
  expect(readRequired(rules, JSON.stringify({ contexts: ['legacy'], checks: [{ context: 'check' }] }))).toEqual(['check', 'analyze (actions)', 'legacy'])
  expect(readRequired('[]', undefined)).toEqual([])
  expect(readRequired('<html>proxy error</html>', undefined)).toBeUndefined()
  expect(readRequired('', undefined)).toBeUndefined()
  // Classic protection that answered but can't be parsed makes the whole set unknown (PR #19 review).
  expect(readRequired(rules, '<html>proxy error</html>')).toBeUndefined()
})
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.

- [ ] **Step 3: Implement `readRequired`** (`github.ts`):

```ts
/**
 * The checks a base requires (R86): each `required_status_checks` rule of `gh api repos/<slug>/rules/branches/<base>`, plus classic
 * protection's `contexts` and `checks[].context` when given. undefined when either payload can't be parsed: every check then counts as required.
 */
export function readRequired(rules: string, protection: string | undefined): string[] | undefined {
  let listed: unknown
  try {
    listed = JSON.parse(rules)
  } catch {
    return undefined
  }
  if (!Array.isArray(listed)) return undefined
  const out: string[] = []
  for (const rule of listed) {
    const row = typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>) : {}
    if (row.type !== 'required_status_checks') continue
    const params = (row.parameters ?? {}) as { required_status_checks?: { context?: unknown }[] }
    for (const one of params.required_status_checks ?? []) if (typeof one.context === 'string') out.push(one.context)
  }
  if (protection !== undefined) {
    try {
      const read = JSON.parse(protection) as { contexts?: unknown[]; checks?: { context?: unknown }[] }
      for (const one of read.contexts ?? []) if (typeof one === 'string') out.push(one)
      for (const one of read.checks ?? []) if (typeof one.context === 'string') out.push(one.context)
    } catch {
      // Rulesets and classic protection apply together: half a set is not the set (PR #19 review).
      return undefined
    }
  }
  return [...new Set(out)]
}
```

- [ ] **Step 4: Fake the endpoints** in `tests/world.ts`. Add to the `gh` type:
  - `/** Checks the base requires; undefined requires every check in \`checks\` (as before R86). */ required?: string[]`
  - `/** How the rules endpoint answers: 'ok' (default), 'garbage', 'throw', or an HTTP status. */ rulesAnswer?: 'ok' | 'garbage' | 'throw' | number`
  - `/** How classic protection answers: 'none' (404, the default), 'ok' (requires 'legacy'), 'garbage', 'throw', or an HTTP status. */ classicAnswer?: 'none' | 'ok' | 'garbage' | 'throw' | number`

In the `process.run` handler, after the `garbage` line, add:

```ts
      const failed = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      if (/^api repos\/\S+\/rules\/branches\//.test(args)) {
        const how = w.gh.rulesAnswer ?? 'ok'
        if (how === 'throw') throw new Error('network down')
        if (typeof how === 'number') return failed(`gh: HTTP ${how}`)
        if (how === 'garbage') return out('<html>proxy error</html>')
        const names = w.gh.required ?? (w.gh.checks as { name?: string }[]).map(one => String(one.name))
        return out(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: names.map(context => ({ context })) } }]))
      }
      if (/^api repos\/\S+\/branches\/\S+\/protection/.test(args)) {
        const how = w.gh.classicAnswer ?? 'none'
        if (how === 'throw') throw new Error('network down')
        if (how === 'none') return failed('gh: Branch not protected (HTTP 404)')
        if (typeof how === 'number') return failed(`gh: HTTP ${how}`)
        if (how === 'garbage') return out('<html>proxy error</html>')
        return out(JSON.stringify({ contexts: ['legacy'], checks: [] }))
      }
```

If a throwing handler doesn't surface as a rejected `process.run` in this harness, model `'throw'` however the fake engine reports a failed spawn, and say so in the report.

Add the source-combination test to `tests/flow.test.ts` (import `requiredChecksOf` from `'../hooks/round'`):

```ts
test('R86: the required set is known only when both sources are established (PR #19 review)', async ($, on) => {
  const w = world(on)
  const cases: [World['gh']['rulesAnswer'], World['gh']['classicAnswer'], string[] | 'unknown'][] = [
    ['ok', 'none', ['check']],
    ['ok', 'ok', ['check', 'legacy']],
    ['ok', 403, 'unknown'],
    ['ok', 500, 'unknown'],
    [403, 'none', 'unknown'],
    [500, 'ok', 'unknown'],
    ['throw', 'none', 'unknown'],
    ['ok', 'throw', 'unknown'],
    ['garbage', 'none', 'unknown'],
    ['ok', 'garbage', 'unknown'],
  ]
  w.gh.required = ['check']
  for (const [i, [rules, classic, want]] of cases.entries()) {
    w.gh.rulesAnswer = rules
    w.gh.classicAnswer = classic
    const got = await requiredChecksOf($, '/repo', 'me/repo', `base${i}`)
    expect(got === 'unknown' ? 'unknown' : [...got]).toEqual(want)
  }
  // An unknown answer is not cached: once GitHub answers, the same base reads.
  w.gh.rulesAnswer = 500
  expect(await requiredChecksOf($, '/repo', 'me/repo', 'later')).toBe('unknown')
  w.gh.rulesAnswer = 'ok'
  expect(await requiredChecksOf($, '/repo', 'me/repo', 'later')).toEqual(new Set(['check']))
})
```

Use the world type the file already uses (`ReturnType<typeof world>`) if `World` isn't exported.

- [ ] **Step 5: Implement the async helpers** in `round.ts` (near `fetchFeedback`; import `readRequired` from `./github`, and the `Standing` and `CheckState` types and `standingOf` from `./lifecycle` and `../types`):

```ts
/** The PR head's checks from `gh pr checks` (R1-9): [] when gh reports none, 'unreadable' when it can't say. */
export async function readChecks($: Engine, root: string, pr: number, repo?: string): Promise<{ name: string; bucket: string }[] | 'unreadable'> {
  let ran: { exitCode: number; stdout: string; stderr: string }
  try {
    ran = await $.process.run(['gh', 'pr', 'checks', String(pr), ...(repo === undefined ? [] : ['--repo', repo]), '--json', 'name,state,bucket'], {
      cwd: root,
      timeoutMs: 30_000,
    })
  } catch (error) {
    ran = { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  try {
    const read = JSON.parse(ran.stdout) as unknown
    const row = (one: unknown): Record<string, unknown> => (typeof one === 'object' && one !== null ? (one as Record<string, unknown>) : {})
    if (Array.isArray(read)) return read.map(one => ({ name: String(row(one).name ?? '?'), bucket: String(row(one).bucket ?? '') }))
  } catch {
    // Not JSON: read stderr below.
  }
  return /no checks reported/i.test(ran.stderr) ? [] : 'unreadable'
}

const required = new Map<string, Set<string>>()

/**
 * The base's required checks (R86): the union of its rulesets and classic protection, cached per repository and base for the session.
 * Each source must be parsed, or authoritatively absent (classic's 404 "not protected"); a throw, a 403 or 500, or a payload that
 * doesn't parse from either makes it 'unknown', which fails closed (every check required) and is not cached (PR #19 review).
 */
export async function requiredChecksOf($: Engine, root: string, slug: string | undefined, base: string): Promise<Set<string> | 'unknown'> {
  if (slug === undefined) return 'unknown'
  const key = `${slug}:${base}`
  const seen = required.get(key)
  if (seen !== undefined) return seen
  const api = (path: string) => $.process.run(['gh', 'api', path], { cwd: root, timeoutMs: 30_000 }).catch(() => undefined)
  const rules = await api(`repos/${slug}/rules/branches/${base}`)
  const classic = await api(`repos/${slug}/branches/${base}/protection/required_status_checks`)
  if (rules === undefined || rules.exitCode !== 0 || classic === undefined) return 'unknown'
  const isClassicNone = classic.exitCode !== 0 && /\b404\b|not protected/i.test(classic.stderr)
  if (classic.exitCode !== 0 && !isClassicNone) return 'unknown'
  const listed = readRequired(rules.stdout, classic.exitCode === 0 ? classic.stdout : undefined)
  if (listed === undefined) return 'unknown'
  const found = new Set(listed)
  required.set(key, found)
  return found
}

/** The standing of a PR head (R79): the record's findings and review, its checks, and which of them its base requires. */
export async function gatherStanding(
  $: Engine,
  rec: LifecycleRecord,
  pr: { number: number; baseRefName: string; headRefOid: string },
  repo?: string,
): Promise<Standing> {
  const checks = await readChecks($, rec.root, pr.number, repo)
  const needed = checks === 'unreadable' || checks.length === 0 ? new Set<string>() : await requiredChecksOf($, rec.root, repo ?? rec.slug, pr.baseRefName)
  const ci: CheckState[] | 'unreadable' =
    checks === 'unreadable' ? 'unreadable' : checks.map(one => ({ ...one, isRequired: needed === 'unknown' || needed.has(one.name) }))
  return standingOf(rec, { head: pr.headRefOid, base: pr.baseRefName }, ci)
}
```

The `required` cache is module state. If tests that use different `w.gh.required` values interfere, add the world's id to the key, or clear the map in `setup(c)` (called on each `register`).

- [ ] **Step 6: Run the suite.** Expected: PASS. Nothing calls the async helpers yet.

- [ ] **Step 7: Commit**

```bash
git add pr-lifecycle/hooks/github.ts pr-lifecycle/hooks/round.ts pr-lifecycle/tests/world.ts pr-lifecycle/tests/github.test.ts
git commit -m "pr-lifecycle: required checks from rulesets and classic protection; gatherStanding (R86)"
```

---

