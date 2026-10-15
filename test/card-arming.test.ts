/**
 * A card answers its own keys (an approval's A and D, a question's pick and submit) and its own keyboard clicks only once it is armed: ARM_MS
 * after it appeared or took focus from outside, and after the last key on the page. One rule (isArmed), one clock, one appearance store, and
 * the card's arm (createCardArm) are pure and tested here; the wiring in the components is checked by source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ARM_MS, isArmed } from '../src/shared/approval-keys.js';
import { createAppearances, createCardArm, createKeyClock, isNavKey } from '../ui/src/a11y/keyClockCore.js';

const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const container = (inner: object) => ({ contains: (n: unknown) => n === inner });

test('isArmed: armed ARM_MS after the later of the card appearing (or taking focus) and the last key, and not before', () => {
  assert.equal(isArmed(0, 0, ARM_MS - 1), false);
  assert.equal(isArmed(0, 0, ARM_MS), true);
  assert.equal(isArmed(0, 900, 1500), false, 'a key 600 ms ago restarts the quiet period');
  assert.equal(isArmed(0, 900, 1900), true);
  assert.equal(isArmed(1200, 0, 1500), false, 'a card that took focus at 1200 waits until 2200');
  assert.equal(isArmed(1200, 0, 2200), true);
});

test('the key clock: each key is recorded once, every reader of the same key gets the same answer, navigation keys record nothing', () => {
  const clock = createKeyClock();
  const k1 = {}, k2 = {}, k3 = {}, arrow = {};
  assert.equal(clock.note(k1, 100, 'x'), 0, 'no key before the first');
  assert.equal(clock.note(k2, 300, 'x'), 100, 'the key before k2 was at 100');
  assert.equal(clock.note(k2, 300, 'x'), 100, 'read again for the same key: the same answer');
  assert.equal(clock.note(arrow, 500, 'ArrowDown'), 300, 'an arrow reads the last key and records nothing');
  assert.equal(clock.last(), 300);
  assert.equal(clock.note(k3, 900, 'a'), 300);
  assert.equal(isNavKey('Tab') && isNavKey('ArrowLeft') && !isNavKey('a'), true);
});

test('the window stamps the clock on focus and on becoming visible: a card waits ARM_MS after either', () => {
  const clock = createKeyClock();
  clock.stamp(500);
  const arm = createCardArm(clock, () => 0);
  assert.equal(arm.armedNow(1499), false, 'the window came back at 500: not armed before 1500');
  assert.equal(arm.armedNow(1500), true);
});

test('held key: every repeat restarts the quiet period, so a held A never arms the card; a repeat never answers', () => {
  const clock = createKeyClock();
  const arm = createCardArm(clock, () => 0);
  for (let t = 100; t <= 2000; t += 100) assert.equal(arm.key({}, 'a', false, t), false, `a press at ${t} ms is too soon`);
  assert.equal(arm.key({}, 'a', true, 2600), false, 'a repeat never answers, however long it has been');
  assert.equal(arm.key({}, 'a', false, 2600 + ARM_MS), true, 'a fresh press after the quiet period answers');
});

test('bubbling focus: a move between the card\'s own controls does not restart the arm; focus from outside does', () => {
  const inner = {};
  const outside = {};
  const clock = createKeyClock();
  const arm = createCardArm(clock, () => 0);
  arm.enterFrom(container(inner), inner, 900);
  assert.equal(arm.armedNow(1000), true, 'a move inside (the focus event bubbles from a button) restarts nothing');
  arm.enterFrom(container(inner), outside, 900);
  assert.equal(arm.armedNow(1500), false, 'focus from outside restarts the arm');
  assert.equal(arm.armedNow(1900), true);
  arm.enterFrom(container(inner), null, 2000);
  assert.equal(arm.armedNow(2500), false, 'focus with no earlier element (from the window) counts as from outside');
});

test('remount: a card that mounts again keeps its appearance, so it does not re-arm; a reveal restarts it on purpose', () => {
  const clock = createKeyClock();
  const appear = createAppearances();
  const first = createCardArm(clock, () => appear.appearedAt('approval:x', 100));
  assert.equal(first.armedNow(1100), true);
  const remounted = createCardArm(clock, () => appear.appearedAt('approval:x', 900));
  assert.equal(appear.appearedAt('approval:x', 900), 100, 'the first sight is kept');
  assert.equal(remounted.armedNow(1100), true, 'a remount is armed at the same moment as before');
  appear.restart('approval:x', 2000);
  assert.equal(remounted.armedNow(2500), false, 'a reveal starts the wait again');
  assert.equal(remounted.armedNow(3000), true);
});

test('a keyboard-synthesised click (detail 0) needs the arm; a mouse click (detail 1 or more) never waits', () => {
  const clock = createKeyClock();
  const arm = createCardArm(clock, () => 0);
  assert.equal(arm.click(0, 500), false, 'an Enter or Space on Allow before the arm does nothing');
  assert.equal(arm.click(1, 500), true, 'a mouse click is immediate');
  assert.equal(arm.click(0, ARM_MS), true, 'a keyboard click after the arm works');
});

test('the Enter that causes a click decides the click: armed Enter then its own click works, an unarmed one does not', () => {
  const clock = createKeyClock();
  const arm = createCardArm(clock, () => 0);
  assert.equal(arm.key({}, 'Enter', false, ARM_MS + 50), true, 'the Enter is armed');
  assert.equal(arm.click(0, ARM_MS + 51), true, 'its click follows at once and is allowed by that Enter');
  assert.equal(arm.click(0, ARM_MS + 52), false, 'the verdict is used once: a second click reads the arm again, and the Enter was just now');
  const early = createCardArm(createKeyClock(), () => 0);
  assert.equal(early.key({}, 'Enter', false, 300), false);
  assert.equal(early.click(0, 301), false, 'an unarmed Enter\'s click is ignored');
});

test('the appearance store: one first sight per item, pruned to the live items of its own prefix only', () => {
  const appear = createAppearances();
  assert.equal(appear.appearedAt('approval:a', 10), 10);
  assert.equal(appear.appearedAt('approval:a', 20), 10);
  appear.appearedAt('digest:d', 30);
  appear.prune('approval:', new Set(['approval:b']));
  assert.equal(appear.appearedAt('approval:a', 40), 40, 'a gone approval is forgotten');
  assert.equal(appear.appearedAt('digest:d', 50), 30, 'another owner\'s item is not touched');
});

test('ApprovalCard: its own A and D, and its Allow and Deny clicks, all ask the arm; the arm\'s hint and live note are wired', () => {
  const card = src('ui/src/components/ApprovalCard.tsx');
  assert.match(card, /useCardArm\(`approval:\$\{a\.id\}`\)/);
  assert.match(card, /arm\.key\(e\.nativeEvent, e\.key, e\.repeat, performance\.now\(\)\)/);
  assert.match(card, /onClick=\{\(e\) => \{ if \(!arm\.click\(e\.detail, performance\.now\(\)\)\) \{ notReady\(\); return; \} void decide\(a\.id, true\); \}\}/);
  assert.match(card, /onClick=\{\(e\) => \{ if \(!arm\.click\(e\.detail, performance\.now\(\)\)\) \{ notReady\(\); return; \} void decide\(a\.id, false\); \}\}/);
  assert.match(card, /data-armed=\{armed \? 'true' : 'false'\}/);
  assert.match(card, /Ready in a moment/);
  assert.match(card, /role="status" aria-live="polite"/);
  assert.match(card, /if \(!noKey && \(e\.key === 'a' \|\| e\.key === 'A'\)\)/, 'the Blender rule is unchanged');
});

test('QuestionCard: picking, submitting and the option clicks ask the arm; moving the highlight does not', () => {
  const q = src('ui/src/components/QuestionCard.tsx');
  assert.match(q, /useCardArm\(`question:\$\{q\.id\}`\)/);
  const body = q.slice(q.indexOf('const onKeyDown = (e: React.KeyboardEvent) => {'), q.indexOf('const submit = () => {'));
  assert.match(body, /const ok = arm\.key\(e\.nativeEvent, e\.key, e\.repeat, performance\.now\(\)\);/);
  assert.match(body, /if \(!ok && \(act\.kind === 'pick' \|\| act\.kind === 'submit'\)\) \{ if \(!e\.repeat\) notReady\(\); return; \}/);
  assert.ok(body.indexOf("act.kind === 'move'") > body.indexOf('const ok = arm.key('), 'moving stays free');
  assert.match(q, /onClick=\{\(e\) => \{ if \(!arm\.click\(e\.detail, performance\.now\(\)\)\) \{ notReady\(\); return; \} pick\(o\.label\); \}\}/);
  assert.match(q, /onClick=\{\(e\) => \{ if \(!arm\.click\(e\.detail, performance\.now\(\)\)\) \{ notReady\(\); return; \} submit\(\); \}\}/);
});

test('the window shortcut and the cards read one clock and one appearance store; the shortcut listens in capture phase', () => {
  const thread = src('ui/src/components/Thread.tsx');
  assert.match(thread, /quietSince = quietBefore\(e, now, e\.key\)/);
  assert.match(thread, /isArmed\(appearedAt\('approval:' \+ a\.id, now\), quietSince, now\)/);
  assert.doesNotMatch(thread, /shownAt|lastKeyAt/, 'the appearance and the clock are shared, not per thread');
  const clock = src('ui/src/a11y/keyClock.ts');
  assert.match(clock, /addEventListener\('keydown', [^;]*, true\)/, 'capture: a key stopPropagation-ed by a list still counts');
  assert.match(clock, /if \(shared\.installed\) return;|!shared\.installed/, 'installed once, also under HMR');
});

test('Digest: its A and D use the shared clock and rule, not a private clock', () => {
  const digest = src('ui/src/projects/page/Digest.tsx');
  assert.doesNotMatch(digest, /lastKeyAt|now - Math\.max/);
  assert.match(digest, /quietBefore\(e\.nativeEvent, now, e\.key\)/);
  assert.match(digest, /isArmed\(appearedAt\('digest:' \+ row\.key, now\), quiet, now\)/);
});
