/**
 * The key that signs the gate settings files, in memory only. Electron main wraps a random 256-bit key with the OS keystore into
 * <dataDir>/gates-key.bin (src/electron/connector-key.ts, `ensureGatesKey`) and hands it to the core as the launch line
 * `GATESKEY <64 hex>`. It is its own key: it does not depend on a GitHub connection or on the connectors' key.
 */
import { registerSecretBytes } from '../log/redact.js';

export const GATES_KEY_LINE = /^GATESKEY ([0-9a-f]{64})$/;

export class GatesKeyring {
  #key: Buffer | undefined;
  /** Installs the key from the documented line. Any other form changes nothing; the first key wins. */
  installLine(line: string): boolean {
    const m = GATES_KEY_LINE.exec(line.trim());
    if (!m || this.#key) return false;
    this.#key = Buffer.from(m[1]!, 'hex');
    registerSecretBytes(this.#key);
    return true;
  }
  has(): boolean { return this.#key !== undefined; }
  get(): Buffer | undefined { return this.#key; }
  toString(): string { return '[GatesKeyring]'; }
  toJSON(): string { return '[GatesKeyring]'; }
}
