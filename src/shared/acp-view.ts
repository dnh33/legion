/**
 * Agent host (ACP) settings types and the small pure helpers around them. Shared by the core, the engine and the window.
 * The config part (defaults, normaliser, patch merge) lives in config.ts; this file has no imports so both sides can use it.
 */

/** One agent Legion can run through the Agent Client Protocol. Hermes is the built-in entry. */
export interface AcpEntry {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** True only for entries Legion ships and has tested. A user-added entry is always false. */
  tested: boolean;
  enabled: boolean;
  /** Hermes only: run it in a Hermes profile named `legion` (`-p legion`) instead of the user's own Hermes home. */
  contained?: boolean;
  /** Optional limits, all absent (off) until set. A "step" is one tool call the agent makes. */
  maxSteps?: number;
  maxTokensPerTask?: number;
  /** USD per million tokens. The agent reports token counts but never cost, so cost is only known when the owner enters these. */
  prices?: AcpPrices;
}

export interface AcpPrices { inputPerMTok: number; outputPerMTok: number }

export const ACP_MAX_STEPS_MIN = 1;
export const ACP_MAX_STEPS_MAX = 10_000;
export const ACP_MAX_TOKENS_MIN = 1_000;
export const ACP_MAX_TOKENS_MAX = 100_000_000;
/** The same ceiling provider prices have (USD per million tokens). */
export const ACP_PRICE_MAX = 100_000;

/** Tokens one agent turn used (the agent reports counts only). */
export type TokenDelta = { input: number; output: number };

/** The four "in between" items. Every one is off by default: Legion forwards the agent's own permission options unchanged. */
export interface AcpSwitches { disasterStop: boolean; modeMap: boolean; stripSkipFlags: boolean; answerOnce: boolean }

export interface AcpConfig { entries: AcpEntry[]; switches: AcpSwitches; watchdogMinutes: number; firstUseSeen: boolean }

/** The Hermes entry as it is once the owner has turned "Offer Hermes" on. */
export const BUILTIN_HERMES: AcpEntry = { id: 'hermes', label: 'Hermes', command: 'hermes', args: ['acp'], tested: true, enabled: true };
/** The Hermes entry as Legion ships it: off until the owner turns "Offer Hermes" on in Settings, Agent hosts (nothing looks for it or starts it before that). */
export const DEFAULT_HERMES: AcpEntry = { ...BUILTIN_HERMES, enabled: false };

export const ACP_WATCHDOG_DEFAULT_MINUTES = 10;
export const ACP_WATCHDOG_MIN_MINUTES = 1;
export const ACP_WATCHDOG_MAX_MINUTES = 120;

/**
 * `min`: the oldest Hermes Legion works with, a safe floor for the Hermes with the gateway ACP server this runtime talks to (the source notes
 * are in src/core/acp/detect.ts). `testedWith`: the version the runtime was built and checked against. The Doctor and Settings read these, so
 * both say the same numbers.
 */
export const TESTED_HERMES = { min: '0.22.3', testedWith: '0.22.3' } as const;
/** Negative when a is older than b. Both are `x.y.z`. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d; }
  return 0;
}

/** The arguments to start an entry: its own, or the Contained profile form when it is contained. */
export function containedArgs(e: AcpEntry): string[] {
  return e.contained ? ['-p', 'legion', 'acp'] : [...e.args];
}

/**
 * What an entry may be given. A custom (user-added) entry is untested: it gets no Legion tools and cannot run Full.
 * The engine reads this, never the entry's own `tested` flag alone.
 */
export function entryLimits(e: AcpEntry): { legionTools: boolean; fullAllowed: boolean } {
  return e.tested ? { legionTools: true, fullAllowed: true } : { legionTools: false, fullAllowed: false };
}

/**
 * What a turn cost in USD, or undefined when the entry has no prices (cost unknown). Same arithmetic as a provider's costOf,
 * with a guard so a bad token count can never make a negative or NaN cost.
 */
export function acpCostOf(e: AcpEntry, delta: TokenDelta): number | undefined {
  if (!e.prices) return undefined;
  const n = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  return (n(delta.input) * e.prices.inputPerMTok + n(delta.output) * e.prices.outputPerMTok) / 1_000_000;
}

/** The entry with this id, or undefined. A config with no acp block still knows the built-in entry. */
export function acpEntry(config: { acp?: AcpConfig }, id: string): AcpEntry | undefined {
  const found = config.acp?.entries.find((e) => e.id === id);
  if (found) return found;
  return !config.acp && id === BUILTIN_HERMES.id ? DEFAULT_HERMES : undefined;
}

/** What a check of the Contained Hermes profile (`legion`) found. `detail` is plain words for the window. */
export interface AcpContainedStatus { exists: boolean; signedIn: boolean; policyOk: boolean; detail: string }
/** The answer to "Set up": `signInCommand` is the one command the owner runs once, in a terminal. Legion never runs it. */
export interface AcpContainedSetup { ok: boolean; detail: string; signInCommand: string }

/** What the last check found for one entry. `unknown` until a check has run. */
export interface AcpDetection {
  state: 'unknown' | 'found' | 'missing' | 'error';
  version?: string;
  detail?: string;
  /** False: on the PATH but not started yet (the window asks for a full check when Settings opens). */
  checked?: boolean;
  /** Hermes's own approvals mode, read from its settings. Absent until a check read it. */
  approvalsMode?: 'manual' | 'smart' | 'off' | 'unknown';
}

export interface AcpEntryView {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** Names only: environment values can hold secrets and never leave the core. */
  envKeys: string[];
  tested: boolean;
  enabled: boolean;
  contained?: boolean;
  maxSteps?: number;
  maxTokensPerTask?: number;
  prices?: AcpPrices;
  legionTools: boolean;
  fullAllowed: boolean;
  detection: AcpDetection;
}

/** The agent host part of GET/PATCH /api/settings. */
export interface AcpView { entries: AcpEntryView[]; switches: AcpSwitches; watchdogMinutes: number; firstUseSeen: boolean }

export function buildAcpView(acp: AcpConfig, detect?: (e: AcpEntry) => AcpDetection): AcpView {
  return {
    entries: acp.entries.map((e) => ({
      id: e.id, label: e.label, command: e.command, args: [...e.args], envKeys: Object.keys(e.env ?? {}),
      tested: e.tested, enabled: e.enabled, ...(e.contained !== undefined ? { contained: e.contained } : {}),
      ...(e.maxSteps !== undefined ? { maxSteps: e.maxSteps } : {}),
      ...(e.maxTokensPerTask !== undefined ? { maxTokensPerTask: e.maxTokensPerTask } : {}),
      ...(e.prices ? { prices: { ...e.prices } } : {}),
      ...entryLimits(e), detection: detect?.(e) ?? { state: 'unknown' },
    })),
    switches: { ...acp.switches },
    watchdogMinutes: acp.watchdogMinutes,
    firstUseSeen: acp.firstUseSeen,
  };
}

/** One entry in a Settings patch. A known id changes only the fields named; a new id adds a custom entry (needs a command). */
export interface AcpEntryPatch { id: string; label?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; contained?: boolean; tested?: boolean;
  /** A number sets a limit, null clears it, absent leaves it as it is. */
  maxSteps?: number | null; maxTokensPerTask?: number | null; prices?: AcpPrices | null }

/** The agent host part of PATCH /api/settings. Omitted fields are unchanged. */
export interface AcpPatch { entries?: AcpEntryPatch[]; remove?: string[]; switches?: Partial<AcpSwitches>; watchdogMinutes?: number; firstUseSeen?: boolean }
