/**
 * Token fix v1, the Electron side. Electron itself cannot run here, so the decisions main.ts makes are pure functions in
 * src/electron/admin-logic.ts and are tested in plain node. NOT covered: the real BrowserWindow / spawn / dialog / taskkill path on Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminForRenderer, coreAction, coreIsBusy, stoppablePid } from '../src/electron/admin-logic.js';

const SECRET = 'a'.repeat(48);

test('bootstrap: the renderer gets the secret only when /health shows OUR child (pid match) holding a secret', () => {
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: true }, 4242, SECRET), SECRET);
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: false }, 4242, SECRET), undefined, 'ours but no secret');
  assert.equal(adminForRenderer({ ok: true, pid: 999, admin: true }, 4242, SECRET), undefined, 'a foreign core never gets it, even if it claims admin');
  assert.equal(adminForRenderer({ ok: true, admin: true }, 4242, SECRET), undefined, 'no pid in /health');
  assert.equal(adminForRenderer(null, 4242, SECRET), undefined, 'nothing answers');
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: true }, undefined, SECRET), undefined, 'we spawned nothing');
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: true }, 4242, undefined), undefined, 'we hold no secret');
  assert.equal(adminForRenderer({ ok: true, pid: 4242, admin: 'true' as unknown as boolean }, 4242, SECRET), undefined, 'strictly boolean true');
});

test('foreign core: spawn / use / replace when idle / ask when busy / blocked without a usable pid', () => {
  const self = 100;
  assert.equal(coreAction({ health: null, ourPid: undefined, busy: false, selfPid: self }), 'spawn');
  assert.equal(coreAction({ health: { pid: 4242, admin: true }, ourPid: 4242, busy: false, selfPid: self }), 'use');
  // started by the MCP bridge or a terminal: no admin
  assert.equal(coreAction({ health: { pid: 555, admin: false }, ourPid: undefined, busy: false, selfPid: self }), 'replace');
  assert.equal(coreAction({ health: { pid: 555, admin: false }, ourPid: undefined, busy: true, selfPid: self }), 'ask');
  // a core from before this release has no admin field at all
  assert.equal(coreAction({ health: { pid: 555 }, ourPid: undefined, busy: false, selfPid: self }), 'replace');
  // claims admin but is not our child: still foreign
  assert.equal(coreAction({ health: { pid: 555, admin: true }, ourPid: 4242, busy: false, selfPid: self }), 'replace');
  assert.equal(coreAction({ health: { pid: 555, admin: true }, ourPid: 4242, busy: true, selfPid: self }), 'ask');
  // ours by pid but without a secret: treated as foreign (cannot happen unless the secret was lost)
  assert.equal(coreAction({ health: { pid: 4242, admin: false }, ourPid: 4242, busy: false, selfPid: self }), 'replace');
  // never kill what cannot be identified, or Electron main itself
  assert.equal(coreAction({ health: { admin: false }, ourPid: undefined, busy: false, selfPid: self }), 'blocked');
  assert.equal(coreAction({ health: { pid: self, admin: false }, ourPid: undefined, busy: false, selfPid: self }), 'blocked');
  assert.equal(coreAction({ health: { pid: 1, admin: false }, ourPid: undefined, busy: false, selfPid: self }), 'blocked');
  assert.equal(coreAction({ health: { pid: -5, admin: false }, ourPid: undefined, busy: false, selfPid: self }), 'blocked');
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
  assert.match(main, /randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(main, /stdio: \['pipe', out, out\]/);
  assert.match(main, /child\.stdin\?\.end\(secret \+ '\\n'\)/);
  assert.match(main, /LEGION_ADMIN_STDIN: '1'/);
  assert.ok(!/env: \{[^}]*secret/.test(main), 'the secret is not put in the child environment');
  assert.match(main, /spawn\(nodeBin, \[coreEntry\]/, 'argv is the entry file only');
  assert.match(main, /admin: rendererAdmin \?\? ''/);
  assert.match(main, /adminForRenderer\(await getHealth\(readConfig\(\)\.port\), coreProc\?\.pid, adminSecret\)/);
  assert.match(main, /win\?\.webContents\.reload\(\)/, 'a tray restart reloads the window, which re-runs the preload and picks up the rotated secret');
  assert.match(preload, /admin: boot\.admin/);
});

test('wiring (source guard): the UI sends X-Legion-Admin on every request through one helper; the event stream keeps ?token=', () => {
  assert.match(api, /'X-Legion-Admin': adminKey/);
  assert.match(api, /headers: authHeaders\(/);
  assert.match(api, /api\/events\?token=/);
  assert.equal((api.match(/fetch\(/g) ?? []).length, 1, 'one fetch choke point in api.ts');
  assert.match(api, /Open the Legion app to approve or change settings/);
});
