/**
 * The connectors' data key on the Electron side (design 4.4). Pure functions over an injected safeStorage-shaped object, so they are
 * unit-tested in plain node (this file does not import electron).
 *
 * - The key is 256 random bits, created LAZILY on the first Connect (never at app start, so someone who never connects gets no Keychain
 *   prompt) and wrapped with the OS keystore (`encryptStringAsync`) into `<dataDir>/connectors/key.bin`.
 * - A launch only reads `key.bin` if it exists; with no file there is no safeStorage call at all.
 * - Linux with the `basic_text` or `unknown` backend: nothing is written (Chromium's plain-text fallback is not protection).
 * - A wrapped key that decrypts with `shouldReEncrypt` is wrapped again.
 * - The key reaches the core as one line on its stdin pipe, `KEY <64 hex>`: never env, argv, disk (unwrapped) or the renderer.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(wrapped: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

export const KEY_FILE = 'key.bin';
export const keyFilePath = (dataDir: string): string => join(dataDir, 'connectors', KEY_FILE);
const HEX_KEY = /^[0-9a-f]{64}$/;

/** False on Linux when the keystore is only the plain-text fallback. */
export function keystoreUsable(ss: SafeStorageLike, platform: string = process.platform): boolean {
  if (platform !== 'linux') return true;
  const b = ss.getSelectedStorageBackend?.();
  return b !== undefined && b !== 'basic_text' && b !== 'unknown';
}

function writeAtomic(file: string, data: Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* none left over */ }
  writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  try { renameSync(tmp, file); } catch {
    try { unlinkSync(file); } catch { /* ignore */ }
    renameSync(tmp, file);
  }
}

/** The key as hex, or undefined: no `key.bin` (no safeStorage call is made), keystore unusable, or the file does not unwrap. Never throws. */
export async function loadConnectorKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string | undefined> {
  const file = keyFilePath(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    if (!keystoreUsable(ss, platform) || !(await ss.isAsyncEncryptionAvailable())) return undefined;
    const r = await ss.decryptStringAsync(readFileSync(file));
    if (!HEX_KEY.test(r.result)) return undefined;
    if (r.shouldReEncrypt) writeAtomic(file, await ss.encryptStringAsync(r.result));
    return r.result;
  } catch { return undefined; }
}

/** First Connect: makes and wraps a new key (or returns the existing one). undefined when the keystore cannot be used: connectors then stay memory-only. */
export async function ensureConnectorKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string | undefined> {
  const existing = await loadConnectorKey(dataDir, ss, platform);
  if (existing) return existing;
  if (existsSync(keyFilePath(dataDir))) return undefined; // a file we cannot unwrap is never overwritten: that would orphan stored tokens silently
  try {
    if (!keystoreUsable(ss, platform) || !(await ss.isAsyncEncryptionAvailable())) return undefined;
    const hex = randomBytes(32).toString('hex');
    writeAtomic(keyFilePath(dataDir), await ss.encryptStringAsync(hex));
    return hex;
  } catch { return undefined; }
}

/** The line written to the core's stdin after the two secrets. */
export const keyLine = (hex: string): string => `KEY ${hex}\n`;
