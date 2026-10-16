/** H2: the core writes steps 1 to 4 (checking, downloading, verifying, ready) with the update id the app and the helper then carry; the status shows the journey; the Updated notice shows once; the window is a setting. */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_HEADER } from '../src/core/admin.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createUpdaterModule, type UpdaterModule } from '../src/core/updater/index.js';
import { readJourneyEvents, recordStep } from '../src/core/updater/journey-io.js';
import { parseJourneyLine } from '../src/core/updater/journey.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import { Store } from '../src/core/store.js';
import { LOCK, makeKey, makeRelease, startFakeServer, type FakeServer, type Release } from './updater-helpers.js';

const k = makeKey('k1');
const NATIVE = 'n'.repeat(64);
const T0 = Date.parse('2026-10-20T12:00:00Z');
interface Rig { mod: UpdaterModule; srv: FakeServer; root: string; data: string; clock: { t: number }; call: (method: string, path: string, c?: { body?: unknown }) => Promise<unknown> }
async function rig(release: Release | null, o: { version?: string } = {}): Promise<Rig> {
  const srv = await startFakeServer(release);
  const root = tempDir('h2-core-root-'); const data = tempDir('h2-core-data-');
  writeFileSync(join(root, 'package-lock.json'), LOCK);
  const store = new Store(data);
  const engine = { running: () => [] as string[], cancel: () => true, startTask: () => ({}) };
  const deps = { config: {}, store, bus: new EventBus(), engine, approvals: new ApprovalBroker(new EventBus()), dataDir: data, bsvEnabled: () => false } as unknown as ModuleDeps;
  const clock = { t: T0 };
  const mod = createUpdaterModule(deps, { root, nativeSecret: NATIVE, source: srv.source, keys: [k.key], version: o.version ?? '0.2.0', platform: 'win32', timers: false, now: () => clock.t });
  const routes = new Map<string, (c: unknown) => unknown>();
  mod.routes!(((m: string, p: string, h: (c: unknown) => unknown) => { routes.set(`${m} ${p}`, h); }) as unknown as RouteAdder);
  const call = async (method: string, path: string, c: { body?: unknown } = {}) => {
    const h = routes.get(`${method} ${path}`); assert.ok(h, `no route ${method} ${path}`);
    return h({ req: { headers: { [NATIVE_HEADER]: NATIVE }, legionAdmin: true }, body: c.body, params: [], url: new URL('http://x/') });
  };
  return { mod, srv, root, data, clock, call };
}
const lines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

test('H2 core: finding an update, downloading, verifying and staging write steps 1 to 4 with one update id, in the journey file, apply.log and app.log', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true);
    assert.equal((await r.mod.install()).ok, true);
    const ev = readJourneyEvents(r.root);
    assert.deepEqual(ev.map((e) => `${e.step}:${e.state}`), ['checking:done', 'downloading:start', 'downloading:done', 'verifying:start', 'verifying:done', 'ready:done']);
    assert.equal(new Set(ev.map((e) => e.id)).size, 1); assert.match(ev[0]!.id, /^[0-9a-f]{8}$/);
    assert.ok(ev.every((e) => e.from === '0.2.0' && e.to === '0.2.1' && e.proc === 'core' && e.kind === 'code'));
    const al = lines(join(r.root, '.update', 'apply.log')).map((l) => parseJourneyLine(l)).filter(Boolean);
    assert.equal(al.length, ev.length); assert.ok(al.every((e) => e!.id === ev[0]!.id));
    const app = lines(join(r.data, 'logs', 'app.log')).filter((l) => l.includes('journey-step'));
    assert.equal(app.length, ev.length); assert.ok(app.every((l) => l.includes(`id="${ev[0]!.id}"`)));
    const dl = ev.find((e) => e.step === 'downloading' && e.state === 'done')!;
    assert.ok(dl.bytes! > 0 && dl.bytes === dl.total, 'the finished download says how many bytes');
  } finally { await r.srv.close(); }
});

test('H2 core: checking again for the same version keeps the id; a newer version starts a new journey', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true); const id1 = readJourneyEvents(r.root)[0]!.id;
    r.clock.t += 61_000; await r.mod.check(true);
    assert.equal(readJourneyEvents(r.root).length, 1, 'the same update is not logged twice');
    assert.equal(readJourneyEvents(r.root)[0]!.id, id1);
    r.srv.setRelease(makeRelease(k, '0.2.2'));
    r.clock.t += 61_000; await r.mod.check(true);
    const ev = readJourneyEvents(r.root);
    assert.deepEqual(ev.map((e) => e.to), ['0.2.2']); assert.notEqual(ev[0]!.id, id1);
  } finally { await r.srv.close(); }
});

test('H2 core: a failed download is a failed journey with the plain reason, never a silent stop', async () => {
  const r = await rig(makeRelease(k, '0.2.1', { manifest: { asset: { name: 'legion-0.2.1-app.zip', size: 10, sha256: '0'.repeat(64) } } }));
  try {
    await r.mod.check(true);
    const res = await r.mod.install();
    assert.equal(res.ok, false);
    const ev = readJourneyEvents(r.root);
    const f = ev.find((e) => e.step === 'failed');
    assert.ok(f, ev.map((e) => `${e.step}:${e.state}`).join(','));
    assert.equal(f!.state, 'done'); assert.ok(f!.during === 'downloading' || f!.during === 'verifying'); assert.ok(f!.note && f!.note.length > 3);
    assert.equal((await r.mod.status()).journey?.result, 'failed');
  } finally { await r.srv.close(); }
});

test('H2 core: commit hands the app the update id, so the helper and the new build write the same one', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true); await r.mod.install();
    r.clock.t += 120_000;
    const c = await r.mod.commit();
    assert.equal(c.updateId, readJourneyEvents(r.root)[0]!.id);
  } finally { await r.srv.close(); }
});

test('H2 core: the status carries the journey and the update-window setting (on by default, a plain switch)', async () => {
  const r = await rig(makeRelease(k, '0.2.1'));
  try {
    await r.mod.check(true);
    const s = await r.mod.status();
    assert.equal(s.settings.updateWindow, true, 'on by default');
    assert.equal(s.journey?.to, '0.2.1'); assert.equal(s.journey?.result, 'running');
    assert.equal(s.journey?.steps.find((x) => x.id === 'checking')?.state, 'done');
    const saved = await r.call('PATCH', '/api/update/settings', { body: { updateWindow: false } }) as { updateWindow: boolean };
    assert.equal(saved.updateWindow, false);
    assert.equal((await r.mod.status()).settings.updateWindow, false);
    await assert.rejects(r.call('PATCH', '/api/update/settings', { body: { updateWindow: 'yes' } }), /updateWindow must be true or false/);
    assert.equal((await r.call('PATCH', '/api/update/settings', { body: { checkEnabled: true } }) as { updateWindow: boolean }).updateWindow, false, 'other settings leave it alone');
  } finally { await r.srv.close(); }
});

test('H2 core: after the new build wrote Done, the status says Updated once, and acknowledging it clears it for good', async () => {
  const r = await rig(null, { version: '0.2.1' });
  try {
    const c = { installDir: r.root, dataDir: r.data, id: 'ab12cd34', from: '0.2.0', to: '0.2.1', proc: 'new-app' as const };
    recordStep({ ...c, proc: 'helper' }, 'installing', 'done'); recordStep(c, 'done', 'done');
    const s = await r.mod.status();
    assert.deepEqual(s.updated, { version: '0.2.1', id: 'ab12cd34' });
    await r.call('POST', '/api/update/ack-updated', { body: { id: 'ab12cd34' } });
    assert.equal((await r.mod.status()).updated, undefined);
    assert.equal((await r.mod.status()).journey?.result, 'ok', 'About still shows the last journey');
  } finally { await r.srv.close(); }
});

test('H2 core: a journey for another version, or one that did not finish, never shows as Updated', async () => {
  const r = await rig(null, { version: '0.2.5' });
  try {
    recordStep({ installDir: r.root, id: 'ab12cd34', from: '0.2.0', to: '0.2.1', proc: 'new-app' }, 'done', 'done');
    assert.equal((await r.mod.status()).updated, undefined, 'the running version is not the one that was installed');
  } finally { await r.srv.close(); }
});
