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
import { renameWithRetry } from '../shared/rename-retry.js';

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
  try { renameWithRetry(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; } // never a moment with no key file
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

// The gates key: signs the gate settings files. Its own file and its own launch line, so signing never waits for a GitHub Connect.
export const GATES_KEY_FILE = 'gates-key.bin';
export const gatesKeyFilePath = (dataDir: string): string => join(dataDir, GATES_KEY_FILE);

/** The gates key as hex, or undefined (no file, keystore unusable, does not unwrap). Never throws. */
export async function loadGatesKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string | undefined> {
  const file = gatesKeyFilePath(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    if (!keystoreUsable(ss, platform) || !(await ss.isAsyncEncryptionAvailable())) return undefined;
    const r = await ss.decryptStringAsync(readFileSync(file));
    if (!HEX_KEY.test(r.result)) return undefined;
    if (r.shouldReEncrypt) writeAtomic(file, await ss.encryptStringAsync(r.result));
    return r.result;
  } catch { return undefined; }
}

/** Makes and wraps the gates key on first need, or returns the existing one. undefined when no usable keystore exists: only Ask can be stored then. */
export async function ensureGatesKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string | undefined> {
  const existing = await loadGatesKey(dataDir, ss, platform);
  if (existing) return existing;
  if (existsSync(gatesKeyFilePath(dataDir))) return undefined; // never overwrite a file we cannot unwrap: that would orphan every signed file
  try {
    if (!keystoreUsable(ss, platform) || !(await ss.isAsyncEncryptionAvailable())) return undefined;
    const hex = randomBytes(32).toString('hex');
    writeAtomic(gatesKeyFilePath(dataDir), await ss.encryptStringAsync(hex));
    return hex;
  } catch { return undefined; }
}
/** Decided BEFORE the key file is made: `old` if it is there, `lost` if it is not but the data folder is in use, `new` for an empty data folder. */
export type GatesKeyState = 'new' | 'old' | 'lost' | 'unreadable';
export function gatesKeyState(dataDir: string): GatesKeyState {
  if (existsSync(gatesKeyFilePath(dataDir))) return 'old';
  return ['projects.json', 'state.json', 'gates'].some((n) => existsSync(join(dataDir, n))) ? 'lost' : 'new';
}
export const gatesKeyLine = (hex: string | undefined, state: GatesKeyState = 'old'): string => hex ? `GATESKEY ${hex} ${state}
` : `GATESKEY - unreadable
`;

/** The line written to the core's stdin after the two secrets. */
export const keyLine = (hex: string): string => `KEY ${hex}\n`;

// The provider keys' data key: seals providers/keys.enc. Its own file inside the protected providers folder and its own launch line, so
// a lost gates or connectors key never takes the provider keys with it. Made at launch (the core needs it before the first key is saved).
export const PROVIDER_KEY_FILE = 'key.bin';
export const providerKeyFilePath = (dataDir: string): string => join(dataDir, 'providers', PROVIDER_KEY_FILE);

/** The provider data key as hex, or undefined (no usable keystore, or a wrapped key that does not unwrap). Never throws. */
export async function loadProviderKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string | undefined> {
  const file = providerKeyFilePath(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    if (!keystoreUsable(ss, platform) || !(await ss.isAsyncEncryptionAvailable())) return undefined;
    const r = await ss.decryptStringAsync(readFileSync(file));
    if (!HEX_KEY.test(r.result)) return undefined;
    if (r.shouldReEncrypt) writeAtomic(file, await ss.encryptStringAsync(r.result));
    return r.result;
  } catch { return undefined; }
}

/** True when the system key store can be used right now (usable backend and async encryption available). Never throws. */
export async function providerKeyStoreReady(ss: SafeStorageLike, platform: string = process.platform): Promise<boolean> {
  try { return keystoreUsable(ss, platform) && (await ss.isAsyncEncryptionAvailable()); } catch { return false; }
}

/** True when the key.bin that is there unwraps right now. A core that started while the key store was locked said "unreadable"; this is the re-check. Never throws, never writes anything but a re-wrap. */
export async function providerKeyUnlocks(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<boolean> {
  return !!(await loadProviderKey(dataDir, ss, platform));
}

/** Makes and wraps the key on first need, or returns the existing one. A file that does not unwrap is NEVER overwritten (it would orphan keys.enc). */
export async function ensureProviderKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string | undefined> {
  const existing = await loadProviderKey(dataDir, ss, platform);
  if (existing) return existing;
  if (existsSync(providerKeyFilePath(dataDir))) return undefined;
  try {
    if (!keystoreUsable(ss, platform) || !(await ss.isAsyncEncryptionAvailable())) return undefined;
    const hex = randomBytes(32).toString('hex');
    writeAtomic(providerKeyFilePath(dataDir), await ss.encryptStringAsync(hex));
    return hex;
  } catch { return undefined; }
}

/** The launch line for the core: `PKEY <hex>`, `PKEY - unreadable` (the wrapped key is there and does not open) or `PKEY - unavailable` (no usable keystore). */
export async function providerKeyLaunchLine(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<string> {
  const hex = await ensureProviderKey(dataDir, ss, platform);
  if (hex) return `PKEY ${hex}\n`;
  return existsSync(providerKeyFilePath(dataDir)) ? 'PKEY - unreadable\n' : 'PKEY - unavailable\n';
}

/**
 * "Start over with new keys", main's half: a key.bin that does not unwrap is renamed to key.bin.unreadable-<date> (never deleted, never
 * overwritten), so the next `ensureProviderKey` makes a new one. A key.bin that unwraps is left exactly as it is ('kept': then only keys.enc
 * was the problem). A missing file is 'none'; a failed rename throws, so the caller stops before it restarts anything.
 */
export async function setAsideProviderKey(dataDir: string, ss: SafeStorageLike, platform: string = process.platform): Promise<'none' | 'kept' | 'set-aside' | 'unavailable'> {
  const file = providerKeyFilePath(dataDir);
  if (!existsSync(file)) return 'none';
  // A key store that is only unavailable right now (locked keychain, keyring not unlocked yet, no encryption) makes a good key.bin look
  // unreadable at launch. Never rename it then: only a key store that is up and cannot open the file counts as "does not unwrap".
  if (!(await providerKeyStoreReady(ss, platform))) return 'unavailable';
  if (await loadProviderKey(dataDir, ss, platform)) return 'kept';
  const day = new Date().toISOString().slice(0, 10);
  let to = `${file}.unreadable-${day}`;
  for (let i = 2; existsSync(to); i++) to = `${file}.unreadable-${day}-${i}`;
  renameSync(file, to);
  return 'set-aside';
}
