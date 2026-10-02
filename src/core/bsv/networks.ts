/**
 * The network table: the one place that says what each BSV network means for Legion's spend limits and address checks. DATA AND TWO PURE
 * FUNCTIONS, nothing else: no I/O, no clock, no network, no process access (only node:crypto for the address checksum).
 *
 * `Net` is `test` or `main`. The owner-facing label, the base58check version byte of a P2PKH address, the default limits, the hard ceilings
 * (raised by a code change only, never by a file or an API call) and the allowlist size are looked up here through `NET[net]`, so the code
 * that spends can take the network as an opaque value and never spell it out.
 *
 * What this file cannot do: a P2PKH script is the same bytes on both networks, so the network is not visible in a transaction. The version
 * byte of the address the owner or an agent typed is evidence about the owner's intent, not about the wallet. Legion rests on the wallet's
 * own claim (pinned per request by the spend path), the per-network allowlists, the version byte and the owner reading the network word in
 * the dialog. The mainnet version byte and the testnet one are standard and public; whether a given wallet follows them is checked by the
 * owner's own run (see claude/plan-bsv-rung3.md, U12).
 */
import { createHash } from 'node:crypto';

export type Net = 'test' | 'main';

export interface Caps { perTxSats: number; perSessionSats: number; per24hSats: number; maxOutputs: number; maxFeeSats: number }

export interface NetInfo {
  /** What the owner reads in a dialog or on a card. */
  readonly label: string;
  /** True when a spend on this network moves real money (the spend path asks this instead of naming a network). */
  readonly liveFunds: boolean;
  /** The first byte of a base58check P2PKH address on this network. */
  readonly versionByte: number;
  /** Tiny on purpose. */
  readonly defaultCaps: Readonly<Caps>;
  /** The ceiling of every cap on this network. Only a code change raises it. */
  readonly hardCaps: Readonly<Caps>;
  /** The longest recipient allowlist this network may have. */
  readonly maxAllowlist: number;
}

const caps = (c: Caps): Readonly<Caps> => Object.freeze({ ...c });

export const NET: Readonly<Record<Net, NetInfo>> = Object.freeze({
  test: Object.freeze({
    label: 'TESTNET',
    liveFunds: false,
    versionByte: 0x6f,
    defaultCaps: caps({ perTxSats: 1_000, perSessionSats: 5_000, per24hSats: 10_000, maxOutputs: 3, maxFeeSats: 200 }),
    hardCaps: caps({ perTxSats: 1_000_000, perSessionSats: 5_000_000, per24hSats: 10_000_000, maxOutputs: 10, maxFeeSats: 10_000 }),
    maxAllowlist: 50,
  }),
  main: Object.freeze({
    label: 'LIVE FUNDS (main network)',
    liveFunds: true,
    versionByte: 0x00,
    // lower than testnet on purpose: real money, and one payment output per spend
    defaultCaps: caps({ perTxSats: 1_000, perSessionSats: 2_000, per24hSats: 5_000, maxOutputs: 1, maxFeeSats: 100 }),
    hardCaps: caps({ perTxSats: 100_000, perSessionSats: 250_000, per24hSats: 500_000, maxOutputs: 1, maxFeeSats: 1_000 }),
    maxAllowlist: 10,
  }),
});

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

/**
 * A base58check P2PKH address: 25 bytes (version, 20-byte hash, 4-byte double-SHA-256 checksum). Anything else, a wrong length, a character
 * outside the alphabet, a bad checksum, a version byte that belongs to no network in the table: null. Never throws.
 */
export function decodeAddress(address: unknown): { version: number; hash160: Uint8Array } | null {
  if (typeof address !== 'string' || address.length < 26 || address.length > 35) return null;
  const bytes: number[] = []; // little endian while accumulating
  for (const ch of address) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i]! * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < address.length && address[i] === '1'; i++) bytes.push(0);
  if (bytes.length !== 25) return null;
  bytes.reverse();
  const body = Uint8Array.from(bytes.slice(0, 21));
  const check = sha256(sha256(body)).subarray(0, 4);
  for (let i = 0; i < 4; i++) if (check[i] !== bytes[21 + i]) return null;
  const version = bytes[0]!;
  if (version !== NET.test.versionByte && version !== NET.main.versionByte) return null;
  return { version, hash160: body.slice(1) };
}

/** Which network an address belongs to by its version byte, or null when it is not a valid address of a known network. */
export function addressNet(address: unknown): Net | null {
  const d = decodeAddress(address);
  if (!d) return null;
  return d.version === NET.main.versionByte ? 'main' : 'test';
}
