/**
 * Per-network policy (plan 12.1 to 12.4, controls C28 to C31, C33 and C34): testnet and mainnet each have their own caps, allowlist,
 * reservations and ledger; mainnet is behind a hard-off switch and a one-spend arm; the recipient's version byte must match the network;
 * a wallet that claims another network voids the card; an unknown outcome blocks both networks. The engine is pure, so everything runs on a fake clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAddress, addressNet, NET } from '../src/core/bsv/networks.js';
import { DAY_MS, EXEC_TTL_MS, PolicyEngine, PolicyError, sanitizePolicyConfig, validateCaps } from '../src/core/bsv/policy.js';
import type { PolicyConfig, PolicyEvent } from '../src/core/bsv/policy.js';
import { loadPolicyConfig, savePolicyConfig } from '../src/core/bsv/policy-store.js';
import { approveInput, engine, FakeClock, MAIN_A, MAIN_B, mkAddr, req, TEST_A, TEST_B } from './bsv-net-helpers.js';

// ------------------------------------------------------------------ the table and the address decoder

test('NET: frozen, one row per network, the numbers the owner approved (mainnet lower, hard ceilings per network)', () => {
  assert.ok(Object.isFrozen(NET) && Object.isFrozen(NET.test) && Object.isFrozen(NET.main) && Object.isFrozen(NET.main.defaultCaps) && Object.isFrozen(NET.main.hardCaps));
  assert.deepEqual(Object.keys(NET).sort(), ['main', 'test']);
  assert.deepEqual({ ...NET.test.defaultCaps }, { perTxSats: 1000, perSessionSats: 5000, per24hSats: 10000, maxOutputs: 3, maxFeeSats: 200 });
  assert.deepEqual({ ...NET.main.defaultCaps }, { perTxSats: 1000, perSessionSats: 2000, per24hSats: 5000, maxOutputs: 1, maxFeeSats: 100 });
  assert.deepEqual({ ...NET.test.hardCaps }, { perTxSats: 1_000_000, perSessionSats: 5_000_000, per24hSats: 10_000_000, maxOutputs: 10, maxFeeSats: 10_000 });
  assert.deepEqual({ ...NET.main.hardCaps }, { perTxSats: 100_000, perSessionSats: 250_000, per24hSats: 500_000, maxOutputs: 1, maxFeeSats: 1_000 });
  assert.equal(NET.test.versionByte, 0x6f); assert.equal(NET.main.versionByte, 0x00);
  assert.equal(NET.test.label, 'TESTNET'); assert.match(NET.main.label, /LIVE FUNDS/);
  assert.equal(NET.test.maxAllowlist, 50); assert.equal(NET.main.maxAllowlist, 10);
  for (const net of ['test', 'main'] as const) for (const k of Object.keys(NET[net].hardCaps) as Array<keyof typeof NET.test.hardCaps>) assert.ok(NET[net].defaultCaps[k] <= NET[net].hardCaps[k], `${net} ${k}`);
  assert.throws(() => { (NET.main.hardCaps as { perTxSats: number }).perTxSats = 9e9; }, TypeError, 'a hard ceiling cannot be edited at run time');
});

test('addresses: base58check with the right length, checksum and version byte decodes; everything else is null and never throws', () => {
  assert.equal(addressNet(MAIN_A), 'main'); assert.equal(addressNet(TEST_A), 'test');
  const d = decodeAddress(MAIN_A)!;
  assert.equal(d.version, 0); assert.equal(d.hash160.length, 20); assert.ok(d.hash160.every((b) => b === 0x11));
  assert.equal(decodeAddress(TEST_B)!.version, 0x6f);
  // a hash that starts with zero bytes keeps its leading '1's on mainnet
  assert.equal(addressNet(mkAddr(0, 0)), 'main'); assert.ok(mkAddr(0, 0).startsWith('11111111111111111111'));
  const bad: unknown[] = [
    mkAddr(0, 0x11, true), mkAddr(0x6f, 0x11, true),            // bad checksum, both networks
    mkAddr(0x05, 0x11), mkAddr(0xc4, 0x11), mkAddr(0x80, 0x11), // other version bytes (script hash, testnet script hash, WIF-like)
    MAIN_A.slice(1), MAIN_A + '1', ` ${MAIN_A}`, `${MAIN_A} `, MAIN_A.toLowerCase(), `${MAIN_A.slice(0, 5)}0${MAIN_A.slice(6)}`, `${MAIN_A.slice(0, 5)}l${MAIN_A.slice(6)}`, `${MAIN_A.slice(0, 5)}O${MAIN_A.slice(6)}`, `${MAIN_A.slice(0, 5)}I${MAIN_A.slice(6)}`,
    '', '1', 'x'.repeat(26), '1'.repeat(40), 'bob@handcash.io', MAIN_A.replace(/.$/, 'é'), MAIN_A.replace(/.$/, '\u{1F600}'),
    2 ** 53, null, undefined, {}, [], [MAIN_A], Symbol('x'), 12345678901234567890n,
  ];
  for (const b of bad) assert.equal(decodeAddress(b), null, String(typeof b === 'symbol' ? 'symbol' : b));
  for (const b of bad) assert.equal(addressNet(b), null);
});

test('addresses: 400 random and mutated strings never throw and only a real address decodes', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0;
  for (let i = 0; i < 400; i++) {
    const len = 20 + Math.floor(rnd() * 20);
    let s = ''; for (let k = 0; k < len; k++) s += A[Math.floor(rnd() * A.length)];
    if (i % 3 === 0) { const chars = [...MAIN_A]; chars[Math.floor(rnd() * chars.length)] = A[Math.floor(rnd() * A.length)]!; s = chars.join(''); }
    assert.doesNotThrow(() => decodeAddress(s));
    if (decodeAddress(s) && s !== MAIN_A) decoded++;
  }
  assert.ok(decoded <= 1, 'a one-character mutation of an address does not pass its checksum');
});

// ------------------------------------------------------------------ migration of an old policy file (testnet-only shape)

test('migration: an old policy file (top-level caps and allowlist) loads as TESTNET limits; mainnet is at its defaults and OFF', () => {
  const old = { caps: { perTxSats: 800, perSessionSats: 3000, per24hSats: 6000, maxOutputs: 2, maxFeeSats: 150 }, allowlist: [TEST_A, TEST_B], frozen: null };
  const c = sanitizePolicyConfig(old);
  assert.deepEqual(c.nets.test.caps, old.caps);
  assert.deepEqual(c.nets.test.allowlist, [TEST_A, TEST_B]);
  assert.deepEqual(c.nets.main, { caps: { ...NET.main.defaultCaps }, allowlist: [] });
  assert.equal(c.mainnetEnabled, false);
  assert.deepEqual(c.caps, old.caps, 'the mirror reads the testnet limits');
  const e = new PolicyEngine({ config: old });
  assert.equal(e.mainnetEnabled, false);
  assert.deepEqual(e.snapshot().nets.main.allowlist, []);
  assert.deepEqual(e.snapshot().nets.test.caps, old.caps);
});

test('migration: the old fields are read only while `nets` is absent, so they never override a later choice; mainnet entries in an old list are dropped', () => {
  const both = sanitizePolicyConfig({ nets: { test: { caps: { perTxSats: 700 }, allowlist: [TEST_B] } }, caps: { perTxSats: 999 }, allowlist: [TEST_A], mainnetEnabled: false });
  assert.equal(both.nets.test.caps.perTxSats, 700);
  assert.deepEqual(both.nets.test.allowlist, [TEST_B]);
  const mixed = sanitizePolicyConfig({ allowlist: [MAIN_A, TEST_A, 'x@y.io'] });
  assert.deepEqual(mixed.nets.test.allowlist, [TEST_A], 'a mainnet address cannot ride in on the testnet list, and a token or paymail is not a testnet address (B6)');
});

test('migration: the file is rewritten in the new shape (version 2) on the next save, and the result loads to the same limits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-nets-')); const f = join(dir, 'policy.json');
  writeFileSync(f, JSON.stringify({ caps: { perTxSats: 800 }, allowlist: [TEST_A], frozen: null }));
  const loaded = loadPolicyConfig(f);
  assert.equal(loaded.unreadable, false);
  assert.equal(loaded.config.nets.test.caps.perTxSats, 800);
  savePolicyConfig(f, loaded.config);
  const disk = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['frozen', 'mainnetEnabled', 'nets', 'version']);
  assert.equal(disk.version, 2); assert.equal(disk.mainnetEnabled, false);
  assert.equal(disk.caps, undefined, 'no top-level legacy fields are written'); assert.equal(disk.allowlist, undefined);
  assert.deepEqual(loadPolicyConfig(f).config.nets, loaded.config.nets);
});

test('config(): `nets` is the truth; caps and allowlist are a prototype mirror of testnet (not own, not enumerable, not written); an own `caps` is the old callers\' way to change testnet', () => {
  const { e } = engine();
  const cfg = e.config();
  assert.deepEqual(Object.keys(cfg).sort(), ['frozen', 'mainnetEnabled', 'nets']);
  assert.equal(JSON.stringify(cfg).includes('"caps":{"perTx') && JSON.stringify(cfg).indexOf('"caps"') < JSON.stringify(cfg).indexOf('"nets"'), false);
  assert.deepEqual(cfg.caps, cfg.nets.test.caps);
  // what the caller keeps cannot change the engine
  cfg.nets.main.caps.perTxSats = 1; cfg.nets.main.allowlist.push('x');
  assert.equal(e.config().nets.main.caps.perTxSats, NET.main.defaultCaps.perTxSats);
  // the spread an old route does drops the mirror; its explicit `caps` then lands on testnet only
  const dir = mkdtempSync(join(tmpdir(), 'legion-nets-')); const f = join(dir, 'policy.json');
  savePolicyConfig(f, { ...e.config(), caps: validateCaps({ perTxSats: 900 }, e.config().caps) });
  const disk = loadPolicyConfig(f).config;
  assert.equal(disk.nets.test.caps.perTxSats, 900);
  assert.equal(disk.nets.main.caps.perTxSats, NET.main.defaultCaps.perTxSats);
  assert.deepEqual(disk.nets.main.allowlist, [MAIN_A, MAIN_B]);
  // a stale mirror cannot undo a change made to `nets`
  const changed: PolicyConfig = { ...e.config() };
  changed.nets = { ...changed.nets, test: { ...changed.nets.test, caps: { ...changed.nets.test.caps, perTxSats: 400 } } };
  savePolicyConfig(f, changed);
  assert.equal(loadPolicyConfig(f).config.nets.test.caps.perTxSats, 400);
});

// ------------------------------------------------------------------ C29: caps, allowlists, reservations and ledgers per network

test('C29: testnet reservations and spends never use up mainnet headroom, and the reverse', () => {
  const { e } = engine();
  e.arm(60);
  const t = e.evaluate(req({ pay: 900 })); assert.equal(t.verdict, 'needs_approval');
  assert.equal(e.snapshot().nets.test.usage.reservedSats, 920);
  assert.equal(e.snapshot().nets.main.usage.reservedSats, 0, 'a testnet card reserves nothing on mainnet');
  e.approve(t.requestId, approveInput(t.card!)); e.settle(t.requestId, { kind: 'executed', sats: 920 });
  assert.equal(e.snapshot().nets.test.usage.sessionSats, 920);
  assert.equal(e.snapshot().nets.main.usage.sessionSats, 0); assert.equal(e.snapshot().nets.main.usage.last24hSats, 0);
  const m = e.evaluate(req({ network: 'main', pay: 980 }));
  assert.equal(m.verdict, 'needs_approval', 'mainnet still has its whole session cap');
  assert.equal(m.card!.remaining.perSessionSats, NET.main.defaultCaps.perSessionSats - 1000);
  assert.equal(e.snapshot().nets.main.usage.reservedSats, 1000); assert.equal(e.snapshot().nets.test.usage.reservedSats, 0);
  // the reverse: fill mainnet, testnet is untouched
  e.approve(m.requestId, approveInput(m.card!, 'main')); e.settle(m.requestId, { kind: 'executed', sats: 1000 });
  e.arm(60);
  const m2 = e.evaluate(req({ network: 'main', pay: 980 })); e.approve(m2.requestId, approveInput(m2.card!, 'main')); e.settle(m2.requestId, { kind: 'executed', sats: 1000 });
  e.arm(60);
  const m3 = e.evaluate(req({ network: 'main', pay: 100 }));
  assert.equal(m3.verdict, 'deny'); assert.deepEqual(m3.codes, ['over-cap'], 'mainnet session cap of 2,000 is used up');
  assert.equal(e.evaluate(req({ pay: 900 })).verdict, 'needs_approval', 'testnet has room: 920 + 920 <= 5,000');
});

test('C29: the 24 h window is per network; a ledger line without a net is a testnet line; an unrecognised net counts on BOTH (never under-counted)', () => {
  const clock = new FakeClock(); const now = clock.wall();
  const mk = (extra: Array<{ requestId: string; sats: number; at: number; net?: never }> = []) => engine({ clock, ledger: [{ requestId: 'old-test-1', sats: 9_000, at: now - 1000 }, { requestId: 'old-main-1', sats: 4_500, at: now - 1000, net: 'main' }, ...extra] });
  const { e } = mk();
  const s = e.snapshot();
  assert.equal(s.nets.test.usage.last24hSats, 9_000); assert.equal(s.nets.main.usage.last24hSats, 4_500);
  e.arm(5);
  assert.equal(e.evaluate(req({ pay: 980 })).verdict, 'needs_approval', 'testnet: 9,000 + 1,000 is exactly the 10,000 cap');
  assert.equal(e.evaluate(req({ network: 'main', pay: 480 })).verdict, 'needs_approval', 'mainnet: 4,500 + 500 is exactly the 5,000 cap');
  const { e: e2 } = mk(); e2.arm(5);
  const over = e2.evaluate(req({ network: 'main', pay: 580 }));
  assert.equal(over.verdict, 'deny'); assert.deepEqual(over.codes, ['over-cap']); assert.match(over.reasons.join(), /24-hour cap of 5000/);
  // the testnet history does not reach mainnet: a mainnet engine with only testnet history has its whole window
  const { e: e3 } = engine({ clock, ledger: [{ requestId: 'old-test-2', sats: 10_000, at: now - 1000 }] }); e3.arm(5);
  assert.equal(e3.evaluate(req({ network: 'main', pay: 980 })).verdict, 'needs_approval');
  assert.deepEqual(e3.evaluate(req({ pay: 100 })).codes, ['over-cap'], 'and testnet, with 10,000 behind it, is full');
  // an old record outside 24 h is not counted
  const { e: e4 } = engine({ clock, ledger: [{ requestId: 'ancient-1', sats: 10_000, at: now - DAY_MS - 1 }] });
  assert.equal(e4.evaluate(req({ pay: 980 })).verdict, 'needs_approval');
  // unrecognised net: counted against both networks
  const { e: e5 } = engine({ clock, ledger: [{ requestId: 'odd-net-1', sats: 5_000, at: now - 1000, net: 'MAIN' as never }] }); e5.arm(5);
  assert.deepEqual(e5.evaluate(req({ network: 'main', pay: 100 })).codes, ['over-cap'], 'it fills the mainnet window');
  assert.equal(e5.snapshot().nets.test.usage.last24hSats, 5_000, 'and shows on testnet too');
  assert.equal(e5.evaluate(req({ pay: 100 })).verdict, 'needs_approval');
});

test('C29: 100 parallel mainnet proposals fit the session cap exactly once (check and reserve are one step); testnet proposals do not change the count', () => {
  const { e } = engine(); e.arm(60);
  const verdicts: string[] = [];
  for (let i = 0; i < 100; i++) { verdicts.push(e.evaluate(req({ network: 'main', pay: 980 })).verdict); if (i % 10 === 0) e.evaluate(req({ pay: 100 })); }
  assert.equal(verdicts.filter((v) => v === 'needs_approval').length, 2, '2 x 1,000 = the 2,000 session cap');
  assert.equal(e.snapshot().nets.main.usage.reservedSats, 2000);
  assert.equal(e.snapshot().nets.test.usage.reservedSats, 10 * 120);
});

test('C29: every network has its own hard ceiling; a file, an API call or a caps change cannot pass it', () => {
  const { e } = engine();
  assert.throws(() => e.setCaps({ perTxSats: NET.main.hardCaps.perTxSats + 1 }, 'main'), PolicyError);
  assert.throws(() => e.setCaps({ maxOutputs: 2 }, 'main'), /maxOutputs must be a whole number from 1 to 1/);
  assert.throws(() => e.setCaps({ maxFeeSats: 1_001 }, 'main'), PolicyError);
  assert.doesNotThrow(() => e.setCaps({ perTxSats: 100_000, perSessionSats: 250_000, per24hSats: 500_000, maxFeeSats: 1_000 }, 'main'));
  assert.doesNotThrow(() => e.setCaps({ perTxSats: NET.main.hardCaps.perTxSats + 1, perSessionSats: 1_000_000, per24hSats: 2_000_000 }), 'testnet keeps its own, higher ceiling (the default network of the old call shape)');
  assert.equal(e.config().nets.test.caps.perTxSats, 100_001);
  assert.equal(e.config().nets.main.caps.perTxSats, 100_000, 'a testnet change did not touch mainnet');
  const file = sanitizePolicyConfig({ nets: { main: { caps: { perTxSats: 9e15, perSessionSats: 9e15, per24hSats: 9e15, maxOutputs: 9e9, maxFeeSats: 9e15 } }, test: { caps: { perTxSats: 9e15, perSessionSats: 9e15, per24hSats: 9e15 } } } });
  assert.deepEqual(file.nets.main.caps, { ...NET.main.hardCaps });
  assert.equal(file.nets.test.caps.perTxSats, NET.test.hardCaps.perTxSats);
  assert.equal(file.nets.test.caps.maxOutputs, NET.test.defaultCaps.maxOutputs);
  assert.deepEqual(validateCaps({}, undefined, 'main'), { ...NET.main.defaultCaps }, 'validateCaps starts from the network\'s own defaults');
  assert.throws(() => validateCaps({ perTxSats: 100_001 }, undefined, 'main'), PolicyError);
  assert.doesNotThrow(() => validateCaps({ perTxSats: 100_001, perSessionSats: 200_000, per24hSats: 300_000 }, undefined, 'test'));
  assert.throws(() => validateCaps({ perTxSats: 100_001, perSessionSats: 200_000, per24hSats: 300_000 }, undefined, 'main'), /perTxSats must be a whole number from 0 to 100000/);
});

test('C29: allowlists are per network; an empty mainnet list denies even when the testnet list is full', () => {
  const { e } = engine({ allowMain: [] }); e.arm(5);
  const d = e.evaluate(req({ network: 'main' }));
  assert.equal(d.verdict, 'deny'); assert.ok(d.codes.includes('not-allowlisted')); assert.match(d.reasons.join(), /LIVE FUNDS .* allowlist is empty/);
  assert.equal(e.evaluate(req()).verdict, 'needs_approval');
  const { e: e2 } = engine({ allowTest: [] });
  assert.deepEqual(e2.evaluate(req()).codes, ['not-allowlisted']);
  // the allowlist an owner sets for one network leaves the other alone
  const { e: e3 } = engine();
  e3.setAllowlist([MAIN_B], 'main');
  assert.deepEqual(e3.config().nets.main.allowlist, [MAIN_B]); assert.deepEqual(e3.config().nets.test.allowlist, [TEST_A, TEST_B]);
  e3.setAllowlist([TEST_A]);
  assert.deepEqual(e3.config().nets.test.allowlist, [TEST_A]); assert.deepEqual(e3.config().nets.main.allowlist, [MAIN_B]);
  const ev: PolicyEvent[] = []; const e4 = new PolicyEngine({ onEvent: (x) => ev.push(x) });
  e4.setAllowlist([MAIN_A], 'main'); e4.setCaps({ perTxSats: 500 }, 'main');
  assert.deepEqual(ev.map((x) => x.type === 'allowlist' || x.type === 'caps' ? [x.type, x.net] : x.type), [['allowlist', 'main'], ['caps', 'main']], 'events say which network changed');
});

// ------------------------------------------------------------------ C30: the recipient's version byte equals the network

test('C30: setAllowlist refuses an address of the other network, and mainnet takes valid mainnet addresses only; the size limits are per network', () => {
  const { e } = engine();
  assert.throws(() => e.setAllowlist([TEST_A], 'main'), /not a valid mainnet address/);
  assert.throws(() => e.setAllowlist([MAIN_A], 'test'), /not a valid testnet address/);
  assert.throws(() => e.setAllowlist([mkAddr(0, 0x33, true)], 'main'), /not a valid mainnet address/, 'a typo with a bad checksum is not accepted for real funds');
  assert.throws(() => e.setAllowlist(['bob@handcash.io'], 'main'), PolicyError, 'a paymail is not a mainnet recipient in this version');
  assert.throws(() => e.setAllowlist(['bob@handcash.io'], 'test'), /not a valid testnet address/, 'B6: testnet takes valid testnet addresses only: a paymail or a token is refused');
  assert.throws(() => e.setAllowlist(['mtestAddressAlice1111111111111111'], 'test'), PolicyError);
  assert.throws(() => e.setAllowlist([mkAddr(0x6f, 0x33, true)], 'test'), PolicyError, 'B6: a testnet address with a bad checksum is refused');
  assert.deepEqual(e.setAllowlist([TEST_A, TEST_B], 'test'), [TEST_A, TEST_B]);
  const ten = Array.from({ length: 10 }, (_, i) => mkAddr(0, i + 1)); const eleven = [...ten, mkAddr(0, 99)];
  assert.equal(e.setAllowlist(ten, 'main').length, 10);
  assert.throws(() => e.setAllowlist(eleven, 'main'), /at most 10 recipients/);
  assert.equal(e.setAllowlist(Array.from({ length: 50 }, (_, i) => mkAddr(0x6f, i + 1)), 'test').length, 50);
  assert.throws(() => e.setAllowlist(Array.from({ length: 51 }, (_, i) => mkAddr(0x6f, i + 1)), 'test'), /at most 50 recipients/);
  // a file cannot smuggle one in either
  const f = sanitizePolicyConfig({ nets: { main: { allowlist: [TEST_A, mkAddr(0, 5, true), MAIN_A, 'bob@handcash.io', ...eleven] }, test: { allowlist: [MAIN_B, TEST_B] } } });
  assert.deepEqual(f.nets.main.allowlist, [MAIN_A, ...ten.slice(0, 9)], 'only valid mainnet addresses, at most 10');
  assert.deepEqual(f.nets.test.allowlist, [TEST_B]);
});

test('C30: a recipient of the wrong network or an invalid address is refused with its own code, on top of the allowlist check', () => {
  const { e } = engine(); e.arm(5);
  for (const [to, why] of [[TEST_A, 'testnet address on mainnet'], [mkAddr(0, 0x11, true), 'bad checksum on mainnet'], ['bob@handcash.io', 'a paymail on mainnet'], [MAIN_A.slice(0, -1), 'truncated']] as const) {
    const d = e.evaluate(req({ network: 'main', to }));
    assert.equal(d.verdict, 'deny', why); assert.ok(d.codes.includes('address-network-mismatch'), why);
    assert.match(d.reasons.join(), /is not a mainnet address/, why);
  }
  const t = e.evaluate(req({ to: MAIN_A }));
  assert.equal(t.verdict, 'deny'); assert.ok(t.codes.includes('address-network-mismatch') && t.codes.includes('not-allowlisted'));
  for (const to of ['mtestAddressAlice1111111111111111', 'alice@example.com', mkAddr(0x6f, 0x11, true)]) { // B6: on testnet too, the recipient must be a valid TESTNET address
    const t2 = e.evaluate(req({ to })); assert.equal(t2.verdict, 'deny', to); assert.ok(t2.codes.includes('address-network-mismatch'), to);
  }
  const ok = e.evaluate(req({ network: 'main', to: MAIN_B })); assert.equal(ok.verdict, 'needs_approval');
  assert.equal(ok.card!.outputs[0]!.addressNetwork, 'main'); assert.equal(ok.card!.outputs[0]!.allowlisted, true);
  assert.equal(e.evaluate(req({ to: TEST_B })).card!.outputs[0]!.addressNetwork, 'test');
});

test('C30: the change output is not held to the payment rules, and mainnet allows one payment output only', () => {
  const { e } = engine(); e.arm(5);
  const two = req({ network: 'main' });
  two.decoded = { inputSats: 4_000 + 400 + 400 + 20, outputs: [{ recipient: MAIN_A, sats: 400 }, { recipient: MAIN_B, sats: 400 }, { recipient: 'wallet-change', sats: 4_000, change: true }], feeSats: 20 };
  const d = e.evaluate(two);
  assert.equal(d.verdict, 'deny'); assert.deepEqual(d.codes, ['too-many-outputs']);
  const fee = e.evaluate(req({ network: 'main', fee: 101 })); assert.deepEqual(fee.codes, ['fee-too-high']);
  const big = e.evaluate(req({ network: 'main', pay: 1_001 })); assert.deepEqual(big.codes, ['over-cap']);
  assert.equal(e.evaluate(req({ network: 'main', pay: 880, fee: 100 })).verdict, 'needs_approval', 'the mainnet fee ceiling is 100');
});

// ------------------------------------------------------------------ C31 (engine part): the wallet's network is pinned per request

test('C31: the wallet\'s claim must equal the request\'s network at propose; a different claim, or none, is refused with its own code', () => {
  const { e } = engine(); e.arm(5);
  const a = e.evaluate(req({ network: 'main', walletNetwork: 'test' })); assert.deepEqual(a.codes, ['wallet-network-mismatch']);
  const b = e.evaluate(req({ network: 'test', walletNetwork: 'main' })); assert.deepEqual(b.codes, ['wallet-network-mismatch']);
  const c = e.evaluate(req({ network: 'main', walletNetwork: 'unknown' })); assert.deepEqual(c.codes, ['wallet-network-unknown']);
  assert.equal(e.snapshot().nets.main.usage.reservedSats, 0, 'a refused request reserves nothing');
});

test('C31: a flip between propose and approve, in either direction, voids the card; flipping back does not revive it, and the reservation is freed', () => {
  for (const [net, to] of [['test', 'main'], ['main', 'test'], ['test', 'unknown'], ['main', 'unknown']] as const) {
    const { e } = engine(); e.arm(5);
    const d = e.evaluate(req({ network: net }));
    assert.equal(d.verdict, 'needs_approval', net);
    const r = e.approve(d.requestId, approveInput(d.card!, to));
    assert.equal(r.ok, false, `${net} -> ${to}`);
    assert.equal(e.status(d.requestId), 'denied', `${net} -> ${to}: void`);
    assert.equal(e.snapshot().nets[net].usage.reservedSats, 0);
    assert.equal(e.approve(d.requestId, approveInput(d.card!, net)).ok, false, 'not revived');
    assert.equal(e.isArmed(), true, 'a flip voids the card; it does not touch the arm (the module disarms on a reported change)');
  }
});

// ------------------------------------------------------------------ C28: arm needs the switch, expires, and covers exactly one mainnet spend

test('C28: arming is refused while the switch is off or the chain is frozen; enabling starts from zero', () => {
  const { e } = engine({ mainnet: false });
  assert.throws(() => e.arm(5), /switched off/);
  assert.equal(e.isArmed(), false);
  e.setMainnetEnabled(true);
  assert.doesNotThrow(() => e.arm(5));
  e.mainnetOff('test'); // disarms
  assert.equal(e.isArmed(), false);
  e.setMainnetEnabled(true);
  assert.equal(e.isArmed(), false, 'a switch turned back on is not armed');
  e.freeze('x');
  assert.throws(() => e.arm(5), /frozen/);
  assert.throws(() => e.setMainnetEnabled(true), /frozen/, 'enabling is refused while frozen');
  assert.throws(() => e.setMainnetEnabled('yes' as never), PolicyError);
});

test('C28: one arm covers exactly ONE mainnet spend: the approval consumes it, the next request is not-armed', () => {
  const { e, events } = engine(); e.arm(15);
  const a = e.evaluate(req({ network: 'main' })); assert.equal(a.verdict, 'needs_approval');
  const ok = e.approve(a.requestId, approveInput(a.card!, 'main')); assert.equal(ok.ok, true);
  assert.equal(e.isArmed(), false, 'consumed in the same step as the approval');
  assert.ok(events.some((x) => x.type === 'disarmed' && /one mainnet spend/.test(x.reason)));
  assert.equal(e.snapshot().armed, false);
  e.settle(a.requestId, { kind: 'executed', sats: 620 });
  const b = e.evaluate(req({ network: 'main' })); assert.deepEqual(b.codes, ['not-armed']);
  e.arm(5);
  assert.equal(e.evaluate(req({ network: 'main' })).verdict, 'needs_approval', 'a new arm, a new spend');
});

test('C28: two cards made under one arm: the first approval takes it, the second is refused and voided', () => {
  const { e } = engine(); e.arm(15);
  const a = e.evaluate(req({ network: 'main', pay: 300 })); const b = e.evaluate(req({ network: 'main', pay: 310 }));
  assert.equal(a.verdict, 'needs_approval'); assert.equal(b.verdict, 'needs_approval');
  assert.equal(e.approve(a.requestId, approveInput(a.card!, 'main')).ok, true);
  const r = e.approve(b.requestId, approveInput(b.card!, 'main'));
  assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /no longer armed/);
  assert.equal(e.status(b.requestId), 'denied');
});

test('C28: the arm expires on the tick (both clocks), and a testnet approval neither needs it nor uses it up', () => {
  const { e, clock } = engine(); e.arm(5);
  const t = e.evaluate(req()); assert.equal(e.approve(t.requestId, approveInput(t.card!)).ok, true);
  assert.equal(e.isArmed(), true, 'a testnet spend leaves the mainnet arm alone');
  clock.advance(5 * 60_000 - 1); assert.equal(e.isArmed(), true);
  const m = e.evaluate(req({ network: 'main' })); assert.equal(m.verdict, 'needs_approval');
  clock.advance(1); assert.equal(e.isArmed(), false, 'expired at the tick');
  const r = e.approve(m.requestId, approveInput(m.card!, 'main'));
  assert.equal(r.ok, false); assert.equal(e.status(m.requestId) === 'denied' || e.status(m.requestId) === 'expired', true);
  const { e: e2 } = engine(); assert.deepEqual(e2.evaluate(req({ network: 'main' })).codes, ['not-armed']);
  assert.equal(engine().e.evaluate(req()).verdict, 'needs_approval', 'testnet needs no arm');
});

test('C28: a switch turned off after the card was made refuses the approval and voids the card', () => {
  const { e } = engine(); e.arm(5);
  const d = e.evaluate(req({ network: 'main' }));
  e.mainnetOff('owner');
  assert.equal(e.status(d.requestId), 'denied', 'mainnetOff voids pending mainnet cards at once');
  const { e: e2 } = engine(); e2.arm(5);
  const d2 = e2.evaluate(req({ network: 'main' }));
  assert.equal(e2.setMainnetEnabled(false), undefined);
  assert.equal(e2.approve(d2.requestId, approveInput(d2.card!, 'main')).ok, false);
});

// ------------------------------------------------------------------ mainnetOff, voidPending

test('mainnetOff: turns the switch off, disarms, voids pending MAINNET cards only, runs the hook once and only on a real change', () => {
  const { e, events } = engine(); e.arm(5);
  const hook: string[] = []; e.setMainnetOffHook((r) => hook.push(r));
  const m = e.evaluate(req({ network: 'main' })); const t = e.evaluate(req());
  assert.equal(e.mainnetOff('the reason'), true);
  assert.equal(e.mainnetEnabled, false); assert.equal(e.isArmed(), false);
  assert.equal(e.status(m.requestId), 'denied'); assert.equal(e.status(t.requestId), 'pending', 'a testnet card is not touched');
  assert.deepEqual(hook, ['the reason']);
  assert.ok(events.some((x) => x.type === 'mainnet' && !x.enabled) && events.some((x) => x.type === 'voided' && x.net === 'main' && x.ids.includes(m.requestId)));
  assert.equal(e.mainnetOff('again'), false); assert.deepEqual(hook, ['the reason'], 'already off: no second hook call');
  assert.deepEqual(e.evaluate(req({ network: 'main' })).codes, ['mainnet-disabled']);
  // a hook that throws cannot undo the safety step
  const { e: e2 } = engine(); e2.setMainnetOffHook(() => { throw new Error('disk full'); });
  assert.doesNotThrow(() => e2.mainnetOff('x')); assert.equal(e2.mainnetEnabled, false);
  // setMainnetEnabled(false) is the same thing
  const { e: e3 } = engine(); e3.setMainnetEnabled(false); assert.equal(e3.mainnetEnabled, false);
});

test('voidPending: denies pending cards (one network or all), frees reservations, leaves approved spends to the spend path', () => {
  const { e, events } = engine(); e.arm(5);
  const t = e.evaluate(req()); const m = e.evaluate(req({ network: 'main' })); const t2 = e.evaluate(req({ pay: 100 }));
  e.approve(t2.requestId, approveInput(t2.card!));
  assert.deepEqual(e.voidPending('flip', 'test'), [t.requestId]);
  assert.equal(e.status(m.requestId), 'pending'); assert.equal(e.status(t2.requestId), 'approved');
  assert.deepEqual(e.voidPending('all'), [m.requestId]);
  assert.equal(e.status(t2.requestId), 'approved', 'an approved spend is mid-flight');
  assert.deepEqual(e.voidPending('nothing left'), []);
  assert.equal(e.snapshot().nets.main.usage.reservedSats, 0);
  assert.deepEqual(events.filter((x) => x.type === 'voided').map((x) => (x as { net: string }).net), ['test', 'all']);
});

// ------------------------------------------------------------------ C33 (engine part): auto-off

test('C33: a mainnet outcome that is unknown, or a post-sign mismatch, turns the switch off and disarms (testnet outcomes do not)', () => {
  const run = (how: (e: PolicyEngine, id: string) => void, net: 'test' | 'main') => {
    const { e } = engine(); e.arm(5);
    const d = e.evaluate(req({ network: net })); e.approve(d.requestId, approveInput(d.card!, net));
    how(e, d.requestId);
    return e;
  };
  for (const [name, how] of [
    ['settle unknown', (e: PolicyEngine, id: string) => e.settle(id, { kind: 'unknown' })],
    ['settle with a bad amount', (e: PolicyEngine, id: string) => e.settle(id, { kind: 'executed', sats: 'x' as never })],
    ['settle mismatch', (e: PolicyEngine, id: string) => e.settle(id, { kind: 'executed', sats: 999 })],
    ['freeze with the spend in flight', (e: PolicyEngine) => e.freeze('x')],
    ['execution window passed', (e: PolicyEngine) => { (e as unknown as { clock: FakeClock }).clock.advance(EXEC_TTL_MS + 1); e.sweep(); }],
  ] as const) {
    const e = run(how, 'main');
    assert.equal(e.mainnetEnabled, false, name); assert.equal(e.isArmed(), false, name);
    assert.equal(e.config().mainnetEnabled, false, `${name}: the saved config says off too`);
  }
  const f = run((e, id) => e.settle(id, { kind: 'failed' }), 'main'); assert.equal(f.mainnetEnabled, true, 'a spend that failed before signing is not an alarm');
  const ok = run((e, id) => e.settle(id, { kind: 'executed', sats: 620 }), 'main'); assert.equal(ok.mainnetEnabled, true);
  const t = run((e, id) => e.settle(id, { kind: 'unknown' }), 'test'); assert.equal(t.mainnetEnabled, true, 'a testnet unknown blocks spends but is not a mainnet alarm');
  assert.equal(t.isArmed(), true);
});

test('C33: a restart that finds an unknown spend (either network, or a net nobody recognises) starts with the switch OFF whatever the file said', () => {
  for (const net of ['main', 'MAIN', 'weird'] as const) {
    const e = new PolicyEngine({ config: { nets: engine().e.config().nets, frozen: null, mainnetEnabled: true }, unknown: [{ requestId: 'unk-req-0001', agentId: 'assayer', totalSats: 100, net }] });
    assert.equal(e.mainnetEnabled, false, net);
  }
  const t = new PolicyEngine({ config: { nets: engine().e.config().nets, frozen: null, mainnetEnabled: true }, unknown: [{ requestId: 'unk-req-0002', agentId: 'assayer', totalSats: 100, net: 'test' }] });
  assert.equal(t.mainnetEnabled, true, 'a testnet unknown leaves the switch as the file had it');
});

// ------------------------------------------------------------------ C34: an unknown outcome blocks both networks

test('C34: an unknown outcome on testnet blocks mainnet, and the reverse; resolving it clears both', () => {
  for (const [first, second] of [['test', 'main'], ['main', 'test']] as const) {
    const { e } = engine(); e.arm(60);
    const u = e.evaluate(req({ network: first })); e.approve(u.requestId, approveInput(u.card!, first));
    const pend = e.evaluate(req({ network: second }));
    assert.equal(pend.verdict, 'needs_approval', 'made before the unknown');
    e.settle(u.requestId, { kind: 'unknown' });
    e.mainnetEnabled || e.setMainnetEnabled(true); // a mainnet unknown switched it off: this test is about the block, so turn it on
    e.arm(60);
    const blocked = e.evaluate(req({ network: second }));
    assert.equal(blocked.verdict, 'deny', `${first} unknown blocks ${second}`); assert.ok(blocked.codes.includes('unknown-outcome-pending'));
    const late = e.approve(pend.requestId, approveInput(pend.card!, second));
    assert.equal(late.ok, false, 'a card made earlier cannot be approved either'); assert.match((late as { reason: string }).reason, /unknown outcome/);
    assert.equal(e.snapshot().unknown.length, 1);
    assert.equal(e.resolveUnknown(u.requestId, { kind: 'not-sent' }), true);
    assert.equal(e.evaluate(req({ network: second })).verdict, 'needs_approval', 'resolved: spends work again');
  }
});

test('C34: an unknown outcome seeded at start (restart) blocks both networks until it is resolved; its net and reservation are kept', () => {
  for (const net of ['test', 'main'] as const) {
    const base = engine().e.config();
    const e = new PolicyEngine({ config: { ...base, mainnetEnabled: true }, unknown: [{ requestId: 'seed-unk-0001', agentId: 'assayer', totalSats: 700, net }] });
    if (e.mainnetEnabled) e.arm(5); else { e.setMainnetEnabled(true); e.arm(5); }
    for (const target of ['test', 'main'] as const) assert.ok(e.evaluate(req({ network: target })).codes.includes('unknown-outcome-pending'), `${net} seed blocks ${target}`);
    assert.equal(e.snapshot().nets[net].usage.reservedSats, 700, 'the reservation stays on its own network');
    assert.equal(e.snapshot().nets[net === 'test' ? 'main' : 'test'].usage.reservedSats, 0);
    assert.equal(e.resolveUnknown('seed-unk-0001', { kind: 'sent', sats: 700 }), true);
    assert.equal(e.snapshot().nets[net].usage.last24hSats, 700, 'a resolved-as-sent spend lands in its own ledger');
    assert.equal(e.snapshot().nets[net === 'test' ? 'main' : 'test'].usage.last24hSats, 0);
  }
});

// ------------------------------------------------------------------ the card and the snapshot

test('the card carries its network, label, per-network remaining caps, and the confirmations for mainnet (live funds) and a tainted run', () => {
  const { e } = engine(); e.arm(5);
  const m = e.evaluate(req({ network: 'main', tainted: true }));
  assert.equal(m.card!.network, 'main'); assert.equal(m.card!.networkLabel, NET.main.label);
  assert.deepEqual(m.requiredConfirmations, ['approve', 'untrusted-content', 'live-funds']);
  assert.deepEqual(m.card!.remaining, { perTxSats: 380, perSessionSats: 1380, per24hSats: 4380 });
  assert.match(m.card!.warnings.join(' '), /LIVE FUNDS/);
  const t = e.evaluate(req());
  assert.equal(t.card!.networkLabel, 'TESTNET'); assert.deepEqual(t.requiredConfirmations, ['approve']);
  assert.deepEqual(t.card!.remaining, { perTxSats: 380, perSessionSats: 4380, per24hSats: 9380 });
  assert.notEqual(m.card!.hash, t.card!.hash);
});

test('snapshot: per-network views (caps, hard ceilings, allowlist, usage, label), the mainnet switch, and the testnet mirror that older readers use', () => {
  const { e } = engine({ mainnet: false });
  const s = e.snapshot();
  assert.equal(s.mainnetEnabled, false);
  assert.deepEqual(Object.keys(s.nets).sort(), ['main', 'test']);
  assert.deepEqual(s.nets.main.hardCaps, { ...NET.main.hardCaps }); assert.deepEqual(s.nets.main.allowlist, [MAIN_A, MAIN_B]); assert.equal(s.nets.main.label, NET.main.label);
  assert.deepEqual(s.caps, s.nets.test.caps); assert.deepEqual(s.allowlist, s.nets.test.allowlist); assert.deepEqual(s.hardCaps, s.nets.test.hardCaps);
  assert.deepEqual(s.usage, { ...s.nets.test.usage, invalidNetRecords: 0 });
  s.nets.main.caps.perTxSats = 1; s.nets.main.allowlist.length = 0;
  assert.equal(e.snapshot().nets.main.caps.perTxSats, 1000, 'a copy: what a caller does to it changes nothing');
});

test('decision codes: one per failing check, in a fixed vocabulary, repeated for a duplicate request, and never empty for a deny', () => {
  const { e } = engine({ mainnet: false });
  const r = req({ network: 'main', walletNetwork: 'unknown', to: TEST_A, pay: 5_000 });
  const d = e.evaluate(r);
  assert.deepEqual(d.codes, ['wallet-network-unknown', 'mainnet-disabled', 'not-allowlisted', 'address-network-mismatch', 'over-cap']);
  assert.equal(new Set(d.codes).size, d.codes.length);
  assert.deepEqual(e.evaluate(r).codes, d.codes); assert.equal(e.evaluate(r).duplicate, true);
  const bad = e.evaluate({ ...req(), decoded: { inputSats: 1, outputs: [], feeSats: 0 } }); assert.deepEqual([...new Set(bad.codes)], ['bad-request']);
  assert.deepEqual(e.evaluate({ ...req(), requestId: 'x' }).codes, ['bad-request']);
  e.freeze('x'); assert.deepEqual(e.evaluate(req()).codes, ['frozen']);
  const f = engine({ mainnet: true }); f.e.arm(5);
  assert.deepEqual(f.e.evaluate(req({ network: 'main' })).codes, [], 'a needs_approval has no code');
});

test('round trip: what config() says, saved and loaded, gives an engine with the same per-network state; the switch survives only as an explicit true', () => {
  const { e } = engine();
  e.setCaps({ perTxSats: 500 }, 'main'); e.setAllowlist([MAIN_B], 'main'); e.setCaps({ perTxSats: 700 });
  const dir = mkdtempSync(join(tmpdir(), 'legion-nets-')); const f = join(dir, 'policy.json');
  savePolicyConfig(f, e.config());
  const e2 = new PolicyEngine({ config: loadPolicyConfig(f).config });
  assert.deepEqual(e2.config().nets, e.config().nets); assert.equal(e2.mainnetEnabled, true);
  const disk = JSON.parse(readFileSync(f, 'utf8'));
  for (const bad of ['true', 1, 'yes', null, {}, [true], 'TRUE']) {
    writeFileSync(f, JSON.stringify({ ...disk, mainnetEnabled: bad }));
    assert.equal(loadPolicyConfig(f).config.mainnetEnabled, false, JSON.stringify(bad));
  }
  assert.equal(new PolicyEngine({ config: { mainnetEnabled: 'true' as never } }).mainnetEnabled, false);
});

test('C26 (engine part): the network is one of two literals; anything else (a look-alike, a missing value, an extra word) is refused as a bad request and reserves nothing', () => {
  const { e } = engine(); e.arm(5);
  for (const n of ['mainnet', 'Main', 'live', 'test ', '', undefined, null, 1, ['main'], { v: 'main' }]) {
    const d = e.evaluate({ ...req(), network: n as never });
    assert.equal(d.verdict, 'deny', String(n)); assert.deepEqual([...new Set(d.codes)], ['bad-request']);
    assert.match(d.reasons.join(), /network must be test or main/, String(n));
  }
  const w = e.evaluate({ ...req(), walletNetwork: 'mainnet' as never });
  assert.equal(w.verdict, 'deny'); assert.match(w.reasons.join(), /wallet network is not valid/);
  assert.equal(e.snapshot().nets.test.usage.reservedSats + e.snapshot().nets.main.usage.reservedSats, 0);
});
