/**
 * The 2D Order's frame data: the shape of mod/art/<agent>.json (made by scripts/build-mod-frames.py from the painted layers,
 * never by hand) and its decoder. Pure: no `$`, no file access. The lead reads the file only when the 2D Order is switched on
 * and passes the parsed JSON to `decodeArt`; nothing in mod/src/art imports an art file, so "off" loads no frames.
 */
import { decodeBase64 } from './b64.ts'

export type PlaneKind = 'aura' | 'halo-back' | 'body' | 'plume' | 'helm' | 'face' | 'hang' | 'front' | 'token' | 'halo-front'
const KINDS: ReadonlySet<string> = new Set(['aura', 'halo-back', 'body', 'plume', 'helm', 'face', 'hang', 'front', 'token', 'halo-front'])

/** The face planes the desktop shows (mascot.css): one per eye set, `hacking` adds the visor code, `blink` is scaleY(.12). */
export type EyeSet = 'base' | 'narrow' | 'hacking' | 'happy' | 'wince' | 'shut' | 'angry' | 'blink'

export type ArtPlane = {
  /** `L-helm`, `L-hang-2`, ... or `face:<eye set>`. */
  id: string
  kind: PlaneKind
  /** Box on the canvas (the frame plus `margin` pixels on every side). */
  x: number
  y: number
  w: number
  h: number
  /** The layer's rotation pivot on the canvas (the art's data-pivot, scaled). */
  pivot?: readonly [number, number]
  /** Palette index per pixel, row-major, w * h. */
  idx: Uint8Array
  /** Coverage per pixel (0 or 255 in the pixel style), w * h. */
  alpha: Uint8Array
  /** Rows from the pivot to the farthest painted row (for the 1 px sway at the far end). */
  reach: number
}

export type ArtSize = {
  cols: number
  rows: number
  /** Canvas margin, pixels, every side. */
  margin: number
  /** RGB triples. */
  palette: Uint8Array
  /** Palette entries from here on were picked for the face light. */
  faceFrom: number
  planes: ArtPlane[]
  /** Transformed palettes, by tint key (compose.ts). */
  cache: Map<string, Uint8Array>
}

export type VerbStep = {
  p: string
  target?: string | string[]
  targets?: string
  deg?: number | number[]
  dur?: number
  at?: number
  y?: number
  peak?: number
  to?: number
  eyes?: string
  keep?: boolean
  cycles?: number
  times?: number
  stagger?: number
  order?: string
}
export type Verb = { id: string; w?: number; cd?: number; when?: string; steps: VerbStep[] }

export type ArtPersona = {
  name: string
  tempo: number
  haloFlare?: number
  haloMotion?: string
  plumeSway?: number
  plumeLight?: boolean
  sleepPlume?: number
  verbs: Verb[]
}

export type Art = { agent: string; persona: ArtPersona; stage: ArtSize; muster: ArtSize }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`art: ${what} is not a number`)
  return v
}

function decodeSize(raw: unknown, what: string): ArtSize {
  if (!isObj(raw)) throw new Error(`art: ${what} is missing`)
  const cols = num(raw.cols, `${what}.cols`)
  const rows = num(raw.rows, `${what}.rows`)
  const margin = num(raw.margin, `${what}.margin`)
  if (typeof raw.palette !== 'string') throw new Error(`art: ${what}.palette is missing`)
  const palette = decodeBase64(raw.palette)
  if (palette.length % 3 !== 0 || palette.length === 0 || palette.length > 256 * 3) throw new Error(`art: ${what}.palette has ${palette.length} bytes`)
  if (!Array.isArray(raw.planes)) throw new Error(`art: ${what}.planes is missing`)
  const planes: ArtPlane[] = raw.planes.map((p: unknown, i: number): ArtPlane => {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.kind !== 'string' || typeof p.px !== 'string') throw new Error(`art: ${what}.planes[${i}] is malformed`)
    if (!KINDS.has(p.kind)) throw new Error(`art: ${what}.planes[${i}] has kind ${p.kind}`)
    const w = num(p.w, 'w'); const h = num(p.h, 'h'); const x = num(p.x, 'x'); const y = num(p.y, 'y')
    const bytes = decodeBase64(p.px)
    if (bytes.length !== w * h * 2) throw new Error(`art: ${what}.planes[${i}] (${p.id}) has ${bytes.length} bytes for ${w}x${h}`)
    const idx = new Uint8Array(w * h)
    const alpha = new Uint8Array(w * h)
    for (let k = 0; k < w * h; k++) {
      const ix = bytes[k * 2]!
      if (ix * 3 >= palette.length) throw new Error(`art: ${what}.planes[${i}] (${p.id}) uses palette entry ${ix}`)
      idx[k] = ix
      alpha[k] = bytes[k * 2 + 1]!
    }
    let pivot: readonly [number, number] | undefined
    if (Array.isArray(p.pivot) && p.pivot.length === 2) pivot = [num(p.pivot[0], 'pivot'), num(p.pivot[1], 'pivot')]
    const py = pivot ? pivot[1] : y
    const reach = Math.max(1, Math.abs(y + 0.5 - py), Math.abs(y + h - 0.5 - py))
    return { id: p.id, kind: p.kind as PlaneKind, x, y, w, h, ...(pivot ? { pivot } : {}), idx, alpha, reach }
  })
  return { cols, rows, margin, palette, faceFrom: num(raw.faceFrom, `${what}.faceFrom`), planes, cache: new Map() }
}

/** Parsed mod/art/<agent>.json to the runtime's shape. Throws a plain Error naming what is wrong. */
export function decodeArt(raw: unknown): Art {
  if (!isObj(raw) || raw.v !== 1) throw new Error('art: not a version 1 art file')
  if (typeof raw.agent !== 'string') throw new Error('art: agent is missing')
  if (!isObj(raw.sizes)) throw new Error('art: sizes is missing')
  const p = isObj(raw.persona) ? raw.persona : {}
  const persona: ArtPersona = {
    name: typeof p.name === 'string' ? p.name : raw.agent,
    tempo: typeof p.tempo === 'number' && p.tempo > 0 ? p.tempo : 1,
    ...(typeof p.haloFlare === 'number' ? { haloFlare: p.haloFlare } : {}),
    ...(typeof p.haloMotion === 'string' ? { haloMotion: p.haloMotion } : {}),
    ...(typeof p.plumeSway === 'number' ? { plumeSway: p.plumeSway } : {}),
    ...(p.plumeLight === true ? { plumeLight: true } : {}),
    ...(typeof p.sleepPlume === 'number' ? { sleepPlume: p.sleepPlume } : {}),
    verbs: Array.isArray(p.verbs) ? (p.verbs.filter((v: unknown) => isObj(v) && typeof v.id === 'string' && Array.isArray(v.steps)) as Verb[]) : [],
  }
  return { agent: raw.agent, persona, stage: decodeSize(raw.sizes.stage, 'stage'), muster: decodeSize(raw.sizes.muster, 'muster') }
}
