/**
 * The Legion pane as plain data: rows of spans and buttons, before any element is made.
 *
 * Every view (chat, order, band, dispatch) builds `Row[]` here in pure code, and `components.tsx` turns rows into the
 * surface's elements. That split is what lets Node specs prove the layout rules no plugin test can see (the kit
 * exercises trees, not paint): each `line` row is exactly the width it was built for, at every size and in every
 * state, and every Button's action is the UiActions call it claims to be.
 *
 * Widths are terminal cells (text.ts). A plain Button draws its label alone, or `h: label` beside its hotkey
 * (ButtonProps.plain, claude-code.d.ts), so its width is known before drawing.
 */
import { encodeAction, type UiAction } from './actions.ts'
import { cellWidth, fit, wrapCells } from './text.ts'

/** What a span means; components.tsx maps it to the palette (theme.ts). `text` is the terminal's own colour. */
export type SpanTone = 'text' | 'muted' | 'accent' | 'warn' | 'danger' | 'line'

/** `fixed`: never cut to make room (the wordmark, a tab, a mark); only free text gives way. */
export type Span = { t: 'text'; text: string; tone?: SpanTone; bold?: boolean; strike?: boolean; fixed?: boolean }

/**
 * A plain Button: one control, one action. Its `key` is `encodeAction(action)` (actions.ts), unique in its site once
 * `uniqueKeys` has run; the lead's `ui.press` hook acts on it. `hotkey` is one letter or digit, one per site.
 */
export type Btn = {
  t: 'button'
  key: string
  label: string
  action: UiAction
  hotkey?: string
  /** Drawn dim at rest (a secondary control). */
  dim?: boolean
}

export type Part = Span | Btn

/**
 * A row:
 * - `line`: spans and buttons on one terminal line, exactly `width` cells;
 * - `md`: a lead column of `lead` cells (spans), then model-style text the surface lays out (Markdown);
 * - `gap`: one empty line.
 */
export type Row =
  | { t: 'line'; parts: Part[] }
  | { t: 'md'; lead: Part[]; leadWidth: number; width: number; text: string; dim?: boolean; estRows: number }
  | { t: 'gap' }

export const span = (text: string, tone: SpanTone = 'text', more: { bold?: boolean; strike?: boolean; fixed?: boolean } = {}): Span => ({ t: 'text', text, tone, ...more })

export const btn = (action: UiAction, label: string, more: { hotkey?: string; dim?: boolean } = {}): Btn => ({ t: 'button', key: encodeAction(action), label, action, ...more })

/** How many cells a part takes on the terminal: a plain Button with a hotkey draws `h: label`. */
export const partWidth = (p: Part): number => (p.t === 'text' ? cellWidth(p.text) : cellWidth(p.label) + (p.hotkey ? cellWidth(p.hotkey) + 2 : 0))

export const partsWidth = (parts: readonly Part[]): number => parts.reduce((w, p) => w + partWidth(p), 0)

/** Cells a row takes; `md` rows report their lead plus the text's widest line, an estimate. */
export const rowWidth = (r: Row): number => (r.t === 'line' ? partsWidth(r.parts) : r.t === 'md' ? r.leadWidth : 0)

/** Lines a row is expected to take: 1 for a line or gap, the estimate for model text. */
export const rowHeight = (r: Row): number => (r.t === 'md' ? Math.max(1, r.estRows) : 1)

/**
 * One line of exactly `width` cells: `left` parts, then at least `minGap` spaces, then `right` parts flush right. When the
 * two do not fit,
 * the last text span of `left` is cut with `…` (never a Button's label); failing that, `right` is dropped.
 */
export const line = (left: Part[], right: Part[], width: number, minGap = 1): Row => {
  const w = Math.max(0, Math.floor(width))
  let rightParts = right
  // at least `minGap` cells between the two sides, so a button never touches the text before it
  let room = w - partsWidth(rightParts) - (rightParts.length > 0 ? minGap : 0)
  if (room < 0 || (room < partsWidth(left) && !canShrink(left, partsWidth(left) - room))) {
    rightParts = []
    room = w
  }
  const leftParts = shrinkTo(left, room)
  const gap = w - partsWidth(rightParts) - partsWidth(leftParts)
  const parts: Part[] = [...leftParts]
  if (gap > 0) parts.push(span(' '.repeat(gap)))
  parts.push(...rightParts)
  return { t: 'line', parts: merge(parts) }
}

/** True when cutting or dropping the free text spans of `parts` can save `need` cells. */
const canShrink = (parts: readonly Part[], need: number): boolean => {
  let saveable = 0
  for (const p of parts) if (p.t === 'text' && !p.fixed) saveable += cellWidth(p.text)
  return saveable >= need
}

/** The fewest cells a cut span keeps; shorter, it is dropped. */
const MIN_KEPT = 6

/**
 * Cuts the widest text spans of `parts` until they fit in `room` cells, longest first, so a title gives way before a
 * glyph or a mark does. Buttons are never cut. If nothing more can give, the overrun parts are dropped from the end.
 */
export const shrinkTo = (parts: readonly Part[], room: number): Part[] => {
  const out = parts.map(p => ({ ...p })) as Part[]
  let over = partsWidth(out) - room
  while (over > 0) {
    // spacing left at the end (after a span that was dropped) goes before any word is cut
    const last = out[out.length - 1]
    if (last?.t === 'text' && !last.fixed && last.text.trim() === '') {
      out.pop()
      over = partsWidth(out) - room
      continue
    }
    let at = -1
    let widest = 1
    out.forEach((p, i) => {
      if (p.t === 'text' && !p.fixed && cellWidth(p.text) > widest) { widest = cellWidth(p.text); at = i }
    })
    if (at < 0) break
    const p = out[at] as Span
    const keep = widest - over
    // a span cut below MIN_KEPT cells says nothing ('Au…'); it leaves instead, and the gap is padded
    p.text = keep >= MIN_KEPT ? fit(p.text, keep) : ''
    const before = over
    over = partsWidth(out) - room
    // a cut that saved nothing (a glyph wider than the terminal counts it) drops the span, so the loop always ends
    if (over >= before) { p.text = ''; over = partsWidth(out) - room }
  }
  while (partsWidth(out) > room && out.length > 0) out.pop()
  return out.filter(p => p.t !== 'text' || p.text !== '')
}

/** Joins neighbouring text spans that look the same: fewer elements, the same picture. */
const merge = (parts: Part[]): Part[] => {
  const out: Part[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (p.t === 'text' && p.text === '') continue
    if (p.t === 'text' && last?.t === 'text' && last.tone === p.tone && !!last.bold === !!p.bold && !!last.strike === !!p.strike && !!last.fixed === !!p.fixed) {
      out[out.length - 1] = { ...last, text: last.text + p.text }
    } else out.push(p)
  }
  return out
}

/**
 * Text wrapped to `width - indent` cells, as `line` rows each exactly `width` cells: `lead` (or spaces) on the first
 * line, spaces of the same width after. At most `maxLines` lines; the last one ends in `…` when text was left out.
 */
export const wrapped = (text: string, width: number, opts: { lead?: Part[]; indent?: number; tone?: SpanTone; bold?: boolean; maxLines?: number } = {}): Row[] => {
  const indent = opts.lead ? partsWidth(opts.lead) : (opts.indent ?? 0)
  const inner = Math.max(1, width - indent)
  let lines = wrapCells(text, inner)
  const max = opts.maxLines ?? Infinity
  if (lines.length > max) {
    lines = lines.slice(0, max)
    // ' …' after the last kept line; when that overruns, fit cuts the line and ends it in '…' itself
    lines[max - 1] = fit(`${lines[max - 1] ?? ''} …`, inner).trimEnd()
  }
  return lines.map((l, i) => {
    const lead = i === 0 && opts.lead ? opts.lead : [span(' '.repeat(indent))]
    return line([...lead, span(l, opts.tone ?? 'text', { bold: opts.bold })], [], width)
  })
}

/** Model text with a lead column; the height is estimated by wrapping it as plain text. */
export const md = (lead: Part[], leadWidth: number, text: string, width: number, dim = false): Row => ({
  t: 'md',
  lead: [...lead, span(' '.repeat(Math.max(0, leadWidth - partsWidth(lead))))],
  leadWidth,
  width,
  text,
  dim,
  estRows: wrapCells(text, Math.max(1, width - leadWidth)).length,
})

/** Every Button in the rows, in drawing order: the view's controls table. */
export const controls = (rows: readonly Row[]): Btn[] => {
  const out: Btn[] = []
  for (const r of rows) {
    const parts = r.t === 'line' ? r.parts : r.t === 'md' ? r.lead : []
    for (const p of parts) if (p.t === 'button') out.push(p)
  }
  return out
}

/** The text a row shows, buttons drawn as the terminal draws them: what specs read. */
export const rowText = (r: Row): string => {
  const parts = r.t === 'line' ? r.parts : r.t === 'md' ? r.lead : []
  const head = parts.map(p => (p.t === 'text' ? p.text : p.hotkey ? `${p.hotkey}: ${p.label}` : p.label)).join('')
  return r.t === 'md' ? head + r.text : head
}

/**
 * Makes every Button key unique across `rows` (one site): a repeat of a key gets `~2`, `~3`... (actions.ts grammar).
 * Returns new rows; the input is not changed.
 */
export const uniqueKeys = (rows: readonly Row[]): Row[] => {
  const seen = new Map<string, number>()
  const fix = (p: Part): Part => {
    if (p.t !== 'button') return p
    const n = (seen.get(p.key) ?? 0) + 1
    seen.set(p.key, n)
    return n === 1 ? p : { ...p, key: `${p.key}~${n}` }
  }
  return rows.map(r => (r.t === 'line' ? { ...r, parts: r.parts.map(fix) } : r.t === 'md' ? { ...r, lead: r.lead.map(fix) } : r))
}
