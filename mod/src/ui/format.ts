/**
 * Numbers and times as Legion words them. Pure; the same in the engine and in Node.
 *
 * Every function here answers a short string of a bounded width, so a caller can give it a fixed column and nothing
 * jitters as the value changes. None of them throws, and a non-finite input never prints `NaN`.
 */

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** 1234567 -> '1,234,567'. Hand-rolled: the engine's environment is not promised Intl. */
const groupThousands = (whole: number): string => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * A cost estimate in US dollars, always marked `≈` (the engine reports tokens per agent, not dollars; plan §2.4).
 * '≈$0.21', '≈$1,234.56'; '<≈$0.01' for a cost under a cent, as the desktop shows '<$0.01' (ui/src/util.ts:17);
 * '≈$0.00' for zero; '≈$?' when the cost is unknown or not a number. At most 14 cells up to ≈$99,999,999.99.
 */
export const money = (usd: number | null | undefined): string => {
  if (!finite(usd) || usd < 0) return '≈$?'
  if (usd === 0) return '≈$0.00'
  if (usd < 0.01) return '<≈$0.01'
  const cents = Math.round(usd * 100)
  const whole = Math.floor(cents / 100)
  const frac = String(cents % 100).padStart(2, '0')
  return `≈$${groupThousands(whole)}.${frac}`
}

/** A count capped for a badge: 99 -> '99', 100 -> '99+'. Negative or not a number -> '0'. */
export const count = (n: number | null | undefined, cap = 99): string => {
  if (!finite(n) || n <= 0) return '0'
  const whole = Math.floor(n)
  return whole > cap ? `${cap}+` : String(whole)
}

/** Token counts: '987', '12.3k', '123k', '1.2M', '45M'. A trailing '.0' is dropped ('12k'). */
export const tokens = (n: number | null | undefined): string => {
  if (!finite(n) || n <= 0) return '0'
  const whole = Math.round(n)
  if (whole < 1000) return String(whole)
  // one decimal below 100 ('99.96' rounds to '100.0', printed '100'), whole numbers below 999.5, then the next unit
  const short = (v: number): string => (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)))
  const k = whole / 1000
  if (k < 999.5) return `${short(k)}k`
  return `${short(whole / 1_000_000)}M`
}

/**
 * How long ago, in the desktop's words (ui/src/util.ts:3-11): 'now' under 10 s, then '42s', '5m', '3h', '2d'.
 * A time in the future (clock skew between windows) reads 'now'. At most 4 cells below 10,000 days.
 */
export const relTime = (at: number, now: number): string => {
  if (!finite(at) || !finite(now)) return ''
  const s = Math.floor(Math.max(0, now - at) / 1000)
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** A duration: '0s', '42s', '5m 4s', '3h 12m', '2d 3h'. Two units at most, the larger first. */
export const duration = (ms: number | null | undefined): string => {
  if (!finite(ms) || ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** The eighth blocks, one to seven eighths: a partial cell of a meter. */
const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const FULL = '█'

/**
 * A fixed-width bar, exactly `cells` cells: full blocks, one eighth-block for the remainder, then spaces.
 * `value` is clamped to [0, max]; a max of 0 or less, or a value that is not a number, draws an empty bar.
 */
export const meter = (value: number, max: number, cells: number): string => {
  const n = finite(cells) ? Math.max(0, Math.floor(cells)) : 0
  if (n === 0) return ''
  const frac = finite(value) && finite(max) && max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const eighths = Math.round(frac * n * 8)
  const full = Math.floor(eighths / 8)
  const rest = eighths % 8
  const bar = FULL.repeat(full) + (rest > 0 ? EIGHTHS[rest - 1] : '')
  return bar + ' '.repeat(n - full - (rest > 0 ? 1 : 0))
}

/** 'turn' / 'turns', and other plain plurals: `plural(9, 'turn')` -> '9 turns'. */
export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`
