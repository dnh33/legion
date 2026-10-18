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

const DIGEST = 'x-legion-gates-digest';
/** What the app does for a confirmed change: ask the core to preview it, then send the change with the native header and that digest. */
function confirmed(base: string, headers: Record<string, string>) {
  return async (m: string, path: string, body?: unknown, digest?: string) => {
    const target = path.startsWith('/api/gates/accept/') ? { name: path.split('/').pop(), accept: true } : m === 'PATCH' ? { name: path === '/api/gates/app' ? 'app' : path.split('/').pop(), patch: body } : undefined;
    let d = digest;
    if (d === undefined && target) {
      const pv = await fetch(base + '/api/gates/preview', { method: 'POST', headers: { ...AUTH, ...J }, body: JSON.stringify(target) });
      if (pv.status === 200) d = ((await pv.json()) as { digest: string }).digest;
    }
    return fetch(base + path, { method: m, headers: { ...headers, ...J, ...(d ? { [DIGEST]: d } : {}) }, body: body === undefined ? (m === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  };
}

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
  return { mod, core, base: s.base, pid: p.id, call: req(AUTH), native: confirmed(s.base, { ...AUTH, 'X-Legion-Native': NATIVE }), nativeNoDigest: req({ ...AUTH, 'X-Legion-Native': NATIVE }), preview: (body: unknown) => req(AUTH)('POST', '/api/gates/preview', body), wrongNative: req({ ...AUTH, 'X-Legion-Native': 'not-the-secret' }), client: req(asClient), anon: req({}), close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('the preview route is admin-only', async () => {
  const r = await boot();
  try { assert.equal((await r.client('POST', '/api/gates/preview', { name: 'app', patch: { preset: 'ask' } })).status, 403); assert.equal((await r.anon('POST', '/api/gates/preview', {})).status, 401); } finally { await r.close(); }
});

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
    assert.match(await res.text(), /keystore/);
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

test('the keep list refuses a new LEGION_ name or one of Legion\'s own keys, like the editor; names already kept stay removable', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    for (const name of ['LEGION_HOME', 'legion_*', 'ANTHROPIC_API_KEY', 'BOAT_API_KEY']) {
      const res = await r.native('PATCH', '/api/gates/app', { envKeep: [name] });
      assert.equal(res.status, 400, name);
      assert.match(await res.text(), /never passes its own keys/);
    }
    assert.equal((await r.native('PATCH', '/api/gates/app', { envKeep: ['NPM_TOKEN', 'GH_*'] })).status, 200);
    assert.deepEqual(r.core.store.app().envKeep, ['NPM_TOKEN', 'GH_*']);
    assert.equal((await r.call('PATCH', '/api/gates/app', { envKeep: ['GH_*'] })).status, 200, 'removing needs no native header');
    assert.deepEqual(r.core.store.app().envKeep, ['GH_*']);
  } finally { await r.close(); }
});

test('N1: Smart and Accept edits are not ordered: a switch either way, for the app, a project preset and a project cap, needs the native header', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    for (const [path, read, extra] of [['/api/gates/app', () => r.core.store.app(), {}], [`/api/gates/projects/${r.pid}`, () => r.core.store.project(r.pid), { limit: true }]] as const) {
      for (const [from, to] of [['smart', 'accept-edits'], ['accept-edits', 'smart']] as const) {
        assert.equal((await r.native('PATCH', path, { preset: from, ...extra })).status, 200, `${path} set to ${from}`);
        assert.equal((await r.call('PATCH', path, { preset: to })).status, 403, `${path}: ${from} to ${to} with admin only`);
        assert.equal(read().preset, from, 'nothing changed');
        assert.equal((await r.native('PATCH', path, { preset: to })).status, 200, `${path}: ${from} to ${to} with the native header`);
        assert.equal(read().preset, to);
      }
    }
  } finally { await r.close(); }
});

test('tightening needs only the admin token', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    assert.equal((await r.native('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass' })).status, 200);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'ask' })).status, 200);
    assert.equal((await r.call('PATCH', `/api/gates/projects/${r.pid}`, { preset: null })).status, 403, 'removing the cap loosens');
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
    assert.match(await res.text(), /keystore/);
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
  const admin = call(AUTH); const native = confirmed(s.base, { ...AUTH, 'X-Legion-Native': NATIVE });
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

test('a bearer token gets 403 on every gates route, accept and keep included, even with the native header', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    const routes: Array<[string, string, unknown?]> = [['GET', '/api/gates/settings'], ['PATCH', '/api/gates/app', { preset: 'smart' }], ['PATCH', `/api/gates/projects/${r.pid}`, { preset: 'smart' }], ['POST', '/api/gates/reload', {}], ['POST', `/api/gates/accept/${r.pid}`, {}], ['POST', `/api/gates/keep/${r.pid}`, {}]];
    for (const [m, path, body] of routes) {
      assert.equal(isClientRoute(m, path), false, `${m} ${path}`);
      const res = await fetch(r.base + path, { method: m, headers: { ...asClient, ...J, 'X-Legion-Native': NATIVE }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(res.status, 403, `${m} ${path}`);
    }
    assert.equal(r.core.store.app().preset, undefined);
  } finally { await r.close(); }
});

test('a signed loosening reaches the file: the native PATCH is stored with a signature', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    assert.equal((await r.native('PATCH', '/api/gates/app', { preset: 'smart' })).status, 200);
    await r.core.store.flush();
    assert.match(readFileSync(join(r.core.store.folder, 'app.json'), 'utf8'), /"sig": "[0-9a-f]{64}"/);
    assert.equal(((await (await r.call('GET', '/api/gates/settings')).json()) as { app: { preset?: string } }).app.preset, 'smart');
  } finally { await r.close(); }
});

// ---- the preview and the digest: one source of truth for what a change loosens ----
interface Pv { lines: string[]; loosening: string[]; loosens: boolean; digest: string }
const pv = async (r: Awaited<ReturnType<typeof boot>>, name: string, patch: unknown): Promise<Pv> => {
  const res = await r.preview({ name, patch });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as Pv;
};

test('the preview words each kind of loosening from the core itself, and says nothing for a tightening', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    const P = r.pid;
    assert.match((await pv(r, P, { preset: 'accept-edits' })).loosening.join('\n'), /File edits run without asking/);
    assert.match((await pv(r, P, { preset: 'smart' })).loosening.join('\n'), /Legion decides when to ask/);
    const bypass = await pv(r, P, { preset: 'bypass' });
    assert.match(bypass.loosening.join('\n'), /No permission cards/);
    assert.ok(bypass.loosening.some((l) => /deny rules/.test(l)) && bypass.loosening.some((l) => /no sandbox/i.test(l)));
    assert.match((await pv(r, P, { limit: false })).loosening.join('\n'), /go beyond this project's setting/);
    const off = await pv(r, P, { overrides: { 'github-write-card': false } });
    assert.equal(off.loosens, true);
    assert.match(off.loosening[0]!, /Ask before every GitHub write: off\. Agents write to GitHub without asking/);
    assert.ok(!off.loosening.some((l) => /no sandbox/i.test(l)), 'a GitHub gate alone does not need the sandbox line');
    assert.ok((await pv(r, P, { overrides: { 'tool-cards': false } })).loosening.some((l) => /no sandbox/i.test(l)));
    assert.match((await pv(r, 'app', { allowedHosts: ['docs.python.org'] })).loosening[0]!, /Agents may read docs\.python\.org without asking/);
    assert.match((await pv(r, 'app', { envKeep: ['AWS_PROFILE'] })).loosening[0]!, /Commands keep the variable AWS_PROFILE, which can hold a secret/);
    const same = await pv(r, P, { preset: 'ask' });
    assert.deepEqual([same.loosens, same.loosening], [false, []]);
    assert.equal((await r.native('PATCH', `/api/gates/projects/${P}`, { preset: 'ask' })).status, 200);
    assert.match((await pv(r, P, { preset: null })).loosening.join('\n'), /Each agent's own mode applies, Bypass included/);
    // a limit raise and a limited gate going unlimited
    assert.equal((await r.native('PATCH', `/api/gates/projects/${P}`, { preset: 'ask', overrides: { 'attempt-caps': { on: true, limit: 2 }, 'goal-caps': { on: true, limit: 3 } } })).status, 200);
    const raise = await pv(r, P, { overrides: { 'attempt-caps': { on: true, limit: 100 }, 'goal-caps': true } });
    assert.ok(raise.loosening.some((l) => /Limit retries on one item: the limit goes from 2 to 100/.test(l)), raise.loosening.join('|'));
    assert.ok(raise.loosening.some((l) => /Limit the size of a goal: the limit is removed/.test(l)));
    const lower = await pv(r, P, { overrides: { 'attempt-caps': { on: true, limit: 1 }, 'goal-caps': { on: true, limit: 3 } } });
    assert.equal(lower.loosens, false);
  } finally { await r.close(); }
});

test('C1: a patch that drops an owner override names it, even when another change in the same patch is worded', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    assert.equal((await r.native('PATCH', `/api/gates/projects/${r.pid}`, { preset: 'bypass', overrides: { 'tool-cards': true } })).status, 200);
    const p = await pv(r, r.pid, { overrides: { 'stall-ladder': false } });
    assert.equal(p.loosens, true);
    assert.ok(p.loosening.some((l) => /Stop runs that stall: off/.test(l)));
    assert.ok(p.loosening.some((l) => /Ask before tools run: off\. Agents run commands and change files without asking/.test(l)), 'the dropped tool-cards override is named: ' + p.loosening.join('|'));
    assert.ok(p.loosening.some((l) => /no sandbox/i.test(l)));
    const drop = await pv(r, r.pid, { overrides: {} });
    assert.ok(drop.loosening.some((l) => /Ask before tools run: off/.test(l)));
  } finally { await r.close(); }
});

test('the core refuses a native change whose digest is missing or differs from what the owner confirmed (409)', async () => {
  const r = await boot({ keyed: true, nativeSecret: NATIVE });
  try {
    const path = `/api/gates/projects/${r.pid}`;
    const shown = await pv(r, r.pid, { preset: 'smart' });
    assert.equal((await r.nativeNoDigest('PATCH', path, { preset: 'smart' })).status, 409, 'no digest');
    const other = await r.native('PATCH', path, { preset: 'bypass' }, shown.digest);
    assert.equal(other.status, 409); assert.match(await other.text(), /differs from what you confirmed/);
    assert.equal(r.core.store.project(r.pid).preset, undefined, 'nothing changed');
    assert.equal((await r.native('PATCH', path, { limit: false })).status, 200);
    assert.equal((await r.native('PATCH', path, { preset: 'smart' }, shown.digest)).status, 409, 'smart on top of a limit that is now off is not the result that was shown');
    assert.equal((await r.native('PATCH', path, { preset: 'smart' })).status, 200);
    assert.equal((await r.call('PATCH', path, { preset: 'ask' })).status, 200, 'a tightening needs neither');
  } finally { await r.close(); }
});

test('Accept: the preview lists what the file sets and the digest binds that content, so a swapped file is refused', async () => {
  const data = join(cleanupTemp('legion-gates-swap-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const p = projects.create({ name: 'Shop' });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const first = createGatesCore({ dataDir: data, projects, keyring: KEYRING });
  first.store.patchProject(p.id, { preset: 'ask' });
  await first.store.flush();
  const file = join(data, 'gates', `${p.id}.json`);
  const edit = (patch: Record<string, unknown>) => { const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; writeFileSync(file, JSON.stringify({ ...j, ...patch })); };
  edit({ preset: 'smart' });
  const core = createGatesCore({ dataDir: data, projects, keyring: KEYRING });
  const mod = createGatesModule(deps, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const native = confirmed(s.base, { ...AUTH, 'X-Legion-Native': NATIVE });
  try {
    const shown = await (await fetch(s.base + '/api/gates/preview', { method: 'POST', headers: { ...AUTH, ...J }, body: JSON.stringify({ name: p.id, accept: true }) })).json() as Pv;
    assert.equal(shown.loosens, true); assert.match(shown.loosening.join('\n'), /Legion decides when to ask/);
    edit({ preset: 'bypass' });
    assert.equal((await fetch(s.base + '/api/gates/reload', { method: 'POST', headers: { ...AUTH, ...J }, body: '{}' })).status, 200);
    const res = await native('POST', `/api/gates/accept/${p.id}`, undefined, shown.digest);
    assert.equal(res.status, 409); assert.match(await res.text(), /differs from what you confirmed/);
    assert.equal(core.store.project(p.id).preset, 'ask');
    assert.equal((await native('POST', `/api/gates/accept/${p.id}`)).status, 200, 'with the digest of the file now on disk it applies');
    assert.equal(core.store.project(p.id).preset, 'bypass');
  } finally { await mod.dispose?.(); await s.close(); }
});
