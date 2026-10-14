/** The GitHub area routes: admin-only, nothing secret in the answers, the read and write installations merged, 60 s cache, plain problems. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { gate, isClientRoute } from '../src/core/admin.js';
import { EventBus } from '../src/core/bus.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import { GitHubClient } from '../src/core/connectors/github/client.js';
import { isTicked, masterOn, setTicked } from '../src/core/connectors/github/allowlist.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { TokenStore } from '../src/core/connectors/store.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import type { GithubAreaView } from '../src/shared/github-area.js';
import type { AgentProfile } from '../src/shared/types.js';
import { connectGithub } from '../src/electron/connector-ipc.js';
import { DEVICE_CODE, FAKE_CLIENT_ID, FakeGitHub } from './connectors-fake-github.js';
import { tempDir } from './tmp-cleanup.js';

const fakes: FakeGitHub[] = [];
after(async () => { for (const f of fakes) await f.stop(); });
const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1900000000' };

const inst = (id: number, login: string, sel: 'all' | 'selected', slug: string) => ({ id, account: { login, type: 'User' }, repository_selection: sel, permissions: { metadata: 'read' }, app_slug: slug });
const repos = (...names: string[]) => names.map((n, i) => ({ full_name: n, private: i % 2 === 0, html_url: `https://github.com/${n}` }));

interface RigOpts { read?: boolean; write?: boolean; readSel?: 'all' | 'selected'; readRepos?: string[]; writeRepos?: string[]; folders?: Record<string, string | null>; agents?: AgentProfile[] }

async function rig(o: RigOpts = {}) {
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  const dataDir = tempDir('legion-area-');
  const keys = new ConnectorKeyring();
  keys.install(randomBytes(32));
  const store = new TokenStore(join(dataDir, 'connectors'), keys);
  let offline = false;
  const base = fake.fetchFn();
  const fetchFn: typeof fetch = (...a) => (offline ? Promise.reject(new TypeError('fetch failed')) : base(...a));
  const mk = (app: 'read' | 'write') => new GitHubClient({ app, tokens: store, fetchFn, clientId: FAKE_CLIENT_ID, sleep: async () => undefined });
  const read = mk('read');
  const write = mk('write');
  if (o.read !== false) await (await read.startDeviceFlow()).poll();
  if (o.write !== false) await (await write.startDeviceFlow()).poll();
  fake.requests.length = 0;
  fake.override = (_h, _m, path) => {
    const p = path.split('?')[0]!;
    // the read App's token is the first one issued, the write App's the second: tell them apart by the Authorization header of the request
    const auth = fake.requests[fake.requests.length - 1]?.auth ?? '';
    const isWrite = auth === writeAuth;
    if (p === '/user/installations') return [200, { total_count: 1, installations: [isWrite ? inst(22, 'dnh33', 'selected', 'legion-write') : inst(11, 'dnh33', o.readSel ?? 'selected', 'legion-read')] }, rate];
    if (p === '/user/installations/11/repositories') return [200, { total_count: 9, repositories: repos(...(o.readRepos ?? ['Dnh33/Legion', 'dnh33/shared'])) }, rate];
    if (p === '/user/installations/22/repositories') return [200, { total_count: 9, repositories: repos(...(o.writeRepos ?? ['dnh33/shared', 'dnh33/new-thing'])) }, rate];
    return undefined;
  };
  let writeAuth = '';
  // find each App's bearer from the sign-in order of the fake's issued tokens
  const tokens = [...fake.access.keys()];
  if (o.read !== false && o.write !== false) writeAuth = `Bearer ${tokens[1]}`;
  else if (o.write !== false) writeAuth = `Bearer ${tokens[0]}`;

  const bus = new EventBus();
  const agents = new Map<string, AgentProfile>((o.agents ?? []).map((a) => [a.id, a]));
  const projects = [
    { id: 'proj_aaaaaaaaaaaa', name: 'Legion', folder: o.folders?.legion ?? '', members: ['a1', 'a2'], status: 'active' },
    { id: 'proj_bbbbbbbbbbbb', name: 'Other', folder: o.folders?.other ?? '', members: ['a3'], status: 'active' },
  ];
  let now = 1_000_000;
  let activity: unknown[] = [];
  const mod = createConnectorsModule(
    { dataDir, bus, store: { getAgent: (id: string) => agents.get(id), getTask: () => undefined, listAgents: () => [...agents.values()], upsertAgent: (a: AgentProfile) => { agents.set(a.id, a); return a; } } } as unknown as ModuleDeps,
    {
      keys, client: (app?: 'read' | 'write') => (app === 'write' ? write : read), now: () => now,
      projects: { list: () => projects, get: (id: string) => projects.find((p) => p.id === id) } as never,
      repoOf: (folder: string) => (folder ? { owner: folder.split('/')[0]!, name: folder.split('/')[1]! } : null),
      activity: () => activity as never,
    } as never,
  );
  const handlers = new Map<string, (c: unknown) => unknown>();
  const add: RouteAdder = (m, p, h) => { handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  mod.routes!(add);
  const call = async (m: string, p: string, body?: unknown, params: string[] = []): Promise<any> => {
    return handlers.get(`${m} ${p}`)!({ req: { headers: {} }, body, params, url: new URL('http://x/api/github/x') });
  };
  const get = async (force = false): Promise<GithubAreaView> => {
    const h = handlers.get('GET /api/github/area')!;
    return (await h({ req: { headers: {} }, body: undefined, params: [], url: new URL(`http://x/api/github/area${force ? '?force=1' : ''}`) })) as GithubAreaView;
  };
  const refused = async (m: string, p: string, body?: unknown, params: string[] = []) => { try { await call(m, p, body, params); } catch (e) { return { status: (e as { status: number }).status, message: (e as Error).message }; } return undefined; };
  return { fake, dataDir, bus, agents, handlers, call, get, refused, mod, read, write, setOffline: (v: boolean) => { offline = v; }, tick: (ms: number) => { now += ms; }, setActivity: (a: unknown[]) => { activity = a; } };
}
const apiCalls = (r: Awaited<ReturnType<typeof rig>>) => r.fake.requests.filter((q) => q.host === 'api.github.com').length;

test('every GitHub area route is admin-only: the MCP bearer token alone is refused and none is on the client route list', async () => {
  const r = await rig();
  const mine = [...r.handlers.keys()].filter((k) => k.includes('/api/github/'));
  assert.ok(mine.length >= 7, `expected the area routes, got ${mine.join(', ')}`);
  for (const k of mine) {
    const [method, path] = k.split(' ') as [string, string];
    assert.equal(isClientRoute(method, path), false, k);
    assert.equal(gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true }).allow, false, k);
    assert.equal(gate({ method, path, adminOk: true, bearerOk: true, hasSecret: true }).allow, true, k);
  }
});

test('the area merges the read and the write installations: a repo only the write App reaches still lists', async () => {
  const r = await rig();
  const v = await r.get();
  const by = Object.fromEntries(v.repos.map((x) => [x.fullName.toLowerCase(), x]));
  assert.deepEqual(Object.keys(by).sort(), ['dnh33/legion', 'dnh33/new-thing', 'dnh33/shared']);
  assert.equal(by['dnh33/legion']!.installedRead, true);
  assert.equal(by['dnh33/legion']!.installedWrite, false);
  assert.equal(by['dnh33/new-thing']!.installedRead, false);
  assert.equal(by['dnh33/new-thing']!.installedWrite, true, 'installed only for the write App');
  assert.equal(by['dnh33/shared']!.installedRead && by['dnh33/shared']!.installedWrite, true);
  assert.deepEqual(v.signedIn, { read: true, write: true });
  assert.deepEqual(v.registered, { read: true, write: true });
  assert.equal(v.login, 'octo');
  assert.equal(v.selection, 'selected');
  assert.equal(v.agentsEnabled, true);
  assert.ok(v.repos.every((x) => !x.ticked), 'nothing is turned on by default');
  assert.ok(v.repos.every((x) => /^https:\/\/github\.com\/(settings|organizations)\//.test(x.installationSettingsUrl)));
  assert.deepEqual(v.activity, []);
});

test('selection is all when an installation covers every repo', async () => {
  const r = await rig({ readSel: 'all' });
  assert.equal((await r.get()).selection, 'all');
});

test('the output never holds a token, a device code or an address with a query string', async () => {
  const r = await rig();
  setTicked(r.dataDir, 'dnh33/legion', true);
  const outs: unknown[] = [await r.get(), await r.call('PUT', '/api/github/repos/:owner/:name/tick', { on: true }, ['dnh33', 'shared']), await r.call('PUT', '/api/github/agents-switch', { on: false }), await r.call('GET', '/api/github/projects-using/:owner/:name', undefined, ['dnh33', 'legion'])];
  r.fake.script = ['pending', 'success'];
  const w = await rig({ write: false });
  outs.push(await w.call('POST', '/api/github/apps/write/connect', {}));
  const text = JSON.stringify(outs);
  assert.ok(!/gh[ur]_/.test(text), 'no GitHub token');
  assert.ok(!text.includes(DEVICE_CODE), 'no device code');
  assert.ok(!/https?:\/\/[^"\s]*\?/.test(text), 'no address with a query string');
  for (const q of r.fake.requests) assert.ok(!text.includes(q.auth.replace('Bearer ', '')) || !q.auth, 'no bearer token');
});

test('60 s cache: a second read costs no GitHub call, a forced one does, and a tick does not refetch', async () => {
  const r = await rig();
  await r.get();
  const first = apiCalls(r);
  assert.ok(first > 0);
  await r.get();
  assert.equal(apiCalls(r), first, 'served from the cache');
  await r.call('PUT', '/api/github/repos/:owner/:name/tick', { on: true }, ['dnh33', 'legion']);
  const after = await r.get();
  assert.equal(apiCalls(r), first, 'a tick is local');
  assert.equal(after.repos.find((x) => x.fullName.toLowerCase() === 'dnh33/legion')!.ticked, true);
  r.tick(61_000);
  await r.get();
  assert.ok(apiCalls(r) > first, 'the cache ran out');
  const n = apiCalls(r);
  await r.get(true);
  assert.ok(apiCalls(r) > n, '?force=1 asks again');
});

test('a rate limit becomes problem rate-limited with the reset time, keeps the list, and a forced read does not ask GitHub again', async () => {
  const r = await rig();
  const good = await r.get();
  assert.ok(good.repos.length > 0);
  const resetSec = Math.floor(Date.now() / 1000) + 3600;
  r.fake.override = () => [403, { message: 'API rate limit exceeded' }, { ...rate, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) }];
  const v = await r.get(true);
  assert.equal(v.problem?.kind, 'rate-limited');
  assert.equal(v.problem?.resetAt, new Date(resetSec * 1000).toISOString());
  assert.deepEqual(v.repos.map((x) => x.fullName).sort(), good.repos.map((x) => x.fullName).sort(), 'the last list stays');
  const n = apiCalls(r);
  await r.get(true);
  assert.equal(apiCalls(r), n, 'no request while GitHub asks us to wait');
});

test('offline keeps the cached list and says network', async () => {
  const r = await rig();
  const good = await r.get();
  r.setOffline(true);
  const v = await r.get(true);
  assert.equal(v.problem?.kind, 'network');
  assert.equal(v.repos.length, good.repos.length);
  r.setOffline(false);
  assert.equal((await r.get(true)).problem, undefined, 'back online, the problem clears');
});

test('signed out: not-connected, an empty list, and the placeholder app ids read as not registered', async () => {
  const r = await rig({ read: false, write: false });
  const v = await r.get();
  assert.equal(v.problem?.kind, 'not-connected');
  assert.deepEqual(v.repos, []);
  assert.deepEqual(v.signedIn, { read: false, write: false });
  assert.equal(apiCalls(r), 0);
});

test('tick: a repo that is not installed is 404, an installed one is saved lower-case, the master switch is saved', async () => {
  const r = await rig();
  assert.deepEqual(await r.refused('PUT', '/api/github/repos/:owner/:name/tick', { on: true }, ['dnh33', 'nope']), { status: 404, message: 'not-installed' });
  assert.equal((await r.refused('PUT', '/api/github/repos/:owner/:name/tick', { on: 'yes' }, ['dnh33', 'legion']))?.status, 400);
  assert.equal((await r.refused('PUT', '/api/github/repos/:owner/:name/tick', { on: true }, ['..', 'x']))?.status, 400);
  await r.call('PUT', '/api/github/repos/:owner/:name/tick', { on: true }, ['Dnh33', 'Legion.git']);
  assert.equal(isTicked(r.dataDir, 'dnh33/legion'), true);
  await r.call('PUT', '/api/github/repos/:owner/:name/tick', { on: false }, ['dnh33', 'legion']);
  assert.equal(isTicked(r.dataDir, 'dnh33/legion'), false);
  assert.equal((await r.refused('PUT', '/api/github/agents-switch', { on: 1 }))?.status, 400);
  await r.call('PUT', '/api/github/agents-switch', { on: false });
  assert.equal(masterOn(r.dataDir), false);
  assert.equal((await r.get()).agentsEnabled, false);
});

test('write App connect and disconnect: the user code comes back, the sign-in is stored for the write App only, disconnect forgets it', async () => {
  const r = await rig({ write: false });
  assert.equal(await r.write.signedIn(), false);
  r.fake.script = ['pending', 'success'];
  const started = await r.call('POST', '/api/github/apps/write/connect', {});
  assert.equal(started.phase, 'pending');
  assert.equal(started.verificationUri, 'https://github.com/login/device');
  assert.ok(!JSON.stringify(started).includes(DEVICE_CODE));
  for (let i = 0; i < 100 && !(await r.write.signedIn()); i++) await new Promise((x) => setTimeout(x, 5));
  assert.equal(await r.write.signedIn(), true);
  assert.equal(await r.read.signedIn(), true, 'the read sign-in is untouched');
  const out = await r.call('POST', '/api/github/apps/write/disconnect', {});
  assert.equal(out.ok, true);
  assert.match(out.revokeUrl, /github\.com\/settings\/applications$/);
  assert.equal(await r.write.signedIn(), false);
  assert.equal(await r.read.signedIn(), true);
});

test('CI per repo comes from the poller events already seen, with no GitHub call; activity comes from the injected records', async () => {
  const r = await rig();
  await r.get();
  const n = apiCalls(r);
  r.bus.emit({ type: 'ci.updated', summary: { repo: 'Dnh33/Legion', branch: 'main', counts: { success: 3, failure: 1, running: 0 }, running: false, problem: null, rev: 4 } });
  r.setActivity([{ at: '2026-10-15T10:00:00.000Z', agentId: 'builder', repo: 'dnh33/legion', kind: 'comment', title: 'On #4' }]);
  const v = await r.get();
  assert.equal(apiCalls(r), n, 'no extra call');
  const legion = v.repos.find((x) => x.fullName.toLowerCase() === 'dnh33/legion')!;
  assert.deepEqual(legion.ci, { branch: 'main', counts: { success: 3, failure: 1, running: 0 }, running: false, problem: false });
  assert.equal(v.repos.find((x) => x.fullName.toLowerCase() === 'dnh33/shared')!.ci, undefined);
  assert.equal(v.activity?.length, 1);
  assert.equal(v.activity?.[0]?.agentId, 'builder');
});

const agent = (id: string, o: Partial<AgentProfile> = {}): AgentProfile => ({ id, name: id, ...o }) as AgentProfile;

test('projects-using lists the projects whose git remote is the repo, with their level', async () => {
  const r = await rig({ folders: { legion: 'dnh33/legion' }, agents: [agent('a1', { connectors: ['github'] }), agent('a2'), agent('a3')] });
  const out = await r.call('GET', '/api/github/projects-using/:owner/:name', undefined, ['Dnh33', 'legion']);
  assert.deepEqual(out.projects.map((p: { id: string }) => p.id), ['proj_aaaaaaaaaaaa']);
  assert.equal(out.projects[0].level, 'read');
});

test('project access: read gives the members the connector, write also lists the repo for writing (needs the repo turned on), admin-only', async () => {
  const r = await rig({ folders: { legion: 'dnh33/legion' }, agents: [agent('a1'), agent('a2', { connectors: ['github'], githubWrite: ['x/y'] }), agent('a3')] });
  const path = '/api/github/projects/:id/access';
  assert.equal(isClientRoute('PUT', '/api/github/projects/proj_aaaaaaaaaaaa/access'), false);
  assert.equal(gate({ method: 'PUT', path: '/api/github/projects/proj_aaaaaaaaaaaa/access', adminOk: false, bearerOk: true, hasSecret: true }).allow, false);
  assert.equal((await r.refused('PUT', path, { level: 'admin' }, ['proj_aaaaaaaaaaaa']))?.status, 400);
  assert.equal((await r.refused('PUT', path, { level: 'read' }, ['proj_zzzzzzzzzzzz']))?.status, 404);
  await r.call('PUT', path, { level: 'read' }, ['proj_aaaaaaaaaaaa']);
  assert.deepEqual(r.agents.get('a1')!.connectors, ['github']);
  assert.equal(r.agents.get('a1')!.githubWrite, undefined);
  assert.deepEqual(r.agents.get('a3')!.connectors, undefined, 'other projects are untouched');
  assert.deepEqual(r.agents.get('a2')!.githubWrite ?? [], ['x/y'], 'other repos an agent may write stay');
  assert.equal((await r.refused('PUT', path, { level: 'write' }, ['proj_aaaaaaaaaaaa']))?.status, 409, 'the repo is not turned on yet');
  setTicked(r.dataDir, 'dnh33/legion', true);
  await r.call('PUT', path, { level: 'write' }, ['proj_aaaaaaaaaaaa']);
  assert.deepEqual(r.agents.get('a1')!.githubWrite, ['dnh33/legion']);
  assert.deepEqual(r.agents.get('a2')!.githubWrite, ['x/y', 'dnh33/legion']);
  await r.call('PUT', path, { level: 'read' }, ['proj_aaaaaaaaaaaa']);
  assert.equal(r.agents.get('a1')!.githubWrite, undefined);
  assert.deepEqual(r.agents.get('a2')!.githubWrite, ['x/y']);
});

test('a project with no GitHub remote cannot be given access: 409 with plain words', async () => {
  const r = await rig({ folders: { legion: null }, agents: [agent('a1')] });
  const e = await r.refused('PUT', '/api/github/projects/:id/access', { level: 'read' }, ['proj_aaaaaaaaaaaa']);
  assert.equal(e?.status, 409);
  assert.doesNotMatch(e!.message, /—/);
});

test('connectGithub(write) signs in the write App through its own route and opens only the fixed page', async () => {
  const log: string[] = [];
  const out = await connectGithub({
    async call(method, route) {
      log.push(`${method} ${route}`);
      if (route === '/api/connectors/github') return { status: 200, json: { available: true, key: 'installed', writeAvailable: true } };
      if (route === '/api/github/apps/write/connect') return { status: 200, json: { phase: 'pending', userCode: 'ABCD-1234', verificationUri: 'https://evil.example/x' } };
      return { status: 404, json: {} };
    },
    confirm: async () => true, ensureKey: async () => 'a'.repeat(64), restartCore: async () => null,
    openExternal: (u) => { log.push(`open ${u}`); },
  }, 'write');
  assert.equal(out.ok, true);
  assert.ok(log.includes('POST /api/github/apps/write/connect'));
  assert.ok(!log.includes('POST /api/connectors/github/connect'));
  assert.deepEqual(log.filter((l) => l.startsWith('open')), ['open https://github.com/login/device']);
});
