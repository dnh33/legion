/**
 * BSV module wiring for the wallet probe, the policy routes, the audit log and the bsv_status tool.
 * The wallet is a fake transport (never the real wallet port). Policy changes need the admin secret AND the native secret.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { ASSAYER_ID, BSV_PREAMBLE, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { taintsRun } from '../src/core/engine.js';
import { needsApproval } from '../src/core/approvals.js';
import { WalletProbeError } from '../src/core/bsv/wallet-probe.js';
import type { Transport, WireRequest } from '../src/core/bsv/wallet-probe.js';
import { TESTNET_DEFAULT_CAPS, TESTNET_HARD_CAPS } from '../src/core/bsv/policy.js';
import { AUTH, asClient, makeFakes, mkAgent, start } from './helpers-c.js';
import { mkAddr } from './bsv-net-helpers.js';

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

interface Wallet { net: string; calls: WireRequest[]; fail?: boolean }
const fakeWallet = (net = 'testnet'): { w: Wallet; transport: Transport } => {
  const w: Wallet = { net, calls: [] };
  const transport: Transport = async (r) => {
    w.calls.push(r);
    if (w.fail) throw new WalletProbeError('refused');
    const m = r.path.slice(1);
    const body = m === 'getVersion' ? { version: 'fake-1.0.0' } : m === 'getNetwork' ? { network: w.net } : m === 'isAuthenticated' ? { authenticated: true } : { height: 4321 };
    return { status: 200, body: JSON.stringify(body) };
  };
  return { w, transport };
};

async function setup(o: { dataDir?: string; on?: boolean; native?: string | null; net?: string } = {}) {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'legion-bsvw-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port: 4747, authToken: 'on-disk-token', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {}, bsv: { enabled: !!o.on, network: 'testnet' } }, null, 2));
  const cfg = f.ctx.config as any; cfg.bsv = { enabled: !!o.on, network: 'testnet' };
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const bsvEnabled = () => state.enabled;
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled };
  const wal = fakeWallet(o.net);
  const bsv = createBsvModule(deps, { state, nativeSecret: o.native === null ? undefined : o.native ?? NATIVE, transport: wal.transport, probeMinIntervalMs: 0 });
  f.ctx.modules = [bsv];
  f.ctx.bsvEnabled = bsvEnabled;
  const srv = await start(f.ctx);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { ...AUTH, 'X-Legion-Native': NATIVE }) => {
    const r = await fetch(srv.base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : undefined };
  };
  const adminOnly = { ...AUTH }; // admin secret but no native proof
  closers.push(() => srv.close());
  return { ...f, state, bsv, dataDir, srv, wal, call, adminOnly };
}

/** The owner's Connect (the window asks main, main asks the core with the native secret). The wallet is the fake transport: no socket is ever opened. */
const WALLET_URL = 'http://127.0.0.1:45001';
const connectWallet = (s: Awaited<ReturnType<typeof setup>>, url: string = WALLET_URL) => s.call('POST', '/api/bsv/wallet/connect', { url });
const policyFile = (d: string) => join(d, 'bsv', 'policy.json');
const auditLines = (d: string) => readFileSync(join(d, 'bsv', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- who can reach what

test('gate: a bearer token alone (the MCP-client class) reaches none of the BSV wallet, policy or audit routes, not even with the native header; the one exception is Freeze, which only makes things safer', async () => {
  const s = await setup({ on: true });
  for (const [m, p, b] of [['GET', '/api/bsv/wallet'], ['GET', '/api/bsv/policy'], ['GET', '/api/bsv/audit'], ['POST', '/api/bsv/policy/arm', { minutes: 5 }], ['POST', '/api/bsv/policy/unfreeze', {}], ['POST', '/api/bsv/policy/caps', { perTxSats: 5 }], ['POST', '/api/bsv/policy/allowlist', { list: [] }], ['POST', '/api/bsv/policy/disarm', {}], ['POST', '/api/bsv/wallet/connect', { url: WALLET_URL }], ['POST', '/api/bsv/wallet/disconnect', {}]] as Array<[string, string, unknown?]>) {
    for (const headers of [{ ...asClient }, { ...asClient, 'X-Legion-Native': NATIVE }]) {
      const r = await s.call(m, p, b, headers);
      assert.equal(r.status, 403, `${m} ${p}`);
    }
  }
  assert.equal(s.wal.w.calls.length, 0, 'the wallet was never contacted');
  assert.equal(s.bsv.policy.isArmed(), false);
  assert.equal(s.bsv.policy.isFrozen, false);
  // Freeze is open to the bearer token (a core with no app window can still be stopped) and changes nothing but "stopped"
  const fr = await s.call('POST', '/api/bsv/policy/freeze', {}, { ...asClient });
  assert.equal(fr.status, 200);
  assert.equal(s.bsv.policy.isFrozen, true);
  assert.equal(s.wal.w.calls.length, 0);
});

test('native: with the admin secret but WITHOUT the native secret every policy change is refused and changes nothing (a compromised window cannot arm)', async () => {
  const s = await setup({ on: true });
  for (const [p, b] of [['/api/bsv/policy/arm', { minutes: 5 }], ['/api/bsv/policy/disarm', {}], ['/api/bsv/policy/unfreeze', {}], ['/api/bsv/policy/caps', { perTxSats: 5 }], ['/api/bsv/policy/allowlist', { list: ['abc-address-1'] }], ['/api/bsv/wallet/connect', { url: WALLET_URL }]] as Array<[string, unknown]>) {
    const none = await s.call('POST', p, b, s.adminOnly);
    assert.equal(none.status, 403, p);
    assert.match(none.body.error, /native_confirmation_required/);
    const wrong = await s.call('POST', p, b, { ...AUTH, 'X-Legion-Native': NATIVE.slice(0, -1) + 'X' });
    assert.equal(wrong.status, 403, p);
    const short = await s.call('POST', p, b, { ...AUTH, 'X-Legion-Native': 'x' });
    assert.equal(short.status, 403, p);
  }
  assert.equal(s.bsv.policy.isArmed(), false);
  assert.equal(s.bsv.policy.isFrozen, false);
  assert.deepEqual(s.bsv.policy.config().caps, TESTNET_DEFAULT_CAPS);
  assert.deepEqual(s.bsv.policy.config().allowlist, []);
  assert.ok(!existsSync(policyFile(s.dataDir)), 'nothing was saved');
  assert.equal(s.wal.w.calls.length, 0, 'and no wallet was contacted');
  // Freeze needs no native proof: it only stops things (admin secret alone is enough from the window)
  assert.equal((await s.call('POST', '/api/bsv/policy/freeze', {}, s.adminOnly)).status, 200);
  assert.equal(s.bsv.policy.isFrozen, true);
});

test('native: a core that was not started by the app (no native secret) refuses every policy change, even with the right-looking header', async () => {
  const s = await setup({ on: true, native: null });
  const r = await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 }, { ...AUTH, 'X-Legion-Native': NATIVE });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /native_unavailable/);
  assert.equal((await s.call('GET', '/api/bsv/policy')).body.nativeAvailable, false);
  assert.equal((await s.call('POST', '/api/bsv/wallet/connect', { url: WALLET_URL }, { ...AUTH, 'X-Legion-Native': NATIVE })).status, 403);
  assert.equal(s.wal.w.calls.length, 0);
  // freeze works on a core the app did not start (headless): it needs no native proof
  assert.equal((await s.call('POST', '/api/bsv/policy/freeze', {}, { ...AUTH, 'X-Legion-Native': '' })).status, 200);
  assert.equal(s.bsv.policy.isFrozen, true);
});

// ---------------------------------------------------------------- the wallet route

test('wallet: nothing is contacted while BSV mode is off, nor when it is on until Connect; then one probe asks exactly the four allowlisted methods', async () => {
  const s = await setup({ on: false });
  const off = await s.call('GET', '/api/bsv/wallet');
  assert.equal(off.status, 200);
  assert.equal(off.body.probed, false);
  assert.equal(off.body.condition, 'off');
  assert.equal(s.wal.w.calls.length, 0);
  assert.equal((await connectWallet(s)).status, 409, 'BSV mode off: Connect is refused');
  assert.equal((await s.call('POST', '/api/bsv', { enabled: true })).status, 200);
  // on, but nobody pressed Connect and no address is set: no contact at all, however often it is asked
  for (let i = 0; i < 3; i++) { const idle = await s.call('GET', '/api/bsv/wallet'); assert.equal(idle.body.condition, 'not-configured'); assert.equal(idle.body.probed, false); assert.equal(idle.body.connected, false); }
  assert.equal(s.wal.w.calls.length, 0);
  const on = await connectWallet(s);
  assert.equal(on.status, 200);
  assert.equal(on.body.connected, true);
  assert.equal(on.body.reachable, true);
  assert.equal(on.body.network, 'test');
  assert.equal(on.body.condition, 'testnet');
  assert.equal(on.body.height, 4321);
  assert.equal(on.body.legionNetwork, 'testnet');
  assert.deepEqual(s.wal.w.calls.map((c) => c.path), ['/getVersion', '/getNetwork', '/isAuthenticated', '/getHeight']);
  assert.equal((await s.call('GET', '/api/bsv/wallet?cached=1')).body.network, 'test');
  assert.equal(s.wal.w.calls.length, 4, 'cached=1 never contacts the wallet');
  assert.equal(s.state.walletUrl, WALLET_URL, 'the address the owner typed is kept');
  await s.call('POST', '/api/bsv', { enabled: false });
  assert.equal((await s.call('GET', '/api/bsv/wallet')).body.probed, false);
  assert.equal(s.wal.w.calls.length, 4);
  // turning the mode back on starts DISCONNECTED: the address is remembered, the contact is not
  await s.call('POST', '/api/bsv', { enabled: true });
  const again = await s.call('GET', '/api/bsv/wallet');
  assert.equal(again.body.condition, 'not-connected');
  assert.equal(again.body.connected, false);
  assert.equal(s.wal.w.calls.length, 4);
});

test('wallet: a wallet on the main network is a warning; the audit log gets one line for the change, not one per poll', async () => {
  const s = await setup({ on: true, net: 'mainnet' });
  const r = await connectWallet(s);
  assert.equal(r.body.network, 'main');
  assert.equal(r.body.condition, 'mainnet-warning');
  assert.equal(r.body.message, "The wallet says it is on MAINNET (real funds). In Legion's own code a mainnet spend needs the mainnet switch (off by default), Arm, your confirmations and the wallet's own prompt.");
  for (let i = 0; i < 4; i++) await s.call('GET', '/api/bsv/wallet');
  assert.equal(auditLines(s.dataDir).filter((e) => e.tool === 'bsv_wallet' && e.decision === 'probe').length, 1);
  s.wal.w.net = 'testnet';
  await s.call('GET', '/api/bsv/wallet');
  assert.equal(auditLines(s.dataDir).filter((e) => e.tool === 'bsv_wallet' && e.decision === 'probe').length, 2);
});

test('wallet: an unreachable wallet is "not detected"; the configured URL is validated (a non-loopback URL in config.json is never contacted)', async () => {
  const s = await setup({ on: true });
  s.wal.w.fail = true;
  const r = await connectWallet(s);
  assert.equal(r.body.reachable, false);
  assert.equal(r.body.condition, 'not-detected');
  // a config.json edit pointing the probe at another machine
  const d = mkdtempSync(join(tmpdir(), 'legion-bsvw-'));
  writeFileSync(join(d, 'config.json'), JSON.stringify({ bsv: { enabled: true, walletUrl: 'http://203.0.113.7:3321' } }));
  const f = makeFakes();
  const state = createBsvState({ dataDir: d, config: { bsv: { enabled: true, network: 'testnet', walletUrl: 'http://203.0.113.7:3321' } } as never });
  const wal = fakeWallet();
  const mod = createBsvModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: d, bsvEnabled: () => true }, { state, transport: wal.transport });
  const st = await mod.probe.check();
  assert.equal(st.condition, 'not-configured', 'a hand-edited address is ignored: only Connect sets it, so nothing is contacted');
  assert.equal(mod.probe.connect().ok, false, 'and Connect itself refuses an address that is not loopback');
  assert.equal((await mod.probe.check()).condition, 'not-configured');
  assert.equal(wal.w.calls.length, 0);
  // the Connect route refuses it too, with a reason, before anything is saved or sent
  const s2 = await setup({ on: true });
  for (const bad of ['http://203.0.113.7:3321', 'https://127.0.0.1:4444', 'http://user:pw@127.0.0.1:4444', 'http://127.0.0.1:4444/x', 'http://example.com', 'nope', '', 5, null]) assert.equal((await connectWallet(s2, bad as never)).status, 400, String(bad));
  assert.equal(s2.wal.w.calls.length, 0);
  assert.equal(s2.state.walletUrl, undefined, 'a refused address is not kept');
});

test('a hand-edited walletUrl is ignored (only Connect sets it); the BSV toggle rewrites bsv without it', async () => {
  const d = mkdtempSync(join(tmpdir(), 'legion-bsvw-'));
  writeFileSync(join(d, 'config.json'), JSON.stringify({ port: 1, bsv: { enabled: false, network: 'testnet', walletUrl: 'http://127.0.0.1:4444' } }));
  const state = createBsvState({ dataDir: d, config: { bsv: { enabled: false, network: 'testnet', walletUrl: 'http://127.0.0.1:4444' } } as never });
  assert.equal(state.walletUrl, undefined);
  state.set(true);
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'config.json'), 'utf8')).bsv, { enabled: true, network: 'testnet' });
  assert.equal(state.walletUrl, undefined);
});

// ---------------------------------------------------------------- arming and freezing through the routes

test('arm: with both secrets it arms for a listed duration only; invalid durations, BSV off and a frozen chain are refused; nothing about arming is saved', async () => {
  const off = await setup({ on: false });
  assert.equal((await off.call('POST', '/api/bsv/policy/arm', { minutes: 5 })).status, 409, 'BSV mode off');
  const s = await setup({ on: true });
  assert.equal((await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 })).status, 409, 'arming is refused while the mainnet switch is off (the default)');
  s.bsv.policy.setMainnetEnabled(true);
  for (const bad of [{}, { minutes: 7 }, { minutes: '5' }, { minutes: -1 }, { minutes: 1000 }, { minutes: 1.5 }, { minutes: null }]) assert.equal((await s.call('POST', '/api/bsv/policy/arm', bad)).status, 400, JSON.stringify(bad));
  const ok = await s.call('POST', '/api/bsv/policy/arm', { minutes: 15 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.armed, true);
  assert.ok(ok.body.remainingMs > 14 * 60_000 && ok.body.remainingMs <= 15 * 60_000);
  assert.equal(ok.body.spendTools, false);
  assert.equal(ok.body.network, 'testnet');
  assert.equal(ok.body.nativeAvailable, true);
  assert.equal((await s.call('GET', '/api/bsv/policy')).body.armed, true);
  const entries = auditLines(s.dataDir);
  assert.ok(entries.some((e) => e.decision === 'armed' && e.agent === 'owner' && e.fields.minutes === 15));
  assert.ok(!existsSync(policyFile(s.dataDir)) || !/armed/i.test(readFileSync(policyFile(s.dataDir), 'utf8')), 'arming is never written to disk');
  // restart: a new module over the same data dir is not armed
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.isArmed(), false);
  assert.equal((await s.call('POST', '/api/bsv/policy/disarm', {})).body.armed, false);
  assert.equal((await s.call('POST', '/api/bsv/policy/freeze', {})).status, 200);
  assert.equal((await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 })).status, 409, 'frozen');
});

test('turning BSV mode off disarms', async () => {
  const s = await setup({ on: true });
  s.bsv.policy.setMainnetEnabled(true); // arming needs the mainnet switch
  await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 });
  assert.equal(s.bsv.policy.isArmed(), true);
  await s.call('POST', '/api/bsv', { enabled: false });
  assert.equal(s.bsv.policy.isArmed(), false);
});

test('freeze: denies pending cards, disarms, is saved, survives a restart, and only unfreeze (with both secrets) clears it', async () => {
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/allowlist', { list: [mkAddr(0x6f, 0x11)] });
  s.bsv.policy.setMainnetEnabled(true); // arming needs the mainnet switch
  await s.call('POST', '/api/bsv/policy/arm', { minutes: 30 });
  const d = s.bsv.policy.evaluate({
    requestId: 'req-test-0001', network: 'test', walletNetwork: 'test', agentId: 'assayer', taskId: 't1', reason: 'x', tainted: false,
    decoded: { inputSats: 700, outputs: [{ recipient: mkAddr(0x6f, 0x11), sats: 600 }], feeSats: 100 },
  });
  assert.equal(d.verdict, 'needs_approval');
  const fr = await s.call('POST', '/api/bsv/policy/freeze', { reason: 'owner pressed Freeze' });
  assert.equal(fr.status, 200);
  assert.equal(fr.body.frozen.reason, 'owner pressed Freeze');
  assert.equal(fr.body.armed, false);
  assert.equal(fr.body.persisted, true);
  assert.equal(s.bsv.policy.status('req-test-0001'), 'denied');
  assert.equal(JSON.parse(readFileSync(policyFile(s.dataDir), 'utf8')).frozen.reason, 'owner pressed Freeze');
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.isFrozen, true, 'a restart does not unfreeze');
  assert.equal((await s2.call('POST', '/api/bsv/policy/unfreeze', {}, s2.adminOnly)).status, 403);
  assert.equal(s2.bsv.policy.isFrozen, true);
  const un = await s2.call('POST', '/api/bsv/policy/unfreeze', {});
  assert.equal(un.status, 200);
  assert.equal(un.body.frozen, null);
  assert.equal(JSON.parse(readFileSync(policyFile(s.dataDir), 'utf8')).frozen, null);
  assert.deepEqual(auditLines(s.dataDir).filter((e) => ['frozen', 'unfrozen'].includes(e.decision)).map((e) => e.decision), ['frozen', 'unfrozen']);
});

test('caps and allowlist: validated, hard-capped, saved; a hand-edited policy file cannot raise a cap past the ceiling', async () => {
  const s = await setup({ on: true });
  const tooBig = await s.call('POST', '/api/bsv/policy/caps', { perTxSats: TESTNET_HARD_CAPS.perTxSats + 1, perSessionSats: TESTNET_HARD_CAPS.perSessionSats });
  assert.equal(tooBig.status, 409);
  assert.deepEqual(s.bsv.policy.config().caps, TESTNET_DEFAULT_CAPS);
  assert.equal((await s.call('POST', '/api/bsv/policy/caps', { bogus: 1 })).status, 409);
  assert.equal((await s.call('POST', '/api/bsv/policy/caps', [1, 2])).status, 400);
  assert.equal((await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 })).body.caps.perTxSats, 800);
  assert.equal(JSON.parse(readFileSync(policyFile(s.dataDir), 'utf8')).nets.test.caps.perTxSats, 800);
  assert.equal((await s.call('POST', '/api/bsv/policy/allowlist', { list: ['has space'] })).status, 409);
  assert.equal((await s.call('POST', '/api/bsv/policy/allowlist', { list: 'nope' })).status, 409);
  const al = await s.call('POST', '/api/bsv/policy/allowlist', { list: [mkAddr(0x6f, 0x11), mkAddr(0x6f, 0x33)] });
  assert.deepEqual(al.body.allowlist, [mkAddr(0x6f, 0x11), mkAddr(0x6f, 0x33)]);
  assert.equal((await s.call('POST', '/api/bsv/policy/allowlist', { list: ['Bob@HandCash.io'] })).status, 409, 'a paymail is not a testnet address'); // B6
  // a same-user process edits the file to raise everything: the next start does not trust it (see test/bsv-fix-round.test.ts for the full story)
  writeFileSync(policyFile(s.dataDir), JSON.stringify({ caps: { perTxSats: 9e15, perSessionSats: 9e15, per24hSats: 9e15, maxOutputs: 9e9, maxFeeSats: 9e15 }, allowlist: [mkAddr(0x6f, 0x99), '../x'] }));
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.isFrozen, true);
  assert.deepEqual(s2.bsv.policy.config().caps, TESTNET_DEFAULT_CAPS, 'the edited caps are not used at all');
  assert.deepEqual(s2.bsv.policy.config().allowlist, [], 'neither is the edited allowlist');
});

test('an unreadable policy file loads FROZEN, not as defaults', async () => {
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 700 });
  writeFileSync(policyFile(s.dataDir), '{ this is not json');
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.isFrozen, true);
  assert.match(s2.bsv.policy.config().frozen!.reason, /policy file could not be read/);
});

// ---------------------------------------------------------------- the audit log through the module

test('audit: policy changes and wallet probes are logged by the owner/agent name, the reader route returns them newest first with the chain check', async () => {
  const s = await setup({ on: true });
  await connectWallet(s);
  s.bsv.policy.setMainnetEnabled(true); // arming needs the mainnet switch
  await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 });
  await s.call('POST', '/api/bsv/policy/disarm', {});
  const r = await s.call('GET', '/api/bsv/audit?limit=50');
  assert.equal(r.status, 200);
  assert.equal(r.body.verify.ok, true);
  const decisions = r.body.entries.map((e: any) => e.decision);
  assert.deepEqual(decisions.slice(0, 2), ['disarmed', 'armed']);
  assert.ok(decisions.includes('probe'));
  assert.equal(r.body.entries[0].seq > r.body.entries[1].seq, true);
  const page = await s.call('GET', `/api/bsv/audit?limit=1&before=${r.body.entries[0].seq}`);
  assert.equal(page.body.entries.length, 1);
  assert.equal(page.body.entries[0].seq, r.body.entries[0].seq - 1);
  assert.equal((await s.call('GET', '/api/bsv/audit?limit=abc&before=-1')).status, 200, 'junk paging values are ignored, not errors');
});

test('audit: tampering with the log is detected by the reader and, at the next start, freezes the chain and keeps the evidence', async () => {
  const s = await setup({ on: true });
  s.bsv.policy.setMainnetEnabled(true); // arming needs the mainnet switch
  await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 });
  await s.call('POST', '/api/bsv/policy/disarm', {});
  const f = join(s.dataDir, 'bsv', 'audit.jsonl');
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  lines[0] = lines[0]!.replace(/"agent":"[a-z]+"/, '"agent":"someone"'); // whatever the first line is (the switch change is the first one now)
  writeFileSync(f, lines.join('\n') + '\n');
  const live = await s.call('GET', '/api/bsv/audit');
  assert.equal(live.body.verify.ok, false);
  assert.equal((await s.call('GET', '/api/bsv/policy')).body.audit.ok, false);
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.isFrozen, true);
  assert.match(s2.bsv.policy.config().frozen!.reason, /audit log failed verification/);
  assert.ok(readdirSync(join(s.dataDir, 'bsv')).some((n) => n.includes('.broken-')), 'the evidence file is kept');
  assert.equal((await s2.call('GET', '/api/bsv/audit')).body.verify.ok, true, 'a fresh, valid chain carries on');
});

// ---------------------------------------------------------------- the bsv_status tool

async function connect(server: McpSdkServerConfigWithInstance) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(b), client.connect(a)]);
  return client;
}
const textOf = (r: any): string => (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');

test('tool: only the gated agent, only while BSV is on, exactly one tool, read-only', async () => {
  const s = await setup({ on: false });
  const assayer = s.agents.get('assayer')!;
  assert.deepEqual(s.bsv.mcpServers!(assayer), {}, 'off');
  s.state.set(true);
  assert.deepEqual(Object.keys(s.bsv.mcpServers!(assayer)), ['legion_bsv']);
  for (const id of ['zealot', 'scout', 'builder', 'herald', 'assayer2']) assert.deepEqual(s.bsv.mcpServers!(mkAgent(id)), {}, id);
  assert.deepEqual(s.bsv.mcpServers!({ ...mkAgent('assayer'), name: 'Assayer' }), {}, 'a bot that is merely named Assayer, without the gate, gets nothing');
  const client = await connect(s.bsv.mcpServers!(assayer).legion_bsv as McpSdkServerConfigWithInstance);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['bsv_status']);
  assert.equal(tools[0]!.annotations?.readOnlyHint, true);
  assert.deepEqual(tools[0]!.inputSchema.properties ?? {}, {}, 'it takes no arguments: nothing an agent writes can steer it');
});

test('tool: the answer is wrapped as untrusted data, holds only whitelisted fields, taints the run, and the wallet gets only the four methods', async () => {
  const s = await setup({ on: true });
  await connectWallet(s);
  s.wal.w.calls.length = 0;
  let marked = 0;
  const job = { taskId: 'task-9', taint: () => false, markTainted: () => { marked++; } };
  const client = await connect(s.bsv.mcpServers!(s.agents.get('assayer')!, job).legion_bsv as McpSdkServerConfigWithInstance);
  const r: any = await client.callTool({ name: 'bsv_status', arguments: {} });
  assert.equal(r.isError, undefined);
  const t = textOf(r);
  assert.match(t, /<bsv-wallet-status untrusted="true">/);
  assert.match(t, /"network":"test"/);
  assert.match(t, /unverified claim/);
  assert.match(t, /no tool to sign, spend/);
  assert.equal(marked, 1);
  assert.deepEqual(s.wal.w.calls.map((c) => c.path), ['/getVersion', '/getNetwork', '/isAuthenticated', '/getHeight']);
  for (const key of ['balance', 'address', 'publicKey', 'privateKey']) assert.ok(!t.includes(key));
  // the audit log names the agent and the task
  const e = auditLines(s.dataDir).find((x) => x.tool === 'bsv_status');
  assert.ok(e && e.agent === 'assayer' && e.task === 'task-9' && e.decision === 'allowed');
});

test('tool: by name it is NOT a Legion-trusted tool, so a card is needed in ask mode and the run is tainted by the engine', () => {
  const name = 'mcp__legion_bsv__bsv_status';
  assert.equal(taintsRun(name), true);
  assert.equal(needsApproval('ask', name), true);
  assert.equal(needsApproval('auto-edits', name), true);
});

test('tool: refused while BSV is off, while frozen, and after too many calls in one task; none of those contact the wallet', async () => {
  const s = await setup({ on: true });
  const mk = async (taskId: string) => connect(s.bsv.mcpServers!(s.agents.get('assayer')!, { taskId, taint: () => false }).legion_bsv as McpSdkServerConfigWithInstance);
  const c = await mk('t-a');
  s.state.set(false);
  const off: any = await c.callTool({ name: 'bsv_status', arguments: {} });
  assert.equal(off.isError, true);
  assert.equal(s.wal.w.calls.length, 0);
  s.state.set(true);
  s.bsv.policy.freeze('test');
  const fr: any = await c.callTool({ name: 'bsv_status', arguments: {} });
  assert.equal(fr.isError, true);
  assert.match(textOf(fr), /frozen/);
  assert.equal(s.wal.w.calls.length, 0);
  s.bsv.policy.unfreeze();
  assert.equal((await connectWallet(s)).status, 200, 'a freeze disconnects the wallet: the owner connects again');
  let lastErr = 0;
  for (let i = 0; i < 9; i++) { const r: any = await c.callTool({ name: 'bsv_status', arguments: {} }); if (r.isError) lastErr++; }
  assert.equal(lastErr, 3, 'six answers per task, then it stops');
  const other: any = await (await mk('t-b')).callTool({ name: 'bsv_status', arguments: {} });
  assert.equal(other.isError, undefined, 'a different task has its own allowance');
  assert.ok(auditLines(s.dataDir).some((e) => e.tool === 'bsv_status' && e.decision === 'denied'));
});

test('tool: an agent cannot reach the policy: it has no argument, no other tool, and the routes need secrets it never has', async () => {
  const s = await setup({ on: true });
  const client = await connect(s.bsv.mcpServers!(s.agents.get('assayer')!).legion_bsv as McpSdkServerConfigWithInstance);
  const r: any = await client.callTool({ name: 'bsv_status', arguments: { minutes: 15, arm: true, freeze: false, caps: { perTxSats: 1 } } }).catch((e) => ({ isError: true, error: String(e) }));
  void r;
  assert.equal(s.bsv.policy.isArmed(), false);
  assert.deepEqual(s.bsv.policy.config().caps, TESTNET_DEFAULT_CAPS);
  const unknown: any = await client.callTool({ name: 'bsv_arm', arguments: {} }).catch((e) => ({ isError: true, error: String(e) }));
  assert.equal(unknown.isError, true);
});

test('preamble: four lines, describes bsv_status truthfully, still no spend tools and never asks for keys', async () => {
  assert.equal(BSV_PREAMBLE.split('\n').length, 4);
  assert.match(BSV_PREAMBLE, /mcp__legion_bsv__bsv_status/);
  assert.match(BSV_PREAMBLE, /read-only/);
  assert.match(BSV_PREAMBLE, /unverified/);
  assert.match(BSV_PREAMBLE, /Legion has no tool that signs, sends, reads balances or holds funds/);
  assert.match(BSV_PREAMBLE, /Never ask the user for keys, seed phrases/);
  assert.doesNotMatch(BSV_PREAMBLE, /you can (sign|spend|send|broadcast)/i);
});
