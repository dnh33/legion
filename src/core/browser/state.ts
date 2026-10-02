/** The browser tool's settings: <dataDir>/browser/config.json. Allow-local is NOT here on purpose: it lives in memory only (index.ts). */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_BROWSER_CONFIG } from '../../shared/browser.js';
import type { BrowserConfig } from '../../shared/browser.js';

const HEX64 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeConfig(raw: unknown): BrowserConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 500 && !/[\u0000-\u001f]/.test(x)).slice(0, max) : []);
  const domains = strs(o.allowDomains, 50).map((d) => d.trim().toLowerCase().replace(/^\*\./, '')).filter((d) => DOMAIN.test(d));
  const bin = typeof o.binaryPath === 'string' && o.binaryPath.length > 0 && o.binaryPath.length <= 500 && !/[\u0000-\u001f]/.test(o.binaryPath) ? o.binaryPath : undefined;
  const sha = typeof o.managedSha256 === 'string' && HEX64.test(o.managedSha256.toLowerCase()) ? o.managedSha256.toLowerCase() : undefined;
  const engine = o.engine === 'chromium' || o.engine === 'lightpanda' ? o.engine : undefined;
  const chromiumPath = typeof o.chromiumPath === 'string' && o.chromiumPath.length > 0 && o.chromiumPath.length <= 500 && !/[\u0000-\u001f]/.test(o.chromiumPath) ? o.chromiumPath : undefined;
  return {
    ...DEFAULT_BROWSER_CONFIG,
    enabled: o.enabled === true,
    ...(engine ? { engine } : {}),
    ...(chromiumPath ? { chromiumPath } : {}),
    ...(bin ? { binaryPath: bin } : {}),
    ...(bin && Array.isArray(o.launcherArgs) ? { launcherArgs: strs(o.launcherArgs, 16) } : {}),
    allowDomains: [...new Set(domains)],
    ...(sha ? { managedSha256: sha } : {}),
  };
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
