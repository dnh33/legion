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
  /** Hermes only: run it in a Legion profile named `legion` (`-p legion`) instead of the user's own Hermes home. */
  contained?: boolean;
}

/** The four "in between" items. Every one is off by default: Legion forwards the agent's own permission options unchanged. */
export interface AcpSwitches { disasterStop: boolean; modeMap: boolean; stripSkipFlags: boolean; answerOnce: boolean }

export interface AcpConfig { entries: AcpEntry[]; switches: AcpSwitches; watchdogMinutes: number; firstUseSeen: boolean }

export const BUILTIN_HERMES: AcpEntry = { id: 'hermes', label: 'Hermes', command: 'hermes', args: ['acp'], tested: true, enabled: true };

export const ACP_WATCHDOG_DEFAULT_MINUTES = 10;
export const ACP_WATCHDOG_MIN_MINUTES = 1;
export const ACP_WATCHDOG_MAX_MINUTES = 120;

/** The arguments to start an entry: its own, or the Legion profile form when it is contained. */
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

/** The entry with this id, or undefined. A config with no acp block still knows the built-in entry. */
export function acpEntry(config: { acp?: AcpConfig }, id: string): AcpEntry | undefined {
  const found = config.acp?.entries.find((e) => e.id === id);
  if (found) return found;
  return !config.acp && id === BUILTIN_HERMES.id ? BUILTIN_HERMES : undefined;
}

/** What the last check found for one entry. `unknown` until a check has run. */
export interface AcpDetection { state: 'unknown' | 'found' | 'missing' | 'error'; version?: string; detail?: string }

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
      ...entryLimits(e), detection: detect?.(e) ?? { state: 'unknown' },
    })),
    switches: { ...acp.switches },
    watchdogMinutes: acp.watchdogMinutes,
    firstUseSeen: acp.firstUseSeen,
  };
}

/** One entry in a Settings patch. A known id changes only the fields named; a new id adds a custom entry (needs a command). */
export interface AcpEntryPatch { id: string; label?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; contained?: boolean; tested?: boolean }

/** The agent host part of PATCH /api/settings. Omitted fields are unchanged. */
export interface AcpPatch { entries?: AcpEntryPatch[]; remove?: string[]; switches?: Partial<AcpSwitches>; watchdogMinutes?: number; firstUseSeen?: boolean }
