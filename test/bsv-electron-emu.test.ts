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
  assert.deepEqual(r.p0, { armed: false, frozen: null, nativeAvailable: true, spendTools: true });
  assert.equal(r.armAdminOnly, 403);
  assert.equal(r.armGuessedNative, 403);
  assert.equal(r.armAdminAsNative, 403);
  assert.equal(r.armTokenOnly, 403);
  assert.equal(r.stillDisarmed, true);
});

test('emu bsv: cancelling the native dialog changes nothing; confirming arms; the dialog is worded by main, Cancel is the default', { skip }, async () => {
  const r = await bsv();
  // The enable route is registered by T2 (index.ts). Until then the core 404s it, mainnet stays off and main refuses to arm: assert that fail-closed
  // behaviour, and the full flow as soon as the route exists (these assertions then switch on by themselves).
  if (r.routeMissing) { assert.equal(r.cancelled.ok, false); assert.match(r.cancelled.error, /switched off/); assert.equal(r.armedAfterConfirm, false); return; }
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
  // T5: mainnet is OFF by default, so the core refuses to arm until the owner has switched it on. The window has no "enable mainnet" step yet
  // (the T3 second pass adds the dialog); then this test arms again with the switch on and the old assertions (ok, armed, refresh event) come back.
  assert.equal(r.confirmed.ok, true, 'with the switch on, the native arm flow works end to end');
  assert.equal(r.armedAfterConfirm, true);
  assert.equal(r.sentChanged, true, 'the window is told to refresh');
  assert.match(d.detail, /ONE mainnet spend request may be considered, then it disarms/);
  assert.match(d.detail, /wallet's own prompt, which is the last gate/);
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
  if (!r.routeMissing) { assert.equal(r.second.ok, false); assert.match(r.second.error, /already open/); }
  if (!r.routeMissing) { assert.equal(r.firstDone.ok, true, 'the first dialog was answered after the second was refused'); assert.equal(r.dialogsStacked, 1); }
  for (const want of ['policy:frozen', 'policy:unfrozen', 'policy:caps-changed']) assert.ok(r.auditDecisions.includes(want), `${want} in ${r.auditDecisions.join(',')}`);
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
  assert.match(d.detail, /mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q/);
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

test('emu spend: a main card the facts do not allow is refused and denied without a dialog; deny is dialog-free; resolve is a native three-button dialog', { skip }, async () => {
  const r = await spend();
  assert.equal(r.mainnet.ok, false);
  assert.equal(r.mainnetDialogs, 0);
  assert.deepEqual(r.mainnetBodies, [{ decision: 'deny' }]);
  assert.equal(r.forgedNet.ok, false, 'a main card with the TESTNET label is refused even when the facts allow mainnet');
  assert.equal(r.forgedNetDialogs, 0);
  assert.equal(r.mainAllowed.ok, true, 'a main card the core\'s facts allow (enabled and armed) gets its dialog');
  assert.deepEqual(r.mainAllowedDialog.map((d: any) => d.title), ['LIVE FUNDS: approve a MAINNET payment?', 'Last Legion check before your wallet'], 'D1 then D2, always');
  assert.deepEqual(r.mainAllowedDialog.map((d: any) => d.buttons), [['Cancel', 'Continue to the last check'], ['Send 600 sat to ...' + '12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH'.slice(-8), 'Cancel']]);
  assert.deepEqual(r.mainAllowedDialog.map((d: any) => [d.defaultId, d.cancelId]), [[0, 0], [1, 1]], 'Cancel is the default and the Escape button in both, wherever it sits');
  assert.deepEqual(r.mainAllowedBodies, [{ decision: 'approve', cardHash: '6'.repeat(64), confirmations: ['approve', 'live-funds'] }]);
  assert.deepEqual(r.mainD2Habit, { ok: false, cancelled: true }, 'pressing D1\'s yes position on D2 is Cancel');
  assert.deepEqual(r.mainD2HabitBodies, [{ decision: 'deny' }]);
  assert.equal(r.mainTainted.ok, true);
  assert.deepEqual(r.mainTaintedTitles.map((t: string) => t.split(':')[0]), ['LIVE FUNDS', 'Last Legion check before your wallet', 'Untrusted content was read']);
  assert.deepEqual(r.mainTaintedBodies, [{ decision: 'approve', cardHash: '4'.repeat(64), confirmations: ['approve', 'live-funds', 'untrusted-content'] }]);
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

test('emu bsv: mainnet is off by default; arming is refused before any dialog while it is off; enabling is a native dialog and Cancel leaves it off; the bearer token and the admin secret alone cannot enable it', { skip }, async () => {
  const r = await bsv();
  assert.equal(r.mainnetDefault, false);
  assert.equal(r.armWhileOff.ok, false);
  assert.match(r.armWhileOff.error, /Mainnet is switched off/);
  assert.equal(r.dialogsArmWhileOff, 0, 'no arm dialog while the switch is off');
  assert.deepEqual(r.enableCancelled, { ok: false, cancelled: true });
  assert.equal(r.mainnetAfterCancel, false);
  const d = r.enableDialog[0];
  assert.equal(r.enableDialog.length, 1);
  assert.equal(d.message, 'Allow Legion to consider spending REAL BSV?');
  assert.deepEqual(d.buttons, ['Cancel', 'Allow mainnet']);
  assert.equal(d.defaultId, 0); assert.equal(d.cancelId, 0); assert.equal(d.type, 'warning');
  assert.equal(r.enableToken, 403);
  assert.equal(r.mainnetAfterNoNative, false);
  if (r.routeMissing) return; // TODO until T2 registers the route: the rest needs the core's mainnet route
  assert.equal(r.enableAdminOnly, 403);
  assert.equal(r.enableOk.ok, true);
  assert.equal(r.mainnetAfterConfirm, true);
  assert.equal(r.armedAfterEnable, false, 'enabling does not arm');
});

test('emu bsv: the arm is recorded in the audit log (policy:armed), the switch changes are recorded, and switching mainnet off needs no dialog and disarms', { skip }, async () => {
  const r = await bsv();
  if (r.routeMissing) return; // TODO until T2 registers the route
  for (const want of ['policy:armed', 'policy:mainnet-changed']) assert.ok(r.auditDecisions.includes(want), `${want} in ${r.auditDecisions.join(',')}`);
  assert.equal(r.disableOk.ok, true);
  assert.equal(r.dialogsForDisable, 0);
  assert.deepEqual(r.afterDisable, { mainnet: false, armed: false });
});

test('emu bsv (ASSUMPTION T3-A4): a mainnet limits change is either applied to the main network and reported, or main reports that the core did not apply it; the confirmed network is never silently another one', { skip }, async () => {
  const r = await bsv();
  if (r.routeMissing) return; // TODO until T2 registers the route (mainnet caps need a mainnet switch)
  assert.match(r.capsMainDialog, /MAINNET/);
  if (r.capsMain.ok) assert.equal(r.capsMainAfter, 400);
  else assert.match(r.capsMain.error, /did not apply the MAINNET|did not report the mainnet|refused/);
});
