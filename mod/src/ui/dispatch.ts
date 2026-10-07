/**
 * The transcript card a `/to <agent> <text>` or `/say <text>` leaves (plan §4 "Transcript dispatch cards"): live while
 * the task works, then frozen into one summary line, `· ⌘ Builder · done · ≈$0.21 · 9 turns`.
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
import { cellWidth, oneLine } from './text.ts'
import { answerWhere } from './cards.ts'
import { agentLabel, cardsInOrder, isElsewhere, cleanTitle, isActive, nowOf, STATUS_MARK, STATUS_WORDS, type Snapshot } from './views/common.ts'
import { NEEDS_YOU, STATE_WORD } from './words.ts'

const TASK_ID = /\bt_[0-9a-f]{12}\b/

/** The task id a command's output names, or none. */
export const taskIdIn = (text: string): string | undefined => TASK_ID.exec(text)?.[0]

/** The numbers of a summary line, as every other surface orders them: cost, then turns; a zero says nothing (R4). */
const tally = (t: TaskView): string => [t.costUsd >= 0.01 ? money(t.costUsd) : '', t.turns > 0 ? plural(t.turns, 'turn') : ''].filter(Boolean).map(x => ` · ${x}`).join('')

/**
 * The rows of the card for `task`, or none when the text names no task the state holds. Every line starts with the
 * task's state mark, names the agent once, and gives the next step as a command that names its task's agent (review
 * bug 2: a bare /legion continue acts on the task the pane shows).
 */
export const dispatchRows = (s: Snapshot, text: string, width: number): Row[] | undefined => {
  const id = taskIdIn(text)
  const task = id ? s.tasks.find(t => t.id === id) : undefined
  if (!task) return undefined
  const who = agentLabel(s, task.agentId)
  const st = STATUS_MARK[task.status]
  const head: Part[] = [span(`${st.mark} `, st.tone, { fixed: true }), span(who, 'text', { bold: true, fixed: true })]
  if (!isActive(task)) {
    // frozen: one line; a paused task says how to go on, a failed one what went wrong and what to do
    // the numbers give way first on a narrow line, then the long state words; the state and the next step stay
    const next = task.status === 'paused' && !isElsewhere(s, task) ? ` · /legion continue ${task.agentId}` : ''
    const full = STATUS_WORDS[task.status]
    const fits = (words: string, numbers: string) => cellWidth(`${st.mark} ${who} · ${words}${numbers}${next}`) <= width
    const numbers = fits(full, tally(task)) ? tally(task) : ''
    const words = task.status === 'paused' && !fits(full, numbers) ? STATE_WORD.paused : full
    // narrower still, the command already names the agent, so the label goes: `‖ paused · /legion continue builder`
    const label = fits(words, numbers) || !next ? [...head, span(' · ', 'muted', { fixed: true })] : [span(`${st.mark} `, st.tone, { fixed: true })]
    const left: Part[] = [...label, span(words, st.tone === 'muted' ? 'text' : st.tone, { fixed: true }), span(numbers, 'muted')]
    if (next) left.push(span(next, 'accent', { fixed: true }))
    const rows = [line(left, [], width)]
    if (task.status === 'error') {
      rows.push(...wrapped(task.error || 'No reason was given.', width, { indent: 2, tone: 'muted', maxLines: 2 }))
      rows.push(line([span('  '), span(`/to ${task.agentId} <what to do> to try again`, 'muted', { fixed: true })], [], width))
    }
    return rows
  }
  // live: who and what it is doing now (R2), the numbers; the task's title; what needs your OK, if anything
  // the card line says "needs your OK" when there is one, so the first line then leaves its verb out (R1)
  const card = cardsInOrder(s).find(c => c.taskId === task.id)
  const rows: Row[] = [
    line([...head, ...(card ? [] : [span(' · ', 'muted', { fixed: true }), span(nowOf(s, task, 30), 'text')]), span(tally(task), 'muted', { fixed: true })], [], width),
    line([span('  '), span(oneLine(cleanTitle(task.title)), 'muted')], [], width),
  ]
  if (card) {
    // where to answer stays on a wide line; below 56 cells the command has the room
    const where: Part[] = width >= 56 ? [span(answerWhere(isElsewhere(s, task), true), 'muted', { fixed: true }), span(' ')] : []
    rows.push(line(
      [span(`  ${MARK.card} `, 'warn', { bold: true, fixed: true }), span(NEEDS_YOU, 'warn', { bold: true, fixed: true }), span(' · ', 'muted', { fixed: true }), span(oneLine(card.summary))],
      where, width, 2,
    ))
  }
  return uniqueKeys(rows)
}
