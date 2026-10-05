import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURRENT, PRICES, PRICES_AS_OF, PRICES_SOURCE, ZERO_TOKENS, addTokens, estimateUsd, familyOf, priceFor, tokensFromUsage,
} from '../../../src/engine/cost.ts'

test('the price table is pinned: every row as the pricing page listed it on 2026-10-05', () => {
  assert.equal(PRICES_AS_OF, '2026-10-05')
  assert.equal(PRICES_SOURCE, 'https://platform.claude.com/docs/en/about-claude/pricing')
  // [input, output, cache read, 5-minute cache write], USD per million tokens
  const pinned: Record<string, [number, number, number, number]> = {
    'fable-5-1': [10, 50, 0.25, 12.5], 'fable-5': [10, 50, 1, 12.5],
    'opus-5-5': [4, 20, 0.2, 5], 'opus-5': [5, 25, 0.5, 6.25], 'opus-4-8': [5, 25, 0.5, 6.25], 'opus-4-7': [5, 25, 0.5, 6.25],
    'opus-4-6': [5, 25, 0.5, 6.25], 'opus-4-5': [5, 25, 0.5, 6.25], 'opus-4-1': [15, 75, 1.5, 18.75], 'opus-4': [15, 75, 1.5, 18.75],
    'sonnet-5-5': [2, 10, 0.2, 2.5], 'sonnet-5': [2, 10, 0.2, 2.5], 'sonnet-4-6': [3, 15, 0.3, 3.75], 'sonnet-4-5': [3, 15, 0.3, 3.75],
    'sonnet-4': [3, 15, 0.3, 3.75], 'haiku-4-5': [1, 5, 0.1, 1.25], 'haiku-3-5': [0.8, 4, 0.08, 1],
  }
  assert.deepEqual(Object.keys(PRICES).sort(), Object.keys(pinned).sort())
  for (const [k, [i, o, r, w]] of Object.entries(pinned)) assert.deepEqual(PRICES[k], { input: i, output: o, cacheRead: r, cacheWrite: w }, k)
  // The page's multipliers: a 5-minute write is 1.25x input; a read is 0.1x, except Fable 5.1 (0.025x) and Opus 5.5 (0.05x).
  for (const [k, p] of Object.entries(PRICES)) {
    assert.ok(Math.abs(p.cacheWrite - p.input * 1.25) < 1e-9, `${k} write`)
    const readX = k === 'fable-5-1' ? 0.025 : k === 'opus-5-5' ? 0.05 : 0.1
    assert.ok(Math.abs(p.cacheRead - p.input * readX) < 1e-9, `${k} read`)
  }
  assert.deepEqual(CURRENT, { fable: 'fable-5-1', opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-4-5' })
})

test('familyOf and priceFor: aliases, full ids, dated ids, mythos, unknowns', () => {
  const cases: Array<[string | undefined, string, boolean]> = [
    ['opus', 'opus-5-5', false], ['sonnet', 'sonnet-5-5', false], ['haiku', 'haiku-4-5', false], ['fable', 'fable-5-1', false],
    ['claude-opus-5-5', 'opus-5-5', false], ['claude-opus-5', 'opus-5', false], ['claude-opus-4-8-20260101', 'opus-4-8', false],
    ['claude-opus-4-20250514', 'opus-4', false], ['claude-sonnet-4-6', 'sonnet-4-6', false], ['claude-sonnet-4-5-20250929', 'sonnet-4-5', false],
    ['claude-haiku-4-5-20251001', 'haiku-4-5', false], ['claude-fable-5', 'fable-5', false], ['claude-mythos-5-1', 'fable-5-1', false],
    ['CLAUDE-SONNET-5-5', 'sonnet-5-5', false], ['anthropic.claude-opus-5-5', 'opus-5-5', false], ['claude-opus-5-5[1m]', 'opus-5-5', false],
    ['claude-opus-7', 'opus-5-5', true], ['gpt-4o', 'sonnet-5-5', true], [undefined, 'sonnet-5-5', true], ['', 'sonnet-5-5', true],
  ]
  for (const [model, key, uncertain] of cases) {
    const r = priceFor(model)
    assert.equal(r.key, key, String(model))
    assert.equal(r.isEstimateUncertain, uncertain, `${model} uncertain`)
    assert.deepEqual(r.price, PRICES[key])
  }
  assert.equal(familyOf('claude-mythos-5'), 'fable')
  assert.equal(familyOf('nothing'), undefined)
})

test('estimateUsd: sums the four counts at their rates; junk counts cost nothing', () => {
  const m = 1_000_000
  const all = { input: m, output: m, cacheRead: m, cacheWrite: m }
  assert.equal(estimateUsd('opus', all).usd, 4 + 20 + 0.2 + 5)
  assert.equal(estimateUsd('claude-sonnet-4-6', { input: 2 * m, output: 0, cacheRead: 0, cacheWrite: 0 }).usd, 6)
  assert.equal(estimateUsd('claude-haiku-4-5', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }).usd, (1000 * 1 + 1000 * 5) / m)
  const u = estimateUsd('mystery', all)
  assert.equal(u.isEstimateUncertain, true)
  assert.equal(u.usd, 2 + 10 + 0.2 + 2.5)
  assert.equal(estimateUsd('opus', { input: -5, output: Number.NaN, cacheRead: Infinity, cacheWrite: 0 }).usd, 0)
  assert.equal(estimateUsd('opus', ZERO_TOKENS).usd, 0)
})

test('tokensFromUsage and addTokens', () => {
  assert.deepEqual(tokensFromUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  assert.deepEqual(tokensFromUsage(undefined), ZERO_TOKENS)
  assert.deepEqual(addTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 })
})
