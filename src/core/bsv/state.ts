/**
 * BsvState: the single on/off flag of BSV mode. The network is fixed to testnet.
 * Persisted by rewriting ONLY the "bsv" key of <dataDir>/config.json (read, change, write back), never by
 * saving the in-memory config: that object carries env-derived values (API keys, port) which must not land on disk.
 * When there is no config.json (tests, odd setups) it falls back to <dataDir>/bsv.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeBsv, writeConfigFile } from '../../shared/config.js';
import type { BsvConfig } from '../../shared/config.js';
import type { LegionConfig } from '../../shared/types.js';

export class BsvState {
  private on: boolean;
  private url: string | undefined;
  private readonly configFile: string;
  private readonly fallbackFile: string;

  constructor(private readonly opts: { dataDir: string; config?: LegionConfig }) {
    this.configFile = join(opts.dataDir, 'config.json');
    this.fallbackFile = join(opts.dataDir, 'bsv.json');
    const fromConfig = (opts.config as { bsv?: unknown } | undefined)?.bsv;
    const norm = fromConfig !== undefined ? normalizeBsv(fromConfig) : this.readFallback();
    this.on = norm.enabled;
    // A wallet address in config.json is NOT read: a hand-edited file must not choose where Legion connects. Only Connect sets it, in memory.
    this.url = undefined;
  }

  get enabled(): boolean { return this.on; }
  /** The wallet URL the owner typed in this launch (memory only; never read from disk). Loopback is enforced by the probe, not here. */
  get walletUrl(): string | undefined { return this.url; }
  readonly network = 'testnet' as const;

  /**
   * The address the owner typed for the wallet, kept in memory for this launch only (never written to disk, never read back from it).
   * There is no default address anywhere.
   */
  setWalletUrl(url: string): void { this.url = url; }

  /** Returns true when the flag changed. Throws (and keeps the old value) when it cannot be saved. */
  set(enabled: boolean): boolean {
    if (enabled === this.on) return false;
    const next: BsvConfig = { enabled, network: 'testnet' };
    this.persist(next);
    this.on = enabled;
    const cfg = this.opts.config as { bsv?: BsvConfig } | undefined;
    if (cfg) cfg.bsv = next;
    return true;
  }

  private readFallback(): BsvConfig {
    try { return existsSync(this.fallbackFile) ? normalizeBsv(JSON.parse(readFileSync(this.fallbackFile, 'utf8'))) : normalizeBsv(undefined); } catch { return normalizeBsv(undefined); }
  }

  private persist(bsv: BsvConfig): void {
    if (existsSync(this.configFile)) {
      const cur = JSON.parse(readFileSync(this.configFile, 'utf8')) as Record<string, unknown>;
      cur.bsv = bsv;
      writeConfigFile(this.configFile, JSON.stringify(cur, null, 2));
    } else {
      writeFileSync(this.fallbackFile, JSON.stringify(bsv, null, 2), 'utf8');
    }
  }
}

export function createBsvState(opts: { dataDir: string; config?: LegionConfig }): BsvState { return new BsvState(opts); }
