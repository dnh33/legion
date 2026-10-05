/**
 * Calm moods: each mood holds at least MOOD_DWELL_MS, so rapid tool events do not make an agent flicker; urgent moods switch at
 * once. The desktop rule (ui/src/mascot/useBustState.ts:5-7 and :103-108, ui/src/mascot/Relic.tsx:11 and :66-70) as a pure
 * function of the clock. The urgent set is theme.ts URGENT_MOODS. Pure.
 */
import type { Mood, MoodState } from '../../types/index.d.ts'
import { MOOD_DWELL_MS, URGENT_MOODS } from '../theme.ts'

export type MoodStep = {
  /** The mood to keep now. The same object as `current` when nothing changes. */
  state: MoodState
  /** Set when the wanted mood was deferred: check again at this time with the latest wanted mood (the latest wins). */
  recheckAt?: number
}

/**
 * The mood to show after an event wants `wanted` at `now`.
 * - No mood yet: `wanted` at once.
 * - Same mood: kept as it is (its `since` does not restart; a new note replaces the old one).
 * - An urgent mood (theme.ts URGENT_MOODS): at once.
 * - Otherwise: at once if the current mood has shown for MOOD_DWELL_MS, else deferred to `since + MOOD_DWELL_MS`.
 */
export function nextMood(current: MoodState | undefined, wanted: Mood, now: number, note?: string): MoodStep {
  const fresh = (): MoodStep => ({ state: { mood: wanted, since: now, ...(note !== undefined ? { note } : {}) } })
  if (!current) return fresh()
  if (current.mood === wanted) {
    if (note === undefined || note === current.note) return { state: current }
    return { state: { ...current, note } }
  }
  if (URGENT_MOODS.has(wanted)) return fresh()
  const due = current.since + MOOD_DWELL_MS
  if (now >= due) return fresh()
  return { state: current, recheckAt: due }
}
