/**
 * Saves and loads the part of the policy that is allowed to persist: per-network caps and allowlists, the mainnet switch and the frozen
 * flag. Arming is never saved. What comes back from disk is run through sanitizePolicyConfig, so a hand-edited file cannot raise a cap
 * past a hard ceiling or smuggle in a field. A file that exists but cannot be read counts as tampering and loads FROZEN (fail closed), not
 * as defaults, and always with mainnet OFF. The switch lives inside this file, so the module's sha256 check of the file (index.ts: the hash
 * Legion last wrote is recorded in the audit log) is what notices a hand edit of it.
 *
 * File shape (version 2): `{version, nets: {test: {caps, allowlist}, main: {caps, allowlist}}, mainnetEnabled, frozen}`. A version-1 file
 * (testnet-only: top-level `caps` and `allowlist`) still loads, as the testnet limits; it is rewritten in the new shape on the next save.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildPolicyConfig, policyFileShape, sanitizePolicyConfig } from './policy.js';
import type { PolicyConfig } from './policy.js';

export const policyPath = (dataDir: string): string => join(dataDir, 'bsv', 'policy.json');

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export interface LoadedPolicy {
  config: PolicyConfig;
  /** The file existed but could not be read. */
  unreadable: boolean;
  /** sha256 of the file's exact bytes, or null when there is no file (or it could not be read at all). */
  hash: string | null;
}

export function loadPolicyConfig(file: string): LoadedPolicy {
  if (!existsSync(file)) return { config: sanitizePolicyConfig(undefined), unreadable: false, hash: null };
  try {
    const raw = readFileSync(file);
    const hash = sha256(raw);
    try { return { config: sanitizePolicyConfig(JSON.parse(raw.toString('utf8'))), unreadable: false, hash }; } catch { return { config: unreadableConfig(), unreadable: true, hash }; }
  } catch {
    return { config: unreadableConfig(), unreadable: true, hash: null };
  }
}

/** sha256 of the file as it is on disk now: null when there is no file, undefined when it cannot be read. */
export function policyFileHash(file: string): string | null | undefined {
  if (!existsSync(file)) return null;
  try { return sha256(readFileSync(file)); } catch { return undefined; }
}

/** The state a policy file that cannot be trusted loads as: default caps and no allowlist on both networks, mainnet OFF, frozen. */
export function untrustedConfig(reason: string): PolicyConfig {
  return buildPolicyConfig(sanitizePolicyConfig(undefined).nets, { at: new Date().toISOString(), reason }, false);
}
const unreadableConfig = (): PolicyConfig => untrustedConfig('the policy file could not be read');

/** Writes through a temporary file and a rename, so a crash leaves the old file or the new one, never half of one. Throws on failure. Returns the sha256 of what was written. */
export function savePolicyConfig(file: string, cfg: Partial<PolicyConfig>): string {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const text = JSON.stringify(policyFileShape(cfg), null, 2);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not supported everywhere */ }
  return sha256(text);
}
