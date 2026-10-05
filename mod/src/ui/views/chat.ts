/**
 * The Chat view as rows: the rail of agents, the agent's header and task tabs, the thread with its tool chips and
 * approval cards, and the footer that says where the task stands. Plan §4 "Chat view".
 *
 * Words follow the desktop (ui/src/components/Thread.tsx, ToolChip.tsx, ApprovalCard.tsx, AgentRail.tsx,
 * TaskSwitcher.tsx); each port is cited where it is used.
 */
import type { AgentView, ApprovalCard, TaskView, ThreadRow } from '../../../types/index.d.ts'
import { MARK, MOOD_WORDS, railColumns } from '../../theme.ts'
import { count, money, plural } from '../format.ts'
import { btn, line, md, partsWidth, rowHeight, span, wrapped, type Part, type Row, type SpanTone } from '../model.ts'
import { cellWidth, cutCells, fit, oneLine, padCells } from '../text.ts'
import {
  agentLabel, APPROVAL_WORDS, cardsInOrder, originWords, cleanTitle, glyphOf, isActive, selectedAgent, selectedTask, shortTool, STATUS_MARK,
  tasksOf, visibleAgents, type Snapshot,
} from './common.ts'

/** The lead column of a thread row: one cell of gutter, the speaker, then space. Five cells in all. */
const LEAD = 5
const gutter = (): Part => span(' ')
const indent = (): Part => span(' '.repeat(LEAD))

/** Tool state words: plain, fixed to one column (13 cells, "Needs your OK"), so chips line up. */
const TOOL_STATE: Record<NonNullable<ThreadRow['tool']>['state'], { word: string; tone: SpanTone }> = {
  running: { word: 'running', tone: 'accent' },
  ok: { word: '✓', tone: 'muted' },
  error: { word: 'failed', tone: 'danger' },
  awaiting: { word: 'Needs your OK', tone: 'warn' },
  denied: { word: 'Denied', tone: 'muted' },
}
const STATE_COL = 13

/** The widest the thread draws, in cells: past it, a tool's state would sit too far from its name to read as one row. */
export const THREAD_MAX = 100

export type ChatLayout = {
  /** Cells of the rail, its separator included; 0 when the pane is too narrow for one. */
  railWidth: number
  rail: Row[]
  main: Row[]
}

/**
 * The rail: one row per visible agent, the selected one in accent; a separator closes each row. theme.ts railColumns.
 * A row is lead (1) + glyph and name (r - 5) + space + mark (2) + separator: 13 cells for the glyph and name at 18
 * columns, so every roster name fits there ("⌶ Forgemaster"); the mark sits against the separator. The mark is two cells: `!1`..`!9`, `!+` past nine (the exact count is
 * in the title row and the Order view), else the task mark.
 */
export const railRows = (s: Snapshot, width: number): Row[] => {
  const r = railColumns(width)
  if (r === 0) return []
  const sel = selectedAgent(s)
  return visibleAgents(s).map(a => {
    const isSel = a.id === sel?.id
    const label = fit(`${a.glyph} ${a.name}`, r - 5)
    const busy = s.tasks.filter(t => t.agentId === a.id)
    const cards = s.cards.filter(c => c.agentId === a.id).length
    // the rail's mark column: cards first (they need you), then running, queued, paused (AgentRail.tsx: pending first)
    const mark: { text: string; tone: SpanTone } = cards > 0
      ? { text: cards > 9 ? `${MARK.card}+` : `${MARK.card}${cards}`, tone: 'warn' }
      : busy.some(t => t.status === 'running') ? { text: MARK.running, tone: 'accent' }
        : busy.some(t => t.status === 'queued') ? { text: MARK.queued, tone: 'accent' }
          : busy.some(t => t.status === 'paused') ? { text: MARK.paused, tone: 'warn' }
            : { text: '', tone: 'muted' }
    const idle = mark.text === ''
    const name: Part = isSel
      ? span(label, 'accent', { bold: true })
      : btn({ kind: 'agent', agentId: a.id }, label, { dim: idle })
    return line([span(isSel ? MARK.arrow : ' ', 'accent', { fixed: true }), name, span(' ', 'text', { fixed: true }), span(fit(mark.text, 2, { align: 'right' }), mark.tone, { fixed: true }), span(MARK.bar, 'line', { fixed: true })], [], r)
  })
}

/** Below the rail's breakpoint the agents are a strip of glyphs, each a control (one-glyph Buttons). */
const agentStrip = (s: Snapshot, width: number): Row => {
  const sel = selectedAgent(s)
  const parts: Part[] = [gutter()]
  for (const a of visibleAgents(s)) {
    if (partsWidth(parts) + 2 > width) break
    parts.push(a.id === sel?.id ? span(a.glyph, 'accent', { bold: true }) : btn({ kind: 'agent', agentId: a.id }, a.glyph, { dim: true }), span(' '))
  }
  return line(parts, sel ? [span(sel.name, 'accent', { bold: true }), span(' ')] : [], width)
}

/** `⌘ Builder · Auto-edits · sonnet          ≈$0.21 ·  9 turns` (Thread.tsx thread-head: name, approval chip, cost and turns). */
const headerRow = (s: Snapshot, agent: AgentView, task: TaskView | undefined, width: number): Row => {
  // the numbers right-aligned as one group, so the right edge never moves; never cut
  const right: Part[] = task ? [span(`${money(task.costUsd)} · ${plural(task.turns, 'turn')} `, 'muted', { fixed: true })] : []
  // what is said about the agent, in display order, each with the rank in which it leaves when the line is short:
  // the model first, then the escalation, then the approval mode; who started the task stays longest
  const facts: Array<{ text: string; drop: number }> = [
    { text: APPROVAL_WORDS[agent.approval], drop: 3 },
    { text: task?.model ?? agent.model, drop: 1 },
    ...(task?.isEscalated ? [{ text: '↑ escalated', drop: 2 }] : []), // MessageView.tsx ModelTag: "↑ escalated"
    ...(task && originWords(s, task) ? [{ text: originWords(s, task) as string, drop: 4 }] : []), // TaskSwitcher.tsx from-chip
  ]
  const name = span(`${agent.glyph} ${agent.name}`, 'text', { bold: true, fixed: true })
  const room = width - 1 - partsWidth([name]) - partsWidth(right) - 1
  let kept = facts
  for (const rank of [1, 2, 3, 4]) {
    if (cellWidth(kept.map(f => ` · ${f.text}`).join('')) <= room) break
    kept = kept.filter(f => f.drop !== rank)
  }
  return line([gutter(), name, span(kept.map(f => ` · ${f.text}`).join(''), 'muted')], right, width)
}

/**
 * The task tabs: `n: New task`, then the agent's tasks newest first, the selected one in accent; what does not fit is
 * counted as `+N` (TaskSwitcher.tsx "+N more"). The selected task always shows, taking the last place if it must.
 */
const tabsRow = (s: Snapshot, agent: AgentView, task: TaskView | undefined, width: number): Row => {
  const all = tasksOf(s, agent.id)
  const newBtn = btn({ kind: 'new', agentId: agent.id }, 'New task', { hotkey: 'n' })
  const tabMax = Math.max(10, Math.min(28, Math.floor(width / 3)))
  const tabText = (t: TaskView): string => `${STATUS_MARK[t.status].mark} ${cutCells(oneLine(cleanTitle(t.title)), tabMax - 2)}`
  const reserve = 5 // room for ' +99' at the end
  let room = width - 1 - partsWidth([newBtn]) - reserve
  const shown: TaskView[] = []
  for (const t of all) {
    const w = cellWidth(tabText(t)) + 2
    if (w > room) break
    shown.push(t)
    room -= w
  }
  if (task && !shown.includes(task)) {
    const w = cellWidth(tabText(task)) + 2
    while (shown.length > 0 && room < w) room += cellWidth(tabText(shown.pop() as TaskView)) + 2
    if (room >= w) shown.push(task)
  }
  const parts: Part[] = [gutter(), newBtn]
  for (const t of shown) {
    parts.push(span('  '))
    parts.push(t.id === task?.id
      ? span(tabText(t), 'accent', { bold: true })
      : btn({ kind: 'task', taskId: t.id }, tabText(t), { dim: t.status === 'done' || t.status === 'cancelled' }))
  }
  const hidden = all.length - shown.length
  return line(parts, hidden > 0 ? [span(`+${count(hidden)} `, 'muted')] : [], width)
}

/** One thread row as lines (a tool chip, a person's message) or model text (an agent's reply). */
const threadRowRows = (s: Snapshot, agent: AgentView, r: ThreadRow, width: number): Row[] => {
  if (r.role === 'user' && r.fromAgentId) {
    // MessageView.tsx AgentMessage: the sender, then "via Legion"
    const from = s.agents.find(a => a.id === r.fromAgentId)
    const head = line([gutter(), span(from?.glyph ?? MARK.running, 'muted'), span('   '), span(from?.name ?? r.fromAgentId, 'text', { bold: true }), span(' · via Legion', 'muted')], [], width)
    return [head, ...wrapped(r.text, width, { indent: LEAD })]
  }
  if (r.role === 'user') return wrapped(r.text, width, { lead: [gutter(), span('you', 'muted'), span(' ')] })
  if (r.role === 'system') return wrapped(r.text, width, { indent: LEAD, tone: 'muted' })
  if (r.role === 'tool' && r.tool) {
    const st = TOOL_STATE[r.tool.state]
    const name = padCells(shortTool(r.tool.name), 5)
    return [line(
      [indent(), span(`${MARK.arrow} `, 'muted'), span(name), span(' '), span(oneLine(r.tool.summary), 'muted', { strike: r.tool.state === 'denied' })],
      [span(' '), span(fit(st.word, STATE_COL, { align: 'right' }), st.tone), span(' ')],
      width,
    )]
  }
  return [md([gutter(), span(agent.glyph, 'accent')], LEAD, r.text, width)]
}

/**
 * An approval card inline in the thread (ApprovalCard.tsx): "Needs your OK · Bash", who asked, what the call does,
 * then Allow and Deny. Only the first card in view takes the `a` / `d` keys; a click-only card never takes `a`
 * (the desktop's no-one-key-approve rule), and says how to allow it instead.
 */
export const cardRows = (card: ApprovalCard, index: number, width: number, isFirst: boolean): Row[] => {
  const rows: Row[] = [line([indent(), span(`${MARK.card} Needs your OK · `, 'warn', { bold: true }), span(shortTool(card.tool), 'warn', { bold: true })], [], width)]
  if (card.origin) rows.push(...wrapped(card.origin, width, { indent: LEAD + 2, tone: 'muted', maxLines: 2 }))
  rows.push(...wrapped(card.summary, width, { indent: LEAD + 2, maxLines: 6 }))
  const allowKey = isFirst && !card.isClickOnly ? 'a' : undefined
  const parts: Part[] = [
    span(' '.repeat(LEAD + 2)),
    btn({ kind: 'card-allow', cardId: card.id, index }, 'Allow', { hotkey: allowKey }),
    span('   '),
    btn({ kind: 'card-deny', cardId: card.id, index }, 'Deny', { hotkey: isFirst ? 'd' : undefined }),
  ]
  if (card.isClickOnly) parts.push(span('   No one-key allow here: Tab to Allow, then Enter', 'muted'))
  rows.push(line(parts, [], width))
  return rows
}

/** Where the task stands, at the bottom of the thread, with the one action that fits it. */
const footerRows = (s: Snapshot, agent: AgentView, task: TaskView, width: number): Row[] => {
  const mood = s.moods[agent.id]?.mood
  if (isActive(task)) {
    // Thread.tsx: "Queued" / "Working"; the agent's own mood word while it is doing something
    const word = task.status === 'queued' ? 'Queued' : mood === 'thinking' || mood === 'hacking' || mood === 'listening' ? MOOD_WORDS[mood] : 'Working'
    return [line([gutter(), span(`${STATUS_MARK[task.status].mark} ${word}`, 'accent')], [btn({ kind: 'stop', taskId: task.id }, 'Stop', { hotkey: 's' }), span(' ')], width)]
  }
  if (task.status === 'paused') {
    const rows: Row[] = [line([gutter(), span(`${MARK.paused} Paused at the turn limit`, 'warn', { bold: true, fixed: true }), span(' · the work is kept', 'muted')], [btn({ kind: 'continue', taskId: task.id }, 'Continue', { hotkey: 'c' }), span(' ')], width)]
    if (task.error) rows.push(...wrapped(task.error, width, { indent: 3, tone: 'muted', maxLines: 2 }))
    return rows
  }
  if (task.status === 'error') {
    // Thread.tsx: "Run failed", the error or "The run failed without a message."; then a next step
    return [
      line([gutter(), span(`${MARK.error} Run failed`, 'danger', { bold: true })], [], width),
      ...wrapped(task.error || 'The run failed without a message.', width, { indent: 3, tone: 'muted', maxLines: 4 }),
      ...wrapped('Send a follow-up with /say to try again, or press n for a new task.', width, { indent: 3, tone: 'muted' }),
    ]
  }
  if (task.status === 'cancelled') return [line([gutter(), span(`${MARK.cancelled} Cancelled`, 'muted')], [], width)]
  return []
}

/** The screen for an agent with no task in view (Thread.tsx EmptyState: "New task for Builder"). */
const emptyRows = (agent: AgentView, width: number): Row[] => [
  { t: 'gap' },
  line([gutter(), span(agent.glyph, 'accent', { bold: true }), span('  '), span(`New task for ${agent.name}`, 'text', { bold: true })], [], width),
  ...wrapped(agent.description || 'Describe what you want done.', width, { indent: 4, tone: 'muted', maxLines: 3 }),
  { t: 'gap' },
  ...wrapped(`n starts one here. From the prompt: /to ${agent.id} <what to do>`, width, { indent: 4, tone: 'muted' }),
]

/** No agents at all: the roster has not loaded. */
export const noAgentRows = (width: number): Row[] => [
  { t: 'gap' },
  line([gutter(), span('✠', 'accent', { bold: true }), span('  '), span('The order has not mustered yet.', 'text', { bold: true })], [], width),
  ...wrapped('Agents load when the session starts. If this stays empty, run /legion doctor.', width, { indent: 4, tone: 'muted' }),
]

/**
 * The thread's tail that fits `budget` rows: the pane's scroll starts at the top, so the view keeps the newest rows
 * itself and says how many earlier ones it left out. Groups are built newest first and only as far as they fit, so a
 * thread of thousands of rows costs what the screen shows.
 */
const tail = (total: number, build: (i: number) => Row[], budget: number, width: number): Row[] => {
  const kept: Row[][] = []
  let used = 0
  for (let i = total - 1; i >= 0; i--) {
    const g = build(i)
    const h = g.reduce((n, r) => n + rowHeight(r), 0)
    if (kept.length > 0 && used + h > budget - 1) break
    kept.unshift(g)
    used += h
  }
  const left = total - kept.length
  const head: Row[] = left > 0 ? [line([indent(), span(`↑ ${plural(left, 'earlier row')}`, 'muted')], [], width)] : []
  return [...head, ...kept.flat()]
}

/** The whole Chat view at `width` cells, its thread fitted to `bodyRows` rows. */
export const chatLayout = (s: Snapshot, width: number, bodyRows: number, chromeRows: number): ChatLayout => {
  const rail = railRows(s, width)
  const railWidth = rail.length > 0 ? railColumns(width) : 0
  const mw = width - railWidth
  const agent = selectedAgent(s)
  if (!agent) return { railWidth, rail, main: noAgentRows(mw) }
  const task = selectedTask(s)
  const top: Row[] = []
  if (railWidth === 0) top.push(agentStrip(s, mw))
  top.push(headerRow(s, agent, task, mw), tabsRow(s, agent, task, mw))
  const ordered = cardsInOrder(s)
  const here = task ? ordered.filter(c => c.taskId === task.id) : []
  const elsewhere = ordered.filter(c => !here.includes(c))
  if (elsewhere.length > 0) {
    // Thread.tsx: "N approvals waiting in another task  Open →"
    const first = elsewhere[0] as ApprovalCard
    const n = elsewhere.length
    const words = mw >= 60
      ? (n === 1 ? '1 approval waiting in another task' : `${count(n)} approvals waiting in another task`)
      : `${count(n)} waiting in another task`
    top.push(line([gutter(), span(`${MARK.card} ${words}`, 'warn', { fixed: true }), span(` · ${agentLabel(s, first.agentId)}`, 'warn')], [btn({ kind: 'task', taskId: first.taskId }, 'Open', { hotkey: 'o' }), span(' ')], mw))
  }
  if (!task) return { railWidth, rail, main: [...top, ...emptyRows(agent, mw)] }
  // the thread, then its cards (the first takes a / d), then the reply streaming in; at most THREAD_MAX cells wide,
  // so on a wide dock a tool's state stays near its name
  const tw = Math.min(mw, THREAD_MAX)
  const nThread = s.thread.length
  const nGroups = nThread + here.length + (s.live ? 1 : 0)
  const build = (i: number): Row[] => {
    if (i < nThread) return threadRowRows(s, agent, s.thread[i] as ThreadRow, tw)
    if (i < nThread + here.length) return cardRows(here[i - nThread] as ApprovalCard, ordered.indexOf(here[i - nThread] as ApprovalCard), tw, i === nThread)
    return [md([gutter(), span(agent.glyph, 'accent')], LEAD, `${s.live}${MARK.caret}`, tw)]
  }
  const foot = footerRows(s, agent, task, tw)
  const budget = Math.max(4, bodyRows - chromeRows - top.length - foot.length - 1)
  // a failed, stopped or paused run says so in its footer; "No messages yet." is only for one still to speak
  const quiet = isActive(task) || task.status === 'done' ? wrapped('No messages yet.', tw, { indent: LEAD, tone: 'muted' }) : []
  const body = nGroups > 0 ? tail(nGroups, build, budget, tw) : quiet
  return { railWidth, rail, main: [...top, { t: 'gap' }, ...body, ...foot] }
}
