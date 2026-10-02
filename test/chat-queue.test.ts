/**
 * Composer message queue: the pure state machine (ui/src/chat/queue.ts) and the busy rules (ui/src/chat/busy.ts).
 * The store glue and the real UI are exercised by test-perf/chat-ui (Playwright against a real core with a scripted SDK).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalRequest, Task } from '../src/shared/types.js';
import {
  MAX_QUEUE, MAX_TEXT, OVERRIDE, beginSend, canDrain, cancelObserved, clear, countOf, edit, emptyState, enqueue, failureObserved, finishSend,
  lock, parseKey, pause, prune, queueOf, rejectMessage, rekey, remove, restore, resume, serialize, shouldQueue, takeLast, threadKey, unlock,
  type QState,
} from '../ui/src/chat/queue.js';
import { busyReason } from '../ui/src/chat/busy.js';

const K = 't:task1';
let n = 0;
const add = (s: QState, text: string, key = K, model = 'auto'): QState => {
  const r = enqueue(s, key, text, model, `i${++n}`, 1000 + n);
  assert.ok(r.ok, text);
  return r.state;
};
const texts = (s: QState, key = K) => (queueOf(s, key)?.items ?? []).map((i) => i.text);

test('keys: a task is a thread, a task-less agent view is its own thread', () => {
  assert.equal(threadKey('zealot', 'task9'), 't:task9');
  assert.equal(threadKey('zealot', null), 'n:zealot');
  assert.deepEqual(parseKey('t:task9'), { taskId: 'task9', agentId: null });
  assert.deepEqual(parseKey('n:zealot'), { taskId: null, agentId: 'zealot' });
});

test('enqueue keeps order, ignores blank text, and stores the model chosen at the time', () => {
  let s: QState = emptyState;
  s = add(s, 'one', K, 'opus'); s = add(s, 'two'); s = add(s, 'three');
  assert.deepEqual(texts(s), ['one', 'two', 'three']);
  assert.equal(queueOf(s, K)!.items[0]!.model, 'opus');
  const r = enqueue(s, K, '   \n ', 'auto', 'x', 1);
  assert.ok(!r.ok && r.reason === 'empty' && r.state === s);
  assert.equal(countOf(s, K), 3);
});

test('max length: the 21st message is refused with a visible reason and the queue is unchanged', () => {
  let s: QState = emptyState;
  for (let i = 0; i < MAX_QUEUE; i++) s = add(s, 'm' + i);
  const r = enqueue(s, K, 'one too many', 'auto', 'z', 5);
  assert.ok(!r.ok && r.reason === 'full' && r.state === s);
  assert.match(rejectMessage('full'), /queue is full \(20 messages\)/i);
  assert.equal(countOf(s, K), MAX_QUEUE);
  // another thread is not affected
  assert.ok(enqueue(s, 't:other', 'fine', 'auto', 'y', 5).ok);
});

test('very long messages: at the limit is fine, one character over is refused; storage cannot smuggle bigger ones back in', () => {
  let s: QState = emptyState;
  s = add(s, 'x'.repeat(MAX_TEXT));
  const r = enqueue(s, K, 'x'.repeat(MAX_TEXT + 1), 'auto', 'big', 1);
  assert.ok(!r.ok && r.reason === 'too-long');
  assert.match(rejectMessage('too-long'), /too long to queue/);
  const raw = JSON.stringify({ v: 1, threads: { [K]: { items: [{ id: 'a', text: 'y'.repeat(MAX_TEXT + 1), model: 'auto', at: 1 }, { id: 'b', text: 'ok', model: 'auto', at: 2 }], hold: null } } });
  assert.deepEqual(texts(restore(raw)), ['ok']);
});

test('multi-line text and slash commands queue like any message and come back verbatim', () => {
  let s: QState = emptyState;
  s = add(s, '/opus refactor the parser', K, 'auto'); s = add(s, 'line one\nline two\n\n  indented'); s = add(s, '/sonnet');
  assert.deepEqual(texts(s), ['/opus refactor the parser', 'line one\nline two\n\n  indented', '/sonnet']);
});

test('dequeue on run end: sends in order, one at a time, and only when idle', () => {
  let s: QState = emptyState;
  s = add(s, 'one'); s = add(s, 'two'); s = add(s, 'three');
  const t = () => queueOf(s, K);
  assert.equal(canDrain(t(), true), false, 'busy: holds');
  assert.equal(canDrain(t(), false), true, 'idle: goes');
  const a = beginSend(s, K)!; s = a.state;
  assert.equal(a.item.text, 'one');
  assert.equal(canDrain(t(), false), false, 'in flight: the next one waits');
  assert.equal(beginSend(s, K), null, 'cannot start a second send');
  s = finishSend(s, K, a.item.id, true);
  assert.deepEqual(texts(s), ['two', 'three']);
  assert.equal(canDrain(t(), true), false, 'the run for "one" is live again');
  assert.equal(canDrain(t(), false), true);
  const b = beginSend(s, K)!; assert.equal(b.item.text, 'two'); s = finishSend(b.state, K, b.item.id, true);
  const c = beginSend(s, K)!; assert.equal(c.item.text, 'three'); s = finishSend(c.state, K, c.item.id, true);
  assert.equal(queueOf(s, K), undefined, 'an emptied thread is dropped');
  assert.deepEqual(s, emptyState);
});

test('a failed send keeps the message, holds the queue with the reason, and never retries by itself', () => {
  let s = add(emptyState, 'one'); s = add(s, 'two');
  const a = beginSend(s, K)!;
  s = finishSend(a.state, K, a.item.id, false, 'Task is still running');
  assert.deepEqual(texts(s), ['one', 'two']);
  assert.equal(queueOf(s, K)!.hold, 'error');
  assert.equal(queueOf(s, K)!.error, 'Task is still running');
  assert.equal(canDrain(queueOf(s, K), false), false);
  s = resume(s, K);
  assert.equal(canDrain(queueOf(s, K), false), true);
  assert.equal(queueOf(s, K)!.error, undefined);
});

test('Ctrl+Enter override: locks the thread so nothing queued jumps ahead, then the queue carries on behind it', () => {
  let s = add(emptyState, 'queued 1'); s = add(s, 'queued 2');
  s = lock(s, K);
  assert.equal(queueOf(s, K)!.sending, OVERRIDE);
  assert.equal(canDrain(queueOf(s, K), false), false, 'idle moment between cancel and send: still locked');
  assert.equal(shouldQueue(queueOf(s, K), false), true, 'a plain Enter in that moment queues instead of overtaking');
  assert.equal(beginSend(s, K), null);
  s = cancelObserved(s, K, true);
  assert.equal(queueOf(s, K)!.hold, null, 'the cancel we caused does not pause the queue');
  s = unlock(s, K);
  assert.deepEqual(texts(s), ['queued 1', 'queued 2'], 'the rest of the queue stays queued');
  assert.equal(canDrain(queueOf(s, K), true), false, 'the override message is running: wait');
  assert.equal(canDrain(queueOf(s, K), false), true, 'then they follow, in order');
});

test('Ctrl+Enter whose send fails holds the queue instead of firing the next message at an unclear state', () => {
  let s = add(emptyState, 'queued 1');
  s = lock(s, K); s = unlock(s, K, 'Cannot reach Legion core');
  assert.equal(queueOf(s, K)!.hold, 'error');
  assert.equal(canDrain(queueOf(s, K), false), false);
});

test('lock on an empty thread is a no-op (nothing to protect)', () => {
  assert.equal(lock(emptyState, K), emptyState);
  assert.equal(unlock(emptyState, K), emptyState);
});

test('stop pauses: a user cancel never silently sends the next message; Resume goes on, Clear drops', () => {
  let s = add(emptyState, 'one'); s = add(s, 'two');
  s = cancelObserved(s, K, false);
  assert.equal(queueOf(s, K)!.hold, 'cancelled');
  assert.equal(canDrain(queueOf(s, K), false), false, 'idle after the cancel, still paused');
  assert.equal(shouldQueue(queueOf(s, K), false), false, 'a new message typed while paused and idle is sent at once');
  const resumed = resume(s, K);
  assert.equal(canDrain(queueOf(resumed, K), false), true);
  assert.deepEqual(texts(resumed), ['one', 'two']);
  const cleared = clear(s, K);
  assert.equal(queueOf(cleared, K), undefined);
});

test('stop with an empty queue pauses nothing and creates no thread', () => {
  assert.equal(cancelObserved(emptyState, K, false), emptyState);
  assert.equal(pause(emptyState, K), emptyState);
});

test('the first reason for a hold stands (a later failure does not overwrite a cancel)', () => {
  let s = add(emptyState, 'one');
  s = pause(s, K, 'cancelled'); s = failureObserved(s, K, 'boom');
  assert.equal(queueOf(s, K)!.hold, 'cancelled');
});

test('a failed run pauses the queue with the error text', () => {
  let s = add(emptyState, 'one');
  s = failureObserved(s, K, 'Budget exceeded');
  assert.equal(queueOf(s, K)!.hold, 'error');
  assert.equal(queueOf(s, K)!.error, 'Budget exceeded');
  assert.equal(canDrain(queueOf(s, K), false), false);
});

test('remove, edit in place, pull the last one back', () => {
  let s = add(emptyState, 'one'); s = add(s, 'two'); s = add(s, 'three');
  const [one, two] = queueOf(s, K)!.items;
  s = remove(s, K, two!.id);
  assert.deepEqual(texts(s), ['one', 'three']);
  const e = edit(s, K, one!.id, 'one, edited');
  assert.ok(e.ok); s = e.state;
  assert.deepEqual(texts(s), ['one, edited', 'three']);
  assert.equal(queueOf(s, K)!.items[0]!.id, one!.id, 'the item keeps its place and id');
  const emptied = edit(s, K, one!.id, '  ');
  assert.ok(emptied.ok); assert.deepEqual(texts(emptied.state), ['three'], 'editing to nothing removes it');
  const big = edit(s, K, one!.id, 'x'.repeat(MAX_TEXT + 1));
  assert.ok(!big.ok && big.reason === 'too-long' && big.state === s);
  const t = takeLast(s, K)!;
  assert.equal(t.item.text, 'three'); s = t.state;
  assert.deepEqual(texts(s), ['one, edited']);
  assert.equal(takeLast(emptyState, K), null);
});

test('the item in flight cannot be removed, edited or pulled back (it is already on its way)', () => {
  let s = add(emptyState, 'one'); s = add(s, 'two');
  const a = beginSend(s, K)!; s = a.state;
  assert.equal(remove(s, K, a.item.id), s);
  assert.ok(!edit(s, K, a.item.id, 'changed').ok);
  assert.equal(takeLast(s, K)!.item.text, 'two');
  const cleared = clear(s, K);
  assert.deepEqual(texts(cleared), ['one'], 'Clear leaves the one in flight');
  assert.equal(queueOf(cleared, K)!.hold, null);
});

test('queues are per thread: another thread is untouched, and untouched threads keep their identity', () => {
  let s = add(emptyState, 'a1', 't:a'); s = add(s, 'b1', 't:b');
  const b = queueOf(s, 't:b');
  s = add(s, 'a2', 't:a');
  assert.equal(queueOf(s, 't:b'), b, 'same object: a subscriber to thread b is not woken');
  s = cancelObserved(s, 't:a', false);
  assert.equal(queueOf(s, 't:a')!.hold, 'cancelled');
  assert.equal(queueOf(s, 't:b')!.hold, null, 'a stop in one thread pauses only that thread');
  assert.equal(canDrain(queueOf(s, 't:b'), false), true);
});

test('a "new task" queue continues as the new task\'s queue, in order', () => {
  let s = add(emptyState, 'first', 'n:zealot'); s = add(s, 'second', 'n:zealot'); s = add(s, 'third', 'n:zealot');
  const a = beginSend(s, 'n:zealot')!;
  s = finishSend(a.state, 'n:zealot', a.item.id, true);
  s = rekey(s, 'n:zealot', 't:task7');
  assert.equal(queueOf(s, 'n:zealot'), undefined);
  assert.deepEqual(texts(s, 't:task7'), ['second', 'third']);
  // merging onto an existing queue appends
  let m = add(emptyState, 'x', 't:task7'); m = add(m, 'y', 'n:zealot');
  assert.deepEqual(texts(rekey(m, 'n:zealot', 't:task7'), 't:task7'), ['x', 'y']);
});

test('prune drops the queues of deleted threads only', () => {
  let s = add(emptyState, 'a', 't:a'); s = add(s, 'b', 't:b');
  s = prune(s, (k) => k !== 't:a');
  assert.equal(queueOf(s, 't:a'), undefined);
  assert.deepEqual(texts(s, 't:b'), ['b']);
  assert.equal(prune(s, () => true), s);
});

test('persistence round trip: items, order and models survive, and EVERYTHING comes back held ("restored")', () => {
  let s = add(emptyState, 'one', K, 'opus'); s = add(s, 'two\nlines'); s = add(s, '/sonnet hi', 'n:zealot');
  const a = beginSend(s, K)!; s = a.state; // in flight at the moment of the reload
  const back = restore(serialize(s));
  assert.deepEqual(texts(back), ['one', 'two\nlines']);
  assert.equal(queueOf(back, K)!.items[0]!.model, 'opus');
  assert.deepEqual(texts(back, 'n:zealot'), ['/sonnet hi']);
  for (const k of [K, 'n:zealot']) {
    assert.equal(queueOf(back, k)!.hold, 'restored');
    assert.equal(queueOf(back, k)!.sending, null);
    assert.equal(canDrain(queueOf(back, k), false), false, 'never auto-sent after a reload');
  }
  const resumed = resume(back, K);
  assert.equal(canDrain(queueOf(resumed, K), false), true, 'only the owner\'s Resume lets it go');
  assert.equal(queueOf(back, 'n:zealot')!.hold, 'restored', 'other threads stay held');
});

test('persistence: a paused or failed queue does not come back running, and empty threads are not stored', () => {
  let s = add(emptyState, 'one'); s = pause(s, K, 'error', 'x');
  assert.equal(queueOf(restore(serialize(s)), K)!.hold, 'restored');
  assert.equal(serialize(emptyState), JSON.stringify({ v: 1, threads: {} }));
});

test('persistence: garbage, wrong versions and hostile shapes give an empty queue, not a crash', () => {
  for (const raw of [null, undefined, '', 'not json', '{}', '[]', '{"v":2,"threads":{}}', '{"v":1}', '{"v":1,"threads":[]}', '{"v":1,"threads":{"bad":{"items":[]}}}', '{"v":1,"threads":{"t:a":{"items":"no"}}}', '{"v":1,"threads":{"t:a":null}}']) {
    assert.deepEqual(restore(raw as string), emptyState, String(raw));
  }
  const mixed = JSON.stringify({ v: 1, threads: { 't:a': { items: [null, 1, { id: 1, text: 'no id' }, { id: 'ok', text: 'kept', model: 7 }, { id: 'e', text: '   ' }] } } });
  const s = restore(mixed);
  assert.deepEqual(texts(s, 't:a'), ['kept']);
  assert.equal(queueOf(s, 't:a')!.items[0]!.model, 'auto');
  // more than the limit is clamped
  const many = JSON.stringify({ v: 1, threads: { 't:a': { items: Array.from({ length: 50 }, (_, i) => ({ id: 'i' + i, text: 'm' + i, model: 'auto', at: i })) } } });
  assert.equal(countOf(restore(many), 't:a'), MAX_QUEUE);
});

test('shouldQueue: busy queues; items already waiting also queue (no overtaking); idle and empty sends', () => {
  const idleEmpty = undefined;
  assert.equal(shouldQueue(idleEmpty, false), false);
  assert.equal(shouldQueue(idleEmpty, true), true);
  const waiting = queueOf(add(emptyState, 'x'), K);
  assert.equal(shouldQueue(waiting, false), true);
  const held = queueOf(pause(add(emptyState, 'x'), K), K);
  assert.equal(shouldQueue(held, false), false, 'held + idle: the owner is typing a fresh message, send it');
  assert.equal(shouldQueue(held, true), true);
});

// ---------------------------------------------------------------- busy rules

const task = (id: string, agentId: string, status: Task['status'], source: Task['source'] = 'ui'): Task => ({
  id, agentId, title: id, status, source, requestedModel: 'auto', createdAt: '', updatedAt: '',
});
const appr = (taskId: string, agentId: string): ApprovalRequest => ({ id: 'ap-' + taskId, taskId, agentId, toolName: 'Bash', summary: 'ls', input: {}, at: '' });

test('busy: own run (running or queued) holds the queue', () => {
  assert.equal(busyReason('z', 't1', [task('t1', 'z', 'running')], []), 'run');
  assert.equal(busyReason('z', 't1', [task('t1', 'z', 'queued')], []), 'run');
  for (const st of ['done', 'error', 'cancelled'] as const) assert.equal(busyReason('z', 't1', [task('t1', 'z', st)], []), null, st);
});

test('busy: a pending approval counts as still running even when the task row says otherwise', () => {
  assert.equal(busyReason('z', 't1', [task('t1', 'z', 'done')], [appr('t1', 'z')]), 'approval');
  assert.equal(busyReason('z', 't1', [task('t1', 'z', 'running')], [appr('t1', 'z')]), 'run');
  assert.equal(busyReason('z', 't1', [task('t1', 'z', 'done')], [appr('other', 'z')]), null, 'an approval in another thread is not ours');
});

test('busy: the same agent working for a room, an agent call or MCP counts; the owner\'s own other tab and other agents do not', () => {
  const t1 = task('t1', 'z', 'done');
  for (const src of ['bot', 'agent', 'mcp', 'cli'] as const) assert.equal(busyReason('z', 't1', [t1, task('r1', 'z', 'running', src)], []), 'other', src);
  assert.equal(busyReason('z', 't1', [t1, task('tab2', 'z', 'running', 'ui')], []), null, 'own other tab runs in parallel as before');
  assert.equal(busyReason('z', 't1', [t1, task('r1', 's', 'running', 'bot')], []), null, 'a different agent');
  assert.equal(busyReason('z', 't1', [t1, task('r1', 'z', 'done', 'bot')], []), null, 'finished');
  assert.equal(busyReason('z', null, [task('r1', 'z', 'queued', 'bot')], []), 'other', 'the New task view of a busy agent');
  assert.equal(busyReason('z', null, [], []), null);
});
