import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker, needsApproval, summarizeToolInput } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import type { LegionEvent } from '../src/shared/types.js';

test('needsApproval matrix', () => {
  for (const t of ['Bash', 'Write', 'mcp__x__y', 'Whatever']) assert.equal(needsApproval('full', t), false);
  for (const mode of ['ask', 'auto-edits'] as const) {
    for (const t of ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'mcp__legion__vm_exec']) {
      assert.equal(needsApproval(mode, t), false, `${mode} ${t}`);
    }
    for (const t of ['Bash', 'mcp__github__create_issue', 'Mystery']) assert.equal(needsApproval(mode, t), true, `${mode} ${t}`);
  }
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(needsApproval('ask', t), true);
    assert.equal(needsApproval('auto-edits', t), false);
  }
});

test('summarizeToolInput', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(summarizeToolInput('Write', { file_path: '/a/b.txt', content: 'x' }), '/a/b.txt');
  assert.equal(summarizeToolInput('Edit', { file_path: '/a/c.txt' }), '/a/c.txt');
  assert.equal(summarizeToolInput('mcp__a__b', { q: 1 }), '{"q":1}');
  assert.ok(summarizeToolInput('Bash', { command: 'x'.repeat(1000) }).length <= 400);
  assert.ok(summarizeToolInput('Other', { v: 'y'.repeat(1000) }).length <= 400);
});

test('broker allow / deny emits events and clears pending', async () => {
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const b = new ApprovalBroker(bus);
  const p1 = b.request('t1', 'a1', 'Bash', { command: 'rm x' });
  const p2 = b.request('t1', 'a1', 'Bash', { command: 'ls' });
  assert.equal(b.pending().length, 2);
  const [r1, r2] = b.pending();
  assert.equal(r1!.summary, 'rm x');
  assert.equal(b.resolve(r1!.id, true), true);
  assert.equal(b.resolve(r2!.id, false), true);
  assert.equal(b.resolve(r2!.id, false), false);
  assert.equal(await p1, true);
  assert.equal(await p2, false);
  assert.equal(b.pending().length, 0);
  assert.equal(events.filter((e) => e.type === 'approval.requested').length, 2);
  const resolved = events.filter((e) => e.type === 'approval.resolved') as Extract<LegionEvent, { type: 'approval.resolved' }>[];
  assert.deepEqual(resolved.map((e) => e.allowed), [true, false]);
});

test('broker auto-denies on timeout', async () => {
  const b = new ApprovalBroker(new EventBus(), { timeoutMs: 20 });
  assert.equal(await b.request('t', 'a', 'Bash', { command: 'x' }), false);
  assert.equal(b.pending().length, 0);
});

test('cancelForTask denies only that task', async () => {
  const b = new ApprovalBroker(new EventBus());
  const a = b.request('t1', 'a', 'Bash', {});
  const c = b.request('t2', 'a', 'Bash', {});
  b.cancelForTask('t1');
  assert.equal(await a, false);
  assert.equal(b.pending().length, 1);
  assert.equal(b.pending()[0]!.taskId, 't2');
  b.resolve(b.pending()[0]!.id, true);
  assert.equal(await c, true);
});

test('legion in-process tool prefixes need no approval; stricterMode picks the tighter mode', async () => {
  const { stricterMode } = await import('../src/core/approvals.js');
  for (const t of ['mcp__legion_comms__bot_send', 'mcp__legion_kg__kg_search']) assert.equal(needsApproval('ask', t), false);
  assert.equal(needsApproval('ask', 'mcp__legion_other__x'), true);
  assert.equal(stricterMode('full', 'ask'), 'ask');
  assert.equal(stricterMode('auto-edits', 'full'), 'auto-edits');
  assert.equal(stricterMode('ask', 'ask'), 'ask');
});

test('board tools are Legion tools: no card, no taint; foreign and lookalike tools keep both', async () => {
  const { isLegionTool } = await import('../src/core/approvals.js');
  const { taintsRun } = await import('../src/core/engine.js');
  for (const t of ['list', 'get', 'propose', 'create', 'update', 'delete']) {
    const n = `mcp__legion_board__${t}`;
    assert.equal(isLegionTool(n), true, n);
    assert.equal(needsApproval('ask', n), false, n);
    assert.equal(taintsRun(n), false, n);
  }
  assert.equal(isLegionTool('mcp__legion_board__x__run'), false);
  assert.equal(isLegionTool('mcp__legion_boardish__list'), false);
  assert.equal(needsApproval('ask', 'mcp__legion_other__x'), true);
  assert.equal(taintsRun('mcp__legion_other__x'), true);
});

test('house tools are Legion tools: reading your own context layer must not stop for an approval card', async () => {
  // `mcp__legion_house__` was missing from LEGION_TOOL_PREFIXES, so every house_recall / house_read / house_list fell
  // through to the "Bash, other mcp__*, and unknown tools" branch and raised a card -- in 'ask' AND in 'auto-edits'.
  // An agent asking for the house rules is doing the most ordinary thing there is, and it was asking the owner for
  // permission to read a markdown file. Measured before the fix: needsApproval('ask') === true for all three tools.
  const { isLegionTool } = await import('../src/core/approvals.js');
  const { taintsRun } = await import('../src/core/engine.js');
  const { HOUSE_SERVER_NAME } = await import('../src/core/house/context.js');
  assert.equal(HOUSE_SERVER_NAME, 'legion_house');
  for (const t of ['house_recall', 'house_read', 'house_list']) {
    const n = `mcp__${HOUSE_SERVER_NAME}__${t}`;
    assert.equal(isLegionTool(n), true, `${n} must be recognised as a Legion tool`);
    assert.equal(needsApproval('ask', n), false, `${n} must not raise a card in 'ask'`);
    assert.equal(needsApproval('auto-edits', n), false, `${n} must not raise a card in 'auto-edits'`);
  }
  // A lookalike server is still foreign: the prefix must be exact, not a substring test.
  assert.equal(isLegionTool('mcp__legion_house__x__run'), false, 'a nested tool name is not ours');
  assert.equal(isLegionTool('mcp__legion_houseish__read'), false, 'a lookalike server is not ours');
  assert.equal(needsApproval('ask', 'mcp__legion_houseish__read'), true, 'and it still needs a card');
  assert.equal(taintsRun(`mcp__${HOUSE_SERVER_NAME}__house_read`), false);
});
