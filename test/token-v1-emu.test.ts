/**
 * The Electron main process, emulated (N6): the real compiled dist/src/electron/main.js with `electron` stubbed, driving a REAL spawned core.
 * Scenarios live in test/electron-emu/run.mjs (ported from the round-2 reviewer's e1/e2/e3 proofs); each runs in its own node process.
 * Not covered: real Electron windows/IPC, and Windows itself (taskkill, netstat output on a real machine).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const skip = process.platform === 'win32' ? 'POSIX emulation (uses /proc, sh, sleep)' : false;
const haveListenerTool = (() => { for (const t of ['lsof', 'ss']) { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return true; } catch { /* next */ } } return false; })();

const runScenario = (name: string): Promise<any> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', './test/electron-emu/register.mjs', 'test/electron-emu/run.mjs', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`scenario ${name} timed out\n${out}\n${err}`)); }, 90_000);
  child.on('exit', () => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('EMU_RESULT '));
    if (!line) return reject(new Error(`scenario ${name}: no result\n${out}\n${err}`));
    const r = JSON.parse(line.slice('EMU_RESULT '.length));
    if (r.error) return reject(new Error(`scenario ${name}: ${r.error}`));
    resolve(r);
  });
});

const memo = new Map<string, Promise<any>>();
/** The read-only scenarios run once and are shared by the tests that look at them. */
const scenario = (name: string): Promise<any> => { if (!memo.has(name)) memo.set(name, runScenario(name)); return memo.get(name)!; };

test('emu preflight: the compiled main and core exist', { skip }, () => {
  assert.ok(existsSync('dist/src/electron/main.js'));
  assert.ok(existsSync('dist/src/bin/legion-core.js'));
});

test('emu: main starts its own core, hands the renderer a 64-char admin secret that opens admin routes (a token alone gets 403), and restart rotates it', { skip }, async () => {
  const r = await scenario('basic');
  assert.equal(r.ensure, null);
  assert.equal(r.adminLen, 64);
  assert.equal(r.adminApprovals, 200);
  assert.equal(r.tokenOnlyApprovals, 403);
  assert.equal(r.restart.oldDead, true);
  assert.equal(r.restart.rotated, true);
  assert.equal(r.restart.adminLen, 64);
  assert.ok(r.restart.newPid);
  assert.equal(r.restart.dialogs, 0);
});

test('emu F2: editing config.json (port and token) after launch does not move the window or leak the secret to the new port', { skip }, async () => {
  const r = await scenario('basic');
  assert.equal(r.afterEditBase, r.baseUrl, 'the pinned port is kept');
  assert.equal(r.afterEditTokenEvil, false, 'the edited token is not used');
  assert.equal(r.rogueGotAdminHeader, 0);
  assert.equal(r.rogueRequests, 0, 'the listener the config pointed at was never contacted');
});

test('emu N5: a squatter that copies /health (a victim pid, admin:true, a fake proof) is not obeyed: the victim lives, the secret is withheld, the person is told', { skip }, async () => {
  const r = await scenario('squat');
  assert.equal(r.victimAlive, true, 'the pid the squatter named still runs');
  assert.equal(r.rogueGotAdminHeader, 0);
  assert.equal(r.bootstrapAdminLen, 0, 'no secret for a core that did not prove itself');
  assert.deepEqual(r.dialogs, ['Legion Core was started outside this app.']);
});

test('emu N5: an idle foreign core whose pid really owns the listener is replaced by our own', { skip: skip || (haveListenerTool ? false : 'neither lsof nor ss is installed') }, async () => {
  const r = await scenario('foreign');
  assert.equal(r.foreignUp, true);
  assert.equal(r.ensure, null);
  assert.equal(r.foreignDead, true);
  assert.equal(r.adminLen, 64);
  assert.ok(r.ownCore && r.ownCore !== r.foreignPid);
});

test('emu N3: killing the core through a non-exec shim leaves no orphan listening', { skip }, async () => {
  const r = await scenario('shim');
  assert.equal(r.ensure, null);
  assert.equal(r.distinct, true, 'the core is a grandchild of the process main spawned');
  assert.equal(r.coreAlive, false);
  assert.equal(r.coreStillAnswers, false);
});

test('emu E3: the admin secret is in no argv, environment, core.log or file under the data directory', { skip }, async () => {
  const r = await scenario('hygiene');
  assert.equal(r.bootstrapIsSecret, true);
  assert.equal(r.inCmdline, false);
  assert.equal(r.inEnviron, false);
  assert.equal(r.inCoreLog, false);
  assert.deepEqual(r.filesWithSecret, []);
});
