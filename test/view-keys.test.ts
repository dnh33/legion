/**
 * The F1/F2/F3 view bindings, tested as the pure rule they are.
 *
 * These exist because the binding is a *navigation* claim: it says a key always takes you to a view. If it silently
 * did nothing — or fired on a modified key and threw you out of the view you were working in — nothing else in the
 * app would notice. So the mapping, the modifier guard, and the fact that `project` is not reachable are all asserted
 * here rather than left to whoever next touches the key handler.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { VIEW_KEYS, VIEW_KEY_LABELS, viewForKey } from '../ui/src/viewKeys.js';

test('F1, F2 and F3 go to Chat, Rooms and Lattice', () => {
  assert.equal(viewForKey('F1'), 'chat');
  assert.equal(viewForKey('F2'), 'rooms');
  assert.equal(viewForKey('F3'), 'graph');
});

test('the labels match the bindings, so the button hint cannot drift from the key', () => {
  // The tab buttons advertise F1/F2/F3. If one key moved and a label did not, the app would be lying on screen.
  assert.deepEqual(VIEW_KEY_LABELS, { chat: 'F1', rooms: 'F2', graph: 'F3' });
  assert.deepEqual(VIEW_KEYS, { F1: 'chat', F2: 'rooms', F3: 'graph' });
  for (const [view, label] of Object.entries(VIEW_KEY_LABELS)) {
    assert.equal(VIEW_KEYS[label as keyof typeof VIEW_KEYS], view, `${label} advertises ${view} but does not go there`);
  }
});

test('a modified key is never ours', () => {
  // Ctrl+F1 and friends belong to other software. Firing on them would yank the user out of the current view while
  // some other shortcut ran.
  assert.equal(viewForKey('F1', { ctrlKey: true }), null);
  assert.equal(viewForKey('F2', { ctrlKey: true }), null);
  assert.equal(viewForKey('F3', { metaKey: true }), null);
  assert.equal(viewForKey('F1', { altKey: true }), null);
  // Shift is deliberately NOT part of the guard: Shift+F1 is still F1 to the platform, and there is nothing to steal.
  // The type says so too - shiftKey is not an input, so passing it cannot change the answer.
  assert.equal(viewForKey('F1', {}), 'chat');
});

test('other keys are ignored, including the function keys nobody bound', () => {
  for (const k of ['F4', 'F5', 'F12', 'Enter', 'Escape', 'a', 'Tab', ' ']) {
    assert.equal(viewForKey(k), null, `${k} should not switch the view`);
  }
});

test('project is not reachable from the keyboard', () => {
  // It is a drill-down from Library, not a peer of the other three. Binding it would let a key drop you out of a
  // project with no way back except the tab.
  const bound = Object.values(VIEW_KEYS);
  assert.ok(!bound.includes('project' as never), 'project must not be bound to a key');
  assert.equal(bound.length, 3, 'exactly three views are bound');
});