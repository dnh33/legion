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
  private readonly configFile: string;
  private readonly fallbackFile: string;

  constructor(private readonly opts: { dataDir: string; config?: LegionConfig }) {
    this.configFile = join(opts.dataDir, 'config.json');
    this.fallbackFile = join(opts.dataDir, 'bsv.json');
    const fromConfig = (opts.config as { bsv?: unknown } | undefined)?.bsv;
    this.on = fromConfig !== undefined ? normalizeBsv(fromConfig).enabled : this.readFallback();
  }

  get enabled(): boolean { return this.on; }
  readonly network = 'testnet' as const;

  /** Returns true when the flag changed. Throws (and keeps the old value) when it cannot be saved. */
  set(enabled: boolean): boolean {
    if (enabled === this.on) return false;
    this.persist({ enabled, network: 'testnet' });
    this.on = enabled;
    const cfg = this.opts.config as { bsv?: BsvConfig } | undefined;
    if (cfg) cfg.bsv = { enabled, network: 'testnet' };
    return true;
  }

  private readFallback(): boolean {
    try { return existsSync(this.fallbackFile) ? normalizeBsv(JSON.parse(readFileSync(this.fallbackFile, 'utf8'))).enabled : false; } catch { return false; }
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
