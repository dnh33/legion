import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalCard, TaskView, ThreadRow } from '../../../types/index.d.ts'
import {
  CONTINUED_TEXT, ERROR_TEXT, REFUSAL_TEXT, STOPPED_TEXT, isResumable, isTurnLimitPause, moodFor, reduceTask, reduceThread,
  type RunEvent,
} from '../../../src/engine/runs.ts'
import { turnLimitText } from '../../../src/engine/continue.ts'
import { estimateUsd } from '../../../src/engine/cost.ts'

const S = { maxTurns: 50 }
const base = (o: Partial<TaskView> = {}): TaskView => ({
  id: 't1', agentId: 'builder', title: 'fix it', status: 'queued', sessionId: 's1', isEscalated: false, isTainted: false, turns: 0, runTurns: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, ...o,
})
const run = (events: RunEvent[], start?: TaskView): TaskView => events.reduce<TaskView | undefined>((t, ev, i) => reduceTask(t, ev, 100 + i, S), start)!
const thread = (events: RunEvent[], rows: ThreadRow[] = []): ThreadRow[] => events.reduce((r, ev, i) => reduceThread(r, ev, 100 + i, S), rows)
const card = (id: string): ApprovalCard => ({ id, taskId: 't1', agentId: 'builder', tool: 'Bash', summary: 'npm test', isClickOnly: false, at: 5 })
const usage = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }

test('a run that hits the turn limit pauses with the desktop text; steps, tokens, cost and taint add up', () => {
  const t = run([
    { type: 'queued', task: base({ error: 'old' }) },
    { type: 'started', taskId: 't1', runId: 'r1', model: 'sonnet' },
    { type: 'step', runId: 'r1' }, { type: 'step', runId: 'r1' }, { type: 'step', runId: 'r1' },
    { type: 'tool', runId: 'r1', toolUseId: 'u1', tool: 'Read', summary: 'a.ts' },
    { type: 'tool', runId: 'r1', toolUseId: 'u2', tool: 'Bash', summary: 'npm test' },
    { type: 'finished', runId: 'r1', reason: 'answer', answer: 'partial', usage, model: 'claude-sonnet-5-5', isTurnLimit: true },
  ])
  assert.equal(t.status, 'paused')
  assert.equal(t.error, turnLimitText(50))
  assert.equal(t.turns, 3)
  assert.equal(t.runTurns, 3)
  assert.equal(t.isTainted, true)
  assert.deepEqual(t.tokens, usage)
  assert.equal(t.costUsd, estimateUsd('claude-sonnet-5-5', usage).usd)
  assert.equal(t.model, 'claude-sonnet-5-5')
  assert.equal(t.updatedAt, 107)
  assert.equal(isTurnLimitPause(t), true)
  assert.equal(isResumable(t), true)
})

test('status rules: done, error with text or a plain fallback, refusal, aborted, stopped stays cancelled', () => {
  const live = [{ type: 'queued', task: base() }, { type: 'started', taskId: 't1', runId: 'r1', model: 'opus' }] as RunEvent[]
  const end = (e: Partial<Extract<RunEvent, { type: 'finished' }>>) => run([...live, { type: 'finished', runId: 'r1', reason: 'answer', answer: 'x', ...e } as RunEvent])
  assert.equal(end({}).status, 'done')
  assert.equal(end({}).error, undefined)
  assert.deepEqual([end({ reason: 'error', errorText: 'API overloaded' }).status, end({ reason: 'error', errorText: 'API overloaded' }).error], ['error', 'API overloaded'])
  assert.equal(end({ reason: 'error', errorText: '   ' }).error, ERROR_TEXT)
  assert.deepEqual([end({ reason: 'refusal' }).status, end({ reason: 'refusal' }).error], ['error', REFUSAL_TEXT])
  assert.equal(end({ reason: 'aborted' }).status, 'cancelled')
  assert.equal(end({ isTurnLimit: false }).status, 'done')
  const stopped = run([...live, { type: 'stopped', taskId: 't1' }])
  assert.equal(stopped.status, 'cancelled')
  assert.equal(run([{ type: 'finished', runId: 'r1', reason: 'answer', answer: 'late' }], stopped).status, 'cancelled', 'a stopped task stays cancelled')
  assert.equal(run([{ type: 'stopped', taskId: 't1' }], end({})).status, 'done', 'stopping a finished task changes nothing')
  assert.equal(isResumable(end({ reason: 'error' })), true)
  assert.equal(isResumable(base({ status: 'error' })), false, 'no run to resume')
  assert.equal(isResumable(run(live)), false, 'running')
  assert.equal(isTurnLimitPause({ status: 'error', error: turnLimitText(3) }), true, 'the desktop\'s error-status form')
  assert.equal(isTurnLimitPause({ status: 'error', error: 'boom' }), false)
})

test('started and continued clear the error; escalation marks the task once; stale and foreign events change nothing', () => {
  const failed = run([{ type: 'queued', task: base() }, { type: 'started', taskId: 't1', runId: 'r1', model: 'sonnet' }, { type: 'finished', runId: 'r1', reason: 'error', answer: '', errorText: 'boom' }])
  const cont = run([{ type: 'continued', taskId: 't1', runId: 'r2' }], failed)
  assert.deepEqual([cont.status, cont.error, cont.runId], ['running', undefined, 'r2'])
  const restarted = run([{ type: 'started', taskId: 't1', runId: 'r3', model: 'opus' }], failed)
  assert.deepEqual([restarted.status, restarted.error, restarted.model], ['running', undefined, 'opus'])
  const stepped = run([{ type: 'step', runId: 'r3' }, { type: 'step', runId: 'r3' }], restarted)
  assert.deepEqual([stepped.turns, stepped.runTurns], [restarted.turns + 2, 2])
  assert.equal(run([{ type: 'continued', taskId: 't1', runId: 'r5' }], stepped).runTurns, 0, 'continued resets the run count')
  assert.equal(run([{ type: 'started', taskId: 't1', runId: 'r6', model: 'opus' }], base({ runTurns: 9 })).runTurns, 0, 'started resets it')
  const esc = run([{ type: 'escalated', taskId: 't1', runId: 'r3' }], restarted)
  assert.deepEqual([esc.isEscalated, esc.model], [true, 'opus'])
  for (const ev of [
    { type: 'step', runId: 'old' }, { type: 'tool', runId: 'old', toolUseId: 'x', tool: 'Bash', summary: '' },
    { type: 'finished', runId: 'old', reason: 'answer', answer: '' }, { type: 'started', taskId: 'other', runId: 'r9', model: 'x' },
    { type: 'stopped', taskId: 'other' }, { type: 'escalated', taskId: 't1', runId: 'old' }, { type: 'queued', task: base({ id: 'other' }) },
    { type: 'card', card: card('u9') }, { type: 'reply', runId: 'r3', text: 'hi' },
  ] as RunEvent[]) assert.equal(reduceTask(restarted, ev, 999, S), restarted, ev.type)
  assert.equal(reduceTask(undefined, { type: 'step', runId: 'r1' }, 1, S), undefined)
  // cost accumulates across runs
  const two = run([
    { type: 'finished', runId: 'r3', reason: 'answer', answer: '', usage, model: 'opus' },
    { type: 'continued', taskId: 't1', runId: 'r4' },
    { type: 'finished', runId: 'r4', reason: 'answer', answer: '', usage, model: 'opus' },
  ], restarted)
  assert.equal(two.tokens.input, 2000)
  assert.ok(Math.abs(two.costUsd - 2 * estimateUsd('opus', usage).usd) < 1e-12)
})

test('a re-queued task keeps its tokens, cost, turns, taint and escalation', () => {
  const before = run([
    { type: 'queued', task: base() },
    { type: 'started', taskId: 't1', runId: 'r1', model: 'sonnet' },
    { type: 'step', runId: 'r1' },
    { type: 'tool', runId: 'r1', toolUseId: 'u1', tool: 'WebFetch', summary: 'x' },
    { type: 'escalated', taskId: 't1', runId: 'r1' },
    { type: 'finished', runId: 'r1', reason: 'answer', answer: 'ok', usage, model: 'opus' },
  ])
  assert.ok(before.isTainted && before.isEscalated && before.turns === 1 && before.costUsd > 0)
  const again = run([{ type: 'queued', task: base({ title: 'follow-up', error: 'x' }) }], before) // rebuilt: untainted, zero cost
  assert.deepEqual([again.status, again.title, again.error], ['queued', 'follow-up', undefined])
  assert.deepEqual([again.isTainted, again.isEscalated, again.turns, again.costUsd, again.tokens], [true, true, 1, before.costUsd, before.tokens])
})

test('thread row ids carry the time: a reloaded thread (rows.length back at 0) never reuses an id', () => {
  const first = reduceThread([], { type: 'reply', runId: 'r1', text: 'one' }, 1_000)
  const afterReload = reduceThread([], { type: 'reply', runId: 'r1', text: 'two' }, 2_000)
  assert.notEqual(first[0]!.id, afterReload[0]!.id)
  assert.match(first[0]!.id, /^r1:a[0-9a-z]+-0$/)
})

test('thread: tool rows update in place; a denial stays denied; a card before its tool row makes one row', () => {
  const rows = thread([
    { type: 'queued', task: base(), prompt: 'Pin the clock.' },
    { type: 'tool', runId: 'r1', toolUseId: 'u1', tool: 'Read', summary: 'test/replay.test.ts' },
    { type: 'toolDone', runId: 'r1', toolUseId: 'u1', isError: false },
    { type: 'tool', runId: 'r1', toolUseId: 'u2', tool: 'Bash', summary: 'npm test' },
    { type: 'card', card: card('u2') },
    { type: 'cardDone', toolUseId: 'u2', allowed: false },
    { type: 'toolDone', runId: 'r1', toolUseId: 'u2', isError: true },
    { type: 'card', card: card('u3') },
    { type: 'tool', runId: 'r1', toolUseId: 'u3', tool: 'Bash', summary: 'npm test' },
    { type: 'cardDone', toolUseId: 'u3', allowed: true },
    { type: 'toolDone', runId: 'r1', toolUseId: 'u3', isError: true },
    { type: 'tool', runId: 'r1', toolUseId: 'u1', tool: 'Read', summary: 'again' }, // replay: no new row
    { type: 'toolDone', runId: 'r1', toolUseId: 'u1', isError: true }, // a late result does not reopen a finished row
  ])
  assert.deepEqual(rows.map((r) => [r.id, r.role, r.tool?.state ?? r.text]), [
    [rows[0]!.id, 'user', 'Pin the clock.'], ['u1', 'tool', 'ok'], ['u2', 'tool', 'denied'], ['u3', 'tool', 'error'],
  ])
  assert.deepEqual(rows[3]!.tool, { name: 'Bash', summary: 'npm test', state: 'error' })
  assert.equal(rows[1]!.tool!.summary, 'test/replay.test.ts')
})

test('thread: replies, the final answer once, the pause line, errors, stop, continue, escalation', () => {
  const rows = thread([
    { type: 'reply', runId: 'r1', text: 'Working on it.' },
    { type: 'reply', runId: 'r1', text: '   ' },
    { type: 'reply', runId: 'r1', text: 'Done.' },
    { type: 'finished', runId: 'r1', reason: 'answer', answer: 'Done.', isTurnLimit: true },
    { type: 'finished', runId: 'r1', reason: 'answer', answer: 'Done.', isTurnLimit: true },
    { type: 'continued', taskId: 't1', runId: 'r2' },
    { type: 'continued', taskId: 't1', runId: 'r2' },
    { type: 'finished', runId: 'r2', reason: 'error', answer: 'Last words.', errorText: 'boom' },
    { type: 'finished', runId: 'r2', reason: 'error', answer: 'Last words.', errorText: 'boom' },
    { type: 'escalated', taskId: 't1', runId: 'r2', errorText: 'boom' },
    { type: 'finished', runId: 'r3', reason: 'refusal', answer: '' },
    { type: 'finished', runId: 'r4', reason: 'aborted', answer: '' },
    { type: 'stopped', taskId: 't1' },
  ])
  assert.deepEqual(rows.map((r) => `${r.role}:${r.text}`), [
    'assistant:Working on it.', 'assistant:Done.', 'system:Paused at the turn limit (50 turns this run).', `system:${CONTINUED_TEXT}`,
    'assistant:Last words.', 'system:Error: boom', 'system:Escalated to Opus: error_during_execution: boom', `system:Error: ${REFUSAL_TEXT}`,
    `system:${STOPPED_TEXT}`,
  ])
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'unique ids')
  // cancelled is final: after a stop, the stopped run's late error or pause adds no row; after a new prompt or Continue it does
  const stopped = thread([{ type: 'stopped', taskId: 't1' }, { type: 'finished', runId: 'r7', reason: 'error', answer: '', errorText: 'late' }, { type: 'finished', runId: 'r8', reason: 'answer', answer: '', isTurnLimit: true }])
  assert.deepEqual(stopped.map((r) => r.text), [STOPPED_TEXT])
  const resumed = thread([{ type: 'stopped', taskId: 't1' }, { type: 'continued', taskId: 't1', runId: 'r9' }, { type: 'finished', runId: 'r9', reason: 'error', answer: '', errorText: 'real' }])
  assert.deepEqual(resumed.map((r) => r.text), [STOPPED_TEXT, CONTINUED_TEXT, 'Error: real'])
  const noSettings = reduceThread([], { type: 'finished', runId: 'r1', reason: 'answer', answer: '', isTurnLimit: true }, 1)
  assert.equal(noSettings[0]!.text, 'Paused at the turn limit.')
})

test('moodFor: each event\'s mood', () => {
  const cases: Array<[RunEvent, string | undefined]> = [
    [{ type: 'queued', task: base() }, 'listening'],
    [{ type: 'started', taskId: 't1', runId: 'r', model: 'x' }, 'thinking'],
    [{ type: 'step', runId: 'r' }, 'thinking'],
    [{ type: 'tool', runId: 'r', toolUseId: 'u', tool: 'Bash', summary: '' }, 'hacking'],
    [{ type: 'toolDone', runId: 'r', toolUseId: 'u', isError: false }, undefined],
    [{ type: 'card', card: card('u') }, 'awaiting'],
    [{ type: 'cardDone', toolUseId: 'u', allowed: true }, 'hacking'],
    [{ type: 'cardDone', toolUseId: 'u', allowed: false }, 'thinking'],
    [{ type: 'reply', runId: 'r', text: 'x' }, 'thinking'],
    [{ type: 'finished', runId: 'r', reason: 'answer', answer: '' }, 'victory'],
    [{ type: 'finished', runId: 'r', reason: 'answer', answer: '', isTurnLimit: true }, 'awaiting'],
    [{ type: 'finished', runId: 'r', reason: 'error', answer: '' }, 'error'],
    [{ type: 'finished', runId: 'r', reason: 'refusal', answer: '' }, 'error'],
    [{ type: 'finished', runId: 'r', reason: 'aborted', answer: '' }, 'idle'],
    [{ type: 'stopped', taskId: 't1' }, 'idle'],
    [{ type: 'continued', taskId: 't1', runId: 'r' }, 'thinking'],
    [{ type: 'escalated', taskId: 't1', runId: 'r' }, 'thinking'],
  ]
  for (const [ev, want] of cases) assert.equal(moodFor(ev), want, JSON.stringify(ev))
})
