/**
 * decodeSignable / p2pkhScript / encodeAddress: fail-closed, bounded, values from the parents only. Layouts follow BRC-62 (BEEF V1),
 * BRC-96 (V2: the BUMP index comes BEFORE the raw transaction), BRC-95 (Atomic prefix 01010101 + subject txid) and BRC-74 (BUMP).
 * The fixtures are built by test/bsv-fake-wallet.ts, an encoder written independently of the decoder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSignable, encodeAddress, p2pkhScript } from '../src/core/bsv/spend.js';
import { NET } from '../src/core/bsv/networks.js';
import { beef, bump, dataScript, p2pkhOf, rawTx, txidOf } from './bsv-fake-wallet.js';
import { MAIN_A, TEST_A, mkAddr } from './bsv-net-helpers.js';

const parent = rawTx([{ prevTxid: 'aa'.repeat(32), vout: 0, script: Buffer.from([0x51]) }], [{ sats: 10_000, script: p2pkhOf(0x55) }, { sats: 777, script: p2pkhOf(0x56) }]);
const target = (outs = [{ sats: 600, script: p2pkhOf(0x11) }, { sats: 9_380, script: p2pkhOf(0x77) }]) => rawTx([{ prevTxid: txidOf(parent), vout: 0 }], outs);

test('decoder: Atomic BEEF V1, V2, plain BEEF, with and without a BUMP: inputs come from the parent, the fee is inputs minus outputs', () => {
  const t = target();
  for (const o of [{ atomic: true }, { atomic: false }, { v2: true, atomic: true }, { v2: true, atomic: false }, { atomic: true, atomicTxidReversed: true }]) {
    const d = decodeSignable(beef([{ raw: parent }, { raw: t }], o))!;
    assert.ok(d, JSON.stringify(o));
    assert.equal(d.inputSats, 10_000); assert.equal(d.feeSats, 20); assert.deepEqual(d.outputs.map((x) => x.sats), [600, 9_380]); assert.equal(d.txid, txidOf(t));
  }
  for (const v2 of [false, true]) assert.ok(decodeSignable(beef([{ raw: parent, bumpIndex: 0 }, { raw: t }], { v2, bumps: [bump()] })), `bump v2=${v2}`);
});

test('decoder: refuses (null, never a throw) what it cannot check', () => {
  const t = target();
  const good = beef([{ raw: parent }, { raw: t }], { atomic: true });
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)], ['garbage', Buffer.from('not a transaction at all')], ['wrong magic', Buffer.concat([Buffer.from([3, 0, 0xbe, 0xef]), good.subarray(4)])],
    ['no parent', beef([{ raw: t }], { atomic: true })], ['parent as bare txid', beef([{ raw: parent, txidOnly: true }, { raw: t }], { v2: true, atomic: true })],
    ['wrong atomic subject', Buffer.concat([good.subarray(0, 4), Buffer.alloc(32, 9), good.subarray(36)])],
    ['spends a missing output', beef([{ raw: parent }, { raw: rawTx([{ prevTxid: txidOf(parent), vout: 5 }], [{ sats: 1, script: p2pkhOf(1) }]) }])],
    ['outputs above inputs', beef([{ raw: parent }, { raw: target([{ sats: 10_001, script: p2pkhOf(1) }]) }])],
    ['a zero-sat output', beef([{ raw: parent }, { raw: target([{ sats: 0, script: dataScript() }, { sats: 9_980, script: p2pkhOf(1) }]) }])],
    ['duplicate parent', beef([{ raw: parent }, { raw: parent }, { raw: t }])], ['trailing byte', Buffer.concat([good, Buffer.from([0])])],
    ['bump index out of range', beef([{ raw: parent, bumpIndex: 3 }, { raw: t }], { bumps: [bump()] })],
    ['truncated', good.subarray(0, good.length - 7)], ['oversize', Buffer.alloc(300 * 1024, 1)],
  ];
  for (const [name, bytes] of cases) assert.equal(decodeSignable(bytes), null, name);
  // 101 outputs, 101 inputs
  const many = target(Array.from({ length: 101 }, (_, i) => ({ sats: 1, script: p2pkhOf(i) })));
  assert.equal(decodeSignable(beef([{ raw: parent }, { raw: many }])), null, '101 outputs');
});

test('decoder: 400 fuzzed mutations of a good BEEF never throw and never decode to a different fee (bounded time)', () => {
  const good = beef([{ raw: parent }, { raw: target() }], { atomic: true });
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const t0 = Date.now(); let decoded = 0;
  for (let i = 0; i < 400; i++) {
    const b = Buffer.from(good);
    const mode = i % 4;
    if (mode === 0) b[rnd() % b.length] = rnd() & 0xff;
    else if (mode === 1) { b[rnd() % 40] = 0xff; }
    else if (mode === 2) return_(b.subarray(0, rnd() % b.length));
    else { b[(rnd() % b.length)] ^= 1 << (rnd() % 8); }
    function return_(x: Uint8Array) { const d = decodeSignable(x); assert.ok(d === null || d.feeSats >= 0); }
    const d = decodeSignable(b);
    if (d) { decoded++; assert.ok(d.feeSats >= 0 && d.inputSats >= d.feeSats); }
  }
  assert.ok(Date.now() - t0 < 5000, 'time bounded');
  assert.ok(decoded < 400);
  // a varint that claims 2^53 transactions
  assert.equal(decodeSignable(Buffer.concat([Buffer.from([1, 0, 0xbe, 0xef, 0]), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00])])), null);
});

test('p2pkhScript / encodeAddress: the version byte must equal the network, a bad checksum or another network is null, and the encoder round-trips', () => {
  const s = p2pkhScript(TEST_A, 'test' as never)!;
  assert.deepEqual([...s], [...p2pkhOf(0x11)]);
  assert.equal(p2pkhScript(TEST_A, 'main' as never), null, 'a testnet address on the main network');
  assert.equal(p2pkhScript(MAIN_A, 'test' as never), null);
  assert.deepEqual([...p2pkhScript(MAIN_A, 'main' as never)!], [...p2pkhOf(0x11)], 'the script bytes are the same on both networks');
  assert.equal(p2pkhScript(mkAddr(0x6f, 0x11, true), 'test' as never), null, 'bad checksum');
  assert.equal(p2pkhScript(TEST_A + ' ', 'test' as never), null); assert.equal(p2pkhScript('', 'test' as never), null);
  assert.equal(p2pkhScript(TEST_A.replace('m', 'l'), 'test' as never), null);
  for (const net of ['test', 'main'] as const) { const a = encodeAddress(p2pkhOf(0x42).subarray(3, 23), net); assert.equal(a, mkAddr(NET[net].versionByte, 0x42)); }
});
