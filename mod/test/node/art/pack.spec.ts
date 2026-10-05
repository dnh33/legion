import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeBase64, encodeBase64 } from '../../../src/art/b64.ts'
import { DEFAULT_COLOR, LOWER_HALF, UPPER_HALF, colorPairs, hexColor, pack, unpack } from '../../../src/art/pack.ts'
import type { Frame } from '../../../src/art/compose.ts'

const frame = (w: number, h: number, px: number[][]): Frame => {
  const rgba = new Uint8ClampedArray(w * h * 4)
  px.forEach((p, i) => rgba.set(p, i * 4))
  return { w, h, rgba }
}

test('base64 matches Node for every length 0..64 and round-trips', () => {
  for (let n = 0; n <= 64; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 255)
    const ours = encodeBase64(b)
    assert.equal(ours, Buffer.from(b).toString('base64'), `length ${n}`)
    assert.deepEqual(decodeBase64(ours), b)
  }
  assert.throws(() => decodeBase64('abc'), /multiple of 4/)
  assert.throws(() => decodeBase64('ab$='), /bad character/)
})

test('one cell is three little-endian u32s: U+2580, fg = top pixel, bg = bottom pixel', () => {
  const cells = pack(frame(1, 2, [[0x12, 0x34, 0x56, 255], [0xab, 0xcd, 0xef, 255]]), { panel: 0 })
  assert.deepEqual([...decodeBase64(cells)], [0x80, 0x25, 0, 0, 0x56, 0x34, 0x12, 0, 0xef, 0xcd, 0xab, 0])
  assert.deepEqual([...unpack(cells)], [0x2580, 0x123456, 0xabcdef])
  assert.equal(UPPER_HALF, 0x2580)
})

test('a cell with no art is a space in the terminal default colours (0x01000000)', () => {
  const words = unpack(pack(frame(1, 2, [[9, 9, 9, 0], [9, 9, 9, 0]]), { panel: 0x12151a }))
  assert.deepEqual([...words], [0x20, 0x01000000, 0x01000000])
  assert.equal(DEFAULT_COLOR, 0x01000000)
  assert.deepEqual([...decodeBase64(pack(frame(1, 2, [[0, 0, 0, 0], [0, 0, 0, 0]]), { panel: 0 }))], [0x20, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1])
})

test('panel mode: an uncovered half takes the panel colour; partial coverage blends over it', () => {
  const panel = hexColor('#12151a')
  assert.deepEqual([...unpack(pack(frame(1, 2, [[255, 0, 0, 255], [0, 0, 0, 0]]), { panel }))], [UPPER_HALF, 0xff0000, panel])
  assert.deepEqual([...unpack(pack(frame(1, 2, [[0, 0, 0, 0], [0, 255, 0, 255]]), { panel }))], [UPPER_HALF, panel, 0x00ff00])
  const w = unpack(pack(frame(1, 2, [[255, 255, 255, 128], [255, 255, 255, 255]]), { panel }))
  const k = 128 / 255
  const mix = (c: number): number => Math.round(255 * k + c * (1 - k))
  assert.equal(w[1], (mix(0x12) << 16) | (mix(0x15) << 8) | mix(0x1a))
})

test('terminal mode leaves uncovered halves to the terminal (U+2584 / U+2580 against the default)', () => {
  const o = { panel: 0x12151a, transparent: 'terminal' as const }
  assert.deepEqual([...unpack(pack(frame(1, 2, [[0, 0, 0, 0], [1, 2, 3, 255]]), o))], [0x2584, 0x010203, 0x01000000])
  assert.deepEqual([...unpack(pack(frame(1, 2, [[1, 2, 3, 255], [0, 0, 0, 0]]), o))], [0x2580, 0x010203, 0x01000000])
  assert.equal(LOWER_HALF, 0x2584)
})

test('cells are row-major, columns * rows triplets; an odd last pixel row is uncovered below', () => {
  const f = frame(2, 3, [[1, 0, 0, 255], [2, 0, 0, 255], [3, 0, 0, 255], [4, 0, 0, 255], [5, 0, 0, 255], [6, 0, 0, 255]])
  const w = unpack(pack(f, { panel: 0x0000ff }))
  assert.equal(w.length, 2 * 2 * 3)
  assert.deepEqual([...w], [UPPER_HALF, 0x010000, 0x030000, UPPER_HALF, 0x020000, 0x040000, UPPER_HALF, 0x050000, 0x0000ff, UPPER_HALF, 0x060000, 0x0000ff])
  assert.equal(colorPairs(pack(f, { panel: 0x0000ff })).size, 4)
})

test('hexColor reads #rrggbb and refuses anything else', () => {
  assert.equal(hexColor('#7CFFB2'), 0x7cffb2)
  assert.throws(() => hexColor('7CFFB2'))
})
