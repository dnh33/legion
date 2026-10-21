/**
 * One helper decides whether a model value runs on Claude, on a provider, or on an agent host (`acp:<entry>[/<model>]`).
 * Every reader of the old provider-prefix check goes through it, so a Hermes model is never mistaken for Claude or a provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toolsOf } from '../src/core/agent-reach.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine, EngineError } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { attachLogEvents } from '../src/core/log/events.js';
import { LogSink } from '../src/core/log/logger.js';
import { buildLegionMcpServer } from '../src/core/mcp-tools.js';
import type { ModuleJob } from '../src/core/modules.js';
import { normalizeProviders } from '../src/core/providers/config.js';
import { ARMORY_SERVER_NAME } from '../src/core/armory/index.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import { acpLabel, parseAcpModel, runtimeOf } from '../src/shared/runtime.js';
import { summariseUsage } from '../src/shared/usage-summary.js';
import type { AgentProfile, Task } from '../src/shared/types.js';
import { canJoinRun, isProviderModel } from '../ui/src/chat/busy.js';
import { armoryRig, mkAgent as armoryAgent } from './armory-rig.js';
import { repoRoot } from './ps-helpers.js';
import { tempDir } from './tmp-cleanup.js';


// ---------------------------------------------------------------- the helper

test('runtimeOf: Claude aliases and AWS ARNs are Claude, name:model is a provider, acp:entry is an agent host', () => {
  assert.equal(runtimeOf('sonnet'), 'claude');
  assert.equal(runtimeOf('auto'), 'claude');
  assert.equal(runtimeOf('claude-opus-5-5[1m]'), 'claude');
  assert.equal(runtimeOf('arn:aws:bedrock:x'), 'claude');
  assert.equal(runtimeOf(undefined), 'claude');
  assert.equal(runtimeOf(''), 'claude');
  assert.equal(runtimeOf('deepseek:chat'), 'provider');
  assert.equal(runtimeOf('openrouter:vendor/model'), 'provider');
  assert.equal(runtimeOf('acp:hermes'), 'acp');
  assert.equal(runtimeOf('acp:hermes/openrouter:x'), 'acp');
});

test('parseAcpModel: the entry id, and the model after the first slash (which may itself hold slashes and colons)', () => {
  assert.deepEqual(parseAcpModel('acp:hermes'), { entryId: 'hermes' });
  assert.deepEqual(parseAcpModel('acp:hermes/anthropic:claude-x'), { entryId: 'hermes', modelId: 'anthropic:claude-x' });
  assert.deepEqual(parseAcpModel('acp:hermes/openrouter:a/b'), { entryId: 'hermes', modelId: 'openrouter:a/b' });
  assert.deepEqual(parseAcpModel('acp:hermes/'), { entryId: 'hermes' }, 'an empty model after the slash is no model');
  assert.equal(parseAcpModel('sonnet'), undefined);
  assert.equal(parseAcpModel('openai:gpt-4o'), undefined);
  assert.equal(parseAcpModel('acp:/x'), undefined, 'no entry id');
  assert.equal(parseAcpModel('acp:Bad Id'), undefined);
  assert.equal(parseAcpModel(undefined as never), undefined);
});

test('acpLabel: the words shown for an agent host run, and nothing for a model that is not one', () => {
  assert.equal(acpLabel('acp:hermes'), 'Hermes');
  assert.equal(acpLabel('acp:hermes/openrouter:x'), 'Hermes');
  assert.equal(acpLabel('sonnet'), undefined);
});

test('the id "acp" is reserved: a provider entry with that id is dropped as unusable', () => {
  const entry = { kind: 'openai-compat', baseUrl: 'https://api.example.com/v1', enabled: true };
  const cfg = normalizeProviders({ entries: { acp: entry, mine: entry } });
  assert.equal(cfg.entries.acp, undefined);
  assert.ok(cfg.entries.mine, 'other ids are untouched');
  assert.ok(cfg.dropped?.some((d) => /^acp: not a usable provider id/.test(d)), String(cfg.dropped));
});

// ---------------------------------------------------------------- the readers

test('toolsOf: an agent host agent is not told it has no shell and no files', () => {
  const text = toolsOf({ model: 'acp:hermes' });
  assert.doesNotMatch(text, /no shell/i);
  assert.match(text, /Hermes/);
  assert.match(toolsOf({ model: 'openai:gpt-4o' }), /no shell and no file tools/, 'a provider agent still gets the old words');
  assert.match(toolsOf({ model: 'sonnet' }), /Claude Code/);
});

test('log events: a run on an agent host is labelled with the host, not a provider id', () => {
  const dir = tempDir('legion-rt-log-');
  const sink = new LogSink({ dir });
  const bus = new EventBus();
  const detach = attachLogEvents(bus, sink, () => 1000);
  const base = { id: 't1', agentId: 'builder', title: 'x', source: 'ui', requestedModel: 'auto', createdAt: 'x', updatedAt: 'x' };
  bus.emit({ type: 'task.updated', task: { ...base, status: 'running', model: 'acp:hermes' } as Task });
  bus.emit({ type: 'task.updated', task: { ...base, status: 'done', model: 'acp:hermes', turns: 1 } as Task });
  detach();
  sink.flushSync(); sink.closeAll();
  const agents = readFileSync(join(dir, 'agents.log'), 'utf8');
  assert.match(agents, /run\.started agent="builder" provider="Hermes" model="acp:hermes"/);
  assert.match(agents, /run\.finished agent="builder" provider="Hermes" model="acp:hermes"/);
  assert.doesNotMatch(agents, /provider="acp"/);
});

test('usage summary: an agent host task is grouped under the host label', () => {
  const when = new Date(2026, 9, 5, 12).getTime();
  const row = (model: string) => ({ agentId: 'a', model, turns: 1, updatedAt: new Date(when).toISOString() });
  const s = summariseUsage([row('acp:hermes'), row('acp:hermes/openrouter:x'), row('sonnet')], when);
  assert.deepEqual(s.today.byModel.map((r) => r.key).sort(), ['Hermes', 'sonnet']);
  assert.equal(s.today.byModel.find((r) => r.key === 'Hermes')!.tasks, 2);
});

test('the Armory offers no tools to an agent host job (only a provider run needs them)', () => {
  const r = armoryRig({ cc: {}, agents: [armoryAgent('alpha')] });
  const agent = r.agents.get('alpha')!;
  const job = (runtime: ModuleJob['runtime']) => ({ taskId: 't', runtime, taint: () => false }) as ModuleJob;
  assert.deepEqual(r.mod.mcpServers!(agent, job('acp')), {});
  assert.ok(r.mod.mcpServers!(agent, job('provider'))[ARMORY_SERVER_NAME], 'a provider run still gets them');
});

test('the composer: a message to a running agent host run is queued, never fed to it like a Claude run', () => {
  const running = { status: 'running' as const, provider: undefined, model: 'acp:hermes' as string | undefined };
  assert.equal(canJoinRun('run', running, 0, 'and make it blue'), false);
  assert.equal(canJoinRun('run', { ...running, model: 'opus' }, 0, 'and make it blue'), true);
  assert.equal(isProviderModel('acp:hermes'), false, 'an agent host is not a provider');
  assert.equal(isProviderModel('openai:gpt-4o'), true);
});

test('a token client cannot create an agent on an agent host model', async () => {
  const server = buildLegionMcpServer({ store: { listAgents: () => [] }, bus: new EventBus() } as never) as any;
  const r = await server._registeredTools.legion_create_agent.handler({ name: 'Sneaky', model: 'acp:hermes' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /can only be chosen in the Legion app/);
});

// ---------------------------------------------------------------- the engine

function rig(model: string) {
  const dir = tempDir('legion-rt-eng-');
  const store = new Store(dir);
  const agent: AgentProfile = {
    id: 'a1', name: 'Alpha', emoji: '*', description: '', systemPrompt: '', model,
    vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [], createdAt: '', updatedAt: '',
  };
  store.upsertAgent(agent);
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  const calls: unknown[] = [];
  const queryFn = ((p: unknown) => { calls.push(p); throw new Error('the Claude SDK must not be reached'); }) as unknown as QueryFn;
  const engine = new Engine({
    store, bus, vms: {} as never, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, maxConcurrent: 1,
  });
  return { store, engine, calls };
}

test('a run on the built-in agent host fails in plain words until the runtime lands, and never reaches Claude or a provider', async () => {
  const r = rig('acp:hermes');
  const t = r.engine.startTask({ agentId: 'a1', prompt: 'hello', source: 'ui' });
  const done = await r.engine.waitFor(t.id, 5000);
  assert.equal(done.status, 'error');
  assert.equal(done.error, 'This Legion cannot run Hermes agents yet. Update Legion, or choose another model for this agent.');
  assert.equal(r.calls.length, 0);
});

test('a run on an agent host entry that does not exist says it is not set up', async () => {
  const r = rig('acp:ghost/some-model');
  const t = r.engine.startTask({ agentId: 'a1', prompt: 'hello', source: 'ui' });
  const done = await r.engine.waitFor(t.id, 5000);
  assert.equal(done.status, 'error');
  assert.equal(done.error, 'The agent host "ghost" is not set up. Choose another model for this agent in Settings.');
  assert.equal(r.calls.length, 0);
});

test('compacting a task on an agent host is declined as not supported, with no provider call and no Claude /compact', async () => {
  const r = rig('acp:hermes');
  r.store.upsertTask({ id: 't9', agentId: 'a1', title: 't', status: 'done', source: 'ui', requestedModel: 'auto', model: 'acp:hermes', sessionId: 's1', createdAt: '', updatedAt: '' } as Task);
  const out = await r.engine.compactTaskNow('t9');
  assert.deepEqual(out, { ok: false, detail: 'Compacting is not supported for this agent.' });
  assert.equal(r.calls.length, 0);
});

test('a token client can neither put a Claude agent on an agent host nor move an agent host agent', () => {
  const claude = rig('sonnet');
  assert.throws(() => claude.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'mcp', model: 'acp:hermes' }), (e) => e instanceof EngineError && e.status === 400 && /can only be chosen in the Legion app/.test(e.message));
  const host = rig('acp:hermes');
  assert.throws(() => host.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'mcp', model: 'sonnet' }), (e) => e instanceof EngineError && e.status === 400 && /can only be chosen in the Legion app/.test(e.message));
});

// ---------------------------------------------------------------- the tripwire (ruling R9)

/**
 * Every call of the provider-prefix check outside src/shared/runtime.ts and src/core/providers/ must be named here with a reason, so a
 * new reader of the prefix cannot appear unseen. A reader that only needs to know Claude, provider or agent host uses runtimeOf instead.
 */
const PROVIDER_PREFIX_ALLOWED: Record<string, string> = {
  'src/core/log/events.ts': 'logs the provider id of a provider run (the runtime kind alone is not enough); an agent host run is labelled before it',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...sourceFiles(p)); } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('tripwire: every call of the provider-prefix check outside the helper and providers/ is on the allow list, with a reason', () => {
  const found = new Set<string>();
  for (const root of ['src', 'ui/src']) {
    for (const f of sourceFiles(join(repoRoot, root))) {
      const rel = relative(repoRoot, f).replace(/\\/g, '/');
      if (rel === 'src/shared/runtime.ts' || rel.startsWith('src/core/providers/')) continue;
      if (/\bproviderPrefix\s*\(/.test(readFileSync(f, 'utf8'))) found.add(rel);
    }
  }
  assert.deepEqual([...found].sort(), Object.keys(PROVIDER_PREFIX_ALLOWED).sort(), 'a new caller must be added to the allow list with a reason (or use runtimeOf); a stale entry must go');
  for (const [file, reason] of Object.entries(PROVIDER_PREFIX_ALLOWED)) assert.ok(reason.length > 20, `${file} needs a real reason`);
});
