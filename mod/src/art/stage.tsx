/**
 * The 2D Order's elements: the stage (the agent you are looking at) and a muster tile, each one Raster sized exactly,
 * or the glyph and mood word where Raster does not exist (every surface but the terminal) or no art is loaded.
 * Drawing only: no `$`, no state writes. The cells come from driver.ts.
 */
import type { ElementTable, RenderElement } from 'claude-code'
import type { Mood } from '../../types/index.d.ts'
import type { Palette } from '../theme.ts'
import type { Art } from './art.ts'
import { fallbackModel, type FallbackTone } from './stage-model.ts'

/** Box and Text are on every surface; Raster only on the terminal (pass the table `$.ui.resolve(e)` answered). */
export type StageEl = Pick<ElementTable, 'Box' | 'Text'> & { Raster?: ElementTable<'terminal'>['Raster'] }

export type StageFallback = { glyph: string; mood: Mood; pal: Palette }

const toneColor = (pal: Palette, t: FallbackTone): string | undefined => (t === 'accent' ? pal.accentText : t === 'warn' ? pal.warn : t === 'danger' ? pal.danger : undefined)

function fallback(el: StageEl, key: string, cols: number, rows: number, f: StageFallback): RenderElement {
  const { Box, Text } = el
  const m = fallbackModel(f.glyph, f.mood, cols, rows)
  return (
    <Box key={key} width={cols} height={rows} flexDirection="column" alignItems="center" justifyContent="center">
      <Text bold>{m.glyph}</Text>
      {m.showWord ? <Text color={toneColor(f.pal, m.tone)} dimColor={m.tone === 'muted' ? true : undefined}>{m.word}</Text> : null}
    </Box>
  )
}

/**
 * The stage: one Raster keyed `stage` (the key `$.ui.blit` names), exactly `cols` x `rows`. `cells` must be packed for
 * that size (driver.ts); without art, cells or Raster it is the glyph and mood word in a box of the same size.
 */
export function renderStage(el: StageEl, art: Art | null, cells: string | null, cols: number, rows: number, fb: StageFallback): RenderElement {
  const { Raster } = el
  if (!Raster || !art || !cells || art.stage.cols !== cols || art.stage.rows !== rows) return fallback(el, 'stage', cols, rows, fb)
  return <Raster key="stage" columns={cols} rows={rows} cells={cells} />
}

/** One muster tile (a still per mood), keyed `muster-<agent>` so several can share a row. */
export function renderMusterTile(el: StageEl, art: Art | null, cells: string | null, agent: string, fb: StageFallback): RenderElement {
  const { Raster } = el
  const cols = art ? art.muster.cols : 10
  const rows = art ? art.muster.rows : 6
  if (!Raster || !art || !cells) return fallback(el, `muster-${agent}`, cols, rows, fb)
  return <Raster key={`muster-${agent}`} columns={cols} rows={rows} cells={cells} />
}
