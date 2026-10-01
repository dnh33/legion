import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ASSAYER_ID, BSV_PREAMBLE, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import type { CoreModule } from '../src/core/modules.js';
import type { LegionEvent } from '../src/shared/types.js';
import { makeFakes, mkAgent, start, TOKEN } from './helpers-c.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

interface SetupOpts { kg?: boolean; seedPath?: string; withConfigFile?: boolean; startOn?: boolean }

async function setup(o: SetupOpts = {}) {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = mkdtempSync(join(tmpdir(), 'legion-bsv-'));
  if (o.withConfigFile !== false) {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port: 4747, authToken: 'on-disk-token', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} }, null, 2));
  }
  const cfg = f.ctx.config as any;
  if (o.startOn) cfg.bsv = { enabled: true, network: 'testnet' };
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const bsvEnabled = () => state.enabled;
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled };
  const kg: CoreModule | undefined = o.kg === false ? undefined : createKnowledgeModule(deps, { debounceMs: 20, seedPath: o.seedPath });
  const bsv = createBsvModule(deps, { state, kg });
  f.ctx.modules = [...(kg ? [kg] : []), bsv];
  f.ctx.bsvEnabled = bsvEnabled;
  const srv = await start(f.ctx);
  const events: LegionEvent[] = [];
  f.bus.on((e) => events.push(e));
  const call = async (method: string, path: string, body?: unknown, raw?: string) => {
    const r = await fetch(srv.base + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const close = async () => { await kg?.dispose?.(); await srv.close(); };
  closers.push(close);
  return { ...f, state, bsv, kg, dataDir, srv, events, call, close };
}

const ids = (xs: Array<{ id: string }>) => xs.map((a) => a.id);

test('state filter: the Assayer is hidden from /api/state and /api/agents while off, shown while on', async () => {
  const s = await setup();
  assert.equal(ids((await s.call('GET', '/api/state')).body.agents).includes('assayer'), false);
  assert.equal(ids((await s.call('GET', '/api/agents')).body).includes('assayer'), false);
  assert.deepEqual(ids((await s.call('GET', '/api/state')).body.agents), ['zealot', 'scout']);

  assert.equal((await s.call('POST', '/api/bsv', { enabled: true })).status, 200);
  assert.equal(ids((await s.call('GET', '/api/state')).body.agents).includes('assayer'), true);
  assert.equal(ids((await s.call('GET', '/api/agents')).body).includes('assayer'), true);

  assert.equal((await s.call('POST', '/api/bsv', { enabled: false })).status, 200);
  assert.equal(ids((await s.call('GET', '/api/state')).body.agents).includes('assayer'), false);
  assert.equal(ids((await s.call('GET', '/api/agents')).body).includes('assayer'), false);
});

test('hidden agents stay reachable by id: patch works, then delete works', async () => {
  const s = await setup();
  const p = await s.call('PATCH', '/api/agents/assayer', { description: 'tuned while hidden' });
  assert.equal(p.status, 200);
  assert.equal(s.agents.get('assayer')!.description, 'tuned while hidden');
  assert.equal((await s.call('DELETE', '/api/agents/assayer')).status, 200);
  assert.equal(s.agents.has('assayer'), false);
});

test('without a bsvEnabled hook in the context the gated agent is hidden', async () => {
  const s = await setup();
  s.ctx.bsvEnabled = undefined;
  assert.equal(ids((await s.call('GET', '/api/agents')).body).includes('assayer'), false);
  await s.state.set(true);
  assert.equal(ids((await s.call('GET', '/api/agents')).body).includes('assayer'), false);
});

test('MCP legion_list_agents hides and shows the Assayer with the flag', async () => {
  const s = await setup();
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.srv.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  closers.push(() => client.close());
  const list = async (): Promise<string[]> => {
    const r: any = await client.callTool({ name: 'legion_list_agents', arguments: {} });
    return JSON.parse(r.content.map((c: any) => c.text).join('')).map((a: any) => a.id);
  };
  assert.deepEqual(await list(), ['zealot', 'scout']);
  await s.call('POST', '/api/bsv', { enabled: true });
  assert.deepEqual(await list(), ['zealot', 'scout', 'assayer']);
  await s.call('POST', '/api/bsv', { enabled: false });
  assert.deepEqual(await list(), ['zealot', 'scout']);
});

test('GET /api/bsv reports the status shape; POST validates the body', async () => {
  const s = await setup();
  const g = await s.call('GET', '/api/bsv');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { enabled: false, network: 'testnet', assayerAvailable: true, knowledgeLoaded: false, knowledgeNodes: 0 });
  for (const bad of [undefined, {}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, [true], 'on', { on: true }]) {
    const r = await s.call('POST', '/api/bsv', bad as any);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await s.call('POST', '/api/bsv', undefined, '{not json')).status, 400);
  assert.equal(s.state.enabled, false, 'a bad body must not flip anything');
  assert.equal((await s.call('GET', '/api/bsv')).body.enabled, false);
  assert.equal((await fetch(s.srv.base + '/api/bsv')).status, 401, 'bearer auth is enforced');
  assert.equal((await s.call('PATCH', '/api/bsv', { enabled: true })).status, 405);
});

test('assayerAvailable is false when the roster agent is gone', async () => {
  const s = await setup();
  s.agents.delete('assayer');
  assert.equal((await s.call('GET', '/api/bsv')).body.assayerAvailable, false);
});

test('enabling loads the seed once and is idempotent; disabling hides the kg bsv scope but keeps the nodes', async () => {
  const s = await setup();
  assert.equal((await s.call('GET', '/api/kg/stats')).body.byScope.bsv, undefined);
  assert.equal((await s.call('POST', '/api/kg/seed/bsv', {})).status, 409, 'kg refuses to seed while off');

  const on1 = (await s.call('POST', '/api/bsv', { enabled: true })).body;
  assert.equal(on1.enabled, true);
  assert.equal(on1.seed.status, 'loaded');
  assert.ok(on1.seed.nodes >= 45, `seed nodes ${on1.seed.nodes}`);
  assert.ok(on1.seed.created >= 45);
  assert.equal(on1.knowledgeLoaded, true);
  assert.equal(on1.knowledgeNodes, on1.seed.nodes);
  const stats1 = (await s.call('GET', '/api/kg/stats')).body;
  assert.equal(stats1.byScope.bsv, on1.seed.nodes);

  const on2 = (await s.call('POST', '/api/bsv', { enabled: true })).body;
  assert.equal(on2.seed.status, 'already-loaded');
  assert.equal(on2.knowledgeNodes, on1.knowledgeNodes);
  assert.equal((await s.call('GET', '/api/kg/stats')).body.nodes, stats1.nodes, 'no duplicate nodes');

  const off = (await s.call('POST', '/api/bsv', { enabled: false })).body;
  assert.equal(off.enabled, false);
  assert.equal(off.seed, undefined);
  assert.equal(off.knowledgeLoaded, false);
  assert.equal(off.knowledgeNodes, 0);
  const statsOff = (await s.call('GET', '/api/kg/stats')).body;
  assert.equal(statsOff.byScope.bsv, undefined, 'bsv scope is hidden while off');
  assert.equal(statsOff.bsvAvailable, false);

  const on3 = (await s.call('POST', '/api/bsv', { enabled: true })).body;
  assert.equal(on3.seed.status, 'already-loaded', 'nodes were kept while off, so no second load');
  assert.equal(on3.knowledgeNodes, on1.knowledgeNodes);
});

test('two simultaneous enable requests load the pack exactly once', async () => {
  const s = await setup();
  const [a, b] = await Promise.all([s.call('POST', '/api/bsv', { enabled: true }), s.call('POST', '/api/bsv', { enabled: true })]);
  const statuses = [a.body.seed.status, b.body.seed.status].sort();
  assert.deepEqual(statuses, ['already-loaded', 'loaded']);
});

test('a missing or broken pack does not block the toggle and says so', async () => {
  const s = await setup({ seedPath: join(tmpdir(), 'definitely-not-here.json') });
  const r = await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.seed.status, 'error');
  assert.match(r.body.seed.error, /not installed|missing/i);
  assert.equal(r.body.knowledgeLoaded, false);
});

test('without a knowledge graph module the toggle still works and reports no-kg', async () => {
  const s = await setup({ kg: false });
  const r = await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.seed, { status: 'no-kg' });
  assert.equal(r.body.knowledgeNodes, 0);
});

test('the flag persists in config.json (only the bsv key changes) and survives a restart', async () => {
  const s = await setup();
  const file = join(s.dataDir, 'config.json');
  const before = JSON.parse(readFileSync(file, 'utf8'));
  await s.call('POST', '/api/bsv', { enabled: true });
  const after1 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after1.bsv, { enabled: true, network: 'testnet' });
  assert.deepEqual({ ...after1, bsv: undefined }, { ...before, bsv: undefined }, 'nothing but "bsv" was touched');
  assert.equal(createBsvState({ dataDir: s.dataDir }).enabled, false, 'a state with no config object does not read config.json');
  const reloaded = createBsvState({ dataDir: s.dataDir, config: { ...(s.ctx.config as any), bsv: after1.bsv } });
  assert.equal(reloaded.enabled, true);
  assert.deepEqual((s.ctx.config as any).bsv, { enabled: true, network: 'testnet' }, 'in-memory config follows');
  await s.call('POST', '/api/bsv', { enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).bsv, { enabled: false, network: 'testnet' });
});

test('env-derived secrets in the in-memory config never reach config.json', async () => {
  const s = await setup();
  (s.ctx.config as any).boat.apiKey = 'ENV-BOAT-KEY';
  (s.ctx.config as any).claude.apiKey = 'ENV-ANTHROPIC-KEY';
  await s.call('POST', '/api/bsv', { enabled: true });
  const raw = readFileSync(join(s.dataDir, 'config.json'), 'utf8');
  assert.equal(raw.includes('ENV-'), false);
  assert.equal(JSON.parse(raw).authToken, 'on-disk-token');
});

test('without a config.json the flag falls back to bsv.json in the data dir', async () => {
  const s = await setup({ withConfigFile: false });
  await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal(existsSync(join(s.dataDir, 'config.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, 'bsv.json'), 'utf8')), { enabled: true, network: 'testnet' });
  assert.equal(createBsvState({ dataDir: s.dataDir }).enabled, true);
});

test('a config that starts with bsv enabled starts on', async () => {
  const s = await setup({ startOn: true });
  assert.equal(s.state.enabled, true);
  assert.equal(ids((await s.call('GET', '/api/agents')).body).includes('assayer'), true);
});

test('turning on emits agent.updated for the Assayer; turning off emits nothing (clients refetch)', async () => {
  const s = await setup();
  await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal(s.events.filter((e) => e.type === 'agent.updated' && e.agent.id === 'assayer').length, 1);
  await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal(s.events.filter((e) => e.type === 'agent.updated' && e.agent.id === 'assayer').length, 1, 'no event when nothing changed');
  s.events.length = 0;
  await s.call('POST', '/api/bsv', { enabled: false });
  assert.equal(s.events.some((e) => e.type === 'agent.deleted' || e.type === 'agent.updated'), false);
});

test('the event stream does not leak the hidden Assayer', async () => {
  const s = await setup();
  const ctl = new AbortController();
  const res = await fetch(s.srv.base + `/api/events?token=${TOKEN}`, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += dec.decode(value); } } catch { /* aborted */ } })();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(50);
  s.bus.emit({ type: 'agent.updated', agent: s.agents.get('assayer')! });
  s.bus.emit({ type: 'agent.updated', agent: s.agents.get('scout')! });
  await wait(80);
  assert.equal(seen.includes('"id":"assayer"'), false);
  assert.equal(seen.includes('"id":"scout"'), true);
  s.state.set(true);
  s.bus.emit({ type: 'agent.updated', agent: s.agents.get('assayer')! });
  await wait(80);
  assert.equal(seen.includes('"id":"assayer"'), true);
  ctl.abort();
  await pump;
});

test('preamble: four lines, only for the assayer, only while on', async () => {
  const s = await setup();
  const a = s.agents.get('assayer')!;
  assert.equal(s.bsv.preamble!(a), '', 'off');
  assert.equal(s.bsv.preamble!(s.agents.get('zealot')!), '', 'other agent, off');
  s.state.set(true);
  const p = s.bsv.preamble!(a);
  assert.equal(p, BSV_PREAMBLE);
  assert.equal(p.split('\n').length, 4);
  assert.match(p, /BSV mode is on/);
  assert.match(p, /testnet/);
  assert.match(p, /no wallet tools/);
  assert.match(p, /kg_recall with scope bsv/);
  assert.match(p, /Never ask the user for keys, seed phrases/);
  for (const id of ['zealot', 'scout', 'builder', 'herald', 'assayer2']) assert.equal(s.bsv.preamble!(mkAgent(id)), '', id);
  s.state.set(false);
  assert.equal(s.bsv.preamble!(a), '', 'off again');
});

test('the module has no mcp servers of its own (no tools, no wallet)', async () => {
  const s = await setup();
  s.state.set(true);
  assert.equal(s.bsv.mcpServers, undefined);
});

// ---------------------------------------------------------------- BSV mode v1: the hidden Assayer stays hidden for every way of running it

async function mcpClient(s: Awaited<ReturnType<typeof setup>>): Promise<(name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.srv.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  closers.push(() => client.close());
  return async (name, args) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join('\n'), isError: r.isError === true };
  };
}

test('hidden Assayer: legion_run, legion_continue and legion_vm (exec included) say Unknown agent while BSV is off, and the message does not name it; BSV on works', async () => {
  const s = await setup();
  const call = await mcpClient(s);
  // a finished Assayer task from an earlier "on" period, to try to continue
  await s.call('POST', '/api/bsv', { enabled: true });
  const first = await call('legion_run', { agent: 'assayer', prompt: 'explain utxos' });
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, /echo: explain utxos/);
  const taskId = /"taskId":\s*"(task_\d+)"/.exec(first.text)![1]!;
  assert.equal((await call('legion_vm', { agent: 'Assayer', action: 'exec', command: 'echo hi' })).isError, false, 'BSV on: exec reaches the Assayer VM');
  assert.equal((await call('legion_continue', { taskId, prompt: 'more' })).isError, false);

  await s.call('POST', '/api/bsv', { enabled: false });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['legion_run', { agent: 'assayer', prompt: 'x' }],
    ['legion_run', { agent: 'ASSAYER', prompt: 'x' }],
    ['legion_run', { agent: 'Assayer', prompt: 'x', wait: false }],
    ['legion_vm', { agent: 'assayer', action: 'status' }],
    ['legion_vm', { agent: 'assayer', action: 'start' }],
    ['legion_vm', { agent: 'assayer', action: 'exec', command: 'echo hi' }],
    ['legion_vm', { agent: 'assayer', action: 'desktop' }],
  ];
  for (const [name, args] of calls) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.text, /Unknown agent "[^"]*"/i, name);
    assert.match(r.text, /Available agents: zealot \(Zealot\), scout \(Scout\)\./, 'the list omits the Assayer');
    assert.doesNotMatch(r.text.replace(/Unknown agent "[^"]*"/i, ''), /assayer/i, `${name}: the message must not name the Assayer`);
  }
  const cont = await call('legion_continue', { taskId, prompt: 'more' });
  assert.equal(cont.isError, true);
  assert.match(cont.text, /Unknown task/);
  assert.doesNotMatch(cont.text, /assayer/i);
  // other agents are unaffected
  assert.equal((await call('legion_run', { agent: 'scout', prompt: 'hi' })).isError, false);
  assert.equal((await call('legion_vm', { agent: 'scout', action: 'status' })).isError, false);

  await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal((await call('legion_run', { agent: 'assayer', prompt: 'back again' })).isError, false, 'BSV on again');
});

test('hidden Assayer over HTTP: starting a task, its VM, exec and desktop are refused while BSV is off; reading, editing and stopping still work', async () => {
  const s = await setup();
  const off = [
    await s.call('POST', '/api/tasks', { agentId: 'assayer', prompt: 'x' }),
    await s.call('POST', '/api/vms/assayer/start'),
    await s.call('POST', '/api/vms/assayer/exec', { command: 'echo hi' }),
    await s.call('POST', '/api/vms/assayer/desktop'),
    await s.call('GET', '/api/vms/assayer/screenshot'),
  ];
  for (const r of off) assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal((await s.call('POST', '/api/vms/assayer/stop')).status, 200, 'a running VM can still be stopped');
  assert.equal((await s.call('PATCH', '/api/agents/assayer', { description: 'tuned while hidden' })).status, 200);
  assert.equal((await s.call('POST', '/api/tasks', { agentId: 'scout', prompt: 'x' })).status, 201);
  await s.call('POST', '/api/bsv', { enabled: true });
  assert.equal((await s.call('POST', '/api/tasks', { agentId: 'assayer', prompt: 'x' })).status, 201);
  assert.equal((await s.call('POST', '/api/vms/assayer/exec', { command: 'echo hi' })).status, 200);
});
