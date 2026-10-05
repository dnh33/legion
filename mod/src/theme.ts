/**
 * Legion's look in a terminal: the desktop's tokens (ui/src/styles/tokens.css), unchanged, and the rules for using them.
 *
 * Rules (plan §6):
 * - Accent (phosphor green) means "alive and yours": focus, the running pulse, the selection, connected. Never danger.
 * - Hierarchy comes from weight, dim, accent and space only. No ALL-CAPS except the wordmark.
 * - Plain words for state. Character only in the mascot quips and empty states.
 */
import type { Mood } from '../types/index.d.ts'

export type Tone = 'bg' | 'surface' | 'surface2' | 'surface3' | 'line' | 'lineStrong' | 'text' | 'text2' | 'muted' | 'faint' | 'accent' | 'accentText' | 'accentInk' | 'warn' | 'danger'
export type Palette = Record<Tone, string>

/** ui/src/styles/tokens.css `:root` (dark, the default). */
export const DARK: Palette = {
  bg: '#0b0d10', surface: '#12151a', surface2: '#171b21', surface3: '#1d222a',
  line: '#1e232b', lineStrong: '#2a313b',
  text: '#e6e9ef', text2: '#b3bac6', muted: '#8a93a3', faint: '#7d8797',
  accent: '#7CFFB2', accentText: '#7CFFB2', accentInk: '#04140b',
  warn: '#FFCC66', danger: '#FF6B6B',
}

/** ui/src/styles/tokens.css `:root[data-theme='light']`. */
export const LIGHT: Palette = {
  bg: '#f4f5f7', surface: '#ffffff', surface2: '#f6f7f9', surface3: '#eceef2',
  line: '#e3e6eb', lineStrong: '#cfd4dc',
  text: '#14171c', text2: '#3a4250', muted: '#596275', faint: '#626c7e',
  accent: '#0c9f5e', accentText: '#087a47', accentInk: '#ffffff',
  warn: '#8f5d0c', danger: '#c0343e',
}

export const palette = (theme: 'dark' | 'light'): Palette => (theme === 'light' ? LIGHT : DARK)

/** Claude Code's theme names that start with `light` are light terminals; everything else draws on dark. */
export const themeFromClaude = (name: unknown): 'dark' | 'light' => (typeof name === 'string' && name.startsWith('light') ? 'light' : 'dark')

/** The mood words of the desktop (ui/src/mascot/useRelicState.ts). */
export const MOOD_WORDS: Record<Mood, string> = {
  idle: 'Standing vigil',
  listening: 'Listening',
  thinking: 'Deliberating',
  hacking: 'Executing',
  awaiting: 'Awaiting your word',
  victory: 'Victory',
  error: 'Fault detected',
  sleeping: 'Dormant',
  annoyed: 'Annoyed',
}

/** Moods that switch at once; every other mood dwells at least MOOD_DWELL_MS (desktop mascot rule). */
export const URGENT_MOODS: ReadonlySet<Mood> = new Set(['awaiting', 'error'])
export const MOOD_DWELL_MS = 1800

/** One-cell marks. Each must be width 1 in Windows Terminal (spike S8 measures them; the fallbacks are ASCII-safe). */
export const MARK = {
  running: '●',
  queued: '◐',
  done: '·',
  error: '✕',
  paused: '‖',
  cancelled: '–',
  card: '!',
  arrow: '▸',
  bar: '│',
  rule: '─',
  ellipsis: '…',
  caret: '▍',
} as const

/** The width of the rail column, in cells, at each pane width. */
export const railColumns = (bodyColumns: number): number => (bodyColumns >= 100 ? 18 : bodyColumns >= 72 ? 14 : 0)

/** Breakpoints the views lay out against, in cells. */
export const BREAKPOINTS = { narrow: 72, medium: 100, wide: 140 } as const
