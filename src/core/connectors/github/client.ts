/**
 * The GitHub client: the ONLY file that talks to GitHub (design 4.3). The gateway tools, the CI panel and the Armory import it.
 *
 * - Device flow for the "Legion (read)" GitHub App; anonymous mode (no token) for public reads.
 * - `request()` reaches api.github.com only. Errors are typed `GhError` kinds and never carry a URL, a header or a body.
 * - Reads are retried once after a 401 and a token refresh; writes are never retried after they were sent.
 * - Tokens live in the encrypted TokenStore. They are never logged, never put in an error, never returned to a caller.
 * - Job logs: `logs()` follows exactly one redirect to a host on GITHUB_LOG_STORAGE_HOSTS, with no Authorization, and fails closed
 *   (`logs-unavailable`) while that list is empty. The signed address is used inside this file and never returned.
 *
 * No write methods here: writes.ts is slice 2.
 */
import { GITHUB_API_ORIGIN, GITHUB_DEVICE_PAGE, GITHUB_LOG_STORAGE_HOSTS, GITHUB_READ_APP_CLIENT_ID, GITHUB_WEB_ORIGIN, looksLikeClientId } from './hosts.js';
import type { TokenStore } from '../store.js';

export const GITHUB_TOKEN_ID = 'github-read';

// ------------------------------------------------------------------------------------------------ errors

export type GhErrorKind = 'not-connected' | 'auth-expired' | 'forbidden' | 'rate-limited' | 'not-found' | 'logs-unavailable' | 'network';

const MESSAGES: Record<GhErrorKind, string> = {
  'not-connected': 'GitHub is not connected.',
  'auth-expired': 'The GitHub sign-in expired. Sign in again.',
  forbidden: 'GitHub refused this request (not allowed for the connected permissions).',
  'rate-limited': 'GitHub rate limit reached.',
  'not-found': 'GitHub did not find that.',
  'logs-unavailable': 'The job log is not available.',
  network: 'Could not reach GitHub.',
};

/** A typed failure. The message is fixed text per kind; no request address, header or response body is ever attached. */
export class GhError extends Error {
  readonly kind: GhErrorKind;
  readonly needs?: 'read' | 'write';
  readonly resetAt?: string;
  readonly retryable?: boolean;
  constructor(kind: GhErrorKind, extra: { needs?: 'read' | 'write'; resetAt?: string; retryable?: boolean } = {}) {
    super(MESSAGES[kind]);
    this.name = 'GhError';
    this.kind = kind;
    if (extra.needs) this.needs = extra.needs;
    if (extra.resetAt) this.resetAt = extra.resetAt;
    if (kind === 'network') this.retryable = extra.retryable ?? true;
  }
}

export type DeviceFlowErrorKind = 'not-configured' | 'disabled' | 'denied' | 'expired' | 'cancelled' | 'network' | 'failed';
const FLOW_MESSAGES: Record<DeviceFlowErrorKind, string> = {
  'not-configured': 'The GitHub App is not registered yet, so sign-in is not available.',
  disabled: 'Device flow is not enabled for the Legion GitHub App.',
  denied: 'The sign-in was cancelled on GitHub.',
  expired: 'The sign-in code expired. Start again.',
  cancelled: 'The sign-in was cancelled.',
  network: 'Could not reach GitHub to finish the sign-in.',
  failed: 'GitHub did not accept the sign-in.',
};
export class DeviceFlowError extends Error {
  readonly kind: DeviceFlowErrorKind;
  constructor(kind: DeviceFlowErrorKind) { super(FLOW_MESSAGES[kind]); this.name = 'DeviceFlowError'; this.kind = kind; }
}

// ------------------------------------------------------------------------------------------------ shapes

export interface GhRate { limit: number; remaining: number; resetAt: string }
/** Pinned 2026-10-07 with the house/skills session. */
export interface GhResponse { status: number; json: unknown; etag?: string; notModified?: boolean; rate: GhRate }
export type GhArea = 'contents' | 'issues' | 'pull_requests' | 'actions';
export interface Connection {
  auth: 'github-app' | 'pat' | 'anonymous';
  login?: string;
  expiresAt?: string;
  /** True when a stored sign-in could not be renewed: the owner must sign in again. */
  needsSignIn?: boolean;
  permissions?: Record<string, 'read' | 'write'>;
  scopes?: string[];
  rate: GhRate;
}
/** What `request()` accepts. Headers cannot be chosen by the caller (no Authorization, no Host): only these fields. */
export interface GhInit { method?: string; body?: string; ifNoneMatch?: string }

interface GhTokenRecord { access: string; refresh?: string; expiresAt?: number; refreshExpiresAt?: number; login?: string }
type FetchFn = typeof fetch;

export interface GhClientDeps {
  tokens: TokenStore;
  /** Defaults to the global fetch. Tests pass one that maps the GitHub hosts to a local fake. */
  fetchFn?: FetchFn;
  clientId?: string;
  /** Public reads without a sign-in. Default true. With false, no token means `not-connected`. */
  anonymous?: boolean;
  /** Exact host names a job-log redirect may point to. Default: GITHUB_LOG_STORAGE_HOSTS (empty). */
  storageHosts?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One short line per event. Never contains a token, a code, a header or a query string. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

const API_VERSION = '2022-11-28';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_LOG = 2 * 1024 * 1024;
const REFRESH_SKEW_MS = 60_000;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** "owner/name" with no "." or ".." part. */
export const validRepo = (repo: unknown): repo is string => typeof repo === 'string' && REPO.test(repo) && !repo.split('/').some((p) => p === '.' || p === '..');

const isRead = (m: string) => m === 'GET' || m === 'HEAD';
const num = (v: string | null): number | undefined => { if (v === null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const redirectStatus = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

export class GitHubClient {
  private readonly tokens: TokenStore;
  private readonly doFetch: FetchFn;
  private readonly clientId: string;
  private readonly anonymous: boolean;
  private readonly storageHosts: readonly string[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logLine: (line: string) => void;
  private readonly timeoutMs: number;
  private refreshing: Promise<GhTokenRecord> | undefined;
  private lastRate: GhRate = { limit: 0, remaining: 0, resetAt: new Date(0).toISOString() };
  private perms: Record<string, 'read' | 'write'> | undefined;
  private needsSignIn = false;

  constructor(deps: GhClientDeps) {
    this.tokens = deps.tokens;
    this.doFetch = deps.fetchFn ?? ((u, i) => fetch(u, i));
    this.clientId = deps.clientId ?? GITHUB_READ_APP_CLIENT_ID;
    this.anonymous = deps.anonymous ?? true;
    this.storageHosts = deps.storageHosts ?? GITHUB_LOG_STORAGE_HOSTS;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logLine = deps.log ?? (() => undefined);
    this.timeoutMs = deps.timeoutMs ?? 20_000;
  }

  // ---------------------------------------------------------------------------------------------- device flow

  /**
   * Starts the device flow. The device code stays inside the returned object's closure; only the user code and the fixed GitHub page are
   * exposed for display. `poll()` honours GitHub's interval and slow_down, and stores the token when the owner approves.
   */
  async startDeviceFlow(): Promise<{ userCode: string; verificationUri: string; expiresAt: number; intervalSec: number; poll(signal?: AbortSignal): Promise<void> }> {
    if (!looksLikeClientId(this.clientId)) throw new DeviceFlowError('not-configured');
    const first = await this.formPost('/login/device/code', { client_id: this.clientId });
    if (!first) throw new DeviceFlowError('network');
    const f = asRec(first);
    const deviceCode = typeof f.device_code === 'string' ? f.device_code : '';
    const userCode = typeof f.user_code === 'string' ? f.user_code : '';
    if (f.error === 'device_flow_disabled') throw new DeviceFlowError('disabled');
    if (!deviceCode || !userCode) throw new DeviceFlowError('failed');
    let interval = Math.max(1, num(String(f.interval ?? '')) ?? 5);
    const expiresAt = this.now() + Math.max(1, num(String(f.expires_in ?? '')) ?? 900) * 1000;
    const startedInterval = interval;
    const poll = async (signal?: AbortSignal): Promise<void> => {
      let netFails = 0;
      for (;;) {
        if (signal?.aborted) throw new DeviceFlowError('cancelled');
        await this.sleep(interval * 1000);
        if (signal?.aborted) throw new DeviceFlowError('cancelled');
        if (this.now() >= expiresAt) throw new DeviceFlowError('expired');
        const r = await this.formPost('/login/oauth/access_token', { client_id: this.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (!r) { if (++netFails >= 3) throw new DeviceFlowError('network'); continue; }
        netFails = 0;
        const j = asRec(r);
        if (typeof j.access_token === 'string' && j.access_token) {
          const rec = this.recordFrom(j);
          await this.tokens.set(GITHUB_TOKEN_ID, rec);
          this.needsSignIn = false;
          this.perms = undefined;
          this.logLine('github: signed in');
          return;
        }
        switch (j.error) {
          case 'authorization_pending': break;
          case 'slow_down': interval = Math.max(interval + 5, num(String(j.interval ?? '')) ?? 0); break;
          case 'expired_token': throw new DeviceFlowError('expired');
          case 'access_denied': throw new DeviceFlowError('denied');
          case 'device_flow_disabled': throw new DeviceFlowError('disabled');
          default: throw new DeviceFlowError('failed');
        }
      }
    };
    return { userCode, verificationUri: GITHUB_DEVICE_PAGE, expiresAt, intervalSec: startedInterval, poll };
  }

  /** POST to github.com (device flow and refresh). Returns the parsed JSON, or undefined on any transport failure. Nothing is logged from it. */
  private async formPost(path: string, fields: Record<string, string>): Promise<unknown | undefined> {
    try {
      const res = await this.doFetch(GITHUB_WEB_ORIGIN + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Legion' },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status >= 500 || redirectStatus(res.status)) return undefined;
      return JSON.parse(await this.readText(res, 64 * 1024));
    } catch { return undefined; }
  }

  private recordFrom(j: Record<string, unknown>): GhTokenRecord {
    const rec: GhTokenRecord = { access: String(j.access_token) };
    if (typeof j.refresh_token === 'string' && j.refresh_token) rec.refresh = j.refresh_token;
    const exp = num(String(j.expires_in ?? ''));
    if (exp) rec.expiresAt = this.now() + exp * 1000;
    const rexp = num(String(j.refresh_token_expires_in ?? ''));
    if (rexp) rec.refreshExpiresAt = this.now() + rexp * 1000;
    return rec;
  }

  /** Forgets the stored sign-in locally. (Revoking at GitHub is the owner's step: github.com/settings/applications.) */
  async disconnect(): Promise<void> {
    await this.tokens.remove(GITHUB_TOKEN_ID);
    this.perms = undefined;
    this.needsSignIn = false;
  }

  // ---------------------------------------------------------------------------------------------- tokens

  private async currentToken(): Promise<GhTokenRecord | undefined> {
    let rec = await this.tokens.get<GhTokenRecord>(GITHUB_TOKEN_ID);
    if (rec && typeof rec.access !== 'string') rec = undefined;
    if (rec?.expiresAt !== undefined && rec.expiresAt - REFRESH_SKEW_MS <= this.now()) rec = await this.refresh(rec);
    return rec;
  }

  /**
   * Renews the sign-in. Concurrent callers share one attempt. The rotated refresh token is persisted BEFORE the new access token is used.
   * A definitive refusal deletes the local sign-in (the owner must sign in again); a transport failure keeps it.
   */
  private refresh(rec: GhTokenRecord): Promise<GhTokenRecord> {
    if (this.refreshing) return this.refreshing;
    const attempt = (async (): Promise<GhTokenRecord> => {
      if (!rec.refresh || (rec.refreshExpiresAt !== undefined && rec.refreshExpiresAt <= this.now())) return this.signInAgain();
      const r = await this.formPost('/login/oauth/access_token', { client_id: this.clientId, grant_type: 'refresh_token', refresh_token: rec.refresh });
      if (r === undefined) throw new GhError('network', { retryable: true });
      const j = asRec(r);
      if (typeof j.access_token !== 'string' || !j.access_token) return this.signInAgain();
      const next = this.recordFrom(j);
      if (!next.refresh && rec.refresh) next.refresh = rec.refresh;
      if (rec.login) next.login = rec.login;
      await this.tokens.set(GITHUB_TOKEN_ID, next);
      this.logLine('github: token refreshed');
      return next;
    })();
    this.refreshing = attempt;
    const clear = () => { if (this.refreshing === attempt) this.refreshing = undefined; };
    attempt.then(clear, clear);
    return attempt;
  }

  private async signInAgain(): Promise<never> {
    await this.tokens.remove(GITHUB_TOKEN_ID);
    this.needsSignIn = true;
    this.perms = undefined;
    this.logLine('github: sign-in could not be renewed');
    throw new GhError('auth-expired');
  }

  // ---------------------------------------------------------------------------------------------- requests

  /**
   * One authenticated (or anonymous) exchange with api.github.com, no redirect followed. Reads are retried once after a 401 and a refresh;
   * a write that got a 401 is not retried.
   */
  private async exchange(path: string, init: GhInit & { accept?: string }): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) throw new GhError('network', { retryable: false });
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN) throw new GhError('network', { retryable: false });
    let rec = await this.currentToken();
    if (!rec && (!this.anonymous || !isRead(method))) throw new GhError('not-connected');
    let res = await this.send(url, method, init, rec?.access);
    if (res.status === 401) {
      if (!rec) throw new GhError('not-connected');
      if (!isRead(method)) throw new GhError('auth-expired');
      rec = await this.refresh(rec);
      res = await this.send(url, method, init, rec.access);
      if (res.status === 401) throw new GhError('auth-expired');
    }
    this.noteRate(res);
    return res;
  }

  private async send(url: URL, method: string, init: GhInit & { accept?: string }, token: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { accept: init.accept ?? 'application/vnd.github+json', 'x-github-api-version': API_VERSION, 'user-agent': 'Legion' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.ifNoneMatch) headers['if-none-match'] = init.ifNoneMatch;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await this.doFetch(url.toString(), { method, headers, redirect: 'manual', ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
      this.logLine(`github: ${method} ${url.pathname} ${res.status}`);
      return res;
    } catch {
      this.logLine(`github: ${method} ${url.pathname} failed`);
      throw new GhError('network', { retryable: true });
    }
  }

  private noteRate(res: Response): void {
    const limit = num(res.headers.get('x-ratelimit-limit'));
    const remaining = num(res.headers.get('x-ratelimit-remaining'));
    const reset = num(res.headers.get('x-ratelimit-reset'));
    if (limit !== undefined && remaining !== undefined) this.lastRate = { limit, remaining, resetAt: new Date((reset ?? 0) * 1000).toISOString() };
  }

  private async readText(res: Response, cap: number): Promise<string> {
    const text = await res.text();
    if (text.length > cap) throw new Error('too large');
    return text;
  }

  /** api.github.com only. `init` has no header field: Authorization, Host and friends cannot be chosen by the caller. */
  async request(path: string, init: GhInit = {}): Promise<GhResponse> {
    const method = (init.method ?? 'GET').toUpperCase();
    let res = await this.exchange(path, init);
    // one same-origin redirect for reads (a renamed or moved repository); anything else is not followed
    if (redirectStatus(res.status) && isRead(method)) {
      const loc = res.headers.get('location');
      let to: URL | undefined;
      try { to = loc ? new URL(loc, GITHUB_API_ORIGIN) : undefined; } catch { to = undefined; }
      if (!to || to.origin !== GITHUB_API_ORIGIN) throw new GhError('network', { retryable: false });
      res = await this.exchange(to.pathname + to.search, init);
    }
    return this.classify(res, method);
  }

  private async classify(res: Response, method: string): Promise<GhResponse> {
    const rate = this.lastRate;
    const etag = res.headers.get('etag') ?? undefined;
    if (res.status === 304) return { status: 304, json: undefined, notModified: true, ...(etag ? { etag } : {}), rate };
    if (res.status >= 200 && res.status < 300) {
      let json: unknown;
      try { const t = await this.readText(res, MAX_BODY); json = t ? JSON.parse(t) : undefined; } catch { throw new GhError('network', { retryable: false }); }
      return { status: res.status, json, ...(etag ? { etag } : {}), rate };
    }
    if (res.status === 404 || res.status === 410) throw new GhError('not-found');
    if (res.status === 401) throw new GhError('not-connected');
    if (res.status === 403 || res.status === 429) {
      const retryAfter = num(res.headers.get('retry-after'));
      const limited = res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || retryAfter !== undefined;
      if (limited) {
        const reset = retryAfter !== undefined ? this.now() + retryAfter * 1000 : (num(res.headers.get('x-ratelimit-reset')) ?? 0) * 1000;
        throw new GhError('rate-limited', { resetAt: new Date(reset).toISOString() });
      }
      throw new GhError('forbidden', { needs: isRead(method) ? 'read' : 'write' });
    }
    throw new GhError('network', { retryable: res.status >= 500 });
  }

  // ---------------------------------------------------------------------------------------------- connection and permissions

  async connection(): Promise<Connection> {
    const rec = await this.currentToken();
    if (!rec) {
      const r = await this.request('/rate_limit');
      const core = asRec(asRec(asRec(r.json).resources).core);
      const rate: GhRate = typeof core.limit === 'number' ? { limit: core.limit, remaining: Number(core.remaining ?? 0), resetAt: new Date(Number(core.reset ?? 0) * 1000).toISOString() } : r.rate;
      return { auth: 'anonymous', rate, ...(this.needsSignIn ? { needsSignIn: true } : {}) };
    }
    const user = await this.request('/user');
    const login = typeof asRec(user.json).login === 'string' ? String(asRec(user.json).login) : undefined;
    let permissions: Record<string, 'read' | 'write'> | undefined;
    try {
      const inst = await this.request('/user/installations');
      const list = asRec(inst.json).installations;
      const merged: Record<string, 'read' | 'write'> = {};
      for (const i of Array.isArray(list) ? list : []) {
        for (const [k, v] of Object.entries(asRec(asRec(i).permissions))) {
          if (v === 'write' || (v === 'read' && merged[k] !== 'write')) merged[k] = v === 'write' ? 'write' : 'read';
        }
      }
      permissions = merged;
    } catch (e) { if (!(e instanceof GhError)) throw e; }
    this.perms = permissions;
    return {
      auth: 'github-app', ...(login ? { login } : {}), ...(rec.expiresAt ? { expiresAt: new Date(rec.expiresAt).toISOString() } : {}),
      ...(permissions ? { permissions } : {}), rate: user.rate,
    };
  }

  /** From the last `connection()`: 'unknown' until that has run, or when the installations were not readable. */
  can(area: GhArea, level: 'read' | 'write'): 'yes' | 'no' | 'unknown' {
    if (!this.perms) return 'unknown';
    const have = this.perms[area];
    if (have === undefined) return 'no';
    return level === 'read' || have === 'write' ? 'yes' : 'no';
  }

  // ---------------------------------------------------------------------------------------------- job logs

  /**
   * The text of a job's log. GitHub answers with a redirect to a signed storage address; it is followed once, only to a host on the
   * storage list, with no Authorization, a size cap and a timeout. The address is never returned or logged. The list ships empty,
   * so this fails closed (`logs-unavailable`) until C-GH-2 has recorded the real host names.
   */
  async logs(jobId: number | string, repo: string): Promise<{ text: string; truncated: boolean }> {
    if (!validRepo(repo) || !/^\d{1,20}$/.test(String(jobId))) throw new GhError('not-found');
    const res = await this.exchange(`/repos/${repo}/actions/jobs/${jobId}/logs`, {});
    if (!redirectStatus(res.status)) {
      if (res.status === 404) throw new GhError('not-found');
      if (res.status === 403 || res.status === 429) await this.classify(res, 'GET');
      throw new GhError('logs-unavailable');
    }
    let to: URL | undefined;
    try { const loc = res.headers.get('location'); to = loc ? new URL(loc) : undefined; } catch { to = undefined; }
    if (!to || to.protocol !== 'https:' || to.username || to.password || to.port) throw new GhError('logs-unavailable');
    const host = to.hostname.toLowerCase();
    if (!this.storageHosts.includes(host)) {
      this.logLine(`github: log redirect host ${host} is not on the storage list`);
      throw new GhError('logs-unavailable');
    }
    let body: Response;
    try {
      body = await this.doFetch(to.toString(), { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'Legion' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new GhError('network', { retryable: true }); }
    if (body.status !== 200 || !body.body) throw new GhError('logs-unavailable');
    const reader = body.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = MAX_LOG - size;
        if (value.length > room) { chunks.push(Buffer.from(value.subarray(0, room))); size = MAX_LOG; truncated = true; await reader.cancel().catch(() => undefined); break; }
        chunks.push(Buffer.from(value));
        size += value.length;
      }
    } catch { throw new GhError('network', { retryable: true }); }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }
}

// ------------------------------------------------------------------------------------------------ the one instance

let instance: GitHubClient | undefined;
/** Core startup calls this once. A second call returns the existing instance, so one client does every token refresh. */
export function createGitHubClient(deps: GhClientDeps): GitHubClient {
  instance ??= new GitHubClient(deps);
  return instance;
}
/** Everyone else uses only this: the single instance, or undefined before core start or with no connectors. */
export function getGitHubClient(): GitHubClient | undefined { return instance; }
/** Tests only: forget the instance. */
export function resetGitHubClientForTests(): void { instance = undefined; }
