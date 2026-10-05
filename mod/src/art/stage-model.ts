/**
 * What the 2D Order's stage shows when it cannot draw cells: the agent's glyph and the mood word (plan section 5,
 * "Fallback"). Pure, so a Node spec can prove it; stage.tsx only turns it into elements.
 */
import type { Mood } from '../../types/index.d.ts'
import { MOOD_WORDS } from '../theme.ts'

export type FallbackTone = 'accent' | 'warn' | 'danger' | 'muted'

/** The mood word's tone: amber needs you, red is a fault, dim is asleep; working moods are "alive and yours". */
export const moodTone = (m: Mood): FallbackTone =>
  m === 'awaiting' ? 'warn' : m === 'error' || m === 'annoyed' ? 'danger' : m === 'sleeping' || m === 'idle' ? 'muted' : 'accent'

export type FallbackModel = { glyph: string; word: string; tone: FallbackTone; showWord: boolean }

/** The glyph and the mood word, the word dropped when the box is narrower than it (the glyph alone still says who). */
export function fallbackModel(glyph: string, mood: Mood, cols: number, rows: number): FallbackModel {
  const word = MOOD_WORDS[mood]
  return { glyph, word, tone: moodTone(mood), showWord: rows >= 2 && cols >= word.length }
}
