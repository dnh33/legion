/** The away module over real HTTP: admin-only routes, validation, the snapshot's new fields, attention without text, budget notice once. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isClientRoute } from '../src/core/admin.js';
import { createAwayCore, createAwayModule } from '../src/core/away/index.js';
import { EventBus } from '../src/core/bus.js';
import type { AwayModule } from '../src/core/away/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';
import type { LegionEvent } from '../src/shared/types.js';

const J = { 'Content-Type': 'application/json' };

async function boot(opts: { now?: () => number } = {}) {
  const root = cleanupTemp('legion-away-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const holds: Array<[string, number]> = [];
  (f.ctx.approvals as unknown as Record<string, unknown>).hold = (id: string, ms: number) => { holds.push([id, ms]); return true; };
  (f.ctx.engine as unknown as Record<string, unknown>).queueSnapshot = () => ({ cap: 4, running: 1, items: [{ taskId: 'task_1', reason: 'slot', position: 1 }] });
  f.ctx.store.upsertTask({ id: 'task_1', agentId: 'zealot', title: 't', status: 'queued', source: 'ui', requestedModel: 'auto', createdAt: '', updatedAt: '' });
  const p = projects.create({ name: 'Shop' });
  projects.setMembers(p.id, ['zealot', 'scout']);
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const mod: AwayModule = createAwayModule(deps, { projects, ...(opts.now ? { now: opts.now } : {}) });
  (f.ctx as { modules?: unknown }).modules = [mod];
  (f.ctx as { away?: unknown }).away = mod.service;
  const s = await start(f.ctx);
  const events: LegionEvent[] = [];
  f.bus.on((e) => events.push(e));
  const req = (headers: Record<string, string>) => (m: string, path: string, body?: unknown) =>
    fetch(s.base + path, { method: m, headers: { ...headers, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { f, mod, base: s.base, pid: p.id, events, holds, call: req(AUTH), client: req(asClient), anon: req({}), close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('every new route is admin-only: a bearer token gets 403, nobody gets 401, none is a client route', async () => {
  const r = await boot();
  try {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/away'], ['PATCH', '/api/away/app', { notify: { enabled: false } }], ['PATCH', `/api/away/projects/${r.pid}`, { paused: true }],
      ['POST', `/api/away/projects/${r.pid}/seen`, {}], ['POST', `/api/away/projects/${r.pid}/budget-override`, {}],
      ['GET', '/api/attention'], ['GET', '/api/spend'], ['GET', '/api/spend?scope=project&project=' + r.pid],
      ['POST', '/api/approvals/apr_1/hold', { ms: 5000 }],
    ];
    for (const [m, path, body] of routes) {
      assert.equal(isClientRoute(m, path.split('?')[0]!), false, `${m} ${path} must not be a client route`);
      assert.equal((await r.client(m, path, body)).status, 403, `${m} ${path} with a bearer token`);
      assert.equal((await r.anon(m, path, body)).status, 401, `${m} ${path} with nothing`);
    }
    assert.equal(r.holds.length, 0, 'the refused hold changed nothing');
    assert.equal(r.mod.store.project(r.pid).paused, false, 'the refused patch changed nothing');
    assert.equal((await r.call('GET', '/api/away')).status, 200);
  } finally { await r.close(); }
});

test('GET /api/away: defaults for every project; PATCH is validated and kept', async () => {
  const r = await boot();
  try {
    const first = await (await r.call('GET', '/api/away')).json() as { app: { quiet: { enabled: boolean } }; projects: Record<string, { paused: boolean; onSilence: { mode: string }; notify: string }> };
    assert.equal(first.app.quiet.enabled, false);
    assert.deepEqual(first.projects[r.pid], { onSilence: { mode: 'deny', parkMinutes: 3 }, paused: false, budget: null, notify: 'problems' });
    const ok = await r.call('PATCH', `/api/away/projects/${r.pid}`, { paused: true, notify: 'everything' });
    assert.equal(ok.status, 200);
    assert.equal(r.mod.store.project(r.pid).paused, true);
    assert.ok(r.events.some((e) => e.type === 'away.updated'), 'the engine and the app hear about it');
    for (const bad of [{ onSilence: { mode: 'allow', parkMinutes: 3 } }, { paused: 'yes' }, { budget: { limit: 0, period: 'week' } }, { notify: 'loud' }, 'text', null]) {
      const res = await r.call('PATCH', `/api/away/projects/${r.pid}`, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await r.call('PATCH', '/api/away/projects/nope', { paused: true })).status, 404);
    assert.equal((await r.call('PATCH', '/api/away/app', { quiet: { enabled: true, from: '22:00', to: '22:00' } })).status, 400);
    assert.equal((await r.call('PATCH', '/api/away/app', { quiet: { enabled: true, from: '22:00', to: '07:00' } })).status, 200);
    assert.equal(r.mod.store.app().quiet.enabled, true);
    assert.equal(r.mod.service.policy().quiet()?.from, '22:00');
  } finally { await r.close(); }
});

test('Mark as seen uses the core clock; the time is kept per project', async () => {
  const fixed = Date.UTC(2026, 9, 14, 9, 40);
  const r = await boot({ now: () => fixed });
  try {
    const res = await r.call('POST', `/api/away/projects/${r.pid}/seen`, { at: '1999-01-01T00:00:00Z' });
    assert.deepEqual(await res.json(), { looked: new Date(fixed).toISOString() }, 'a time sent by the client is ignored');
    const all = await (await r.call('GET', '/api/away')).json() as { looked: Record<string, string> };
    assert.equal(all.looked[r.pid], new Date(fixed).toISOString());
    assert.equal((await r.call('POST', '/api/away/projects/nope/seen', {})).status, 404);
  } finally { await r.close(); }
});

test('budget: reached once per period with one notice; "run anyway" needs a budget and lasts to the end of the period', async () => {
  const now = new Date(2026, 9, 14, 15).getTime();
  const r = await boot({ now: () => now });
  try {
    assert.equal((await r.call('POST', `/api/away/projects/${r.pid}/budget-override`, {})).status, 409, 'no budget, nothing to run past');
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { budget: { limit: 5, period: 'week' } });
    const svc = r.mod.service;
    svc.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 4 });
    assert.equal(svc.budgetBlocked(r.pid), false);
    svc.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 1.5 });
    assert.equal(svc.budgetBlocked(r.pid), true);
    assert.equal(svc.budgetBlocked(r.pid), true);
    svc.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 1 });
    assert.equal(r.events.filter((e) => e.type === 'budget.reached').length, 1, 'one notice per period');
    assert.equal((await r.call('POST', `/api/away/projects/${r.pid}/budget-override`, {})).status, 200);
    assert.equal(svc.budgetBlocked(r.pid), false, 'run anyway lifts it');
    const until = Date.parse(r.mod.store.project(r.pid).budgetOverrideUntil!);
    assert.equal(until, new Date(2026, 9, 19).getTime(), 'to Monday 00:00');
    // changing the budget starts a fresh decision
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { budget: { limit: 50, period: 'week' } });
    assert.equal(r.mod.store.project(r.pid).budgetOverrideUntil, undefined);
  } finally { await r.close(); }
});

test('pause: the service answers per project', async () => {
  const r = await boot();
  try {
    assert.equal(r.mod.service.isPaused(r.pid), false);
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { paused: true });
    assert.equal(r.mod.service.isPaused(r.pid), true);
    assert.equal(r.mod.service.isPaused('other'), false);
  } finally { await r.close(); }
});

test('spend: app and project scope, bad scope 400, unknown project 404', async () => {
  const now = new Date(2026, 9, 14, 15).getTime();
  const r = await boot({ now: () => now });
  try {
    r.mod.service.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 2 });
    r.mod.service.recordSpend({ taskId: 't2', agentId: 'scout', usd: 1 });
    const app = await (await r.call('GET', '/api/spend')).json() as { week: number; daily: unknown[] };
    assert.equal(app.week, 3);
    assert.equal(app.daily.length, 14);
    const proj = await (await r.call('GET', `/api/spend?scope=project&project=${r.pid}`)).json() as { week: number };
    assert.equal(proj.week, 2);
    assert.equal((await r.call('GET', '/api/spend?scope=galaxy')).status, 400);
    assert.equal((await r.call('GET', '/api/spend?scope=project')).status, 404);
    assert.equal((await r.call('GET', '/api/spend?scope=project&project=nope')).status, 404);
  } finally { await r.close(); }
});

test('spend: the project scope carries the budget verdict the page needs', async () => {
  const now = new Date(2026, 9, 14, 15).getTime();
  const r = await boot({ now: () => now });
  try {
    r.mod.service.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 6 });
    type B = { limited: boolean; reached: boolean; overridden: boolean; spent: number; limit?: number; period?: string; periodEnd?: number };
    const get = async () => (await (await r.call('GET', `/api/spend?scope=project&project=${r.pid}`)).json() as { budget: B }).budget;
    assert.deepEqual(await get(), { limited: false, reached: false, overridden: false, spent: 0 });
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { budget: { limit: 5, period: 'week' } });
    assert.deepEqual(await get(), { limited: true, reached: true, overridden: false, spent: 6, limit: 5, period: 'week', periodEnd: new Date(2026, 9, 19).getTime() });
    await r.call('POST', `/api/away/projects/${r.pid}/budget-override`, {});
    const after = await get();
    assert.equal(after.reached, false);
    assert.equal(after.overridden, true);
    const app = await (await r.call('GET', '/api/spend')).json() as { budget?: unknown };
    assert.equal(app.budget, undefined, 'the app scope has no single budget');
  } finally { await r.close(); }
});

test('spend: the project scope can say what was spent since a moment (the digest header)', async () => {
  const now = new Date(2026, 9, 14, 15).getTime();
  const r = await boot({ now: () => now });
  try {
    r.mod.service.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 2 });
    const since = encodeURIComponent(new Date(now - 3600_000).toISOString());
    const get = async (q: string) => (await (await r.call('GET', `/api/spend?scope=project&project=${r.pid}${q}`)).json() as { sinceUsd?: number }).sinceUsd;
    assert.equal(await get(''), undefined);
    assert.equal(await get(`&since=${since}`), 2);
    assert.equal(await get(`&since=${encodeURIComponent(new Date(now + 3600_000).toISOString())}`), 0);
    assert.equal((await r.call('GET', `/api/spend?scope=project&project=${r.pid}&since=notatime`)).status, 400);
  } finally { await r.close(); }
});

test('hold route: body validated, forwards to the broker', async () => {
  const r = await boot();
  try {
    assert.equal((await r.call('POST', '/api/approvals/apr_1/hold', {})).status, 400);
    assert.equal((await r.call('POST', '/api/approvals/apr_1/hold', { ms: 'soon' })).status, 400);
    assert.equal((await r.call('POST', '/api/approvals/apr_1/hold', { ms: -5 })).status, 400);
    const res = await r.call('POST', '/api/approvals/apr_1/hold', { ms: 8000 });
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(r.holds, [['apr_1', 8000]]);
  } finally { await r.close(); }
});

test('the snapshot carries the queue to everyone, and parked asks and caps to the app only', async () => {
  const r = await boot();
  try {
    const admin = await (await r.call('GET', '/api/state')).json() as { queue: { cap: number; items: unknown[] }; parked: unknown[]; caps: Record<string, unknown> };
    assert.equal(admin.queue.cap, 4);
    assert.equal(admin.queue.items.length, 1);
    assert.deepEqual(admin.parked, []);
    assert.deepEqual(admin.caps, {});
    const token = await (await r.client('GET', '/api/state')).json() as { queue?: unknown; parked?: unknown; caps?: unknown };
    assert.ok(token.queue);
    assert.equal(token.parked, undefined);
    assert.equal(token.caps, undefined);
  } finally { await r.close(); }
});

test('attention counts what waits, by project, and carries no text of any ask', async () => {
  const r = await boot();
  try {
    const secret = 'rm -rf / --SECRET-COMMAND-TEXT';
    r.f.ctx.store.upsertTask({ id: 'task_9', agentId: 'zealot', title: 'agent wrote this title', status: 'running', source: 'ui', requestedModel: 'auto', projectId: r.pid, createdAt: '', updatedAt: '' });
    const approval = { id: 'apr_9', taskId: 'task_9', agentId: 'zealot', toolName: 'Bash', summary: secret, input: { command: secret }, at: new Date().toISOString() };
    r.f.pending.push(approval);
    r.f.bus.emit({ type: 'approval.requested', approval });
    const view = await (await r.call('GET', '/api/attention')).json() as { total: number; byProject: Record<string, number> };
    assert.equal(view.total, 1);
    assert.deepEqual(view.byProject, { [r.pid]: 1 });
    const sent = r.events.filter((e) => e.type === 'attention.updated');
    assert.ok(sent.length >= 1);
    const everything = JSON.stringify([view, sent]);
    assert.ok(!everything.includes('SECRET-COMMAND-TEXT'), 'no command text');
    assert.ok(!everything.includes('agent wrote this title'), 'no agent-written text');
    r.f.pending.length = 0;
    r.f.bus.emit({ type: 'approval.resolved', approvalId: 'apr_9', allowed: false });
    const after = await (await r.call('GET', '/api/attention')).json() as { total: number };
    assert.equal(after.total, 0);
  } finally { await r.close(); }
});

test('the away folder is protected from the agents\' file tools', async () => {
  const r = await boot();
  try {
    const paths = r.mod.protectedPaths!();
    assert.equal(paths.length, 1);
    assert.ok(/away$/.test(paths[0]!));
    assert.equal(paths[0], r.mod.store.folder);
  } finally { await r.close(); }
});

test('reading the state or the queue never sends a budget notice; setting a budget below what was spent does, once', async () => {
  const now = new Date(2026, 9, 14, 15).getTime();
  const r = await boot({ now: () => now });
  try {
    r.mod.service.recordSpend({ taskId: 't', agentId: 'zealot', projectId: r.pid, usd: 6 });
    const count = () => r.events.filter((e) => e.type === 'budget.reached').length;
    assert.equal(count(), 0, 'no budget yet');
    // a stored budget below the spend, not yet announced: reading must not announce it
    r.mod.store.patchProject(r.pid, { budget: { limit: 5, period: 'week' } });
    for (let i = 0; i < 3; i++) { await r.call('GET', '/api/state'); r.mod.service.budgetBlocked(r.pid); r.mod.service.budgetRollsAt(r.pid); }
    assert.equal(count(), 0, 'reading is side-effect free');
    assert.equal(r.mod.service.budgetBlocked(r.pid), true);
    // the owner sets it through the route: that is the moment to tell once
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { budget: { limit: 4, period: 'week' } });
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { budget: { limit: 3, period: 'week' } });
    assert.equal(count(), 1);
    assert.equal(r.mod.service.budgetRollsAt(r.pid), new Date(2026, 9, 19).getTime(), 'the end of the week');
    await r.call('PATCH', `/api/away/projects/${r.pid}`, { budget: null });
    assert.equal(r.mod.service.budgetRollsAt(r.pid), undefined, 'no budget, no roll-over');
  } finally { await r.close(); }
});

test('queue.updated on the event stream leaves out a hidden agent\'s tasks, like the snapshot', async () => {
  const r = await boot();
  try {
    const hidden = { ...r.f.agents.get('scout')!, id: 'assayer', name: 'Assayer', requires: 'bsv' as const };
    r.f.agents.set('assayer', hidden);
    for (const [id, agentId] of [['task_v', 'scout'], ['task_h', 'assayer']] as const) {
      r.f.ctx.store.upsertTask({ id, agentId, title: id, status: 'queued', source: 'ui', requestedModel: 'auto', createdAt: '', updatedAt: '' });
    }
    (r.f.ctx.engine as unknown as Record<string, unknown>).queueSnapshot = () => ({ cap: 4, running: 4, items: [{ taskId: 'task_v', reason: 'slot', position: 1 }, { taskId: 'task_h', reason: 'slot', position: 2 }] });
    const snap = await (await r.call('GET', '/api/state')).json() as { queue: { items: Array<{ taskId: string }> } };
    assert.deepEqual(snap.queue.items.map((i) => i.taskId), ['task_v']);
    const res = await fetch(r.base + '/api/events', { headers: AUTH });
    const reader = res.body!.getReader();
    await reader.read();
    r.f.bus.emit({ type: 'queue.updated', queue: { cap: 4, running: 4, items: [{ taskId: 'task_v', reason: 'slot', position: 1 }, { taskId: 'task_h', reason: 'slot', position: 2 }] } });
    let text = '';
    const dec = new TextDecoder();
    for (let i = 0; i < 20 && !text.includes('queue.updated'); i++) { const { value } = await reader.read(); text += dec.decode(value ?? new Uint8Array()); }
    await reader.cancel();
    assert.ok(text.includes('queue.updated'));
    assert.ok(text.includes('task_v'));
    assert.ok(!text.includes('task_h'), 'the hidden agent\'s task is not in the stream');
  } finally { await r.close(); }
});

test('the app can start a task "after" the agent\'s other run (startAfter); a bearer-only client cannot, and a non-boolean is refused', async () => {
  const r = await boot();
  try {
    const seen: Array<{ startAfter?: unknown; source?: string }> = [];
    const real = (r.f.ctx.engine as unknown as { startTask: (p: unknown) => unknown }).startTask.bind(r.f.ctx.engine);
    (r.f.ctx.engine as unknown as Record<string, unknown>).startTask = (p: { startAfter?: unknown; source?: string }) => { seen.push({ startAfter: p.startAfter, source: p.source }); return real(p); };
    const ok = await r.call('POST', '/api/tasks', { agentId: 'zealot', prompt: 'second', projectId: r.pid, startAfter: true });
    assert.equal(ok.status, 201);
    assert.deepEqual(seen[0], { startAfter: true, source: 'ui' });
    const plain = await r.call('POST', '/api/tasks', { agentId: 'zealot', prompt: 'plain', projectId: r.pid });
    assert.equal(plain.status, 201);
    assert.equal(seen[1]!.startAfter, undefined, 'absent stays absent');
    assert.equal((await r.client('POST', '/api/tasks', { agentId: 'zealot', prompt: 'x', startAfter: true })).status, 403, 'a token client cannot queue behind a run');
    assert.equal((await r.call('POST', '/api/tasks', { agentId: 'zealot', prompt: 'x', startAfter: 'yes' })).status, 400);
  } finally { await r.close(); }
});

test('the one notice for a reached budget says whether "Stop at the budget" is on for that project', () => {
  const root = cleanupTemp('legion-away-stop-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const on = projects.create({ name: 'On' }); const off = projects.create({ name: 'Off' }); const unknown = projects.create({ name: 'Unknown' });
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const core = createAwayCore({
    dataDir: data, bus, tasks: { getTask: () => undefined }, projects,
    stopsAtBudget: (pid) => { if (pid === unknown.id) throw new Error('gates not readable'); return pid !== off.id; },
  });
  for (const p of [on, off, unknown]) {
    core.store.patchProject(p.id, { budget: { limit: 1, period: 'day' } });
    core.service.recordSpend({ taskId: 't', agentId: 'zealot', projectId: p.id, usd: 2 });
  }
  const stopsOf = (pid: string) => events.filter((e) => e.type === 'budget.reached' && e.projectId === pid).map((e) => (e as { stops?: boolean }).stops);
  assert.deepEqual(stopsOf(on.id), [true]);
  assert.deepEqual(stopsOf(off.id), [false]);
  assert.deepEqual(stopsOf(unknown.id), [true], 'a gate that cannot be read is on');
});
