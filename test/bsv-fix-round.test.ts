/**
 * BSV fix round after the independent review (verdict: SHIP AFTER FIXES). One group of tests per fix, numbered as in the review:
 *  1 policy file tamper -> frozen        2 hedge check (see bsv-hedge.test.ts)   3 audit recovery and time-ordered ledger
 *  4 no default address, Connect only    5 a "changed" report only tightens      6 tripwire hardening (planted cases: bsv-review-tripwire.test.ts)
 *  7 semver-only version (also in bsv-wallet-probe.test.ts)   8 clone on entry   9 Freeze without Electron
 * The wallet is always a fake transport; nothing here opens a socket, and nothing here may touch the owner's real wallet.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { ASSAYER_ID, createBsvModule, createBsvState } from '../src/core/bsv/index.js';
import { AuditLog, auditPath, verifyText } from '../src/core/bsv/audit.js';
import { DAY_MS, TESTNET_DEFAULT_CAPS, TESTNET_HARD_CAPS, ledgerFromAudit, PolicyEngine, requestHash } from '../src/core/bsv/policy.js';
import type { Clock, PolicyEvent, SpendRequest } from '../src/core/bsv/policy.js';
import { loadPolicyConfig, policyFileHash, policyPath, savePolicyConfig, sha256 } from '../src/core/bsv/policy-store.js';
import * as probeModule from '../src/core/bsv/wallet-probe.js';
import { WalletProbeError } from '../src/core/bsv/wallet-probe.js';
import type { Transport, WireRequest } from '../src/core/bsv/wallet-probe.js';
import { gate, isClientRoute } from '../src/core/admin.js';
import { bsvConfirmation, bsvPreflight, parseBsvAction } from '../src/electron/admin-logic.js';
import { joinLiterals, normalize, unescapeLiterals } from './bsv-scan.js';
import { AUTH, asClient, makeFakes, mkAgent, start } from './helpers-c.js';
import { mkAddr } from './bsv-net-helpers.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); });

const ALICE = mkAddr(0x6f, 0x11);
const NATIVE = 'native-secret-0123456789abcdef0123456789';
const WALLET_URL = 'http://127.0.0.1:45001';

class FakeClock implements Clock {
  w = 1_800_000_000_000; m = 5_000;
  wall() { return this.w; } mono() { return this.m; }
  advance(ms: number) { this.w += ms; this.m += ms; }
}
let n = 0;
function req(over: Partial<SpendRequest> = {}): SpendRequest {
  return {
    requestId: `fix-${String(++n).padStart(6, '0')}`, network: 'test', walletNetwork: 'test', agentId: 'assayer', taskId: 'task-1', reason: 'pay the faucet back', tainted: false,
    decoded: { inputSats: 4620, outputs: [{ recipient: ALICE, sats: 600 }, { recipient: mkAddr(0x6f, 0x44), sats: 4000, change: true }], feeSats: 20 },
    ...over,
  };
}
function engine(o: { allow?: string[]; ledger?: Array<{ requestId: string; sats: number; at: number }> } = {}) {
  const clock = new FakeClock();
  const events: PolicyEvent[] = [];
  const e = new PolicyEngine({ clock, sessionId: 's1', ledger: o.ledger, onEvent: (ev) => events.push(ev), config: { caps: { ...TESTNET_DEFAULT_CAPS }, allowlist: o.allow ?? [ALICE], frozen: null } });
  return { e, clock, events };
}

// ================================================================== 8. clone on entry (no shared mutable references)

test('8: a caller that keeps the returned decision cannot drop a required confirmation: approve still demands them', () => {
  const { e, clock } = engine();
  clock.advance(1);
  const d = e.evaluate(req({ tainted: true }));
  assert.equal(d.verdict, 'needs_approval');
  assert.deepEqual(d.requiredConfirmations, ['approve', 'untrusted-content']);
  const card = d.card!;
  // the caller edits what it was handed: the list on the decision AND the list on the card
  d.requiredConfirmations.length = 0;
  card.requiredConfirmations.length = 0;
  const r = e.approve(d.requestId, { cardHash: card.hash, confirmations: ['approve'], walletNetwork: 'test' });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /missing confirmation: untrusted-content/);
  assert.equal(e.approve(d.requestId, { cardHash: card.hash, confirmations: ['approve', 'untrusted-content'], walletNetwork: 'test' }).ok, true);
});

test('8: the stored decision is deep-copied on every way out: a duplicate answer is not the first answer\'s object, and editing either changes nothing', () => {
  const { e } = engine();
  const r = req();
  const first = e.evaluate(r);
  const second = e.evaluate(r);
  assert.equal(second.duplicate, true);
  assert.notEqual(first.card, second.card);
  assert.notEqual(first.requiredConfirmations, second.requiredConfirmations);
  first.card!.outputs[0]!.sats = 1; first.card!.totalSpendSats = 1; first.reasons.push('x');
  const third = e.evaluate(r);
  assert.equal(third.card!.totalSpendSats, 620);
  assert.equal(third.card!.outputs[0]!.sats, 600);
  assert.deepEqual(third.reasons, []);
  // a refused request: the stored refusal is a copy too
  const bad = req({ decoded: { inputSats: 10, outputs: [{ recipient: ALICE, sats: 5 }], feeSats: 1 } });
  const d1 = e.evaluate(bad);
  d1.reasons.length = 0;
  assert.ok(e.evaluate(bad).reasons.length > 0, 'the stored refusal kept its reasons');
});

test('8: the request is copied once on entry: editing it afterwards, or a getter that answers differently each time, changes nothing that was checked', () => {
  const { e } = engine();
  const r = req();
  const d = e.evaluate(r);
  const hashAtEntry = d.card!.hash;
  // edit the caller's object after the check: the card, the hash and the reservation are not affected
  r.decoded.outputs[0]!.recipient = mkAddr(0x6f, 0x22); r.reason = 'something else';
  assert.equal(e.snapshot().usage.reservedSats, 620);
  assert.equal(d.card!.hash, hashAtEntry);
  // the same id with the edited content is a different request, and is refused as such
  assert.match(e.evaluate(r).reasons.join(' '), /already used with different content/);

  // a getter that says one thing to the check and another to the card: only one read happens, so the card and the amounts agree
  let reads = 0;
  const sneaky = req();
  Object.defineProperty(sneaky.decoded.outputs[0]!, 'sats', { enumerable: true, get() { reads++; return reads === 1 ? 600 : 1; } });
  const d2 = e.evaluate(sneaky);
  assert.equal(d2.verdict, 'needs_approval');
  assert.equal(d2.card!.outputs[0]!.sats, 600);
  assert.equal(d2.card!.totalSpendSats, 620);
  assert.equal(reads, 1, 'read exactly once, on entry');
  // and hash = what the card shows
  assert.equal(d2.card!.hash, requestHash({ ...sneaky, decoded: { ...sneaky.decoded, outputs: [{ recipient: ALICE, sats: 600 }, { recipient: mkAddr(0x6f, 0x44), sats: 4000, change: true }] } }));
});

test('8: an object the engine cannot copy (a proxy, a function field, a cycle) is a denial, never an exception and never a reservation', () => {
  const { e } = engine();
  const weird = [
    new Proxy(req(), {}),
    { ...req(), reason: (() => 'x') as unknown as string },
    (() => { const r = req() as unknown as Record<string, unknown>; r.self = r; r.decoded = { ...(r.decoded as object), cyc: r }; return r as unknown as SpendRequest; })(),
  ];
  for (const w of weird) {
    const d = e.evaluate(w);
    assert.equal(d.verdict === 'deny' || d.verdict === 'needs_approval', true);
    if (d.verdict === 'deny') assert.ok(d.reasons.length);
  }
  const proxied = e.evaluate(new Proxy(req(), {}));
  assert.equal(proxied.verdict, 'deny');
  assert.match(proxied.reasons.join(' '), /could not be read safely/);
  assert.equal(engine().e.snapshot().usage.reservedSats, 0);
  assert.equal(e.status(proxied.requestId), undefined, 'and nothing was reserved or remembered for it');
});

test('8: an approval and a settlement read their input once: what is checked is what is used', () => {
  const { e } = engine();
  const d = e.evaluate(req());
  let hashReads = 0; let confReads = 0;
  const input = {
    get cardHash() { hashReads++; return hashReads === 1 ? d.card!.hash : 'f'.repeat(64); },
    get confirmations() { confReads++; return confReads === 1 ? ['approve'] : []; },
    walletNetwork: 'test' as const,
  };
  assert.equal(e.approve(d.requestId, input).ok, true);
  assert.equal(hashReads, 1); assert.equal(confReads, 1);

  let satsReads = 0;
  const outcome = { kind: 'executed' as const, get sats() { satsReads++; return satsReads === 1 ? 620 : 99_999; } };
  assert.deepEqual(e.settle(d.requestId, outcome), { ok: true });
  assert.equal(satsReads, 1);
  assert.deepEqual(e.executedRecords().map((r) => r.sats), [620], 'the amount that was checked is the amount that was recorded');
  assert.equal(e.isFrozen, false);

  // a throwing outcome is "unknown", which blocks everything until a person resolves it
  const d2 = e.evaluate(req());
  e.approve(d2.requestId, { cardHash: d2.card!.hash, confirmations: ['approve'], walletNetwork: 'test' });
  const throwing = { get kind(): never { throw new Error('boom'); } } as unknown as { kind: 'failed' };
  e.settle(d2.requestId, throwing);
  assert.equal(e.status(d2.requestId), 'unknown');
});

test('8: caps, allowlist and events are copies too: what a caller or an observer keeps cannot reach the engine', () => {
  const { e, events } = engine();
  const caps = { perTxSats: 700 };
  e.setCaps(caps);
  caps.perTxSats = 999_999;
  assert.equal(e.config().caps.perTxSats, 700);
  const list = [ALICE];
  e.setAllowlist(list);
  list.push(mkAddr(0x6f, 0x22));
  assert.deepEqual(e.config().allowlist, [ALICE]);
  const cfg = e.config(); cfg.caps.perTxSats = 1; cfg.allowlist.push('x');
  assert.equal(e.config().caps.perTxSats, 700);
  const capsEvent = events.find((x) => x.type === 'caps') as Extract<PolicyEvent, { type: 'caps' }>;
  capsEvent.caps.perTxSats = 123_456;
  assert.equal(e.config().caps.perTxSats, 700);
  // freeze: the arrays handed back are not the arrays the observer saw
  const d = e.evaluate(req());
  const fr = e.freeze('test');
  const fev = events.find((x) => x.type === 'frozen') as Extract<PolicyEvent, { type: 'frozen' }>;
  assert.deepEqual(fr.denied, [d.requestId]);
  fev.denied.length = 0;
  assert.deepEqual(fr.denied, [d.requestId]);
  // a non-array allowlist, or one that is edited while being read, is refused or copied once
  assert.throws(() => e.setAllowlist('nope' as never));
});

// ================================================================== 3. audit: recovery and time order

function auditDir() { return mkdtempSync(join(tmpdir(), 'legion-bsvfix-')); }
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean);

test('3: the rolling window is ordered by the time of each spend, not by where its line sits', () => {
  const t0 = 1_800_000_000_000;
  const e = (sats: number, atMs: number, id: string) => ({ decision: 'executed', ts: new Date(atMs).toISOString(), fields: { sats, requestId: id } as Record<string, unknown> });
  const out = ledgerFromAudit([e(300, t0 + 3000, 'c'), e(100, t0 + 1000, 'a'), e(200, t0 + 2000, 'b'), { decision: 'probe', ts: new Date(t0).toISOString(), fields: {} }]);
  assert.deepEqual(out.map((r) => r.requestId), ['a', 'b', 'c']);
  assert.deepEqual(out.map((r) => r.sats), [100, 200, 300]);
});

test('3: a flood of status notes cannot push an old spend out of the 24-hour window (the old reader looked at the last 500 lines)', () => {
  const dir = auditDir();
  const file = auditPath(dir);
  let t = 1_800_000_000_000;
  const log = new AuditLog(file, { now: () => t });
  log.open();
  log.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-old-0001', sats: 700 } });
  for (let i = 0; i < 700; i++) { t += 1000; log.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: `note ${i}` }); }
  // the last-500-lines view really has lost it ...
  assert.equal(ledgerFromAudit(log.read({ limit: 500 }).entries).length, 0);
  // ... the time-based view has not
  const full = ledgerFromAudit(log.entries((x) => x.decision === 'executed', t - DAY_MS));
  assert.deepEqual(full.map((r) => r.sats), [700]);
  // and the module, started over this directory, counts it against the rolling cap
  const f = makeFakes();
  const mod = createBsvModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: dir, bsvEnabled: () => true }, { state: createBsvState({ dataDir: dir, config: f.ctx.config }), nativeSecret: NATIVE, now: () => t });
  assert.equal(mod.policy.snapshot().usage.last24hSats, 700);
});

test('3: an entry older than a day is outside the window; one inside it counts; entries come back in time order', () => {
  const dir = auditDir();
  const file = auditPath(dir);
  let t = 1_800_000_000_000;
  const log = new AuditLog(file, { now: () => t });
  log.open();
  log.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-ancient1', sats: 50 } });
  t += DAY_MS + 5000;
  log.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-recent01', sats: 60 } });
  const recent = ledgerFromAudit(log.entries((x) => x.decision === 'executed', t - DAY_MS));
  assert.deepEqual(recent.map((r) => r.sats), [60]);
  const all = log.entries((x) => x.decision === 'executed');
  assert.deepEqual(all.map((x) => x.fields.sats), [50, 60]);
});

test('3: rotation keeps the chain: after a restart the new file continues from the archive, and the archived spends still count', () => {
  const dir = auditDir();
  const file = auditPath(dir);
  let t = 1_800_000_000_000;
  const a = new AuditLog(file, { now: () => t, rotateBytes: 2500 });
  a.open();
  a.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-rot-0001', sats: 400 } });
  for (let i = 0; i < 40; i++) { t += 10; a.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: `padding line ${i} ${'x'.repeat(40)}` }); }
  const archives = readdirSync(dir + '/bsv').filter((x) => /^audit\.jsonl\.\d+$/.test(x));
  assert.ok(archives.length >= 1, 'it rotated');
  const headBefore = a.head;
  // simulate "the process stopped right after a rotation": the current file is empty
  writeFileSync(file, '');
  const b = new AuditLog(file, { now: () => t, rotateBytes: 2500 });
  // the anchor still says where the chain ended, and the newest archive does not end there: this is a cut, not a rotation
  const r1 = b.open();
  assert.equal(r1.ok, false, 'an emptied file whose archive does not hold the head is reported');
  assert.match(r1.tamper!.reason, /cut off|ends at entry|missing or empty/);
  // the spend in an archive is still found
  assert.ok(b.entries((x) => x.decision === 'executed').some((x) => x.fields.sats === 400));
  assert.ok(headBefore.seq > 0);
});

test('3: a clean rotation (the file is empty because the last write was the rotation itself) is NOT a tamper and the chain continues', () => {
  const dir = auditDir();
  const file = auditPath(dir);
  let t = 1_800_000_000_000;
  const a = new AuditLog(file, { now: () => t, rotateBytes: 100_000 });
  a.open();
  for (let i = 0; i < 3; i++) { t += 10; a.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: `n${i}` }); }
  const head = a.head;
  // what rotateIfLarge leaves when the process stops between the rename and the next append: the archive holds everything, the file is empty
  renameSync(file, `${file}.${head.seq}`);
  writeFileSync(file, '');
  const b = new AuditLog(file, { now: () => t });
  const r = b.open();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(b.head, head, 'the head came from the newest archive');
  const next = b.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: 'after' });
  assert.equal(next.seq, head.seq + 1);
  assert.equal(next.prev, head.hash, 'the chain continues across the rotation');
  assert.equal(b.verify().ok, true);
});

test('3: a log whose end was cut off is reported at the next start (the anchor remembers where it ended), the chain carries on and says so, and the module freezes', () => {
  const dir = auditDir();
  const file = auditPath(dir);
  const t = 1_800_000_000_000;
  const a = new AuditLog(file, { now: () => t });
  a.open();
  for (let i = 0; i < 6; i++) a.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: `n${i}` });
  const full = lines(file);
  writeFileSync(file, full.slice(0, 3).join('\n') + '\n'); // lines 3..5 removed from the end: the hash chain of what is left is perfectly valid
  assert.equal(verifyText(readFileSync(file, 'utf8')).ok, true, 'the truncated file verifies on its own');
  const b = new AuditLog(file, { now: () => t });
  const r = b.open();
  assert.equal(r.ok, false);
  assert.match(r.tamper!.reason, /cut off|ends at entry 2/);
  const last = JSON.parse(lines(file).at(-1)!);
  assert.equal(last.decision, 'head-mismatch');
  assert.equal(last.fields.anchorSeq, 5);
  assert.equal(last.fields.fileSeq, 2);
  assert.equal(b.verify().ok, true, 'the chain is valid again, with the finding as its latest line');
  // and a module over the same directory freezes
  const f = makeFakes();
  const dir2 = auditDir();
  const file2 = auditPath(dir2);
  const c = new AuditLog(file2, { now: () => t }); c.open();
  for (let i = 0; i < 4; i++) c.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: `n${i}` });
  writeFileSync(file2, lines(file2).slice(0, 2).join('\n') + '\n');
  const mod = createBsvModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: dir2, bsvEnabled: () => true }, { state: createBsvState({ dataDir: dir2, config: f.ctx.config }), nativeSecret: NATIVE, now: () => t });
  assert.equal(mod.policy.isFrozen, true);
  assert.match(mod.policy.config().frozen!.reason, /cut off|ends at entry/);
});

test('3: the file replaced by another valid chain, the anchor deleted, the anchor garbled, and the file removed are each reported', () => {
  const t = 1_800_000_000_000;
  const mk = () => {
    const dir = auditDir(); const file = auditPath(dir);
    const a = new AuditLog(file, { now: () => t }); a.open();
    for (let i = 0; i < 4; i++) a.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: `n${i}` });
    return { dir, file };
  };
  // (a) replaced by a different valid chain of the same length
  { const { dir, file } = mk(); const other = auditDir(); const of = auditPath(other); const o = new AuditLog(of, { now: () => t + 1 }); o.open(); for (let i = 0; i < 4; i++) o.append({ agent: 'someone', tool: 'x', decision: 'y' }); writeFileSync(file, readFileSync(of));
    const r = new AuditLog(file, { now: () => t }).open(); assert.equal(r.ok, false, 'a replaced file'); assert.match(r.tamper!.reason, /replaced|not the one/); void dir; }
  // (b) the anchor deleted while entries exist
  { const { file } = mk(); rmSync(`${file}.head`); const r = new AuditLog(file, { now: () => t }).open(); assert.equal(r.ok, false); assert.match(r.tamper!.reason, /anchor file is missing/); }
  // (c) the anchor is garbage
  { const { file } = mk(); writeFileSync(`${file}.head`, '{not json'); const r = new AuditLog(file, { now: () => t }).open(); assert.equal(r.ok, false); assert.match(r.tamper!.reason, /anchor file could not be read/); }
  // (d) the log file removed, anchor left
  { const { file } = mk(); rmSync(file); const r = new AuditLog(file, { now: () => t }).open(); assert.equal(r.ok, false); assert.match(r.tamper!.reason, /missing or empty/); assert.ok(existsSync(file), 'a fresh log was started and says so'); }
  // (e) after any of them the log is valid and the next start is quiet
  { const { file } = mk(); rmSync(`${file}.head`); new AuditLog(file, { now: () => t }).open(); const again = new AuditLog(file, { now: () => t }).open(); assert.equal(again.ok, true); }
});

test('3: a torn last line (a crash mid-write) is tolerated and the next entry starts on a clean line; garbage in the middle moves the file aside but its spends are still counted', () => {
  const dir = auditDir(); const file = auditPath(dir);
  let t = 1_800_000_000_000;
  const a = new AuditLog(file, { now: () => t }); a.open();
  a.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-torn-001', sats: 300 } });
  a.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: 'n' });
  appendFileSync(file, '{"v":1,"seq":2,"ts":"2026-10-02T00:00:00.0'); // half a line, no newline
  const b = new AuditLog(file, { now: () => t });
  const r = b.open();
  assert.equal(r.ok, true, 'a torn tail is a crash, not an attack');
  const n1 = b.append({ agent: 'legion', tool: 'bsv_wallet', decision: 'probe', reason: 'after the crash' });
  assert.equal(n1.seq, 2);
  assert.equal(b.verify().ok, false, 'the torn fragment is still in the file in the middle of it now');
  // the file now has a bad line in the middle: the next start moves it aside, and the evidence still counts
  t += 10;
  const c = new AuditLog(file, { now: () => t });
  const r2 = c.open();
  assert.equal(r2.ok, false);
  assert.ok(r2.tamper!.movedTo && existsSync(r2.tamper!.movedTo));
  assert.deepEqual(c.entries((x) => x.decision === 'executed').map((x) => x.fields.sats), [300], 'the spend in the kept evidence is still in the window');
  assert.equal(c.verify().ok, true);
});

test('3: the lenient reader is bounded (files and bytes) and skips junk lines instead of failing', () => {
  const dir = auditDir(); const file = auditPath(dir);
  const a = new AuditLog(file, { now: () => 1_800_000_000_000 }); a.open();
  a.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-lenient1', sats: 5 } });
  appendFileSync(file, 'garbage line\n{"v":1}\n[1,2]\n');
  assert.deepEqual(a.entries((x) => x.decision === 'executed').map((x) => x.fields.sats), [5]);
  // more archives than the scan will open: the newest are read, the rest ignored, nothing throws
  for (let i = 0; i < 80; i++) writeFileSync(`${file}.${1000 + i}`, '');
  assert.doesNotThrow(() => a.entries());
  assert.ok(a.entries().length >= 1);
  assert.ok(statSync(file).size > 0);
});

// ================================================================== 1. policy file tamper -> frozen

const fakeWallet = (net = 'testnet') => {
  const w = { net, calls: [] as WireRequest[], fail: false, extra: {} as Record<string, unknown> };
  const transport: Transport = async (r) => {
    w.calls.push(r);
    if (w.fail) throw new WalletProbeError('refused');
    const m = r.path.slice(1);
    const body = m === 'getVersion' ? { version: '1.0.0' } : m === 'getNetwork' ? { network: w.net } : m === 'isAuthenticated' ? { authenticated: true } : { height: 4321 };
    return { status: 200, body: JSON.stringify({ ...body, ...w.extra }) };
  };
  return { w, transport };
};

async function setup(o: { dataDir?: string; on?: boolean; native?: string | null; net?: string; startNow?: () => number } = {}) {
  const f = makeFakes();
  f.agents.set(ASSAYER_ID, { ...mkAgent(ASSAYER_ID, 'Assayer'), requires: 'bsv' });
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'legion-bsvfix-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port: 4747, authToken: 'on-disk-token', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {}, bsv: { enabled: !!o.on, network: 'testnet' } }, null, 2));
  (f.ctx.config as any).bsv = { enabled: !!o.on, network: 'testnet' };
  const state = createBsvState({ dataDir, config: f.ctx.config });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => state.enabled };
  const wal = fakeWallet(o.net);
  const bsv = createBsvModule(deps, { state, nativeSecret: o.native === null ? undefined : o.native ?? NATIVE, transport: wal.transport, probeMinIntervalMs: 0, now: o.startNow });
  f.ctx.modules = [bsv];
  f.ctx.bsvEnabled = () => state.enabled;
  const srv = await start(f.ctx);
  closers.push(() => srv.close());
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { ...AUTH, 'X-Legion-Native': NATIVE }) => {
    const r = await fetch(srv.base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : undefined };
  };
  return { ...f, state, bsv, dataDir, srv, wal, call };
}
type Rig = Awaited<ReturnType<typeof setup>>;
const policyFile = (d: string) => policyPath(d);
const auditLines = (d: string) => lines(auditPath(d)).map((l) => JSON.parse(l));
const evidence = (d: string) => readdirSync(join(d, 'bsv')).filter((x) => x.startsWith('policy.json.tampered-'));
const connectWallet = (s: Rig, url = WALLET_URL) => s.call('POST', '/api/bsv/wallet/connect', { url });
const mcpClient = async (server: McpSdkServerConfigWithInstance) => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(b), client.connect(a)]);
  return client;
};

test('1: a policy file Legion wrote is trusted across a restart (its hash is in the audit log); the same bytes edited by hand are not', async () => {
  const s = await setup({ on: true });
  assert.equal((await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 })).status, 200);
  assert.equal((await s.call('POST', '/api/bsv/policy/allowlist', { list: [ALICE] })).status, 200);
  const h = policyFileHash(policyFile(s.dataDir));
  assert.match(String(h), /^[0-9a-f]{64}$/);
  assert.equal(auditLines(s.dataDir).filter((e) => e.tool === 'policy' && e.decision === 'saved').at(-1).fields.policyHash, h, 'the audit log recorded the exact hash');
  const ok = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(ok.bsv.policy.isFrozen, false, 'Legion\'s own file loads normally');
  assert.equal(ok.bsv.policy.config().caps.perTxSats, 800);
  assert.deepEqual(ok.bsv.policy.config().allowlist, [ALICE]);
  assert.equal(evidence(s.dataDir).length, 0);
});

test('1: a hand-edited policy file (raised limits, an extra recipient) loads as DEFAULT limits, an empty allowlist and frozen; the file is kept as evidence and the audit log says so', async () => {
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  const edited = JSON.parse(readFileSync(policyFile(s.dataDir), 'utf8'));
  edited.nets.test.caps.perTxSats = 5000; edited.nets.test.caps.perSessionSats = 5_000_000; edited.nets.test.allowlist = [mkAddr(0x6f, 0x99)]; edited.mainnetEnabled = true;
  writeFileSync(policyFile(s.dataDir), JSON.stringify(edited, null, 2));
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.isFrozen, true);
  assert.match(s2.bsv.policy.config().frozen!.reason, /changed outside Legion/);
  assert.deepEqual(s2.bsv.policy.config().caps, TESTNET_DEFAULT_CAPS, 'the edited limits are not used, and neither are Legion\'s earlier ones: the owner sets them again');
  assert.deepEqual(s2.bsv.policy.config().allowlist, []);
  assert.equal(s2.bsv.policy.mainnetEnabled, false, 'a hand-edited mainnetEnabled:true is not used: the file is untrusted, so the switch is off');
  assert.equal(evidence(s.dataDir).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, 'bsv', evidence(s.dataDir)[0]!), 'utf8')).nets.test.caps.perTxSats, 5000, 'the edited file is kept as it was');
  assert.ok(auditLines(s.dataDir).some((e) => e.tool === 'policy' && e.decision === 'file-tampered'));
  // what is on disk now is Legion's own frozen file, so it stays frozen after yet another restart, and unfreezing is the owner's act (native)
  const s3 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s3.bsv.policy.isFrozen, true);
  assert.equal((await s3.call('POST', '/api/bsv/policy/unfreeze', {}, { ...AUTH })).status, 403);
  assert.equal((await s3.call('POST', '/api/bsv/policy/unfreeze', {})).status, 200);
  const s4 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s4.bsv.policy.isFrozen, false, 'after the owner unfroze it, Legion\'s own save is trusted again');
});

test('1: a policy file with no record at all (created by hand on a fresh install), a missing file Legion had saved, and an unreadable file each freeze', async () => {
  // no record
  const d1 = mkdtempSync(join(tmpdir(), 'legion-bsvfix-')); mkdirSync(join(d1, 'bsv'), { recursive: true });
  writeFileSync(policyFile(d1), JSON.stringify({ caps: { perTxSats: 900 }, allowlist: [mkAddr(0x6f, 0x99)], frozen: null }));
  const a = await setup({ dataDir: d1, on: true });
  assert.equal(a.bsv.policy.isFrozen, true);
  assert.match(a.bsv.policy.config().frozen!.reason, /no record of being written by Legion/);
  assert.deepEqual(a.bsv.policy.config().allowlist, []);
  // missing
  const b0 = await setup({ on: true });
  await b0.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  rmSync(policyFile(b0.dataDir));
  const b = await setup({ dataDir: b0.dataDir, on: true });
  assert.equal(b.bsv.policy.isFrozen, true);
  assert.match(b.bsv.policy.config().frozen!.reason, /missing although Legion saved one/);
  // unreadable
  const c0 = await setup({ on: true });
  await c0.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  writeFileSync(policyFile(c0.dataDir), '{ not json');
  const c = await setup({ dataDir: c0.dataDir, on: true });
  assert.equal(c.bsv.policy.isFrozen, true);
  assert.equal(evidence(c0.dataDir).length, 1);
});

test('1: while running, a changed file freezes the chain before anything reads or changes the policy; Legion\'s own copy is written back; bsv_status contacts nothing', async () => {
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  await connectWallet(s);
  const callsBefore = s.wal.w.calls.length;
  const mine = readFileSync(policyFile(s.dataDir), 'utf8');
  const edited = JSON.parse(mine); edited.nets.test.caps.perTxSats = 5000; edited.frozen = null;
  writeFileSync(policyFile(s.dataDir), JSON.stringify(edited));
  // the tool is the first thing to notice
  const tool = await mcpClient(s.bsv.mcpServers!(s.agents.get('assayer')!, { taskId: 'task-1', taint: () => false }).legion_bsv as McpSdkServerConfigWithInstance);
  const r: any = await tool.callTool({ name: 'bsv_status', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /frozen/);
  assert.equal(s.wal.w.calls.length, callsBefore, 'no wallet contact after the tamper');
  assert.equal(s.bsv.policy.isFrozen, true);
  assert.match(s.bsv.policy.config().frozen!.reason, /changed outside Legion while it was running/);
  assert.equal(s.bsv.policy.config().caps.perTxSats, 800, 'in memory Legion still has the owner\'s real limits');
  assert.equal(JSON.parse(readFileSync(policyFile(s.dataDir), 'utf8')).nets.test.caps.perTxSats, 800, 'and wrote them back over the foreign file');
  assert.equal(evidence(s.dataDir).length, 1);
  assert.ok(auditLines(s.dataDir).some((e) => e.decision === 'file-tampered'));
  assert.equal((await s.call('GET', '/api/bsv/wallet?cached=1')).body.connected, false, 'a freeze disconnects the wallet');
  // a second edit is noticed again, and a restart afterwards is quiet about the second one (Legion wrote the file last)
  const s2 = await setup({ dataDir: s.dataDir, on: true });
  assert.equal(s2.bsv.policy.config().caps.perTxSats, 800);
  assert.equal(evidence(s.dataDir).length, 1);
});

test('1: removing the file while running freezes too, and a GET of the policy is enough to notice (no timer is involved)', async () => {
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  rmSync(policyFile(s.dataDir));
  const v = await s.call('GET', '/api/bsv/policy');
  assert.equal(v.body.frozen.reason.includes('removed'), true);
  assert.ok(existsSync(policyFile(s.dataDir)), 'rewritten from memory');
  // while frozen, arming is refused
  assert.equal((await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 })).status, 409);
});

test('1: the policy store reports the hash of what it wrote and of what it read; evidence files are capped at ten', async () => {
  const dir = auditDir();
  const f = join(dir, 'bsv', 'policy.json');
  const cfg = { caps: { ...TESTNET_DEFAULT_CAPS }, allowlist: [ALICE], frozen: null };
  const h = savePolicyConfig(f, cfg);
  assert.equal(h, sha256(readFileSync(f)));
  const l = loadPolicyConfig(f);
  assert.equal(l.hash, h);
  assert.equal(l.unreadable, false);
  assert.equal(loadPolicyConfig(join(dir, 'nope.json')).hash, null);
  writeFileSync(f, 'x');
  assert.equal(loadPolicyConfig(f).unreadable, true);
  assert.equal(policyFileHash(join(dir, 'nope.json')), null);
  // ten pieces of evidence are kept, the eleventh tamper does not fill the disk
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  for (let i = 0; i < 13; i++) { writeFileSync(policyFile(s.dataDir), JSON.stringify({ caps: { perTxSats: 1 + i } })); await s.call('GET', '/api/bsv/policy'); }
  assert.ok(evidence(s.dataDir).length <= 10);
  assert.equal(s.bsv.policy.isFrozen, true);
});

// ================================================================== 4. no default address, Connect only

test('4: there is no default wallet address anywhere: the probe exports none, a probe without an address sends nothing, and a configured address is not contacted at start', async () => {
  assert.equal('DEFAULT_WALLET_URL' in probeModule, false);
  const calls: WireRequest[] = [];
  const transport: Transport = async (r) => { calls.push(r); return { status: 200, body: '{}' }; };
  const r = await probeModule.probeWallet({ transport });
  assert.equal(r.error, 'rejected-url'); assert.deepEqual(r.sent, []);
  // a wallet address in config.json (hand-edited, or left by an older version) is IGNORED: only Connect sets an address, in memory
  const dir = mkdtempSync(join(tmpdir(), 'legion-bsvfix-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ bsv: { enabled: true, network: 'testnet', walletUrl: WALLET_URL } }));
  const f = makeFakes();
  const state = createBsvState({ dataDir: dir, config: { bsv: { enabled: true, network: 'testnet', walletUrl: WALLET_URL } } as never });
  const wal = fakeWallet();
  const mod = createBsvModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: dir, bsvEnabled: () => true }, { state, transport: wal.transport, probeMinIntervalMs: 0 });
  await mod.start();
  for (let i = 0; i < 3; i++) await mod.probe.check();
  assert.equal(wal.w.calls.length, 0, 'enabled, a hand-edited address in config.json, still nothing is contacted');
  assert.equal(state.walletUrl, undefined, 'the hand-edited address was not read');
  assert.equal(mod.probe.connect().ok, false, 'Connect has no address to use until the owner types one');
  assert.equal(mod.probe.connectedUrl, undefined);
  for (let i = 0; i < 3; i++) await mod.probe.check();
  assert.equal(wal.w.calls.length, 0, 'zero requests until the owner sets an address and presses Connect');
  assert.equal(mod.probe.cached().condition, 'not-configured');
  state.setWalletUrl('http://127.0.0.1:45002');
  assert.equal(mod.probe.connect().ok, true);
  assert.equal(mod.probe.connectedUrl, 'http://127.0.0.1:45002');
  await mod.probe.check();
  assert.ok(wal.w.calls.length > 0, 'after Connect the typed address is used');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).bsv.walletUrl, WALLET_URL, 'and the typed address is never written back over the file');
});

test('4: bsv_status before Connect contacts nothing and says so; after Connect it asks the four questions', async () => {
  const s = await setup({ on: true });
  const tool = await mcpClient(s.bsv.mcpServers!(s.agents.get('assayer')!, { taskId: 'task-4', taint: () => false }).legion_bsv as McpSdkServerConfigWithInstance);
  const before: any = await tool.callTool({ name: 'bsv_status', arguments: {} });
  assert.equal(s.wal.w.calls.length, 0);
  assert.match(before.content[0].text, /"condition":"not-configured"/);
  assert.ok(auditLines(s.dataDir).some((e) => e.tool === 'bsv_status' && e.decision === 'denied' && /not connected a wallet/.test(e.reason ?? '')));
  assert.equal((await connectWallet(s)).status, 200);
  s.wal.w.calls.length = 0;
  const after: any = await tool.callTool({ name: 'bsv_status', arguments: {} });
  assert.match(after.content[0].text, /"network":"test"/);
  assert.deepEqual(s.wal.w.calls.map((c) => c.path), ['/getVersion', '/getNetwork', '/isAuthenticated', '/getHeight']);
});

test('4: Connect needs BSV mode on, an unfrozen chain, the native proof and a loopback address; Disconnect (and Freeze, and turning the mode off) stop all contact', async () => {
  const s = await setup({ on: true });
  assert.equal((await s.call('POST', '/api/bsv/wallet/connect', { url: WALLET_URL }, { ...AUTH })).status, 403, 'admin secret alone is not enough');
  assert.equal(s.wal.w.calls.length, 0);
  assert.equal((await connectWallet(s, 'http://203.0.113.9:3321')).status, 400);
  assert.equal((await connectWallet(s)).status, 200);
  assert.ok(auditLines(s.dataDir).some((e) => e.tool === 'bsv_wallet' && e.decision === 'connected' && e.fields.address === '127.0.0.1:45001'));
  assert.equal((await s.call('GET', '/api/bsv/wallet')).body.connected, true);
  // Disconnect: admin secret is enough (it only quiets things), and the next read asks nothing
  s.wal.w.calls.length = 0;
  const dis = await s.call('POST', '/api/bsv/wallet/disconnect', {}, { ...AUTH });
  assert.equal(dis.status, 200); assert.equal(dis.body.connected, false);
  await s.call('GET', '/api/bsv/wallet'); await s.call('GET', '/api/bsv/wallet');
  assert.equal(s.wal.w.calls.length, 0);
  // frozen: Connect refused
  await s.call('POST', '/api/bsv/policy/freeze', {});
  assert.equal((await connectWallet(s)).status, 409);
  await s.call('POST', '/api/bsv/policy/unfreeze', {});
  assert.equal((await connectWallet(s)).status, 200);
  // freeze while connected disconnects
  await s.call('POST', '/api/bsv/policy/freeze', {});
  assert.equal((await s.call('GET', '/api/bsv/wallet?cached=1')).body.connected, false);
});

test('4: the Electron side: connect is parsed strictly, shows the address in a native dialog, refuses extra fields and non-loopback addresses, and is refused while frozen', () => {
  assert.deepEqual(parseBsvAction({ kind: 'connect', url: WALLET_URL }), { kind: 'connect', url: WALLET_URL });
  for (const bad of [{ kind: 'connect' }, { kind: 'connect', url: 5 }, { kind: 'connect', url: 'http://203.0.113.9:80' }, { kind: 'connect', url: 'https://127.0.0.1:4000' }, { kind: 'connect', url: WALLET_URL, extra: 1 }, { kind: 'connect', url: 'http://user:pw@127.0.0.1:4000' }, { kind: 'connect', url: 'http://127.0.0.1:4000/x' }]) {
    assert.equal(parseBsvAction(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parseBsvAction({ kind: 'disconnect' }), { kind: 'disconnect' });
  assert.equal(parseBsvAction({ kind: 'disconnect', x: 1 }), undefined);
  const c = bsvConfirmation({ kind: 'connect', url: WALLET_URL });
  assert.equal(c.needsDialog, true);
  assert.equal(c.route, '/api/bsv/wallet/connect');
  assert.deepEqual(c.body, { url: WALLET_URL });
  assert.match(c.message, /127\.0\.0\.1:45001/);
  assert.match(c.detail, /four read-only questions/);
  assert.match(c.detail, /unverified/);
  assert.match(c.detail, /not contact it again after you disconnect, freeze, turn BSV mode off or restart/);
  assert.equal(c.buttons[0], 'Cancel');
  assert.equal(bsvConfirmation({ kind: 'disconnect' }).needsDialog, false);
  assert.match(bsvPreflight({ kind: 'connect', url: WALLET_URL }, { frozen: { reason: 'x' } }) ?? '', /frozen/);
  assert.equal(bsvPreflight({ kind: 'connect', url: WALLET_URL }, { frozen: null }), undefined);
});

// ================================================================== 5. a "changed" report from the wallet never raises a limit or resets state

test('5: a wallet that reports a different network can only DISARM; limits, allowlist, freeze, ledger and pending requests are exactly as they were', async () => {
  const s = await setup({ on: true });
  await s.call('POST', '/api/bsv/policy/caps', { perTxSats: 800 });
  await s.call('POST', '/api/bsv/policy/allowlist', { list: [ALICE] });
  await connectWallet(s);
  s.bsv.policy.setMainnetEnabled(true); // arming needs the mainnet switch on
  await s.call('POST', '/api/bsv/policy/arm', { minutes: 15 });
  const d = s.bsv.policy.evaluate(req());
  assert.equal(d.verdict, 'needs_approval');
  const before = s.bsv.policy.snapshot();
  s.wal.w.net = 'mainnet';
  await s.call('GET', '/api/bsv/wallet'); // the probe sees the change
  const mid = s.bsv.policy.snapshot();
  assert.equal(mid.armed, false, 'tightened: disarmed');
  assert.deepEqual({ ...mid, armed: true, armedUntil: before.armedUntil, remainingMs: before.remainingMs }, { ...before, usage: mid.usage, pending: mid.pending }, 'nothing else changed');
  assert.deepEqual(mid.caps, before.caps); assert.deepEqual(mid.allowlist, before.allowlist); assert.equal(mid.frozen, null);
  assert.equal(s.bsv.policy.status(d.requestId), 'pending', 'a pending card is neither approved nor cleared by it');
  s.wal.w.net = 'testnet';
  await s.call('GET', '/api/bsv/wallet');
  const after = s.bsv.policy.snapshot();
  assert.equal(after.armed, false, 'the wallet going back to testnet does not re-arm anything');
  assert.deepEqual(after.caps, before.caps);
  // a frozen chain stays frozen whatever the wallet says
  s.bsv.policy.freeze('test');
  await connectWallet(s).catch(() => undefined);
  assert.equal(s.bsv.policy.isFrozen, true);
});

test('5: fields a wallet adds to its answers (a "changed" flag, limits, "raise" requests) are dropped by the probe and move nothing', async () => {
  const s = await setup({ on: true });
  s.wal.w.extra = { changed: true, limitsChanged: true, perTxSats: 99_999_999, caps: { perTxSats: 1e9 }, unfreeze: true, armed: true, frozen: false, network_changed: 'yes' };
  const caps = s.bsv.policy.config().caps;
  const r = await connectWallet(s);
  assert.equal(r.status, 200);
  for (const k of ['changed', 'limitsChanged', 'perTxSats', 'caps', 'unfreeze', 'armed', 'frozen']) assert.equal(k in r.body, false, k);
  assert.deepEqual(s.bsv.policy.config().caps, caps);
  assert.equal(s.bsv.policy.isArmed(), false);
  // a frozen chain is not unfrozen by a wallet that says "unfreeze: true"
  s.bsv.policy.freeze('t');
  s.wal.w.extra = { unfreeze: true, frozen: false };
  await s.bsv.probe.check({ fresh: true });
  assert.equal(s.bsv.policy.isFrozen, true);
  // and nothing in the module's source feeds a probe result to anything that loosens: the only policy call in the onChange handler is disarm
  const src = readFileSync(join(process.cwd(), 'src/core/bsv/index.ts'), 'utf8');
  const handler = /probe\.onChange = [\s\S]*?\n  \};/.exec(src)![0];
  assert.deepEqual([...handler.matchAll(/policy\.(\w+)\(/g)].map((m) => m[1]), ['disarm']);
});

// ================================================================== 9. Freeze without Electron

test('9: a core with no app (no admin secret, no native secret) can be frozen with the bearer token alone; nothing that loosens is reachable that way', () => {
  const g = (method: string, path: string) => gate({ method, path, adminOk: false, bearerOk: true, hasSecret: false });
  assert.deepEqual(g('POST', '/api/bsv/policy/freeze'), { allow: true, admin: false });
  assert.deepEqual(g('POST', '/api/bsv/policy/freeze/'), { allow: true, admin: false });
  for (const [m, p] of [['GET', '/api/bsv/policy/freeze'], ['POST', '/api/bsv/policy/unfreeze'], ['POST', '/api/bsv/policy/arm'], ['POST', '/api/bsv/policy/disarm'], ['POST', '/api/bsv/policy/caps'], ['POST', '/api/bsv/policy/allowlist'], ['POST', '/api/bsv/wallet/connect'], ['POST', '/api/bsv/wallet/disconnect'], ['GET', '/api/bsv/wallet'], ['GET', '/api/bsv/policy'], ['GET', '/api/bsv/audit'], ['POST', '/api/bsv/policy/freeze/x'], ['POST', '/api/bsv/policy/freezeX']] as const) {
    assert.equal(g(m, p).allow, false, `${m} ${p}`);
    assert.equal(isClientRoute(m, p), false, `${m} ${p}`);
  }
  assert.equal(gate({ method: 'POST', path: '/api/bsv/policy/freeze', adminOk: false, bearerOk: false, hasSecret: false }).allow, false, 'without the bearer token it is refused too');
});

test('9: through the real HTTP server, a core with no native secret and no admin secret freezes on the bearer token; the freeze is saved and survives a restart', async () => {
  const s = await setup({ on: true, native: null });
  const bearerOnly = { ...asClient };
  assert.equal((await s.call('POST', '/api/bsv/policy/arm', { minutes: 5 }, bearerOnly)).status, 403);
  const fr = await s.call('POST', '/api/bsv/policy/freeze', { reason: 'frozen from a headless client' }, bearerOnly);
  assert.equal(fr.status, 200);
  assert.equal(s.bsv.policy.isFrozen, true);
  assert.equal(JSON.parse(readFileSync(policyFile(s.dataDir), 'utf8')).frozen.reason, 'frozen from a headless client');
  const again = await setup({ dataDir: s.dataDir, on: true, native: null });
  assert.equal(again.bsv.policy.isFrozen, true, 'still frozen after a restart, and the saved file is trusted (Legion wrote it)');
  assert.equal(evidence(s.dataDir).length, 0);
  // unfreezing is not possible headless
  assert.equal((await again.call('POST', '/api/bsv/policy/unfreeze', {}, { ...AUTH, 'X-Legion-Native': NATIVE })).status, 403);
  assert.equal(again.bsv.policy.isFrozen, true);
});

// ================================================================== 6. the tripwire's folding (planted cases are in bsv-review-tripwire.test.ts)

test('6: normalize folds escapes, concat, template parts, reversal, replace, slice and array items before names are matched', () => {
  const cases: Array<[string, string]> = [
    ["'\\u0073ignAction'", 'signAction'],
    ["'\\x73ignAction'", 'signAction'],
    ["'\\u{73}ignAction'", 'signAction'],
    ["'sig'.concat('nAc', 'tion')", 'signAction'],
    ["'sig' + 'n' + 'Action'", 'signAction'],
    ["`sig${'n'}Action`", 'signAction'],
    ["['sig', 'nAction'].join('')", 'signAction'],
    ["'noitcAngis'.split('').reverse().join('')", 'signAction'],
    ["'signXAction'.replace('X', '')", 'signAction'],
    ["'signXXAction'.replaceAll('X', '')", 'signAction'],
    ["'zzsignAction'.slice(2)", 'signAction'],
    ["'zsignActionz'.substring(1, 11)", 'signAction'],
    ["['x', 'signAction'][1]", 'signAction'],
  ];
  for (const [src, want] of cases) assert.ok(normalize(src).includes(want), `${src} -> ${normalize(src)}`);
  assert.equal(unescapeLiterals('\\u0041\\x42'), 'AB');
  assert.equal(joinLiterals("'a' + 'b'"), "'ab'");
  // text that is not a literal is left alone (the BSV-area rules refuse those shapes instead)
  assert.equal(normalize('a + b'), 'a + b');
});

// ================================================================== 7. semver only (the module level view of it)

test('7: through the module, a wallet that reports a vendor tag, a "v" prefix or text has no version in the answer; valid semver is shown', async () => {
  const s = await setup({ on: true });
  const seen: Array<string | null> = [];
  for (const v of ['1.2.3', '2.0.0-rc.1+b5', 'v1.2.3', 'BSV Desktop 1.2.3', '1.2', '<b>1.2.3</b>']) {
    s.wal.w.extra = { version: v };
    await connectWallet(s);
    seen.push((await s.call('GET', '/api/bsv/wallet?cached=1')).body.version);
  }
  assert.deepEqual(seen, ['1.2.3', '2.0.0-rc.1+b5', null, null, null, null]);
  void TESTNET_HARD_CAPS;
});
