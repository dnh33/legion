/**
 * The Chat view as rows, built around three questions in this order (claude/tui-information-design.md): does anything
 * need me, what is happening now, what happened.
 *
 *   the task's opening message, with one total cost          (what this is about)
 *   ! ⌘ Builder needs your OK to run a command …             (needs me: first, under the title)
 *   ├ ⌘ Builder   Fix the flaky replay test   editing  ≈$0.21 (what is happening: the pieces it handed out)
 *   ⌘  the conversation, finished tool lines folded           (what happened)
 *   ● editing replay.test.ts                  s: stop · k: keys (where it stands, and the likely keys)
 *
 * Rules applied here: R1 one place per fact, R2 verbs not moods, R3 configuration only when it explains something, R4
 * quiet when nothing happens, R5 one footer of keys, R7 narrow means fewer things, R8 the transcript is the
 * conversation, R9 one accent per region, R11 one word per thing. Words follow the desktop where it has them
 * (ui/src/components/Thread.tsx, MessageView.tsx, TaskSwitcher.tsx); each port is cited where it is used.
 */
import type { AgentView, ApprovalCard, TaskView, ThreadRow } from '../../../types/index.d.ts'
import { MARK, railColumns } from '../../theme.ts'
import { count, money, plural, relTime } from '../format.ts'
import { answerWhere, cardWords } from '../cards.ts'
import { btn, line, md, partsWidth, rowHeight, span, wrapped, type Part, type Row } from '../model.ts'
import { cellWidth, cutCells, fit, oneLine } from '../text.ts'
import { NEEDS_YOU } from '../words.ts'
import {
  agentLabel, cardsInOrder, cleanTitle, isActive, isElsewhere, nowOf, originWords, selectedAgent, selectedTask, STATUS_MARK,
  taskOf, tasksOf, uiFlags, visibleAgents, type Snapshot,
} from './common.ts'
import { descendants, taskLine, taskTree } from './tasks.ts'

/** The lead column of a thread row: one cell of gutter, the speaker, then space. Five cells in all. */
const LEAD = 5
const gutter = (): Part => span(' ')
const indent = (n = LEAD): Part => span(' '.repeat(n))

/** At most this many handed-out pieces under the title; the rest are in the Order view. */
const DELEGATED_MAX = 6

/** At most this many task tabs; the rest are `+N` (and all are in Order). */
const TABS_MAX = 3

/** The widest the view draws, in cells: past it a row's two ends drift too far apart to read as one. */
export const THREAD_MAX = 100

/** The run is near its turn limit from this share of it (R3: the turn count shows only then). */
const NEAR_LIMIT = 0.8

export type ChatLayout = {
  /** Cells of the rail, its separator included; 0 when the pane is too narrow for one. */
  railWidth: number
  rail: Row[]
  main: Row[]
}

/** An agent with something in play: work, a pause, a failure to look at, or something that needs the person. */
const inPlay = (s: Snapshot, id: string): boolean =>
  s.tasks.some(t => t.agentId === id && (isActive(t) || t.status === 'paused')) || s.cards.some(c => c.agentId === id)

/**
 * The rail (R7, R4): the shown agent and every agent with something in play get a row; the rest share one dim line of
 * glyphs. From 100 cells a row carries a two-cell mark (`!1` needs your OK, `●` working, `◐` queued, `‖` paused); at
 * 72–99 the rail is glyph and name only. A row is lead (1) + glyph and name (r - 5) + space + mark (2) + separator.
 */
export const railRows = (s: Snapshot, width: number): Row[] => {
  const r = railColumns(width)
  if (r === 0) return []
  const sel = selectedAgent(s)
  const marks = width >= 100
  const rows: Row[] = []
  const shown = visibleAgents(s)
  for (const a of shown.filter(x => x.id === sel?.id || inPlay(s, x.id))) {
    const isSel = a.id === sel?.id
    const label = fit(`${a.glyph} ${a.name}`, r - 5)
    const mine = s.tasks.filter(t => t.agentId === a.id)
    const cards = s.cards.filter(c => c.agentId === a.id).length
    const mark = !marks ? { text: '', tone: 'muted' as const }
      : cards > 0 ? { text: cards > 9 ? `${MARK.card}+` : `${MARK.card}${cards}`, tone: 'warn' as const }
        : mine.some(t => t.status === 'running') ? { text: MARK.running, tone: 'accent' as const }
          : mine.some(t => t.status === 'queued') ? { text: MARK.queued, tone: 'muted' as const }
            : mine.some(t => t.status === 'paused') ? { text: MARK.paused, tone: 'warn' as const }
              : { text: '', tone: 'muted' as const }
    const name: Part = isSel ? span(label, 'accent', { bold: true, fixed: true }) : btn({ kind: 'agent', agentId: a.id }, label)
    rows.push(line([span(isSel ? MARK.arrow : ' ', 'accent', { fixed: true }), name, span(' ', 'text', { fixed: true }), span(fit(mark.text, 2, { align: 'right' }), mark.tone, { fixed: true }), span(MARK.bar, 'line', { fixed: true })], [], r))
  }
  // the resting agents: one dim line of glyphs (each a control), wrapping inside the rail
  const resting = shown.filter(x => x.id !== sel?.id && !inPlay(s, x.id))
  let parts: Part[] = [span(' ')]
  const flush = (): void => { rows.push(line(parts, [span(MARK.bar, 'line', { fixed: true })], r)); parts = [span(' ')] }
  for (const a of resting) {
    if (partsWidth(parts) + 2 > r - 1) flush()
    parts.push(btn({ kind: 'agent', agentId: a.id }, a.glyph, { dim: true }), span(' '))
  }
  if (resting.length > 0) flush()
  return rows
}

/**
 * The task tabs, only when the agent has more than one task (R4): newest first, the shown one in accent. The row's room
 * is shared out, the shown tab first, so a title is cut only when the row is really full; what does not fit is `+N`.
 */
const tabsRow = (s: Snapshot, agent: AgentView, task: TaskView | undefined, width: number): Row | undefined => {
  const all = tasksOf(s, agent.id)
  if (all.length < 2) return undefined
  const room = width - 1 - 5 // a space at the left; ' +99 ' at the right
  const text = (t: TaskView, max: number): string => `${STATUS_MARK[t.status].mark} ${cutCells(oneLine(cleanTitle(t.title)), Math.max(4, max - 2))}`
  // at most three tabs, each with room to be read; the rest are counted
  const order = (task ? [task, ...all.filter(t => t.id !== task.id)] : all).slice(0, TABS_MAX)
  const shown: Array<{ t: TaskView; label: string }> = []
  let left = room
  for (const t of order) {
    const others = Math.max(0, Math.min(order.length - shown.length - 1, 3))
    const max = Math.max(10, Math.floor(left / (others + 1)) - 2)
    const label = text(t, Math.min(max, 40))
    if (cellWidth(label) + 2 > left) break
    shown.push({ t, label })
    left -= cellWidth(label) + 2
  }
  // drawn in their own order, newest first, so a tab never jumps when another is shown
  shown.sort((a, b) => all.indexOf(a.t) - all.indexOf(b.t))
  const parts: Part[] = [span(' ')]
  shown.forEach(({ t, label }, i) => {
    if (i > 0) parts.push(span('  ', 'text', { fixed: true }))
    parts.push(t.id === task?.id
      ? span(label, 'accent', { bold: true, fixed: true })
      : btn({ kind: 'task', taskId: t.id }, label, { dim: !isActive(t) && t.status !== 'paused' }))
  })
  const hidden = all.length - shown.length
  return line(parts, hidden > 0 ? [span(`+${count(hidden)} `, 'muted', { fixed: true })] : [], width)
}

/** The opening message of a task: its first row from the person, or its title. The thread then leaves that row out (R1). */
const opening = (s: Snapshot, task: TaskView): { text: string; rowId?: string } => {
  const first = s.thread.find(r => r.role === 'user')
  return first && !first.fromAgentId ? { text: first.text, rowId: first.id } : { text: cleanTitle(task.title) }
}

/**
 * The title line: the opening message, then only what explains something (R3): who started it, an escalated model,
 * the turn count near the limit; then one total for the task and the pieces it handed out (R10).
 */
const titleRows = (s: Snapshot, task: TaskView, pieces: readonly TaskView[], width: number): Row[] => {
  const notes: string[] = []
  const from = originWords(s, task)
  if (from) notes.push(from)
  if (task.isEscalated) notes.push(`↑ ${task.model ?? 'opus'}`) // MessageView.tsx ModelTag: the router moved it up
  const max = s.settings?.maxTurns
  if (max && task.runTurns >= Math.ceil(max * NEAR_LIMIT) && isActive(task)) notes.push(`turn ${task.runTurns} of ${max}`)
  const total = [task, ...pieces].reduce((n, t) => n + (Number.isFinite(t.costUsd) ? t.costUsd : 0), 0)
  const right: Part[] = []
  if (notes.length > 0) right.push(span(notes.join(' · '), 'muted', { fixed: true }), span('  '))
  if (total >= 0.01) right.push(span(money(total), 'muted', { fixed: true }))
  right.push(span(' '))
  return [line([gutter(), span(oneLine(opening(s, task).text), 'text', { bold: true })], right, width, 2)]
}

/**
 * A "needs your OK" (cards.ts), first under the title: who and what for, the exact call, what saying yes does, who
 * sent the agent, then where to answer. No buttons: the run waits on Claude Code's own permission dialog (plan §2.1).
 */
export const cardRows = (s: Snapshot, card: ApprovalCard, width: number): Row[] => {
  const w = cardWords(card)
  const elsewhere = isElsewhere(s, taskOf(s, card.taskId))
  const body = LEAD + 2
  // the head is said whole: "needs your OK to run a command", or "needs your OK" when the rest would be cut
  const who = [gutter(), span(MARK.card, 'warn', { bold: true, fixed: true }), span('   '), span(agentLabel(s, card.agentId), 'text', { bold: true, fixed: true })]
  const head = partsWidth(who) + cellWidth(` ${w.head}`) + 1 <= width ? w.head : NEEDS_YOU
  return [
    line([...who, span(` ${head}`, 'warn', { bold: true, fixed: true })], [], width),
    ...wrapped(w.what, width, { indent: body, maxLines: 4 }),
    ...wrapped(w.consequence, width, { indent: body, tone: 'muted', maxLines: 2 }),
    ...(w.origin ? wrapped(w.origin, width, { indent: body, tone: 'muted', maxLines: 2 }) : []),
    ...wrapped(answerWhere(elsewhere), width, { indent: body, maxLines: 1 }),
  ]
}

/** Tool lines the tree already says (R1): handing work to another agent, by the Agent tool or Legion's bridge tools. */
const isHandOff = (r: ThreadRow): boolean =>
  !!r.tool && (/__(ask|tell|agents)$/.test(r.tool.name) || (r.tool.name === 'Agent' && /^(Ask|Tell) [^:]+:/.test(r.tool.summary)))

/** One tool line that is drawn: running (its verb) or failed; finished ones fold (R8). */
const toolRow = (s: Snapshot, task: TaskView, r: ThreadRow, width: number): Row => {
  const tool = r.tool as NonNullable<ThreadRow['tool']>
  const failed = tool.state === 'error'
  const what = failed ? `${tool.name}  ${oneLine(tool.summary)}` : nowOf(s, { ...task, status: 'running' }, width)
  const right: Part[] = failed ? [span(' '), span('failed', 'danger', { fixed: true }), span(' ')] : tool.state === 'denied' ? [span(' '), span('denied', 'muted', { fixed: true }), span(' ')] : []
  return line([indent(), span(`${MARK.arrow} `, 'muted', { fixed: true }), span(what, failed ? 'text' : 'muted', { strike: tool.state === 'denied' })], right, width)
}

/** A finished tool line, drawn while its task's steps are open. */
const stepRow = (r: ThreadRow, width: number): Row => {
  const tool = r.tool as NonNullable<ThreadRow['tool']>
  return line([indent(), span(`${MARK.arrow} `, 'muted', { fixed: true }), span(tool.name.replace(/^mcp__/, '').replace(/__/g, '·'), 'muted', { fixed: true }), span('  '), span(oneLine(tool.summary), 'muted', { strike: tool.state === 'denied' })], [], width)
}

/**
 * The thread as groups of rows (R8): the person's words, the agent's answers, system notes with their own lead, tool lines
 * only while they run or when they failed. Runs of finished tool lines fold into one "N steps" control (enter opens);
 * with the task's steps open they show, with one control to fold them again.
 */
const threadGroups = (s: Snapshot, agent: AgentView, task: TaskView, width: number, skipRowId: string | undefined): Row[][] => {
  const groups: Row[][] = []
  const open = uiFlags(s.ui).stepsOpen === task.id
  const hasCard = s.cards.some(c => c.taskId === task.id)
  let folded: ThreadRow[] = []
  let openShown = false
  const flushFold = (): void => {
    if (folded.length === 0) return
    if (open) {
      if (!openShown) groups.push([line([indent(), btn({ kind: 'steps', taskId: null }, 'fold steps', { dim: true })], [], width)])
      openShown = true
      groups.push(folded.map(r => stepRow(r, width)))
    } else {
      groups.push([line([indent(), btn({ kind: 'steps', taskId: task.id }, plural(folded.length, 'step'), { dim: true })], [], width)])
    }
    folded = []
  }
  for (const r of s.thread) {
    if (r.id === skipRowId) continue
    if (r.role === 'tool' && r.tool) {
      if (isHandOff(r)) continue
      if (r.tool.state === 'ok' || r.tool.state === 'denied') { folded.push(r); continue }
      // a call that waits on the person is the card under the title; its line here would say it twice (R1)
      if (r.tool.state === 'awaiting' && hasCard) continue
      flushFold()
      groups.push([toolRow(s, task, r, width)])
      continue
    }
    flushFold()
    if (r.role === 'user' && r.fromAgentId) {
      // MessageView.tsx AgentMessage: the sender, "via Legion"
      const from = s.agents.find(a => a.id === r.fromAgentId)
      groups.push([
        line([gutter(), span(from?.glyph ?? MARK.done, 'muted', { fixed: true }), span('   '), span(from?.name ?? r.fromAgentId, 'text', { bold: true, fixed: true }), span(' · via Legion', 'muted')], [], width),
        ...wrapped(r.text, width, { indent: LEAD }),
      ])
    } else if (r.role === 'user') {
      groups.push(wrapped(r.text, width, { lead: [gutter(), span('you', 'muted', { fixed: true }), span(' ')] }))
    } else if (r.role === 'system') {
      // a note from Legion, not speech: its own quiet lead (a failed start reads "Failed: …", in danger)
      const failed = /^failed\b/i.test(r.text)
      groups.push(wrapped(r.text, width, { lead: [gutter(), span(failed ? MARK.error : MARK.done, failed ? 'danger' : 'muted', { fixed: true }), span('   ')], tone: failed ? 'danger' : 'muted' }))
    } else {
      groups.push([md([gutter(), span(agent.glyph, 'text', { bold: true })], LEAD, r.text, width)])
    }
  }
  flushFold()
  return groups
}

/** The keys a footer offers: at most three, then `k` for the rest (R5). */
type Key = { action: Parameters<typeof btn>[0]; label: string; hotkey: string }

const keysLine = (left: Part[], keys: Key[], width: number): Row => {
  const right: Part[] = []
  // a phrase on the left is said whole or not at all: parts marked `fixed` stay, the rest leave whole when short
  const fixedLeft = left.filter(p => p.t === 'text' && p.fixed)
  for (const k of [...keys.slice(0, 3), { action: { kind: 'keys', open: true }, label: 'keys', hotkey: 'k' } as Key]) {
    if (right.length > 0) right.push(span(' · ', 'muted', { fixed: true }))
    right.push(btn(k.action, k.label, { hotkey: k.hotkey }))
  }
  right.push(span(' '))
  const room = width - 1 - partsWidth(right) - 2
  const keep = partsWidth(left) <= room ? left : fixedLeft
  return line([gutter(), ...keep], right, width, 2)
}

/** Where the task stands, in one line with its likely keys; a failure adds its reason. */
const footerRows = (s: Snapshot, agent: AgentView, task: TaskView, width: number): Row[] => {
  const st = STATUS_MARK[task.status]
  const newKey: Key = { action: { kind: 'new', agentId: agent.id }, label: 'new', hotkey: 'n' }
  if (isElsewhere(s, task) && (isActive(task) || task.status === 'paused')) {
    // read-only here: the window that runs it continues or stops it (plan §2.3 "Ownership")
    return [keysLine([span(`${st.mark} in another window`, 'muted', { fixed: true }), span(' · continue or stop it there', 'muted')], [], width)]
  }
  if (isActive(task)) {
    // the card above already says it needs your OK (R1); otherwise the verb of what it is doing now (R2)
    const now = nowOf(s, task, Math.max(12, width - 30))
    const left: Part[] = now === NEEDS_YOU ? [] : [span(st.mark, st.tone, { fixed: true }), span(' '), span(now, 'text')]
    return [keysLine(left, [{ action: { kind: 'stop', taskId: task.id }, label: 'stop', hotkey: 's' }], width)]
  }
  if (task.status === 'paused') {
    // when, for someone coming back to it later; the words shorten before the keys leave
    const ago = relTime(task.updatedAt, s.now)
    const when = ago === 'now' || ago === '' ? '' : ` ${ago} ago`
    const keys: Key[] = [{ action: { kind: 'continue', taskId: task.id }, label: 'continue', hotkey: 'c' }]
    const keyCells = 'c: continue · k: keys '.length + 2
    const say = [`Paused${when} at the turn limit`, 'Paused at the turn limit', 'Paused'].find(t => cellWidth(t) + 3 + keyCells <= width) ?? 'Paused'
    return [keysLine([span(`${MARK.paused} ${say}`, 'warn', { bold: true, fixed: true })], keys, width)]
  }
  if (task.status === 'error') {
    // Thread.tsx "Run failed" → glossary "failed", with the reason and the next step
    return [
      ...wrapped(`Failed: ${task.error || 'no reason was given.'}`, width, { lead: [gutter(), span(MARK.error, 'danger', { fixed: true }), span(' ')], tone: 'danger', maxLines: 3 }),
      keysLine([span('/say to try again', 'muted')], [newKey], width),
    ]
  }
  if (task.status === 'cancelled') return [keysLine([span(`${MARK.cancelled} stopped`, 'muted', { fixed: true }), span(' · /say picks it up again', 'muted')], [newKey], width)]
  const ago = relTime(task.updatedAt, s.now)
  return [keysLine([span(`${MARK.done} done${ago === 'now' || ago === '' ? '' : ` ${ago} ago`}`, 'muted', { fixed: true }), span(' · /say to follow up', 'muted')], [newKey], width)]
}

/** An agent with no task in view: what it does, and the one line that starts work (the rail or the header names it). */
const emptyRows = (agent: AgentView, width: number): Row[] => [
  { t: 'gap' },
  ...(agent.description ? wrapped(agent.description, width, { indent: 4, tone: 'muted', maxLines: 2 }) : []),
  { t: 'gap' },
  line([span('    '), span(`/to ${agent.id} <what to do>`, 'accent', { fixed: true })], [], width),
  { t: 'gap' },
  keysLine([], [{ action: { kind: 'new', agentId: agent.id }, label: 'new', hotkey: 'n' }], width),
]

/**
 * The very first open: no task anywhere yet. Two sentences and one command (design doc "First open"): what this is, who
 * leads, and the line to type. Everything else is behind `k`.
 */
export const firstRunRows = (s: Snapshot, paneWidth: number): Row[] => {
  // a readable measure: on a wide dock the sentence keeps its shape instead of running to the edge
  const width = Math.min(paneWidth, 72)
  const n = visibleAgents(s).length
  const lead = s.agents.find(a => a.id === 'zealot' && !a.isHidden)
  const rows: Row[] = [
    { t: 'gap' },
    line([gutter(), span('✠', 'accent', { bold: true, fixed: true }), span('  '), span(`Your Order is ready: ${n} agents.`, 'text', { bold: true })], [], width),
  ]
  if (lead) {
    // one sentence a line, so no line ends on a lone word at any width
    rows.push(...wrapped(`Tell ${lead.name} what you want.`, width, { indent: 4, tone: 'muted', maxLines: 2 }))
    rows.push(...wrapped('It splits the work and hands it out.', width, { indent: 4, tone: 'muted', maxLines: 2 }))
    rows.push({ t: 'gap' }, line([span('    '), span(`/to ${lead.id} <what you want done>`, 'accent', { fixed: true })], [], width))
  }
  // laid out at the measure, padded to the pane, so every row still spans its column
  return [...rows.map(r => (r.t === 'line' ? line(r.parts, [], paneWidth) : r)), { t: 'gap' }, keysLine([], [], paneWidth)]
}

/** No agents at all: the roster has not loaded. */
export const noAgentRows = (width: number): Row[] => [
  { t: 'gap' },
  line([gutter(), span('✠', 'accent', { bold: true }), span('  '), span('The Order has not mustered yet.', 'text', { bold: true })], [], width),
  ...wrapped('Agents load when the session starts. If this stays empty, type /legion doctor.', width, { indent: 4, tone: 'muted' }),
]

/**
 * The thread's tail that fits `budget` rows: the pane's scroll starts at the top, so the view keeps the newest rows
 * itself and says how many earlier lines it left out. Groups are built newest first and only as far as they fit.
 */
const tail = (groups: Row[][], budget: number, width: number): Row[] => {
  const kept: Row[][] = []
  let used = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as Row[]
    const h = g.reduce((n, r) => n + rowHeight(r), 0)
    if (kept.length > 0 && used + h > budget - 1) break
    kept.unshift(g)
    used += h
  }
  const left = groups.length - kept.length
  const head: Row[] = left > 0 ? [line([indent(), span(`↑ ${plural(left, 'earlier line')}`, 'muted')], [], width)] : []
  return [...head, ...kept.flat()]
}

/** The whole Chat view at `width` cells, its thread fitted to `bodyRows` rows. */
export const chatLayout = (s: Snapshot, width: number, bodyRows: number, chromeRows: number): ChatLayout => {
  const rail = railRows(s, width)
  const railWidth = rail.length > 0 ? railColumns(width) : 0
  // the view is at most THREAD_MAX cells wide, so its two ends line up on a wide dock
  const mw = Math.min(width - railWidth, THREAD_MAX)
  const agent = selectedAgent(s)
  if (!agent) return { railWidth, rail, main: noAgentRows(mw) }
  if (s.tasks.length === 0) return { railWidth, rail, main: firstRunRows(s, mw) }
  const task = selectedTask(s)
  const top: Row[] = []
  // below the rail's breakpoint the header names the shown agent (R7); no strip of glyphs
  if (railWidth === 0) top.push(line([gutter(), span(`${agent.glyph} ${agent.name}`, 'text', { bold: true, fixed: true })], [], mw))
  const tabs = tabsRow(s, agent, task, mw)
  if (tabs) top.push(tabs)
  const ordered = cardsInOrder(s)
  const here = task ? ordered.filter(c => c.taskId === task.id) : []
  const others = ordered.filter(c => !here.includes(c))
  if (others.length > 0) {
    // Thread.tsx "N approvals waiting in another task · Open" → glossary words, who rather than how many (the title row
    // holds the count, R1); open shows that task
    const first = others[0] as ApprovalCard
    const who = others.some(c => c.agentId !== first.agentId) ? `${agentLabel(s, first.agentId)} and others need` : `${agentLabel(s, first.agentId)} needs`
    top.push(line([gutter(), span(`${MARK.card} `, 'warn', { fixed: true }), span(`${who} your OK in another task`, 'warn')], [btn({ kind: 'task', taskId: first.taskId }, 'open'), span(' ')], mw, 2))
  }
  if (!task) return { railWidth, rail, main: [...top, ...emptyRows(agent, mw)] }
  const pieces = descendants(s, task.id)
  top.push(...titleRows(s, task, pieces, mw))
  // needs me: the first card in full, directly under the title; more are counted, not repeated
  if (here.length > 0) {
    top.push(...cardRows(s, here[0] as ApprovalCard, mw))
    const more = here.length - 1
    if (more > 0) top.push(line([gutter(), span(`${MARK.card} ${count(more)} more ${more === 1 ? 'needs' : 'need'} your OK`, 'warn', { fixed: true }), span(' · 2: Order', 'muted')], [], mw))
  }
  // what is happening: the pieces this task handed out, as a tree (its own line left out)
  if (pieces.length > 0) {
    const tree = taskTree([task, ...pieces]).filter(l => l.task.id !== task.id).slice(0, DELEGATED_MAX)
    for (const l of tree) top.push(taskLine(s, l, mw))
    if (pieces.length > tree.length) top.push(line([span('   '), span(`+${count(pieces.length - tree.length)} more · 2: Order`, 'muted')], [], mw))
  }
  // what happened: the conversation, then the reply streaming in
  const groups = threadGroups(s, agent, task, mw, opening(s, task).rowId)
  if (s.live) groups.push([md([gutter(), span(agent.glyph, 'text', { bold: true })], LEAD, `${s.live}${MARK.caret}`, mw)])
  const foot = footerRows(s, agent, task, mw)
  const budget = Math.max(4, bodyRows - chromeRows - top.length - foot.length - 2)
  const body = tail(groups, budget, mw)
  return { railWidth, rail, main: [...top, { t: 'gap' }, ...body, ...(body.length > 0 ? [{ t: 'gap' } as Row] : []), ...foot] }
}

/** The key-help view (`k`): every key, the commands, and one line on what Legion is. `k` again goes back. */
export const keysRows = (width: number): Row[] => {
  const w = Math.min(width, 72)
  const key = (k: string, what: string): Row => line([span('   '), span(fit(k, 8), 'text', { bold: true, fixed: true }), span(what, 'muted')], [], width)
  const rows: Row[] = [
    { t: 'gap' },
    line([gutter(), span('Keys', 'text', { bold: true, fixed: true })], [], width),
    ...wrapped('Legion runs your Order of agents inside Claude Code. Zealot splits the work and hands it out; you answer what needs your OK in the permission dialog.', w, { indent: 3, tone: 'muted', maxLines: 3 }).map(r => (r.t === 'line' ? line(r.parts, [], width) : r)),
    { t: 'gap' },
    key('1 2', 'Chat, Order'),
    key('↑ ↓', 'move between agents and tasks'),
    key('enter', 'open the selected task or step'),
    key('c', 'continue the paused task'),
    key('s', 'stop the shown task'),
    key('n', 'new message to the shown agent'),
    key('k', 'these keys; again to go back'),
    key('Tab', 'reach any control'),
    key('Esc', 'back to typing'),
    { t: 'gap' },
    ...wrapped('Keys work while the Legion pane has focus: ctrl+x tab, or a click in fullscreen. Below 72 columns, pick an agent in 2 Order.', w, { indent: 3, tone: 'muted', maxLines: 3 }).map(r => (r.t === 'line' ? line(r.parts, [], width) : r)),
    ...wrapped('Each has a command too: /to, /say, /legion continue, /legion stop.', w, { indent: 3, tone: 'muted', maxLines: 2 }).map(r => (r.t === 'line' ? line(r.parts, [], width) : r)),
    { t: 'gap' },
    line([gutter()], [btn({ kind: 'keys', open: false }, 'back', { hotkey: 'k' }), span(' ')], width),
  ]
  return rows
}
