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

test('end to end: a provider run\'s mcp__host__shell call really runs on this host, inside its root, without Legion\'s key', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'legion-host-e2e-'));
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-' + 'ant-must-not-reach-the-shell';
  let n = 0;
  const f = await startFake((_r, res) => {
    n++;
    if (n === 1) replyTools(res, [{ id: 's1', name: 'mcp__host__shell', args: { command: 'node -e "console.log(process.cwd()); console.log(\'KEY=\' + (process.env.ANTHROPIC_API_KEY || \'absent\'))"' } }]);
    else replyText(res, 'done');
  });
  try {
    const h = setup(f, { agent: { approval: 'full', host: { enabled: true, rootDir: root } } });
    const t = await run(h);
    assert.equal(t.status, 'done');
    const out = toolMsg(f.requests[1]!, 's1');
    assert.match(out, /exit code: 0/);
    assert.ok(out.toLowerCase().includes(root.toLowerCase()), `ran in its root: ${out}`);
    assert.match(out, /KEY=absent/);
    assert.ok(t.tainted, 'a host call taints the run');
  } finally {
    await f.close();
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('a continued provider run sees its open tasks in the system prompt from the first turn', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'carry me', description: '' } }]); else replyText(res, 'done'); });
  try {
    const h = setup(f);
    const t = await run(h, 'one');
    await run(h, 'two', { continueTaskId: t.id });
    const sys = (f.requests.at(-1)!.body.messages as any[])[0].content as string;
    assert.match(sys, /\[Your task list for this conversation, kept by Legion\]/);
    assert.match(sys, /1\. carry me \(pending\)/);
  } finally { await f.close(); }
});

test('a provider run with no tasks gets no task-list block at all', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok'));
  try {
    const h = setup(f);
    await run(h);
    assert.doesNotMatch((f.requests[0]!.body.messages as any[])[0].content, /kept by Legion\]/);
  } finally { await f.close(); }
});

test('a provider todo change marks the list for handover to the next Claude run', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__todo_create', args: { subject: 'x', description: '' } }]); else replyText(res, 'done'); });
  try {
    const h = setup(f);
    const t = await run(h);
    const { TaskListStore } = await import('../src/core/task-list.js');
    const { join } = await import('node:path');
    assert.equal(new TaskListStore(join(h.config.workspaceDir, '.task-lists')).load(t.id).handoverPending, true);
  } finally { await f.close(); }
});

/** A thread with one open task, buried past the compaction threshold, then continued. Returns the stored summary rows. */
async function compactedThread(withList: boolean, refuseOnce: boolean): Promise<string[]> {
  const { COMPACTION_MARKER } = await import('../src/core/providers/compaction.js');
  const { compactionGuard } = await import('../src/core/providers/tool-loop.js');
  const { TaskList, TaskListStore } = await import('../src/core/task-list.js');
  const { jsonReply } = await import('./providers-fakes.js');
  const { join } = await import('node:path');
  let armed = false;
  let refusals = 0;
  const f = await startFake((req, res) => {
    if (/DATA to summarise/.test(JSON.stringify(req.body) ?? '')) { replyText(res, '## Goal\nkeep going\n\n## Key Decisions\ncarry on'); return; }
    if (armed && refuseOnce && !refusals) { refusals++; jsonReply(res, 400, { error: { message: "This model's maximum context length is 8192 tokens, however you requested 12000 tokens." } }); return; }
    replyText(res, 'ok');
  });
  try {
    const h = setup(f, { entry: { contextWindow: 8_192 } });
    const first = await run(h, 'a short ask');
    if (withList) {
      const l = new TaskList();
      l.create({ subject: 'survive the summary', description: '' });
      new TaskListStore(join(h.config.workspaceDir, '.task-lists')).save(first.id, l);
    }
    const store = h.store as unknown as { addMessage(m: { taskId: string; role: string; text: string }): unknown };
    const lines = refuseOnce ? 60 : 120;
    for (let i = 0; i < lines; i++) store.addMessage({ taskId: first.id, role: 'assistant', text: `work ${i}: ${'filler text about the migration. '.repeat(10)}` });
    compactionGuard.forget(first.id);
    armed = true;
    const next = h.engine.startTask({ agentId: h.agent.id, prompt: 'carry on', source: 'ui', continueTaskId: first.id } as never);
    await h.engine.waitFor(next.id, 20_000);
    if (refuseOnce) assert.equal(refusals, 1, 'the overflow path ran');
    return h.store.listMessages(first.id).filter((m) => m.role === 'system' && m.text.startsWith(COMPACTION_MARKER)).map((m) => m.text);
  } finally { await f.close(); }
}

test('after a compaction the summary carries the task list, so the open tasks survive it (pre-flight and overflow paths)', async () => {
  for (const refuseOnce of [false, true]) {
    const rows = await compactedThread(true, refuseOnce);
    assert.ok(rows.length > 0, 'a compaction happened');
    assert.match(rows.at(-1)!, /\n\n\[Your task list for this conversation, kept by Legion\]\n- \[ \] 1\. survive the summary \(pending\)$/);
  }
});

test('a compaction in a thread with no tasks leaves the summary row as it was', async () => {
  const rows = await compactedThread(false, false);
  assert.ok(rows.length > 0, 'a compaction happened');
  assert.doesNotMatch(rows.at(-1)!, /kept by Legion\]/);
});

test('todo_create says the task list is private and shared work belongs on the project board', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok'));
  try {
    const h = setup(f);
    await run(h);
    const tool = (f.requests[0]!.body.tools as any[]).find((t) => t.function?.name === 'mcp__legion__todo_create');
    assert.ok(tool, 'todo_create is offered');
    assert.match(tool.function.description, /project board/);
  } finally { await f.close(); }
});
