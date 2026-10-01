/**
 * BSV v1 review fixes, part 2: the hidden Assayer, through the REAL engine, store, comms hub and HTTP/MCP servers (F3, F4).
 * "Hidden" means: while BSV mode is off nothing on any surface says the Assayer exists or what it did. Local only.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ASSAYER_ID, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createCommsModule } from '../src/core/comms/index.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { CoreContext } from '../src/core/server.js';
import type { LegionEvent, Task } from '../src/shared/types.js';
import { start, TOKEN } from './helpers-c.js';
import { init, mkAgent, ok } from './library-fakes.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

const deferred = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; };

async function rig(opts: { maxConcurrent?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-bsvhid-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4747, authToken: 'x', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} }, null, 2));
  const store = new Store(join(dir, 'store'));
  for (const a of [mkAgent('zealot', 'Zealot'), mkAgent('scout', 'Scout'), { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' as const }]) store.upsertAgent(a);
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  config.authToken = TOKEN;
  const started: string[] = [];
  const hold = { zealot: deferred() };
  let hasHold = false;
  const queryFn = ((p: any) => {
    const agent = basename(p.options.cwd);
    started.push(agent);
    const sid = `sess-${started.length}`;
    const gen = (async function* () {
      yield init(sid);
      if (agent === 'zealot' && hasHold) await hold.zealot.p;
      yield ok(`${agent} done`, sid);
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const approvals = new ApprovalBroker(bus);
  const engine = new Engine({ store, bus, vms: {} as any, approvals, config, queryFn, boatConfigured: () => false, maxConcurrent: opts.maxConcurrent ?? 4 });
  const state = createBsvState({ dataDir: dir, config });
  const deps = { config, store, bus, engine, approvals, dataDir: dir, bsvEnabled: () => state.enabled };
  const comms = createCommsModule(deps);
  const bsv = createBsvModule(deps, { state });
  engine.setModules([comms, bsv]);
  const ctx: CoreContext = {
    config, store, bus, engine, vms: {} as any, approvals, boatConfigured: () => false,
    doctor: async () => [], catalog: async () => ({ commands: [], models: [], fetchedAt: '' }), settings: {} as any,
    modules: [comms, bsv], bsvEnabled: () => state.enabled,
  };
  const srv = await start(ctx);
  closers.push(async () => { await comms.dispose?.(); await srv.close(); });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : undefined };
  };
  const mcp = new Client({ name: 'hidden-test', version: '0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(srv.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  closers.push(() => mcp.close());
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r: any = await mcp.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join('\n'), isError: r.isError === true };
  };
  const run = async (agentId: string, prompt: string): Promise<Task> => {
    const t = engine.startTask({ agentId, prompt, source: 'ui' });
    return engine.waitFor(t.id, 5000);
  };
  return { dir, store, bus, engine, approvals, state, comms, bsv, ctx, srv, call, tool, run, started, hold, setHold: (v: boolean) => { hasHold = v; } };
}

const toggle = (s: Awaited<ReturnType<typeof rig>>, on: boolean) => s.call('POST', '/api/bsv', { enabled: on });

// ------------------------------------------------------------------ F3: tasks, state, approvals, SSE

test('F3: while BSV is off, /api/state and the task routes say nothing about the Assayer\'s tasks, approvals or events', async () => {
  const s = await rig();
  await toggle(s, true);
  const secret = await s.run(ASSAYER_ID, 'a bsv question nobody should see while off');
  const plain = await s.run('zealot', 'an ordinary question');
  assert.equal(secret.status, 'done');
  // an approval waiting for the Assayer
  void s.approvals.request(secret.id, ASSAYER_ID, 'Bash', { command: 'echo hidden' });
  void s.approvals.request(plain.id, 'zealot', 'Bash', { command: 'echo visible' });

  const on = (await s.call('GET', '/api/state')).body;
  assert.ok(on.tasks.some((t: Task) => t.id === secret.id), 'BSV on: the task is listed');
  assert.equal((await s.call('GET', `/api/tasks/${secret.id}`)).status, 200);

  await toggle(s, false);
  const state = (await s.call('GET', '/api/state')).body;
  const text = JSON.stringify(state);
  assert.ok(!state.tasks.some((t: Task) => t.agentId === ASSAYER_ID), 'no task of the Assayer in /api/state');
  assert.ok(state.tasks.some((t: Task) => t.id === plain.id), 'ordinary tasks are still there');
  assert.ok(!state.agents.some((a: { id: string }) => a.id === ASSAYER_ID));
  assert.ok(!state.approvals.some((a: { agentId: string }) => a.agentId === ASSAYER_ID), 'no approval of the Assayer');
  assert.ok(state.approvals.some((a: { agentId: string }) => a.agentId === 'zealot'));
  assert.ok(!state.vms.some((v: { agentId: string }) => v.agentId === ASSAYER_ID), 'no VM record of the Assayer');
  assert.doesNotMatch(text, /nobody should see/);
  assert.doesNotMatch(text, /assayer/i);

  for (const [method, path, body] of [
    ['GET', `/api/tasks/${secret.id}`], ['GET', `/api/tasks/${secret.id}/wait?timeoutMs=10`], ['PATCH', `/api/tasks/${secret.id}`, { title: 'x' }],
    ['DELETE', `/api/tasks/${secret.id}`], ['POST', `/api/tasks/${secret.id}/cancel`],
  ] as Array<[string, string, unknown?]>) {
    const r = await s.call(method, path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.doesNotMatch(JSON.stringify(r.body), /assayer|nobody should see/i, `${method} ${path} leaks nothing`);
  }
  assert.equal((await s.call('GET', `/api/tasks/${plain.id}`)).status, 200);
  assert.equal((await s.call('POST', '/api/tasks', { agentId: ASSAYER_ID, prompt: 'x' })).status, 404);
  // and the task is intact: BSV on again shows it
  await toggle(s, true);
  assert.equal((await s.call('GET', `/api/tasks/${secret.id}`)).status, 200);
  s.approvals.cancelForTask(secret.id);
  s.approvals.cancelForTask(plain.id);
});

test('F3: the event stream never carries the Assayer\'s tasks, messages, approvals, VM, rooms or comms state while BSV is off', async () => {
  const s = await rig();
  await toggle(s, true);
  const secret = await s.run(ASSAYER_ID, 'event stream secret');
  const room = (await s.call('POST', '/api/rooms', { name: 'Hidden Room', members: ['scout', ASSAYER_ID] })).body;
  assert.ok(room?.id, 'the room was made while BSV was on');
  await toggle(s, false);

  const ac = new AbortController();
  const res = await fetch(s.srv.base + '/api/events', { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
  closers.push(async () => ac.abort());
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += dec.decode(value); } } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 50));
  const assayerRecord = s.store.getTask(secret.id)!;
  const evs: LegionEvent[] = [
    { type: 'task.updated', task: assayerRecord },
    { type: 'message', message: { id: 'mx', taskId: secret.id, role: 'assistant', text: 'LEAK-message', at: '' } },
    { type: 'message.delta', taskId: secret.id, text: 'LEAK-delta' },
    { type: 'vm.updated', vm: { agentId: ASSAYER_ID, sandboxId: null, state: 'running', size: 'default', lastUsedAt: null, createdAt: null } },
    { type: 'approval.requested', approval: { id: 'apr_x', taskId: secret.id, agentId: ASSAYER_ID, toolName: 'Bash', summary: 'LEAK-approval', input: {}, at: '' } },
    { type: 'agent.deleted', agentId: ASSAYER_ID },
    { type: 'comms.state', agentId: ASSAYER_ID, state: 'speaking' },
    { type: 'comms.state', agentId: 'scout', state: 'waiting-bot', peerId: ASSAYER_ID },
    { type: 'room.updated', room } as LegionEvent,
    { type: 'room.message', message: { id: 'rm1', roomId: room.id, from: { kind: 'bot', agentId: ASSAYER_ID }, to: [], kind: 'chat', text: 'LEAK-room', at: '', hop: 1 } } as LegionEvent,
    { type: 'task.updated', task: { id: 'zz', agentId: 'zealot', title: 'CONTROL', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: '', updatedAt: '' } },
  ];
  for (const e of evs) s.bus.emit(e);
  await new Promise((r) => setTimeout(r, 150));
  ac.abort();
  await pump;
  assert.match(seen, /CONTROL/, 'the control event arrived, so the stream was live');
  assert.doesNotMatch(seen, /LEAK|event stream secret|assayer/i, `leaked: ${seen.slice(0, 400)}`);
});

// ------------------------------------------------------------------ F3: MCP

test('F3: legion_status, legion_recent_tasks, legion_continue and legion_cancel treat the Assayer\'s tasks as unknown while BSV is off', async () => {
  const s = await rig();
  await toggle(s, true);
  const secret = await s.run(ASSAYER_ID, 'mcp secret question');
  const plain = await s.run('zealot', 'mcp plain question');
  assert.equal((await s.tool('legion_status', { taskId: secret.id })).isError, false, 'BSV on: readable');
  await toggle(s, false);

  const st = await s.tool('legion_status', { taskId: secret.id });
  assert.equal(st.isError, true);
  assert.doesNotMatch(st.text, /assayer|mcp secret question/i);
  const missing = await s.tool('legion_status', { taskId: 'task_does_not_exist' });
  assert.equal(st.text.replace(secret.id, 'X'), missing.text.replace('task_does_not_exist', 'X'), 'a hidden task answers exactly like an id that never existed');
  const recent = await s.tool('legion_recent_tasks', { limit: 50 });
  assert.doesNotMatch(recent.text, /assayer|mcp secret question/i);
  assert.match(recent.text, new RegExp(plain.id), 'ordinary tasks are still listed');
  assert.equal((await s.tool('legion_continue', { taskId: secret.id, prompt: 'more' })).isError, true);
  const cancel = await s.tool('legion_cancel', { taskId: secret.id });
  assert.match(cancel.text, /Unknown task/);
  assert.equal((await s.tool('legion_status', { taskId: plain.id })).isError, false);
});

// ------------------------------------------------------------------ F3: comms

function hubOf(s: Awaited<ReturnType<typeof rig>>): any {
  // the module hides its hub; reach it through the tools it hands each bot (the same path a model uses)
  return s.comms;
}

test('F3: bot_list, bot_send, room membership and DM creation never reveal or reach the hidden Assayer', async () => {
  const s = await rig();
  const comms = hubOf(s);
  const scoutServer: any = comms.mcpServers({ id: 'scout', name: 'Scout' } as any).legion_comms;
  const botTool = async (name: string, args: Record<string, unknown>) => {
    const r = await scoutServer.instance._registeredTools[name].handler(args, {});
    return { text: r.content.map((c: any) => c.text).join('\n'), isError: r.isError === true };
  };
  const roomsOnDisk = () => s.call('GET', '/api/rooms').then((r) => r.body as Array<{ id: string; members: string[]; kind: string }>);

  // BSV on: the Assayer is a normal peer, and a group room with it can exist
  await toggle(s, true);
  assert.match((await botTool('bot_list', {})).text, /assayer/i);
  const made = await s.call('POST', '/api/rooms', { name: 'Gold room', members: ['scout', ASSAYER_ID] });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  // BSV off
  await toggle(s, false);
  const before = (await roomsOnDisk()).length;
  const list = await botTool('bot_list', {});
  assert.doesNotMatch(list.text, /assayer/i, 'bot_list does not list it');
  const hiddenSend = await botTool('bot_send', { to: 'assayer', text: 'hello hidden' });
  const nameSend = await botTool('bot_send', { to: 'Assayer', text: 'hello hidden' });
  const ghostSend = await botTool('bot_send', { to: 'nosuchbot', text: 'hello ghost' });
  assert.equal(hiddenSend.isError, true);
  assert.match(hiddenSend.text, /Unknown bot/);
  assert.equal(hiddenSend.text.replace(/"?assayer"?/i, 'X'), ghostSend.text.replace(/"?nosuchbot"?/i, 'X'), 'hidden and non-existent answer identically (no existence oracle)');
  assert.equal(nameSend.isError, true);
  assert.equal((await roomsOnDisk()).length, before, 'no DM room was created');
  assert.ok(!(await roomsOnDisk()).some((r) => r.kind === 'dm'), 'no dm room at all');
  assert.equal(s.started.includes(ASSAYER_ID), false, 'and nothing woke the Assayer');

  // human side: rooms API
  const rooms = await roomsOnDisk();
  assert.ok(!rooms.some((r) => r.members.includes(ASSAYER_ID)), 'a room that has the Assayer in it is not listed while off');
  assert.equal((await s.call('GET', `/api/rooms/${made.body.id}`)).status, 404);
  assert.equal((await s.call('POST', `/api/rooms/${made.body.id}/messages`, { text: 'hi' })).status, 404);
  assert.equal((await s.call('POST', '/api/rooms', { name: 'Another', members: ['scout', ASSAYER_ID] })).status, 400, 'cannot create a room with it');
  assert.equal((await s.call('POST', '/api/rooms', { name: 'Third', members: ['scout', 'zealot'] })).status, 201);
  const third = (await roomsOnDisk()).find((r) => r.members.includes('zealot') && r.members.includes('scout'))!;
  const add = await s.call('POST', `/api/rooms/${third.id}/members`, { add: [ASSAYER_ID] });
  assert.equal(add.status, 400, 'cannot add it to a room');
  const ghostAdd = await s.call('POST', `/api/rooms/${third.id}/members`, { add: ['nosuchbot'] });
  assert.equal(JSON.stringify(add.body).replace('assayer', 'X'), JSON.stringify(ghostAdd.body).replace('nosuchbot', 'X'), 'same answer as for an agent that never existed');
  assert.equal((await s.call('GET', '/api/rooms/search?q=Gold')).body.rooms.length, 0, 'search does not find the hidden room');

  // BSV on again: everything is back, nothing was lost
  await toggle(s, true);
  assert.equal((await s.call('GET', `/api/rooms/${made.body.id}`)).status, 200);
  assert.match((await botTool('bot_list', {})).text, /assayer/i);
});

// ------------------------------------------------------------------ F4: queued jobs

test('F4: a job of the Assayer that was queued and whose BSV mode went off is cancelled with a clear message, never run (the engine check alone, no toggle route)', async () => {
  const s = await rig({ maxConcurrent: 1 });
  await toggle(s, true);
  s.setHold(true);
  const blocker = s.engine.startTask({ agentId: 'zealot', prompt: 'occupy the only slot', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const queued = s.engine.startTask({ agentId: ASSAYER_ID, prompt: 'queued while on', source: 'ui' });
  assert.equal(s.store.getTask(queued.id)!.status, 'queued');
  // the flag flips WITHOUT going through the toggle route (config edited, another module, a race)
  s.state.set(false);
  s.hold.zealot.release();
  await s.engine.waitFor(blocker.id, 5000);
  await new Promise((r) => setTimeout(r, 60));
  const t = s.store.getTask(queued.id)!;
  assert.equal(t.status, 'cancelled', `the queued Assayer job was ${t.status}`);
  assert.equal(s.started.includes(ASSAYER_ID), false, 'the Assayer never ran');
  const msgs = s.store.listMessages(queued.id).map((m) => m.text).join('\n');
  assert.match(msgs, /BSV mode was turned off/i, 'a clear reason is recorded');
});

test('F4: turning BSV off through the toggle route cancels the queued Assayer jobs at once, and leaves other agents\' jobs alone', async () => {
  const s = await rig({ maxConcurrent: 1 });
  await toggle(s, true);
  s.setHold(true);
  const blocker = s.engine.startTask({ agentId: 'zealot', prompt: 'occupy the only slot', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const a = s.engine.startTask({ agentId: ASSAYER_ID, prompt: 'assayer queued', source: 'ui' });
  const z = s.engine.startTask({ agentId: 'scout', prompt: 'scout queued', source: 'ui' });
  await toggle(s, false);
  assert.equal(s.store.getTask(a.id)!.status, 'cancelled', 'cancelled the moment the toggle went off');
  assert.equal(s.store.getTask(z.id)!.status, 'queued', 'an ordinary queued job is untouched');
  s.hold.zealot.release();
  await s.engine.waitFor(z.id, 5000);
  assert.equal(s.store.getTask(z.id)!.status, 'done');
  assert.equal(s.started.includes(ASSAYER_ID), false);
  await s.engine.waitFor(blocker.id, 5000);
});

test('F4: the Assayer\'s cancelled job does not reach the event stream while BSV is off', async () => {
  const s = await rig({ maxConcurrent: 1 });
  await toggle(s, true);
  s.setHold(true);
  const blocker = s.engine.startTask({ agentId: 'zealot', prompt: 'occupy', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  s.engine.startTask({ agentId: ASSAYER_ID, prompt: 'LEAK queued assayer job', source: 'ui' });
  s.state.set(false); // off, then a client connects
  const ac = new AbortController();
  const res = await fetch(s.srv.base + '/api/events', { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += dec.decode(value); } } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 30));
  s.hold.zealot.release(); // the pump now reaches the queued Assayer job and cancels it
  await s.engine.waitFor(blocker.id, 5000);
  await new Promise((r) => setTimeout(r, 120));
  ac.abort();
  await pump;
  assert.match(seen, /occupy/, 'the stream was live (the blocker finished on it)');
  assert.doesNotMatch(seen, /LEAK|assayer|Cancelled: BSV/i, seen.slice(0, 400));
});
