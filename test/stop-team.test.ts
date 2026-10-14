import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, init, ok, notices, setup, tick } from './bridge-rig.js';

// E2: Stop a team. One action cancels a task and every task it started (transitively), and a stopped task's late
// send-back must not wake the caller.

const hang = () => new Promise<void>(() => undefined);

test('stopTeam cancels the lead and every task it started, down the chain', async () => {
  const s = setup((c) => {
    if (c.agent === 'zealot') return (async function* () { yield init('z'); await callTool(c.options, 'tell', { agent: 'builder', message: 'build' }); await hang(); })();
    if (c.agent === 'builder') return (async function* () { yield init('b'); await callTool(c.options, 'tell', { agent: 'scout', message: 'look' }); await hang(); })();
    if (c.agent === 'scout') return (async function* () { yield init('s'); await hang(); })();
    return undefined;
  }, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await tick(250);
  const b = s.store.listTasks(10, 'builder', true)[0]!;
  const sc = s.store.listTasks(10, 'scout', true)[0]!;
  assert.equal(b.parentTaskId, z.id);
  assert.equal(sc.parentTaskId, b.id);
  assert.deepEqual(s.engine.teamOf(z.id).sort(), [b.id, sc.id].sort());
  const r = s.engine.cancelTeam(z.id);
  assert.deepEqual(r.cancelled.sort(), [z.id, b.id, sc.id].sort());
  await tick(150);
  for (const id of [z.id, b.id, sc.id]) assert.equal(s.store.getTask(id)!.status, 'cancelled', id);
  assert.equal(s.calls.filter((c) => c.agent === 'zealot').length, 1, 'the lead was not woken by a send-back');
});

test('stopping a lead that already finished still cancels what it started, and their send-backs do not wake it', async () => {
  const s = setup((c) => {
    if (c.agent === 'zealot') return (async function* () { yield init('z'); await callTool(c.options, 'tell', { agent: 'builder', message: 'build' }); yield ok('told', 'z'); })();
    if (c.agent === 'builder') return (async function* () { yield init('b'); await hang(); })();
    return undefined;
  }, 3);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  const b = s.store.listTasks(10, 'builder', true)[0]!;
  assert.equal(b.status, 'running');
  const r = s.engine.cancelTeam(z.id);
  assert.deepEqual(r.cancelled, [b.id], 'the finished lead is not listed, its helper is');
  await tick(200);
  assert.equal(s.store.getTask(b.id)!.status, 'cancelled');
  assert.equal(s.calls.filter((c) => c.agent === 'zealot').length, 1, 'no run was started for the lead');
  assert.equal(s.store.getTask(z.id)!.status, 'done');
  assert.doesNotMatch(notices(s, z.id).join('\n'), /not delivered/, 'dropped quietly: the owner asked for it');
});

test('stopping a team twice is harmless: the second call finds nothing live', async () => {
  let round = 0;
  const s = setup((c) => {
    if (c.agent === 'zealot') return (async function* () {
      const sid = `z-${c.n}`; yield init(sid);
      if (round++ === 0) await callTool(c.options, 'tell', { agent: 'builder', message: 'one' });
      yield ok('told', sid);
    })();
    if (c.agent === 'builder' && c.n === 0) return (async function* () { yield init('b0'); await hang(); })();
    return undefined;
  }, 3);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  s.engine.cancelTeam(z.id);
  await tick(150);
  const b = s.store.listTasks(10, 'builder', true)[0]!;
  assert.equal(b.status, 'cancelled');
  assert.equal(s.engine.cancelTeam(z.id).cancelled.length, 0, 'nothing left to stop');
});
