/**
 * Shared fixtures for the per-network policy tests (not a test file: the runner only loads *.test.js).
 * Addresses are built here from fixed 20-byte patterns, so there is no key behind any of them, and the encoder is independent of the decoder in
 * src/core/bsv/networks.ts that the tests check.
 */
import { createHash } from 'node:crypto';
import { NET } from '../src/core/bsv/networks.js';
import { PolicyEngine } from '../src/core/bsv/policy.js';
import type { Clock, Net, PolicyEvent, SpendRequest } from '../src/core/bsv/policy.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58check of version byte + 20 bytes of `fill`. `badChecksum` flips the last checksum byte. */
export function mkAddr(version: number, fill: number, badChecksum = false): string {
  const body = Buffer.concat([Buffer.from([version]), Buffer.alloc(20, fill)]);
  const sum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  if (badChecksum) sum[3] = sum[3]! ^ 0xff;
  const all = Buffer.concat([body, sum]);
  let n = BigInt('0x' + all.toString('hex')); let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)]! + out; n /= 58n; }
  for (const b of all) { if (b === 0) out = '1' + out; else break; }
  return out;
}

export const MAIN_A = mkAddr(NET.main.versionByte, 0x11);
export const MAIN_B = mkAddr(NET.main.versionByte, 0x22);
export const TEST_A = mkAddr(NET.test.versionByte, 0x11);
export const TEST_B = mkAddr(NET.test.versionByte, 0x22);

export class FakeClock implements Clock {
  w = 1_800_000_000_000; m = 5_000;
  wall() { return this.w; } mono() { return this.m; }
  advance(ms: number) { this.w += ms; this.m += ms; }
}

let n = 0;
/** A balanced 600-sat payment with a 20-sat fee and change, for `network` (default test), to that network's first fixture address. */
export function req(over: Partial<SpendRequest> & { pay?: number; fee?: number; to?: string } = {}): SpendRequest {
  const net: Net = over.network ?? 'test';
  const pay = over.pay ?? 600; const fee = over.fee ?? 20;
  const { pay: _p, fee: _f, to, ...rest } = over;
  return {
    requestId: `net-${String(++n).padStart(7, '0')}`, network: net, walletNetwork: net, agentId: 'assayer', taskId: 'task-1',
    reason: 'pay the faucet back', tainted: false,
    decoded: { inputSats: pay + fee + 4000, outputs: [{ recipient: to ?? (net === 'main' ? MAIN_A : TEST_A), sats: pay }, { recipient: net === 'main' ? MAIN_B : TEST_B, sats: 4000, change: true }], feeSats: fee },
    ...rest,
  };
}

export const approveInput = (card: { hash: string; requiredConfirmations: string[] }, wn: Net | 'unknown' = 'test') => ({ cardHash: card.hash, confirmations: card.requiredConfirmations, walletNetwork: wn });

/** An engine with BOTH networks' allowlists holding the fixture addresses and the mainnet switch ON (unless `mainnet: false`). */
export function engine(o: { mainnet?: boolean; clock?: FakeClock; ledger?: Array<{ requestId: string; sats: number; at: number; net?: Net }>; allowTest?: string[]; allowMain?: string[] } = {}) {
  const clock = o.clock ?? new FakeClock();
  const events: PolicyEvent[] = [];
  const e = new PolicyEngine({
    clock, sessionId: 'sess1', ledger: o.ledger, onEvent: (ev) => events.push(ev),
    config: { nets: { test: { caps: { ...NET.test.defaultCaps }, allowlist: o.allowTest ?? [TEST_A, TEST_B] }, main: { caps: { ...NET.main.defaultCaps }, allowlist: o.allowMain ?? [MAIN_A, MAIN_B] } }, frozen: null, mainnetEnabled: o.mainnet ?? true },
  });
  return { e, clock, events };
}
