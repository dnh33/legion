import test from 'node:test';
import assert from 'node:assert/strict';
import { denyAt, isQuietAt, nextQuietBoundary, parkAt, validQuiet } from '../src/shared/ask-clock.js';
import type { QuietConfig } from '../src/shared/ask-clock.js';

const MIN = 60_000;
const q: QuietConfig = { enabled: true, from: '22:00', to: '07:00' };
/** A local wall-clock time, so the tests hold in any time zone the machine uses. */
const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('no quiet hours: the deny clock is the plain wait', () => {
  const t = at(2026, 3, 10, 12, 0);
  assert.equal(denyAt(t, 10 * MIN, undefined), t + 10 * MIN);
  assert.equal(denyAt(t, 10 * MIN, { enabled: false, from: '22:00', to: '07:00' }), t + 10 * MIN);
});

test('quiet window wraps midnight', () => {
  assert.equal(isQuietAt(at(2026, 3, 10, 23, 0), q), true);
  assert.equal(isQuietAt(at(2026, 3, 10, 3, 0), q), true);
  assert.equal(isQuietAt(at(2026, 3, 10, 7, 0), q), false, 'the end minute is outside');
  assert.equal(isQuietAt(at(2026, 3, 10, 22, 0), q), true, 'the start minute is inside');
  assert.equal(isQuietAt(at(2026, 3, 10, 12, 0), q), false);
});

test('quiet window inside one day', () => {
  const day: QuietConfig = { enabled: true, from: '13:00', to: '14:30' };
  assert.equal(isQuietAt(at(2026, 3, 10, 13, 59), day), true);
  assert.equal(isQuietAt(at(2026, 3, 10, 14, 30), day), false);
  assert.equal(isQuietAt(at(2026, 3, 10, 12, 59), day), false);
});

test('an ask raised inside quiet hours starts counting when quiet ends', () => {
  const asked = at(2026, 3, 10, 23, 30);
  assert.equal(denyAt(asked, 10 * MIN, q), at(2026, 3, 11, 7, 10));
});

test('an ask raised 4 minutes before quiet starts has 6 minutes left when quiet ends', () => {
  const asked = at(2026, 3, 10, 21, 56);
  assert.equal(denyAt(asked, 10 * MIN, q), at(2026, 3, 11, 7, 6));
});

test('an ask that finishes before quiet starts is unaffected', () => {
  const asked = at(2026, 3, 10, 21, 40);
  assert.equal(denyAt(asked, 10 * MIN, q), asked + 10 * MIN);
});

test('a long wait that spans a whole quiet window skips it once', () => {
  const asked = at(2026, 3, 10, 20, 0);
  // 2 h before quiet, then quiet (9 h), then the rest
  assert.equal(denyAt(asked, 3 * 60 * MIN, q), at(2026, 3, 11, 8, 0));
});

test('from equal to to is not a window: it counts as off', () => {
  const same: QuietConfig = { enabled: true, from: '22:00', to: '22:00' };
  assert.equal(validQuiet(same), undefined);
  assert.equal(isQuietAt(at(2026, 3, 10, 22, 0), same), false);
  const t = at(2026, 3, 10, 22, 0);
  assert.equal(denyAt(t, 10 * MIN, same), t + 10 * MIN);
});

test('bad times are not a window', () => {
  for (const bad of [{ enabled: true, from: '25:00', to: '07:00' }, { enabled: true, from: '22:00', to: 'x' }, { enabled: true, from: '2200', to: '07:00' }]) {
    assert.equal(validQuiet(bad as QuietConfig), undefined);
  }
  assert.deepEqual(validQuiet(q), q);
  assert.equal(validQuiet({ ...q, enabled: false }), undefined);
});

test('parking is not extended by quiet hours', () => {
  const asked = at(2026, 3, 10, 23, 0);
  assert.equal(parkAt(asked, 3), asked + 3 * MIN);
});

test('the next boundary is the next start or end of quiet', () => {
  assert.equal(nextQuietBoundary(at(2026, 3, 10, 12, 0), q), at(2026, 3, 10, 22, 0));
  assert.equal(nextQuietBoundary(at(2026, 3, 10, 23, 0), q), at(2026, 3, 11, 7, 0));
  assert.equal(nextQuietBoundary(at(2026, 3, 10, 12, 0), undefined), null);
});

test('daylight saving days: the window follows the wall clock, not 24 h', () => {
  // Days around the common spring-forward and fall-back dates. Whatever the zone, quiet ends at 07:00 local.
  for (const [m, d] of [[3, 8], [3, 9], [3, 29], [3, 30], [10, 25], [10, 26], [11, 1], [11, 2]] as const) {
    const asked = at(2026, m, d, 23, 0);
    const out = denyAt(asked, 10 * MIN, q)!;
    const dt = new Date(out);
    assert.equal(dt.getHours(), 7, `${m}/${d} ends at 07:xx local`);
    assert.equal(dt.getMinutes(), 10);
  }
});
