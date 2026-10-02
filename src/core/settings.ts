/** Settings API backend: validate, persist atomically to config.json, apply live. */
import { existsSync, readFileSync } from 'node:fs';
import { writeConfigFile } from '../shared/config.js';
import type { LegionConfig, McpServerEntry, SettingsPatch, SettingsView } from '../shared/types.js';
import { sanitizeRates } from '../shared/vm-usage.js';
import { BoatClient } from './boat.js';
import type { EventBus } from './bus.js';

export class SettingsError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'SettingsError'; }
}

export interface SettingsDeps {
  config: LegionConfig;
  bus: EventBus;
  configPath: string;
  dataDir: string;
  /** Called after boat key/baseUrl changed (rebuild client happens lazily via getBoat; this restarts the reaper). */
  onBoatChange?: () => void;
  /** Test hook. */
  makeBoat?: (o: { apiKey: string; baseUrl: string }) => Pick<BoatClient, 'me'> & Partial<Pick<BoatClient, 'checkKey'>>;
}

const MASK = '••••';
const maskVal = (v: string) => (v.length < 8 ? MASK : MASK + v.slice(-4));
const maskMap = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, maskVal(v)])) : undefined);
/** Copy of an MCP entry with every env/header value masked (secrets never leave the core). */
function maskEntry(e: McpServerEntry): McpServerEntry {
  if (e.type === 'http' || e.type === 'sse') return { ...e, ...(e.headers ? { headers: maskMap(e.headers)! } : {}) };
  return { ...e, ...(e.env ? { env: maskMap(e.env)! } : {}) };
}
/** In a PATCH, a value starting with the mask means "keep the existing value for that key". */
function unmask(m: Record<string, string> | undefined, existing: Record<string, string> | undefined, field: string): Record<string, string> | undefined {
  if (!m) return m;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v.startsWith(MASK)) {
      if (existing?.[k] === undefined) throw new SettingsError(`${field}.${k} is a masked placeholder but has no existing value; send the real value`);
      out[k] = existing[k]!;
    } else out[k] = v;
  }
  return out;
}
const hint = (k?: string) => (k ? `…${k.slice(-4)}` : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function secret(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\s]/.test(v.trim())) throw new SettingsError(`${field} must be a non-empty string without spaces (max 500), or null to clear`);
  return v.trim();
}
function strMap(v: unknown, field: string): Record<string, string> {
  if (!isObj(v) || Object.values(v).some((x) => typeof x !== 'string')) throw new SettingsError(`${field} must be an object of strings`);
  return v as Record<string, string>;
}
function httpUrl(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new SettingsError(`${field} must be a URL string`);
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch { throw new SettingsError(`${field} must be an http(s) URL`); }
  return v;
}
function mcpEntry(name: string, v: unknown): McpServerEntry {
  const f = `mcpServers.${name}`;
  if (!isObj(v)) throw new SettingsError(`${f} must be an object`);
  if (v.type === 'http' || v.type === 'sse') {
    return { type: v.type, url: httpUrl(v.url, `${f}.url`), ...(v.headers !== undefined ? { headers: strMap(v.headers, `${f}.headers`) } : {}) };
  }
  if (v.type !== undefined && v.type !== 'stdio') throw new SettingsError(`${f}.type must be stdio, http or sse`);
  if (typeof v.command !== 'string' || !v.command.trim()) throw new SettingsError(`${f}.command is required`);
  if (v.args !== undefined && (!Array.isArray(v.args) || v.args.some((a) => typeof a !== 'string'))) throw new SettingsError(`${f}.args must be an array of strings`);
  return {
    ...(v.type ? { type: 'stdio' as const } : {}), command: v.command,
    ...(v.args ? { args: v.args as string[] } : {}), ...(v.env !== undefined ? { env: strMap(v.env, `${f}.env`) } : {}),
  };
}

/** Returns a normalised patch; throws SettingsError(400) on bad input. */
export function validatePatch(raw: unknown, current?: Record<string, McpServerEntry>): SettingsPatch {
  if (!isObj(raw)) throw new SettingsError('JSON object body required');
  const out: SettingsPatch = {};
  if (raw.claude !== undefined) {
    if (!isObj(raw.claude)) throw new SettingsError('claude must be an object');
    const c = raw.claude, o: NonNullable<SettingsPatch['claude']> = {};
    if (c.auth !== undefined) {
      if (c.auth !== 'claude-login' && c.auth !== 'api-key') throw new SettingsError("claude.auth must be 'claude-login' or 'api-key'");
      o.auth = c.auth;
    }
    if (c.apiKey !== undefined) o.apiKey = secret(c.apiKey, 'claude.apiKey');
    if (c.executablePath !== undefined) {
      if (c.executablePath !== null && (typeof c.executablePath !== 'string' || !c.executablePath.trim() || c.executablePath.length > 1000)) throw new SettingsError('claude.executablePath must be a path string or null');
      o.executablePath = c.executablePath === null ? null : (c.executablePath as string).trim();
    }
    if (c.inheritClaudeCodeSettings !== undefined) {
      if (typeof c.inheritClaudeCodeSettings !== 'boolean') throw new SettingsError('claude.inheritClaudeCodeSettings must be a boolean');
      o.inheritClaudeCodeSettings = c.inheritClaudeCodeSettings;
    }
    if (c.maxTurns !== undefined) {
      if (typeof c.maxTurns !== 'number' || !Number.isInteger(c.maxTurns) || c.maxTurns < 1 || c.maxTurns > 1000) throw new SettingsError('claude.maxTurns must be an integer 1-1000');
      o.maxTurns = c.maxTurns;
    }
    out.claude = o;
  }
  if (raw.boat !== undefined) {
    if (!isObj(raw.boat)) throw new SettingsError('boat must be an object');
    const b = raw.boat, o: NonNullable<SettingsPatch['boat']> = {};
    if (b.apiKey !== undefined) o.apiKey = secret(b.apiKey, 'boat.apiKey');
    if (b.baseUrl !== undefined) o.baseUrl = httpUrl(b.baseUrl, 'boat.baseUrl').replace(/\/+$/, '');
    if (b.rates !== undefined) {
      if (b.rates !== null && !isObj(b.rates)) throw new SettingsError('boat.rates must be an object');
      const r: Record<string, number> = {};
      for (const [k, v] of Object.entries(b.rates ?? {})) {
        if (!['small', 'default', 'large'].includes(k)) throw new SettingsError(`boat.rates.${k} is not a VM size (small, default, large)`);
        if (v === null || v === undefined || v === '') continue; // empty = no rate for that size
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100000) throw new SettingsError(`boat.rates.${k} must be a positive number (your hourly price)`);
        r[k] = v;
      }
      (o as any).rates = Object.keys(r).length ? r : null; // null removes the key from config.json
    }
    if (b.currency !== undefined) {
      if (b.currency !== null && (typeof b.currency !== 'string' || b.currency.length > 12)) throw new SettingsError('boat.currency must be a short text (e.g. "USD")');
      (o as any).currency = b.currency ? (b.currency as string).trim() : null;
    }
    out.boat = o;
  }
  if (raw.mcpServers !== undefined) {
    if (!isObj(raw.mcpServers)) throw new SettingsError('mcpServers must be an object');
    const m: Record<string, McpServerEntry> = {};
    for (const [name, v] of Object.entries(raw.mcpServers)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name === 'legion') throw new SettingsError(`Invalid MCP server name "${name}"`);
      const e = mcpEntry(name, v);
      const old = current?.[name] as any;
      if ('headers' in e && e.headers) e.headers = unmask(e.headers, old?.headers, `mcpServers.${name}.headers`)!;
      if ('env' in e && e.env) e.env = unmask(e.env, old?.env, `mcpServers.${name}.env`)!;
      m[name] = e;
    }
    out.mcpServers = m;
  }
  return out;
}


export class SettingsService {
  constructor(private readonly deps: SettingsDeps) {}

  view(): SettingsView {
    const c = this.deps.config;
    return {
      claude: {
        auth: c.claude.auth, apiKeySet: !!c.claude.apiKey, ...(c.claude.apiKey ? { apiKeyHint: hint(c.claude.apiKey) } : {}),
        ...(c.claude.executablePath ? { executablePath: c.claude.executablePath } : {}),
        inheritClaudeCodeSettings: c.claude.inheritClaudeCodeSettings, maxTurns: c.claude.maxTurns,
      },
      boat: {
        apiKeySet: !!c.boat.apiKey, ...(c.boat.apiKey ? { apiKeyHint: hint(c.boat.apiKey) } : {}), baseUrl: c.boat.baseUrl,
        rates: sanitizeRates(c.boat.rates), currency: typeof c.boat.currency === 'string' ? c.boat.currency : '',
      },
      mcpServers: Object.fromEntries(Object.entries(c.mcpServers ?? {}).map(([k, v]) => [k, maskEntry(v)])),
      port: c.port, configPath: this.deps.configPath, dataDir: this.deps.dataDir,
    };
  }

  patch(raw: unknown): SettingsView {
    const p = validatePatch(raw, this.deps.config.mcpServers);
    const cfg = this.deps.config;
    // Apply to the on-disk JSON (not the in-memory config) so env-derived values are never persisted.
    let disk: any = {};
    if (existsSync(this.deps.configPath)) {
      try { disk = JSON.parse(readFileSync(this.deps.configPath, 'utf8')); } catch { throw new SettingsError('config.json is unreadable; fix or delete it first', 500); }
      if (!isObj(disk)) disk = {};
    }
    const apply = (target: any) => {
      for (const sec of ['claude', 'boat'] as const) {
        const src = p[sec] as Record<string, unknown> | undefined;
        if (!src) continue;
        target[sec] = isObj(target[sec]) ? target[sec] : {};
        for (const [k, v] of Object.entries(src)) {
          if (v === null) delete target[sec][k]; else target[sec][k] = v;
        }
      }
      if (p.mcpServers) target.mcpServers = p.mcpServers;
    };
    apply(disk);
    try { writeConfigFile(this.deps.configPath, JSON.stringify(disk, null, 2)); } catch (e) {
      throw new SettingsError(`Could not write config: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
    const boatBefore = `${cfg.boat.apiKey ?? ''}|${cfg.boat.baseUrl}`;
    apply(cfg);
    const view = this.view();
    this.deps.bus.emit({ type: 'settings.updated', settings: view });
    if (`${cfg.boat.apiKey ?? ''}|${cfg.boat.baseUrl}` !== boatBefore) {
      try { this.deps.onBoatChange?.(); } catch { /* ignore */ }
    }
    return view;
  }

  /**
   * Tests the given key (or the saved one): GET /me, then the permission probe (cheap reads and actions aimed at a sandbox id that cannot exist;
   * never creates a sandbox). `warnings` are plain sentences for the UI. Never stores anything.
   */
  async testBoat(apiKey?: unknown, baseUrl?: unknown): Promise<{ ok: boolean; detail: string; warnings?: string[] }> {
    if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string')) throw new SettingsError('apiKey must be a string');
    const base = baseUrl === undefined || baseUrl === null || baseUrl === '' ? this.deps.config.boat.baseUrl : httpUrl(baseUrl, 'baseUrl').replace(/\/+$/, '');
    const key = (typeof apiKey === 'string' && apiKey.trim()) || this.deps.config.boat.apiKey;
    if (!key) return { ok: false, detail: 'No boat.dev API key set' };
    try {
      const make = this.deps.makeBoat ?? ((o) => new BoatClient(o));
      const client = make({ apiKey: key, baseUrl: base });
      const me: any = await client.me();
      const who = me && typeof me === 'object' ? (me.email ?? me.name ?? me.username) : undefined;
      const warnings: string[] = [];
      if (typeof client.checkKey === 'function') {
        const probe = await client.checkKey();
        for (const o of probe.ops) {
          if (o.status === 'forbidden') warnings.push(`This boat.dev API key cannot ${o.action ?? o.op}: create a full-access key in boat.dev and paste it here.`);
        }
        if (probe.claude === 'not_configured') warnings.push('Claude is not configured on boat.dev: open the Agents page in your boat.dev dashboard. Until then vm_claude cannot run.');
      }
      return { ok: true, detail: who ? `Connected as ${who}` : 'Connected', ...(warnings.length ? { warnings } : {}) };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** getBoat() that follows live edits of config.boat (key/baseUrl): rebuilds the client when they change, null when unset. */
export function makeBoatGetter(config: LegionConfig, make: (o: { apiKey: string; baseUrl: string }) => BoatClient = (o) => new BoatClient(o)): () => BoatClient | null {
  let boat: BoatClient | null = null;
  let sig = '';
  return () => {
    if (!config.boat.apiKey) { boat = null; sig = ''; return null; }
    const now = `${config.boat.apiKey}|${config.boat.baseUrl}`;
    if (!boat || now !== sig) { boat = make({ apiKey: config.boat.apiKey, baseUrl: config.boat.baseUrl }); sig = now; }
    return boat;
  };
}
