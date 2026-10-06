/**
 * Mainnet ships OFF (plan 12.1, controls C25, C27, C33 and C35): the switch defaults to false and every way of loading a policy that Legion
 * did not write leaves it false; only the native-confirmed route turns it on; turning it off needs no dialog and works whatever else is going on;
 * every automatic switch-off is saved. The wallet is always a fake transport and nothing here opens a socket to a wallet.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate, isClientRoute, NATIVE_HEADER, safeEqual } from '../src/core/admin.js';
import { HttpError } from '../src/core/server.js';
import { ASSAYER_ID, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { AuditLog, auditPath } from '../src/core/bsv/audit.js';
import { MAINNET_ROUTE, registerMainnetRoutes } from '../src/core/bsv/mainnet-routes.js';
import { NET } from '../src/core/bsv/networks.js';
import { PolicyEngine, sanitizePolicyConfig } from '../src/core/bsv/policy.js';
import { loadPolicyConfig, policyPath, savePolicyConfig, sha256, untrustedConfig } from '../src/core/bsv/policy-store.js';
import { MAINNET_WARNING, WalletProbeError } from '../src/core/bsv/wallet-probe.js';
import type { Transport } from '../src/core/bsv/wallet-probe.js';
import { AUTH, asClient, makeFakes, mkAgent, start } from './helpers-c.js';
import { approveInput, MAIN_A, MAIN_B, req, TEST_A } from './bsv-net-helpers.js';

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

// ------------------------------------------------------------------ a real module over a temp data dir (the file-tamper story)

const wallet: Transport = async (r) => { if (r.path === '/never') throw new WalletProbeError('refused'); return { status: 200, body: JSON.stringify({ network: 'testnet', version: '1.0.0', authenticated: true, height: 1 }) }; };

function module_(o: { dataDir?: string } = {}) {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = o.dataDir ?? cleanupTemp('legion-mdef-');
  (f.ctx.config as any).bsv = { enabled: true, network: 'testnet' };
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => state.enabled };
  const bsv = createBsvModule(deps, { state, nativeSecret: NATIVE, transport: wallet, probeMinIntervalMs: 0 });
  const routes = new Map<string, (c: unknown) => unknown>();
  bsv.routes!((m, p, h) => { routes.set(`${m} ${p}`, h as never); });
  const call = async (m: string, p: string, body?: unknown, native = true) => (routes.get(`${m} ${p}`)!({ req: { headers: native ? { [NATIVE_HEADER]: NATIVE } : {} }, body }));
  return { bsv, dataDir, call };
}
const lines = (d: string) => readFileSync(auditPath(d), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evidence = (d: string) => readdirSync(join(d, 'bsv')).filter((x) => x.startsWith('policy.json.tampered-'));

test('C25: a fresh install has mainnet OFF; the engine says mainnet-disabled; arming is refused; the view shows the switch and both networks', async () => {
  const m = module_();
  assert.equal(m.bsv.policy.mainnetEnabled, false);
  assert.equal(m.bsv.policy.isFrozen, false, 'a fresh install is not frozen');
  assert.equal(existsSync(policyPath(m.dataDir)), false, 'nothing was written yet');
  const view: any = await m.call('GET', '/api/bsv/policy');
  assert.equal(view.mainnetEnabled, false);
  assert.deepEqual(Object.keys(view.nets).sort(), ['main', 'test']);
  assert.deepEqual(view.nets.main.caps, { ...NET.main.defaultCaps }); assert.deepEqual(view.nets.main.allowlist, []); assert.deepEqual(view.nets.test.caps, { ...NET.test.defaultCaps });
  assert.deepEqual(view.caps, view.nets.test.caps, 'the older fields still read the testnet limits');
  const d = m.bsv.policy.evaluate(req({ network: 'main' }));
  assert.equal(d.verdict, 'deny'); assert.ok(d.codes.includes('mainnet-disabled')); assert.equal(d.codes.includes('not-armed'), false, 'switch off is reported as off, not as not-armed');
  await assert.rejects(async () => m.call('POST', '/api/bsv/policy/arm', { minutes: 5 }), (e: unknown) => e instanceof HttpError && e.status === 409 && /switched off/.test(e.message));
  assert.equal(m.bsv.policy.isArmed(), false);
});

test('C25: the default is false on every path that does not read an explicit true from a file Legion wrote', () => {
  assert.equal(new PolicyEngine().mainnetEnabled, false);
  assert.equal(new PolicyEngine().config().mainnetEnabled, false);
  assert.equal(new PolicyEngine().snapshot().mainnetEnabled, false);
  for (const raw of [undefined, null, {}, [], 'on', 1, { mainnetEnabled: 'true' }, { mainnetEnabled: 1 }, { mainnetEnabled: {} }, { mainnetEnabled: [true] }, { mainnet: true }, { nets: { main: { enabled: true } } }]) assert.equal(sanitizePolicyConfig(raw).mainnetEnabled, false, JSON.stringify(raw));
  assert.equal(sanitizePolicyConfig({ nets: {}, mainnetEnabled: true }).mainnetEnabled, true, 'only the exact boolean, in a file of the current shape');
  assert.equal(sanitizePolicyConfig({ mainnetEnabled: true }).mainnetEnabled, false, 'B7: a legacy-shaped file (no nets) never loads mainnet on');
  assert.equal(sanitizePolicyConfig({ caps: {}, allowlist: [], mainnetEnabled: true, frozen: null }).mainnetEnabled, false, 'B7: whatever else the legacy shape holds'); 
  const u = untrustedConfig('why');
  assert.equal(u.mainnetEnabled, false); assert.equal(u.frozen?.reason, 'why');
  assert.deepEqual(u.nets.main, { caps: { ...NET.main.defaultCaps }, allowlist: [] }); assert.deepEqual(u.nets.test, { caps: { ...NET.test.defaultCaps }, allowlist: [] });
  const dir = cleanupTemp('legion-mdef-'); const f = join(dir, 'policy.json');
  assert.equal(loadPolicyConfig(f).config.mainnetEnabled, false, 'no file');
  writeFileSync(f, '{ not json'); assert.equal(loadPolicyConfig(f).config.mainnetEnabled, false); assert.equal(loadPolicyConfig(f).config.frozen !== null, true, 'unreadable: frozen');
});

test('C25: a policy file that says mainnetEnabled:true but is not the one Legion wrote (hand-edited, replaced, or with no record) loads OFF and frozen, and is kept as evidence', async () => {
  // (1) Legion's own file, then a hand edit that flips the switch
  const a = module_();
  await a.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  const mine = JSON.parse(readFileSync(policyPath(a.dataDir), 'utf8'));
  assert.equal(mine.mainnetEnabled, false); assert.equal(mine.version, 2);
  writeFileSync(policyPath(a.dataDir), JSON.stringify({ ...mine, mainnetEnabled: true }, null, 2));
  const a2 = module_({ dataDir: a.dataDir });
  assert.equal(a2.bsv.policy.isFrozen, true); assert.equal(a2.bsv.policy.mainnetEnabled, false);
  assert.match(a2.bsv.policy.config().frozen!.reason, /changed outside Legion/);
  assert.equal(a2.bsv.policy.config().nets.test.caps.perTxSats, 1000, 'the owner\'s earlier limits are not used either: they set them again');
  assert.equal(evidence(a.dataDir).length, 1);
  assert.equal(JSON.parse(readFileSync(join(a.dataDir, 'bsv', evidence(a.dataDir)[0]!), 'utf8')).mainnetEnabled, true, 'the edited file is kept as it was');
  assert.ok(lines(a.dataDir).some((e) => e.tool === 'policy' && e.decision === 'file-tampered'));
  assert.equal(JSON.parse(readFileSync(policyPath(a.dataDir), 'utf8')).mainnetEnabled, false, 'what is on disk now is Legion\'s own: off');
  // (2) a file created by hand on a fresh install: no record of it
  const dir = cleanupTemp('legion-mdef-'); mkdirSync(join(dir, 'bsv'), { recursive: true });
  writeFileSync(policyPath(dir), JSON.stringify({ version: 2, nets: { test: { caps: {}, allowlist: [] }, main: { caps: {}, allowlist: [MAIN_A] } }, mainnetEnabled: true, frozen: null }));
  const b = module_({ dataDir: dir });
  assert.equal(b.bsv.policy.isFrozen, true); assert.equal(b.bsv.policy.mainnetEnabled, false);
  assert.match(b.bsv.policy.config().frozen!.reason, /no record of being written by Legion/);
  assert.deepEqual(b.bsv.policy.config().nets.main.allowlist, [], 'its mainnet allowlist is not used');
  // (3) changed while running: the next read freezes, and Legion's own copy (switch off) is written back
  const c = module_();
  await c.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  writeFileSync(policyPath(c.dataDir), JSON.stringify({ ...JSON.parse(readFileSync(policyPath(c.dataDir), 'utf8')), mainnetEnabled: true }));
  const v: any = await c.call('GET', '/api/bsv/policy');
  assert.equal(v.frozen !== null, true); assert.equal(v.mainnetEnabled, false); assert.equal(c.bsv.policy.mainnetEnabled, false);
  assert.equal(JSON.parse(readFileSync(policyPath(c.dataDir), 'utf8')).mainnetEnabled, false);
});

test('migration through the module: a policy file written by the earlier (testnet-only) Legion, with its hash in the audit log, loads as testnet limits, mainnet off, not frozen', () => {
  const dir = cleanupTemp('legion-mdef-'); mkdirSync(join(dir, 'bsv'), { recursive: true });
  const old = JSON.stringify({ caps: { perTxSats: 800, perSessionSats: 3000, per24hSats: 6000, maxOutputs: 2, maxFeeSats: 150 }, allowlist: [TEST_A], frozen: null }, null, 2);
  writeFileSync(policyPath(dir), old);
  const log = new AuditLog(auditPath(dir)); log.open();
  log.append({ agent: 'legion', tool: 'policy', decision: 'saved', fields: { policyHash: sha256(old) } });
  const m = module_({ dataDir: dir });
  assert.equal(m.bsv.policy.isFrozen, false, 'the old file matches the hash Legion recorded: no tamper alarm');
  assert.equal(m.bsv.policy.config().nets.test.caps.perTxSats, 800); assert.deepEqual(m.bsv.policy.config().nets.test.allowlist, [TEST_A]);
  assert.equal(m.bsv.policy.mainnetEnabled, false); assert.deepEqual(m.bsv.policy.config().nets.main.caps, { ...NET.main.defaultCaps });
  assert.equal(readFileSync(policyPath(dir), 'utf8'), old, 'loading does not rewrite it');
});

// ------------------------------------------------------------------ the route (a real HTTP server with the real gate)

interface Rig { call: (body?: unknown, h?: Record<string, string>) => Promise<{ status: number; body: any }>; policy: PolicyEngine; file: string; notes: Array<[string, string, string, string?]>; flags: { bsv: boolean; save: boolean; checks: number } }
async function rig(o: { on?: boolean; frozen?: boolean; unknown?: Array<{ requestId: string; agentId: string; totalSats: number; net?: unknown }>; fileOn?: boolean } = {}): Promise<Rig> {
  const f = makeFakes();
  const dir = cleanupTemp('legion-mroute-'); const file = join(dir, 'policy.json');
  const policy = new PolicyEngine({ config: { nets: { test: { caps: { ...NET.test.defaultCaps }, allowlist: [] }, main: { caps: { ...NET.main.defaultCaps }, allowlist: [MAIN_A, MAIN_B] } }, frozen: null, mainnetEnabled: !!o.on }, ...(o.unknown ? { unknown: o.unknown } : {}) });
  if (o.fileOn) savePolicyConfig(file, { ...policy.config(), mainnetEnabled: true }); // a file that says on while memory may say off
  if (o.frozen) policy.freeze('test');
  const notes: Rig['notes'] = []; const flags = { bsv: true, save: true, checks: 0 };
  registerRoutesIntoCtx(f.ctx, policy, file, notes, flags);
  const srv = await start(f.ctx);
  closers.push(() => srv.close());
  const call = async (body?: unknown, h: Record<string, string> = { ...AUTH, 'X-Legion-Native': NATIVE }) => {
    const r = await fetch(srv.base + MAINNET_ROUTE, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : undefined };
  };
  return { call, policy, file, notes, flags };
}
function registerRoutesIntoCtx(ctx: any, policy: PolicyEngine, file: string, notes: Rig['notes'], flags: Rig['flags']): void {
  ctx.modules = [{
    id: 'mainnet-route-test',
    routes: (add: any) => registerMainnetRoutes(add, {
      policy,
      requireNative: (r) => {
        const g = r?.headers?.[NATIVE_HEADER];
        if (typeof g !== 'string' || !safeEqual(g, NATIVE)) throw new HttpError(403, 'native_confirmation_required');
      },
      checkPolicyFile: () => { flags.checks++; },
      persist: (cfg) => { if (!flags.save) return false; savePolicyConfig(file, cfg ?? policy.config()); return true; },
      note: (agent, tool, decision, reason) => { notes.push([agent, tool, decision, reason]); },
      bsvEnabled: () => flags.bsv,
      view: () => policy.snapshot(),
    }),
  }];
}
const saved = (r: Rig) => JSON.parse(readFileSync(r.file, 'utf8'));

test('C27: the switch route is admin-only (default-deny, not on the MCP client list): the bearer token alone gets 403 and nothing changes', async () => {
  assert.equal(isClientRoute('POST', MAINNET_ROUTE), false);
  assert.deepEqual(gate({ method: 'POST', path: MAINNET_ROUTE, adminOk: false, bearerOk: true, hasSecret: true }), { allow: false, status: 403, error: 'admin_required' });
  assert.equal(gate({ method: 'POST', path: MAINNET_ROUTE, adminOk: false, bearerOk: false, hasSecret: true }).allow, false);
  const r = await rig();
  for (const body of [{ enabled: true }, { enabled: false }]) {
    const t = await r.call(body, { ...asClient, 'X-Legion-Native': NATIVE });
    assert.equal(t.status, 403, JSON.stringify(body));
  }
  assert.equal(r.policy.mainnetEnabled, false); assert.equal(existsSync(r.file), false); assert.deepEqual(r.notes, []);
  const on = await rig({ on: true });
  assert.equal((await on.call({ enabled: false }, { ...asClient })).status, 403, 'not even the safe direction for a bearer token');
  assert.equal(on.policy.mainnetEnabled, true);
});

test('C27: ENABLE needs the native secret: admin alone, a guessed secret or the admin secret as native all get 403 and the switch stays off', async () => {
  const r = await rig();
  assert.equal((await r.call({ enabled: true }, { ...AUTH })).status, 403, 'admin only');
  assert.equal((await r.call({ enabled: true }, { ...AUTH, 'X-Legion-Native': 'f'.repeat(40) })).status, 403, 'guessed');
  assert.equal((await r.call({ enabled: true }, { ...AUTH, 'X-Legion-Native': AUTH['X-Legion-Admin']! })).status, 403, 'the admin secret is not the native secret');
  assert.equal(r.policy.mainnetEnabled, false); assert.equal(existsSync(r.file), false);
});

test('C27: with the native secret, enable saves first, then turns the switch on, logs it as the owner, and does not arm; a second enable changes nothing', async () => {
  const r = await rig();
  const ok = await r.call({ enabled: true });
  assert.equal(ok.status, 200); assert.equal(ok.body.mainnetEnabled, true); assert.equal(ok.body.armed, false);
  assert.equal(r.policy.mainnetEnabled, true); assert.equal(r.policy.isArmed(), false);
  assert.equal(saved(r).mainnetEnabled, true); assert.equal(saved(r).version, 2);
  assert.deepEqual(r.notes.map((n) => n.slice(0, 3)), [['owner', 'policy', 'mainnet-on']]);
  assert.ok(r.flags.checks >= 1, 'the policy file is checked before anything changes');
  assert.equal((await r.call({ enabled: true })).status, 200);
  assert.equal(r.notes.length, 1, 'no duplicate line');
});

test('C27: enable is refused while BSV mode is off or the chain is frozen (409), when the body is not exactly {enabled:boolean} (400), and when the file cannot be saved (500: the switch stays off)', async () => {
  const r = await rig(); r.flags.bsv = false;
  assert.equal((await r.call({ enabled: true })).status, 409); assert.equal(r.policy.mainnetEnabled, false);
  r.flags.bsv = true;
  for (const bad of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enabled: true, extra: 1 }, { enabled: true, network: 'main' }, [true], 'true', null]) assert.equal((await r.call(bad)).status, 400, JSON.stringify(bad));
  r.flags.save = false;
  assert.equal((await r.call({ enabled: true })).status, 500); assert.equal(r.policy.mainnetEnabled, false, 'saved first: a failed save leaves it off');
  r.flags.save = true;
  const fz = await rig({ frozen: true });
  assert.equal((await fz.call({ enabled: true })).status, 409); assert.equal(fz.policy.mainnetEnabled, false);
});

test('C27: DISABLE needs no dialog and no native secret, works while frozen or with BSV mode off, disarms, saves, and says whether it saved', async () => {
  const r = await rig({ on: true });
  r.policy.arm(15);
  const off = await r.call({ enabled: false }, { ...AUTH });
  assert.equal(off.status, 200); assert.equal(off.body.mainnetEnabled, false); assert.equal(off.body.armed, false); assert.equal(off.body.persisted, true);
  assert.equal(r.policy.isArmed(), false); assert.equal(saved(r).mainnetEnabled, false);
  assert.deepEqual(r.notes.map((n) => n.slice(0, 3)), [['owner', 'policy', 'mainnet-off']]);
  const again = await r.call({ enabled: false }, { ...AUTH });
  assert.equal(again.status, 200, 'idempotent'); assert.equal(again.body.persisted, true, 'B5: a repeated Disable writes the file again and reports that result');
  assert.equal(r.notes.filter((n) => n[2] === 'mainnet-off').length, 2, 'and logs it');
  const fz = await rig({ on: true, frozen: true }); fz.flags.bsv = false;
  assert.equal((await fz.call({ enabled: false }, { ...AUTH })).status, 200); assert.equal(fz.policy.mainnetEnabled, false);
  assert.equal(saved(fz).mainnetEnabled, false);
  // a save that fails: still off in memory, the response says so, and the chain freezes (the file may still say on)
  const s = await rig({ on: true }); s.flags.save = false;
  const bad = await s.call({ enabled: false }, { ...AUTH });
  assert.equal(bad.status, 200); assert.equal(bad.body.persisted, false); assert.equal(s.policy.mainnetEnabled, false); assert.equal(s.policy.isFrozen, true);
});

test('C33: every automatic switch-off (unknown outcome, mismatch) is saved to the policy file and logged by Legion, so a restart cannot bring it back on', async () => {
  for (const how of ['unknown', 'mismatch', 'freeze'] as const) {
    const r = await rig();
    await r.call({ enabled: true });
    assert.equal(saved(r).mainnetEnabled, true);
    r.policy.arm(5);
    const d = r.policy.evaluate(req({ network: 'main' })); r.policy.approve(d.requestId, approveInput(d.card!, 'main'));
    if (how === 'unknown') r.policy.settle(d.requestId, { kind: 'unknown' });
    else if (how === 'mismatch') r.policy.settle(d.requestId, { kind: 'executed', sats: 1 });
    else r.policy.freeze('x');
    assert.equal(r.policy.mainnetEnabled, false, how);
    assert.equal(saved(r).mainnetEnabled, false, `${how}: the file says off`);
    assert.equal(new PolicyEngine({ config: loadPolicyConfig(r.file).config }).mainnetEnabled, false);
    assert.deepEqual(r.notes.map((n) => n.slice(0, 3)).filter((n) => n[2] === 'mainnet-off'), [['legion', 'policy', 'mainnet-off']], how);
  }
});

test('C33: a switch-off that cannot be saved freezes the chain instead of leaving the file saying "on"', async () => {
  const r = await rig({ on: true }); r.flags.save = false;
  r.policy.mainnetOff('a mainnet spend has an unknown outcome');
  assert.equal(r.policy.mainnetEnabled, false); assert.equal(r.policy.isFrozen, true);
  assert.match(r.policy.config().frozen!.reason, /could not be saved/);
});

// ------------------------------------------------------------------ C35: ships off, and the words say so without overclaiming

test('C35: the sentences Legion shows about mainnet say it is OFF until the owner turns it on, scope the claim to Legion\'s own code, and never say it refuses mainnet or is testnet only', () => {
  assert.match(MAINNET_WARNING, /needs the mainnet switch \(off by default\)/);
  assert.match(MAINNET_WARNING, /whether the wallet asks too depends on the wallet/);
  const dir = join(process.cwd(), 'src', 'core', 'bsv');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const t = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(t, /testnet only|only testnet|refuses mainnet|never spends on mainnet|risk-free|cannot lose|production-ready|safe on mainnet/i, f);
  }
  // the default table the words rest on
  assert.equal(new PolicyEngine().snapshot().mainnetEnabled, false);
  assert.deepEqual({ ...NET.main.defaultCaps }, { perTxSats: 1000, perSessionSats: 2000, per24hSats: 5000, maxOutputs: 1, maxFeeSats: 100 });
});

test('C27d: enable while the chain is frozen is refused AND the file is not written with the switch on (the check comes before the save)', async () => {
  const r = await rig({ frozen: true });
  const on = await r.call({ enabled: true });
  assert.equal(on.status, 409);
  assert.equal(existsSync(r.file), false, 'nothing was saved');
  assert.equal(r.policy.mainnetEnabled, false);
  // the same with BSV mode off
  const b = await rig(); b.flags.bsv = false;
  assert.equal((await b.call({ enabled: true })).status, 409); assert.equal(existsSync(b.file), false);
});

test('C27h: DISABLE runs the policy-file check first (a tampered file is noticed on the safe path too); so does enable', async () => {
  const r = await rig({ on: true });
  await r.call({ enabled: false }, { ...AUTH });
  assert.equal(r.flags.checks, 1, 'disable');
  const e = await rig(); await e.call({ enabled: true });
  assert.equal(e.flags.checks, 1, 'enable');
  const bad = await rig({ on: true }); await bad.call('nope' as never, { ...AUTH });
  assert.equal(bad.flags.checks, 0, 'a refused body changes nothing and checks nothing');
});

test('B5: Disable always writes the file and reports that result, even when memory already says off but the file still says on', async () => {
  const r = await rig({ fileOn: true });
  assert.equal(r.policy.mainnetEnabled, false); assert.equal(saved(r).mainnetEnabled, true, 'precondition: the file says on');
  const off = await r.call({ enabled: false }, { ...AUTH });
  assert.equal(off.status, 200); assert.equal(off.body.persisted, true);
  assert.equal(saved(r).mainnetEnabled, false, 'the file was repaired');
  assert.equal(r.notes.filter((n) => n[2] === 'mainnet-off').length, 1);
  // and when that save fails the answer says false (not a stale true) and the chain freezes
  const f = await rig({ fileOn: true }); f.flags.save = false;
  const bad = await f.call({ enabled: false }, { ...AUTH });
  assert.equal(bad.body.persisted, false); assert.equal(f.policy.isFrozen, true);
});

test('B5: a restart seed that switched mainnet off (an earlier mainnet spend had no outcome) is saved and logged once the route registers its hook', async () => {
  const r = await rig({ on: true, unknown: [{ requestId: 'seed-main-0001', agentId: 'assayer', totalSats: 620, net: 'main' }] });
  assert.equal(r.policy.mainnetEnabled, false);
  assert.equal(saved(r).mainnetEnabled, false, 'the file says off');
  assert.deepEqual(r.notes.map((n) => n.slice(0, 3)), [['legion', 'policy', 'mainnet-off']]);
  assert.match(String(r.notes[0]![3]), /no known outcome/);
});
