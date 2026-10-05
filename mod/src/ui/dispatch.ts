/**
 * The transcript card a `/to <agent> <text>` or `/say <text>` leaves (plan §4 "Transcript dispatch cards"): live while
 * the task runs, then frozen into one summary line, `⌘ Builder · done · 9 turns · ≈$0.21`.
 *
 * Contract with the command (lead-owned): the command's output text names the task as `t_` + 12 hex (TaskView.id).
 * With no such id, or a task the state does not hold, the card is not drawn and the engine draws the text.
 *
 * The transcript is no focus site, so these Buttons take no hotkeys: a card's `a` / `d` live in the band, where the
 * same card is drawn with them. A click works in fullscreen.
 */
import type { TaskView } from '../../types/index.d.ts'
import { MARK } from '../theme.ts'
import { money, plural } from './format.ts'
import { btn, line, span, uniqueKeys, wrapped, type Part, type Row } from './model.ts'
import { oneLine } from './text.ts'
import { agentLabel, cardsInOrder, cleanTitle, isActive, moodWord, shortTool, STATUS_MARK, STATUS_WORDS, type Snapshot } from './views/common.ts'

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
    const left: Part[] = [span(who, 'text', { bold: true }), span(' · '), span(STATUS_WORDS[task.status], st.tone, { fixed: true }), span(` · ${tally(task)}`, 'muted', { fixed: true })]
    if (task.status === 'paused') left.push(span(' · /continue', 'accent'))
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
  const ordered = cardsInOrder(s)
  const index = ordered.findIndex(c => c.taskId === task.id)
  const card = ordered[index]
  if (card) {
    rows.push(line(
      [span(`  ${MARK.card} Needs your OK · ${shortTool(card.tool)}`, 'warn', { bold: true })],
      [btn({ kind: 'card-allow', cardId: card.id, index }, 'Allow'), span('  '), btn({ kind: 'card-deny', cardId: card.id, index }, 'Deny'), span(' ')],
      width,
    ))
  }
  return uniqueKeys(rows)
}
