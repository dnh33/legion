import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createGitHubClient, GhError, getGitHubClient, GitHubClient, GITHUB_TOKEN_ID, GITHUB_WRITE_TOKEN_ID, resetGitHubClientForTests } from '../src/core/connectors/github/client.js';
import {
  GITHUB_APP_SLUGS, GITHUB_INSTALLATIONS_URL, GITHUB_READ_APP_CLIENT_ID, GITHUB_WRITE_APP_CLIENT_ID, githubInstallSettingsUrl, githubInstallUrl, looksLikeClientId,
} from '../src/core/connectors/github/hosts.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { TokenStore } from '../src/core/connectors/store.js';
import { FAKE_CLIENT_ID, FakeGitHub } from './connectors-fake-github.js';
import { tempDir } from './tmp-cleanup.js';

const fakes: FakeGitHub[] = [];
after(async () => { for (const f of fakes) await f.stop(); });

const newStore = (dir: string): TokenStore => { const kr = new ConnectorKeyring(); kr.install(randomBytes(32)); return new TokenStore(join(dir, 'connectors'), kr); };

async function rig(app: 'read' | 'write' = 'write') {
  const dir = tempDir('legion-gha-');
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  const store = newStore(dir);
  const client = new GitHubClient({ app, tokens: store, fetchFn: fake.fetchFn(), clientId: FAKE_CLIENT_ID, sleep: async () => undefined });
  const flow = await client.startDeviceFlow();
  await flow.poll();
  fake.requests.length = 0;
  return { dir, fake, store, client };
}
const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1900000000' };
const repoRows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ full_name: `o/r${from + i}`, private: i % 2 === 0, html_url: `https://github.com/o/r${from + i}` }));

test('the two registered client ids are accepted, the placeholder is not', () => {
  assert.equal(GITHUB_READ_APP_CLIENT_ID, 'Iv23liIt2yvFfWgPrZfK');
  assert.equal(GITHUB_WRITE_APP_CLIENT_ID, 'Iv23li7s6igxaj3TZMa3');
  assert.equal(looksLikeClientId(GITHUB_READ_APP_CLIENT_ID), true);
  assert.equal(looksLikeClientId(GITHUB_WRITE_APP_CLIENT_ID), true);
  assert.equal(looksLikeClientId('unregistered'), false);
  assert.deepEqual(GITHUB_APP_SLUGS, { read: 'legion-read', write: 'legion-write' });
  assert.equal(githubInstallUrl('legion-write'), 'https://github.com/apps/legion-write/installations/new');
  assert.equal(GITHUB_INSTALLATIONS_URL, 'https://github.com/settings/installations');
  assert.equal(githubInstallSettingsUrl({ id: 42, account: { login: 'dnh33', type: 'User' } }), 'https://github.com/settings/installations/42');
  assert.equal(githubInstallSettingsUrl({ id: 7, account: { login: 'acme', type: 'Organization' } }), 'https://github.com/organizations/acme/settings/installations/7');
});

test('an unregistered client id refuses sign-in for either app, with no network call', async () => {
  const dir = tempDir('legion-gha-');
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  for (const app of ['read', 'write'] as const) {
    const c = new GitHubClient({ app, tokens: newStore(dir), fetchFn: fake.fetchFn(), clientId: 'unregistered' });
    assert.equal(c.deviceFlowAvailable(), false);
    await assert.rejects(c.startDeviceFlow(), { kind: 'not-configured' });
  }
  assert.equal(fake.requests.length, 0);
});

test('token ids: read keeps github-read, write uses github-write, neither touches the other', async () => {
  assert.equal(GITHUB_TOKEN_ID, 'github-read');
  assert.equal(GITHUB_WRITE_TOKEN_ID, 'github-write');
  const w = await rig('write');
  assert.equal(typeof (await w.store.get<{ access: string }>('github-write'))?.access, 'string');
  assert.equal(await w.store.get('github-read'), undefined);
  assert.equal(await w.client.signedIn(), true);
  await w.client.disconnect();
  assert.equal(await w.store.get('github-write'), undefined);
  const r = await rig('read');
  assert.equal(typeof (await r.store.get<{ access: string }>('github-read'))?.access, 'string');
  assert.equal(await r.store.get('github-write'), undefined);
});

test('getGitHubClient(kind): read by default, write is its own client on the same store, one instance each', () => {
  resetGitHubClientForTests();
  assert.equal(getGitHubClient(), undefined);
  assert.equal(getGitHubClient('write'), undefined);
  const store = newStore(tempDir('legion-gha-'));
  const read = createGitHubClient({ tokens: store });
  assert.equal(getGitHubClient(), read);
  assert.equal(getGitHubClient('read'), read);
  const write = getGitHubClient('write');
  assert.ok(write && write !== read);
  assert.equal(getGitHubClient('write'), write);
  assert.equal(createGitHubClient({ tokens: store }), read);
  assert.equal(read.deviceFlowAvailable(), true);
  assert.equal(write.deviceFlowAvailable(), true);
  resetGitHubClientForTests();
  assert.equal(getGitHubClient('write'), undefined);
});

test('installations(): maps the answer, and needs a sign-in', async () => {
  const r = await rig('write');
  r.fake.override = (_h, _m, path) => path.split('?')[0] === '/user/installations'
    ? [200, { total_count: 2, installations: [
      { id: 11, account: { login: 'dnh33', type: 'User' }, repository_selection: 'selected', permissions: { contents: 'read', issues: 'write' }, app_slug: 'legion-write' },
      { id: 12, account: { login: 'acme', type: 'Organization' }, repository_selection: 'all', permissions: { metadata: 'read' }, app_slug: 'legion-write' },
    ] }, rate] : undefined;
  assert.deepEqual(await r.client.installations(), [
    { id: 11, account: { login: 'dnh33', type: 'User' }, repositorySelection: 'selected', permissions: { contents: 'read', issues: 'write' }, appSlug: 'legion-write' },
    { id: 12, account: { login: 'acme', type: 'Organization' }, repositorySelection: 'all', permissions: { metadata: 'read' }, appSlug: 'legion-write' },
  ]);
  const anon = new GitHubClient({ app: 'write', tokens: newStore(join(r.dir, 'other')), fetchFn: r.fake.fetchFn(), clientId: FAKE_CLIENT_ID });
  await assert.rejects(anon.installations(), (e: unknown) => e instanceof GhError && e.kind === 'not-connected');
});

test('installationRepos(): 100 per page, a short page ends it, nothing is truncated', async () => {
  const r = await rig('read');
  r.fake.override = (_h, _m, path) => {
    if (!path.startsWith('/user/installations/5/repositories')) return undefined;
    const page = Number(new URL(path, 'https://x').searchParams.get('page') ?? '1');
    return [200, { total_count: 103, repositories: page === 1 ? repoRows(0, 100) : repoRows(100, 3) }, rate];
  };
  const got = await r.client.installationRepos(5);
  assert.equal(got.repos.length, 103);
  assert.equal(got.truncated, false);
  assert.deepEqual(got.repos[0], { fullName: 'o/r0', private: true, htmlUrl: 'https://github.com/o/r0' });
  const paths = r.fake.requests.filter((q) => q.path.includes('/repositories')).map((q) => q.path);
  assert.equal(paths.length, 2);
  assert.ok(paths[0]!.includes('per_page=100') && paths[0]!.includes('page=1') && paths[1]!.includes('page=2'));
});

test('installationRepos(): stops at 10 pages and says truncated', async () => {
  const r = await rig('read');
  r.fake.override = (_h, _m, path) => path.startsWith('/user/installations/5/repositories') ? [200, { total_count: 5000, repositories: repoRows(0, 100) }, rate] : undefined;
  const got = await r.client.installationRepos(5);
  assert.equal(got.repos.length, 1000);
  assert.equal(got.truncated, true);
  assert.equal(r.fake.requests.filter((q) => q.path.includes('/repositories')).length, 10);
});

test('installationRepos(): sends the ETag back and uses the kept answer on a 304', async () => {
  const r = await rig('read');
  r.fake.override = (_h, _m, path) => {
    if (!path.startsWith('/user/installations/5/repositories')) return undefined;
    const sent = r.fake.requests[r.fake.requests.length - 1]!.ifNoneMatch;
    return sent === 'W/"p1"' ? [304, '', { ...rate, etag: 'W/"p1"' }] : [200, { total_count: 2, repositories: repoRows(0, 2) }, { ...rate, etag: 'W/"p1"' }];
  };
  const first = await r.client.installationRepos(5);
  const second = await r.client.installationRepos(5);
  assert.deepEqual(second, first);
  assert.equal(second.repos.length, 2);
  const reqs = r.fake.requests.filter((q) => q.path.includes('/repositories'));
  assert.equal(reqs[0]!.ifNoneMatch, '');
  assert.equal(reqs[1]!.ifNoneMatch, 'W/"p1"');
});

test('installationRepos(): refuses a bad installation id before any request', async () => {
  const r = await rig('read');
  for (const bad of [0, -1, 1.5, NaN, '5/../x' as unknown as number]) await assert.rejects(r.client.installationRepos(bad), (e: unknown) => e instanceof GhError && e.kind === 'not-found');
  assert.equal(r.fake.requests.length, 0);
});

test('a 401 on the write client refreshes once with the write token and retries', async () => {
  const r = await rig('write');
  const rec = await r.store.get<{ access: string }>('github-write');
  r.fake.revoked.add(rec!.access);
  const list = await r.client.installations();
  assert.ok(Array.isArray(list));
  assert.equal(r.fake.requests.filter((q) => q.host === 'github.com' && q.path.includes('access_token')).length, 1);
  const next = await r.store.get<{ access: string }>('github-write');
  assert.notEqual(next?.access, rec!.access);
  assert.equal(await r.store.get('github-read'), undefined);
});

test('a refused call logs GitHub\'s own short reason, never a token (mutation: drop the reason from the log)', async () => {
  const dir = tempDir('legion-gha-');
  const fake = await new FakeGitHub().start();
  fakes.push(fake);
  const lines: string[] = [];
  const client = new GitHubClient({ app: 'read', tokens: newStore(dir), fetchFn: fake.fetchFn(), clientId: FAKE_CLIENT_ID, sleep: async () => undefined, log: (l) => lines.push(l) });
  await (await client.startDeviceFlow()).poll();
  fake.override = (_h, _m, path) => path.split('?')[0] === '/user/installations'
    ? [403, { message: 'You must authenticate with an access token authorized to a GitHub App in order to list installations\u0007', documentation_url: 'https://docs.github.com/x' }, rate] : undefined;
  await assert.rejects(client.installations(), (e: Error & { kind?: string }) => e.kind === 'forbidden');
  const why = lines.find((l) => l.startsWith('github: refused: '));
  assert.ok(why, lines.join(' | '));
  assert.match(why!, /authorized to a GitHub App in order to list installations$/);
  assert.doesNotMatch(why!, /\u0007|gh[uprs]_/);
});
