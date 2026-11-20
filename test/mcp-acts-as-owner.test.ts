/**
 * "MCP clients act as you" (app gate setting `mcpActsAsOwner`): off by default, set only by the owner's save, read as off from an app file Legion
 * cannot trust. With it on, a token client may start a run inside a project at the agent's own approval mode, and may create and change projects and
 * board items. With it off nothing changes (the old guard tests in projects-engine, mcp and project-board-* keep proving the off state).
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initialPrompt } from '../src/core/input-channel.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine, EngineError } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { BoardStore } from '../src/core/projects/board/store.js';
import { TaintedPaths } from '../src/core/tainted-paths.js';
import { GatesStore, MCP_OWNER_ON_LINE, MCP_OWNER_OFF_LINE } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import { PRESETS } from '../src/shared/gates-registry.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, Task } from '../src/shared/types.js';
import { MCP_OWNER_OFF } from '../src/core/mcp-tools.js';
import { makeFakes, start, TOKEN } from './helpers-c.js';

const newGates = (dir = join(cleanupTemp('legion-mcp-owner-gates-'), 'gates')) => ({ dir, store: new GatesStore(dir, { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 7)), keyState: 'new' }) });

// ---- the setting itself

test('the setting is off by default, the owner turns it on and off in the app file, and it survives a restart', async () => {
  const { dir, store } = newGates();
  assert.equal(store.app().mcpActsAsOwner, undefined, 'absent means off');
  const pv = store.preview('app', { mcpActsAsOwner: true });
  assert.ok(pv.loosening.includes(MCP_OWNER_ON_LINE), 'turning it on is a loosening the dialog names');
  store.patchApp({ mcpActsAsOwner: true });
  assert.equal(store.app().mcpActsAsOwner, true);
  await store.flush();
  const again = new GatesStore(dir, { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 7)), keyState: 'new' });
  assert.equal(again.app().mcpActsAsOwner, true, 'kept across a restart, signed with the rest');
  assert.ok(again.preview('app', { mcpActsAsOwner: false }).lines.includes(MCP_OWNER_OFF_LINE));
  again.patchApp({ mcpActsAsOwner: false });
  assert.equal(again.app().mcpActsAsOwner, undefined, 'off is written as absent');
});

test('the setting is app-wide and boolean only', () => {
  const { store } = newGates();
  assert.throws(() => store.patchProject('proj_000000000001', { mcpActsAsOwner: true }), /whole app/);
  assert.throws(() => store.patchApp({ mcpActsAsOwner: 'yes' }), /true or false/);
});

test('without the signing key the setting cannot be turned on (a loosening needs the key)', () => {
  const dir = join(cleanupTemp('legion-mcp-owner-nokey-'), 'gates');
  const store = new GatesStore(dir, { allowed: PRESETS, signer: undefined, keyState: 'unreadable' } as any);
  assert.throws(() => store.patchApp({ mcpActsAsOwner: true }));
  assert.equal(store.app().mcpActsAsOwner, undefined);
});

// ---- the engine: project pick and approval cap

class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, Task>();
  msgs: ChatMessage[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  listAgents() { return [...this.agents.values()]; }
  listTasks(limit = 500, agentId?: string) { return [...this.tasks.values()].filter((t) => !agentId || t.agentId === agentId).slice(0, limit).map((t) => ({ ...t })); }
  upsertTask(t: Task) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: ChatMessage) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}
const mkAgent = (id: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id, name: id.toUpperCase(), emoji: 'A', description: '', systemPrompt: '', model: 'auto',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'], createdAt: '', updatedAt: '', ...over,
});
async function* quick(): AsyncGenerator<any, void> {
  yield { type: 'system', subtype: 'init', session_id: 's1' };
  yield { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, num_turns: 1, session_id: 's1' };
}

function setup() {
  const root = cleanupTemp('legion-mcp-owner-eng-');
  const store = new FakeStore();
  for (const id of ['a1', 'a2']) store.agents.set(id, mkAgent(id));
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(root, 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const calls: Array<{ prompt: any; options: any }> = [];
  const queryFn = ((params: any) => {
    calls.push({ ...params, prompt: initialPrompt(params.prompt) });
    return Object.assign(quick(), { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) });
  }) as unknown as QueryFn;
  const gates = newGates();
  const engine = new Engine({
    store: store as any, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(bus), config, queryFn,
    boatConfigured: () => false, projects, taintedPaths: new TaintedPaths(join(root, 'tp.json')),
    gates: { gate: () => undefined, switchedOff: () => false, store: gates.store } as any,
  });
  const folder = join(root, 'game');
  mkdirSync(folder, { recursive: true });
  const p0 = projects.create({ name: 'Hirtshals RPG', instructions: 'Read CLAUDE.md first.' });
  projects.setMembers(p0.id, ['a1']);
  const p = projects.setFolder(p0.id, folder);
  return { store, engine, calls, projects, gates, p };
}
const runTo = async (s: ReturnType<typeof setup>, params: Parameters<Engine['startTask']>[0]) => s.engine.waitFor(s.engine.startTask(params).id, 3000);

test('off: an MCP run cannot pick a project and stays capped at ask (the 0.3.10 behaviour)', async () => {
  const s = setup();
  assert.equal(s.engine.mcpActsAsOwner(), false);
  const t = await runTo(s, { agentId: 'a1', prompt: 'go', source: 'mcp', projectId: s.p.id });
  assert.equal(t.projectId, undefined, 'the project is ignored for a client');
  assert.equal(t.origin?.approvalCeiling, 'ask');
  assert.notEqual(s.calls[0]!.options.permissionMode, 'bypassPermissions', 'a full agent started by a client is capped');
  assert.equal(s.calls[0]!.options.additionalDirectories, undefined, 'no project folder');
});

test('on: an MCP run starts inside the project, gets its folder, and keeps the agent\'s own approval mode', async () => {
  const s = setup();
  s.gates.store.patchApp({ mcpActsAsOwner: true });
  assert.equal(s.engine.mcpActsAsOwner(), true);
  const t = await runTo(s, { agentId: 'a1', prompt: 'go', source: 'mcp', projectId: s.p.id });
  assert.equal(t.projectId, s.p.id);
  assert.equal(t.origin?.approvalCeiling, 'full', 'no cap');
  assert.deepEqual(s.calls[0]!.options.additionalDirectories, [s.p.folder]);
  assert.equal(s.calls[0]!.options.permissionMode, 'bypassPermissions', 'a full agent runs as the owner\'s own run does');
});

test('on: an `ask` agent started by a client still asks (the setting removes the client cap, never the agent\'s own mode)', async () => {
  const s = setup();
  s.store.agents.set('a1', mkAgent('a1', { approval: 'ask' }));
  s.gates.store.patchApp({ mcpActsAsOwner: true });
  await runTo(s, { agentId: 'a1', prompt: 'go', source: 'mcp', projectId: s.p.id });
  assert.notEqual(s.calls[0]!.options.permissionMode, 'bypassPermissions');
  assert.equal(typeof s.calls[0]!.options.canUseTool, 'function');
});

test('on: a bad pick is an error, as it is for the app (non-member, unknown, archived)', () => {
  const s = setup();
  s.gates.store.patchApp({ mcpActsAsOwner: true });
  assert.throws(() => s.engine.startTask({ agentId: 'a2', prompt: 'x', source: 'mcp', projectId: s.p.id }), (e: any) => e instanceof EngineError && e.status === 400);
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'mcp', projectId: 'proj_000000000000' }), (e: any) => e instanceof EngineError && e.status === 400);
  s.projects.update(s.p.id, { status: 'archived' });
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'mcp', projectId: s.p.id }), (e: any) => e instanceof EngineError && e.status === 409);
});

test('on: continuing a task a client started while the setting was off stays capped (no laundering through a continue)', async () => {
  const s = setup();
  const t = await runTo(s, { agentId: 'a1', prompt: 'first', source: 'mcp' });
  assert.equal(t.origin?.approvalCeiling, 'ask');
  s.gates.store.patchApp({ mcpActsAsOwner: true });
  const c = await runTo(s, { agentId: 'a1', prompt: 'again', source: 'mcp', continueTaskId: t.id });
  assert.equal(c.origin?.approvalCeiling, 'ask');
  assert.notEqual(s.calls[1]!.options.permissionMode, 'bypassPermissions');
});

test('on, but the app file was changed outside Legion: read as off (fail closed)', async () => {
  const s = setup();
  s.gates.store.patchApp({ mcpActsAsOwner: true });
  const real = s.gates.store.view.bind(s.gates.store);
  (s.gates.store as any).view = (ids: string[]) => ({ ...real(ids), changedOutside: ['app'] });
  assert.equal(s.engine.mcpActsAsOwner(), false);
  const t = await runTo(s, { agentId: 'a1', prompt: 'go', source: 'mcp', projectId: s.p.id });
  assert.equal(t.projectId, undefined);
  assert.equal(t.origin?.approvalCeiling, 'ask');
});

test('a run another agent starts is not loosened by the setting (only a token client is)', async () => {
  const s = setup();
  s.gates.store.patchApp({ mcpActsAsOwner: true });
  s.store.agents.set('a1', mkAgent('a1', { approval: 'ask' }));
  const parent = await runTo(s, { agentId: 'a1', prompt: 'lead', source: 'ui', projectId: s.p.id });
  s.projects.setMembers(s.p.id, ['a1', 'a2']);
  const child = s.engine.startTask({ agentId: 'a2', prompt: 'help', source: 'agent', bridge: { fromAgentId: 'a1', parentTaskId: parent.id, hop: 1 } });
  await s.engine.waitFor(child.id, 3000);
  assert.equal(s.store.getTask(child.id)?.origin?.approvalCeiling, 'ask', 'an ask caller still caps the full agent it calls');
});

// ---- the MCP tools

async function mcpWith(on: boolean) {
  const f = makeFakes();
  const root = cleanupTemp('legion-mcp-owner-tools-');
  const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
  const board = new BoardStore(join(root, 'board'));
  const started: any[] = [];
  const orig = f.ctx.engine.startTask.bind(f.ctx.engine);
  f.ctx.engine.startTask = (p: any) => { started.push(p); return orig(p); };
  (f.ctx.engine as any).mcpActsAsOwner = () => on;
  const ctx: any = { ...f.ctx, projects, board };
  const s = await start(ctx);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: r.content.map((c: any) => c.text).join('\n') };
  };
  return { client, call, projects, board, started, root, close: async () => { await client.close(); await s.close(); } };
}

test('MCP, off: every owner action is refused with the reason, and nothing changes', async () => {
  const m = await mcpWith(false);
  try {
    const p = m.projects.setMembers(m.projects.create({ name: 'P' }).id, ['scout']);
    const run = await m.call('legion_run', { agent: 'scout', prompt: 'x', project: p.id, wait: false });
    assert.equal(run.isError, true); assert.equal(run.text, MCP_OWNER_OFF);
    assert.equal(m.started.length, 0, 'no run was started');
    const edit = await m.call('legion_project_edit', { action: 'create', name: 'New' });
    assert.equal(edit.isError, true); assert.equal(edit.text, MCP_OWNER_OFF);
    assert.equal(m.projects.list().length, 1);
    const bw = await m.call('legion_board_write', { action: 'create', project: p.id, title: 'T' });
    assert.equal(bw.isError, true); assert.match(bw.text, /MCP clients act as you/);
    assert.equal(m.board.view(p).items.length, 0);
    // a run with no project still works, as before
    const plain = await m.call('legion_run', { agent: 'scout', prompt: 'x', wait: false });
    assert.equal(plain.isError, false);
    assert.equal(m.started[0].projectId, undefined);
  } finally { await m.close(); }
});

test('MCP, on: legion_run passes the project (by id or name); project and board edits land', async () => {
  const m = await mcpWith(true);
  try {
    const { tools } = await m.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['legion_projects', 'legion_project_edit', 'legion_board_read', 'legion_board_write']) assert.ok(names.includes(n), n);
    const folder = join(m.root, 'game'); mkdirSync(folder, { recursive: true });
    const created = await m.call('legion_project_edit', { action: 'create', name: 'Hirtshals RPG', instructions: 'Read CLAUDE.md.', folder, members: ['scout', 'zealot'] });
    assert.equal(created.isError, false, created.text);
    const pid = JSON.parse(created.text).id as string;
    const p = m.projects.get(pid)!;
    assert.deepEqual(p.members, ['scout', 'zealot']);
    assert.equal(p.instructions, 'Read CLAUDE.md.');
    assert.ok(p.folder.toLowerCase().endsWith('game'));
    const upd = await m.call('legion_project_edit', { action: 'update', id: 'hirtshals rpg', instructions: 'v2', members: ['scout'] });
    assert.equal(upd.isError, false, upd.text);
    assert.equal(m.projects.get(pid)!.instructions, 'v2');
    assert.deepEqual(m.projects.get(pid)!.members, ['scout']);
    const badAgent = await m.call('legion_project_edit', { action: 'update', id: pid, members: ['nobody'] });
    assert.equal(badAgent.isError, true); assert.match(badAgent.text, /Unknown agent/);
    const run = await m.call('legion_run', { agent: 'scout', prompt: 'x', project: 'Hirtshals RPG', wait: false });
    assert.equal(run.isError, false, run.text);
    assert.equal(m.started.at(-1).projectId, pid);
    const unknown = await m.call('legion_run', { agent: 'scout', prompt: 'x', project: 'nope', wait: false });
    assert.equal(unknown.isError, true); assert.match(unknown.text, /Unknown project/);
    const item = await m.call('legion_board_write', { action: 'create', project: pid, title: 'Write the Pjok Maxi note', assignee: 'scout', priority: 'high' });
    assert.equal(item.isError, false, item.text);
    const iid = JSON.parse(item.text).id as string;
    assert.deepEqual(JSON.parse(item.text).assignee, { kind: 'agent', id: 'scout' });
    const moved = await m.call('legion_board_write', { action: 'move', project: pid, id: iid, status: 'doing' });
    assert.equal(moved.isError, false, moved.text);
    assert.equal(m.board.get(pid, iid)?.status, 'doing');
    const patched = await m.call('legion_board_write', { action: 'update', project: pid, id: iid, description: 'Use the game-docs layout.', due: '2026-12-01' });
    assert.equal(patched.isError, false, patched.text);
    assert.equal(m.board.get(pid, iid)?.description, 'Use the game-docs layout.');
    const notMember = await m.call('legion_board_write', { action: 'create', project: pid, title: 'x', assignee: 'zealot' });
    assert.equal(notMember.isError, true); assert.match(notMember.text, /not a member/);
  } finally { await m.close(); }
});
