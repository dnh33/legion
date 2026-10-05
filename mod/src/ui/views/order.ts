/**
 * The Order view with the 2D stage off: the Ops summary. Every agent with its mood word, the running tasks with cost
 * and turns, the recent ones, and the doctor's line. Plan §4 "Order is the 2D stage, or the Ops summary when 2D is
 * off"; the desktop's Ops panel (ui/src/components/OpsPanel.tsx) is the model for Recent.
 */
import type { TaskView } from '../../../types/index.d.ts'
import { MARK } from '../../theme.ts'
import { count, money, plural, relTime } from '../format.ts'
import { btn, line, partsWidth, span, wrapped, type Part, type Row } from '../model.ts'
import { cutCells, fit, oneLine } from '../text.ts'
import { cleanTitle, glyphOf, isActive, moodTone, moodWord, selectedAgent, STATUS_MARK, visibleAgents, type Snapshot } from './common.ts'

const gutter = (): Part => span(' ')
/** Fixed columns: cost '≈$1,234.56' is 10 cells; turns '999 turns' 9; age '59m' 4. */
const COST = 10
const TURNS = 9
const AGE = 4
const RECENT_MAX = 8 // OpsPanel.tsx: the 8 most recently updated

const heading = (text: string, n: number | undefined, width: number, right: Part[] = []): Row =>
  line([gutter(), span(text, 'text', { bold: true }), ...(n !== undefined && n > 0 ? [span(`  ${count(n)}`, 'muted')] : [])], right, width)

/** One task line: mark, the agent's glyph, the title (a Button: it opens the task), then fixed number columns. */
const taskRow = (s: Snapshot, t: TaskView, width: number, right: Part[]): Row => {
  const st = STATUS_MARK[t.status]
  const lead: Part[] = [gutter(), span(st.mark, st.tone), span(' '), span(glyphOf(s, t.agentId), 'muted'), span(' ')]
  const room = Math.max(1, width - partsWidth(lead) - partsWidth(right) - 1)
  const title = cutCells(oneLine(cleanTitle(t.title)), room)
  return line([...lead, btn({ kind: 'task', taskId: t.id }, title, { dim: !isActive(t) && t.status !== 'paused' })], right, width)
}

export const orderRows = (s: Snapshot, width: number): Row[] => {
  const rows: Row[] = []
  const sel = selectedAgent(s)
  const agents = visibleAgents(s)
  const showTurns = width >= 60

  // Agents, each with its mood word: a glance at the whole order
  rows.push(heading('Agents', undefined, width, sel ? [btn({ kind: 'poke', agentId: sel.id }, `Poke ${sel.name}`, { hotkey: 'p', dim: true }), span(' ')] : []))
  if (agents.length === 0) rows.push(...wrapped('The order has not mustered yet. If this stays empty, run /legion doctor.', width, { indent: 3, tone: 'muted' }))
  const nameCol = Math.min(16, Math.max(10, Math.floor(width / 4)))
  for (const a of agents) {
    const isSel = a.id === sel?.id
    const label = fit(`${a.glyph} ${a.name}`, nameCol)
    const running = s.tasks.filter(t => t.agentId === a.id && isActive(t)).length
    const cards = s.cards.filter(c => c.agentId === a.id).length
    // fixed columns, so a row does not move when an agent starts; compact below 60 cells ('●2' for '2 running')
    const runText = running === 0 ? '' : width >= 60 ? `${count(running)} running` : `${MARK.running}${count(running)}`
    const right: Part[] = [
      span(fit(runText, width >= 60 ? 10 : 4, { align: 'right' }), 'accent'),
      span(fit(cards > 0 ? `${MARK.card}${count(cards)}` : '', 5, { align: 'right' }), 'warn'),
      span(' '),
    ]
    rows.push(line([
      span(isSel ? MARK.arrow : ' ', 'accent'), span(' '),
      isSel ? span(label, 'accent', { bold: true }) : btn({ kind: 'agent', agentId: a.id }, label, { dim: running === 0 && cards === 0 }),
      span('  '), span(moodWord(s, a.id), moodTone(s, a.id)),
    ], right, width))
  }

  // Running: what is working now, and what waits at the turn limit
  const live = s.tasks.filter(t => isActive(t) || t.status === 'paused').sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  rows.push({ t: 'gap' }, heading('Running', live.length, width))
  if (live.length === 0) rows.push(...wrapped('Nothing running. Press n in Chat to start a task.', width, { indent: 3, tone: 'muted' }))
  for (const t of live) {
    const right: Part[] = [span(' '), span(fit(money(t.costUsd), COST, { align: 'right' }), 'muted')]
    if (showTurns) right.push(span(' '), span(fit(plural(t.turns, 'turn'), TURNS, { align: 'right' }), 'muted'))
    right.push(span(' '))
    rows.push(taskRow(s, t, width, right))
  }

  // Recent: the last finished, failed or stopped tasks (OpsPanel.tsx "Recent tasks")
  const recent = s.tasks.filter(t => !isActive(t) && t.status !== 'paused').sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, RECENT_MAX)
  rows.push({ t: 'gap' }, heading('Recent', recent.length, width))
  if (recent.length === 0) rows.push(...wrapped('Tasks show up here as agents work.', width, { indent: 3, tone: 'muted' }))
  for (const t of recent) {
    rows.push(taskRow(s, t, width, [span(' '), span(fit(money(t.costUsd), COST, { align: 'right' }), 'muted'), span(' '), span(fit(relTime(t.updatedAt, s.now), AGE, { align: 'right' }), 'muted'), span(' ')]))
  }

  if (s.doctor) rows.push({ t: 'gap' }, line([gutter(), span('Doctor', 'text', { bold: true }), span(`  ${s.doctor}`, 'muted')], [], width))
  return rows
}
