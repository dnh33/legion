/**
 * Final-gate review fixes (G1, G5): a bot's final reply in a room, and 64-hex handling in room posts.
 * Uses the real CommsHub over the fake engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './comms-fakes.test.js';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
const KEYHEX = '0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d';

test('G1: a seed phrase in a bot final reply is never stored or sent; a short notice is stored instead', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  h.hub.postHuman(room.id, '@scout what is the recovery phrase?');
  h.engine.finish(h.engine.last('scout').taskId, `Sure, here it is: ${PHRASE}`);
  const msgs = h.messages(room.id);
  for (const m of msgs) assert.ok(!m.text.includes('abandon ability'), `stored message leaks the phrase: ${m.text}`);
  const note = msgs.find((m) => m.from.kind === 'system' && m.kind === 'note' && /seed phrase/i.test(m.text));
  assert.ok(note, 'a redaction notice is stored');
  assert.ok(note!.text.length < 300);
  assert.ok(!msgs.some((m) => m.from.kind === 'bot' && /Sure, here it is/.test(m.text)), 'the bot reply is not stored at all');
  // room events only: the engine's own task record is outside the room hub
  for (const e of h.events.filter((x) => x.type.startsWith('room.'))) assert.ok(!JSON.stringify(e).includes('abandon ability'), `event leaks the phrase: ${e.type}`);
  // the on-disk log too
  const again = h.reopen();
  assert.ok(!JSON.stringify(again.roomWithMessages(room.id, 1000)).includes('abandon ability'));
});

test('G1: a seed phrase hidden in a longer reply, with the bot mentioning another bot, wakes nobody', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  h.hub.postHuman(room.id, '@scout go');
  const before = h.engine.starts.length;
  h.engine.finish(h.engine.last('scout').taskId, `@zealot please keep this safe\n1. abandon\n2. ability\n3. able\n4. about\n5. above\n6. absent\n7. absorb\n8. abstract\n9. absurd\n10. abuse\n11. access\n12. accident`);
  assert.equal(h.engine.starts.length, before, 'the redacted reply does not wake the mentioned bot');
  assert.ok(!JSON.stringify(h.messages(room.id)).includes('absurd'));
});

test('G1: an ordinary reply is still posted normally', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  h.hub.postHuman(room.id, '@scout hi');
  h.engine.finish(h.engine.last('scout').taskId, 'All good, nothing to report.');
  assert.ok(h.messages(room.id).some((m) => m.from.kind === 'bot' && m.text === 'All good, nothing to report.'));
});

test('G5: a transaction id survives in a bot reply, a bot message and a human post; a labelled private key hex is still redacted', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  const human = h.hub.postHuman(room.id, `@scout look at tx ${TXID}`);
  assert.ok(human.text.includes(TXID), 'human post keeps the txid');
  h.engine.finish(h.engine.last('scout').taskId, `Confirmed: ${TXID} is in block 812345. private key: ${KEYHEX}`);
  const reply = h.messages(room.id).find((m) => m.from.kind === 'bot')!;
  assert.ok(reply.text.includes(TXID), `txid kept in the bot reply: ${reply.text}`);
  assert.ok(!reply.text.includes(KEYHEX), 'labelled key hex redacted');
  assert.match(reply.text, /private key: \[redacted-key\]/);
  const posted = h.hub.roomPost('scout', room.id, `txid ${TXID}; wif: ${KEYHEX}`);
  assert.ok(posted.text.includes(TXID));
  assert.ok(!posted.text.includes(KEYHEX));
});
