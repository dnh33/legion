/**
 * The Marshal panel's own logic: the form's bounds and errors, the done-when text, and the one line that
 * names a running dispatch. Pure functions over the shared wire types, so the panel, the route's contract
 * and the render test all read one truth (the bounds come from MARSHAL_LIMITS, the checks count from the
 * ledger's own MAX_DONE_WHEN).
 */
import { MARSHAL_DEFAULTS, MARSHAL_LIMITS } from '../../../../src/shared/board.js';
import type { MarshalConfig, MarshalRunningView } from '../../../../src/shared/board.js';
import { MAX_DONE_WHEN } from '../../../../src/core/marshal/ledger.js';

/** The form's two numbers, as the shared contract clamps them. */
export const WAVE_BOUNDS = MARSHAL_LIMITS.waveSize;
export const STALL_BOUNDS = MARSHAL_LIMITS.stallMinutes;
/** The most checks an item may carry: the ledger's own bound, shown where the checks are written. */
export const CHECK_MAX = MAX_DONE_WHEN;

/** The controls as the form holds them: numbers are text while the owner types. */
export interface MarshalDraft { enabled: boolean; waveSize: string; stallMinutes: string }

/** The draft for a config (or the shipped defaults while nothing has loaded). */
export const draftOf = (cfg?: MarshalConfig): MarshalDraft => ({
  enabled: cfg?.enabled ?? MARSHAL_DEFAULTS.enabled,
  waveSize: String(cfg?.waveSize ?? MARSHAL_DEFAULTS.waveSize),
  stallMinutes: String(cfg?.stallMinutes ?? MARSHAL_DEFAULTS.stallMinutes),
});

/** Everything wrong with the draft, in the owner's words. Empty means the Save button may be pressed. */
export function draftErrors(d: MarshalDraft): string[] {
  const out: string[] = [];
  const wave = Number(d.waveSize.trim());
  if (!Number.isInteger(wave) || wave < WAVE_BOUNDS[0] || wave > WAVE_BOUNDS[1]) {
    out.push(`Wave size must be a whole number between ${WAVE_BOUNDS[0]} and ${WAVE_BOUNDS[1]} — that is how many items one pass may start.`);
  }
  const stall = Number(d.stallMinutes.trim());
  if (!Number.isInteger(stall) || stall < STALL_BOUNDS[0] || stall > STALL_BOUNDS[1]) {
    out.push(`Stop a silent run after a whole number of minutes between ${STALL_BOUNDS[0]} and ${STALL_BOUNDS[1]}.`);
  }
  return out;
}

/** The draft as the route takes it. Only call it when `draftErrors` is empty. */
export const draftToConfig = (d: MarshalDraft): MarshalConfig => ({
  enabled: d.enabled, waveSize: Number(d.waveSize.trim()), stallMinutes: Number(d.stallMinutes.trim()),
});

/** The checks as text the owner edits: one per line, empty lines dropped, nothing else touched. */
export function parseChecks(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}
/** True when the checks on screen differ from the saved ones (spacing and blank lines do not count). */
export const checksPending = (text: string, savedText: string): boolean => parseChecks(text).join('\n') !== parseChecks(savedText).join('\n');
/** The stored checks as text to show. */
export const checksText = (checks?: readonly string[]): string => (checks ?? []).join('\n');
/** Why these lines cannot be saved yet, or undefined when they can. */
export function checksError(text: string): string | undefined {
  const lines = parseChecks(text);
  if (lines.length > CHECK_MAX) return `At most ${CHECK_MAX} checks: they are what decides whether this item is done.`;
  const long = lines.findIndex((l) => l.length > 200);
  if (long >= 0) return `Check ${long + 1} is too long (max 200 characters).`;
  return undefined;
}

/** One running dispatch as a line: what, which bot, on which model. */
export const runLine = (r: MarshalRunningView): string =>
  `${r.title} → ${r.botName} (${r.model}${r.gated ? ', gated' : ''})`;
