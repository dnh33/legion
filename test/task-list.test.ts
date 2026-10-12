import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorClaudeTaskCall, TaskList, TaskListStore, TASK_LIST_MAX } from '../src/core/task-list.js';

test('create numbers tasks 1, 2, 3 and starts them pending', () => {
  const l = new TaskList();
  assert.equal(l.create({ subject: 'Read the spec', description: 'all of it' }).id, '1');
  const b = l.create({ subject: 'Write the test', description: '', activeForm: 'Writing the test' });
  assert.equal(b.id, '2');
  assert.deepEqual(l.get('2'), { id: '2', subject: 'Write the test', description: '', status: 'pending', activeForm: 'Writing the test', blocks: [], blockedBy: [] });
  assert.deepEqual(l.list().map((t) => t.id), ['1', '2']);
});

test('create with a given id mirrors a list kept elsewhere (Claude Code numbers its own tasks); the next own id follows it', () => {
  const l = new TaskList();
  l.create({ subject: 'a', description: '' }, '7');
  assert.equal(l.get('7')?.subject, 'a');
  assert.equal(l.create({ subject: 'b', description: '' }).id, '8');
});

test('update changes only the fields it names and reports them, like Claude Code does', () => {
  const l = new TaskList();
  l.create({ subject: 'Run tests', description: 'npm test' });
  const r = l.update({ taskId: '1', status: 'in_progress', activeForm: 'Running tests' });
  assert.deepEqual(r, { success: true, taskId: '1', updatedFields: ['activeForm', 'status'], statusChange: { from: 'pending', to: 'in_progress' } });
  assert.equal(l.get('1')?.description, 'npm test');
  assert.equal(l.update({ taskId: '1', status: 'completed' }).statusChange?.to, 'completed');
});

test('update on an unknown id fails plainly and changes nothing', () => {
  const l = new TaskList();
  const r = l.update({ taskId: '9', status: 'completed' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /9/);
  assert.equal(l.list().length, 0);
});

test('blockers are kept on both sides; an unknown blocker id is refused, not silently dropped', () => {
  const l = new TaskList();
  l.create({ subject: 'a', description: '' });
  l.create({ subject: 'b', description: '' });
  l.create({ subject: 'c', description: '' });
  assert.equal(l.update({ taskId: '3', addBlockedBy: ['1'] }).success, true);
  assert.equal(l.update({ taskId: '1', addBlocks: ['2'] }).success, true);
  assert.deepEqual(l.get('1')?.blocks, ['3', '2']);
  assert.deepEqual(l.get('3')?.blockedBy, ['1']);
  assert.deepEqual(l.get('2')?.blockedBy, ['1']);
  // the same blocker twice is kept once
  l.update({ taskId: '3', addBlockedBy: ['1'] });
  assert.deepEqual(l.get('3')?.blockedBy, ['1']);
  const bad = l.update({ taskId: '3', addBlockedBy: ['42'] });
  assert.equal(bad.success, false);
  assert.deepEqual(l.get('3')?.blockedBy, ['1']);
  // a task cannot block itself
  assert.equal(l.update({ taskId: '3', addBlockedBy: ['3'] }).success, false);
});

test('status "deleted" removes the task and every link to it', () => {
  const l = new TaskList();
  l.create({ subject: 'a', description: '' });
  l.create({ subject: 'b', description: '' });
  l.update({ taskId: '2', addBlockedBy: ['1'] });
  assert.equal(l.update({ taskId: '1', status: 'deleted' }).success, true);
  assert.equal(l.get('1'), null);
  assert.deepEqual(l.get('2')?.blockedBy, []);
  // a deleted id is not handed out again
  assert.equal(l.create({ subject: 'c', description: '' }).id, '3');
});

test('the list is bounded: past the cap create throws with the reason', () => {
  const l = new TaskList();
  for (let i = 0; i < TASK_LIST_MAX; i++) l.create({ subject: `t${i}`, description: '' });
  assert.throws(() => l.create({ subject: 'one more', description: '' }), /at most/);
});

test('an empty subject is refused; long text is clipped', () => {
  const l = new TaskList();
  assert.throws(() => l.create({ subject: '   ', description: '' }), /subject/);
  const t = l.create({ subject: 'x'.repeat(500), description: 'y'.repeat(10_000) });
  assert.ok(t.subject.length <= 200);
  assert.ok(t.description.length <= 4000);
});

test('todos() is the live checklist shape: subject as content, status and activeForm carried, in id order', () => {
  const l = new TaskList();
  l.create({ subject: 'one', description: '' });
  l.create({ subject: 'two', description: '', activeForm: 'Doing two' });
  l.update({ taskId: '2', status: 'in_progress' });
  l.update({ taskId: '1', status: 'completed' });
  assert.deepEqual(l.todos(), [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
  ]);
});

test('a list survives a JSON round trip; damaged entries are dropped, never trusted', () => {
  const l = new TaskList();
  l.create({ subject: 'a', description: 'd' });
  l.create({ subject: 'b', description: '' });
  l.update({ taskId: '2', addBlockedBy: ['1'], status: 'in_progress' });
  const back = TaskList.fromJSON(JSON.parse(JSON.stringify(l)));
  assert.deepEqual(back.list(), l.list());
  assert.equal(back.create({ subject: 'c', description: '' }).id, '3');
  const damaged = TaskList.fromJSON({ nextId: 'x', tasks: [{ id: '1', subject: 'ok', status: 'weird' }, { subject: 'no id' }, 'junk'] });
  assert.deepEqual(damaged.list().map((t) => [t.id, t.status]), [['1', 'pending']]);
  assert.equal(TaskList.fromJSON(null).list().length, 0);
});

test('the store keeps one file per Legion task and reloads it; an unreadable file is an empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-tasklist-'));
  try {
    const s = new TaskListStore(dir);
    const l = s.load('task_1');
    assert.equal(l.list().length, 0);
    l.create({ subject: 'keep me', description: '' });
    s.save('task_1', l);
    assert.equal(new TaskListStore(dir).load('task_1').get('1')?.subject, 'keep me');
    assert.equal(s.load('task_2').list().length, 0);
    // a task id with path characters cannot escape the folder
    s.save('../evil', l);
    assert.ok(readdirSync(dir).every((n) => !n.includes('..') && !n.includes('/')));
    writeFileSync(join(dir, 'task_3.json'), '{not json');
    assert.equal(s.load('task_3').list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remove deletes a task\'s list file; removing one that never existed is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-tasklist-'));
  try {
    const s = new TaskListStore(dir);
    const l = new TaskList();
    l.create({ subject: 'gone soon', description: '' });
    s.save('task_1', l);
    s.remove('task_1');
    assert.equal(s.load('task_1').list().length, 0);
    assert.deepEqual(readdirSync(dir), []);
    s.remove('never');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mirror: a TaskList result updates status and links but keeps what it does not carry (activeForm, description)', () => {
  let l = new TaskList();
  l = mirrorClaudeTaskCall(l, { name: 'TaskCreate', input: { subject: 'one', description: 'details', activeForm: 'Doing one' } }, { structured: { task: { id: '1', subject: 'one' } }, text: '', isError: false })!;
  l = mirrorClaudeTaskCall(l, { name: 'TaskList', input: {} }, { structured: { tasks: [{ id: '1', subject: 'one', status: 'in_progress', blockedBy: [] }, { id: '2', subject: 'two', status: 'pending', blockedBy: ['1'] }] }, text: '', isError: false })!;
  assert.deepEqual(l.get('1'), { id: '1', subject: 'one', description: 'details', status: 'in_progress', activeForm: 'Doing one', blocks: ['2'], blockedBy: [] });
  assert.deepEqual(l.get('2')?.blockedBy, ['1']);
});

test('mirror: numeric ids from Claude Code are read as the same ids', () => {
  let l = new TaskList();
  l = mirrorClaudeTaskCall(l, { name: 'TaskCreate', input: { subject: 'one', description: '' } }, { structured: { task: { id: 1, subject: 'one' } }, text: '', isError: false })!;
  assert.equal(l.get('1')?.subject, 'one');
  l = mirrorClaudeTaskCall(l, { name: 'TaskList', input: {} }, { structured: { tasks: [{ id: 1, subject: 'one', status: 'completed', blockedBy: [] }] }, text: '', isError: false })!;
  assert.equal(l.get('1')?.status, 'completed');
});

test('list order is numeric first, then text ids, the same every time', () => {
  const l = new TaskList();
  for (const id of ['a', '10', 'b', '2']) l.create({ subject: id, description: '' }, id);
  assert.deepEqual(l.list().map((t) => t.id), ['2', '10', 'a', 'b']);
});
