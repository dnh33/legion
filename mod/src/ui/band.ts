/**
 * The band above the prompt: only what needs the person, one row each, at most three, then `+N more · /legion to open`.
 * Plan §4 "Band". It yields to a survey and is gone when nothing waits (the render hook passes then).
 *
 * Rows, in order: the open channel (`Speaking to ✠ Zealot`), approval cards (oldest first), then the band items the
 * engine posted (finished, paused, failed runs, Library notes), newest first.
 *
 * Keys are letters only: a bare digit typed into an empty prompt presses a band Button (ButtonProps.hotkey,
 * claude-code.d.ts), and a stray digit must never continue a task. Card rows carry no controls: approvals are answered
 * in Claude Code's own permission dialog (plan §2.1). The first paused run takes `c` (not one another window owns),
 * the first finished or failed run `o`, the first dismissable row `x`. Every other control is reached with Tab.
 *
 * Cards come from the `cards` state, the one truth for what is waiting; a band item of kind `card` is not drawn
 * twice.
 */
import type { ApprovalCard, BandItem } from '../../types/index.d.ts'
import { MARK } from '../theme.ts'
import { count } from './format.ts'
import { bandOrder } from './actions.ts'
import { btn, line, span, uniqueKeys, type Part, type Row, type SpanTone } from './model.ts'
import { oneLine } from './text.ts'
import { askVerb, answerWhere } from './cards.ts'
import { agentLabel, cardsInOrder, isElsewhere, shortTool, taskOf, type Snapshot } from './views/common.ts'

export const BAND_MAX = 3

type Entry =
  | { kind: 'channel'; agentId: string }
  | { kind: 'card'; card: ApprovalCard; index: number }
  | { kind: 'item'; item: BandItem; index: number }

const ITEM_MARK: Record<BandItem['kind'], { mark: string; tone: SpanTone }> = {
  card: { mark: MARK.card, tone: 'warn' },
  done: { mark: MARK.done, tone: 'accent' },
  paused: { mark: MARK.paused, tone: 'warn' },
  error: { mark: MARK.error, tone: 'danger' },
  inbox: { mark: MARK.done, tone: 'muted' },
}

/** Everything that waits, in band order. */
export const bandEntries = (s: Snapshot): Entry[] => [
  ...(s.ui.channel ? [{ kind: 'channel', agentId: s.ui.channel } as const] : []),
  ...cardsInOrder(s).map((card, index) => ({ kind: 'card', card, index }) as const),
  ...bandOrder(s.band).map((item, index) => ({ kind: 'item', item, index }) as const),
]

/** The band's rows at `width` cells and at most `maxRows` rows; none when nothing waits. */
export const bandRows = (s: Snapshot, width: number, maxRows: number): Row[] => {
  const all = bandEntries(s)
  const cap = Math.max(0, Math.min(BAND_MAX, Math.floor(maxRows)))
  if (all.length === 0 || cap === 0) return []
  const shown = all.length <= cap ? all : all.slice(0, cap - 1)
  const taken = new Set<string>()
  /** The hotkey once per band: the first row that asks for it gets it. */
  const key = (k: string): string | undefined => (taken.has(k) ? undefined : (taken.add(k), k))
  const wide = width >= 72
  const rows = shown.map((e): Row => {
    if (e.kind === 'channel') {
      return line([span(' '), span('Speaking to ', 'accent'), span(agentLabel(s, e.agentId), 'accent', { bold: true, fixed: true }), span(' · /legion talk off', 'muted')], [], width)
    }
    if (e.kind === 'card') {
      // who asks, what exactly, then where to answer; no buttons (cards.ts: the run waits on Claude Code's dialog)
      const c = e.card
      const where = answerWhere(isElsewhere(s, taskOf(s, c.taskId)), true)
      const left: Part[] = [span(' '), span(`${MARK.card} `, 'warn', { fixed: true }), span(agentLabel(s, c.agentId), 'text', { bold: true, fixed: true }), span(wide ? ` ${askVerb(c.tool)}` : ` · ${shortTool(c.tool)}`, 'warn'), span('  '), span(oneLine(c.summary))]
      return line(left, [span(where, 'muted', { fixed: true }), span(' ')], width, 2)
    }
    const it = e.item
    const m = ITEM_MARK[it.kind]
    const left: Part[] = [span(' '), span(`${m.mark} `, m.tone, { fixed: true })]
    if (it.agentId) left.push(span(agentLabel(s, it.agentId), 'text', { bold: true }), span(' · ', 'muted'))
    left.push(span(oneLine(it.text), it.kind === 'error' ? 'danger' : 'text'))
    const right: Part[] = [span(' ')]
    if (it.kind === 'paused' && it.taskId && !isElsewhere(s, taskOf(s, it.taskId))) {
      const id = it.taskId
      right.push(btn({ kind: 'continue', taskId: id }, 'Continue', { hotkey: key('c') }), span('  '))
    } else if ((it.kind === 'done' || it.kind === 'error') && it.taskId) {
      const id = it.taskId
      right.push(btn({ kind: 'task', taskId: id }, 'Open', { hotkey: key('o') }), span('  '))
    }
    right.push(btn({ kind: 'band-dismiss', itemId: it.id, index: e.index }, 'Dismiss', { hotkey: key('x'), dim: true }), span(' '))
    return line(left, right, width)
  })
  if (shown.length < all.length) {
    const more = all.length - shown.length
    rows.push(line([span(' '), span(`+${count(more, 999)} more · /legion to open`, 'muted')], [], width))
  }
  return uniqueKeys(rows)
}
