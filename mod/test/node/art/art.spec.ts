import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Mood } from '../../../types/index.d.ts'
import { decodeArt } from '../../../src/art/art.ts'
import { musterCells, stillStageCells } from '../../../src/art/driver.ts'
import { colorPairs } from '../../../src/art/pack.ts'
import { DARK, LIGHT } from '../../../src/theme.ts'
import { hexColor } from '../../../src/art/pack.ts'
import { AGENTS, ART_DIR, artFiles, loadArt, rawArt } from './load.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url).href)
const MOODS: Mood[] = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed']

test('one art file per bust, each under 256 KiB, under 40 files in all', () => {
  const files = artFiles()
  assert.deepEqual(files.slice().sort(), AGENTS.map(a => `${a}.json`).sort())
  assert.ok(files.length < 40)
  for (const f of files) assert.ok(statSync(`${ART_DIR}${f}`).size < 256 * 1024, f)
})

test('every art file was made from the painted layers as they are now (source hash), so a repaint cannot ship stale frames', () => {
  for (const agent of AGENTS) {
    const raw = rawArt(agent) as { source: string; sourceSha256: string; agent: string }
    assert.equal(raw.agent, agent)
    const bytes = readFileSync(`${REPO}${raw.source}`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), raw.sourceSha256, `${agent}: re-run python scripts/build-mod-frames.py`)
  }
})

test('decodeArt reads every file: sizes, a posterised palette (at most 24 colours), every face plane', () => {
  for (const agent of AGENTS) {
    const art = loadArt(agent)
    assert.deepEqual([art.stage.cols, art.stage.rows, art.muster.cols, art.muster.rows], [32, 18, 10, 6], agent)
    for (const s of [art.stage, art.muster]) {
      assert.ok(s.palette.length / 3 <= 24, `${agent}: ${s.palette.length / 3} colours`)
      for (const e of ['base', 'narrow', 'hacking', 'happy', 'wince', 'shut', 'angry', 'blink']) assert.ok(s.planes.some(p => p.id === `face:${e}`), `${agent} face:${e}`)
      for (const p of s.planes) for (const a of p.alpha) assert.ok(a === 0 || a === 255, `${agent} ${p.id}: soft alpha ${a}`)
    }
  }
})

test('decodeArt refuses a broken file with a plain message', () => {
  assert.throws(() => decodeArt(null), /version 1/)
  assert.throws(() => decodeArt({ v: 1, agent: 'x', sizes: {} }), /stage is missing/)
  const raw = structuredClone(rawArt('scout')) as { sizes: { stage: { planes: { px: string }[] } } }
  raw.sizes.stage.planes[0]!.px = 'AAAA'
  assert.throws(() => decodeArt(raw), /bytes for/)
})

test('colour pairs: every bust and mood far under Raster 1024, and so is the stage plus a full muster row of 12', () => {
  let worst = 0
  for (const theme of [DARK, LIGHT]) {
    const panel = hexColor(theme.surface)
    for (const mood of MOODS) {
      for (const agent of AGENTS) {
        const n = colorPairs(stillStageCells(loadArt(agent), mood, { panel })).size
        assert.ok(n <= 1024, `${agent} ${mood}: ${n}`)
        worst = Math.max(worst, n)
      }
      // worst case on one screen: a stage and twelve muster tiles, all in this mood
      for (const stageAgent of AGENTS) {
        const all = colorPairs(stillStageCells(loadArt(stageAgent), mood, { panel }))
        for (const a of AGENTS.filter(x => x !== stageAgent).slice(0, 12)) colorPairs(musterCells(loadArt(a), mood, { panel }), all)
        assert.ok(all.size <= 1024, `${stageAgent} stage + muster, ${mood}: ${all.size}`)
      }
    }
  }
  assert.ok(worst > 0)
})
