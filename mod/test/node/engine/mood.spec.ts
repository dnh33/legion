import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MoodState } from '../../../types/index.d.ts'
import { nextMood } from '../../../src/engine/mood.ts'
import { MOOD_DWELL_MS, URGENT_MOODS } from '../../../src/theme.ts'
import { readRepo } from './_src.ts'

test('nextMood: first mood, same mood, urgent at once, calm after the dwell (the desktop 1.8 s), deferred inside it', () => {
  // the dwell is the desktop's (ui/src/mascot/useBustState.ts MIN_DWELL_MS); theme.ts holds the mod's copy
  assert.match(readRepo('ui/src/mascot/useBustState.ts'), /export const MIN_DWELL_MS = 1800;/)
  assert.equal(MOOD_DWELL_MS, 1800)
  const t0 = 10_000
  const cur: MoodState = { mood: 'thinking', since: t0, note: 'a' }

  assert.deepEqual(nextMood(undefined, 'hacking', t0), { state: { mood: 'hacking', since: t0 } })
  assert.deepEqual(nextMood(undefined, 'idle', t0, 'n'), { state: { mood: 'idle', since: t0, note: 'n' } })

  assert.equal(nextMood(cur, 'thinking', t0 + 5).state, cur, 'same mood: same object')
  assert.equal(nextMood(cur, 'thinking', t0 + 5, 'a').state, cur)
  assert.deepEqual(nextMood(cur, 'thinking', t0 + 5, 'b'), { state: { mood: 'thinking', since: t0, note: 'b' } }, 'note replaced, since kept')

  for (const urgent of URGENT_MOODS) assert.deepEqual(nextMood(cur, urgent, t0 + 1), { state: { mood: urgent, since: t0 + 1 } }, urgent)
  assert.deepEqual([...URGENT_MOODS].sort(), ['awaiting', 'error'])

  assert.deepEqual(nextMood(cur, 'hacking', t0 + 100), { state: cur, recheckAt: t0 + MOOD_DWELL_MS })
  assert.deepEqual(nextMood(cur, 'victory', t0 + MOOD_DWELL_MS - 1), { state: cur, recheckAt: t0 + MOOD_DWELL_MS })
  assert.deepEqual(nextMood(cur, 'hacking', t0 + MOOD_DWELL_MS), { state: { mood: 'hacking', since: t0 + MOOD_DWELL_MS } })
  assert.deepEqual(nextMood(cur, 'idle', t0 + 60_000, 'z'), { state: { mood: 'idle', since: t0 + 60_000, note: 'z' } })

  // leaving an urgent mood for a calm one also waits out the dwell
  const awaiting: MoodState = { mood: 'awaiting', since: t0 }
  assert.deepEqual(nextMood(awaiting, 'hacking', t0 + 10), { state: awaiting, recheckAt: t0 + MOOD_DWELL_MS })
})
