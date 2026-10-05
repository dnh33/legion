/**
 * The Chat view as rows: the rail of agents, the agent's header and task tabs, the thread with its tool chips and
 * approval cards, and the footer that says where the task stands. Plan §4 "Chat view".
 *
 * Words follow the desktop (ui/src/components/Thread.tsx, ToolChip.tsx, ApprovalCard.tsx, AgentRail.tsx,
 * TaskSwitcher.tsx); each port is cited where it is used.
 */
import type { AgentView, ApprovalCard, TaskView, ThreadRow } from '../../../types/index.d.ts'
import { MARK, MOOD_WORDS, railColumns } from '../../theme.ts'
import { count, money, plural, relTime } from '../format.ts'
import { descendants, taskLine, taskTree } from './tasks.ts'
import { answerWhere, cardWords } from '../cards.ts'
import { btn, line, md, partsWidth, rowHeight, span, wrapped, type Part, type Row, type SpanTone } from '../model.ts'
import { cellWidth, cutCells, fit, oneLine, padCells } from '../text.ts'
import {
  agentLabel, APPROVAL_WORDS, cardsInOrder, isElsewhere, modelWords, originWords, taskOf, cleanTitle, glyphOf, isActive, selectedAgent, selectedTask, shortTool, STATUS_MARK,
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

/**
 * A tool's name on its chip. Legion's own bridge tools read as what happened, as the desktop's ToolChip.tsx bridge
 * chips do ("Asked", "Told", "Checked who is available"); every other tool by its short name.
 */
const toolWords = (name: string): string => {
  const bridge = /__(ask|tell|agents)$/.exec(name)
  if (bridge) return bridge[1] === 'ask' ? 'Asked' : bridge[1] === 'tell' ? 'Told' : 'Checked'
  return shortTool(name)
}

/** At most this many handed-out pieces under the header; the rest are in the Order view. */
const DELEGATED_MAX = 6

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
    { text: modelWords(task?.model ?? agent.model), drop: 1 },
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
    const name = padCells(toolWords(r.tool.name), 5)
    return [line(
      [indent(), span(`${MARK.arrow} `, 'muted'), span(name), span(' '), span(oneLine(r.tool.summary), 'muted', { strike: r.tool.state === 'denied' })],
      [span(' '), span(fit(st.word, STATE_COL, { align: 'right' }), st.tone), span(' ')],
      width,
    )]
  }
  return [md([gutter(), span(agent.glyph, 'accent')], LEAD, r.text, width)]
}

/**
 * An approval card inline in the thread, read top to bottom as the brief's card rule orders it: who asks and what kind
 * of thing, the exact call, what saying yes does, who sent the agent (when someone did), then where to answer. No
 * buttons: the run waits on Claude Code's own permission dialog (plan §2.1), and a card of another window's run
 * points there instead. Wording ports the desktop's ApprovalCard.tsx head ("Needs your OK") into a sentence.
 */
export const cardRows = (s: Snapshot, card: ApprovalCard, width: number): Row[] => {
  const w = cardWords(card)
  const elsewhere = isElsewhere(s, taskOf(s, card.taskId))
  const body = LEAD + 2
  return [
    line([indent(), span(`${MARK.card} `, 'warn', { bold: true, fixed: true }), span(agentLabel(s, card.agentId), 'text', { bold: true }), span(` ${w.verb}`, 'warn', { bold: true })], [], width),
    ...wrapped(w.what, width, { indent: body, maxLines: 4 }),
    ...wrapped(w.consequence, width, { indent: body, tone: 'muted', maxLines: 2 }),
    ...(w.origin ? wrapped(w.origin, width, { indent: body, tone: 'muted', maxLines: 2 }) : []),
    ...wrapped(answerWhere(elsewhere), width, { indent: body, tone: 'warn', maxLines: 1 }),
  ]
}

/** Where the task stands, at the bottom of the thread, with the one action that fits it. */
const footerRows = (s: Snapshot, agent: AgentView, task: TaskView, width: number): Row[] => {
  const mood = s.moods[agent.id]?.mood
  if (isElsewhere(s, task) && (isActive(task) || task.status === 'paused')) {
    // read-only here: the window that runs it continues or stops it (plan §2.3 "Ownership")
    const where = isActive(task) ? 'Running in another window' : 'Paused in another window'
    return [
      line([gutter(), span(`${STATUS_MARK[task.status].mark} ${where}`, STATUS_MARK[task.status].tone, { fixed: true })], [], width),
      ...wrapped('Continue or stop it from that window.', width, { indent: 3, tone: 'muted' }),
    ]
  }
  if (isActive(task)) {
    // Thread.tsx: "Queued" / "Working"; the agent's own mood word while it is doing something
    const word = task.status === 'queued' ? 'Queued' : mood === 'thinking' || mood === 'hacking' || mood === 'listening' ? MOOD_WORDS[mood] : 'Working'
    return [line([gutter(), span(`${STATUS_MARK[task.status].mark} ${word}`, 'accent')], [btn({ kind: 'stop', taskId: task.id }, 'Stop', { hotkey: 's' }), span(' ')], width)]
  }
  if (task.status === 'paused') {
    // when, for someone coming back to it later; "now" needs no word
    const ago = relTime(task.updatedAt, s.now)
    const when = ago === 'now' || ago === '' ? '' : ` ${ago} ago`
    // the one-key Continue always stays; the reassurance is said whole, or not at all when the line is short
    // the one-key Continue always stays: the words shorten first, then the reassurance leaves whole
    const go: Part[] = [btn({ kind: 'continue', taskId: task.id }, 'Continue', { hotkey: 'c' }), span(' ')]
    const kept = span(' · the work is kept', 'muted', { fixed: true })
    const say = (text: string): Part => span(`${MARK.paused} ${text}`, 'warn', { bold: true, fixed: true })
    const fits = (parts: Part[]): boolean => partsWidth([gutter(), ...parts, ...go]) + 1 <= width
    const left = [[say(`Paused${when} at the turn limit`), kept], [say(`Paused${when} at the turn limit`)], [say('Paused at the turn limit')], [say('Paused')]]
      .find(fits) ?? [say('Paused')]
    const rows: Row[] = [line([gutter(), ...left], go, width)]
    // the runtime's own line repeats the state; only a line that says more is shown
    if (task.error && !/^paused at the turn limit/i.test(task.error)) rows.push(...wrapped(task.error, width, { indent: 3, tone: 'muted', maxLines: 2 }))
    return rows
  }
  if (task.status === 'error') {
    // Thread.tsx: "Run failed", the error or "The run failed without a message."; then a next step
    return [
      line([gutter(), span(`${MARK.error} Run failed`, 'danger', { bold: true })], [], width),
      ...wrapped(task.error || 'The run failed without a message.', width, { indent: 3, tone: 'muted', maxLines: 4 }),
      ...wrapped('Try again with /say, or press n for a new task.', width, { indent: 3, tone: 'muted' }),
    ]
  }
  if (task.status === 'cancelled') return [line([gutter(), span(`${MARK.cancelled} Stopped`, 'muted', { fixed: true }), span(' · /say picks it up again', 'muted')], [], width)]
  // done: when, and how to follow up in the same thread
  return [line([gutter(), span(`${MARK.done} Done ${relTime(task.updatedAt, s.now)}${relTime(task.updatedAt, s.now) === 'now' ? '' : ' ago'}`, 'muted', { fixed: true }), span(' · /say to follow up here', 'muted')], [], width)]
}

/** The screen for an agent with no task in view (Thread.tsx EmptyState: "New task for Builder"). */
const emptyRows = (agent: AgentView, width: number): Row[] => [
  { t: 'gap' },
  line([gutter(), span(agent.glyph, 'accent', { bold: true }), span('  '), span(`New task for ${agent.name}`, 'text', { bold: true })], [], width),
  ...wrapped(agent.description || 'Describe what you want done.', width, { indent: 4, tone: 'muted', maxLines: 3 }),
  { t: 'gap' },
  line([span('    '), span('Press n, or type in the prompt:', 'muted')], [], width),
  line([span('    '), span(`/to ${agent.id} <what to do>`, 'accent', { fixed: true })], [], width),
]

/**
 * The very first open: no task anywhere yet. Five seconds to know what this is, who is here and the one thing to do:
 * ask Zealot, who cuts the request into tasks and hands them across the Order.
 */
export const firstRunRows = (s: Snapshot, paneWidth: number): Row[] => {
  // a readable measure: on a wide dock the sentence keeps its shape instead of running to the edge
  const width = Math.min(paneWidth, 72)
  const n = visibleAgents(s).length
  const lead = s.agents.find(a => a.id === 'zealot' && !a.isHidden)
  const rows: Row[] = [
    { t: 'gap' },
    line([gutter(), span('✠', 'accent', { bold: true, fixed: true }), span('  '), span(`Your Order: ${n} agents, ready.`, 'text', { bold: true })], [], width),
  ]
  if (lead) {
    rows.push(...wrapped(`${lead.name} leads: it splits your request into tasks and hands them out across the Order.`, width, { indent: 4, tone: 'muted', maxLines: 3 }))
    rows.push({ t: 'gap' }, line([span('    '), span('Start here:', 'text', { fixed: true })], [], width))
    rows.push(line([span('    '), span(`/to ${lead.id} <what you want done>`, 'accent', { fixed: true })], [], width))
  }
  rows.push({ t: 'gap' }, ...wrapped('Or pick an agent and press n.', width, { indent: 4, tone: 'muted' }))
  // laid out at the measure, padded to the pane, so every row still spans its column
  return rows.map(r => (r.t === 'line' ? line(r.parts, [], paneWidth) : r))
}

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
  // the view is at most THREAD_MAX cells wide, header and thread alike, so their right edges line up on a wide dock
  const mw = Math.min(width - railWidth, THREAD_MAX)
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
    // Open shows that task, where the card says where to answer
    top.push(line([gutter(), span(`${MARK.card} ${words}`, 'warn', { fixed: true }), span(` · ${agentLabel(s, first.agentId)}`, 'warn')], [btn({ kind: 'task', taskId: first.taskId }, 'Open', { hotkey: 'o' }), span(' ')], mw))
  }
  // the first open: nothing to head or tab yet, only the welcome (the strip of glyphs stays on a narrow pane)
  if (s.tasks.length === 0) return { railWidth, rail, main: [...(railWidth === 0 ? [agentStrip(s, mw)] : []), ...firstRunRows(s, mw)] }
  if (!task) return { railWidth, rail, main: [...top, ...emptyRows(agent, mw)] }
  // the pieces this task handed out, as a tree with who, state and cost: the whole request at a glance
  const pieces = descendants(s, task.id)
  if (pieces.length > 0) {
    // drawn as the tree under this task (its own line left out), so each piece hangs from ├ / └
    const tree = taskTree([task, ...pieces]).filter(l => l.task.id !== task.id).slice(0, DELEGATED_MAX)
    top.push(line([gutter(), span('Handed out', 'text', { bold: true, fixed: true }), span(`  ${count(pieces.filter(isActive).length)} working · ${count(pieces.length)} in all`, 'muted')], [], mw))
    for (const l of tree) top.push(taskLine(s, l, mw))
    if (pieces.length > tree.length) top.push(line([span('   '), span(`+${count(pieces.length - tree.length)} more · 5: Order`, 'muted')], [], mw))
  }
  // the thread, then its cards, then the reply streaming in
  const tw = mw
  const nThread = s.thread.length
  const nGroups = nThread + here.length + (s.live ? 1 : 0)
  const build = (i: number): Row[] => {
    if (i < nThread) return threadRowRows(s, agent, s.thread[i] as ThreadRow, tw)
    if (i < nThread + here.length) return cardRows(s, here[i - nThread] as ApprovalCard, tw)
    return [md([gutter(), span(agent.glyph, 'accent')], LEAD, `${s.live}${MARK.caret}`, tw)]
  }
  const foot = footerRows(s, agent, task, tw)
  const budget = Math.max(4, bodyRows - chromeRows - top.length - foot.length - 1)
  // a failed, stopped or paused run says so in its footer; "No messages yet." is only for one still to speak
  const quiet = isActive(task) ? wrapped('No messages yet.', tw, { indent: LEAD, tone: 'muted' }) : []
  const body = nGroups > 0 ? tail(nGroups, build, budget, tw) : quiet
  return { railWidth, rail, main: [...top, { t: 'gap' }, ...body, ...foot] }
}
