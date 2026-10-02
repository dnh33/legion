/** The boat.dev VM fixes from Zealot's report, end to end: real BoatClient + VmManager + agent tools against a fake boat HTTP server. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoatClient } from '../src/core/boat.js';
import { BoatHealth } from '../src/core/boat-health.js';
import { buildAgentToolsServer } from '../src/core/agent-tools.js';
import { EventBus } from '../src/core/bus.js';
import { runDoctor } from '../src/core/doctor.js';
import { SettingsService } from '../src/core/settings.js';
import { Store } from '../src/core/store.js';
import { VmError, VmManager } from '../src/core/vm-manager.js';
import { defaultConfig } from '../src/shared/config.js';
import type { LegionConfig, LegionEvent } from '../src/shared/types.js';
import { FakeBoatServer } from './fake-boat-server.js';
import type { QueryFn } from '../src/core/engine.js';

const KEY = 'bk_live_TOPSECRET_0123456789';
const servers: FakeBoatServer[] = [];
after(async () => { for (const s of servers) await s.stop(); });

async function setup(o: { rates?: LegionConfig['boat']['rates']; currency?: string } = {}) {
  const fb = await new FakeBoatServer().start();
  servers.push(fb);
  const dir = mkdtempSync(join(tmpdir(), 'legion-vmfix-'));
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'w'));
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const clock = { t: new Date(2026, 4, 1, 10, 0, 0).getTime() };
  const config = defaultConfig();
  config.boat = { apiKey: KEY, baseUrl: fb.baseUrl, ...(o.rates ? { rates: o.rates } : {}), ...(o.currency ? { currency: o.currency } : {}) };
  const boat = new BoatClient({ apiKey: KEY, baseUrl: fb.baseUrl, pollMs: 1 });
  const vm = new VmManager({ store, bus, getBoat: () => boat, now: () => clock.t, boatConfig: () => config.boat });
  const agent = (id: string, size: 'small' | 'default' | 'large') => { const a = store.getAgent(id)!; store.upsertAgent({ ...a, vm: { ...a.vm, enabled: true, size } }); };
  const tools = (agentId: string, claudeAvailable = vm.claudeAvailable()) => {
    const srv = buildAgentToolsServer({ agentId, taskId: 't1', vms: vm, vmEnabled: true, claudeAvailable, bridge: {} as any });
    const reg = (srv.instance as any)._registeredTools as Record<string, { handler: (a: any, e: any) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
    return { names: Object.keys(reg), call: async (n: string, a: any = {}) => { const r = await reg[n]!.handler(a, {}); return { text: r.content[0]!.text, isError: !!r.isError }; } };
  };
  return { fb, store, bus, events, clock, config, boat, vm, agent, tools, dir };
}

const createdTypes = (fb: FakeBoatServer) => fb.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes').map((r) => r.body.type);

// ---- 1. trial: large is refused -> fall back to default and say so ------------------------------------------------------------
test('bug 1: a free trial refuses large -> Builder falls back to default, the record says so, the next start skips the failing call', async () => {
  const s = await setup();
  s.fb.trial = true;
  s.agent('builder', 'large');
  const rec = await s.vm.ensureRunning('builder');
  assert.equal(rec.state, 'ready');
  assert.equal(rec.size, 'default');
  assert.equal(rec.requestedSize, 'large');
  assert.match(rec.notice ?? '', /free trial/);
  assert.match(rec.notice ?? '', /Configured size: large/);
  assert.deepEqual(createdTypes(s.fb), ['large', 'default'], 'one refused attempt, then the fallback');
  // The record must not look stale because its size differs from the config: the next start reuses the running VM.
  const again = await s.vm.ensureRunning('builder');
  assert.equal(again.sandboxId, rec.sandboxId);
  assert.equal(createdTypes(s.fb).length, 2);
  assert.match(again.notice ?? '', /free trial/);
  // After a stop and a new start the account is known to be on a trial: no second refused call.
  await s.vm.stop('builder');
  s.fb.sandboxes.clear();
  await s.vm.ensureRunning('builder');
  assert.deepEqual(createdTypes(s.fb), ['large', 'default', 'default']);
  assert.equal(s.vm.health.view().trial.limited, true);
});

test('bug 1: resume of an archived VM also falls back when the trial refuses the configured size', async () => {
  const s = await setup();
  await s.vm.health.ensure(); s.fb.requests.length = 0; // the first-use key probe is lazy (K1); do it up front so it does not mix into the calls counted below
  await s.vm.ensureRunning('builder'); // default
  await s.vm.stop('builder');
  s.fb.trial = true;
  s.agent('builder', 'large');
  const rec = await s.vm.ensureRunning('builder');
  assert.equal(rec.state, 'ready');
  assert.equal(rec.size, 'default');
  assert.equal(rec.requestedSize, 'large');
  assert.deepEqual(s.fb.requests.filter((r) => r.path.endsWith('/resume')).map((r) => r.body.type), ['large', 'default']);
});

test('bug 1: with default size configured nothing changes and no notice appears; the Builder seed is default', async () => {
  const s = await setup();
  assert.equal(s.store.getAgent('builder')!.vm.size, 'default');
  const rec = await s.vm.ensureRunning('builder');
  assert.equal(rec.notice, undefined);
  assert.equal(rec.requestedSize, undefined);
  assert.deepEqual(createdTypes(s.fb), ['default']);
});

test('bug 1: the trial fallback also reaches the agent through vm_start (notice in the tool result)', async () => {
  const s = await setup();
  s.fb.trial = true;
  s.agent('builder', 'large');
  const r = await s.tools('builder').call('vm_start');
  assert.equal(r.isError, false);
  const j = JSON.parse(r.text);
  assert.equal(j.size, 'default');
  assert.match(j.notes.join(' '), /free trial/);
});

// ---- 2. stale / failed records are rebuilt from the config -----------------------------------------------------------------------
test('bug 2: a failed record {sandboxId null, state error, size large} is recreated from the agent config on the next start', async () => {
  const s = await setup();
  s.store.upsertVm({ agentId: 'builder', sandboxId: null, state: 'error', size: 'large', lastUsedAt: null, createdAt: null, error: 'POST /sandboxes -> 403 trial_machine_class_not_allowed' });
  const rec = await s.vm.ensureRunning('builder');
  assert.equal(rec.state, 'ready');
  assert.equal(rec.size, 'default');
  assert.equal(rec.error, undefined);
  assert.deepEqual(createdTypes(s.fb), ['default']);
});

test('bug 2: an error record whose sandbox boat.dev no longer has (404) or reports as error is replaced, not reused', async () => {
  const s = await setup();
  s.store.upsertVm({ agentId: 'builder', sandboxId: 'bx_dead', state: 'error', size: 'large', lastUsedAt: null, createdAt: null, error: 'boom' });
  const a = await s.vm.ensureRunning('builder');
  assert.notEqual(a.sandboxId, 'bx_dead');
  assert.equal(a.size, 'default');
  // sandbox exists but is in error state on boat
  s.fb.sandboxes.set('bx_err', { state: 'error', type: 'large' });
  s.store.upsertVm({ ...a, sandboxId: 'bx_err', state: 'error', error: 'x' });
  const b = await s.vm.ensureRunning('builder');
  assert.notEqual(b.sandboxId, 'bx_err');
  assert.equal(b.state, 'ready');
});

test('bug 2: a stopped VM picks up a size changed in the agent settings when it is resumed', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  await s.vm.stop('zealot');
  s.agent('zealot', 'small');
  const rec = await s.vm.ensureRunning('zealot');
  assert.equal(rec.size, 'small');
  assert.equal(s.fb.requests.filter((r) => r.path.endsWith('/resume')).at(-1)!.body.type, 'small');
});

test('bug 2: a running VM is not destroyed when the size setting changes; the record says when it applies', async () => {
  const s = await setup();
  const first = await s.vm.ensureRunning('zealot');
  s.agent('zealot', 'large');
  const rec = await s.vm.ensureRunning('zealot');
  assert.equal(rec.sandboxId, first.sandboxId);
  assert.equal(rec.size, 'default');
  assert.match(rec.notice ?? '', /running at size default; the configured size large applies the next time/);
});

test('bug 2: the HTTP/agent settings path: an agent edit survives (the manager reads the live config, state.json is not the source of truth)', async () => {
  const s = await setup();
  s.agent('builder', 'large');
  assert.equal(s.store.getAgent('builder')!.vm.size, 'large');
  s.fb.trial = true;
  const rec = await s.vm.ensureRunning('builder');
  assert.equal(rec.requestedSize, 'large');
});

// ---- 3. vm_stop with no sandbox -----------------------------------------------------------------------------------------------
test('bug 3: vm_stop for an agent with no sandbox says so plainly and never shows a fake error state', async () => {
  const s = await setup();
  const r = await s.tools('builder').call('vm_stop');
  assert.equal(r.isError, false);
  const j = JSON.parse(r.text);
  assert.equal(j.ok, true);
  assert.equal(j.stopped, false);
  assert.match(j.message, /^No sandbox to stop/);
  assert.notEqual(j.state, 'error');
  assert.equal(j.state, 'none');
  assert.equal(s.fb.requests.length, 0, 'nothing is sent to boat.dev when there is nothing to stop');
});

test('bug 3: a failed start leaves {sandboxId null, state error}; vm_stop clears it back to none instead of echoing the error', async () => {
  const s = await setup();
  s.store.upsertVm({ agentId: 'builder', sandboxId: null, state: 'error', size: 'large', lastUsedAt: null, createdAt: null, error: 'it failed' });
  const events0 = s.events.length;
  const r = await s.vm.stop('builder');
  assert.equal(r.stopped, false);
  assert.match(r.message, /No sandbox to stop/);
  assert.equal(r.vm.state, 'none');
  assert.equal(r.vm.error, undefined);
  assert.equal(s.store.getVm('builder').state, 'none');
  assert.ok(s.events.length > events0, 'a vm.updated event tells the UI');
});

test('bug 3: stopping a VM that is already stopped is also a plain no-op; a real stop says stopped:true', async () => {
  const s = await setup();
  await s.vm.health.ensure(); s.fb.requests.length = 0; // the first-use key probe is lazy (K1); do it up front so it does not mix into the calls counted below
  await s.vm.ensureRunning('zealot');
  const a = await s.vm.stop('zealot');
  assert.equal(a.stopped, true);
  assert.equal(a.vm.state, 'archived');
  const b = await s.vm.stop('zealot');
  assert.equal(b.stopped, false);
  assert.match(b.message, /already stopped/);
  assert.equal(s.fb.count('POST', /\/stop$/), 1);
  // the record says archived but boat.dev has it running (resumed from the dashboard): stop really stops it
  s.fb.sandboxes.get('bx_1')!.state = 'ready';
  const c = await s.vm.stop('zealot');
  assert.equal(c.stopped, true);
  assert.equal(s.fb.count('POST', /\/stop$/), 2);
});

// ---- 4. key permissions ---------------------------------------------------------------------------------------------------------
test('bug 4: resume refused for the key -> precise message (not "check billing"), remembered in health', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  await s.vm.stop('zealot');
  s.fb.forbidden.add('resume');
  await assert.rejects(s.vm.ensureRunning('zealot'), (e: any) => {
    assert.ok(e instanceof VmError);
    assert.match(e.message, /This boat\.dev API key cannot sandbox\.resume/);
    assert.match(e.message, /full-access key/);
    assert.doesNotMatch(e.message, /billing/i);
    return true;
  });
  assert.deepEqual(s.vm.health.view().forbidden.map((f) => f.action), ['sandbox.resume']);
  assert.match(s.store.getVm('zealot').error ?? '', /cannot sandbox\.resume/);
  // the user pastes a better key: the finding goes away once the action works
  s.fb.forbidden.clear();
  const rec = await s.vm.ensureRunning('zealot');
  assert.equal(rec.state, 'ready');
  assert.deepEqual(s.vm.health.view().forbidden, []);
});

test('bug 4: probing the key finds the refused actions without creating a sandbox, and Doctor says so', async () => {
  const s = await setup();
  s.fb.forbidden.add('resume');
  const view = await s.vm.health.probe();
  assert.equal(view.keyOk, true);
  assert.deepEqual(view.forbidden.map((f) => f.action), ['sandbox.resume']);
  assert.equal(view.probes.find((p) => p.op === 'resume')!.status, 'forbidden');
  assert.equal(view.probes.find((p) => p.op === 'stop')!.status, 'allowed');
  assert.equal(s.fb.count('POST', /^\/sandboxes$/), 0, 'the probe never creates a sandbox');
  assert.equal(s.fb.sandboxes.size, 0);
  const checks = await runDoctor({ config: s.config, getBoat: () => s.boat, health: s.vm.health, queryFn: (() => ({ accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined })) as unknown as QueryFn });
  const boat = checks.find((c) => c.id === 'boat')!;
  assert.equal(boat.ok, false);
  assert.match(boat.detail, /cannot do: sandbox\.resume/);
  assert.match(boat.fix ?? '', /full-access key/);
});

test('bug 4: Settings "test key" returns plain warnings for a key that lacks permissions or a Claude setup', async () => {
  const s = await setup();
  s.fb.forbidden.add('resume');
  s.fb.providerConfigured = false;
  s.fb.providerFirst = true;
  const svc = new SettingsService({ config: s.config, bus: s.bus, configPath: join(s.dir, 'config.json'), dataDir: s.dir, makeBoat: (o) => new BoatClient({ ...o, pollMs: 1 }) });
  const r = await svc.testBoat(KEY, s.fb.baseUrl);
  assert.equal(r.ok, true);
  assert.ok(r.warnings!.some((w) => /cannot sandbox\.resume.*full-access key/.test(w)), r.warnings!.join('|'));
  assert.ok(r.warnings!.some((w) => /Claude is not configured on boat\.dev/.test(w)));
  s.fb.forbidden.clear(); s.fb.providerConfigured = true;
  assert.equal((await svc.testBoat(KEY, s.fb.baseUrl)).warnings, undefined);
});

test('bug 4: a key change resets what was learned about the old key', async () => {
  const s = await setup();
  s.fb.forbidden.add('resume');
  await s.vm.health.probe();
  assert.equal(s.vm.health.view().forbidden.length, 1);
  s.vm.health.reset();
  const v = s.vm.health.view();
  assert.deepEqual([v.forbidden, v.checkedAt, v.keyOk], [[], null, null]);
});

// ---- 5. vm_claude when Claude is not configured on boat.dev ---------------------------------------------------------------
test('bug 5: vm_claude fails with an actionable message once, then is hidden and fails early (no VM started) until the TTL passes', async () => {
  const s = await setup();
  s.fb.providerConfigured = false;
  const t1 = s.tools('zealot');
  assert.ok(t1.names.includes('vm_claude'), 'offered while nothing is known');
  const r1 = await t1.call('vm_claude', { prompt: 'do it' });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /Claude is not configured on boat\.dev: open the Agents page/);
  assert.equal(s.vm.health.view().claude.state, 'not_configured');
  assert.equal(s.vm.claudeAvailable(), false);
  const t2 = s.tools('zealot');
  assert.ok(!t2.names.includes('vm_claude'), 'hidden while known-unconfigured');
  for (const n of ['vm_start', 'vm_exec', 'vm_stop', 'vm_usage', 'vm_desktop']) assert.ok(t2.names.includes(n), n);
  // discoverable through the message in vm_start and vm_usage
  assert.match(JSON.parse((await t2.call('vm_start')).text).notes.join(' '), /vm_claude is not offered right now\. Claude is not configured on boat\.dev/);
  assert.match(JSON.parse((await t2.call('vm_usage')).text).vm_claude, /Claude is not configured on boat\.dev/);
  // calling it anyway (e.g. through the manager) fails before touching boat.dev
  const promptsBefore = s.fb.count('POST', /\/prompt$/);
  await assert.rejects(s.vm.claude('zealot', 'x'), (e: any) => e instanceof VmError && e.code === 'claude_not_configured');
  assert.equal(s.fb.count('POST', /\/prompt$/), promptsBefore);
  // TTL passes (5 min): the tool is back; once Claude is configured it works and the finding is cleared
  s.clock.t += 6 * 60_000;
  s.fb.providerConfigured = true;
  assert.equal(s.vm.claudeAvailable(), true);
  assert.ok(s.tools('zealot').names.includes('vm_claude'));
  assert.equal(await s.vm.claude('zealot', 'x'), 'all done');
  assert.equal(s.vm.health.view().claude.state, 'configured');
});

test('bug 5: the probe notices an unconfigured Claude without starting anything (when boat.dev answers that before the lookup; otherwise it stays unknown)', async () => {
  const s = await setup();
  s.fb.providerConfigured = false;
  assert.equal((await s.vm.health.probe()).claude.state, 'unknown', 'a 404 for the impossible sandbox says nothing about Claude');
  s.fb.providerFirst = true;
  const v = await s.vm.health.probe();
  assert.equal(v.claude.state, 'not_configured');
  assert.match(v.claude.message ?? '', /Agents page/);
  assert.equal(s.fb.count('POST', /^\/sandboxes$/), 0);
  assert.equal(s.fb.sandboxes.size, 0);
});

test('bug 5: the Doctor lists Claude on boat.dev only while it is known to be unconfigured', async () => {
  const s = await setup();
  const q = (() => ({ accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined })) as unknown as QueryFn;
  assert.equal((await runDoctor({ config: s.config, getBoat: () => s.boat, health: s.vm.health, queryFn: q })).some((c) => c.id === 'boat-claude'), false);
  s.fb.providerConfigured = false;
  await assert.rejects(s.vm.claude('zealot', 'x'));
  const c = (await runDoctor({ config: s.config, getBoat: () => s.boat, health: s.vm.health, queryFn: q })).find((x) => x.id === 'boat-claude')!;
  assert.match(c.detail, /Claude is not configured on boat\.dev/);
  assert.match(c.fix ?? '', /Agents page/);
});

// ---- 6. usage ---------------------------------------------------------------------------------------------------------------------
test('bug 6: runtime and day totals follow a fake clock through start, exec, stop, restart', async () => {
  const s = await setup();
  const t = s.tools('zealot');
  const start = JSON.parse((await t.call('vm_start')).text);
  assert.equal(start.usage.running, true);
  assert.equal(start.usage.runtimeSeconds, 0);
  assert.match(start.usageSummary, /this run 0 s · today 0 s/);
  s.clock.t += 90_000;
  const exec = await t.call('vm_exec', { command: 'echo hi' });
  assert.match(exec.text, /--- vm usage ---\nthis run 1 min 30 s · today 1 min 30 s$/);
  s.clock.t += 30_000;
  const stop = JSON.parse((await t.call('vm_stop')).text);
  assert.equal(stop.stopped, true);
  assert.deepEqual([stop.usage.running, stop.usage.runtimeSeconds, stop.usage.todaySeconds], [false, 0, 120]);
  s.clock.t += 3600_000; // an hour stopped is not counted
  const usage = JSON.parse((await t.call('vm_usage')).text);
  assert.equal(usage.usage.todaySeconds, 120);
  assert.equal(usage.state, 'archived');
  await s.vm.ensureRunning('zealot');
  s.clock.t += 60_000;
  assert.equal(s.vm.usage('zealot').todaySeconds, 180);
  assert.equal(s.vm.usage('zealot').runtimeSeconds, 60);
});

test('bug 6: no price is ever invented: no rate means no estimate; a configured rate gives a labelled estimate', async () => {
  const none = await setup();
  await none.vm.ensureRunning('zealot');
  none.clock.t += 3600_000;
  assert.equal(none.vm.usage('zealot').estimate, undefined);
  assert.doesNotMatch((await none.tools('zealot').call('vm_usage')).text, /estimate"/);
  const priced = await setup({ rates: { default: 0.6 }, currency: 'DKK' });
  await priced.vm.ensureRunning('zealot');
  priced.clock.t += 1800_000;
  const u = JSON.parse((await priced.tools('zealot').call('vm_usage')).text).usage;
  assert.equal(u.estimate.amount, 0.3);
  assert.equal(u.estimate.currency, 'DKK');
  assert.match(u.estimate.basis, /^estimate: /);
  assert.equal(priced.vm.health.view().currency, 'DKK');
  // a rate for another size does not price this VM
  const other = await setup({ rates: { large: 9 } });
  await other.vm.ensureRunning('zealot');
  other.clock.t += 3600_000;
  assert.equal(other.vm.usage('zealot').estimate, undefined);
});

test('bug 6: vm_usage is read-only: it never starts a VM or calls boat.dev', async () => {
  const s = await setup();
  const r = await s.tools('builder').call('vm_usage');
  assert.equal(r.isError, false);
  assert.equal(s.fb.requests.length, 0);
  assert.equal(JSON.parse(r.text).state, 'none');
});

test('bug 6: a VM that boat.dev stopped while Legion was closed is closed at last use + TTL, not at "now"', async () => {
  const s = await setup();
  await s.vm.ensureRunning('zealot');
  s.clock.t += 5 * 3600_000; // Legion was closed for 5 hours; boat's TTL (15 min idle + 15 min safety) stopped it
  s.fb.sandboxes.get('bx_1')!.state = 'archived';
  await s.vm.refreshAll();
  assert.equal(s.store.getVm('zealot').state, 'archived');
  assert.equal(s.vm.usage('zealot').todaySeconds, 30 * 60);
});

// ---- secrets ----------------------------------------------------------------------------------------------------------------------
test('no API key in tool output, records, events, health or Doctor, even when boat.dev echoes it back', async () => {
  const s = await setup();
  s.fb.echoKey = true;
  s.fb.forbidden.add('create');
  const t = s.tools('zealot');
  const out = [(await t.call('vm_start')).text, (await t.call('vm_exec', { command: 'x' })).text, (await t.call('vm_stop')).text, (await t.call('vm_usage')).text];
  s.fb.forbidden.clear();
  s.fb.forbidden.add('resume');
  await s.vm.ensureRunning('zealot');
  await s.vm.stop('zealot');
  out.push((await t.call('vm_start')).text);
  await s.vm.health.probe();
  s.fb.providerConfigured = false;
  s.fb.forbidden.clear();
  out.push((await t.call('vm_claude', { prompt: 'x' })).text);
  const checks = await runDoctor({ config: s.config, getBoat: () => s.boat, health: s.vm.health, queryFn: (() => ({ accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined })) as unknown as QueryFn });
  const blob = JSON.stringify({ out, records: s.store.listVms(), events: s.events, health: s.vm.health.view(), checks });
  assert.ok(!blob.includes(KEY), 'the key must not appear anywhere');
  assert.ok(blob.includes('***'), 'the echoed key was scrubbed, not just absent');
});

test('BoatHealth only learns from boat errors it understands', () => {
  const bus = new EventBus();
  const evs: LegionEvent[] = [];
  bus.on((e) => evs.push(e));
  const h = new BoatHealth({ getBoat: () => null, bus });
  assert.equal(h.note(new Error('x')), false);
  assert.equal(h.view().configured, false);
  assert.equal(evs.length, 0);
});
