import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackModel, moodTone } from '../../../src/art/stage-model.ts'
import { MOOD_WORDS } from '../../../src/theme.ts'

test('the fallback is the glyph and the exact mood word, the word dropped when it does not fit', () => {
  const m = fallbackModel('⌘', 'awaiting', 32, 18)
  assert.deepEqual(m, { glyph: '⌘', word: MOOD_WORDS.awaiting, tone: 'warn', showWord: true })
  assert.equal(fallbackModel('⌘', 'awaiting', 10, 6).showWord, false)
  assert.equal(fallbackModel('⌘', 'idle', 32, 1).showWord, false)
})

test('mood tones: amber needs you, red is a fault, asleep and idle are dim, working is accent', () => {
  assert.equal(moodTone('awaiting'), 'warn')
  assert.equal(moodTone('error'), 'danger')
  assert.equal(moodTone('annoyed'), 'danger')
  assert.equal(moodTone('sleeping'), 'muted')
  assert.equal(moodTone('idle'), 'muted')
  assert.equal(moodTone('hacking'), 'accent')
})
