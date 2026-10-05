/**
 * Task lines as the Order view and the Chat view's "Delegated" block draw them: a task and the pieces it handed out,
 * as a tree (a bridge task sits under the task that asked for it), each line one task with fixed number columns.
 *
 * What survives on a small pane, in order: the state mark, the agent's glyph, the title and the cost. From 80 cells the
 * agent's name joins; from 100, what the agent is doing now (its mood word) and the turns.
 */
import type { TaskView } from '../../../types/index.d.ts'
import { money, plural } from '../format.ts'
import { btn, line, partsWidth, span, type Part, type Row } from '../model.ts'
import { cutCells, fit, oneLine } from '../text.ts'
import { agentById, cleanTitle, glyphOf, isActive, isElsewhere, moodTone, moodWord, STATUS_MARK, type Snapshot } from './common.ts'

/** Fixed columns: cost '≈$1,234.56' is 10 cells; turns '999 turns' 9; the agent's name 11; the now-word 14. */
const COST = 10
const TURNS = 9
const NAME = 11
const NOW = 14

export type TreeLine = { task: TaskView; depth: number; isLast: boolean; prefix: string }

/** The task that asked for `t` through the bridge, when it is in `pool`. */
const parentIn = (pool: ReadonlyMap<string, TaskView>, t: TaskView): TaskView | undefined =>
  t.origin.kind === 'bridge' ? pool.get(t.origin.fromTaskId) : undefined

/**
 * `tasks` as a tree: roots newest first, each followed by the pieces it handed out, oldest first (the order it asked).
 * A cycle in the data (a task naming its own descendant) is broken: every task is drawn once.
 */
export const taskTree = (tasks: readonly TaskView[]): TreeLine[] => {
  const pool = new Map(tasks.map(t => [t.id, t]))
  const kids = new Map<string, TaskView[]>()
  const roots: TaskView[] = []
  for (const t of tasks) {
    const p = parentIn(pool, t)
    if (p && p.id !== t.id) kids.set(p.id, [...(kids.get(p.id) ?? []), t])
    else roots.push(t)
  }
  const out: TreeLine[] = []
  const seen = new Set<string>()
  const walk = (t: TaskView, depth: number, isLast: boolean, lead: string): void => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    out.push({ task: t, depth, isLast, prefix: depth === 0 ? '' : `${lead}${isLast ? '└ ' : '├ '}` })
    const children = (kids.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    children.forEach((c, i) => walk(c, depth + 1, i === children.length - 1, depth === 0 ? '' : `${lead}${isLast ? '  ' : '│ '}`))
  }
  roots.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).forEach(r => walk(r, 0, true, ''))
  // whatever a cycle kept out of reach of a root is drawn flat at the end
  for (const t of tasks) if (!seen.has(t.id)) walk(t, 0, true, '')
  return out
}

/** Every task under `taskId` through the bridge, any depth. */
export const descendants = (s: Pick<Snapshot, 'tasks'>, taskId: string): TaskView[] => {
  const out: TaskView[] = []
  const seen = new Set([taskId])
  for (let i = 0, frontier = [taskId]; i < 8 && frontier.length > 0; i++) {
    const next = s.tasks.filter(t => t.origin.kind === 'bridge' && frontier.includes(t.origin.fromTaskId) && !seen.has(t.id))
    for (const t of next) seen.add(t.id)
    out.push(...next)
    frontier = next.map(t => t.id)
  }
  return out
}

/**
 * One task line: state mark, glyph, [name], tree prefix, title (a Button that opens it), [now], cost, [turns] or a
 * trailing column of the caller's (`tail`, such as the age in Recent).
 */
export const taskLine = (s: Snapshot, l: Pick<TreeLine, 'task' | 'prefix'>, width: number, tail?: Part[]): Row => {
  const t = l.task
  const st = STATUS_MARK[t.status]
  const agent = agentById(s, t.agentId)
  // who first, in fixed columns; the tree hangs the titles, so names and titles each line up
  const lead: Part[] = [span(' '), span(st.mark, st.tone, { fixed: true }), span(' '), span(glyphOf(s, t.agentId), isActive(t) ? 'accent' : 'muted', { fixed: true }), span(' ')]
  if (width >= 80) lead.push(span(fit(agent?.name ?? t.agentId, NAME), 'text', { fixed: true }), span(' '))
  if (l.prefix) lead.push(span(l.prefix, 'line', { fixed: true }))
  const right: Part[] = [span(' ')]
  if (width >= 100 && !tail) {
    // what it is doing now: its agent's mood while it runs; plain state words otherwise
    const now = isElsewhere(s, t) ? 'other window' : t.status === 'running' ? moodWord(s, t.agentId) : t.status === 'queued' ? 'queued' : t.status === 'paused' ? 'paused' : ''
    const tone = isElsewhere(s, t) || t.status === 'queued' ? 'muted' : t.status === 'running' ? moodTone(s, t.agentId) : 'warn'
    right.push(span(fit(now, NOW), tone, { fixed: true }), span(' '))
  }
  right.push(span(fit(money(t.costUsd), COST, { align: 'right' }), 'muted', { fixed: true }))
  if (tail) right.push(...tail)
  else if (width >= 100) right.push(span(' '), span(fit(plural(t.turns, 'turn'), TURNS, { align: 'right' }), 'muted', { fixed: true }))
  right.push(span(' '))
  // below 100 cells a run another window owns says so after its title
  const note: Part[] = isElsewhere(s, t) && width < 100 ? [span(' · other window', 'muted', { fixed: true })] : []
  const room = Math.max(1, width - partsWidth(lead) - partsWidth(note) - partsWidth(right) - 1)
  const title = cutCells(oneLine(cleanTitle(t.title)), room)
  return line([...lead, btn({ kind: 'task', taskId: t.id }, title, { dim: !isActive(t) && t.status !== 'paused' }), ...note], right, width)
}
