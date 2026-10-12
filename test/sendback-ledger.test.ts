/**
 * The send-back rule's memory: one goal goes to one agent at most three times (the first send and two send-backs), and
 * never back to an agent once it moved on. The count survives a core restart, and a send that never reached the agent
 * (a refused or failed delivery) does not use up a try.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SendBackLedger, MAX_SENDS_PER_GOAL } from '../src/core/sendback-ledger.js';
import { tempDir } from './tmp-cleanup.js';

const B = { id: 'builder', name: 'Builder' };
const S = { id: 'scout', name: 'Scout' };

test('check never counts: only record does, so a delivery that throws leaves the try unused', () => {
  const l = new SendBackLedger(tempDir('legion-sb-'));
  for (let i = 0; i < 5; i++) assert.equal(l.check('t1', B, 'Fix the export test'), undefined);
  for (let i = 0; i < MAX_SENDS_PER_GOAL; i++) { assert.equal(l.check('t1', B, 'Fix the export test'), undefined); l.record('t1', B, 'Fix the export test'); }
  assert.match(l.check('t1', B, 'fix the EXPORT  test') ?? '', /two send-backs|3 times/);
});

test('the count and the moved-on rule survive a restart; forget drops a task', () => {
  const dir = tempDir('legion-sb-');
  const a = new SendBackLedger(dir);
  a.record('t1', B, 'Fix the export test');
  a.record('t1', B, 'Fix the export test');
  a.record('t1', S, 'Fix the export test');
  const b = new SendBackLedger(dir);
  assert.match(b.check('t1', B, 'Fix the export test') ?? '', /does not go back/);
  assert.equal(b.check('t1', S, 'Fix the export test'), undefined);
  assert.equal(b.check('t2', B, 'Fix the export test'), undefined);
  b.forget('t1');
  assert.equal(new SendBackLedger(dir).check('t1', B, 'Fix the export test'), undefined);
});

test('no goal, no count; no folder, memory only', () => {
  const l = new SendBackLedger(undefined);
  for (let i = 0; i < 5; i++) { assert.equal(l.check('t1', B, undefined), undefined); l.record('t1', B, undefined); }
  for (let i = 0; i < MAX_SENDS_PER_GOAL; i++) l.record('t1', B, 'g');
  assert.ok(l.check('t1', B, 'g'));
});
