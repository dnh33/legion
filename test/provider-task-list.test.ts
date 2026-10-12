import test from 'node:test';
import assert from 'node:assert/strict';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import type { FakeReq } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';

/** The tool message the model was shown for `id`, from the request that followed. */
const toolMsg = (req: FakeReq, id: string): string => (req.body.messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
const progressOf = (events: any[], id: string) => events.filter((e) => e.type === 'task.progress' && e.taskId === id).map((e) => e.progress);

test('a provider run keeps its own task list: create, update, get and list answer in Claude Code\'s shapes, with no card and no taint', async () => {
  let n = 0;
  const f = await startFake((_r, res) => {
    n++;
    if (n === 1) replyTools(res, [
      { id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'Read the spec', description: 'all of it', activeForm: 'Reading the spec' } },
      { id: 'c2', name: 'mcp__legion__todo_create', args: { subject: 'Write the test', description: '' } },
    ]);
    else if (n === 2) replyTools(res, [
      { id: 'u1', name: 'mcp__legion__todo_update', args: { taskId: '1', status: 'in_progress' } },
      { id: 'u2', name: 'mcp__legion__todo_update', args: { taskId: '2', addBlockedBy: ['1'] } },
      { id: 'u3', name: 'mcp__legion__todo_update', args: { taskId: '9', status: 'completed' } },
    ]);
    else if (n === 3) replyTools(res, [{ id: 'g1', name: 'mcp__legion__todo_get', args: { taskId: '2' } }, { id: 'l1', name: 'mcp__legion__todo_list', args: {} }]);
    else replyText(res, 'done');
  });
  try {
    const h = setup(f); // approval 'ask': a card here would hang the run until it timed out
    const t = await run(h);
    assert.equal(t.status, 'done');
    assert.equal(h.approvals.pending().length, 0);
    assert.equal(h.events.some((e) => e.type === 'approval.requested'), false, 'the task list is the run\'s own notes: never carded');
    assert.ok(!t.tainted, 'the task list brings in no outside content');
    assert.deepEqual(JSON.parse(toolMsg(f.requests[1]!, 'c1')), { task: { id: '1', subject: 'Read the spec' } });
    assert.deepEqual(JSON.parse(toolMsg(f.requests[1]!, 'c2')), { task: { id: '2', subject: 'Write the test' } });
    assert.deepEqual(JSON.parse(toolMsg(f.requests[2]!, 'u1')), { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } });
    assert.match(toolMsg(f.requests[2]!, 'u3'), /no task #9/i);
    const got = JSON.parse(toolMsg(f.requests[3]!, 'g1'));
    assert.deepEqual(got.task.blockedBy, ['1']);
    assert.equal(got.task.description, '');
    assert.deepEqual(JSON.parse(toolMsg(f.requests[3]!, 'l1')), { tasks: [
      { id: '1', subject: 'Read the spec', status: 'in_progress', blockedBy: [] },
      { id: '2', subject: 'Write the test', status: 'pending', blockedBy: ['1'] },
    ] });
  } finally { await f.close(); }
});

test('a provider run shows the live checklist and its turn against the limit, like a Claude run', async () => {
  let n = 0;
  const f = await startFake((_r, res) => {
    n++;
    if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'one', description: '', activeForm: 'Doing one' } }]);
    else if (n === 2) replyTools(res, [{ id: 'u1', name: 'mcp__legion__todo_update', args: { taskId: '1', status: 'completed' } }]);
    else replyText(res, 'done');
  });
  try {
    const h = setup(f, { maxTurns: 12 });
    const t = await run(h);
    const ps = progressOf(h.events, t.id);
    assert.ok(ps.length > 0, 'a provider run sends task.progress');
    assert.ok(ps.every((p) => p.maxTurns === 12), 'the limit is the provider loop\'s own');
    assert.deepEqual(ps.map((p) => p.turn).filter((x, i, a) => a.indexOf(x) === i), [1, 2, 3]);
    const lists = ps.filter((p) => p.todos).map((p) => p.todos);
    assert.deepEqual(lists[0], [{ content: 'one', status: 'pending', activeForm: 'Doing one' }]);
    assert.deepEqual(lists.at(-1), [{ content: 'one', status: 'completed', activeForm: 'Doing one' }]);
  } finally { await f.close(); }
});

test('a continued provider conversation keeps its task list: the next run lists what the first one made', async () => {
  let n = 0;
  const f = await startFake((_r, res) => {
    n++;
    if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'carry me', description: '' } }]);
    else if (n === 3) replyTools(res, [{ id: 'l1', name: 'mcp__legion__todo_list', args: {} }]);
    else replyText(res, 'done');
  });
  try {
    const h = setup(f);
    const t = await run(h, 'one');
    await run(h, 'two', { continueTaskId: t.id });
    assert.deepEqual(JSON.parse(toolMsg(f.requests[3]!, 'l1')).tasks.map((x: any) => x.subject), ['carry me']);
    // and a different task starts with an empty list
    n = 2;
    const other = await run(h, 'three');
    assert.notEqual(other.id, t.id);
    assert.deepEqual(JSON.parse(toolMsg(f.requests.at(-1)!, 'l1')).tasks, []);
  } finally { await f.close(); }
});

