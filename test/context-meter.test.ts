import test from 'node:test';
import assert from 'node:assert/strict';
import { contextLabel, contextTokensOf } from '../src/shared/context-meter.js';

test('the context in use is input plus cache read plus cache write, not the output', () => {
  assert.equal(contextTokensOf({ input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, output_tokens: 7_000 }), 52_010);
  assert.equal(contextTokensOf({ input_tokens: 1200 }), 1200);
});

test('missing or empty usage gives no number rather than 0 or NaN', () => {
  assert.equal(contextTokensOf(undefined), undefined);
  assert.equal(contextTokensOf(null), undefined);
  assert.equal(contextTokensOf({}), undefined);
  assert.equal(contextTokensOf({ input_tokens: 0, cache_read_input_tokens: 0 }), undefined);
  assert.equal(contextTokensOf({ input_tokens: 'a', cache_read_input_tokens: NaN, cache_creation_input_tokens: -5 }), undefined);
  assert.equal(contextTokensOf({ input_tokens: 'a', cache_read_input_tokens: 300 }), 300);
});

test('the label is tokens only, in thousands from 1000 up', () => {
  assert.equal(contextLabel(84_210), 'context 84k');
  assert.equal(contextLabel(999), 'context 999');
  assert.equal(contextLabel(1_000), 'context 1k');
  assert.equal(contextLabel(1_250_000), 'context 1250k');
});
