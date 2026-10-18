/** The agent editor's Skill finder control: what the form sends, and that the core stores it the way the form means it. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finderBody, finderChanges, finderFormOf, pickFinderMode } from '../src/shared/agent-finder.js';
import { AUTH } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';

after(closeAll);

test('the form starts from the saved fields; an agent with none follows the Armory', () => {
  assert.deepEqual(finderFormOf({}), { mode: 'inherit', k: null });
  assert.deepEqual(finderFormOf({ skillFinder: 'on', skillFinderK: 4 }), { mode: 'on', k: 4 });
  assert.deepEqual(finderFormOf({ skillFinderK: 2 }), { mode: 'inherit', k: 2 });
});

test('the body: inherit and on send k (null clears it); off leaves k alone', () => {
  assert.deepEqual(finderBody({ mode: 'inherit', k: null }), { skillFinder: 'inherit', skillFinderK: null });
  assert.deepEqual(finderBody({ mode: 'on', k: 4 }), { skillFinder: 'on', skillFinderK: 4 });
  assert.deepEqual(finderBody({ mode: 'off', k: 4 }), { skillFinder: 'off' }, 'a stored k is not thrown away by switching off');
});

test('a save sends the finder keys only for what changed from the start value of the form', () => {
  const start = finderFormOf({});
  assert.deepEqual(finderChanges(start, start), {}, 'untouched: nothing is sent, so no skillFinder is stored');
  assert.deepEqual(finderChanges(start, { mode: 'on', k: null }), { skillFinder: 'on' }, 'only the mode changed');
  assert.deepEqual(finderChanges(start, { mode: 'inherit', k: 4 }), { skillFinderK: 4 }, 'only the count changed');
  const set = finderFormOf({ skillFinder: 'on', skillFinderK: 4 });
  assert.deepEqual(finderChanges(set, set), {});
  assert.deepEqual(finderChanges(set, pickFinderMode(set, 'inherit')), { skillFinder: 'inherit', skillFinderK: null }, 'back to the Armory clears both');
  assert.deepEqual(finderChanges(set, pickFinderMode(set, 'off')), { skillFinder: 'off' }, 'off sends no count');
});

test('choosing "Same as the Armory" clears k; the other choices keep it', () => {
  assert.deepEqual(pickFinderMode({ mode: 'on', k: 4 }, 'inherit'), { mode: 'inherit', k: null });
  assert.deepEqual(pickFinderMode({ mode: 'on', k: 4 }, 'off'), { mode: 'off', k: 4 });
  assert.deepEqual(pickFinderMode({ mode: 'off', k: 4 }, 'on'), { mode: 'on', k: 4 });
});

test('the core stores what the form sent: on with k, then Same as the Armory removes k', async () => {
  const m = await mount();
  const on = await m.http('PATCH', '/api/agents/worker', { name: 'Worker', ...finderBody({ mode: 'on', k: 4 }) }, AUTH);
  assert.equal(on.status, 200);
  assert.equal(on.json.skillFinder, 'on');
  assert.equal(on.json.skillFinderK, 4);
  const back = await m.http('PATCH', '/api/agents/worker', { name: 'Worker', ...finderBody(pickFinderMode({ mode: 'on', k: 4 }, 'inherit')) }, AUTH);
  assert.equal(back.status, 200);
  assert.equal(back.json.skillFinder, 'inherit');
  assert.equal('skillFinderK' in back.json, false, 'the override is gone');
  const set = await m.http('PATCH', '/api/agents/worker', { name: 'Worker', skillFinderK: 3 }, AUTH);
  assert.equal(set.json.skillFinderK, 3);
  const kept = await m.http('PATCH', '/api/agents/worker', { name: 'Worker', ...finderBody({ mode: 'off', k: 3 }) }, AUTH);
  assert.equal(kept.json.skillFinder, 'off');
  assert.equal(kept.json.skillFinderK, 3, 'off does not touch k');
});

test('the task a window gets from /api/state carries skillTurns (both the full and the slim snapshot), so the chat line can show', async () => {
  const m = await mount();
  const turns = [{ at: new Date().toISOString(), suggested: ['sp:a'], loaded: [], why: [{ id: 'sp:a', score: 3, matched: ['pdf'], thirdParty: true as const }] }];
  const t = { id: 'task_finder_turns', agentId: 'worker', title: 'x', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), skillTurns: turns };
  m.store.upsertTask(t as never);
  for (const q of ['/api/state', '/api/state?slim=1']) {
    const r = await m.http('GET', q, undefined, AUTH);
    assert.equal(r.status, 200);
    const got = (r.json.tasks as Array<{ id: string; skillTurns?: unknown }>).find((x) => x.id === t.id);
    assert.deepEqual(got?.skillTurns, turns, q);
  }
});
