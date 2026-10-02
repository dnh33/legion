/**
 * Token fix v1, the core side: /health, the stdin secret reader, and a REAL spawned core (Linux checks marked).
 * The secret must never be on disk, in the environment or in argv, and never in a response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ADMIN_STDIN_FLAG, healthProof, readAdminSecret, readSecretFromStream } from '../src/core/admin.js';
import { adminForRenderer } from '../src/electron/admin-logic.js';
import { makeFakes, start, TEST_ADMIN } from './helpers-c.js';

// ---------------------------------------------------------------- /health

test('/health reports admin:boolean and never the secret (in-process server)', async () => {
  const f = makeFakes();
  const withSecret = await start(f.ctx);
  const body = await (await fetch(withSecret.base + '/health')).text();
  const j = JSON.parse(body);
  assert.equal(j.ok, true);
  assert.equal(j.admin, true);
  assert.equal(typeof j.pid, 'number');
  assert.ok(!body.includes(TEST_ADMIN), '/health must not contain the admin secret');
  assert.deepEqual(Object.keys(j).sort(), ['admin', 'ok', 'pid', 'version'], 'no nonce: no proof, nothing new');
  // the challenge: HMAC(secret, nonce), only for a valid hex nonce, never the secret itself
  const nonce = 'ab12'.repeat(8);
  const ch = await (await fetch(`${withSecret.base}/health?nonce=${nonce}`)).text();
  assert.equal(JSON.parse(ch).proof, healthProof(TEST_ADMIN, nonce));
  assert.ok(!ch.includes(TEST_ADMIN));
  for (const bad of ['zz', 'ab', 'g'.repeat(32), 'ab'.repeat(100), '']) assert.equal(JSON.parse(await (await fetch(`${withSecret.base}/health?nonce=${bad}`)).text()).proof, undefined, `nonce "${bad.slice(0, 8)}"`);
  await withSecret.close();
  const headless = await start({ ...f.ctx, adminSecret: undefined });
  assert.equal((await (await fetch(headless.base + '/health')).json()).admin, false);
  assert.equal((await (await fetch(`${headless.base}/health?nonce=${nonce}`)).json()).proof, undefined, 'a core without a secret can never prove one');
  await headless.close();
});

// ---------------------------------------------------------------- the stdin reader

test('readSecretFromStream: first line, EOF without newline, too short, nothing, timeout', async () => {
  const S = randomBytes(24).toString('hex');
  const a = new PassThrough(); const pa = readSecretFromStream(a); a.write(S + '\nrest'); assert.equal(await pa, S);
  const b = new PassThrough(); const pb = readSecretFromStream(b); b.end(S); assert.equal(await pb, S);
  const c = new PassThrough(); const pc = readSecretFromStream(c); c.end('short\n'); assert.equal(await pc, undefined, 'a guessable short value is ignored');
  const d = new PassThrough(); const pd = readSecretFromStream(d); d.end(); assert.equal(await pd, undefined);
  const e = new PassThrough(); assert.equal(await readSecretFromStream(e, 30), undefined, 'a pipe that never delivers times out');
  const f = new PassThrough(); const pf = readSecretFromStream(f); f.write(S.slice(0, 20)); f.write(S.slice(20) + '\r\n'); assert.equal(await pf, S, 'split chunks and CRLF');
});

test('readAdminSecret: only when the flag says stdin; the flag is removed; env values and argv are never read', async () => {
  const S = randomBytes(24).toString('hex');
  const noFlag: NodeJS.ProcessEnv = { LEGION_ADMIN_SECRET: S, LEGION_ADMIN: S };
  const untouched = new PassThrough();
  assert.equal(await readAdminSecret(noFlag, untouched), undefined, 'a secret in the environment is ignored');
  const flagged: NodeJS.ProcessEnv = { [ADMIN_STDIN_FLAG]: '1', LEGION_ADMIN_SECRET: S };
  const s = new PassThrough(); const p = readAdminSecret(flagged, s); s.write(S + '\n');
  assert.equal(await p, S);
  assert.equal(flagged[ADMIN_STDIN_FLAG], undefined, 'the flag is deleted so agent children do not inherit it');
  const wrongFlag: NodeJS.ProcessEnv = { [ADMIN_STDIN_FLAG]: S };
  assert.equal(await readAdminSecret(wrongFlag, new PassThrough()), undefined, 'the flag value is only ever 1; a secret there is not used');
});

// ---------------------------------------------------------------- a real spawned core

const coreJs = fileURLToPath(new URL('../src/bin/legion-core.js', import.meta.url)); // not .pathname: "/D:/..." on Windows
const freePort = (): Promise<number> => new Promise((res, rej) => {
  const s = createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  try { return statSync(p).isDirectory() ? filesUnder(p) : [p]; } catch { return []; }
});

async function spawnCore(o: { secret?: string; flag?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'legion-tok1-core-'));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [coreJs], {
    env: { ...process.env, LEGION_HOME: home, LEGION_PORT: String(port), ...(o.flag ? { [ADMIN_STDIN_FLAG]: '1' } : {}) },
    stdio: [o.flag ? 'pipe' : 'ignore', 'ignore', 'ignore'],
  });
  if (o.flag) child.stdin!.end(o.secret === undefined ? '' : o.secret + '\n');
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 20000;
  let up = false;
  while (Date.now() < end && !up) {
    try { up = (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, 'the real core did not come up');
  const token = (JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { authToken: string }).authToken;
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  return { home, port, base, child, token, stop };
}

test('a real core started with the secret on stdin: admin works with the header only, the config token is client-class, and the secret is nowhere on disk or in the environment', async () => {
  const SECRET = randomBytes(24).toString('hex');
  const core = await spawnCore({ flag: true, secret: SECRET });
  try {
    const h = await fetch(core.base + '/health');
    const hb = await h.text();
    const hj = JSON.parse(hb);
    assert.equal(hj.admin, true);
    assert.equal(hj.pid, core.child.pid, '/health pid is the child pid (Electron main relies on this)');
    assert.ok(!hb.includes(SECRET));
    const B = { Authorization: `Bearer ${core.token}` }; const A = { 'X-Legion-Admin': SECRET };
    const hit = (m: string, p: string, h: Record<string, string>, body?: unknown) => fetch(core.base + p, { method: m, headers: { ...h, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await hit('GET', '/api/state', B)).status, 200);
    assert.equal((await hit('POST', '/api/bsv', B, { enabled: true })).status, 403);
    assert.equal((await hit('PATCH', '/api/settings', B, { claude: { maxTurns: 7 } })).status, 403);
    assert.equal((await hit('GET', '/api/kg/stats', B)).status, 403);
    assert.equal((await hit('GET', '/api/nothing-here', B)).status, 403);
    assert.equal((await hit('GET', '/api/settings', A)).status, 200);
    assert.equal((await hit('GET', '/api/kg/stats', { ...B, ...A })).status, 200);
    const patched = await hit('PATCH', '/api/settings', { ...B, ...A }, { claude: { maxTurns: 7 } });
    assert.equal(patched.status, 200);
    const bad = await hit('GET', '/api/settings', { ...B, 'X-Legion-Admin': SECRET.slice(0, -1) + (SECRET.endsWith('0') ? '1' : '0') });
    const badText = await bad.text();
    assert.equal(bad.status, 403);
    assert.ok(!badText.includes(SECRET));
    // nothing on disk: config.json, core.log, the graph, every file the core wrote under LEGION_HOME
    const files = filesUnder(core.home);
    assert.ok(files.some((f) => f.endsWith('config.json')));
    // the core is still running: its atomic writes (state.json.tmp, then rename) can remove a file between the listing and the read
    const leaks = files.filter((f) => { try { return readFileSync(f).includes(SECRET); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } });
    assert.deepEqual(leaks, [], 'the admin secret must not be in any file under LEGION_HOME');
    // Linux: the process environment and command line (a same-user bot can read both)
    if (existsSync(`/proc/${core.child.pid}/environ`)) {
      assert.ok(!readFileSync(`/proc/${core.child.pid}/environ`).includes(SECRET), 'secret in /proc/<pid>/environ');
      assert.ok(!readFileSync(`/proc/${core.child.pid}/cmdline`).includes(SECRET), 'secret in /proc/<pid>/cmdline');
      // (the flag itself, value 1, stays in the initial environ block: it is not the secret)
    }
  } finally { await core.stop(); }
});

test('a real core started without the flag (headless, like the MCP bridge does) is admin-closed, and so is one handed a too-short secret or nothing', async () => {
  for (const [label, o] of [['headless', {}], ['short secret', { flag: true, secret: 'abc' }], ['stdin closed empty', { flag: true }]] as const) {
    const core = await spawnCore(o);
    try {
      const hj = await (await fetch(core.base + '/health')).json();
      assert.equal(hj.admin, false, label);
      const B = { Authorization: `Bearer ${core.token}` };
      assert.equal((await fetch(core.base + '/api/state', { headers: B })).status, 200, label);
      const r = await fetch(core.base + '/api/settings', { headers: { ...B, 'X-Legion-Admin': 'abc' } });
      assert.equal(r.status, 403, label);
      assert.equal((await r.json()).error, 'admin_unavailable: open the Legion app', label);
      const r2 = await fetch(core.base + '/api/approvals/x', { method: 'POST', headers: { ...B, 'Content-Type': 'application/json' }, body: '{"allow":true}' });
      assert.equal(r2.status, 403, label);
    } finally { await core.stop(); }
  }
});

test('a real core answers the challenge, also through a shim whose pid is not the core pid; a rogue echoing the pid cannot', async () => {
  const SECRET = randomBytes(24).toString('hex');
  // a shim: the process we spawn (like node.cmd / Volta / scoop) starts the real core as its child and passes our stdin pipe on
  const home = mkdtempSync(join(tmpdir(), 'legion-tok1-shim-'));
  const port = await freePort();
  const shim = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath,[process.argv[1]],{stdio:'inherit'})", coreJs], {
    env: { ...process.env, LEGION_HOME: home, LEGION_PORT: String(port), [ADMIN_STDIN_FLAG]: '1' }, stdio: ['pipe', 'ignore', 'ignore'],
  });
  shim.stdin!.end(SECRET + '\n');
  const base = `http://127.0.0.1:${port}`;
  try {
    const end = Date.now() + 20000; let up = false;
    while (Date.now() < end && !up) { try { up = (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up, 'shimmed core did not come up');
    const nonce = randomBytes(16).toString('hex');
    const h = await (await fetch(`${base}/health?nonce=${nonce}`)).json();
    assert.notEqual(h.pid, shim.pid, 'the shim pid differs from the core pid');
    assert.equal(adminForRenderer(h, SECRET, nonce), SECRET, 'main would release the secret to it');
    // a rogue that copies the public pid and the admin flag, with no secret
    const rogue = { ok: true, pid: h.pid, admin: true, proof: healthProof('c'.repeat(48), nonce) };
    assert.equal(adminForRenderer(rogue, SECRET, nonce), undefined);
    assert.equal(adminForRenderer({ ...h, proof: undefined }, SECRET, nonce), undefined);
    // and a different core (another secret) is not ours
    assert.equal(adminForRenderer(h, 'd'.repeat(48), nonce), undefined);
  } finally {
    shim.kill('SIGTERM');
    // the core is the shim's child: stop it through the port's own pid
    try { const hh = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).json(); process.kill(hh.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
});
