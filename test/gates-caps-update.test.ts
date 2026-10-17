/** Gates PR 2, task 9: the attempt caps, the update consent and the digest hold follow the registry; three gates stay on in every preset. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AttemptLedger, attemptLimits, MAX_ATTEMPTS_PER_BOT, MAX_ATTEMPTS_PER_ITEM } from '../src/core/marshal/ledger.js';
import { gateValue, PRESETS, type GateValue } from '../src/shared/gates-registry.js';
import { createUpdaterModule, type UpdaterModule } from '../src/core/updater/index.js';
import { createHold, holdMs, HOLD_IRREVERSIBLE_MS, HOLD_MS } from '../ui/src/projects/hold.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { Store } from '../src/core/store.js';
import { tempDir } from './tmp-cleanup.js';
import { LOCK, makeKey, makeRelease, startFakeServer } from './updater-helpers.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = 'wi_aaaaaaaaaaaa';
const app = (preset: (typeof PRESETS)[number]) => ({ app: { version: 1 as const, preset } });

/** Dispatch the item to `bots` in turn until the ledger refuses; returns how many dispatches it allowed. */
function allowed(l: AttemptLedger, bots: string[]): number {
  let n = 0;
  for (let i = 0; i < 100; i++) {
    const bot = bots.find((b) => l.mayDispatch(I, b).ok);
    if (!bot) return n;
    l.recordDispatch(I, bot, `t${i}`); l.runEnded(I, 'failed'); n++;
  }
  return n;
}
const fresh = (limits?: (p: string) => { perBot: number; perItem: number }, projectId = 'proj_a'): AttemptLedger => {
  const l = new AttemptLedger(undefined, limits ? { limits, projectId } : undefined);
  l.setDoneWhen(I, ['it works']);
  return l;
};

test('ledger: Ask keeps 2 per bot and 4 per item; Bypass gives 4 and 8', () => {
  assert.equal(MAX_ATTEMPTS_PER_BOT, 2); assert.equal(MAX_ATTEMPTS_PER_ITEM, 4);
  const lim = (preset: (typeof PRESETS)[number]) => () => attemptLimits(gateValue('attempt-caps', app(preset)));
  assert.deepEqual(lim('ask')(), { perBot: 2, perItem: 4 });
  assert.deepEqual(lim('bypass')(), { perBot: 4, perItem: 8 });
  // one bot: the per-bot cap bites; several bots: the per-item cap does
  assert.equal(allowed(fresh(lim('ask')), ['a']), 2);
  assert.equal(allowed(fresh(lim('bypass')), ['a']), 4);
  assert.equal(allowed(fresh(lim('ask')), ['a', 'b', 'c', 'd']), 4);
  assert.equal(allowed(fresh(lim('bypass')), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']), 8);
  const l = fresh(lim('bypass'));
  for (let i = 0; i < 4; i++) { l.recordDispatch(I, 'a', `t${i}`); l.runEnded(I, 'failed'); }
  const refused = l.mayDispatch(I, 'a');
  assert.ok(!refused.ok);
  assert.match(refused.ok ? '' : refused.why, /4 times/);
});

test('ledger: no limits option means the exported defaults (2 and 4)', () => {
  assert.equal(allowed(fresh(), ['a']), 2);
  assert.equal(allowed(fresh(), ['a', 'b', 'c', 'd']), 4);
});

test('ledger limits are read per project at dispatch time', () => {
  let cap = { perBot: 2, perItem: 4 };
  const seen: string[] = [];
  const l = fresh((p) => { seen.push(p); return cap; }, 'proj_x');
  l.recordDispatch(I, 'a', 't1'); l.runEnded(I, 'failed');
  assert.ok(l.mayDispatch(I, 'a').ok);
  cap = { perBot: 1, perItem: 4 }; // the owner tightened the preset between two dispatches
  assert.ok(!l.mayDispatch(I, 'a').ok, 'the next check reads the new, lower value');
  cap = { perBot: 3, perItem: 6 }; // and loosened it again
  assert.ok(l.mayDispatch(I, 'a').ok, 'and then the higher one');
  assert.ok(seen.length > 0 && seen.every((p) => p === 'proj_x'), 'the project id is what the ledger asks with');
});

test('attemptLimits: a limit gives per-item = limit and per-bot = half; off is unlimited; true is the default', () => {
  assert.deepEqual(attemptLimits({ on: true, limit: 8 }), { perBot: 4, perItem: 8 });
  assert.deepEqual(attemptLimits({ on: true, limit: 1 }), { perBot: 1, perItem: 1 });
  assert.deepEqual(attemptLimits(true), { perBot: 2, perItem: 4 });
  assert.deepEqual(attemptLimits(false), { perBot: Infinity, perItem: Infinity });
  assert.deepEqual(attemptLimits({ on: true, limit: Number.NaN }), { perBot: 2, perItem: 4 });
});

const K = makeKey('k1');
const T0 = Date.parse('2026-10-20T12:00:00Z');
async function updater(gate: GateValue | undefined, probes: Record<string, () => boolean> = {}) {
  const srv = await startFakeServer(makeRelease(K, '0.2.1'));
  const root = tempDir('upd-root-'); const data = tempDir('upd-data-');
  writeFileSync(join(root, 'package-lock.json'), LOCK);
  const store = new Store(data); const bus = new EventBus();
  const deps = { config: {}, store, bus, engine: { running: () => [], cancel: () => true, startTask: () => ({}) }, approvals: new ApprovalBroker(bus), dataDir: data, bsvEnabled: () => false } as unknown as ModuleDeps;
  const clock = { t: T0 };
  const mod: UpdaterModule = createUpdaterModule(deps, {
    root, nativeSecret: 'n'.repeat(64), source: srv.source, keys: [K.key], version: '0.2.0', platform: 'win32', timers: false, now: () => clock.t, probes, freeBytes: () => 10 ** 12,
    ...(gate === undefined ? {} : { gates: { gate: () => gate } }),
  });
  return { mod, srv, clock };
}
const waitFor = async (cond: () => Promise<boolean>) => { for (let i = 0; i < 300 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await cond(), 'timed out'); };

test('update-consent off: the update stages by itself; readyToApply is true when idle and no goal runs, false while a goal runs', async () => {
  let goal = false;
  const r = await updater(false, { 'a goal is running': () => goal });
  try {
    await r.mod.check(true);
    await waitFor(async () => (await r.mod.status()).phase === 'staged'); // no click, no auto setting
    r.clock.t += 120_000;
    goal = true;
    let s = await r.mod.status();
    assert.equal(s.readyToApply, false);
    assert.ok(s.busy.reasons.some((x) => /goal/.test(x)), 'the goal is named as the reason');
    goal = false;
    await r.mod.status(); // the first idle sample: the goal ending restarts the quiet minute
    r.clock.t += 120_000;
    s = await r.mod.status();
    assert.equal(s.readyToApply, true);
    await r.mod.commit(); // the commit needs no click either
  } finally { await r.srv.close(); }
});

test('update-consent off with no goal probe registered: absent means not running', async () => {
  const r = await updater(false);
  try {
    await r.mod.check(true);
    await waitFor(async () => (await r.mod.status()).phase === 'staged');
    r.clock.t += 120_000;
    assert.equal((await r.mod.status()).readyToApply, true);
  } finally { await r.srv.close(); }
});

test('update-consent on (and no gate reader at all): unchanged, nothing is downloaded until the owner clicks', async () => {
  for (const g of [true, undefined] as const) {
    const r = await updater(g);
    try {
      await r.mod.check(true);
      await new Promise((res) => setTimeout(res, 100));
      const s = await r.mod.status();
      assert.equal(s.phase, 'idle'); assert.equal(s.staged, undefined);
      assert.equal(r.srv.hits.filter((h) => h.includes('/releases/download/')).length, 0);
      assert.deepEqual(await r.mod.install(), { ok: true });
      r.clock.t += 120_000;
      assert.equal((await r.mod.status()).readyToApply, true);
    } finally { await r.srv.close(); }
  }
});

test('digest-hold off: the hold counts down 0 ms and sends at once; on: 5000 and 10000 as today', async () => {
  assert.equal(holdMs({ level: 1, certain: true }), HOLD_MS);
  assert.equal(holdMs({ level: 3, certain: true }), HOLD_IRREVERSIBLE_MS);
  assert.equal(holdMs({ level: 1, certain: true }, false), HOLD_MS);
  assert.equal(holdMs({ level: 3, certain: true }, true), 0);
  assert.equal(holdMs(undefined, true), 0);
  const calls: number[] = [];
  const h = createHold({ totalMs: holdMs({ level: 3, certain: true }, true), send: async () => { calls.push(1); return { ok: true as const }; } });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(calls.length, 1, 'sent with no tick');
  assert.equal(h.view().phase, 'sent');
});

test('stall-ladder, ask-timeout-deny and budget-stop are true in every preset (the registry says so, so no preset can switch them off)', () => {
  for (const id of ['stall-ladder', 'ask-timeout-deny', 'budget-stop']) for (const p of PRESETS) assert.equal(gateValue(id, app(p)), true, `${id} in ${p}`);
});
