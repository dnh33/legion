import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HOP } from '../src/core/bridge.js';
import { callTool, init, isReply, ok, notices, setup, tick } from './bridge-rig.js';

// BUG-1: a reply came back to the lead at the SENDER's hop + 1, so each tell/reply round-trip cost the lead two hops and a lead started
// by the owner ran out after about three round-trips; replies over the limit were dropped without a word.

test("an owner-started lead collects 10 tell/reply round-trips from 3 agents: every reply is delivered at the lead's own hop", async () => {
  const targets = ['builder', 'scout', 'worker'];
  const hopsSeen: Array<number | undefined> = [];
  const tellErrors: string[] = [];
  let round = 0;
  const s = setup((c) => {
    if (c.agent !== 'zealot') return undefined;
    return (async function* () {
      const sid = `z-${c.n}`;
      yield init(sid);
      const me = s.store.listTasks(50, 'zealot', true)[0]!;
      hopsSeen.push(me.bridgeHop);
      if (round < 10) {
        const r = await callTool(c.options, 'tell', { agent: targets[round % 3], message: `job ${round}` });
        round++;
        if (r.isError) tellErrors.push(r.text);
      }
      yield ok(round < 10 ? 'waiting for the reply' : 'all collected', sid);
    })();
  });
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  for (let i = 0; i < 400 && s.calls.filter((c) => c.agent === 'zealot').length < 11; i++) await tick(10);
  await tick(100);
  const zealotRuns = s.calls.filter((c) => c.agent === 'zealot');
  assert.deepEqual(tellErrors, [], 'no tell was refused for hops');
  assert.equal(zealotRuns.filter((c) => isReply(c.prompt)).length, 10, 'ten replies arrived');
  assert.equal(zealotRuns.length, 11);
  assert.ok(hopsSeen.every((h) => (h ?? 0) === 0), `the lead stayed at hop 0: ${hopsSeen.join(',')}`);
  assert.equal(s.store.getTask(z.id)!.result, 'all collected');
});

test('unsolicited ping-pong (A tells B, B tells A, ...) still stops at the hop limit', async () => {
  const errors: string[] = [];
  const s = setup((c) => {
    if (isReply(c.prompt)) return undefined;
    if (c.agent !== 'zealot' && c.agent !== 'builder') return undefined;
    const other = c.agent === 'zealot' ? 'builder' : 'zealot';
    return (async function* () {
      yield init(`s-${c.agent}-${c.n}`);
      const r = await callTool(c.options, 'tell', { agent: other, message: 'ping' });
      if (r.isError) errors.push(r.text);
      yield ok('pong', `s-${c.agent}-${c.n}`);
    })();
  });
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'start', source: 'ui' });
  await s.engine.waitFor(z.id, 5000);
  await tick(800);
  const runs = s.calls.filter((c) => !isReply(c.prompt));
  assert.equal(runs.length, MAX_HOP + 1, `ran ${runs.length} times`);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Bridge hop limit reached \(6\)/);
});

test('a reply that cannot be delivered leaves a notice on both threads: the caller was cancelled', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const s = setup((c) => {
    if (c.agent === 'builder') return (async function* () { yield init('b'); await gate; yield ok('the finished build', 'b'); })();
    if (c.agent === 'zealot') return (async function* () { yield init('z'); await callTool(c.options, 'tell', { agent: 'builder', message: 'build' }); await new Promise(() => undefined); })();
    return undefined;
  });
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await tick(150);
  const builderTask = s.store.listTasks(10, 'builder', true)[0]!.id;
  s.engine.cancel(z.id);
  await tick(50);
  release();
  await s.engine.waitFor(builderTask, 3000);
  await tick(100);
  assert.match(notices(s, z.id).join('\n'), /reply from Builder .*was not delivered here: the task was cancelled/);
  assert.match(notices(s, builderTask).join('\n'), /Your reply to .* was not delivered: the task was cancelled/);
  assert.equal(s.calls.filter((c) => c.agent === 'zealot').length, 1, 'no run was started for it');
});

test('a reply refused by the hop guard is not silent either, and starts nothing', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const s = setup((c) => {
    if (c.agent === 'builder') return (async function* () { yield init('b'); await gate; yield ok('late answer', 'b'); })();
    if (c.agent === 'zealot') return (async function* () { yield init('z'); await callTool(c.options, 'tell', { agent: 'builder', message: 'build' }); yield ok('told', 'z'); })();
    return undefined;
  });
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  const builderTask = s.store.listTasks(10, 'builder', true)[0]!.id;
  // a caller already past the limit (it cannot get here by tells: they are refused first)
  s.store.upsertTask({ ...s.store.getTask(z.id)!, bridgeHop: MAX_HOP + 1 });
  release();
  await s.engine.waitFor(builderTask, 3000);
  await tick(100);
  assert.match(notices(s, z.id).join('\n'), /not delivered here: the task is already 7 hops from you \(limit 6\)/);
  assert.match(notices(s, builderTask).join('\n'), /was not delivered/);
  assert.equal(s.calls.filter((c) => c.agent === 'zealot').length, 1);
});
