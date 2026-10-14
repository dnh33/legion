import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { periodEnd, periodStart } from '../src/shared/spend-periods.js';
import { budgetStatus, SpendLedger } from '../src/core/away/ledger.js';
import type { ProjectAway } from '../src/core/away/store.js';

const at = (y: number, mo: number, d: number, h = 12, mi = 0): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ledger-'));
const entry = (ms: number, usd: number, extra: Record<string, unknown> = {}) => ({ at: new Date(ms).toISOString(), taskId: 't1', agentId: 'builder', projectId: 'p1', usd, ...extra });

test('day: local midnight to the next', () => {
  const now = at(2026, 10, 14, 15, 30);
  assert.equal(periodStart('day', now), at(2026, 10, 14, 0, 0));
  assert.equal(periodEnd('day', now), at(2026, 10, 15, 0, 0));
});

test('week: starts Monday 00:00 local, ends the next Monday ("until Monday")', () => {
  // 2026-10-14 is a Wednesday
  assert.equal(new Date(at(2026, 10, 14)).getDay(), 3);
  assert.equal(periodStart('week', at(2026, 10, 14, 15)), at(2026, 10, 12, 0, 0));
  assert.equal(periodEnd('week', at(2026, 10, 14, 15)), at(2026, 10, 19, 0, 0));
  // Monday itself and Sunday night
  assert.equal(periodStart('week', at(2026, 10, 12, 0, 0)), at(2026, 10, 12, 0, 0));
  assert.equal(periodStart('week', at(2026, 10, 18, 23, 59)), at(2026, 10, 12, 0, 0));
  assert.equal(new Date(periodEnd('week', at(2026, 10, 14))).getDay(), 1);
});

test('week spans a month and a year boundary', () => {
  assert.equal(periodStart('week', at(2026, 1, 2)), at(2025, 12, 29, 0, 0));
  assert.equal(periodEnd('week', at(2026, 1, 2)), at(2026, 1, 5, 0, 0));
});

test('month: first of the month to the first of the next, December rolls the year', () => {
  assert.equal(periodStart('month', at(2026, 10, 31, 23)), at(2026, 10, 1, 0, 0));
  assert.equal(periodEnd('month', at(2026, 10, 31, 23)), at(2026, 11, 1, 0, 0));
  assert.equal(periodEnd('month', at(2026, 12, 15)), at(2027, 1, 1, 0, 0));
});

test('boundaries hold on daylight saving days (local fields, never +24 h)', () => {
  for (const [m, d] of [[3, 8], [3, 29], [10, 25], [11, 1]] as const) {
    const s = periodStart('day', at(2026, m, d, 13));
    const e = periodEnd('day', at(2026, m, d, 13));
    assert.equal(new Date(s).getHours(), 0);
    assert.equal(new Date(e).getHours(), 0);
    assert.equal(new Date(e).getDate(), new Date(at(2026, m, d + 1, 12)).getDate());
  }
});

test('the ledger records one line per entry and sums a period for a project', () => {
  const dir = tmp();
  const now = at(2026, 10, 14, 15);
  const l = new SpendLedger(dir, () => now);
  l.record(entry(at(2026, 10, 14, 9), 1.5));
  l.record(entry(at(2026, 10, 13, 9), 2));
  l.record(entry(at(2026, 10, 5, 9), 4));          // earlier this month, not this week
  l.record(entry(at(2026, 10, 14, 10), 3, { projectId: 'p2' }));
  assert.equal(l.periodTotal('day', now, 'p1'), 1.5);
  assert.equal(l.periodTotal('week', now, 'p1'), 3.5);
  assert.equal(l.periodTotal('month', now, 'p1'), 7.5);
  assert.equal(l.periodTotal('week', now), 6.5, 'all projects');
  const lines = readFileSync(join(dir, 'spend-2026-10.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)).sort(), ['agentId', 'at', 'projectId', 'taskId', 'usd']);
});

test('a new ledger reads what an old one wrote, including the previous month', () => {
  const dir = tmp();
  const now = at(2026, 11, 1, 12);
  const first = new SpendLedger(dir, () => now);
  first.record(entry(at(2026, 10, 30, 12), 5));   // the week of 2026-10-26 spans both months
  first.record(entry(at(2026, 11, 1, 10), 1));
  const again = new SpendLedger(dir, () => now);
  assert.equal(again.periodTotal('week', now, 'p1'), 6);
  assert.equal(again.periodTotal('month', now, 'p1'), 1);
});

test('an entry that is not a positive amount is ignored', () => {
  const l = new SpendLedger(tmp(), () => at(2026, 10, 14));
  for (const usd of [0, -1, NaN, Infinity, '2' as never]) l.record(entry(at(2026, 10, 14, 9), usd));
  assert.equal(l.periodTotal('day', at(2026, 10, 14)), 0);
});

test('a write that fails never fails the run, and the amount still counts while the core runs', () => {
  const base = tmp();
  const blocked = join(base, 'away');
  writeFileSync(blocked, 'a file where the folder should be');
  const now = at(2026, 10, 14, 15);
  const l = new SpendLedger(blocked, () => now);
  assert.doesNotThrow(() => l.record(entry(at(2026, 10, 14, 9), 2)));
  assert.equal(l.periodTotal('day', now, 'p1'), 2);
});

test('summary: this week, today, by project, by agent, 14 days oldest first', () => {
  const now = at(2026, 10, 14, 15);
  const l = new SpendLedger(tmp(), () => now);
  l.record(entry(at(2026, 10, 14, 9), 1, { agentId: 'scout' }));
  l.record(entry(at(2026, 10, 13, 9), 2, { agentId: 'builder' }));
  l.record(entry(at(2026, 10, 12, 9), 4, { agentId: 'builder', projectId: 'p2' }));
  l.record(entry(at(2026, 10, 1, 9), 8, { agentId: 'builder' }));
  const s = l.summary(now);
  assert.equal(s.week, 7);
  assert.equal(s.today, 1);
  assert.deepEqual(s.byProject, [{ projectId: 'p2', usd: 4 }, { projectId: 'p1', usd: 3 }]);
  assert.deepEqual(s.byAgent, [{ agentId: 'builder', usd: 6 }, { agentId: 'scout', usd: 1 }]);
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily[13]!.usd, 1);
  assert.equal(s.daily[12]!.usd, 2);
  assert.equal(s.daily[0]!.usd, 8, 'the 1st is the oldest of the 14 days');
  assert.ok(s.daily[0]!.day < s.daily[13]!.day);
  const only = l.summary(now, 'p1');
  assert.equal(only.week, 3);
  assert.deepEqual(only.byProject, [{ projectId: 'p1', usd: 3 }]);
});

const cfg = (extra: Partial<ProjectAway> = {}): ProjectAway => ({ onSilence: { mode: 'deny', parkMinutes: 3 }, paused: false, notify: 'problems', budget: { limit: 5, period: 'week' }, ...extra });

test('budget: reached at the limit, not below, none without a limit', () => {
  const now = at(2026, 10, 14, 15);
  const l = new SpendLedger(tmp(), () => now);
  assert.equal(budgetStatus(l, cfg({ budget: null }), 'p1', now).reached, false);
  l.record(entry(at(2026, 10, 13, 9), 4.99));
  assert.equal(budgetStatus(l, cfg(), 'p1', now).reached, false);
  l.record(entry(at(2026, 10, 14, 9), 0.01));
  const st = budgetStatus(l, cfg(), 'p1', now);
  assert.equal(st.reached, true);
  assert.equal(st.periodEnd, at(2026, 10, 19, 0, 0));
});

test('budget: an override lasts to the end of the period, then the budget applies again', () => {
  const now = at(2026, 10, 14, 15);
  const l = new SpendLedger(tmp(), () => now);
  l.record(entry(at(2026, 10, 14, 9), 9));
  const over = cfg({ budgetOverrideUntil: new Date(at(2026, 10, 19, 0, 0)).toISOString() });
  const st = budgetStatus(l, over, 'p1', now);
  assert.equal(st.reached, false);
  assert.equal(st.overridden, true);
  // next week the override has expired and nothing has been spent yet
  const later = at(2026, 10, 20, 9);
  assert.equal(budgetStatus(l, over, 'p1', later).overridden, false);
  assert.equal(budgetStatus(l, over, 'p1', later).reached, false);
  l.record(entry(at(2026, 10, 20, 9), 6));
  assert.equal(budgetStatus(l, over, 'p1', later).reached, true);
});
