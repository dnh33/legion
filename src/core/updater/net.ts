/**
 * The only outbound network code of the updater. Every request, and every redirect hop, is checked by `validateUrl` against the source's
 * policy (production: https, port 443, github.com and GitHub's two release-asset hosts; no credentials, no cookies, no tokens).
 * Redirects are followed by hand, at most LIMITS.maxRedirects. Sizes are capped while streaming, not only by the headers.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LIMITS, type NetPolicy } from './config.js';

export type NetErrorKind = 'policy' | 'offline' | 'timeout' | 'rate-limit' | 'http' | 'size';
export class NetError extends Error {
  constructor(public readonly kind: NetErrorKind, message: string, public readonly retryAfterMs?: number) { super(message); }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Throws NetError('policy') unless the URL may be requested under this policy. */
export function validateUrl(raw: string, policy: NetPolicy): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new NetError('policy', 'not a valid address'); }
  if (u.username || u.password) throw new NetError('policy', 'an address with credentials is refused');
  const loop = policy.allowLoopbackHttp && LOOPBACK.has(u.hostname);
  if (u.protocol === 'http:') { if (!loop) throw new NetError('policy', 'plain http is refused'); }
  else if (u.protocol === 'https:') { if (!loop && u.port !== '' && u.port !== '443') throw new NetError('policy', 'only port 443 is allowed'); }
  else throw new NetError('policy', 'only https is allowed');
  if (!policy.hosts.includes(u.hostname)) throw new NetError('policy', `host ${u.hostname} is not on the update allowlist`);
  return u;
}

export type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
const HEADERS = (version: string): Record<string, string> => ({ 'user-agent': `Legion-Updater/${version}`, accept: '*/*' });

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  const n = h ? Number(h) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n * 1000, 24 * 3600_000) : undefined;
}

/** GET with manual, re-validated redirects. Returns the final 200 response (body unread). */
async function get(url: string, policy: NetPolicy, o: { version: string; timeoutMs: number; fetchImpl?: FetchLike }): Promise<Response> {
  let current = validateUrl(url, policy).toString();
  const f: FetchLike = o.fetchImpl ?? ((u, init) => fetch(u, init));
  for (let hop = 0; ; hop++) {
    let res: Response;
    try { res = await f(current, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs), headers: HEADERS(o.version) }); }
    catch (e) {
      const name = (e as { name?: string }).name;
      throw new NetError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'offline', 'could not reach the update server');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new NetError('http', 'a redirect without a location');
      if (hop >= LIMITS.maxRedirects) throw new NetError('policy', 'too many redirects');
      current = validateUrl(new URL(loc, current).toString(), policy).toString(); // every hop is checked again
      continue;
    }
    if (res.status === 403 || res.status === 429) throw new NetError('rate-limit', `the server refused the request (HTTP ${res.status})`, retryAfter(res) ?? 3600_000);
    if (res.status === 404) throw new NetError('http', 'not found (HTTP 404)');
    if (res.status >= 500) throw new NetError('offline', `the server had a problem (HTTP ${res.status})`);
    if (!res.ok || !res.body) throw new NetError('http', `unexpected answer (HTTP ${res.status})`);
    return res;
  }
}

const declared = (res: Response): number => { const n = Number(res.headers.get('content-length') ?? NaN); return Number.isFinite(n) ? n : -1; };

/** A small file (manifest, signature) into memory, never more than `maxBytes`. */
export async function fetchSmall(url: string, policy: NetPolicy, o: { maxBytes: number; version: string; timeoutMs?: number; fetchImpl?: FetchLike }): Promise<Buffer> {
  const res = await get(url, policy, { version: o.version, timeoutMs: o.timeoutMs ?? LIMITS.requestTimeoutMs, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  if (declared(res) > o.maxBytes) { void res.body?.cancel(); throw new NetError('size', 'the answer is larger than the limit'); }
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > o.maxBytes) throw new NetError('size', 'the answer is larger than the limit');
      chunks.push(c);
    }
  } catch (e) { if (e instanceof NetError) throw e; throw new NetError('offline', 'the connection broke while reading'); }
  return Buffer.concat(chunks);
}

/** The package to `dest` (a .part file, removed on any failure): at most `exactSize` bytes, and exactly that many, hashed while streaming. */
export async function downloadFile(url: string, policy: NetPolicy, dest: string, o: { exactSize: number; version: string; onProgress?: (bytes: number) => void; timeoutMs?: number; fetchImpl?: FetchLike }): Promise<{ sha256: string; bytes: number }> {
  const res = await get(url, policy, { version: o.version, timeoutMs: o.timeoutMs ?? LIMITS.downloadTimeoutMs, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  const len = declared(res);
  if (len > o.exactSize || (len >= 0 && len !== o.exactSize)) { void res.body?.cancel(); throw new NetError('size', 'the download size differs from the signed size'); }
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > o.exactSize) { cb(new NetError('size', 'the download is larger than the signed size')); return; }
      hash.update(chunk);
      o.onProgress?.(bytes);
      cb(null, chunk);
    },
  });
  try { await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(dest, { flags: 'wx' })); }
  catch (e) {
    try { rmSync(dest, { force: true }); } catch { /* ignore */ }
    if (e instanceof NetError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new NetError(code === 'ENOSPC' ? 'size' : 'offline', code === 'ENOSPC' ? 'the disk is full' : 'the download was interrupted');
  }
  if (bytes !== o.exactSize) { try { rmSync(dest, { force: true }); } catch { /* ignore */ } throw new NetError('size', 'the download is shorter than the signed size'); }
  return { sha256: hash.digest('hex'), bytes };
}
