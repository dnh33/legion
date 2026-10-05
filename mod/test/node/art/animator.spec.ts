import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Mood } from '../../../types/index.d.ts'
import { AMBIENT_FPS, BLINK_MS, createAnimState, DORMANT_MS, MAX_FPS, poseKey, tick, type AnimInput, type AnimState } from '../../../src/art/animator.ts'
import { MOOD_DWELL_MS } from '../../../src/theme.ts'
import { FACE_FILTER } from '../../../src/art/compose.ts'
import { createStage, stepStage } from '../../../src/art/driver.ts'
import { AGENTS, loadArt } from './load.ts'

const art = loadArt('builder')
const idle = (lastEventAt = 0): AnimInput => ({ mood: 'idle', motion: true, lastEventAt })

/** Runs the scheduler as the lead would: call at nextAtMs, count frames. */
function run(mood: Mood, ms: number, opts: { motion?: boolean; agent?: string } = {}): { frames: number[]; gaps: number[]; last: number | null } {
  const a = opts.agent ? loadArt(opts.agent) : art
  let st = createAnimState(a, 0, mood, { seed: 7 })
  const frames: number[] = []
  const gaps: number[] = []
  let t = 0
  let last: number | null = 0
  for (let i = 0; i < 100000; i++) {
    const r = tick(a, st, t, { mood, motion: opts.motion ?? true, lastEventAt: 0 })
    st = r.state
    if (r.pose) frames.push(t)
    last = r.nextAtMs
    if (r.nextAtMs === null || r.nextAtMs > ms) break
    gaps.push(r.nextAtMs - t)
    t = r.nextAtMs
  }
  return { frames, gaps, last }
}

test('never faster than 12 frames a second, for every bust and mood', () => {
  for (const agent of AGENTS) for (const mood of ['idle', 'thinking', 'hacking', 'awaiting', 'error', 'victory', 'annoyed'] as Mood[]) {
    const r = run(mood, 20000, { agent })
    for (const g of r.gaps) assert.ok(g >= 1000 / MAX_FPS - 1e-9, `${agent} ${mood}: a ${g} ms gap`)
    for (let i = 1; i < r.frames.length; i++) assert.ok(r.frames[i]! - r.frames[i - 1]! >= 1000 / MAX_FPS - 1e-9, `${agent} ${mood}: frames ${r.frames[i - 1]} and ${r.frames[i]}`)
  }
})

test('idle ambient motion is sampled at 8 fps or less: wakes land on the 125 ms grid or on a scheduled event', () => {
  let st = createAnimState(art, 0, 'idle', { seed: 3 })
  st = { ...st, blinkAt: 1e12, verbNextAt: 1e12 }
  let t = 0
  for (let i = 0; i < 200; i++) {
    const r = tick(art, st, t, idle())
    st = r.state
    if (r.nextAtMs === null || r.nextAtMs > 50000) break
    const g = r.nextAtMs - t
    assert.ok(g >= 1000 / AMBIENT_FPS - 1e-6, `idle woke after ${g} ms`)
    assert.ok(Math.abs(g / (1000 / AMBIENT_FPS) - Math.round(g / (1000 / AMBIENT_FPS))) < 1e-6, `idle gap ${g} is off the 8 fps grid`)
    t = r.nextAtMs
  }
})

test('only a changed pose is a frame: a tick between changes returns null', () => {
  let st = createAnimState(art, 0, 'idle', { seed: 1 })
  const a = tick(art, st, 0, idle())
  assert.ok(a.pose)
  st = a.state
  const b = tick(art, st, 1, idle())
  assert.equal(b.pose, null)
  assert.equal(poseKey(a.pose!), b.state.lastKey)
})

test('a calm mood waits out the dwell (1.8 s); an urgent one switches at once', () => {
  let st = createAnimState(art, 0, 'idle', { seed: 1 })
  st = tick(art, st, 0, idle()).state
  const r = tick(art, st, 500, { mood: 'thinking', motion: true, lastEventAt: 500 })
  assert.equal(r.state.shown, 'idle')
  assert.ok(r.nextAtMs !== null && r.nextAtMs <= MOOD_DWELL_MS)
  const later = tick(art, r.state, MOOD_DWELL_MS, { mood: 'thinking', motion: true, lastEventAt: 500 })
  assert.equal(later.state.shown, 'thinking')
  const urgent = tick(art, st, 300, { mood: 'awaiting', motion: true, lastEventAt: 300 })
  assert.equal(urgent.state.shown, 'awaiting')
  assert.ok(urgent.pose)
  assert.deepEqual(urgent.pose!.face.ops, FACE_FILTER.awaiting)
  assert.deepEqual(urgent.pose!.face.from, FACE_FILTER.idle) // the colours cross-fade from idle (mascot.css .45 s)
})

test('Dormant: 60 s after the last event, one still frame, then nothing scheduled', () => {
  let st = createAnimState(art, 0, 'idle', { seed: 1 })
  let t = 0
  let r = tick(art, st, t, idle())
  while (r.nextAtMs !== null && r.nextAtMs < DORMANT_MS) { st = r.state; t = r.nextAtMs; r = tick(art, st, t, idle()) }
  assert.equal(r.nextAtMs === null || r.nextAtMs >= DORMANT_MS, true)
  const d = tick(art, r.state, DORMANT_MS, idle())
  assert.equal(d.nextAtMs, null)
  if (d.pose) { assert.equal(d.pose.bob, 0); assert.deepEqual(d.pose.shear, {}); assert.equal(d.pose.eyes, 'base') }
  const again = tick(art, d.state, DORMANT_MS + 5000, idle())
  assert.equal(again.pose, null)
  assert.equal(again.nextAtMs, null)
  // the next event wakes it
  const wake = tick(art, again.state, DORMANT_MS + 6000, idle(DORMANT_MS + 6000))
  assert.notEqual(wake.nextAtMs, null)
})

test('motion off: one static frame per mood, then nothing (no timer), and moods switch at once', () => {
  let st = createAnimState(art, 0, 'idle', { seed: 1 })
  const off = (mood: Mood, t: number) => tick(art, st, t, { mood, motion: false, lastEventAt: t })
  let r = off('idle', 0)
  assert.ok(r.pose)
  assert.equal(r.nextAtMs, null)
  st = r.state
  r = off('idle', 4000)
  assert.equal(r.pose, null)
  assert.equal(r.nextAtMs, null)
  st = r.state
  r = off('awaiting', 4100)
  assert.ok(r.pose)
  assert.equal(r.state.shown, 'awaiting')
  assert.equal(r.nextAtMs, null)
  assert.equal(r.pose.bob, 0)
})

test('the blink closes the eyes for 140 ms on the base set only', () => {
  let st = createAnimState(art, 0, 'idle', { seed: 9 })
  st = { ...st, blinkAt: 3000, verbNextAt: 1e12 }
  const at = tick(art, st, 3000, idle(3000))
  assert.equal(at.pose?.eyes ?? 'unchanged', 'blink')
  assert.ok(at.nextAtMs !== null && at.nextAtMs <= 3000 + Math.max(BLINK_MS, 1000 / MAX_FPS))
  const after = tick(art, at.state, 3000 + BLINK_MS, idle(3000))
  assert.notEqual(after.pose?.eyes, 'blink')
})

test('the same seed gives the same frames (pure)', () => {
  const a = run('idle', 30000)
  const b = run('idle', 30000)
  assert.deepEqual(a.frames, b.frames)
})

test('cost while on: every bust and mood draws at most about 4 frames a second while awake, and nothing once Dormant', () => {
  let worst = { frames: 0, ms: 0, what: '' }
  let worstMs = { ms: 0, what: '' }
  for (const mood of ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'] as Mood[]) {
    for (const agent of AGENTS) {
      const rt = createStage(loadArt(agent), 0, mood, { panel: 0x12151a, seed: 2 })
      let t = 0
      let frames = 0
      const t0 = performance.now()
      for (;;) {
        const r = stepStage(rt, t, { mood, motion: true, lastEventAt: 0 })
        if (r.cells) frames++
        if (r.nextAtMs === null) break
        t = r.nextAtMs
      }
      const ms = performance.now() - t0
      assert.ok(t <= DORMANT_MS + 1000, `${agent} ${mood} still awake at ${t}`)
      assert.ok(frames <= 260, `${agent} ${mood}: ${frames} frames in the awake minute`)
      if (frames > worst.frames) worst = { frames, ms, what: `${agent} ${mood}` }
      if (ms > worstMs.ms) worstMs = { ms, what: `${agent} ${mood}` }
    }
  }
  console.log(`awake minute, worst frames: ${worst.frames} (${worst.what}); worst CPU (tick + compose + pack): ${worstMs.ms.toFixed(1)} ms (${worstMs.what})`)
})

export type { AnimState }
