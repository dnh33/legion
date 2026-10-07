/** Shared client code for the harness CLI, the scenarios and the smoke test: start/stop a stack and talk to its control server. No dependencies. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
export const DIR_PREFIX = 'legion-harness-';
export const MARKER_FILE = 'harness-marker.json';
export const pointerFile = () => join(tmpdir(), 'legion-harness-current.json');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

export function assertBuilt() {
  if (!existsSync(join(repoRoot, 'dist', 'src', 'core', 'engine.js')) || !existsSync(join(repoRoot, 'dist', 'test', 'fake-boat-server.js'))) {
    throw new Error('dist/ is missing: run `npm run build:ts` first (the harness runs the compiled core and test/fake-boat-server.ts).');
  }
}

/**
 * Removes temp folders a crashed supervisor left behind. Only a folder that (a) is named legion-harness-*, (b) carries our marker file with a
 * recorded supervisor pid and (c) whose recorded pid is no longer alive. Never kills anything, never matches by process name.
 * @returns {string[]} the folders removed
 */
export function sweepDeadHarnessDirs(root = tmpdir()) {
  const removed = [];
  let names = []; try { names = readdirSync(root); } catch { return removed; }
  for (const n of names) {
    if (!n.startsWith(DIR_PREFIX)) continue;
    const dir = join(root, n);
    try {
      const m = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8'));
      if (m?.harness !== true || !Number.isInteger(m.supervisorPid) || isAlive(m.supervisorPid)) continue;
      rmSync(dir, { recursive: true, force: true }); removed.push(dir);
    } catch { /* no marker, unreadable or not ours: leave it */ }
  }
  return removed;
}

/** Starts a detached stack and resolves with its handle (the content of handle.json, including the control token: keep it in memory). */
export async function startHarness({ timeoutMs = 45000 } = {}) {
  assertBuilt();
  sweepDeadHarnessDirs();
  const harnessDir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  const out = openSync(join(harnessDir, 'supervisor.log'), 'a');
  const child = spawn(process.execPath, [join(here, 'stack.mjs'), harnessDir], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: tmpdir() });
  child.unref();
  writeFileSync(join(harnessDir, MARKER_FILE), JSON.stringify({ harness: true, supervisorPid: child.pid }));
  const handleFile = join(harnessDir, 'handle.json');
  const end = Date.now() + timeoutMs;
  while (!existsSync(handleFile)) {
    if (!isAlive(child.pid) || Date.now() > end) {
      let log = ''; try { log = readFileSync(join(harnessDir, 'supervisor.log'), 'utf8').slice(-800); } catch { /* ignore */ }
      try { if (isAlive(child.pid)) process.kill(child.pid); } catch { /* ignore */ }
      rmSync(harnessDir, { recursive: true, force: true });
      throw new Error(`harness did not start: ${log || 'no output'}`);
    }
    await sleep(100);
  }
  return { ...JSON.parse(readFileSync(handleFile, 'utf8')), handleFile };
}

export function readHandle(file) {
  const f = file || process.env.LEGION_HARNESS_HANDLE || (existsSync(pointerFile()) ? JSON.parse(readFileSync(pointerFile(), 'utf8')).handleFile : '');
  if (!f || !existsSync(f)) throw new Error('no running harness found (start one with `start`, or pass --handle <file>)');
  return { ...JSON.parse(readFileSync(f, 'utf8')), handleFile: f };
}

async function control(handle, path, body) {
  const r = await fetch(handle.control.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${handle.control.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`control ${path}: ${r.status} ${j.error ?? ''}`);
  return j;
}

/** Stops a stack: asks the supervisor, then (only if it is still alive) kills the recorded pids, never by name. Returns what, if anything, is left. */
export async function stopHarness(handle) {
  try { await control(handle, '/stop', {}); } catch { /* already gone */ }
  let current = handle;
  try { current = { ...handle, ...JSON.parse(readFileSync(handle.handleFile, 'utf8')) }; } catch { /* handle already deleted */ }
  const pids = [...new Set([handle.supervisorPid, current.corePid, handle.corePid])].filter(Boolean);
  const end = Date.now() + 10000;
  while (pids.some(isAlive) && Date.now() < end) await sleep(100);
  for (const pid of pids) if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  await sleep(100);
  const dir = handle.harnessDir;
  if (dir && basename(dir).startsWith(DIR_PREFIX) && existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* reported below */ } }
  try { if (existsSync(pointerFile()) && JSON.parse(readFileSync(pointerFile(), 'utf8')).handleFile === handle.handleFile) rmSync(pointerFile()); } catch { /* ignore */ }
  return { pidsAlive: pids.filter(isAlive), dirLeft: !!dir && existsSync(dir) };
}

export function writePointer(handle) { writeFileSync(pointerFile(), JSON.stringify({ handleFile: handle.handleFile }), { mode: 0o600 }); }

/** What scenarios use: a thin client over the control server. */
export function client(handle) {
  const h = {
    handle,
    status: () => control(handle, '/status'),
    /** @returns {Promise<{status:number, json?:any, text?:string}>} auth: admin (default, like the app window) | token (an MCP client) | none | admin-only | native (what Electron main sends after its dialog) */
    call: (method, path, body, auth = 'admin') => control(handle, '/call', { method, path, body, auth }),
    script: (match, steps) => control(handle, '/script', { match, steps }),
    modelLog: () => control(handle, '/model/log'),
    /** Scripts the fake GitHub behind the CI panel: {scenario, connection, rate, logs, fail, privateRepos, finish, resetCalls}. Returns call counts and the write log. */
    github: (cmd = {}) => control(handle, '/fakes/github', cmd),
    resetModel: () => control(handle, '/model/reset', {}),
    boat: () => control(handle, '/fakes/boat'),
    boatConfig: (patch) => control(handle, '/fakes/boat/config', patch),
    boatClear: () => control(handle, '/fakes/boat/clear', {}),
    wallet: () => control(handle, '/fakes/wallet'),
    walletState: (patch) => control(handle, '/fakes/wallet/state', patch),
    walletClear: () => control(handle, '/fakes/wallet/clear', {}),
    /** Read, write or list a file inside the stack's temp LEGION_HOME (emulates a hand edit). */
    homeFile: (op, path, content) => control(handle, '/home-file', { op, path, content }),
    restartCore: (configPatch) => control(handle, '/restart-core', { configPatch }),
    async until(fn, ms = 15000, what = 'condition') {
      const end = Date.now() + ms;
      for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(40); }
    },
    /** Starts a task as the app would (admin) and resolves with the finished task. */
    async runTask(agentId, prompt, { auth = 'admin', timeoutMs = 20000 } = {}) {
      const r = await h.call('POST', '/api/tasks', { agentId, prompt }, auth);
      if (r.status !== 201) throw new Error(`POST /api/tasks -> ${r.status} ${JSON.stringify(r.json ?? r.text)}`);
      return h.waitTask(r.json.id, timeoutMs, auth);
    },
    async waitTask(id, ms = 20000, auth = 'admin') {
      return h.until(async () => { const t = (await h.call('GET', `/api/tasks/${id}`, undefined, auth)).json?.task; return t && ['done', 'error', 'cancelled'].includes(t.status) ? t : null; }, ms, `task ${id}`);
    },
    async pendingApprovals() { return (await h.call('GET', '/api/approvals')).json ?? []; },
    async waitApproval(ms = 15000) { return h.until(async () => { const p = await h.pendingApprovals(); return p.length ? p[0] : null; }, ms, 'an approval card'); },
  };
  return h;
}
