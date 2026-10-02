/**
 * Capture stack for the trailer screenshots. Everything lives in ONE temp folder outside the repo and is removed by stop().
 *   - FakeBoatServer (dist/test/fake-boat-server.js) and the harness fake wallet (random loopback port),
 *   - a REAL Legion core (scripts/harness/core-entry.mjs: real Engine, routes, kg, comms, bsv, blender, updater; scripted model),
 *   - a tiny same-origin server: serves dist-ui and reverse-proxies /api/* and /health to the core
 *     (Origin, Sec-Fetch-*, Referer dropped, Host rewritten to 127.0.0.1:<coreport>, SSE streamed through).
 * Secrets: the ADMIN and NATIVE secrets are made in memory, written to the core's stdin pipe like the Electron main process does, and never
 * written to disk, argv, env or logs. The admin secret is handed to the page (window.legion.admin) only in the browser's memory, which is what
 * the real app window does too. The native secret never leaves this process: it is added to a call only when a script asks for auth 'native'.
 * Requires `npm run build:ts` and `npm run build:ui` first.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeWallet } from '../../../scripts/harness/fake-wallet.mjs';
import { coreEnv } from '../../../scripts/harness/core-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const uiDir = join(repo, 'dist-ui');
const hex = (n) => randomBytes(n).toString('hex');
const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

export async function startStack({ blenderEnabled = false } = {}) {
  if (!existsSync(join(uiDir, 'index.html'))) throw new Error('dist-ui is missing: run npm run build:ui');
  const dir = mkdtempSync(join(tmpdir(), 'legion-v2-capture-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const { FakeBoatServer } = await import(pathToFileURL(join(repo, 'dist', 'test', 'fake-boat-server.js')).href);
  const boat = await new FakeBoatServer().start();
  const wallet = await startFakeWallet();
  const blenderPath = join(dir, 'bin', 'fake-blender.mjs');
  mkdirSync(dirname(blenderPath), { recursive: true });
  writeFileSync(blenderPath, readFileSync(join(repo, 'scripts', 'harness', 'fake-blender.mjs')));
  try { chmodSync(blenderPath, 0o755); } catch { /* windows */ }

  const authToken = hex(24);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ authToken, workspaceDir: join(home, 'workspaces'), boat: { baseUrl: boat.baseUrl, apiKey: 'harness-fake-boat-key' } }, null, 2), { mode: 0o600 });

  const adminSecret = hex(32);
  const nativeSecret = hex(32);
  let core = null;
  let corePort = 0;
  let nextId = 1;
  const pendingIpc = new Map();
  for (let attempt = 0; attempt < 4 && !core; attempt++) {
    corePort = await freePort();
    const env = coreEnv(process.env, { LEGION_HOME: home, LEGION_PORT: String(corePort), LEGION_ADMIN_STDIN: '1' });
    const child = spawn(process.execPath, [join(repo, 'scripts', 'harness', 'core-entry.mjs')], { env, stdio: ['pipe', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.stdin.end(adminSecret + '\n' + nativeSecret + '\n');
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 20000);
      child.on('message', (m) => { if (m?.event === 'ready') { clearTimeout(t); resolve(m); } else if (m && typeof m.id === 'number') { const p = pendingIpc.get(m.id); pendingIpc.delete(m.id); p?.(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (ready) core = child; else { try { child.kill(); } catch { /* ignore */ } }
  }
  if (!core) throw new Error('core did not start');

  const ipc = (msg) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pendingIpc.delete(id); reject(new Error('no answer from core control channel')); }, 10000);
    pendingIpc.set(id, (m) => { clearTimeout(t); m.ok ? resolve(m.data) : reject(new Error(m.error)); });
    core.send({ ...msg, id });
  });

  /** One request to the core with the auth class asked for: 'admin' (default), 'native' (admin + native), 'token' or 'none'. */
  function call(method, path, body, auth = 'admin') {
    const h = {};
    if (auth !== 'none') h.Authorization = `Bearer ${authToken}`;
    if (auth === 'admin' || auth === 'native') h['X-Legion-Admin'] = adminSecret;
    if (auth === 'native') h['X-Legion-Native'] = nativeSecret;
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data !== undefined) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    return new Promise((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: corePort, method, path, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
          resolve({ status: res.statusCode, json, text: json === undefined ? text : undefined });
        });
      });
      r.setTimeout(60000, () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      if (data !== undefined) r.write(data);
      r.end();
    });
  }

  // --- same-origin server: static dist-ui + reverse proxy to the core
  const DROP = /^(origin|referer|sec-fetch-.*|host|connection|content-length)$/i;
  const proxy = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!DROP.test(k) && v !== undefined) headers[k] = v;
      headers.host = `127.0.0.1:${corePort}`;
      const up = httpRequest({ host: '127.0.0.1', port: corePort, method: req.method, path: req.url, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => up.destroy());
      req.pipe(up);
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = normalize(join(uiDir, rel));
    if (file !== uiDir && !file.startsWith(uiDir + sep)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  const proxyPort = await freePort();
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try { proxy.closeAllConnections?.(); proxy.close(); } catch { /* ignore */ }
    const c = core;
    if (c && c.exitCode === null) {
      await new Promise((resolve) => { const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 5000); c.once('exit', () => { clearTimeout(t); resolve(); }); try { c.kill('SIGTERM'); } catch { resolve(); } });
    }
    await Promise.allSettled([boat.stop(), wallet.stop()]);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return {
    dir, corePort, proxyPort, authToken, adminSecret, blenderPath, wallet, boat, corePid: core.pid,
    pageUrl: `http://127.0.0.1:${proxyPort}/index.html`,
    call, stop,
    script: (match, steps) => ipc({ op: 'script', match, steps }),
    resetModel: () => ipc({ op: 'reset' }),
    until: async (fn, ms = 15000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); } },
  };
}
