/**
 * The connectors' data key, in memory only. Electron main wraps a random 256-bit key with the OS keystore (src/electron/connector-key.ts)
 * and hands it to the core as a line on the launch pipe; the core installs it here. It is never written to disk, an environment variable,
 * argv or a log by this module, and toString/JSON show nothing. No key (headless core, Linux without a keyring, first launch before
 * the first Connect) means the token store keeps connectors in memory only.
 */
export const DATA_KEY_BYTES = 32;
/** The one accepted form of the key line on the launch pipe: "KEY " and 64 lowercase hex characters. */
export const KEY_LINE = /^KEY ([0-9a-f]{64})$/;

export class ConnectorKeyring {
  #key: Buffer | undefined;

  /** Installs the key from the documented line text. Returns false (and changes nothing) for any other form. The first key wins. */
  installLine(line: string): boolean {
    const m = KEY_LINE.exec(line.trim());
    return m ? this.install(Buffer.from(m[1]!, 'hex')) : false;
  }

  install(key: Buffer): boolean {
    if (this.#key || key.length !== DATA_KEY_BYTES) return false;
    this.#key = Buffer.from(key);
    return true;
  }

  has(): boolean { return this.#key !== undefined; }
  /** The key for the token store. Only the store should call this. */
  get(): Buffer | undefined { return this.#key; }

  toString(): string { return '[ConnectorKeyring]'; }
  toJSON(): string { return '[ConnectorKeyring]'; }
}
