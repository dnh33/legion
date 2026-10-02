/** The VM fixes through the real HTTP server: agent settings (size, enable), stop with no sandbox, trial fallback, usage, key check, rates in Settings. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BoatClient } from '../src/core/boat.js';
import { EventBus } from '../src/core/bus.js';
import { SettingsService } from '../src/core/settings.js';
import { Store } from '../src/core/store.js';
import { VmManager } from '../src/core/vm-manager.js';
import { defaultConfig } from '../src/shared/config.js';
import type { CoreContext } from '../src/core/server.js';
import { FakeBoatServer } from './fake-boat-server.js';
import { AUTH, start } from './helpers-c.js';

const KEY = 'bk_live_HTTP_SECRET_987654321';

describe('VM fixes over HTTP', () => {
  const fb = new FakeBoatServer();
  const bus = new EventBus();
  let base = ''; let close: () => Promise<void>; let dir = ''; let store: Store; let config: ReturnType<typeof defaultConfig>;
  const H = { ...AUTH, 'Content-Type': 'application/json' };
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...H, ...(init.headers as any) } });
  const json = async (path: string, init: RequestInit = {}): Promise<any> => (await api(path, init)).json();

  before(async () => {
    await fb.start();
    dir = mkdtempSync(join(tmpdir(), 'legion-vmhttp-'));
    store = new Store(dir);
    store.seedDefaults(join(dir, 'w'));
    config = defaultConfig();
    config.boat = { apiKey: KEY, baseUrl: fb.baseUrl };
    config.authToken = 'test-token-123';
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ boat: { apiKey: KEY, baseUrl: fb.baseUrl } }));
    const boat = new BoatClient({ apiKey: KEY, baseUrl: fb.baseUrl, pollMs: 1 });
    const vms = new VmManager({ store, bus, getBoat: () => boat, boatConfig: () => config.boat });
    const settings = new SettingsService({ config, bus, configPath, dataDir: dir });
    const ctx = {
      config, store, bus, engine: {} as any, vms, approvals: { pending: () => [], resolve: () => false } as any, boatConfigured: () => true,
      doctor: async () => [], catalog: async () => ({ commands: [], models: [], fetchedAt: 'x' }), settings,
    } as unknown as CoreContext;
    const s = await start(ctx);
    base = s.base; close = s.close;
  });
  after(async () => { await close(); await fb.stop(); });

  it('agent settings: size and enable are editable over the API and survive (this replaces hand-editing state.json)', async () => {
    const before = (await json('/api/agents')).find((a: any) => a.id === 'builder');
    assert.equal(before.vm.size, 'default', 'Builder is no longer seeded as large');
    const p = await json('/api/agents/builder', { method: 'PATCH', body: JSON.stringify({ vm: { size: 'large', enabled: true } }) });
    assert.deepEqual([p.vm.size, p.vm.enabled], ['large', true]);
    const off = await json('/api/agents/builder', { method: 'PATCH', body: JSON.stringify({ vm: { enabled: false } }) });
    assert.deepEqual([off.vm.size, off.vm.enabled], ['large', false]);
    const bad = await api('/api/agents/builder', { method: 'PATCH', body: JSON.stringify({ vm: { size: 'huge' } }) });
    assert.equal(bad.status, 400);
    await api('/api/agents/builder', { method: 'PATCH', body: JSON.stringify({ vm: { enabled: true } }) });
  });

  it('start on a trial account falls back to default and the record (also in /api/state) carries the notice', async () => {
    fb.trial = true;
    const r = await json('/api/vms/builder/start', { method: 'POST' });
    assert.equal(r.state, 'ready');
    assert.equal(r.size, 'default');
    assert.equal(r.requestedSize, 'large');
    assert.match(r.notice, /free trial/);
    const st = await json('/api/state');
    const rec = st.vms.find((v: any) => v.agentId === 'builder');
    assert.match(rec.notice, /free trial/);
    assert.equal(st.boat.trial.limited, true);
    assert.deepEqual(st.boat.rates, {});
    assert.equal(JSON.stringify(st).includes(KEY), false);
  });

  it('stop returns the record plus stopped/message/usage; with nothing to stop it is 200 with "No sandbox to stop"', async () => {
    const none = await api('/api/vms/scout/stop', { method: 'POST' });
    assert.equal(none.status, 200);
    const n = await none.json();
    assert.equal(n.stopped, false);
    assert.match(n.message, /^No sandbox to stop/);
    assert.notEqual(n.state, 'error');
    assert.equal(n.usage.running, false);
    const real = await json('/api/vms/builder/stop', { method: 'POST' });
    assert.equal(real.stopped, true);
    assert.equal(real.state, 'archived');
    assert.equal(typeof real.usage.todaySeconds, 'number');
  });

  it('GET /api/vms/:id/usage is read-only', async () => {
    const calls = fb.requests.length;
    const u = await json('/api/vms/builder/usage');
    assert.equal(u.running, false);
    assert.equal(fb.requests.length, calls);
  });

  it('POST /api/boat/check probes the key (no sandbox created) and /api/boat/health returns it; SSE carries boat.health without the key', async () => {
    fb.forbidden.add('resume');
    const ac = new AbortController();
    const sse = await fetch(base + '/api/events', { headers: AUTH, signal: ac.signal });
    const created = fb.count('POST', /^\/sandboxes$/);
    const v = await json('/api/boat/check', { method: 'POST' });
    assert.equal(fb.count('POST', /^\/sandboxes$/), created);
    assert.deepEqual(v.forbidden.map((f: any) => f.action), ['sandbox.resume']);
    assert.equal(v.keyOk, true);
    assert.deepEqual((await json('/api/boat/health')).forbidden.map((f: any) => f.action), ['sandbox.resume']);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 3000;
    while (!buf.includes('boat.health') && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: true }), 500))]);
      if (value) buf += dec.decode(value);
      if (done) break;
    }
    ac.abort();
    assert.match(buf, /boat\.health/);
    assert.equal(buf.includes(KEY), false);
    fb.forbidden.clear();
  });

  it('Settings: hourly rates and currency validate, persist, show in the view, and clear', async () => {
    const view0 = await json('/api/settings');
    assert.deepEqual([view0.boat.rates, view0.boat.currency], [{}, '']);
    const ok = await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ boat: { rates: { default: 0.6, large: 2.4 }, currency: 'DKK' } }) });
    assert.deepEqual(ok.boat.rates, { default: 0.6, large: 2.4 });
    assert.equal(ok.boat.currency, 'DKK');
    const disk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(disk.boat.rates, { default: 0.6, large: 2.4 });
    assert.equal(disk.boat.apiKey, KEY, 'the key is untouched');
    assert.deepEqual((await json('/api/boat/health')).rates, { default: 0.6, large: 2.4 });
    for (const bad of [{ default: -1 }, { default: 'x' }, { medium: 1 }, { large: 0 }]) {
      assert.equal((await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ boat: { rates: bad } }) })).status, 400, JSON.stringify(bad));
    }
    const cleared = await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ boat: { rates: {}, currency: '' } }) });
    assert.deepEqual([cleared.boat.rates, cleared.boat.currency], [{}, '']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).boat.rates, undefined);
  });
});
