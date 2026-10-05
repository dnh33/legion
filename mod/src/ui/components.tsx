/**
 * Rows to elements: the one place the Legion UI makes the surface's elements. Pure drawing helpers: each takes the
 * element table `$.ui.resolve(e)` answered, the palette (theme.ts) and rows, never `$`, so they run under any hook.
 *
 * A `line` row is spans and plain Buttons side by side, already exactly as wide as its box (model.ts), so the
 * terminal neither wraps nor truncates it. An `md` row is a lead column beside a Markdown block the surface lays out.
 */
import type { ElementTable, RenderElement } from 'claude-code'
import type { Palette } from '../theme.ts'
import { MARK } from '../theme.ts'
import type { Part, Row, SpanTone } from './model.ts'
import type { PaneLayout } from './views/pane.ts'

/** The elements every surface has that the Legion UI draws with. */
export type El = Pick<ElementTable, 'Box' | 'Text' | 'Button' | 'Markdown'>

/** A colour for a tone; `undefined` keeps the terminal's own (text) or draws dim (muted), which adapts to any theme. */
export const toneColor = (pal: Palette, tone: SpanTone | undefined): string | undefined => {
  switch (tone) {
    case 'accent': return pal.accentText
    case 'warn': return pal.warn
    case 'danger': return pal.danger
    case 'line': return pal.lineStrong
    default: return undefined
  }
}

/** Markdown takes at most 10000 characters, tab and newline its only control characters (MarkdownProps.text). */
export const MARKDOWN_MAX = 10000
export const markdownSafe = (text: string): string => {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  // keep the end: a streaming reply's newest words are the ones to see
  return clean.length > MARKDOWN_MAX ? `${MARK.ellipsis}${clean.slice(clean.length - (MARKDOWN_MAX - 1))}` : clean
}

/**
 * A Legion Button's own `onPress` does nothing: the press raises `ui.press` with the Button's key, and the lead's hook
 * acts on it (actions.ts). ButtonProps requires the handler.
 */
const pressedElsewhere = (): void => {}

export const PartEl = (el: El, pal: Palette, p: Part): RenderElement => {
  const { Text, Button } = el
  if (p.t === 'button') {
    return <Button key={p.key} label={p.label} plain hotkey={p.hotkey} dimColor={p.dim} onPress={pressedElsewhere} />
  }
  return (
    <Text color={toneColor(pal, p.tone)} dimColor={p.tone === 'muted' ? true : undefined} bold={p.bold ? true : undefined} strikethrough={p.strike ? true : undefined}>
      {p.text}
    </Text>
  )
}

export const Line = (el: El, pal: Palette, parts: readonly Part[]): RenderElement => {
  const { Box } = el
  return <Box flexDirection="row">{parts.map(p => PartEl(el, pal, p))}</Box>
}

export const Rule = (el: El, pal: Palette, width: number): RenderElement => {
  const { Text } = el
  return <Text color={pal.lineStrong}>{MARK.rule.repeat(Math.max(0, width))}</Text>
}

export const RowEl = (el: El, pal: Palette, r: Row): RenderElement => {
  const { Box, Text, Markdown } = el
  if (r.t === 'gap') return <Text> </Text>
  if (r.t === 'line') return Line(el, pal, r.parts)
  return (
    <Box flexDirection="row" width={r.width}>
      <Box width={r.leadWidth} flexShrink={0}>{Line(el, pal, r.lead)}</Box>
      <Box flexGrow={1} flexDirection="column"><Markdown text={markdownSafe(r.text)} dimColor={r.dim ? true : undefined} /></Box>
    </Box>
  )
}

export const Rows = (el: El, pal: Palette, rows: readonly Row[]): RenderElement => {
  const { Box } = el
  return <Box flexDirection="column">{rows.map(r => RowEl(el, pal, r))}</Box>
}

/**
 * The pane: title and rule, then the rail beside the view when there is one. The rail's separator runs as far as the
 * view's estimated height, so the column reads as one even when the thread is long.
 */
export const Pane = (el: El, pal: Palette, layout: PaneLayout): RenderElement => {
  const { Box, Text } = el
  if (layout.railWidth === 0) return Rows(el, pal, [...layout.title, ...layout.main])
  const mainHeight = layout.main.reduce((n, r) => n + (r.t === 'md' ? Math.max(1, r.estRows) : 1), 0)
  const pad = Math.max(0, mainHeight - layout.rail.length)
  const blank = ' '.repeat(layout.railWidth - 1)
  return (
    <Box flexDirection="column">
      {layout.title.map(r => RowEl(el, pal, r))}
      <Box flexDirection="row">
        <Box flexDirection="column" width={layout.railWidth} flexShrink={0}>
          {layout.rail.map(r => RowEl(el, pal, r))}
          {Array.from({ length: pad }, () => <Box flexDirection="row"><Text>{blank}</Text><Text color={pal.lineStrong}>{MARK.bar}</Text></Box>)}
        </Box>
        <Box flexDirection="column" flexGrow={1}>{layout.main.map(r => RowEl(el, pal, r))}</Box>
      </Box>
    </Box>
  )
}
