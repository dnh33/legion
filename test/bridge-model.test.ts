import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, Catalog, Task } from '../src/shared/types.js';

type Call = { agent: string; prompt: string; options: any; n: number };
type Script = (c: Call) => AsyncGenerator<any, void> | undefined;

const mkAgent = (id: string, name: string): AgentProfile => ({
  id, name, emoji: '*', description: `${name} does things`, systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [],
  createdAt: '', updatedAt: '',
});

let sidN = 0;
const ok = (text: string, sid: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, num_turns: 1, session_id: sid });

function setup(script: Script, maxConcurrent = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-br-'));
  const store = new Store(dir);
  for (const [id, name] of [['zealot', 'Zealot'], ['builder', 'Builder'], ['scout', 'Scout'], ['worker', 'Worker']]) store.upsertAgent(mkAgent(id!, name!));
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  const calls: Call[] = [];
  const queryFn = ((p: any) => {
    const agent = basename(p.options.cwd);
    const call: Call = { agent, prompt: p.prompt, options: p.options, n: calls.filter((c) => c.agent === agent).length };
    calls.push(call);
    const sid = `sess-${++sidN}`;
    const custom = script(call);
    const gen = custom ?? (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sid };
      yield ok(`${agent} says: ${String(p.prompt).split('\n').pop()}`, sid);
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const engine = new Engine({ store, bus, vms: {} as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, maxConcurrent });
  return { store, bus, engine, calls };
}

/** Invoke one of the agent's own in-process tools, exactly as the model would. */
async function callTool(options: any, name: string, args: any): Promise<{ isError?: boolean; text: string; json?: any }> {
  const t = options.mcpServers.legion.instance._registeredTools[name];
  const r = await t.handler(args, {});
  const text = r.content.map((c: any) => c.text).join('\n');
  let json: any; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { isError: r.isError, text, json };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const gated = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });


const modelOf = (s: ReturnType<typeof setup>, agent: string, n = 0) => s.calls.filter((c) => c.agent === agent)[n]!.options.model;
const catalogOf = (...values: string[]): (() => Promise<Catalog>) => async () => ({
  commands: [], fetchedAt: '', models: values.map((v) => ({ value: v, displayName: v, description: '' })),
});

test('B: ask with model "haiku" runs the target on haiku, and the task records who chose it', async () => {
  let asked: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    asked = await callTool(c.options, 'ask', { agent: 'builder', message: 'count the files', model: 'haiku' });
    yield ok('done', 'z1');
  })(), 2);
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(asked.isError, undefined);
  assert.equal(modelOf(s, 'builder'), 'haiku', 'the SDK got the override, not the builder default (sonnet)');
  assert.equal(asked.json.model, 'haiku');
  const bt = s.store.getTask(asked.json.taskId)!;
  assert.equal(bt.requestedModel, 'haiku');
  assert.deepEqual(bt.modelOverride, { model: 'haiku', by: 'zealot' });
});

test('B: the override applies to that task only: the next ask on the same thread goes back to the agent default', async () => {
  const seen: any[] = [];
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    seen.push(await callTool(c.options, 'ask', { agent: 'builder', message: 'one', model: 'haiku' }));
    seen.push(await callTool(c.options, 'ask', { agent: 'builder', message: 'two' }));
    seen.push(await callTool(c.options, 'ask', { agent: 'builder', message: 'three', model: 'opus' }));
    seen.push(await callTool(c.options, 'ask', { agent: 'builder', message: 'four' }));
    yield ok('done', 'z1');
  })(), 2);
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.deepEqual([0, 1, 2, 3].map((n) => modelOf(s, 'builder', n)), ['haiku', 'sonnet', 'opus', 'sonnet']);
  assert.equal(seen[0].json.taskId, seen[1].json.taskId, 'one pair thread');
  const t = s.store.getTask(seen[1].json.taskId)!;
  assert.equal(t.modelOverride, undefined, 'cleared once a later message did not ask for one');
  assert.equal(t.requestedModel, 'sonnet');
});

test('B: "auto" is an override too (let the router decide even for an agent fixed to opus)', async () => {
  let asked: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    asked = await callTool(c.options, 'ask', { agent: 'scout', message: 'quick question', model: 'auto' });
    yield ok('done', 'z1');
  })(), 2);
  s.store.upsertAgent({ ...s.store.getAgent('scout')!, model: 'opus' });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  const bt = s.store.getTask(asked.json.taskId)!;
  assert.equal(bt.requestedModel, 'auto');
  assert.equal(modelOf(s, 'scout'), 'sonnet', 'a short simple prompt routes to sonnet');
});

test('B: tell takes a model too, and the reply into the caller does not change the caller\'s own model', async () => {
  let told: any;
  const s = setup((c) => {
    if (c.agent === 'zealot' && c.n === 0) return (async function* () {
      yield init('z1');
      told = await callTool(c.options, 'tell', { agent: 'builder', message: 'long job', model: 'haiku' });
      yield ok('started', 'z1');
    })();
    return undefined;
  }, 2);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui', model: 'opus' });
  await s.engine.waitFor(z.id, 5000);
  for (let i = 0; i < 100 && s.calls.filter((c) => c.agent === 'zealot').length < 2; i++) await tick(20);
  await s.engine.waitFor(z.id, 5000);
  assert.equal(modelOf(s, 'builder'), 'haiku');
  assert.deepEqual(s.store.getTask(told.json.taskId)!.modelOverride, { model: 'haiku', by: 'zealot' });
  assert.equal(modelOf(s, 'zealot', 1), 'opus', 'the reply turn keeps the caller on its own model');
});

test('B: the model choice never changes the approval ceiling of the delegated task', async () => {
  let asked: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    asked = await callTool(c.options, 'ask', { agent: 'builder', message: 'rm -rf it', model: 'opus' });
    yield ok('done', 'z1');
  })(), 2);
  s.store.upsertAgent({ ...s.store.getAgent('zealot')!, approval: 'ask' });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  const bt = s.store.getTask(asked.json.taskId)!;
  assert.equal(bt.origin?.approvalCeiling, 'ask', 'still capped by the lead');
  const call = s.calls.find((c) => c.agent === 'builder')!;
  assert.notEqual(call.options.permissionMode, 'bypassPermissions');
  assert.equal(call.options.model, 'opus');
});

test('B: a full lead asking with a model leaves the target at the ceiling it would have had without one', async () => {
  const seen: any[] = [];
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    seen.push(await callTool(c.options, 'ask', { agent: 'builder', message: 'a', model: 'haiku', fresh: true }));
    seen.push(await callTool(c.options, 'ask', { agent: 'scout', message: 'b', fresh: true }));
    yield ok('done', 'z1');
  })(), 2);
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  const a = s.store.getTask(seen[0].json.taskId)!; const b = s.store.getTask(seen[1].json.taskId)!;
  assert.equal(a.origin?.approvalCeiling, b.origin?.approvalCeiling);
  assert.equal(a.origin?.approvalCeiling, 'full');
});

test('B: unknown or odd model values are refused with the list of allowed ones; nothing starts', async () => {
  const s = setup(() => undefined, 2);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 5000);
  const opts = s.calls[0]!.options;
  for (const bad of ['gpt-5', 'claude-opus-4-1', 'Opus 5', 'haiku;rm', ' ']) {
    const r = await callTool(opts, 'ask', { agent: 'builder', message: 'x', model: bad });
    assert.equal(r.isError, true, bad);
    assert.match(r.text, /sonnet, opus, haiku, auto/);
    const t = await callTool(opts, 'tell', { agent: 'builder', message: 'x', model: bad });
    assert.equal(t.isError, true, bad);
  }
  assert.equal(s.calls.filter((c) => c.agent === 'builder').length, 0);
  // case and padding are forgiven
  const ok1 = await callTool(opts, 'ask', { agent: 'builder', message: 'x', model: ' Haiku ' });
  assert.equal(ok1.isError, undefined);
  assert.equal(modelOf(s, 'builder'), 'haiku');
});

test('B: the model is validated against the catalog when it can be read; an unreadable catalog does not block', async () => {
  const s = setup(() => undefined, 2);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 5000);
  const opts = s.calls[0]!.options;
  s.engine.bridge.catalog = catalogOf('default', 'sonnet', 'opus');
  const no = await callTool(opts, 'ask', { agent: 'builder', message: 'x', model: 'haiku' });
  assert.equal(no.isError, true);
  assert.match(no.text, /not offered on this account/);
  assert.match(no.text, /sonnet, opus/);
  assert.equal((await callTool(opts, 'ask', { agent: 'builder', message: 'x', model: 'opus' })).isError, undefined);
  assert.equal((await callTool(opts, 'ask', { agent: 'builder', message: 'x', model: 'auto' })).isError, undefined, 'auto needs no catalog entry');
  s.engine.bridge.catalog = async () => ({ commands: [], models: [], fetchedAt: '', error: 'probe failed' });
  assert.equal((await callTool(opts, 'ask', { agent: 'scout', message: 'x', model: 'haiku' })).isError, undefined, 'a failed probe cannot veto');
  s.engine.bridge.catalog = async () => { throw new Error('boom'); };
  assert.equal((await callTool(opts, 'ask', { agent: 'worker', message: 'x', model: 'haiku' })).isError, undefined);
});

test('B: a message queued behind a busy thread keeps its own model for its own run', async () => {
  const g = gated();
  const seen: any[] = [];
  const s = setup((c) => {
    if (c.agent === 'builder' && c.n === 0) return (async function* () { yield init('b1'); await g.p; yield ok('first done', 'b1'); })();
    if (c.agent === 'zealot') return (async function* () {
      yield init('z1');
      const p1 = callTool(c.options, 'ask', { agent: 'builder', message: 'first' });
      await tick(40);
      const p2 = callTool(c.options, 'ask', { agent: 'builder', message: 'second', model: 'haiku' });
      await tick(40);
      g.open();
      seen.push(await p1, await p2);
      yield ok('done', 'z1');
    })();
    return undefined;
  }, 3);
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.deepEqual([modelOf(s, 'builder', 0), modelOf(s, 'builder', 1)], ['sonnet', 'haiku']);
});
