import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentView, TaskStatus, TaskView, ThreadRow } from '../../../types/index.d.ts'
import { memoryPort } from '../../../src/store/memory-port.ts'
import {
  CUT_MARKER,
  DEFAULT_SETTINGS,
  MAX_ROW_TEXT,
  MAX_TASKS,
  capText,
  capTasks,
  createAgentStore,
  createSettingsStore,
  createTaskStore,
  createThreadStore,
  validateSettingsPatch,
} from '../../../src/store/stores.ts'
import { tickClock } from './helpers.ts'

function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    id,
    agentId: 'builder',
    title: `task ${id}`,
    status: 'running',
    sessionId: 'S',
    isEscalated: false,
    isTainted: false,
    turns: 0,
    runTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    origin: { kind: 'person' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

// ---------------------------------------------------------------------------------------------------------------- tasks

test('tasks: put, update, remove; newest first by creation; survives a reopen', async () => {
  const port = memoryPort()
  const s = createTaskStore(port, 'A')
  assert.deepEqual(await s.load(), [])
  await s.put(task('t_1', { createdAt: 10 }))
  await s.put(task('t_2', { createdAt: 20 }))
  await s.put(task('t_3', { createdAt: 15 }))
  await s.put(task('t_1', { createdAt: 10, status: 'done', turns: 4 }))
  await s.remove('t_3')
  assert.deepEqual(s.list().map(t => t.id), ['t_2', 't_1'])
  const reopened = await createTaskStore(port, 'A').load()
  assert.deepEqual(reopened.map(t => [t.id, t.status, t.turns]), [['t_2', 'running', 0], ['t_1', 'done', 4]])
})

test('tasks: a put keeps its own copy (a caller mutating its object later changes nothing)', async () => {
  const s = createTaskStore(memoryPort(), 'A')
  await s.load()
  const t = task('t_1')
  await s.put(t)
  t.title = 'mutated'
  assert.equal(s.list()[0]!.title, 'task t_1')
})

test('tasks: bad input is refused with a clear error', async () => {
  const s = createTaskStore(memoryPort(), 'A')
  await s.load()
  await assert.rejects(s.put(task('../x')), /tasks: not a task/)
  await assert.rejects(s.put({ ...task('t_1'), status: 'flying' as TaskStatus }), /not a task/)
  await assert.rejects(s.remove('a/b'), /bad id/)
})

test('tasks: two windows, last writer wins, and refresh reports changed and removed tasks', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createTaskStore(port, 'A', { now: clock.now })
  const b = createTaskStore(port, 'B', { now: clock.now })
  await a.load()
  await b.load()
  await a.put(task('t_1', { title: 'from A' }))
  await a.put(task('t_2'))
  let ch = await b.refresh()
  assert.deepEqual(ch.changed.map(t => t.id).sort(), ['t_1', 't_2'])
  await b.put(task('t_1', { title: 'from B' }))
  await b.remove('t_2')
  ch = await a.refresh()
  assert.deepEqual(ch.changed.map(t => t.title), ['from B'])
  assert.deepEqual(ch.removed, ['t_2'])
  assert.deepEqual(ch.tasks.map(t => t.id), ['t_1'])
  ch = await a.refresh()
  assert.deepEqual([ch.changed, ch.removed], [[], []])
})

test("tasks: another window's file caught mid-rewrite never makes its tasks vanish from this window", async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createTaskStore(port, 'A', { now: clock.now })
  const b = createTaskStore(port, 'B', { now: clock.now })
  await a.load()
  await b.put(task('t_b1', { createdAt: 1 }))
  await b.put(task('t_b2', { createdAt: 2 }))
  await a.refresh()
  const full = port.files.get('tasks/seg-B-0.jsonl')!.text
  await port.write('tasks/seg-B-0.jsonl', '') // B's rewrite truncated the file and has not written it yet
  assert.deepEqual((await a.refresh()).removed, [])
  await a.put(task('t_a1', { createdAt: 3 }))
  assert.deepEqual(a.list().map(t => t.id), ['t_a1', 't_b2', 't_b1'])
  await port.write('tasks/seg-B-0.jsonl', full)
  assert.deepEqual((await a.refresh()).changed, [])
})

test("tasks: a dead window's tasks are adopted by a live one's compaction and stay listed; heartbeat keeps a window alive", async () => {
  const clock = tickClock()
  const port = memoryPort({ now: clock.now })
  const d = createTaskStore(port, 'D', { now: clock.now })
  const b = createTaskStore(port, 'B', { now: clock.now })
  const a = createTaskStore(port, 'A', { now: clock.now })
  await d.load()
  await b.load()
  await a.load()
  await d.put(task('t_d', { createdAt: 1 }))
  await b.put(task('t_b', { createdAt: 2 }))
  await a.put(task('t_a', { createdAt: 3 }))
  await b.refresh()
  clock.set(clock.now() + 25 * 60 * 60 * 1000)
  await b.heartbeat() // B is idle but its window is open: it stays alive
  await a.heartbeat()
  await a.compact()
  assert.equal(JSON.parse(port.files.get('tasks/gen-D.json')!.text).adoptedBy, 'A')
  assert.equal(port.files.has('tasks/gen-B.json'), false)
  assert.deepEqual((await createTaskStore(port, 'R').load()).map(t => t.id), ['t_a', 't_b', 't_d'])
  const ch = await b.refresh()
  assert.deepEqual([ch.changed, ch.removed], [[], []], 'moved records are not changes')
  assert.deepEqual(ch.tasks.map(t => t.id), ['t_a', 't_b', 't_d'])
})

test('tasks: the cap keeps 500 and drops the oldest finished tasks only', () => {
  const tasks: TaskView[] = []
  for (let i = 0; i < 480; i++) tasks.push(task(`t_r${i}`, { status: (['running', 'queued', 'paused'] as const)[i % 3], updatedAt: i }))
  for (let i = 0; i < 40; i++) tasks.push(task(`t_f${i}`, { status: (['done', 'error', 'cancelled'] as const)[i % 3], updatedAt: 1000 + i }))
  const kept = capTasks(tasks)
  assert.equal(kept.length, MAX_TASKS)
  const dropped = tasks.filter(t => !kept.includes(t)).map(t => t.id)
  assert.deepEqual(dropped, Array.from({ length: 20 }, (_, i) => `t_f${i}`))
  // All unfinished: none can go, even past the cap.
  const busy = Array.from({ length: 510 }, (_, i) => task(`t_b${i}`, { status: 'running' }))
  assert.equal(capTasks(busy).length, 510)
})

test('tasks: compaction keeps the fold, drops superseded records, and a delete hides another window\'s put until that put is gone', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createTaskStore(port, 'A', { now: clock.now })
  const b = createTaskStore(port, 'B', { now: clock.now })
  await a.load()
  await b.load()
  await b.put(task('t_x'))
  for (let i = 0; i < 5; i++) await a.put(task('t_1', { turns: i }))
  await a.refresh()
  await a.remove('t_x') // A deletes B's task
  await a.compact()
  let tasksFiles = [...port.files.entries()].filter(([p, f]) => p.startsWith('tasks/seg-A') && f.text !== '')
  let lines = tasksFiles.flatMap(([, f]) => f.text.trim().split('\n'))
  assert.equal(lines.length, 2, 'the latest t_1 put and the t_x tombstone')
  const fresh = await createTaskStore(port, 'R').load()
  assert.deepEqual(fresh.map(t => [t.id, t.turns]), [['t_1', 4]])
  await b.refresh()
  await b.compact() // B's put of t_x is superseded by A's delete: dropped
  await a.refresh()
  await a.compact() // nobody holds t_x any more: the tombstone goes too
  tasksFiles = [...port.files.entries()].filter(([p, f]) => p.startsWith('tasks/seg-') && f.text !== '')
  lines = tasksFiles.flatMap(([, f]) => f.text.trim().split('\n'))
  assert.equal(lines.length, 1)
  assert.deepEqual((await createTaskStore(port, 'R2').load()).map(t => t.id), ['t_1'])
})

test('tasks: compaction runs by itself once own records grow', async () => {
  const port = memoryPort()
  const s = createTaskStore(port, 'A', { compactAt: 4000 })
  await s.load()
  for (let i = 0; i < 40; i++) await s.put(task('t_1', { turns: i }))
  assert.ok(port.files.has('tasks/gen-A.json'), 'compacted')
  assert.deepEqual((await createTaskStore(port, 'R').load()).map(t => t.turns), [39])
})

// -------------------------------------------------------------------------------------------------------------- threads

const row = (id: string, at: number, over: Partial<ThreadRow> = {}): ThreadRow => ({ id, role: 'assistant', text: `row ${id}`, at, ...over })

test('threads: append and load the last rows; each task reads only its own folder', async () => {
  const port = memoryPort()
  const s = createThreadStore(port, 'A')
  await s.append('t_1', Array.from({ length: 250 }, (_, i) => row(`r${i}`, i)))
  await s.append('t_2', [row('other', 1)])
  const fresh = createThreadStore(port, 'A')
  port.reads.length = 0
  const rows = await fresh.load('t_1')
  assert.equal(rows.length, 200)
  assert.equal(rows[0]!.id, 'r50')
  assert.equal(rows.at(-1)!.id, 'r249')
  assert.ok(port.reads.every(p => p.startsWith('threads/t_1/')), port.reads.join(' '))
  assert.deepEqual((await fresh.load('t_1', 3)).map(r => r.id), ['r247', 'r248', 'r249'])
  assert.deepEqual(await fresh.load('t_none'), [])
  await assert.rejects(fresh.load('t_1', 0), /limit/)
  await assert.rejects(fresh.load('../t_1'), /bad id/)
})

test('threads: a later record for the same row updates it in place, before and after compaction', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const s = createThreadStore(port, 'A', { now: clock.now })
  await s.append('t_1', [row('u', 1, { role: 'user' }), row('tool', 2, { role: 'tool', tool: { name: 'Bash', summary: 'npm test', state: 'running' } })])
  await s.append('t_1', [row('a', 3)])
  await s.append('t_1', [row('tool', 2, { role: 'tool', tool: { name: 'Bash', summary: 'npm test', state: 'ok' } })])
  const view = (rows: ThreadRow[]): string[] => rows.map(r => `${r.id}${r.tool ? `:${r.tool.state}` : ''}`)
  assert.deepEqual(view(await s.load('t_1')), ['u', 'tool:ok', 'a'])
  await s.compact('t_1')
  assert.deepEqual(view(await createThreadStore(port, 'R').load('t_1')), ['u', 'tool:ok', 'a'])
})

test('threads: refresh hands another window\'s new rows, undefined when nothing changed', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createThreadStore(port, 'A', { now: clock.now })
  const b = createThreadStore(port, 'B', { now: clock.now })
  await a.append('t_1', [row('r1', 1)])
  assert.deepEqual((await b.refresh('t_1'))!.map(r => r.id), ['r1'])
  assert.equal(await b.refresh('t_1'), undefined)
  await a.append('t_1', [row('r2', 2)])
  assert.deepEqual((await b.refresh('t_1'))!.map(r => r.id), ['r1', 'r2'])
})

test('threads: text over 8000 characters is cut to exactly 8000 with a visible marker', async () => {
  const s = createThreadStore(memoryPort(), 'A')
  await s.append('t_1', [row('long', 1, { text: 'x'.repeat(20_000) }), row('short', 2, { text: 'y'.repeat(MAX_ROW_TEXT) })])
  const [long, short] = await s.load('t_1')
  assert.equal(long!.text.length, MAX_ROW_TEXT)
  assert.ok(long!.text.endsWith(CUT_MARKER))
  assert.equal(short!.text, 'y'.repeat(MAX_ROW_TEXT), 'exactly at the limit: untouched')
  // A cut never leaves half a surrogate pair.
  const emoji = capText('😀'.repeat(5000))
  assert.ok(emoji.length <= MAX_ROW_TEXT)
  assert.ok(emoji.endsWith(CUT_MARKER))
  assert.doesNotMatch(emoji.slice(0, -CUT_MARKER.length), /[\uD800-\uDBFF]$/)
  await assert.rejects(s.append('t_1', [{ id: '', role: 'user', text: 'x', at: 1 }]), /not a thread row/)
})

// ------------------------------------------------------------------------------------------------------------- settings

test('settings: defaults (maxTurns 40, the desktop default), patch, reopen', async () => {
  const port = memoryPort()
  const s = createSettingsStore(port, 'A')
  assert.deepEqual(await s.load(), { theme: 'auto', motion: true, twoD: false, maxTurns: 40, fullMode: 'acceptEdits' })
  assert.deepEqual(await s.patch({ motion: false, maxTurns: 250 }), { ...DEFAULT_SETTINGS, motion: false, maxTurns: 250 })
  await s.patch({ theme: 'light' })
  assert.deepEqual(await createSettingsStore(port, 'B').load(), { ...DEFAULT_SETTINGS, motion: false, maxTurns: 250, theme: 'light' })
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS))
})

test('settings: bad values and unknown keys are refused with a clear Error and nothing is stored', async () => {
  const port = memoryPort()
  const s = createSettingsStore(port, 'A')
  await s.load()
  const cases: Array<[unknown, RegExp]> = [
    [{ maxTurns: 0 }, /maxTurns must be an integer 1-1000/],
    [{ maxTurns: 1001 }, /maxTurns/],
    [{ maxTurns: 2.5 }, /maxTurns/],
    [{ maxTurns: '40' }, /maxTurns/],
    [{ theme: 'blue' }, /theme must be "auto", "dark" or "light"/],
    [{ fullMode: 'bypassPermissions' }, /fullMode must be "acceptEdits" or "auto"/],
    [{ motion: 'yes' }, /motion must be true or false/],
    [{ twoD: 1 }, /twoD must be true or false/],
    [{ volume: 3 }, /unknown setting "volume"/],
    [null, /must be an object/],
    [{ maxTurns: 0, theme: 'x' }, /maxTurns.*; theme/],
  ]
  for (const [p, re] of cases) await assert.rejects(s.patch(p as never), re, JSON.stringify(p))
  assert.equal(port.calls.write, 0)
  assert.deepEqual(validateSettingsPatch({ maxTurns: 1 }), { maxTurns: 1 })
  assert.deepEqual(validateSettingsPatch({ maxTurns: 1000 }), { maxTurns: 1000 })
})

test('settings: a stored invalid field is skipped and counted, its valid neighbours still apply', async () => {
  const port = memoryPort()
  const line = (q: number, patch: unknown): string => JSON.stringify({ s: 'X', q, t: q, op: { k: 'patch', patch } })
  await port.write('settings/seg-X-0.jsonl', [line(0, { maxTurns: 5000, motion: false }), line(1, { colour: 'red' }), line(2, 'nope')].join('\n') + '\n')
  const s = createSettingsStore(port, 'A')
  assert.deepEqual(await s.load(), { ...DEFAULT_SETTINGS, motion: false })
  assert.equal(s.invalid, 3)
})

test('settings: two windows win per field; compaction keeps only the fields each record still wins', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createSettingsStore(port, 'A', { now: clock.now })
  const b = createSettingsStore(port, 'B', { now: clock.now })
  await a.load()
  await b.load()
  await a.patch({ theme: 'dark', maxTurns: 100 })
  await b.patch({ maxTurns: 300 })
  await a.patch({ motion: false })
  assert.deepEqual(await b.refresh(), { ...DEFAULT_SETTINGS, theme: 'dark', maxTurns: 300, motion: false })
  assert.equal(await b.refresh(), undefined)
  await a.refresh()
  await a.compact()
  const aLines = [...port.files.entries()].filter(([p, f]) => p.startsWith('settings/seg-A') && f.text !== '').flatMap(([, f]) => f.text.trim().split('\n'))
  const patches = aLines.map(l => JSON.parse(l).op.patch)
  assert.deepEqual(patches, [{ theme: 'dark' }, { motion: false }], 'maxTurns 100 lost to B and is gone')
  assert.deepEqual(await createSettingsStore(port, 'R').load(), { ...DEFAULT_SETTINGS, theme: 'dark', maxTurns: 300, motion: false })
})

// --------------------------------------------------------------------------------------------------------------- agents

function agent(id: string, over: Partial<AgentView> = {}): AgentView {
  return { id, name: id, glyph: '✠', description: '', systemPrompt: `you are ${id}`, model: 'auto', approval: 'ask', isRoster: true, isHidden: false, ...over }
}
const SEED = [agent('zealot'), agent('builder', { glyph: '⌘' }), agent('assayer', { glyph: '⊜', isHidden: true })]

test('agents: seed order, an edit replaces its seed entry, person agents follow in creation order', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const s = createAgentStore(port, 'A', { now: clock.now })
  assert.deepEqual((await s.load(SEED)).map(a => a.id), ['zealot', 'builder', 'assayer'])
  await s.put(agent('mine2', { isRoster: false }))
  await s.put(agent('builder', { systemPrompt: 'edited', model: 'opus' }))
  await s.put(agent('mine1', { isRoster: true })) // a person's agent cannot claim to be roster
  await s.put(agent('mine2', { isRoster: false, name: 'Mine Two' }))
  const list = await createAgentStore(port, 'B').load(SEED)
  assert.deepEqual(list.map(a => [a.id, a.isRoster]), [['zealot', true], ['builder', true], ['assayer', true], ['mine2', false], ['mine1', false]])
  assert.equal(list[1]!.systemPrompt, 'edited')
  assert.equal(list[3]!.name, 'Mine Two')
})

test('agents: roster agents cannot be deleted (Zealot never), only edited; flags stay the seed\'s', async () => {
  const port = memoryPort()
  const s = createAgentStore(port, 'A')
  await s.load(SEED)
  await assert.rejects(s.remove('zealot'), /zealot is a roster agent; it can be edited, not deleted/)
  await assert.rejects(s.remove('builder'), /roster agent/)
  await s.put(agent('assayer', { isHidden: false, isRoster: false }))
  assert.deepEqual(s.list().find(a => a.id === 'assayer')!.isHidden, true, 'the Assayer stays hidden')
  assert.equal(s.list().find(a => a.id === 'assayer')!.isRoster, true)
  await s.put(agent('mine', { isRoster: false }))
  await s.remove('mine')
  assert.deepEqual(s.list().map(a => a.id), ['zealot', 'builder', 'assayer'])
  // A delete of a roster agent written to disk by other means is ignored.
  await port.write('agents/seg-X-0.jsonl', `${JSON.stringify({ s: 'X', q: 0, t: 9e15, op: { k: 'del', id: 'zealot' } })}\n`)
  assert.deepEqual((await createAgentStore(port, 'B').load(SEED)).map(a => a.id), ['zealot', 'builder', 'assayer'])
  await assert.rejects(createAgentStore(port, 'C').put(agent('x')), /load the roster first/)
})
