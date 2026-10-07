// Electron main process, emulated: the REAL compiled dist/src/electron/main.js with `electron` stubbed (register.mjs), driving a REAL spawned core.
// Run: node --import ./test/electron-emu/register.mjs test/electron-emu/run.mjs <scenario>   (the suite does this; one JSON line comes back on stdout)
// Ported from the round-2 reviewer's e1/e2/e3 proofs. Not run: real Electron, real Windows (taskkill, netstat parsing on real output).
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

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
writeFileSync(emu, src + '\nexport const __t = { ensureCore, killCore, restartCore, getHealth, createWindow, uiUrl, get win() { return win; }, get coreProc() { return coreProc; }, get adminSecret() { return adminSecret; }, get nativeSecret() { return nativeSecret; }, setPinnedPort(p) { pinned = { port: p, token: "" }; }, spendTick: () => spendNative.tick(), spendIdle: () => spendNative.idle() };\n');
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
// A process's argv and environment as text. Linux has /proc. macOS has no /proc; `ps -E` prints the environment after the
// command line (allowed for a process of the same user), so there the environ check is a superset of the argv check.
// A ps that printed no environment would make "the secret is not in it" pass for the wrong reason, so the environ text must show
// LEGION_HOME, which the core always gets.
const procText = (pid, what) => {
  if (process.platform !== 'darwin') return readFileSync(`/proc/${pid}/${what}`, 'utf8');
  const text = execFileSync('ps', [what === 'environ' ? '-wwE' : '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (what === 'environ' && !text.includes(`LEGION_HOME=${home}`)) throw new Error(`ps -E did not show the environment of ${pid}`);
  return text;
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
    out.inCmdline = has(procText(pid, 'cmdline'));
    out.inEnviron = has(procText(pid, 'environ'));
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
    out.nativeInCmdline = hasN(procText(pid, 'cmdline'));
    out.nativeInEnviron = hasN(procText(pid, 'environ'));
    out.nativeInCoreLog = hasN(readFileSync(join(home, 'core.log'), 'utf8'));
    out.nativeInBootstrap = JSON.stringify(b).includes(N ?? 'x');
    const nfiles = [];
    // The core writes atomically (x.tmp, then rename), so a file or folder can vanish between readdir and read: skip ENOENT only.
    const gone = (e) => e && e.code === 'ENOENT';
    const walkN = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch (e) { if (gone(e)) return; throw e; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walkN(p); else { let text; try { text = readFileSync(p, 'utf8'); } catch (err) { if (gone(err)) continue; throw err; } if (hasN(text)) nfiles.push(p); } } };
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
    // 0. mainnet is OFF by default: arming is refused by main before any dialog; enabling is a native dialog (Cancel leaves it off)
    out.mainnetDefault = (await policy()).mainnetEnabled;
    globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 1;
    out.armWhileOff = await ipc({ kind: 'arm', minutes: 5 });
    out.dialogsArmWhileOff = globalThis.__dialogs.length;
    globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 0;
    out.enableCancelled = await ipc({ kind: 'mainnet-enable' });
    out.enableDialog = dialogs().map((d) => ({ title: d.title, message: d.message, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId, type: d.type, detail: d.detail }));
    out.mainnetAfterCancel = (await policy()).mainnetEnabled;
    out.enableAdminOnly = (await call('POST', '/api/bsv/policy/mainnet', { enabled: true })).status;
    out.enableToken = (await call('POST', '/api/bsv/policy/mainnet', { enabled: true }, { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' })).status;
    out.mainnetAfterNoNative = (await policy()).mainnetEnabled;
    globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 1;
    out.enableOk = await ipc({ kind: 'mainnet-enable' });
    out.routeMissing = !out.enableOk.ok && /Not found/.test(String(out.enableOk.error)); // T2 registers mainnet-routes in index.ts; until that merges the core has no such route
    out.mainnetAfterConfirm = (await policy()).mainnetEnabled;
    out.armedAfterEnable = (await policy()).armed;
    // 1. the person cancels the arm: nothing changes, the dialog was worded by main, Cancel is the default
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
    // 5b. a mainnet limits change must land on the main network: main compares what the core reports with what the owner confirmed
    globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 1;
    out.capsMain = await ipc({ kind: 'caps', net: 'main', caps: { perTxSats: 400 } });
    const pm = await policy();
    out.capsMainDialog = dialogs().map((d) => d.title)[0] ?? null;
    out.capsMainAfter = pm.nets?.main?.caps?.perTxSats ?? null;
    out.capsTestAfterMain = pm.nets?.test?.caps?.perTxSats ?? pm.caps.perTxSats;
    // 6. dialogs do not stack
    globalThis.__dialogs.length = 0; globalThis.__dialogDelay = 400;
    const first = ipc({ kind: 'arm', minutes: 15 });
    await wait(80);
    out.second = await ipc({ kind: 'arm', minutes: 5 });
    out.firstDone = await first;
    out.dialogsStacked = globalThis.__dialogs.length;
    globalThis.__dialogDelay = 0;
    // 6b. switching mainnet off needs no dialog and disarms
    globalThis.__dialogs.length = 0;
    out.disableOk = await ipc({ kind: 'mainnet-disable' });
    out.dialogsForDisable = globalThis.__dialogs.length;
    const pd = await policy();
    out.afterDisable = { mainnet: pd.mainnetEnabled, armed: pd.armed };
    // 7. the audit log recorded all of it
    const a = (await call('GET', '/api/bsv/audit?limit=50')).json;
    out.auditDecisions = a.entries.map((e) => `${e.tool}:${e.decision}`);
    out.auditOk = (await policy()).audit.ok;
  }

  if (scenario === 'spend') {
    // REAL main (stubbed electron) and a real core that proves the secrets; the spend routes are played by a FAKE core on its own port,
    // because the real spend service is another task's. The fake checks the admin and native headers exactly as the real core would.
    out.ensure = await __t.ensureCore();
    __t.createWindow(false);
    const ADMIN = __t.adminSecret; const NATIVE = __t.nativeSecret;
    const ID = (c) => c.repeat(40); const PAY = 'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q'; // fixed test-network address (no key behind it), see test/bsv-net-helpers.ts
    const mk = (id, over = {}) => ({ requestId: ID(id), network: 'test', networkLabel: 'TESTNET', agentId: 'assayer', taskId: 't', purpose: 'p', outputs: [{ index: 0, recipient: PAY, sats: 600, kind: 'payment', allowlisted: true }], fee: { sats: 12 }, totalSpendSats: 612, remaining: { perTxSats: 388, perSessionSats: 4388, per24hSats: 9388 }, warnings: [], requiredConfirmations: ['approve'], createdAt: 1, expiresAt: 2, hash: '1'.repeat(64), ...over });
    const fake = { facts: {}, on: true, cards: [], unknown: [], log: [] };
    const srv = await new Promise((res) => {
      const s = http.createServer((q, r) => {
        let body = ''; q.on('data', (d) => { body += d; });
        q.on('end', () => {
          const u = new URL(q.url, 'http://x'); const hdr = { admin: q.headers['x-legion-admin'] ?? null, native: q.headers['x-legion-native'] ?? null };
          fake.log.push({ method: q.method, path: u.pathname, body: body ? JSON.parse(body) : undefined, ...hdr });
          r.setHeader('content-type', 'application/json');
          const send = (st, j) => { r.statusCode = st; r.end(JSON.stringify(j)); };
          if (hdr.admin !== ADMIN) return send(403, { error: 'admin_required' });
          if (u.pathname === '/api/bsv') return send(200, { enabled: fake.on });
          if (u.pathname === '/api/bsv/policy') return send(200, { caps: { perTxSats: 1000, perSessionSats: 5000, per24hSats: 10000 }, nativeAvailable: true, ...fake.facts });
          if (u.pathname === '/api/bsv/spend/pending') return send(200, { cards: fake.cards, unknown: fake.unknown });
          if (q.method === 'POST' && /^\/api\/bsv\/spend\/[0-9a-f]{40}\/(decision|resolve)$/.test(u.pathname)) {
            if (hdr.native !== NATIVE) return send(403, { error: 'native_required' });
            const id = u.pathname.split('/')[4]; fake.cards = fake.cards.filter((c) => c.requestId !== id); fake.unknown = fake.unknown.filter((c) => c.requestId !== id);
            return send(200, { ok: true });
          }
          send(404, {});
        });
      });
      s.listen(0, '127.0.0.1', () => { servers.push(s); res(s); });
    });
    __t.setPinnedPort(srv.address().port);
    const ipc = (raw, over = {}) => globalThis.__handle['legion:bsv-policy']({ sender: __t.win.webContents, senderFrame: { url: __t.uiUrl }, ...over }, raw);
    const posts = () => fake.log.filter((l) => l.method === 'POST');
    const reset = () => { fake.log.length = 0; globalThis.__dialogs.length = 0; globalThis.__dialogAnswers = []; globalThis.__dialogThrow = false; globalThis.__dialogAnswer = 0; globalThis.__dialogDelay = 0; };
    // 1. Cancel
    fake.cards = [mk('a')]; reset(); globalThis.__dialogAnswers = [0];
    out.cancel = await ipc({ kind: 'spend-review', requestId: ID('a') });
    out.cancelDialog = globalThis.__dialogs.map((d) => ({ title: d.title, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId, type: d.type, detail: d.detail }));
    out.cancelPosts = posts().map((l) => ({ path: l.path.replace(ID('a'), 'ID'), body: l.body, adminOk: l.admin === ADMIN, nativeOk: l.native === NATIVE }));
    // 2. the window's own admin secret is never enough for the decision route (the fake plays the real core's rule): the window has no native secret
    const win403 = await fetch(`http://127.0.0.1:${srv.address().port}/api/bsv/spend/${ID('a')}/decision`, { method: 'POST', headers: { 'X-Legion-Admin': ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', cardHash: '1'.repeat(64), confirmations: ['approve'] }) });
    out.windowDirectDecision = win403.status;
    // 3. closed window (the dialog throws): deny, never approve
    fake.cards = [mk('b')]; reset(); globalThis.__dialogThrow = true;
    out.closed = await ipc({ kind: 'spend-review', requestId: ID('b') });
    out.closedBodies = posts().map((l) => l.body);
    // 4. approve: the hash is the one the core served
    fake.cards = [mk('c', { hash: '7'.repeat(64) })]; reset(); globalThis.__dialogAnswers = [1];
    out.approve = await ipc({ kind: 'spend-review', requestId: ID('c') });
    out.approveBodies = posts().map((l) => l.body);
    // 5. untrusted: two dialogs
    fake.cards = [mk('d', { requiredConfirmations: ['approve', 'untrusted-content'], hash: '8'.repeat(64) })]; reset(); globalThis.__dialogAnswers = [1, 1];
    out.untrusted = await ipc({ kind: 'spend-review', requestId: ID('d') });
    out.untrustedDialogs = globalThis.__dialogs.length; out.untrustedBodies = posts().map((l) => l.body);
    // 6. forged: extra keys, a card from the window, an id the core does not list, another sender or frame
    fake.cards = [mk('e')]; reset();
    out.forgedExtra = await ipc({ kind: 'spend-review', requestId: ID('e'), card: mk('e', { hash: '9'.repeat(64) }), cardHash: '9'.repeat(64) });
    out.forgedUnlisted = await ipc({ kind: 'spend-review', requestId: ID('f') });
    out.foreignFrame = await ipc({ kind: 'spend-review', requestId: ID('e') }, { senderFrame: { url: 'https://evil.example/' } });
    out.foreignSender = await ipc({ kind: 'spend-review', requestId: ID('e') }, { sender: {} });
    out.noFrame = await ipc({ kind: 'spend-deny', requestId: ID('e') }, { senderFrame: undefined });
    out.forgedDialogs = globalThis.__dialogs.length; out.forgedPosts = posts().length;
    // 7. a main-network card: refused, denied, no dialog
    const MAINPAY = '12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH';
    const mm = (id, over = {}) => mk(id, { network: 'main', networkLabel: 'LIVE FUNDS (main network)', outputs: [{ index: 0, recipient: MAINPAY, sats: 600, kind: 'payment', allowlisted: true }], requiredConfirmations: ['approve', 'live-funds'], ...over });
    fake.cards = [mm('9')]; reset(); globalThis.__dialogAnswers = [1, 1];
    out.mainnet = await ipc({ kind: 'spend-review', requestId: ID('9') });
    out.mainnetDialogs = globalThis.__dialogs.length; out.mainnetBodies = posts().map((l) => l.body);
    // a forged network label, and a main card the facts do allow
    fake.cards = [mk('9', { network: 'main' })]; fake.facts = { mainnetEnabled: true, armed: true }; reset(); globalThis.__dialogAnswers = [1, 1];
    out.forgedNet = await ipc({ kind: 'spend-review', requestId: ID('9') });
    out.forgedNetDialogs = globalThis.__dialogs.length;
    fake.cards = [mm('9', { hash: '6'.repeat(64) })]; reset(); globalThis.__dialogAnswers = [1, 0]; // D1 yes (button 1), D2 yes (button 0: the position differs)
    out.mainAllowed = await ipc({ kind: 'spend-review', requestId: ID('9') });
    out.mainAllowedDialog = globalThis.__dialogs.map((d) => ({ title: d.title, message: d.message, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId })); out.mainAllowedBodies = posts().map((l) => l.body);
    // D2 answered with D1's yes position (button 1 = Cancel there): denied
    fake.cards = [mm('8', { hash: '5'.repeat(64) })]; reset(); globalThis.__dialogAnswers = [1, 1];
    out.mainD2Habit = await ipc({ kind: 'spend-review', requestId: ID('8') });
    out.mainD2HabitBodies = posts().map((l) => l.body);
    // the Escape answer of Electron is cancelId: for D2 that is 1, for D1 it is 0; a tainted main card shows three dialogs
    fake.cards = [mm('7', { hash: '4'.repeat(64), requiredConfirmations: ['approve', 'live-funds', 'untrusted-content'] })]; reset(); globalThis.__dialogAnswers = [1, 0, 1];
    out.mainTainted = await ipc({ kind: 'spend-review', requestId: ID('7') });
    out.mainTaintedTitles = globalThis.__dialogs.map((d) => d.title); out.mainTaintedBodies = posts().map((l) => l.body);
    fake.facts = {};
    // 8. deny is dialog-free; resolve is native
    fake.cards = [mk('5')]; fake.unknown = [{ requestId: ID('6'), totalSats: 321, agentId: 'assayer', net: 'test' }]; reset();
    out.deny = await ipc({ kind: 'spend-deny', requestId: ID('5') }); out.denyDialogs = globalThis.__dialogs.length;
    globalThis.__dialogAnswers = [2];
    out.resolve = await ipc({ kind: 'spend-resolve', requestId: ID('6') });
    out.resolveDialog = globalThis.__dialogs.map((d) => ({ message: d.message, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId }));
    out.resolveBodies = posts().filter((l) => /resolve$/.test(l.path)).map((l) => l.body);
    // 9. the poll: nothing is asked while BSV is off; on, cards are shown one at a time, oldest first
    fake.cards = [mk('2', { createdAt: 20 }), mk('1', { createdAt: 10 })]; fake.on = false; reset(); globalThis.__dialogDelay = 150;
    await __t.spendTick(); await __t.spendTick();
    out.offPendingReads = fake.log.filter((l) => l.path === '/api/bsv/spend/pending').length; out.offDialogs = globalThis.__dialogs.length;
    fake.on = true;
    await __t.spendTick(); await wait(40); await __t.spendTick();
    await __t.spendIdle();
    out.onDialogs = globalThis.__dialogs.length;
    out.onOrder = posts().filter((l) => /decision$/.test(l.path)).map((l) => l.path.split('/')[4][0]);
    // 10. a second confirmation (an arm dialog) cannot open while a spend dialog is open
    fake.cards = [mk('3')]; fake.on = true; reset(); globalThis.__dialogDelay = 300; globalThis.__dialogAnswers = [0];
    await __t.spendTick(); await wait(60);
    out.armWhileSpend = await ipc({ kind: 'unfreeze' });
    await __t.spendIdle();
  }
} catch (e) { out.error = String(e?.stack ?? e); }
await cleanup();
rmSync(home, { recursive: true, force: true });
console.log('EMU_RESULT ' + JSON.stringify(out));
process.exit(0);
