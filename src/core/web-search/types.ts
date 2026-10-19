/** Shared types of the web search and page read providers (task 28). The setting itself lives in src/shared/web-search-config.ts. */
import type { WebProviderId, WebSearchConfig } from '../../shared/web-search-config.js';

export type { WebProviderId, WebSearchConfig };

export interface SearchHit { title: string; url: string; snippet: string }
export interface WebRequest { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown }
/** What a call cost: micro-USD when the provider reports dollars, credits when it reports those. */
export interface Charge { micro?: number; credits?: number }
export interface AdapterCtx { key?: string; cfg: WebSearchConfig; limit: number }

/** One provider as pure functions: build the request, read the answer. No I/O here. Header names in `headers` passed to parse are lower case. */
export interface WebAdapter {
  id: WebProviderId; label: string; canSearch: boolean; canRead: boolean;
  /** The fixed API origin (a key is saved for it and handed out only for it). undefined: not configured (SearXNG with no address). */
  origin(cfg: WebSearchConfig): string | undefined;
  needsKey: boolean;
  search(query: string, ctx: AdapterCtx): WebRequest;
  parseSearch(status: number, headers: Record<string, string>, json: unknown): { hits: SearchHit[]; charge?: Charge };
  read?(url: string, ctx: AdapterCtx): WebRequest;
  parseRead?(status: number, headers: Record<string, string>, json: unknown): { text: string; charge?: Charge };
}

export type WebErrorCode = 'not_ready' | 'cap' | 'auth' | 'rate' | 'status' | 'network' | 'format' | 'json_disabled' | 'refused';
/** A failure with a code and a message safe to show: it never holds the key, a header or the request. */
export class WebProviderError extends Error {
  constructor(public readonly code: WebErrorCode, message: string) { super(message); this.name = 'WebProviderError'; }
}
