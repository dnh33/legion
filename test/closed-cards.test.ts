/**
 * W2b item 1 (R60/R61): a Hermes card that closed on its own stays in the thread, and it survives a reload of the window.
 * The core keeps the closed card (small, in memory, capped); the state snapshot carries it; Dismiss tells the core.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker, ACP_CLOSED_NOTE, ACP_LATE_NOTE } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { AUTH, makeFakes, mkAgent, start } from './helpers-c.js';
import type { LegionEvent } from '../src/shared/types.js';

const OPTS = [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }, { optionId: 'o2', name: 'Deny', kind: 'reject_once' }];
const ask = (b: ApprovalBroker, taskId = 't1', waitMs = 60_000) => {
  const p = b.requestAcp(taskId, 'a1', { toolName: 'Bash', title: 'rm -rf build', summary: 'rm -rf build', input: {}, options: OPTS, waitMs });
  return { p, id: b.pending().at(-1)!.id };
};
const taskEvent = (bus: EventBus, id: string, status: string): void => bus.emit({ type: 'task.updated', task: { id, status } } as unknown as LegionEvent);
const ids = (b: ApprovalBroker): string[] => b.closedCards().map((c) => c.card.id);

test('a card that ran out of time is kept whole with its note; an open card and a card closed by the task ending are not', async () => {
  const bus = new EventBus();
  const b = new ApprovalBroker(bus);
  const open = ask(b);
  assert.deepEqual(ids(b), [], 'a card that is still open is not a closed card');
  const timed = ask(b, 't1', 20);
  await timed.p;
  assert.deepEqual(ids(b), [timed.id]);
  const kept = b.closedCards()[0]!;
  assert.equal(kept.note, ACP_CLOSED_NOTE);
  assert.equal(kept.card.acpTitle, 'rm -rf build');
  assert.deepEqual(kept.card.acpOptions?.map((o) => o.optionId), ['o1', 'o2'], 'the whole card, so a reloaded window draws it as before');
  b.cancelForTask('t1'); // the task ended: the open card closes without staying
  await open.p;
  assert.deepEqual(ids(b), [timed.id], 'a card closed because the task ended does not stay');
});

test('Dismiss removes it, a late answer is remembered on it, and the list is capped', async () => {
  const bus = new EventBus();
  const b = new ApprovalBroker(bus);
  const a = ask(b, 't1', 10); await a.p;
  assert.equal(b.resolve(a.id, true, undefined, 'o1'), false);
  assert.equal(b.lateNote(a.id), ACP_LATE_NOTE);
  assert.equal(b.closedCards()[0]!.late, ACP_LATE_NOTE, 'the late answer shows after a reload too');
  assert.equal(b.dismissClosed(a.id), true);
  assert.deepEqual(ids(b), []);
  assert.equal(b.dismissClosed(a.id), false, 'unknown or already dismissed');
  for (let i = 0; i < 205; i++) { const x = ask(b, 't1', 1); await x.p; }
  assert.equal(b.closedCards().length, 200, 'the oldest go first');
});

test('the task ending (cancelled or deleted) or a new turn after a finished one drops its closed cards; a normal finish keeps them', async () => {
  const bus = new EventBus();
  const b = new ApprovalBroker(bus);
  const mk = async (taskId: string): Promise<string> => { const x = ask(b, taskId, 5); await x.p; return x.id; };
  const c1 = await mk('t1'); await mk('t2');
  taskEvent(bus, 't1', 'running');
  assert.equal(b.closedCards().length, 2, 'the run going on does not drop it');
  taskEvent(bus, 't1', 'done');
  assert.ok(ids(b).includes(c1), 'a normal finish keeps it until dismissed');
  taskEvent(bus, 't1', 'running');
  assert.ok(!ids(b).includes(c1), 'a new turn drops it');
  assert.equal(b.closedCards().length, 1);
  taskEvent(bus, 't2', 'cancelled');
  assert.equal(b.closedCards().length, 0, 'cancelled drops it');
  await mk('t3');
  bus.emit({ type: 'task.deleted', taskId: 't3' } as unknown as LegionEvent);
  assert.equal(b.closedCards().length, 0, 'deleted drops it');
});

test('GET /api/state carries the closed cards (visible agents only) and POST /api/approvals/:id/dismiss removes one', async () => {
  const f = makeFakes();
  f.agents.set('a1', mkAgent('a1'));
  const b = new ApprovalBroker(f.bus);
  const mine = ask(b, 't1', 5); await mine.p;
  const dismissed: string[] = [];
  const real = b.dismissClosed.bind(b);
  const approvals = Object.assign(Object.create(b), { pending: () => [], closedCards: () => b.closedCards(), dismissClosed: (id: string) => { dismissed.push(id); return real(id); } });
  const ctx = { ...f.ctx, approvals };
  const s = await start(ctx);
  try {
    const snap = await (await fetch(`${s.base}/api/state`, { headers: AUTH })).json() as { closedCards?: Array<{ card: { id: string }; note: string }> };
    assert.deepEqual(snap.closedCards?.map((c) => c.card.id), [mine.id]);
    assert.equal(snap.closedCards?.[0]?.note, ACP_CLOSED_NOTE);
    const r = await fetch(`${s.base}/api/approvals/${mine.id}/dismiss`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(dismissed, [mine.id]);
    const after = await (await fetch(`${s.base}/api/state`, { headers: AUTH })).json() as { closedCards?: unknown[] };
    assert.deepEqual(after.closedCards, []);
    const client = await fetch(`${s.base}/api/approvals/${mine.id}/dismiss`, { method: 'POST', headers: { Authorization: AUTH.Authorization!, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(client.status, 403, 'a token-only client cannot dismiss: it is the window\'s call');
  } finally { await s.close(); }
});
