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
import { BoardStore } from '../src/core/projects/board/store.js';
import { MarshalDriver } from '../src/core/marshal/driver.js';
import type { MarshalPorts } from '../src/core/marshal/orchestrator.js';
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
async function updater(gate: GateValue | undefined | (() => GateValue), probes: Record<string, () => boolean> = {}, release = makeRelease(K, '0.2.1')) {
  const srv = await startFakeServer(release);
  const root = tempDir('upd-root-'); const data = tempDir('upd-data-');
  writeFileSync(join(root, 'package-lock.json'), LOCK);
  const store = new Store(data); const bus = new EventBus();
  const deps = { config: {}, store, bus, engine: { running: () => [], cancel: () => true, startTask: () => ({}) }, approvals: new ApprovalBroker(bus), dataDir: data, bsvEnabled: () => false } as unknown as ModuleDeps;
  const clock = { t: T0 };
  const mod: UpdaterModule = createUpdaterModule(deps, {
    root, nativeSecret: 'n'.repeat(64), source: srv.source, keys: [K.key], version: '0.2.0', platform: 'win32', timers: false, now: () => clock.t, probes, freeBytes: () => 10 ** 12,
    ...(gate === undefined ? {} : { gates: { gate: typeof gate === 'function' ? gate : () => gate } }),
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
  const throwing = () => { throw new Error('gates core is down'); };
  for (const g of [true, undefined, throwing] as const) {
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

test('update-consent: an update staged while the gate was off does not carry the owner consent; switching it on stops the apply', async () => {
  let value: GateValue = false;
  const r = await updater(() => value);
  try {
    await r.mod.check(true);
    await waitFor(async () => (await r.mod.status()).phase === 'staged');
    r.clock.t += 120_000;
    await r.mod.status();
    r.clock.t += 120_000;
    let s = await r.mod.status();
    assert.equal(s.readyToApply, true); assert.equal(s.consent, true, 'gate off: the panel reports no consent needed');
    value = true; // the owner switches "Ask before an update installs" back on
    s = await r.mod.status();
    assert.equal(s.readyToApply, false); assert.equal(s.consent, false, 'no click was ever given');
    await assert.rejects(() => r.mod.commit(), (e: { status?: number }) => e.status === 409);
    value = false;
    assert.equal((await r.mod.status()).readyToApply, true, 'and switching it off again resumes');
    value = true;
    assert.deepEqual(await r.mod.install(), { ok: true }); // the owner clicks: that is consent
    assert.equal((await r.mod.status()).readyToApply, true);
  } finally { await r.srv.close(); }
});

test('update-consent off: a version whose staging failed is not downloaded again for 24 hours', async () => {
  const rel = makeRelease(K, '0.2.1');
  const bad = { ...rel, zip: Buffer.alloc(rel.zip.length, 7) }; // the manifest still names the real hash, so staging fails
  const r = await updater(false, {}, bad);
  try {
    const dl = () => r.srv.hits.filter((h) => h.includes('/releases/download/')).length;
    await r.mod.check(true);
    await waitFor(async () => dl() > 0 && (await r.mod.status()).phase === 'idle' && !!(await r.mod.status()).error);
    const first = dl();
    r.clock.t += 6 * 3600_000; await r.mod.check(true);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(dl(), first, 'inside the 24 hours: no second download');
    r.clock.t += 19 * 3600_000; await r.mod.check(true);
    await waitFor(async () => dl() > first);
  } finally { await r.srv.close(); }
});

test('attempt caps ride the marshal driver per project: Ask gets 2/4, Bypass 4/8', () => {
  const dir = tempDir('legion-caps-driver-');
  const board = new BoardStore(dir, () => T0);
  const preset: Record<string, (typeof PRESETS)[number]> = { proj_aaaaaaaaaaaa: 'ask', proj_bbbbbbbbbbbb: 'bypass' };
  const mk = (limits: boolean) => new MarshalDriver({
    board, project: (id) => ({ id, members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], status: 'active' }),
    ports: () => ({ board }) as unknown as MarshalPorts, changed: () => undefined, now: () => T0, schedule: () => () => undefined,
    ...(limits ? { limits: (pid: string) => attemptLimits(gateValue('attempt-caps', app(preset[pid]!))) } : {}),
  });
  const bots = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  for (const id of Object.keys(preset)) board.create({ id, members: bots, status: 'active' }, { title: 'x', priority: 'high' });
  const d = mk(true);
  const ledger = (pid: string) => { const l = d.marshalFor(pid)!.ledger; l.setDoneWhen(I, ['it works']); return l; };
  assert.equal(allowed(ledger('proj_aaaaaaaaaaaa'), ['a']), 2); assert.equal(allowed(ledger('proj_bbbbbbbbbbbb'), ['a']), 4);
  const d2 = mk(true); const l2 = (pid: string) => { const l = d2.marshalFor(pid)!.ledger; l.setDoneWhen(I, ['it works']); return l; };
  assert.equal(allowed(l2('proj_aaaaaaaaaaaa'), bots), 4); assert.equal(allowed(l2('proj_bbbbbbbbbbbb'), bots), 8);
});

test('digest-hold off: the hold counts down 0 ms and sends at once; on: 5000 and 10000 as today', async () => {
  assert.equal(holdMs({ level: 1, certain: true }), HOLD_MS);
  assert.equal(holdMs({ level: 3, certain: true }), HOLD_IRREVERSIBLE_MS);
  assert.equal(holdMs({ level: 1, certain: true }, false), HOLD_MS);
  assert.equal(holdMs({ level: 3, certain: true }, true), 0);
  assert.equal(holdMs(undefined, true), 0);
  const calls: number[] = [];
  const h = createHold({ totalMs: holdMs({ level: 3, certain: true }, true), holdOff: true, send: async () => { calls.push(1); return { ok: true as const }; } });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(calls.length, 1, 'sent with no tick');
  assert.equal(h.view().phase, 'sent');
});

test('createHold: only holdOff sends at once; a total of 0 or less without it counts down as before Task 9 (sends on the first tick)', async () => {
  for (const totalMs of [0, -5]) {
    const calls: number[] = [];
    const h = createHold({ totalMs, send: async () => { calls.push(1); return { ok: true as const }; } });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(calls.length, 0, `totalMs ${totalMs}: no send before a tick`);
    assert.equal(h.view().phase, 'counting');
    h.tick(1);
    assert.equal(calls.length, 1); assert.equal(h.view().phase, 'sent');
  }
});

test('stall-ladder, ask-timeout-deny and budget-stop are true in every preset (the registry says so, so no preset can switch them off)', () => {
  for (const id of ['stall-ladder', 'ask-timeout-deny', 'budget-stop']) for (const p of PRESETS) assert.equal(gateValue(id, app(p)), true, `${id} in ${p}`);
});

test('a gate-staged update: Restart and install records consent only after the native yes; the idle timer never applies it', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const main = readFileSync(`${root}/src/electron/updater-main.ts`, 'utf8');
  const fn = main.slice(main.indexOf('async function applyNow('), main.indexOf('async function applyNow(') + 4000);
  assert.match(fn, /!st\.json\.staged \|\| \(!st\.json\.consent && !force\)/, 'without force (the timer) consent is required');
  const yes = fn.indexOf('if (r.response !== 1) return'), rec = fn.indexOf("'/api/update/approve', { version: st.json.staged.version }"), drain = fn.indexOf("'/api/update/drain'");
  assert.ok(yes > 0 && rec > yes && drain > rec, 'consent is recorded after the dialog yes and before the drain');
  const panel = readFileSync(`${root}/ui/src/components/UpdatePanel.tsx`, 'utf8');
  assert.match(panel, /st\.consent \? 'Legion installs it by itself[^']*' : 'Legion waits for your yes\./, 'the panel does not promise a self-install without consent');
});

test('approveStaged records consent only for the staged version the dialog named, and never downloads', async () => {
  const { isClientRoute } = await import('../src/core/admin.js');
  assert.equal(isClientRoute('POST', '/api/update/approve'), false, 'admin only');
  let value: GateValue = false;
  const r = await updater(() => value);
  try {
    await r.mod.check(true);
    await waitFor(async () => (await r.mod.status()).phase === 'staged');
    const v = (await r.mod.status()).staged!.version;
    value = true; // the owner switches "Ask before an update installs" back on
    const dl = () => r.srv.hits.filter((h) => h.includes('/releases/download/')).length;
    const before = dl();
    for (const other of ['9.9.9', undefined, 42, '']) assert.throws(() => r.mod.approveStaged(other), (e: { status?: number }) => e.status === 409);
    assert.equal((await r.mod.status()).consent, false, 'a different version approves nothing');
    assert.deepEqual(r.mod.approveStaged(v), { ok: true });
    assert.equal((await r.mod.status()).consent, true);
    assert.equal(dl(), before, 'approving downloads nothing');
  } finally { await r.srv.close(); }
});
