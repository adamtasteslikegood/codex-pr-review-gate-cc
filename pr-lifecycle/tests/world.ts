import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Run } from '../types'

export const RUN = { plugin: 'pr-lifecycle', key: 'run' } as const
export const TRAILER = 'PR_GATE_RESULT'

export type World = {
  spawned: { prompt: string; description?: string }[]
  prompts: string[]
  opened: string[]
  git: {
    head: string
    dirty: string
    numstat: string
    branch: string
    since: string
    /** `git diff --raw` against the base. */
    raw: string
    /** Whether a submodule commit is on the submodule's origin. */
    isLanded: boolean
    /** `git diff -U0` of a package file. */
    pkgDiff: string
    /** Commits not on the other base, as `rev-list` prints them. */
    left: string
    /** `git diff --name-only` between two heads: the files a new commit touched. */
    changed: string
  }
  /** The run as the mod last wrote it. */
  run?: Run
  /** The plugin's store, as the mod wrote it. */
  store: Map<string, unknown>
  stored: (key: string) => unknown
  /** The test's clock: `advance` moves it, and fires what falls due. */
  clock?: { advance: (ms: number) => Promise<void> }
}

export const runOf = async (w: World): Promise<Run> => w.run as Run

/** Everything beneath the mod: git, the agents, the main agent's prompt queue. */
export function world(on: On): World {
  const w: World = {
    spawned: [],
    prompts: [],
    opened: [],
    git: {
      head: 'a'.repeat(40),
      dirty: '',
      numstat: '10\t2\tsrc/app.ts',
      branch: 'feat/x',
      since: '',
      raw: '',
      isLanded: false,
      pkgDiff: '',
      left: 'x',
      changed: 'src/app.ts',
    },
    store: new Map(),
    stored: (key: string) => w.store.get(key),
  }
  w.clock = mock.clock(on, { now: 1_000 })
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('state.set', RUN, (_$, e, next) => {
    w.run = e.value as Run
    return next(e)
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(1).join(' ')
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args.startsWith('rev-parse --show-toplevel')) return out('/repo\n')
    if (args.startsWith('rev-parse --abbrev-ref')) return out(`${w.git.branch}\n`)
    if (args.startsWith('rev-parse --verify')) return out('b\n')
    if (args.startsWith('rev-parse HEAD')) return out(`${w.git.head}\n`)
    if (args.startsWith('status')) return out(w.git.dirty)
    if (args.startsWith('diff --numstat origin/')) return out(w.git.numstat)
    if (args.startsWith('diff --raw')) return out(w.git.raw)
    if (args.startsWith('diff -U0')) return out(w.git.pkgDiff)
    if (args.startsWith('merge-base --is-ancestor')) return out('', w.git.isLanded ? 0 : 1)
    if (args.startsWith('rev-list --no-merges')) return out(w.git.left)
    if (args.startsWith('diff --numstat')) return out(w.git.since)
    if (args.startsWith('diff --name-only')) return out(w.git.changed)
    if (args.startsWith('remote get-url')) return out('https://github.com/me/repo.git\n')
    return out('')
  })
  on('agent.spawn', (_$, e) => {
    w.spawned.push({ prompt: e.prompt, description: e.description })
    return { model: 'test', agentId: `agent-${w.spawned.length}` }
  })
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    w.opened.push(e.command)
    return { result: { stdout: 'https://github.com/me/repo/pull/1', stderr: '', interrupted: false } as never }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  return w
}

export const review = (step: string, gate: string, findings: object[] = [], extra: object = {}) =>
  `Codex said things.\n${TRAILER}\n${JSON.stringify({ step, gate, findings, ...extra })}`

export const P1 = { severity: 'P1', title: 'Unvalidated redirect', file: 'src/app.ts', line: 12 }
export const P2 = { severity: 'P2', title: 'Rename this', file: 'src/app.ts', line: 3 }

export const turn = (answer: string, agentId?: string) => ({
  answer,
  agentId,
  durationMs: 1,
  isAborted: false,
  turnId: `turn-${agentId ?? 'main'}`,
  reason: 'answer' as const,
})

export const isHeld = (ran: { deny?: string; isError?: boolean }): boolean => ran.deny !== undefined || ran.isError === true

export const createPr = { tool: 'Bash' as const, command: 'gh pr create --base dev --title "feat: x [KAN-1]"' }
