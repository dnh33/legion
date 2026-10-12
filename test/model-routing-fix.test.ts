/**
 * Model routing: `agent.model` (the model the owner chose in Settings) is authoritative for a thread.
 *
 * Three leaks are pinned here (see the diagnosis: engine.ts:344 continued tasks reuse the creation snapshot;
 * engine.ts:1257 a provider-shaped model that resolves to nothing fell through to the Claude path):
 *  (a) a live thread continues on agent.model after Settings changed - not on the snapshot taken at creation;
 *  (b) a provider-shaped model with no matching provider entry FAILS the task instead of running on Claude;
 *  (d) the legitimate per-task override path is untouched: a bot-declared override, the engine's ceiling, and a
 *      reply landing in the caller's own task keep working exactly as before.
 * (c) lives in test/composer-model.test.ts (the UI side).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile } from '../src/shared/types.js';
import { tempDir } from './tmp-cleanup.js';
import { startFake, replyText } from './providers-fakes.js';
import { run, setup as provSetup } from './providers-harness.js';

const mkAgent = (model: string): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: '*', description: 'does things', systemPrompt: '', model,
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [],
  createdAt: '', updatedAt: '',
});

/** A real Engine with a scripted Claude query() (and NO provider runtime): every SDK call's options.model is recorded. */
function rig(model = 'sonnet') {
  const dir = tempDir('legion-mr-');
  const store = new Store(dir);
  store.upsertAgent(mkAgent(model));
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  const calls: { model: string }[] = [];
  const queryFn = ((p: any) => {
    calls.push({ model: p.options.model });
    const sid = `sess-${calls.length}`;
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sid };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: sid };
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  // no `providers`: every run is a Claude run, exactly like features.providers = false
  const engine = new Engine({ store, bus, vms: {} as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false });
  return { store, engine, calls, agent: () => store.getAgent('a1')! };
}

const setModel = (r: ReturnType<typeof rig>, model: string) => r.store.upsertAgent({ ...r.agent(), model });
const used = (r: ReturnType<typeof rig>, n: number) => r.calls[n]!.model;

// ---------------------------------------------------------------- (a) continued threads re-read agent.model

test('(a) a continued thread runs on the model Settings says now, not the snapshot taken when the task was created', async () => {
  const r = rig('sonnet');
  const first = r.engine.startTask({ agentId: 'a1', prompt: 'first', source: 'ui' });
  await r.engine.waitFor(first.id, 5000);
  assert.equal(used(r, 0), 'sonnet');
  setModel(r, 'opus'); // the owner changes the bot's model in Settings
  const second = r.engine.startTask({ agentId: 'a1', prompt: 'second', source: 'ui', continueTaskId: first.id });
  await r.engine.waitFor(second.id, 5000);
  assert.equal(second.requestedModel, 'opus', 'the continued task asks for the configured model');
  assert.equal(used(r, 1), 'opus', 'and the run uses it (before the fix this was the stale "sonnet")');
});

test('(a) the same for a room wake (source bot) and a bridge pair continuation', async () => {
  const r = rig('sonnet');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'hello', source: 'bot' });
  await r.engine.waitFor(t1.id, 5000);
  setModel(r, 'opus');
  const wake = r.engine.startTask({ agentId: 'a1', prompt: 'again', source: 'bot', continueTaskId: t1.id });
  await r.engine.waitFor(wake.id, 5000);
  assert.equal(used(r, 1), 'opus', 'the woken room thread follows Settings');
  const pair = r.engine.startTask({
    agentId: 'a1', prompt: 'and again', source: 'agent', continueTaskId: wake.id,
    bridge: { fromAgentId: 'lead', parentTaskId: 'task_lead', hop: 1 } as any,
  });
  await r.engine.waitFor(pair.id, 5000);
  assert.equal(used(r, 2), 'opus', 'the bridge pair thread follows Settings');
});

test('(a) an MCP continue follows Settings too', async () => {
  const r = rig('sonnet');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'hello', source: 'mcp' });
  await r.engine.waitFor(t1.id, 5000);
  setModel(r, 'haiku');
  const t2 = r.engine.startTask({ agentId: 'a1', prompt: 'more', source: 'mcp', continueTaskId: t1.id });
  await r.engine.waitFor(t2.id, 5000);
  assert.equal(t2.requestedModel, 'haiku');
  assert.equal(used(r, 1), 'haiku');
});

test('(a) a snapshot written by an old client (model equal to agent.model at creation) does not pin the thread', async () => {
  // what the app used to send on every send: the model as it was when the task was created
  const r = rig('sonnet');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'first', source: 'ui', model: 'sonnet' });
  await r.engine.waitFor(t1.id, 5000);
  setModel(r, 'opus');
  const t2 = r.engine.startTask({ agentId: 'a1', prompt: 'second', source: 'ui', continueTaskId: t1.id });
  await r.engine.waitFor(t2.id, 5000);
  assert.equal(used(r, 1), 'opus');
});

test('(a) a model the composer poisoned the thread with is dropped on the next turn that asks for none', async () => {
  // a stale legion.model.<id> sent 'sonnet' while Settings said 'opus'; the next turn without a request goes back to Settings
  const r = rig('opus');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'first', source: 'ui', model: 'sonnet' });
  await r.engine.waitFor(t1.id, 5000);
  assert.equal(t1.requestedModel, 'sonnet', 'an explicit request is honoured for that turn');
  const t2 = r.engine.startTask({ agentId: 'a1', prompt: 'second', source: 'ui', continueTaskId: t1.id });
  await r.engine.waitFor(t2.id, 5000);
  assert.equal(t2.requestedModel, 'opus', 'and is not sticky');
  assert.equal(used(r, 1), 'opus');
});

// ---------------------------------------------------------------- (b) a provider-shaped model never reaches Claude

test('(b) a provider-shaped model with no matching provider entry fails the task instead of running on Claude', async () => {
  const f = await startFake((_r, res) => replyText(res, 'x'));
  try {
    const h = provSetup(f, { agent: { model: 'ghost:test-model' } }); // not a preset, no entry: resolve() gives up
    const t = await run(h);
    assert.equal(t.status, 'error', 'the run is refused, not silently rerouted');
    assert.match(t.error ?? '', /not set up any more/);
    assert.equal(h.claudeCalls.length, 0, 'the Claude SDK never sees a provider-shaped model');
    assert.equal(f.requests.length, 0, 'and no request goes to any provider either');
  } finally { await f.close(); }
});

test('(b) with no provider runtime at all (features.providers = false) a provider-shaped model still fails loudly', async () => {
  const r = rig('openrouter:anthropic/claude-sonnet-4.5');
  const t = r.engine.startTask({ agentId: 'a1', prompt: 'hello', source: 'ui' });
  const done = await r.engine.waitFor(t.id, 5000);
  assert.equal(done.status, 'error');
  assert.match(done.error ?? '', /not set up any more/);
  assert.equal(r.calls.length, 0, 'nothing reached queryFn');
});

test('(b) a plain Claude model still runs on Claude (the guard is about provider shape, not about failure)', async () => {
  const r = rig('sonnet');
  const t = r.engine.startTask({ agentId: 'a1', prompt: 'hello', source: 'ui' });
  const done = await r.engine.waitFor(t.id, 5000);
  assert.equal(done.status, 'done');
  assert.equal(used(r, 0), 'sonnet');
});

// ---------------------------------------------------------------- (d) the legitimate override path still works

test('(d) a bot-declared per-task override still wins for that run and is recorded', async () => {
  const r = rig('sonnet');
  const t = r.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'agent', model: 'haiku', modelOverrideBy: 'lead' });
  await r.engine.waitFor(t.id, 5000);
  assert.equal(t.requestedModel, 'haiku');
  assert.deepEqual(t.modelOverride, { model: 'haiku', by: 'lead' });
  assert.equal(used(r, 0), 'haiku', 'the run uses the override, not the configured model');
});

test('(d) an over-ceiling override is still refused by the engine (no bot moves an agent up)', () => {
  const r = rig('sonnet');
  assert.throws(
    () => r.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'agent', model: 'opus', modelOverrideBy: 'lead' }),
    /above Alpha's own model setting/,
  );
  assert.equal(r.calls.length, 0, 'nothing started');
});

test('(d) an explicit request on THIS turn still beats the configured model', async () => {
  const r = rig('sonnet');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'first', source: 'ui' });
  await r.engine.waitFor(t1.id, 5000);
  const t2 = r.engine.startTask({ agentId: 'a1', prompt: 'second', source: 'ui', continueTaskId: t1.id, model: 'haiku' });
  await r.engine.waitFor(t2.id, 5000);
  assert.equal(t2.requestedModel, 'haiku');
  assert.equal(used(r, 1), 'haiku');
});

test('(d) a reply landing in the caller\'s own task keeps the model that task was given', async () => {
  const r = rig('sonnet');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui', model: 'opus' });
  await r.engine.waitFor(t1.id, 5000);
  const reply = r.engine.startTask({
    agentId: 'a1', prompt: '[Reply from Builder] done', source: 'agent', continueTaskId: t1.id,
    bridge: { fromAgentId: 'builder', parentTaskId: t1.id, reply: true, hop: 1 } as any,
  });
  await r.engine.waitFor(reply.id, 5000);
  assert.equal(reply.requestedModel, 'opus', 'the owner\'s own choice for this thread survives the reply');
  assert.equal(used(r, 1), 'opus');
});

test('(d) a bot override carried into a reply is still kept; a later message without one goes back to Settings', async () => {
  const r = rig('sonnet');
  const t1 = r.engine.startTask({ agentId: 'a1', prompt: 'first', source: 'agent', model: 'haiku', modelOverrideBy: 'lead' });
  await r.engine.waitFor(t1.id, 5000);
  const reply = r.engine.startTask({
    agentId: 'a1', prompt: '[Reply from Lead] ok', source: 'agent', continueTaskId: t1.id,
    bridge: { fromAgentId: 'lead', parentTaskId: t1.id, reply: true, hop: 1 } as any,
  });
  await r.engine.waitFor(reply.id, 5000);
  assert.equal(reply.requestedModel, 'haiku', 'the override the task still carries wins');
  assert.deepEqual(reply.modelOverride, { model: 'haiku', by: 'lead' });
  const plain = r.engine.startTask({ agentId: 'a1', prompt: 'and now?', source: 'ui', continueTaskId: reply.id });
  await r.engine.waitFor(plain.id, 5000);
  assert.equal(plain.requestedModel, 'sonnet', 'the override applied to that run only');
  assert.equal(plain.modelOverride, undefined);
});
