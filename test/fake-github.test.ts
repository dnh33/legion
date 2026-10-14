/** The GitHub fake: installations, installation repos, repo create and the write endpoints, in GitHub's documented shapes (two apps: read and write). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeGitHub } from '../src/core/ci/fake-github.js';
import { GhError } from '../src/core/connectors/github/client.js';

const T0 = Date.parse('2026-10-15T10:00:00Z');
type Raw = Record<string, unknown>;

function rig() {
  const gh = new FakeGitHub(() => T0);
  gh.setConnection({ auth: 'github-app', login: 'octo', permissions: { contents: 'read', issues: 'write', pull_requests: 'write', actions: 'write' }, rate: { limit: 5000, remaining: 5000, resetAt: new Date(T0 + 3_600_000).toISOString() } });
  gh.addInstallation({ id: 11, slug: 'legion-read', selection: 'selected', account: 'octo', permissions: { contents: 'read', issues: 'read' }, repos: ['octo/alpha', 'octo/beta'] });
  gh.addInstallation({ id: 22, slug: 'legion-write', selection: 'selected', account: 'octo', permissions: { issues: 'write', administration: 'write' }, repos: ['octo/alpha'] });
  return gh;
}
const post = (gh: FakeGitHub, path: string, body: unknown) => gh.request(path, { method: 'POST', body: JSON.stringify(body) });
const fails = async (p: Promise<unknown>, kind: string, extra: Raw = {}) => {
  await assert.rejects(p, (e: unknown) => e instanceof GhError && e.kind === kind && Object.entries(extra).every(([k, v]) => (e as unknown as Raw)[k] === v));
};

describe('fake GitHub: installations', () => {
  it('lists installations with selection, permissions and app slug', async () => {
    const r = await rig().request('/user/installations');
    const j = r.json as { total_count: number; installations: Raw[] };
    assert.equal(r.status, 200);
    assert.equal(j.total_count, 2);
    assert.deepEqual(j.installations.map((i) => [i.id, i.app_slug, i.repository_selection]), [[11, 'legion-read', 'selected'], [22, 'legion-write', 'selected']]);
    assert.deepEqual(j.installations[1]!.permissions, { issues: 'write', administration: 'write' });
    assert.equal((j.installations[0]!.account as Raw).login, 'octo');
  });
  it('shows an install on all repositories', async () => {
    const gh = rig();
    gh.addInstallation({ id: 33, slug: 'legion-read', selection: 'all', account: 'acme', repos: ['acme/x'] });
    const j = (await gh.request('/user/installations')).json as { installations: Raw[] };
    assert.equal(j.installations.at(-1)!.repository_selection, 'all');
  });
  it('refuses a caller that is not signed in', async () => {
    const gh = new FakeGitHub(() => T0);
    await fails(gh.request('/user/installations'), 'not-connected');
  });
  it('speaks ETag and 304, and a 304 costs a signed-in caller nothing', async () => {
    const gh = rig();
    const first = await gh.request('/user/installations');
    assert.ok(first.etag);
    const left = gh.conn.rate.remaining;
    const again = await gh.request('/user/installations', { ifNoneMatch: first.etag });
    assert.equal(again.status, 304);
    assert.equal(again.notModified, true);
    assert.equal(gh.conn.rate.remaining, left);
    gh.addInstallation({ id: 44, slug: 'legion-read', selection: 'selected', account: 'zed', repos: [] });
    assert.equal((await gh.request('/user/installations', { ifNoneMatch: first.etag })).status, 200, 'a change drops the old tag');
  });
});

describe('fake GitHub: installation repositories', () => {
  it('lists the repos of one installation in GitHub shape', async () => {
    const r = await rig().request('/user/installations/11/repositories?per_page=100');
    const j = r.json as { total_count: number; repository_selection: string; repositories: Raw[] };
    assert.equal(j.total_count, 2);
    assert.equal(j.repository_selection, 'selected');
    assert.deepEqual(j.repositories.map((x) => x.full_name), ['octo/alpha', 'octo/beta']);
    assert.equal(j.repositories[0]!.private, true);
    assert.equal((j.repositories[0]!.owner as Raw).login, 'octo');
    assert.equal(typeof j.repositories[0]!.html_url, 'string');
  });
  it('pages with per_page capped at 100', async () => {
    const gh = rig();
    gh.addInstallation({ id: 55, slug: 'legion-read', selection: 'selected', account: 'big', repos: Array.from({ length: 230 }, (_, i) => `big/r${String(i).padStart(3, '0')}`) });
    const p = async (q: string) => (await gh.request(`/user/installations/55/repositories?${q}`)).json as { total_count: number; repositories: Raw[] };
    const a = await p('per_page=100&page=1'); const b = await p('per_page=100&page=2'); const c = await p('per_page=100&page=3'); const d = await p('per_page=100&page=4');
    assert.deepEqual([a.repositories.length, b.repositories.length, c.repositories.length, d.repositories.length], [100, 100, 30, 0]);
    assert.equal(a.total_count, 230);
    assert.equal(b.repositories[0]!.full_name, 'big/r100');
    assert.equal((await p('per_page=500')).repositories.length, 100, 'GitHub caps per_page at 100');
  });
  it('speaks ETag and 304 per page', async () => {
    const gh = rig();
    const path = '/user/installations/11/repositories?per_page=100&page=1';
    const first = await gh.request(path);
    assert.equal((await gh.request(path, { ifNoneMatch: first.etag })).status, 304);
    assert.equal((await gh.request('/user/installations/11/repositories?per_page=100&page=2', { ifNoneMatch: first.etag })).status, 200, 'a tag belongs to its page');
  });
  it('answers 404 for an installation the caller does not have', async () => {
    await fails(rig().request('/user/installations/999/repositories'), 'not-found');
  });
});

describe('fake GitHub: orgs', () => {
  it('lists the orgs of the caller', async () => {
    const gh = rig();
    gh.addOrg('acme'); gh.addOrg('widgets');
    const r = await gh.request('/user/orgs?per_page=100');
    assert.deepEqual((r.json as Raw[]).map((o) => o.login), ['acme', 'widgets']);
  });
});

describe('fake GitHub: create repo', () => {
  it('creates a personal repo: 201, full_name, html_url, and it shows in the write install at once', async () => {
    const gh = rig();
    const r = await post(gh, '/user/repos', { name: 'fresh', private: true });
    const j = r.json as Raw;
    assert.equal(r.status, 201);
    assert.equal(j.full_name, 'octo/fresh');
    assert.equal(j.html_url, 'https://github.com/octo/fresh');
    assert.equal(j.private, true);
    const w = ((await gh.request('/user/installations/22/repositories')).json as { repositories: Raw[] }).repositories.map((x) => x.full_name);
    assert.ok(w.includes('octo/fresh'), 'the write app is granted the repo it created');
    const rd = ((await gh.request('/user/installations/11/repositories')).json as { repositories: Raw[] }).repositories.map((x) => x.full_name);
    assert.ok(!rd.includes('octo/fresh'), 'the read app still needs the owner to add it');
  });
  it('is public only when the body does not say private, like GitHub', async () => {
    const gh = rig();
    assert.equal(((await post(gh, '/user/repos', { name: 'a', private: false })).json as Raw).private, false);
    assert.equal(((await post(gh, '/user/repos', { name: 'b' })).json as Raw).private, false, 'GitHub defaults to public; Legion must always send the flag');
  });
  it('creates in an org', async () => {
    const gh = rig();
    gh.addOrg('acme');
    const r = await post(gh, '/orgs/acme/repos', { name: 'tool', private: true });
    assert.equal(r.status, 201);
    assert.equal((r.json as Raw).full_name, 'acme/tool');
  });
  it('422 when the name exists, whatever the case', async () => {
    const gh = rig();
    await post(gh, '/user/repos', { name: 'dup' });
    await assert.rejects(post(gh, '/user/repos', { name: 'DUP' }), (e: unknown) => e instanceof GhError && e.kind === 'network' && e.retryable === false);
    assert.equal(gh.calls.at(-1)!.status, 422);
    assert.equal(gh.calls.at(-1)!.reason, 'name-exists');
  });
  it('422 for a missing name', async () => {
    const gh = rig();
    await assert.rejects(post(gh, '/user/repos', { private: true }));
    assert.equal(gh.calls.at(-1)!.status, 422);
  });
  it('403 when the org must approve, 404 for an org that is not the caller\'s', async () => {
    const gh = rig();
    gh.addOrg('locked', { needsApproval: true });
    await fails(post(gh, '/orgs/locked/repos', { name: 'x' }), 'forbidden');
    assert.equal(gh.calls.at(-1)!.status, 403);
    assert.equal(gh.calls.at(-1)!.reason, 'org-approval');
    await fails(post(gh, '/orgs/nowhere/repos', { name: 'x' }), 'not-found');
    assert.equal(gh.calls.at(-1)!.status, 404);
  });
  it('429 carries the reset time', async () => {
    const gh = rig();
    const resetAt = new Date(T0 + 90_000).toISOString();
    gh.failCreate = { status: 429, resetAt };
    await fails(post(gh, '/user/repos', { name: 'slow' }), 'rate-limited', { resetAt });
    assert.equal(gh.calls.at(-1)!.status, 429);
    assert.equal((await post(gh, '/user/repos', { name: 'slow' })).status, 201, 'the failure was one-shot');
  });
  it('403 when the app lacks the create right', async () => {
    const gh = rig();
    gh.failCreate = { status: 403 };
    await fails(post(gh, '/user/repos', { name: 'nope' }), 'forbidden');
  });
  it('refuses a caller that is not signed in, and counts every send', async () => {
    const anon = new FakeGitHub(() => T0);
    await fails(post(anon, '/user/repos', { name: 'x' }), 'not-connected');
    const gh = rig();
    await post(gh, '/user/repos', { name: 'once' });
    assert.equal(gh.calls.filter((c) => c.method === 'POST' && c.path === '/user/repos').length, 1);
  });
});

describe('fake GitHub: write endpoints', () => {
  it('opens an issue (201), comments (201), opens a PR (201), reviews (200)', async () => {
    const gh = rig();
    const i = await post(gh, '/repos/octo/alpha/issues', { title: 'Bug', body: 'text' });
    assert.equal(i.status, 201);
    const n = (i.json as Raw).number as number;
    assert.match(String((i.json as Raw).html_url), /octo\/alpha\/issues\/\d+$/);
    assert.equal((await post(gh, `/repos/octo/alpha/issues/${n}/comments`, { body: 'hi' })).status, 201);
    const pr = await post(gh, '/repos/octo/alpha/pulls', { title: 'Fix', head: 'feat/x', base: 'main' });
    assert.equal(pr.status, 201);
    assert.match(String((pr.json as Raw).html_url), /octo\/alpha\/pull\/\d+$/);
    assert.equal((await post(gh, `/repos/octo/alpha/pulls/${(pr.json as Raw).number}/reviews`, { event: 'COMMENT', body: 'ok' })).status, 200);
    assert.deepEqual(gh.writes.map((w) => w.op), ['issue', 'comment', 'pr', 'review']);
    assert.ok(gh.writes.every((w) => w.repo === 'octo/alpha'));
  });
  it('re-runs failed jobs (201) and cancels a run (202), and the run changes', async () => {
    const gh = rig();
    gh.addRun({ id: 7, conclusion: 'failure' });
    gh.addRun({ id: 8, status: 'in_progress' });
    assert.equal((await post(gh, '/repos/octo/alpha/actions/runs/7/rerun-failed-jobs', {})).status, 201);
    assert.equal(gh.runs.find((r) => r.id === 7)!.status, 'queued');
    assert.equal((await post(gh, '/repos/octo/alpha/actions/runs/8/cancel', {})).status, 202);
    assert.equal(gh.runs.find((r) => r.id === 8)!.conclusion, 'cancelled');
    assert.deepEqual(gh.writes.map((w) => w.op), ['rerun', 'cancel']);
  });
  it('403 without the write right for that area, 404 for a missing run', async () => {
    const gh = rig();
    gh.setConnection({ permissions: { issues: 'read', pull_requests: 'read', actions: 'read' } });
    await fails(post(gh, '/repos/octo/alpha/issues', { title: 'x' }), 'forbidden', { needs: 'write' });
    await fails(post(gh, '/repos/octo/alpha/issues/1/comments', { body: 'x' }), 'forbidden', { needs: 'write' });
    await fails(post(gh, '/repos/octo/alpha/pulls', { title: 'x' }), 'forbidden', { needs: 'write' });
    await fails(post(gh, '/repos/octo/alpha/actions/runs/7/cancel', {}), 'forbidden', { needs: 'write' });
    gh.setConnection({ permissions: { actions: 'write' } });
    await fails(post(gh, '/repos/octo/alpha/actions/runs/404/cancel', {}), 'not-found');
    assert.equal(gh.calls.at(-1)!.status, 404);
  });
  it('404 for an unknown write path and a missing repo', async () => {
    const gh = rig();
    gh.missingRepos.add('octo/gone');
    await fails(post(gh, '/repos/octo/alpha/branches', {}), 'not-found');
    await fails(post(gh, '/repos/octo/gone/issues', { title: 'x' }), 'not-found');
  });
  it('keeps the old run listing and the writesPort working', async () => {
    const gh = rig();
    gh.addRun({ id: 1, conclusion: 'failure' });
    assert.equal(((await gh.request('/repos/octo/alpha/actions/runs')).json as { total_count: number }).total_count, 1);
    gh.writesOn = true;
    await gh.writesPort()!.rerunFailed(1, 'octo/alpha');
    assert.deepEqual(gh.writes, [{ op: 'rerun', runId: 1, repo: 'octo/alpha' }]);
  });
});
