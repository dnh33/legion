import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyFilter, compose, FACE_FILTER, outlineOf, restPose, type FilterOp, type Frame, type Pose } from '../../../src/art/compose.ts'
import type { Art, ArtSize } from '../../../src/art/art.ts'
import { stillPose } from '../../../src/art/animator.ts'
import { AGENTS, loadArt } from './load.ts'

type Truth = { inputs: number[][]; outputs: Record<string, number[][]> }
const truth = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/filter-truth.json', import.meta.url).href), 'utf8')) as Truth
const OPS: Record<string, readonly FilterOp[]> = {
  awaiting: FACE_FILTER.awaiting, error: FACE_FILTER.error, sleeping: FACE_FILTER.sleeping, listening: FACE_FILTER.listening, breathe: [['brightness', 1.35]],
}

test('face recolour matches Edge drawing the desktop filters (mascot.css) within 1 of 255', () => {
  for (const [name, ops] of Object.entries(OPS)) {
    truth.inputs.forEach((c, i) => {
      const got = applyFilter(ops, c[0]!, c[1]!, c[2]!).map(v => Math.round(v * 255))
      const want = truth.outputs[name]![i]!
      got.forEach((v, k) => assert.ok(Math.abs(v - want[k]!) <= 1, `${name} ${c.join()} -> ${got.join()} want ${want.join()}`))
    })
  }
})

const art: Art = loadArt('builder')
const S: ArtSize = art.stage
const px = (f: Frame, x: number, y: number): string => [...f.rgba.slice((y * f.w + x) * 4, (y * f.w + x) * 4 + 4)].join()

test('compose is deterministic: the same pose gives the same bytes, for every bust', () => {
  const p = stillPose(art, 'awaiting')
  const a = compose(S, p)
  assert.deepEqual(a.rgba, compose(S, p).rgba)
  assert.equal(a.w, S.cols)
  assert.equal(a.h, S.rows * 2)
  for (const agent of AGENTS) {
    const x = loadArt(agent)
    assert.deepEqual(compose(x.stage, stillPose(x, 'idle')).rgba, compose(x.stage, stillPose(x, 'idle')).rgba, agent)
  }
})

test('bob lifts the whole bust by exactly one pixel row (the margin supplies the row below)', () => {
  const p: Pose = { ...restPose(), outline: false }
  const a = compose(S, p)
  const b = compose(S, { ...p, bob: 1 })
  for (let y = 0; y < a.h - 1; y++) for (let x = 0; x < a.w; x++) assert.equal(px(b, x, y), px(a, x, y + 1), `${x},${y}`)
})

test('a sway moves only the far rows of that hang, by one pixel', () => {
  // most busts' hangs hang below the head-and-shoulders crop; the Herald's ribbons are inside it
  const H = loadArt('herald').stage
  const hang = H.planes.find(p => p.kind === 'hang' && p.h >= 4 && p.pivot)!
  assert.ok(hang, 'no hang to sway')
  const base: Pose = { ...restPose(), outline: false }
  const a = compose(H, base)
  const b = compose(H, { ...base, shear: { [hang.id]: 1 } })
  assert.notDeepEqual(a.rgba, b.rgba)
  const py = hang.pivot![1]
  for (let y = 0; y < a.h; y++) {
    const cy = y + H.margin
    if (Math.abs(cy + 0.5 - py) / hang.reach < 0.5) for (let x = 0; x < a.w; x++) assert.equal(px(a, x, y), px(b, x, y), `row ${y} moved`)
  }
})

test('mood colours touch the face only: every changed pixel lies in the face plane', () => {
  const idle = stillPose(art, 'idle')
  const a = compose(S, idle)
  const b = compose(S, { ...idle, face: { ops: FACE_FILTER.error } })
  const face = S.planes.find(p => p.id === 'face:base')!
  let changed = 0
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    if (px(a, x, y) === px(b, x, y)) continue
    changed++
    const cx = x + S.margin
    const cy = y + S.margin
    assert.ok(cx >= face.x && cx < face.x + face.w && cy >= face.y && cy < face.y + face.h, `pixel ${x},${y} outside the face changed`)
  }
  assert.ok(changed > 3, `only ${changed} face pixels changed`)
})

test('each mood shows its eye set (mascot.css): hacking narrow + code, victory happy, error wince, sleeping shut, annoyed angry', () => {
  const want = { idle: 'base', hacking: 'hacking', victory: 'happy', error: 'wince', sleeping: 'shut', annoyed: 'angry' } as const
  for (const [m, e] of Object.entries(want)) assert.equal(stillPose(art, m as keyof typeof want).eyes, e)
  for (const e of ['base', 'narrow', 'hacking', 'happy', 'wince', 'shut', 'angry', 'blink']) assert.ok(S.planes.some(p => p.id === `face:${e}`), e)
})

test('outline: a darker shade of the same colour, never pure black, only on uncovered pixels', () => {
  for (const c of [[0, 0, 0], [255, 0, 0], [124, 255, 178], [10, 10, 12]]) {
    const o = outlineOf(c[0]!, c[1]!, c[2]!)
    assert.ok(Math.max(...o) >= 17, `${c.join()} -> ${o.join()}`)
    if (Math.max(...c) > 60) assert.ok(o.every((v, i) => v <= c[i]!), `${c.join()} -> ${o.join()} is not darker`)
  }
  const flat = compose(S, { ...restPose(), outline: false })
  const lined = compose(S, restPose())
  let added = 0
  for (let i = 0; i < flat.rgba.length; i += 4) {
    if (flat.rgba[i + 3]! >= 128) assert.deepEqual([...lined.rgba.slice(i, i + 4)], [...flat.rgba.slice(i, i + 4)])
    else if (lined.rgba[i + 3] === 255) added++
  }
  assert.ok(added > 10, `only ${added} outline pixels`)
})
