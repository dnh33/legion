import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isClientRoute } from '../src/core/admin.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';

const J = { 'Content-Type': 'application/json' };

async function boot() {
  const root = cleanupTemp('legion-gates-routes-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const p = projects.create({ name: 'Shop' });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir: data, projects });
  const mod = createGatesModule(deps, { projects, core });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const req = (headers: Record<string, string>) => (m: string, path: string, body?: unknown) =>
    fetch(s.base + path, { method: m, headers: { ...headers, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { mod, core, pid: p.id, call: req(AUTH), client: req(asClient), anon: req({}), close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('every gates route is admin-only', async () => {
  const r = await boot();
  try {
    const routes: Array<[string, string, unknown?]> = [['GET', '/api/gates/settings'], ['PATCH', '/api/gates/app', { preset: 'ask' }], ['PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' }], ['POST', '/api/gates/reload', {}]];
    for (const [m, path, body] of routes) {
      assert.equal(isClientRoute(m, path), false, `${m} ${path}`);
      assert.equal((await r.client(m, path, body)).status, 403, `${m} ${path} with a bearer token`);
      assert.equal((await r.anon(m, path, body)).status, 401, `${m} ${path} with nothing`);
    }
  } finally { await r.close(); }
});

test('settings round-trip, unknown project is 404, bypass is 400 in this part', async () => {
  const r = await boot();
  try {
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    const v = await (await r.call('GET', '/api/gates/settings')).json() as { projects: Record<string, { preset?: string }> };
    assert.equal(v.projects[r.pid]?.preset, 'ask');
    assert.equal((await r.call('PATCH', '/api/gates/projects/proj_00000000beef', { preset: 'ask' })).status, 404);
    const res = await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not available yet/);
  } finally { await r.close(); }
});

test('the gates folder is a protected path', async () => {
  const r = await boot();
  try { assert.deepEqual(r.mod.protectedPaths?.(), [r.core.store.folder]); } finally { await r.close(); }
});

test('the resolver: Per agent gives the agent own mode; Ask with its limit caps a full agent; the ceiling wins', async () => {
  const r = await boot();
  try {
    for (const m of ['ask', 'auto-edits', 'full'] as const) assert.equal(r.core.resolver.mode({ agentMode: m, startProjectId: r.pid }), m);
    assert.equal(r.core.resolver.mode({ agentMode: 'full' }), 'full');
    assert.equal(r.core.resolver.mode({ agentMode: 'full', startProjectId: r.pid, ceiling: 'ask' }), 'ask');
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    assert.equal(r.core.resolver.mode({ agentMode: 'full', startProjectId: r.pid }), 'ask', 'limit defaults to on with a preset');
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { limit: false })).status, 200);
    assert.equal(r.core.resolver.mode({ agentMode: 'full', startProjectId: r.pid }), 'full');
  } finally { await r.close(); }
});

test('a damaged project gates file caps a full own agent to Ask from the first call', () => {
  const data = join(cleanupTemp('legion-gates-damaged-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const p = projects.create({ name: 'Shop' });
  mkdirSync(join(data, 'gates'), { recursive: true });
  writeFileSync(join(data, 'gates', `${p.id}.json`), '{not json');
  const core = createGatesCore({ dataDir: data, projects });
  assert.equal(core.resolver.mode({ agentMode: 'full', startProjectId: p.id }), 'ask');
});

test('an empty project list does not prune the gates files: a failed projects.json load must not delete the caps', async () => {
  const data = join(cleanupTemp('legion-gates-noprune-'), 'data');
  mkdirSync(join(data, 'gates'), { recursive: true });
  const file = join(data, 'gates', 'proj_000000000001.json');
  writeFileSync(file, JSON.stringify({ version: 1, preset: 'ask' }));
  const projects = new ProjectStore(data, join(data, 'ws'));
  assert.deepEqual(projects.list(), []);
  const core = createGatesCore({ dataDir: data, projects });
  await core.store.flush();
  assert.equal(existsSync(file), true, 'the cap file is kept');
  assert.deepEqual(core.store.project('proj_000000000001'), { version: 1, preset: 'ask' });
});

test('a damaged project gates file still caps a full own agent after a restart', async () => {
  const data = join(cleanupTemp('legion-gates-restart-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const p = projects.create({ name: 'Shop' });
  mkdirSync(join(data, 'gates'), { recursive: true });
  writeFileSync(join(data, 'gates', `${p.id}.json`), '{not json');
  const first = createGatesCore({ dataDir: data, projects });
  assert.equal(first.resolver.mode({ agentMode: 'full', startProjectId: p.id }), 'ask');
  await first.store.flush();
  const restarted = createGatesCore({ dataDir: data, projects });
  assert.equal(restarted.resolver.mode({ agentMode: 'full', startProjectId: p.id }), 'ask');
});
