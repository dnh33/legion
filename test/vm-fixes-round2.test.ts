/** Review round 2 for the VM fixes: memoised usage, serialised start/stop, stale prices, verified stop, probe classification, call-time gating. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoatClient, BoatError, failureKind } from '../src/core/boat.js';
import { BoatHealth, publicBoatHealth } from '../src/core/boat-health.js';
import { buildAgentToolsServer } from '../src/core/agent-tools.js';
import { EventBus } from '../src/core/bus.js';
import { Store } from '../src/core/store.js';
import { VmManager } from '../src/core/vm-manager.js';
import { defaultConfig } from '../src/shared/config.js';
import type { LegionConfig, VmRecord } from '../src/shared/types.js';
import { RATES_TTL_MS, createUsageMemo, vmUsage } from '../src/shared/vm-usage.js';
import { FakeBoatServer } from './fake-boat-server.js';

const KEY = 'bk_live_ROUND2_SECRET';
const servers: FakeBoatServer[] = [];
after(async () => { for (const s of servers) await s.stop(); });
const sleepMs = (n: number) => new Promise((r) => setTimeout(r, n));

async function setup(o: { rates?: LegionConfig['boat']['rates'] } = {}) {
  const fb = await new FakeBoatServer().start();
  servers.push(fb);
  const dir = mkdtempSync(join(tmpdir(), 'legion-vmr2-'));
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'w'));
  const bus = new EventBus();
  const clock = { t: new Date(2026, 4, 1, 10, 0, 0).getTime() };
  const config = defaultConfig();
  config.boat = { apiKey: KEY, baseUrl: fb.baseUrl, ...(o.rates ? { rates: o.rates, currency: 'DKK' } : {}) };
  const boat = new BoatClient({ apiKey: KEY, baseUrl: fb.baseUrl, pollMs: 1 });
  const vm = new VmManager({ store, bus, getBoat: () => boat, now: () => clock.t, boatConfig: () => config.boat, stopPollMs: 1, stopPollTries: 3 });
  const tools = (agentId: string) => {
    const srv = buildAgentToolsServer({ agentId, taskId: 't1', vms: vm, vmEnabled: true, claudeAvailable: true, bridge: {} as any });
    const reg = (srv.instance as any)._registeredTools as Record<string, { handler: (a: any, e: any) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
    return { names: Object.keys(reg), call: async (n: string, a: any = {}) => { const r = await reg[n]!.handler(a, {}); return { text: r.content[0]!.text, isError: !!r.isError }; } };
  };
  return { fb, store, bus, clock, config, boat, vm, tools, dir };
}
const rec = (o: Partial<VmRecord> = {}): VmRecord => ({ agentId: 'a', sandboxId: 'bx_1', state: 'ready', size: 'default', lastUsedAt: null, createdAt: null, ...o });

// ---- 1. memoised usage ---------------------------------------------------------------------------------------------------------
test('R1: usage is computed once per record, second and price set, not once per call or render', () => {
  const memo = createUsageMemo();
  const t = new Date(2026, 4, 1, 10).getTime();
  const r = rec({ runStartedAt: new Date(t - 5000).toISOString() });
  const a = memo(r, t, { default: 1 }, 'DKK');
  for (let i = 0; i < 50; i++) assert.equal(memo(r, t + 10, { default: 1 }, 'DKK'), a, 'same second, same inputs: the same object');
  assert.deepEqual(memo.stats, { computed: 1, hits: 50 });
  memo(r, t + 1000, { default: 1 }, 'DKK');
  assert.equal(memo.stats.computed, 2, 'a new second recomputes');
  memo(rec({ runStartedAt: r.runStartedAt, state: 'archived' }), t + 1000, { default: 1 }, 'DKK');
  assert.equal(memo.stats.computed, 3, 'a changed record recomputes');
  memo(rec({ runStartedAt: r.runStartedAt, state: 'archived' }), t + 1000, { default: 2 }, 'DKK');
  assert.equal(memo.stats.computed, 4, 'a changed price recomputes');
  memo({ ...rec(), agentId: 'other' }, t, undefined);
  assert.equal(memo.stats.computed, 5, 'a different agent is its own entry');
  memo(r, t + 1000, { default: 2 }, 'DKK');
  assert.equal(memo.stats.computed, 6, 'entries are per agent (the other agent\'s call replaced nothing of ours, but ours was a different record by then)');
});

test('R1: VmManager.usage is memoised and the memo never serves old numbers after the clock or the record moves', async () => {
  const s = await setup({ rates: { default: 3600 } });
  await s.vm.ensureRunning('zealot');
  const memo = (s.vm as any).usageMemo as ReturnType<typeof createUsageMemo>;
  const base = memo.stats.computed;
  const a = s.vm.usage('zealot');
  for (let i = 0; i < 20; i++) s.vm.usage('zealot');
  assert.equal(memo.stats.computed - base, 1);
  s.clock.t += 5000;
  assert.equal(s.vm.usage('zealot').runtimeSeconds, a.runtimeSeconds + 5);
  assert.equal(s.vm.usage('zealot').estimate?.amount, 5, '5 s at 3600/h');
  s.config.boat.rates = { default: 7200 };
  assert.equal(s.vm.usage('zealot').estimate?.amount, 10, 'prices are read live from the config on every call');
});

// ---- 3. stale prices -------------------------------------------------------------------------------------------------------------
test('R3: prices from a cached copy older than the TTL give no estimate, only a note; fresh prices do', () => {
  const t = new Date(2026, 4, 1, 10).getTime();
  const r = rec({ runStartedAt: new Date(t - 3600_000).toISOString() });
  const fresh = vmUsage(r, t, { default: 2 }, 'DKK', t - 60_000);
  assert.equal(fresh.estimate?.amount, 2);
  assert.equal(fresh.estimateNote, undefined);
  const edge = vmUsage(r, t, { default: 2 }, 'DKK', t - RATES_TTL_MS);
  assert.ok(edge.estimate, 'exactly at the TTL is still fresh');
  const stale = vmUsage(r, t, { default: 2 }, 'DKK', t - RATES_TTL_MS - 1);
  assert.equal(stale.estimate, undefined);
  assert.match(stale.estimateNote ?? '', /^cost unknown: the prices were last refreshed/);
  assert.equal(vmUsage(r, t, { default: 2 }, 'DKK', Number.NaN).estimate, undefined, 'an unreadable timestamp is not "fresh"');
  assert.equal(vmUsage(r, t, {}, 'DKK', t - 99 * RATES_TTL_MS).estimateNote, undefined, 'no price configured: nothing to be stale');
  // the memo does not keep serving a fresh estimate once the copy goes stale
  const memo = createUsageMemo();
  assert.ok(memo(r, t, { default: 2 }, 'DKK', t - 1000).estimate);
  assert.equal(memo(r, t, { default: 2 }, 'DKK', t - RATES_TTL_MS - 5000).estimate, undefined);
});

test('R3: the health view carries asOf (the time it was produced), so a holder can tell how old its copy is', async () => {
  const s = await setup({ rates: { default: 1 } });
  const v1 = s.vm.health.view();
  assert.equal(v1.asOf, new Date(s.clock.t).toISOString());
  s.clock.t += 120_000;
  assert.equal(s.vm.health.view().asOf, new Date(s.clock.t).toISOString());
});

// ---- 2. serialised start / stop --------------------------------------------------------------------------------------------------
test('R2: a stop issued while a start is still creating the VM waits for it and then really stops it (no "No sandbox to stop")', async () => {
  const s = await setup();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  s.fb.gate = (m, p) => (m === 'POST' && p === '/sandboxes' ? held : undefined);
  const start = s.vm.ensureRunning('zealot');
  await sleepMs(40);
  assert.equal(s.store.getVm('zealot').sandboxId, null, 'the start is in flight: no sandbox id yet');
  const stop = s.vm.stop('zealot');
  await sleepMs(40);
  assert.equal(s.fb.count('POST', /\/stop$/), 0, 'the stop has not run ahead of the start');
  release();
  const [started, stopped] = await Promise.all([start, stop]);
  assert.equal(started.state, 'ready');
  assert.equal(stopped.stopped, true);
  assert.doesNotMatch(stopped.message, /No sandbox|already stopped/);
  assert.equal(s.store.getVm('zealot').state, 'archived');
  const order = s.fb.requests.filter((r) => (r.method === 'POST' && (r.path === '/sandboxes' || r.path.endsWith('/stop')))).map((r) => r.path.endsWith('/stop') ? 'stop' : 'create');
  assert.deepEqual(order, ['create', 'stop']);
});

test('R2: a start requested after a stop waits for that stop (and resumes), instead of joining the earlier start', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  const stop = s.vm.stop('zealot');
  const again = s.vm.ensureRunning('zealot');
  const [st, up] = await Promise.all([stop, again]);
  assert.equal(st.stopped, true);
  assert.equal(up.state, 'ready');
  const ops = s.fb.requests.filter((r) => r.method === 'POST' && /\/(stop|resume)$/.test(r.path)).map((r) => r.path.split('/').pop());
  assert.deepEqual(ops, ['stop', 'resume']);
});

test('R2: two concurrent stops send one stop; the second says the VM is already stopped', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  const [a, b] = await Promise.all([s.vm.stop('zealot'), s.vm.stop('zealot')]);
  assert.deepEqual([a.stopped, b.stopped], [true, false]);
  assert.match(b.message, /already stopped/);
  assert.equal(s.fb.count('POST', /\/stop$/), 1);
});

test('R2: a failed start does not wedge the queue: a stop after it still runs', async () => {
  const s = await setup();
  s.fb.forbidden.add('create');
  await assert.rejects(s.vm.ensureRunning('zealot'));
  const r = await s.vm.stop('zealot');
  assert.equal(r.stopped, false);
  assert.match(r.message, /No sandbox to stop/);
});

// ---- 4. stop re-verified ---------------------------------------------------------------------------------------------------------
test('R4: if boat.dev still reports the VM up after the stop request, the result says so, stopped is false and the run keeps counting', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  s.clock.t += 60_000;
  s.fb.stopSticks = true;
  const r = await s.vm.stop('zealot');
  assert.equal(r.stopped, false);
  assert.equal(r.verified, true);
  assert.match(r.message, /still reports the VM as 'ready'.*may still be billing/);
  assert.equal(r.vm.state, 'ready');
  assert.equal(s.store.getVm('zealot').state, 'ready');
  assert.equal(r.usage.running, true, 'the run was not closed: boat.dev says it is still up');
  assert.equal(r.usage.runtimeSeconds, 60);
  // and the same through the agent tool
  const j = JSON.parse((await s.tools('zealot').call('vm_stop')).text);
  assert.deepEqual([j.stopped, j.verified, j.state], [false, true, 'ready']);
});

test('R4: a snapshot still in progress is reported as in progress; one that finishes is reported stopped', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  s.fb.archiveGets = 1; // one 'archiving' answer, then 'archived'
  const a = await s.vm.stop('zealot');
  assert.equal(a.stopped, true);
  assert.equal(a.vm.state, 'archived');
  assert.match(a.message, /^VM stopped/);
  await s.vm.ensureRunning('zealot');
  s.fb.archiveGets = 99; // never finishes within the 3 checks
  const b = await s.vm.stop('zealot');
  assert.equal(b.stopped, true);
  assert.equal(b.vm.state, 'archiving');
  assert.match(b.message, /still saving the snapshot/);
});

test('R4: when boat.dev cannot be asked afterwards the result says the stop is unconfirmed', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  s.fb.failGets = true;
  const r = await s.vm.stop('zealot');
  assert.equal(r.verified, false);
  assert.match(r.message, /could not be asked to confirm/);
  assert.equal(r.vm.state, 'archiving');
});

test('R4: a VM that boat.dev no longer has after the stop is reported gone, not "stopped"', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  s.fb.gate = (m, p) => { if (m === 'GET' && /^\/sandboxes\/bx_1$/.test(p) && s.fb.count('POST', /\/stop$/) > 0) s.fb.sandboxes.clear(); return undefined; };
  const r = await s.vm.stop('zealot');
  assert.equal(r.vm.state, 'none');
  assert.equal(r.vm.sandboxId, null);
  assert.match(r.message, /gone from boat\.dev/);
});

// ---- 5. probe classification and key lifecycle ---------------------------------------------------------------------------------
test('R5: failureKind separates auth, network, rate limit and server', () => {
  assert.equal(failureKind(new BoatError('x', 401)), 'auth');
  assert.equal(failureKind(new BoatError('x', 0, 'network')), 'network');
  assert.equal(failureKind(new BoatError('x', 429)), 'rate_limit');
  assert.equal(failureKind(new BoatError('x', 502)), 'server');
  assert.equal(failureKind(new BoatError('x', 404)), 'other');
  assert.equal(failureKind(new Error('x')), 'other');
});

test('R5: a rejected key is keyOk=false with kind auth; the probe stops there', async () => {
  const s = await setup();
  s.fb.override = (_m, p) => (p === '/me' ? [401, { ok: false, status: 401, code: 'bad_key', message: 'nope' }] : undefined);
  const v = await s.vm.health.probe();
  assert.equal(v.keyOk, false);
  assert.equal(v.keyProblem?.kind, 'auth');
  assert.equal(v.probes.length, 0);
  assert.equal(s.fb.requests.length, 1);
});

test('R5: an unreachable boat.dev is NOT a verdict on the key: keyOk stays null, kind network, every action unknown', async () => {
  const s = await setup();
  const dead = new BoatClient({ apiKey: KEY, baseUrl: 'http://127.0.0.1:1/api/v1', pollMs: 1 });
  const h = new BoatHealth({ getBoat: () => dead });
  const v = await h.probe();
  assert.equal(v.keyOk, null);
  assert.equal(v.keyProblem?.kind, 'network');
  assert.ok(v.probes.length > 0 && v.probes.every((p) => p.status === 'unknown' && p.reason === 'network'));
  assert.deepEqual(v.forbidden, []);
});

test('R5: a rate limit on /me or mid-probe is "rate_limit", never "allowed"; the probe stops asking', async () => {
  const s = await setup();
  s.fb.override = (_m, p) => (p === '/me' ? [429, { ok: false, status: 429, code: 'rate_limited', message: 'slow down' }] : undefined);
  const a = await s.vm.health.probe();
  assert.equal(a.keyOk, null);
  assert.equal(a.keyProblem?.kind, 'rate_limit');
  assert.ok(a.probes.every((p) => p.status === 'unknown' && p.reason === 'rate_limit'));
  assert.equal(s.fb.requests.length, 1);
  // mid-probe
  const s2 = await setup();
  s2.fb.override = (_m, p) => (p.endsWith('/resume') ? [429, { ok: false, status: 429, message: 'slow down' }] : undefined);
  const b = await s2.vm.health.probe();
  assert.equal(b.keyOk, true);
  assert.equal(b.probes.find((p) => p.op === 'stop')!.status, 'allowed');
  assert.deepEqual(b.probes.find((p) => p.op === 'resume'), { op: 'resume', status: 'unknown', reason: 'rate_limit' });
  assert.ok(b.probes.filter((p) => ['run commands', 'read and write files', 'prompt Claude'].includes(p.op)).every((p) => p.status === 'unknown'));
  assert.equal(b.keyProblem?.kind, 'rate_limit');
  assert.equal(s2.fb.count('POST', /\/commands$/), 0, 'no further calls after a 429');
});

test('R5: server errors and an unexplained 403 give no verdict either', async () => {
  const s = await setup();
  s.fb.override = (m, p) => {
    if (p.endsWith('/stop')) return [503, { ok: false, message: 'down' }];
    if (p.endsWith('/resume')) return [403, { ok: false, code: 'something_else', message: 'plan?' }];
    return undefined;
  };
  const v = await s.vm.health.probe();
  assert.deepEqual(v.probes.find((p) => p.op === 'stop'), { op: 'stop', status: 'unknown', reason: 'server' });
  assert.deepEqual(v.probes.find((p) => p.op === 'resume'), { op: 'resume', status: 'unknown', reason: 'other' });
  assert.deepEqual(v.forbidden, []);
});

test('R5: changing or removing the key drops what was learned, and a probe still running for the old key cannot write into the new state', async () => {
  const fb = await new FakeBoatServer().start();
  servers.push(fb);
  const a = new BoatClient({ apiKey: 'key-A', baseUrl: fb.baseUrl, pollMs: 1 });
  const b = new BoatClient({ apiKey: 'key-B', baseUrl: fb.baseUrl, pollMs: 1 });
  let cur: BoatClient | null = a;
  const h = new BoatHealth({ getBoat: () => cur });
  fb.forbidden.add('resume');
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  fb.gate = (m, p) => (p.endsWith('/stop') ? held : undefined);
  const probe = h.probe();
  await sleepMs(40);
  cur = b; // the user pastes another key while the probe runs
  assert.equal(h.view().configured, true);
  release();
  const out = await probe;
  assert.deepEqual(out.forbidden, [], 'the old key\'s answers were dropped');
  assert.equal(out.checkedAt, null);
  assert.equal(h.view().forbidden.length, 0);
  // a finding for key B, then removing the key clears it with no help from the caller
  fb.gate = undefined;
  await h.probe();
  assert.equal(h.view().forbidden.length, 1);
  cur = null;
  const gone = h.view();
  assert.deepEqual([gone.configured, gone.forbidden, gone.checkedAt, gone.keyOk, gone.probes], [false, [], null, null, []]);
  // and a note() for the old key is not kept either
  cur = a;
  h.note(new BoatError('x', 403, 'provider_not_configured'));
  assert.equal(h.claudeMissing(), true);
  cur = b;
  assert.equal(h.claudeMissing(), false, 'a new key is a new account: nothing carries over');
});

// ---- 6. call-time gating ---------------------------------------------------------------------------------------------------------
test('R6: vm_claude registered while available is refused at call time once Claude is known unconfigured, and no VM is started', async () => {
  const s = await setup();
  const t = s.tools('zealot'); // registered with claudeAvailable: true
  assert.ok(t.names.includes('vm_claude'));
  s.vm.health.note(new BoatError('locked', 409, 'provider_not_configured'));
  const r = await t.call('vm_claude', { prompt: 'do it' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Claude is not configured on boat\.dev: open the Agents page/);
  assert.equal(s.fb.requests.length, 0, 'nothing reached boat.dev: no VM was created to fail afterwards');
  assert.equal(s.store.getVm('zealot').state, 'none');
  // after the TTL it is allowed again at call time
  s.clock.t += 6 * 60_000;
  assert.equal((await t.call('vm_claude', { prompt: 'x' })).text, 'all done');
});

// ---- 7. non-admin views ----------------------------------------------------------------------------------------------------------
test('R7: publicBoatHealth keeps working/not-working and drops prices, probe details and what the key can do', async () => {
  const s = await setup({ rates: { default: 0.6, large: 2.4 } });
  s.fb.forbidden.add('resume');
  s.fb.providerConfigured = false;
  s.fb.providerFirst = true;
  await s.vm.health.probe();
  const full = s.vm.health.view();
  assert.deepEqual(full.rates, { default: 0.6, large: 2.4 });
  assert.ok(full.forbidden.length && full.probes.length);
  const pub = publicBoatHealth(full);
  assert.deepEqual([pub.rates, pub.currency, pub.probes, pub.forbidden, pub.checkedAt, pub.keyOk], [{}, '', [], [], null, null]);
  assert.equal(pub.configured, true);
  assert.equal(pub.claude.state, 'not_configured');
  assert.equal(pub.claude.message, undefined);
  assert.equal(pub.keyProblem, undefined);
  const text = JSON.stringify(pub);
  assert.ok(!/0\.6|2\.4|DKK|resume/.test(text), text);
});
