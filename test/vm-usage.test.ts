import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VmRecord } from '../src/shared/types.js';
import { closeRun, fmtDuration, localDay, sanitizeRates, usageLine, vmUsage } from '../src/shared/vm-usage.js';

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const rec = (o: Partial<VmRecord> = {}): VmRecord => ({ agentId: 'a', sandboxId: 'bx_1', state: 'ready', size: 'default', lastUsedAt: null, createdAt: null, ...o });

test('a running VM: runtime since start, today = finished runs + the current one', () => {
  const start = at(2026, 5, 1, 10, 0, 0);
  const now = start + 90_000;
  const u = vmUsage(rec({ runStartedAt: iso(start) }), now);
  assert.equal(u.running, true);
  assert.equal(u.runtimeSeconds, 90);
  assert.equal(u.todaySeconds, 90);
  const u2 = vmUsage(rec({ runStartedAt: iso(start), usageDay: localDay(now), usageSeconds: 600 }), now);
  assert.equal(u2.todaySeconds, 690);
});

test('a stopped VM has no runtime, only the day total; a total from another day does not count', () => {
  const now = at(2026, 5, 2, 9);
  const stopped = vmUsage(rec({ state: 'archived', runStartedAt: null, usageDay: localDay(now), usageSeconds: 120 }), now);
  assert.deepEqual([stopped.running, stopped.runtimeSeconds, stopped.todaySeconds], [false, 0, 120]);
  const yesterday = vmUsage(rec({ state: 'archived', usageDay: localDay(at(2026, 5, 1)), usageSeconds: 99999 }), now);
  assert.equal(yesterday.todaySeconds, 0);
});

test('a run that crosses midnight counts only the part after midnight as today', () => {
  const start = at(2026, 5, 1, 23, 30);
  const now = at(2026, 5, 2, 0, 20);
  const u = vmUsage(rec({ runStartedAt: iso(start) }), now);
  assert.equal(u.runtimeSeconds, 50 * 60);
  assert.equal(u.todaySeconds, 20 * 60);
  const closed = closeRun(rec({ runStartedAt: iso(start) }), now);
  assert.equal(closed.runStartedAt, null);
  assert.equal(closed.usageDay, localDay(now));
  assert.equal(closed.usageSeconds, 20 * 60);
});

test('closeRun adds to the same-day total and starts over on a new day', () => {
  const start = at(2026, 5, 1, 10);
  const end = start + 5 * 60_000;
  assert.equal(closeRun(rec({ runStartedAt: iso(start), usageDay: localDay(end), usageSeconds: 60 }), end).usageSeconds, 360);
  assert.equal(closeRun(rec({ runStartedAt: iso(start), usageDay: '2020-01-01', usageSeconds: 5000 }), end).usageSeconds, 300);
  assert.equal(closeRun(rec({ runStartedAt: null }), end).usageSeconds, 0);
});

test('no estimate without a configured rate; with one it is labelled an estimate and uses the VM size rate', () => {
  const start = at(2026, 5, 1, 10);
  const now = start + 3600_000;
  assert.equal(vmUsage(rec({ runStartedAt: iso(start) }), now).estimate, undefined);
  assert.equal(vmUsage(rec({ runStartedAt: iso(start) }), now, {}, 'USD').estimate, undefined);
  assert.equal(vmUsage(rec({ runStartedAt: iso(start), size: 'large' }), now, { default: 0.5 }).estimate, undefined, 'a rate for another size is not used');
  const u = vmUsage(rec({ runStartedAt: iso(start), size: 'large' }), now, { default: 0.5, large: 2 }, 'DKK');
  assert.equal(u.estimate?.amount, 2);
  assert.equal(u.estimate?.currency, 'DKK');
  assert.match(u.estimate!.basis, /^estimate:/);
  assert.match(usageLine(u), /est\. 2\.00 DKK/);
  assert.doesNotMatch(usageLine(vmUsage(rec({ runStartedAt: iso(start) }), now)), /est\./);
});

test('sanitizeRates keeps only finite positive numbers', () => {
  assert.deepEqual(sanitizeRates({ small: 1, default: '2', large: -3, extra: 5 }), { small: 1 });
  assert.deepEqual(sanitizeRates({ default: Number.NaN, large: 0 }), {});
  assert.deepEqual(sanitizeRates(null), {});
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(42), '42 s');
  assert.equal(fmtDuration(423), '7 min 3 s');
  assert.equal(fmtDuration(2 * 3600 + 5 * 60), '2 h 05 min');
});
