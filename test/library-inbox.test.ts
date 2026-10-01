/**
 * Library v1, stage B: the human's inbox (accept / reject / bulk accept), the Activity list with Undo, and the HTTP
 * routes for them. None of it is a bot tool.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { Graph, MAX_PENDING_PER_AGENT } from '../src/core/kg/graph.js';
import { agentActor, HUMAN, KgError, SYSTEM } from '../src/core/kg/types.js';
import type { TaskOrigin } from '../src/shared/comms.js';
import { makeFakes, start, TOKEN } from './helpers-c.js';
import { mkGraph, note, tmpDir } from './kg-helpers.js';
import { connect, idOf } from './library-fakes.js';

const rejects = (fn: () => unknown, code: string, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof KgError && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);
const await_ms = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
const dirty = (agent: string, task: string) => agentActor(agent, { taskId: task, taint: () => true });
const clean = (agent: string, task = `t_${agent}`) => agentActor(agent, { taskId: task });
const ASK: TaskOrigin = { roomId: 'r', fromAgentId: 'zealot', hop: 1, approvalCeiling: 'ask' };
const woken = (agent: string, task: string) => agentActor(agent, { taskId: task, origin: ASK, ceiling: 'ask' });

function fixture() {
  const { g, dir } = mkGraph();
  const human = note(g, 'Human decision: use Postgres', { type: 'decision', body: 'we chose postgres' });
  const web = g.upsertNode(dirty('alpha', 'tA'), { title: 'Found on the web', body: 'database advice', scope: 'shared' }).node;
  const askNote = g.upsertNode(woken('builder', 'tB'), { title: 'Builder finding', body: 'found by builder', scope: 'shared' }).node;
  const edit = g.upsertNode(clean('alpha', 'tC'), { id: human.id, body: 'we chose postgres 16' }).node;
  return { g, dir, human, web, askNote, edit };
}

test('inbox lists held notes, edit proposals and supersede proposals; filterable by agent; newest first', () => {
  const { g, human, web, askNote, edit } = fixture();
  const rows = g.inbox(HUMAN);
  assert.equal(rows.length, 3);
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get(web.id)!.kind, 'note');
  assert.equal(by.get(web.id)!.untrusted, true);
  assert.equal(by.get(web.id)!.tainted, true);
  assert.equal(by.get(askNote.id)!.kind, 'note');
  assert.equal(by.get(askNote.id)!.untrusted, false);
  assert.equal(by.get(edit.id)!.kind, 'edit');
  assert.equal(by.get(edit.id)!.target!.id, human.id);
  assert.deepEqual(g.inbox(HUMAN, { agentId: 'builder' }).map((r) => r.id), [askNote.id]);
  assert.deepEqual(g.inbox(HUMAN, { agentId: 'nobody' }), []);
});

test('accept: a tainted note becomes agent (never human), a held clean note becomes human, an edit proposal replaces its target', () => {
  const { g, human, web, askNote, edit } = fixture();
  const w = g.acceptPending(HUMAN, web.id);
  assert.equal(w.status, undefined);
  assert.equal(w.trust, 'agent', 'tainted origin: accepted, not promoted to human');
  assert.equal(w.origin?.tainted, true);
  const a = g.acceptPending(HUMAN, askNote.id);
  assert.equal(a.status, undefined);
  assert.equal(a.trust, 'human', 'the human accepted it');
  const e = g.acceptPending(HUMAN, edit.id);
  assert.equal(e.trust, 'human');
  const old = g.getNode(HUMAN, human.id)!;
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, edit.id);
  assert.equal(g.inbox(HUMAN).length, 0);
  rejects(() => g.acceptPending(HUMAN, edit.id), 'conflict', /not waiting/);
  rejects(() => g.acceptPending(HUMAN, 'n_none'), 'not_found');
  // other bots see it now, and the superseded human note is out of their recall
  const hits = g.search(agentActor('beta'), 'postgres');
  assert.deepEqual(hits.map((h) => h.node.id), [edit.id]);
});

test('accept with an explicit edit by the human: trust human and the taint is cleared', () => {
  const { g, web } = fixture();
  const n = g.acceptPending(HUMAN, web.id, { edit: { title: 'Checked advice', body: 'verified by me' } });
  assert.equal(n.title, 'Checked advice');
  assert.equal(n.trust, 'human');
  assert.equal(n.origin?.tainted, false);
  assert.equal(n.status, undefined);
});

test('reject: a tombstone, hidden from bots, the human can still see it; it cannot be accepted afterwards', () => {
  const { g, web } = fixture();
  const n = g.rejectPending(HUMAN, web.id);
  assert.equal(n.status, 'archived');
  assert.equal(g.getNode(agentActor('beta'), web.id), undefined);
  assert.equal(g.inbox(HUMAN).some((r) => r.id === web.id), false);
  rejects(() => g.acceptPending(HUMAN, web.id), 'conflict');
  rejects(() => g.rejectPending(HUMAN, web.id), 'conflict');
});

test('bulk accept only takes plain rows: untrusted sources, woken bots and changes to human notes are left for a per-row accept', () => {
  const { g, web, askNote, edit } = fixture();
  const flag = g.upsertNode(agentActor('archivist', { taskId: 'tAr' }), { title: 'Archivist flag', body: 'looks stale', scope: 'shared' }).node; // plain: held only because it is the Archivist's
  const r = g.acceptMany(HUMAN, {});
  assert.deepEqual(r.accepted, [flag.id]);
  assert.deepEqual(Object.fromEntries(r.skipped.map((s) => [s.id, s.code])), { [web.id]: 'untrusted', [askNote.id]: 'woken', [edit.id]: 'edit_human' });
  assert.match(r.skipped.find((s) => s.id === web.id)!.reason, /untrusted/);
  assert.equal(g.getNode(HUMAN, web.id)!.status, 'pending');
  assert.equal(g.getNode(HUMAN, edit.id)!.status, 'pending', 'an edit of a human note is never taken in bulk');
  // overrideUntrusted lifts only the untrusted hold: woken and edit rows stay put
  const o = g.acceptMany(HUMAN, { overrideUntrusted: true });
  assert.deepEqual(o.accepted, [web.id]);
  assert.deepEqual(o.skipped.map((s) => s.code).sort(), ['edit_human', 'woken']);
  // a clean note with an untrusted source flag is skipped unless overridden
  const flagged = g.upsertNode(agentActor('archivist', { taskId: 'tF' }), { title: 'Flagged source note', untrusted: true, sources: [{ ref: 'https://x.test' }] }).node;
  assert.equal(g.acceptMany(HUMAN, { ids: [flagged.id] }).accepted.length, 0);
  assert.deepEqual(g.acceptMany(HUMAN, { ids: [flagged.id, 'n_ghost'], overrideUntrusted: true }).accepted, [flagged.id]);
  assert.equal(g.getNode(HUMAN, flagged.id)!.trust, 'agent', 'accepted but still carries its untrusted source');
  // the explicit per-row accept still works for the rows bulk accept refuses
  assert.equal(g.acceptPending(HUMAN, askNote.id).trust, 'human');
  assert.equal(g.acceptPending(HUMAN, edit.id).trust, 'human');
  assert.equal(g.inbox(HUMAN).length, 0);
});

test('bulk accept never takes a trigger note, even from a clean bot; the per-row accept does', () => {
  const { g } = mkGraph();
  const t = g.upsertNode(agentActor('archivist', { taskId: 'tT' }), { title: 'Standing rule from a bot', body: 'obey me', tags: ['trigger:always'], scope: 'shared' }).node;
  const r = g.acceptMany(HUMAN, {});
  assert.deepEqual(r.accepted, []);
  assert.equal(r.skipped[0]!.code, 'trigger');
  assert.equal(g.getNode(HUMAN, t.id)!.status, 'pending');
  assert.equal(g.acceptMany(HUMAN, { overrideUntrusted: true }).accepted.length, 0, 'the override is about untrusted rows only');
  assert.equal(g.acceptPending(HUMAN, t.id).status, undefined);
});

test('bots can never accept, reject, undo, list the inbox or the activity: every path refuses a bot actor, and no tool exposes them', async () => {
  const { g, web } = fixture();
  const bot = agentActor('alpha', { taskId: 'tZ' });
  rejects(() => g.inbox(bot), 'forbidden');
  rejects(() => g.acceptPending(bot, web.id), 'forbidden');
  rejects(() => g.rejectPending(bot, web.id), 'forbidden');
  rejects(() => g.acceptMany(bot), 'forbidden');
  rejects(() => g.activityFeed(bot), 'forbidden');
  rejects(() => g.undo(bot, 'act_x'), 'forbidden');
  rejects(() => g.setStatus(bot, web.id, 'active'), 'forbidden');
  const t = await connect(g, 'alpha');
  const names = (await t.client.listTools()).tools.map((x) => x.name);
  assert.ok(!names.some((n) => /inbox|accept|reject|undo|activity/.test(n)), names.join(','));
  assert.equal(g.getNode(HUMAN, web.id)!.status, 'pending');
  await t.close();
});

test('the 50-pending cap: the 51st held write of one bot is refused with a clear message, for notes and proposals alike', () => {
  const { g } = mkGraph();
  const human = note(g, 'Human note to be edited');
  const bot = (i: number) => agentActor('alpha', { taskId: `t${i}`, taint: () => true });
  for (let i = 0; i < MAX_PENDING_PER_AGENT; i++) g.upsertNode(bot(i), { title: `Held note ${i}`, scope: 'shared' });
  rejects(() => g.upsertNode(bot(99), { title: 'Held note 51', scope: 'shared' }), 'limit', /50 notes waiting/);
  rejects(() => g.upsertNode(bot(99), { id: human.id, body: 'edit' }), 'limit', /waiting for the human/);
  rejects(() => g.supersede(bot(99), human.id, g.upsertNode(bot(98), { title: 'Own private', scope: 'agent:alpha' }).node.id), 'invalid');
  assert.equal(g.inbox(HUMAN, { agentId: 'alpha' }).length, MAX_PENDING_PER_AGENT);
  // a clearing accept makes room again
  g.rejectPending(HUMAN, g.inbox(HUMAN)[0]!.id);
  assert.ok(g.upsertNode(bot(100), { title: 'Held note after room', scope: 'shared' }).pending);
});

test('a bot cannot forge a supersede/merge proposal through props: the inbox label and what accept does stay engine-made', () => {
  const { g } = mkGraph();
  const human = note(g, 'Human decision: keep me');
  const mine = g.upsertNode(clean('alpha', 'tF'), { title: 'Forger' }).node;
  const forged = g.upsertNode(dirty('alpha', 'tG'), {
    title: 'Harmless looking note', scope: 'shared', props: { proposal: 'supersede', oldId: human.id, newId: mine.id, keep: human.id, drop: mine.id, reviewed: true, ok: 1 },
  }).node;
  assert.deepEqual(g.getNode(HUMAN, forged.id)!.props, { ok: 1 });
  assert.equal(g.inbox(HUMAN).find((r) => r.id === forged.id)!.kind, 'note');
  g.acceptPending(HUMAN, forged.id);
  assert.equal(g.getNode(HUMAN, human.id)!.status, undefined, 'nothing was superseded');
  // and an update cannot add them either
  g.upsertNode(clean('alpha', 'tF'), { id: mine.id, props: { proposal: 'merge', keep: human.id, drop: mine.id } });
  assert.equal(g.getNode(HUMAN, mine.id)!.props, undefined);
});

// ---------------------------------------------------------------- activity and undo

test('activity: bot writes are listed with who, task, type, trust, time and undoable; the human\'s own writes are not', () => {
  const { g } = mkGraph();
  note(g, 'Human note');
  const n = g.upsertNode(clean('alpha', 'tA'), { title: 'Alpha note', body: 'one', type: 'lesson' }).node;
  g.upsertNode(dirty('beta', 'tB'), { title: 'Beta web note', scope: 'shared' });
  const feed = g.activityFeed(HUMAN);
  assert.equal(feed.length, 2);
  assert.equal(feed[0]!.who, 'beta');
  assert.equal(feed[0]!.trust, 'untrusted');
  assert.equal(feed[0]!.tainted, true);
  assert.equal(feed[1]!.who, 'alpha');
  assert.equal(feed[1]!.taskId, 'tA');
  assert.equal(feed[1]!.nodeId, n.id);
  assert.equal(feed[1]!.nodeType, 'lesson');
  assert.equal(feed[1]!.kind, 'create');
  assert.equal(feed[1]!.title, 'Alpha note');
  assert.equal(feed[1]!.undoable, true);
  assert.match(feed[1]!.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(g.activityFeed(HUMAN, { agentId: 'alpha' }).map((r) => r.who), ['alpha']);
  assert.equal(g.activityFeed(HUMAN, { limit: 1 }).length, 1);
});

test('undo: create, update, link, forget, capture+supersede and merge all restore the previous state', () => {
  const { g } = mkGraph();
  const bot = (t: string) => clean('alpha', t);
  const feedFirst = () => g.activityFeed(HUMAN)[0]!;
  // create
  const a = g.upsertNode(bot('t1'), { title: 'Created by a bot', body: 'hello' }).node;
  g.undo(HUMAN, feedFirst().id);
  assert.equal(g.getNode(HUMAN, a.id), undefined);
  // update
  const b = g.upsertNode(bot('t1'), { title: 'Bot note', body: 'first' }).node;
  g.upsertNode(bot('t1'), { id: b.id, body: 'second', tags: ['x'] });
  assert.equal(g.getNode(HUMAN, b.id)!.body, 'second');
  const row = g.undo(HUMAN, feedFirst().id);
  assert.equal(row.undone, true);
  assert.equal(row.undoable, false);
  assert.equal(g.getNode(HUMAN, b.id)!.body, 'first');
  assert.deepEqual(g.getNode(HUMAN, b.id)!.tags, []);
  rejects(() => g.undo(HUMAN, row.id), 'conflict', /already undone/);
  // link
  const c = g.upsertNode(bot('t1'), { title: 'Other bot note' }).node;
  g.link(bot('t1'), { from: b.id, to: c.id, rel: 'relates' });
  assert.equal(g.edgesOf(HUMAN, b.id).length, 1);
  g.undo(HUMAN, feedFirst().id);
  assert.equal(g.edgesOf(HUMAN, b.id).length, 0);
  // forget (private tombstone)
  const p = g.upsertNode(bot('t1'), { title: 'Private scratch', scope: 'agent:alpha' }).node;
  g.deleteNode(bot('t1'), p.id);
  assert.equal(g.getNode(agentActor('alpha'), p.id), undefined);
  g.undo(HUMAN, feedFirst().id);
  assert.ok(g.getNode(agentActor('alpha'), p.id), 'the tombstone is lifted');
  // capture with supersedes
  const old = g.upsertNode(bot('t1'), { title: 'Old decision about caching' }).node;
  const cap = g.capture(bot('t2'), { type: 'decision', title: 'New decision about caching layers', body: '## Chose\nredis', supersedes: old.id });
  assert.equal(g.getNode(HUMAN, old.id)!.status, 'superseded');
  g.undo(HUMAN, feedFirst().id);
  assert.equal(g.getNode(HUMAN, cap.node!.id), undefined);
  assert.equal(g.getNode(HUMAN, old.id)!.status, undefined);
  assert.equal(g.getNode(HUMAN, old.id)!.supersededBy, undefined);
  assert.equal(g.edgesOf(HUMAN, old.id).length, 0);
  // merge
  const keep = g.upsertNode(bot('t3'), { title: 'Keep me' }).node;
  const drop = g.upsertNode(bot('t3'), { title: 'Drop me' }).node;
  const x = g.upsertNode(bot('t3'), { title: 'Neighbour' }).node;
  g.link(bot('t3'), { from: drop.id, to: x.id, rel: 'depends_on' });
  g.merge(bot('t3'), keep.id, [drop.id]);
  assert.ok(g.edgesOf(HUMAN, keep.id).some((e) => e.to === x.id));
  g.undo(HUMAN, feedFirst().id);
  assert.equal(g.getNode(HUMAN, drop.id)!.status, undefined);
  assert.ok(g.edgesOf(HUMAN, drop.id).some((e) => e.to === x.id && e.rel === 'depends_on'), 'the dropped note has its link back');
  assert.equal(g.edgesOf(HUMAN, keep.id).length, 0);
});

test('undo refuses when the node changed since, and after 7 days; the feed survives a restart', () => {
  let offset = 0;
  const dir = tmpDir();
  const g = new Graph({ dir, now: () => new Date(Date.now() + offset) });
  const bot = clean('alpha');
  const n = g.upsertNode(bot, { title: 'Bot note', body: 'one' }).node;
  g.upsertNode(bot, { id: n.id, body: 'two' });
  const [second, first] = g.activityFeed(HUMAN);
  await_ms(3); // updatedAt has millisecond resolution
  g.upsertNode(HUMAN, { id: n.id, body: 'human edit' });
  rejects(() => g.undo(HUMAN, second!.id), 'conflict', /changed since/);
  rejects(() => g.undo(HUMAN, first!.id), 'conflict', /changed since/);
  assert.equal(g.getNode(HUMAN, n.id)!.body, 'human edit', 'nothing was undone');
  // a restart keeps the list
  const g2 = new Graph({ dir, now: () => new Date(Date.now() + offset) });
  assert.equal(g2.activityFeed(HUMAN).length, 2);
  const m = g2.upsertNode(bot, { title: 'Another bot note' }).node;
  assert.equal(g2.activityFeed(HUMAN)[0]!.undoable, true);
  offset = 8 * 86_400_000;
  assert.equal(g2.activityFeed(HUMAN)[0]!.undoable, false, 'past 7 days');
  rejects(() => g2.undo(HUMAN, g2.activityFeed(HUMAN)[0]!.id), 'conflict', /no longer be undone/);
  assert.ok(g2.getNode(HUMAN, m.id));
  rejects(() => g2.undo(HUMAN, 'act_missing'), 'not_found');
  // lint-lite drops the old entries
  assert.ok(g2.lintLite().prunedActivity >= 3);
  assert.equal(g2.activityFeed(HUMAN).length, 0);
});

test('system writes (episodes) are listed and undoable like bot writes', () => {
  const { g } = mkGraph();
  g.recordEpisode({ taskId: 'task_1', agentId: 'alpha', title: 'Long task', status: 'done', turns: 9, costUsd: 0.2, prompt: 'p', result: 'r', tainted: false });
  const row = g.activityFeed(HUMAN)[0]!;
  assert.equal(row.who, 'system');
  assert.equal(row.kind, 'episode');
  g.undo(HUMAN, row.id);
  assert.equal(g.getNode(HUMAN, 'ep:task_1'), undefined);
  void SYSTEM;
});

// ---------------------------------------------------------------- HTTP

const open: Array<() => Promise<void>> = [];
after(async () => { for (const c of open) await c().catch(() => undefined); });

async function server() {
  const f = makeFakes();
  const mod = createKnowledgeModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: tmpDir(), bsvEnabled: () => false });
  f.ctx.modules = [mod];
  const srv = await start(f.ctx);
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const r = await fetch(srv.base + path, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  open.push(async () => { await mod.dispose?.(); await srv.close(); });
  return { mod, g: mod.graph(), call };
}

test('routes: inbox, accept, bulk accept, reject, activity and undo all need the bearer token and behave', async () => {
  const s = await server();
  const human = note(s.g, 'Human decision: use Postgres', { type: 'decision', body: 'x' });
  const web = s.g.upsertNode(dirty('alpha', 'tA'), { title: 'Found on the web', scope: 'shared' }).node;
  const held = s.g.upsertNode(woken('builder', 'tB'), { title: 'Builder finding', scope: 'shared' }).node;
  const held2 = s.g.upsertNode(woken('builder', 'tB2'), { title: 'Builder second finding', scope: 'shared' }).node;
  const edit = s.g.upsertNode(clean('alpha', 'tC'), { id: human.id, body: 'y' }).node;
  for (const [m, p] of [['GET', '/api/kg/inbox'], ['POST', '/api/kg/inbox/accept'], ['POST', `/api/kg/inbox/${web.id}/accept`], ['POST', `/api/kg/inbox/${web.id}/reject`], ['GET', '/api/kg/activity'], ['POST', '/api/kg/activity/x/undo']] as const) {
    assert.equal((await s.call(m, p, m === 'POST' ? {} : undefined, false)).status, 401, `${m} ${p}`);
  }
  const inbox = await s.call('GET', '/api/kg/inbox');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.length, 4);
  assert.equal((await s.call('GET', '/api/kg/inbox?agent=builder')).body.length, 2);
  const one = await s.call('POST', `/api/kg/inbox/${held.id}/accept`, {});
  assert.equal(one.status, 200);
  assert.equal(one.body.node.trust, 'human');
  assert.equal((await s.call('POST', `/api/kg/inbox/${held.id}/accept`, {})).status, 409);
  assert.equal((await s.call('POST', '/api/kg/inbox/n_ghost/accept', {})).status, 404);
  assert.equal((await s.call('POST', `/api/kg/inbox/${web.id}/accept`, { edit: { title: 5 } })).status, 400);
  const bulk = await s.call('POST', '/api/kg/inbox/accept', {});
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.body.accepted, [], 'a woken bot\'s note, an edit of a human note and an untrusted row are all left for a per-row accept');
  assert.deepEqual(Object.fromEntries(bulk.body.skipped.map((k: any) => [k.id, k.code])), { [web.id]: 'untrusted', [held2.id]: 'woken', [edit.id]: 'edit_human' });
  assert.equal((await s.call('POST', `/api/kg/inbox/${held2.id}/accept`, {})).status, 200);
  assert.equal((await s.call('POST', `/api/kg/inbox/${edit.id}/accept`, {})).status, 200);
  assert.equal((await s.call('POST', '/api/kg/inbox/accept', { ids: 'nope' })).status, 400);
  assert.equal((await s.call('POST', '/api/kg/inbox/accept', { overrideUntrusted: true })).body.accepted[0], web.id);
  assert.equal((await s.call('GET', '/api/kg/lint')).body.lite, undefined, 'no lint-lite run yet');
  s.g.lintLite();
  const lint = await s.call('GET', '/api/kg/lint');
  assert.equal(lint.status, 200);
  assert.equal(typeof lint.body.lite.at, 'string');
  assert.equal(typeof lint.body.lite.expiredEpisodes, 'number');
  assert.equal(typeof lint.body.lite.stale, 'number');
  const rej = idOf((await connectAndWrite(s.g)).text);
  assert.equal((await s.call('POST', `/api/kg/inbox/${rej}/reject`)).body.node.status, 'archived');
  // activity + undo
  const feed = await s.call('GET', '/api/kg/activity?limit=3');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.length, 3);
  assert.equal((await s.call('GET', '/api/kg/activity?limit=0')).status, 400);
  const rejected = feed.body.find((r: any) => r.nodeId === rej);
  assert.equal((await s.call('POST', `/api/kg/activity/${rejected.id}/undo`)).status, 409, 'the note was rejected since, so its creation cannot be undone blindly');
  s.g.upsertNode(clean('alpha', 'tD'), { title: 'Fresh bot note' });
  const target = (await s.call('GET', '/api/kg/activity?limit=1')).body[0];
  assert.equal(target.undoable, true);
  const u = await s.call('POST', `/api/kg/activity/${target.id}/undo`);
  assert.equal(u.status, 200);
  assert.equal(u.body.entry.undone, true);
  assert.equal((await s.call('POST', `/api/kg/activity/${target.id}/undo`)).status, 409);
  assert.equal((await s.call('POST', '/api/kg/activity/act_nope/undo')).status, 404);
});

async function connectAndWrite(g: Graph) {
  const t = await connect(g, 'beta', { taskId: 'tR', taint: () => true });
  const r = await t.call('kg_upsert_node', { title: 'To be rejected', scope: 'shared' });
  await t.close();
  return r;
}
