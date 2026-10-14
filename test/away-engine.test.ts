/** The engine's side of the away features: what a card carries, the hook timeout, and spend written once per result. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ok, setup } from './away-rig.js';
import type { AskPolicy } from '../src/core/away/policy.js';

const init = { type: 'system', subtype: 'init', session_id: 's1' };
const sig = { signal: new AbortController().signal };

/** A run that asks about one tool call and waits for the answer. */
function askingRun(toolName: string, input: (folder: string) => Record<string, unknown>, opts: { project?: boolean } = {}) {
  let folder = '';
  const s = setup({
    approval: 'ask',
    script: (p) => (async function* () {
      yield init;
      await (p.options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<unknown>)(toolName, input(folder), sig);
      yield ok();
    })(),
  });
  folder = s.project.folder;
  const task = opts.project === false ? s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' }) : s.start('a1', 'go');
  const card = async () => { for (let i = 0; i < 100 && !s.approvals.pending().length; i++) await s.tick(5); return s.approvals.pending()[0]!; };
  return { s, task, card, folder: () => folder };
}

test('a card carries its project and a consequence set by the core', async () => {
  const r = askingRun('Bash', () => ({ command: 'git push origin main' }));
  const c = await r.card();
  assert.equal(c.projectId, r.s.project.id);
  assert.equal(c.consequence!.level, 3);
  assert.ok(c.consequence!.tags.includes('leaves'));
  assert.equal(c.consequence!.certain, true);
  r.s.approvals.resolve(c.id, false);
  await r.s.engine.waitFor(r.task.id, 3000);
});

test('a file edit inside the project is level 2, outside it is level 3 and not certain', async () => {
  const inside = askingRun('Write', (folder) => ({ file_path: join(folder, 'a.txt'), content: 'x' }));
  const c1 = await inside.card();
  assert.equal(c1.consequence!.level, 2);
  assert.equal(c1.consequence!.certain, true);
  inside.s.approvals.resolve(c1.id, false);
  await inside.s.engine.waitFor(inside.task.id, 3000);
  const outside = askingRun('Write', () => ({ file_path: 'C:/Users/someone/.bashrc', content: 'x' }));
  const c2 = await outside.card();
  assert.equal(c2.consequence!.level, 3);
  assert.equal(c2.consequence!.certain, false);
  outside.s.approvals.resolve(c2.id, false);
  await outside.s.engine.waitFor(outside.task.id, 3000);
});

test('an unreadable command gets an unknown consequence on the ordinary card', async () => {
  const r = askingRun('Bash', () => ({ command: '$prog --go' }));
  const c = await r.card();
  assert.equal(c.projectId, r.s.project.id);
  assert.equal(c.consequence!.level, 3);
  assert.deepEqual(c.consequence!.tags, ['unknown']);
  assert.equal(c.consequence!.certain, false);
  r.s.approvals.resolve(c.id, false);
  await r.s.engine.waitFor(r.task.id, 3000);
});

test('the shell floor own card (no Remember) carries the project and an unknown consequence too', async () => {
  const s = setup({
    approval: 'ask',
    script: (p) => (async function* () {
      yield init;
      const hooks = (p.options.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Array<(i: unknown) => Promise<unknown>> }> }).PreToolUse;
      const floor = hooks.find((h) => (h.matcher ?? '').includes('Bash'))!;
      await floor.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: '$prog --go' } });
      yield ok();
    })(),
  });
  const task = s.start('a1', 'go');
  for (let i = 0; i < 100 && !s.approvals.pending().length; i++) await s.tick(5);
  const c = s.approvals.pending()[0]!;
  assert.equal(c.noRemember, true);
  assert.equal(c.projectId, s.project.id);
  assert.deepEqual(c.consequence!.tags, ['unknown']);
  assert.equal(c.consequence!.certain, false);
  s.approvals.resolve(c.id, false);
  await s.engine.waitFor(task.id, 3000);
});

test('a card for a task with no project has a consequence and no project', async () => {
  const r = askingRun('Bash', () => ({ command: 'ls' }), { project: false });
  const c = await r.card();
  assert.equal(c.projectId, undefined);
  assert.equal(c.consequence!.level, 1);
  r.s.approvals.resolve(c.id, false);
  await r.s.engine.waitFor(r.task.id, 3000);
});

const hookTimeouts = (options: Record<string, unknown>): number[] => {
  const hooks = (options.hooks ?? {}) as { PreToolUse?: Array<{ timeout?: number }> };
  return (hooks.PreToolUse ?? []).map((h) => h.timeout).filter((t): t is number => typeof t === 'number');
};

test('the hook timeout is the broker\'s longest wait plus a minute: 660 s as before, much longer with quiet hours', async () => {
  const plain = setup({ approval: 'ask' });
  plain.start('a1', 'go');
  await plain.tick(40);
  plain.release('go');
  await plain.tick(60);
  assert.ok(hookTimeouts(plain.calls[0]!.options).length > 0, 'the run has card hooks');
  assert.deepEqual([...new Set(hookTimeouts(plain.calls[0]!.options))], [660]);

  const quiet = setup({ approval: 'ask' });
  const policy: AskPolicy = { policyFor: () => ({ onSilence: 'deny', parkMinutes: 3 }), quiet: () => ({ enabled: true, from: '22:00', to: '07:00' }) };
  quiet.approvals.setPolicy(policy);
  quiet.start('a1', 'go');
  await quiet.tick(40);
  const t = [...new Set(hookTimeouts(quiet.calls[0]!.options))];
  assert.equal(t.length, 1);
  assert.equal(t[0], quiet.approvals.timeoutSeconds + 60);
  assert.ok(t[0]! >= 600 + 24 * 3600 + 60, `${t[0]}`);
  assert.ok(t[0]! * 1000 < 2 ** 31 - 1, 'below the largest timer value');
  quiet.release('go');
  await quiet.tick(60);
});

const okTotal = (text: string, total: number) => ({ ...ok(text), total_cost_usd: total });

test('spend is written once per result, as the rise since the last result of the session', async () => {
  let n = 0;
  const totals = [0.5, 0.8];
  const s = setup({ script: () => (async function* () { yield init; yield okTotal('done', totals[n++]!); })() });
  const t = s.start('a1', 'first');
  await s.engine.waitFor(t.id, 3000);
  assert.deepEqual(s.away.spends.map((e) => ({ taskId: e.taskId, agentId: e.agentId, projectId: e.projectId })), [{ taskId: t.id, agentId: 'a1', projectId: s.project.id }]);
  assert.equal(s.away.spends[0]!.usd, 0.5);
  const again = s.engine.startTask({ agentId: 'a1', prompt: 'more', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(again.id, 3000);
  assert.equal(s.away.spends.length, 2);
  assert.ok(Math.abs((s.away.spends[1]!.usd as number) - 0.3) < 1e-9, 'only the rise since the session\'s last result');
});

test('a result with no cost writes nothing; a failing ledger never fails the run', async () => {
  const free = setup({ script: () => (async function* () { yield init; yield { type: 'result', subtype: 'success', is_error: false, result: 'x', num_turns: 1, session_id: 's1' }; })() });
  await free.engine.waitFor(free.start('a1', 'go').id, 3000);
  assert.equal(free.away.spends.length, 0);

  const s = setup({ script: () => (async function* () { yield init; yield okTotal('done', 1); })() });
  (s.engine as unknown as { away: { recordSpend: () => void } }).away.recordSpend = () => { throw new Error('disk full'); };
  const done = await s.engine.waitFor(s.start('a1', 'go').id, 3000);
  assert.equal(done.status, 'done');
});

test('without an away module nothing is recorded and the run is unchanged', async () => {
  const s = setup({ withAway: false, script: () => (async function* () { yield init; yield okTotal('done', 2); })() });
  const done = await s.engine.waitFor(s.start('a1', 'go').id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.costUsd, 2);
  assert.equal(s.away.spends.length, 0);
});
