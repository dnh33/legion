/**
 * Builder B: the budget guard acts BEFORE a bot is woken (D), and a completed handoff ends the chatter (E).
 * Real CommsHub with the fake engine from comms-fakes.test.ts, fake costs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './comms-fakes.test.js';
import type { Harness } from './comms-fakes.test.js';

const reply = (h: Harness, agent: string, text: string | undefined, cost = 0.01) => h.engine.finish(h.engine.last(agent).taskId, text, { cost });
const botMsgs = (h: Harness, roomId: string, agent?: string) =>
  h.messages(roomId).filter((m) => m.from.kind === 'bot' && (!agent || (m.from as { agentId: string }).agentId === agent));
const SENDER = { ceiling: 'full' as const };

// ================================================================ D. budget is checked before the next turn

test('D: the room pauses BEFORE a wake that the last turns say would overshoot the budget (observed: paused at $2.43 on $2.00)', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 2 } });
  h.hub.postHuman(room.id, '@zealot start');
  reply(h, 'zealot', '@scout take over', 1.2);              // spent 1.20; the next turn would probably cost about the same
  assert.equal(h.engine.startsFor('scout').length, 0, 'scout was not woken');
  const r = h.hub.getRoom(room.id);
  assert.equal(r.paused?.reason, 'budget');
  assert.ok(r.costUsd <= 2, `cost stays under the budget (${r.costUsd})`);
  const g = h.guardMessages(room.id);
  assert.equal(g.length, 1);
  assert.match(g[0]!.text, /budget/);
  assert.match(g[0]!.text, /paused before the next turn would exceed it/);
  assert.match(g[0]!.text, /estimated next turn \$1\.20/);
});

test('D: the old wording still applies once the budget is already reached (no estimate in it)', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 0.05 } });
  h.hub.postHuman(room.id, '@zealot go');
  reply(h, 'zealot', '@scout take over', 0.06);
  const t = h.guardMessages(room.id)[0]!.text;
  assert.match(t, /reached its budget/);
  assert.doesNotMatch(t, /before the next turn/);
});

test('D: cheap turns keep going while the next one fits', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 2, maxHops: 50 } });
  h.hub.postHuman(room.id, '@zealot go');
  reply(h, 'zealot', '@scout one', 0.3);
  reply(h, 'scout', '@zealot two', 0.3);
  reply(h, 'zealot', '@scout three', 0.3);
  assert.equal(h.hub.getRoom(room.id).paused, undefined);
  assert.equal(h.engine.startsFor('scout').length, 2);
  reply(h, 'scout', '@zealot four', 0.3);                   // 1.2 spent, 1.5 with the next turn: fits
  assert.equal(h.engine.startsFor('zealot').length, 3, 'zealot: the human wake plus two replies');
  reply(h, 'zealot', '@scout five', 0.3);                   // 1.5 spent, 1.8 with the next turn: fits
  assert.equal(h.hub.getRoom(room.id).paused, undefined);
  reply(h, 'scout', '@zealot six', 0.3);                    // 1.8 spent, 2.1 would exceed: stop before waking
  const r = h.hub.getRoom(room.id);
  assert.equal(r.paused?.reason, 'budget');
  assert.ok(Math.abs(r.costUsd - 1.8) < 1e-9, `no turn ran past the budget (${r.costUsd})`);
  assert.equal(h.engine.startsFor('zealot').length, 3, 'no wake after the pause');
});

test('D: with no history a small floor still stops a room whose budget is below one turn', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 0.01 } });
  h.hub.postHuman(room.id, '@zealot hi');
  assert.equal(h.engine.startsFor('zealot').length, 0, 'nothing woke: even a first turn would exceed $0.01');
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
});

test('D: wakes that are already running are reserved for, so a broadcast cannot start more turns than the budget covers', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder', 'scribe'], { strategy: 'all', guards: { budgetUsd: 0.05 } });
  h.hub.postHuman(room.id, 'everyone, look at this');
  // floor $0.02 per turn: two fit under $0.05, the third would not
  assert.deepEqual(h.engine.starts.map((s) => s.agentId), ['zealot', 'scout']);
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
});

test('D: queued messages are not delivered when the finishing run leaves too little for another turn', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 1 } });
  h.hub.postHuman(room.id, '@scout one');
  h.hub.postHuman(room.id, '@scout two');                    // queued behind the running turn
  reply(h, 'scout', 'a', 0.6);                               // 0.60 spent, 1.20 with the next turn
  assert.equal(h.engine.startsFor('scout').length, 1);
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
});

test('D: raising the budget and resuming lets the room carry on', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 1 } });
  h.hub.postHuman(room.id, '@zealot go');
  reply(h, 'zealot', '@scout take over', 0.8);
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
  h.hub.updateRoom(room.id, { guards: { budgetUsd: 5 } });
  h.hub.resume(room.id);
  h.hub.postHuman(room.id, '@scout now you');
  assert.equal(h.engine.startsFor('scout').length, 1);
});

// ================================================================ E. handoff chatter

test('E: handing off and then finishing with the same words posts ONE message, not two (Scout posted LEAD-TEST-1 twice)', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { maxHops: 50 } });
  h.hub.postHuman(room.id, '@zealot lead this');
  h.hub.handoff('zealot', room.id, 'scout', 'Take the lead and report back with LEAD-TEST-1', SENDER);
  assert.equal(h.engine.startsFor('scout').length, 1);
  reply(h, 'zealot', 'Handed to @Scout.');                  // zealot's own wake ends
  // scout hands back, then ends its run with the same words
  h.hub.handoff('scout', room.id, 'zealot', 'LEAD-TEST-1', SENDER);
  reply(h, 'scout', '@Zealot LEAD-TEST-1');
  const mine = botMsgs(h, room.id, 'scout');
  assert.equal(mine.length, 1, 'only the handoff message: ' + mine.map((m) => m.text).join(' | '));
  assert.equal(mine[0]!.kind, 'handoff');
});

test('E: after the handback the old bot is not woken again and the lead is woken once', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { maxHops: 50 } });
  h.hub.postHuman(room.id, '@zealot lead this');
  h.hub.handoff('zealot', room.id, 'scout', 'Do the check, then give it back', SENDER);
  reply(h, 'zealot', 'Handing this to @Scout, @Scout please do the check.');   // must not wake scout a second time
  assert.equal(h.engine.startsFor('scout').length, 1, 'scout was woken by the handoff only');
  h.hub.handoff('scout', room.id, 'zealot', 'Check done: all green', SENDER);
  reply(h, 'scout', 'All green. @Zealot over to you.');                          // a final answer after the handback wakes nobody
  assert.equal(h.engine.startsFor('zealot').length, 2, 'zealot: the first wake plus the handback');
  reply(h, 'zealot', 'Thanks @Scout, nice work.');                                // the receiver of a handoff does not bounce back to the sender
  assert.equal(h.engine.startsFor('scout').length, 1, 'scout is not woken again');
  assert.equal(h.hub.getRoom(room.id).lead, 'zealot');
  assert.equal(h.hub.getRoom(room.id).paused, undefined);
});

test('E: a final answer that adds something after a handoff is kept but wakes nobody', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  h.hub.postHuman(room.id, '@scout look');
  h.hub.handoff('scout', room.id, 'zealot', 'Findings: three flaky tests', SENDER);
  reply(h, 'scout', 'Extra note for the record, @Builder may want this.');
  const texts = botMsgs(h, room.id, 'scout').map((m) => m.text);
  assert.ok(texts.some((t) => /Extra note/.test(t)), 'kept in the transcript');
  assert.equal(h.engine.startsFor('builder').length, 0, 'but it ends the wake chain');
});

test('E: a reply to a handoff may still wake other bots; only the bot that handed off is not woken back', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  h.hub.postHuman(room.id, '@zealot go');
  h.hub.handoff('zealot', room.id, 'scout', 'You lead now', SENDER);
  reply(h, 'zealot', 'ok');
  reply(h, 'scout', '@Builder please run the tests. @Zealot fyi.');
  assert.equal(h.engine.startsFor('builder').length, 1);
  assert.equal(h.engine.startsFor('zealot').length, 1, 'zealot handed off, so scout\'s answer does not wake it back');
});

test('E: the same post twice in one wake is stored once and the tool says so', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  h.hub.postHuman(room.id, '@scout report');
  const a = h.hub.roomPost('scout', room.id, 'LEAD-TEST-1', undefined, SENDER);
  const b = h.hub.roomPost('scout', room.id, 'lead test 1!', undefined, SENDER);
  assert.equal(b.id, a.id, 'the earlier message is returned');
  assert.equal((b as { duplicate?: boolean }).duplicate, true);
  assert.equal(botMsgs(h, room.id, 'scout').length, 1);
  reply(h, 'scout', 'LEAD-TEST-1');                          // the final answer is the same words again
  assert.equal(botMsgs(h, room.id, 'scout').length, 1, 'the auto-post of the final answer is suppressed too');
});

test('E: a near-duplicate by the same bot inside the window is suppressed, outside it is allowed, other recipients are not duplicates', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder'], { guards: { maxHops: 50, cycleRepeats: 50 } });
  const first = h.hub.roomPost('scout', room.id, '@zealot the build is green', undefined, SENDER);
  const near = h.hub.roomPost('scout', room.id, '@zealot The build is green!!', undefined, SENDER);
  assert.equal(near.id, first.id);
  const other = h.hub.roomPost('scout', room.id, '@builder the build is green', undefined, SENDER);
  assert.notEqual(other.id, first.id, 'a different recipient is a different message');
  h.clock.t += 61_000;
  const later = h.hub.roomPost('scout', room.id, '@zealot the build is green', undefined, SENDER);
  assert.notEqual(later.id, first.id, 'after the window the same words are allowed again');
  const different = h.hub.roomPost('scout', room.id, '@zealot the deploy failed on step 3', undefined, SENDER);
  assert.notEqual(different.id, later.id);
});

test('E: a suppressed duplicate wakes nobody and does not count toward the cycle guard', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { maxHops: 50, cycleRepeats: 3 } });
  h.hub.roomPost('scout', room.id, '@zealot ping', undefined, SENDER);
  reply(h, 'zealot', 'NO_REPLY');
  for (let i = 0; i < 4; i++) h.hub.roomPost('scout', room.id, '@zealot ping', undefined, SENDER);
  assert.equal(h.hub.getRoom(room.id).paused, undefined, 'no cycle pause from suppressed repeats');
  assert.equal(h.engine.startsFor('zealot').length, 1);
});

test('E: a DM bot_send repeated word for word is stored once', () => {
  const h = makeHarness();
  const a = h.hub.botSend('scout', 'zealot', 'status of LEAD-TEST-1?', undefined, SENDER);
  const b = h.hub.botSend('scout', 'zealot', 'Status of LEAD-TEST-1', undefined, SENDER);
  assert.equal(b.id, a.id);
  assert.equal(h.engine.startsFor('zealot').length, 1);
});

test('E: an identical handoff twice is delivered once; a handoff to a different bot is not a duplicate', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  const a = h.hub.handoff('zealot', room.id, 'scout', 'You lead now', SENDER);
  const b = h.hub.handoff('zealot', room.id, 'scout', 'you lead now.', SENDER);
  assert.equal(b.id, a.id);
  assert.equal(h.engine.startsFor('scout').length, 1);
  const c = h.hub.handoff('zealot', room.id, 'builder', 'You lead now', SENDER);
  assert.notEqual(c.id, a.id);
  assert.equal(h.hub.getRoom(room.id).lead, 'builder');
});
