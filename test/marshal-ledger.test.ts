/** The attempt ledger: the futility rule as code — two tries per bot, forward-only reassignment, done_when before dispatch (marshal/ledger.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AttemptLedger, MAX_ATTEMPTS_PER_BOT, MAX_ATTEMPTS_PER_ITEM } from '../src/core/marshal/ledger.js';
import { BoardStore, BoardError } from '../src/core/projects/board/store.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { tempDir } from './tmp-cleanup.js';

const P: ProjectRef = { id: 'proj_aaaaaaaaaaaa', members: ['builder', 'exorcist'], status: 'active' };

const I = 'wi_aaaaaaaaaaaa';
const A = 'builder', B = 'exorcist';

test('a third dispatch of the same item to the same bot is refused, in code', () => {
  const l = new AttemptLedger();
  l.setDoneWhen(I, ['it works']);
  assert.ok(l.mayDispatch(I, A).ok, 'first try');
  l.recordDispatch(I, A, 'task_1');
  l.runEnded(I, 'failed');
  assert.ok(l.mayDispatch(I, A).ok, 'a send-back is the second try, still allowed');
  l.recordDispatch(I, A, 'task_2');
  l.runEnded(I, 'failed');
  const third = l.mayDispatch(I, A);
  assert.ok(!third.ok, 'the third dispatch is refused');
  assert.match(third.ok ? '' : third.why, /twice/, 'the refusal says why');
  assert.match(third.ok ? '' : third.why, /builder/, 'and names the bot');
});

test('forward-only: once the item leaves a bot it never goes back, but an untried bot may have it', () => {
  const l = new AttemptLedger();
  l.setDoneWhen(I, ['it works']);
  l.recordDispatch(I, A, 'task_1');
  l.runEnded(I, 'failed');
  l.recordDispatch(I, B, 'task_2'); // reassigned: A is history from here
  l.runEnded(I, 'failed');
  const back = l.mayDispatch(I, A);
  assert.ok(!back.ok, 'never back to a bot the item was reassigned away from');
  assert.match(back.ok ? '' : back.why, /forward-only/);
  assert.equal(l.mayDispatch(I, B).ok, true, 'the bot that holds it is not excluded by the same rule');
});

test('an item that burned its attempts everywhere stops: the loop must block it, never force a fit', () => {
  const l = new AttemptLedger();
  l.setDoneWhen(I, ['it works']);
  // two bots, two tries each: the per-bot rule alone would stop them, so the item-wide cap must also bite
  for (const bot of ['b1', 'b2']) for (let n = 0; n < MAX_ATTEMPTS_PER_BOT; n++) {
    l.recordDispatch(I, bot, `task_${bot}_${n}`);
    l.runEnded(I, 'failed');
  }
  const next = l.mayDispatch(I, 'b9');
  assert.ok(!next.ok, 'a fresh bot is refused too: the item is out of attempts');
  assert.match(next.ok ? '' : next.why, /out of attempts/);
});

test('one owner at a time: while a dispatch is live no other bot may take the item', () => {
  const l = new AttemptLedger();
  l.setDoneWhen(I, ['it works']);
  l.recordDispatch(I, A, 'task_1'); // still live: no runEnded yet
  const other = l.mayDispatch(I, B);
  assert.ok(!other.ok);
  assert.match(other.ok ? '' : other.why, /builder/, 'the refusal names the owner');
  l.runEnded(I, 'done');
  assert.ok(l.mayDispatch(I, B).ok, 'the run ended: the item is free');
});

test('done_when is written before dispatch, and a dispatch without it is refused', () => {
  const l = new AttemptLedger();
  const none = l.mayDispatch(I, A);
  assert.ok(!none.ok, 'no checks, no dispatch');
  assert.match(none.ok ? '' : none.why, /done.when/i);
  l.setDoneWhen(I, ['the test passes', 'the diff is under 40 lines']);
  assert.ok(l.mayDispatch(I, A).ok, 'checks written: dispatch allowed');
  assert.deepEqual(l.doneWhen(I), ['the test passes', 'the diff is under 40 lines']);
});

test('the ledger is a value: a snapshot restores every answer after a restart', () => {
  const l = new AttemptLedger();
  l.setDoneWhen(I, ['passes']);
  l.recordDispatch(I, A, 'task_1');
  l.runEnded(I, 'failed');
  const back = AttemptLedger.from(l.snapshot());
  assert.equal(back.mayDispatch(I, A).ok, true, 'one try used, a second still allowed');
  assert.deepEqual(back.doneWhen(I), ['passes'], 'the checks survive the restart');
  back.recordDispatch(I, A, 'task_2');
  back.runEnded(I, 'failed');
  assert.ok(!back.mayDispatch(I, A).ok, 'the count is not reset by a restart');
  assert.equal(l.mayDispatch(I, A).ok, true, 'the original is a copy, not a view');
});

test('a stalled run counts as an attempt and its escalation is the ledger’s, not the matcher’s', () => {
  const l = new AttemptLedger();
  l.setDoneWhen(I, ['it works']);
  l.recordDispatch(I, A, 'task_1');
  l.runEnded(I, 'stalled');
  assert.equal(l.stalls(I), 1, 'one stall recorded');
  l.recordDispatch(I, A, 'task_2');
  l.runEnded(I, 'stalled');
  assert.ok(!l.mayDispatch(I, A).ok, 'two tries, both stalled: refused');
  assert.equal(l.stalls(I), 2, 'the count feeds the escalation');
});

test('the ledger rides the board log: a snapshot in the sidecar comes back after a restart', () => {
  const dir = tempDir('legion-marshal-sidecar-');
  const s = new BoardStore(dir);
  const item = s.create(P, { title: 'ship it' });
  const l = new AttemptLedger();
  l.setDoneWhen(item.id, ['it works']);
  l.recordDispatch(item.id, 'builder', 'task_1');
  l.runEnded(item.id, 'failed');
  s.setSidecar(P.id, item.id, { dispatch: l.snapshot() });
  const back = AttemptLedger.from((new BoardStore(dir).sidecar(P.id, item.id) ?? {}).dispatch);
  assert.ok(back.mayDispatch(item.id, 'builder').ok, 'one try used: the second is still allowed after a restart');
  back.recordDispatch(item.id, 'builder', 'task_2');
  back.runEnded(item.id, 'failed');
  assert.ok(!back.mayDispatch(item.id, 'builder').ok, 'the count was not reset by the restart');
});

test('compaction keeps the sidecar, and a setSidecar never eats the other unknown keys', () => {
  const dir = tempDir('legion-marshal-sidecar2-');
  const s = new BoardStore(dir);
  const item = s.create(P, { title: 'ship it' });
  // `deps` is another unknown key the log carries: the sidecar merge must not drop it
  s.setSidecar(P.id, item.id, { deps: ['wi_bbbbbbbbbbbb'] });
  const l = new AttemptLedger();
  l.setDoneWhen(item.id, ['it works']);
  for (let n = 0; n < 220; n++) s.setSidecar(P.id, item.id, { dispatch: { n } }); // past the compaction threshold
  const side = new BoardStore(dir).sidecar(P.id, item.id)!;
  assert.equal((side.dispatch as { n: number }).n, 219, 'the last sidecar write is the one that survived compaction');
  assert.deepEqual(side.deps, ['wi_bbbbbbbbbbbb'], 'the other unknown key is intact');
});

test('the sidecar is state, not content: an oversized write is refused', () => {
  const dir = tempDir('legion-marshal-sidecar3-');
  const s = new BoardStore(dir);
  const item = s.create(P, { title: 'ship it' });
  assert.throws(() => s.setSidecar(P.id, item.id, { blob: 'x'.repeat(3000) }), (e: unknown) => e instanceof BoardError && e.status === 400);
  assert.equal(s.sidecar(P.id, item.id), undefined, 'nothing was written');
  s.setSidecar(P.id, item.id, { dispatch: { a: 1 } });
  s.setSidecar(P.id, item.id, { dispatch: undefined });
  assert.equal(s.sidecar(P.id, item.id), undefined, 'dropping the last key drops the sidecar');
});

test('garbage in the snapshot never corrupts the guards', () => {
  const l = AttemptLedger.from({ [I]: { attempts: { [A]: Number.NaN }, doneWhen: ['passes', 42] } as never });
  assert.ok(l.mayDispatch(I, A).ok, 'a NaN count is not a count: one try stands');
  assert.deepEqual(l.doneWhen(I), ['passes'], 'the readable checks are kept, the unreadable one dropped');
});
