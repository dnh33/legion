/**
 * Terminal cell width, and strings fitted to an exact number of cells.
 *
 * Pure, no globals beyond the language: the same code runs in the engine and under Node's test runner. Every row the
 * Legion pane draws is built from these, so a row is exactly as wide as the pane and nothing shifts between states.
 *
 * The width rules follow wcwidth as modern terminals apply it (Windows Terminal, kitty, iTerm2):
 * - combining marks, format characters, variation selectors and control characters: 0 cells;
 * - East Asian Wide and Fullwidth, and emoji drawn as emoji (Emoji_Presentation, or any pictograph with VS16): 2 cells;
 * - an emoji ZWJ sequence, a flag (two regional indicators) and an emoji with a skin-tone modifier: one cluster, 2 cells;
 * - everything else, the roster glyphs and theme marks included: 1 cell. Spike S8 measures the roster glyphs for real.
 */
import { MARK } from '../theme.ts'

/** The roster glyphs: text-presentation symbols the plan counts as 1 cell (spike S8 confirms per terminal). */
export const ROSTER_GLYPHS = ['✠', '⌘', '◎', '⌕', '✎', '▤', '◬', '⌶', '☾', '⊥', '⚑', '⊜', '◈'] as const

const ONE_CELL: ReadonlySet<number> = new Set([...ROSTER_GLYPHS, ...Object.values(MARK)].map(g => g.codePointAt(0) ?? 0))

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u

const PRINTABLE_ASCII = /^[ -~]*$/
const ZWJ = 0x200d
const VS15 = 0xfe0e
const VS16 = 0xfe0f
const isRegional = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff
const isSkinTone = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff

/** East Asian Wide (W) and Fullwidth (F) ranges, Unicode 15 (EastAsianWidth.txt), outside the emoji block. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f2ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

const isWide = (cp: number): boolean => {
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return true
  return false
}

/** The width of one code point on its own, outside any cluster. */
export const codePointWidth = (cp: number): number => {
  if (ONE_CELL.has(cp)) return 1
  const ch = String.fromCodePoint(cp)
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || ZERO.test(ch)) return 0
  if (EMOJI_PRESENTATION.test(ch) || isWide(cp)) return 2
  return 1
}

/** One grapheme-ish cluster: its text and its width. Built without Intl.Segmenter so every runtime agrees. */
type Cluster = { text: string; width: number }

/** Splits a string into the clusters a terminal draws as one unit, each with its width. */
export const clusters = (s: string): Cluster[] => {
  const out: Cluster[] = []
  const cps = Array.from(s, ch => ch.codePointAt(0) ?? 0)
  let i = 0
  while (i < cps.length) {
    const cp = cps[i] as number
    let text = String.fromCodePoint(cp)
    let width = codePointWidth(cp)
    let isEmoji = width === 2 && (EMOJI_PRESENTATION.test(text) || isRegional(cp))
    i++
    // a second regional indicator joins the first: one flag
    if (isRegional(cp) && i < cps.length && isRegional(cps[i] as number)) {
      text += String.fromCodePoint(cps[i] as number)
      i++
    }
    // marks, selectors, skin tones and ZWJ continuations belong to the cluster
    while (i < cps.length) {
      const next = cps[i] as number
      const ch = String.fromCodePoint(next)
      if (next === VS16 && PICTOGRAPH.test(String.fromCodePoint(cp)) && !ONE_CELL.has(cp)) {
        text += ch; width = 2; isEmoji = true; i++
      } else if (next === VS15) {
        text += ch; i++
      } else if (isSkinTone(next) && isEmoji) {
        text += ch; i++
      } else if (next === ZWJ && i + 1 < cps.length && isEmoji) {
        text += ch + String.fromCodePoint(cps[i + 1] as number); i += 2
      } else if (codePointWidth(next) === 0 && !(next < 0x20 || (next >= 0x7f && next < 0xa0))) {
        text += ch; i++
      } else break
    }
    out.push({ text, width })
  }
  return out
}

/** Cells a string takes on a terminal line. Newlines and tabs count 0: lines are fitted one at a time. */
export const cellWidth = (s: string): number => {
  if (PRINTABLE_ASCII.test(s)) return s.length // the common case, without the cluster walk
  let w = 0
  for (const c of clusters(s)) w += c.width
  return w
}

/** One line: newlines, tabs and other control characters become spaces, runs collapse to one. */
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ')

export type FitOptions = { align?: 'left' | 'right'; ellipsis?: boolean }

/** Pads `s` with spaces to at least `cols` cells, on the right (left-aligned) or on the left (right-aligned). */
export const padCells = (s: string, cols: number, align: 'left' | 'right' = 'left'): string => {
  const room = Math.max(0, Math.floor(cols) - cellWidth(s))
  return align === 'right' ? ' '.repeat(room) + s : s + ' '.repeat(room)
}

/** Cuts `s` to at most `cols` cells, never splitting a cluster; adds `…` when cut and `ellipsis` is on. */
export const cutCells = (s: string, cols: number, ellipsis = true): string => {
  const max = Math.max(0, Math.floor(cols))
  if (cellWidth(s) <= max) return s
  const budget = ellipsis ? max - cellWidth(MARK.ellipsis) : max
  let out = ''
  let w = 0
  for (const c of clusters(s)) {
    if (w + c.width > budget) break
    out += c.text
    w += c.width
  }
  return ellipsis && max > 0 ? out.trimEnd() + MARK.ellipsis : out
}

/**
 * `s` on one line, exactly `cols` cells wide: cut with `…` when longer, padded with spaces when shorter. A wide cluster
 * that would straddle the edge is left out and the gap padded, so the result never overruns.
 */
export const fit = (s: string, cols: number, options: FitOptions = {}): string => {
  const n = Math.max(0, Math.floor(Number.isFinite(cols) ? cols : 0))
  if (n === 0) return ''
  const cut = cutCells(oneLine(s), n, options.ellipsis !== false)
  return padCells(cut, n, options.align ?? 'left')
}

/**
 * Word-wraps `s` to lines of at most `cols` cells. Explicit newlines are kept; a word longer than a line is broken
 * between clusters. Trailing spaces are dropped from each line. An empty string is one empty line.
 */
export const wrapCells = (s: string, cols: number): string[] => {
  const n = Math.max(1, Math.floor(Number.isFinite(cols) ? cols : 1))
  const lines: string[] = []
  for (const para of s.replace(/\r\n?/g, '\n').split('\n')) {
    const words = oneLine(para).split(' ')
    let line = ''
    let w = 0
    for (const word of words) {
      if (word === '') continue
      const ww = cellWidth(word)
      if (w > 0 && w + 1 + ww <= n) {
        line += ' ' + word; w += 1 + ww
        continue
      }
      if (w > 0) { lines.push(line); line = ''; w = 0 }
      if (ww <= n) { line = word; w = ww; continue }
      // a word longer than the line: break it between clusters
      let piece = ''
      let pw = 0
      for (const c of clusters(word)) {
        if (pw + c.width > n) { lines.push(piece); piece = ''; pw = 0 }
        piece += c.text; pw += c.width
      }
      line = piece; w = pw
    }
    lines.push(line)
  }
  return lines
}
