/**
 * BSV arming and freezing, end to end up to policy state: the real compiled Electron main.js (electron stubbed) driving a REAL spawned core.
 * The scenario lives in test/electron-emu/run.mjs ('bsv' and 'hygiene'). The core here is real; the spend routes are covered with a fake core in bsv-spend-native.test.ts.
 * NOT covered: a real Electron dialog on a real desktop (the stub records the options main passes and answers cancel or confirm).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const skip = process.platform === 'win32' ? 'POSIX emulation (uses /proc)' : false;

const runScenario = (name: string): Promise<any> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', './test/electron-emu/register.mjs', 'test/electron-emu/run.mjs', name], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`scenario ${name} timed out\n${out}`)); }, 90_000);
  child.on('exit', () => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('EMU_RESULT '));
    if (!line) return reject(new Error(`scenario ${name}: no result\n${out}`));
    const r = JSON.parse(line.slice('EMU_RESULT '.length));
    if (r.error) return reject(new Error(`scenario ${name}: ${r.error}`));
    resolve(r);
  });
});
let memo: Promise<any> | undefined;
const bsv = () => (memo ??= runScenario('bsv'));

test('emu bsv: the window\'s admin secret, a guessed native secret, the admin secret as native, or the MCP token all get 403 on arm; nothing changes', { skip }, async () => {
  const r = await bsv();
  assert.equal(r.ensure, null);
  assert.deepEqual(r.bootstrapKeys, ['admin', 'baseUrl', 'platform', 'token'], 'the window is handed no native secret');
  assert.equal(r.bsvOn, 200);
  assert.deepEqual({ ...r.p0, spendTools: typeof r.p0.spendTools }, { armed: false, frozen: null, nativeAvailable: true, spendTools: 'boolean' });
  assert.equal(r.armAdminOnly, 403);
  assert.equal(r.armGuessedNative, 403);
  assert.equal(r.armAdminAsNative, 403);
  assert.equal(r.armTokenOnly, 403);
  assert.equal(r.stillDisarmed, true);
});

test('emu bsv: cancelling the native dialog changes nothing; confirming arms; the dialog is worded by main, Cancel is the default', { skip }, async () => {
  const r = await bsv();
  assert.deepEqual(r.cancelled, { ok: false, cancelled: true });
  assert.equal(r.armedAfterCancel, false);
  assert.equal(r.cancelDialog.length, 1);
  const d = r.cancelDialog[0];
  assert.equal(d.message, 'Arm LIVE FUNDS mode for 5 minutes?');
  assert.deepEqual(d.buttons, ['Cancel', 'Arm for 5 minutes']);
  assert.equal(d.defaultId, 0);
  assert.equal(d.cancelId, 0);
  assert.equal(d.type, 'warning');
  assert.match(d.detail, /ordinary tools/);
  assert.doesNotMatch(d.detail, /no spend tool/);
  assert.match(d.detail, /Per transaction: 0\.00001000 BSV \(1,000 sat\)/, 'the limits come from the core, not the window');
  assert.equal(r.confirmed.ok, true);
  assert.equal(r.confirmed.view.armed, true);
  assert.equal(r.armedAfterConfirm, true);
  assert.equal(r.sentChanged, true, 'the window is told to refresh');
});

test('emu bsv: malformed requests and requests from another window or frame are refused before any dialog', { skip }, async () => {
  const r = await bsv();
  for (const k of ['badKind', 'badExtra', 'badProto', 'badString']) assert.deepEqual(r[k], { ok: false, error: 'That request was not understood.' }, k);
  for (const k of ['wrongSender', 'wrongFrame', 'noFrame']) assert.deepEqual(r[k], { ok: false, error: 'Refused: not the Legion window.' }, k);
  assert.equal(r.dialogsForBad, 0);
});

test('emu bsv: Freeze is one step with no dialog and disarms; unfreeze asks (and stays frozen on cancel); arming while frozen is refused before any dialog', { skip }, async () => {
  const r = await bsv();
  assert.equal(r.froze.ok, true);
  assert.deepEqual(r.afterFreeze, { frozen: true, armed: false });
  assert.equal(r.dialogsForFreeze, 0);
  assert.deepEqual(r.unfreezeCancelled, { ok: false, cancelled: true });
  assert.equal(r.stillFrozen, true);
  assert.equal(r.armWhileFrozen.ok, false);
  assert.match(r.armWhileFrozen.error, /frozen/);
  assert.equal(r.armedWhileFrozen, false);
  assert.deepEqual(r.unfreezeDialog, ['Unfreeze the BSV chain?'], 'no arm dialog was shown while frozen');
  assert.equal(r.dialogsBeforeUnfreeze, 1);
  assert.equal(r.unfreezeOk.ok, true);
  assert.deepEqual(r.afterUnfreeze, { frozen: false, armed: false }, 'unfreezing does not arm');
});

test('emu bsv: a caps change shows before and after in the dialog and a value above the hard ceiling is refused by the core', { skip }, async () => {
  const r = await bsv();
  assert.equal(r.capsOk.ok, true);
  assert.equal(r.capsAfter, 500);
  assert.match(r.capsDialogDetail, /Per transaction: 0\.00001000 BSV \(1,000 sat\)\s+->\s+0\.00000500 BSV \(500 sat\)/);
  assert.equal(r.capsTooBig.ok, false);
  assert.match(r.capsTooBig.error, /perTxSats/);
  assert.equal(r.capsAfterTooBig, 500);
});

test('emu bsv: confirmation dialogs never stack, and every change is in the audit log, whose chain verifies', { skip }, async () => {
  const r = await bsv();
  assert.equal(r.second.ok, false);
  assert.match(r.second.error, /already open/);
  assert.equal(r.firstDone.ok, true);
  assert.equal(r.dialogsStacked, 1);
  for (const want of ['policy:armed', 'policy:frozen', 'policy:unfrozen', 'policy:caps-changed']) assert.ok(r.auditDecisions.includes(want), `${want} in ${r.auditDecisions.join(',')}`);
  assert.equal(r.auditOk, true);
});

test('emu hygiene: the native secret is 64 hex chars, differs from the admin secret, and is in no argv, environ, core.log, file or bootstrap', { skip }, async () => {
  const r = await runScenario('hygiene');
  assert.equal(r.nativeLen, 64);
  assert.equal(r.nativeDiffersFromAdmin, true);
  assert.equal(r.nativeInCmdline, false);
  assert.equal(r.nativeInEnviron, false);
  assert.equal(r.nativeInCoreLog, false);
  assert.equal(r.nativeInBootstrap, false);
  assert.deepEqual(r.nativeFiles, []);
});

// ---- spend review through the real compiled main (a FAKE core plays the spend routes; the real spend service is another task's)
let spendMemo: Promise<any> | undefined;
const spend = () => (spendMemo ??= runScenario('spend'));
const ID = (c: string) => c.repeat(40);

test('emu spend: Cancel denies with both secrets from main; the dialog is worded from the core\'s card, Cancel is the default and Escape button', { skip }, async () => {
  const r = await spend();
  assert.equal(r.ensure, null);
  assert.deepEqual(r.cancel, { ok: false, cancelled: true });
  assert.equal(r.cancelDialog.length, 1);
  const d = r.cancelDialog[0];
  assert.deepEqual(d.buttons, ['Cancel', 'Approve this payment']);
  assert.equal(d.defaultId, 0); assert.equal(d.cancelId, 0); assert.equal(d.type, 'warning');
  assert.match(d.detail, /mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn/);
  assert.match(d.detail, /Network: TESTNET/);
  assert.match(d.detail, /Limits: per transaction 0\.00001000 BSV \(1,000 sat\)/, 'the caps are read from the core');
  assert.deepEqual(r.cancelPosts, [{ path: '/api/bsv/spend/ID/decision', body: { decision: 'deny' }, adminOk: true, nativeOk: true }]);
  assert.equal(r.windowDirectDecision, 403, 'the window\'s admin secret alone cannot decide');
});

test('emu spend: a closed window (the dialog fails) denies; approve sends the hash the core served; untrusted content needs two dialogs', { skip }, async () => {
  const r = await spend();
  assert.deepEqual(r.closed, { ok: false, cancelled: true });
  assert.deepEqual(r.closedBodies, [{ decision: 'deny' }]);
  assert.equal(r.approve.ok, true);
  assert.deepEqual(r.approveBodies, [{ decision: 'approve', cardHash: '7'.repeat(64), confirmations: ['approve'] }]);
  assert.equal(r.untrusted.ok, true);
  assert.equal(r.untrustedDialogs, 2);
  assert.deepEqual(r.untrustedBodies, [{ decision: 'approve', cardHash: '8'.repeat(64), confirmations: ['approve', 'untrusted-content'] }]);
});

test('emu spend: a forged card, an unlisted id, a foreign frame or another sender all get no dialog and no call to the core', { skip }, async () => {
  const r = await spend();
  assert.deepEqual(r.forgedExtra, { ok: false, error: 'That request was not understood.' });
  assert.equal(r.forgedUnlisted.ok, false);
  for (const k of ['foreignFrame', 'foreignSender', 'noFrame']) assert.deepEqual(r[k], { ok: false, error: 'Refused: not the Legion window.' }, k);
  assert.equal(r.forgedDialogs, 0);
  assert.equal(r.forgedPosts, 0);
});

test('emu spend: a main-network card is refused and denied without a dialog; deny is dialog-free; resolve is a native three-button dialog', { skip }, async () => {
  const r = await spend();
  assert.equal(r.mainnet.ok, false);
  assert.equal(r.mainnetDialogs, 0);
  assert.deepEqual(r.mainnetBodies, [{ decision: 'deny' }]);
  assert.equal(r.deny.ok, true);
  assert.equal(r.denyDialogs, 0);
  assert.equal(r.resolve.ok, true);
  assert.deepEqual(r.resolveDialog, [{ message: 'Was the payment of 0.00000321 BSV (321 sat) sent?', buttons: ['Cancel', 'It was NOT sent', 'It WAS sent'], defaultId: 0, cancelId: 0 }]);
  assert.deepEqual(r.resolveBodies, [{ outcome: 'sent' }]);
});

test('emu spend: no poll of the pending route while BSV is off; with it on, dialogs open one at a time, oldest card first; a policy dialog cannot open over a spend dialog', { skip }, async () => {
  const r = await spend();
  assert.equal(r.offPendingReads, 0);
  assert.equal(r.offDialogs, 0);
  assert.equal(r.onDialogs, 2);
  assert.deepEqual(r.onOrder, [ID('1')[0], ID('2')[0]]);
  assert.equal(r.armWhileSpend.ok, false);
  assert.match(r.armWhileSpend.error, /already open/);
});
