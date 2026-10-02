/**
 * Saves and loads the part of the policy that is allowed to persist: caps, allowlist and the frozen flag. Arming is never saved.
 * What comes back from disk is run through sanitizePolicyConfig, so a hand-edited file cannot raise a cap past the hard ceiling or
 * smuggle in a field. A file that exists but cannot be read counts as tampering and loads FROZEN (fail closed), not as defaults.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CAPS, sanitizePolicyConfig } from './policy.js';
import type { PolicyConfig } from './policy.js';

export const policyPath = (dataDir: string): string => join(dataDir, 'bsv', 'policy.json');

export interface LoadedPolicy { config: PolicyConfig; /** The file existed but could not be read. */ unreadable: boolean }

export function loadPolicyConfig(file: string): LoadedPolicy {
  if (!existsSync(file)) return { config: sanitizePolicyConfig(undefined), unreadable: false };
  try {
    return { config: sanitizePolicyConfig(JSON.parse(readFileSync(file, 'utf8'))), unreadable: false };
  } catch {
    const base = sanitizePolicyConfig(undefined);
    return { config: { ...base, caps: { ...DEFAULT_CAPS }, frozen: { at: new Date().toISOString(), reason: 'the policy file could not be read' } }, unreadable: true };
  }
}

/** Writes through a temporary file and a rename, so a crash leaves the old file or the new one, never half of one. Throws on failure. */
export function savePolicyConfig(file: string, cfg: PolicyConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not supported everywhere */ }
}
