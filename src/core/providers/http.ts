/**
 * The ONLY place Legion's own code makes a request to a model provider. Rules, all enforced here and not by the callers:
 * the address is the configured provider's base address plus a fixed path (a model or tool never supplies a URL); https except for
 * this computer; no redirect is ever followed; the key goes only to the origin it was saved for; every wait has a timeout and every
 * body has a size cap; at most four requests are in flight. The tripwire lists this file by path, so the rules above are what keep
 * it to the owner's configured providers (see test/providers-http.test.ts).
 */
import { checkEndpoint } from './endpoint.js';
import type { ProviderEntry } from './types.js';

export interface HttpLimits {
  /** Until the response headers arrive. */
  headerMs: number;
  /** Between two chunks of a body or stream. */
  idleMs: number;
  /** The whole request, stream included. */
  totalMs: number;
  maxRequestBytes: number;
  /** A non-stream response body. */
  maxBodyBytes: number;
  /** All text of one stream. */
  maxStreamBytes: number;
  /** One line of a stream. */
  maxLineBytes: number;
  /** Concurrent requests across all providers. */
  maxInFlight: number;
}
export const DEFAULT_LIMITS: HttpLimits = {
  headerMs: 30_000, idleMs: 60_000, totalMs: 10 * 60_000,
  maxRequestBytes: 2 * 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024, maxStreamBytes: 4 * 1024 * 1024, maxLineBytes: 1024 * 1024, maxInFlight: 4,
};

export type ProviderErrorCode = 'refused' | 'timeout' | 'too_large' | 'redirect' | 'status' | 'network' | 'aborted' | 'format';
export class ProviderHttpError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string, public readonly status?: number, public readonly retryAfterSec?: number) {
    super(message); this.name = 'ProviderHttpError';
  }
}

export interface ProviderTarget {
  entry: ProviderEntry;
  /** The key, if one is saved. */
  key?: string;
  /** The origin the key was saved for. */
  keyOrigin?: string;
}

export type ProviderResponse =
  | { kind: 'json'; json: unknown }
  | { kind: 'sse'; events: AsyncGenerator<string, void, void> };

export interface RequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  /** 'json': a stream is an error. 'any': a JSON body or an event stream. */
  accept: 'json' | 'any';
  signal?: AbortSignal;
  limits?: Partial<HttpLimits>;
}

// ---- concurrency: one counter for the whole process
let inFlight = 0;
const waiters: Array<() => void> = [];
async function acquire(max: number, signal?: AbortSignal): Promise<void> {
  while (inFlight >= max) {
    if (signal?.aborted) throw new ProviderHttpError('aborted', 'Cancelled.');
    await new Promise<void>((res) => { waiters.push(res); });
  }
  inFlight++;
}
function release(): void { inFlight--; const w = waiters.shift(); if (w) w(); }
/** Test hook: how many requests are in flight right now. */
export const providerRequestsInFlight = (): number => inFlight;

const PATH_RE = /^\/[A-Za-z0-9_\-./]{0,120}$/;

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ProviderHttpError('timeout', 'The provider stopped sending data (no data for a while).')), idleMs); });
  try { return await Promise.race([reader.read(), idle]); } finally { if (t) clearTimeout(t); }
}

async function readCapped(res: Response, max: number, idleMs: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let total = 0; let out = '';
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, idleMs);
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new ProviderHttpError('too_large', `The provider's answer is larger than the ${Math.round(max / 1024)} KiB limit.`);
      out += dec.decode(value, { stream: true });
    }
    return out + dec.decode();
  } finally { try { void reader.cancel().catch(() => undefined); } catch { /* ignore */ } }
}

/** The provider's own error message, if its body has one (OpenAI-style `error.message`), else the status line. */
function errorTextOf(status: number, body: string): string {
  let msg = '';
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const e = j.error;
    msg = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : typeof j.message === 'string' ? j.message : '';
  } catch { msg = body.replace(/\s+/g, ' ').trim(); }
  return clip(msg, 300) || `HTTP ${status}`;
}

export async function providerRequest(target: ProviderTarget, path: string, opts: RequestOptions): Promise<ProviderResponse> {
  const lim: HttpLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const { entry } = target;
  if (!entry.enabled) throw new ProviderHttpError('refused', 'This provider is turned off in Settings.');
  const ep = checkEndpoint(entry.baseUrl, { allowPrivate: entry.allowPrivateNetwork === true });
  if (!ep.ok) throw new ProviderHttpError('refused', ep.reason);
  if (!PATH_RE.test(path) || path.includes('..')) throw new ProviderHttpError('refused', 'Not an allowed provider path.');
  const keylessOk = entry.keyless === true && (ep.loopback || (entry.allowPrivateNetwork === true && ep.privateLiteral));
  if (!target.key && !keylessOk) throw new ProviderHttpError('refused', 'No API key is saved for this provider. Add one in Settings, Providers.');
  if (target.key && target.keyOrigin !== ep.origin) throw new ProviderHttpError('refused', "The saved key belongs to a different address than this provider's. Save the key again in Settings, Providers.");
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload !== undefined && Buffer.byteLength(payload) > lim.maxRequestBytes) throw new ProviderHttpError('too_large', 'The request is larger than the limit Legion allows to send.');
  if (opts.signal?.aborted) throw new ProviderHttpError('aborted', 'Cancelled.');

  await acquire(lim.maxInFlight, opts.signal);
  const ac = new AbortController();
  let reason: 'header' | 'total' | 'cancel' | undefined;
  const onAbort = () => { reason = 'cancel'; ac.abort(); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const headerTimer = setTimeout(() => { reason = 'header'; ac.abort(); }, lim.headerMs);
  const totalTimer = setTimeout(() => { reason = 'total'; ac.abort(); }, lim.totalMs);
  let released = false;
  const cleanup = () => {
    clearTimeout(headerTimer); clearTimeout(totalTimer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (!released) { released = true; release(); }
  };
  try {
    const headers: Record<string, string> = { Accept: opts.accept === 'any' ? 'text/event-stream, application/json' : 'application/json' };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (target.key) headers.Authorization = `Bearer ${target.key}`;
    let res: Response;
    try {
      res = await fetch(`${ep.url}${path}`, { method: opts.method, headers, body: payload, redirect: 'manual', signal: ac.signal });
    } catch (e) {
      if (reason === 'cancel') throw new ProviderHttpError('aborted', 'Cancelled.');
      if (reason === 'header') throw new ProviderHttpError('timeout', `${ep.host} did not answer in time.`);
      if (reason === 'total') throw new ProviderHttpError('timeout', 'The request took longer than the time limit.');
      const code = (e as { cause?: { code?: string } })?.cause?.code;
      throw new ProviderHttpError('network', `Could not reach ${ep.host}${code ? ` (${code})` : ''}.`);
    }
    clearTimeout(headerTimer);
    if (res.status >= 300 && res.status < 400) {
      try { void res.body?.cancel().catch(() => undefined); } catch { /* ignore */ }
      throw new ProviderHttpError('redirect', `${ep.host} answered with a redirect (${res.status}). Legion does not follow redirects; set the provider's address to the final one.`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      const body = await readCapped(res, 16 * 1024, lim.idleMs).catch(() => '');
      const ra = Number(res.headers.get('retry-after'));
      throw new ProviderHttpError('status', errorTextOf(res.status, body), res.status, Number.isFinite(ra) && ra >= 0 ? ra : undefined);
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      if (opts.accept !== 'any') throw new ProviderHttpError('format', 'The provider answered with a stream where a plain answer was expected.');
      return { kind: 'sse', events: sseEvents(res, lim, ac, cleanup) };
    }
    if (!ct.includes('application/json')) throw new ProviderHttpError('format', 'The provider answered with something other than JSON.');
    const text = await readCapped(res, lim.maxBodyBytes, lim.idleMs);
    cleanup();
    try { return { kind: 'json', json: JSON.parse(text) }; } catch { throw new ProviderHttpError('format', 'The provider answered with JSON Legion could not read.'); }
  } catch (e) {
    cleanup();
    if (e instanceof ProviderHttpError) throw e;
    if (reason === 'cancel') throw new ProviderHttpError('aborted', 'Cancelled.');
    throw new ProviderHttpError('network', `Could not reach ${ep.host}.`);
  }
}

/** The `data:` payloads of an event stream, one string per line. Comments, `event:` lines and blank lines are skipped. */
async function* sseEvents(res: Response, lim: HttpLimits, ac: AbortController, cleanup: () => void): AsyncGenerator<string, void, void> {
  if (!res.body) { cleanup(); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let total = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await readChunk(reader, lim.idleMs); } catch (e) { ac.abort(); throw e; }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > lim.maxStreamBytes) { ac.abort(); throw new ProviderHttpError('too_large', `The provider's streamed answer is larger than the ${Math.round(lim.maxStreamBytes / 1024)} KiB limit.`); }
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.length > lim.maxLineBytes) { ac.abort(); throw new ProviderHttpError('too_large', 'One line of the provider stream is larger than the limit.'); }
        if (line.startsWith('data:')) yield line.slice(5).replace(/^ /, '');
      }
      if (buf.length > lim.maxLineBytes) { ac.abort(); throw new ProviderHttpError('too_large', 'One line of the provider stream is larger than the limit.'); }
    }
    const rest = (buf + dec.decode()).replace(/\r$/, '');
    if (rest.startsWith('data:')) yield rest.slice(5).replace(/^ /, '');
  } finally {
    try { void reader.cancel().catch(() => undefined); } catch { /* ignore */ }
    cleanup();
  }
}
