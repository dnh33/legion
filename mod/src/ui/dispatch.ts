/**
 * The transcript card a `/to <agent> <text>` or `/say <text>` leaves (plan §4 "Transcript dispatch cards"): live while
 * the task runs, then frozen into one summary line, `⌘ Builder · done · 9 turns · ≈$0.21`.
 *
 * Contract with the command (lead-owned): the command's output text names the task as `t_` + 12 hex (TaskView.id).
 * With no such id, or a task the state does not hold, the card is not drawn and the engine draws the text.
 *
 * The card holds no controls: a waiting approval is answered in Claude Code's own permission dialog (plan §2.1).
 */
import type { TaskView } from '../../types/index.d.ts'
import { MARK } from '../theme.ts'
import { money, plural } from './format.ts'
import { line, span, uniqueKeys, wrapped, type Part, type Row } from './model.ts'
import { oneLine } from './text.ts'
import { askVerb, answerWhere } from './cards.ts'
import { agentLabel, cardsInOrder, isElsewhere, cleanTitle, isActive, moodWord, shortTool, STATUS_MARK, STATUS_WORDS, type Snapshot } from './views/common.ts'

const TASK_ID = /\bt_[0-9a-f]{12}\b/

/** The task id a command's output names, or none. */
export const taskIdIn = (text: string): string | undefined => TASK_ID.exec(text)?.[0]

/** The numbers of a summary line: turns and cost, in that order (the plan's line). */
const tally = (t: TaskView): string => `${plural(t.turns, 'turn')} · ${money(t.costUsd)}`

/** The rows of the card for `task`, or none when the text names no task the state holds. */
export const dispatchRows = (s: Snapshot, text: string, width: number): Row[] | undefined => {
  const id = taskIdIn(text)
  const task = id ? s.tasks.find(t => t.id === id) : undefined
  if (!task) return undefined
  const who = agentLabel(s, task.agentId)
  const st = STATUS_MARK[task.status]
  if (!isActive(task)) {
    // frozen: one line; a paused run says how to go on, a failed one what went wrong
    // a paused run's next step is never the part that gives way: below 72 cells its state says just "paused"
    const words = task.status === 'paused' && width < 72 ? 'paused' : STATUS_WORDS[task.status]
    const left: Part[] = [span(who, 'text', { bold: true }), span(' · '), span(words, st.tone, { fixed: true }), span(` · ${tally(task)}`, 'muted', { fixed: true })]
    if (task.status === 'paused') left.push(span(' · /continue', 'accent', { fixed: true }))
    const rows = [line(left, [], width)]
    if (task.status === 'error') rows.push(...wrapped(task.error || 'The run failed without a message.', width, { indent: 2, tone: 'muted', maxLines: 2 }))
    return rows
  }
  // live: who, what they are doing, the numbers; the task's title; the newest tool chip; a card if one waits
  const rows: Row[] = [
    line([span(`${st.mark} `, st.tone, { fixed: true }), span(who, 'text', { bold: true }), span(` · ${task.status === 'queued' ? 'Queued' : moodWord(s, task.agentId)}`, 'accent'), span(` · ${tally(task)}`, 'muted', { fixed: true })], [], width),
    line([span('  '), span(oneLine(cleanTitle(task.title)), 'muted')], [], width),
  ]
  const thread = s.thread
  const lastTool = [...thread].reverse().find(r => r.role === 'tool' && r.tool)
  if (lastTool?.tool) rows.push(line([span(`  ${MARK.arrow} `, 'muted'), span(shortTool(lastTool.tool.name)), span('  '), span(oneLine(lastTool.tool.summary), 'muted')], [], width))
  const card = cardsInOrder(s).find(c => c.taskId === task.id)
  if (card) {
    // who asks for what, and where to answer (cards.ts); the transcript holds no controls for it
    rows.push(line(
      [span(`  ${MARK.card} `, 'warn', { bold: true, fixed: true }), span(`${agentLabel(s, card.agentId)} ${askVerb(card.tool)}`, 'warn', { bold: true })],
      [span(answerWhere(isElsewhere(s, task), true), 'muted', { fixed: true }), span(' ')],
      width, 2,
    ))
  }
  return uniqueKeys(rows)
}
