/** The browser tool's settings: <dataDir>/browser/config.json. Allow-local is NOT here on purpose: it lives in memory only (index.ts). */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_BROWSER_CONFIG } from '../../shared/browser.js';
import type { BrowserConfig } from '../../shared/browser.js';

const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Reads only the fields this version knows; anything else in an older file is ignored and dropped on the next save. */
export function normalizeConfig(raw: unknown): BrowserConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 500 && !/[\u0000-\u001f]/.test(x)).slice(0, max) : []);
  const domains = strs(o.allowDomains, 50).map((d) => d.trim().toLowerCase().replace(/^\*\./, '')).filter((d) => DOMAIN.test(d));
  const chromiumPath = typeof o.chromiumPath === 'string' && o.chromiumPath.length > 0 && o.chromiumPath.length <= 500 && !/[\u0000-\u001f]/.test(o.chromiumPath) ? o.chromiumPath : undefined;
  return { ...DEFAULT_BROWSER_CONFIG, enabled: o.enabled === true, ...(chromiumPath ? { chromiumPath } : {}), allowDomains: [...new Set(domains)] };
}

export class BrowserState {
  private cfg: BrowserConfig;
  readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'browser', 'config.json');
    let raw: unknown = {};
    try { if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { raw = {}; }
    this.cfg = normalizeConfig(raw);
  }
  get config(): BrowserConfig { return this.cfg; }
  update(patch: Partial<BrowserConfig>): BrowserConfig {
    const next = normalizeConfig({ ...this.cfg, ...patch });
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    try { chmodSync(tmp, 0o600); } catch { /* not on every file system */ }
    renameSync(tmp, this.file);
    this.cfg = next;
    return next;
  }
}
