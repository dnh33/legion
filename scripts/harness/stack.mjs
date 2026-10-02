/**
 * The harness supervisor (started detached by `legion-harness.mjs start`; not meant to be run by hand).
 * Owns, inside one temp folder outside the repo: a REAL Legion core (core-entry.mjs) in its own process with a temp LEGION_HOME and a random
 * loopback port, a fake boat.dev (test/fake-boat-server.ts, compiled to dist/test), a fake BSV wallet (fake-wallet.mjs), a fake `blender`
 * executable, and a small control server the CLI talks to.
 *
 * Secrets: the per-launch ADMIN secret and NATIVE secret are made here, written to the core's stdin pipe (line 1 and line 2, then the pipe is
 * closed) exactly as the Electron main process does, and kept in this process's memory. They are never written to a file, env var, argv or log.
 * The control server adds them to a request only when a CLI call asks for that auth class (`/call`).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeWallet } from './fake-wallet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const harnessDir = process.argv[2];
if (!harnessDir) { process.stderr.write('usage: stack.mjs <harnessDir>\n'); process.exit(2); }
process.chdir(tmpdir()); // never keep a folder we delete open as our cwd
const home = join(harnessDir, 'home');
mkdirSync(home, { recursive: true });
const hex = (n) => randomBytes(n).toString('hex');

const { FakeBoatServer } = await import(pathToFileURL(join(repo, 'dist', 'test', 'fake-boat-server.js')).href);
const boat = await new FakeBoatServer().start();
const wallet = await startFakeWallet();
const blenderPath = join(harnessDir, 'bin', 'fake-blender.mjs');
mkdirSync(dirname(blenderPath), { recursive: true });
writeFileSync(blenderPath, readFileSync(join(here, 'fake-blender.mjs')));
try { chmodSync(blenderPath, 0o755); } catch { /* windows */ }

const authToken = hex(24);
const configFile = join(home, 'config.json');
writeFileSync(configFile, JSON.stringify({ authToken, workspaceDir: join(home, 'workspaces'), boat: { baseUrl: boat.baseUrl, apiKey: 'harness-fake-boat-key' } }, null, 2), { mode: 0o600 });

const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let adminSecret = '';
let nativeSecret = '';
let core = null;
let corePort = 0;
let coreInfo = {};
let nextId = 1;
const pendingIpc = new Map();
const logFd = join(harnessDir, 'core.log');

async function startCore() {
  adminSecret = hex(32); // 64 hex chars, like the app
  nativeSecret = hex(32);
  for (let attempt = 0; attempt < 4; attempt++) {
    corePort = await freePort();
    const env = { ...process.env, LEGION_HOME: home, LEGION_PORT: String(corePort), LEGION_ADMIN_STDIN: '1' };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_|BOAT_API_KEY|CLAUDE)/.test(k)) delete env[k];
    const child = spawn(process.execPath, [join(here, 'core-entry.mjs')], { env, stdio: ['pipe', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr.on('data', (d) => { try { writeFileSync(logFd, d, { flag: 'a' }); } catch { /* ignore */ } });
    child.stdin.on('error', () => undefined);
    child.stdin.end(adminSecret + '\n' + nativeSecret + '\n');
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 20000);
      child.on('message', (m) => { if (m?.event === 'ready') { clearTimeout(t); resolve(m); } else if (m && typeof m.id === 'number') { const p = pendingIpc.get(m.id); pendingIpc.delete(m.id); p?.(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (ready) { core = child; coreInfo = ready; return; }
    try { child.kill(); } catch { /* ignore */ }
  }
  throw new Error('core did not start (see core.log in the harness folder)');
}
const ipc = (msg) => new Promise((resolve, reject) => {
  if (!core?.connected) return reject(new Error('core is not running'));
  const id = nextId++;
  const t = setTimeout(() => { pendingIpc.delete(id); reject(new Error('core did not answer the control message')); }, 10000);
  pendingIpc.set(id, (m) => { clearTimeout(t); m.ok ? resolve(m.data) : reject(new Error(m.error)); });
  core.send({ ...msg, id });
});
const stopCore = async () => {
  const c = core; core = null;
  if (!c || c.exitCode !== null) return;
  await new Promise((resolve) => { const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 5000); c.once('exit', () => { clearTimeout(t); resolve(); }); try { c.kill('SIGTERM'); } catch { resolve(); } });
};

await startCore();

/** One request to the core, with the auth class the caller asked for. Secrets are added here and never leave this process. */
function callCore({ method = 'GET', path = '/', body, auth = 'admin', headers = {} }) {
  const h = { ...headers };
  if (auth !== 'none' && auth !== 'admin-only') h.Authorization = `Bearer ${authToken}`;
  if (auth === 'admin' || auth === 'admin-only' || auth === 'native') h['X-Legion-Admin'] = adminSecret;
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

const ctlToken = hex(16);
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')); } catch { res({}); } }); });
let shuttingDown = false;
const control = createServer(async (req, res) => {
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.headers.authorization !== `Bearer ${ctlToken}`) return send(401, { error: 'unauthorized' });
  const url = new URL(req.url ?? '/', 'http://x');
  const body = req.method === 'POST' ? await readBody(req) : {};
  try {
    if (url.pathname === '/status') {
      return send(200, { core: { pid: core?.pid ?? null, port: corePort, alive: !!core && core.exitCode === null, ...coreInfo }, boat: { url: boat.baseUrl, requests: boat.requests.length }, wallet: { url: wallet.url, requests: wallet.seen.length }, blender: blenderPath, supervisorPid: process.pid });
    }
    if (url.pathname === '/call') return send(200, await callCore(body));
    if (url.pathname === '/script') return send(200, await ipc({ op: 'script', match: body.match, steps: body.steps }));
    if (url.pathname === '/model/log') return send(200, await ipc({ op: 'log' }));
    if (url.pathname === '/model/reset') return send(200, await ipc({ op: 'reset' }));
    if (url.pathname === '/fakes/boat') return send(200, { requests: boat.requests.map(({ method, path }) => ({ method, path })), sandboxes: [...boat.sandboxes.entries()].map(([id, s]) => ({ id, ...s })) });
    if (url.pathname === '/fakes/boat/config') { for (const k of ['trial', 'providerConfigured', 'providerFirst', 'stopSticks']) if (typeof body[k] === 'boolean') boat[k] = body[k]; if (Array.isArray(body.forbidden)) boat.forbidden = new Set(body.forbidden.map(String)); return send(200, { ok: true }); }
    if (url.pathname === '/fakes/boat/clear') { boat.requests.length = 0; return send(200, { ok: true }); }
    if (url.pathname === '/fakes/wallet') return send(200, { url: wallet.url, port: wallet.port, state: wallet.state, seen: wallet.seen, offAllowlist: wallet.offAllowlist });
    if (url.pathname === '/fakes/wallet/state') { wallet.setState(body); return send(200, wallet.state); }
    if (url.pathname === '/fakes/wallet/clear') { wallet.seen.length = 0; wallet.offAllowlist.length = 0; return send(200, { ok: true }); }
    if (url.pathname === '/restart-core') {
      // like the tray's "Restart core": new process, NEW secrets. `configPatch` is shallow-merged per top-level key into config.json first (emulates a hand edit).
      await stopCore();
      if (body.configPatch && typeof body.configPatch === 'object') {
        const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
        for (const [k, v] of Object.entries(body.configPatch)) cfg[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(cfg[k] ?? {}), ...v } : v;
        writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      }
      await startCore();
      writeHandle();
      return send(200, { ok: true, port: corePort, pid: core.pid });
    }
    if (url.pathname === '/home-file') {
      // read or replace a file inside the temp LEGION_HOME (to emulate a hand edit); anything that resolves outside it is refused
      const target = resolve(home, String(body.path ?? ''));
      if (target !== home && !target.startsWith(home + sep)) return send(400, { error: 'path is outside the harness home' });
      if (body.op === 'write') { writeFileSync(target, String(body.content ?? '')); return send(200, { ok: true }); }
      if (body.op === 'list') return send(200, { files: readdirSync(target) });
      return send(200, { content: readFileSync(target, 'utf8') });
    }
    if (url.pathname === '/stop') { send(200, { ok: true }); void shutdown(); return undefined; }
    return send(404, { error: 'unknown control route' });
  } catch (e) { return send(500, { error: String(e?.message ?? e) }); }
});
await new Promise((r) => control.listen(0, '127.0.0.1', r));

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopCore();
  await Promise.allSettled([boat.stop(), wallet.stop()]);
  control.closeAllConnections?.();
  control.close();
  try { rmSync(harnessDir, { recursive: true, force: true }); } catch { /* the CLI retries */ }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

const writeHandle = () => {
  const handle = {
    version: 1,
    harnessDir,
    home,
    baseUrl: `http://127.0.0.1:${corePort}`,
    supervisorPid: process.pid,
    corePid: core.pid,
    control: { url: `http://127.0.0.1:${control.address().port}`, token: ctlToken },
    fakes: { boatUrl: boat.baseUrl, walletUrl: wallet.url, blender: blenderPath },
    startedAt,
  };
  const tmp = join(harnessDir, 'handle.json.tmp');
  writeFileSync(tmp, JSON.stringify(handle, null, 2), { mode: 0o600 });
  renameSync(tmp, join(harnessDir, 'handle.json'));
};
const startedAt = new Date().toISOString();
writeHandle();
