/** Endpoint URL rules (pure, no network): the same checks run when a config is loaded and again before every request. */

export interface EndpointOk { ok: true; origin: string; host: string; loopback: boolean; privateLiteral: boolean; url: string }
export interface EndpointBad { ok: false; reason: string }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : undefined;
}

/** A literal IPv4 or IPv6 address in a private, link-local, unique-local or loopback range (not a hostname: no DNS lookup is made). */
export function isPrivateLiteral(host: string): boolean {
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.startsWith('[')) {
    const h = host.slice(1, -1).toLowerCase();
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateLiteral(mapped[1]!);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // a mapped v4 written in hex: treated as private rather than decoded
  }
  return false;
}

/**
 * Accepts https anywhere, and http only for localhost, 127.0.0.1 and [::1]. Refuses user info, a fragment, any other scheme,
 * and a literal private-network address unless `allowPrivate` (set only by a native-confirmed change).
 */
export function checkEndpoint(raw: unknown, opts: { allowPrivate?: boolean } = {}): EndpointOk | EndpointBad {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) return { ok: false, reason: 'The address must be a URL of at most 300 characters.' };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: 'The address is not a valid URL.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only https addresses are allowed (http only for this computer: localhost or 127.0.0.1).' };
  if (u.username || u.password) return { ok: false, reason: 'The address must not contain a user name or password.' };
  if (u.hash) return { ok: false, reason: 'The address must not contain a # fragment.' };
  if (u.search) return { ok: false, reason: 'The address must not contain a query string.' };
  const loopback = LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol === 'http:' && !loopback) return { ok: false, reason: 'http is only allowed for this computer (localhost or 127.0.0.1). Use https for any other host.' };
  const privateLiteral = isPrivateLiteral(u.hostname);
  if (privateLiteral && !loopback && !opts.allowPrivate) return { ok: false, reason: 'A private-network address needs your confirmation in the Legion app.' };
  const url = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return { ok: true, origin: u.origin, host: u.host, loopback, privateLiteral, url };
}
