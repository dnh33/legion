/** Choose an App's repos from Legion: owner-only routes, the real GitHub rules in plain words, one change at a time, nothing retried. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, isClientRoute } from '../src/core/admin.js';
import { FakeGitHub } from '../src/core/ci/fake-github.js';
import { addRepoPickerRoutes } from '../src/core/connectors/github/repo-picker-routes.js';
import { githubInstallUrl } from '../src/core/connectors/github/hosts.js';
import type { RouteAdder } from '../src/core/modules.js';
import type { GithubApp } from '../src/shared/github-area.js';

const asked: string[] = [];
function rig(o: { read?: boolean; write?: boolean; readSel?: 'all' | 'selected'; readRepos?: string[]; user?: { fullName: string; private?: boolean; admin?: boolean }[]; noInstall?: boolean } = {}) {
  const mk = (slug: string, id: number, signed: boolean, sel: 'all' | 'selected', repos: string[]) => {
    const f = new FakeGitHub(() => Date.now(), { auth: signed ? 'github-app' : 'anonymous', login: 'dnh33', rate: { limit: 5000, remaining: 5000, resetAt: new Date(Date.now() + 3_600_000).toISOString() } });
    if (!o.noInstall) f.addInstallation({ id, slug, selection: sel, account: 'dnh33', repos });
    f.userRepos = o.user ?? [{ fullName: 'dnh33/a' }, { fullName: 'dnh33/b' }, { fullName: 'dnh33/c', private: false, admin: false }, { fullName: 'dnh33/d' }, { fullName: 'other/zed' }];
    return f;
  };
  const fakes: Record<GithubApp, FakeGitHub> = {
    read: mk('legion-read', 11, o.read !== false, o.readSel ?? 'selected', o.readRepos ?? ['dnh33/a', 'dnh33/b']),
    write: mk('legion-write', 22, o.write !== false, 'selected', ['dnh33/a']),
  };
  let invalidated = 0;
  const handlers = new Map<string, (c: unknown) => unknown>();
  const add: RouteAdder = (m, p, h) => { handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  const unsigned = new Set<GithubApp>();
  if (o.read === false) unsigned.add('read');
  if (o.write === false) unsigned.add('write');
  addRepoPickerRoutes(add, {
    client: (app) => { asked.push(app); return unsigned.has(app) ? undefined : { signedIn: async () => fakes[app].conn.auth !== 'anonymous', request: (p, i) => fakes[app].request(p, i) }; },
    invalidate: () => { invalidated++; },
  });
  const call = async (m: string, p: string, params: string[], q = ''): Promise<any> => handlers.get(`${m} ${p}`)!({ req: { headers: {} }, params, body: undefined, url: new URL(`http://x${p}${q}`) });
  const LIST = 'GET /api/github/apps/:app/repos'; const ITEM = '/api/github/apps/:app/repos/:repoId';
  const list = (app: string, q = '') => call('GET', '/api/github/apps/:app/repos', [app], q ? `?q=${q}` : '');
  const put = (app: string, id: string) => call('PUT', ITEM, [app, id]);
  const del = (app: string, id: string) => call('DELETE', ITEM, [app, id]);
  const refused = async (p: Promise<unknown>): Promise<{ status: number; message: string } | undefined> => { try { await p; } catch (e) { return { status: (e as { status: number }).status, message: (e as Error).message }; } return undefined; };
  const changes = (app: GithubApp) => fakes[app].calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE');
  return { fakes, handlers, list, put, del, refused, changes, invalidated: () => invalidated, LIST };
}
const id = (r: ReturnType<typeof rig>, full: string): string => String(r.fakes.read.repoId(full));

test('the three routes are admin-only: the MCP bearer alone is refused, none is a client route', () => {
  const r = rig();
  assert.deepEqual([...r.handlers.keys()].sort(), ['DELETE /api/github/apps/:app/repos/:repoId', 'GET /api/github/apps/:app/repos', 'PUT /api/github/apps/:app/repos/:repoId']);
  for (const [method, path] of [['GET', '/api/github/apps/read/repos'], ['PUT', '/api/github/apps/write/repos/123'], ['DELETE', '/api/github/apps/read/repos/123']] as const) {
    assert.equal(isClientRoute(method, path), false, `${method} ${path}`);
    assert.equal(gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true }).allow, false, `${method} ${path}`);
    assert.equal(gate({ method, path, adminOk: true, bearerOk: true, hasSecret: true }).allow, true, `${method} ${path}`);
  }
});

test('an unknown app is a 400 on all three routes, and GitHub is never asked', async () => {
  const r = rig();
  for (const bad of ['admin', 'READ', '', 'read/../write']) {
    assert.equal((await r.refused(r.list(bad)))?.status, 400, bad);
    assert.equal((await r.refused(r.put(bad, '5')))?.status, 400, bad);
    assert.equal((await r.refused(r.del(bad, '5')))?.status, 400, bad);
  }
  assert.equal(r.fakes.read.calls.length + r.fakes.write.calls.length, 0);
});

test('a repo id that is not a positive whole number is a 400 and sends nothing', async () => {
  const r = rig();
  for (const bad of ['abc', '0', '-1', '1.5', '1e3', '', ' 7', '99999999999999999999']) {
    assert.equal((await r.refused(r.put('read', bad)))?.status, 400, `PUT ${bad}`);
    assert.equal((await r.refused(r.del('read', bad)))?.status, 400, `DELETE ${bad}`);
  }
  assert.equal(r.fakes.read.calls.length, 0);
});

test('list marks each repo: installed, private, admin; only the installation account; sorted as GitHub gave them', async () => {
  const r = rig();
  const v = await r.list('read');
  assert.equal(v.phase, 'ready');
  assert.equal(v.installationId, 11);
  assert.equal(v.selection, 'selected');
  assert.equal(v.account, 'dnh33');
  assert.equal(v.installUrl, githubInstallUrl('legion-read'));
  assert.deepEqual(v.rows.map((x: { fullName: string; installed: boolean; admin: boolean; private: boolean }) => [x.fullName, x.installed, x.admin, x.private]), [
    ['dnh33/a', true, true, true], ['dnh33/b', true, true, true], ['dnh33/c', false, false, false], ['dnh33/d', false, true, true],
  ]);
  assert.equal(v.rows[0].id, r.fakes.read.repoId('dnh33/a'));
  assert.ok(r.fakes.read.calls.some((c) => c.path.startsWith('/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100')));
});

test('the search filters in code, case-insensitively', async () => {
  const r = rig();
  assert.deepEqual((await r.list('read', 'B')).rows.map((x: { fullName: string }) => x.fullName), ['dnh33/b']);
  assert.deepEqual((await r.list('read', 'nope')).rows, []);
});

test('seesUninstalled is true when GitHub lists a repo the App is not installed on, false when it lists only installed ones', async () => {
  assert.equal((await rig().list('read')).seesUninstalled, true);
  const only = rig({ user: [{ fullName: 'dnh33/a' }, { fullName: 'dnh33/b' }] });
  assert.equal((await only.list('read')).seesUninstalled, false);
});

test('not installed: the install address; not signed in: needs-signin and no call', async () => {
  const none = rig({ noInstall: true });
  assert.deepEqual(await none.list('read'), { phase: 'not-installed', installUrl: githubInstallUrl('legion-read') });
  const out = rig({ write: false });
  assert.deepEqual(await out.list('write'), { phase: 'needs-signin' });
  assert.equal(out.fakes.write.calls.length, 0);
  const anon = rig();
  anon.fakes.read.setConnection({ auth: 'anonymous' });
  assert.deepEqual(await anon.list('read'), { phase: 'needs-signin' });
});

test('selection all is reported', async () => {
  const v = await rig({ readSel: 'all' }).list('read');
  assert.equal(v.selection, 'all');
});

test('PUT adds a repo to that App only, DELETE removes it, and the area is invalidated after each', async () => {
  const r = rig();
  assert.deepEqual(await r.put('read', id(r, 'dnh33/d')), { ok: true });
  assert.deepEqual(r.fakes.read.installations[0]!.repos, ['dnh33/a', 'dnh33/b', 'dnh33/d']);
  assert.deepEqual(r.fakes.write.installations[0]!.repos, ['dnh33/a']);
  assert.equal(r.invalidated(), 1);
  assert.deepEqual(r.changes('read').map((c) => [c.method, c.path]), [['PUT', `/user/installations/11/repositories/${id(r, 'dnh33/d')}`]]);
  assert.deepEqual(await r.del('read', id(r, 'dnh33/b')), { ok: true });
  assert.deepEqual(r.fakes.read.installations[0]!.repos, ['dnh33/a', 'dnh33/d']);
  assert.equal(r.invalidated(), 2);
  assert.equal((await r.list('read')).rows.find((x: { fullName: string }) => x.fullName === 'dnh33/d').installed, true);
});

test('failures are plain words with the right status, and the area is invalidated anyway', async () => {
  const r = rig();
  // 403: not an admin of the repo
  let e = await r.refused(r.put('read', id(r, 'dnh33/c')));
  assert.deepEqual(e, { status: 403, message: 'You need to be an admin of that repo to add it.' });
  // 422 on DELETE: the last repo
  const one = rig({ readRepos: ['dnh33/a'] });
  e = await one.refused(one.del('read', id(one, 'dnh33/a')));
  assert.deepEqual(e, { status: 422, message: 'Legion must keep at least one repo, or it is set to all repos on GitHub.' });
  // 422 on DELETE: all repos
  const all = rig({ readSel: 'all' });
  e = await all.refused(all.del('read', id(all, 'dnh33/a')));
  assert.equal(e?.message, 'Legion must keep at least one repo, or it is set to all repos on GitHub.');
  // 422 on PUT: all repos
  e = await all.refused(all.put('read', id(all, 'dnh33/b')));
  assert.deepEqual(e, { status: 422, message: 'GitHub refused: the app is set to all repos. Change that at GitHub.' });
  // 404: no such repo
  e = await r.refused(r.put('read', '424242'));
  assert.deepEqual(e, { status: 404, message: 'GitHub did not find that repo or installation.' });
  // rate limit
  r.fakes.read.failChange = { status: 429 };
  e = await r.refused(r.put('read', id(r, 'dnh33/b')));
  assert.deepEqual(e, { status: 429, message: 'GitHub is limiting requests. Try again in a while.' });
  assert.equal(r.invalidated(), 3);
  for (const x of [e!.message]) assert.ok(!/[—–]/.test(x));
});

test('a PUT or DELETE is sent once and never retried, whatever failed', async () => {
  const r = rig();
  r.fakes.read.failNext = { error: { kind: 'network', retryable: true }, count: Infinity };
  // the first request of a change is the installation lookup; it fails before any PUT
  assert.equal((await r.refused(r.put('read', id(r, 'dnh33/b'))))?.status, 502);
  assert.equal(r.changes('read').length, 0);
  assert.equal(r.fakes.read.calls.length, 1);
  r.fakes.read.failNext = null;
  r.fakes.read.failChange = { status: 422 };
  assert.equal((await r.refused(r.put('read', id(r, 'dnh33/d'))))?.status, 422);
  assert.equal(r.changes('read').length, 1);
  r.fakes.read.failChange = { status: 403 };
  assert.equal((await r.refused(r.del('read', id(r, 'dnh33/a'))))?.status, 403);
  assert.equal(r.changes('read').length, 2);
});

test('one change at a time per App: the second is a 409, the other App is free, and the lock is released after', async () => {
  const r = rig();
  const real = r.fakes.read.request.bind(r.fakes.read);
  let release!: () => void;
  const hold = new Promise<void>((ok) => { release = ok; });
  r.fakes.read.request = async (p, i) => { if (i?.method === 'PUT') await hold; return real(p, i); };
  const first = r.put('read', id(r, 'dnh33/d'));
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(await r.refused(r.del('read', id(r, 'dnh33/b'))), { status: 409, message: 'A change is already running.' });
  assert.deepEqual(await r.put('write', id(r, 'dnh33/b')), { ok: true });
  release();
  await first;
  assert.deepEqual(await r.del('read', id(r, 'dnh33/b')), { ok: true });
});
