import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedLabel } from '../ui/src/chat/elapsed.js';

test('the working row\'s clock reads plainly at every scale, and a clock skew never shows a negative time', () => {
  assert.equal(elapsedLabel(0), '0s');
  assert.equal(elapsedLabel(45_400), '45s');
  assert.equal(elapsedLabel(60_000), '1m 00s');
  assert.equal(elapsedLabel(134_000), '2m 14s');
  assert.equal(elapsedLabel(3_599_000), '59m 59s');
  assert.equal(elapsedLabel(3_780_000), '1h 03m');
  assert.equal(elapsedLabel(-5_000), '0s');
});
