import { test } from 'node:test'
import assert from 'node:assert/strict'
import { count, duration, meter, money, relTime, tokens } from '../../../src/ui/format.ts'
import { cellWidth } from '../../../src/ui/text.ts'

test('money: ≈ always, cents, thousands, tiny, zero, unknown', () => {
  assert.equal(money(0.21), '≈$0.21')
  assert.equal(money(1234.56), '≈$1,234.56')
  assert.equal(money(1234567.891), '≈$1,234,567.89')
  assert.equal(money(0.004), '<≈$0.01')
  assert.equal(money(0.0099), '<≈$0.01')
  assert.equal(money(0.01), '≈$0.01')
  assert.equal(money(0.995), '≈$1.00')
  assert.equal(money(0), '≈$0.00')
  assert.equal(money(NaN), '≈$?')
  assert.equal(money(undefined), '≈$?')
  assert.equal(money(-1), '≈$?')
})

test('count caps at 99+ (or a given cap) and never shows a negative', () => {
  assert.equal(count(5), '5')
  assert.equal(count(99), '99')
  assert.equal(count(100), '99+')
  assert.equal(count(12, 9), '9+')
  assert.equal(count(-2), '0')
  assert.equal(count(NaN), '0')
  assert.equal(count(3.7), '3')
})

test('tokens: 987, 12.3k, 123k, 1.2M, never 1000k', () => {
  assert.equal(tokens(987), '987')
  assert.equal(tokens(12_345), '12.3k')
  assert.equal(tokens(12_000), '12k')
  assert.equal(tokens(99_960), '100k')
  assert.equal(tokens(123_456), '123k')
  assert.equal(tokens(999_499), '999k')
  assert.equal(tokens(999_600), '1M')
  assert.equal(tokens(1_234_567), '1.2M')
  assert.equal(tokens(0), '0')
  assert.equal(tokens(NaN), '0')
})

test('relTime: the desktop words, future as now', () => {
  const now = 10_000_000
  assert.equal(relTime(now - 5_000, now), 'now')
  assert.equal(relTime(now - 42_000, now), '42s')
  assert.equal(relTime(now - 5 * 60_000, now), '5m')
  assert.equal(relTime(now - 3 * 3_600_000, now), '3h')
  assert.equal(relTime(now - 2 * 86_400_000, now), '2d')
  assert.equal(relTime(now + 60_000, now), 'now')
  assert.equal(relTime(NaN, now), '')
})

test('duration: two units at most', () => {
  assert.equal(duration(0), '0s')
  assert.equal(duration(42_000), '42s')
  assert.equal(duration(304_000), '5m 4s')
  assert.equal(duration(300_000), '5m')
  assert.equal(duration((3 * 60 + 12) * 60_000), '3h 12m')
  assert.equal(duration((2 * 24 + 3) * 3_600_000), '2d 3h')
  assert.equal(duration(-5), '0s')
})

test('meter: exactly cells wide, eighth blocks, clamped, NaN-safe', () => {
  assert.equal(meter(0, 8, 8), '        ')
  assert.equal(meter(8, 8, 8), '████████')
  assert.equal(meter(4, 8, 8), '████    ')
  assert.equal(meter(1, 64, 8), '▏       ') // one eighth of one cell
  assert.equal(meter(3, 8, 1), '▍')
  assert.equal(meter(99, 8, 4), '████')
  assert.equal(meter(-5, 8, 4), '    ')
  assert.equal(meter(NaN, 8, 4), '    ')
  assert.equal(meter(4, 0, 4), '    ')
  assert.equal(meter(4, 8, 0), '')
  for (let v = 0; v <= 64; v++) assert.equal(cellWidth(meter(v, 64, 8)), 8, String(v))
})
