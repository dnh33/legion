import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine, EngineError } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { buildAgentToolsServer } from '../src/core/agent-tools.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, LegionConfig, LegionEvent, Task } from '../src/shared/types.js';

// ---- fakes
class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, Task>();
  msgs: ChatMessage[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  upsertTask(t: Task) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: ChatMessage) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}

const mkAgent = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: 'A', description: '', systemPrompt: 'Be nice.', model: 'auto',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'],
  createdAt: '', updatedAt: '', ...over,
});

type Script = (params: { prompt: any; options: any }, call: number) => AsyncGenerator<any, void>;

function setup(script: Script, opts: { agent?: Partial<AgentProfile>; config?: (c: LegionConfig) => void; boat?: boolean; maxConcurrent?: number; approvalTimeoutMs?: number } = {}) {
  const store = new FakeStore();
  const agent = mkAgent(opts.agent);
  store.agents.set(agent.id, agent);
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const config = defaultConfig();
  config.workspaceDir = join(mkdtempSync(join(tmpdir(), 'legion-eng-')), 'ws');
  opts.config?.(config);
  const approvals = new ApprovalBroker(bus, { timeoutMs: opts.approvalTimeoutMs });
  const calls: { prompt: any; options: any }[] = [];
  const queryFn = ((params: any) => {
    calls.push(params);
    const gen = script(params, calls.length - 1);
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) });
  }) as unknown as QueryFn;
  const vms = { touch() {}, ensureRunning: async () => ({}) } as any;
  const engine = new Engine({
    store: store as any, bus, vms, approvals, config, queryFn,
    boatConfigured: () => opts.boat ?? false, maxConcurrent: opts.maxConcurrent,
  });
  return { store, bus, events, config, approvals, calls, engine, agent };
}

const init = (sid = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: sid });
const textAssistant = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const ok = (text: string, extra: any = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, num_turns: 2, session_id: 'sess-1', ...extra });
const err = (subtype: string, errors: string[] = []) => ({ type: 'result', subtype, is_error: true, errors, total_cost_usd: 0.02, num_turns: 3, session_id: 'sess-1' });

async function* happy(): AsyncGenerator<any, void> {
  yield init();
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } };
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } };
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo ' + 'x'.repeat(800) } }] } };
  yield ok('Hello there');
}

test('happy path: streaming, messages, task fields, options', async () => {
  const s = setup(() => happy());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'say hi', source: 'ui' });
  assert.equal(t.status, 'queued');
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Hello there');
  assert.equal(done.model, 'sonnet');
  assert.equal(done.sessionId, 'sess-1');
  assert.equal(done.costUsd, 0.01);
  assert.equal(done.turns, 2);
  const deltas = s.events.filter((e) => e.type === 'message.delta') as any[];
  assert.deepEqual(deltas.map((d) => d.text), ['Hel']);
  const msgs = s.store.listMessages(t.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2]!.toolName, 'Bash');
  assert.ok(msgs[2]!.text.length <= 500);
  const moods = s.events.filter((e) => e.type === 'mascot').map((e: any) => e.mood);
  assert.deepEqual(moods.slice(0, 3), ['thinking', 'hacking', 'success']);

  const o = s.calls[0]!.options;
  assert.equal(o.model, 'sonnet');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.maxTurns, s.config.claude.maxTurns);
  assert.equal(o.resume, undefined);
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
  assert.equal(o.canUseTool, undefined);
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(o.cwd, join(s.config.workspaceDir, 'a1'));
  assert.ok(existsSync(o.cwd));
  assert.equal(o.systemPrompt.preset, 'claude_code');
  assert.match(o.systemPrompt.append, /Alpha/);
  assert.match(o.systemPrompt.append, /Be nice\./);
  assert.ok(o.systemPrompt.append.split('\n').length <= 14);
});

test('startTask validation errors', () => {
  const s = setup(() => happy());
  assert.throws(() => s.engine.startTask({ agentId: 'nope', prompt: 'x', source: 'ui' }), (e: any) => e instanceof EngineError && e.status === 404);
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: '   ', source: 'ui' }), (e: any) => e.status === 400);
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui', continueTaskId: 'zz' }), (e: any) => e.status === 404);
});

test('auth env: claude-login deletes API key vars; api-key sets it', async () => {
  const saveKey = process.env.ANTHROPIC_API_KEY, saveTok = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
  try {
    const a = setup(() => happy());
    await a.engine.waitFor(a.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'cli' }).id, 3000);
    assert.equal('ANTHROPIC_API_KEY' in a.calls[0]!.options.env && a.calls[0]!.options.env.ANTHROPIC_API_KEY !== undefined, false);
    assert.equal(a.calls[0]!.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    // the child env is a plain-object copy of process.env: on Windows its key is "Path" (plain objects are case-sensitive, process.env is not)
    const pathKey = Object.keys(a.calls[0]!.options.env).find((k) => k.toUpperCase() === 'PATH');
    assert.equal(a.calls[0]!.options.env[pathKey ?? 'PATH'], process.env.PATH);

    const b = setup(() => happy(), { config: (c) => { c.claude.auth = 'api-key'; c.claude.apiKey = 'sk-config'; c.claude.executablePath = '/bin/claude'; c.claude.inheritClaudeCodeSettings = false; } });
    await b.engine.waitFor(b.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'cli' }).id, 3000);
    assert.equal(b.calls[0]!.options.env.ANTHROPIC_API_KEY, 'sk-config');
    assert.equal(b.calls[0]!.options.pathToClaudeCodeExecutable, '/bin/claude');
    assert.deepEqual(b.calls[0]!.options.settingSources, []);
  } finally {
    if (saveKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saveKey;
    if (saveTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saveTok;
  }
});

test('routing: auto hard prompt -> opus; /sonnet prefix stripped; agent model honored', async () => {
  const s = setup(() => happy());
  const t1 = s.engine.startTask({ agentId: 'a1', prompt: 'refactor and debug the architecture', source: 'ui' });
  await s.engine.waitFor(t1.id, 3000);
  assert.equal(s.calls[0]!.options.model, 'opus');
  const t2 = s.engine.startTask({ agentId: 'a1', prompt: '/sonnet refactor and debug the architecture', source: 'ui' });
  await s.engine.waitFor(t2.id, 3000);
  assert.equal(s.calls[1]!.options.model, 'sonnet');
  assert.equal(s.calls[1]!.prompt, 'refactor and debug the architecture');
  assert.equal(s.store.getTask(t2.id)!.model, 'sonnet');
});

test('escalation: sonnet error_max_turns -> opus rerun with resume + system message', async () => {
  const s = setup((_p, n) => (async function* () {
    yield init('sess-x');
    if (n === 0) yield err('error_max_turns');
    else yield ok('fixed it');
  })(), { agent: { model: 'sonnet' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.escalated, true);
  assert.equal(done.model, 'opus');
  assert.equal(done.result, 'fixed it');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0]!.options.model, 'sonnet');
  assert.equal(s.calls[1]!.options.model, 'opus');
  assert.equal(s.calls[1]!.options.resume, 'sess-x');
  assert.equal(s.calls[1]!.prompt, 'do it');
  assert.ok(Math.abs(done.costUsd! - 0.03) < 1e-9);
  const sys = s.store.listMessages(t.id).filter((m) => m.role === 'system');
  assert.equal(sys.length, 1);
  assert.match(sys[0]!.text, /^Escalated to Opus: /);
});

test('escalation happens at most once; opus failure ends in error', async () => {
  const s = setup(() => (async function* () { yield init(); yield err('error_during_execution', ['boom']); })(), { agent: { model: 'sonnet' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls.length, 2);
  assert.equal(done.status, 'error');
  assert.match(done.error!, /boom/);
  assert.equal(s.events.filter((e: any) => e.type === 'mascot' && e.mood === 'error').length, 1);
});

test('auth/rate-limit errors do not escalate', async () => {
  const s = setup(() => (async function* () { yield init(); yield err('error_during_execution', ['Invalid API key, please login']); })(), { agent: { model: 'sonnet' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(s.calls.length, 1);
  assert.equal(done.status, 'error');
  assert.equal(done.escalated, undefined);
});

test('continue: same task, resume session, priorModel keeps opus', async () => {
  const s = setup(() => happy());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'refactor and debug the architecture', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  assert.throws(() => s.engine.startTask({ agentId: 'nope', prompt: 'x', source: 'ui', continueTaskId: t.id }), (e: any) => e.status === 404);
  const t2 = s.engine.startTask({ agentId: 'a1', prompt: 'thanks', source: 'ui', continueTaskId: t.id });
  assert.equal(t2.id, t.id);
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(s.calls[1]!.options.resume, 'sess-1');
  assert.equal(s.calls[1]!.options.model, 'opus');
  assert.equal(done.turns, 4);
  assert.equal(s.store.listMessages(t.id).filter((m) => m.role === 'user').length, 2);
});

test('continue while running -> 409', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () { yield init(); await gate; yield ok('x'); })());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: 'y', source: 'ui', continueTaskId: t.id }), (e: any) => e.status === 409);
  release();
  await s.engine.waitFor(t.id, 3000);
});

test('cancel: aborts run, status cancelled, pending approvals denied', async () => {
  const s = setup((p) => (async function* () {
    yield init();
    await new Promise<void>(() => undefined); // hangs forever; engine must stop waiting on abort
  })(), { agent: { approval: 'ask' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.engine.running(), [t.id]);
  const pending = s.calls[0]!.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
  assert.equal(s.approvals.pending().length, 1);
  assert.equal(s.engine.cancel(t.id), true);
  assert.deepEqual(await pending, { behavior: 'deny', message: 'The user denied this action.' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'cancelled');
  assert.equal(s.calls[0]!.options.abortController.signal.aborted, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.engine.running(), []);
  assert.equal(s.engine.cancel(t.id), false);
  assert.equal(s.engine.cancel('unknown'), false);
});

test('approvals via canUseTool: allow, deny, auto-allowed, timeout', async () => {
  const s = setup(() => happy(), { agent: { approval: 'auto-edits' }, approvalTimeoutMs: 40 });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  const o = s.calls[0]!.options;
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  const sig = { signal: new AbortController().signal };
  assert.deepEqual(await o.canUseTool('Edit', { file_path: '/x' }, sig), { behavior: 'allow', updatedInput: { file_path: '/x' } });
  assert.equal((await o.canUseTool('mcp__legion__vm_exec', {}, sig)).behavior, 'allow');

  const p = o.canUseTool('Bash', { command: 'ls' }, sig);
  assert.equal(s.approvals.pending()[0]!.summary, 'ls');
  s.approvals.resolve(s.approvals.pending()[0]!.id, true);
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: { command: 'ls' } });

  const d = o.canUseTool('Bash', { command: 'rm' }, sig);
  s.approvals.resolve(s.approvals.pending()[0]!.id, false);
  assert.deepEqual(await d, { behavior: 'deny', message: 'The user denied this action.' });

  assert.equal((await o.canUseTool('mcp__other__x', {}, sig)).behavior, 'deny'); // times out after 40ms
});

test('concurrency cap and FIFO queue', async () => {
  const gates: (() => void)[] = [];
  const s = setup(() => (async function* () {
    yield init();
    await new Promise<void>((r) => gates.push(r));
    yield ok('x');
  })(), { maxConcurrent: 2 });
  const ids = [1, 2, 3].map((i) => s.engine.startTask({ agentId: 'a1', prompt: `p${i}`, source: 'ui' }).id);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.engine.running().length, 2);
  assert.equal(s.store.getTask(ids[2]!)!.status, 'queued');
  assert.equal(s.calls.length, 2);
  gates[0]!();
  await s.engine.waitFor(ids[0]!, 3000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2]!.prompt, 'p3');
  gates[1]!(); gates[2]!();
  for (const id of ids) assert.equal((await s.engine.waitFor(id, 3000)).status, 'done');
});

test('cancelling a queued task removes it from the queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () { yield init(); await gate; yield ok('x'); })(), { maxConcurrent: 1 });
  const a = s.engine.startTask({ agentId: 'a1', prompt: 'a', source: 'ui' });
  const b = s.engine.startTask({ agentId: 'a1', prompt: 'b', source: 'ui' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.engine.cancel(b.id), true);
  assert.equal(s.store.getTask(b.id)!.status, 'cancelled');
  release();
  await s.engine.waitFor(a.id, 3000);
  assert.equal(s.calls.length, 1);
});

test('thrown SDK error never crashes: task error + system message + mascot error', async () => {
  const s = setup(() => (async function* () { yield init(); throw new Error('spawn ENOENT'); })(), { agent: { model: 'opus' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(done.status, 'error');
  assert.match(done.error!, /ENOENT/);
  assert.ok(s.store.msgs.some((m) => m.role === 'system' && /ENOENT/.test(m.text)));
  assert.ok(s.events.some((e: any) => e.type === 'mascot' && e.mood === 'error'));

  const s2 = setup(() => { throw new Error('sync boom'); }, { agent: { model: 'opus' } });
  const d2 = await s2.engine.waitFor(s2.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(d2.status, 'error');
});

test('waitFor times out with the current task', async () => {
  const s = setup(() => (async function* () { yield init(); await new Promise<void>(() => undefined); })());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  const cur = await s.engine.waitFor(t.id, 50);
  assert.ok(cur.status === 'running' || cur.status === 'queued');
  s.engine.cancel(t.id);
  await assert.rejects(s.engine.waitFor('nope', 10), (e: any) => e.status === 404);
});

test('mcpServers: config filtered per agent; legion vm server only when vm enabled + boat configured', async () => {
  const cfgFn = (c: LegionConfig) => {
    c.mcpServers = {
      one: { command: 'node', args: ['a.js'], env: { K: 'v' } },
      two: { type: 'http', url: 'http://x/mcp', headers: { A: 'b' } },
      three: { type: 'sse', url: 'http://y/sse' },
    };
  };
  const vm = { enabled: true, size: 'default' as const, idleStopMinutes: 15 };
  const all = setup(() => happy(), { config: cfgFn, boat: true, agent: { vm } });
  await all.engine.waitFor(all.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  const m = all.calls[0]!.options.mcpServers;
  assert.deepEqual(Object.keys(m).sort(), ['legion', 'one', 'three', 'two']);
  assert.equal(m.legion.type, 'sdk');
  assert.equal(m.legion.name, 'legion');
  assert.deepEqual(m.one, { type: 'stdio', command: 'node', args: ['a.js'], env: { K: 'v' } });
  assert.deepEqual(m.two, { type: 'http', url: 'http://x/mcp', headers: { A: 'b' } });

  const some = setup(() => happy(), { config: cfgFn, boat: false, agent: { vm, mcpServers: ['two'] } });
  await some.engine.waitFor(some.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.deepEqual(Object.keys(some.calls[0]!.options.mcpServers).sort(), ['legion', 'two']);
  assert.deepEqual(Object.keys((some.calls[0]!.options.mcpServers.legion.instance as any)._registeredTools).sort(), ['agents', 'ask', 'tell']);
  assert.deepEqual(some.calls[0]!.options.disallowedTools, ['SendMessage', 'ListAgents']);
  assert.deepEqual(Object.keys((all.calls[0]!.options.mcpServers.legion.instance as any)._registeredTools).sort(), ['agents', 'ask', 'tell', 'vm_claude', 'vm_desktop', 'vm_exec', 'vm_read_file', 'vm_start', 'vm_stop', 'vm_usage', 'vm_write_file']);
});

test('agent tools server builds with name legion', () => {
  const srv = buildAgentToolsServer({ agentId: 'a1', taskId: 't', vms: {} as any, vmEnabled: false, bridge: {} as any });
  assert.equal(srv.type, 'sdk');
  assert.equal(srv.name, 'legion');
  assert.ok(srv.instance);
});

test('local_command_output becomes an assistant message; unknown /commands sent verbatim; task.model is the value used', async () => {
  const s = setup(() => (async function* () {
    yield init();
    yield { type: 'system', subtype: 'local_command_output', content: 'Total cost: $0.00', session_id: 'sess-1' };
    yield { type: 'system', subtype: 'local_command_output', content: '   ', session_id: 'sess-1' };
    yield ok('');
  })(), { agent: { model: 'claude-opus-5-5[1m]' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: '/cost now', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.model, 'claude-opus-5-5[1m]');
  assert.equal(s.calls[0]!.prompt, '/cost now');
  assert.equal(s.calls[0]!.options.model, 'claude-opus-5-5[1m]');
  const msgs = s.store.listMessages(t.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', '/cost now'], ['assistant', 'Total cost: $0.00']]);
});

test('/model prefix sets model and is stripped; non-sonnet errors do not escalate', async () => {
  const s = setup(() => (async function* () { yield init(); yield err('error_max_turns'); })());
  const t = s.engine.startTask({ agentId: 'a1', prompt: '/model haiku do x', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.options.model, 'haiku');
  assert.equal(s.calls[0]!.prompt, 'do x');
  assert.equal(done.status, 'error');
});

import { clipToolResult } from '../src/core/engine.js';
test('clipToolResult keeps long JSON results parseable', () => {
  const raw = JSON.stringify({ taskId: 't1', status: 'done', result: 'x'.repeat(5000) });
  const out = clipToolResult(raw);
  const o = JSON.parse(out);
  assert.equal(o.taskId, 't1');
  assert.ok(o.result.length < 1500 && o.result.endsWith('…'));
  assert.ok(clipToolResult('y'.repeat(3000)).length === 1500);
});

// ---- module seam and bot-origin approval ceiling
test('modules: mcp servers and preamble are merged into the run options', async () => {
  const s = setup(() => happy());
  s.engine.setModules([{
    id: 'm',
    mcpServers: () => ({ legion_comms: { type: 'stdio', command: 'x' } as any }),
    preamble: () => 'COMMS PREAMBLE',
  }, { id: 'broken', mcpServers: () => { throw new Error('boom'); }, preamble: () => { throw new Error('boom'); } }]);
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'hi', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const o = s.calls[0]!.options;
  assert.ok(o.mcpServers.legion_comms);
  assert.match(o.systemPrompt.append, /COMMS PREAMBLE/);
});

test('modules: disallowedTools are added in every permission mode; a throwing module adds nothing', async () => {
  const s = setup(() => happy(), { agent: { approval: 'full' } });
  s.engine.setModules([
    { id: 'm', disallowedTools: (a) => (a.id === 'a1' ? ['mcp__blender'] : ['other']) },
    { id: 'broken', disallowedTools: () => { throw new Error('boom'); } },
  ]);
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'hi', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const o = s.calls[0]!.options;
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.deepEqual(o.disallowedTools, ['SendMessage', 'ListAgents', 'mcp__blender']);
});

test('bot-origin task: a full-approval agent is never run in bypass mode when the sender is stricter', async () => {
  const s = setup(() => happy(), { agent: { approval: 'full' } });
  const origin = { roomId: 'room_1', fromAgentId: 'scout', hop: 1, approvalCeiling: 'ask' as const };
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'bot', origin });
  await s.engine.waitFor(t.id, 3000);
  const o = s.calls[0]!.options;
  assert.notEqual(o.permissionMode, 'bypassPermissions');
  assert.equal(typeof o.canUseTool, 'function');
  assert.equal(s.store.getTask(t.id)!.origin?.fromAgentId, 'scout');
  // Bash needs a card, and the card names the sender.
  const sig = { signal: new AbortController().signal };
  const p = o.canUseTool('Bash', { command: 'rm -rf x' }, sig);
  const [req] = s.approvals.pending();
  assert.deepEqual(req!.origin, { roomId: 'room_1', fromAgentId: 'scout', hop: 1 });
  s.approvals.resolve(req!.id, false);
  assert.equal((await p).behavior, 'deny');
});

test('bot-origin task with a full ceiling keeps the receiver bypass mode; human tasks are unchanged', async () => {
  const s = setup(() => happy(), { agent: { approval: 'full' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'bot', origin: { roomId: 'r', fromAgentId: 'builder', hop: 1, approvalCeiling: 'full' } });
  await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls[0]!.options.permissionMode, 'bypassPermissions');
});
