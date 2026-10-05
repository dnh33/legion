/** Config schema, defaults and data-dir paths. */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultBlenderConfig, normalizeBlender } from './blender.js';
import type { BlenderConfig } from './blender.js';
import { MAX_ROOM_BUDGET_USD } from './comms.js';
import type { CompactionSettings, LegionConfig } from './types.js';
import { DEFAULT_PROVIDERS, normalizeProviders } from '../core/providers/config.js';
import type { ProvidersConfig } from '../core/providers/types.js';
export { MAX_ROOM_BUDGET_USD };

export const VERSION = '0.2.3-g';

/**
 * Optional BSV Dev Kit toggle (knowledge and visibility only: no wallet, no keys, no funds).
 * The network is fixed to testnet; any other value in a config file is ignored on load.
 * Kept here (not in types.ts) so the shared types stay frozen; LegionConfig consumers that
 * do not care about BSV are unaffected.
 */
export interface BsvConfig {
  enabled: boolean;
  network: 'testnet';
  /** Where the wallet status probe looks (loopback only, checked again by the probe). Absent = the default. */
  walletUrl?: string;
}
/**
 * Limits for rooms and room membership that a BOT asks for (`room_create`, `room_add_member`, always behind a human approval card).
 * Edited in config.json under "comms"; values outside their range are pulled back on load.
 */
export interface CommsConfig {
  /** Most members a room a bot creates (or grows) may have, 2 to 6 (the same ceiling the New room dialog has). Default 6. */
  botRoomMaxMembers: number;
  /** Budget in USD for a bot-created room that names none. Default none (null = no spend limit). */
  botRoomDefaultBudgetUsd: number | null;
  /** Highest budget a bot may ask for. Default none (null = no ceiling; a bot-named budget is still at least $0.05). */
  botRoomMaxBudgetUsd: number | null;
  /** What one turn is assumed to cost in a room with no turn history, for the budget guard that stops BEFORE a wake. Default 0.02. */
  turnCostFloorUsd: number;
}
/** Switches for work that is built but not part of a release yet. Set only by editing config.json (no UI, no route writes it). Empty now: providers shipped, see FeaturesConfig. */
export interface ExperimentalConfig {}
export function normalizeExperimental(_v: unknown): ExperimentalConfig {
  return {};
}

/**
 * Switches for features that are ON by default. Set only by editing config.json (no UI, no route writes it). Only the literal `false` turns one off:
 * a missing key, `true`, "false" as text, 0 or anything else leaves it on.
 */
export interface FeaturesConfig { projectBoard: boolean; providers: boolean }
export function normalizeFeatures(v: unknown): FeaturesConfig {
  const o = (v && typeof v === 'object' ? v : {}) as { projectBoard?: unknown; providers?: unknown };
  return { projectBoard: o.projectBoard !== false, providers: o.providers !== false };
}

export type CoreConfig = LegionConfig & { bsv: BsvConfig; comms: CommsConfig; blender: BlenderConfig; providers: ProvidersConfig; experimental: ExperimentalConfig; features: FeaturesConfig };

/** The least a room's budget can be (below it one turn cannot fit). The hub, the settings dialogs and the bot-room limits all use it. */
export const MIN_ROOM_BUDGET_USD = 0.05;

/**
 * The shipped compaction defaults. Each value equals the constant the provider path used before this block existed
 * (verified against src/core/providers/compaction.ts by test/provider-compaction-config.test.ts), so a config with no
 * `compaction` key behaves exactly as every earlier release did.
 */
export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  thresholdFraction: 0.5,
  tailBudgetShare: 0.2,
  summaryShare: 0.1,
  protectFirst: 3,
  contextWindowOverride: null,
  smallWindowTokens: 32_000,
};

/** The accepted range for every numeric compaction field. One source of truth: PATCH validation, config.json normalization and the UI all read it. */
export const COMPACTION_LIMITS: Record<Exclude<keyof CompactionSettings, 'enabled'>, { min: number; max: number }> = {
  thresholdFraction: { min: 0.1, max: 0.95 },
  tailBudgetShare: { min: 0.02, max: 0.6 },
  summaryShare: { min: 0.02, max: 0.4 },
  protectFirst: { min: 1, max: 20 },
  contextWindowOverride: { min: 4_096, max: 4_000_000 },
  smallWindowTokens: { min: 4_096, max: 4_000_000 },
};

/**
 * Whatever the file held under "compaction", reduced to values inside their ranges (the default for anything missing,
 * wrong-typed or out of range). A hand-edited config.json is never trusted; a value the Settings API accepts is.
 */
export function normalizeCompaction(v: unknown): CompactionSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  type NumKey = Exclude<keyof CompactionSettings, 'contextWindowOverride' | 'enabled'>;
  const num = (k: NumKey, int = false): number => {
    const x = o[k];
    const L = COMPACTION_LIMITS[k];
    return typeof x === 'number' && Number.isFinite(x) && x >= L.min && x <= L.max && (!int || Number.isInteger(x)) ? x : DEFAULT_COMPACTION[k];
  };
  const cwo = o.contextWindowOverride;
  const cwoL = COMPACTION_LIMITS.contextWindowOverride;
  const override = cwo === null ? null
    : typeof cwo === 'number' && Number.isFinite(cwo) && Number.isInteger(cwo) && cwo >= cwoL.min && cwo <= cwoL.max ? cwo
      : DEFAULT_COMPACTION.contextWindowOverride;
  return {
    // Only an explicit false turns it off. Anything else - absent, true, or a wrong type from a hand-edited
    // config - reads as on, because silently disabling compaction would be worse than ignoring a typo.
    enabled: o.enabled === false ? false : true,
    thresholdFraction: num('thresholdFraction'),
    tailBudgetShare: num('tailBudgetShare'),
    summaryShare: num('summaryShare'),
    protectFirst: num('protectFirst', true),
    contextWindowOverride: override,
    smallWindowTokens: num('smallWindowTokens', true),
  };
}

/**
 * The compaction settings a provider run consumes, from a LegionConfig. This is the function the engine/provider seam
 * calls: it always returns a complete, valid object, so a config written before this section existed (or a partial one)
 * is safe to read. The values only matter on the provider path; Claude runs ignore them.
 */
export function compactionFor(config: Pick<LegionConfig, 'compaction'>): CompactionSettings {
  return normalizeCompaction(config.compaction);
}

export const DEFAULT_COMMS: CommsConfig = { botRoomMaxMembers: 6, botRoomDefaultBudgetUsd: null, botRoomMaxBudgetUsd: null, turnCostFloorUsd: 0.02 };

/** Whatever the file held under "comms", reduced to numbers inside their ranges (defaults for anything missing or wrong). */
export function normalizeComms(v: unknown): CommsConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (k: 'botRoomMaxMembers' | 'turnCostFloorUsd', lo: number, hi: number, int = false): number => {
    const x = o[k];
    return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi && (!int || Number.isInteger(x)) ? x : DEFAULT_COMMS[k];
  };
  /** A USD amount in range, or null (no limit) for anything else, including a missing value. */
  const usd = (k: 'botRoomDefaultBudgetUsd' | 'botRoomMaxBudgetUsd'): number | null => {
    const x = o[k];
    return typeof x === 'number' && Number.isFinite(x) && x >= MIN_ROOM_BUDGET_USD && x <= MAX_ROOM_BUDGET_USD ? x : null;
  };
  const max = usd('botRoomMaxBudgetUsd');
  const def = usd('botRoomDefaultBudgetUsd');
  return {
    botRoomMaxMembers: num('botRoomMaxMembers', 2, 6, true),
    botRoomMaxBudgetUsd: max,
    botRoomDefaultBudgetUsd: def !== null && max !== null ? Math.min(def, max) : def,
    turnCostFloorUsd: num('turnCostFloorUsd', 0, 10),
  };
}

/** %USERPROFILE%\.legion on Windows, ~/.legion elsewhere. Override with LEGION_HOME. */
export function dataDir(): string {
  const dir = process.env.LEGION_HOME || join(homedir(), '.legion');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}

export function defaultConfig(): CoreConfig {
  return {
    port: 4747,
    authToken: randomBytes(24).toString('hex'),
    workspaceDir: join(dataDir(), 'workspaces'),
    claude: {
      auth: 'claude-login',
      inheritClaudeCodeSettings: true,
      inheritMcp: false,
      maxTurns: 40,
    },
    boat: { baseUrl: 'https://boat.dev/api/v1' },
    mcpServers: {},
    compaction: { ...DEFAULT_COMPACTION },
    bsv: { enabled: false, network: 'testnet' },
    comms: { ...DEFAULT_COMMS },
    blender: defaultBlenderConfig(),
    providers: { ...DEFAULT_PROVIDERS, entries: {} },
    experimental: {},
    features: { projectBoard: true, providers: true },
  };
}

/** Whatever the file held under "bsv", reduced to the one shape we accept (testnet only, boolean flag, an optional wallet URL string). */
export function normalizeBsv(v: unknown): BsvConfig {
  const enabled = !!v && typeof v === 'object' && (v as { enabled?: unknown }).enabled === true;
  const out: BsvConfig = { enabled, network: 'testnet' };
  const url = v && typeof v === 'object' ? (v as { walletUrl?: unknown }).walletUrl : undefined;
  if (typeof url === 'string' && url.length > 0 && url.length <= 200) out.walletUrl = url;
  return out;
}

/** Deep-merge loaded JSON over defaults so new fields appear after upgrades. */
function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)
      ? merge(b, v)
      : v;
  }
  return out;
}

/** Load config, creating it (with a fresh auth token) on first run. Env overrides: LEGION_PORT, BOAT_API_KEY, ANTHROPIC_API_KEY (only used when auth='api-key'). */
export function loadConfig(): CoreConfig {
  const p = configPath();
  let cfg = defaultConfig();
  if (existsSync(p)) {
    cfg = merge(cfg, JSON.parse(readFileSync(p, 'utf8')));
    tightenConfigMode(p);
  } else {
    saveConfig(cfg);
  }
  cfg.bsv = normalizeBsv(cfg.bsv);
  cfg.comms = normalizeComms(cfg.comms);
  cfg.blender = normalizeBlender(cfg.blender);
  cfg.providers = normalizeProviders(cfg.providers);
  cfg.compaction = normalizeCompaction(cfg.compaction);
  cfg.experimental = normalizeExperimental(cfg.experimental);
  cfg.features = normalizeFeatures(cfg.features);
  if (process.env.LEGION_PORT) cfg.port = Number(process.env.LEGION_PORT);
  if (!cfg.boat.apiKey && process.env.BOAT_API_KEY) cfg.boat.apiKey = process.env.BOAT_API_KEY;
  if (cfg.claude.auth === 'api-key' && !cfg.claude.apiKey && process.env.ANTHROPIC_API_KEY) {
    cfg.claude.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  return cfg;
}

/**
 * config.json holds the bearer token and provider keys: owner read/write only (0600) wherever the OS has file modes.
 * This keeps other local users out; it does NOT keep out a bot that runs as the same user (see docs/LIBRARY.md).
 */
export function saveConfig(cfg: LegionConfig): void {
  writeConfigFile(configPath(), JSON.stringify(cfg, null, 2));
}

/**
 * The one way config.json is written (first run, Settings, the BSV toggle): a temp file created 0600 next to it, renamed over
 * it, then the mode checked again. A writer that renames a default-mode temp file would silently undo the 0600.
 */
export function writeConfigFile(file: string, json: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* none left over */ }
  writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  tightenConfigMode(tmp);
  try {
    renameSync(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EEXIST') { try { unlinkSync(file); } catch { /* ignore */ } renameSync(tmp, file); }
    else { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
  }
  tightenConfigMode(file);
}

/** Takes group and other access off an existing config file (created by an older version with the default mode). Best effort. */
export function tightenConfigMode(p: string): void {
  if (process.platform === 'win32') return; // Windows ACLs are inherited from the profile folder; POSIX bits mean nothing there
  try { if ((statSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600); } catch { /* read-only or foreign file: nothing more to do */ }
}

/** Config safe to send to the UI (no secrets). */
export function redactConfig<T extends LegionConfig>(cfg: T): T {
  return {
    ...cfg,
    authToken: '***',
    claude: { ...cfg.claude, apiKey: cfg.claude.apiKey ? '***' : undefined },
    boat: { ...cfg.boat, apiKey: cfg.boat.apiKey ? '***' : undefined },
  };
}

/**
 * When Legion Core is launched from inside a Claude Code / Cowork / Claude Desktop session (e.g. via the
 * stdio MCP bridge) it inherits that host session's private env vars. Passing those to our own
 * Claude Code children makes them attach to the host session instead of running standalone.
 * Keep the user's genuine configuration vars; drop host-session plumbing.
 */
const KEEP_ENV = new Set([
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);
const HOST_ENV = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_(PID|SESSION_|AFTER_|AUTO_|AUTOCOMPACT_|PROJECT_|INTERNAL_|ADDITIONAL_|EFFORT|ENABLE_|CHROME_)|CCR_|ANTHROPIC_BASE_URL$)/;

export function scrubHostSessionEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (HOST_ENV.test(k) && !KEEP_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}
