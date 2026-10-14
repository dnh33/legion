import test from 'node:test';
import assert from 'node:assert/strict';
import { barHeights, dayLabel, money, notificationsLine, quietProblem, SPEND_NOTE, spendRows, weekResetLabel } from '../ui/src/away/awayLogic.js';
import { periodEnd, periodStart } from '../src/shared/spend-periods.js';

test('money: two decimals, thousands separated, tiny amounts never read as zero', () => {
  assert.equal(money(0), '$0.00');
  assert.equal(money(3.2), '$3.20');
  assert.equal(money(1234.5), '$1,234.50');
  assert.equal(money(0.004), 'under $0.01');
  assert.equal(money(Number.NaN), '$0.00');
});

test('the week label names the Monday it resets on, from the same period math the budget uses', () => {
  const wed = new Date(2026, 9, 14, 15).getTime();
  assert.equal(new Date(periodStart('week', wed)).getDay(), 1);
  assert.equal(weekResetLabel(wed), 'Resets Monday 19 October');
  const sun = new Date(2026, 9, 18, 23, 59).getTime();
  assert.equal(weekResetLabel(sun), 'Resets Monday 19 October');
  assert.equal(new Date(periodEnd('week', sun)).getDate(), 19);
});

test('daily bars: scaled to the biggest day, a spent day is never invisible, an empty window is flat', () => {
  assert.deepEqual(barHeights([{ day: '2026-10-13', usd: 0 }, { day: '2026-10-14', usd: 0 }]), [0, 0]);
  const h = barHeights([{ day: 'a', usd: 10 }, { day: 'b', usd: 5 }, { day: 'c', usd: 0.01 }, { day: 'd', usd: 0 }]);
  assert.deepEqual(h, [100, 50, 4, 0]);
});

test('day labels are short weekdays, with the date for the first of the window', () => {
  assert.equal(dayLabel('2026-10-14'), 'Wed');
  assert.equal(dayLabel('2026-10-14', true), 'Wed 14');
});

test('rows: names from the lists, no project and unknown agents are labelled, empty list stays empty', () => {
  const rows = spendRows([{ projectId: 'p1', usd: 4 }, { projectId: null, usd: 1 }, { projectId: 'gone', usd: 0.5 }], { p1: 'Shop' }, 'No project', 'A deleted project');
  assert.deepEqual(rows.map((r) => [r.label, r.usd]), [['Shop', 4], ['No project', 1], ['A deleted project', 0.5]]);
  assert.deepEqual(spendRows([], {}, 'x', 'y'), []);
});

test('the spending note explains the ledger and the older tasks', () => {
  assert.match(SPEND_NOTE, /counted per run/);
  assert.match(SPEND_NOTE, /last updated/);
});

test('quiet hours: equal times are refused with a plain sentence, valid ones are described', () => {
  assert.equal(quietProblem({ enabled: true, from: '22:00', to: '22:00' }), 'Pick two different times.');
  assert.equal(quietProblem({ enabled: true, from: '', to: '07:00' }), 'Pick a start and an end time.');
  assert.equal(quietProblem({ enabled: false, from: '22:00', to: '22:00' }), null);
  assert.equal(quietProblem({ enabled: true, from: '22:00', to: '07:00' }), null);
  assert.equal(notificationsLine({ enabled: true, from: '22:00', to: '07:00' }), 'Quiet from 22:00 to 07:00. Asks keep waiting; you get one summary when it ends.');
  assert.equal(notificationsLine({ enabled: false, from: '22:00', to: '07:00' }), 'Quiet hours are off.');
});

test('none of these strings has an em dash, an en dash or "this computer"', () => {
  const all = [SPEND_NOTE, notificationsLine({ enabled: true, from: '22:00', to: '07:00' }), quietProblem({ enabled: true, from: '1', to: '1' }) ?? '', money(0.001)].join(' ');
  assert.ok(!/[\u2013\u2014]/.test(all) && !/this computer/i.test(all));
});
