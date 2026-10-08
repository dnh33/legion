/**
 * Title-bar update badge: the pure state machine pureBadgeState(status) in ui/src/updateBadgeState.ts — one arm per phase of
 * GET /api/update/status (nothing when no update, available, downloading with a percent, ready, installing, waiting) — plus
 * the download-percent clamp and the "installs when idle" rule that decides the ready hint.
 *
 * Negative (recorded): changing the ready arm's `detail` to always be 'installs when idle' turns
 * "ready: installs when idle vs install now" red (expected 'install now', got 'installs when idle'). It was reverted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadPct, installsWhenIdle, pureBadgeState } from '../ui/src/updateBadgeState.js';

test('no update anywhere in the status means nothing is shown', () => {
  assert.equal(pureBadgeState({}).visible, false);
  assert.equal(pureBadgeState({ phase: 'idle' }).visible, false);
  assert.equal(pureBadgeState({ phase: 'checking' }).visible, false);
  assert.equal(pureBadgeState({ phase: 'idle', available: null }).visible, false);
  assert.equal(pureBadgeState({ phase: 'idle' }).kind, 'none');
  // the hidden state carries no text at all
  const n = pureBadgeState({});
  assert.equal(n.label, '');
  assert.equal(n.title, '');
  assert.equal(n.action, 'none');
});

test('available update in idle/checking: "Update available" with the version, click opens settings', () => {
  for (const phase of ['idle', 'checking']) {
    const b = pureBadgeState({ phase, available: { version: '0.9.9' } });
    assert.equal(b.visible, true);
    assert.equal(b.kind, 'available');
    assert.equal(b.label, 'Update available');
    assert.equal(b.detail, 'v0.9.9');
    assert.equal(b.tone, 'accent');
    assert.equal(b.action, 'settings');
  }
});

test('downloading: percentage from progress, and the state says work is under way', () => {
  const b = pureBadgeState({ phase: 'downloading', available: { version: '0.9.9' }, progress: { bytes: 42, total: 100 } });
  assert.equal(b.visible, true);
  assert.equal(b.kind, 'downloading');
  assert.equal(b.detail, '42%');
  assert.equal(b.pct, 42);
  assert.equal(b.tone, 'progress');
  // no byte count yet -> still shown, but with no percentage to claim
  const none = pureBadgeState({ phase: 'downloading', progress: { bytes: 0, total: 0 } });
  assert.equal(none.visible, true);
  assert.equal(none.pct, null);
  assert.notEqual(none.detail, '0%');
});

test('ready: "installs when idle" only when auto-install is on and nothing is running, else "install now"', () => {
  const ready = { phase: 'staged', staged: { version: '0.9.9', kind: 'code' as const } };
  const idle = pureBadgeState({ ...ready, settings: { autoInstallWhenIdle: true }, busy: { idle: true, reasons: [] } });
  assert.equal(idle.kind, 'ready');
  assert.equal(idle.detail, 'installs when idle');
  assert.equal(idle.tone, 'ready');
  assert.equal(idle.action, 'settings');

  const now = pureBadgeState({ ...ready, settings: { autoInstallWhenIdle: true }, busy: { idle: false, reasons: ['a task is running'] } });
  assert.equal(now.detail, 'install now');

  const off = pureBadgeState({ ...ready, settings: { autoInstallWhenIdle: false }, busy: { idle: true } });
  assert.equal(off.detail, 'install now');

  // no settings/busy at all -> cannot promise an idle install
  assert.equal(pureBadgeState(ready).detail, 'install now');
  // staged without the phase flag still reads as ready
  assert.equal(pureBadgeState({ staged: { version: '1.2.3' } }).kind, 'ready');
});

test('installing (committing) outranks a download still finishing and is shown as busy', () => {
  const b = pureBadgeState({ phase: 'committing', available: { version: '0.9.9' }, staged: { version: '0.9.9' }, progress: { bytes: 50, total: 100 } });
  assert.equal(b.visible, true);
  assert.equal(b.kind, 'installing');
  assert.equal(b.label, 'Installing update…');
  assert.equal(b.tone, 'busy');
  assert.equal(b.action, 'settings');
});

test('awaiting-approval is visible and points at the update card', () => {
  const b = pureBadgeState({ phase: 'awaiting-approval', available: { version: '0.9.9' } });
  assert.equal(b.visible, true);
  assert.equal(b.kind, 'approval');
  assert.equal(b.action, 'settings');
});

test('downloadPct clamps to 0..100 and is null without a total', () => {
  assert.equal(downloadPct({ bytes: 0, total: 100 }), 0);
  assert.equal(downloadPct({ bytes: 100, total: 100 }), 100);
  assert.equal(downloadPct({ bytes: 250, total: 100 }), 100);
  assert.equal(downloadPct({ bytes: -5, total: 100 }), 0);
  assert.equal(downloadPct({ bytes: 1, total: 0 }), null);
  assert.equal(downloadPct(null), null);
  assert.equal(downloadPct(undefined), null);
});

test('installsWhenIdle needs auto-install on and the app not busy', () => {
  assert.equal(installsWhenIdle({ settings: { autoInstallWhenIdle: true }, busy: { idle: true } }), true);
  assert.equal(installsWhenIdle({ settings: { autoInstallWhenIdle: true }, busy: { idle: false } }), false);
  assert.equal(installsWhenIdle({ settings: { autoInstallWhenIdle: false }, busy: { idle: true } }), false);
  assert.equal(installsWhenIdle({}), false);
});
