/** H2: the "Updating Legion" window's own rules: when it closes (orphan, hard cap, done, failed), the lock hand-over, the commands from the helper, and what it shows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_DONE_SHOW_MS, WINDOW_FAIL_LINGER_MS, WINDOW_HARD_CAP_MS, WINDOW_ORPHAN_GRACE_MS, lockAction, noticeAfterWindow, parseCommands, pendingCommands, windowDecision, windowModel } from '../src/core/updater/update-window-logic.js';
import { foldJourney, type JourneyEvent, type JourneyStepId } from '../src/core/updater/journey.js';

const T0 = 1_000_000;
const base = { openedAt: T0, helperDeadForMs: 0 };
const ev = (step: JourneyStepId, state: JourneyEvent['state'], over: Partial<JourneyEvent> = {}): JourneyEvent => ({ at: '2026-10-15T10:00:00.000Z', id: 'ab12cd34', step, state, proc: 'helper', from: '0.3.1', to: '0.3.2', ...over });

test('H2 window: it stays while the helper works, and closes when the helper has been gone for the grace time with no result (an orphan)', () => {
  assert.deepEqual(windowDecision({ ...base }, T0 + 60_000), { close: false });
  assert.deepEqual(windowDecision({ ...base, helperDeadForMs: WINDOW_ORPHAN_GRACE_MS - 1 }, T0 + 60_000), { close: false }, 'a helper that just ended may still be writing its last line');
  assert.deepEqual(windowDecision({ ...base, helperDeadForMs: WINDOW_ORPHAN_GRACE_MS }, T0 + 60_000), { close: true, reason: 'orphan' });
});

test('H2 window: a hard cap ends it whatever else is true', () => {
  assert.deepEqual(windowDecision({ ...base }, T0 + WINDOW_HARD_CAP_MS - 1), { close: false });
  assert.deepEqual(windowDecision({ ...base }, T0 + WINDOW_HARD_CAP_MS), { close: true, reason: 'hard-cap' });
  assert.deepEqual(windowDecision({ ...base, finish: { result: 'failed', at: T0 + 10 } }, T0 + WINDOW_HARD_CAP_MS), { close: true, reason: 'hard-cap' });
});

test('H2 window: after the helper says ok it shows Done for a moment, then closes', () => {
  const finish = { result: 'ok' as const, at: T0 + 5000 };
  assert.deepEqual(windowDecision({ ...base, finish }, T0 + 5000 + WINDOW_DONE_SHOW_MS - 1), { close: false });
  assert.deepEqual(windowDecision({ ...base, finish }, T0 + 5000 + WINDOW_DONE_SHOW_MS), { close: true, reason: 'done' });
  assert.deepEqual(windowDecision({ ...base, finish, helperDeadForMs: 60_000 }, T0 + 5000 + 100), { close: false }, 'a helper that has ended after finishing is not an orphan');
});

test('H2 window: a failure stays on screen until the person chooses, with a long limit; it never just disappears', () => {
  const finish = { result: 'failed' as const, message: 'x', at: T0 + 5000 };
  assert.deepEqual(windowDecision({ ...base, finish, helperDeadForMs: 60_000 }, T0 + 5000 + 60_000), { close: false });
  assert.deepEqual(windowDecision({ ...base, finish }, T0 + 5000 + WINDOW_FAIL_LINGER_MS), { close: true, reason: 'failed-linger' });
  assert.deepEqual(windowDecision({ ...base, finish, choice: 'close' }, T0 + 6000), { close: true, reason: 'user-closed' });
  assert.deepEqual(windowDecision({ ...base, finish: { result: 'rolled-back', at: T0 }, choice: 'retry' }, T0 + 6000), { close: true, reason: 'user-retry' });
});

test('H2 lock: the window asks for the lock until it has it, gives it up when the helper says so, and never asks again', () => {
  assert.equal(lockAction({ held: false, released: false }, { releaseRequested: false, finished: false, appGone: true }), 'request', 'the old app may still hold it: keep asking');
  assert.equal(lockAction({ held: true, released: false }, { releaseRequested: false, finished: false, appGone: true }), 'none');
  assert.equal(lockAction({ held: true, released: false }, { releaseRequested: true, finished: false, appGone: true }), 'release');
  assert.equal(lockAction({ held: false, released: true }, { releaseRequested: true, finished: false, appGone: true }), 'none', 'after the hand-over the new build owns it');
  assert.equal(lockAction({ held: false, released: false }, { releaseRequested: true, finished: false, appGone: true }), 'none', 'a hand-over asked for before the window got the lock: do not take it now');
  assert.equal(lockAction({ held: false, released: false }, { releaseRequested: false, finished: true, appGone: true }), 'none', 'a finished window never takes the lock');
  assert.equal(lockAction({ held: false, released: false }, { releaseRequested: false, finished: false, appGone: false }), 'none', 'the old app is still closing: asking now would pull its window forward');
});

test('H2 commands: the helper writes numbered lines; the window handles each once, in order, and skips damaged lines', () => {
  const text = [JSON.stringify({ seq: 1, cmd: 'release-lock' }), 'junk', JSON.stringify({ seq: 2, cmd: 'finish', result: 'ok' }), JSON.stringify({ seq: 3, cmd: 'bogus' }), ''].join('\n');
  assert.deepEqual(parseCommands(text).map((c) => c.seq), [1, 2]);
  assert.deepEqual(pendingCommands(text, 0).map((c) => c.cmd), ['release-lock', 'finish']);
  assert.deepEqual(pendingCommands(text, 1).map((c) => c.cmd), ['finish']);
  assert.deepEqual(pendingCommands(text, 2), []);
});

test('H2 model: while the helper works the window lists the steps, checks the earlier ones and marks the current one', () => {
  const v = foldJourney([ev('ready', 'done', { proc: 'core', kind: 'code' }), ev('closing', 'done'), ev('installing', 'start')])!;
  const m = windowModel(v, undefined);
  assert.equal(m.title, 'Updating Legion'); assert.equal(m.subtitle, '0.3.1 to 0.3.2');
  assert.deepEqual(m.rows.map((r) => `${r.label}:${r.state}`), [
    'Downloaded and verified:done', 'Closing Legion:done', 'Installing:active', 'Starting the new version:pending', 'Checking that it runs:pending', 'Done:pending',
  ], 'Preparing is for full updates only');
  assert.deepEqual(m.bar, { mode: 'sweep' }); assert.deepEqual(m.buttons, []); assert.equal(m.tone, 'working');
});

test('H2 model: a full update shows Preparing with its percent in the bar', () => {
  const v = foldJourney([ev('closing', 'done', { kind: 'full' }), ev('preparing', 'start', { pct: 42 })])!;
  const m = windowModel(v, undefined);
  assert.ok(m.rows.some((r) => r.label === 'Preparing' && r.state === 'active'));
  assert.deepEqual(m.bar, { mode: 'pct', pct: 42 });
});

test('H2 model: before any event the window still says what it is doing', () => {
  const m = windowModel(null, undefined);
  assert.equal(m.title, 'Updating Legion'); assert.equal(m.subtitle, ''); assert.equal(m.rows.find((r) => r.label === 'Closing Legion')?.state, 'active', 'closing is under way'); assert.deepEqual(m.bar, { mode: 'sweep' });
});

test('H2 model: done is shown as done; a failure gives the plain reason with Retry and Close; a rollback says so', () => {
  const v = foldJourney([ev('closing', 'done'), ev('health', 'done')])!;
  const ok = windowModel(v, { result: 'ok', at: 1 });
  assert.equal(ok.title, 'Legion is updated'); assert.ok(ok.rows.every((r) => r.state === 'done')); assert.deepEqual(ok.bar, { mode: 'full' }); assert.equal(ok.tone, 'ok');
  const f = foldJourney([ev('closing', 'start'), ev('failed', 'done', { during: 'closing', note: 'the app did not exit in time; nothing was changed' })])!;
  const bad = windowModel(f, { result: 'failed', at: 1 });
  assert.equal(bad.title, 'The update did not finish'); assert.match(bad.message ?? '', /Legion did not close in time/); assert.match(bad.message ?? '', /Your files are unchanged/);
  assert.deepEqual(bad.buttons, ['Retry', 'Close']); assert.equal(bad.tone, 'failed'); assert.deepEqual(bad.bar, { mode: 'none' });
  assert.equal(bad.rows.find((r) => r.label === 'Closing Legion')?.state, 'failed');
  const rb = windowModel(foldJourney([ev('health', 'start'), ev('rolled-back', 'done', { during: 'health', note: 'the new build did not report healthy' })])!, { result: 'rolled-back', at: 1 });
  assert.equal(rb.title, 'Went back to the previous version'); assert.equal(rb.tone, 'failed');
});

test('H2 model: with no reason the failure still reads plainly, and nothing says "this computer" or uses a long dash', () => {
  const m = windowModel(foldJourney([ev('closing', 'start'), ev('failed', 'done', { during: 'closing' })])!, { result: 'failed', at: 1 });
  assert.match(m.message ?? '', /Something went wrong/);
  for (const text of [m.title, m.subtitle, m.message ?? '', m.footer, ...m.rows.map((r) => r.label)]) { assert.equal(/[—–]/.test(text), false, text); assert.equal(/this (computer|machine)/i.test(text), false, text); }
});

test('H2 notice: a window still open owns the question; its Retry retries without a second dialog; its Close stays quiet; no answer falls back to the dialog', () => {
  assert.equal(noticeAfterWindow({ open: true }, 'ab12cd34'), 'wait');
  assert.equal(noticeAfterWindow({ open: false, result: { id: 'ab12cd34', choice: 'retry' } }, 'ab12cd34'), 'retry');
  assert.equal(noticeAfterWindow({ open: false, result: { id: 'ab12cd34', choice: 'close' } }, 'ab12cd34'), 'quiet');
  assert.equal(noticeAfterWindow({ open: false, result: { id: 'ab12cd34', choice: 'timeout' } }, 'ab12cd34'), 'ask');
  assert.equal(noticeAfterWindow({ open: false, result: { id: 'old00000', choice: 'retry' } }, 'ab12cd34'), 'ask', 'an answer about another update is not an answer');
  assert.equal(noticeAfterWindow({ open: false, result: null }, 'ab12cd34'), 'ask');
});

test('H2 model: a reason the plain-words list does not know still starts with a capital letter', () => {
  const m = windowModel(foldJourney([ev('closing', 'start'), ev('failed', 'done', { during: 'closing', note: 'the staged tree is odd' })])!, { result: 'failed', at: 1 });
  assert.equal(m.message, 'The staged tree is odd. Your files are unchanged.');
});
