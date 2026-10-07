/** The Settings routes of the connectors module: admin-only, the sign-in cannot start before the key is installed, nothing secret in the answers. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { gate, isClientRoute } from '../src/core/admin.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import { GitHubClient } from '../src/core/connectors/github/client.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { TokenStore } from '../src/core/connectors/store.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import { DEVICE_CODE, FAKE_CLIENT_ID, FakeGitHub, USER_CODE } from './connectors-fake-github.js';
import { tempDir } from './tmp-cleanup.js';

const fakes: FakeGitHub[] = [];
after(async () => { for (const f of fakes) await f.stop(); });

async function rig(o: { key?: boolean; registered?: boolean } = {}) {
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  const keys = new ConnectorKeyring();
  if (o.key) keys.install(randomBytes(32));
  const store = new TokenStore(join(tempDir('legion-cr-'), 'connectors'), keys);
  const client = new GitHubClient({ tokens: store, fetchFn: fake.fetchFn(), ...(o.registered === false ? {} : { clientId: FAKE_CLIENT_ID }), sleep: async () => undefined });
  const mod = createConnectorsModule({ store: { getAgent: () => undefined, getTask: () => undefined } } as unknown as ModuleDeps, { keys, client: () => client });
  const handlers = new Map<string, (c: unknown) => unknown>();
  const add: RouteAdder = (m, p, h) => { handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  mod.routes!(add);
  const call = async (m: string, p: string, body?: unknown): Promise<any> => handlers.get(`${m} ${p}`)!({ req: { headers: {} }, body, params: [], url: new URL(`http://x${p}`) });
  const refused = async (m: string, p: string, body?: unknown): Promise<{ status: number; message: string } | undefined> => { try { await call(m, p, body); } catch (e) { return { status: (e as { status: number }).status, message: (e as Error).message }; } return undefined; };
  return { fake, keys, client, mod, call, refused, handlers };
}
const idle = async (r: Awaited<ReturnType<typeof rig>>) => { for (let i = 0; i < 100 && r.mod.flow().phase === 'pending'; i++) await new Promise((x) => setTimeout(x, 5)); };

test('every connectors route is admin-only: the MCP bearer token alone is refused, none is on the client route list', async () => {
  const r = await rig();
  assert.ok(r.handlers.size >= 5);
  for (const k of r.handlers.keys()) {
    const [method, path] = k.split(' ') as [string, string];
    assert.equal(isClientRoute(method, path), false, k);
    const d = gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true });
    assert.equal(d.allow, false, k);
    assert.equal(gate({ method, path, adminOk: true, bearerOk: true, hasSecret: true }).allow, true, k);
  }
});

test('status: not available while the GitHub App is not registered (placeholder client id); Connect says so and contacts nobody', async () => {
  const r = await rig({ key: true, registered: false });
  const s = await r.call('GET', '/api/connectors/github');
  assert.equal(s.available, false);
  assert.equal(s.key, 'installed');
  assert.equal(s.signedIn, false);
  assert.match(s.revokeUrl, /github\.com\/settings\/applications$/);
  assert.deepEqual(await r.refused('POST', '/api/connectors/github/connect', {}), { status: 409, message: 'not-available' });
  assert.equal(r.fake.requests.length, 0);
});

test('the sign-in cannot start before the key is installed (needs-key, nothing requested); memoryOnly is the owner\'s explicit exception', async () => {
  const r = await rig({ key: false });
  assert.equal((await r.call('GET', '/api/connectors/github')).key, 'missing');
  assert.deepEqual(await r.refused('POST', '/api/connectors/github/connect', {}), { status: 409, message: 'needs-key' });
  assert.deepEqual(await r.refused('POST', '/api/connectors/github/connect', { memoryOnly: 'true' }), { status: 409, message: 'needs-key' }, 'only the boolean true');
  assert.equal(r.fake.requests.length, 0, 'no request to GitHub before the key is there');
  r.fake.script = ['pending', 'success'];
  const started = await r.call('POST', '/api/connectors/github/connect', { memoryOnly: true });
  assert.equal(started.phase, 'pending');
  await idle(r);
  const s = await r.call('GET', '/api/connectors/github');
  assert.equal(s.signedIn, true);
  assert.equal(s.storage, 'memory-only');
});

test('connect with a key: the window gets the user code and the fixed page, never the device code; the flow completes; status and disconnect carry no secret', async () => {
  const r = await rig({ key: true });
  r.fake.script = ['pending', 'pending', 'success'];
  const started = await r.call('POST', '/api/connectors/github/connect', {});
  assert.equal(started.userCode, USER_CODE);
  assert.equal(started.verificationUri, 'https://github.com/login/device');
  const mid = JSON.stringify(await r.call('GET', '/api/connectors/github'));
  assert.ok(!mid.includes(DEVICE_CODE));
  await idle(r);
  const done = await r.call('GET', '/api/connectors/github');
  assert.deepEqual([done.signedIn, done.storage, done.flow.phase], [true, 'ok', 'idle']);
  const conn = await r.call('GET', '/api/connectors/github/connection');
  assert.equal(conn.auth, 'github-app');
  assert.equal(conn.login, 'octo');
  assert.ok(conn.permissions && conn.rate);
  const all = JSON.stringify([started, done, conn]);
  assert.ok(!all.includes(DEVICE_CODE) && !all.includes('ghu_') && !all.includes('ghr_'), 'no token or code in any answer');
  const gone = await r.call('POST', '/api/connectors/github/disconnect');
  assert.match(gone.revokeUrl, /settings\/applications/);
  assert.equal((await r.call('GET', '/api/connectors/github')).signedIn, false);
});

test('a refused or cancelled sign-in is shown plainly; cancel stops polling; a second Connect while one is pending returns the same code', async () => {
  const r = await rig({ key: true });
  r.fake.script = ['denied'];
  await r.call('POST', '/api/connectors/github/connect', {});
  await idle(r);
  const f = (await r.call('GET', '/api/connectors/github')).flow;
  assert.equal(f.phase, 'failed');
  assert.equal(f.reason, 'denied');
  const r2 = await rig({ key: true });
  r2.fake.script = ['pending'];
  const a = await r2.call('POST', '/api/connectors/github/connect', {});
  const b = await r2.call('POST', '/api/connectors/github/connect', {});
  assert.equal(b.userCode, a.userCode);
  await r2.call('POST', '/api/connectors/github/cancel');
  assert.equal(r2.mod.flow().phase, 'idle');
});
