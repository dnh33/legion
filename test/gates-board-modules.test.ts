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
import { BOARD_LIMITS } from '../src/shared/board.js';
import type { Preset } from '../src/shared/gates-registry.js';
import type { ApprovalRequest, LegionEvent, RunMode } from '../src/shared/types.js';
import type { RoomRequest } from '../src/core/comms/hub.js';
import { fakeResolver, startFakeCdp } from './browser-fakes.js';
import { agent as blAgent, connectTools, GOOD_SCRIPT, rig as blenderRig } from './blender-helpers.js';
import { makeHarness } from './comms-fakes.test.js';
import { gatesRig, pause } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { tempDir } from './tmp-cleanup.js';

type Surface = { name: string; fire(r: GatesRig, ceiling?: RunMode): Promise<boolean> };
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
function boardOf(r: GatesRig, ceiling?: RunMode) {
  const dir = tempDir('legion-gates-board-');
  const board = new BoardStore(join(dir, 'board'), () => 0);
  const proj = r.projects.forRun(r.project.id, 'a1')!;
  board.setLeader(proj, 'a1');
  const item = board.botCreate(proj, 'a1', { title: 'Old idea' }, { tainted: false });
  const mod = createBoardModule({ config: {} as any, store: r.store as any, bus: new EventBus(), engine: r.engine, approvals: r.approvals, dataDir: dir, bsvEnabled: () => false }, { projects: r.projects, board });
  const job = { taskId: r.task.id, taint: () => false, projectId: r.project.id, ...(ceiling ? { ceiling } : {}) } as any;
  const cfg = mod.mcpServers!(r.agent, job).legion_board;
  return { board, proj, item, cfg };
}

const deleteSurface: Surface = {
  name: 'board delete',
  async fire(r, ceiling) {
    const b = boardOf(r, ceiling);
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
  async fire(r, ceiling) {
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
      const job = { taskId: r.task.id, taint: () => false, markTainted: () => undefined, ...(ceiling ? { ceiling } : {}) } as any;
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
  async fire(r, ceiling) {
    const rg = blenderRig({ extra: { modeOf: (id: string, tid?: string) => engineOf(r).runModeOf(id, tid), gateOff: (id: string, a: any) => gateOff(r.engine, id, a) } as never });
    rg.decision.value = false;
    const job = { ...rg.job, taskId: r.task.id, ...(ceiling ? { ceiling } : {}) };
    const t = await connectTools(rg, blAgent('a1'), job);
    await t.call('blender_exec', { script: GOOD_SCRIPT, purpose: 'make a cube', mode: 'live' });
    await t.close();
    return rg.cards.length > 0;
  },
};

const roomSurface: Surface = {
  name: 'room request',
  async fire(r, ceiling) {
    const seen: RoomRequest[] = [];
    const h = makeHarness({ hub: { approve: async (q: RoomRequest) => { seen.push(q); return false; }, runModeOf: (_id: string, tid?: string) => engineOf(r).runModeOf('a1', tid), gateOff: (id: string, a: any) => gateOff(r.engine, id, { ...a, agentId: 'a1' }) /* the harness sender is zealot; the rig run belongs to a1 */ } as never });
    await h.hub.botCreateRoom('zealot', { name: 'Crew', members: ['scout'] }, { taskId: r.task.id, ...(ceiling ? { ceiling } : {}) }).catch(() => undefined);
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
    assert.equal(gateOff({ cardOffFor: () => { throw new Error('x'); } }, 'module-cards', { taskId: 't', agentId: 'a1', action: 'x' }), false, 'a failed lookup keeps the card');
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


// ---- fix round 1: the same rule as tool cards (only an explicit owner override removes a card below the agent's own setting)

const SURFACES = [deleteSurface, browserSurface, blenderSurface, roomSurface];

test('I1: an agent the owner set to Ask keeps its delete, browser, Blender and room cards in a Bypass project; an agent that follows Bypass gets none', async () => {
  for (const s of SURFACES) {
    const own = await gatesRig({ preset: 'bypass' }); // own mode Ask, does not follow the project
    try { assert.equal(await s.fire(own), true, `${s.name}: own-Ask agent in Bypass keeps its card`); } finally { own.stop(); }
    const follow = await presetRig('bypass');
    try { assert.equal(await s.fire(follow), false, `${s.name}: a follower gets no card`); } finally { follow.stop(); }
  }
  // an explicit override in an Ask project covers the agent that set itself to Ask
  for (const s of SURFACES) {
    const r = await gatesRig({ preset: 'ask', overrides: { 'module-cards': false, 'board-delete-card': false } });
    try { assert.equal(await s.fire(r), false, `${s.name}: explicit override, no card`); } finally { r.stop(); }
  }
});

test('I2: Bypass writes the would-have-asked line for the board delete, browser, Blender and room cards', async () => {
  for (const s of SURFACES) {
    const r = await presetRig('bypass');
    try {
      assert.equal(await s.fire(r), false);
      const t = lines(r);
      assert.ok(t.length >= 1, `${s.name}: a line is written (${t.join(' | ')})`);
      assert.match(t[0]!, s === deleteSurface ? /^Would have asked: .*, because Ask before a board item is deleted is off$/ : /^Would have asked: [^]*, because Ask before browser, Blender and room actions is off$/, s.name);
    } finally { r.stop(); }
    const on = await presetRig('ask');
    try { await s.fire(on); assert.deepEqual(lines(on), [], `${s.name}: none while the card is on`); } finally { on.stop(); }
  }
});

const proposeSurface: Surface = {
  name: 'propose',
  async fire(r, ceiling) {
    const b = boardOf(r, ceiling);
    const t = await mcp(b.cfg);
    await t.call('propose', { title: 'Maybe this' });
    return b.board.view(b.proj).inbox.some((i) => i.title === 'Maybe this'); // true = it waited in the Inbox (the card-equivalent)
  },
};

test('I3 and M7: a run another bot or an outside app started (an Ask ceiling) keeps the card at all five sites, and the Inbox at propose', async () => {
  for (const s of [...SURFACES, proposeSurface]) {
    const ov = { 'module-cards': false, 'board-delete-card': false, 'proposals-inbox': false };
    const askProject = await gatesRig({ preset: 'ask', follow: true, overrides: ov });
    try { assert.equal(await s.fire(askProject, 'ask'), true, `${s.name}: ceiling beats an explicit switch-off`); } finally { askProject.stop(); }
    if (s === proposeSurface) continue; // the Inbox is on in every preset; only an override turns it off
    const bypass = await presetRig('bypass');
    try { assert.equal(await s.fire(bypass, 'ask'), true, `${s.name}: ceiling beats a Bypass project`); } finally { bypass.stop(); }
  }
});

test('M1 and M2: the gate is read with the START project; a task the engine does not know reads as on', async () => {
  const r = await gatesRig({ preset: 'ask', follow: true, app: 'bypass' });
  try {
    const other = r.projects.setMembers(r.projects.create({ name: 'Other', instructions: '' }).id, ['a1']);
    r.core.store.patchProject(other.id, { preset: 'bypass' });
    r.store.getTask(r.task.id)!.projectId = other.id; // the task now lives in a Bypass project; the run STARTED in the Ask one
    assert.equal(engineOf(r).gateFor(r.task.id, 'module-cards'), true, 'start project (Ask) wins over the live project (Bypass)');
    assert.equal(engineOf(r).cardOffFor(r.task.id, 'module-cards', 'a1'), false);
    assert.equal(engineOf(r).gateFor('no-such-task', 'module-cards'), true, 'unknown task: fail closed');
    assert.equal(engineOf(r).gateFor(undefined, 'module-cards'), true, 'no task: fail closed');
    assert.equal(engineOf(r).cardOffFor('no-such-task', 'module-cards', 'a1'), false);
  } finally { r.stop(); }
});

test('M4: with module-cards off the shell floor and the deny rules still apply', async () => {
  const r = await gatesRig({ preset: 'ask', follow: true, overrides: { 'module-cards': false } });
  try {
    r.setRules([{ id: 'gr_deny', enabled: true, then: 'deny', when: { tools: ['Edit'] }, label: 'gr_deny', source: 'user' } as never]);
    const floor = await r.run('Bash', { command: 'rm -rf /' });
    assert.equal(floor.allow, false, 'the shell floor refuses');
    const rule = await r.run('Edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' });
    assert.equal(rule.allow, false, 'the deny rule applies');
  } finally { r.stop(); }
});

test('I4: a proposal sent straight to Backlog keeps the places for the owner and the per-agent open-item cap, like create', async () => {
  const r = await presetRig('ask', { 'proposals-inbox': false });
  try {
    const b = boardRun(r);
    const L = BOARD_LIMITS;
    // fill the board up to the places kept for the owner with the owner's own items
    const fillTo = (n: number) => { while (b.board.view(b.proj).items.length < n) b.board.create(b.proj, { title: `o${b.board.view(b.proj).items.length}` } as never); };
    fillTo(L.itemsPerProject - L.botReserve);
    const res = await b.call('propose', { title: 'Into the owner places' });
    assert.equal(res.isError, true, 'the places kept for the owner stay free');
    assert.match(res.text, /kept for the owner/);
    assert.equal((await b.call('create', { title: 'Same cap through create' })).isError, true, 'create refuses at the same size');
  } finally { r.stop(); }
  const r2 = await presetRig('ask', { 'proposals-inbox': false });
  try {
    const b = boardRun(r2);
    for (let k = 0; k < BOARD_LIMITS.botOpenPerAgent; k++) b.board.create(b.proj, { title: `mine${k}` }, { kind: 'agent', id: 'a1' });
    const res = await b.call('propose', { title: 'One too many' });
    assert.equal(res.isError, true, 'the per-agent open-item cap applies');
    assert.match(res.text, /open items you created/);
  } finally { r2.stop(); }
});

test('M5: the propose tool description does not promise the Inbox', async () => {
  const r = await presetRig('ask', { 'proposals-inbox': false });
  try {
    const b = boardOf(r);
    const t = await mcp(b.cfg);
    const d = (await t.c.listTools()).tools.find((x) => x.name === 'propose')!.description ?? '';
    assert.doesNotMatch(d, /is not on the board until/, d);
    assert.match(d, /turned the Inbox off/);
  } finally { r.stop(); }
});

// ---- the browser script card, the new-site card on a click, and the module-cards off lines (review task 7+8, M4 and re-review 1)

const TOUR_PAGES = {
  'https://a.test/': { title: 'Home', text: 'hi', elements: { '#go': { href: 'https://b.test/', goes: 'https://b.test/' } } },
  'https://b.test/': { title: 'Elsewhere', text: 'other site' },
};
const TOUR_DNS = fakeResolver({ 'a.test': ['93.184.216.34'], 'b.test': ['93.184.216.35'] });

/** Opens a page, runs a script and clicks a link to a second site, saying yes to every card. Returns the card summaries in order. */
async function browserTour(r: GatesRig, steps: Array<'eval' | 'click'>): Promise<string[]> {
  const fake = await startFakeCdp({ pages: TOUR_PAGES });
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus);
  const cards: string[] = [];
  bus.on((e: LegionEvent) => { if (e.type === 'approval.requested') { cards.push(`${e.approval.toolName}: ${e.approval.summary}`); setImmediate(() => approvals.resolve(e.approval.id, true)); } });
  const manager: BrowserManager = new BrowserManager((taskId) => new BrowserSession({
    guard: () => ({}), resolve: TOUR_DNS,
    approveOrigin: async (o, u) => (await manager.peek(taskId)?.approveOrigin?.(o, u)) ?? false,
    async launch() {
      const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`);
      return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { cdp.close(); } };
    },
  }));
  try {
    const job = { taskId: r.task.id, taint: () => false, markTainted: () => undefined } as any;
    const cfg = buildBrowserServer(r.agent, job, { manager, guard: () => ({}), resolve: TOUR_DNS, approvals, secrets: () => [], statusLine: () => '', modeOf: (id, tid) => engineOf(r).runModeOf(id, tid), gateOff: (id, a) => gateOff(r.engine, id, a) });
    const t = await mcp(cfg);
    await t.call('browser_open', { url: 'https://a.test/' });
    for (const s of steps) {
      if (s === 'eval') await t.call('browser_eval', { expression: 'document.title' });
      else await t.call('browser_click', { selector: '#go' });
    }
    await t.c.close();
    return cards;
  } finally { await manager.disposeAll(); await fake.close(); }
}

test('browser_eval gets a card in Ask, Accept edits and Smart, none in Bypass', async () => {
  for (const p of PRESETS) {
    const r = await presetRig(p);
    try {
      const cards = await browserTour(r, ['eval']);
      assert.equal(cards.some((c) => /^.*browser_eval: Run a script/.test(c)), EXPECT[p], `browser_eval in ${p}: ${cards.join(' | ')}`);
    } finally { r.stop(); }
  }
});

test('a click that reaches a new site gets the new-site card the same way', async () => {
  for (const p of PRESETS) {
    const r = await presetRig(p);
    try {
      const cards = await browserTour(r, ['click']);
      assert.equal(cards.some((c) => /moved the page to a new site: https:\/\/b\.test/.test(c)), EXPECT[p], `new-site card in ${p}: ${cards.join(' | ')}`);
    } finally { r.stop(); }
  }
});

test('module-cards off by an owner override in an Ask project: browser and room actions write the would-have-asked line, and no card', async () => {
  const r = await presetRig('ask', { 'module-cards': false });
  try {
    const cards = await browserTour(r, ['eval', 'click']);
    assert.deepEqual(cards, [], 'no browser card of any kind');
    const t = lines(r).filter((x) => /because Ask before browser, Blender and room actions is off$/.test(x));
    assert.ok(t.some((x) => /browser_open https:\/\/a\.test/.test(x)), `first page line: ${t.join(' | ')}`);
    assert.ok(t.some((x) => /browser_eval document\.title/.test(x)), `script line: ${t.join(' | ')}`);
    assert.ok(t.some((x) => /new site https:\/\/b\.test/.test(x)), `new-site line: ${t.join(' | ')}`);
    const before = lines(r).length;
    assert.equal(await roomSurface.fire(r), false, 'no room card either');
    assert.ok(lines(r).length > before, 'the room action wrote its line');
  } finally { r.stop(); }
  const on = await presetRig('ask');
  try { await browserTour(on, ['eval', 'click']); assert.deepEqual(lines(on), [], 'no line while the cards are on'); } finally { on.stop(); }
});
