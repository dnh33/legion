/** H2: the badge and the panel speak the journey's step names; the "Updated to X" notice shows once; the window is a setting; Settings, About lists the last journey. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { pureBadgeState } from '../ui/src/updateBadgeState.js';
import { journeyRows } from '../ui/src/updateJourneyView.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

test('H2 badge: while bytes arrive it says Downloading with the bytes; once every byte is in it says Verifying the signature', () => {
  const d = pureBadgeState({ phase: 'downloading', available: { version: '0.9.9' }, progress: { bytes: 114_000_000, total: 285_000_000 } });
  assert.equal(d.label, 'Downloading'); assert.equal(d.detail, '40%'); assert.match(d.title, /114\.0 MB of 285\.0 MB/);
  const v = pureBadgeState({ phase: 'downloading', available: { version: '0.9.9' }, progress: { bytes: 285_000_000, total: 285_000_000 } });
  assert.equal(v.kind, 'verifying'); assert.equal(v.label, 'Verifying the signature'); assert.equal(v.tone, 'progress');
});

test('H2 badge: committing is step 5, Closing Legion', () => {
  const b = pureBadgeState({ phase: 'committing' });
  assert.equal(b.label, 'Closing Legion'); assert.equal(b.kind, 'installing');
});

test('H2 badge: after an update landed it says Updated to X with What\'s new, once; a running download or a staged update outranks it', () => {
  const u = pureBadgeState({ phase: 'idle', updated: { version: '0.3.2', id: 'ab12cd34' } });
  assert.equal(u.visible, true); assert.equal(u.kind, 'updated'); assert.equal(u.label, 'Updated to 0.3.2'); assert.equal(u.detail, 'What\'s new'); assert.equal(u.action, 'none');
  assert.equal(pureBadgeState({ phase: 'idle', updated: null }).visible, false, 'dismissed: gone');
  assert.equal(pureBadgeState({ phase: 'downloading', updated: { version: '0.3.2', id: 'ab12cd34' }, progress: { bytes: 1, total: 100 } }).kind, 'downloading');
  assert.equal(pureBadgeState({ phase: 'staged', staged: { version: '0.3.3' }, updated: { version: '0.3.2', id: 'ab12cd34' } }).kind, 'ready');
});

test('H2 about: the journey list has one row per step with the state, the time and, when it failed, the reason; Preparing is left out of a code update', () => {
  const steps = [
    { id: 'checking', n: '1', label: 'Checking for the update', where: 'app', state: 'done', at: '2026-10-15T10:00:00.000Z' },
    { id: 'preparing', n: '6', label: 'Preparing', where: 'helper', state: 'skipped' },
    { id: 'installing', n: '7', label: 'Installing', where: 'helper', state: 'failed', at: '2026-10-15T10:00:30.000Z' },
    { id: 'health', n: '9', label: 'Checking that it runs', where: 'helper', state: 'pending' },
  ];
  const rows = journeyRows({ id: 'ab12cd34', from: '0.3.1', to: '0.3.2', kind: 'code', steps, result: 'failed', reason: 'files in use', startedAt: 'x' } as never);
  assert.deepEqual(rows.map((r) => `${r.label}:${r.state}`), ['Checking for the update:done', 'Installing:failed', 'Checking that it runs:pending']);
  assert.match(rows[0]!.when, /^\d{1,2}:\d\d:\d\d/);
  assert.equal(rows[2]!.when, '');
});

test('H2 panel: the window switch, the journey list and the step wording exist, and only plain text is rendered', () => {
  const panel = read('ui/src/components/UpdatePanel.tsx');
  assert.match(panel, /updateWindow/); assert.match(panel, /Show the Updating Legion window/); assert.match(panel, /JourneyList/);
  assert.match(panel, /Verifying the signature/); assert.match(panel, /Closing Legion/);
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(panel), false);
  const badge = read('ui/src/components/UpdateBadge.tsx');
  assert.match(badge, /ack-updated/); assert.match(badge, /What&apos;s new/);
});

test('H2 text: nothing the person reads uses a long dash or says "this computer"', () => {
  for (const f of ['ui/src/updateJourneyView.ts', 'src/core/updater/journey.ts', 'assets/update-window.html']) {
    const text = read(f).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.includes('/*')).join('\n');
    assert.equal(/this (computer|machine)/i.test(text), false, f);
  }
});
