/** Projects over HTTP and MCP: the admin gate, the native secret, read-only MCP, admin-only events (controls C1, C2, C3, C14, C15). */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isClientRoute } from '../src/core/admin.js';
import { createProjectsModule, ProjectStore } from '../src/core/projects/index.js';
import { AUTH, asClient, makeFakes, start, TOKEN } from './helpers-c.js';

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const root = cleanupTemp('legion-proj-http-');
const data = join(root, 'data');
const projects = new ProjectStore(data, join(data, 'ws'));
const f = makeFakes();
(f.ctx as any).projects = projects;
(f.ctx as any).modules = [createProjectsModule({ config: f.ctx.config, store: f.ctx.store as any, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects, nativeSecret: NATIVE })];
let base = ''; let close: () => Promise<void>; let client: Client;
before(async () => {
  const s = await start(f.ctx); base = s.base; close = s.close;
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});
after(async () => { await client.close(); await close(); });

const J = { 'Content-Type': 'application/json' };
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { ...AUTH, ...J }) =>
  fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const NATIVE_H = { ...AUTH, ...J, 'X-Legion-Native': NATIVE };

test('C1 every project route is admin-only: not on the client list, the token alone gets 403, no token 401', async () => {
  const id = 'proj_0123456789ab';
  for (const [m, p] of [['GET', '/api/projects'], ['GET', `/api/projects/${id}`], ['POST', '/api/projects'], ['PATCH', `/api/projects/${id}`], ['PUT', `/api/projects/${id}/members`], ['PUT', `/api/projects/${id}/folder`], ['PATCH', '/api/rooms/room_x'], ['POST', '/api/rooms']] as const) {
    assert.equal(isClientRoute(m, p), false, `${m} ${p}`);
    assert.equal((await fetch(base + p, { method: m, headers: { ...asClient, ...J }, body: m === 'GET' ? undefined : '{}' })).status, 403, `${m} ${p} token only`);
    assert.equal((await fetch(base + p, { method: m, body: m === 'GET' ? undefined : '{}' })).status, 401, `${m} ${p} nothing`);
  }
  // rooms and tasks: the project field is the owner's
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers: { ...asClient, ...J }, body: JSON.stringify({ agentId: 'zealot', prompt: 'x', projectId: id }) })).status, 403, 'a token client cannot start a task inside a project');
  const ok = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...asClient, ...J }, body: JSON.stringify({ agentId: 'zealot', prompt: 'x' }) });
  assert.equal(ok.status, 201, 'the same call without projectId still works');
  const msg: any = await (await fetch(base + '/api/tasks', { method: 'POST', headers: { ...asClient, ...J }, body: JSON.stringify({ agentId: 'zealot', prompt: 'x', projectId: id }) })).json();
  assert.match(msg.error, /admin_required/);
});

test('create, read, edit, archive as the owner; a body with folder or members is refused (C3)', async () => {
  const c = await call('POST', '/api/projects', { name: 'Site', instructions: 'Be brief.' });
  assert.equal(c.status, 201);
  const p: any = await c.json();
  assert.equal(p.status, 'active'); assert.deepEqual(p.members, []);
  assert.equal((await call('POST', '/api/projects', { name: 'X', folder: join(root, 'x') }, NATIVE_H)).status, 400, 'folder smuggled into create, even with the native secret');
  assert.equal((await call('POST', '/api/projects', { name: 'X', members: ['zealot'] }, NATIVE_H)).status, 400, 'members smuggled into create');
  assert.equal((await call('PATCH', `/api/projects/${p.id}`, { folder: join(root, 'x') }, NATIVE_H)).status, 400);
  assert.equal((await call('PATCH', `/api/projects/${p.id}`, { members: ['zealot'] }, NATIVE_H)).status, 400);
  const e: any = await (await call('PATCH', `/api/projects/${p.id}`, { name: 'Site 2', status: 'archived' })).json();
  assert.equal(e.name, 'Site 2'); assert.equal(e.status, 'archived');
  assert.equal((await call('GET', '/api/projects')).status, 200);
  assert.equal((await call('GET', '/api/projects/proj_000000000000')).status, 404);
  assert.equal((await call('POST', '/api/projects', { name: '' })).status, 400);
});

test('C2 members and folder need the native secret as well as admin; wrong or missing = 403; unknown agents 400', async () => {
  const p: any = await (await call('POST', '/api/projects', { name: 'Native' })).json();
  const members = { members: ['zealot', 'scout'] };
  assert.equal((await call('PUT', `/api/projects/${p.id}/members`, members)).status, 403);
  assert.equal((await call('PUT', `/api/projects/${p.id}/members`, members, { ...AUTH, ...J, 'X-Legion-Native': 'wrong' })).status, 403);
  assert.equal((await call('PUT', `/api/projects/${p.id}/members`, { members: ['ghost'] }, NATIVE_H)).status, 400);
  assert.equal(projects.get(p.id)!.members.length, 0, 'nothing changed so far');
  const ok: any = await (await call('PUT', `/api/projects/${p.id}/members`, members, NATIVE_H)).json();
  assert.deepEqual(ok.members, ['zealot', 'scout']);
  const folder = join(root, 'picked');
  assert.equal((await call('PUT', `/api/projects/${p.id}/folder`, { folder })).status, 403);
  assert.equal((await call('PUT', `/api/projects/${p.id}/folder`, { folder }, { ...AUTH, ...J, 'X-Legion-Native': 'wrong' })).status, 403);
  assert.equal(projects.get(p.id)!.folder.includes('picked'), false);
  const set: any = await (await call('PUT', `/api/projects/${p.id}/folder`, { folder }, NATIVE_H)).json();
  assert.ok(set.folder.endsWith('picked'));
  assert.equal((await call('PUT', `/api/projects/${p.id}/folder`, { folder: join(data, 'kg') }, NATIVE_H)).status, 400, 'the data folder is refused even with the native secret');
  assert.equal((await call('PUT', `/api/projects/${p.id}/folder`, { folder: 7 }, NATIVE_H)).status, 400);
  const reset: any = await (await call('PUT', `/api/projects/${p.id}/folder`, { folder: null }, NATIVE_H)).json();
  assert.ok(reset.folder.includes(join('ws', 'projects')));
  // a core that was not started by the app has no native secret: locked
  const headless = createProjectsModule({ config: f.ctx.config, store: f.ctx.store as any, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects });
  const routes: Record<string, (c: any) => unknown> = {};
  headless.routes!((m, pat, fn) => { routes[`${m} ${pat}`] = fn; });
  assert.throws(() => routes['PUT /api/projects/:id/members']!({ req: { headers: { 'x-legion-native': NATIVE } }, params: [p.id], body: members }), /native_unavailable/);
  assert.throws(() => routes['PUT /api/projects/:id/folder']!({ req: { headers: { 'x-legion-native': NATIVE } }, params: [p.id], body: { folder: null } }), /native_unavailable/);
});

test('C14 MCP: legion_projects lists and gets, and the server has no project write tool', async () => {
  const p: any = await (await call('POST', '/api/projects', { name: 'Readable', instructions: 'Instructions for readers.' })).json();
  await call('PUT', `/api/projects/${p.id}/members`, { members: ['scout'] }, NATIVE_H);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['legion_cancel', 'legion_continue', 'legion_create_agent', 'legion_list_agents', 'legion_models', 'legion_projects', 'legion_recent_tasks', 'legion_run', 'legion_status', 'legion_vm'], 'one new tool, read only');
  assert.ok(!names.some((n) => /project/.test(n) && n !== 'legion_projects'));
  const t = tools.find((x) => x.name === 'legion_projects')!;
  assert.equal(t.annotations?.readOnlyHint, true);
  assert.deepEqual(Object.keys((t.inputSchema as any).properties).sort(), ['action', 'id']);
  assert.deepEqual((t.inputSchema as any).properties.action.enum, ['list', 'get']);
  const list: any = await client.callTool({ name: 'legion_projects', arguments: { action: 'list' } });
  const rows = JSON.parse(list.content[0].text);
  assert.ok(rows.some((r: any) => r.id === p.id && r.name === 'Readable' && r.members[0] === 'scout'));
  assert.ok(!('instructions' in rows[0]) && !('folder' in rows[0]));
  const got: any = await client.callTool({ name: 'legion_projects', arguments: { action: 'get', id: p.id } });
  assert.equal(JSON.parse(got.content[0].text).instructions, 'Instructions for readers.');
  const bad: any = await client.callTool({ name: 'legion_projects', arguments: { action: 'get', id: 'proj_000000000000' } });
  assert.equal(bad.isError, true);
  const create: any = await client.callTool({ name: 'legion_projects', arguments: { action: 'create', name: 'Evil' } }).catch((e) => ({ isError: true, error: String(e) }));
  assert.ok(create.isError || create.error, 'there is no create action');
  assert.equal(projects.list().some((x) => x.name === 'Evil'), false);
});

test('C15 project events reach the admin stream only', async () => {
  const read = async (headers: Record<string, string>): Promise<string> => {
    const ac = new AbortController();
    const r = await fetch(base + '/api/events', { headers, signal: ac.signal });
    const rd = r.body!.getReader();
    let got = '';
    const pump = (async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; got += new TextDecoder().decode(value); } } catch { /* aborted */ } })();
    await new Promise((res) => setTimeout(res, 100));
    const p: any = await (await call('POST', '/api/projects', { name: 'Evented' })).json();
    f.ctx.bus.emit({ type: 'task.updated', task: { id: 'tt', agentId: 'zealot', title: 't', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: '', updatedAt: '' } as any });
    await new Promise((res) => setTimeout(res, 200));
    ac.abort(); await pump.catch(() => undefined);
    assert.ok(p.id);
    return got;
  };
  const admin = await read({ ...AUTH });
  assert.match(admin, /"type":"project.updated"/);
  const token = await read({ ...asClient });
  assert.ok(!token.includes('project.updated'), 'a token-only stream gets no project event');
  assert.match(token, /task.updated/, 'but still gets task events');
});
