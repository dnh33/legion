/**
 * The status line under the prompt (`$.ui.status`): plain text, at most 80 cells. Plan §4 "Status line".
 *
 *   ⌘ Builder · editing replay.test.ts · 1 needs your OK · 2 working
 *   Talking to ✠ Zealot · /legion talk off             (while a channel is open)
 *
 * `$.ui.status` draws plain text, so the plan's "turns accent while a channel is open" cannot be drawn here; the
 * band carries the channel in accent instead (band.ts).
 */
import { count } from './format.ts'
import { cellWidth, cutCells } from './text.ts'
import { agentLabel, nowOf, selectedAgent, type Snapshot } from './views/common.ts'
import { counts, NEEDS_YOU } from './words.ts'

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

/**
 * The status line's text; `undefined` (clear the line) when there are no agents to speak of. The shown agent and what
 * its task is doing now (R2, a verb, never a mood word), then the counts, what needs your OK first (R11 words; the
 * same count function as the title row, so the two agree).
 */
export const statusText = (s: Snapshot, max = STATUS_MAX): string | undefined => {
  if (s.ui.channel) return fitParts([`Talking to ${agentLabel(s, s.ui.channel)}`, '/legion talk off'], max, [1])
  const agent = selectedAgent(s)
  if (!agent) return undefined
  const c = counts(s.tasks, s.cards)
  const mine = s.tasks.filter(t => t.agentId === agent.id && t.status === 'running').sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const parts = [`${agent.glyph} ${agent.name}`]
  const drop: number[] = []
  // a verb, unless it would only repeat the count of what needs your OK beside it (R1)
  const verb = mine ? nowOf(s, mine, 30) : undefined
  if (verb && verb !== NEEDS_YOU) { drop.push(parts.length); parts.push(verb) }
  if (c.needsYou > 0) parts.push(`${count(c.needsYou)} ${c.needsYou === 1 ? 'needs' : 'need'} your OK`)
  const tail: number[] = []
  if (c.working > 0) { tail.push(parts.length); parts.push(`${count(c.working)} working`) }
  if (c.paused > 0) { tail.push(parts.length); parts.push(`${count(c.paused)} paused`) }
  // the paused and working counts leave first, then the verb; the agent and what needs your OK stay
  return fitParts(parts, max, [...tail.reverse(), ...drop])
}
