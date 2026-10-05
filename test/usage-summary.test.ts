import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseUsage, type UsageTask } from '../src/shared/usage-summary.js';

const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).getTime();
const t = (when: number, o: Partial<UsageTask> = {}): UsageTask => ({ agentId: 'zealot', model: 'sonnet', costUsd: 1, turns: 2, updatedAt: new Date(when).toISOString(), ...o });
const NOW = at(2026, 10, 5, 15);

test('buckets by local day: today, 7 days and 30 days are nested and exact at the edges', () => {
  const s = summariseUsage([
    t(at(2026, 10, 5, 1), { costUsd: 1 }),   // today, early morning
    t(at(2026, 10, 4, 23), { costUsd: 2 }),  // yesterday
    t(at(2026, 9, 29, 9), { costUsd: 4 }),   // 6 days ago: inside 7 days
    t(at(2026, 9, 28, 9), { costUsd: 8 }),   // 7 days ago: outside 7 days, inside 30
    t(at(2026, 9, 6, 9), { costUsd: 16 }),   // 29 days ago: inside 30
    t(at(2026, 9, 5, 9), { costUsd: 32 }),   // 30 days ago: outside
  ], NOW);
  assert.equal(s.today.costUsd, 1);
  assert.equal(s.days7.costUsd, 1 + 2 + 4);
  assert.equal(s.days30.costUsd, 1 + 2 + 4 + 8 + 16);
  assert.equal(s.days30.tasks, 5);
});

test('groups by model and agent, biggest first, and never gives a provider task a cost', () => {
  const { costUsd: _c, ...noCost } = t(NOW, { model: 'gpt-x', provider: 'openrouter', agentId: 'b' });
  const s = summariseUsage([
    t(NOW, { model: 'opus', costUsd: 3, agentId: 'a' }),
    t(NOW, { model: 'sonnet', costUsd: 1, agentId: 'b' }),
    t(NOW, { model: 'sonnet', costUsd: 1, agentId: 'b' }),
    noCost,
  ], NOW);
  assert.deepEqual(s.today.byModel.map((r) => [r.key, r.costUsd, r.tasks]), [['opus', 3, 1], ['sonnet', 2, 2], ['openrouter:gpt-x', 0, 1]]);
  assert.deepEqual(s.today.byAgent.map((r) => r.key), ['a', 'b']);
  assert.equal(s.today.costUsd, 5);
});

test('daily is the last 14 local days, oldest first, zero-filled, and the last day is today', () => {
  const s = summariseUsage([t(NOW, { costUsd: 2 }), t(at(2026, 9, 22), { costUsd: 3 })], NOW);
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily[13]!.day, '2026-10-05');
  assert.equal(s.daily[13]!.costUsd, 2);
  assert.equal(s.daily[0]!.day, '2026-09-22');
  assert.equal(s.daily[0]!.costUsd, 3);
  assert.equal(s.daily[5]!.costUsd, 0);
});

test('bad data is never counted as cost: NaN, negative, missing, unparseable or far-future dates', () => {
  const s = summariseUsage([
    t(NOW, { costUsd: Number.NaN }), t(NOW, { costUsd: -5 }), t(NOW, { costUsd: undefined }),
    { agentId: 'x', updatedAt: 'not a date', costUsd: 9 }, t(NOW + 40 * 86_400_000, { costUsd: 9 }),
  ], NOW);
  assert.equal(s.today.costUsd, 0);
  assert.equal(s.today.tasks, 3);
  assert.equal(s.days30.tasks, 3);
});

test('an empty list is a valid, empty summary', () => {
  const s = summariseUsage([], NOW);
  assert.equal(s.days30.tasks, 0);
  assert.deepEqual(s.today.byModel, []);
  assert.equal(s.daily.length, 14);
});
