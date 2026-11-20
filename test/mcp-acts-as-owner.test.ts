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

// ---- review round 1 (PR #218): fixes and their proofs

import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { clientFolderRefusal } from '../src/core/mcp-tools.js';
import { runsAsChip } from '../ui/src/gates/presetsLogic.js';

test('a hand-edited app file that sets the flag without a valid signature reads as off', async () => {
  const s = setup();
  s.gates.store.patchApp({ claudeOwnChecks: true });
  await s.gates.store.flush();
  const file = join(s.gates.dir, 'app.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...raw, mcpActsAsOwner: true }));
  const reread = new GatesStore(s.gates.dir, { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 7)), keyState: 'new' });
  const v = reread.view([]);
  assert.ok(v.changedOutside.includes('app') || v.unreadable.includes('app') || reread.app().mcpActsAsOwner !== true, 'not trusted as on');
  const e2 = new Engine({ store: s.store as any, bus: new EventBus(), vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(new EventBus()), config: defaultConfig(), queryFn: (() => quick()) as any, boatConfigured: () => false, gates: { gate: () => undefined, switchedOff: () => false, store: reread } as any });
  assert.equal(e2.mcpActsAsOwner(), false);
});

test('the run chip says "asks" only for a real cap: a ceiling of full (the setting on) adds nothing', () => {
  assert.equal(runsAsChip({ effective: 'ask', agentMode: 'ask', source: 'own', limit: true, ceiling: 'full' } as any).reason, undefined);
  assert.equal(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', limit: true, ceiling: 'ask' } as any).reason, 'Started by an outside app: asks');
});

test('an outside app cannot make a key, settings or system folder a project folder', () => {
  assert.match(clientFolderRefusal(join(homedir(), '.ssh')) ?? '', /cannot make that folder/);
  assert.match(clientFolderRefusal(join(homedir(), '.claude', 'skills')) ?? '', /cannot make/);
  if (process.platform === 'win32') assert.match(clientFolderRefusal(join(process.env.SystemRoot ?? 'C:/Windows', 'System32')) ?? '', /cannot make/);
  assert.equal(clientFolderRefusal(join(homedir(), 'games', 'hirtshals')), undefined);
});

test('MCP, on: a refused folder leaves no half-made project; a shared name is refused; client text is untrusted; Inbox items are unknown', async () => {
  const m = await mcpWith(true);
  try {
    const before = m.projects.list().length;
    const bad = await m.call('legion_project_edit', { action: 'create', name: 'Keys', folder: join(homedir(), '.ssh') });
    assert.equal(bad.isError, true); assert.match(bad.text, /cannot make/);
    assert.equal(m.projects.list().length, before, 'nothing was created');
    const a = m.projects.create({ name: 'Twin' }); const b = m.projects.create({ name: 'twin' });
    m.projects.setMembers(a.id, ['scout']); m.projects.setMembers(b.id, ['scout']);
    for (const r of [
      await m.call('legion_run', { agent: 'scout', prompt: 'x', project: 'Twin', wait: false }),
      await m.call('legion_project_edit', { action: 'update', id: 'TWIN', instructions: 'x' }),
      await m.call('legion_board_write', { action: 'create', project: 'twin', title: 'x' }),
    ]) { assert.equal(r.isError, true); assert.match(r.text, /2 projects are called/); }
    const byId = await m.call('legion_run', { agent: 'scout', prompt: 'x', project: a.id, wait: false });
    assert.equal(byId.isError, false, 'the id still works');
    const p = m.projects.get(a.id)!;
    const made = await m.call('legion_board_write', { action: 'create', project: p.id, title: 'From Claude Code' });
    assert.equal(JSON.parse(made.text).trust, 'untrusted', 'text from an outside app is not text the owner read');
    const owners = m.board.create(p, { title: 'Owner wrote this' });
    assert.equal(owners.trust, 'human');
    const edited = await m.call('legion_board_write', { action: 'update', project: p.id, id: owners.id, description: 'changed by a client' });
    assert.equal(JSON.parse(edited.text).trust, 'untrusted', 'a client text edit drops "reviewed"');
    const moved = await m.call('legion_board_write', { action: 'move', project: p.id, id: JSON.parse(made.text).id, status: 'doing' });
    assert.equal(moved.isError, false);
    const prop = m.board.propose(p, 'scout', { title: 'A proposal' }, { tainted: false });
    const hidden = await m.call('legion_board_write', { action: 'update', project: p.id, id: prop.id, title: 'x' });
    assert.equal(hidden.isError, true); assert.match(hidden.text, /Unknown item/);
  } finally { await m.close(); }
});

// ---- the card, rendered: off (default), on, and no signing key

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MCP_OWNER_LABEL, MCP_OWNER_NO_KEY, MCP_OWNER_OFF_TEXT, MCP_OWNER_ON_TEXT } from '../ui/src/gates/mcpOwnerCopy.js';

test('render: the MCP clients card shows off by default, on when set, and cannot be turned on without the key', async () => {
  const REPO = fileURLToPath(new URL('../../', import.meta.url));
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { McpOwnerCardView } from ${JSON.stringify(join(REPO, 'ui/src/gates/McpOwner.tsx'))};
        export const card = (p) => renderToStaticMarkup(createElement(McpOwnerCardView, { onToggle: () => {}, busy: false, note: null, ...p }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        b.onResolve({ filter: /\/store$/ }, () => ({ path: 'app-store', namespace: 'stub' }));
        b.onLoad({ filter: /^app-store$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: 'export const toast = () => {}; export const useStore = () => []; export const openSettings = () => {};' }));
        b.onResolve({ filter: /useGatesView$/ }, () => ({ path: 'use-gates-view', namespace: 'stub' }));
        b.onLoad({ filter: /^use-gates-view$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `export const useGatesView = () => ({}); export const useGatesAction = () => ({ pending: false, note: null, run: async () => true }); export const reloadGatesFromDisk = async () => {}; export const PENDING_TEXT = 'Waiting';` }));
      },
    }],
  });
  const d = cleanupTemp('mcp-owner-ui-');
  const file = join(d, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const r = createRequire(file)(file) as { card: (p: unknown) => string };
  const view = (app: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({ app: { version: 1, ...app }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o });
  const unesc = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const off = unesc(r.card({ view: view() }));
  assert.ok(off.includes(MCP_OWNER_LABEL));
  assert.ok(off.includes(MCP_OWNER_OFF_TEXT));
  assert.doesNotMatch(off, /checked=""/, 'off by default');
  assert.doesNotMatch(off, /disabled=""/, 'and it can be turned on');
  const on = unesc(r.card({ view: view({ mcpActsAsOwner: true }) }));
  assert.match(on, /checked=""/);
  assert.ok(on.includes(MCP_OWNER_ON_TEXT));
  const noKey = unesc(r.card({ view: view({}, { canSign: false }) }));
  assert.match(noKey, /disabled=""/, 'without the key it cannot be turned on');
  assert.ok(noKey.includes(MCP_OWNER_NO_KEY));
  const onNoKey = unesc(r.card({ view: view({ mcpActsAsOwner: true }, { canSign: false }) }));
  assert.doesNotMatch(onNoKey, /disabled=""/, 'turning it off never needs the key');
  for (const t of [MCP_OWNER_LABEL, MCP_OWNER_ON_TEXT, MCP_OWNER_OFF_TEXT, MCP_OWNER_NO_KEY, MCP_OWNER_ON_LINE, MCP_OWNER_OFF_LINE]) assert.doesNotMatch(t, /—|–|this (computer|machine)/i, 'plain words');
});

// ---- review round 2 (PR #218): the client folder check cannot be led around

import { realpathSync, symlinkSync } from 'node:fs';

test('the client folder check holds for links, network and device paths, and folders that contain a guarded one', () => {
  const root = cleanupTemp('legion-mcp-owner-folders-');
  const home = join(root, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, 'games', 'hirtshals'), { recursive: true });
  const link = join(root, 'innocent');
  symlinkSync(join(home, '.ssh'), link, 'junction');
  const real = realpathSync(link);
  assert.equal(clientFolderRefusal(link, undefined, home), undefined, 'the raw path alone looks harmless');
  assert.match(clientFolderRefusal(link, real, home) ?? '', /inside a folder that holds keys/, 'the real path behind the link is refused');
  assert.match(clientFolderRefusal('\\\\localhost\\C$\\Users\\x\\.ssh', undefined, home) ?? '', /network and device paths/);
  assert.match(clientFolderRefusal('\\\\?\\C:\\Users\\x\\games', undefined, home) ?? '', /network and device paths/);
  assert.match(clientFolderRefusal('//server/share/x', undefined, home) ?? '', /network and device paths/);
  assert.match(clientFolderRefusal(home, undefined, home) ?? '', /contains a folder that holds keys/, 'home itself, whatever LEGION_HOME is');
  assert.match(clientFolderRefusal(root, undefined, home) ?? '', /contains a folder/, 'a folder above home');
  assert.equal(clientFolderRefusal(join(home, 'games', 'hirtshals'), undefined, home), undefined, 'an ordinary folder is fine');
  assert.match(clientFolderRefusal(join(home, '.SSH', 'keys') + '\\', undefined, home) ?? '', /inside/, 'case and a trailing separator');
  assert.doesNotMatch(clientFolderRefusal(join(home, '.ssh'), undefined, home) ?? '', new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'the message does not echo the path');
});

test('MCP, on: a link to a guarded folder is refused through the tool, and nothing is created', async () => {
  const m = await mcpWith(true);
  try {
    const target = join(homedir(), '.claude');
    const link = join(m.root, 'looks-fine');
    try { symlinkSync(target, link, 'junction'); } catch { return; } // no ~/.claude on this machine: the unit test above covers the rule
    const before = m.projects.list().length;
    const r = await m.call('legion_project_edit', { action: 'create', name: 'Linked', folder: link });
    assert.equal(r.isError, true, r.text); assert.match(r.text, /cannot make that folder a project folder/);
    assert.equal(m.projects.list().length, before);
  } finally { await m.close(); }
});
