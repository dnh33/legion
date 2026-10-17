/**
 * The skill finder's owner settings and the per-agent override.
 *
 * The owner's settings live in armory.json (`finder`). The file keeps only the keys the owner set, so a later default reaches
 * everyone who never chose a value: the defaults are filled in on read (`finderFor`), never written.
 *
 * The rankers 'local' and 'provider' are not resolved here. A ranker that cannot run falls back to 'keyword' when the finder
 * runs, because only then is it known whether the model is installed or a provider matches.
 */
import type { FinderRanker, FinderSettings, FinderThreshold } from '../../../shared/armory-view.js';
import type { AgentProfile } from '../../../shared/types.js';
import { DEFAULT_K, THRESHOLDS } from './defaults.js';

export const FINDER_DEFAULTS: FinderSettings = {
  suggest: false,
  searchTool: true,
  subagents: true,
  ranker: 'keyword',
  rerank: false,
  rerankMonthlyUsd: 1,
  // Off until it is shown to keep accuracy. On 400 public skills (Task 11e) it lost 11 to 19 points of right skill picks from 40 to 100
  // skills, measured without the search tool beside it; the owner's own 104 skills lost nothing. 'auto' (above WARN_ABOVE skills) and true stay choices.
  slimListing: false,
  k: DEFAULT_K,
  threshold: 'balanced',
  chatLine: true,
  noticeSeen: false,
};

/** Range of k (skills per note), set by the owner or per agent. */
export const K_MIN = 1;
export const K_MAX = 5;
/** Range of the monthly cap on reranking spend, in US dollars. */
export const MONTHLY_USD_MAX = 50;
/** Longest provider id or model name the settings keep. */
export const FINDER_MAX_TEXT = 120;

const RANKERS: readonly FinderRanker[] = ['keyword', 'local', 'provider'];
const THRESHOLD_NAMES = Object.keys(THRESHOLDS) as FinderThreshold[];
const FINDER_KEYS = [
  'suggest', 'searchTool', 'subagents', 'ranker', 'providerId', 'providerModel', 'rerank', 'rerankMonthlyUsd',
  'slimListing', 'k', 'threshold', 'chatLine', 'noticeSeen',
] as const satisfies readonly (keyof FinderSettings)[];
export type FinderKey = keyof FinderSettings;

/** A value that is not valid. `reason` names the field, for the route's 400. */
export class FinderInputError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * One key's value. `ok: false` carries the reason. `ok: true` with `value: undefined` means the key is removed (an empty
 * provider id or model). Numbers are clamped here, so every caller gets the same range.
 */
type Checked = { ok: true; value: unknown } | { ok: false; reason: string };

function check(key: FinderKey, v: unknown): Checked {
  switch (key) {
    case 'ranker':
      return RANKERS.includes(v as FinderRanker) ? { ok: true, value: v } : { ok: false, reason: `ranker must be one of: ${RANKERS.join(', ')}` };
    case 'threshold':
      return THRESHOLD_NAMES.includes(v as FinderThreshold) ? { ok: true, value: v } : { ok: false, reason: `threshold must be one of: ${THRESHOLD_NAMES.join(', ')}` };
    case 'slimListing':
      return v === true || v === false || v === 'auto' ? { ok: true, value: v } : { ok: false, reason: 'slimListing must be true, false or "auto"' };
    case 'suggest':
      return v === true || v === false || v === 'auto' ? { ok: true, value: v } : { ok: false, reason: 'suggest must be true, false or "auto"' };
    case 'providerId':
    case 'providerModel':
      if (typeof v !== 'string' || v.length > FINDER_MAX_TEXT) return { ok: false, reason: `${key} must be a string of at most ${FINDER_MAX_TEXT} characters` };
      return { ok: true, value: v === '' ? undefined : v };
    case 'k':
      if (!finite(v)) return { ok: false, reason: `k must be a number from ${K_MIN} to ${K_MAX}` };
      return { ok: true, value: clamp(Math.round(v), K_MIN, K_MAX) };
    case 'rerankMonthlyUsd':
      if (!finite(v)) return { ok: false, reason: `rerankMonthlyUsd must be a number of US dollars from 0 to ${MONTHLY_USD_MAX}` };
      return { ok: true, value: clamp(v, 0, MONTHLY_USD_MAX) };
    default:
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: `${key} must be true or false` };
  }
}

/**
 * Reads a stored or hand-edited block. Keeps each known key whose value is valid (clamped where a range applies) and drops
 * the rest. Undefined when the input is not an object or nothing valid is left.
 */
export function cleanFinder(raw: unknown): Partial<FinderSettings> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of FINDER_KEYS) {
    const c = check(key, raw[key]);
    if (c.ok && c.value !== undefined) out[key] = c.value;
  }
  return Object.keys(out).length ? (out as Partial<FinderSettings>) : undefined;
}

/**
 * The body of POST /api/armory/finder: a partial patch. Every key sent is checked. An unknown key or a bad type throws a
 * FinderInputError that names the field. A key whose value is undefined in the result means "remove it".
 */
export function finderPatch(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(body)) {
    if (!(FINDER_KEYS as readonly string[]).includes(key)) throw new FinderInputError(`Unknown finder setting "${key.slice(0, 60)}".`);
    const c = check(key as FinderKey, v);
    if (!c.ok) throw new FinderInputError(c.reason);
    out[key] = c.value;
  }
  return out;
}

/** The stored block after a patch. A key whose value is undefined is removed, so it falls back to the default. */
export function applyFinderPatch(stored: Partial<FinderSettings> | undefined, patch: Record<string, unknown>): Partial<FinderSettings> {
  const next: Record<string, unknown> = { ...(stored ?? {}) };
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) delete next[key];
    else next[key] = v;
  }
  return next as Partial<FinderSettings>;
}

/** Whether the note is on for these settings. 'auto' is on only for the local ranker once its model is installed (`localReady`). */
export function suggestOn(f: Pick<FinderSettings, 'suggest' | 'ranker'>, localReady: boolean): boolean {
  return f.suggest === 'auto' ? f.ranker === 'local' && localReady : f.suggest;
}

/**
 * The settings a run uses. The owner's block with the defaults filled in, then the agent's override:
 * - skillFinder 'off' turns suggest, search and subagents off for this agent;
 * - skillFinder 'on' turns suggest on for this agent (search and subagents keep the owner's value);
 * - skillFinderK replaces k. The agent's k is clamped the same way as the owner's.
 * With no agent, the owner's block alone.
 */
export function finderFor(file: { finder?: Partial<FinderSettings> }, agent?: Pick<AgentProfile, 'skillFinder' | 'skillFinderK'>): FinderSettings {
  const base: FinderSettings = { ...FINDER_DEFAULTS, ...(file.finder ?? {}) };
  const k = finite(agent?.skillFinderK) ? clamp(Math.round(agent.skillFinderK), K_MIN, K_MAX) : base.k;
  const mode = agent?.skillFinder ?? 'inherit';
  if (mode === 'off') return { ...base, suggest: false, searchTool: false, subagents: false, k };
  if (mode === 'on') return { ...base, suggest: true, k };
  return { ...base, k };
}
