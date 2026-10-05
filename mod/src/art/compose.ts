/**
 * Composes one frame of a bust from its machine-made planes (art.ts). Effects only: planes are shifted by whole pixels, the
 * lower rows of a hanging layer are offset by one pixel about its pivot, and colours go through the desktop's own CSS filter
 * functions. No pixel of the painted art is drawn here. Pure and deterministic: the same pose gives the same bytes.
 */
import type { Mood } from '../../types/index.d.ts'
import type { ArtPlane, ArtSize, EyeSet, PlaneKind } from './art.ts'

/** A CSS filter function (Filter Effects 1, "filter functions"); `hue` is hue-rotate in degrees. */
export type FilterOp = readonly ['sepia' | 'saturate' | 'hue' | 'brightness', number]

/**
 * The face filter per state, exactly as mascot.css writes them (`.mx.mxs-<state> .mx-face { filter: ... }`, lines 39-91).
 * Thinking breathes (mx-breathe, brightness 1 to 1.35) and is animated by the animator, not listed here.
 */
export const FACE_FILTER: Record<Mood, readonly FilterOp[]> = {
  idle: [],
  listening: [['brightness', 1.18]],
  thinking: [],
  hacking: [],
  awaiting: [['sepia', 1], ['saturate', 3.4], ['hue', -14], ['brightness', 1.12]],
  victory: [],
  error: [['sepia', 1], ['saturate', 6], ['hue', -48], ['brightness', 0.98]],
  sleeping: [['brightness', 0.45], ['saturate', 0.6]],
  annoyed: [['sepia', 1], ['saturate', 6], ['hue', -48], ['brightness', 0.98]],
}

/** The eye set per state (mascot.css: hacking narrow + visor code, victory happy, error wince, sleeping shut, annoyed angry). */
export const FACE_EYES: Record<Mood, EyeSet> = {
  idle: 'base', listening: 'base', thinking: 'base', hacking: 'hacking', awaiting: 'base',
  victory: 'happy', error: 'wince', sleeping: 'shut', annoyed: 'angry',
}

/** A colour treatment of a group of planes. `from` + `mix` cross-fade from an earlier treatment (mix 1 = `ops`). */
export type Tint = {
  ops: readonly FilterOp[]
  from?: readonly FilterOp[]
  mix?: number
  /** brightness() after the ops (breathe, flare). */
  gain?: number
  /** opacity, 0 to 1. */
  alpha?: number
}

export type Pose = {
  /** Whole-bust lift in pixels (the float bob); positive is up. */
  bob: number
  /** Offset of the head rig (plume, helm, face), pixels. */
  rigDx: number
  rigDy: number
  /** Plane id to -1, 0 or 1: the sign of a CSS rotate() about the plane's pivot, shown as a 1 px shift at the far end. */
  shear: Readonly<Record<string, number>>
  eyes: EyeSet
  face: Tint
  halo: Tint
  plume: Tint
  /** A 1 px outline in a darker shade of the neighbouring colour around the figure (aura and halo rings stay as painted). */
  outline: boolean
}

/** Straight-alpha RGBA, `w * h * 4`. */
export type Frame = { w: number; h: number; rgba: Uint8ClampedArray }

export const NO_TINT: Tint = { ops: [] }

export const restPose = (): Pose => ({ bob: 0, rigDx: 0, rigDy: 0, shear: {}, eyes: 'base', face: NO_TINT, halo: NO_TINT, plume: NO_TINT, outline: true })

// ---- CSS filter functions in sRGB, clamped after each function (checked against Edge: filter-truth.json) ----

const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131]

function opMatrix(op: FilterOp): number[] {
  const [name, v] = op
  if (name === 'brightness') return [v, 0, 0, 0, v, 0, 0, 0, v]
  if (name === 'sepia') {
    const a = 1 - Math.min(1, Math.max(0, v))
    const id = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    return SEPIA.map((s, i) => s + (id[i]! - s) * a)
  }
  if (name === 'saturate') {
    const s = v
    return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]
  }
  const r = (v * Math.PI) / 180
  const c = Math.cos(r); const s = Math.sin(r)
  return [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Applies a CSS filter chain to one sRGB colour (0-255 each); returns 0-1 floats. */
export function applyFilter(ops: readonly FilterOp[], r: number, g: number, b: number): [number, number, number] {
  let x = r / 255; let y = g / 255; let z = b / 255
  for (const op of ops) {
    const m = opMatrix(op)
    const nx = m[0]! * x + m[1]! * y + m[2]! * z
    const ny = m[3]! * x + m[4]! * y + m[5]! * z
    const nz = m[6]! * x + m[7]! * y + m[8]! * z
    x = clamp01(nx); y = clamp01(ny); z = clamp01(nz)
  }
  return [x, y, z]
}

const tintKey = (t: Tint): string => `${JSON.stringify(t.ops)}|${t.from ? JSON.stringify(t.from) : ''}|${t.mix ?? 1}|${t.gain ?? 1}`
const isPlain = (t: Tint): boolean => t.ops.length === 0 && (!t.from || t.from.length === 0) && (t.gain ?? 1) === 1

/** The palette as a tint shows it (cached on the size; at most 96 cached palettes, then the cache starts over). */
export function tintPalette(size: ArtSize, t: Tint): Uint8Array {
  if (isPlain(t)) return size.palette
  const key = tintKey(t)
  const hit = size.cache.get(key)
  if (hit) return hit
  const pal = size.palette
  const out = new Uint8Array(pal.length)
  const mix = t.from ? clamp01(t.mix ?? 1) : 1
  const gain = t.gain ?? 1
  for (let i = 0; i < pal.length; i += 3) {
    const r = pal[i]!; const g = pal[i + 1]!; const b = pal[i + 2]!
    let [x, y, z] = applyFilter(t.ops, r, g, b)
    if (t.from && mix < 1) {
      const [fx, fy, fz] = applyFilter(t.from, r, g, b)
      x = fx + (x - fx) * mix; y = fy + (y - fy) * mix; z = fz + (z - fz) * mix
    }
    out[i] = Math.round(clamp01(x * gain) * 255)
    out[i + 1] = Math.round(clamp01(y * gain) * 255)
    out[i + 2] = Math.round(clamp01(z * gain) * 255)
  }
  if (size.cache.size >= 96) size.cache.clear()
  size.cache.set(key, out)
  return out
}

/** The outline shade of a colour: the same hue at 42 % (never pure black: the brightest channel stays at least 7 %). */
export function outlineOf(r: number, g: number, b: number): [number, number, number] {
  let x = (r / 255) * 0.42; let y = (g / 255) * 0.42; let z = (b / 255) * 0.42
  const m = Math.max(x, y, z)
  if (m < 0.07) { const d = 0.07 - m; x += d; y += d; z += d }
  return [Math.round(x * 255), Math.round(y * 255), Math.round(z * 255)]
}

const RIG: ReadonlySet<PlaneKind> = new Set(['plume', 'helm', 'face'])
const NO_OUTLINE: ReadonlySet<PlaneKind> = new Set(['aura', 'halo-back', 'halo-front'])

/** Scratch buffers per size, so a frame allocates only its own output. */
const scratch = new WeakMap<ArtSize, { body: Uint8Array; bodyRgb: Uint8Array }>()

/** Composes the frame `size.cols` x `size.rows * 2` pixels for a pose. */
export function compose(size: ArtSize, pose: Pose): Frame {
  const W = size.cols; const H = size.rows * 2; const M = size.margin
  const rgba = new Uint8ClampedArray(W * H * 4)
  let s = scratch.get(size)
  if (!s) { s = { body: new Uint8Array(W * H), bodyRgb: new Uint8Array(W * H * 3) }; scratch.set(size, s) }
  const body = s.body; const bodyRgb = s.bodyRgb
  body.fill(0)
  const faceId = `face:${pose.eyes}`
  for (const pl of size.planes) {
    if (pl.kind === 'face' && pl.id !== faceId) continue
    const tint = pl.kind === 'face' ? pose.face : pl.kind === 'halo-back' || pl.kind === 'halo-front' ? pose.halo : pl.kind === 'plume' ? pose.plume : NO_TINT
    drawPlane(size, pl, pose, tint, rgba, body, bodyRgb, W, H, M)
  }
  if (pose.outline) addOutline(rgba, body, bodyRgb, W, H)
  return { w: W, h: H, rgba }
}

function drawPlane(size: ArtSize, pl: ArtPlane, pose: Pose, tint: Tint, rgba: Uint8ClampedArray, body: Uint8Array, bodyRgb: Uint8Array, W: number, H: number, M: number): void {
  const pal = tintPalette(size, tint)
  const aMul = tint.alpha === undefined ? 1 : clamp01(tint.alpha)
  if (aMul === 0) return
  const rig = RIG.has(pl.kind)
  const ox = pl.x - M + (rig ? pose.rigDx : 0)
  const oy = pl.y - M - pose.bob + (rig ? pose.rigDy : 0)
  const sh = pose.shear[pl.id] ?? 0
  const py = pl.pivot ? pl.pivot[1] : pl.y
  const outlined = !NO_OUTLINE.has(pl.kind)
  for (let r = 0; r < pl.h; r++) {
    const y = oy + r
    if (y < 0 || y >= H) continue
    // CSS rotate(+deg) about the pivot moves points below it to the left and points above it to the right
    const dx = sh === 0 ? 0 : Math.round((-sh * (pl.y + r + 0.5 - py)) / pl.reach)
    const rowBase = r * pl.w
    for (let c = 0; c < pl.w; c++) {
      const k = rowBase + c
      let a = pl.alpha[k]!
      if (a === 0) continue
      const x = ox + c + dx
      if (x < 0 || x >= W) continue
      if (aMul < 1) a = Math.round(a * aMul)
      if (a === 0) continue
      const pi = pl.idx[k]! * 3
      const cr = pal[pi]!; const cg = pal[pi + 1]!; const cb = pal[pi + 2]!
      const o = (y * W + x) * 4
      if (a === 255) {
        rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb; rgba[o + 3] = 255
      } else {
        // straight-alpha "over"
        const sa = a / 255; const da = rgba[o + 3]! / 255
        const oa = sa + da * (1 - sa)
        const f = da * (1 - sa)
        rgba[o] = (cr * sa + rgba[o]! * f) / oa
        rgba[o + 1] = (cg * sa + rgba[o + 1]! * f) / oa
        rgba[o + 2] = (cb * sa + rgba[o + 2]! * f) / oa
        rgba[o + 3] = oa * 255
      }
      if (outlined && a >= 128) {
        const p = y * W + x
        body[p] = 1; bodyRgb[p * 3] = cr; bodyRgb[p * 3 + 1] = cg; bodyRgb[p * 3 + 2] = cb
      }
    }
  }
}

function addOutline(rgba: Uint8ClampedArray, body: Uint8Array, bodyRgb: Uint8Array, W: number, H: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (body[p] || rgba[p * 4 + 3]! >= 128) continue
      // the first figure pixel below, above, left, right gives the shade
      let q = -1
      if (y + 1 < H && body[p + W]) q = p + W
      else if (y > 0 && body[p - W]) q = p - W
      else if (x > 0 && body[p - 1]) q = p - 1
      else if (x + 1 < W && body[p + 1]) q = p + 1
      if (q < 0) continue
      const [r, g, b] = outlineOf(bodyRgb[q * 3]!, bodyRgb[q * 3 + 1]!, bodyRgb[q * 3 + 2]!)
      rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = 255
    }
  }
}
