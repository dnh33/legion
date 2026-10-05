/** Reads the "providers" part of config.json into the one shape Legion accepts. Whatever is wrong is dropped or clamped, never trusted. */
import { MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from './compaction.js';
import { checkEndpoint } from './endpoint.js';
import type { ProviderEntry, ProviderPrice, ProvidersConfig } from './types.js';

/** Turns one provider run may take; 200 is also the top of the accepted range. Was 40 before 0.2.5-c. */
export const DEFAULT_PROVIDERS: ProvidersConfig = { version: 1, entries: {}, maxTurns: 200, maxToolCallsPerTurn: 16 };
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED_IDS = new Set(['claude', 'legion', 'auto', 'sonnet', 'opus', 'haiku', 'arn']);
const MAX_ENTRIES = 24;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function price(v: unknown): ProviderPrice | undefined {
  if (!isObj(v)) return undefined;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000;
  return ok(v.inputPerMTok) && ok(v.outputPerMTok) ? { inputPerMTok: v.inputPerMTok, outputPerMTok: v.outputPerMTok } : undefined;
}

/** One entry, or a plain-words reason it was refused. */
export function normalizeEntry(id: string, v: unknown): { entry: ProviderEntry } | { reason: string } {
  if (!isObj(v)) return { reason: `${id}: not an object` };
  if (v.kind === 'cli') return { reason: `${id}: CLI providers are not available in this version` };
  if (v.kind !== undefined && v.kind !== 'openai-compat') return { reason: `${id}: unknown kind` };
  if (v.wire !== undefined && v.wire !== 'chat' && v.wire !== 'responses') return { reason: `${id}: wire must be chat or responses` };
  const allowPrivate = v.allowPrivateNetwork === true;
  const ep = checkEndpoint(v.baseUrl, { allowPrivate });
  if (!ep.ok) return { reason: `${id}: ${ep.reason}` };
  const label = typeof v.label === 'string' && v.label.trim() ? v.label.trim().slice(0, 60) : id;
  const models = Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 120 && !/\s/.test(m)).slice(0, 200) : [];
  const prices: Record<string, ProviderPrice> = {};
  if (isObj(v.prices)) for (const [m, p] of Object.entries(v.prices)) { const pp = price(p); if (pp && m.length <= 120 && Object.keys(prices).length < 200) prices[m] = pp; }
  // keyless means "no key", so it only stands where nothing secret could be sent anywhere unexpected
  const keyless = v.keyless === true && (ep.loopback || (allowPrivate && ep.privateLiteral));
  // A window nobody can check is still clamped: too small and every turn compacts, too large and runs die on overflow.
  const window = typeof v.contextWindow === 'number' && Number.isFinite(v.contextWindow)
    ? Math.round(Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, v.contextWindow)))
    : undefined;
  return {
    entry: {
      kind: 'openai-compat', label, baseUrl: ep.url, enabled: v.enabled === true, models,
      ...(v.wire === 'responses' ? { wire: 'responses' as const } : {}),
      ...(keyless ? { keyless: true } : {}), ...(allowPrivate && ep.privateLiteral ? { allowPrivateNetwork: true } : {}),
      ...(Object.keys(prices).length ? { prices } : {}),
      ...(window !== undefined ? { contextWindow: window } : {}),
    },
  };
}

export function normalizeProviders(raw: unknown): ProvidersConfig {
  const out: ProvidersConfig = { version: 1, entries: {}, maxTurns: DEFAULT_PROVIDERS.maxTurns, maxToolCallsPerTurn: DEFAULT_PROVIDERS.maxToolCallsPerTurn };
  if (!isObj(raw)) return out;
  const int = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  out.maxTurns = int(raw.maxTurns, 1, 200, out.maxTurns);
  out.maxToolCallsPerTurn = int(raw.maxToolCallsPerTurn, 1, 64, out.maxToolCallsPerTurn);
  const dropped: string[] = [];
  const entries = isObj(raw.entries) ? raw.entries : {};
  for (const [id, v] of Object.entries(entries)) {
    if (Object.keys(out.entries).length >= MAX_ENTRIES) { dropped.push(`${id}: too many providers`); continue; }
    if (!PROVIDER_ID_RE.test(id) || RESERVED_IDS.has(id)) { dropped.push(`${id}: not a usable provider id`); continue; }
    const r = normalizeEntry(id, v);
    if ('reason' in r) dropped.push(r.reason); else out.entries[id] = r.entry;
  }
  if (dropped.length) out.dropped = dropped;
  return out;
}
