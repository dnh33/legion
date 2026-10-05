/**
 * When the 2D Order draws a new frame, and which pose it shows. Pure: time comes in as `now`, randomness from a seeded
 * generator kept in the state, and the result says when to look again. The cost model (plan section 5):
 *
 * - Only a changed pose is a frame. Between changes the lead schedules one `$.clock.after` at `nextAtMs` and draws nothing.
 * - Never above 12 frames a second; ambient motion (the bob, the hang sway) is sampled at 8.
 * - Moods dwell MOOD_DWELL_MS before a calm mood replaces them; URGENT_MOODS switch at once (theme.ts, desktop rule).
 * - 60 s after the last event the bust goes Dormant: one still frame, then `nextAtMs: null` until the next event.
 * - `motion: false`: one static frame per mood, then nothing.
 *
 * At this size the desktop's motions are a fraction of a pixel (the bob is 1.4 % of the height, about half a pixel), so
 * each becomes a deliberate 1 px step at the moment its eased curve passes the half-way mark. The desktop halo turns once
 * in 110 s; a 30 px ring cannot rotate legibly, so the halo holds still and breathes in brightness while thinking instead
 * of turning faster.
 */
import type { Mood } from '../../types/index.d.ts'
import { MOOD_DWELL_MS, URGENT_MOODS } from '../theme.ts'
import type { Art, ArtPlane, EyeSet, Verb, VerbStep } from './art.ts'
import { FACE_EYES, FACE_FILTER, NO_TINT, type FilterOp, type Pose, type Tint } from './compose.ts'

export const MAX_FPS = 12
export const AMBIENT_FPS = 8
export const DORMANT_MS = 60_000
/** mascot.css `.mx-face { transition: filter .45s ease }`. */
export const FADE_MS = 450
export const BLINK_MS = 140
const FAST_STEP = 1000 / MAX_FPS
const SLOW_STEP = 1000 / AMBIENT_FPS
/** How far ahead the scheduler looks for the next change before it settles for a cheap re-check. */
const HORIZON_MS = 4000

export type AnimInput = {
  /** The agent's mood as the engine keeps it (engine/mood.ts already applies the dwell; the animator applies it again). */
  mood: Mood
  /** settings.motion. */
  motion: boolean
  /** When the last event for this agent happened (a tool call, a reply, a card): the Dormant clock counts from here. */
  lastEventAt: number
}

export type AnimState = {
  shown: Mood
  shownSince: number
  /** The mood faded from, while the colours cross-fade. */
  prev: Mood | null
  fadeAt: number
  /** A calm mood waiting for the dwell to pass. */
  pending: Mood | null
  lastKey: string | null
  blinkAt: number
  verb: { i: number; at: number; len: number } | null
  verbNextAt: number
  verbLast: number[]
  rng: number
  outline: boolean
}

export type Tick = {
  state: AnimState
  /** The pose to draw, or null when the frame is unchanged. */
  pose: Pose | null
  /** When to call `tick` again; null: not until the next event or mood change. */
  nextAtMs: number | null
}

// ---- seeded randomness (mulberry32) ----
function rand(st: AnimState): number {
  let t = (st.rng = (st.rng + 0x6d2b79f5) | 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
export const seedOf = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h | 0
}

const smooth = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))
const easeOut = (u: number): number => 1 - (1 - Math.min(1, Math.max(0, u))) ** 2
const q = (v: number, step: number): number => Math.round(v / step) * step
const mod = (a: number, n: number): number => ((a % n) + n) % n
/** 0 at the ends of the period, 1 in the middle, eased (an ease-in-out 0% / 50% / 100% keyframe pair). */
const breath = (t: number, period: number): number => { const p = mod(t, period) / period; return p < 0.5 ? smooth(p * 2) : smooth((1 - p) * 2) }

export function createAnimState(art: Art, now: number, mood: Mood, opts: { seed?: number; outline?: boolean } = {}): AnimState {
  const st: AnimState = {
    shown: mood, shownSince: now, prev: null, fadeAt: -Infinity, pending: null, lastKey: null,
    blinkAt: 0, verb: null, verbNextAt: 0, verbLast: art.persona.verbs.map(() => -Infinity),
    rng: opts.seed ?? seedOf(art.agent), outline: opts.outline ?? true,
  }
  st.blinkAt = now + 2200 + rand(st) * 4200
  st.verbNextAt = now + verbGap(art, st)
  return st
}

const verbGap = (art: Art, st: AnimState): number => (10000 + rand(st) * 12000) * art.persona.tempo

// ---- the pose at a time ----

const HALO_BY_MOOD = (m: Mood): Tint => (m === 'sleeping' ? { ops: [], alpha: 0.35 } : m === 'error' ? { ops: [['saturate', 0.4], ['brightness', 0.8]] } : NO_TINT)
const PLUME_BY_MOOD = (art: Art, m: Mood): Tint => (m === 'sleeping' && art.persona.plumeLight ? { ops: [['brightness', 0.55], ['saturate', 0.6]] } : NO_TINT)
/** mascot.css mx-flare / mxs-flare-soft: the halo starts at --flare and settles at --flare-end. */
const flare = (art: Art): [number, number] => {
  const f = art.persona.haloFlare
  return f ? [f, 1 + (f - 1) / 2] : [2.2, 1.25]
}

function hangs(art: Art): ArtPlane[] { return art.stage.planes.filter(p => p.kind === 'hang') }

function fade(from: Tint, to: Tint, mix: number): Tint {
  if (mix >= 1) return to
  const out: Tint = { ops: to.ops, from: from.ops, mix }
  const fa = from.alpha ?? 1; const ta = to.alpha ?? 1
  if (fa !== 1 || ta !== 1) out.alpha = fa + (ta - fa) * mix
  return out
}

const withGain = (t: Tint, gain: number): Tint => (gain === 1 ? t : { ...t, gain: (t.gain ?? 1) * gain })

/** The pose of the shown mood at time t. `awake` false: the still pose (Dormant, or motion off). */
export function poseAt(art: Art, st: AnimState, t: number, awake: boolean): Pose {
  const m = st.shown
  const since = t - st.shownSince
  let face: Tint = { ops: FACE_FILTER[m] }
  let halo = HALO_BY_MOOD(m)
  let plume = PLUME_BY_MOOD(art, m)
  let eyes: EyeSet = FACE_EYES[m]
  let bob = 0; let rigDx = 0; let rigDy = m === 'sleeping' ? 1 : 0
  const shear: Record<string, number> = {}
  const [flareFrom, flareEnd] = flare(art)
  if (m === 'victory') halo = withGain(halo, awake && since < 1400 ? q(flareFrom + (flareEnd - flareFrom) * easeOut(since / 1400), 0.05) : flareEnd)
  if (awake) {
    const fading = st.prev !== null && t - st.fadeAt < FADE_MS
    if (fading && st.prev) {
      const mix = q(smooth((t - st.fadeAt) / FADE_MS), 1 / 6)
      face = fade({ ops: FACE_FILTER[st.prev] }, face, mix)
      halo = fade(HALO_BY_MOOD(st.prev), halo, mix)
      plume = fade(PLUME_BY_MOOD(art, st.prev), plume, mix)
    }
    if (m !== 'thinking' && m !== 'sleeping') {
      // mx-bob: 7 s (hacking 4.6 s), up at 50 %, eased; the 1 px lift holds while the curve is past half way
      const period = m === 'hacking' ? 4600 : 7000
      const p = mod(t, period) / period
      bob = p >= 0.25 && p < 0.75 ? 1 : 0
    }
    if (m === 'thinking') {
      // mx-breathe 2.6 s, brightness 1 to 1.35, in five steps; the halo breathes in three (it stands in for the faster turn)
      face = withGain(face, 1 + q(0.35 * breath(t, 2600), 0.0875))
      halo = withGain(halo, 1 + q(0.15 * breath(t, 5200), 0.075))
    }
    if (m === 'awaiting') face = withGain(face, 1 + q(0.14 * breath(t, 1600), 0.07)) // the 1.6 s rhythm of mx-bang, three steps
    if (m === 'error') {
      // mx-flick 1.2 s steps(1): 8-12 % at .35, 55-58 % at .6; each window held for at least one 12 fps frame
      const p = mod(since, 1200) / 1200
      const a = p >= 0.08 && p < 0.16 ? 0.35 : p >= 0.55 && p < 0.62 ? 0.6 : 1
      if (a !== 1) face = { ...face, alpha: a }
    }
    if (m === 'annoyed' && since < 1000) {
      // mx-shake .5 s x 2: -4deg at 25 %, +4deg at 75 %
      const p = mod(since, 500) / 500
      rigDx = p >= 0.125 && p < 0.375 ? -1 : p >= 0.625 && p < 0.875 ? 1 : 0
    }
    const verbOn = st.verb !== null && t >= st.verb.at && t < st.verb.at + st.verb.len
    if ((m === 'idle' || m === 'hacking') && !verbOn) {
      // mx-sway (mascot.css .mx-hang: -1.4 to 1.6 deg, 5.2 s, hacking 2.6 s). The desktop staggers every hang; here they share
      // one phase, so the hangs are one moving thing next to the bob (art direction: at most two things move) and an idle
      // stage draws about one frame a second instead of four
      const period = m === 'hacking' ? 2600 : 5200
      const p = mod(t, period) / period
      const deg = p < 0.5 ? -1.4 + 3 * smooth(p * 2) : 1.6 - 3 * smooth((p - 0.5) * 2)
      const s = deg > 1 ? 1 : deg < -0.8 ? -1 : 0
      if (s) for (const h of hangs(art)) shear[h.id] = s
    }
    if ((eyes === 'base') && t >= st.blinkAt && t < st.blinkAt + BLINK_MS) eyes = 'blink'
    if (verbOn && st.verb && m === 'idle') {
      const v = art.persona.verbs[st.verb.i]
      if (v) {
        const fx = verbEffects(art, v, t - st.verb.at)
        rigDy += fx.rigDy
        if (fx.faceGain !== 1) face = withGain(face, fx.faceGain)
        if (fx.plumeGain !== 1) plume = withGain(plume, fx.plumeGain)
        if (fx.haloGain !== 1) halo = withGain(halo, fx.haloGain)
        if (fx.eyes) eyes = fx.eyes
        Object.assign(shear, fx.shear)
      }
    }
  }
  return { bob, rigDx, rigDy, shear, eyes, face, halo, plume, outline: st.outline }
}

// ---- persona verbs (verbs.js primitives, as pixel effects) ----

const STEP_DUR: Record<string, number> = { lean: 1800, nod: 1400, scan: 2400, flutter: 1000, flare: 900, wave: 900 }
const EYE_SETS: ReadonlySet<string> = new Set(['narrow', 'happy', 'wince', 'shut', 'angry'])

/** verbs.js osc(): 0, +d, -.7d, then each cycle at .55 of the last, back to 0, keyframes evenly spaced. */
function osc(deg: number, cycles: number, u: number): number {
  const ks = [0]
  let amp = 1
  for (let i = 0; i < cycles; i++) { ks.push(deg * amp, -deg * amp * 0.7); amp *= 0.55 }
  ks.push(0)
  const x = Math.min(1, Math.max(0, u)) * (ks.length - 1)
  const i = Math.min(ks.length - 2, Math.floor(x))
  return ks[i]! + (ks[i + 1]! - ks[i]!) * smooth(x - i)
}
const oscShear = (deg: number, cycles: number, u: number): number => {
  const a = osc(deg, cycles, u)
  return Math.abs(a) >= Math.abs(deg) * 0.5 ? Math.sign(a) : 0
}

function targetIds(art: Art, target: string | string[] | undefined, fallback: string): string[] {
  const t = target ?? fallback
  if (Array.isArray(t)) return t.flatMap(x => targetIds(art, x, fallback))
  const planes = art.stage.planes
  if (t === 'halo') return planes.filter(p => p.kind === 'halo-back' || p.kind === 'halo-front').map(p => p.id)
  if (t === 'token') return planes.filter(p => p.kind === 'token').map(p => p.id)
  if (t === 'hangs') return hangsByX(art).map(p => p.id)
  const m = /^(hang|token)-(\d+)\.\.(\d+)$/.exec(t)
  if (m) {
    const out: string[] = []
    for (let i = Number(m[2]); i <= Number(m[3]); i++) if (planes.some(p => p.id === `L-${m[1]}-${i}`)) out.push(`L-${m[1]}-${i}`)
    return out
  }
  return planes.some(p => p.id === `L-${t}`) ? [`L-${t}`] : []
}
const hangsByX = (art: Art): ArtPlane[] => hangs(art).slice().sort((a, b) => (a.pivot?.[0] ?? 0) - (b.pivot?.[0] ?? 0))

/** How long a verb plays, in ms (verbs.js play(): steps start at `at`; a wave runs its stagger). */
export function verbLength(art: Art, v: Verb): number {
  const T = art.persona.tempo
  let len = 0
  for (const s of v.steps) {
    const at = Math.round((s.at ?? 0) * T)
    const dur = Math.round((s.dur ?? STEP_DUR[s.p] ?? 1000) * T)
    let extra = 0
    if (s.p === 'wave') extra = Math.max(0, targetIds(art, s.targets, 'hangs').length - 1) * Math.round((s.stagger ?? 180) * T)
    len = Math.max(len, at + dur + extra)
  }
  return len
}

type VerbFx = { rigDy: number; faceGain: number; plumeGain: number; haloGain: number; eyes: EyeSet | null; shear: Record<string, number> }

export function verbEffects(art: Art, v: Verb, dt: number): VerbFx {
  const T = art.persona.tempo
  const fx: VerbFx = { rigDy: 0, faceGain: 1, plumeGain: 1, haloGain: 1, eyes: null, shear: {} }
  for (const s of v.steps as VerbStep[]) {
    const at = Math.round((s.at ?? 0) * T)
    const dur = Math.round((s.dur ?? STEP_DUR[s.p] ?? 1000) * T)
    const u = (dt - at) / dur
    if (s.p === 'wave') {
      const ids = targetIds(art, s.targets, 'hangs')
      const order = s.order === 'rtl' ? ids.slice().reverse() : ids
      const gap = Math.round((s.stagger ?? 180) * T)
      order.forEach((id, i) => {
        const ui = (dt - at - i * gap) / dur
        if (ui >= 0 && ui < 1) { const sh = oscShear(typeof s.deg === 'number' ? s.deg : 4, s.cycles ?? 1, ui); if (sh) fx.shear[id] = sh }
      })
      continue
    }
    if (u < 0 || u >= 1) continue
    if (s.p === 'nod') {
      const times = s.times ?? 1
      const f = mod(u * times, 1)
      if (f >= 0.2 && f < 0.8) fx.rigDy = 1
    } else if (s.p === 'flare') {
      const peak = s.to ?? s.peak ?? 1.2
      const g = q(u < 0.4 ? 1 + (peak - 1) * (u / 0.4) : peak + (1 - peak) * ((u - 0.4) / 0.6), 0.05)
      const tgt = typeof s.target === 'string' ? s.target : 'face'
      if (tgt === 'plume') fx.plumeGain = g
      else fx.faceGain = g
    } else if (s.p === 'flutter') {
      const tgt = typeof s.target === 'string' ? s.target : 'plume'
      if (tgt === 'halo' && s.keep) {
        fx.haloGain = 1 + q(0.15 * Math.sin(Math.PI * u), 0.05) // a halo cannot turn one notch at this size: it glints
      } else {
        const sh = oscShear(typeof s.deg === 'number' ? s.deg : 3, s.cycles ?? 1, u)
        if (sh) for (const id of targetIds(art, s.target, 'plume')) fx.shear[id] = sh
      }
    } else if (s.p === 'scan') {
      if (s.eyes && EYE_SETS.has(s.eyes)) fx.eyes = s.eyes as EyeSet
    }
    // lean: a 1.5 degree lean of the head is a fifth of a pixel here, so it is left out
  }
  return fx
}

// ---- the scheduler ----

export const poseKey = (p: Pose): string => JSON.stringify(p)

/** One step. Never mutates `prev`; returns the next state, the pose to draw (null: unchanged) and when to call again. */
export function tick(art: Art, prev: AnimState, now: number, input: AnimInput): Tick {
  const st: AnimState = { ...prev, verbLast: prev.verbLast.slice() }
  // 1. mood: urgent moods and motion off switch at once, calm moods after the dwell
  if (input.mood === st.shown) st.pending = null
  else if (!input.motion || URGENT_MOODS.has(input.mood) || now - st.shownSince >= MOOD_DWELL_MS) {
    st.prev = st.shown; st.fadeAt = now; st.shown = input.mood; st.shownSince = now; st.pending = null; st.verb = null
    if (input.mood === 'idle') st.verbNextAt = now + verbGap(art, st)
  } else st.pending = input.mood
  const dueMood = st.pending ? st.shownSince + MOOD_DWELL_MS : Infinity
  const wakeFrom = Math.max(input.lastEventAt, st.shownSince)
  const awake = input.motion && now - wakeFrom < DORMANT_MS
  if (awake) {
    // 2. blinks (desktop stage: every 2.2 to 6.4 s) and persona verbs (idle only, 10 to 22 s apart times the tempo)
    if (now >= st.blinkAt + BLINK_MS) st.blinkAt = now + 2200 + rand(st) * 4200
    if (st.verb && now >= st.verb.at + st.verb.len) st.verb = null
    if (st.shown === 'idle' && !st.verb && now >= st.verbNextAt) {
      const v = pickVerb(art, st, now)
      if (v >= 0) {
        const len = verbLength(art, art.persona.verbs[v]!)
        st.verb = { i: v, at: now, len }; st.verbLast[v] = now
        st.verbNextAt = now + len + verbGap(art, st)
      } else st.verbNextAt = now + verbGap(art, st)
    }
  }
  const pose = poseAt(art, st, now, awake)
  const key = poseKey(pose)
  const changed = key !== st.lastKey
  st.lastKey = key
  if (!awake) return { state: st, pose: changed ? pose : null, nextAtMs: Number.isFinite(dueMood) ? dueMood : null }
  // 3. the next change: scheduled events, or the first sample on the frame grid where the pose differs
  const events = [wakeFrom + DORMANT_MS, dueMood, st.blinkAt, st.blinkAt + BLINK_MS, st.verb ? st.verb.at + st.verb.len : Infinity, st.shown === 'idle' && !st.verb ? st.verbNextAt : Infinity]
  let next = Infinity
  for (const e of events) if (e > now && e < next) next = e
  const fast = (st.prev !== null && now - st.fadeAt < FADE_MS) || st.verb !== null || ((st.shown === 'victory' || st.shown === 'annoyed' || st.shown === 'error') && now - st.shownSince < 1400) || st.shown === 'error'
  const step = fast ? FAST_STEP : SLOW_STEP
  const limit = Math.min(next, now + HORIZON_MS)
  for (let t = now + step; t < limit; t += step) {
    if (poseKey(poseAt(art, st, t, true)) !== key) { next = t; break }
  }
  if (!Number.isFinite(next) || next > now + HORIZON_MS) next = now + HORIZON_MS
  return { state: st, pose: changed ? pose : null, nextAtMs: Math.max(next, now + FAST_STEP) }
}

function pickVerb(art: Art, st: AnimState, now: number): number {
  const ok: number[] = []
  art.persona.verbs.forEach((v, i) => { if ((v.when ?? 'idle') === 'idle' && now - st.verbLast[i]! >= (v.cd ?? 30) * 1000) ok.push(i) })
  if (!ok.length) return -1
  const total = ok.reduce((n, i) => n + (art.persona.verbs[i]!.w ?? 1), 0)
  let r = rand(st) * total
  for (const i of ok) { r -= art.persona.verbs[i]!.w ?? 1; if (r <= 0) return i }
  return ok[ok.length - 1]!
}

/** The still pose of a mood (the muster row and motion off). */
export function stillPose(art: Art, mood: Mood, outline = true): Pose {
  const st = createAnimState(art, 0, mood, { outline })
  return poseAt(art, st, 0, false)
}

export type { FilterOp }
