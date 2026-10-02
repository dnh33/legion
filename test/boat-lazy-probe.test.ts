/** K1: the boat.dev key probe (about 8 calls) is lazy. Core start makes none; the first look is on first VM use or when Settings, boat.dev opens, once and cached. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_STDIN_FLAG } from '../src/core/admin.js';
import { BoatClient } from '../src/core/boat.js';
import { BoatHealth } from '../src/core/boat-health.js';
import { EventBus } from '../src/core/bus.js';
import { Store } from '../src/core/store.js';
import { VmManager } from '../src/core/vm-manager.js';
import { FakeBoatServer } from './fake-boat-server.js';

const KEY = 'bk_live_LAZY_PROBE_KEY';
const SECRET = 'a1'.repeat(32);
const servers: FakeBoatServer[] = [];
after(async () => { for (const s of servers) await s.stop(); });
const fake = async () => { const f = await new FakeBoatServer().start(); servers.push(f); return f; };
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const freePort = (): Promise<number> => new Promise((res, rej) => {
  const s = createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});
const coreJs = new URL('../src/bin/legion-core.js', import.meta.url).pathname;

test('K1: a real core with a boat.dev key makes ZERO boat.dev calls at start; Settings opening probes once, a second open is cached, Check again asks again', async () => {
  const fb = await fake();
  const home = mkdtempSync(join(tmpdir(), 'legion-k1-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ boat: { apiKey: KEY, baseUrl: fb.baseUrl } }));
  const port = await freePort();
  const child = spawn(process.execPath, [coreJs], { env: { ...process.env, LEGION_HOME: home, LEGION_PORT: String(port), [ADMIN_STDIN_FLAG]: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin!.end(SECRET + '\n');
  const base = `http://127.0.0.1:${port}`;
  try {
    const end = Date.now() + 20000;
    let up = false;
    while (Date.now() < end && !up) { try { up = (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { await sleep(100); } }
    assert.ok(up, 'the core did not come up');
    await sleep(1500); // background start-up work (the reaper, the old probe) would have shown by now
    assert.equal(fb.requests.length, 0, `core start must not call boat.dev (saw ${fb.requests.map((r) => `${r.method} ${r.path}`).join(', ')})`);
    const post = async (p: string) => (await fetch(base + p, { method: 'POST', headers: { 'X-Legion-Admin': SECRET } })).json() as Promise<any>;
    const first = await post('/api/boat/ensure');
    assert.ok(first.checkedAt, 'the first look ran');
    const n = fb.requests.length;
    assert.ok(n > 0);
    await post('/api/boat/ensure');
    assert.equal(fb.requests.length, n, 'a second open is answered from the cache');
    await post('/api/boat/check');
    assert.ok(fb.requests.length > n, 'the manual re-check button asks again');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('K1: BoatHealth.ensure probes once per key, shares a probe in flight, and starts over for a new key', async () => {
  const fb = await fake();
  let cur = new BoatClient({ apiKey: KEY, baseUrl: fb.baseUrl, pollMs: 1 });
  const h = new BoatHealth({ getBoat: () => cur, bus: new EventBus() });
  assert.equal(fb.requests.length, 0, 'constructing it calls nothing');
  assert.equal(h.view().checkedAt, null, 'viewing it calls nothing');
  const [a, b] = await Promise.all([h.ensure(), h.ensure()]);
  assert.ok(a.checkedAt && b.checkedAt);
  const n = fb.requests.length;
  assert.ok(n >= 5, 'the probe is a handful of calls');
  await h.ensure();
  assert.equal(fb.requests.length, n, 'cached');
  cur = new BoatClient({ apiKey: 'bk_live_OTHER', baseUrl: fb.baseUrl, pollMs: 1 });
  assert.equal(h.view().checkedAt, null, 'a new key forgets the old findings');
  await h.ensure();
  assert.ok(fb.requests.length > n, 'and looks again, once');
});

test('K1: the first VM use triggers the probe (once); nothing before it', async () => {
  const fb = await fake();
  const dir = mkdtempSync(join(tmpdir(), 'legion-k1vm-'));
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'w'));
  const boat = new BoatClient({ apiKey: KEY, baseUrl: fb.baseUrl, pollMs: 1 });
  const vm = new VmManager({ store, bus: new EventBus(), getBoat: () => boat });
  assert.equal(fb.requests.length, 0, 'a VmManager that has not been used makes no call');
  await vm.ensureRunning('builder');
  for (let i = 0; i < 50 && !vm.health.view().checkedAt; i++) await sleep(20);
  assert.ok(vm.health.view().checkedAt, 'the probe ran on first use');
  const probeCalls = fb.requests.filter((r) => r.path.includes('bx_legion_probe_does_not_exist')).length;
  assert.ok(probeCalls > 0);
  await vm.ensureRunning('builder').catch(() => undefined);
  assert.equal(fb.requests.filter((r) => r.path.includes('bx_legion_probe_does_not_exist')).length, probeCalls, 'not probed again');
});
