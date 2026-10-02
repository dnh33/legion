// Electron main process, emulated: the REAL compiled dist/src/electron/main.js with `electron` stubbed (register.mjs), driving a REAL spawned core.
// Run: node --import ./test/electron-emu/register.mjs test/electron-emu/run.mjs <scenario>   (the suite does this; one JSON line comes back on stdout)
// Ported from the round-2 reviewer's e1/e2/e3 proofs. Not run: real Electron, real Windows (taskkill, netstat parsing on real output).
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
if (scenario === 'shim') {
  // the shim must be executable; a checkout that does not keep the mode bit (archive, some worktrees) would fail with EACCES
  chmodSync('test/electron-emu/shim.sh', 0o755);
  process.env.LEGION_NODE = resolve('test/electron-emu/shim.sh');
}

// the compiled main, plus an export of its internals, next to the original so its relative imports resolve
const dist = resolve('dist/src/electron');
const emu = join(dist, `main_emu_${process.pid}.js`);
const src = readFileSync(join(dist, 'main.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');
writeFileSync(emu, src + '\nexport const __t = { ensureCore, killCore, restartCore, getHealth, createWindow, uiUrl, get win() { return win; }, get coreProc() { return coreProc; }, get adminSecret() { return adminSecret; }, get nativeSecret() { return nativeSecret; } };\n');
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
    const N = __t.nativeSecret;
    out.nativeLen = N?.length ?? 0;
    out.nativeDiffersFromAdmin = !!N && N !== S;
    const hasN = (x) => !!N && x.includes(N);
    out.nativeInCmdline = hasN(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
    out.nativeInEnviron = hasN(readFileSync(`/proc/${pid}/environ`, 'utf8'));
    out.nativeInCoreLog = hasN(readFileSync(join(home, 'core.log'), 'utf8'));
    out.nativeInBootstrap = JSON.stringify(b).includes(N ?? 'x');
    const nfiles = [];
    const walkN = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkN(p); else if (hasN(readFileSync(p, 'utf8'))) nfiles.push(p); } };
    walkN(home);
    out.nativeFiles = nfiles;
  }
  if (scenario === 'bsv') {
    out.ensure = await __t.ensureCore();
    __t.createWindow(false);
    const b = bootstrap();
    const base = b.baseUrl;
    const A = { 'X-Legion-Admin': b.admin, 'Content-Type': 'application/json' };
    const call = async (method, path, body, headers = A) => { const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const policy = async () => (await call('GET', '/api/bsv/policy')).json;
    const ipc = (raw, over = {}) => globalThis.__handle['legion:bsv-policy']({ sender: __t.win.webContents, senderFrame: { url: __t.uiUrl }, ...over }, raw);
    const dialogs = () => globalThis.__dialogs.filter((d) => d.defaultId === 0 && d.buttons?.length === 2);
    out.bootstrapKeys = Object.keys(b).sort();
    out.bsvOn = (await call('POST', '/api/bsv', { enabled: true })).status;
    out.p0 = (({ armed, frozen, nativeAvailable, spendTools }) => ({ armed, frozen, nativeAvailable, spendTools }))(await policy());
    // the window's own secret is not enough, with no native header or a guessed one
    out.armAdminOnly = (await call('POST', '/api/bsv/policy/arm', { minutes: 5 })).status;
    out.armGuessedNative = (await call('POST', '/api/bsv/policy/arm', { minutes: 5 }, { ...A, 'X-Legion-Native': 'f'.repeat(64) })).status;
    out.armAdminAsNative = (await call('POST', '/api/bsv/policy/arm', { minutes: 5 }, { ...A, 'X-Legion-Native': b.admin })).status;
    out.armTokenOnly = (await call('POST', '/api/bsv/policy/arm', { minutes: 5 }, { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' })).status;
    out.stillDisarmed = (await policy()).armed === false;
    // 1. the person cancels: nothing changes, the dialog was worded by main, Cancel is the default
    globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 0;
    out.cancelled = await ipc({ kind: 'arm', minutes: 5 });
    out.cancelDialog = dialogs().map((d) => ({ title: d.title, message: d.message, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId, type: d.type, detail: d.detail }));
    out.armedAfterCancel = (await policy()).armed;
    // 2. the person confirms
    globalThis.__dialogAnswer = 1; globalThis.__dialogs.length = 0; globalThis.__sent.length = 0;
    out.confirmed = await ipc({ kind: 'arm', minutes: 5 });
    out.armedAfterConfirm = (await policy()).armed;
    out.sentChanged = globalThis.__sent.includes('legion:bsv-changed');
    // 3. a window that sends something odd, or is not our window, gets no dialog at all
    globalThis.__dialogs.length = 0;
    out.badKind = await ipc({ kind: 'arm', minutes: 7 });
    out.badExtra = await ipc({ kind: 'freeze', reason: 'x'.repeat(10) });
    out.badProto = await ipc(JSON.parse('{"kind":"caps","caps":{"__proto__":{"perTxSats":1},"perTxSats":1}}'));
    out.badString = await ipc('arm');
    out.wrongSender = await ipc({ kind: 'arm', minutes: 5 }, { sender: {} });
    out.wrongFrame = await ipc({ kind: 'arm', minutes: 5 }, { senderFrame: { url: 'https://evil.example/' } });
    out.noFrame = await ipc({ kind: 'arm', minutes: 5 }, { senderFrame: undefined });
    out.dialogsForBad = globalThis.__dialogs.length;
    // 4. freeze is one click and needs no dialog; it disarms; unfreeze asks, and asks again if cancelled
    globalThis.__dialogs.length = 0;
    out.froze = await ipc({ kind: 'freeze' });
    const pf = await policy();
    out.afterFreeze = { frozen: !!pf.frozen, armed: pf.armed };
    out.dialogsForFreeze = globalThis.__dialogs.length;
    globalThis.__dialogAnswer = 0;
    out.unfreezeCancelled = await ipc({ kind: 'unfreeze' });
    out.stillFrozen = !!(await policy()).frozen;
    out.armWhileFrozen = (await (async () => { globalThis.__dialogAnswer = 1; return ipc({ kind: 'arm', minutes: 5 }); })());
    out.armedWhileFrozen = (await policy()).armed;
    out.unfreezeDialog = dialogs().map((d) => d.message);
    out.dialogsBeforeUnfreeze = globalThis.__dialogs.length;
    out.unfreezeOk = await ipc({ kind: 'unfreeze' });
    out.afterUnfreeze = { frozen: !!(await policy()).frozen, armed: (await policy()).armed };
    // 5. caps: the dialog quotes the change, a value above the hard ceiling is refused by the core
    globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 1;
    out.capsOk = await ipc({ kind: 'caps', caps: { perTxSats: 500 } });
    out.capsAfter = (await policy()).caps.perTxSats;
    out.capsDialogDetail = dialogs().map((d) => d.detail)[0] ?? null;
    out.capsTooBig = await ipc({ kind: 'caps', caps: { perTxSats: 999_999_999 } });
    out.capsAfterTooBig = (await policy()).caps.perTxSats;
    // 6. dialogs do not stack
    globalThis.__dialogs.length = 0; globalThis.__dialogDelay = 400;
    const first = ipc({ kind: 'arm', minutes: 15 });
    await wait(80);
    out.second = await ipc({ kind: 'arm', minutes: 5 });
    out.firstDone = await first;
    out.dialogsStacked = globalThis.__dialogs.length;
    globalThis.__dialogDelay = 0;
    // 7. the audit log recorded all of it
    const a = (await call('GET', '/api/bsv/audit?limit=50')).json;
    out.auditDecisions = a.entries.map((e) => `${e.tool}:${e.decision}`);
    out.auditOk = (await policy()).audit.ok;
  }
} catch (e) { out.error = String(e?.stack ?? e); }
await cleanup();
rmSync(home, { recursive: true, force: true });
console.log('EMU_RESULT ' + JSON.stringify(out));
process.exit(0);
