/**
 * BSV policy changes from the Electron side: the pure parts of the native confirmation flow (admin-logic.ts) and the shape of main.ts.
 * The flow against a REAL spawned core is in bsv-electron-emu.test.ts. NOT covered: a real Electron dialog on a real desktop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BSV_ARM_CHOICES_MINUTES, bsvConfirmation, bsvPreflight, dialogText, parseBsvAction, satsText, trustedSender } from '../src/electron/admin-logic.js';
import { ARM_CHOICES_MINUTES, DEFAULT_CAPS } from '../src/core/bsv/policy.js';

const UI = 'file:///opt/legion/dist-ui/index.html';

test('arm choices in Electron are exactly the core\'s list', () => {
  assert.deepEqual([...BSV_ARM_CHOICES_MINUTES], [...ARM_CHOICES_MINUTES]);
});

test('parseBsvAction: only the six known actions with exactly their fields', () => {
  assert.deepEqual(parseBsvAction({ kind: 'arm', minutes: 15 }), { kind: 'arm', minutes: 15 });
  assert.deepEqual(parseBsvAction({ kind: 'disarm' }), { kind: 'disarm' });
  assert.deepEqual(parseBsvAction({ kind: 'freeze' }), { kind: 'freeze' });
  assert.deepEqual(parseBsvAction({ kind: 'unfreeze' }), { kind: 'unfreeze' });
  assert.deepEqual(parseBsvAction({ kind: 'caps', caps: { perTxSats: 500, maxOutputs: 2 } }), { kind: 'caps', caps: { perTxSats: 500, maxOutputs: 2 } });
  assert.deepEqual(parseBsvAction({ kind: 'allowlist', list: ['mxabc123', 'Bob@Example.com'] }), { kind: 'allowlist', list: ['mxabc123', 'Bob@Example.com'] });
  assert.deepEqual(parseBsvAction({ kind: 'allowlist', list: [] }), { kind: 'allowlist', list: [] });
});

test('parseBsvAction: refuses everything else (types, extra keys, odd minutes, prototype tricks, bad recipients, huge lists)', () => {
  const bad: unknown[] = [
    undefined, null, 0, 'arm', ['arm'], {}, { kind: 1 }, { kind: 'spend' }, { kind: 'sign', tx: 'x' }, { kind: 'ARM', minutes: 5 },
    { kind: 'arm' }, { kind: 'arm', minutes: '5' }, { kind: 'arm', minutes: 7 }, { kind: 'arm', minutes: 0 }, { kind: 'arm', minutes: -5 }, { kind: 'arm', minutes: 1e9 }, { kind: 'arm', minutes: NaN }, { kind: 'arm', minutes: 5, until: 1 },
    { kind: 'freeze', reason: 'because' }, { kind: 'disarm', force: true }, { kind: 'unfreeze', ok: true },
    { kind: 'caps' }, { kind: 'caps', caps: {} }, { kind: 'caps', caps: [] }, { kind: 'caps', caps: { perTxSats: -1 } }, { kind: 'caps', caps: { perTxSats: 1.5 } }, { kind: 'caps', caps: { perTxSats: '5' } },
    { kind: 'caps', caps: { perTxSats: Number.MAX_SAFE_INTEGER + 2 } }, { kind: 'caps', caps: { unknownCap: 1 } }, { kind: 'caps', caps: { perTxSats: 1 }, extra: 1 },
    JSON.parse('{"kind":"caps","caps":{"__proto__":{"perTxSats":1}}}'), JSON.parse('{"kind":"caps","caps":{"constructor":1}}'),
    { kind: 'allowlist' }, { kind: 'allowlist', list: 'abc' }, { kind: 'allowlist', list: ['a b c'] }, { kind: 'allowlist', list: [' abc'] }, { kind: 'allowlist', list: ['ab'] }, { kind: 'allowlist', list: [5] },
    { kind: 'allowlist', list: ['abc\ndef'] }, { kind: 'allowlist', list: Array.from({ length: 51 }, (_, i) => `addr${i}x`) }, { kind: 'allowlist', list: ['x'.repeat(121)] },
    Object.create({ kind: 'freeze' }), Object.assign(Object.create(null), { kind: 'freeze' }),
  ];
  for (const b of bad) assert.equal(parseBsvAction(b), undefined, JSON.stringify(b));
});

test('only arm, unfreeze, caps and allowlist show a native dialog; freeze and disarm (they only make things safer) do not', () => {
  assert.equal(bsvConfirmation({ kind: 'arm', minutes: 5 }).needsDialog, true);
  assert.equal(bsvConfirmation({ kind: 'unfreeze' }).needsDialog, true);
  assert.equal(bsvConfirmation({ kind: 'caps', caps: { perTxSats: 1 } }).needsDialog, true);
  assert.equal(bsvConfirmation({ kind: 'allowlist', list: ['abc'] }).needsDialog, true);
  assert.equal(bsvConfirmation({ kind: 'freeze' }).needsDialog, false);
  assert.equal(bsvConfirmation({ kind: 'disarm' }).needsDialog, false);
});

test('each action maps to exactly its core route and body', () => {
  const r = (a: Parameters<typeof bsvConfirmation>[0]) => { const c = bsvConfirmation(a); return [c.method, c.route, c.body]; };
  assert.deepEqual(r({ kind: 'arm', minutes: 15 }), ['POST', '/api/bsv/policy/arm', { minutes: 15 }]);
  assert.deepEqual(r({ kind: 'disarm' }), ['POST', '/api/bsv/policy/disarm', {}]);
  assert.deepEqual(r({ kind: 'freeze' }), ['POST', '/api/bsv/policy/freeze', { reason: 'frozen by the owner' }]);
  assert.deepEqual(r({ kind: 'unfreeze' }), ['POST', '/api/bsv/policy/unfreeze', {}]);
  assert.deepEqual(r({ kind: 'caps', caps: { maxFeeSats: 100 } }), ['POST', '/api/bsv/policy/caps', { maxFeeSats: 100 }]);
  assert.deepEqual(r({ kind: 'allowlist', list: ['abc', 'def'] }), ['POST', '/api/bsv/policy/allowlist', { list: ['abc', 'def'] }]);
});

test('every dialog: Cancel is first (the default and the Escape button), the confirm button names the action, and nothing claims spending works', () => {
  const facts = { caps: { ...DEFAULT_CAPS }, allowlist: ['abc'], frozen: { reason: 'the audit log failed verification' }, pending: [1], unknown: [1, 2] };
  const acts: Array<Parameters<typeof bsvConfirmation>[0]> = [{ kind: 'arm', minutes: 5 }, { kind: 'unfreeze' }, { kind: 'caps', caps: { perTxSats: 5 } }, { kind: 'allowlist', list: ['abc'] }];
  for (const a of acts) {
    const c = bsvConfirmation(a, facts, 'Wallet check: wallet is on MAINNET.');
    assert.equal(c.buttons[0], 'Cancel');
    assert.notEqual(c.buttons[1], 'OK');
    assert.ok(c.title.length > 0 && c.message.length > 0);
    assert.match(c.detail, /no spend tool/, a.kind);
    assert.match(c.detail, /policy state only/, a.kind);
    assert.doesNotMatch(c.detail + c.message, /funds will|will send|can spend your|enable spending|trading|profit/i, a.kind);
  }
  const arm = bsvConfirmation({ kind: 'arm', minutes: 15 }, facts, 'Wallet check: x');
  assert.equal(arm.type, 'warning');
  assert.match(arm.message, /LIVE FUNDS/);
  assert.match(arm.message, /15 minutes/);
  assert.equal(arm.buttons[1], 'Arm for 15 minutes');
  for (const line of ['Per transaction: 0.00001000 BSV (1,000 sat)', 'Per session: 0.00005000 BSV (5,000 sat)', 'Per rolling 24 hours: 0.00010000 BSV (10,000 sat)', 'Max outputs: 3', 'Fee ceiling: 0.00000200 BSV (200 sat)']) assert.ok(arm.detail.includes(line), line);
  const un = bsvConfirmation({ kind: 'unfreeze' }, facts);
  assert.match(un.detail, /audit log failed verification/);
  assert.match(un.detail, /2 earlier request/);
  assert.match(un.detail, /Unfreezing does not arm mainnet/);
});

test('dialog text from the core is one short printable line: control, bidi and zero-width characters are removed', () => {
  const ch = (...n: number[]) => String.fromCharCode(...n);
  const evil = `line1${ch(10)}line2${ch(13)}${ch(0x202e)}evil${ch(0x200b)}hidden${ch(0)}${ch(0xfeff)}   ` + 'x'.repeat(500);
  const out = dialogText(evil);
  assert.ok(out.length <= 160);
  assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/);
  assert.doesNotMatch(out, /\n/);
  assert.equal(dialogText(undefined), '');
  assert.equal(dialogText(42), '');
  assert.equal(dialogText({ toString: () => 'x' }), '');
  // and through the dialog
  const c = bsvConfirmation({ kind: 'unfreeze' }, { frozen: { reason: `ok${String.fromCharCode(10, 0x202e)}EVIL` } });
  assert.ok(!c.detail.includes(String.fromCharCode(0x202e)));
});

test('satsText: integer maths, BSV with eight decimals and the satoshi count; junk is zero', () => {
  assert.equal(satsText(0), '0.00000000 BSV (0 sat)');
  assert.equal(satsText(1), '0.00000001 BSV (1 sat)');
  assert.equal(satsText(123456789), '1.23456789 BSV (123,456,789 sat)');
  assert.equal(satsText(-5), '0.00000000 BSV (0 sat)');
  assert.equal(satsText(1.5), '0.00000000 BSV (0 sat)');
  assert.equal(satsText('7'), '0.00000000 BSV (0 sat)');
  assert.equal(satsText(NaN), '0.00000000 BSV (0 sat)');
});

test('preflight: no dialog is shown for an arm that the core would refuse because the chain is frozen', () => {
  assert.match(bsvPreflight({ kind: 'arm', minutes: 5 }, { frozen: { reason: 'x' } }) ?? '', /frozen/);
  assert.equal(bsvPreflight({ kind: 'arm', minutes: 5 }, { frozen: null }), undefined);
  assert.equal(bsvPreflight({ kind: 'unfreeze' }, { frozen: { reason: 'x' } }), undefined);
  assert.equal(bsvPreflight({ kind: 'freeze' }, { frozen: { reason: 'x' } }), undefined);
});

test('trustedSender: only the page the window loaded', () => {
  assert.equal(trustedSender(UI, UI), true);
  assert.equal(trustedSender(UI + '#/chat', UI), true);
  assert.equal(trustedSender(UI + '?x=1', UI), true);
  for (const u of [undefined, null, '', 'https://evil.example/', UI + 'x', UI.replace('index.html', 'other.html'), 'file:///tmp/evil/index.html', 'data:text/html,hi', 'http://127.0.0.1:4747/', 123]) assert.equal(trustedSender(u, UI), false, String(u));
});

// ---- the shape of main.ts and the preload: these cannot be exercised without a desktop, so the properties that matter are pinned in the source

const main = readFileSync(new URL('../../src/electron/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');

test('main.ts: the native secret goes to the core over stdin only and never to the renderer, a log, argv or env', () => {
  assert.match(main, /child\.stdin\?\.end\(secret \+ '\\n' \+ native \+ '\\n'\)/);
  const bootstrap = main.slice(main.indexOf("ipcMain.on('legion:bootstrap'"), main.indexOf("ipcMain.handle('legion:bsv-policy'"));
  assert.doesNotMatch(bootstrap, /nativeSecret|native/i, 'bootstrap must not carry the native secret');
  const spawnBlock = main.slice(main.indexOf('const child = spawn('), main.indexOf('coreProc = child;'));
  assert.doesNotMatch(spawnBlock, /native/, 'not in argv or env');
  assert.doesNotMatch(main, /console\.\w+\([^)]*nativeSecret/);
  // the only places the variable is read or written: its declaration, set at spawn, cleared on exit and kill, and the one header
  const uses = main.split('\n').filter((l) => l.includes('nativeSecret')).map((l) => l.trim());
  assert.equal(uses.length, 5, uses.join('\n'));
  assert.ok(uses.every((l) => /^let nativeSecret|^nativeSecret = |nativeSecret = undefined|headers\['X-Legion-Native'\] = nativeSecret/.test(l)), uses.join('\n'));
  assert.doesNotMatch(preload, /nativeSecret|X-Legion-Native/i, 'the preload has no native secret');
});

test('main.ts: the policy IPC handler checks the sender window and frame URL first, and the native header is sent only to the pinned core after the dialog', () => {
  const h = main.slice(main.indexOf("ipcMain.handle('legion:bsv-policy'"), main.indexOf("ipcMain.handle('legion:open-external'"));
  assert.match(h, /senderFrame/);
  assert.match(h, /sender\)? !== win\.webContents|\.sender\s*!==\s*win\.webContents/);
  assert.match(h, /trustedSender\(frameUrl, uiUrl\)/);
  assert.ok(h.indexOf('trustedSender') < h.indexOf('bsvPolicyChange(raw)'), 'sender check comes before any work');
  const fn = main.slice(main.indexOf('async function bsvPolicyChange'), main.indexOf('function showWindow'));
  assert.ok(fn.indexOf('parseBsvAction(raw)') < fn.indexOf('showMessageBox'), 'parse before dialog');
  assert.ok(fn.indexOf('showMessageBox') < fn.indexOf("ownCoreCall('POST', c.route, c.body, true)"), 'dialog before the native call');
  assert.equal((main.match(/'X-Legion-Native'/g) ?? []).length, 1, 'one place sends the native header');
  assert.match(fn, /defaultId: 0, cancelId: 0/);
  assert.match(fn, /bsvDialogOpen/);
  assert.match(main, /live \|\| !adminSecret \|\| !rendererAdmin \|\| !pinned/, 'only a proven core of our own');
});

test('preload: exposes bsvPolicy and onBsvChanged, validates nothing it should not, and still no secret beyond the existing admin one', () => {
  assert.match(preload, /bsvPolicy\(action\)/);
  assert.match(preload, /invoke\('legion:bsv-policy', action\)/);
  assert.match(preload, /onBsvChanged\(cb\)/);
});
