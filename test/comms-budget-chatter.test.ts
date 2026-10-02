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

test('D: a $0, negative or below-minimum budget is refused at the door, and a stored one cannot wedge the room', () => {
  const h = makeHarness();
  for (const bad of [0, -1, 0.01, 0.049]) {
    assert.throws(() => h.room(['zealot', 'scout'], { guards: { budgetUsd: bad } }), /guards\.budgetUsd must be a number between 0\.05 and 10000/, String(bad));
  }
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 0.05 } });
  assert.throws(() => h.hub.updateRoom(room.id, { guards: { budgetUsd: 0 } }), /between 0\.05/);
  assert.throws(() => h.hub.updateRoom(room.id, { guards: { budgetUsd: -5 } }), /between 0\.05/);
  // a room file written by hand or by an older build with a $0 budget still gets its first turn (the floor applies at the guard too)
  (h.hub as any).mustRoom(room.id).guards.budgetUsd = 0;
  h.hub.postHuman(room.id, '@zealot hi');
  assert.equal(h.engine.startsFor('zealot').length, 1, 'the first turn runs');
  assert.equal(h.hub.getRoom(room.id).paused, undefined);
});

test('D: the first turn of a room with nothing spent always runs, even when the turn estimate is above the budget', () => {
  const h = makeHarness({ hub: { comms: { botRoomMaxMembers: 6, botRoomDefaultBudgetUsd: 1, botRoomMaxBudgetUsd: 5, turnCostFloorUsd: 0.5 } } });
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 0.05 } });
  h.hub.postHuman(room.id, '@zealot hi');
  assert.equal(h.engine.startsFor('zealot').length, 1, 'not wedged at birth');
  reply(h, 'zealot', 'hello', 0.2);
  h.hub.postHuman(room.id, '@zealot again');
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget', 'after money was spent the guard applies as usual');
});

test('D: a human message that a budget stop kept from waking its bot is held and delivered on resume (also one sent while paused)', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 0.05 } });
  h.hub.postHuman(room.id, '@zealot first');
  reply(h, 'zealot', 'ok', 0.2);                                   // over budget now
  h.hub.postHuman(room.id, '@scout IMPORTANT-ONE');               // trips the stop: not delivered, but kept
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
  assert.equal(h.engine.startsFor('scout').length, 0);
  h.hub.postHuman(room.id, '@zealot IMPORTANT-TWO');              // sent while paused
  assert.equal(h.engine.startsFor('zealot').length, 1);
  h.hub.updateRoom(room.id, { guards: { budgetUsd: 5 } });
  h.hub.resume(room.id);
  assert.equal(h.engine.startsFor('scout').length, 1, 'IMPORTANT-ONE reached scout');
  assert.match(h.engine.last('scout').prompt, /IMPORTANT-ONE/);
  assert.equal(h.engine.startsFor('zealot').length, 2, 'IMPORTANT-TWO reached zealot');
  assert.match(h.engine.last('zealot').prompt, /IMPORTANT-TWO/);
  assert.match(h.texts(room.id).join('\n'), /Delivering 2 messages that arrived while it was paused/);
  // nothing is delivered twice by a second resume
  h.hub.resume(room.id);
  assert.equal(h.engine.startsFor('scout').length, 1);
});

test('D: still short of money at resume pauses again and keeps the held message; a freeze drops it', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: 0.05 } });
  h.hub.postHuman(room.id, '@zealot first');
  reply(h, 'zealot', 'ok', 0.2);
  h.hub.postHuman(room.id, '@scout KEEP-ME');
  h.hub.resume(room.id);                                                      // budget unchanged
  assert.equal(h.hub.getRoom(room.id).paused?.reason, 'budget');
  assert.equal(h.engine.startsFor('scout').length, 0);
  h.hub.updateRoom(room.id, { guards: { budgetUsd: 5 } });
  h.hub.resume(room.id);
  assert.equal(h.engine.startsFor('scout').length, 1);
  assert.match(h.engine.last('scout').prompt, /KEEP-ME/);
  // a freeze is deliberate: what was held is dropped, not replayed later
  const r2 = h.room(['builder', 'scout'], { guards: { budgetUsd: 0.05 } });
  h.hub.postHuman(r2.id, '@builder go');
  reply(h, 'builder', 'ok', 0.2);
  h.hub.postHuman(r2.id, '@scout HELD-THEN-FROZEN');
  h.hub.freeze(r2.id);
  h.hub.updateRoom(r2.id, { guards: { budgetUsd: 5 } });
  const before = h.engine.startsFor('scout').length;
  h.hub.resume(r2.id);
  assert.equal(h.engine.startsFor('scout').length, before);
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
  const b = h.hub.roomPost('scout', room.id, 'LEAD-TEST-1', undefined, SENDER);
  assert.equal(b.id, a.id, 'the earlier message is returned');
  assert.equal((b as { duplicate?: boolean }).duplicate, true);
  assert.equal(botMsgs(h, room.id, 'scout').length, 1);
  reply(h, 'scout', 'LEAD-TEST-1');                          // the final answer is the same words again
  assert.equal(botMsgs(h, room.id, 'scout').length, 1, 'the auto-post of the final answer is suppressed too');
});

test('E: only an exact repeat to the same recipients inside the window is suppressed; similar, prefix or reworded messages are real messages', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder'], { guards: { maxHops: 50, cycleRepeats: 50 } });
  const first = h.hub.roomPost('scout', room.id, '@zealot the build is green', undefined, SENDER);
  const exact = h.hub.roomPost('scout', room.id, '@zealot the build is green', undefined, SENDER);
  assert.equal(exact.id, first.id, 'exactly the same words to the same bot');
  for (const text of ['@zealot The build is green!!', '@zealot the build is green.', '@zealot the build is green on step 3', '@zealot the build', '@zealot the build is green, and tests pass', '@zealot the build is GREEN']) {
    const m = h.hub.roomPost('scout', room.id, text, undefined, SENDER);
    assert.notEqual(m.id, first.id, `"${text}" is its own message`);
  }
  const other = h.hub.roomPost('scout', room.id, '@builder the build is green', undefined, SENDER);
  assert.notEqual(other.id, first.id, 'a different recipient is a different message');
  const again = h.hub.roomPost('scout', room.id, '@builder the build is green', undefined, SENDER);
  assert.equal(again.id, other.id);
  h.clock.t += 61_000;
  const later = h.hub.roomPost('scout', room.id, '@zealot the build is green', undefined, SENDER);
  assert.notEqual(later.id, first.id, 'after the window the same words are allowed again');
});

test('E: a message that differs only in what it quotes is not eaten (two reports that share a long prefix)', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  const head = 'Test run finished: the suite has the following failures and the details are listed below, ';
  const a = h.hub.roomPost('scout', room.id, '@zealot ' + head + 'test A failed', undefined, SENDER);
  const b = h.hub.roomPost('scout', room.id, '@zealot ' + head + 'test B failed', undefined, SENDER);
  assert.notEqual(a.id, b.id);
  assert.equal(botMsgs(h, room.id, 'scout').length, 2);
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
  const b = h.hub.botSend('scout', 'zealot', 'status of LEAD-TEST-1?', undefined, SENDER);
  assert.equal(b.id, a.id);
  assert.equal(h.engine.startsFor('zealot').length, 1);
  const c = h.hub.botSend('scout', 'zealot', 'Status of LEAD-TEST-1', undefined, SENDER);
  assert.notEqual(c.id, a.id, 'not word for word, so a message of its own');
});

test('E: an identical handoff twice is delivered once; a handoff to a different bot is not a duplicate', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  const a = h.hub.handoff('zealot', room.id, 'scout', 'You lead now', SENDER);
  const b = h.hub.handoff('zealot', room.id, 'scout', 'You lead now', SENDER);
  assert.equal(b.id, a.id);
  assert.equal(h.engine.startsFor('scout').length, 1);
  const reworded = h.hub.handoff('zealot', room.id, 'scout', 'you lead now.', SENDER);
  assert.notEqual(reworded.id, a.id, 'reworded is not identical');
  const c = h.hub.handoff('zealot', room.id, 'builder', 'You lead now', SENDER);
  assert.notEqual(c.id, a.id);
  assert.equal(h.hub.getRoom(room.id).lead, 'builder');
});

// ================================================================ B (rooms side): a sender can pick the model for the woken bot's turn

test('B: bot_send and room_post can ask for a model; it reaches the engine for that turn and shows in the transcript line', () => {
  const h = makeHarness();
  h.agents.get('builder')!.model = 'opus';   // an agent fixed to opus may be asked for opus; an auto or sonnet one may not (cap test below)
  const room = h.room(['zealot', 'scout', 'builder']);
  const dm = h.hub.botSend('zealot', 'scout', 'quick check please', undefined, SENDER, { model: 'Haiku' });
  assert.equal(dm.model, 'haiku', 'normalised');
  assert.equal(h.engine.last('scout').model, 'haiku');
  assert.equal(h.engine.last('scout').modelOverrideBy, 'zealot');
  const post = h.hub.roomPost('zealot', room.id, '@builder run the tests', undefined, SENDER, { model: 'opus' });
  assert.equal(h.messages(room.id).find((m) => m.id === post.id)!.model, 'opus', 'stored with the message (the room transcript line)');
  assert.equal(h.engine.last('builder').model, 'opus');
  assert.match(h.hub.roomRead('scout', room.id).text, /<bot-message [^>]*model="opus"/);
  const md = h.hub.exportRoom(room.id, 'md') as string;
  assert.match(md, /asked for opus/);
  // without a model nothing is recorded or passed
  const plain = h.hub.roomPost('zealot', room.id, '@scout and you?', undefined, SENDER);
  assert.equal(h.messages(room.id).find((m) => m.id === plain.id)!.model, undefined);
  assert.equal(h.engine.last('scout').model, undefined);
  assert.equal(h.engine.last('scout').modelOverrideBy, undefined);
});

test('B: a model that is not sonnet, opus, haiku or auto is refused in rooms too, and the model does not change the ceiling the wake carries', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  h.agents.get('scout')!.model = 'opus';
  assert.throws(() => h.hub.roomPost('zealot', room.id, '@scout hi', undefined, SENDER, { model: 'gpt-5' }), /model must be one of: sonnet, opus, haiku, auto/);
  assert.equal(h.engine.starts.length, 0);
  h.hub.roomPost('zealot', room.id, '@scout hi', undefined, { ceiling: 'ask' }, { model: 'opus' });
  assert.equal(h.engine.last('scout').origin?.approvalCeiling, 'ask');
});

test('B cap: a post cannot ask a sonnet or auto bot for opus; nothing is posted or woken; haiku, sonnet and auto pass', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  h.agents.get('builder')!.model = 'sonnet';                       // scout stays 'auto'
  for (const to of ['scout', 'builder']) {
    assert.throws(() => h.hub.roomPost('zealot', room.id, `@${to} think hard`, undefined, SENDER, { model: 'opus' }), /above .* own model setting/, to);
    assert.throws(() => h.hub.botSend('zealot', to, 'think hard', undefined, SENDER, { model: 'opus' }), /above .* own model setting/, to);
  }
  assert.equal(h.engine.starts.length, 0, 'nobody was woken');
  assert.equal(botMsgs(h, room.id).length, 0, 'nothing was posted');
  for (const model of ['haiku', 'sonnet', 'auto']) h.hub.roomPost('zealot', room.id, `@scout hi ${model}`, undefined, SENDER, { model });
  assert.equal(h.engine.startsFor('scout').length, 1, 'the later ones queue behind the first wake');
  // two addressees, one over its ceiling: the whole post is refused
  h.agents.get('builder')!.model = 'opus';
  assert.throws(() => h.hub.roomPost('zealot', room.id, '@scout @builder hi', undefined, SENDER, { model: 'opus' }), /above .* own model setting/, 'scout (auto) is addressed too');
});

// ================================================================ E: handoff needs an explicit @mention

test('E: a handoff always names its receiver: text without @Name gets it added, text that has it is left as written', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  const a = h.hub.handoff('zealot', room.id, 'scout', 'Please take the lead', SENDER);
  assert.match(a.text, /^@Scout Please take the lead/);
  const b = h.hub.handoff('scout', room.id, 'builder', 'Over to @Builder for the tests', SENDER);
  assert.equal(b.text, 'Over to @Builder for the tests');
  assert.deepEqual(a.to, ['scout']);
  assert.deepEqual(b.to, ['builder']);
});

test('E: the receiving run wakes only bots it names with @; a handoff that names nobody else ends the chatter', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout', 'builder']);
  h.hub.postHuman(room.id, '@zealot go');
  h.hub.handoff('zealot', room.id, 'scout', 'You lead now', SENDER);
  reply(h, 'zealot', 'ok');
  reply(h, 'scout', 'Done. Builder and Zealot know the details already.');    // names nobody with @
  assert.equal(h.engine.startsFor('builder').length, 0);
  assert.equal(h.engine.startsFor('zealot').length, 1, 'the sender of the handoff is not woken back');
  assert.equal(h.hub.getRoom(room.id).paused, undefined);
});
