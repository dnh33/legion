/** The DNS step of the URL guard: resolve the host with an injected resolver and check every answer. Real resolver in system.ts's neighbour: lookupAll below uses node:dns only. */
import { lookup } from 'node:dns/promises';
import { checkResolved, checkUrl } from './url-guard.js';
import type { GuardOptions, UrlVerdict } from './url-guard.js';

export type Resolver = (host: string) => Promise<string[]>;

export const lookupAll: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const isLiteral = (h: string): boolean => h.includes(':') || /^[\d.]+$/.test(h);

/** checkUrl, then (for a name, not a literal address) the resolved addresses. A resolver failure refuses the page. */
export async function checkUrlResolved(raw: unknown, o: GuardOptions, resolve: Resolver = lookupAll): Promise<UrlVerdict> {
  const v = checkUrl(raw, o);
  if (!v.ok || isLiteral(v.host)) return v;
  let addrs: string[];
  try { addrs = await resolve(v.host); } catch { return { ok: false, reason: 'the host name could not be resolved' }; }
  const r = checkResolved(v.url, addrs, o);
  return r.ok ? v : { ok: false, reason: r.reason };
}
