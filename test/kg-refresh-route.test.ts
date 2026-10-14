/**
 * POST /api/kg/nodes/:id/refresh: the Lint tab's Refresh button. Admin-only, one Archivist run per note at a time, and the stale rows
 * of GET /api/kg/lint carry what the audit list shows (title, type, source count, confidence, author, the live run).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { isClientRoute } from '../src/core/admin.js';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { addKgRoutes } from '../src/core/kg/routes.js';
import { agentActor, SYSTEM } from '../src/core/kg/types.js';
import { makeFakes, mkAgent, start, TOKEN, TEST_ADMIN } from './helpers-c.js';
import { HUMAN, tmpDir } from './kg-helpers.js';

const DAY = 86_400_000;
const open: Array<() => Promise<void>> = [];
after(async () => { for (const c of open) await c().catch(() => undefined); });

async function setup(opts: { archivist?: boolean } = {}) {
  const f = makeFakes({ holdRuns: true });
  if (opts.archivist !== false) f.agents.set('archivist', mkAgent('archivist', 'Archivist'));
  let nowMs = Date.now(); // nodes are stamped with the real clock; only reads (lint, refresh) use this one
  const started: Array<{ agentId: string; prompt: string; source: string; projectId?: string }> = [];
  const realStart = f.ctx.engine.startTask.bind(f.ctx.engine);
  f.ctx.engine.startTask = (p: any) => { started.push({ agentId: p.agentId, prompt: p.prompt, source: p.source, projectId: p.projectId }); return realStart(p); };
  const mod = createKnowledgeModule(
    { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: tmpDir(), bsvEnabled: () => false },
    { debounceMs: 20, now: () => new Date(nowMs) },
  );
  f.ctx.modules = [mod];
  const srv = await start(f.ctx);
  const call = async (method: string, path: string, body?: unknown, who: 'admin' | 'bearer' | 'none' = 'admin') => {
    const headers: Record<string, string> = {};
    if (who !== 'none') headers.Authorization = `Bearer ${TOKEN}`;
    if (who === 'admin') headers['X-Legion-Admin'] = TEST_ADMIN;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const close = async () => { await mod.dispose?.(); await srv.close(); };
  open.push(close);
  return { ...f, mod, call, close, started, advanceDays: (d: number) => { nowMs += d * DAY; } };
}

test('refresh is admin-only: 401 without a token, 403 with the bearer alone, and it is not a client route', async () => {
  const s = await setup();
  const id = s.mod.graph().upsertNode(HUMAN, { title: 'Old note' }).node.id;
  s.advanceDays(200);
  assert.equal(isClientRoute('POST', `/api/kg/nodes/${id}/refresh`), false);
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/refresh`, {}, 'none')).status, 401);
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/refresh`, {}, 'bearer')).status, 403);
  assert.equal(s.started.length, 0, 'a refused call starts no run');
  await s.close();
});

test('an unknown note is a 404 and starts nothing', async () => {
  const s = await setup();
  const r = await s.call('POST', '/api/kg/nodes/n_missing/refresh', {});
  assert.equal(r.status, 404);
  assert.equal(s.started.length, 0);
  await s.close();
});

test('a stale note starts exactly one Archivist run from the app, with the prompt builder text and no project', async () => {
  const s = await setup();
  const id = s.mod.graph().upsertNode(HUMAN, { title: 'Shopify theme tips', sources: [{ ref: 'https://shopify.dev/docs/themes' }] }).node.id;
  s.advanceDays(200.5);
  const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {});
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.taskId, 'string');
  assert.equal(s.started.length, 1);
  const st = s.started[0]!;
  assert.equal(st.agentId, 'archivist');
  assert.equal(st.source, 'ui');
  assert.equal(st.projectId, undefined);
  assert.match(st.prompt, new RegExp(id));
  assert.match(st.prompt, /Shopify theme tips/);
  assert.match(st.prompt, /https:\/\/shopify\.dev\/docs\/themes/);
  assert.match(st.prompt, /200 days/);
  await s.close();
});

test('a second refresh of the same note while the run is live is refused with a plain 409; another note is fine', async () => {
  const s = await setup();
  const a = s.mod.graph().upsertNode(HUMAN, { title: 'Note A' }).node.id;
  const b = s.mod.graph().upsertNode(HUMAN, { title: 'Note B' }).node.id;
  s.advanceDays(200);
  const first = await s.call('POST', `/api/kg/nodes/${a}/refresh`, {});
  assert.equal(first.status, 200);
  const again = await s.call('POST', `/api/kg/nodes/${a}/refresh`, {});
  assert.equal(again.status, 409);
  assert.match(again.body.error ?? again.body.message ?? JSON.stringify(again.body), /already being refreshed/i);
  assert.equal(s.started.length, 1, 'the second call started no run');
  assert.equal((await s.call('POST', `/api/kg/nodes/${b}/refresh`, {})).status, 200);
  // the first run ends: the note can be refreshed again
  s.tasks.get(first.body.taskId)!.status = 'done';
  assert.equal((await s.call('POST', `/api/kg/nodes/${a}/refresh`, {})).status, 200);
  assert.equal(s.started.length, 3);
  await s.close();
});

test('a built-in note is refused with 409 and starts nothing', async () => {
  const s = await setup();
  const seed = s.mod.graph().upsertNode(SYSTEM, { title: 'Built-in note', type: 'concept' }).node.id;
  s.advanceDays(200);
  const r = await s.call('POST', `/api/kg/nodes/${seed}/refresh`, {});
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /built-in/i);
  assert.equal(s.started.length, 0);
  await s.close();
});

test('a note updated a few days ago is refused with 409 and starts nothing', async () => {
  const s = await setup();
  const id = s.mod.graph().upsertNode(HUMAN, { title: 'Fresh note' }).node.id;
  const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {});
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /can be refreshed once it is 30 days old/);
  assert.equal(s.started.length, 0);
  await s.close();
});

test('with no Archivist on the roster the answer is a plain 404', async () => {
  const s = await setup({ archivist: false });
  const id = s.mod.graph().upsertNode(HUMAN, { title: 'Old note' }).node.id;
  s.advanceDays(200);
  const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {});
  assert.equal(r.status, 404);
  assert.match(JSON.stringify(r.body), /Archivist/);
  await s.close();
});

test('a run that fails to start leaves the note free to try again', async () => {
  const s = await setup({ archivist: false });
  const id = s.mod.graph().upsertNode(HUMAN, { title: 'Old note' }).node.id;
  s.advanceDays(200);
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/refresh`, {})).status, 404);
  s.agents.set('archivist', mkAgent('archivist', 'Archivist'));
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/refresh`, {})).status, 200);
  await s.close();
});

test('GET /api/kg/lint: stale rows carry what the audit shows, and the live run until it ends', async () => {
  const s = await setup();
  const g = s.mod.graph();
  const mine = g.upsertNode(HUMAN, { title: 'Shopify theme tips', type: 'concept', confidence: 0.3, sources: [{ ref: 'https://a.test' }, { ref: 'https://b.test' }] }).node.id;
  const seed = g.upsertNode(SYSTEM, { title: 'Built-in note', type: 'concept' }).node.id;
  s.advanceDays(200);
  let lint = (await s.call('GET', '/api/kg/lint')).body;
  const row = lint.stale.find((x: any) => x.id === mine);
  assert.equal(row.title, 'Shopify theme tips');
  assert.equal(row.type, 'concept');
  assert.equal(row.sourceCount, 2);
  assert.equal(row.confidence, 0.3);
  assert.equal(row.createdBy, 'human');
  assert.equal(row.refreshTaskId, undefined);
  assert.equal(lint.stale.find((x: any) => x.id === seed).createdBy, 'system');
  const run = await s.call('POST', `/api/kg/nodes/${mine}/refresh`, {});
  lint = (await s.call('GET', '/api/kg/lint')).body;
  assert.equal(lint.stale.find((x: any) => x.id === mine).refreshTaskId, run.body.taskId);
  s.tasks.get(run.body.taskId)!.status = 'done';
  lint = (await s.call('GET', '/api/kg/lint')).body;
  assert.equal(lint.stale.find((x: any) => x.id === mine).refreshTaskId, undefined);
  await s.close();
});

test('a note that belongs to a project starts the run in that project', async () => {
  const handlers = new Map<string, (c: any) => unknown>();
  const started: any[] = [];
  const node = { id: 'n_p', type: 'concept', title: 'Project note', body: '', tags: [], scope: 'shared', createdBy: 'scout', projectId: 'proj_1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const graph = { getNode: () => node, canSeeNode: () => true, hasPendingProposalFor: () => false } as any;
  addKgRoutes((m, p, h) => { handlers.set(`${m} ${p}`, h); }, {
    graph: () => graph, bsvEnabled: () => false,
    refresh: { agentId: 'archivist', now: () => Date.parse('2026-10-01T00:00:00Z'), start: (a) => { started.push(a); return { id: 'task_x' } as any; }, isLive: () => false },
  });
  const out = await handlers.get('POST /api/kg/nodes/:id/refresh')!({ params: ['n_p'], url: new URL('http://x/'), body: {} }) as { taskId: string };
  assert.equal(out.taskId, 'task_x');
  assert.equal(started[0].projectId, 'proj_1');
});

test('an untrusted, unreviewed note is refused with plain words and starts nothing', async () => {
  const s = await setup();
  const id = s.mod.graph().upsertNode(HUMAN, { title: 'From the web', sources: [{ ref: 'https://evil.test/x', untrusted: true }] }).node.id;
  s.advanceDays(200);
  const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {});
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /Review this note before refreshing it\./);
  assert.equal(s.started.length, 0);
  const row = (await s.call('GET', '/api/kg/lint')).body.stale.find((x: any) => x.id === id);
  assert.equal(row.refreshBlock, 'untrusted');
  await s.close();
});

test('a note with a proposal already in the Inbox is refused, and the pending copy itself cannot be refreshed', async () => {
  const s = await setup();
  const g = s.mod.graph();
  const id = g.upsertNode(HUMAN, { title: 'Theme tips', body: 'old' }).node.id;
  const prop = g.upsertNode(agentActor('archivist'), { id, body: 'new text' });
  assert.equal(prop.pending, true);
  s.advanceDays(200);
  const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {});
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /already in your Inbox/);
  const pend = await s.call('POST', `/api/kg/nodes/${prop.node.id}/refresh`, {});
  assert.equal(pend.status, 409);
  assert.match(JSON.stringify(pend.body), /waiting in your Inbox/);
  assert.equal(s.started.length, 0);
  const lint = (await s.call('GET', '/api/kg/lint')).body;
  assert.equal(lint.stale.find((x: any) => x.id === id).refreshBlock, 'proposal');
  await s.close();
});

test('a private note of another agent is refused: the Archivist cannot read it', async () => {
  const s = await setup();
  const id = s.mod.graph().upsertNode(agentActor('scout'), { title: 'Scout private', scope: 'agent:scout' }).node.id;
  s.advanceDays(200);
  const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {});
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /cannot read/);
  assert.equal(s.started.length, 0);
  await s.close();
});

test('at most three refreshes run at once; a fourth waits', async () => {
  const s = await setup();
  const ids = [1, 2, 3, 4].map((i) => s.mod.graph().upsertNode(HUMAN, { title: `Note ${i}` }).node.id);
  s.advanceDays(200);
  const runs: string[] = [];
  for (const id of ids.slice(0, 3)) { const r = await s.call('POST', `/api/kg/nodes/${id}/refresh`, {}); assert.equal(r.status, 200); runs.push(r.body.taskId); }
  const fourth = await s.call('POST', `/api/kg/nodes/${ids[3]}/refresh`, {});
  assert.equal(fourth.status, 409);
  assert.match(JSON.stringify(fourth.body), /Three refreshes are running\. Wait for one to finish\./);
  assert.equal(s.started.length, 3);
  s.tasks.get(runs[0]!)!.status = 'done';
  assert.equal((await s.call('POST', `/api/kg/nodes/${ids[3]}/refresh`, {})).status, 200);
  await s.close();
});

test('Still current: admin-only, takes the note out of the stale list and out of Refresh', async () => {
  const s = await setup();
  const g = s.mod.graph();
  const id = g.upsertNode(HUMAN, { title: 'Checked by me', props: { keep: 'this' } }).node.id;
  const seed = g.upsertNode(SYSTEM, { title: 'Built-in note' }).node.id;
  s.advanceDays(200);
  assert.equal(isClientRoute('POST', `/api/kg/nodes/${id}/checked`), false);
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/checked`, {}, 'none')).status, 401);
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/checked`, {}, 'bearer')).status, 403);
  assert.equal((await s.call('POST', '/api/kg/nodes/n_missing/checked', {})).status, 404);
  assert.equal((await s.call('POST', `/api/kg/nodes/${seed}/checked`, {})).status, 409);
  assert.ok((await s.call('GET', '/api/kg/lint')).body.stale.some((x: any) => x.id === id));
  const ok = await s.call('POST', `/api/kg/nodes/${id}/checked`, {});
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.checkedAt, 'string');
  assert.ok(!(await s.call('GET', '/api/kg/lint')).body.stale.some((x: any) => x.id === id), 'no longer stale');
  assert.equal(g.getNode(HUMAN, id)!.props?.keep, 'this', 'other props are kept');
  assert.equal(g.getNode(HUMAN, id)!.trust ?? 'human', 'human', 'trust is untouched');
  assert.equal((await s.call('POST', `/api/kg/nodes/${id}/refresh`, {})).status, 409, 'just checked, so too fresh to refresh');
  await s.close();
});
