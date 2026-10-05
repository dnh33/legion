/**
 * The Legion pane as rows: the title row (wordmark, view tabs, a running count), a rule, then the view.
 *
 * Phase 1 draws two views, Chat and Order. Rooms, Library and Board are not built, so they get no tab and no
 * placeholder screen; their keys (2, 3, 4) stay free until they are.
 */
import type { ViewId } from '../../../types/index.d.ts'
import { MARK } from '../../theme.ts'
import { count } from '../format.ts'
import { btn, line, span, uniqueKeys, type Part, type Row } from '../model.ts'
import { chatLayout, type ChatLayout } from './chat.ts'
import { isActive, type Snapshot } from './common.ts'
import { orderRows } from './order.ts'

/** The views this phase draws, with their keys (plan §4: `1 Chat · 2 Rooms · 3 Library · 4 Board · 5 Order`). */
export const VIEWS: ReadonlyArray<{ id: ViewId; key: string; label: string }> = [
  { id: 'chat', key: '1', label: 'Chat' },
  { id: 'order', key: '5', label: 'Order' },
]

/** Rows above the view: the title row and its rule. */
export const CHROME_ROWS = 2

/** A view this phase does not draw shows Chat. */
export const shownView = (v: ViewId | undefined): ViewId => (VIEWS.some(x => x.id === v) ? (v as ViewId) : 'chat')

/**
 * ` ✠ LEGION  1: Chat  5: Order                    2 running · !1`. The active tab is text in accent (pressing it would
 * do nothing); the others are Buttons with their digit, drawn the same width so nothing moves when the view changes.
 */
export const titleRow = (s: Snapshot, width: number): Row => {
  const view = shownView(s.ui.view)
  const left: Part[] = [span(' '), span('✠ LEGION', 'accent', { bold: true, fixed: true })]
  for (const v of VIEWS) {
    left.push(span('  '))
    left.push(v.id === view ? span(`${v.key}: ${v.label}`, 'accent', { bold: true, fixed: true }) : btn({ kind: 'view', view: v.id }, v.label, { hotkey: v.key, dim: true }))
  }
  const running = s.tasks.filter(isActive).length
  const right: Part[] = []
  if (running > 0) right.push(span(`${count(running)} running`, 'muted'))
  if (s.cards.length > 0) right.push(span(right.length > 0 ? ' · ' : '', 'muted'), span(`${MARK.card}${count(s.cards.length)} need your OK`, 'warn'))
  if (right.length > 0) right.push(span(' '))
  return line(left, right, width, 2)
}

export const ruleRow = (width: number): Row => line([span(MARK.rule.repeat(Math.max(0, width)), 'line')], [], width)

export type PaneLayout = { title: Row[] } & ChatLayout

/** The whole pane at `width` cells, its body fitted to `bodyRows` rows. Order has no rail. */
export const paneLayout = (s: Snapshot, width: number, bodyRows: number): PaneLayout => {
  const title = [titleRow(s, width), ruleRow(width)]
  const l: PaneLayout = shownView(s.ui.view) === 'order'
    ? { title, railWidth: 0, rail: [], main: orderRows(s, width) }
    : { title, ...chatLayout(s, width, bodyRows, CHROME_ROWS) }
  // the pane is one site: a key (a task opened from its tab and from a card notice) is unique across all of it
  const all = uniqueKeys([...l.title, ...l.rail, ...l.main])
  return { title: all.slice(0, l.title.length), railWidth: l.railWidth, rail: all.slice(l.title.length, l.title.length + l.rail.length), main: all.slice(l.title.length + l.rail.length) }
}
