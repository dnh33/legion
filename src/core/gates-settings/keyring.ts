/**
 * The key that signs the gate settings files, in memory only. Electron main wraps a random 256-bit key with the OS keystore into
 * <dataDir>/gates-key.bin (src/electron/connector-key.ts, `ensureGatesKey`) and hands it to the core as the launch line
 * `GATESKEY <64 hex>`. It is its own key: it does not depend on a GitHub connection or on the connectors' key.
 */
import { registerSecretBytes } from '../log/redact.js';

/** `GATESKEY <64 hex> [new|old|lost]`: Electron says whether the key is new (an empty data folder), old (its file was there) or lost (a used folder with no key file). */
export const GATES_KEY_LINE = /^GATESKEY ([0-9a-f]{64})(?: (new|old|lost))?$/;
/** `GATESKEY - unreadable`: the key file is there but does not open. There is no key; the core treats every project as Ask. */
export const GATES_KEY_UNREADABLE_LINE = /^GATESKEY - unreadable$/;
export type GatesKeyState = 'new' | 'old' | 'lost' | 'unreadable';

export class GatesKeyring {
  #key: Buffer | undefined;
  #state: GatesKeyState = 'old';
  /** Installs the key from the documented line. Any other form changes nothing; the first key wins. */
  installLine(line: string): boolean {
    if (GATES_KEY_UNREADABLE_LINE.test(line.trim())) { if (this.#key) return false; this.#state = 'unreadable'; return true; }
    const m = GATES_KEY_LINE.exec(line.trim());
    if (!m || this.#key || this.#state === 'unreadable') return false;
    this.#key = Buffer.from(m[1]!, 'hex');
    this.#state = (m[2] as GatesKeyState | undefined) ?? 'old'; // a line with no state is treated as the careful one
    registerSecretBytes(this.#key);
    return true;
  }
  has(): boolean { return this.#key !== undefined; }
  get(): Buffer | undefined { return this.#key; }
  state(): GatesKeyState { return this.#state; }
  toString(): string { return '[GatesKeyring]'; }
  toJSON(): string { return '[GatesKeyring]'; }
}
