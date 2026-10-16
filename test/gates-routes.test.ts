import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isClientRoute } from '../src/core/admin.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';

const J = { 'Content-Type': 'application/json' };

const NATIVE = 'native-secret';
const KEYRING = { get: () => Buffer.alloc(32, 9) };

async function boot(o: { keyed?: boolean; nativeSecret?: string | undefined } = {}) {
  const root = cleanupTemp('legion-gates-routes-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const p = projects.create({ name: 'Shop' });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir: data, projects, ...(o.keyed ? { keyring: KEYRING } : {}) });
  const mod = createGatesModule(deps, { projects, core, ...(o.nativeSecret ? { nativeSecret: o.nativeSecret } : {}) });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const req = (headers: Record<string, string>) => (m: string, path: string, body?: unknown) =>
    fetch(s.base + path, { method: m, headers: { ...headers, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { mod, core, pid: p.id, call: req(AUTH), native: req({ ...AUTH, 'X-Legion-Native': NATIVE }), wrongNative: req({ ...AUTH, 'X-Legion-Native': 'not-the-secret' }), client: req(asClient), anon: req({}), close: async () => { await mod.dispose?.(); await s.close(); } };
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

test('settings round-trip, unknown project is 404, bypass is 400 when the core has no key', async () => {
  const r = await boot({ nativeSecret: NATIVE });
  try {
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    const v = await (await r.call('GET', '/api/gates/settings')).json() as { projects: Record<string, { preset?: string }> };
    assert.equal(v.projects[r.pid]?.preset, 'ask');
    assert.equal((await r.call('PATCH', '/api/gates/projects/proj_00000000beef', { preset: 'ask' })).status, 404);
    const res = await r.native('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /keystore key/);
  } finally { await r.close(); }
});

test('the gates folder is a protected path', async () => {
  const r = await boot();
  try { assert.deepEqual(r.mod.protectedPaths?.(), [r.core.store.folder]); } finally { await r.close(); }
});

test('the resolver: Per agent gives the agent own mode; Ask with its limit caps a full agent; the ceiling wins', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    for (const m of ['ask', 'auto-edits', 'full'] as const) assert.equal(r.core.resolver.mode({ agentMode: m, startProjectId: r.pid }), m);
    assert.equal(r.core.resolver.mode({ agentMode: 'full' }), 'full');
    assert.equal(r.core.resolver.mode({ agentMode: 'full', startProjectId: r.pid, ceiling: 'ask' }), 'ask');
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    assert.equal(r.core.resolver.mode({ agentMode: 'full', startProjectId: r.pid }), 'ask', 'limit defaults to on with a preset');
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { limit: false })).status, 403, 'switching the limit off loosens: native only');
    assert.equal(r.core.resolver.mode({ agentMode: 'full', startProjectId: r.pid }), 'ask');
    assert.equal((await r.native('PATCH', `/api/gates/projects/${r.pid}`, { limit: false })).status, 200);
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

test('a loosening needs the native header: admin alone gets 403 and nothing changes', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    const res = await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /native_confirmation_required/);
    assert.equal((await r.wrongNative('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' })).status, 403);
    assert.equal((await r.call('PATCH', '/api/gates/app', { allowedHosts: ['docs.python.org'] })).status, 403);
    assert.equal((await r.call('PATCH', '/api/gates/app', { envKeep: ['AWS_PROFILE'] })).status, 403);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { limit: false })).status, 403);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { overrides: { 'github-write-card': false } })).status, 403);
    assert.equal(r.core.store.project(r.pid).preset, undefined);
    assert.equal(r.core.store.app().allowedHosts, undefined);
    assert.equal((await r.native('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' })).status, 200);
    assert.equal(r.core.store.project(r.pid).preset, 'bypass');
  } finally { await r.close(); }
});

test('tightening needs only the admin token', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    assert.equal((await r.native('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' })).status, 200);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: null })).status, 200);
    assert.equal((await r.call('PATCH', '/api/gates/app', { preset: 'ask' })).status, 200);
  } finally { await r.close(); }
});

test('with no nativeSecret configured a loosening is 403 native_unavailable, and Ask still works', async () => {
  const r = await boot({ keyed: true });
  try {
    const res = await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'smart' });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /native_unavailable/);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
  } finally { await r.close(); }
});

test('with no keystore key only Ask can be set, even with the native header (fail closed)', async () => {
  const r = await boot({ nativeSecret: NATIVE });
  try {
    const res = await r.native('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /keystore key/);
    assert.equal(r.core.store.project(r.pid).preset, undefined);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    const v = await (await r.call('GET', '/api/gates/settings')).json() as { canSign: boolean };
    assert.equal(v.canSign, false);
  } finally { await r.close(); }
});

test('a patch that names shellFloorOff is 400 no switch, whatever the headers', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    const res = await r.native('PATCH', '/api/gates/app', { shellFloorOff: true });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /no switch/);
  } finally { await r.close(); }
});

test('a file changed outside shows in the settings view; Accept needs the native header, Keep mine only admin', async () => {
  const data = join(cleanupTemp('legion-gates-outside-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const p = projects.create({ name: 'Shop' });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const first = createGatesCore({ dataDir: data, projects, keyring: KEYRING });
  first.store.patchProject(p.id, { preset: 'ask' });
  await first.store.flush();
  const file = join(data, 'gates', `${p.id}.json`);
  const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; j.preset = 'bypass'; writeFileSync(file, JSON.stringify(j));
  const core = createGatesCore({ dataDir: data, projects, keyring: KEYRING });
  const mod = createGatesModule(deps, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const call = (h: Record<string, string>) => (m: string, path: string) => fetch(s.base + path, { method: m, headers: { ...h, ...J }, ...(m === 'GET' ? {} : { body: '{}' }) });
  const admin = call(AUTH); const native = call({ ...AUTH, 'X-Legion-Native': NATIVE });
  try {
    const v = await (await admin('GET', '/api/gates/settings')).json() as { changedOutside: string[]; canSign: boolean; projects: Record<string, { preset?: string }> };
    assert.deepEqual(v.changedOutside, [p.id]);
    assert.equal(v.canSign, true);
    assert.equal(v.projects[p.id]?.preset, 'ask', 'the project reads Ask until the owner chooses');
    assert.equal((await admin('POST', `/api/gates/accept/${p.id}`)).status, 403, 'Accept is a loosening: native only');
    assert.equal(core.store.project(p.id).preset, 'ask');
    assert.equal((await admin('POST', '/api/gates/keep/proj_00000000beef')).status, 404);
    assert.equal((await native('POST', `/api/gates/accept/${p.id}`)).status, 200);
    assert.equal(core.store.project(p.id).preset, 'bypass');
    assert.deepEqual(core.store.changedOutside(), []);
    assert.equal((await admin('POST', `/api/gates/keep/${p.id}`)).status, 404, 'nothing left to keep');
  } finally { await mod.dispose?.(); await s.close(); }
});
