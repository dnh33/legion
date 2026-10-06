/**
 * A fake GitHub for the connector tests: real HTTP on 127.0.0.1, no real network. It answers as api.github.com (REST), github.com (device
 * flow and token refresh) and one log storage host. `fetchFn()` gives the client a fetch that maps those host names to this server and
 * records (and refuses) every other host, so a test can also prove that nothing else is ever contacted.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const STORAGE_HOST = 'logs.fake-storage.example';
export const FAKE_CLIENT_ID = 'Iv1.0123456789abcdef';
export const DEVICE_CODE = 'devcode-SECRET-0123456789';
export const USER_CODE = 'WDJB-MJHT';

export interface FakeReq { host: string; method: string; path: string; auth: string; ifNoneMatch: string; body: string }
type Poll = 'pending' | 'slow_down' | 'expired' | 'denied' | 'disabled' | 'success';

export class FakeGitHub {
  server!: Server;
  port = 0;
  requests: FakeReq[] = [];
  /** Hosts the client tried that this fake does not serve (it never contacts them). */
  stray: string[] = [];
  /** Device flow: answers to the next polls, in order; the last one repeats. */
  script: Poll[] = ['success'];
  deviceDisabled = false;
  /** github.com refresh endpoint: 'ok' rotates, 'bad' answers bad_refresh_token, 'down' answers 503. */
  refreshMode: 'ok' | 'bad' | 'down' = 'ok';
  /** Access tokens live this long (seconds) from issue. */
  expiresIn = 28800;
  /** A hostile server: error messages echo the Authorization header and the request path. */
  echoAuth = false;
  hugeLog = false;
  private seq = 0;
  private polls = 0;
  access = new Map<string, { login: string }>();
  refreshes = new Set<string>();
  revoked = new Set<string>();
  /** Per-path override: [status, json, extra headers]. */
  override?: (host: string, method: string, path: string) => [number, unknown, Record<string, string>?] | undefined;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const host = String(req.headers['x-fake-host'] ?? '');
        const path = req.url ?? '/';
        const r: FakeReq = { host, method: req.method ?? 'GET', path, auth: String(req.headers.authorization ?? ''), ifNoneMatch: String(req.headers['if-none-match'] ?? ''), body: raw };
        this.requests.push(r);
        const [status, json, headers] = this.override?.(host, r.method, path) ?? this.handle(r);
        const text = typeof json === 'string' ? json : JSON.stringify(json);
        res.writeHead(status, { 'content-type': typeof json === 'string' ? 'text/plain' : 'application/json', ...headers });
        res.end(status === 304 || status === 204 ? undefined : text);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> { if (!this.server.listening) return; await new Promise<void>((r) => { this.server.close(() => r()); this.server.closeAllConnections?.(); }); }

  /** The fetch the client under test gets: github hosts go to this server, anything else is recorded in `stray` and fails. */
  fetchFn(): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.protocol !== 'https:' || !['api.github.com', 'github.com', STORAGE_HOST].includes(u.hostname)) { this.stray.push(u.host); throw new Error('no such host'); }
      const headers = new Headers(init?.headers);
      headers.set('x-fake-host', u.hostname);
      return fetch(`http://127.0.0.1:${this.port}${u.pathname}${u.search}`, { ...init, headers });
    }) as typeof fetch;
  }

  issue(login = 'octo'): { access: string; refresh: string } {
    const n = ++this.seq;
    const access = `ghu_FAKEACCESS${String(n).padStart(4, '0')}abcdefghijklmnopqrstuv`;
    const refresh = `ghr_FAKEREFRESH${String(n).padStart(4, '0')}abcdefghijklmnopqrstuv`;
    this.access.set(access, { login });
    this.refreshes.add(refresh);
    return { access, refresh };
  }
  expire(access: string): void { this.access.delete(access); }
  apiRequests(): FakeReq[] { return this.requests.filter((r) => r.host === 'api.github.com'); }

  private tokenBody(): Record<string, unknown> {
    const t = this.issue();
    return { access_token: t.access, token_type: 'bearer', expires_in: this.expiresIn, refresh_token: t.refresh, refresh_token_expires_in: 15811200 };
  }

  private handle(r: FakeReq): [number, unknown, Record<string, string>?] {
    if (r.host === 'github.com') return this.handleWeb(r);
    if (r.host === STORAGE_HOST) return [200, this.hugeLog ? 'x'.repeat(3 * 1024 * 1024) : 'line one\nline two\n'];
    const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1900000000' };
    const echo = this.echoAuth ? ` auth=${r.auth} path=${r.path}` : '';
    let who: string | undefined;
    if (r.auth) {
      const t = r.auth.replace(/^Bearer /, '');
      const a = this.access.get(t);
      if (!a || this.revoked.has(t)) return [401, { message: 'Bad credentials' + echo }, rate];
      who = a.login;
    }
    const path = r.path.split('?')[0]!;
    if (path === '/rate_limit') return [200, { resources: { core: { limit: who ? 5000 : 60, remaining: who ? 4990 : 58, reset: 1900000000 } } }, rate];
    if (path === '/user') return who ? [200, { login: who }, rate] : [401, { message: 'Requires authentication' + echo }, rate];
    if (path === '/user/installations') return who ? [200, { total_count: 2, installations: [{ id: 1, permissions: { contents: 'read', metadata: 'read', actions: 'read' } }, { id: 2, permissions: { issues: 'write', contents: 'read' } }] }, rate] : [401, { message: 'x' }, rate];
    if (path === '/repos/o/r') {
      if (r.ifNoneMatch === 'W/"v1"') return [304, '', { ...rate, etag: 'W/"v1"' }];
      return [200, { full_name: 'o/r' }, { ...rate, etag: 'W/"v1"' }];
    }
    if (path === '/repos/o/missing') return [404, { message: 'Not Found' + echo }, rate];
    if (path === '/repos/o/forbidden') return [403, { message: 'Resource not accessible by integration' + echo }, rate];
    if (path === '/repos/o/ratelimited') return [403, { message: 'API rate limit exceeded' }, { ...rate, 'x-ratelimit-remaining': '0' }];
    if (path === '/repos/o/secondary') return [403, { message: 'secondary rate limit' }, { ...rate, 'retry-after': '30' }];
    if (path === '/repos/o/boom') return [502, { message: 'bad gateway' + echo }, rate];
    if (path === '/repos/o/moved') return [301, '', { location: 'https://api.github.com/repos/o/r', ...rate }];
    if (path === '/repos/o/evil') return [301, '', { location: 'https://evil.example/steal', ...rate }];
    if (path === '/repos/o/r/issues/1/comments' && r.method === 'POST') return [201, { id: 9 }, rate];
    if (path === '/repos/o/r/actions/jobs/7/logs') return who ? [302, '', { location: `https://${STORAGE_HOST}/blob?sig=SIGNED-SECRET-QUERY`, ...rate }] : [401, { message: 'x' }, rate];
    if (path === '/repos/o/r/actions/jobs/8/logs') return [410, { message: 'gone' }, rate];
    if (path === '/repos/o/r/actions/jobs/9/logs') return [302, '', { location: 'https://evil.example/log?sig=1', ...rate }];
    return [404, { message: 'Not Found' }, rate];
  }

  private handleWeb(r: FakeReq): [number, unknown] {
    const form = new URLSearchParams(r.body);
    if (r.path === '/login/device/code') {
      if (this.deviceDisabled) return [200, { error: 'device_flow_disabled' }];
      return [200, { device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }];
    }
    if (r.path === '/login/oauth/access_token') {
      if (form.get('grant_type') === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        if (this.refreshMode === 'down') return [503, { error: 'unavailable' }];
        if (this.refreshMode === 'bad' || !this.refreshes.has(rt)) return [200, { error: 'bad_refresh_token' }];
        this.refreshes.delete(rt);
        return [200, this.tokenBody()];
      }
      if (form.get('device_code') !== DEVICE_CODE) return [200, { error: 'incorrect_device_code' }];
      const step = this.script[Math.min(this.polls++, this.script.length - 1)]!;
      switch (step) {
        case 'pending': return [200, { error: 'authorization_pending' }];
        case 'slow_down': return [200, { error: 'slow_down', interval: 10 }];
        case 'expired': return [200, { error: 'expired_token' }];
        case 'denied': return [200, { error: 'access_denied' }];
        case 'disabled': return [200, { error: 'device_flow_disabled' }];
        default: return [200, this.tokenBody()];
      }
    }
    return [404, { error: 'not_found' }];
  }
}
