/**
 * Loopback-only guard (plan: claude/plan-loopback.md). Legion's own HTTP server may only be reached from this computer, by name 127.0.0.1 or localhost.
 * Pure functions plus one listen helper; no node:http / node:net import on purpose (the BSV tripwire lists the files that may have them).
 *
 * What it does, in order, for EVERY request before any route (including /health, /mcp and the event stream):
 *   1. the socket's remote address must be loopback (127.0.0.0/8, ::1, ::ffff:127.x), else the connection is destroyed;
 *   2. the Host header must be exactly 127.0.0.1:<port> or localhost:<port> (a tunnel, a port forward or a DNS-rebinding page sends another one) -> 421;
 *   3. an Origin header, if present, must be on a tight list; 'null' and 'file://' only for the Electron app window (its User-Agent, which a web page cannot set) -> 403;
 *   4. a request a browser sent (Sec-Fetch-Site present) that is not same-origin needs an allowed Origin; 'none' is only for plain GET/HEAD -> 403.
 * Non-browser clients (curl, the stdio proxy, the Electron main process) send no Origin and no Sec-Fetch-Site and still need the bearer token.
 *
 * Limits (stated in the plan): another process of the same user on this computer is not stopped; a tunnel the owner sets up that
 * rewrites the Host header to 127.0.0.1:<port> still carries whatever token its user sends.
 */

/** The only address Legion's own servers listen on. No config, env var or CLI argument changes it (test/net-guard-source.test.ts reads src/). */
export const LOOPBACK_HOST = '127.0.0.1';

/** Browser origins of the UI in dev (vite) and the one the core itself would serve. */
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const ELECTRON_UA = /\sElectron\/\d/;

interface SocketLike { remoteAddress?: string | undefined; destroy(): unknown }
interface ReqLike { headers: Record<string, string | string[] | undefined>; method?: string; socket: { remoteAddress?: string | undefined } }

/** True for 127.0.0.0/8 (dotted), ::1, and the IPv4-mapped forms of 127.x (::ffff:127.0.0.1 and ::ffff:7f00:1). Anything else, including undefined, is false. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/.exec(a);
  if (mapped) {
    const rest = mapped[1]!;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) return (parseInt(hex[1]!, 16) >> 8) === 127;
    return isDottedLoopback(rest);
  }
  return isDottedLoopback(a);
}
function isDottedLoopback(a: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) && o[0] === 127;
}

/** Host header values this server answers to for the given port. [::1] is NOT included: the server does not listen on IPv6. */
export function allowedHosts(port: number): string[] { return [`127.0.0.1:${port}`, `localhost:${port}`]; }
export function hostAllowed(host: string | string[] | undefined, port: number): boolean {
  if (typeof host !== 'string' || !host) return false;
  return allowedHosts(port).includes(host.toLowerCase());
}

/** Origin allow rule. `null` and `file://` (what the Electron window sends, loaded from file) are accepted only with an Electron User-Agent. */
export function originAllowed(origin: string, port: number, userAgent: string | undefined): boolean {
  if (origin === 'null' || origin === 'file://') return typeof userAgent === 'string' && ELECTRON_UA.test(userAgent);
  if (DEV_ORIGINS.has(origin)) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export type GuardDecision = { ok: true } | { ok: false; status: 403 | 421; error: string; destroy?: boolean };
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The whole request check, pure. `port` is the port the server really listens on. */
export function checkRequest(req: ReqLike, port: number): GuardDecision {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return { ok: false, status: 403, error: 'not_loopback', destroy: true };
  if (!hostAllowed(req.headers.host, port)) return { ok: false, status: 421, error: 'misdirected_request: Legion answers only on 127.0.0.1 or localhost' };
  const origin = one(req.headers.origin);
  const ua = one(req.headers['user-agent']);
  if (origin !== undefined && !originAllowed(origin, port, ua)) return { ok: false, status: 403, error: 'origin_not_allowed' };
  const site = one(req.headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin') {
    const m = (req.method ?? 'GET').toUpperCase();
    if (site === 'none') {
      if (m !== 'GET' && m !== 'HEAD') return { ok: false, status: 403, error: 'browser_request_refused' };
    } else if (origin === undefined && !(typeof ua === 'string' && ELECTRON_UA.test(ua))) {
      return { ok: false, status: 403, error: 'browser_request_refused' };
    }
  }
  return { ok: true };
}

/** Connection-level check: destroy a socket whose peer is not loopback before any byte is parsed. Returns true when it was destroyed. */
export function dropNonLoopback(sock: SocketLike): boolean {
  if (isLoopbackAddress(sock.remoteAddress)) return false;
  try { sock.destroy(); } catch { /* ignore */ }
  return true;
}

/** True when a listening server's address is loopback (a string address, i.e. a pipe, is not). */
export function addressIsLoopback(addr: unknown): boolean {
  return !!addr && typeof addr === 'object' && isLoopbackAddress((addr as { address?: string }).address);
}

interface ListenLike {
  listen(port: number, host: string): unknown;
  address(): unknown;
  once(ev: 'listening', cb: () => void): unknown;
  close(): unknown;
}
/**
 * The one place that calls `.listen(`. Listens on LOOPBACK_HOST only, then asserts the bound address is loopback; if not, closes and calls `onViolation`
 * (the core passes a process exit). `onListening` runs only after the check passed.
 */
export function listenLoopback(server: ListenLike, port: number, onListening: () => void, onViolation: (addr: unknown) => void): void {
  server.once('listening', () => {
    const addr = server.address();
    if (!addressIsLoopback(addr)) { try { server.close(); } catch { /* ignore */ } onViolation(addr); return; }
    onListening();
  });
  server.listen(port, LOOPBACK_HOST);
}
