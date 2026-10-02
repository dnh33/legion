/** Reads the "providers" part of config.json into the one shape Legion accepts. Whatever is wrong is dropped or clamped, never trusted. */
import { checkEndpoint } from './endpoint.js';
import type { CliKind, ProviderEntry, ProviderPrice, ProvidersConfig } from './types.js';

export const DEFAULT_PROVIDERS: ProvidersConfig = { version: 1, entries: {}, maxTurns: 40, maxToolCallsPerTurn: 16, stdioMcpAllow: {}, leadChoices: {} };
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED_IDS = new Set(['claude', 'legion', 'auto', 'sonnet', 'opus', 'haiku', 'arn']);
const MAX_ENTRIES = 24;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function price(v: unknown): ProviderPrice | undefined {
  if (!isObj(v)) return undefined;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000;
  return ok(v.inputPerMTok) && ok(v.outputPerMTok) ? { inputPerMTok: v.inputPerMTok, outputPerMTok: v.outputPerMTok } : undefined;
}

const CLI_KINDS = new Set(['codex', 'opencode']);
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** An absolute program path (POSIX or Windows drive / UNC); a bare name is refused so nothing is looked up on PATH. */
export const isAbsoluteProgramPath = (s: string): boolean => (/^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s)) && !/[\u0000-\u001f"%^&|<>!`;]/.test(s) && s.length <= 400;
const capNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000_000 ? v : undefined);

/** One entry, or a plain-words reason it was refused. */
export function normalizeEntry(id: string, v: unknown): { entry: ProviderEntry } | { reason: string } {
  if (!isObj(v)) return { reason: `${id}: not an object` };
  if (v.kind !== undefined && v.kind !== 'openai-compat' && v.kind !== 'cli') return { reason: `${id}: unknown kind` };
  const label = typeof v.label === 'string' && v.label.trim() ? v.label.trim().slice(0, 60) : id;
  const tokenCaps = {
    ...(capNum(v.tokenCapPerTask) !== undefined ? { tokenCapPerTask: capNum(v.tokenCapPerTask)! } : {}),
    ...(capNum(v.tokenCapPerDay) !== undefined ? { tokenCapPerDay: capNum(v.tokenCapPerDay)! } : {}),
  };
  if (v.kind === 'cli') {
    if (typeof v.cli !== 'string' || !CLI_KINDS.has(v.cli)) return { reason: `${id}: cli must be codex or opencode` };
    if (typeof v.executable !== 'string' || !isAbsoluteProgramPath(v.executable)) return { reason: `${id}: the program must be given as a full path without special characters` };
    if (v.sandbox !== undefined && v.sandbox !== 'read-only' && v.sandbox !== 'workspace-write') return { reason: `${id}: sandbox must be read-only or workspace-write` };
    const agents = Array.isArray(v.allowedAgents) ? [...new Set(v.allowedAgents.filter((a): a is string => typeof a === 'string' && AGENT_ID_RE.test(a)))].slice(0, 50) : [];
    const t = typeof v.timeoutSeconds === 'number' && Number.isInteger(v.timeoutSeconds) && v.timeoutSeconds >= 10 && v.timeoutSeconds <= 3600 ? v.timeoutSeconds : 900;
    return { entry: { kind: 'cli', cli: v.cli as CliKind, executable: v.executable, sandbox: v.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only', allowedAgents: agents, timeoutSeconds: t, label, baseUrl: '', enabled: v.enabled === true, ...tokenCaps } };
  }
  if (v.wire !== undefined && v.wire !== 'chat' && v.wire !== 'responses') return { reason: `${id}: wire must be chat or responses` };
  const allowPrivate = v.allowPrivateNetwork === true;
  const ep = checkEndpoint(v.baseUrl, { allowPrivate });
  if (!ep.ok) return { reason: `${id}: ${ep.reason}` };
  const models = Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 120 && !/\s/.test(m)).slice(0, 200) : [];
  const prices: Record<string, ProviderPrice> = {};
  if (isObj(v.prices)) for (const [m, p] of Object.entries(v.prices)) { const pp = price(p); if (pp && m.length <= 120 && Object.keys(prices).length < 200) prices[m] = pp; }
  // keyless means "no key", so it only stands where nothing secret could be sent anywhere unexpected
  const keyless = v.keyless === true && (ep.loopback || (allowPrivate && ep.privateLiteral));
  return {
    entry: {
      kind: 'openai-compat', label, baseUrl: ep.url, enabled: v.enabled === true, models,
      ...(v.wire === 'responses' ? { wire: 'responses' as const } : {}),
      ...(keyless ? { keyless: true } : {}), ...(allowPrivate && ep.privateLiteral ? { allowPrivateNetwork: true } : {}),
      ...(Object.keys(prices).length ? { prices } : {}),
      ...(v.trusted === true ? { trusted: true } : {}), ...(v.leadSelectable === true ? { leadSelectable: true } : {}), ...tokenCaps,
    },
  };
}

export function normalizeProviders(raw: unknown): ProvidersConfig {
  const out: ProvidersConfig = { version: 1, entries: {}, maxTurns: DEFAULT_PROVIDERS.maxTurns, maxToolCallsPerTurn: DEFAULT_PROVIDERS.maxToolCallsPerTurn, stdioMcpAllow: {}, leadChoices: {} };
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
  if (isObj(raw.stdioMcpAllow)) for (const [n, f] of Object.entries(raw.stdioMcpAllow)) if (SERVER_NAME_RE.test(n) && typeof f === 'string' && /^[0-9a-f]{64}$/.test(f) && Object.keys(out.stdioMcpAllow).length < 100) out.stdioMcpAllow[n] = f;
  if (isObj(raw.leadChoices)) for (const [a, list] of Object.entries(raw.leadChoices)) {
    if (!AGENT_ID_RE.test(a) || !Array.isArray(list) || Object.keys(out.leadChoices).length >= 100) continue;
    const vals = [...new Set(list.filter((m): m is string => typeof m === 'string' && m.length <= 120 && /^[a-z][a-z0-9-]{1,31}:\S+$/.test(m)))].slice(0, 50);
    if (vals.length) out.leadChoices[a] = vals;
  }
  if (dropped.length) out.dropped = dropped;
  return out;
}
