import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellWidth, cutCells, fit, padCells, ROSTER_GLYPHS, wrapCells } from '../../../src/ui/text.ts'
import { MARK } from '../../../src/theme.ts'

test('cellWidth: ASCII, wide CJK and fullwidth, emoji, combining marks', () => {
  assert.equal(cellWidth('Legion'), 6)
  assert.equal(cellWidth('漢字'), 4)
  assert.equal(cellWidth('ＡＢ'), 4)
  assert.equal(cellWidth('🚀'), 2)
  assert.equal(cellWidth('é'), 1) // e + combining acute
  assert.equal(cellWidth('a​b'), 2) // zero-width space
  assert.equal(cellWidth(''), 0)
})

test('cellWidth: emoji clusters count once (ZWJ family, flag, skin tone, VS16)', () => {
  assert.equal(cellWidth('👨‍👩‍👧'), 2)
  assert.equal(cellWidth('🇩🇰'), 2)
  assert.equal(cellWidth('👍🏽'), 2)
  assert.equal(cellWidth('❤️'), 2) // text heart + VS16 draws as emoji
  assert.equal(cellWidth('❤'), 1)
})

test('cellWidth: surrogate pairs are one code point, not two cells each', () => {
  assert.equal('𝐀'.length, 2)
  assert.equal(cellWidth('𝐀'), 1) // mathematical bold A: narrow, outside the BMP
})

test('cellWidth: every roster glyph and theme mark is 1 cell', () => {
  for (const g of [...ROSTER_GLYPHS, ...Object.values(MARK)]) assert.equal(cellWidth(g), 1, g)
})

test('fit: exactly cols cells, cut with an ellipsis, padded, right-aligned', () => {
  assert.equal(fit('Builder', 10), 'Builder   ')
  assert.equal(fit('Builder', 10, { align: 'right' }), '   Builder')
  assert.equal(fit('Forgemaster', 8), 'Forgema…')
  assert.equal(fit('Forgemaster', 8, { ellipsis: false }), 'Forgemas')
  assert.equal(fit('anything', 0), '')
  assert.equal(fit('x', -3), '')
  assert.equal(fit('a\nb\tc', 5), 'a b c')
})

test('fit: a wide cluster at the edge is left out and padded, never overrunning', () => {
  const out = fit('ab漢字', 5)
  assert.equal(cellWidth(out), 5)
  assert.equal(out, 'ab漢…')
  for (let n = 1; n < 12; n++) assert.equal(cellWidth(fit('漢字🚀👨‍👩‍👧 ok', n)), n, String(n))
})

test('padCells pads by cells, not code units; cutCells keeps clusters whole', () => {
  assert.equal(padCells('漢', 4), '漢  ')
  assert.equal(padCells('toolong', 3), 'toolong')
  assert.equal(cutCells('👨‍👩‍👧xyz', 3), '👨‍👩‍👧…')
})

test('wrapCells: words wrap, newlines kept, long words broken, each line within cols', () => {
  assert.deepEqual(wrapCells('one two three', 7), ['one two', 'three'])
  assert.deepEqual(wrapCells('a\n\nb', 5), ['a', '', 'b'])
  assert.deepEqual(wrapCells('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapCells('', 4), [''])
  for (const l of wrapCells('漢字漢字漢字 and some words 🚀🚀🚀🚀', 5)) assert.ok(cellWidth(l) <= 5, l)
})
