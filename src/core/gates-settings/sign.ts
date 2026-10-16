/**
 * Signing for the gate settings files (spec 4.1). The key is the connectors' persistent data key (the per-launch secrets change on
 * every start, so they cannot sign files that must survive a restart). Legion derives its own sub-key with HKDF, so the data key
 * itself is never used as a MAC key. The signature covers the file name too, so one file cannot be copied over another.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { GateSettings } from '../../shared/gates-registry.js';

export interface Signer {
  sign(name: string, canonical: string): string;
  verify(name: string, canonical: string, sig: string): boolean;
}

/** The settings as JSON with every object's keys in sorted order, so the same settings always sign the same. */
export function canonicalize(s: GateSettings): string {
  const sorted = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)]))
    : Array.isArray(v) ? v.map(sorted) : v;
  return JSON.stringify(sorted(s));
}

/** No signer without a 32-byte key: the caller then fails closed (only Ask can be stored). */
export function makeSigner(key: Buffer | undefined): Signer | undefined {
  if (!key || key.length !== 32) return undefined;
  const k = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'legion-gates-v1', 32));
  const mac = (name: string, c: string): Buffer => createHmac('sha256', k).update(`${name}\n${c}`).digest();
  return {
    sign: (name, c) => mac(name, c).toString('hex'),
    verify: (name, c, sig) => {
      try {
        if (!/^[0-9a-f]{64}$/.test(sig)) return false;
        const a = mac(name, c); const b = Buffer.from(sig, 'hex');
        return a.length === b.length && timingSafeEqual(a, b);
      } catch { return false; }
    },
  };
}
