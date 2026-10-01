/** Config schema, defaults and data-dir paths. */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LegionConfig } from './types.js';

export const VERSION = '0.1.0';

/**
 * Optional BSV Dev Kit toggle (knowledge and visibility only: no wallet, no keys, no funds).
 * The network is fixed to testnet; any other value in a config file is ignored on load.
 * Kept here (not in types.ts) so the shared types stay frozen; LegionConfig consumers that
 * do not care about BSV are unaffected.
 */
export interface BsvConfig { enabled: boolean; network: 'testnet' }
export type CoreConfig = LegionConfig & { bsv: BsvConfig };

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
      maxTurns: 40,
    },
    boat: { baseUrl: 'https://boat.dev/api/v1' },
    mcpServers: {},
    bsv: { enabled: false, network: 'testnet' },
  };
}

/** Whatever the file held under "bsv", reduced to the one shape we accept (testnet only, boolean flag). */
export function normalizeBsv(v: unknown): BsvConfig {
  const enabled = !!v && typeof v === 'object' && (v as { enabled?: unknown }).enabled === true;
  return { enabled, network: 'testnet' };
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
  const p = configPath();
  writeFileSync(p, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  tightenConfigMode(p);
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
