/** Polish: no-limit wording in the room UI, and the budget pause message never runs for a room without a budget. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './comms-fakes.test.js';

const ui = (f: string) => readFileSync(join(process.cwd(), 'ui/src/rooms', f), 'utf8');

test('P1: a room paused for budget whose limit was later removed never reads "its No limit limit"', () => {
  const src = ui('roomsUtil.ts');
  const line = src.split('\n').find((l) => l.includes("case 'budget'"))!;
  assert.match(line, /g\.budgetUsd === null \?/, 'the removed-limit case has its own text');
  assert.match(line, /limit has since been removed/);
  const withLimit = line.slice(line.indexOf(': `This room spent'));
  assert.doesNotMatch(withLimit.split('?')[0]!, /No limit/);
  assert.match(withLimit, /fmtBudget\(g\.budgetUsd\)/, 'the with-limit text still shows the limit');
});

test('P2: RoomSettings hints "no spend limit" when the box is blank and the room had a limit', () => {
  const src = ui('RoomSettings.tsx');
  assert.match(src, /budgetBlank && room\.guards\.budgetUsd !== null && <span className="rm-hint" role="status">This room will have no spend limit\.<\/span>/);
  assert.match(ui('rooms.css'), /\.rm-hint\b/);
});

test('P4: the budget pause message is only for a room that has a budget (explicit guard, no "?? 0")', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout'], { guards: { budgetUsd: null } });
  const pause = (h.hub as unknown as { pauseBudget(r: unknown, s: unknown): void }).pauseBudget.bind(h.hub);
  assert.throws(() => pause(h.hub.getRoom(room.id), {}), /no budget/);
  assert.equal(h.hub.getRoom(room.id).paused, undefined, 'nothing was paused');
  assert.doesNotMatch(readFileSync(join(process.cwd(), 'src/core/comms/hub.ts'), 'utf8'), /budgetUsd \?\? 0/);
});
