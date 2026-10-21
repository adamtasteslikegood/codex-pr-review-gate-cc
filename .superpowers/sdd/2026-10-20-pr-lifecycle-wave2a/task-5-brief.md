### Task 5: `standingOf` and `holdText` (pure)

**Files:**
- Modify: `pr-lifecycle/types/index.d.ts` (add `CheckState`, `Blocker`, `Standing`)
- Modify: `pr-lifecycle/hooks/lifecycle.ts` (add `standingOf`, `holdText`, `blockerOf`)
- Test: `pr-lifecycle/tests/lifecycle.test.ts`

**Interfaces:**
- Produces, in `types/index.d.ts`:

```ts
/** A CI check on a PR head, by gh's bucket (pass, fail, cancel, pending, skipping), and whether the base requires it (R86). */
export type CheckState = { name: string; bucket: string; isRequired: boolean }

export type Blocker = {
  kind:
    | 'open' | 'verify-owed' | 'reverify-owed' | 'rebuttal-unchecked' | 'disputed' | 'deferred' | 'security-p1'
    | 'head-unreviewed' | 'round-owed' | 'retargeted' | 'ci-failing' | 'ci-running' | 'ci-unreadable'
  /** A finding id, or a check name. */
  id?: string
  /** One line, with the stored (triaged) severity. */
  said: string
  owner: 'agent' | 'codex' | 'person' | 'gate'
  /** The exact step that clears it. */
  release: string
}

/** Everything between a head and its merge (R79): one list, none short-circuited. */
export type Standing = {
  phase: 'pre' | 'post'
  head: string
  waiver?: Waiver
  /** Checks GitHub doesn't require that a post waiver set aside (R86). */
  setAside: string[]
  mayProceed: boolean
  blockers: Blocker[]
}
```

- Produces, in `lifecycle.ts`:
  - `export function standingOf(rec: LifecycleRecord, at: { head: string; base: string }, ci?: readonly CheckState[] | 'unreadable'): Standing`
  - `export function holdText(s: Standing, named?: ReadonlySet<string>): string`

- [ ] **Step 1: Write the failing tests** (`lifecycle.test.ts`; import `standingOf`, `holdText`):

```ts
const postRec = (over: object = {}) => at([post({ endHead: 'a' })], { phase: 'post', pr: 7, ...over })

test('R79: the standing lists every finding that holds the merge, each with its owner and release', async () => {
  const rec = postRec({
    findings: [
      finding({ id: 'G2-1', source: 'github', severity: 'P2', status: 'open' }),
      finding({ id: 'G2-2', source: 'github', severity: 'P3', status: 'deferred' }),
      finding({ id: 'R1-1', status: 'reported-fixed' }),
      finding({ id: 'R1-2', status: 'verified-fixed', needsRecheck: true }),
    ],
  })
  const s = standingOf(rec, { head: 'a', base: 'dev' })
  expect(s.blockers.map(one => [one.id, one.kind, one.owner])).toEqual(
    expect.arrayContaining([
      ['G2-1', 'open', 'agent'],
      ['G2-2', 'deferred', 'person'],
      ['R1-1', 'verify-owed', 'codex'],
      ['R1-2', 'reverify-owed', 'codex'],
    ]),
  )
  expect(s.mayProceed).toBe(false)
  expect(s.blockers.find(one => one.id === 'G2-2')?.release).toBe('/pr-gate waive G2-2 <reason>')
})

test('R79/R86: CI joins the standing; a post waiver sets aside only checks GitHub does not require', async () => {
  const ci = [
    { name: 'check', bucket: 'pending', isRequired: true },
    { name: 'Independent Claude review', bucket: 'cancel', isRequired: false },
    { name: 'lint', bucket: 'pass', isRequired: true },
  ]
  const open = standingOf(postRec(), { head: 'a', base: 'dev' }, ci)
  expect(open.blockers.map(one => [one.id, one.kind])).toEqual(
    expect.arrayContaining([['check', 'ci-running'], ['Independent Claude review', 'ci-failing']]),
  )
  const waived = postRec({ waivers: [{ scope: 'post', head: 'a', reason: 'docs only', by: 'composer', at: 2 }], findings: [finding({ id: 'G2-1', source: 'github', severity: 'P2' })] })
  const s = standingOf(waived, { head: 'a', base: 'dev' }, ci)
  expect(s.setAside).toEqual(['Independent Claude review'])
  expect(s.blockers.map(one => one.id)).toEqual(['check'])
  expect(standingOf(waived, { head: 'a', base: 'dev' }, ci.filter(one => one.name !== 'check')).mayProceed).toBe(true)
})

test('R79: unreadable checks are a blocker; a security P1 survives a post waiver', async () => {
  expect(standingOf(postRec(), { head: 'a', base: 'dev' }, 'unreadable').blockers.map(one => one.kind)).toContain('ci-unreadable')
  const rec = postRec({
    waivers: [{ scope: 'post', head: 'a', reason: 'x', by: 'composer', at: 2 }],
    findings: [finding({ id: 'R1-1', isSecurity: true, status: 'open' })],
  })
  expect(standingOf(rec, { head: 'a', base: 'dev' }).blockers.map(one => one.kind)).toContain('security-p1')
})

test('R79: holdText names every blocker once, skipping ids the caller already named', async () => {
  const rec = postRec({ findings: [finding({ id: 'G2-1', source: 'github', severity: 'P2' }), finding({ id: 'G2-2', source: 'github', severity: 'P3', status: 'deferred' })] })
  const s = standingOf(rec, { head: 'abcdef1234', base: 'dev' }, [{ name: 'check', bucket: 'fail', isRequired: true }])
  const all = holdText(s)
  expect(all).toContain('Everything between abcdef1 and the merge:')
  expect(all).toContain('G2-1 [P2]')
  expect(all).toContain('G2-2 [P3]')
  expect(all).toContain('check')
  const rest = holdText(s, new Set(['G2-1']))
  expect(rest).not.toContain('G2-1')
  expect(rest).toContain('Also holding:')
  expect(holdText(standingOf(postRec(), { head: 'abcdef1234', base: 'dev' }, []))).toContain('Nothing else holds the merge of abcdef1.')
})
```

`decideNext` on `postRec()` may itself add a head-level blocker (`round-owed`, say). That's why the tests use `arrayContaining`, except the waived case, where head blockers are dropped.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL, `standingOf` undefined.

- [ ] **Step 3: Implement** in `lifecycle.ts`, after `securityHolds`:

```ts
const short = (sha: string): string => sha.slice(0, 7)

/** One finding that holds the merge, as a blocker with its owner and the step that clears it (R79). */
function blockerOf(f: Finding): Blocker {
  const tag = `${f.id} [${f.severity}]${f.isSecurity === true ? ' security' : ''} ${f.title}`
  const waive = `/pr-gate waive ${f.id} <reason>`
  const isSecurityP1 = isBlocking(f) && f.isSecurity === true
  if (isDisputed(f)) return { kind: 'disputed', id: f.id, said: `${tag}: disputed`, owner: 'person', release: waive }
  if (f.status === 'deferred') return { kind: isSecurityP1 ? 'security-p1' : 'deferred', id: f.id, said: `${tag}: deferred`, owner: 'person', release: waive }
  if (isReverifyOwed(f)) {
    return { kind: 'reverify-owed', id: f.id, said: `${tag}: fixed, re-verify owed (file changed)`, owner: 'codex', release: "the gate's Codex check re-verifies it" }
  }
  if (f.status === 'reported-fixed') {
    return { kind: 'verify-owed', id: f.id, said: `${tag}: fixed, verification owed`, owner: 'codex', release: "the gate's Codex check verifies it" }
  }
  if (f.status === 'rebutted') {
    return { kind: 'rebuttal-unchecked', id: f.id, said: `${tag}: rebuttal not yet accepted`, owner: 'codex', release: "the gate's Codex check rules on it" }
  }
  return { kind: isSecurityP1 ? 'security-p1' : 'open', id: f.id, said: `${tag}: open`, owner: 'agent', release: 'fix it, or rebut it with file:line evidence' }
}

/**
 * Everything between this head and its merge (R79): findings, the head's own review, and CI, with nothing short-circuited. A post
 * waiver for this head and base leaves only a security P1 and CI; CI a waiver covers is only what GitHub does not require (R86).
 */
export function standingOf(rec: LifecycleRecord, at: { head: string; base: string }, ci?: readonly CheckState[] | 'unreadable'): Standing {
  const phase = rec.phase === 'pre' ? 'pre' : 'post'
  const isOnBase = rec.base === at.base
  const waiver = isOnBase ? rec.waivers.find(one => one.scope === phase && one.head === at.head && (phase === 'post' || one.base === at.base)) : undefined
  const security = securityHolds(rec)
  const isWaived = waiver !== undefined && security.length === 0
  const blockers: Blocker[] = (isWaived ? [] : mergeHolds(rec)).map(blockerOf)
  if (!isOnBase && phase === 'post') {
    blockers.push({ kind: 'retargeted', said: `reviewed for ${rec.base}, but the PR now targets ${at.base}`, owner: 'person', release: `point it back at ${rec.base}, or /pr-gate reset` })
  }
  if (!isWaived && phase === 'post') {
    const next = decideNext(rec)
    if (next.kind === 'round') blockers.push({ kind: 'round-owed', said: `a review round is owed on ${short(at.head)}`, owner: 'gate', release: 'the gate runs it; leave the branch alone' })
    if (next.kind === 'exhausted') {
      blockers.push({ kind: 'head-unreviewed', said: next.why, owner: 'person', release: '/pr-gate allow 1 <reason>, or /pr-gate waive post <reason>' })
    }
  }
  const setAside: string[] = []
  if (ci === 'unreadable') {
    blockers.push({ kind: 'ci-unreadable', said: `the CI checks on ${short(at.head)} could not be read`, owner: 'agent', release: 'check gh auth status and the network, then try again' })
  } else {
    for (const one of ci ?? []) {
      const isBad = one.bucket === 'fail' || one.bucket === 'cancel'
      if (!isBad && (one.bucket === 'pass' || one.bucket === 'skipping')) continue
      if (isWaived && !one.isRequired) {
        setAside.push(one.name)
        continue
      }
      blockers.push(
        isBad
          ? { kind: 'ci-failing', id: one.name, said: `check ${one.name} ${one.bucket === 'cancel' ? 'cancelled' : 'failing'}`, owner: 'agent', release: 'fix what it reports and push, or rerun it (gh run rerun <run-id> --failed)' }
          : { kind: 'ci-running', id: one.name, said: `check ${one.name} running`, owner: 'gate', release: `wait for it (gh pr checks ${rec.pr ?? ''} --watch)` },
      )
    }
  }
  return { phase, head: at.head, ...(waiver === undefined ? {} : { waiver }), setAside, mayProceed: blockers.length === 0, blockers }
}

const OWNERS: Record<Blocker['owner'], string> = { agent: 'yours', codex: 'the gate (Codex)', person: "the person's", gate: 'the gate' }

/** The standing in words (R79): every blocker once, skipping ids the text around it already named, with who acts and how. */
export function holdText(s: Standing, named: ReadonlySet<string> = new Set()): string {
  const what = s.phase === 'pre' ? 'pull request' : 'merge'
  const aside = s.setAside.length === 0 ? [] : [`Set aside by the post waiver (GitHub does not require them): ${s.setAside.join(', ')}.`]
  if (s.blockers.length === 0) return [...aside, `Nothing else holds the ${what} of ${short(s.head)}.`].join('\n')
  const rest = s.blockers.filter(one => one.id === undefined || !named.has(one.id))
  if (rest.length === 0) return aside.join('\n')
  const heading = named.size > 0 ? 'Also holding:' : `Everything between ${short(s.head)} and the ${what}:`
  return [...aside, heading, ...rest.map(one => `- ${one.said} (${OWNERS[one.owner]}: ${one.release})`)].join('\n')
}
```

Import the `Blocker`, `CheckState` and `Standing` types from `'../types'` at the top of `lifecycle.ts`. `decideNext` is defined later in the same file; a function declaration is hoisted, so the call is fine.

- [ ] **Step 4: Run the suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pr-lifecycle/types/index.d.ts pr-lifecycle/hooks/lifecycle.ts pr-lifecycle/tests/lifecycle.test.ts
git commit -m "pr-lifecycle: standingOf and holdText, everything between a head and its merge (R79)"
```

---

