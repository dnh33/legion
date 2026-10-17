/**
 * Gates PR 2, task 8: the board delete card, the browser, Blender and room cards and the proposals Inbox follow the registry.
 * Ask cards as in 0.3.0. Accept edits and Smart card them too (these guards pass no lower consequence). Bypass does not. An owner override
 * can turn one gate off in any preset. Every other check (shell floor, deny rules, board limits and rate limits) stays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { connectCdp } from '../src/core/browser/cdp.js';
import { BrowserManager } from '../src/core/browser/manager.js';
import { BrowserSession } from '../src/core/browser/session.js';
import { buildBrowserServer } from '../src/core/browser/tools.js';
import { BoardStore } from '../src/core/projects/board/store.js';
import { createBoardModule } from '../src/core/projects/board/index.js';
import { gateOff } from '../src/core/permission-mode.js';
import { PRESETS } from '../src/shared/gates-registry.js';
import type { Preset } from '../src/shared/gates-registry.js';
import type { ApprovalRequest, LegionEvent } from '../src/shared/types.js';
import type { RoomRequest } from '../src/core/comms/hub.js';
import { fakeResolver, startFakeCdp } from './browser-fakes.js';
import { agent as blAgent, connectTools, GOOD_SCRIPT, rig as blenderRig } from './blender-helpers.js';
import { makeHarness } from './comms-fakes.test.js';
import { gatesRig, pause } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { tempDir } from './tmp-cleanup.js';

type Surface = { name: string; fire(r: GatesRig): Promise<boolean> };
const DNS = fakeResolver({ 'a.test': ['93.184.216.34'] });

const presetRig = (preset: Preset, overrides?: Record<string, boolean>) => gatesRig({ preset, follow: true, ...(overrides ? { overrides } : {}) });
const lines = (r: GatesRig, kind = 'would-have-asked') => r.activityRead().filter((l) => l.kind === kind).map((l) => l.text);
const engineOf = (r: GatesRig) => r.engine as any;

async function mcp(cfg: any) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return { c, call: async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await c.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n');
    return { text, isError: res.isError === true };
  } };
}

/** The board of the rig's project, with a leader and one item to delete. */
function boardOf(r: GatesRig) {
  const dir = tempDir('legion-gates-board-');
  const board = new BoardStore(join(dir, 'board'), () => 0);
  const proj = r.projects.forRun(r.project.id, 'a1')!;
  board.setLeader(proj, 'a1');
  const item = board.botCreate(proj, 'a1', { title: 'Old idea' }, { tainted: false });
  const mod = createBoardModule({ config: {} as any, store: r.store as any, bus: new EventBus(), engine: r.engine, approvals: r.approvals, dataDir: dir, bsvEnabled: () => false }, { projects: r.projects, board });
  const job = { taskId: r.task.id, taint: () => false, projectId: r.project.id } as any;
  const cfg = mod.mcpServers!(r.agent, job).legion_board;
  return { board, proj, item, cfg };
}

const deleteSurface: Surface = {
  name: 'board delete',
  async fire(r) {
    const b = boardOf(r);
    const t = await mcp(b.cfg);
    const p = t.call('delete', { id: b.item.id });
    await pause(40);
    const card = r.pending().length > 0;
    if (card) r.answer(false);
    await p;
    return card;
  },
};

const browserSurface: Surface = {
  name: 'browser first page',
  async fire(r) {
    const fake = await startFakeCdp({ pages: { 'https://a.test/': { title: 'Home', text: 'hi' } } });
    const bus = new EventBus();
    const approvals = new ApprovalBroker(bus);
    const cards: ApprovalRequest[] = [];
    bus.on((e: LegionEvent) => { if (e.type === 'approval.requested') { cards.push(e.approval); setImmediate(() => approvals.resolve(e.approval.id, false)); } });
    const manager: BrowserManager = new BrowserManager((taskId) => new BrowserSession({
      guard: () => ({}), resolve: DNS,
      approveOrigin: async (o, u) => (await manager.peek(taskId)?.approveOrigin?.(o, u)) ?? false,
      async launch() {
        const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`);
        return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { cdp.close(); } };
      },
    }));
    try {
      const job = { taskId: r.task.id, taint: () => false, markTainted: () => undefined } as any;
      const cfg = buildBrowserServer(r.agent, job, { manager, guard: () => ({}), resolve: DNS, approvals, secrets: () => [], statusLine: () => '', modeOf: (id, tid) => engineOf(r).runModeOf(id, tid), gateOff: (id, a) => gateOff(r.engine, id, a) });
      const t = await mcp(cfg);
      await t.call('browser_open', { url: 'https://a.test/' });
      await t.c.close();
      return cards.length > 0;
    } finally { await manager.disposeAll(); await fake.close(); }
  },
};

const blenderSurface: Surface = {
  name: 'Blender exec',
  async fire(r) {
    const rg = blenderRig({ extra: { modeOf: (id: string, tid?: string) => engineOf(r).runModeOf(id, tid), gateOff: (id: string, a: any) => gateOff(r.engine, id, a) } as never });
    rg.decision.value = false;
    const job = { ...rg.job, taskId: r.task.id };
    const t = await connectTools(rg, blAgent('a1'), job);
    await t.call('blender_exec', { script: GOOD_SCRIPT, purpose: 'make a cube', mode: 'live' });
    await t.close();
    return rg.cards.length > 0;
  },
};

const roomSurface: Surface = {
  name: 'room request',
  async fire(r) {
    const seen: RoomRequest[] = [];
    const h = makeHarness({ hub: { approve: async (q: RoomRequest) => { seen.push(q); return false; }, runModeOf: (_id: string, tid?: string) => engineOf(r).runModeOf('a1', tid), gateOff: (id: string, a: any) => gateOff(r.engine, id, a) } as never });
    await h.hub.botCreateRoom('zealot', { name: 'Crew', members: ['scout'] }, { taskId: r.task.id }).catch(() => undefined);
    return seen.length > 0;
  },
};

const EXPECT: Record<Preset, boolean> = { ask: true, 'accept-edits': true, smart: true, bypass: false };

for (const s of [deleteSurface, browserSurface, blenderSurface, roomSurface]) {
  test(`${s.name}: Ask, Accept edits and Smart card it; Bypass does not`, async () => {
    for (const p of PRESETS) {
      const r = await presetRig(p);
      try { assert.equal(await s.fire(r), EXPECT[p], `${s.name} in ${p}`); } finally { r.stop(); }
    }
  });
}

test('module-cards off in an Ask project: no module card, and the delete card is a different gate', async () => {
  for (const s of [browserSurface, blenderSurface, roomSurface]) {
    const r = await presetRig('ask', { 'module-cards': false });
    try { assert.equal(await s.fire(r), false, `${s.name}: no card`); } finally { r.stop(); }
    const on = await presetRig('ask');
    try { assert.equal(await s.fire(on), true, `${s.name}: still carded with the gate on`); } finally { on.stop(); }
  }
  const r = await presetRig('ask', { 'module-cards': false });
  try { assert.equal(await deleteSurface.fire(r), true); } finally { r.stop(); }
});

test('board-delete-card off in an Ask project: the delete runs without a card, and module cards stay', async () => {
  const r = await presetRig('ask', { 'board-delete-card': false });
  try {
    assert.equal(await deleteSurface.fire(r), false);
    assert.equal(await browserSurface.fire(r), true, 'module cards are a different gate');
  } finally { r.stop(); }
});

test('gateOff: a ceiling keeps the card, no engine and a failed lookup read as on', async () => {
  const r = await gatesRig({ preset: 'ask', follow: true, overrides: { 'module-cards': false } });
  try {
    assert.equal(gateOff(r.engine, 'module-cards', { taskId: r.task.id, agentId: 'a1', action: 'x', ceiling: 'ask' }), false, 'a ceiling wins');
    assert.equal(gateOff(r.engine, 'module-cards', { taskId: r.task.id, agentId: 'a1', action: 'x' }), true);
    assert.equal(gateOff(undefined, 'module-cards', { agentId: 'a1', action: 'x' }), false, 'no engine: on');
    assert.equal(gateOff({ gateFor: () => { throw new Error('x'); } }, 'module-cards', { taskId: 't', agentId: 'a1', action: 'x' }), false, 'a failed lookup keeps the card');
  } finally { r.stop(); }
});

// ---- would-have-asked lines

test('would-have-asked: board delete and module cards write one line when off and none when on', async () => {
  const off = await presetRig('ask', { 'board-delete-card': false, 'module-cards': false });
  try {
    await deleteSurface.fire(off); await blenderSurface.fire(off);
    const t = lines(off);
    assert.equal(t.filter((x) => /^Would have asked: .*Old idea.*, because Ask before a board item is deleted is off$/.test(x)).length, 1, t.join('\n'));
    assert.equal(t.filter((x) => /because Ask before browser, Blender and room actions is off$/.test(x)).length, 1, t.join('\n'));
  } finally { off.stop(); }
  const on = await presetRig('ask');
  try { await deleteSurface.fire(on); await blenderSurface.fire(on); assert.deepEqual(lines(on), []); } finally { on.stop(); }
});

// ---- proposals inbox

const boardRun = (r: GatesRig) => {
  const b = boardOf(r);
  let conn: ReturnType<typeof mcp> | undefined;
  return { ...b, call: async (name: string, args: Record<string, unknown>) => (await (conn ??= mcp(b.cfg))).call(name, args) };
};

test('proposals-inbox is on in all four presets', async () => {
  for (const p of PRESETS) {
    const r = await presetRig(p);
    try {
      assert.equal(engineOf(r).gateFor(r.task.id, 'proposals-inbox'), true, p);
      const b = boardRun(r);
      const res = await b.call('propose', { title: `idea ${p}` });
      assert.match(res.text, /Inbox/);
      assert.ok(b.board.view(b.proj).inbox.some((i) => i.title === `idea ${p}`), `${p}: in the Inbox`);
      assert.deepEqual(lines(r), [], `${p}: no line while it is on`);
    } finally { r.stop(); }
  }
});

test('proposals-inbox off: an agent proposal lands in Backlog with agent trust, never as human-trusted', async () => {
  const r = await presetRig('ask', { 'proposals-inbox': false });
  try {
    const b = boardRun(r);
    const res = await b.call('propose', { title: 'Straight to backlog', description: 'from an agent' });
    assert.equal(res.isError, false, res.text);
    const v = b.board.view(b.proj);
    assert.equal(v.inbox.some((i) => i.title === 'Straight to backlog'), false, 'not in the Inbox');
    const item = v.items.find((i) => i.title === 'Straight to backlog')!;
    assert.equal(item.status, 'backlog');
    assert.equal(item.trust, 'untrusted');
    assert.equal(item.proposal, undefined);
    assert.equal(item.createdBy.kind, 'agent');
    assert.equal(item.createdBy.id, 'a1');
    assert.match(lines(r).join('\n'), /Would have asked: .*Straight to backlog.*, because Agent proposals wait in the Inbox is off/);
  } finally { r.stop(); }
});

test('the board limits and the per-bot rate limits still apply when the inbox is off', async () => {
  const r = await presetRig('ask', { 'proposals-inbox': false });
  try {
    const b = boardRun(r);
    const errs: boolean[] = [];
    for (let k = 0; k < 12; k++) errs.push((await b.call('propose', { title: `p${k}` })).isError);
    assert.equal(errs.slice(0, 3).some((e) => e), false, 'the first few go through');
    assert.ok(errs.includes(true), 'the proposal rate limit stops a flood');
    assert.equal((await b.call('propose', { title: 's', description: '-----BEGIN PRIVATE KEY-----' })).isError, true, 'the secret check still applies');
  } finally { r.stop(); }
});
