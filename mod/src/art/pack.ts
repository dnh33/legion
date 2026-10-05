/**
 * Frame to Raster cells (RasterProps.cells, claude-code.d.ts ~8431-8458): standard padded base64 of `columns * rows`
 * little-endian u32 triplets `[codePoint, foreground, background]`, row-major. One cell holds two pixels with U+2580
 * (upper half block): foreground = the top pixel, background = the bottom one. Pure.
 */
import { decodeBase64, encodeBase64 } from './b64.ts'
import type { Frame } from './compose.ts'

export const UPPER_HALF = 0x2580
export const LOWER_HALF = 0x2584
export const SPACE = 0x20
/** RasterProps: bit 24 alone is the terminal's own default colour. */
export const DEFAULT_COLOR = 0x01000000

export type PackOptions = {
  /** The panel colour, 0xRRGGBB (the theme's surface): partly covered pixels blend over it. */
  panel: number
  /**
   * Where no art is: `panel` (default, the brief's rule) paints uncovered halves in the panel colour and leaves a cell with
   * no art at all as a space in the terminal's default colours; `terminal` leaves every uncovered half to the terminal
   * itself (U+2584 or U+2580 against the default colour), so no box shows on a terminal whose own background differs.
   */
  transparent?: 'panel' | 'terminal'
}

/** "#rrggbb" to 0xRRGGBB. */
export const hexColor = (hex: string): number => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  return parseInt(m[1]!, 16)
}

function pixel(rgba: Uint8ClampedArray, o: number, panel: number): number {
  const a = rgba[o + 3]!
  if (a === 255) return (rgba[o]! << 16) | (rgba[o + 1]! << 8) | rgba[o + 2]!
  const k = a / 255
  const pr = (panel >>> 16) & 255; const pg = (panel >>> 8) & 255; const pb = panel & 255
  const r = Math.round(rgba[o]! * k + pr * (1 - k))
  const g = Math.round(rgba[o + 1]! * k + pg * (1 - k))
  const b = Math.round(rgba[o + 2]! * k + pb * (1 - k))
  return (r << 16) | (g << 8) | b
}

/** Packs a frame of `cols` x `2 * rows` pixels. An odd last pixel row counts as uncovered below. */
export function pack(frame: Frame, opts: PackOptions): string {
  const cols = frame.w
  const rows = Math.ceil(frame.h / 2)
  const out = new Uint8Array(cols * rows * 12)
  const term = opts.transparent === 'terminal'
  const panel = opts.panel & 0xffffff
  const rgba = frame.rgba
  let o = 0
  const put = (v: number): void => {
    out[o] = v & 255; out[o + 1] = (v >>> 8) & 255; out[o + 2] = (v >>> 16) & 255; out[o + 3] = (v >>> 24) & 255
    o += 4
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = ((2 * r) * cols + c) * 4
      const hasBottom = 2 * r + 1 < frame.h
      const b = ((2 * r + 1) * cols + c) * 4
      const ta = rgba[t + 3]!
      const ba = hasBottom ? rgba[b + 3]! : 0
      if (ta === 0 && ba === 0) {
        put(SPACE); put(DEFAULT_COLOR); put(DEFAULT_COLOR)
      } else if (term && ta === 0) {
        put(LOWER_HALF); put(pixel(rgba, b, panel)); put(DEFAULT_COLOR)
      } else if (term && ba === 0) {
        put(UPPER_HALF); put(pixel(rgba, t, panel)); put(DEFAULT_COLOR)
      } else {
        put(UPPER_HALF)
        put(ta === 0 ? panel : pixel(rgba, t, panel))
        put(ba === 0 ? panel : pixel(rgba, b, panel))
      }
    }
  }
  return encodeBase64(out)
}

/** The distinct (foreground, background) pairs in packed cells: what Raster's 1024-pair palette has to hold. */
export function colorPairs(cells: string, into: Set<string> = new Set()): Set<string> {
  const bytes = decodeBase64(cells)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i + 12 <= bytes.length; i += 12) into.add(`${v.getUint32(i + 4, true)}:${v.getUint32(i + 8, true)}`)
  return into
}

/** Reads packed cells back to `[codePoint, fg, bg]` triplets (specs and review tools). */
export function unpack(cells: string): Uint32Array {
  const bytes = decodeBase64(cells)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Uint32Array(bytes.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = v.getUint32(i * 4, true)
  return out
}
