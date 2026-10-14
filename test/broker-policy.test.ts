import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalBroker, describeWaited } from '../src/core/approvals.js';
import { QuestionBroker } from '../src/core/questions.js';
import { EventBus } from '../src/core/bus.js';
import { HOLD_MAX_MS } from '../src/core/away/policy.js';
import type { AskPolicy } from '../src/core/away/policy.js';
import type { QuietConfig } from '../src/shared/ask-clock.js';
import type { LegionEvent } from '../src/shared/types.js';

const MIN = 60_000;
const local = (h: number, m = 0): number => new Date(2026, 9, 14, h, m, 0, 0).getTime();
const quiet: QuietConfig = { enabled: true, from: '22:00', to: '07:00' };

interface PolicyOpts { quiet?: QuietConfig; modes?: Record<string, { onSilence: 'deny' | 'park'; parkMinutes: number }>; projectOf?: Record<string, string> }
const policy = (o: PolicyOpts = {}): AskPolicy => ({
  policyFor: (pid) => (pid && o.modes?.[pid]) || { onSilence: 'deny', parkMinutes: 3 },
  quiet: () => o.quiet,
  projectOf: (taskId) => o.projectOf?.[taskId],
});
const settled = (p: Promise<unknown>): { done: boolean; value?: unknown } => { const s: { done: boolean; value?: unknown } = { done: false }; void p.then((v) => { s.done = true; s.value = v; }); return s; };
/** Let promise callbacks run (mock timers do not drive microtasks). */
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('policy absent: the ask is denied at exactly the old wait, nothing sooner', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus());
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'ls' }));
  mock.timers.tick(10 * MIN - 1); await flush();
  assert.equal(s.done, false);
  mock.timers.tick(1); await flush();
  assert.deepEqual(s, { done: true, value: false });
  assert.equal(b.pending().length, 0);
});

test('a request carries its project and a consequence set by the core', () => {
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ projectOf: { t9: 'proj-9' } }) });
  void b.request('t1', 'a1', 'Bash', { command: 'git push' }, undefined, { projectId: 'proj-1' });
  void b.request('t9', 'a1', 'Bash', { command: 'ls' });
  void b.request('t2', 'a1', 'mcp__x__y', {});
  const [push, ls, odd] = b.pending();
  assert.equal(push!.projectId, 'proj-1');
  assert.equal(push!.consequence!.level, 3);
  assert.equal(ls!.projectId, 'proj-9', 'a module-raised ask finds its project through the policy');
  assert.equal(ls!.consequence!.level, 1);
  assert.equal(odd!.projectId, undefined);
  assert.equal(odd!.consequence!.certain, false);
  for (const r of b.pending()) b.resolve(r.id, false);
});

test('park: a parkable ask in a parking project parks at the project time, not at 10 minutes', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  t.after(() => mock.timers.reset());
  const events: LegionEvent[] = [];
  const bus = new EventBus(); bus.on((e) => events.push(e));
  const b = new ApprovalBroker(bus, { policy: policy({ modes: { park1: { onSilence: 'park', parkMinutes: 3 } } }) });
  let parked = 0;
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'git push' }, undefined, { projectId: 'park1', parkable: true, onPark: () => { parked++; } }));
  mock.timers.tick(3 * MIN - 1); await flush();
  assert.equal(parked, 0);
  mock.timers.tick(1); await flush();
  assert.equal(parked, 1);
  assert.deepEqual(s, { done: true, value: false }, 'parking never answers yes');
  assert.ok(events.some((e) => e.type === 'approval.resolved' && e.allowed === false));
});

test('park is only for asks that can park; others in a parking project still wait the old time and deny', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ modes: { park1: { onSilence: 'park', parkMinutes: 3 } } }) });
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'ls' }, undefined, { projectId: 'park1' }));
  mock.timers.tick(5 * MIN); await flush();
  assert.equal(s.done, false);
  mock.timers.tick(5 * MIN); await flush();
  assert.deepEqual(s, { done: true, value: false });
});

test('two projects, two behaviours', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ modes: { pk: { onSilence: 'park', parkMinutes: 2 } } }) });
  let parkedA = 0; let parkedB = 0;
  const a = settled(b.request('t1', 'x', 'Bash', { command: 'ls' }, undefined, { projectId: 'pk', parkable: true, onPark: () => { parkedA++; } }));
  const c = settled(b.request('t2', 'x', 'Bash', { command: 'ls' }, undefined, { projectId: 'other', parkable: true, onPark: () => { parkedB++; } }));
  mock.timers.tick(2 * MIN); await flush();
  assert.equal(a.done, true); assert.equal(parkedA, 1);
  assert.equal(c.done, false); assert.equal(parkedB, 0);
  mock.timers.tick(8 * MIN); await flush();
  assert.equal(c.done, true); assert.equal(parkedB, 0, 'deny, not park');
});

test('quiet hours: an ask raised 4 minutes before quiet has 6 minutes left when quiet ends', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(21, 56) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ quiet }) });
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'ls' }));
  mock.timers.tick(9 * 60 * MIN + 5 * MIN); await flush();   // to 07:01 the next morning
  assert.equal(s.done, false, 'still waiting overnight');
  assert.equal(b.pending().length, 1);
  mock.timers.tick(5 * MIN - 1); await flush();               // 07:05:59.999
  assert.equal(s.done, false);
  mock.timers.tick(1); await flush();                          // 07:06
  assert.deepEqual(s, { done: true, value: false });
});

test('quiet hours: an ask raised inside quiet starts counting at quiet end', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(23, 30) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ quiet }) });
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'ls' }));
  mock.timers.tick(7 * 60 * MIN + 30 * MIN + 9 * MIN); await flush();   // 07:09
  assert.equal(s.done, false);
  mock.timers.tick(1 * MIN); await flush();                               // 07:10
  assert.deepEqual(s, { done: true, value: false });
});

test('quiet hours do not extend parking', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(23, 0) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ quiet, modes: { pk: { onSilence: 'park', parkMinutes: 3 } } }) });
  let parked = 0;
  void b.request('t1', 'a1', 'Bash', { command: 'ls' }, undefined, { projectId: 'pk', parkable: true, onPark: () => { parked++; } });
  mock.timers.tick(3 * MIN); await flush();
  assert.equal(parked, 1);
});

test('hold: delays the deny of an ask in its last seconds, once, and never answers it', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  t.after(() => mock.timers.reset());
  const events: LegionEvent[] = [];
  const bus = new EventBus(); bus.on((e) => events.push(e));
  const b = new ApprovalBroker(bus);
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'git push' }));
  const id = b.pending()[0]!.id;
  mock.timers.tick(10 * MIN - 5_000); await flush();               // 5 s left
  assert.equal(b.hold(id, 10 ** 9), true, 'a huge ms is clamped, not refused');
  assert.equal(b.hold(id, 5_000), false, 'once per ask');
  assert.equal(b.pending().length, 1);
  assert.equal(s.done, false);
  assert.ok(!events.some((e) => e.type === 'approval.resolved'), 'a hold never answers the ask');
  mock.timers.tick(HOLD_MAX_MS - 1); await flush();
  assert.equal(s.done, false);
  mock.timers.tick(1); await flush();
  assert.deepEqual(s, { done: true, value: false });
  assert.equal(b.hold('does-not-exist', 5_000), false);
});

test('hold never shortens a wait', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus());
  const s = settled(b.request('t1', 'a1', 'Bash', { command: 'ls' }));
  const id = b.pending()[0]!.id;
  assert.equal(b.hold(id, 1_000), true);
  mock.timers.tick(5 * MIN); await flush();
  assert.equal(s.done, false, 'one second of hold did not pull the deny forward');
  mock.timers.tick(5 * MIN); await flush();
  assert.equal(s.done, true);
});

test('no timer path ever resolves an ask to allow: long waits with quiet, hold and park all end in false', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(21, 0) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ quiet, modes: { pk: { onSilence: 'park', parkMinutes: 5 } } }) });
  const results: unknown[] = [];
  for (const [i, o] of [{}, { projectId: 'pk', parkable: true, onPark: () => undefined }, { projectId: 'pk' }].entries()) {
    void b.request(`t${i}`, 'a', 'Bash', { command: 'ls' }, undefined, o).then((v) => results.push(v));
  }
  b.hold(b.pending()[0]!.id, 15_000);
  mock.timers.tick(48 * 60 * MIN); await flush();
  assert.equal(results.length, 3);
  assert.deepEqual(results, [false, false, false]);
  assert.equal(b.pending().length, 0);
});

test('only an explicit resolve(id, true) allows', async () => {
  const b = new ApprovalBroker(new EventBus());
  const p = b.request('t1', 'a1', 'Bash', { command: 'ls' });
  assert.equal(b.resolve(b.pending()[0]!.id, true), true);
  assert.equal(await p, true);
});

test('source scan: no timer callback in the brokers or the ask timer can resolve true', () => {
  for (const f of ['src/core/approvals.ts', 'src/core/away/policy.ts', 'src/core/questions.ts']) {
    const code = readFileSync(join(process.cwd(), f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    // (the question broker's owner-answer path settles `answered: true` by design; its timer calls are checked below)
    if (!f.endsWith('questions.ts')) {
      assert.ok(!/settle\([^)]*\btrue\b/.test(code), `${f}: settle(..., true)`);
      assert.ok(!/resolve(Promise)?\(\s*true\s*\)/.test(code), `${f}: resolves true`);
    }
    // everything a timer can do is inside a startAskTimer call: no `true` may appear there (a park is reported as `parked: true`, an answer of no)
    for (const call of code.match(/startAskTimer\(\{[\s\S]*?\}\);/g) ?? []) assert.ok(!/\btrue\b/.test(call.replace(/parked:\s*true/g, '')), `${f}: true inside a timer call`);
  }
  const used = ['src/core/approvals.ts', 'src/core/questions.ts'].map((f) => (readFileSync(join(process.cwd(), f), 'utf8').match(/startAskTimer\(/g) ?? []).length);
  assert.deepEqual(used, [1, 1], 'both brokers arm their timers through startAskTimer');
});

test('the hook timeout is the longest possible wait, and is still the old number without a policy', () => {
  assert.equal(new ApprovalBroker(new EventBus()).timeoutSeconds, 600);
  const withQuiet = new ApprovalBroker(new EventBus(), { policy: policy({ quiet }) });
  assert.ok(withQuiet.timeoutSeconds >= 600 + 24 * 3600, `${withQuiet.timeoutSeconds}`);
  assert.ok(withQuiet.timeoutSeconds * 1000 < 2 ** 31 - 1, 'below the largest timer value');
  const withPark = new ApprovalBroker(new EventBus(), { policy: policy(), timeoutMs: 60_000 });
  assert.ok(withPark.timeoutSeconds >= 120 * 60, 'a park wait can be up to 120 minutes');
});

test('cancelling a task leaves no timer behind: nothing fires when the old deadline passes', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(12) });
  try {
    const b = new ApprovalBroker(new EventBus(), { policy: policy({ quiet }) });
    let fired = 0;
    const p = b.request('t1', 'a1', 'Bash', { command: 'ls' }, undefined, { onTimeout: () => { fired++; } });
    const done = settled(p);
    b.cancelForTask('t1');
    await flush();
    assert.equal(b.pending().length, 0);
    assert.deepEqual(done, { done: true, value: false }, 'cancelled is a no');
    mock.timers.tick(48 * 60 * MIN);
    await flush();
    assert.equal(fired, 0, 'the deny timer was cleared with the ask');
  } finally { mock.timers.reset(); }
});

test('a hook must outlive any wait, even when quiet hours are switched on while the run is going', () => {
  let q: QuietConfig | undefined;
  const b = new ApprovalBroker(new EventBus(), { policy: { policyFor: () => ({ onSilence: 'deny', parkMinutes: 3 }), quiet: () => q } });
  const before = b.timeoutSeconds;
  q = quiet;
  const after = b.timeoutSeconds;
  assert.equal(before, after, 'the number does not depend on the setting at the moment it is read');
  assert.ok(before >= 600 + 24 * 3600, `${before}`);
  assert.ok(before * 1000 < 2 ** 31 - 1);
});

test('the deny callback learns how long the ask really waited, so the model can be told the truth', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(21, 56) });
  t.after(() => mock.timers.reset());
  const b = new ApprovalBroker(new EventBus(), { policy: policy({ quiet }) });
  let waited = -1;
  void b.request('t1', 'a1', 'Bash', { command: 'ls' }, undefined, { onTimeout: (ms?: number) => { waited = ms ?? -1; } });
  mock.timers.tick(9 * 60 * MIN + 10 * MIN); await flush();
  assert.equal(waited, 9 * 60 * MIN + 10 * MIN, 'from 21:56 to 07:06');
  assert.equal(describeWaited(waited, b.waitMs), '10 minutes of waiting (quiet hours paused the countdown, so it stayed open for 9 hours)');
  assert.equal(describeWaited(10 * MIN, 10 * MIN), '10 minutes');
  assert.equal(describeWaited(10 * MIN + 3000, 10 * MIN), '10 minutes', 'a timer that fires a moment late is not quiet hours');
});

test('questions follow the same policy: declined at the old wait, parked on request, quiet hours extend', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: local(21, 56) });
  t.after(() => mock.timers.reset());
  const qb = new QuestionBroker(new EventBus(), { policy: policy({ quiet, modes: { pk: { onSilence: 'park', parkMinutes: 3 } } }) });
  const spec = [{ question: 'Which?', header: 'h', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }];
  const s = settled(qb.request('t1', 'a1', spec, undefined, { projectId: 'x' }));
  assert.equal(qb.pending()[0]!.projectId, 'x');
  assert.equal(qb.pending()[0]!.consequence!.level, 0);
  mock.timers.tick(9 * 60 * MIN + 5 * MIN); await flush();
  assert.equal(s.done, false, 'quiet hours hold a question too');
  mock.timers.tick(6 * MIN); await flush();
  assert.deepEqual(s.value, { answered: false, picks: null });
  let parked = 0;
  const p = settled(qb.request('t2', 'a1', spec, undefined, { projectId: 'pk', parkable: true, onPark: () => { parked++; } }));
  mock.timers.tick(3 * MIN); await flush();
  assert.equal(parked, 1);
  assert.equal((p.value as { answered: boolean }).answered, false);
});
