/** Repo create (design 6.4, amendment 13): owner-only routes, the write App's normal token, one POST and never a retry, plain failures. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gate, isClientRoute } from '../src/core/admin.js';
import { readAllowlist } from '../src/core/connectors/github/allowlist.js';
import { GitHubClient } from '../src/core/connectors/github/client.js';
import { addRepoAdminRoutes } from '../src/core/connectors/github/repo-admin-routes.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { TokenStore } from '../src/core/connectors/store.js';
import type { RouteAdder } from '../src/core/modules.js';
import { FAKE_CLIENT_ID, FakeGitHub } from './connectors-fake-github.js';
import { repoRoot } from './ps-helpers.js';
import { tempDir } from './tmp-cleanup.js';

const fakes: FakeGitHub[] = [];
after(async () => { for (const f of fakes) await f.stop(); });
const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1900000000' };
type Reply = [number, unknown, Record<string, string>?];

async function rig(o: { signedIn?: boolean; noClient?: boolean } = {}) {
  const dataDir = tempDir('legion-cr6-');
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  const kr = new ConnectorKeyring(); kr.install(randomBytes(32));
  const hold: { p?: Promise<void> } = {};
  const base = fake.fetchFn();
  // a POST waits here while a test holds it, so two creates can overlap
  const fetchFn = (async (u: string | URL | Request, i?: RequestInit) => { if (i?.method === 'POST' && String(u).includes('api.github.com') && hold.p) await hold.p; return base(u, i); }) as typeof fetch;
  const client = new GitHubClient({ app: 'write', tokens: new TokenStore(join(dataDir, 'connectors'), kr), fetchFn, clientId: FAKE_CLIENT_ID, sleep: async () => undefined });
  if (o.signedIn !== false) await (await client.startDeviceFlow()).poll();
  fake.requests.length = 0;
  const asked: string[] = [];
  const handlers = new Map<string, (c: unknown) => unknown>();
  const add: RouteAdder = (m, p, h) => { handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  addRepoAdminRoutes(add, { dataDir, client: (k) => { asked.push(k ?? 'read'); return o.noClient ? undefined : client; } });
  const call = async (m: string, p: string, body?: unknown): Promise<any> => handlers.get(`${m} ${p}`)!({ req: { headers: {} }, body, params: [], url: new URL(`http://x${p}`) });
  const refused = async (m: string, p: string, body?: unknown): Promise<{ status: number; message: string } | undefined> => { try { await call(m, p, body); } catch (e) { return { status: (e as { status: number }).status, message: (e as Error).message }; } return undefined; };
  const posts = () => fake.requests.filter((r) => r.method === 'POST');
  return { dataDir, fake, client, hold, handlers, call, refused, posts, asked };
}
const created = (name = 'new-one', owner = 'octo'): Reply => [201, { full_name: `${owner}/${name}`, html_url: `https://github.com/${owner}/${name}`, private: true }, rate];

test('routes are admin-only: the MCP bearer alone is refused, none is a client route', async () => {
  const r = await rig();
  assert.deepEqual([...r.handlers.keys()].sort(), ['GET /api/github/orgs', 'POST /api/github/repos']);
  for (const k of r.handlers.keys()) {
    const [method, path] = k.split(' ') as [string, string];
    assert.equal(isClientRoute(method, path), false, k);
    assert.equal(gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true }).allow, false, k);
    assert.equal(gate({ method, path, adminOk: true, bearerOk: true, hasSecret: true }).allow, true, k);
  }
});

test('write App not signed in: needs-write, no call to GitHub', async () => {
  for (const o of [{ signedIn: false }, { noClient: true }]) {
    const r = await rig(o);
    assert.deepEqual(await r.call('POST', '/api/github/repos', { name: 'x' }), { phase: 'needs-write', message: 'Connect writes first: creating a repo uses Legion (write).' });
    assert.equal(r.fake.requests.length, 0);
  }
});

test('create asks for the write client only, defaults private on and README off, posts once to /user/repos', async () => {
  const r = await rig();
  r.fake.override = (_h, m, p) => (m === 'POST' && p === '/user/repos' ? created() : undefined);
  const out = await r.call('POST', '/api/github/repos', { name: 'new-one' });
  assert.deepEqual(out, { phase: 'done', fullName: 'octo/new-one', htmlUrl: 'https://github.com/octo/new-one', ticked: false });
  assert.equal(r.posts().length, 1);
  assert.deepEqual(JSON.parse(r.posts()[0]!.body), { name: 'new-one', private: true, auto_init: false });
  assert.ok(r.asked.length > 0 && r.asked.every((k) => k === 'write'));
  assert.deepEqual(readAllowlist(r.dataDir).ticked, []);
});

test('an org owner posts to /orgs/{org}/repos; README, public and a description clipped to 350 pass through; tick:true turns it on', async () => {
  const r = await rig();
  r.fake.override = (_h, m, p) => (m === 'POST' && p === '/orgs/acme/repos' ? created('Tools', 'acme') : undefined);
  const out = await r.call('POST', '/api/github/repos', { owner: 'acme', name: 'Tools', description: 'd'.repeat(500), private: false, readme: true, tick: true });
  assert.deepEqual(out, { phase: 'done', fullName: 'acme/Tools', htmlUrl: 'https://github.com/acme/Tools', ticked: true });
  const sent = JSON.parse(r.posts()[0]!.body);
  assert.equal(sent.description.length, 350);
  assert.equal(sent.private, false);
  assert.equal(sent.auto_init, true);
  assert.deepEqual(readAllowlist(r.dataDir).ticked, ['acme/tools']);
});

test('invalid input is refused before any GitHub call', async () => {
  const r = await rig();
  const bad: unknown[] = [undefined, 'name', [], {}, { name: '' }, { name: '..' }, { name: 'a/b' }, { name: 'a'.repeat(101) }, { name: 'ok', owner: 'a/b' }, { name: 'ok', owner: '..' }, { name: 'ok', private: 'yes' }, { name: 'ok', readme: 1 }, { name: 'ok', tick: 'true' }, { name: 'ok', description: 5 }];
  for (const body of bad) assert.equal((await r.refused('POST', '/api/github/repos', body))?.status, 400, JSON.stringify(body));
  assert.equal(r.fake.requests.length, 0);
});

test('Review Focus 4: two concurrent POSTs make one GitHub call, the second gets 409; the lock frees afterwards', async () => {
  const r = await rig();
  let release!: () => void; r.hold.p = new Promise<void>((x) => { release = x; });
  r.fake.override = (_h, m, p) => (m === 'POST' && p === '/user/repos' ? created() : undefined);
  const first = r.call('POST', '/api/github/repos', { name: 'new-one' });
  const second = await r.refused('POST', '/api/github/repos', { name: 'new-one' });
  assert.deepEqual(second, { status: 409, message: 'A create is already running.' });
  release();
  assert.equal((await first).phase, 'done');
  assert.equal(r.posts().length, 1);
  r.hold.p = undefined;
  assert.equal((await r.call('POST', '/api/github/repos', { name: 'again' })).phase, 'done');
  assert.equal(r.posts().length, 2);
});

test('failures are plain, the lock frees, and there is never a second POST (no retry after send)', async () => {
  const cases: Array<{ owner?: string; reply: Reply; status: number; message: string }> = [
    { reply: [422, { message: 'name already exists on this account' }, rate], status: 422, message: 'That name is taken.' },
    { owner: 'acme', reply: [403, { message: 'Resource not accessible by integration' }, rate], status: 403, message: 'The organisation must approve Legion (write) first.' },
    { reply: [404, { message: 'Not Found' }, rate], status: 404, message: 'GitHub did not find that.' },
    { reply: [429, { message: 'slow down' }, { ...rate, 'retry-after': '30' }], status: 429, message: 'GitHub is limiting requests. Try again in a while.' },
    { reply: [403, { message: 'API rate limit exceeded' }, { ...rate, 'x-ratelimit-remaining': '0' }], status: 429, message: 'GitHub is limiting requests. Try again in a while.' },
    { reply: [502, { message: 'bad gateway' }, rate], status: 502, message: 'Could not reach GitHub. Check your repositories before you try again.' },
  ];
  for (const c of cases) {
    const r = await rig();
    r.fake.override = (_h, m) => (m === 'POST' ? c.reply : undefined);
    const got = await r.refused('POST', '/api/github/repos', { name: 'x', ...(c.owner ? { owner: c.owner } : {}) });
    assert.deepEqual(got, { status: c.status, message: c.message }, String(c.reply[0]));
    assert.equal(r.posts().length, 1, `one POST for ${c.reply[0]}`);
    assert.doesNotMatch(String(got?.message), /token|bearer|secret/i);
    r.fake.override = (_h, m) => (m === 'POST' ? created('x') : undefined);
    assert.equal((await r.call('POST', '/api/github/repos', { name: 'x' })).phase, 'done', 'lock freed');
  }
});

test('GET /api/github/orgs lists the signed-in user organisations; signed out gives an empty list with no call', async () => {
  const r = await rig();
  r.fake.override = (_h, m, p) => (m === 'GET' && p.startsWith('/user/orgs') ? [200, [{ login: 'acme', id: 1 }, { login: 'beta', id: 2 }, { login: 'bad/name' }], rate] : undefined);
  assert.deepEqual(await r.call('GET', '/api/github/orgs'), { orgs: [{ login: 'acme' }, { login: 'beta' }] });
  const out = await rig({ signedIn: false });
  assert.deepEqual(await out.call('GET', '/api/github/orgs'), { orgs: [] });
  assert.equal(out.fake.requests.length, 0);
});

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('the access token is in no data-folder file in plain text, and a create writes nothing outside connectors/', async () => {
  const r = await rig();
  r.fake.override = (_h, m, p) => (m === 'POST' && p === '/user/repos' ? created() : undefined);
  const tokens = [...r.fake.access.keys()];
  assert.ok(tokens.length > 0);
  await r.call('POST', '/api/github/repos', { name: 'new-one', tick: true });
  const files = walk(r.dataDir);
  assert.ok(files.length > 0);
  for (const f of files) for (const t of tokens) assert.equal(readFileSync(f).includes(t), false, f);
  assert.deepEqual(files.map((f) => f.slice(r.dataDir.length + 1).replace(/\\/g, '/')).filter((f) => !f.startsWith('connectors/')), []);
});

test('source: only repo-admin*.ts import repo-admin; the agent tool files do not, and it opens no socket of its own', () => {
  const src = join(repoRoot, 'src');
  const importers = walk(src).filter((f) => /\.ts$/.test(f)).filter((f) => /from\s+['"][^'"]*repo-admin(?:-routes)?\.js['"]/.test(readFileSync(f, 'utf8')));
  for (const f of importers) {
    const rel = f.slice(src.length + 1).replace(/\\/g, '/');
    assert.ok(/^core\/connectors\/github\/repo-admin/.test(rel) || rel === 'bin/legion-core.ts', `unexpected importer ${rel}`);
  }
  for (const n of ['tools.ts', 'write-tools.ts']) assert.doesNotMatch(readFileSync(join(src, 'core/connectors/github', n), 'utf8'), /repo-admin/);
  assert.doesNotMatch(readFileSync(join(src, 'core/connectors/github/repo-admin.ts'), 'utf8'), /\bfetch\s*\(|node:http|node:net/);
});

test('a reply without full_name and no owner: created, but nothing bogus is ticked and no "/name" path is made up', async () => {
  const r = await rig();
  r.fake.override = (_h, m, p) => (m === 'POST' && p === '/user/repos' ? [201, { html_url: 'https://github.com/octo/bare' }, rate] : undefined);
  const out = await r.call('POST', '/api/github/repos', { name: 'bare', tick: true });
  assert.equal(out.phase, 'done');
  assert.equal(out.ticked, false);
  assert.ok(!String(out.fullName).startsWith('/'), out.fullName);
  assert.deepEqual(readAllowlist(r.dataDir).ticked, []);
});
