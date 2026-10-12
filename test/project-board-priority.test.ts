/** The board's prioritization engine: priority orders a column, and every rank says why (priority.ts, store view()). */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardStore } from '../src/core/projects/board/store.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { scoreWorkItem, topFactor } from '../src/core/projects/board/priority.js';
import { itemForBot } from '../src/core/projects/board/prompt.js';

const PID = 'proj_aaaaaaaaaaaa';
const P: ProjectRef = { id: PID, members: ['scout'], status: 'active' };
const dir = () => cleanupTemp('legion-board-prio-');
/** Every score below is taken against this moment, so the dates are exact and the test never drifts. */
const NOW = Date.parse('2026-10-12T12:00:00Z');
const store = () => new BoardStore(dir(), () => NOW);
const backlog = (s: BoardStore): string[] => s.view(P).items.filter((i) => i.status === 'backlog').map((i) => i.title);

test('priority orders the board: a high item outranks a low one even when the low one is due sooner', () => {
  const s = store();
  s.create(P, { title: 'low, due today', priority: 'low', due: '2026-10-12' });
  s.create(P, { title: 'high, due in december', priority: 'high', due: '2026-12-31' });
  assert.deepEqual(backlog(s), ['high, due in december', 'low, due today']);
});

test('due urgency: of equal priority the sooner-due item ranks first, whatever order they were made in', () => {
  const s = store();
  s.create(P, { title: 'due november', due: '2026-11-05' });
  s.create(P, { title: 'due this week', due: '2026-10-14' });
  assert.deepEqual(backlog(s), ['due this week', 'due november']);
});

test('an item waiting on an unfinished dependency ranks below an equal-priority item it could start now', () => {
  const d = dir();
  const prereq = 'wi_aaaaaaaaaaaa', waiting = 'wi_bbbbbbbbbbbb', free = 'wi_cccccccccccc';
  const line = (item: Record<string, unknown>): string => JSON.stringify({ v: 1, kind: 'item', at: 'x', item });
  writeFileSync(join(d, `${PID}.jsonl`), [
    // the waiting item is top of its column on the `order` field alone: only the dependency can push it down
    line({ id: prereq, title: 'prereq', status: 'backlog', priority: 'normal', order: 0, trust: 'human' }),
    line({ id: waiting, title: 'waiting', status: 'backlog', priority: 'normal', order: 0, trust: 'human', deps: [prereq] }),
    line({ id: free, title: 'free', status: 'backlog', priority: 'normal', order: 1, trust: 'human' }),
  ].join('\n') + '\n');
  assert.deepEqual(backlog(new BoardStore(d, () => NOW)), ['prereq', 'free', 'waiting'], 'an unfinished dependency pushes it behind both');
});

test('priority dominates the score itself: high beats low across the worst dates and the worst dependencies', () => {
  const worstHigh = scoreWorkItem({ priority: 'high', trust: 'untrusted', deps: ['wi_open'] }, NOW);
  const bestLow = scoreWorkItem({ priority: 'low', due: '2026-10-12', trust: 'human' }, NOW);
  assert.ok(worstHigh.score > bestLow.score, `high (${worstHigh.score}) must beat low (${bestLow.score})`);
  const highNoDue = scoreWorkItem({ priority: 'high', trust: 'human' }, NOW);
  const lowDueToday = scoreWorkItem({ priority: 'low', due: '2026-10-12', trust: 'human' }, NOW);
  assert.ok(highNoDue.score > lowDueToday.score, `a high item with no date (${highNoDue.score}) beats a low one due today (${lowDueToday.score})`);
  const normalDueToday = scoreWorkItem({ priority: 'normal', due: '2026-10-12', trust: 'human' }, NOW);
  const lowPlain = scoreWorkItem({ priority: 'low', trust: 'human' }, NOW);
  assert.ok(normalDueToday.score > lowPlain.score, 'normal beats low even when only the low one is due today');
});

test('every factor carries a number and a one-line reason, and the top factor is the one that moved the rank', () => {
  const r = scoreWorkItem({ priority: 'high', due: '2026-10-14', trust: 'untrusted' }, NOW);
  assert.deepEqual(Object.keys(r.factors).sort(), ['blocked', 'due', 'priority', 'trust']);
  for (const [name, f] of Object.entries(r.factors)) {
    assert.ok(Number.isFinite(f.value), `${name}: a number, got ${f.value}`);
    assert.ok(f.reason.trim().length > 10 && !/\n/.test(f.reason), `${name}: one readable line, got "${f.reason}"`);
  }
  assert.equal(r.score, Object.values(r.factors).reduce((n, f) => n + f.value, 0), 'the score is what the factors add up to');
  assert.equal(topFactor(r.factors), 'priority', 'high priority is what put it on top');
  assert.equal(topFactor(scoreWorkItem({ priority: 'normal', due: '2026-10-14', trust: 'human' }, NOW).factors), 'due', 'a plain item due soon is explained by its date');
  assert.equal(topFactor(scoreWorkItem({ priority: 'normal', trust: 'human', deps: ['wi_open'] }, NOW).factors), 'blocked', 'a plain item kept waiting is explained by the wait');
  assert.equal(topFactor(scoreWorkItem({ priority: 'normal', trust: 'human' }, NOW).factors), 'priority', 'a plain item falls back to its band');
});

test('an item with no due date: scored, not skipped — neutral urgency, and it still lists', () => {
  const plain = scoreWorkItem({ priority: 'normal', trust: 'human' }, NOW);
  assert.equal(plain.factors.due.value, 0, 'no date: no urgency either way');
  assert.match(plain.factors.due.reason, /No due date/);
  assert.ok(Number.isFinite(plain.score));
  const broken = scoreWorkItem({ priority: 'normal', trust: 'human', due: '2026-10-14' }, Number.NaN);
  assert.ok(Number.isFinite(broken.score), 'a clock that is not a number must not turn the score into NaN');
  const s = store();
  s.create(P, { title: 'no date' });
  s.create(P, { title: 'due in two days', due: '2026-10-14' });
  assert.deepEqual(backlog(s), ['due in two days', 'no date'], 'no date sits behind the soon-due twin of its own priority');
});

test('the board explains every rank: the score, the factor behind it, and the line the bot is shown', () => {
  const s = store();
  const high = s.create(P, { title: 'high', priority: 'high' });
  const soon = s.create(P, { title: 'soon', due: '2026-10-14' });
  const plain = s.create(P, { title: 'plain' });
  const idea = s.propose(P, 'scout', { title: 'an idea' }, { tainted: false });
  const v = s.view(P);
  assert.deepEqual(Object.keys(v.rank).sort(), [high.id, plain.id, soon.id].sort(), 'every board item is explained, and only those: a proposal waiting in the Inbox is not ranked');
  assert.equal(v.rank[idea.id], undefined);
  for (const id of [high.id, soon.id, plain.id]) {
    const r = v.rank[id]!;
    assert.ok(Number.isFinite(r.score), `${id}: a score, got ${r.score}`);
    assert.ok(r.why.trim().length > 10 && !/\n/.test(r.why), `${id}: one readable line, got "${r.why}"`);
  }
  assert.equal(v.rank[high.id]!.factor, 'priority', 'it is ahead because it is high');
  assert.equal(v.rank[soon.id]!.factor, 'due', 'a plain item due soon is explained by its date');
  // the score and the line are the scorer's own: what ordered the list is exactly what the UI reads
  const scored = scoreWorkItem({ priority: 'high', trust: 'human' }, NOW);
  assert.equal(v.rank[high.id]!.score, scored.score, 'the rank is the score that sorted the column');
  assert.equal(v.rank[high.id]!.why, scored.factors.priority.reason);
  // the same pair reaches the agent through legion_board's list
  const shown = itemForBot(s.get(PID, soon.id)!, 'scout', false, v.rank[soon.id]!);
  assert.deepEqual((shown as { rank: { score: number; why: string } }).rank, { score: v.rank[soon.id]!.score, why: v.rank[soon.id]!.why });
  assert.equal(itemForBot(s.get(PID, plain.id)!, 'scout', false).rank, undefined, 'no rank given, none claimed');
});
