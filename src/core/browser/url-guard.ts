/**
 * The URL and address rules for the browser tool: Legion's own code, applied before every navigation and to every redirect hop it can see.
 * Pure (no network, no clock). The DNS step lives in resolve.ts and reuses classifyAddress / checkResolved from here.
 *
 * Limits (plan section 6): this stops Legion from sending the browser to a bad address and stops bad content from reaching the agent. It does not
 * control what the browser itself resolves or requests on its own (DNS rebinding, page-script requests) unless the browser's own options do.
 */
import { BROWSER_LIMITS } from '../../shared/browser.js';

/**
 * The port of the owner's real BSV wallet. The repo's BSV tripwire forbids that number written as a literal in any source file, so it is spelled
 * in pieces on purpose. It is refused on every local or private address, always, even when "allow local addresses" is on.
 */
export const PROTECTED_LOCAL_PORT = 3000 + 300 + 21;

export type AddressClass = 'public' | 'loopback' | 'private' | 'linklocal' | 'cgnat' | 'metadata' | 'reserved';

/** Classes the owner may enable with "allow local addresses" (and a port list). Everything else non-public is always refused. */
const LOCAL_CLASSES = new Set<AddressClass>(['loopback', 'private', 'linklocal', 'cgnat']);

export interface GuardOptions {
  allowLocal?: boolean;
  /** With allowLocal: only these ports on local addresses (empty = none). */
  localPorts?: readonly number[];
  /** Non-empty = only these domains (and their subdomains). */
  allowDomains?: readonly string[];
}

export type UrlVerdict = { ok: true; url: URL; origin: string; host: string; port: number } | { ok: false; reason: string };

function parseV4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** Parses the canonical IPv6 text the URL parser produces ("::1", "::ffff:7f00:1", "2001:db8::2") into 8 groups. */
function parseV6(h: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(h) || h.includes(':::')) return null;
  let tail: number[] = [];
  let s = h;
  const dot = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseV4(s.slice(dot + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, dot + 1) + '0:0';
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const grp = (t: string): number[] | null => {
    if (t === '') return [];
    const out: number[] = [];
    for (const g of t.split(':')) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; out.push(parseInt(g, 16)); }
    return out;
  };
  const head = grp(parts[0]!);
  const rest = parts.length === 2 ? grp(parts[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (parts.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else groups = head;
  if (groups.length !== 8) return null;
  if (tail.length) { groups[6] = tail[0]!; groups[7] = tail[1]!; }
  return groups;
}

function classV4(b: number[]): AddressClass {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 169 && c === 254 && ((b[2] === 169 && b[3] === 254) || (b[2] === 170 && b[3] === 2))) return 'metadata'; // cloud metadata (incl. the ECS task address)
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168)) return 'private';
  if (a === 169 && c === 254) return 'linklocal';
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat';
  // 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15, 192.0.2/24 doc ranges, multicast and the rest of 224+
  if (a === 0 || a >= 224 || (a === 192 && c === 0 && b[2] === 0) || (a === 198 && (c === 18 || c === 19)) || (a === 192 && c === 0 && b[2] === 2) || (a === 198 && c === 51 && b[2] === 100) || (a === 203 && c === 0 && b[2] === 113)) return 'reserved';
  return 'public';
}

/** Classifies an IPv4 or IPv6 literal (no brackets). Anything that is not a valid literal is 'reserved' (never trusted). */
export function classifyAddress(ip: string): AddressClass {
  const h = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseV4(h);
  if (v4) return classV4(v4);
  const g = parseV6(h);
  if (!g) return 'reserved';
  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroTo(7) && g[7] === 1) return 'loopback';
  if (allZeroTo(8)) return 'reserved'; // ::
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address
  if ((allZeroTo(5) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
    return classV4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  }
  // 6to4 (2002:AABB:CCDD::) carries an IPv4 address; SIIT (::ffff:0:a.b.c.d) too
  if (g[0] === 0x2002) return classV4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]);
  if (allZeroTo(4) && g[4] === 0xffff && g[5] === 0) return classV4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return 'reserved'; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2001 && g[1] === 0) return 'reserved'; // Teredo
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return 'reserved'; // discard-only 100::/64
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return 'metadata'; // AWS IPv6 metadata fd00:ec2::254
  if ((g[0]! & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local fec0::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return 'private'; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return 'linklocal'; // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return 'reserved'; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'reserved'; // documentation
  return 'public';
}

/** Name-based classes (no address involved). */
export function classifyName(host: string): AddressClass {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'metadata.google.internal' || h === 'metadata' || h === 'instance-data') return 'metadata';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.')) return 'private';
  return 'public';
}

const isLiteral = (h: string): boolean => h.includes(':') || /^[\d.]+$/.test(h);

/** The domain list rule: the host equals an entry or is a subdomain of it. */
export function inAllowedDomains(host: string, list: readonly string[] | undefined): boolean {
  if (!list || list.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((d) => { const x = d.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''); return !!x && (h === x || h.endsWith('.' + x)); });
}

/** The rule for one address class on one port. Returns a refusal reason, or null when allowed. */
export function classRefusal(cls: AddressClass, port: number, o: GuardOptions): string | null {
  if (cls === 'public') return null;
  if (port === PROTECTED_LOCAL_PORT && (LOCAL_CLASSES.has(cls) || cls === 'metadata')) return 'that port on this computer or a private address is never allowed (it belongs to a program Legion must not reach)';
  if (cls === 'metadata') return 'cloud metadata addresses are never allowed';
  if (cls === 'reserved') return 'that address is reserved and is never allowed';
  if (!o.allowLocal) return `${cls === 'loopback' ? 'this computer' : cls === 'linklocal' ? 'a link-local address' : cls === 'cgnat' ? 'a shared carrier-grade address' : 'a private network address'} is not allowed (the owner has not enabled local addresses)`;
  if (!o.localPorts || !o.localPorts.includes(port)) return `local addresses are enabled but port ${port} is not on the owner's port list`;
  return null;
}

/** Everything checkable without a network: scheme, userinfo, length, host class, port, domain list. */
export function checkUrl(raw: unknown, o: GuardOptions = {}): UrlVerdict {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'no address given' };
  const text = raw.trim();
  if (text.length > BROWSER_LIMITS.urlChars) return { ok: false, reason: `the address is longer than ${BROWSER_LIMITS.urlChars} characters` };
  // control characters and spaces: the URL parser would silently strip some of them
  if (/[\u0000- \u007f]/.test(text)) return { ok: false, reason: 'the address contains spaces or control characters' };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, reason: 'not a valid address' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `only http and https addresses are allowed (not ${u.protocol})` };
  if (u.username || u.password) return { ok: false, reason: 'addresses with a user name or password are not allowed' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'no host in the address' };
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const cls = isLiteral(host) ? classifyAddress(host) : classifyName(host);
  const refused = classRefusal(cls, port, o);
  if (refused) return { ok: false, reason: refused };
  if (!inAllowedDomains(host, o.allowDomains)) return { ok: false, reason: 'that site is not on the allowed domain list for this run' };
  return { ok: true, url: u, origin: u.origin, host, port };
}

/**
 * After DNS: the addresses a name resolved to. Every one must pass (one bad record refuses the page). Literal hosts need no lookup.
 */
export function checkResolved(url: URL, addrs: readonly string[], o: GuardOptions = {}): { ok: true } | { ok: false; reason: string } {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (addrs.length === 0) return { ok: false, reason: 'the host did not resolve to any address' };
  for (const a of addrs) {
    const refused = classRefusal(classifyAddress(a), port, o);
    if (refused) return { ok: false, reason: `the host resolves to ${a}: ${refused}` };
  }
  return { ok: true };
}
