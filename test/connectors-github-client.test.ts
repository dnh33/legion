import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHubClient, DeviceFlowError, GhError, getGitHubClient, GitHubClient, GITHUB_TOKEN_ID, resetGitHubClientForTests, type GhClientDeps } from '../src/core/connectors/github/client.js';
import { GITHUB_LOG_STORAGE_HOSTS } from '../src/core/connectors/github/hosts.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { TokenStore } from '../src/core/connectors/store.js';
import { DEVICE_CODE, FAKE_CLIENT_ID, FakeGitHub, STORAGE_HOST } from './connectors-fake-github.js';
import { tempDir } from './tmp-cleanup.js';

const fakes: FakeGitHub[] = [];
// a failed assertion must not leave a server open (the test process would never exit)
after(async () => { for (const f of fakes) await f.stop(); });
interface Rig { fake: FakeGitHub; store: TokenStore; client: GitHubClient; dir: string; sleeps: number[]; logs: string[]; clock: { t: number }; events: string[] }

async function rig(over: Partial<GhClientDeps> = {}, withKey = true): Promise<Rig> {
  const dir = tempDir('legion-ghc-');
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  const kr = new ConnectorKeyring();
  if (withKey) kr.install(randomBytes(32));
  const events: string[] = [];
  const store = new TokenStore(join(dir, 'connectors'), kr);
  const origSet = store.set.bind(store);
  store.set = ((id: string, v: unknown) => { events.push('persist'); return origSet(id, v); }) as typeof store.set;
  const base = fake.fetchFn();
  const fetchFn = ((u: string, i: RequestInit) => { const a = new Headers(i?.headers).get('authorization'); if (a) events.push(`api:${a.slice(7, 25)}`); return base(u, i); }) as typeof fetch;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const clock = { t: 1_800_000_000_000 };
  const client = new GitHubClient({ tokens: store, fetchFn, clientId: FAKE_CLIENT_ID, sleep: async (ms) => { sleeps.push(ms); }, log: (l) => logs.push(l), now: () => clock.t, ...over });
  return { fake, store, client, dir, sleeps, logs, clock, events };
}
async function signedIn(r: Rig): Promise<void> { const f = await r.client.startDeviceFlow(); await f.poll(); r.fake.requests.length = 0; r.events.length = 0; }
async function kind(p: Promise<unknown>): Promise<GhError> { try { await p; } catch (e) { assert.ok(e instanceof GhError, String(e)); return e; } throw new Error('expected a GhError'); }
const leaks = (text: string, extra: string[] = []) => ['ghu_FAKE', 'ghr_FAKE', DEVICE_CODE, 'SIGNED-SECRET', 'auth=', ...extra].filter((s) => text.includes(s));

test('device flow: user code and the fixed page are shown, the device code never; interval and slow_down are honoured; the token is stored encrypted', async () => {
  const r = await rig();
  r.fake.script = ['pending', 'slow_down', 'pending', 'success'];
  const flow = await r.client.startDeviceFlow();
  assert.equal(flow.userCode, 'WDJB-MJHT');
  assert.equal(flow.verificationUri, 'https://github.com/login/device');
  assert.ok(!JSON.stringify(flow).includes(DEVICE_CODE) && !Object.values(flow).some((v) => v === DEVICE_CODE));
  await flow.poll();
  assert.deepEqual(r.sleeps, [5000, 5000, 10000, 10000]);
  assert.equal((await r.store.get<{ access: string }>(GITHUB_TOKEN_ID))?.access.startsWith('ghu_FAKE'), true);
  for (const f of readdirSync(join(r.dir, 'connectors'))) assert.deepEqual(leaks(readFileSync(join(r.dir, 'connectors', f)).toString('latin1')), []);
  assert.deepEqual(leaks(r.logs.join('\n')), []);
  await r.fake.stop();
});

test('device flow: expired, denied and disabled end plainly; an unregistered client id never reaches the network', async () => {
  for (const [step, want] of [['expired', 'expired'], ['denied', 'denied'], ['disabled', 'disabled']] as const) {
    const r = await rig();
    r.fake.script = [step];
    const flow = await r.client.startDeviceFlow();
    await assert.rejects(flow.poll(), (e: unknown) => e instanceof DeviceFlowError && e.kind === want && !leaks(String(e.message)).length);
    await r.fake.stop();
  }
  const d = await rig();
  d.fake.deviceDisabled = true;
  await assert.rejects(d.client.startDeviceFlow(), (e: unknown) => e instanceof DeviceFlowError && e.kind === 'disabled');
  await d.fake.stop();
  const u = await rig({ clientId: 'unregistered' });
  await assert.rejects(u.client.startDeviceFlow(), (e: unknown) => e instanceof DeviceFlowError && e.kind === 'not-configured');
  assert.equal(u.fake.requests.length, 0);
  await u.fake.stop();
  const t = await rig();
  t.fake.script = ['pending'];
  const flow = await t.client.startDeviceFlow();
  t.clock.t += 901_000;
  await assert.rejects(flow.poll(), (e: unknown) => e instanceof DeviceFlowError && e.kind === 'expired');
  const ac = new AbortController(); ac.abort();
  await assert.rejects((await t.client.startDeviceFlow()).poll(ac.signal), (e: unknown) => e instanceof DeviceFlowError && e.kind === 'cancelled');
  await t.fake.stop();
});

test('anonymous mode: public reads carry no Authorization; writes and anonymous:false are not-connected', async () => {
  const r = await rig();
  const res = await r.client.request('/repos/o/r');
  assert.equal(res.status, 200);
  assert.equal(r.fake.apiRequests()[0]!.auth, '');
  const c = await r.client.connection();
  assert.equal(c.auth, 'anonymous');
  assert.equal(c.rate.limit, 60);
  assert.equal((await kind(r.client.request('/repos/o/r/issues/1/comments', { method: 'POST', body: '{}' }))).kind, 'not-connected');
  const strict = await rig({ anonymous: false });
  assert.equal((await kind(strict.client.request('/repos/o/r'))).kind, 'not-connected');
  assert.equal(strict.fake.requests.length, 0);
  await r.fake.stop(); await strict.fake.stop();
});

test('every GhError kind, and none carries a URL, a header, a body or a token', async () => {
  const r = await rig();
  r.fake.echoAuth = true;
  await signedIn(r);
  const cases: Array<[string, () => Promise<unknown>, (e: GhError) => void]> = [
    ['not-found', () => r.client.request('/repos/o/missing'), (e) => assert.equal(e.kind, 'not-found')],
    ['forbidden read', () => r.client.request('/repos/o/forbidden'), (e) => assert.equal(e.needs, 'read')],
    ['forbidden write', () => r.client.request('/repos/o/forbidden', { method: 'POST', body: '{}' }), (e) => assert.equal(e.needs, 'write')],
    ['rate-limited', () => r.client.request('/repos/o/ratelimited'), (e) => assert.equal(e.resetAt, new Date(1900000000 * 1000).toISOString())],
    ['secondary', () => r.client.request('/repos/o/secondary'), (e) => assert.equal(e.resetAt, new Date(r.clock.t + 30_000).toISOString())],
    ['network 5xx', () => r.client.request('/repos/o/boom'), (e) => assert.equal(e.retryable, true)],
    ['network bad path', () => r.client.request('https://evil.example/x'), (e) => assert.equal(e.retryable, false)],
  ];
  for (const [name, run, check] of cases) {
    const e = await kind(run());
    check(e);
    const text = JSON.stringify({ ...e, message: e.message, stack: e.stack });
    assert.deepEqual(leaks(text, ['/repos/', 'api.github.com', 'Bearer', 'Bad credentials']), [], name);
  }
  const down = new GitHubClient({ tokens: r.store, fetchFn: (async () => { throw new Error('connect ECONNREFUSED https://api.github.com/secret?token=ghu_FAKEx'); }) as typeof fetch, clientId: FAKE_CLIENT_ID });
  const ne = await kind(down.request('/repos/o/r'));
  assert.deepEqual([ne.kind, ne.retryable], ['network', true]);
  assert.equal(leaks(JSON.stringify({ ...ne, m: ne.message, s: ne.stack }), ['api.github.com']).length, 0);
  assert.deepEqual(leaks(r.logs.join('\n')), []);
  await r.fake.stop();
});

test('ETag: If-None-Match is passed through and a 304 comes back as notModified, free of a body', async () => {
  const r = await rig();
  await signedIn(r);
  const a = await r.client.request('/repos/o/r');
  assert.equal(a.etag, 'W/"v1"');
  assert.equal(a.notModified, undefined);
  const b = await r.client.request('/repos/o/r', { ifNoneMatch: a.etag });
  assert.deepEqual([b.status, b.notModified, b.json], [304, true, undefined]);
  assert.equal(b.etag, 'W/"v1"');
  assert.equal(b.rate.limit, 5000);
  assert.equal(r.fake.apiRequests().at(-1)!.ifNoneMatch, 'W/"v1"');
  await r.fake.stop();
});

test('a read is retried once after a 401 and a refresh; the rotated token is saved BEFORE it is used; concurrent reads share one refresh', async () => {
  const r = await rig();
  await signedIn(r);
  const rec = await r.store.get<{ access: string; refresh: string }>(GITHUB_TOKEN_ID);
  r.fake.expire(rec!.access);
  const res = await r.client.request('/repos/o/r');
  assert.equal(res.status, 200);
  const api = r.fake.apiRequests();
  assert.equal(api.length, 2, 'one failed attempt, one retry');
  assert.equal(r.fake.requests.filter((q) => q.host === 'github.com').length, 1);
  const next = await r.store.get<{ access: string; refresh: string }>(GITHUB_TOKEN_ID);
  assert.notEqual(next!.refresh, rec!.refresh);
  const persistAt = r.events.indexOf('persist');
  const usedNew = r.events.findIndex((e) => e === `api:${next!.access.slice(0, 18)}`);
  assert.ok(persistAt >= 0 && usedNew > persistAt, r.events.join(','));
  // coalescing
  r.fake.expire(next!.access);
  r.fake.requests.length = 0;
  await Promise.all([r.client.request('/repos/o/r'), r.client.request('/repos/o/r'), r.client.request('/repos/o/r')]);
  assert.equal(r.fake.requests.filter((q) => q.host === 'github.com').length, 1);
  // a second 401 after the refresh is auth-expired, not a loop
  const again = await r.store.get<{ access: string }>(GITHUB_TOKEN_ID);
  r.fake.override = (h, _m, p) => (h === 'api.github.com' && p === '/repos/o/r' ? [401, { message: 'x' }] : undefined);
  r.fake.requests.length = 0;
  assert.equal((await kind(r.client.request('/repos/o/r'))).kind, 'auth-expired');
  assert.equal(r.fake.apiRequests().length, 2);
  assert.ok(again);
  await r.fake.stop();
});

test('a write is never retried after a 401, and no refresh is attempted for it', async () => {
  const r = await rig();
  await signedIn(r);
  const rec = await r.store.get<{ access: string }>(GITHUB_TOKEN_ID);
  r.fake.expire(rec!.access);
  r.fake.requests.length = 0;
  assert.equal((await kind(r.client.request('/repos/o/r/issues/1/comments', { method: 'POST', body: '{"body":"x"}' }))).kind, 'auth-expired');
  assert.equal(r.fake.requests.length, 1);
  await r.fake.stop();
});

test('an expiring token is renewed before the request; a refused refresh deletes the local sign-in and says sign in again; a downed refresh keeps it', async () => {
  const r = await rig();
  await signedIn(r);
  r.clock.t += 28_800_000 - 30_000;
  r.fake.requests.length = 0;
  await r.client.request('/repos/o/r');
  assert.deepEqual(r.fake.requests.map((q) => q.host), ['github.com', 'api.github.com']);
  r.clock.t += 28_800_000;
  r.fake.refreshMode = 'down';
  const e = await kind(r.client.request('/repos/o/r'));
  assert.deepEqual([e.kind, e.retryable], ['network', true]);
  assert.ok(await r.store.get(GITHUB_TOKEN_ID), 'kept');
  r.fake.refreshMode = 'bad';
  assert.equal((await kind(r.client.request('/repos/o/r'))).kind, 'auth-expired');
  assert.equal(await r.store.get(GITHUB_TOKEN_ID), undefined);
  assert.equal((await r.client.connection()).needsSignIn, true);
  await r.fake.stop();
});

test('host restriction: only api.github.com paths; callers cannot set headers; an off-host redirect is not followed; nothing else is contacted', async () => {
  const r = await rig();
  await signedIn(r);
  for (const p of ['https://evil.example/x', 'http://api.github.com/x', '//evil.example/x', 'evil.example', '/a b', '/x#y', '/\\evil']) {
    const e = await kind(r.client.request(p));
    assert.deepEqual([e.kind, e.retryable], ['network', false], p);
  }
  assert.equal(r.fake.requests.length, 0, 'rejected before any request');
  assert.deepEqual(r.fake.stray, [], 'no other host was even attempted');
  assert.equal((await kind(r.client.request('/repos/o/evil'))).kind, 'network');
  assert.deepEqual(r.fake.stray, []);
  const moved = await r.client.request('/repos/o/moved');
  assert.deepEqual(moved.json, { full_name: 'o/r' });
  await r.client.request('/repos/o/r', { headers: { authorization: 'Bearer attacker', host: 'evil.example' } } as never);
  assert.ok(r.fake.apiRequests().at(-1)!.auth.startsWith('Bearer ghu_FAKE'));
  assert.ok(r.fake.requests.every((q) => ['api.github.com', 'github.com'].includes(q.host)));
  await r.fake.stop();
});

test('job logs fail closed while the host list is empty: api.github.com is asked, the storage host is never contacted, nothing leaks', async () => {
  assert.deepEqual(GITHUB_LOG_STORAGE_HOSTS, []);
  const r = await rig();
  await signedIn(r);
  const e = await kind(r.client.logs(7, 'o/r'));
  assert.equal(e.kind, 'logs-unavailable');
  assert.equal(r.fake.requests.some((q) => q.host === STORAGE_HOST), false);
  assert.deepEqual(leaks(JSON.stringify({ ...e, m: e.message }) + r.logs.join('\n')), []);
  assert.ok(r.logs.some((l) => l.includes(STORAGE_HOST) && l.includes('not on the storage list')), 'only the host name is recorded');
  await r.fake.stop();
});

test('job logs with a listed host: one redirect, no Authorization on it, text only (no URL), size cap; others refused', async () => {
  const r = await rig({ storageHosts: [STORAGE_HOST] });
  await signedIn(r);
  const out = await r.client.logs('7', 'o/r');
  assert.deepEqual(out, { text: 'line one\nline two\n', truncated: false });
  const hop = r.fake.requests.find((q) => q.host === STORAGE_HOST)!;
  assert.equal(hop.auth, '');
  assert.deepEqual(leaks(JSON.stringify(out) + r.logs.join('\n')), []);
  assert.equal((await kind(r.client.logs(9, 'o/r'))).kind, 'logs-unavailable', 'unlisted host');
  assert.equal((await kind(r.client.logs(8, 'o/r'))).kind, 'logs-unavailable', 'expired logs');
  r.fake.hugeLog = true;
  const big = await r.client.logs(7, 'o/r');
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 2 * 1024 * 1024);
  assert.deepEqual(r.fake.stray, []);
  const anon = await rig({ storageHosts: [STORAGE_HOST] });
  assert.equal((await kind(anon.client.logs(7, 'o/r'))).kind, 'not-connected');
  await r.fake.stop(); await anon.fake.stop();
});

test('repo arguments: owner/name only, "." and ".." refused as either part, as not-found, before any request', async () => {
  const r = await rig({ storageHosts: [STORAGE_HOST] });
  await signedIn(r);
  for (const bad of ['o', 'o/r/x', '../r', 'o/..', './r', 'o/.', '', 'o r/x', 'o/r?x=1', '/o/r']) assert.equal((await kind(r.client.logs(7, bad))).kind, 'not-found', bad);
  assert.equal((await kind(r.client.logs('7/../8', 'o/r'))).kind, 'not-found');
  assert.equal(r.fake.requests.length, 0);
  await r.fake.stop();
});

test('connection() and can(): permissions merged across installations; unknown before it has run', async () => {
  const r = await rig();
  await signedIn(r);
  assert.equal(r.client.can('issues', 'write'), 'unknown');
  const c = await r.client.connection();
  assert.equal(c.auth, 'github-app');
  assert.equal(c.login, 'octo');
  assert.deepEqual(c.permissions, { contents: 'read', metadata: 'read', actions: 'read', issues: 'write' });
  assert.equal(c.rate.remaining, 4990);
  assert.deepEqual([r.client.can('issues', 'write'), r.client.can('issues', 'read'), r.client.can('actions', 'write'), r.client.can('actions', 'read'), r.client.can('pull_requests', 'read')], ['yes', 'yes', 'no', 'yes', 'no']);
  assert.ok(!JSON.stringify(c).includes('ghu_'));
  await r.client.disconnect();
  assert.equal(await r.store.get(GITHUB_TOKEN_ID), undefined);
  await r.fake.stop();
});

test('without a key the sign-in lives in memory only: nothing is written', async () => {
  const r = await rig({}, false);
  await signedIn(r);
  assert.equal((await r.client.request('/user')).status, 200);
  assert.deepEqual(readdirSync(r.dir), []);
  await r.fake.stop();
});

test('one instance: the getter returns exactly what core created, and creating twice does not make a second client', () => {
  resetGitHubClientForTests();
  assert.equal(getGitHubClient(), undefined);
  const store = new TokenStore(join(tempDir('legion-ghc-'), 'connectors'), new ConnectorKeyring());
  const made = createGitHubClient({ tokens: store });
  assert.equal(getGitHubClient(), made);
  assert.equal(createGitHubClient({ tokens: store }), made);
  resetGitHubClientForTests();
  assert.equal(getGitHubClient(), undefined);
});
