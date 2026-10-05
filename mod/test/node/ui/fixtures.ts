/**
 * UI fixtures: the roster, tasks and cards in every state the views must hold (plan §6 "Real conditions"): empty,
 * long (a 300-character title, 13 agents, 99+ cards, ≈$1,234.56), error and paused. Shared by the Node specs and the
 * plugin tests. Plain data only.
 */
import type { AgentView, ApprovalCard, BandItem, TaskStatus, TaskView, ThreadRow } from '../../../types/index.d.ts'
import type { Snapshot } from '../../../src/ui/views/common.ts'

const ROSTER: Array<[string, string, string, AgentView['approval'], string]> = [
  ['zealot', 'Zealot', '✠', 'ask', 'Plans the work and hands it out.'],
  ['builder', 'Builder', '⌘', 'auto-edits', 'Writes and fixes code.'],
  ['scout', 'Scout', '◎', 'ask', 'Finds things out.'],
  ['inquisitor', 'Inquisitor', '⌕', 'ask', 'Reviews and tries to refute.'],
  ['scribe', 'Scribe', '✎', 'auto-edits', 'Writes docs.'],
  ['archivist', 'Archivist', '▤', 'ask', 'Keeps the Library.'],
  ['sentinel', 'Sentinel', '◬', 'ask', 'Watches security.'],
  ['forgemaster', 'Forgemaster', '⌶', 'ask', 'Builds and ships.'],
  ['exorcist', 'Exorcist', '☾', 'ask', 'Hunts bugs.'],
  ['preceptor', 'Preceptor', '⊥', 'ask', 'Teaches.'],
  ['herald', 'Herald', '⚑', 'ask', 'Writes releases.'],
  ['assayer', 'Assayer', '⊜', 'ask', 'Needs BSV.'],
  ['sculptor', 'Sculptor', '◈', 'ask', 'Shapes 3D.'],
]

export const AGENTS: AgentView[] = ROSTER.map(([id, name, glyph, approval, description]) => ({
  id, name, glyph, description, approval, systemPrompt: '', model: 'auto', isRoster: true, isHidden: id === 'assayer',
}))

export const LONG_TITLE = `Fix the flaky replay test ${'and keep every assertion while the clock is pinned '.repeat(6)}`.slice(0, 300)

export const task = (id: string, agentId: string, status: TaskStatus, more: Partial<TaskView> = {}): TaskView => ({
  id, agentId, title: `Task ${id}`, status, sessionId: 's1', isEscalated: false, isTainted: false, turns: 9, runTurns: 9,
  tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.21, origin: { kind: 'person' },
  createdAt: 1_000, updatedAt: 2_000, model: 'sonnet', ...more,
})

export const card = (id: string, taskId: string, agentId: string, more: Partial<ApprovalCard> = {}): ApprovalCard => ({
  id, taskId, agentId, tool: 'Bash', summary: 'npm test -- replay', isClickOnly: false, at: 10, ...more,
})

export const THREAD: ThreadRow[] = [
  { id: 'r1', role: 'user', text: 'Pin the clock in the replay test.', at: 1 },
  { id: 'r2', role: 'assistant', text: 'Pinned it with an injected clock.', at: 2 },
  { id: 'r3', role: 'tool', text: '', tool: { name: 'Read', summary: 'test/replay.test.ts', state: 'ok' }, at: 3 },
  { id: 'r4', role: 'tool', text: '', tool: { name: 'Edit', summary: 'test/replay.test.ts  +4 −1', state: 'ok' }, at: 4 },
  { id: 'r5', role: 'tool', text: '', tool: { name: 'Bash', summary: 'npm test -- replay', state: 'awaiting' }, at: 5 },
  { id: 'r6', role: 'user', text: 'Builder, check the docs too.', fromAgentId: 'zealot', at: 6 },
  { id: 'r7', role: 'system', text: 'Continued where it stopped.', at: 7 },
]

export const base = (more: Partial<Snapshot> = {}): Snapshot => ({
  agents: AGENTS, tasks: [], cards: [], ui: { view: 'chat', agentId: 'builder', taskId: null, channel: null },
  moods: {}, band: [], thread: [], live: '', now: 1_000_000, ...more,
})

/** A busy order: a running task with a card, a paused one, a failed one, recent done ones. */
export const busy = (more: Partial<Snapshot> = {}): Snapshot => base({
  tasks: [
    task('t_000000000001', 'builder', 'running', { title: 'fix the flaky replay', createdAt: 5_000, updatedAt: 9_000 }),
    task('t_000000000002', 'builder', 'paused', { title: 'tests', createdAt: 4_000, error: 'Paused at the turn limit (50 turns).' }),
    task('t_000000000003', 'scout', 'error', { title: 'find the leak', error: 'The model refused the request.' }),
    task('t_000000000004', 'scribe', 'done', { title: 'docs', updatedAt: 990_000 }),
  ],
  cards: [card('c1', 't_000000000001', 'builder')],
  ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000001', channel: null },
  moods: { builder: { mood: 'hacking', since: 1 } },
  thread: THREAD,
  live: 'Executing the replay',
  ...more,
})

/** The long state: 300-char title, 99+ cards, ≈$1,234.56, 13 agents, many tasks. */
export const long = (): Snapshot => {
  const tasks = Array.from({ length: 30 }, (_, i) => task(`t_${String(i).padStart(12, '0')}`, i % 2 ? 'builder' : 'forgemaster', i % 3 === 0 ? 'running' : 'done', {
    title: i === 0 ? LONG_TITLE : `task number ${i} ${LONG_TITLE.slice(0, 40)}`, costUsd: 1234.56, turns: 999, createdAt: i, updatedAt: i,
  }))
  const cards = Array.from({ length: 120 }, (_, i) => card(`c${i}`, 't_000000000001', 'builder', { summary: LONG_TITLE, at: i }))
  return base({
    tasks, cards, thread: [...THREAD, { id: 'big', role: 'assistant', text: LONG_TITLE.repeat(3), at: 9 }],
    ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000001', channel: null }, live: LONG_TITLE,
    band: Array.from({ length: 6 }, (_, i): BandItem => ({ id: `b${i}`, kind: i % 2 ? 'done' : 'paused', taskId: 't_000000000001', agentId: 'builder', text: LONG_TITLE, at: i })),
  })
}

export const WIDTHS = [40, 60, 80, 100, 120, 200] as const
