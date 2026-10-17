/**
 * The provider keys' data key, in memory only. Electron main wraps a random 256-bit key with the OS keystore into
 * <dataDir>/providers/key.bin (src/electron/connector-key.ts, `ensureProviderKey`) and hands it to the core as one line on the launch
 * pipe. It is never written to disk, an environment variable, argv or a log by this module, and toString/JSON show nothing.
 *
 * The line is `PKEY <64 hex>`, or `PKEY - unavailable` (this system has no usable key store: the owner-only keys.json is used, as
 * before) or `PKEY - unreadable` (the wrapped key is there but does not open: the sealed keys cannot be unlocked). A core started
 * without Electron gets no line at all.
 */
import { registerSecretBytes } from '../log/redact.js';

export const PKEY_BYTES = 32;
export const PKEY_LINE = /^PKEY ([0-9a-f]{64})$/;
export const PKEY_NONE_LINE = /^PKEY - (unavailable|unreadable)$/;
export type NoKeyReason = 'unavailable' | 'unreadable';

export class ProviderKeyring {
  #key: Buffer | undefined;
  #none: NoKeyReason | undefined;

  /** Installs the key (or the reason there is none) from the documented line. Any other form changes nothing; the first line wins. */
  installLine(line: string): boolean {
    if (this.#key || this.#none) return false;
    const t = line.trim();
    const m = PKEY_LINE.exec(t);
    if (m) {
      this.#key = Buffer.from(m[1]!, 'hex');
      registerSecretBytes(this.#key); // the redactor knows the key from the moment the core holds it, in every text encoding
      return true;
    }
    const n = PKEY_NONE_LINE.exec(t);
    if (n) { this.#none = n[1] as NoKeyReason; return true; }
    return false;
  }

  has(): boolean { return this.#key !== undefined; }
  /** The key for the provider key store. Only that store should call this. */
  get(): Buffer | undefined { return this.#key; }
  /** Why there is no key, when Electron said so. undefined: a key, or no line at all (a core started without the app). */
  noKey(): NoKeyReason | undefined { return this.#none; }

  toString(): string { return '[ProviderKeyring]'; }
  toJSON(): string { return '[ProviderKeyring]'; }
}
