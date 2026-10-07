/**
 * Contract test: the CI module against the REAL connectors GitHubClient, with its fetch injected through GhClientDeps (no network).
 * This is what proves the swap from the fake: the real request() refusals, GhInit.ifNoneMatch, thrown GhError instances, logs() failing
 * closed, `can()` answering 'unknown' without permissions, and a build with no writes module.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createCiModule } from '../src/core/ci/index.js';
import { CiPoller } from '../src/core/ci/poller.js';
import type { GitHubWrites } from '../src/core/ci/port.js';
import { GitHubClient } from '../src/core/connectors/github/client.js';
import type { ModuleDeps } from '../src/core/modules.js';
import type { CiUpdateSummary } from '../src/shared/ci.js';
import { AUTH, makeFakes, start } from './helpers-c.js';
import { tempDir } from './tmp-cleanup.js';

const T0 = Date.parse('2026-10-07T10:00:00Z');
const RESET_EPOCH = Math.floor((T0 + 3_600_000) / 1000);

interface Seen { url: URL; method: string; headers: Record<string, string> }
const run = (id: number, branch: string, status = 'completed', conclusion: string | null = 'success') => ({
  id, name: 'CI', head_branch: branch, head_sha: 'abc', display_title: `Run ${id}`, event: 'push', status, conclusion,
  html_url: `https://github.com/dnh33/legion/actions/runs/${id}`, created_at: '2026-10-07T09:50:00Z', run_started_at: '2026-10-07T09:50:05Z', updated_at: '2026-10-07T09:52:05Z', run_attempt: 1,
});

/** A scripted api.github.com. `mode` flips refusals; every request is recorded. */
function world() {
  const seen: Seen[] = [];
  const mode = { rateLimited: false, notFound: false };
  const ETAG = 'W/"runs-1"';
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    seen.push({ url, method: init?.method ?? 'GET', headers });
    const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': mode.rateLimited ? '0' : '4990', 'x-ratelimit-reset': String(RESET_EPOCH) };
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...rate, ...extra } });
    if (url.hostname !== 'api.github.com') return new Response('no', { status: 500 });
    if (mode.rateLimited) return new Response('{}', { status: 403, headers: rate });
    if (mode.notFound && url.pathname.startsWith('/repos')) return new Response('{}', { status: 404, headers: rate });
    const p = url.pathname;
    if (p === '/rate_limit') return json(200, { resources: { core: { limit: 60, remaining: 57, reset: RESET_EPOCH } } });
    if (p === '/user') return json(200, { login: 'octo' });
    if (p === '/user/installations') return json(200, { installations: [{ permissions: { actions: 'write', contents: 'read' } }] });
    if (p === '/repos/dnh33/legion/actions/runs') {
      if (headers['if-none-match'] === ETAG) return new Response(null, { status: 304, headers: { ...rate, etag: ETAG } });
      const b = url.searchParams.get('branch');
      const list = [run(1, b ?? 'main', 'in_progress', null), run(2, 'main')];
      return json(200, { total_count: list.length, workflow_runs: list }, { etag: ETAG });
    }
    const jobs = /^\/repos\/dnh33\/legion\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    if (jobs) return json(200, { total_count: 1, jobs: [{ id: 900401, run_id: Number(jobs[1]), name: 'test (windows-latest, 2/4)', status: 'completed', conclusion: 'failure', started_at: '2026-10-07T09:50:10Z', completed_at: '2026-10-07T09:52:00Z', html_url: 'https://github.com/dnh33/legion/actions/runs/1/job/900401', labels: [] }] });
    if (/^\/repos\/dnh33\/legion\/actions\/jobs\/\d+\/logs$/.test(p)) return new Response(null, { status: 302, headers: { ...rate, location: 'https://blob.example.net/signed?sig=secret' } });
    return json(404, {});
  }) as typeof fetch;
  return { seen, mode, fetchFn };
}

function rig(o: { signedIn?: boolean; branch?: string | null; writes?: GitHubWrites } = {}) {
  const clock = { t: T0 };
  const w = world();
  const tokens = {
    get: async () => (o.signedIn ? { access: 'ghu_testtoken_not_real', login: 'octo' } : undefined),
    set: async () => undefined, remove: async () => undefined, status: async () => (o.signedIn ? 'ok' : 'empty'),
  };
  const client = new GitHubClient({ tokens: tokens as never, fetchFn: w.fetchFn, now: () => clock.t, storageHosts: [], sleep: async () => undefined });
  const events: CiUpdateSummary[] = [];
  const poller = new CiPoller({
    github: client, writes: o.writes, emit: (e) => events.push(e), now: () => clock.t, schedule: () => () => undefined,
    resolveRepo: () => ({ repo: { owner: 'dnh33', name: 'legion' }, branch: o.branch === undefined ? 'feat/ci-panel' : o.branch, source: 'remote' }),
  });
  return { clock, w, client, poller, events, advance: (ms: number) => { clock.t += ms; } };
}

describe('the CI module against the real GitHubClient', () => {
  it('anonymous: lists runs, reads the rate from /rate_limit, sends no credentials, and is read-only (can() is unknown, no writes module)', async () => {
    const r = rig();
    const v = await r.poller.runsView();
    assert.equal(v.problem, null);
    assert.deepEqual(v.runs.map((x) => x.id).sort(), [1, 2]);
    const s = await r.poller.stateView();
    assert.equal(s.connection?.auth, 'anonymous');
    assert.equal(s.live, 'slow');
    assert.equal(r.client.can('actions', 'write'), 'unknown');
    assert.equal(s.canWrite, 'no');
    assert.ok(r.w.seen.every((c) => c.headers.authorization === undefined), 'no Authorization header');
    assert.ok(r.w.seen.every((c) => c.url.hostname === 'api.github.com'));
  });

  it('every path the module builds passes the client\'s request() refusals, including encoded branch names', async () => {
    for (const branch of ['feat/ci-panel', 'a//b', 'v1.0/x-y', 'a.b_c', 'main']) {
      const r = rig({ signedIn: true, branch });
      const v = await r.poller.runsView();
      assert.equal(v.problem, null, `branch ${branch}: no refusal (a refused path would be a network problem)`);
      assert.ok(v.runs.length > 0, branch);
      await r.poller.jobsView(1);
      await r.poller.logView(900401);
      for (const c of r.w.seen) {
        const raw = c.url.pathname + c.url.search;
        assert.ok(raw.startsWith('/') && !raw.startsWith('//') && !/[\\\s#]/.test(raw), raw);
      }
      if (branch === 'a//b') assert.ok(r.w.seen.some((c) => c.url.search.includes('branch=a%2F%2Fb')), 'the slashes are encoded, not sent raw');
    }
  });

  it('sends If-None-Match as GhInit.ifNoneMatch when signed in, gets a 304 back, and does not re-render; anonymous never sends it', async () => {
    const r = rig({ signedIn: true });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    const lists1 = r.w.seen.filter((c) => c.url.pathname.endsWith('/actions/runs'));
    assert.ok(lists1.every((c) => c.headers['if-none-match'] === undefined), 'nothing to match yet');
    const emitted = r.events.length;
    r.advance(11_000);
    await r.poller.refresh('auto');
    const lists2 = r.w.seen.filter((c) => c.url.pathname.endsWith('/actions/runs')).slice(lists1.length);
    assert.ok(lists2.length > 0 && lists2.every((c) => c.headers['if-none-match'] === 'W/"runs-1"'), 'the client got the etag in ifNoneMatch and put it in the header');
    assert.equal(r.events.length, emitted, 'a 304 changes nothing on screen');
    assert.equal((await r.poller.runsView()).runs.length, 2, 'the cached rows are kept');

    const a = rig();
    await a.poller.refresh('open');
    a.advance(80_000);
    await a.poller.refresh('manual');
    assert.ok(a.w.seen.filter((c) => c.url.pathname.endsWith('/actions/runs')).every((c) => c.headers['if-none-match'] === undefined));
  });

  it('rate-limited: the client throws GhError rate-limited, the panel shows it and nothing more is requested until the reset', async () => {
    const r = rig({ signedIn: true });
    await r.poller.refresh('open');
    r.w.mode.rateLimited = true;
    r.advance(11_000);
    await r.poller.refresh('auto');
    const v = await r.poller.runsView();
    assert.equal(v.problem?.kind, 'rate-limited');
    assert.equal(v.problem?.resetAt, new Date(RESET_EPOCH * 1000).toISOString());
    assert.ok(v.runs.length > 0 && v.stale, 'old rows stay, marked stale');
    const n = r.w.seen.length;
    r.w.mode.rateLimited = false;
    r.advance(20_000);
    await r.poller.refresh('manual');
    assert.equal(r.w.seen.length, n, 'paused until resetAt');
  });

  it('not-found is a state; logs fail closed as logs-unavailable and the signed address never leaves the client', async () => {
    const r = rig({ signedIn: true });
    r.w.mode.notFound = true;
    assert.equal((await r.poller.runsView()).problem?.kind, 'not-found');
    r.w.mode.notFound = false;
    const log = await r.poller.logView(900401);
    assert.deepEqual(log, { available: false, reason: 'logs-unavailable' });
    assert.ok(r.w.seen.some((c) => c.url.pathname === '/repos/dnh33/legion/actions/jobs/900401/logs'), 'logs(jobId, repo) built the path from the repo');
    assert.ok(!r.w.seen.some((c) => c.url.hostname === 'blob.example.net'), 'the storage host is not on the list, so it is never contacted');
    assert.ok(!JSON.stringify(log).includes('signed'));
  });

  it('writes: without a writes module canWrite is false even with write permission; with one it follows can()', async () => {
    const none = rig({ signedIn: true });
    const s1 = await none.poller.stateView();
    assert.equal(none.client.can('actions', 'write'), 'yes', 'the permission map says write');
    assert.equal(s1.canWrite, 'no', 'but there is nothing to call');
    const some = rig({ signedIn: true, writes: { rerunFailed: async () => undefined, cancel: async () => undefined } });
    assert.equal((await some.poller.stateView()).canWrite, 'yes');
  });

  it('through the HTTP routes: re-run and cancel refuse plainly (403, never a 500) while there is no writes module', async () => {
    const r = rig({ signedIn: true });
    const f = makeFakes();
    const ci = createCiModule({ config: f.ctx.config, bus: f.bus, dataDir: tempDir('legion-ci-contract-') } as unknown as ModuleDeps, { github: r.client, schedule: () => () => undefined });
    const { base, close } = await start({ ...f.ctx, modules: [ci] });
    closers.push(close);
    const call = async (m: string, p: string, body?: unknown) => {
      const res = await fetch(base + p, { method: m, headers: { ...AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: await res.json().catch(() => undefined) as any };
    };
    assert.equal((await call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' })).status, 200);
    assert.equal((await call('GET', '/api/ci/runs')).status, 200);
    assert.equal((await call('GET', '/api/ci/state')).json.canWrite, 'no');
    const a = await call('POST', '/api/ci/runs/1/rerun-failed');
    const b = await call('POST', '/api/ci/runs/1/cancel');
    assert.deepEqual([a.status, b.status], [403, 403]);
    assert.ok(!r.w.seen.some((c) => c.method === 'POST'), 'nothing was sent to GitHub');
  });
});

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c(); });
