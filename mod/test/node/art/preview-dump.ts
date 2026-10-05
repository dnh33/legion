/**
 * Review tool, not a spec: runs the real runtime (animator, compose, pack) and writes the packed cells as JSON, so
 * scripts/build-mod-frames.py --review can draw what the terminal will draw. Usage:
 *   node --experimental-transform-types --no-warnings mod/test/node/art/preview-dump.ts <out.json>
 */
import { writeFileSync } from 'node:fs'
import type { Mood } from '../../../types/index.d.ts'
import { createStage, musterCells, stepStage, stillStageCells } from '../../../src/art/driver.ts'
import { AGENTS, loadArt } from './load.ts'

const MOODS: Mood[] = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed']
const PANELS = { dark: 0x12151a, light: 0xffffff }
const out: Record<string, unknown> = {}
for (const agent of AGENTS) {
  const art = loadArt(agent)
  const entry: Record<string, unknown> = { cols: art.stage.cols, rows: art.stage.rows, mcols: art.muster.cols, mrows: art.muster.rows }
  for (const [pn, panel] of Object.entries(PANELS)) {
    for (const outline of [false, true]) {
      const tag = `${pn}${outline ? '' : '-flat'}`
      entry[`stage-${tag}`] = Object.fromEntries(MOODS.map(m => [m, stillStageCells(art, m, { panel, outline })]))
      entry[`muster-${tag}`] = Object.fromEntries(MOODS.map(m => [m, musterCells(art, m, { panel, outline })]))
    }
    entry[`stage-term-${pn}`] = Object.fromEntries(MOODS.map(m => [m, stillStageCells(art, m, { panel, outline: true, transparent: 'terminal' })]))
    // the first frames of an idle stage, as the lead would blit them
    const rt = createStage(art, 0, 'idle', { panel, outline: true, seed: 1 })
    const frames: { t: number; cells: string }[] = []
    let t = 0
    for (let i = 0; i < 400 && frames.length < 8 && t < 20000; i++) {
      const r = stepStage(rt, t, { mood: 'idle', motion: true, lastEventAt: 0 })
      if (r.cells) frames.push({ t: Math.round(t), cells: r.cells })
      if (r.nextAtMs === null) break
      t = r.nextAtMs
    }
    entry[`idle-${pn}`] = frames
  }
  out[agent] = entry
}
writeFileSync(process.argv[2] ?? 'preview.json', JSON.stringify(out))
console.log('wrote', process.argv[2])
