/**
 * Task lines as the Order view and the Chat view's "Delegated" block draw them: a task and the pieces it handed out,
 * as a tree (a bridge task sits under the task that asked for it), each line one task with fixed number columns.
 *
 * What survives on a small pane: the agent's glyph, the title and the cost (R7). From 56 cells what the task is doing
 * now joins (R2) in place of the state mark, from 80 the agent's name, and in Order from 100 the turns.
 */
import type { TaskView } from '../../../types/index.d.ts'
import { money, plural } from '../format.ts'
import { btn, line, partsWidth, span, type Part, type Row, type SpanTone } from '../model.ts'
import { cutCells, fit, oneLine } from '../text.ts'
import { agentById, cleanTitle, glyphOf, isActive, isElsewhere, nowOf, STATUS_MARK, type Snapshot } from './common.ts'
/** Fixed columns: cost '≈$1,234.56' is 10 cells; turns '999 turns' 9; the agent's name 11. */
const COST = 10
const TURNS = 9
const NAME = 11

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

/** The tone of a task's now-words: what needs the person is loud, what works is plain, what rests is quiet (R9). */
const nowTone = (s: Snapshot, t: TaskView): SpanTone => {
  if (isElsewhere(s, t)) return 'muted'
  if (t.status === 'running') return s.cards.some(c => c.taskId === t.id) ? 'warn' : 'text'
  if (t.status === 'paused') return 'warn'
  if (t.status === 'error') return 'danger'
  return 'muted'
}

export type TaskLineOptions = {
  /** Order's accounting columns: the turns, from 100 cells. */
  turns?: boolean
  /** A trailing column of the caller's (Recent's age), in place of the now-words. */
  tail?: Part[]
}

/**
 * One task line: tree prefix, glyph, [name], title (a Button that opens it), [what it is doing now], cost.
 * From 56 cells the now-words say the state (R2: a verb while it works); below that a one-cell mark says it instead,
 * so the title and the cost survive (R7). A cost under a cent is left out (R4).
 */
export const taskLine = (s: Snapshot, l: Pick<TreeLine, 'task' | 'prefix'>, width: number, opts: TaskLineOptions = {}): Row => {
  const t = l.task
  const st = STATUS_MARK[t.status]
  const agent = agentById(s, t.agentId)
  // the now-words take 30% of the line, 12 to 26 cells; below 56 cells a one-cell mark says the state instead
  const now = Math.max(12, Math.min(26, Math.floor(width * 0.3)))
  const wide = width >= 56
  const named = width >= 80
  const lead: Part[] = [span(' ')]
  // the tree hangs the titles: after the name when names show (so names line up), else before the glyph
  if (l.prefix && !named) lead.push(span(l.prefix, 'line', { fixed: true }))
  if (!wide) lead.push(span(st.mark, st.tone, { fixed: true }), span(' '))
  lead.push(span(glyphOf(s, t.agentId), 'muted', { fixed: true }), span(' '))
  if (named) lead.push(span(fit(agent?.name ?? t.agentId, NAME), 'text', { fixed: true }), span(' '))
  if (l.prefix && named) lead.push(span(l.prefix, 'line', { fixed: true }))
  const right: Part[] = [span(' ')]
  if (opts.tail) right.push(...opts.tail, span(' '))
  else if (wide) right.push(span(fit(nowOf(s, t, now), now), nowTone(s, t), { fixed: true }), span(' '))
  right.push(span(fit(t.costUsd >= 0.01 ? money(t.costUsd) : '', COST, { align: 'right' }), 'muted', { fixed: true }))
  if (opts.turns && width >= 100) right.push(span(' '), span(fit(t.turns > 0 ? plural(t.turns, 'turn') : '', TURNS, { align: 'right' }), 'muted', { fixed: true }))
  right.push(span(' '))
  const room = Math.max(1, width - partsWidth(lead) - partsWidth(right) - 1)
  const title = cutCells(oneLine(cleanTitle(t.title)), room)
  return line([...lead, btn({ kind: 'task', taskId: t.id }, title, { dim: !isActive(t) && t.status !== 'paused' })], right, width)
}
