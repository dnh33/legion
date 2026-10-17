/**
 * The five providers as pure functions (task 28): how to ask, and how to read the answer. No I/O here; transport.ts sends the request.
 *
 * Provider output is data (R6): each adapter keeps only the fields it knows (title, address, snippet, page text, charge). Everything else in an
 * answer (advice, review invitations, instructions) is dropped here and never reaches the agent. An error message holds fixed words and a
 * status number, never the answer's own text, so a key an answer echoes cannot end up in one (the one exception is a page a provider
 * could not read: its reason, clipped).
 */
import { CAP_MESSAGE, ERR_AUTH, ERR_FORMAT, ERR_JSON_DISABLED, ERR_RATE, ERR_STATUS } from '../../shared/web-search-copy.js';
import { clampTregCap } from '../../shared/web-search-config.js';
import { checkSearxngAddress } from './address.js';
import { WebProviderError } from './types.js';
import type { AdapterCtx, Charge, SearchHit, WebAdapter, WebRequest } from './types.js';
import type { WebSearchConfig } from '../../shared/web-search-config.js';

export const TREG_ORIGIN = 'https://treg.to';
export const EXA_ORIGIN = 'https://api.exa.ai';
export const TAVILY_ORIGIN = 'https://api.tavily.com';
export const BRAVE_ORIGIN = 'https://api.search.brave.com';

const MAX_ROWS = 20;
const TITLE_MAX = 300;
const SNIPPET_MAX = 600;
const REASON_MAX = 300;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const first = (o: Obj, keys: string[]): string | undefined => { for (const k of keys) { const v = str(o[k]); if (v) return v; } return undefined; };
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Throws the coded error for a status that is not 2xx. The answer's text is not copied into it. */
function checkStatus(label: string, status: number, json: unknown, opts: { jsonDisabled?: boolean; cap?: boolean } = {}): void {
  if (status >= 200 && status < 300) return;
  if (opts.jsonDisabled && status === 403) throw new WebProviderError('json_disabled', ERR_JSON_DISABLED);
  if (status === 401 || status === 403) throw new WebProviderError('auth', ERR_AUTH);
  if (status === 402 && opts.cap && JSON.stringify(json ?? null).includes('route_max_cost')) throw new WebProviderError('cap', CAP_MESSAGE(0));
  if (status === 429) throw new WebProviderError('rate', ERR_RATE(label));
  throw new WebProviderError('status', ERR_STATUS(label, status));
}
const needObj = (label: string, json: unknown): Obj => { if (!isObj(json)) throw new WebProviderError('format', ERR_FORMAT(label)); return json; };

function rows(list: unknown[], fields: { title: string[]; url: string[]; snippet: string[] }): SearchHit[] {
  const out: SearchHit[] = [];
  for (const r of list) {
    if (out.length >= MAX_ROWS) break;
    if (!isObj(r)) continue;
    const url = first(r, fields.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: clip(first(r, fields.title) ?? url, TITLE_MAX), url, snippet: clip((first(r, fields.snippet) ?? '').replace(/\s+/g, ' ').trim(), SNIPPET_MAX) });
  }
  return out;
}

const limitOf = (ctx: AdapterCtx): number => Math.min(10, Math.max(1, Math.floor(ctx.limit) || 5));
const json = (extra: Record<string, string>): Record<string, string> => ({ 'Content-Type': 'application/json', Accept: 'application/json', ...extra });

/* ---------- treg ---------- */
// The row field names of a routed answer are not documented (the catalog says "provider-native rows"): these readers are tolerant (ruling U2).
const tregHeaders = (ctx: AdapterCtx): Record<string, string> => json({
  'X-Treg-Token': ctx.key ?? '',
  // the cap is part of every request: a call that would cost more is stopped by treg and nothing is charged
  'X-Treg-Route-Max-Cost': String(clampTregCap(ctx.cfg.tregMaxCostUsd)),
  'X-Treg-Route-Prefer': 'tinyfish',
});
function tregCharge(headers: Record<string, string>, j: Obj): Charge | undefined {
  const h = Number(headers['x-treg-cost-micro']);
  if (headers['x-treg-cost-micro'] !== undefined && Number.isFinite(h) && h >= 0) return { micro: Math.round(h) };
  const meta = isObj(j._treg) ? j._treg : undefined;
  return typeof meta?.charged_micro === 'number' && Number.isFinite(meta.charged_micro) && meta.charged_micro >= 0 ? { micro: Math.round(meta.charged_micro) } : undefined;
}
const tregOut = (j: Obj, key: string): unknown[] => {
  const out = j.output;
  if (isObj(out) && Array.isArray(out[key])) return out[key] as unknown[];
  if (key === 'results' && Array.isArray(out)) return out;
  return arr(j[key]);
};

const treg: WebAdapter = {
  id: 'treg', label: 'treg', canSearch: true, canRead: true, needsKey: true,
  origin: () => TREG_ORIGIN,
  search: (query, ctx) => ({ url: `${TREG_ORIGIN}/call/treg.web.search`, method: 'POST', headers: tregHeaders(ctx), body: { q: query, limit: limitOf(ctx) } }),
  parseSearch(status, headers, j) {
    checkStatus('treg', status, j, { cap: true });
    const o = needObj('treg', j);
    const charge = tregCharge(headers, o);
    return { hits: rows(tregOut(o, 'results'), { title: ['title', 'name'], url: ['url', 'link'], snippet: ['snippet', 'description', 'content', 'text'] }), ...(charge ? { charge } : {}) };
  },
  // the page address goes in the body as data, never as treg.to/call/<address> (that shape fetches any address for anyone)
  read: (url, ctx) => ({ url: `${TREG_ORIGIN}/call/treg.web.extract`, method: 'POST', headers: tregHeaders(ctx), body: { url } }),
  parseRead(status, headers, j) {
    checkStatus('treg', status, j, { cap: true });
    const o = needObj('treg', j);
    const page = tregOut(o, 'pages')[0];
    const charge = tregCharge(headers, o);
    return { text: isObj(page) ? first(page, ['markdown', 'content', 'text', 'raw_content']) ?? '' : '', ...(charge ? { charge } : {}) };
  },
};

/* ---------- Exa ---------- */
function exaCharge(o: Obj): Charge | undefined {
  const c = isObj(o.costDollars) ? o.costDollars.total : undefined;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? { micro: Math.round(c * 1_000_000) } : undefined;
}
const exa: WebAdapter = {
  id: 'exa', label: 'Exa', canSearch: true, canRead: true, needsKey: true,
  origin: () => EXA_ORIGIN,
  search: (query, ctx) => ({ url: `${EXA_ORIGIN}/search`, method: 'POST', headers: json({ 'x-api-key': ctx.key ?? '' }), body: { query, numResults: limitOf(ctx), contents: { text: { maxCharacters: 400 } } } }),
  parseSearch(status, _h, j) {
    checkStatus('Exa', status, j);
    const o = needObj('Exa', j);
    const charge = exaCharge(o);
    return { hits: rows(arr(o.results), { title: ['title'], url: ['url'], snippet: ['text'] }), ...(charge ? { charge } : {}) };
  },
  read: (url, ctx) => ({ url: `${EXA_ORIGIN}/contents`, method: 'POST', headers: json({ 'x-api-key': ctx.key ?? '' }), body: { urls: [url], text: true } }),
  parseRead(status, _h, j) {
    checkStatus('Exa', status, j);
    const o = needObj('Exa', j);
    const page = arr(o.results)[0];
    const charge = exaCharge(o);
    return { text: isObj(page) ? first(page, ['text']) ?? '' : '', ...(charge ? { charge } : {}) };
  },
};

/* ---------- Tavily ---------- */
function tavilyCharge(o: Obj): Charge | undefined {
  const c = isObj(o.usage) ? o.usage.credits : undefined;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? { credits: c } : undefined;
}
const tavily: WebAdapter = {
  id: 'tavily', label: 'Tavily', canSearch: true, canRead: true, needsKey: true,
  origin: () => TAVILY_ORIGIN,
  search: (query, ctx) => ({ url: `${TAVILY_ORIGIN}/search`, method: 'POST', headers: json({ Authorization: `Bearer ${ctx.key ?? ''}` }), body: { query, max_results: limitOf(ctx), search_depth: 'basic' } }),
  parseSearch(status, _h, j) {
    checkStatus('Tavily', status, j);
    const o = needObj('Tavily', j);
    const charge = tavilyCharge(o);
    return { hits: rows(arr(o.results), { title: ['title'], url: ['url'], snippet: ['content'] }), ...(charge ? { charge } : {}) };
  },
  read: (url, ctx) => ({ url: `${TAVILY_ORIGIN}/extract`, method: 'POST', headers: json({ Authorization: `Bearer ${ctx.key ?? ''}` }), body: { urls: [url], format: 'markdown' } }),
  parseRead(status, _h, j) {
    checkStatus('Tavily', status, j);
    const o = needObj('Tavily', j);
    const page = arr(o.results)[0];
    const text = isObj(page) ? first(page, ['raw_content']) ?? '' : '';
    // HTTP 200 does not mean the page was read: the failed list says so
    const failed = arr(o.failed_results)[0];
    if (!text && isObj(failed)) throw new WebProviderError('status', `Tavily could not read the page: ${clip(first(failed, ['error']) ?? 'no reason given', REASON_MAX)}`);
    const charge = tavilyCharge(o);
    return { text, ...(charge ? { charge } : {}) };
  },
};

/* ---------- Brave (search only) ---------- */
const brave: WebAdapter = {
  id: 'brave', label: 'Brave Search', canSearch: true, canRead: false, needsKey: true,
  origin: () => BRAVE_ORIGIN,
  search: (query, ctx) => ({
    url: `${BRAVE_ORIGIN}/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limitOf(ctx)) }).toString()}`,
    method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': ctx.key ?? '' },
  }),
  parseSearch(status, _h, j) {
    checkStatus('Brave Search', status, j);
    const o = needObj('Brave Search', j);
    return { hits: rows(isObj(o.web) ? arr(o.web.results) : [], { title: ['title'], url: ['url'], snippet: ['description'] }) };
  },
};

/* ---------- SearXNG (search only, no key) ---------- */
// The result fields (title, url, content, score) are not in the instance's own API page; they follow the reference plugin and are read tolerantly (ruling U4).
const searxng: WebAdapter = {
  id: 'searxng', label: 'SearXNG', canSearch: true, canRead: false, needsKey: false,
  origin(cfg: WebSearchConfig) {
    const a = cfg.searxng ? checkSearxngAddress(cfg.searxng.baseUrl) : undefined;
    return a?.ok ? a.origin : undefined;
  },
  search(query, ctx): WebRequest {
    const a = ctx.cfg.searxng ? checkSearxngAddress(ctx.cfg.searxng.baseUrl) : undefined;
    if (!a?.ok) throw new WebProviderError('not_ready', 'SearXNG has no valid address. Add it in Settings, Web search.');
    return { url: `${a.url}/search?${new URLSearchParams({ q: query, format: 'json' }).toString()}`, method: 'GET', headers: { Accept: 'application/json' } };
  },
  parseSearch(status, _h, j) {
    checkStatus('SearXNG', status, j, { jsonDisabled: true });
    const o = needObj('SearXNG', j);
    const list = arr(o.results);
    const scored = list.map((r, i) => ({ r, i, s: isObj(r) && typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0 }));
    // best first when the instance scores its results; otherwise its own order
    if (scored.some((x) => x.s !== 0)) scored.sort((a, b) => b.s - a.s || a.i - b.i);
    return { hits: rows(scored.map((x) => x.r), { title: ['title'], url: ['url'], snippet: ['content'] }) };
  },
};

export const ADAPTERS = { treg, exa, tavily, brave, searxng } as const;
