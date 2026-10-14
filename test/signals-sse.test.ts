import test from 'node:test';
import assert from 'node:assert/strict';
import { SseReader, eventSignals } from '../src/electron/signals-logic.js';

test('SSE reader: events split across chunks, comments and heartbeats ignored, bad JSON skipped', () => {
  const r = new SseReader();
  const got: unknown[] = [];
  const feed = (s: string) => { for (const e of r.push(s)) got.push(e); };
  feed(': connected\n\ndata: {"type":"away.updated"}\n\ndata: {"type":"att');
  feed('ention.updated","attention":{"total":2}}\n\n: hb\n\ndata: not json\n\r\n');
  feed('data: {"type":"a"}\r\n\r\n');
  assert.deepEqual(got, [{ type: 'away.updated' }, { type: 'attention.updated', attention: { total: 2 } }, { type: 'a' }]);
});

test('SSE reader: a runaway line without a newline is dropped, not buffered forever', () => {
  const r = new SseReader();
  assert.deepEqual(r.push('data: ' + 'x'.repeat(3_000_000)), []);
  assert.deepEqual(r.push('\n\ndata: {"type":"ok"}\n\n'), [{ type: 'ok' }]);
});

test('eventSignals: keeps ids and kinds only, from the core events', () => {
  const names = { agent: (id: string) => (id === 's' ? 'Scout' : undefined), project: (id: string) => (id === 'p' ? 'Shop' : undefined), projectOfTask: (t: string) => (t === 't9' ? 'p' : undefined) };
  const open = new Map();
  const a = eventSignals({ type: 'approval.requested', approval: { id: 'a1', taskId: 't9', agentId: 's', toolName: 'Bash', summary: 'rm -rf /', input: { command: 'rm -rf /' }, at: '' } } as never, open, names, new Map());
  assert.deepEqual(open.get('a:a1'), { key: 'a:a1', kind: 'approval', agentName: 'Scout', projectId: 'p', projectName: 'Shop', taskId: 't9' });
  assert.ok(!JSON.stringify([...open.values()]).includes('rm -rf'));
  assert.deepEqual(a, {});
  eventSignals({ type: 'approval.resolved', approvalId: 'a1', allowed: true } as never, open, names, new Map());
  assert.equal(open.size, 0);
  eventSignals({ type: 'question.requested', question: { id: 'q1', taskId: 't9', agentId: 's', questions: [{ question: 'secret text' }], at: '' } } as never, open, names, new Map());
  assert.equal(open.get('a:q1')?.kind, 'question');
  eventSignals({ type: 'question.resolved', questionId: 'q1', answered: true } as never, open, names, new Map());
  assert.equal(open.size, 0);
  const st = new Map<string, string>();
  const upd = (id: string, status: string) => eventSignals({ type: 'task.updated', task: { id, agentId: 's', status, projectId: 'p', result: 'secret failure text' } } as never, open, names, st);
  assert.deepEqual(upd('t9', 'error'), {}, 'first seen already failed (after a reconnect): not news');
  assert.deepEqual(upd('t1', 'running'), {});
  const f = upd('t1', 'error');
  assert.equal(f.failed?.length, 1);
  assert.equal(f.failed![0]!.agentName, 'Scout');
  assert.ok(!JSON.stringify(f).includes('secret failure text'));
  assert.deepEqual(upd('t1', 'error'), {}, 'a repeat update of a failed task is not a new failure');
  upd('t10', 'running');
  assert.equal(upd('t10', 'done').finished?.length, 1);
  upd('t11', 'queued');
  assert.deepEqual(upd('t11', 'cancelled'), {});
  const b = eventSignals({ type: 'budget.reached', projectId: 'p', period: 'week' } as never, open, names, new Map());
  assert.equal(b.budget?.[0]?.projectName, 'Shop');
});
