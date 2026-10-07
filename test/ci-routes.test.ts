/** CI module over the real HTTP server: admin-only routes, id and repo validation, write routes, logs, and the "no client yet" state. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { isClientRoute } from '../src/core/admin.js';
import { createCiModule } from '../src/core/ci/index.js';
import { FakeGitHub } from '../src/core/ci/fake-github.js';
import { createGitHubClient, resetGitHubClientForTests } from '../src/core/connectors/github/client.js';
import { createWritesResolver, isGitHubPort, isGitHubWrites, resolveGitHub, RETRY_IMPORT_MS } from '../src/core/ci/wiring.js';
import type { ModuleDeps } from '../src/core/modules.js';
import type { LegionEvent } from '../src/shared/types.js';
import { asClient, AUTH, makeFakes, start } from './helpers-c.js';
import { tempDir } from './tmp-cleanup.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c(); });

async function mount(o: { github?: FakeGitHub | null; writes?: boolean } = {}) {
  const f = makeFakes();
  const dataDir = tempDir('legion-ci-data-');
  const gh = o.github === null ? undefined : (o.github ?? new FakeGitHub());
  if (gh && !o.github) { gh.setConnection({ auth: 'pat', login: 'octo', permissions: { actions: 'write' }, rate: { limit: 5000, remaining: 5000, resetAt: new Date(Date.now() + 3_600_000).toISOString() } }); gh.scenario('mixed'); }
  if (gh) gh.writesOn = o.writes !== false;
  const events: LegionEvent[] = [];
  f.bus.on((e) => events.push(e));
  const ci = createCiModule({ config: f.ctx.config, bus: f.bus, dataDir } as unknown as ModuleDeps, { github: gh, writes: gh ? () => gh.writesPort() : undefined, schedule: () => () => undefined });
  const { base, close } = await start({ ...f.ctx, modules: [ci] });
  closers.push(close, async () => ci.dispose?.());
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) => {
    const res = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json };
  };
  return { gh, call, events, ci };
}

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/ci/state'], ['GET', '/api/ci/runs'], ['GET', '/api/ci/runs/9004/jobs'], ['GET', '/api/ci/jobs/900401/log'],
  ['POST', '/api/ci/runs/9004/rerun-failed'], ['POST', '/api/ci/runs/9005/cancel'], ['POST', '/api/ci/watch'], ['POST', '/api/ci/refresh'], ['PUT', '/api/ci/repo'],
];

describe('every CI route is admin-only', () => {
  it('the MCP bearer token alone gets 403 on all of them, none is in the client list, and no write reached GitHub', async () => {
    const m = await mount();
    for (const [method, path] of ROUTES) {
      assert.equal(isClientRoute(method, path), false, `${method} ${path} is not a client route`);
      const r = await m.call(method, path, method === 'GET' ? undefined : { mode: 'panel', repo: 'a/b' }, asClient);
      assert.equal(r.status, 403, `${method} ${path} with the token only`);
    }
    assert.deepEqual(m.gh!.writes, []);
    assert.equal(m.gh!.calls.length, 0, 'the refused calls made no GitHub request');
    const none = await m.call('GET', '/api/ci/state', undefined, {});
    assert.equal(none.status, 401);
  });
});

describe('validation', () => {
  it('refuses bad run and job ids', async () => {
    const m = await mount();
    for (const id of ['0', '-1', '1.5', 'abc', '99999999999999999999', '9007199254740993', '9999999999999999', '1000000000000000', '01', '1e3']) {
      assert.equal((await m.call('GET', `/api/ci/runs/${id}/jobs`)).status, 400, `jobs ${id}`);
      assert.equal((await m.call('GET', `/api/ci/jobs/${id}/log`)).status, 400, `log ${id}`);
      assert.equal((await m.call('POST', `/api/ci/runs/${id}/rerun-failed`)).status, 400, `rerun ${id}`);
      assert.equal((await m.call('POST', `/api/ci/runs/${id}/cancel`)).status, 400, `cancel ${id}`);
    }
    assert.deepEqual(m.gh!.writes, []);
  });
  it('refuses bad repo names, branches, watch bodies; accepts a good repo', async () => {
    const m = await mount();
    for (const bad of ['../x', './x', 'a/..', 'a/b/c', 'a b/c', '.', 'a', 'a/b;x', 5]) assert.equal((await m.call('PUT', '/api/ci/repo', { repo: bad })).status, 400, String(bad));
    assert.equal((await m.call('GET', '/api/ci/runs?branch=a..b')).status, 400);
    assert.equal((await m.call('GET', '/api/ci/runs?branch=' + encodeURIComponent('x y'))).status, 400);
    assert.equal((await m.call('POST', '/api/ci/watch', { mode: 'both' })).status, 400);
    assert.equal((await m.call('POST', '/api/ci/watch', { mode: 'panel', projectId: '../x' })).status, 400);
    assert.equal((await m.call('POST', '/api/ci/watch', { mode: 'panel' })).status, 200);
    const ok = await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.repo, { owner: 'dnh33', name: 'legion', source: 'manual' });
    assert.ok(m.gh!.calls.every((c) => c.path.startsWith('/repos/dnh33/legion/')), 'only the validated repo reaches the client');
  });
});

describe('reads', () => {
  it('serves runs, jobs and a log for a repo the owner set, and emits ci.updated', async () => {
    const m = await mount();
    await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    const runs = await m.call('GET', '/api/ci/runs');
    assert.equal(runs.status, 200);
    assert.ok(runs.json.runs.length >= 5);
    assert.equal(runs.json.counts.running >= 1, true);
    const jobs = await m.call('GET', '/api/ci/runs/9004/jobs');
    assert.deepEqual(jobs.json.summary.failedJobs.map((j: any) => j.id), [900401]);
    assert.ok(m.events.some((e) => e.type === 'ci.updated'));
    const state = await m.call('GET', '/api/ci/state');
    assert.equal(state.json.canWrite, 'yes');
    assert.equal(JSON.stringify(state.json).includes('permissions'), false, 'no permission map or secret in the state');
  });
  it('logs refused is a normal 200 state; with logs on, text is masked and kept as text', async () => {
    const m = await mount();
    await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    const refused = await m.call('GET', '/api/ci/jobs/900401/log');
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.json, { available: false, reason: 'logs-unavailable' });
    m.gh!.logsMode = 'ok';
    const log = await m.call('GET', '/api/ci/jobs/900401/log');
    assert.equal(log.json.available, true);
    assert.equal(log.json.masked, true);
    assert.ok(!log.json.text.includes('ghp_abcdef'));
    assert.ok(log.json.text.includes('<img src=x onerror=alert(1)>'));
    assert.ok(log.json.text.split('\n').length <= 500);
  });
  it('403, 404 and rate limit from GitHub become states in the answer, not errors', async () => {
    const m = await mount();
    const states: Array<[any, string]> = [
      [{ kind: 'forbidden', needs: 'read' }, 'forbidden'], [{ kind: 'not-found' }, 'not-found'],
      [{ kind: 'rate-limited', resetAt: new Date(Date.now() + 600_000).toISOString() }, 'rate-limited'],
    ];
    let i = 0;
    for (const [error, kind] of states) {
      m.gh!.failNext = { error, count: 1 };
      // a new repo drops the cache and the debounce, so each PUT makes one fresh request
      const put = await m.call('PUT', '/api/ci/repo', { repo: `dnh33/probe${++i}` });
      assert.equal(put.status, 200, kind);
      assert.equal(put.json.problem?.kind, kind);
      const runs = await m.call('GET', '/api/ci/runs');
      assert.equal(runs.status, 200);
      assert.equal(runs.json.problem?.kind, kind);
      assert.deepEqual(runs.json.runs, []);
    }
  });
});

describe('Re-run and Cancel', () => {
  it('the write routes call the client with the repo, and refresh the list', async () => {
    const m = await mount();
    await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    await m.call('GET', '/api/ci/runs');
    const a = await m.call('POST', '/api/ci/runs/9004/rerun-failed');
    assert.equal(a.status, 200);
    const b = await m.call('POST', '/api/ci/runs/9005/cancel');
    assert.equal(b.status, 200);
    assert.deepEqual(m.gh!.writes, [{ op: 'rerun', runId: 9004, repo: 'dnh33/legion' }, { op: 'cancel', runId: 9005, repo: 'dnh33/legion' }]);
  });
  it('without write access neither reaches the client: 403, nothing recorded', async () => {
    const m = await mount();
    await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    m.gh!.setConnection({ auth: 'pat', permissions: { actions: 'read' } });
    const state = await m.call('GET', '/api/ci/state');
    assert.equal(state.json.canWrite, 'no');
    assert.equal((await m.call('POST', '/api/ci/runs/9004/rerun-failed')).status, 403);
    assert.equal((await m.call('POST', '/api/ci/runs/9005/cancel')).status, 403);
    m.gh!.setConnection({ auth: 'anonymous' });
    assert.equal((await m.call('POST', '/api/ci/runs/9004/rerun-failed')).status, 403);
    assert.deepEqual(m.gh!.writes, []);
  });
  it('with no writes module: canWrite is false even with write permission, and both routes refuse plainly (403, not a 500)', async () => {
    const m = await mount({ writes: false });
    await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    const state = await m.call('GET', '/api/ci/state');
    assert.equal(m.gh!.can('actions', 'write'), 'yes', 'the permission is there');
    assert.equal(state.json.canWrite, 'no', 'but without the module the panel stays read-only');
    const a = await m.call('POST', '/api/ci/runs/9004/rerun-failed');
    const b = await m.call('POST', '/api/ci/runs/9005/cancel');
    assert.deepEqual([a.status, b.status], [403, 403]);
    assert.match(a.json.error, /write access/);
    assert.deepEqual(m.gh!.writes, []);
  });
  it('a GitHub refusal or a missing run becomes a plain message with no GitHub detail', async () => {
    const m = await mount();
    await m.call('PUT', '/api/ci/repo', { repo: 'dnh33/legion' });
    const gone = await m.call('POST', '/api/ci/runs/123456/cancel');
    assert.equal(gone.status, 404);
    m.gh!.failNext = { error: { kind: 'rate-limited', resetAt: new Date(Date.now() + 1000).toISOString() }, count: 1 };
    assert.equal((await m.call('POST', '/api/ci/runs/9004/rerun-failed')).status, 429);
  });
  it('only the two admin routes in index.ts call the write members (source check)', () => {
    const dir = join(process.cwd(), 'src', 'core', 'ci');
    const hits: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/\.(rerunFailed|cancel)\(/g)) hits.push(`${f}:${m[1]}`);
    }
    // the fake implements them and the poller must not call them; index.ts is the only caller
    assert.deepEqual(hits.sort(), ['index.ts:cancel', 'index.ts:rerunFailed']);
  });
});

describe('no GitHub client in the build', () => {
  it('the state says unavailable and the data routes answer 503 with a plain line; nothing is polled', async () => {
    const m = await mount({ github: null });
    const s = await m.call('GET', '/api/ci/state');
    assert.equal(s.status, 200);
    assert.equal(s.json.available, false);
    const runs = await m.call('GET', '/api/ci/runs');
    assert.equal(runs.status, 503);
    assert.match(runs.json.error, /Connectors/);
    assert.equal((await m.call('POST', '/api/ci/watch', { mode: 'chip' })).status, 200);
  });
  it('the client resolver asks for the single core instance on every use, and accepts it only with the four read members', () => {
    resetGitHubClientForTests();
    assert.equal(resolveGitHub(), undefined, 'before core start');
    const tokens = { get: async () => undefined, set: async () => undefined, remove: async () => undefined, status: async () => 'empty' };
    const real = createGitHubClient({ tokens: tokens as never, fetchFn: (async () => { throw new Error('no network in tests'); }) as never });
    assert.equal(resolveGitHub(), real, 'picked up after boot, without a restart');
    assert.equal(isGitHubPort(real), true, 'the real client is accepted: it has no write members and needs none');
    assert.equal(resolveGitHub(() => ({ connection() {} })), undefined, 'not a port');
    assert.equal(resolveGitHub(() => { throw new Error('x'); }), undefined);
    resetGitHubClientForTests();
    assert.equal(resolveGitHub(), undefined);
  });
  it('the writes resolver picks up a module that appears later; a missing module is silent, a broken one is logged once by kind', async () => {
    const logs: string[] = [];
    let mod: unknown = {};
    let t = 0;
    const r = createWritesResolver((m) => logs.push(m), async () => mod, () => t);
    await r.settled();
    assert.equal(r.get(), undefined, 'module without rerunFailed and cancel: no writes');
    const writes = { rerunFailed: async () => undefined, cancel: async () => undefined };
    mod = writes;
    // the module object is read as loaded: a second resolver sees the real thing
    const r2 = createWritesResolver((m) => logs.push(m), async () => writes, () => t);
    await r2.settled();
    assert.equal(r2.get(), writes);
    assert.equal(isGitHubWrites({ rerunFailed() {} }), false);

    const missing = createWritesResolver((m) => logs.push(m), async () => { throw Object.assign(new Error('Cannot find module /secret/path'), { code: 'ERR_MODULE_NOT_FOUND' }); }, () => t);
    await missing.settled();
    assert.equal(missing.get(), undefined);
    assert.equal(logs.length, 0, 'module not found is normal and silent');

    let attempts = 0;
    const broken = createWritesResolver((m) => logs.push(m), async () => { attempts++; throw Object.assign(new SyntaxError('bad token in /secret/path'), { code: 'ERR_BROKEN' }); }, () => t);
    await broken.settled();
    broken.get(); t += RETRY_IMPORT_MS + 1; broken.get(); await broken.settled();
    assert.ok(attempts >= 2, 'it tries again later');
    assert.equal(logs.length, 1, 'one line only');
    const line = String(logs[0]);
    assert.match(line, /ERR_BROKEN/);
    assert.ok(!/secret|path|token/.test(line), 'kind only, no message');
  });
  it('the default writes module is absent today: no writes, and the real module path is a literal import', async () => {
    const r = createWritesResolver();
    await r.settled();
    assert.equal(r.get(), undefined);
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'ci', 'wiring.ts'), 'utf8');
    assert.ok(src.includes("import('../connectors/github/writes.js')"), 'a literal specifier, as the tripwire needs');
  });
});
