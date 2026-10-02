/**
 * Builder B, item C: a bot can ask for a group room and for members to be added or removed, always through a card the user answers.
 * Hub level (fake engine, fake approver), tool level (in-process MCP client) and end to end (real Engine, real broker, real HTTP).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RoomStore } from '../src/core/comms/rooms.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalBroker } from '../src/core/approvals.js';
import { createCommsModule } from '../src/core/comms/index.js';
import { buildCommsToolsServer } from '../src/core/comms/tools.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { MAX_ROOM_BUDGET_USD, normalizeComms } from '../src/shared/config.js';
import type { RoomRequest } from '../src/core/comms/hub.js';
import { makeHarness } from './comms-fakes.test.js';
import { AUTH, asClient } from './helpers-c.js';
import { closeAll, mk, mount, until } from './token-harness.js';
import { init, ok as okMsg } from './library-fakes.js';
import type { Call } from './token-harness.js';

/** An approver the test answers by hand. */
function approver() {
  const seen: RoomRequest[] = [];
  const waiting: Array<(allow: boolean) => void> = [];
  const approve = (r: RoomRequest) => new Promise<boolean>((res) => { seen.push(r); waiting.push(res); });
  return { seen, approve, answer: (allow: boolean, n = 0) => waiting[n]!(allow), pending: () => seen.length - 0 };
}
const ctx = (taskId = 'task_1', extra: Record<string, unknown> = {}) => ({ taskId, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

// ================================================================ room_create

test('C: room_create shows a card first, and only on Allow creates a room marked as created by the bot', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const pending = h.hub.botCreateRoom('zealot', { name: 'Launch crew', members: ['scout', 'Builder'] }, ctx());
  await tick();
  assert.equal(a.seen.length, 1);
  const card = a.seen[0]!;
  assert.equal(card.tool, 'room_create');
  assert.equal(card.agentId, 'zealot');
  assert.equal(card.taskId, 'task_1');
  assert.match(card.summary, /Zealot asks to create a room\. The name below is the bot's text, not Legion's: Launch crew\nMembers: Zealot, Scout, Builder\. Lead: Zealot\./);
  assert.match(card.summary, /No spend limit/, 'the owner is told plainly that nothing caps the cost');
  assert.doesNotMatch(card.summary, /Budget: \$/);
  assert.match(card.summary, /Only you can delete the room later/);
  assert.equal(h.hub.listRooms().length, 0, 'nothing exists while the card is open');
  assert.ok(!h.events.some((e) => e.type === 'room.updated'), 'and nothing was announced');
  a.answer(true);
  const room = await pending;
  assert.equal(room.createdBy, 'zealot');
  assert.deepEqual(room.members, ['zealot', 'scout', 'builder']);
  assert.equal(room.lead, 'zealot');
  assert.equal(room.kind, 'group');
  assert.equal(room.guards.budgetUsd, null, 'a bot-made room has no spend limit unless one is named');
  assert.equal(room.guards.maxHops, 6, 'the ordinary hop guard');
  assert.equal(room.guards.cycleRepeats, 3);
  assert.match(h.messages(room.id)[0]!.text, /Room created by Zealot; you approved it/);
  assert.equal(h.hub.roomList('scout')[0]!.createdBy, 'Zealot');
  assert.match(h.hub.exportRoom(room.id, 'md') as string, /Created by: Zealot/);
});

test('C: a denied card creates nothing and tells the bot not to ask again', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const p = h.hub.botCreateRoom('zealot', { name: 'X', members: ['scout'] }, ctx());
  const caught = assert.rejects(p, /did not approve.*Nothing was changed.*Do not ask again/);
  await tick();
  a.answer(false);
  await caught;
  assert.equal(h.hub.listRooms().length, 0);
});

test('C: no approver, no task, or an approver that throws: nothing is created', async () => {
  const none = makeHarness();
  await assert.rejects(none.hub.botCreateRoom('zealot', { name: 'X', members: ['scout'] }, ctx()), /no way to ask the user/);
  const h = makeHarness({ hub: { approve: async () => true } });
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'X', members: ['scout'] }, {}), /no way to ask the user/);
  const boom = makeHarness({ hub: { approve: async () => { throw new Error('broker down'); } } });
  await assert.rejects(boom.hub.botCreateRoom('zealot', { name: 'X', members: ['scout'] }, ctx()), /did not approve/);
  assert.equal(none.hub.listRooms().length + h.hub.listRooms().length + boom.hub.listRooms().length, 0);
});

test('C: caps are enforced before any card: members, budget, lead, strangers, self only', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const names = ['scout', 'builder', 'scribe', 'ranger', 'warden', 'oracle'];
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Big', members: names }, ctx()), /at most 6 bots including you \(you named 7\)/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Alone', members: ['zealot'] }, ctx()), /at least one other bot/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Ghost', members: ['nobody'] }, ctx()), /Unknown agent "nobody"/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Free', members: ['scout'], budgetUsd: 0 }, ctx()), /at least 0\.05/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Lead', members: ['scout'], lead: 'builder' }, ctx()), /lead must be one of the members/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: '  ', members: ['scout'] }, ctx()), /name is required/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'x'.repeat(81), members: ['scout'] }, ctx()), /80 characters/);
  assert.equal(a.seen.length, 0, 'no card for an invalid request');
});

test('C: the member cap, the budget default and the budget ceiling come from config', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve, comms: { botRoomMaxMembers: 3, botRoomDefaultBudgetUsd: 0.5, botRoomMaxBudgetUsd: 2, turnCostFloorUsd: 0.02 } } });
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Four', members: ['scout', 'builder', 'scribe'] }, ctx()), /at most 3 bots/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Rich', members: ['scout'], budgetUsd: 2.5 }, ctx()), /at most \$2\.00/);
  const p = h.hub.botCreateRoom('zealot', { name: 'Ok', members: ['scout', 'builder'], budgetUsd: 2 }, ctx());
  await tick(); a.answer(true);
  assert.equal((await p).guards.budgetUsd, 2);
  const q = h.hub.botCreateRoom('zealot', { name: 'Default', members: ['scout'] }, ctx());
  await tick(); a.answer(true, 1);
  assert.equal((await q).guards.budgetUsd, 0.5);
});

test('C: normalizeComms pulls config values back into range', () => {
  assert.deepEqual(normalizeComms(undefined), { botRoomMaxMembers: 6, botRoomDefaultBudgetUsd: null, botRoomMaxBudgetUsd: null, turnCostFloorUsd: 0.02 });
  const n = normalizeComms({ botRoomMaxMembers: 40, botRoomDefaultBudgetUsd: 9, botRoomMaxBudgetUsd: 3, turnCostFloorUsd: -1 });
  assert.equal(n.botRoomMaxMembers, 6, 'never above the 6 every room is limited to');
  assert.equal(n.botRoomMaxBudgetUsd, 3);
  assert.equal(n.botRoomDefaultBudgetUsd, 3, 'the default cannot exceed the ceiling');
  assert.equal(n.turnCostFloorUsd, 0.02);
  assert.equal(normalizeComms({ botRoomMaxMembers: 4.5 }).botRoomMaxMembers, 6);
  assert.equal(normalizeComms('junk').botRoomMaxBudgetUsd, null);
  // a $0 or negative budget in the config file falls back to the defaults: a room a bot makes can never start wedged
  const low = normalizeComms({ botRoomDefaultBudgetUsd: 0, botRoomMaxBudgetUsd: -2 });
  assert.equal(low.botRoomMaxBudgetUsd, null);
  assert.equal(low.botRoomDefaultBudgetUsd, null);
  assert.equal(normalizeComms({ botRoomDefaultBudgetUsd: 0.01 }).botRoomDefaultBudgetUsd, null, 'below the 0.05 minimum is not accepted');
});

test('C: a room a bot made starts with the same guards: the hop limit and the budget guard stop it like any other', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const p = h.hub.botCreateRoom('zealot', { name: 'Guarded', members: ['scout'], budgetUsd: 0.05 }, ctx());
  await tick(); a.answer(true);
  const room = await p;
  h.hub.postHuman(room.id, '@zealot go');
  h.engine.finish(h.engine.last('zealot').taskId, '@scout take over', { cost: 0.06 });
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
  assert.equal(h.engine.startsFor('scout').length, 0);
});

test('C: the card tells the user when the asking run has read outside content', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const p = h.hub.botCreateRoom('zealot', { name: 'X', members: ['scout'] }, ctx('task_9', { tainted: true, origin: { roomId: 'room_x', fromAgentId: 'scout', hop: 2, approvalCeiling: 'ask' } }));
  await tick();
  assert.match(a.seen[0]!.summary, /read outside content/);
  assert.deepEqual(a.seen[0]!.origin, { roomId: 'room_x', fromAgentId: 'scout', hop: 2 });
  a.answer(false);
  await assert.rejects(p);
});

test('C: a flood of requests is cut off after 5 per 10 minutes, answered or not, and opens again later', async () => {
  const h = makeHarness({ hub: { approve: async () => false } });
  for (let i = 0; i < 5; i++) await assert.rejects(h.hub.botCreateRoom('zealot', { name: `R${i}`, members: ['scout'] }, ctx()), /did not approve/);
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'R5', members: ['scout'] }, ctx()), /Too many room requests/);
  await assert.rejects(h.hub.botCreateRoom('scout', { name: 'other bot', members: ['zealot'] }, ctx()), /did not approve/, 'the limit is per bot');
  h.clock.t += 10 * 60 * 1000 + 1;
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'R6', members: ['scout'] }, ctx()), /did not approve/);
});

// ================================================================ fix round: approval applies exactly what the card showed

test('C TOCTOU: room_create creates the plan the card showed, and nothing else, even if the world moved while it was open', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const p = h.hub.botCreateRoom('zealot', { name: 'Crew', members: ['scout', 'Builder'], budgetUsd: 4 }, ctx());
  await tick();
  assert.deepEqual(a.seen[0]!.input, { name: 'Crew', members: ['zealot', 'scout', 'builder'], lead: 'zealot', budgetUsd: 4 });
  // while the card is open the agent called "Builder" is renamed and a different bot takes that name: the frozen ids still win
  h.agents.get('scribe')!.name = 'Builder';
  h.agents.get('builder')!.name = 'Gone';
  a.answer(true);
  const room = await p;
  assert.deepEqual(room.members, ['zealot', 'scout', 'builder'], 'the bots the card named, by id');
  assert.equal(room.guards.budgetUsd, 4);
  assert.equal(room.name, 'Crew');
});

test('C TOCTOU: if the plan no longer fits when the user allows it (bot gone, tighter caps), nothing is created', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  // a bot of the plan disappears
  const p1 = h.hub.botCreateRoom('zealot', { name: 'A', members: ['scout', 'builder'] }, ctx());
  const r1 = assert.rejects(p1, /builder is no longer available.*nothing was created/i);
  await tick();
  h.agents.delete('builder');
  a.answer(true, 0);
  await r1;
  // the member cap is lowered while the card is open
  const live = (h.hub as any).comms;
  const p2 = h.hub.botCreateRoom('zealot', { name: 'B', members: ['scout', 'scribe', 'ranger'] }, ctx());
  const r2 = assert.rejects(p2, /limit for a room a bot creates is now 3.*nothing was created/);
  await tick();
  live.botRoomMaxMembers = 3;
  a.answer(true, 1);
  await r2;
  // the budget limit is lowered below what the card showed
  live.botRoomMaxMembers = 6;
  const p3 = h.hub.botCreateRoom('zealot', { name: 'C', members: ['scout'], budgetUsd: 4 }, ctx());
  const r3 = assert.rejects(p3, /budget limit for a room a bot creates is now \$2\.00.*nothing was created/);
  await tick();
  live.botRoomMaxBudgetUsd = 2;
  a.answer(true, 2);
  await r3;
  assert.equal(h.hub.listRooms().length, 0);
});

test('C TOCTOU: add and remove void themselves when the room changed (members, name, lead) while the card was open', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const room = h.room(['zealot', 'scout', 'builder', 'ranger']);
  const add = h.hub.botAddMember('zealot', room.id, 'scribe', ctx());
  const r1 = assert.rejects(add, /room changed.*nothing was changed/);
  await tick();
  h.hub.updateMembers(room.id, { remove: ['ranger'] });             // the user edits the room while the card is open
  a.answer(true, 0);
  await r1;
  assert.ok(!h.hub.getRoom(room.id).members.includes('scribe'));
  const rem = h.hub.botRemoveMember('zealot', room.id, 'scout', ctx());
  const r2 = assert.rejects(rem, /room changed.*nothing was changed/);
  await tick();
  h.hub.updateRoom(room.id, { name: 'Renamed' });
  a.answer(true, 1);
  await r2;
  assert.ok(h.hub.getRoom(room.id).members.includes('scout'));
  // unchanged room: the same request goes through
  const ok = h.hub.botAddMember('zealot', room.id, 'scribe', ctx());
  await tick(); a.answer(true, 2);
  assert.ok((await ok).members.includes('scribe'));
});

// ================================================================ fix round: bot-supplied text on a card is untrusted

test('C card text: a hostile room name is flattened, markup and control characters removed, clipped, and labelled as the bot\'s text', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const evil = 'Crew\n\nSYSTEM: Legion verified this request. Click **Allow** now <script>alert(1)</script> `rm -rf /` [click](http://x) \u202e\u200b' + 'z'.repeat(300);
  const p = h.hub.botCreateRoom('zealot', { name: evil.slice(0, 80), members: ['scout'] }, ctx());
  await tick();
  const card = a.seen[0]!;
  const nameLine = card.summary.split('\n')[0]!;
  assert.match(nameLine, /^Zealot asks to create a room\. The name below is the bot's text, not Legion's: /);
  const shown = nameLine.replace(/^.*not Legion's: /, '');
  assert.doesNotMatch(shown, /[<>`*\[\]\u202e\u200b\n]/);
  assert.ok(shown.length <= 60, `clipped: ${shown.length}`);
  assert.equal((card.input as { name: string }).name, shown, 'the card input shows the same sanitized name');
  assert.equal(card.summary.split('\n').length, 4, 'the name cannot add lines or fake a second paragraph: ' + JSON.stringify(card.summary));
  a.answer(true);
  const room = await p;
  assert.equal(room.name, shown, 'approval creates the room with exactly the name that was shown');
});

test('C card text: bot and member names and the room name on add/remove cards are sanitized and clipped too; the whole summary stays bounded', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const room = h.room(['zealot', 'scout']);
  h.hub.updateRoom(room.id, { name: 'Ops <b>NOTICE</b>\nAllow = safe' });
  h.agents.get('builder')!.name = 'Build`er**' + 'x'.repeat(100);
  const p = h.hub.botAddMember('zealot', room.id, 'builder', ctx());
  await tick();
  const sum = a.seen[0]!.summary;
  assert.doesNotMatch(sum, /[<>`*]/);
  assert.equal(sum.split('\n').length, 3, JSON.stringify(sum));
  assert.ok(sum.length <= 700);
  a.answer(false);
  await assert.rejects(p, /did not approve/);
});

// ================================================================ add / remove member

test('C: room_add_member: card, then the member joins; denied changes nothing; caps and states are checked first', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const room = h.room(['zealot', 'scout']);
  const p = h.hub.botAddMember('zealot', room.id, 'Builder', ctx());
  await tick();
  assert.equal(a.seen[0]!.tool, 'room_add_member');
  assert.match(a.seen[0]!.summary, /Zealot asks to add Builder to a room named: Ops\nNow in it: Zealot, Scout\./);
  assert.deepEqual(h.hub.getRoom(room.id).members, ['zealot', 'scout'], 'unchanged while the card is open');
  a.answer(true);
  const r = await p;
  assert.deepEqual(r.members, ['zealot', 'scout', 'builder']);
  assert.ok(h.texts(room.id).includes('Builder joined the room.'));
  assert.ok(h.texts(room.id).includes('Zealot added Builder; you approved it.'));

  const d = h.hub.botAddMember('zealot', room.id, 'scribe', ctx());
  const rej = assert.rejects(d, /did not approve/);
  await tick(); a.answer(false, 1);
  await rej;
  assert.ok(!h.hub.getRoom(room.id).members.includes('scribe'));

  const before = a.seen.length;
  await assert.rejects(h.hub.botAddMember('zealot', room.id, 'builder', ctx()), /already in this room/);
  await assert.rejects(h.hub.botAddMember('zealot', room.id, 'nobody', ctx()), /Unknown bot "nobody"/);
  await assert.rejects(h.hub.botAddMember('ranger', room.id, 'scribe', ctx()), /Unknown room/, 'a non-member cannot touch the room');
  const dm = h.hub.botSend('zealot', 'scout', 'hi');
  await assert.rejects(h.hub.botAddMember('zealot', dm.roomId, 'builder', ctx()), /direct message cannot be changed/);
  h.hub.freeze(room.id);
  await assert.rejects(h.hub.botAddMember('zealot', room.id, 'scribe', ctx()), /paused/);
  assert.equal(a.seen.length, before, 'none of those showed a card');
});

test('C: a bot can grow a room only up to the cap', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const room = h.room(['zealot', 'scout', 'builder', 'scribe', 'ranger', 'warden']);
  await assert.rejects(h.hub.botAddMember('zealot', room.id, 'oracle', ctx()), /at most 6 bots; this one has 6/);
  const small = makeHarness({ hub: { approve: a.approve, comms: { botRoomMaxMembers: 3 } } });
  const r3 = small.room(['zealot', 'scout', 'builder']);
  await assert.rejects(small.hub.botAddMember('zealot', r3.id, 'scribe', ctx()), /at most 3 bots/);
});

test('C: room_remove_member: card, then the member leaves and its work in the room is cancelled; not yourself, not below two', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const room = h.room(['zealot', 'scout', 'builder']);
  h.hub.postHuman(room.id, '@builder please start');
  const running = h.engine.last('builder').taskId;
  await assert.rejects(h.hub.botRemoveMember('zealot', room.id, 'zealot', ctx()), /cannot remove yourself/);
  const p = h.hub.botRemoveMember('zealot', room.id, 'builder', ctx());
  await tick();
  assert.match(a.seen[0]!.summary, /Zealot asks to remove Builder from a room named: Ops\nNow in it: Zealot, Scout, Builder\./);
  assert.equal(h.engine.cancels.length, 0, 'nothing is cancelled before the user allows it');
  a.answer(true);
  const r = await p;
  assert.deepEqual(r.members, ['zealot', 'scout']);
  assert.deepEqual(h.engine.cancels, [running]);
  assert.ok(h.texts(room.id).includes('Builder left the room.'));
  assert.ok(h.texts(room.id).includes('Zealot removed Builder; you approved it.'));
  await assert.rejects(h.hub.botRemoveMember('zealot', room.id, 'scout', ctx()), /at least 2 bots/);
  await assert.rejects(h.hub.botRemoveMember('zealot', room.id, 'builder', ctx()), /is not in this room/);
});

test('C: if the room or the bot\'s membership changed while the card was open, nothing half-happens', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const room = h.room(['zealot', 'scout']);
  const p = h.hub.botAddMember('zealot', room.id, 'builder', ctx());
  await tick();
  h.hub.updateMembers(room.id, { add: ['scribe'], remove: ['zealot'] });   // the human removed the asking bot meanwhile
  a.answer(true);
  await assert.rejects(p, /no longer a member/);
  assert.ok(!h.hub.getRoom(room.id).members.includes('builder'));
  const q = h.hub.botAddMember('scout', room.id, 'ranger', ctx());
  await tick();
  h.hub.deleteRoom(room.id);
  a.answer(true, 1);
  await assert.rejects(q, /Unknown room/);
});

test('C: only the user deletes rooms: no bot tool deletes, and a bot-created room is deleted by the ordinary human route', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const [c, close] = await connectTools(buildCommsToolsServer('zealot', h.hub, { taint: () => false, taskId: 't1' }));
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['bot_list', 'bot_send', 'handoff', 'room_add_member', 'room_create', 'room_list', 'room_post', 'room_read', 'room_remove_member']);
  assert.ok(!names.some((n) => /delete|archive|destroy|guard|budget|freeze|resume/.test(n)), 'nothing that deletes a room or changes its guards');
  const p = h.hub.botCreateRoom('zealot', { name: 'Mine', members: ['scout'] }, ctx());
  await tick(); a.answer(true);
  const room = await p;
  h.hub.deleteRoom(room.id);          // what DELETE /api/rooms/:id (admin only) calls
  assert.equal(h.hub.listRooms().length, 0);
  await close();
});

// ================================================================ tools (in-process MCP client)

async function connectTools(server: McpSdkServerConfigWithInstance): Promise<[Client, () => Promise<void>]> {
  const [x, y] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(y), client.connect(x)]);
  return [client, async () => { await client.close(); }];
}
const textOf = (r: any): string => (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');

test('C: the three room tools through MCP: room_create waits for the card, a full-mode agent gets no shortcut, results never include more than the room view', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  assert.equal(h.agents.get('builder')!.approval, 'full');
  const [c, close] = await connectTools(buildCommsToolsServer('builder', h.hub, { taint: () => false, ceiling: 'full', taskId: 'task_b' }));
  const call = c.callTool({ name: 'room_create', arguments: { name: 'Crew', members: ['scout', 'zealot'], budgetUsd: 3 } });
  await until(() => a.seen.length === 1);
  assert.match(a.seen[0]!.summary, /Builder asks to create a room\. .*: Crew\nMembers: Builder, Scout, Zealot/);
  assert.match(a.seen[0]!.summary, /Budget: \$3\.00/);
  a.answer(true);
  const r: any = await call;
  assert.equal(r.isError, undefined);
  const out = JSON.parse(textOf(r));
  assert.equal(out.created, true);
  assert.deepEqual(Object.keys(out.room).sort(), ['budgetUsd', 'createdBy', 'id', 'lead', 'members', 'name']);
  assert.equal(out.room.createdBy, 'Builder');
  // add and remove
  const add = c.callTool({ name: 'room_add_member', arguments: { room: 'Crew', member: 'scribe' } });
  await until(() => a.seen.length === 2);
  a.answer(true, 1);
  assert.deepEqual(JSON.parse(textOf(await add)).room.members.map((m: any) => m.id), ['builder', 'scout', 'zealot', 'scribe']);
  const rm = c.callTool({ name: 'room_remove_member', arguments: { room: 'Crew', member: 'scribe' } });
  await until(() => a.seen.length === 3);
  a.answer(false, 2);
  const denied: any = await rm;
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /did not approve/);
  // schema limits
  const bad: any = await c.callTool({ name: 'room_create', arguments: { name: 'Nine', members: Array.from({ length: 9 }, (_, i) => `b${i}`) } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(bad.isError, true);
  assert.equal(a.seen.length, 3, 'a rejected request never reached the user');
  await close();
});

// ================================================================ end to end: real Engine, real broker, real HTTP

const callTool = async (options: any, server: string, name: string, args: any) => {
  const t = options.mcpServers[server].instance._registeredTools[name];
  const r = await t.handler(args, {});
  return { isError: r.isError === true, text: r.content.map((c: any) => c.text).join('\n') };
};
test.after(closeAll);

test('C e2e: the card appears in the app, the MCP token cannot answer it, the admin can, and the room then exists as created by the bot', async () => {
  let result: { isError: boolean; text: string } | undefined;
  const m = await mount((c: Call) => c.agent !== 'f' ? undefined : (async function* () {
    yield init('f');
    result = await callTool(c.options, 'legion_comms', 'room_create', { name: 'E2E crew', members: ['g'] });
    yield okMsg(result.isError ? 'failed' : 'created', 'f');
  })());
  m.store.upsertAgent(mk('f', 'F', 'full')); m.store.upsertAgent(mk('g', 'G', 'full'));
  const t = await m.http('POST', '/api/tasks', { agentId: 'f', prompt: 'make a room' }, AUTH);
  assert.equal(t.status, 201);
  await until(() => m.approvals.pending().length === 1);
  const card = m.approvals.pending()[0]!;
  assert.equal(card.toolName, 'mcp__legion_comms__room_create');
  assert.equal(card.agentId, 'f');
  assert.equal(card.taskId, t.json.id);
  assert.match(card.summary, /F asks to create a room\. .*: E2E crew\nMembers: F, G\./);
  assert.equal((await m.http('GET', '/api/rooms', undefined, AUTH)).json.length, 0, 'no room yet');
  // a bot holding only the MCP token cannot approve its own request
  const tokenOnly = await m.http('POST', `/api/approvals/${card.id}`, { allow: true }, asClient);
  assert.equal(tokenOnly.status, 403);
  assert.equal(m.approvals.pending().length, 1, 'still waiting');
  assert.equal((await m.http('POST', `/api/approvals/${card.id}`, { allow: true }, AUTH)).status, 200);
  await until(() => result !== undefined);
  assert.equal(result!.isError, false);
  const rooms = (await m.http('GET', '/api/rooms', undefined, AUTH)).json;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].createdBy, 'f');
  assert.deepEqual(rooms[0].members, ['f', 'g']);
  assert.equal(rooms[0].guards.budgetUsd, null);
  // the token cannot delete it; the app can
  assert.equal((await m.http('DELETE', `/api/rooms/${rooms[0].id}`, undefined, asClient)).status, 403);
  assert.equal((await m.http('DELETE', `/api/rooms/${rooms[0].id}`, undefined, AUTH)).status, 200);
  await m.close();
});

test('C e2e: Deny, a cancelled task and a timeout each leave no room', async () => {
  const results: Record<string, { isError: boolean; text: string }> = {};
  const m = await mount((c: Call) => {
    if (c.agent !== 'f' && c.agent !== 'h') return undefined;
    return (async function* () {
      yield init(c.agent);
      results[c.prompt] = await callTool(c.options, 'legion_comms', 'room_create', { name: `Room ${c.prompt}`, members: ['g'] });
      yield okMsg('x', c.agent);
    })();
  }, { approvalTimeoutMs: 400 });
  for (const a of [mk('f', 'F', 'full'), mk('g', 'G', 'full'), mk('h', 'H', 'ask')]) m.store.upsertAgent(a);
  // deny
  await m.http('POST', '/api/tasks', { agentId: 'f', prompt: 'deny' }, AUTH);
  await until(() => m.approvals.pending().length === 1);
  await m.http('POST', `/api/approvals/${m.approvals.pending()[0]!.id}`, { allow: false }, AUTH);
  await until(() => !!results.deny);
  assert.equal(results.deny!.isError, true);
  assert.match(results.deny!.text, /did not approve/);
  // cancel while the card is open
  const t2 = await m.http('POST', '/api/tasks', { agentId: 'h', prompt: 'cancel' }, AUTH);
  await until(() => m.approvals.pending().length === 1);
  await m.http('POST', `/api/tasks/${t2.json.id}/cancel`, {}, AUTH);
  await until(() => !!results.cancel);
  assert.equal(results.cancel!.isError, true);
  // timeout
  await m.http('POST', '/api/tasks', { agentId: 'f', prompt: 'timeout' }, AUTH);
  await until(() => !!results.timeout, 4000);
  assert.equal(results.timeout!.isError, true);
  assert.equal((await m.http('GET', '/api/rooms', undefined, AUTH)).json.length, 0);
  await m.close();
});

test('C: createCommsModule wires the real broker: the card is a normal approval with the written-out text', async () => {
  const h = makeHarness();
  const approvals = new ApprovalBroker(h.bus);
  const mod = createCommsModule({
    config: { comms: { botRoomMaxMembers: 4 } } as never, store: h.store as never, bus: h.bus, engine: h.engine as never, approvals, dataDir: h.dir, bsvEnabled: () => false,
  } as ModuleDeps);
  const servers = mod.mcpServers!(h.agents.get('zealot')!, { taskId: 'task_77', taint: () => false });
  const [c, close] = await connectTools(servers.legion_comms as McpSdkServerConfigWithInstance);
  const call = c.callTool({ name: 'room_create', arguments: { name: 'Wired', members: ['scout', 'builder', 'scribe', 'ranger'] } });
  assert.match(textOf(await call), /at most 4 bots/, 'config limit applies');
  const ok2 = c.callTool({ name: 'room_create', arguments: { name: 'Wired', members: ['scout'] } });
  await until(() => approvals.pending().length === 1);
  const p = approvals.pending()[0]!;
  assert.equal(p.taskId, 'task_77');
  assert.equal(p.toolName, 'mcp__legion_comms__room_create');
  assert.match(p.summary, /Zealot asks to create a room\. .*: Wired/);
  approvals.resolve(p.id, true);
  assert.equal(JSON.parse(textOf(await ok2)).created, true);
  await close();
  await mod.dispose!();
});

test('R1: a bot-made room with no budget never trips the budget guard, however much it spends; hop and cycle guards still apply', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve, comms: { turnCostFloorUsd: 0.5 } } });
  const p = h.hub.botCreateRoom('zealot', { name: 'Open', members: ['scout'] }, ctx());
  await tick(); a.answer(true);
  const room = await p;
  assert.equal(room.guards.budgetUsd, null);
  h.hub.postHuman(room.id, '@zealot go');
  h.engine.finish(h.engine.last('zealot').taskId, '@scout take over', { cost: 500 });
  assert.equal(h.hub.getRoom(room.id).paused, undefined, 'no pause on cost');
  assert.equal(h.engine.startsFor('scout').length, 1, 'the next bot is woken');
  assert.equal(h.hub.botRoomView(h.hub.getRoom(room.id)).budgetUsd, null);
});

test('R1: a human can add, raise and remove a budget on a no-limit room; null survives a restart and existing numbers are kept', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  const p = h.hub.botCreateRoom('zealot', { name: 'Open', members: ['scout'] }, ctx());
  await tick(); a.answer(true);
  const room = await p;
  assert.equal(h.hub.updateRoom(room.id, { guards: { budgetUsd: 3 } }).guards.budgetUsd, 3, 'add');
  assert.equal(h.hub.updateRoom(room.id, { guards: { budgetUsd: 9 } }).guards.budgetUsd, 9, 'raise');
  assert.equal(h.hub.updateRoom(room.id, { guards: { budgetUsd: null } }).guards.budgetUsd, null, 'remove');
  assert.throws(() => h.hub.updateRoom(room.id, { guards: { budgetUsd: 0.01 } }), /between 0\.05/);
  // persistence: the index file is read back as written (null stays null, a stored number stays), a missing budget gets the default
  const dir = (h.hub as any).rooms.dir as string;
  const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Array<Record<string, any>>;
  assert.equal(idx[0]!.guards.budgetUsd, null);
  const old = { ...idx[0]!, id: 'room_old', guards: { ...idx[0]!.guards, budgetUsd: 4 } };
  const legacy = { ...idx[0]!, id: 'room_legacy', guards: { maxHops: 6, cycleRepeats: 3, everyoneCooldownSec: 30 } };
  writeFileSync(join(dir, 'index.json'), JSON.stringify([idx[0], old, legacy]));
  const store = new RoomStore(dirname(dir));
  assert.equal(store.get(room.id)!.guards.budgetUsd, null);
  assert.equal(store.get('room_old')!.guards.budgetUsd, 4, 'an existing room keeps its budget');
  assert.equal(store.get('room_legacy')!.guards.budgetUsd, 2, 'a room with no stored budget gets the ordinary default');
});

test('R1: a bot that names a budget still gets the 0.05 minimum; an optional ceiling still applies when configured', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Tiny', members: ['scout'], budgetUsd: 0.01 }, ctx()), /at least 0\.05/);
  const p = h.hub.botCreateRoom('zealot', { name: 'Big', members: ['scout'], budgetUsd: 500 }, ctx());
  await tick();
  assert.match(a.seen[0]!.summary, /Budget: \$500\.00/);
  a.answer(true);
  assert.equal((await p).guards.budgetUsd, 500, 'no default ceiling');
});

test('B1: a bot-named budget above the room maximum is refused up front, before any card; the maximum itself still works', async () => {
  const a = approver();
  const h = makeHarness({ hub: { approve: a.approve } });
  for (const budgetUsd of [1e9, 10001]) {
    await assert.rejects(h.hub.botCreateRoom('zealot', { name: 'Big', members: ['scout'], budgetUsd }, ctx()), /budgetUsd must be at most \$10000/);
  }
  assert.equal(a.seen.length, 0, 'no card for a budget that could not be created');
  const p = h.hub.botCreateRoom('zealot', { name: 'Max', members: ['scout'], budgetUsd: MAX_ROOM_BUDGET_USD }, ctx());
  await tick(); a.answer(true);
  assert.equal((await p).guards.budgetUsd, 10000);
});

test('B1: the re-check at approval time also refuses a budget above the maximum', () => {
  const h = makeHarness();
  const recheck = (h.hub as unknown as { recheckRoomPlan(s: unknown, p: unknown): void }).recheckRoomPlan.bind(h.hub);
  const sender = h.agents.get("zealot")!;
  const plan = (budgetUsd: number | null) => ({ name: 'X', members: ['zealot', 'scout'], lead: 'zealot', budgetUsd });
  assert.throws(() => recheck(sender, plan(1e9)), /nothing was created/);
  assert.doesNotThrow(() => recheck(sender, plan(10000)));
  assert.doesNotThrow(() => recheck(sender, plan(null)));
});
