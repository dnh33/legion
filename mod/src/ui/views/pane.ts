/**
 * The Legion pane as rows: the title row (wordmark, view tabs, the counts), a rule, then the view, or the key-help
 * view while it is open. Phase 1 draws two views, Chat and Order; Rooms, Library and Board get no tab and no placeholder.
 */
import type { ViewId } from '../../../types/index.d.ts'
import { MARK } from '../../theme.ts'
import { count } from '../format.ts'
import { btn, line, partsWidth, span, uniqueKeys, type Part, type Row, type SpanTone } from '../model.ts'
import { cellWidth } from '../text.ts'
import { counts } from '../words.ts'
import { chatLayout, keysRows, type ChatLayout } from './chat.ts'
import { uiFlags, type Snapshot } from './common.ts'
import { orderRows } from './order.ts'

/** The views this phase draws, numbered by what exists (R6: renumbered when Rooms and the Library arrive). */
export const VIEWS: ReadonlyArray<{ id: ViewId; key: string; label: string }> = [
  { id: 'chat', key: '1', label: 'Chat' },
  { id: 'order', key: '2', label: 'Order' },
]

/** Rows above the view: the title row and its rule. */
export const CHROME_ROWS = 2

/** A view this phase does not draw shows Chat. */
export const shownView = (v: ViewId | undefined): ViewId => (VIEWS.some(x => x.id === v) ? (v as ViewId) : 'chat')

/**
 * The counts the title row says, in reading order: what needs the person first (R1: this is the one place on screen
 * for them). Each part has the rank in which it leaves a short row; "needs your OK" leaves last, and below that it
 * shortens to `!1`.
 */
const countParts = (s: Snapshot): Array<{ text: string; tone: SpanTone; drop: number }> => {
  const c = counts(s.tasks, s.cards)
  const parts: Array<{ text: string; tone: SpanTone; drop: number }> = []
  if (c.needsYou > 0) parts.push({ text: `${count(c.needsYou)} ${c.needsYou === 1 ? 'needs' : 'need'} your OK`, tone: 'warn', drop: 4 })
  if (c.working > 0) parts.push({ text: `${count(c.working)} working`, tone: 'muted', drop: 3 })
  if (c.paused > 0) parts.push({ text: `${count(c.paused)} paused`, tone: 'warn', drop: 2 })
  if (c.queued > 0) parts.push({ text: `${count(c.queued)} queued`, tone: 'muted', drop: 1 })
  return parts
}

/**
 * ` ✠ LEGION   1: Chat  2: Order                1 needs your OK · 3 working`. The active tab is text in accent; the other
 * is a Button with its digit, the same width, so nothing moves when the view changes. Spacers are fixed: the tabs never
 * run together (review bug 3).
 */
export const titleRow = (s: Snapshot, width: number): Row => {
  const view = shownView(s.ui.view)
  const left: Part[] = [span(' ', 'text', { fixed: true }), span('✠ LEGION', 'accent', { bold: true, fixed: true }), span('  ', 'text', { fixed: true })]
  for (const v of VIEWS) {
    left.push(span(' ', 'text', { fixed: true }))
    left.push(v.id === view ? span(`${v.key}: ${v.label}`, 'text', { bold: true, fixed: true }) : btn({ kind: 'view', view: v.id }, v.label, { hotkey: v.key, dim: true }))
    left.push(span(' ', 'text', { fixed: true }))
  }
  const room = width - partsWidth(left) - 2
  let parts = countParts(s)
  const text = (ps: typeof parts): string => ps.map(p => p.text).join(' · ')
  for (const rank of [1, 2, 3]) if (cellWidth(text(parts)) > room) parts = parts.filter(p => p.drop !== rank)
  const needs = counts(s.tasks, s.cards).needsYou
  if (cellWidth(text(parts)) > room && needs > 0) parts = [{ text: `${MARK.card}${count(needs)}`, tone: 'warn', drop: 4 }]
  const right: Part[] = []
  parts.forEach((p, i) => {
    if (i > 0) right.push(span(' · ', 'muted', { fixed: true }))
    right.push(span(p.text, p.tone, { fixed: true }))
  })
  if (right.length > 0) right.push(span(' ', 'text', { fixed: true }))
  return line(left, right, width, 2)
}

export const ruleRow = (width: number): Row => line([span(MARK.rule.repeat(Math.max(0, width)), 'line')], [], width)

export type PaneLayout = { title: Row[] } & ChatLayout

/** The whole pane at `width` cells, its body fitted to `bodyRows` rows. Order has no rail. */
export const paneLayout = (s: Snapshot, width: number, bodyRows: number): PaneLayout => {
  const title = [titleRow(s, width), ruleRow(width)]
  const l: PaneLayout = uiFlags(s.ui).keysOpen
    ? { title, railWidth: 0, rail: [], main: keysRows(width) }
    : shownView(s.ui.view) === 'order'
      ? { title, railWidth: 0, rail: [], main: orderRows(s, width) }
      : { title, ...chatLayout(s, width, bodyRows, CHROME_ROWS) }
  // the pane is one site: a key (a task opened from its tab and from a card notice) is unique across all of it
  const all = uniqueKeys([...l.title, ...l.rail, ...l.main])
  return { title: all.slice(0, l.title.length), railWidth: l.railWidth, rail: all.slice(l.title.length, l.title.length + l.rail.length), main: all.slice(l.title.length + l.rail.length) }
}
