/**
 * Web search and page read providers (gates PR 2, task 28): readiness, the calls, the cost line, and the validation of the setting.
 *
 * Off by default. Choosing a provider is not a gate loosening: every call an agent makes through it passes the same per-site web check
 * as the built-in tools (engine.ts askGuards). A provider call that fails is shown as the error; it never falls back to another
 * provider and never to the built-in tool. Provider output is data: it reaches the agent only as a tool result, behind a fixed first line.
 */
import { COST_LINE, CREDITS_LINE, ERR_NOT_PICKED, ERR_NOT_SET_UP, ERR_NO_ADDRESS, ERR_PRIVATE, ERR_REFUSED, NO_PAGE_TEXT, NO_RESULTS, WEB_RESULT_HEAD, CAP_MESSAGE } from '../../shared/web-search-copy.js';
import { TREG_CAP_MAX, TREG_CAP_MIN, WEB_PROVIDERS, clampTregCap, defaultWebSearch, isWebProviderId, webProviderMeta } from '../../shared/web-search-config.js';
import type { ProviderKeys } from '../providers/secrets.js';
import { ADAPTERS } from './adapters.js';
import { checkSearxngAddress } from './address.js';
import { webRequestJson } from './transport.js';
import type { FetchLike } from './transport.js';
import { WebProviderError } from './types.js';
import type { Charge, SearchHit, WebProviderId, WebRequest, WebSearchConfig } from './types.js';

export { defaultConfig } from '../../shared/config.js';
export { ADAPTERS, WebProviderError };
export type { Charge, SearchHit, WebProviderId, WebSearchConfig };

/** The longest tool result a provider can produce, in characters (before the fixed head line and the cost line). */
export const WEB_RESULT_MAX = 30_000;

export interface WebCallLog { provider: WebProviderId; tool: 'web_search' | 'web_read'; host?: string; micro?: number }
export interface WebSearchDeps {
  config: () => WebSearchConfig;
  /** Only `get(id, origin)` is used: a key saved for another origin is not handed out. */
  keys: Pick<ProviderKeys, 'get'> & Partial<Pick<ProviderKeys, 'all'>>;
  fetchImpl?: FetchLike;
  log?: (e: WebCallLog) => void;
}

export const keyIdOf = (id: WebProviderId): string => `web:${id}`;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Keeps the start of a page (a docs page is read from the top). */
const cutHead = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}\n[truncated: showing first ${max} of ${s.length} chars]`);

export class WebSearchService {
  constructor(private readonly deps: WebSearchDeps) {}

  /** The same service with another log sink (the engine binds one per run, so a line carries its task). */
  withLog(log: (e: WebCallLog) => void): WebSearchService { return new WebSearchService({ ...this.deps, log }); }

  /** Every stored key, so text Legion is about to store or show can be cleaned of them (the shell redaction reads this). */
  secretValues(): string[] { try { return this.deps.keys.all?.() ?? []; } catch { return []; } }

  /** A key or address is present for the provider's fixed origin. No network. */
  ready(id: WebProviderId): boolean {
    const a = ADAPTERS[id]; const cfg = this.deps.config();
    const origin = a.origin(cfg);
    if (!origin) return false;
    return !a.needsKey || this.deps.keys.get(keyIdOf(id), origin) !== undefined;
  }
  /** The picked search provider, or undefined when the built-in tool is used. */
  searchOn(): WebProviderId | undefined { const v = this.deps.config().search; return v !== 'builtin' && isWebProviderId(v) && ADAPTERS[v].canSearch ? v : undefined; }
  readOn(): WebProviderId | undefined { const v = this.deps.config().read; return v !== 'builtin' && isWebProviderId(v) && ADAPTERS[v].canRead ? v : undefined; }

  async search(query: string, limit = 5, signal?: AbortSignal): Promise<{ text: string; hits: SearchHit[]; charge?: Charge }> {
    const id = this.searchOn();
    if (!id) throw new WebProviderError('not_ready', ERR_NOT_PICKED);
    return this.searchWith(id, query, limit, signal);
  }

  async read(url: string, signal?: AbortSignal): Promise<{ text: string; charge?: Charge }> {
    const id = this.readOn();
    if (!id) throw new WebProviderError('not_ready', ERR_NOT_PICKED);
    const a = ADAPTERS[id];
    const { json, status, headers } = await this.send(id, (ctx) => a.read!(url, ctx), 5, signal);
    const parsed = this.parse(id, () => a.parseRead!(status, headers, json));
    let host: string | undefined;
    try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '') || undefined; } catch { host = undefined; }
    this.logCall({ provider: id, tool: 'web_read', ...(host ? { host } : {}), ...(parsed.charge?.micro !== undefined ? { micro: parsed.charge.micro } : {}) });
    return { text: this.compose(a.label, cutHead(parsed.text.trim() || NO_PAGE_TEXT, WEB_RESULT_MAX), parsed.charge), ...(parsed.charge ? { charge: parsed.charge } : {}) };
  }

  /** Settings, Test: one tiny search on this provider, whether or not it is the picked one. */
  async test(id: WebProviderId | undefined, signal?: AbortSignal): Promise<{ ok: boolean; detail: string; micro?: number }> {
    const use = id ?? this.searchOn();
    if (!use) return { ok: false, detail: ERR_NOT_PICKED };
    try {
      const r = await this.searchWith(use, 'test', 1, signal);
      const label = ADAPTERS[use].label;
      return { ok: true, detail: `${label} answered with ${r.hits.length} ${r.hits.length === 1 ? 'result' : 'results'}.${r.charge?.micro ? ` ${COST_LINE(r.charge.micro, label)}` : ''}`, ...(r.charge?.micro !== undefined ? { micro: r.charge.micro } : {}) };
    } catch (e) {
      return { ok: false, detail: clip(e instanceof WebProviderError ? e.message : 'The test failed.', 300) };
    }
  }

  private async searchWith(id: WebProviderId, query: string, limit: number, signal?: AbortSignal): Promise<{ text: string; hits: SearchHit[]; charge?: Charge }> {
    const a = ADAPTERS[id];
    if (!a.canSearch) throw new WebProviderError('not_ready', ERR_NOT_PICKED);
    const { json, status, headers } = await this.send(id, (ctx) => a.search(query, ctx), limit, signal);
    const parsed = this.parse(id, () => a.parseSearch(status, headers, json));
    this.logCall({ provider: id, tool: 'web_search', ...(parsed.charge?.micro !== undefined ? { micro: parsed.charge.micro } : {}) });
    const body = parsed.hits.length
      ? parsed.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n')
      : NO_RESULTS;
    return { text: this.compose(a.label, cutHead(body, WEB_RESULT_MAX), parsed.charge), hits: parsed.hits, ...(parsed.charge ? { charge: parsed.charge } : {}) };
  }

  /** The fixed head line, the provider's text, and the charge when it is known. */
  private compose(label: string, body: string, charge: Charge | undefined): string {
    const cost = charge?.micro ? COST_LINE(charge.micro, label) : charge?.credits ? CREDITS_LINE(charge.credits, label) : '';
    return [WEB_RESULT_HEAD, body, ...(cost ? [cost] : [])].join('\n');
  }

  private logCall(e: WebCallLog): void { try { this.deps.log?.(e); } catch { /* the log is advisory */ } }

  /** The checks before a byte leaves (ready, origin, address), the request, and the raw answer. Nothing here reads the answer. */
  private async send(id: WebProviderId, build: (ctx: { key?: string; cfg: WebSearchConfig; limit: number }) => WebRequest, limit: number, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; json: unknown }> {
    const a = ADAPTERS[id]; const cfg = this.deps.config();
    const origin = a.origin(cfg);
    if (!origin) throw new WebProviderError('not_ready', id === 'searxng' ? ERR_NO_ADDRESS(a.label) : ERR_NOT_SET_UP(a.label));
    const key = a.needsKey ? this.deps.keys.get(keyIdOf(id), origin) : undefined;
    if (a.needsKey && !key) throw new WebProviderError('not_ready', ERR_NOT_SET_UP(a.label));
    let allowHttp = false;
    if (id === 'searxng') {
      const addr = checkSearxngAddress(cfg.searxng?.baseUrl);
      if (!addr.ok) throw new WebProviderError('not_ready', ERR_NO_ADDRESS(a.label));
      // a loopback or private-network address was confirmed by the app, or it is not used
      if (addr.private && cfg.searxng?.allowPrivateNetwork !== true) throw new WebProviderError('refused', ERR_PRIVATE);
      allowHttp = addr.http;
    }
    let req: WebRequest;
    try { req = build({ ...(key ? { key } : {}), cfg, limit: Math.min(10, Math.max(1, Math.floor(limit) || 5)) }); } catch (e) { throw this.clean(e, key, cfg); }
    // the key goes only to the origin it was saved for
    let reqOrigin = ''; try { reqOrigin = new URL(req.url).origin; } catch { /* refused below */ }
    if (reqOrigin !== origin) throw new WebProviderError('refused', ERR_REFUSED);
    try {
      const r = await webRequestJson(req, { ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}), ...(signal ? { signal } : {}), allowHttp, label: a.label });
      return { status: r.status, headers: r.headers, json: r.json };
    } catch (e) { throw this.clean(e, key, cfg); }
  }

  /** Reads an answer with the adapter. Its errors are coded; the key is taken out of any message, and a cap stop names the owner's cap. */
  private parse<T>(id: WebProviderId, fn: () => T): T {
    const cfg = this.deps.config();
    const key = ADAPTERS[id].needsKey ? this.deps.keys.get(keyIdOf(id), ADAPTERS[id].origin(cfg) ?? '') : undefined;
    try { return fn(); } catch (e) { throw this.clean(e, key, cfg); }
  }

  private clean(e: unknown, key: string | undefined, cfg: WebSearchConfig): WebProviderError {
    if (!(e instanceof WebProviderError)) return new WebProviderError('format', 'The provider answered in a form Legion could not read.');
    if (e.code === 'cap') return new WebProviderError('cap', CAP_MESSAGE(clampTregCap(cfg.tregMaxCostUsd)));
    const msg = key ? e.message.split(key).join('…') : e.message;
    return msg === e.message ? e : new WebProviderError(e.code, msg);
  }
}

/* ---------- the setting: validation of a change ---------- */

export interface WebSearchPatch {
  search?: WebSearchConfig['search']; read?: WebSearchConfig['read']; tregMaxCostUsd?: number;
  /** null: forget the address */
  searxng?: { baseUrl: string; allowPrivateNetwork?: boolean } | null;
}
export interface WebPatchResult {
  ok: boolean; error?: string; patch?: WebSearchPatch;
  /** The provider whose one-time notice the owner must accept first (the page shows it, then sends `acknowledge`). */
  needsNotice?: WebProviderId;
  /** The change needs the app's native confirmation (a new or different SearXNG address, or a higher treg cap). */
  needsNative?: boolean;
  /** Set when the body carried a SearXNG address: whether it is a loopback or private-network one (the dialog words the two apart). */
  privateNetwork?: boolean;
  /** The provider the owner accepted the notice for, when the body named one. */
  acknowledge?: WebProviderId;
}

const KNOWN_KEYS = new Set(['search', 'read', 'tregMaxCostUsd', 'searxng', 'acknowledge']);
const hostOf = (u: string | undefined): string | undefined => { const a = checkSearxngAddress(u); return a.ok ? a.host : undefined; };
const bad = (error: string): WebPatchResult => ({ ok: false, error });

/** Pure. Checks one change against the current setting; nothing is stored here (the route does that after the notice and the native checks). */
export function validateWebSearchPatch(raw: unknown, current: WebSearchConfig = defaultWebSearch()): WebPatchResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('JSON object body required');
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!KNOWN_KEYS.has(k)) return bad(`Unknown setting "${clip(k, 40)}".`);
  const patch: WebSearchPatch = {};
  let needsNative = false;
  let privateNetwork: boolean | undefined;
  for (const job of ['search', 'read'] as const) {
    const v = b[job];
    if (v === undefined) continue;
    if (v === 'builtin') { patch[job] = 'builtin'; continue; }
    if (!isWebProviderId(v)) return bad(`"${job}" must be "builtin" or one of ${WEB_PROVIDERS.map((p) => p.id).join(', ')}.`);
    const meta = webProviderMeta(v);
    if (job === 'read' && !meta.canRead) return bad(`${meta.label} can only search. Pick another provider, or the built-in tool, to read pages.`);
    patch[job] = v;
  }
  if (b.tregMaxCostUsd !== undefined) {
    const v = b.tregMaxCostUsd;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < TREG_CAP_MIN || v > TREG_CAP_MAX) return bad(`The per-call spending cap must be between $${TREG_CAP_MIN} and $${TREG_CAP_MAX}.`);
    patch.tregMaxCostUsd = v;
    // a higher cap lets one call spend more of the owner's money: it needs the app's confirm like every loosening (a lower or equal cap does not)
    if (v > clampTregCap(current.tregMaxCostUsd)) needsNative = true;
  }
  if (b.searxng !== undefined) {
    if (b.searxng === null) patch.searxng = null;
    else {
      const o = b.searxng as { baseUrl?: unknown };
      if (typeof b.searxng !== 'object' || Array.isArray(b.searxng)) return bad('"searxng" must be an object with a baseUrl, or null.');
      const a = checkSearxngAddress(o.baseUrl);
      if (!a.ok) return bad(a.reason);
      patch.searxng = { baseUrl: a.url, ...(a.private ? { allowPrivateNetwork: true } : {}) };
      // Any new or different address needs the app's confirm, like a model provider's address: where every search goes is the owner's call.
      // (A name that resolves to a private address cannot be seen here, so a public name is not enough reason to skip it.)
      if (a.private || !current.searxng || current.searxng.baseUrl !== a.url) needsNative = true;
      privateNetwork = a.private;
    }
  }
  let acknowledge: WebProviderId | undefined;
  if (b.acknowledge !== undefined) { if (!isWebProviderId(b.acknowledge)) return bad('"acknowledge" must name a provider.'); acknowledge = b.acknowledge; }

  const nextSearxng = patch.searxng === undefined ? current.searxng : patch.searxng ?? undefined;
  const nextSearch = patch.search ?? current.search; const nextRead = patch.read ?? current.read;
  if ((nextSearch === 'searxng' || nextRead === 'searxng') && !nextSearxng) return bad('Add the SearXNG address first.');

  // the one-time notice: for a provider newly picked, and for SearXNG again when its host changes
  // with no current address (cleared, or never set) any new address counts as a new host, so clearing it cannot skip the notice
  const hostChanged = patch.searxng !== undefined && patch.searxng !== null && (!current.searxng || hostOf(current.searxng.baseUrl) !== hostOf(patch.searxng.baseUrl));
  let needsNotice: WebProviderId | undefined;
  for (const id of [patch.search, patch.read]) {
    if (!id || id === 'builtin') continue;
    if (!current.acknowledged[id] || (id === 'searxng' && hostChanged)) { needsNotice = id; break; }
  }
  if (!needsNotice && hostChanged && current.acknowledged.searxng) needsNotice = 'searxng';

  return { ok: true, patch, ...(needsNotice ? { needsNotice } : {}), ...(needsNative ? { needsNative: true } : {}), ...(privateNetwork !== undefined ? { privateNetwork } : {}), ...(acknowledge ? { acknowledge } : {}) };
}
