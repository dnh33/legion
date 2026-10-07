import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import type { ChatMessage, Task } from '../src/shared/types.js';

const tmp = () => cleanupTemp('legion-store-');
const task = (id: string, status: Task['status'], updatedAt: string, agentId = 'zealot'): Task => ({
  id, agentId, title: id, status, source: 'ui', requestedModel: 'auto', createdAt: updatedAt, updatedAt,
});

test('seedDefaults creates the three agents, is idempotent and keeps edits', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'workspaces'));
  const ids = s.listAgents().map((a) => a.id).filter((id) => ['builder', 'scout', 'zealot'].includes(id)).sort();
  assert.deepEqual(ids, ['builder', 'scout', 'zealot']);
  assert.equal(s.getAgent('builder')!.vm.size, 'default', 'Builder no longer defaults to large (free trials refuse it)');
  assert.equal(s.getAgent('scout')!.vm.enabled, false);
  assert.equal(s.getAgent('scout')!.model, 'sonnet');
  assert.equal(s.getAgent('zealot')!.approval, 'auto-edits');
  assert.equal(s.getAgent('builder')!.approval, 'full');
  assert.equal(s.getAgent('scout')!.approval, 'ask');
  assert.equal(s.getAgent('zealot')!.cwd, join(dir, 'workspaces', 'zealot'));
  assert.deepEqual(s.getAgent('zealot')!.mcpServers, ['*']);
  assert.equal(s.getAgent('zealot')!.vm.idleStopMinutes, 15);
  const edited = { ...s.getAgent('zealot')!, name: 'Renamed' };
  s.upsertAgent(edited);
  s.seedDefaults(join(dir, 'workspaces'));
  assert.equal(s.listAgents().length, 14); // the three defaults plus the eleven-bot muster roster
  assert.equal(s.getAgent('zealot')!.name, 'Renamed');
  rmSync(dir, { recursive: true, force: true });
});

test('persistence round-trip after flush', async () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  s.upsertTask(task('t1', 'done', '2026-01-01T00:00:00.000Z'));
  s.upsertVm({ agentId: 'zealot', sandboxId: 'bx_1', state: 'ready', size: 'default', lastUsedAt: null, createdAt: null });
  const m: ChatMessage = { id: 'm1', taskId: 't1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' };
  s.addMessage(m);
  await s.flush();
  assert.ok(existsSync(join(dir, 'state.json')));
  assert.ok(!existsSync(join(dir, 'state.json.tmp')));
  assert.ok(readFileSync(join(dir, 'messages', 't1.jsonl'), 'utf8').includes('"m1"'));

  const s2 = new Store(dir);
  assert.equal(s2.listAgents().length, 14);
  assert.equal(s2.getTask('t1')!.status, 'done');
  assert.equal(s2.getVm('zealot').sandboxId, 'bx_1');
  assert.deepEqual(s2.listMessages('t1'), [m]);
  assert.deepEqual(s2.listMessages('nope'), []);
  s2.addMessage({ ...m, id: 'm2', text: 'again' });
  assert.deepEqual(s2.listMessages('t1').map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(new Store(dir).listMessages('t1').map((x) => x.id), ['m1', 'm2']);
  rmSync(dir, { recursive: true, force: true });
});

test('debounced write happens without explicit flush', async () => {
  const dir = tmp();
  const s = new Store(dir, { saveDebounceMs: 20 });
  s.upsertTask(task('t1', 'done', '2026-01-01T00:00:00.000Z'));
  assert.ok(!existsSync(join(dir, 'state.json')));
  // Poll for file to appear instead of fixed sleep
  const maxWait = 2000;
  const pollInterval = 5;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    if (existsSync(join(dir, 'state.json'))) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  assert.ok(existsSync(join(dir, 'state.json')));
  rmSync(dir, { recursive: true, force: true });
});

test('listTasks orders newest first, filters by agent, applies limit', () => {
  const s = new Store(tmp());
  s.upsertTask(task('a', 'done', '2026-01-01T00:00:00.000Z', 'zealot'));
  s.upsertTask(task('b', 'done', '2026-01-03T00:00:00.000Z', 'scout'));
  s.upsertTask(task('c', 'done', '2026-01-02T00:00:00.000Z', 'zealot'));
  assert.deepEqual(s.listTasks().map((t) => t.id), ['b', 'c', 'a']);
  assert.deepEqual(s.listTasks(200, 'zealot').map((t) => t.id), ['c', 'a']);
  assert.deepEqual(s.listTasks(1).map((t) => t.id), ['b']);
});

test('getVm returns default record; deleteAgent removes agent and vm', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  const v = s.getVm('builder');
  assert.equal(v.state, 'none');
  assert.equal(v.sandboxId, null);
  assert.equal(v.size, 'default');
  assert.equal(s.getVm('ghost').size, 'default');
  s.upsertVm({ ...v, sandboxId: 'bx_2' });
  assert.equal(s.deleteAgent('builder'), true);
  assert.equal(s.deleteAgent('builder'), false);
  assert.equal(s.listVms().length, 0);
});

test('recoverInterrupted marks running/queued tasks as error', () => {
  const s = new Store(tmp());
  s.upsertTask(task('r', 'running', '2026-01-01T00:00:00.000Z'));
  s.upsertTask(task('q', 'queued', '2026-01-01T00:00:00.000Z'));
  s.upsertTask(task('d', 'done', '2026-01-01T00:00:00.000Z'));
  assert.equal(s.recoverInterrupted(), 2);
  assert.equal(s.getTask('r')!.status, 'error');
  assert.equal(s.getTask('q')!.error, 'Legion restarted');
  assert.equal(s.getTask('d')!.status, 'done');
  assert.equal(s.recoverInterrupted(), 0);
});

test('corrupt state.json does not crash', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), '{not json');
  const s = new Store(dir);
  assert.equal(s.listAgents().length, 0);
});

test('deleteTask removes task and messages file; archived tasks are hidden unless requested', async () => {
  const dir = tmp();
  const s = new Store(dir);
  s.upsertTask(task('a', 'done', '2026-01-01T00:00:00Z'));
  s.upsertTask({ ...task('b', 'done', '2026-01-02T00:00:00Z'), archived: true });
  s.addMessage({ id: 'm1', taskId: 'a', role: 'user', text: 'x', at: '2026-01-01T00:00:00Z' } as ChatMessage);
  assert.deepEqual(s.listTasks().map((t) => t.id), ['a']);
  assert.deepEqual(s.listTasks(200, undefined, true).map((t) => t.id), ['b', 'a']);
  assert.ok(existsSync(join(dir, 'messages', 'a.jsonl')));
  assert.equal(s.deleteTask('a'), true);
  assert.equal(s.deleteTask('a'), false);
  assert.equal(s.getTask('a'), undefined);
  assert.deepEqual(s.listMessages('a'), []);
  assert.ok(!existsSync(join(dir, 'messages', 'a.jsonl')));
  await s.flush();
  assert.deepEqual(new Store(dir).listTasks(10, undefined, true).map((t) => t.id), ['b']);
});

test('seedDefaults keeps the frozen three first and adds the muster roster after them', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  const ids = s.listAgents().map((a) => a.id);
  assert.deepEqual(ids.slice(0, 3), ['zealot', 'builder', 'scout']);
  assert.equal(ids.length, 14);
  assert.equal(s.getAgent('assayer')!.requires, 'bsv');
  rmSync(dir, { recursive: true, force: true });
});
