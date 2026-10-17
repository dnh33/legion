/**
 * Web search and page read providers (gates PR 2, task 28): the setting, its default and its one normalizer.
 * Pure data and rules, shared by the core and the Settings page. Off by default: both choices are 'builtin', which changes nothing.
 */

export type WebProviderId = 'treg' | 'exa' | 'tavily' | 'brave' | 'searxng';
export const WEB_PROVIDER_IDS: readonly WebProviderId[] = ['treg', 'exa', 'tavily', 'brave', 'searxng'];

/** What each provider can do and what it is called, in the words the Settings page shows. */
export interface WebProviderMeta { id: WebProviderId; label: string; canSearch: boolean; canRead: boolean; needsKey: boolean }
export const WEB_PROVIDERS: readonly WebProviderMeta[] = [
  { id: 'treg', label: 'treg', canSearch: true, canRead: true, needsKey: true },
  { id: 'exa', label: 'Exa', canSearch: true, canRead: true, needsKey: true },
  { id: 'tavily', label: 'Tavily', canSearch: true, canRead: true, needsKey: true },
  { id: 'brave', label: 'Brave Search', canSearch: true, canRead: false, needsKey: true },
  { id: 'searxng', label: 'SearXNG', canSearch: true, canRead: false, needsKey: false },
];
export const isWebProviderId = (v: unknown): v is WebProviderId => typeof v === 'string' && (WEB_PROVIDER_IDS as readonly string[]).includes(v);
export const webProviderMeta = (id: WebProviderId): WebProviderMeta => WEB_PROVIDERS.find((p) => p.id === id)!;

/** The treg cap per call, in US dollars. The vendor's own default is 1, so that is the ceiling here. */
export const TREG_CAP_MIN = 0.001;
export const TREG_CAP_MAX = 1;
export const TREG_CAP_DEFAULT = 0.01;

export interface WebSearchConfig {
  search: 'builtin' | WebProviderId;
  read: 'builtin' | WebProviderId;
  /** Most one treg call may cost, in USD (0.001 to 1). Sent as a header on every treg call. */
  tregMaxCostUsd: number;
  /** The SearXNG instance. `allowPrivateNetwork` is set only by a change the app confirmed natively. */
  searxng?: { baseUrl: string; allowPrivateNetwork?: boolean };
  /** The day the owner clicked "Use <name>" for each provider. */
  acknowledged: Partial<Record<WebProviderId, string>>;
}

export function defaultWebSearch(): WebSearchConfig {
  return { search: 'builtin', read: 'builtin', tregMaxCostUsd: TREG_CAP_DEFAULT, acknowledged: {} };
}

export function clampTregCap(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(TREG_CAP_MAX, Math.max(TREG_CAP_MIN, v)) : TREG_CAP_DEFAULT;
}

/**
 * Whatever config.json held under "webSearch", reduced to the one shape we accept. A choice that names an unknown provider, or a
 * provider that cannot do that job (Brave and SearXNG cannot read a page), falls back to 'builtin'.
 */
export function normalizeWebSearch(v: unknown): WebSearchConfig {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out = defaultWebSearch();
  if (isWebProviderId(o.search) && webProviderMeta(o.search).canSearch) out.search = o.search;
  if (isWebProviderId(o.read) && webProviderMeta(o.read).canRead) out.read = o.read;
  if (typeof o.tregMaxCostUsd === 'number') out.tregMaxCostUsd = clampTregCap(o.tregMaxCostUsd);
  const sx = o.searxng;
  if (sx && typeof sx === 'object' && !Array.isArray(sx) && typeof (sx as { baseUrl?: unknown }).baseUrl === 'string' && (sx as { baseUrl: string }).baseUrl.length <= 300) {
    out.searxng = { baseUrl: (sx as { baseUrl: string }).baseUrl, ...((sx as { allowPrivateNetwork?: unknown }).allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}) };
  }
  const ack = o.acknowledged;
  if (ack && typeof ack === 'object' && !Array.isArray(ack)) {
    for (const id of WEB_PROVIDER_IDS) { const d = (ack as Record<string, unknown>)[id]; if (typeof d === 'string' && d.length <= 40) out.acknowledged[id] = d; }
  }
  return out;
}
