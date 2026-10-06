/**
 * The wallet STATUS probe (rung 1 of the wallet ladder). READ-ONLY and the only file in Legion that contains wallet method names.
 *
 * It asks a BRC-100 wallet on this computer four harmless questions: its version, its network, whether it is signed in, and the chain
 * height it knows. Nothing here reveals a balance, a key or an address, and nothing here can sign or spend: the method list below is the
 * whole vocabulary, every outgoing call is checked against it before any socket opens, and a caller can only NARROW it (an option that
 * names any other method is dropped). test/bsv-scan.ts fails the build if another wallet method name appears anywhere else in src/ or
 * ui/src, or if this file names anything outside the four.
 *
 * Safety properties (each has a test):
 *  - loopback only: the configured URL must be http://127.0.0.1, http://[::1] or http://localhost (with a plain port, no credentials,
 *    no path, no query). `localhost` is connected as the literal 127.0.0.1, so a name lookup can never move the probe to another machine.
 *  - no redirects are followed, no keep-alive, one request per method, never a retry; the whole probe has a hard deadline.
 *  - a response is read through a 4 KB cap, must be HTTP 200 and a JSON object, and only whitelisted fields of the right type survive.
 *    The raw body is never kept, logged or returned. `version` is a semantic version (1.2.3, with an optional -prerelease and +build) or it is dropped (no text channel).
 *  - there is no default address and no contact until the owner presses Connect (in memory only: every launch starts disconnected).
 *  - the answer is an unverified claim: any program on the computer can listen on that port.
 *
 * What is NOT verified (no real wallet was contacted while building this): whether BSV Desktop answers these four methods without a
 * permission prompt, whether it needs a particular `Origin`, and the exact JSON shapes ({version}, {network}, {authenticated},
 * {height} per BRC-100). The parser is tolerant of missing fields and strict about types; the method list can only be narrowed.
 */
import http from 'node:http';

/** The only wallet methods Legion may send. Order = order of the probe. */
export const PROBE_METHODS = ['getVersion', 'getNetwork', 'isAuthenticated', 'getHeight'] as const;
export type ProbeMethod = typeof PROBE_METHODS[number];

// There is NO default wallet address. The owner types the address of the wallet they want Legion to ask, and the first contact happens
// only when they press Connect in the app window (see WalletProbeService.connect). A built-in address would mean every Legion on every
// computer knocks on a well-known port as soon as BSV mode is on.
/** The originator Legion declares (a DNS-style name, as BRC-100 wallets expect). Self-declared: it proves nothing to the wallet. */
export const PROBE_ORIGIN = 'http://legion.local';

export const PROBE_LIMITS = { callTimeoutMs: 1500, totalTimeoutMs: 4000, maxBodyBytes: 4096, minIntervalMs: 5000 } as const;

export type WalletNetwork = 'main' | 'test' | 'unknown';
export type ProbeError = 'rejected-url' | 'no-methods' | 'refused' | 'timeout' | 'too-large' | 'http-error' | 'bad-response' | 'network';

export interface WalletProbeResult {
  /** At least one allowlisted call came back as HTTP 200 with a JSON object holding the expected field. */
  reachable: boolean;
  /** `isAuthenticated`; false when it was not answered (a locked wallet and a silent one look the same here). */
  authenticated: boolean;
  network: WalletNetwork;
  version: string | null;
  height: number | null;
  /** ISO time the probe finished. */
  checkedAt: string;
  /** Why nothing (or not everything) came back. A fixed code, never text from the wallet. */
  error?: ProbeError;
  /** The methods that were actually sent, in order (so a log or a test can show nothing else left the process). */
  sent: ProbeMethod[];
}

// ------------------------------------------------------------------ the URL rule

export type ParsedWalletUrl = { ok: true; host: string; port: number; display: string } | { ok: false; reason: string };

/**
 * Accepts only a loopback http URL with nothing else in it. `host` is what the socket connects to (always a literal address).
 * The WHATWG parser normalises odd spellings first (127.1, 2130706433, 0x7f.1 all become 127.0.0.1), so the check is on the result.
 */
export function parseWalletUrl(raw: unknown): ParsedWalletUrl {
  if (typeof raw !== 'string' || !raw || raw.length > 200 || /[\u0000-\u001f\u007f\s]/.test(raw)) return { ok: false, reason: 'not a usable URL' };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'not a usable URL' }; }
  if (u.protocol !== 'http:') return { ok: false, reason: 'only http:// to this computer is allowed' };
  if (u.username || u.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return { ok: false, reason: 'the URL must be just a host and a port' };
  const hostname = u.hostname.toLowerCase();
  let host: string;
  if (hostname === '127.0.0.1') host = '127.0.0.1';
  else if (hostname === '[::1]') host = '::1';
  else if (hostname === 'localhost') host = '127.0.0.1';
  else return { ok: false, reason: 'only a loopback address (127.0.0.1, [::1] or localhost) is allowed' };
  const port = u.port === '' ? 80 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'bad port' };
  return { ok: true, host, port, display: `${hostname === '[::1]' ? '[::1]' : hostname}:${port}` };
}

// ------------------------------------------------------------------ transport (injectable)

export interface WireRequest { host: string; port: number; path: string; body: string; headers: Record<string, string>; timeoutMs: number; maxBytes: number }
export interface WireResponse { status: number; body: string }
export type Transport = (req: WireRequest) => Promise<WireResponse>;

/** An error with a fixed code; its message is never text from the wallet. */
export class WalletProbeError extends Error {
  constructor(public readonly code: ProbeError) { super(code); this.name = 'WalletProbeError'; }
}

const errorCode = (e: unknown): ProbeError => (e instanceof WalletProbeError ? e.code : 'network');

/** node:http to a literal loopback address: no agent pool, no redirects, a hard deadline, a byte cap, one request. */
export const httpTransport: Transport = (r) => new Promise<WireResponse>((resolve, reject) => {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (fn: () => void) => { if (finished) return; finished = true; if (timer) clearTimeout(timer); fn(); };
  const succeed = (v: WireResponse) => end(() => resolve(v));
  const fail = (code: ProbeError) => end(() => reject(new WalletProbeError(code)));
  const req = http.request({
    host: r.host, port: r.port, method: 'POST', path: r.path, agent: false, setHost: true,
    headers: { ...r.headers, 'Content-Length': String(Buffer.byteLength(r.body)), Connection: 'close' },
  }, (res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > r.maxBytes) { fail('too-large'); res.destroy(); req.destroy(); return; }
      chunks.push(c);
    });
    res.on('end', () => succeed({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', () => fail('network'));
    res.on('aborted', () => fail('network'));
  });
  // one deadline for the whole call (connect, headers and body): a wallet that trickles bytes cannot hold the probe open
  timer = setTimeout(() => { fail('timeout'); req.destroy(); }, r.timeoutMs);
  timer.unref?.();
  req.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ECONNREFUSED' || e.code === 'EADDRNOTAVAIL' ? 'refused' : 'network'));
  req.end(r.body);
});

// ------------------------------------------------------------------ parsing: whitelisted fields of the right type, nothing else

/** The semver.org grammar, nothing looser: MAJOR.MINOR.PATCH with optional -prerelease and +build. No leading "v", no spaces, no free text. */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/** A short vendor token then semver, as the real BSV Desktop reports ("wallet-brc100-1.0.0"): lower-case token of at most 32 characters, a dash, MAJOR.MINOR.PATCH, optional -pre (letters, digits, dots, dashes). Nothing else. */
const TOKEN_VERSION_RE = /^[a-z][a-z0-9-]{0,31}-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?$/;
/** A wallet's version string as Legion will show it: valid semver, or a short safe token followed by semver, at most 64 characters, or null. */
export function readVersion(v: unknown): string | null { return typeof v === 'string' && v.length <= 64 && (SEMVER_RE.test(v) || TOKEN_VERSION_RE.test(v)) ? v : null; }
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseBody(body: string): Record<string, unknown> | null {
  try { const j: unknown = JSON.parse(body); return isPlainObject(j) ? j : null; } catch { return null; }
}

/** 'mainnet' | 'main' -> main; 'testnet' | 'test' | 'teratestnet' -> test; anything else (or a wrong type) -> unknown. */
export function readNetwork(v: unknown): WalletNetwork {
  if (typeof v !== 'string') return 'unknown';
  const s = v.trim().toLowerCase();
  if (s === 'mainnet' || s === 'main') return 'main';
  if (s === 'testnet' || s === 'test' || s === 'teratestnet') return 'test';
  return 'unknown';
}

// ------------------------------------------------------------------ the probe

export interface ProbeOptions {
  /** Required: with no URL nothing is sent (the answer is `rejected-url`). */
  url?: string;
  transport?: Transport;
  /** Can only NARROW PROBE_METHODS: names outside it are dropped before anything is sent. */
  methods?: readonly string[];
  callTimeoutMs?: number;
  totalTimeoutMs?: number;
  now?: () => number;
}

/**
 * One probe: the allowlisted methods in order, one request each, never repeated. A refused connection on the first call ends the probe
 * (nothing is listening); a timeout or an oversized answer ends it too (a stuck wallet is not asked again).
 */
export async function probeWallet(opts: ProbeOptions = {}): Promise<WalletProbeResult> {
  const now = opts.now ?? Date.now;
  const out: WalletProbeResult = { reachable: false, authenticated: false, network: 'unknown', version: null, height: null, checkedAt: '', sent: [] };
  const finish = (error?: ProbeError): WalletProbeResult => { out.checkedAt = new Date(now()).toISOString(); if (error) out.error = error; return out; };

  const target = parseWalletUrl(opts.url);
  if (!target.ok) return finish('rejected-url');
  const wanted = opts.methods === undefined ? [...PROBE_METHODS] : PROBE_METHODS.filter((m) => opts.methods!.includes(m));
  if (!wanted.length) return finish('no-methods');

  const transport = opts.transport ?? httpTransport;
  const callMs = opts.callTimeoutMs ?? PROBE_LIMITS.callTimeoutMs;
  const deadline = now() + (opts.totalTimeoutMs ?? PROBE_LIMITS.totalTimeoutMs);
  let firstError: ProbeError | undefined;

  for (const method of wanted) {
    const left = deadline - now();
    if (left <= 0) { firstError ??= 'timeout'; break; }
    // every outgoing method is checked here, at the point of use, so a future edit cannot send a name that is not on the list
    if (!(PROBE_METHODS as readonly string[]).includes(method)) throw new Error('refusing to call a method that is not on the probe allowlist');
    out.sent.push(method);
    let res: WireResponse;
    try {
      res = await transport({
        host: target.host, port: target.port, path: `/${method}`, body: '{}', timeoutMs: Math.min(callMs, left), maxBytes: PROBE_LIMITS.maxBodyBytes,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: PROBE_ORIGIN, Originator: 'legion.local' },
      });
    } catch (e) {
      const code = errorCode(e);
      firstError ??= code;
      // nothing listening, a stuck socket or a flood: do not ask the remaining questions
      if (code === 'refused' || code === 'timeout' || code === 'too-large') break;
      continue;
    }
    if (res.status !== 200) { firstError ??= 'http-error'; continue; }
    const body = parseBody(res.body);
    if (!body) { firstError ??= 'bad-response'; continue; }
    let good = false;
    switch (method) {
      case 'getVersion':
        if (typeof body.version === 'string') { good = true; out.version = readVersion(body.version); }
        break;
      case 'getNetwork':
        if (typeof body.network === 'string') { good = true; out.network = readNetwork(body.network); }
        break;
      case 'isAuthenticated':
        if (typeof body.authenticated === 'boolean') { good = true; out.authenticated = body.authenticated; }
        break;
      case 'getHeight':
        if (typeof body.height === 'number' && Number.isSafeInteger(body.height) && body.height >= 0 && body.height < 1e9) { good = true; out.height = body.height; }
        break;
    }
    if (good) out.reachable = true; else firstError ??= 'bad-response';
  }
  // an error is reported only when it explains a silent wallet; a partial answer is still an answer
  return finish(out.reachable ? undefined : firstError ?? 'bad-response');
}

// ------------------------------------------------------------------ what the answer means for Legion (pure)

export type WalletCondition = 'off' | 'not-configured' | 'not-connected' | 'rejected-url' | 'not-detected' | 'testnet' | 'mainnet-warning' | 'unknown-network';

export interface WalletStatus extends WalletProbeResult {
  /** False while BSV mode is off, before the owner pressed Connect, or before the first probe: nothing was contacted. */
  probed: boolean;
  /** The owner pressed Connect in this launch (in memory only). */
  connected: boolean;
  /** Where Legion looks (host and port only); empty when no address is set. */
  url: string;
  /** Legion's knowledge mode, which is testnet. It is not the spend network: that is whatever the wallet claims at the moment of a request, and mainnet spending is off unless the owner switched it on. */
  legionNetwork: 'testnet';
  condition: WalletCondition;
  /** One calm sentence for the UI and the tool result. */
  message: string;
}

export const MAINNET_WARNING = "The wallet says it is on MAINNET (real funds). In Legion's own code a mainnet spend needs the mainnet switch (off by default), Arm and your confirmations; whether the wallet asks too depends on the wallet.";

export type WalletIdle = 'off' | 'not-configured' | 'not-connected';

export function describeWallet(r: WalletProbeResult | null, url: string, idle: WalletIdle = 'off'): { condition: WalletCondition; message: string } {
  if (!r) {
    if (idle === 'not-configured') return { condition: 'not-configured', message: 'No wallet address is set. Type the address of your wallet and press Connect; until then Legion contacts nothing.' };
    if (idle === 'not-connected') return { condition: 'not-connected', message: `Not connected. Legion has not contacted ${url || 'a wallet'} in this session and will not until you press Connect.` };
    return { condition: 'off', message: 'Wallet not checked.' };
  }
  if (r.error === 'rejected-url') return { condition: 'rejected-url', message: 'The configured wallet URL is not a loopback address, so Legion did not contact it.' };
  if (!r.reachable) return { condition: 'not-detected', message: `No BRC-100 wallet answered at ${url}.` };
  const locked = r.authenticated ? '' : ' It reports that it is not signed in.';
  if (r.network === 'main') return { condition: 'mainnet-warning', message: MAINNET_WARNING + locked };
  if (r.network === 'test') return { condition: 'testnet', message: `A program at ${url} answers as a testnet wallet (a claim: any local program can answer).${locked}` };
  return { condition: 'unknown-network', message: `A program at ${url} answered but did not say which network it is on; Legion will not use it.${locked}` };
}

export function toWalletStatus(r: WalletProbeResult | null, url: string, idle: WalletIdle = 'off', connected = false): WalletStatus {
  const base: WalletProbeResult = r ?? { reachable: false, authenticated: false, network: 'unknown', version: null, height: null, checkedAt: '', sent: [] };
  return { ...base, probed: !!r, connected, url, legionNetwork: 'testnet', ...describeWallet(r, url, idle) };
}

// ------------------------------------------------------------------ the service: single flight, no storms, nothing while off

export interface WalletProbeServiceOptions {
  /** The configured wallet URL (undefined = none set, and then nothing is ever contacted). Read at every probe, so a config change is picked up. */
  getUrl: () => string | undefined;
  /** Probing happens only while this is true (BSV mode on). */
  enabled: () => boolean;
  transport?: Transport;
  now?: () => number;
  /** A check inside this window of the last finished probe returns that answer instead of asking the wallet again. */
  minIntervalMs?: number;
  methods?: readonly string[];
  callTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export class WalletProbeService {
  private inflight: Promise<WalletStatus> | null = null;
  private last: WalletProbeResult | null = null;
  private lastAt = 0;
  private lastUrl = '';
  /** In memory only. False at every launch: the wallet is never contacted until the owner presses Connect. */
  private connectedFlag = false;
  /** Fired with (previous, next) after a probe whose network, reachability or sign-in changed. The module writes one audit line for it. It is
   *  a notification: the module may only TIGHTEN (disarm) because of it, never raise a limit or reset anything. */
  onChange?: (prev: WalletStatus, next: WalletStatus) => void;

  constructor(private readonly o: WalletProbeServiceOptions) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  private target(): { url: string; ok: boolean; set: boolean } {
    const raw = this.o.getUrl();
    if (!raw) return { url: '', ok: false, set: false };
    const p = parseWalletUrl(raw);
    return { url: p.ok ? p.display : 'the configured address', ok: p.ok, set: true };
  }

  get connected(): boolean { return this.connectedFlag; }

  /** The address Legion may talk to: the configured URL, only while the owner is connected, BSV mode is on and the address is loopback. Otherwise undefined. */
  get connectedUrl(): string | undefined {
    if (!this.connectedFlag || !this.o.enabled()) return undefined;
    const raw = this.o.getUrl();
    return raw && parseWalletUrl(raw).ok ? raw : undefined;
  }

  private idle(): WalletIdle {
    if (!this.o.enabled()) return 'off';
    const t = this.target();
    if (!t.set) return 'not-configured';
    return this.connectedFlag ? 'off' : 'not-connected';
  }

  /** The last answer without contacting anything. */
  cached(): WalletStatus {
    const t = this.target();
    if (!this.o.enabled() || !this.connectedFlag) return toWalletStatus(null, t.url, this.idle(), this.o.enabled() && this.connectedFlag);
    return toWalletStatus(this.last, this.last ? this.lastUrl : t.url, 'off', true);
  }

  /** The owner pressed Connect for this address. Validates it (loopback only) and allows probing; contacts nothing by itself. */
  connect(): { ok: true } | { ok: false; reason: string } {
    const raw = this.o.getUrl();
    if (!raw) return { ok: false, reason: 'no wallet address is set' };
    const p = parseWalletUrl(raw);
    if (!p.ok) return { ok: false, reason: p.reason };
    this.last = null; this.lastAt = 0;
    this.connectedFlag = true;
    return { ok: true };
  }

  /** Stop asking. Used by Disconnect, a freeze, and BSV mode being turned off. */
  disconnect(): void { this.connectedFlag = false; this.last = null; this.lastAt = 0; }

  /** Probes now (or returns the answer of the last few seconds). Never throws, never retries, one probe at a time. Contacts nothing until `connect()`. */
  check(opts: { fresh?: boolean } = {}): Promise<WalletStatus> {
    if (!this.o.enabled() || !this.connectedFlag || !this.target().ok) return Promise.resolve(this.cached());
    const minMs = this.o.minIntervalMs ?? PROBE_LIMITS.minIntervalMs;
    if (!opts.fresh && this.last && this.now() - this.lastAt < minMs && !this.inflight) return Promise.resolve(this.cached());
    if (this.inflight) return this.inflight;
    const run = (async (): Promise<WalletStatus> => {
      const prev = this.cached();
      let r: WalletProbeResult;
      try {
        r = await probeWallet({ url: this.o.getUrl(), transport: this.o.transport, now: this.o.now, methods: this.o.methods, callTimeoutMs: this.o.callTimeoutMs, totalTimeoutMs: this.o.totalTimeoutMs });
      } catch {
        r = { reachable: false, authenticated: false, network: 'unknown', version: null, height: null, checkedAt: new Date(this.now()).toISOString(), error: 'network', sent: [] };
      }
      // the owner may have disconnected (or turned the mode off) while the probe was in flight: that answer is dropped, not stored
      if (!this.connectedFlag || !this.o.enabled()) return this.cached();
      this.last = r;
      this.lastAt = this.now();
      this.lastUrl = this.target().url;
      const next = this.cached();
      if (!prev.probed || prev.reachable !== next.reachable || prev.network !== next.network || prev.authenticated !== next.authenticated) {
        try { this.onChange?.(prev, next); } catch { /* a logging failure must not break the probe */ }
      }
      return next;
    })().finally(() => { this.inflight = null; });
    this.inflight = run;
    return run;
  }

  /** Forget the last answer: the next check asks again. */
  reset(): void { this.last = null; this.lastAt = 0; }
}
