/**
 * One JSON transport for every web provider (task 28). Limits: HTTPS only (http only when the caller says the address is a confirmed private
 * SearXNG one), no redirect is followed (a key must never follow a redirect to another host), 30 s to the first byte, 60 s in all, 2 MB of
 * answer, 64 KB of request. Errors are fixed words: they never hold a header, the key or the request.
 */
import { ERR_FORMAT, ERR_NETWORK, ERR_REFUSED, ERR_TOO_BIG } from '../../shared/web-search-copy.js';
import { WebProviderError } from './types.js';
import type { WebRequest } from './types.js';

/** The shape of fetch: the one file that may use the network defines it, so no other file in this folder names the global. */
export type FetchLike = typeof fetch;

export interface WebLimits { headerMs: number; totalMs: number; maxBodyBytes: number; maxRequestBytes: number }
export const WEB_LIMITS: WebLimits = { headerMs: 30_000, totalMs: 60_000, maxBodyBytes: 2 * 1024 * 1024, maxRequestBytes: 64 * 1024 };

export interface WebReply { status: number; /** lower-case names */ headers: Record<string, string>; /** undefined when the body was not JSON */ json: unknown }

export async function webRequestJson(req: WebRequest, o: { fetchImpl?: FetchLike; signal?: AbortSignal; limits?: Partial<WebLimits>; allowHttp?: boolean; label?: string } = {}): Promise<WebReply> {
  const lim = { ...WEB_LIMITS, ...o.limits };
  const label = o.label ?? 'The provider';
  let u: URL;
  try { u = new URL(req.url); } catch { throw new WebProviderError('refused', ERR_REFUSED); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && o.allowHttp === true)) throw new WebProviderError('refused', ERR_REFUSED);
  if (u.username || u.password) throw new WebProviderError('refused', ERR_REFUSED);
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);
  if (body !== undefined && Buffer.byteLength(body) > lim.maxRequestBytes) throw new WebProviderError('refused', ERR_TOO_BIG);

  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
  let timedOut = false;
  const headerTimer = setTimeout(() => { timedOut = true; ac.abort(); }, lim.headerMs);
  const totalTimer = setTimeout(() => { timedOut = true; ac.abort(); }, lim.totalMs);
  const cleanup = (): void => { clearTimeout(headerTimer); clearTimeout(totalTimer); o.signal?.removeEventListener('abort', onAbort); };
  try {
    let res: Response;
    try {
      res = await (o.fetchImpl ?? fetch)(u.toString(), { method: req.method, headers: req.headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: ac.signal });
    } catch {
      throw new WebProviderError('network', timedOut ? `${label} did not answer in time.` : ERR_NETWORK(label));
    }
    clearTimeout(headerTimer);
    // a redirect is an error: following it could hand the key (or the page address) to another host
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new WebProviderError('refused', ERR_REFUSED);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let text: string;
    try { text = await readCapped(res, lim.maxBodyBytes); } catch (e) {
      if (e instanceof WebProviderError) throw e;
      throw new WebProviderError('network', timedOut ? `${label} did not answer in time.` : ERR_NETWORK(label));
    }
    let parsed: unknown;
    try { parsed = text.trim() ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, headers, json: parsed };
  } finally { cleanup(); }
}

/** The body as text, stopped as soon as it passes the cap. */
async function readCapped(res: Response, max: number): Promise<string> {
  const tooBig = new WebProviderError('format', ERR_FORMAT('The provider') + ' It sent more than 2 MB.');
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw tooBig;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch { /* already closing */ } throw tooBig; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
