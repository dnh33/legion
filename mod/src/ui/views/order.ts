/**
 * The Order view with the 2D stage off: the Ops summary of running work, recent tasks, the agents and the doctor. Plan §4 "Order is the 2D stage, or the Ops summary when 2D is
 * off"; the desktop's Ops panel (ui/src/components/OpsPanel.tsx) is the model for Recent.
 */
import type { DoctorLine, TaskView } from '../../../types/index.d.ts'
import { MARK, MOOD_WORDS } from '../../theme.ts'
import { count, money, plural, relTime } from '../format.ts'
import { btn, line, partsWidth, span, wrapped, type Part, type Row } from '../model.ts'
import { cellWidth, cutCells, fit, oneLine } from '../text.ts'
import { isActive, moodWord, nowOf, selectedAgent, visibleAgents, type Snapshot } from './common.ts'
import { STATE_WORD } from '../words.ts'
import { descendants, taskLine, taskTree } from './tasks.ts'

const gutter = (): Part => span(' ')
/** The age column in Recent: '59m' is 3 cells, '12d' 3, kept at 4 so a '100d' fits. */
const AGE = 4
const RECENT_MAX = 8 // OpsPanel.tsx: the 8 most recently updated

const heading = (text: string, width: number, right: Part[] = []): Row =>
  line([gutter(), span(text, 'text', { bold: true, fixed: true })], right, width)

/** The doctor's marks: a pass in accent ("alive and yours"), a problem in danger, information muted. */
const DOCTOR_MARK = { pass: { mark: '✓', tone: 'accent' }, fail: { mark: MARK.error, tone: 'danger' }, info: { mark: MARK.done, tone: 'muted' } } as const

/**
 * The last `/legion doctor` run: one line per check, mark, label in a fixed column, then the detail, which wraps under
 * itself (never under the mark). Problems come first, in the order the doctor found them. No run yet: a one-line hint.
 */
export const doctorRows = (lines: readonly DoctorLine[], width: number): Row[] => {
  const bad = lines.filter(l => l.ok === false).length
  const head = heading('Doctor', width, lines.length === 0 ? [] : [span(bad === 0 ? 'all clear' : `${count(bad)} to fix`, bad === 0 ? 'accent' : 'danger', { fixed: true }), span(' ')])
  if (lines.length === 0) return [head, ...wrapped('/legion doctor checks what Legion needs.', width, { indent: 3, tone: 'muted' })]
  const labelCol = Math.min(16, Math.max(...lines.map(l => cellWidth(l.label)))) + 2
  const ordered = [...lines.filter(l => l.ok === false), ...lines.filter(l => l.ok !== false)]
  const rows: Row[] = [head]
  for (const l of ordered) {
    const m = l.ok === true ? DOCTOR_MARK.pass : l.ok === false ? DOCTOR_MARK.fail : DOCTOR_MARK.info
    const lead: Part[] = [gutter(), span(m.mark, m.tone, { fixed: true }), span(' '), span(fit(l.label, labelCol), l.ok === false ? 'text' : 'muted', { bold: l.ok === false, fixed: true })]
    // "Install it: claude plugin install x": the command gets a line of its own, so a wrap never splits it
    const cmd = /^(.*?:)\s+((?:claude|\/legion|npm|git) .+)$/.exec(l.detail)
    if (cmd) {
      rows.push(...wrapped(cmd[1] as string, width, { lead, tone: l.ok === false ? 'text' : 'muted', maxLines: 3 }))
      // under the detail when it fits there, else under the mark; cut with '…' only past that
      const at = partsWidth(lead) + cellWidth(cmd[2] as string) <= width ? partsWidth(lead) : 3
      rows.push(line([span(' '.repeat(at)), span(cmd[2] as string, 'accent')], [], width))
    } else rows.push(...wrapped(l.detail, width, { lead, tone: l.ok === false ? 'text' : 'muted', maxLines: 4 }))
  }
  return rows
}

/**
 * The Order at a glance, most urgent first, so a small pane keeps what matters:
 * 1. Running: every live task as a tree under the request that started it (Zealot's request, then each piece it
 *    handed out), with who, what they are doing now and what it costs; the cost of what still runs in the heading.
 * 2. Recent: the last finished, failed or stopped tasks, with their age, to pick one up again.
 * 3. Agents: the working ones with their mood word; the idle ones on one line of glyphs.
 * 4. Doctor: the last `/legion doctor` run.
 */
export const orderRows = (s: Snapshot, width: number): Row[] => {
  const rows: Row[] = []
  const sel = selectedAgent(s)
  const agents = visibleAgents(s)

  // Working: tasks still working, queued or paused, with the tasks they handed out and the tasks that handed them out,
  // as one tree. The counts are the title row's (R1); the heading carries the cost of exactly the lines drawn (bug 5).
  const live = s.tasks.filter(t => isActive(t) || t.status === 'paused')
  const shown = new Map(live.map(t => [t.id, t]))
  for (const t of live) for (const d of descendants(s, t.id)) shown.set(d.id, d)
  const parentOf = (t: TaskView): TaskView | undefined => (t.origin.kind === 'bridge' ? s.tasks.find(x => x.id === (t.origin.kind === 'bridge' ? t.origin.fromTaskId : '')) : undefined)
  for (const t of [...shown.values()]) {
    for (let p = parentOf(t), i = 0; p && i < 8; p = parentOf(p), i++) shown.set(p.id, p)
  }
  const tree = taskTree([...shown.values()])
  const total = drawnCost(tree.map(l => l.task))
  rows.push(heading('Working', width, total >= 0.01 ? [span(`${money(total)} so far`, 'muted', { fixed: true }), span(' ')] : []))
  if (tree.length === 0) rows.push(...wrapped('Nothing is working. /to zealot <what you want done> starts it.', width, { indent: 3, tone: 'muted' }))
  for (const l of tree) rows.push(taskLine(s, l, width, { turns: true }))

  // Recent: the last done, failed or stopped tasks (OpsPanel.tsx "Recent tasks"), with their age, to pick one up again
  const recent = s.tasks.filter(t => !shown.has(t.id)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, RECENT_MAX)
  rows.push({ t: 'gap' }, heading('Recent', width))
  if (recent.length === 0) rows.push(...wrapped('Done tasks stay here to pick up again.', width, { indent: 3, tone: 'muted' }))
  for (const t of recent) rows.push(taskLine(s, { task: t, prefix: '' }, width, { turns: true, tail: [span(fit(relTime(t.updatedAt, s.now), AGE, { align: 'right' }), 'muted', { fixed: true })] }))

  // Agents: each one at work, with its mood word (character belongs here, R2); the resting ones share one line
  rows.push({ t: 'gap' }, heading('Agents', width))
  if (agents.length === 0) rows.push(...wrapped('The Order has not mustered yet. If this stays empty, type /legion doctor.', width, { indent: 3, tone: 'muted' }))
  const working = (id: string): boolean => s.tasks.some(t => t.agentId === id && (isActive(t) || t.status === 'paused')) || s.cards.some(c => c.agentId === id)
  const nameCol = Math.min(16, Math.max(13, Math.floor(width / 5)))
  for (const a of agents.filter(x => working(x.id))) {
    const isSel = a.id === sel?.id
    const label = fit(`${a.glyph} ${a.name}`, nameCol)
    // the count of what needs your OK is the title row's (R1); the word says it here
    const cards = s.cards.filter(c => c.agentId === a.id).length
    const word = agentWord(s, a.id)
    rows.push(line([
      span(isSel ? MARK.arrow : ' ', 'accent', { fixed: true }), span(' '),
      isSel ? span(label, 'accent', { bold: true, fixed: true }) : btn({ kind: 'agent', agentId: a.id }, label),
      span(' '), span(word, cards > 0 ? 'warn' : 'text'),
    ], [], width))
  }
  const idle = agents.filter(x => !working(x.id))
  if (idle.length > 0) {
    // one line: the word once, then each resting agent's glyph (a control that opens it)
    const parts: Part[] = [span('  '), span(`${MOOD_WORDS.idle}  `, 'muted', { fixed: true })]
    for (const a of idle) parts.push(a.id === sel?.id ? span(a.glyph, 'accent', { bold: true }) : btn({ kind: 'agent', agentId: a.id }, a.glyph, { dim: true }), span(' '))
    rows.push(line(parts, [], width))
  }

  rows.push({ t: 'gap' }, ...doctorRows(s.doctor ?? [], width))
  return rows
}

/** The cost of the tasks drawn: the one sum the Working heading shows (a spec pins that it matches the lines). */
export const drawnCost = (tasks: readonly TaskView[]): number => tasks.reduce((sum, t) => sum + (Number.isFinite(t.costUsd) && t.costUsd >= 0.01 ? t.costUsd : 0), 0)

/**
 * An agent's word in the Agents list: its mood, unless its state says otherwise (review bug 6). An agent whose call
 * needs your OK is "Awaiting your word"; one at work whose mood rests (Standing vigil, Dormant, a sibling's Victory)
 * shows its task's verb instead; one with only a queued or paused task says so.
 */
export const agentWord = (s: Snapshot, id: string): string => {
  if (s.cards.some(c => c.agentId === id)) return MOOD_WORDS.awaiting
  const m = s.moods[id]?.mood ?? 'idle'
  const atWork = s.tasks.filter(t => t.agentId === id && t.status === 'running').sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const resting = m === 'idle' || m === 'sleeping' || m === 'victory'
  if (atWork) return resting ? nowOf(s, atWork) : moodWord(s, id)
  if (s.tasks.some(t => t.agentId === id && t.status === 'queued')) return STATE_WORD.queued
  if (s.tasks.some(t => t.agentId === id && t.status === 'paused')) return STATE_WORD.paused
  return moodWord(s, id)
}
