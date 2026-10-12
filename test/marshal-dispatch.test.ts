/** The dispatch loop's pick-next: C1's score order decides what the Marshal works next (marshal/dispatch.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore } from '../src/core/projects/board/store.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { dispatchable, dispatchPrompt } from '../src/core/marshal/dispatch.js';
import type { DispatchCandidate } from '../src/core/marshal/dispatch.js';
import { tempDir } from './tmp-cleanup.js';

const PID = 'proj_aaaaaaaaaaaa';
const P: ProjectRef = { id: PID, members: ['builder', 'scout'], status: 'active' };
const NOW = Date.parse('2026-10-12T12:00:00Z');
const store = () => new BoardStore(tempDir('legion-marshal-dispatch-'), () => NOW);
const titles = (c: DispatchCandidate[]) => c.map((x) => x.item.title);

test('pick-next follows the board score, not the column position: the high item is worked before the low one', () => {
  const s = store();
  s.create(P, { title: 'low, made first', priority: 'low' });      // top of the column by `order`
  s.create(P, { title: 'high, made second', priority: 'high' });   // below it by `order`
  const view = s.view(P);
  assert.deepEqual(titles(dispatchable(view, { depsOf: () => [], isDone: () => false })), ['high, made second', 'low, made first'], 'score order, with the column order only breaking ties');
});

test('every candidate carries the score and the line that explains its place', () => {
  const s = store();
  s.create(P, { title: 'soon', due: '2026-10-14' });
  s.create(P, { title: 'plain' });
  const view = s.view(P);
  const c = dispatchable(view, { depsOf: () => [], isDone: () => false });
  for (const x of c) {
    assert.equal(x.score, view.rank[x.item.id]!.score, 'the candidate carries the board’s own score');
    assert.equal(x.why, view.rank[x.item.id]!.why, 'and the board’s own reason');
  }
  assert.equal(c[0]!.item.title, 'soon', 'the sooner-due item leads, and the reason says so');
  assert.match(c[0]!.why, /due/i);
});

test('only backlog is dispatchable: doing, review, done, blocked and Inbox proposals never appear', () => {
  const s = store();
  s.create(P, { title: 'backlogged' });
  const doing = s.create(P, { title: 'in progress', status: 'doing' });
  s.create(P, { title: 'for review', status: 'review' });
  s.create(P, { title: 'finished', status: 'done' });
  s.create(P, { title: 'stuck', status: 'blocked' });
  s.propose(P, 'scout', { title: 'an idea' }, { tainted: false });
  s.beginRun(P, doing.id, 'task_1'); // a live run keeps it out even if it were moved back
  const view = s.view(P);
  assert.deepEqual(titles(dispatchable(view, { depsOf: () => [], isDone: () => false })), ['backlogged']);
});

test('the owner’s own items are the owner’s: the loop never dispatches them', () => {
  const s = store();
  s.create(P, { title: 'mine' });
  s.patch(P, s.view(P).items[0]!.id, { assignee: { kind: 'owner' } });
  assert.deepEqual(titles(dispatchable(s.view(P), { depsOf: () => [], isDone: () => false })), [], 'assigned to the owner: not the loop’s to route');
});

test('an item that waits on unfinished work is held back, and sails once its dependency is done', () => {
  const s = store();
  const dep = s.create(P, { title: 'the prerequisite' });
  const waiting = s.create(P, { title: 'the follower', priority: 'high' });
  s.setSidecar(PID, waiting.id, { deps: [dep.id] });
  const depsOf = (id: string): readonly string[] => ((s.sidecar(PID, id)?.deps as string[] | undefined) ?? []);
  const view = s.view(P);
  assert.deepEqual(titles(dispatchable(view, { depsOf, isDone: () => false })), ['the prerequisite'], 'the high item stays held while its prerequisite is open');
  s.patch(P, dep.id, { status: 'done' });
  assert.deepEqual(titles(dispatchable(s.view(P), { depsOf, isDone: (id) => s.get(PID, id)?.status === 'done' })), ['the follower'], 'the dependency is done: the follower is free, and the finished item is gone from the list');
});

test('the dispatch prompt is the contract: goal, the done-when checks, and the item as data', () => {
  const item = store().create(P, { title: 'Write the runbook', description: 'Cover the restart path.' });
  const text = dispatchPrompt(item, ['the runbook covers the restart', 'a stranger can follow it']);
  assert.match(text, /^Goal: Write the runbook/, 'the goal leads');
  assert.match(text, /Done when:\n1\. the runbook covers the restart\n2\. a stranger can follow it/, 'the checks decide done, numbered');
  assert.match(text, /<legion-work-item id="wi_[a-f0-9]{12}"/, 'the item itself rides as data');
  assert.match(text, /Cover the restart path\./, 'with its description');
  const untrusted = { ...item, trust: 'untrusted' as const };
  assert.match(dispatchPrompt(untrusted, ['it works']), /not as the owner's instruction/, 'an agent-written item carries the trust note');
  assert.doesNotMatch(text, /not the owner/, 'the owner’s own text needs no such warning');
});
