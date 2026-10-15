/**
 * A card's own keys (an approval's A and D, a question's pick and submit) wait for the same arm as the window shortcut: ARM_MS after the card
 * appeared or took focus, and ARM_MS after the last key on the page. One rule (isArmed) and one clock (keyClock), read by both paths.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ARM_MS, isArmed } from '../src/shared/approval-keys.js';
import { createKeyClock } from '../ui/src/a11y/keyClock.js';

const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

test('isArmed: armed ARM_MS after the later of the card appearing (or taking focus) and the last key, and not before', () => {
  assert.equal(isArmed(0, 0, ARM_MS - 1), false);
  assert.equal(isArmed(0, 0, ARM_MS), true);
  assert.equal(isArmed(0, 900, 1500), false, 'a key 600 ms ago restarts the quiet period');
  assert.equal(isArmed(0, 900, 1900), true);
  assert.equal(isArmed(1200, 0, 1500), false, 'a card that took focus at 1200 waits until 2200');
  assert.equal(isArmed(1200, 0, 2200), true);
});

test('the key clock: each key is recorded once, and every reader of the same key gets the same answer', () => {
  const clock = createKeyClock();
  const k1 = {}, k2 = {}, k3 = {};
  assert.equal(clock.note(k1, 100), 0, 'no key before the first');
  assert.equal(clock.note(k2, 300), 100, 'the key before k2 was at 100');
  assert.equal(clock.note(k2, 300), 100, 'read again for the same key: the same answer');
  assert.equal(clock.note(k3, 900), 300);
});

test('ApprovalCard: its own A and D wait for the arm, checked before either key acts', () => {
  const card = src('ui/src/components/ApprovalCard.tsx');
  assert.match(card, /const arm = useCardArm\(\);/);
  const handler = card.slice(card.indexOf('onKeyDown={(e) => {'), card.indexOf('<div className="approval-head">'));
  const armed = handler.indexOf('const ok = arm.armed(e.nativeEvent);');
  assert.ok(armed > 0, 'the handler asks the arm first');
  assert.ok(armed < handler.indexOf("e.key === 'a'"), 'before A');
  assert.ok(armed < handler.indexOf("e.key === 'd'"), 'before D');
  assert.match(handler, /if \(!ok \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;/);
});

test('QuestionCard: picking an option and submitting wait for the arm; moving the highlight does not', () => {
  const q = src('ui/src/components/QuestionCard.tsx');
  assert.match(q, /const arm = useCardArm\(\);/);
  const body = q.slice(q.indexOf('const onKeyDown = (e: React.KeyboardEvent) => {'), q.indexOf('const submit = () => {'));
  const ok = body.indexOf('const ok = arm.armed(e.nativeEvent);');
  assert.ok(ok > 0, 'the handler asks the arm');
  assert.match(body, /if \(!ok && \(act\.kind === 'pick' \|\| act\.kind === 'submit'\)\) return;/);
  assert.ok(body.indexOf("act.kind === 'move'") > ok, 'moving stays free');
});

test('the window shortcut and the cards read one clock and one rule (the arithmetic lives in isArmed, not in Thread)', () => {
  const thread = src('ui/src/components/Thread.tsx');
  assert.match(thread, /quietSince = quietBefore\(e, now\)/);
  assert.match(thread, /isArmed\(shownAt\.current\.get\(a\.id\) \?\? now, quietSince, now\)/);
  assert.doesNotMatch(thread, /lastKeyAt/, 'the page clock is shared, not a per-thread ref');
});
