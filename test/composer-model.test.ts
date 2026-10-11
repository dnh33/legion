/**
 * (c) The composer never overrides a bot's Settings model (`agent.model`).
 *
 * Two halves of the same leak, both measured before the fix:
 *  - `effectiveModel` preferred localStorage `legion.model.<agentId>` over `agent.model`, and that key was never
 *    cleared when the owner changed the model in Settings, so a stale pick beat Settings on every send;
 *  - every POST /api/tasks carried `model`, and because the engine only treats a model as an override when
 *    `modelOverrideBy` is present, an equal value won outright (no ceiling check, no modelOverride recorded).
 *  - a queue item restored from storage with no model of its own defaulted to 'auto', overriding Settings with
 *    the router's choice; it now goes out with no model at all, so the engine uses the agent's setting.
 *
 * No network: `fetch` is stubbed and only the body of POST /api/tasks is asserted. The store is UI code with
 * bundler-style imports, so - like armory-ui-store - it is bundled with esbuild first and then imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { AgentProfile, Task } from '../src/shared/types.js';
import { restore, queueOf } from '../ui/src/chat/queue.js';
import { tempDir } from './tmp-cleanup.js';

/* ---------- stubs: api.ts reads window at load, the store reads localStorage ---------- */
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
};
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
};

let sent: Record<string, unknown> | undefined;
const json = (data: unknown) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(data) });
const task: Task = {
  id: 'task_1', agentId: 'a1', title: 'hello', status: 'queued', source: 'ui',
  requestedModel: 'sonnet', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if ((init?.method ?? 'GET') === 'POST' && String(url).endsWith('/api/tasks')) {
    sent = JSON.parse(init!.body!);
    return json(task);
  }
  return json({ messages: [], start: 0, end: 0, total: 0, task }); // GET .../messages from loadTask
};

// The store is UI code (bundler-style imports), so it is bundled with esbuild the way the app bundles it, then imported.
const dir = tempDir('legion-composer-model-');
const entry = join(dir, 'entry.ts');
const rel = (p: string): string => join(process.cwd(), p).replace(/\\/g, '/');
writeFileSync(entry, `export * from '${rel('ui/src/store.ts')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const store = await import(pathToFileURL(join(dir, 'store.mjs')).href);

const mkAgent = (model: string): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: '*', description: 'does things', systemPrompt: '', model,
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [],
  createdAt: '', updatedAt: '',
});
const select = (model: string) => store.setState({ agents: [mkAgent(model)], selectedAgentId: 'a1', modelOverride: null, tasks: [] });

test('(c) a stale composer pick in localStorage never beats the model Settings says', () => {
  select('sonnet');
  mem.set('legion.model.a1', 'opus'); // picked before the owner changed the bot to sonnet
  assert.equal(store.effectiveModel(store.getState()), 'sonnet', 'an unequal stored pick is not honoured');
  // while it IS the configured model it is honoured (nothing to override)
  select('opus');
  assert.equal(store.effectiveModel(store.getState()), 'opus');
  mem.delete('legion.model.a1');
  select('sonnet');
  assert.equal(store.effectiveModel(store.getState()), 'sonnet', 'no stored pick: the agent model itself');
});

test('(c) the session pick (composer picker) still wins while it is a real, different choice', () => {
  select('sonnet');
  store.setState({ modelOverride: 'opus' });
  assert.equal(store.effectiveModel(store.getState()), 'opus');
  store.setState({ modelOverride: null });
});

test('(c) POST /api/tasks carries no model at all when it is the agent\'s own', async () => {
  select('sonnet');
  mem.set('legion.model.a1', 'sonnet');
  sent = undefined;
  const r = await store.sendPromptTo({ agentId: 'a1', taskId: null }, 'hello');
  assert.equal(r.ok, true);
  assert.ok(sent, 'the request went out');
  assert.equal('model' in sent, false, 'the configured model is not sent as a request (before the fix it always was)');
  mem.delete('legion.model.a1');
});

test('(c) an explicit composer pick that differs from Settings is still sent', async () => {
  select('sonnet');
  sent = undefined;
  const r = await store.sendPromptTo({ agentId: 'a1', taskId: null }, 'hello', { model: 'opus' });
  assert.equal(r.ok, true);
  assert.equal(sent!.model, 'opus', 'a real choice reaches the engine');
});

test('(c) a queue item restored with no stored model sends no model: the agent\'s Settings win', async () => {
  const raw = JSON.stringify({ v: 1, threads: { 't:task_1': { items: [{ id: 'q1', text: 'queued', at: 1 }] } } });
  const item = queueOf(restore(raw), 't:task_1')!.items[0]!;
  assert.equal(item.model, '', 'storage carried no choice, so none is invented ("auto" was the bug)');
  select('sonnet');
  sent = undefined;
  const r = await store.sendPromptTo({ agentId: 'a1', taskId: null }, 'queued', { model: item.model });
  assert.equal(r.ok, true);
  assert.equal('model' in sent!, false, 'the restored message goes out on the agent\'s own model');
  // a stored model of its own is still kept
  const kept = queueOf(restore(JSON.stringify({ v: 1, threads: { 't:task_1': { items: [{ id: 'q2', text: 'x', model: 'haiku', at: 1 }] } } })), 't:task_1')!.items[0]!;
  assert.equal(kept.model, 'haiku');
});
