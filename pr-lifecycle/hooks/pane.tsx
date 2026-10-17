// The pane: the status display for /pr-gate. It only reads (the run, the lifecycle record, the clock); nothing here starts a run or writes state,
// except the Stop button, which the person presses.

import type { EngineInterface, RenderInput } from 'claude-code'

import type { Finding, LifecycleRecord, Run, Step } from '../types'
import { isBlocking } from './core'
import { isAcceptedRebuttal, isDisputed, isReverifyOwed, mergeHolds, usedRounds, waivedIds } from './lifecycle'
import { elapsed, finish, SPINNER } from './round'

type Engine = EngineInterface

const COMMAND = 'pr-gate'
/** The record's message is one line in the pane: this many characters, then an ellipsis. */
const MESSAGE_CHARS = 160

const truncate = (text: string, chars: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > chars ? `${one.slice(0, chars - 1)}…` : one
}

/** The budget line: the phase, the rounds drawn on the one allowance, and the free baseline rounds after the PR opened. */
const budgetOf = (rec: LifecycleRecord): string => {
  const phase = rec.phase === 'pre' ? 'pre-PR' : rec.phase === 'post' ? 'post-PR' : rec.phase
  const total = rec.allowance + rec.grants.reduce((sum, one) => sum + one.n, 0)
  const baseline = Math.min(2, rec.rounds.filter(one => one.phase === 'post' && one.kind === 'baseline' && one.isCompleted).length)
  return `${phase} · ${usedRounds(rec)}/${total} rounds used${rec.phase === 'pre' ? '' : ` · baseline ${baseline}/2`}`
}

/** What the person is awaited for: the findings that hold the merge and only their waiver releases (a deferral, a dispute). */
const awaitedOf = (rec: LifecycleRecord): string =>
  mergeHolds(rec)
    .filter(one => one.status === 'deferred' || isDisputed(one))
    .map(one => `${one.id} (${isDisputed(one) ? 'disputed' : 'deferred'})`)
    .join(', ')

/** The findings to list: a running round's own copy while it runs, the record's once it stops, and the record's findings the run never carried. */
const rowsOf = (run: Run | null, rec: LifecycleRecord | undefined): Finding[] => {
  const stored = new Map((rec?.findings ?? []).map(one => [one.id, one]))
  const carried = new Set((run?.findings ?? []).map(one => one.id))
  const fromRun = (run?.findings ?? []).map(one => (run?.status === 'running' ? one : (stored.get(one.id) ?? one)))
  return [...fromRun, ...(rec?.findings ?? []).filter(one => !carried.has(one.id))]
}

/** The status line's color: the run's outcome, or a warning when only a record is left. */
/** The Codex models a round ran on, as the reviewers reported them (R69), else the one the gate named; with a trailing space. */
const modelsOf = (run: Run): string => {
  const ran = [...new Set(Object.values(run.ranModels ?? {}))]
  const shown = ran.length > 0 ? ran.join('/') : run.codexModel
  return shown === undefined ? '' : `${shown} `
}

const colorOf = (run: Run | null): 'success' | 'claude' | 'warning' | 'error' => {
  if (run === null || run.status === 'waived') return 'warning'
  return run.status === 'passed' ? 'success' : run.status === 'running' ? 'claude' : 'error'
}

type Mark = { glyph: string; said: string; isSettled: boolean; isOwed: boolean; isStruck: boolean; isVerify?: true }

/** One finding in words: the mark, what stands, and whether it is settled, owed a check, or struck through (only a verified fix is). */
const markOf = (one: Finding, rec: LifecycleRecord | undefined): Mark => {
  const last = one.history.at(-1)
  const wasAccepted = one.status === 'rebutted' && last?.by === 'codex' && last.status === 'rebutted'
  const isWaived = rec !== undefined && waivedIds(rec).has(one.id)
  const waived = isWaived ? rec.waivers.find(w => w.scope === 'finding' && w.findingId === one.id && w.lapsedAt === undefined) : undefined
  const hasLapsed = rec?.waivers.some(w => w.scope === 'finding' && w.findingId === one.id && w.lapsedAt !== undefined) === true
  const lapse = hasLapsed && waived === undefined ? ' (waiver lapsed)' : ''
  if (waived !== undefined) return { glyph: '⊘', said: ` — waived: ${waived.reason}`, isSettled: true, isOwed: false, isStruck: false }
  if (isReverifyOwed(one) || (wasAccepted && one.needsRecheck === true)) {
    const glyph = one.status === 'rebutted' ? '↩' : '✔'
    return { glyph, said: ' — re-verify owed (file changed)', isSettled: false, isOwed: true, isStruck: false, isVerify: true }
  }
  if (one.status === 'verified-fixed') return { glyph: '✔', said: ' — verified fixed', isSettled: true, isOwed: false, isStruck: true }
  if (one.status === 'reported-fixed') {
    return { glyph: '✓', said: ` — reported fixed, unverified${lapse}`, isSettled: false, isOwed: true, isStruck: false, isVerify: true }
  }
  if (one.status === 'rebutted') {
    if (isAcceptedRebuttal(one)) return { glyph: '↩', said: ' — rebuttal accepted', isSettled: true, isOwed: false, isStruck: false }
    if (isDisputed(one)) return { glyph: '↩', said: ` — disputed: awaiting the person${lapse}`, isSettled: false, isOwed: true, isStruck: false }
    return { glyph: '↩', said: ` — rebuttal awaiting Codex${lapse}`, isSettled: false, isOwed: false, isStruck: false }
  }
  if (one.status === 'deferred') return { glyph: '⏸', said: ` — deferred${lapse}`, isSettled: false, isOwed: false, isStruck: false }
  return { glyph: isBlocking(one) ? '●' : '·', said: lapse, isSettled: false, isOwed: false, isStruck: false }
}

export function renderPane($: Engine, e: RenderInput<'Pane'>, run: Run | null, rec: LifecycleRecord | undefined, now: number) {
  const { Box, Button, Text } = $.ui.resolve(e)

  if (run === null && rec === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>PR lifecycle</Text>
        <Text dimColor>Not run yet. /{COMMAND} starts it; opening a PR to a gated base starts it too.</Text>
      </Box>
    )
  }

  const isRunning = run?.status === 'running'
  const frame = SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '⠋'
  const waiting = (run?.pending ?? []).filter(one => one.answer === undefined).length
  const headline =
    run === null
      ? ''
      : run.phase === 'review'
        ? `codex round ${run.round}`
        : run.phase === 'fix'
          ? run.fixKind === 'advisory'
            ? `addressing advisories, round ${run.round}`
            : `fixing round ${run.round}`
          : run.phase === 'verify'
            ? `reviewing the fix, round ${run.round}`
            : run.phase === 'collect'
              ? `collecting reviews, round ${run.round}`
              : run.phase === 'triage'
                ? `answering reviews, round ${run.round}`
                : 'sizing the change'
  const mark = (step: Step): string =>
    step.state === 'done' ? '✔' : step.state === 'failed' ? '✖' : step.state === 'skipped' ? '–' : step.state === 'running' ? (isRunning ? frame : '◐') : '○'
  const round = run?.round ?? -1
  const all = rowsOf(run, rec)
  const current = all.filter(one => one.round === round)
  const earlier = all.filter(one => one.round !== round)
  const room = Math.max(4, (e.viewport?.rows ?? 30) - (run?.steps.length ?? 0) - 12)
  const shown = [...current, ...earlier].slice(0, room)
  const hidden = all.length - shown.length
  const statusColor = colorOf(run)
  // The merge-hold count is mergeHolds itself, so the pane never disagrees with the merge guard.
  const holds = rec === undefined ? 0 : mergeHolds(rec).length
  const blockingOpen =
    rec === undefined
      ? current.filter(one => isBlocking(one) && one.status === 'open').length
      : all.filter(one => isBlocking(one) && one.status === 'open' && !waivedIds(rec).has(one.id)).length
  // Every row owed a check, by the predicate the rows use (a reported fix, a re-verify), at any severity.
  const owed = all.filter(one => markOf(one, rec).isVerify === true).length
  const heading =
    rec === undefined
      ? `Findings (${all.length}${current.some(isBlocking) ? `, ${blockingOpen} blocking open` : ''})`
      : `Findings (${all.length}, ${holds} holding the merge, ${blockingOpen} blocking open, ${owed} owed verification)`
  const awaited = rec !== undefined && !isRunning && rec.phase !== 'ready' && rec.postStatus === 'awaiting-decision' ? awaitedOf(rec) || undefined : undefined
  // A stop reason is stale mid-round: it shows only while no run is running.
  const message = rec?.message === undefined || isRunning ? undefined : truncate(rec.message, MESSAGE_CHARS)

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">
        {run?.branch ?? rec?.branch} → {run?.base ?? rec?.base}
      </Text>
      {rec !== undefined && (
        <Text dimColor wrap="truncate-end">
          {budgetOf(rec)}
        </Text>
      )}
      {run !== null && (
        <Text dimColor wrap="truncate-end">
          round {run.round}
          {run.fixKind === 'advisory' ? ' · advisories' : ''} · {run.tier} blast radius{run.lane === 'light' ? ' · light lane' : ''} · codex{' '}
          {modelsOf(run)}
          {run.effort} ·{' '}
          {elapsed((run.endedAt ?? now) - run.startedAt)}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        {run !== null && isRunning ? (
          <Text color="claude" wrap="truncate-end">
            {frame} in progress: {headline}
            {waiting > 0 ? ` · waiting on ${waiting} agent${waiting === 1 ? '' : 's'}` : ''} · {elapsed(now - run.phaseStartedAt)}
          </Text>
        ) : awaited !== undefined ? (
          <Text color="warning" bold wrap="truncate-end">
            {`awaiting your decision on ${awaited}`}
          </Text>
        ) : (
          <Text color={statusColor} bold wrap="truncate-end">
            {(run?.status ?? (rec?.phase === 'pre' ? rec.preStatus : rec?.postStatus) ?? rec?.phase ?? '').toUpperCase()}
          </Text>
        )}
        {run !== null && isRunning && run.activity !== '' && (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {run.activity}
          </Text>
        )}
        {run !== null && !isRunning && run.message !== undefined && run.message !== rec?.message && <Text wrap="wrap">{run.message}</Text>}
        {message !== undefined && (
          <Text dimColor wrap="truncate-end">
            {message}
          </Text>
        )}
      </Box>

      {run !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>To do</Text>
          {run.steps.map(step => (
            <Text
              key={`step-${step.id}`}
              wrap="truncate-end"
              dimColor={step.state === 'pending' || step.state === 'skipped'}
              color={step.state === 'failed' ? 'error' : step.state === 'running' ? 'claude' : undefined}
            >
              {mark(step)} {step.label}
              {step.detail === undefined ? '' : ` — ${step.detail}`}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>{heading}</Text>
        {all.length === 0 && <Text dimColor>None yet.</Text>}
        {shown.map(one => {
          const said = markOf(one, rec)
          const where = one.file === undefined ? '' : ` (${one.file}${one.line === undefined ? '' : `:${one.line}`})`
          return (
            <Text
              key={`finding-${one.id}`}
              wrap="truncate-end"
              dimColor={said.isSettled || ((one.round !== round || !isBlocking(one)) && !said.isOwed)}
              color={said.isOwed ? 'warning' : one.round === round && isBlocking(one) && one.status === 'open' ? 'error' : undefined}
              strikethrough={said.isStruck}
            >
              {`${said.glyph} ${one.id} [${one.severity}] ${one.title}${where}${said.said}`}
            </Text>
          )
        })}
        {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
      </Box>

      {run !== null && isRunning && (
        <Box marginTop={1}>
          <Button key="stop" label="Stop the gate" onPress={() => void finish($, run.id, 'stopped', 'Stopped by the person.')} />
        </Box>
      )}
    </Box>
  )
}
