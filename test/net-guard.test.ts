import { strict as assert } from 'node:assert';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { addressIsLoopback, checkRequest, dropNonLoopback, isLoopbackAddress, listenLoopback, LOOPBACK_HOST, originAllowed } from '../src/core/net-guard.js';
import { createServer } from '../src/core/server.js';
import { AUTH, asClient, makeFakes, start, TOKEN } from './helpers-c.js';

const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0) legion/0.2.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36';

/** Raw request so Host, Origin and friends can be forged (fetch refuses to set Host). */
function raw(base: string, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

describe('net-guard: address and header rules (pure)', () => {
  it('loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9', '::ffff:7f00:1', '[::1]']) assert.equal(isLoopbackAddress(a), true, a);
  });
  it('everything else is refused, including mapped non-loopback, lookalikes and undefined', () => {
    for (const a of [undefined, '', '0.0.0.0', '::', '192.168.1.5', '10.0.0.1', '8.8.8.8', '::ffff:8.8.8.8', '::ffff:c0a8:101', '128.0.0.1', '127.0.0.256', '127.0.0.1.evil', '1270.0.0.1', 'fe80::1', '::2', 'localhost']) {
      assert.equal(isLoopbackAddress(a), false, String(a));
    }
  });
  it('origin rules: null and file:// need an Electron User-Agent; a web page cannot set one', () => {
    assert.equal(originAllowed('null', 4747, ELECTRON_UA), true);
    assert.equal(originAllowed('file://', 4747, ELECTRON_UA), true);
    assert.equal(originAllowed('null', 4747, CHROME_UA), false);
    assert.equal(originAllowed('file://', 4747, undefined), false);
    assert.equal(originAllowed('http://localhost:5173', 4747, undefined), true);
    assert.equal(originAllowed('http://127.0.0.1:4747', 4747, undefined), true);
    assert.equal(originAllowed('http://127.0.0.1:9999', 4747, undefined), false); // another local web server's page
    assert.equal(originAllowed('http://localhost:4747.evil.com', 4747, undefined), false);
    assert.equal(originAllowed('https://evil.example', 4747, ELECTRON_UA), false);
  });
  it('checkRequest with a fake socket: non-loopback peer is dropped (destroy), IPv4-mapped loopback passes', () => {
    const req = (addr: string | undefined, headers: Record<string, string>, method = 'GET') => ({ headers, method, socket: { remoteAddress: addr } });
    const ok = { host: '127.0.0.1:4747' };
    const lan = checkRequest(req('192.168.1.20', ok), 4747);
    assert.deepEqual(lan.ok === false && lan.destroy, true);
    assert.equal(checkRequest(req('::ffff:192.168.1.20', ok), 4747).ok, false);
    assert.equal(checkRequest(req(undefined, ok), 4747).ok, false);
    assert.equal(checkRequest(req('::ffff:127.0.0.1', ok), 4747).ok, true);
    assert.equal(checkRequest(req('::1', ok), 4747).ok, true);
  });
  it('checkRequest: Sec-Fetch-Site rules', () => {
    const r = (h: Record<string, string>, m = 'GET') => checkRequest({ headers: { host: 'localhost:4747', ...h }, method: m, socket: { remoteAddress: '127.0.0.1' } }, 4747);
    assert.equal(r({ 'sec-fetch-site': 'cross-site' }).ok, false);                       // browser, no Origin
    assert.equal(r({ 'sec-fetch-site': 'cross-site', origin: 'http://localhost:5173' }).ok, true);
    assert.equal(r({ 'sec-fetch-site': 'same-origin' }, 'POST').ok, true);
    assert.equal(r({ 'sec-fetch-site': 'none' }, 'POST').ok, false);
    assert.equal(r({ 'sec-fetch-site': 'none' }).ok, true);
    assert.equal(r({}, 'POST').ok, true);                                                  // curl / stdio proxy: no browser headers
  });
  it('dropNonLoopback destroys the socket of a non-loopback peer only', () => {
    let d = 0; const s = (a: string) => ({ remoteAddress: a, destroy: () => { d++; } });
    assert.equal(dropNonLoopback(s('127.0.0.1')), false); assert.equal(d, 0);
    assert.equal(dropNonLoopback(s('203.0.113.9')), true); assert.equal(d, 1);
  });
  it('addressIsLoopback and listenLoopback self-check: a server that bound a non-loopback address is closed and reported', () => {
    assert.equal(addressIsLoopback({ address: '0.0.0.0', port: 1 }), false);
    assert.equal(addressIsLoopback({ address: '::', port: 1 }), false);
    assert.equal(addressIsLoopback('pipe'), false);
    assert.equal(addressIsLoopback({ address: '127.0.0.1', port: 1 }), true);
    let listened: [number, string] | undefined; let cb: (() => void) | undefined; let closed = 0; const events: string[] = [];
    const fake = (addr: unknown) => ({
      listen: (p: number, h: string) => { listened = [p, h]; cb?.(); }, address: () => addr, once: (_e: 'listening', f: () => void) => { cb = f; }, close: () => { closed++; },
    });
    listenLoopback(fake({ address: '0.0.0.0', port: 5 }), 5, () => events.push('listening'), () => events.push('violation'));
    assert.deepEqual(listened, [5, LOOPBACK_HOST]); assert.deepEqual(events, ['violation']); assert.equal(closed, 1);
    events.length = 0;
    listenLoopback(fake({ address: '127.0.0.1', port: 5 }), 5, () => events.push('listening'), () => events.push('violation'));
    assert.deepEqual(events, ['listening']);
  });
});

describe('net-guard: the real core server', () => {
  const f = makeFakes();
  let base = ''; let port = 0; let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; port = Number(new URL(base).port); close = s.close; });
  after(async () => { await close(); });
  const H = (extra: Record<string, string> = {}) => ({ ...AUTH, host: `127.0.0.1:${port}`, ...extra });

  it('normal requests still work: Host 127.0.0.1 and localhost, token, health, SSE path, MCP', async () => {
    assert.equal((await raw(base, '/health', { host: `127.0.0.1:${port}` })).status, 200);
    assert.equal((await raw(base, '/api/state', H())).status, 200);
    assert.equal((await raw(base, '/api/state', H({ host: `localhost:${port}` }))).status, 200);
    assert.equal((await raw(base, '/api/state', H({ host: `LOCALHOST:${port}` }))).status, 200);
    assert.equal((await fetch(base + '/api/state', { headers: asClient })).status, 200);
    const mcp = await raw(base, '/mcp', { ...asClient, host: `127.0.0.1:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, 'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    assert.equal(mcp.status, 200);
    assert.ok(mcp.body.includes('tools'));
  });
  it('a forged or foreign Host is 421 on every route, before the token is even looked at', async () => {
    for (const host of ['evil.example', 'abc123.ngrok.io', 'abc.trycloudflare.com', `127.0.0.1.evil.com:${port}`, `localhost.evil.com:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `[::1]:${port}`, `0.0.0.0:${port}`, `192.168.1.5:${port}`, `127.0.0.1:${port}, evil.example`]) {
      for (const path of ['/health', '/api/state', '/mcp', '/api/events', '/nope']) {
        const r = await raw(base, path, H({ host }));
        assert.equal(r.status, 421, `${host} ${path}`);
        assert.ok(!('access-control-allow-origin' in r.headers));
      }
    }
    // the DNS-rebinding shape: the browser's Host is the attacker's name, even with the right token
    assert.equal((await raw(base, '/api/state', H({ host: `rebind.attacker.test:${port}` }))).status, 421);
  });
  it('no Host header (HTTP/1.0 style) is refused', async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const q = request({ host: u.hostname, port: u.port, path: '/health', setHost: false, headers: {} }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on('error', reject); q.end();
    });
    assert.ok(r === 421 || r === 400, String(r));
  });
  it("Origin 'null' is refused for a web page, accepted for the Electron window; evil origins never", async () => {
    assert.equal((await raw(base, '/health', H({ origin: 'null', 'user-agent': CHROME_UA }))).status, 403);
    assert.equal((await raw(base, '/health', H({ origin: 'null' }))).status, 403);
    assert.equal((await raw(base, '/api/state', H({ origin: 'https://evil.example', 'user-agent': ELECTRON_UA }))).status, 403);
    assert.equal((await raw(base, '/api/state', H({ origin: `http://127.0.0.1:${port + 1}` }))).status, 403);
    const e = await raw(base, '/api/state', H({ origin: 'file://', 'user-agent': ELECTRON_UA }));
    assert.equal(e.status, 200);
    assert.equal(e.headers['access-control-allow-origin'], 'file://');
    const n = await raw(base, '/api/state', H({ origin: 'null', 'user-agent': ELECTRON_UA }));
    assert.equal(n.status, 200);
    const pre = await raw(base, '/api/state', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'access-control-request-method': 'POST' }, 'OPTIONS');
    assert.equal(pre.status, 403);
    assert.ok(!('access-control-allow-origin' in pre.headers));
  });
  it('a cross-site browser request without an allowed Origin cannot change state or reach /mcp, even with the token', async () => {
    const sf = { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' };
    assert.equal((await raw(base, '/api/tasks', H({ ...sf }), 'POST', '{}')).status, 403);
    assert.equal((await raw(base, '/mcp', H({ ...sf }), 'POST', '{}')).status, 403);
    assert.equal((await raw(base, '/api/state', H({ ...sf, origin: 'https://evil.example' }))).status, 403);
    assert.equal((await raw(base, '/api/tasks', H({ 'sec-fetch-site': 'none' }), 'POST', '{}')).status, 403);
  });
  it('a simple cross-site POST with no token is stopped too (403 by the guard, not 401 by auth)', async () => {
    assert.equal((await raw(base, '/api/agents', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'text/plain' }, 'POST', '{}')).status, 403);
  });
  it('a request from a non-loopback peer on the real server is dropped without an answer', async () => {
    const f2 = makeFakes();
    const server = createServer(f2.ctx);
    let destroyed = 0; let wrote = 0;
    const sock = { remoteAddress: '192.168.1.77', destroy: () => { destroyed++; } };
    const conn = server.listeners('connection'); (conn[conn.length - 1] as (s: unknown) => void)(sock); // the guard's listener is the last one added
    assert.equal(destroyed, 1);
    // and if a request still got through on such a socket (e.g. a future listener), the request hook drops it and writes nothing
    const res = { writeHead: () => { wrote++; }, end: () => { wrote++; }, setHeader: () => { wrote++; }, headersSent: false };
    server.emit('request', { headers: { host: '127.0.0.1:1', authorization: `Bearer ${TOKEN}` }, method: 'GET', url: '/api/state', socket: { remoteAddress: '::ffff:192.168.1.77', destroy: () => { destroyed++; } } } as any, res as any);
    assert.equal(destroyed, 2); assert.equal(wrote, 0);
  });
  it('IPv4-mapped loopback is accepted by the guard on a real dual-stack-style peer address', () => {
    assert.equal(checkRequest({ headers: { host: `127.0.0.1:${port}` }, method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' } }, port).ok, true);
  });
  it('the server really listens on 127.0.0.1 only', async () => {
    const f2 = makeFakes();
    const s = createServer(f2.ctx);
    await new Promise<void>((resolve, reject) => listenLoopback(s, 0, resolve, (a) => reject(new Error('non-loopback ' + JSON.stringify(a)))));
    assert.equal((s.address() as AddressInfo).address, '127.0.0.1');
    await new Promise<void>((r) => s.close(() => r()));
  });
});

describe('net-guard: unauthenticated surface', () => {
  const f = makeFakes();
  let base = ''; let port = 0; let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; port = Number(new URL(base).port); close = s.close; });
  after(async () => { await close(); });
  it('/health is the only route that answers without a token and reveals only ok, version, pid and whether an admin secret exists', async () => {
    const r = await raw(base, '/health', { host: `127.0.0.1:${port}` });
    const j = JSON.parse(r.body);
    assert.deepEqual(Object.keys(j).sort(), ['admin', 'ok', 'pid', 'version']);
    assert.ok(!r.body.includes(TOKEN) && !/legion|\.legion|[A-Za-z]:\\|\/home\//i.test(r.body.replace(/"version":"[^"]*"/, '')));
  });
  it('every other path is 401 without a token (including unknown ones), so nothing else is unauthenticated', async () => {
    for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/config'], ['GET', '/api/settings'], ['GET', '/api/events'], ['POST', '/mcp'], ['GET', '/'], ['GET', '/nope'], ['GET', '/api/kg/notes'], ['POST', '/api/tasks'], ['GET', '/health/x']] as const) {
      assert.equal((await raw(base, p, { host: `127.0.0.1:${port}` }, m)).status, 401, `${m} ${p}`);
    }
  });
});
