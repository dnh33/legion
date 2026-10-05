/**
 * The status line under the prompt (`$.ui.status`): plain text, at most 80 cells. Plan §4 "Status line".
 *
 *   ✠ Zealot · Standing vigil · 2 running · 1 awaiting your word
 *   Speaking to ✠ Zealot · /legion talk off            (while a channel is open)
 *
 * `$.ui.status` draws plain text, so the plan's "turns accent while a channel is open" cannot be drawn here; the
 * band carries the channel in accent instead (band.ts).
 */
import { count } from './format.ts'
import { cellWidth, cutCells } from './text.ts'
import { agentLabel, isActive, moodWord, selectedAgent, type Snapshot } from './views/common.ts'

export const STATUS_MAX = 80

/**
 * Joins parts with ' · '. While the line is too long, parts leave in `dropOrder` (indexes into `parts`); what needs the
 * person goes last. A line still too long is cut with '…'.
 */
const fitParts = (parts: string[], max: number, dropOrder: number[] = []): string => {
  const gone = new Set<number>()
  const join = (): string => parts.filter((_, i) => !gone.has(i)).join(' · ')
  for (const i of dropOrder) {
    if (cellWidth(join()) <= max) break
    gone.add(i)
  }
  return cutCells(join(), max)
}

/** The status line's text; `undefined` (clear the line) when there are no agents to speak of. */
export const statusText = (s: Pick<Snapshot, 'agents' | 'tasks' | 'cards' | 'ui' | 'moods'>, max = STATUS_MAX): string | undefined => {
  if (s.ui.channel) return fitParts([`Speaking to ${agentLabel(s, s.ui.channel)}`, '/legion talk off'], max, [1])
  const agent = selectedAgent(s)
  if (!agent) return undefined
  const running = s.tasks.filter(isActive).length
  const paused = s.tasks.filter(t => t.status === 'paused').length
  const parts = [`${agent.glyph} ${agent.name}`, moodWord(s, agent.id)]
  const drop: number[] = []
  if (running > 0) { drop.push(parts.length); parts.push(`${count(running)} running`) }
  if (paused > 0) { drop.push(parts.length); parts.push(`${count(paused)} paused`) }
  if (s.cards.length > 0) parts.push(`${count(s.cards.length)} awaiting your word`)
  // running goes first, then paused, then the mood; the agent and what awaits the person stay
  return fitParts(parts, max, [...drop, 1])
}
