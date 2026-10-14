/** Focus never falls to the page body after a row is removed (spec 3.2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFocusKey } from '../ui/src/projects/focus.js';

test('the same control survives: focus stays on it', () => {
  assert.equal(pickFocusKey(['a:allow', 'b:allow', 'c:allow'], 'b:allow', ['a:allow', 'b:allow', 'c:allow'], 'region'), 'b:allow');
});
test('the control left: the next surviving sibling gets focus', () => {
  assert.equal(pickFocusKey(['a:allow', 'b:allow', 'c:allow'], 'b:allow', ['a:allow', 'c:allow'], 'region'), 'c:allow');
});
test('it was the last one: the previous sibling gets focus', () => {
  assert.equal(pickFocusKey(['a:allow', 'b:allow', 'c:allow'], 'c:allow', ['a:allow', 'b:allow'], 'region'), 'b:allow');
});
test('a run of removed siblings is skipped', () => {
  assert.equal(pickFocusKey(['a', 'b', 'c', 'd'], 'b', ['a', 'd'], 'region'), 'd');
});
test('nothing survives: the region takes focus, never null', () => {
  assert.equal(pickFocusKey(['a'], 'a', [], 'region'), 'region');
});
test('an anchor that was never in the list lands on the region', () => {
  assert.equal(pickFocusKey(['a'], 'zzz', ['a'], 'region'), 'region');
});
