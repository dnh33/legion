import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoatError, type BoatClient } from '../src/core/boat.js';
import { EventBus } from '../src/core/bus.js';
import { Store } from '../src/core/store.js';
import { VmError, VmManager } from '../src/core/vm-manager.js';
import type { LegionEvent } from '../src/shared/types.js';

class FakeBoat {
  log: string[] = [];
  sandboxes = new Map<string, string>();
  seq = 0;
  createArgs: any[] = [];
  resumeArgs: any[] = [];
  promptArgs: any[] = [];
  async create(p: any) { this.createArgs.push(p); const id = `bx_${++this.seq}`; this.sandboxes.set(id, 'provisioning'); this.log.push('create'); return { id, state: 'provisioning' }; }
  async get(id: string) { const s = this.sandboxes.get(id); if (!s) throw new BoatError('gone', 404, 'not_found'); return { id, state: s }; }
  async waitUntilReady(id: string) { this.log.push('wait'); await new Promise((r) => setTimeout(r, 5)); this.sandboxes.set(id, 'ready'); return { id, state: 'ready' }; }
  async resume(id: string, p: any) { this.resumeArgs.push(p); this.log.push('resume'); this.sandboxes.set(id, 'provisioning'); }
  async stop(id: string) { this.log.push('stop'); this.sandboxes.set(id, 'archived'); }
  async exec(id: string, command: string) { this.log.push('exec:' + command.slice(0, 12)); return { exitCode: 0, stdout: 'hi', stderr: '' }; }
  async readFile(_id: string, path: string, enc?: string) { this.log.push(`read:${path}:${enc ?? 'utf8'}`); return 'ZGF0YQ=='; }
  async writeFile() { this.log.push('write'); }
  async prompt(_id: string, p: any) { this.promptArgs.push(p); return { promptId: 'p' + this.promptArgs.length, conversationId: 'conv1' }; }
  async waitForPrompt() { return { status: 'finished', text: 'done!' }; }
  async desktopUrl() { return 'https://desk/x'; }
}

function setup(opts: { boat?: FakeBoat | null; now?: { t: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-vm-'));
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'w'));
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const boat = opts.boat === undefined ? new FakeBoat() : opts.boat;
  const clock = opts.now ?? { t: Date.parse('2026-01-01T00:00:00Z') };
  const vm = new VmManager({ store, bus, getBoat: () => boat as unknown as BoatClient | null, now: () => clock.t });
  return { store, bus, events, boat: boat as FakeBoat, vm, clock };
}

test('create -> ready -> exec -> stop, emits vm.updated and uses ttl + name', async () => {
  const { vm, boat, events, store } = setup();
  const rec = await vm.ensureRunning('zealot');
  assert.equal(rec.state, 'ready');
  assert.equal(rec.sandboxId, 'bx_1');
  assert.ok(rec.lastUsedAt);
  assert.deepEqual(boat.createArgs[0], { type: 'default', ttlSeconds: 15 * 60 + 900, name: 'legion-zealot' });
  const r = await vm.exec('zealot', 'echo hi');
  assert.equal(r.stdout, 'hi');
  const stopped = await vm.stop('zealot');
  assert.equal(stopped.state, 'archived');
  assert.equal(store.getVm('zealot').state, 'archived');
  const states = events.filter((e) => e.type === 'vm.updated').map((e) => (e as any).vm.state);
  assert.ok(states.includes('provisioning') && states.includes('ready') && states.includes('archiving') && states.at(-1) === 'archived');
});

test('resume path for archived sandbox', async () => {
  const { vm, boat } = setup();
  await vm.ensureRunning('zealot');
  await vm.stop('zealot');
  boat.log.length = 0;
  const rec = await vm.ensureRunning('zealot');
  assert.equal(rec.state, 'ready');
  assert.equal(rec.sandboxId, 'bx_1');
  assert.deepEqual(boat.log, ['resume', 'wait']);
  assert.equal(boat.createArgs.length, 1);
  assert.deepEqual(boat.resumeArgs[0], { ttlSeconds: 1800, type: 'default' });
});

test('already-ready sandbox is reused without create/resume', async () => {
  const { vm, boat } = setup();
  await vm.ensureRunning('zealot');
  boat.log.length = 0;
  await vm.ensureRunning('zealot');
  assert.deepEqual(boat.log, ['wait']);
});

test('404 from boat -> recreate new sandbox', async () => {
  const { vm, boat } = setup();
  await vm.ensureRunning('zealot');
  boat.sandboxes.clear();
  const rec = await vm.ensureRunning('zealot');
  assert.equal(rec.sandboxId, 'bx_2');
  assert.equal(boat.createArgs.length, 2);
});

test('concurrent ensureRunning shares one creation', async () => {
  const { vm, boat } = setup();
  const [a, b, c] = await Promise.all([vm.ensureRunning('builder'), vm.ensureRunning('builder'), vm.exec('builder', 'x').then(() => vm.status('builder'))]);
  assert.equal(boat.createArgs.length, 1);
  assert.equal(a.sandboxId, b.sandboxId);
  assert.equal(c.sandboxId, a.sandboxId);
  assert.equal(boat.createArgs[0].type, 'large');
});

test('error codes: unknown_agent, not_configured, disabled', async () => {
  const s = setup();
  await assert.rejects(s.vm.ensureRunning('ghost'), (e: any) => e instanceof VmError && e.code === 'unknown_agent');
  await assert.rejects(s.vm.ensureRunning('scout'), (e: any) => e.code === 'disabled');
  const n = setup({ boat: null });
  await assert.rejects(n.vm.ensureRunning('zealot'), (e: any) => e.code === 'not_configured' && /Settings → boat\.dev/.test(e.message));
});

test('boat failure -> VmError boat and record state error', async () => {
  const { vm, boat, store } = setup();
  boat.create = async () => { throw new BoatError('boat.dev says billing', 402); };
  await assert.rejects(vm.ensureRunning('zealot'), (e: any) => e.code === 'boat' && /billing/.test(e.message));
  assert.equal(store.getVm('zealot').state, 'error');
  assert.match(store.getVm('zealot').error ?? '', /billing/);
});

test('screenshot requires running VM, does not touch idle timer, returns base64 jpeg', async () => {
  const { vm, boat, clock, store } = setup();
  await assert.rejects(vm.screenshot('zealot'), (e: any) => e.code === 'not_running');
  await vm.ensureRunning('zealot');
  const before = store.getVm('zealot').lastUsedAt;
  clock.t += 60_000;
  const shot = await vm.screenshot('zealot');
  assert.deepEqual(shot, { format: 'jpeg', data: 'ZGF0YQ==' });
  assert.equal(store.getVm('zealot').lastUsedAt, before);
  assert.ok(boat.log.includes('read:/tmp/legion-shot.jpg:base64'));
  assert.ok(boat.log.some((l) => l.startsWith('exec:DISPLAY=:0')));
});

test('claude(): new conversation first, reuses conversationId after', async () => {
  const { vm, boat } = setup();
  assert.equal(await vm.claude('zealot', 'first', { model: 'opus' }), 'done!');
  await vm.claude('zealot', 'second');
  assert.deepEqual(boat.promptArgs[0], { prompt: 'first', model: 'opus', new: true });
  assert.deepEqual(boat.promptArgs[1], { prompt: 'second', model: undefined, conversationId: 'conv1' });
});

test('claude() surfaces failed prompt as VmError', async () => {
  const { vm, boat } = setup();
  boat.waitForPrompt = async () => ({ status: 'failed', text: 'oops' });
  await assert.rejects(vm.claude('zealot', 'x'), (e: any) => e.code === 'boat' && /oops/.test(e.message));
});

test('desktopUrl, readFile, writeFile auto-start', async () => {
  const { vm, boat } = setup();
  assert.equal(await vm.desktopUrl('zealot'), 'https://desk/x');
  assert.equal(await vm.readFile('zealot', '/tmp/a'), 'ZGF0YQ==');
  await vm.writeFile('zealot', '/tmp/a', 'x');
  assert.equal(boat.createArgs.length, 1);
});

test('reapIdle stops only VMs idle longer than idleStopMinutes (fake clock)', async () => {
  const { vm, boat, clock, store } = setup();
  await vm.ensureRunning('zealot');
  await vm.ensureRunning('builder');
  const b = store.getAgent('builder')!;
  store.upsertAgent({ ...b, vm: { ...b.vm, idleStopMinutes: 60 } });
  clock.t += 10 * 60_000;
  assert.deepEqual(await vm.reapIdle(), []);
  clock.t += 6 * 60_000; // 16 min: zealot idle (15), builder not (60)
  assert.deepEqual(await vm.reapIdle(), ['zealot']);
  assert.equal(vm.status('zealot').state, 'archived');
  assert.equal(vm.status('builder').state, 'ready');
  // touching resets the timer
  clock.t += 50 * 60_000;
  vm.touch('builder');
  clock.t += 30 * 60_000;
  assert.deepEqual(await vm.reapIdle(), []);
  clock.t += 31 * 60_000;
  assert.deepEqual(await vm.reapIdle(), ['builder']);
  assert.equal(boat.log.filter((l) => l === 'stop').length, 2);
});

test('startReaper refreshes stored state from boat and returns stop fn', async () => {
  const { vm, boat, store } = setup();
  await vm.ensureRunning('zealot');
  boat.sandboxes.set('bx_1', 'archived');
  const stop = vm.startReaper(1_000_000);
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.equal(store.getVm('zealot').state, 'archived');
});
