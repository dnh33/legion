// Electron main process, emulated: the REAL compiled dist/src/electron/main.js with `electron` stubbed (register.mjs), driving a REAL spawned core.
// Run: node --import ./test/electron-emu/register.mjs test/electron-emu/run.mjs <scenario>   (the suite does this; one JSON line comes back on stdout)
// Ported from the round-2 reviewer's e1/e2/e3 proofs. Not run: real Electron, real Windows (taskkill, netstat parsing on real output).
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const scenario = process.argv[2] || 'basic';
const home = mkdtempSync(join(tmpdir(), 'legion-emu-'));
process.env.LEGION_HOME = home;
delete process.env.LEGION_PORT;
const TOKEN = 'tok' + 'a'.repeat(40);
const PORT = 20000 + Math.floor(Math.random() * 20000);
writeFileSync(join(home, 'config.json'), JSON.stringify({ port: PORT, authToken: TOKEN }));
if (scenario === 'shim') process.env.LEGION_NODE = resolve('test/electron-emu/shim.sh');

// the compiled main, plus an export of its internals, next to the original so its relative imports resolve
const dist = resolve('dist/src/electron');
const emu = join(dist, `main_emu_${process.pid}.js`);
const src = readFileSync(join(dist, 'main.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');
writeFileSync(emu, src + '\nexport const __t = { ensureCore, killCore, restartCore, getHealth, get coreProc() { return coreProc; }, get adminSecret() { return adminSecret; } };\n');
const { __t } = await import(emu);
const seen = []; const servers = [];
const rogue = (port, healthBody) => new Promise((res) => {
  const s = http.createServer((q, r) => {
    seen.push({ url: q.url, admin: q.headers['x-legion-admin'] ?? null });
    const u = new URL(q.url, 'http://x');
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify(u.pathname === '/health' ? healthBody : u.pathname === '/api/state' ? { tasks: [], approvals: [] } : {}));
  });
  s.listen(port, '127.0.0.1', () => { servers.push(s); res(s); });
});
const bootstrap = () => { const e = {}; globalThis.__ipc['legion:bootstrap'](e); return e.returnValue; };
// a zombie (killed, not yet reaped by an init that is slow to wait) is dead
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (url, headers) => fetch(url, { headers }).then((r) => r.status);
const out = {};
const cleanup = async () => {
  try { await __t.killCore(); } catch { /* ignore */ }
  const h = await __t.getHealth(PORT, 500).catch(() => null);
  if (h?.pid && alive(h.pid)) { try { process.kill(h.pid, 'SIGKILL'); } catch { /* ignore */ } }
  for (const s of servers) s.close();
  try { rmSync(emu, { force: true }); } catch { /* ignore */ }
};

try {
  if (scenario === 'basic') {
    out.ensure = await __t.ensureCore();
    const b = bootstrap();
    out.adminLen = b.admin.length;
    out.baseUrl = b.baseUrl; out.port = PORT;
    out.adminApprovals = await status(b.baseUrl + '/api/approvals', { 'X-Legion-Admin': b.admin });
    out.tokenOnlyApprovals = await status(b.baseUrl + '/api/approvals', { Authorization: 'Bearer ' + b.token });
    // F2: a bot edits config.json (port -> its own listener, a fake token) after launch; the "window reload" must not follow it
    const R = PORT + 1;
    await rogue(R, { ok: true, pid: __t.coreProc.pid, admin: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: R, authToken: 'evil' }));
    const b2 = bootstrap();
    out.afterEditBase = b2.baseUrl; out.afterEditTokenEvil = b2.token === 'evil'; out.afterEditAdminGiven = b2.admin.length > 0;
    // tray restart: the old core is gone, a new one runs, the secret rotates
    const oldPid = __t.coreProc.pid;
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: PORT, authToken: TOKEN }));
    await __t.restartCore();
    const b3 = bootstrap();
    out.restart = { newPid: __t.coreProc?.pid ?? null, oldDead: !alive(oldPid), rotated: b3.admin !== b.admin, adminLen: b3.admin.length, baseUrl: b3.baseUrl, dialogs: globalThis.__dialogs.length };
    out.rogueGotAdminHeader = seen.filter((s) => s.admin).length;
    out.rogueRequests = seen.length;
  }
  if (scenario === 'squat') {
    // a rogue holds the port BEFORE start, copies /health including a victim's pid and admin:true, and records everything it is sent
    const victim = spawn('sleep', ['300']);
    await rogue(PORT, { ok: true, version: '0.1.0', pid: victim.pid, admin: true, proof: 'f'.repeat(64) });
    globalThis.__dialogAnswer = 0; // if it ever asked "restart now?", the answer would be yes
    out.ensure = await __t.ensureCore();
    await wait(300);
    out.victimAlive = alive(victim.pid) && victim.exitCode === null && victim.signalCode === null;
    out.rogueGotAdminHeader = seen.filter((s) => s.admin).length;
    out.bootstrapAdminLen = bootstrap().admin.length;
    out.dialogs = globalThis.__dialogs.map((d) => d.message ?? d.error);
    victim.kill('SIGKILL');
  }
  if (scenario === 'foreign') {
    // a real idle core started outside the app (no admin secret) holds the port: its own pid owns the listener, so it is replaced
    const ownDist = resolve('dist/src/bin/legion-core.js');
    const foreign = spawn('node', [ownDist], { env: { ...process.env, LEGION_PORT: String(PORT) }, stdio: 'ignore' });
    const end = Date.now() + 15000;
    while (Date.now() < end && !(await __t.getHealth(PORT, 400))) await wait(200);
    const before = await __t.getHealth(PORT, 400);
    out.foreignUp = !!before && before.admin === false; out.foreignPid = foreign.pid;
    out.ensure = await __t.ensureCore();
    const b = bootstrap();
    out.foreignDead = !alive(foreign.pid);
    out.adminLen = b.admin.length;
    out.ownCore = __t.coreProc?.pid ?? null;
  }
  if (scenario === 'shim') {
    out.ensure = await __t.ensureCore();
    const h = await __t.getHealth(PORT);
    out.wrapperPid = __t.coreProc.pid; out.corePid = h.pid; out.distinct = h.pid !== __t.coreProc.pid;
    await __t.killCore();
    await wait(500);
    out.coreStillAnswers = !!(await __t.getHealth(PORT, 500));
    out.coreAlive = alive(h.pid);
  }
  if (scenario === 'hygiene') {
    out.ensure = await __t.ensureCore();
    const S = __t.adminSecret; const pid = __t.coreProc.pid;
    const b = bootstrap();
    out.bootstrapIsSecret = b.admin === S;
    const has = (x) => x.includes(S);
    out.inCmdline = has(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
    out.inEnviron = has(readFileSync(`/proc/${pid}/environ`, 'utf8'));
    await fetch(`http://127.0.0.1:${PORT}/health?nonce=${'ab'.repeat(16)}`);
    const log = readFileSync(join(home, 'core.log'), 'utf8');
    out.inCoreLog = has(log);
    const files = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (has(readFileSync(p, 'utf8'))) files.push(p); } };
    walk(home);
    out.filesWithSecret = files;
  }
} catch (e) { out.error = String(e?.stack ?? e); }
await cleanup();
rmSync(home, { recursive: true, force: true });
console.log('EMU_RESULT ' + JSON.stringify(out));
process.exit(0);
