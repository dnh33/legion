/**
 * The Marshal, live: the composition root (createBoardModule) builds it over this core's own engine, store
 * and matcher; the per-project tick is off until the owner switches it on; one pass really dispatches — on
 * the bot's OWN model, because the run is started with no model at all; and the three board routes validate
 * and gate like the rest of server.ts. (marshal/driver.ts + projects/board/index.ts.)
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isClientRoute } from '../src/core/admin.js';
import { BoardStore, createBoardModule } from '../src/core/projects/board/index.js';
import type { BoardModule } from '../src/core/projects/board/index.js';
import { ProjectStore } from '../src/core/projects/index.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';
import type { Task } from '../src/shared/types.js';

const J = { 'Content-Type': 'application/json' };
type Started = { p: Record<string, unknown>; t: Task };

interface Rig {
  bmod: BoardModule; projects: ProjectStore; board: BoardStore; f: ReturnType<typeof makeFakes>;
  pid: string; started: Started[]; timers: Set<() => void>; events: string[]; base: string;
  call(m: string, path: string, body?: unknown): Promise<Response>;
  client(m: string, path: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

/** Boots a real core with the board module wired, a two-bot project, and the tick's timer captured (never started unless asked). */
async function boot(o: { enabled?: boolean } = {}): Promise<Rig> {
  const root = cleanupTemp('legion-marshal-http-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const board = new BoardStore(join(data, 'board'));
  const f = makeFakes({ holdRuns: true });
  const started: Started[] = [];
  const realStart = f.ctx.engine.startTask.bind(f.ctx.engine);
  f.ctx.engine.startTask = (args: any) => { const t = realStart(args) as Task; started.push({ p: args as Record<string, unknown>, t }); return t; };
  (f.ctx as { projects?: unknown }).projects = projects;
  (f.ctx as { board?: unknown }).board = board;
  const p = projects.create({ name: 'Order' });
  projects.setMembers(p.id, ['zealot', 'scout']);
  if (o.enabled) board.setMarshal(projects.get(p.id)!, { enabled: true, waveSize: 1, stallMinutes: 8 });
  const timers = new Set<() => void>();
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const bmod = createBoardModule(deps, { projects, board, marshalSchedule: (fn) => { timers.add(fn); return () => { timers.delete(fn); }; } });
  (f.ctx as { modules?: unknown }).modules = [bmod];
  const s = await start(f.ctx);
  const events: string[] = [];
  f.bus.on((e) => events.push(e.type));
  const req = (headers: Record<string, string>) => (m: string, path: string, body?: unknown) =>
    fetch(s.base + path, { method: m, headers: { ...headers, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { bmod, projects, board, f, pid: p.id, started, timers, events, base: s.base, call: req(AUTH), client: req(asClient), close: s.close };
}

/** The matcher's own run, asked through the engine (every pass starts one while an item is dispatchable). */
async function matcherTask(r: Rig, after = 0): Promise<Started> {
  for (let n = 0; n < 400; n++) {
    const hit = r.started.slice(after).find((s) => String(s.p.prompt).startsWith('Route this work item'));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the matcher never asked through the engine');
}
/** Answer it the way the model would: two lines, the contract. */
function answer(r: Rig, m: Started, pick: string, why = 'it is the bot for this work'): void {
  m.t.status = 'done';
  m.t.result = `PICK ${pick}\nWHY ${why}`;
  r.f.bus.emit({ type: 'task.updated', task: m.t });
}
const dispatchesOf = (r: Rig): Started[] => r.started.filter((s) => String(s.p.prompt).startsWith('Goal:'));

test('one pass: the matcher asks, the item dispatches to the chosen bot with NO model, and the status says why', async () => {
  const r = await boot();
  try {
    const item = r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Write the parser', priority: 'high' });
    // the checks that decide the item, written through the route before anything may dispatch
    const d = await r.call('PUT', `/api/projects/${r.pid}/board/items/${item.id}/dispatch`, { doneWhen: ['it parses', 'the test passes'] });
    assert.equal(d.status, 200);
    assert.deepEqual((await d.json()).doneWhen, ['it parses', 'the test passes']);

    // off by default: a tick does nothing at all
    await r.bmod.marshal.tick(r.pid);
    assert.equal(r.started.length, 0, 'the config says off, so nothing is asked or started');

    const cfg = await r.call('PUT', `/api/projects/${r.pid}/board/marshal`, { enabled: true, waveSize: 1, stallMinutes: 8 });
    assert.equal(cfg.status, 200);
    assert.deepEqual(await cfg.json(), { enabled: true, waveSize: 1, stallMinutes: 8 }, 'the route echoes what was stored');
    assert.equal(r.timers.size, 1, 'the tick is scheduled for this project now');

    const pass = r.bmod.marshal.tick(r.pid);
    const ask = await matcherTask(r);
    assert.equal(ask.p.agentId, 'zealot', 'the lead does the matching');
    answer(r, ask, 'scout');
    await pass;

    const run = dispatchesOf(r);
    assert.equal(run.length, 1, 'one wave, one dispatch');
    assert.deepEqual(Object.keys(run[0]!.p).sort(), ['agentId', 'projectId', 'prompt', 'source'], 'the run asks for NOTHING but the bot, the text and the project: no model slot exists');
    assert.equal(run[0]!.p.agentId, 'scout');
    assert.equal(run[0]!.p.source, 'ui');
    assert.equal(run[0]!.p.projectId, r.pid);
    assert.equal(run[0]!.p.modelOverrideBy, undefined, 'no override: Workstream-A model routing stays intact');
    assert.match(String(run[0]!.p.prompt), /^Goal: Write the parser/, 'the contract leads the dispatch prompt');
    assert.match(String(run[0]!.p.prompt), /Done when:\n1\. it parses\n2\. the test passes/, 'and carries the checks');
    assert.equal(r.board.get(r.pid, item.id)!.status, 'doing', 'the board moved the item to Doing');

    const st = await r.call('GET', `/api/projects/${r.pid}/board/status`);
    assert.equal(st.status, 200);
    const body = await st.json() as { status: { running: Array<Record<string, unknown>>; blocked: unknown[]; next: unknown[] }; statusText: string; checks: Record<string, string[]>; marshal: Record<string, unknown> };
    assert.equal(body.status.running.length, 1, 'the picture shows what runs');
    assert.equal(body.status.running[0]!.botId, 'scout', 'with the bot it went to');
    assert.equal(body.status.running[0]!.model, r.f.ctx.store.getAgent('scout')!.model, 'naming the bot’s OWN model');
    assert.ok(String(body.status.running[0]!.why).length > 5, 'and why that bot');
    assert.equal(body.status.blocked.length, 0);
    assert.deepEqual(body.checks[item.id], ['it parses', 'the test passes'], 'the checks come back for the UI to show');
    assert.deepEqual(body.marshal, { enabled: true, waveSize: 1, stallMinutes: 8 });
    assert.match(body.statusText, /^STATUS 1 running, 0 blocked/, 'the plain lines lead');
    assert.match(body.statusText, /Running: Write the parser → Scout/);
  } finally { await r.close(); }
});

test('monitor runs in the driver: a failed run is settled, the item goes back, and the pass may retry it once', async () => {
  const r = await boot({ enabled: true });
  try {
    const item = r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Fix the flake' });
    assert.equal((await r.call('PUT', `/api/projects/${r.pid}/board/items/${item.id}/dispatch`, { doneWhen: ['it passes'] })).status, 200);

    const pass = r.bmod.marshal.tick(r.pid);
    answer(r, await matcherTask(r), 'scout');
    await pass;
    const first = dispatchesOf(r)[0]!;
    assert.equal(r.board.get(r.pid, item.id)!.status, 'doing');

    // the run ends badly — exactly how the board module reports it (onTaskEnd), never through the driver
    first.t.status = 'error'; first.t.error = 'provider offline';
    r.bmod.onTaskEnd!({ ...first.t, projectId: r.pid } as Task, r.f.ctx.store.getAgent('scout')!, { status: 'error', isError: true, errorText: 'provider offline', tainted: false });
    assert.equal(r.board.get(r.pid, item.id)!.status, 'blocked', 'a failed run lands in Blocked, where the owner sees it');

    const before = r.started.length;
    r.events.length = 0; // from here: only what the pass itself says
    const retry = r.bmod.marshal.tick(r.pid);
    answer(r, await matcherTask(r, before), 'scout');
    await retry;
    const sends = dispatchesOf(r);
    assert.equal(sends.length, 2, 'the ledger allows a second try, so the same pass sent it back out');
    assert.notEqual(sends[1]!.t.id, sends[0]!.t.id, 'with a fresh run');
    assert.ok(r.events.includes('board.updated'), 'the pass told the window to reload');
    assert.equal(r.board.get(r.pid, item.id)!.status, 'doing');
  } finally { await r.close(); }
});

test('the tick is a switch: off until the owner turns it on, off again when they turn it off, never on at boot by itself', async () => {
  const r = await boot();
  try {
    assert.equal(r.timers.size, 0, 'a project with no config gets no timer at all');
    assert.equal(r.bmod.marshal.running(r.pid), false);
    const on = await r.call('PUT', `/api/projects/${r.pid}/board/marshal`, { enabled: true, waveSize: 3, stallMinutes: 8 });
    assert.equal(on.status, 200);
    assert.equal(r.timers.size, 1, 'one project, one tick');
    assert.equal(r.bmod.marshal.running(r.pid), true);
    const off = await r.call('PUT', `/api/projects/${r.pid}/board/marshal`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(r.timers.size, 0, 'and it is cancelled again');
    assert.equal(r.bmod.marshal.running(r.pid), false);
    // even called by hand, an off project is never worked
    const before = r.started.length;
    r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Nobody asked for this' });
    await r.bmod.marshal.tick(r.pid);
    assert.equal(r.started.length, before, 'off means off: no match run, no dispatch');
  } finally { await r.close(); }
});

test('a project switched on before the core started keeps its tick and its bounds across the restart', async () => {
  const r = await boot({ enabled: true });
  try {
    assert.equal(r.timers.size, 1, 'the stored `enabled` started the tick at construction');
    const marshal = r.bmod.marshal.marshalFor(r.pid)!;
    assert.equal(marshal.waveSize, 1, 'the stored wave was used');
    assert.equal(marshal.stallMs, 8 * 60_000, 'and the stored stall budget');
    // changing it while the loop runs moves the bounds, not the runs
    marshal.reconfigure({ waveSize: 4, stallMs: 60_000 });
    assert.equal(marshal.waveSize, 4);
    assert.equal(marshal.stallMs, 60_000);
  } finally { await r.close(); }
});

test('the routes validate like the rest of the board: bounds, checks, ids and the archive', async () => {
  const r = await boot();
  try {
    const base = `/api/projects/${r.pid}/board`;
    const item = r.board.create({ id: r.pid, members: ['zealot', 'scout'], status: 'active' }, { title: 'Check me' });
    for (const body of [
      { waveSize: 0 }, { waveSize: 11 }, { waveSize: 2.5 }, { stallMinutes: 0 }, { stallMinutes: 241 }, { enabled: 'yes' }, {},
    ]) {
      assert.equal((await r.call('PUT', `${base}/marshal`, body)).status, 400, `refused: ${JSON.stringify(body)}`);
    }
    assert.equal((await r.call('PUT', `${base}/marshal`, 'nope')).status, 400, 'a non-object body');
    assert.deepEqual(r.board.marshalConfig(r.pid), { enabled: false, waveSize: 3, stallMinutes: 8 }, 'nothing was written by any refusal');
    assert.equal((await r.call('PUT', `${base}/marshal`, { waveSize: 10, stallMinutes: 240 })).status, 200, 'the edges themselves are allowed');

    for (const body of [{ doneWhen: 'a line' }, { doneWhen: [1] }, { doneWhen: [''] }, { doneWhen: ['x'.repeat(201)] }, { doneWhen: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, {}]) {
      assert.equal((await r.call('PUT', `${base}/items/${item.id}/dispatch`, body)).status, 400, `refused: ${JSON.stringify(body).slice(0, 60)}`);
    }
    assert.equal((await r.call('PUT', `${base}/items/wi_000000000000/dispatch`, { doneWhen: ['ok'] })).status, 404, 'an id that is not there');
    assert.equal((await r.call('GET', `${base}/status`)).status, 200, 'the picture reads fine');
    assert.equal((await r.call('GET', `/api/projects/proj_000000000000/board/status`)).status, 404, 'an unknown project');

    // archived: read-only, exactly like every other board write
    r.projects.update(r.pid, { status: 'archived' });
    assert.equal((await r.call('PUT', `${base}/marshal`, { enabled: true })).status, 409);
    assert.equal((await r.call('PUT', `${base}/items/${item.id}/dispatch`, { doneWhen: ['ok'] })).status, 409);
    assert.equal((await r.call('GET', `${base}/status`)).status, 200, 'reading still works');
    assert.equal(r.timers.size, 0, 'and nothing was switched on');
  } finally { await r.close(); }
});

test('every marshal route is admin-only: none is on the token client list', async () => {
  const r = await boot();
  try {
    const id = r.pid;
    const routes: Array<[string, string]> = [
      ['GET', `/api/projects/${id}/board/status`],
      ['PUT', `/api/projects/${id}/board/marshal`],
      ['PUT', `/api/projects/${id}/board/items/wi_aaaaaaaaaaaa/dispatch`],
    ];
    for (const [m, path] of routes) {
      assert.equal(isClientRoute(m, path), false, `${m} ${path} must not be a client route`);
      assert.equal((await r.client(m, path, m === 'GET' ? undefined : {})).status, 403, `${m} ${path} token only`);
      assert.equal((await fetch(r.base + path, { method: m, headers: J, body: m === 'GET' ? undefined : '{}' })).status, 401, `${m} ${path} nothing`);
    }
    assert.equal((await r.call('GET', `/api/projects/${id}/board/status`)).status, 200, 'the app window gets it');
  } finally { await r.close(); }
});
