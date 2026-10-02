/**
 * Token fix v1, the Electron side. Electron itself cannot run here, so the decisions main.ts makes are pure functions in
 * src/electron/admin-logic.ts and are tested in plain node. NOT covered: the real BrowserWindow / spawn / dialog / taskkill path on Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { healthProof } from '../src/core/admin.js';
import { adminForRenderer, coreAction, coreIsBusy, proofValid, stoppablePid } from '../src/electron/admin-logic.js';

const SECRET = 'a'.repeat(48);
const NONCE = 'b0'.repeat(16);

test('bootstrap: the renderer gets the secret only when the core on the port answers HMAC(secret, our fresh nonce); pid and admin:true prove nothing', () => {
  const good = { ok: true, pid: 4242, admin: true, proof: healthProof(SECRET, NONCE) };
  assert.equal(adminForRenderer(good, SECRET, NONCE), SECRET);
  // a node shim / Volta / scoop wrapper: the pid we spawned is not the pid of the node process that answers. It must still succeed.
  assert.equal(adminForRenderer({ ...good, pid: 77777 }, SECRET, NONCE), SECRET, 'pid mismatch with a valid proof succeeds');
  assert.equal(adminForRenderer({ ...good, pid: undefined }, SECRET, NONCE), SECRET, 'pid is not consulted at all');
  // a rogue that echoes our child's public pid and claims admin, but cannot compute the HMAC
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: true }, SECRET, NONCE), undefined, 'no proof');
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: true, proof: 'f'.repeat(64) }, SECRET, NONCE), undefined, 'wrong proof');
  assert.equal(adminForRenderer({ ...good, proof: healthProof('b'.repeat(48), NONCE) }, SECRET, NONCE), undefined, 'proof under another secret');
  assert.equal(adminForRenderer({ ...good, proof: healthProof(SECRET, 'cd'.repeat(16)) }, SECRET, NONCE), undefined, 'a replayed proof for another nonce');
  assert.equal(adminForRenderer({ ...good, admin: false }, SECRET, NONCE), undefined);
  assert.equal(adminForRenderer({ ...good, admin: 'true' as unknown as boolean }, SECRET, NONCE), undefined);
  assert.equal(adminForRenderer({ ...good, proof: good.proof.slice(0, 40) }, SECRET, NONCE), undefined, 'truncated');
  assert.equal(adminForRenderer(null, SECRET, NONCE), undefined, 'nothing answers');
  assert.equal(adminForRenderer(good, undefined, NONCE), undefined, 'we hold no secret');
  assert.equal(adminForRenderer(good, SECRET, 'zz'), undefined, 'a bad nonce is never accepted');
  assert.equal(proofValid(good, SECRET, NONCE), true);
});

test('foreign core: spawn / use / replace when idle / ask when busy / blocked without a usable pid', () => {
  const self = 100;
  // the pid a foreign core claims owns the listener (N5 is tested in token-v1-fix2.test.ts); here it always does
  const c = (health: object | null, ownProof: boolean, busy: boolean) => coreAction({ health, ownProof, busy, selfPid: self, listeners: [(health as { pid?: number } | null)?.pid ?? 0] });
  assert.equal(c(null, false, false), 'spawn');
  assert.equal(c({ pid: 4242, admin: true }, true, false), 'use');
  assert.equal(c({ pid: 555, admin: true }, true, false), 'use', 'a shim: our core, whatever pid it reports');
  // started by the MCP bridge or a terminal: no admin
  assert.equal(c({ pid: 555, admin: false }, false, false), 'replace');
  assert.equal(c({ pid: 555, admin: false }, false, true), 'ask');
  // a core from before this release has no admin field at all
  assert.equal(c({ pid: 555 }, false, false), 'replace');
  // claims admin and our pid but cannot prove it: foreign
  assert.equal(c({ pid: 4242, admin: true }, false, false), 'replace');
  assert.equal(c({ pid: 4242, admin: true }, false, true), 'ask');
  // never kill what cannot be identified, or Electron main itself
  assert.equal(c({ admin: false }, false, false), 'blocked');
  assert.equal(c({ pid: self, admin: false }, false, false), 'blocked');
  assert.equal(c({ pid: 1, admin: false }, false, false), 'blocked');
  assert.equal(c({ pid: -5, admin: false }, false, false), 'blocked');
  assert.equal(stoppablePid(555, self), true);
  assert.equal(stoppablePid('555', self), false);
  assert.equal(stoppablePid(1.5, self), false);
});

test('busy detection: running or queued tasks and pending approvals; anything unreadable counts as busy', () => {
  assert.equal(coreIsBusy({ tasks: [], approvals: [] }), false);
  assert.equal(coreIsBusy({ tasks: [{ status: 'done' }, { status: 'error' }, { status: 'cancelled' }], approvals: [] }), false);
  assert.equal(coreIsBusy({ tasks: [{ status: 'running' }], approvals: [] }), true);
  assert.equal(coreIsBusy({ tasks: [{ status: 'queued' }], approvals: [] }), true);
  assert.equal(coreIsBusy({ tasks: [], approvals: [{ id: 'a' }] }), true);
  assert.equal(coreIsBusy(undefined), true);
  assert.equal(coreIsBusy({}), true);
  assert.equal(coreIsBusy({ tasks: 'x', approvals: [] }), true);
});

// Source-level guards for what cannot run here (main.ts imports electron). They only pin the wiring, they prove nothing about behaviour.
const main = readFileSync(new URL('../../src/electron/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../ui/src/api.ts', import.meta.url), 'utf8');

test('wiring (source guard): secret generated per core spawn, written to the stdin pipe only, bootstrap uses the verified value', () => {
  assert.match(main, /randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(main, /stdio: \['pipe', out, out\]/);
  assert.match(main, /child\.stdin\?\.end\(secret \+ '\\n' \+ native \+ '\\n'\)/, 'admin secret line, then the native secret line (BSV policy), both over stdin only');
  assert.match(main, /LEGION_ADMIN_STDIN: '1'/);
  assert.ok(!/env: \{[^}]*secret/.test(main), 'the secret is not put in the child environment');
  assert.match(main, /spawn\(nodeBin, \[coreEntry\]/, 'argv is the entry file only');
  assert.match(main, /admin: live \? rendererAdmin \?\? '' : ''/);
  // F2: the port and token are pinned when the core is started or adopted; config.json is not re-read for them afterwards
  assert.match(main, /LEGION_PORT: String\(port\)/, 'the child is told the port main chose');
  assert.match(main, /const \{ port, token \} = pinned \?\? readConfig\(\);/);
  const boot = main.split("ipcMain.on('legion:bootstrap'")[1]!.split('});')[0]!;
  assert.ok(!/readConfig\(\)\.(port|token)/.test(boot), 'bootstrap never reads config.json directly');
  // F9: restart waits for the child's exit event
  const kill = main.split('async function killCore')[1]!.split('\n}\n')[0]!;
  assert.match(kill, /once\('exit'/);
  const restart = main.split('async function restartCore')[1]!.split('\n}\n')[0]!;
  assert.ok(!/sleep\(500\)/.test(restart) && /await killCore\(\)/.test(restart));
  assert.match(main, /adminForRenderer\(await getHealth\(port, 1500, nonce\), adminSecret, nonce\)/, 'the secret is released only after the HMAC challenge');
  assert.ok(!/health\.pid === coreProc/.test(main) && !/coreProc\?\.pid, adminSecret/.test(main), 'no pid-equality check left');
  assert.match(main, /win\?\.webContents\.reload\(\)/, 'a tray restart reloads the window, which re-runs the preload and picks up the rotated secret');
  assert.match(preload, /admin: boot\.admin/);
});

test('wiring (source guard): the UI sends X-Legion-Admin on every request through one helper; the app reads the event stream with fetch and the admin header, a browser tab falls back to ?token=', () => {
  assert.match(api, /'X-Legion-Admin': adminKey/);
  assert.match(api, /headers: authHeaders\(/);
  assert.match(api, /api\/events\?token=/);
  assert.equal((api.match(/fetch\(/g) ?? []).length, 2, 'request() and the admin event stream are the only fetches in api.ts');
  assert.match(api, /fetch\(`\$\{base\}\/api\/events`, \{ headers: authHeaders\(\)/);
  assert.match(api, /Open the Legion app to approve or change settings/);
});
