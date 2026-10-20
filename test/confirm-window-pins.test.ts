/**
 * The Legion confirm window, pinned: how its window is made, which questions go through it and which stay with the system, that the update set did
 * not change (an older client rejects a package with a new top-level name), and the wording of every call site.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CODE_SET, FULL_PACKAGE_SET } from '../src/core/updater/apply.js';
import { agentModeBatch, agentModeChange, resetAgentModeCancelForTests } from '../src/electron/agent-mode-ipc.js';
import { bsvConfirmation, parseSpendCard, spendLiveDialog, spendResolveDialog, spendReviewDialog, spendUntrustedDialog, type SpendCard } from '../src/electron/admin-logic.js';
import { connectGithub } from '../src/electron/connector-ipc.js';
import { buildModel, nativeOptions, TONE_TAGS, type ConfirmOptions } from '../src/electron/confirm-window-logic.js';
import { makeConfirm, providerChange } from '../src/electron/provider-ipc.js';
import { projectChange } from '../src/electron/project-ipc.js';
import { MAIN_A, TEST_A } from './bsv-net-helpers.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');
const win = read('src/electron/confirm-window.ts');
const main = read('src/electron/main.ts');

test('update set: CODE_SET and FULL_PACKAGE_SET are exactly what every installed client knows; the page lives inside assets', () => {
  assert.deepEqual([...CODE_SET], ['dist', 'dist-ui', 'assets', 'scripts', 'licenses', 'package.json', 'package-lock.json', 'build-info.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd']);
  assert.deepEqual([...FULL_PACKAGE_SET], [...CODE_SET, 'node_modules', 'runtime']);
  assert.ok(existsSync(`${ROOT}/assets/confirm-window.html`));
  assert.ok(CODE_SET.includes('assets'));
  assert.equal(readdirSync(ROOT).includes('confirm-window.html'), false);
});

test('the window is made like the splash and the update window: sandbox, context isolation, no node, no preload, no dev tools, its own session', () => {
  const prefs = /webPreferences: \{([^}]*)\}/.exec(win)?.[1] ?? '';
  for (const must of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'webviewTag: false', 'devTools: false', 'partition: CONFIRM_PARTITION']) assert.ok(prefs.includes(must), must);
  assert.doesNotMatch(win, /preload\s*:/, 'no preload');
  assert.doesNotMatch(prefs, /nodeIntegration: true|sandbox: false|contextIsolation: false/);
  assert.match(win, /CONFIRM_PARTITION = 'legion-confirm'/, 'no persist: prefix: an in-memory session');
});

test('a minimized or gone parent is no parent: the window opens on its own, so the lock is never held by a hidden modal', () => {
  assert.match(win, /const parent = parentIn && !parentIn\.isDestroyed\(\) && !parentIn\.isMinimized\(\) \? parentIn : undefined;/);
});

test('the page ships: release packaging copies assets whole (it skips only dist/test and node_modules), so no per-file list can leave the page out', () => {
  const pack = read('scripts/release-package.mjs');
  assert.match(pack, /const skip = \(rel\) => rel === 'dist\/test' \|\| rel\.startsWith\('dist\/test\/'\) \|\| rel\.split\('\/'\)\.includes\('node_modules'\);/);
  assert.doesNotMatch(pack, /update-window\.html|splash\.html|confirm-window/, 'no per-file asset list in the packer');
});

test('the window locks itself down: no new windows, no navigation, no redirects, no webviews, every permission refused, no reload', () => {
  for (const must of ['setWindowOpenHandler(() => ({ action: \'deny\' }))', "'will-navigate'", "'will-redirect'", "'will-attach-webview'", 'setPermissionRequestHandler((_wc, _permission, callback) => callback(false))', 'setPermissionCheckHandler(() => false)', 'setDevicePermissionHandler(() => false)', "'before-input-event'"]) assert.ok(win.includes(must), must);
  assert.match(win, /loadFile\(CONFIRM_PAGE\)/, 'a local file, never a URL');
  assert.doesNotMatch(win, /loadURL|session\.defaultSession|fromPartition\((?!CONFIRM_PARTITION)/);
});

test('answers are read from this window\'s own web contents only, through the one-time id gate', () => {
  assert.equal((win.match(/page-title-updated/g) ?? []).length, 1);
  assert.match(win, /wc\.on\('page-title-updated'/);
  assert.match(win, /createAnswerGate\(nonce, model\.buttons\.length\)/);
  assert.match(win, /randomBytes\(16\)\.toString\('hex'\)/, '128 bits');
  assert.equal((win.match(/new BrowserWindow\(/g) ?? []).length, 1, 'a fresh window for every question');
  assert.doesNotMatch(main, /legion-confirm/, 'main.ts never reads a confirm answer itself');
  assert.doesNotMatch(read('src/electron/preload.cjs'), /confirm-window|confirmWindow|legion-confirm/, 'the Legion page gets no way to ask or answer');
});

test('failure falls back to the system dialog with the same question, and nothing ever answers yes by itself', () => {
  assert.match(win, /return native\(parent, opts, `the question was not accepted/);
  assert.match(win, /return native\(parent, opts, 'the page file is missing'\)/);
  assert.match(win, /the window could not be made/);
  assert.match(win, /the window failed/);
  // the only places that resolve with a number: an answer from the page, or the cancel index
  const resolves = [...win.matchAll(/(?:finish|resolveAnswer)\(([^,)]*)/g)].map((m) => m[1]!.trim());
  for (const r of resolves) assert.ok(/^(read\.index|n|cancel|await native\(parent)/.test(r), `unexpected answer source: ${r}`);
  assert.doesNotMatch(win, /confirmAt|defaultIndex|response: 1\b/, 'nothing picks the confirm button');
});

test('one question at a time: a second is refused as busy (never answered Cancel), and a spend review waits instead', () => {
  assert.match(main, /acquire: \(\) => \{ if \(bsvDialogOpen \|\| !holdConfirmWindow\(\)\) return false;/);
  assert.match(main, /release: \(\) => \{ bsvDialogOpen = false; releaseConfirmWindow\(\); \}/);
  assert.match(win, /if \(busy \|\| \(held && !holder\)\) \{/, 'a held lock refuses everyone but the holder');
  assert.match(win, /export function holdConfirmWindow\(\): boolean \{ if \(busy \|\| held\) return false; held = true; return true; \}/);
  assert.match(win, /log\('a question is already open: this one was not asked'\);\s*throw new ConfirmBusyError\(\);/);
  assert.doesNotMatch(win, /resolveIds/, 'a busy window never makes up a cancel');
  assert.match(main, /showHeldMessageBox\(win, shown\)[\s\S]*showHeldMessageBox\(shown\)/, 'the review asks through the own entry of the holder');
  assert.match(main, /if \(bsvDialogOpen \|\| confirmWindowBusy\(\)\) return \{ ok: false, error: 'A confirmation is already open/);
});

test('which questions moved: the 8 settings handlers and the BSV paths use the window; the restart and update questions stay with the system', () => {
  assert.equal((main.match(/makeConfirm\(confirmWindow, \(\) => win\)/g) ?? []).length, 8);
  assert.doesNotMatch(main, /makeConfirm\(dialog/);
  const sys = [...main.matchAll(/dialog\.(showMessageBox|showErrorBox|showOpenDialog)\(/g)].map((m) => m[1]);
  assert.deepEqual(sys, ['showMessageBox', 'showMessageBox', 'showErrorBox', 'showOpenDialog'], 'foreign-core question, started-outside notice, restart failure box, folder picker');
  assert.match(main, /async function askRestartForeignCore[\s\S]*?dialog\.showMessageBox/);
  assert.equal((main.match(/confirmWindow\.showMessageBox\(/g) ?? []).length, 2, 'BSV policy (2 forms)');
  assert.equal((main.match(/confirmWindow\.showHeldMessageBox\(/g) ?? []).length, 2, 'spend review (2 forms)');
  assert.doesNotMatch(read('src/electron/updater-main.ts'), /confirm-window|confirmWindow/, 'the updater keeps its own dialogs: they can run while dist and assets are swapped');
  assert.doesNotMatch(read('src/electron/update-window-main.ts'), /confirm-window|confirmWindow/);
});

// ---- the call sites ----

const card = (over: Partial<Record<string, unknown>> = {}): SpendCard => {
  const r = parseSpendCard({
    requestId: 'a'.repeat(40), network: 'test', networkLabel: 'TESTNET', hash: 'a'.repeat(64), agentId: 'scout', purpose: 'pay the API invoice #4471',
    outputs: [{ kind: 'payment', recipient: TEST_A, sats: 25000, allowlisted: true }], fee: { sats: 12 }, totalSpendSats: 25012,
    remaining: { perTxSats: 25000, perSessionSats: 75000, per24hSats: 175000 }, warnings: [], requiredConfirmations: ['approve'], ...over,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { card: SpendCard }).card;
};
const fits = (o: ConfirmOptions): void => { const r = buildModel(o, { nonce: 'a'.repeat(32), theme: 'dark' }); assert.equal(r.ok, true, JSON.stringify(r)); };

test('makeConfirm hands every field through: Cancel first and default, the confirm label second', async () => {
  let seen: unknown[] = [];
  const confirm = makeConfirm({ showMessageBox: async (...a: unknown[]) => { seen = a; return { response: 1 }; } }, () => null);
  assert.equal(await confirm({ title: 'T', message: 'M', detail: 'D', confirmLabel: 'Go', who: 'Settings \u203a Gates', tone: 'danger', toneTag: 'RESTARTS CORE', items: ['a'] }), true);
  assert.deepEqual(seen, [{ title: 'T', message: 'M', detail: 'D', who: 'Settings \u203a Gates', tone: 'danger', toneTag: 'RESTARTS CORE', items: ['a'], type: 'question', buttons: ['Cancel', 'Go'], defaultId: 0, cancelId: 0, noLink: true }]);
});

test('start over is danger with the RESTARTS CORE tag; a plain key save is the default tone', async () => {
  const shown: unknown[] = [];
  const calls: string[] = [];
  const deps = {
    async call(method: string, route: string) {
      calls.push(`${method} ${route}`);
      if (route === '/api/providers') return { status: 200, json: { keyStoreState: 'blocked', providers: [] } };
      return { status: 200, json: { keyStoreState: 'encrypted' } };
    },
    async confirm(o: unknown) { shown.push(o); return false; },
    startOver: { storeReady: async () => true, setAsideKey: async () => undefined, restartCore: async () => null },
  };
  await providerChange({ kind: 'start-over' }, deps as never);
  const o = shown[0] as ConfirmOptions & { title: string; confirmLabel: string };
  assert.deepEqual([o.title, o.tone, o.toneTag, o.who], ['Start over with new keys?', 'danger', 'RESTARTS CORE', 'Settings \u203a Providers']);
  assert.equal(o.confirmLabel, 'Start over');
  assert.ok(TONE_TAGS.danger.includes(o.toneTag!));
});

test('connecting GitHub for the first time asks to restart the core: danger; "sign in each launch" is the default tone', async () => {
  const shown: Array<Record<string, unknown>> = [];
  const deps = {
    async call(_m: string, route: string) { return route === '/api/state' ? { status: 200, json: { tasks: [] } } : { status: 200, json: { available: true, key: 'missing' } }; },
    async confirm(o: Record<string, unknown>) { shown.push(o); return true; },
    async ensureKey() { return undefined; }, async restartCore() { return null; }, openExternal() { /* none */ },
  };
  await connectGithub(deps as never);
  assert.deepEqual(shown.map((o) => [o.title, o.tone, o.toneTag, o.who]), [
    ['Restart Legion Core to connect GitHub?', 'danger', 'RESTARTS CORE', 'Settings \u203a Connectors'],
    ['Sign in without remembering?', undefined, undefined, 'Settings \u203a Connectors'],
  ]);
});

test('project folder: the folders are rows, the words are one paragraph, and the system dialog gets the same text as before', async () => {
  const shown: Array<Record<string, any>> = [];
  const deps = {
    async call(method: string, route: string) { return method === 'GET' ? { status: 200, json: route === '/api/agents' ? [] : { name: 'Shop', folder: 'C:\\work\\shop', members: [] } } : { status: 200, json: {} }; },
    async confirm(o: Record<string, any>) { shown.push(o); return false; },
    async pickFolder() { return 'D:\\projects\\shop-2'; },
  };
  await projectChange({ kind: 'folder', id: 'proj_0123456789ab', mode: 'pick' }, deps as never);
  const o = shown[0]!;
  assert.equal(o.who, 'Projects \u203a Shop');
  assert.deepEqual(o.facts, [{ label: 'New folder', value: 'D:\\projects\\shop-2' }, { label: 'Now', value: 'C:\\work\\shop' }]);
  assert.equal(o.detail, 'New folder: D:\\projects\\shop-2\nNow: C:\\work\\shop\n\n' + o.windowDetail, 'detail is the old text, whole');
  assert.doesNotMatch(o.windowDetail, /New folder|Now:/);
});

test('agent mode: the lines of the core are the items; the system dialog still gets them as paragraphs', async () => {
  resetAgentModeCancelForTests();
  const shown: Array<Record<string, any>> = [];
  const lines = ['Worker will run file edits inside its project without asking.', 'Shell commands still ask.'];
  const deps = {
    async call(_m: string, route: string) { return route === '/api/agents/mode-preview' ? { status: 200, json: { raises: true, digest: 'f'.repeat(64), loosening: lines, agentName: 'Worker' } } : { status: 200, json: {} }; },
    async confirm(o: Record<string, any>) { shown.push(o); return false; },
  };
  await agentModeChange({ agentId: 'worker', approval: 'auto-edits' }, deps as never);
  assert.deepEqual([shown[0]!.who, shown[0]!.items, shown[0]!.windowDetail, shown[0]!.detail], ['Agents \u203a Worker', lines, '', lines.join('\n\n')]);
  resetAgentModeCancelForTests();
  await agentModeBatch({ changes: [{ agentId: 'worker', approval: 'auto-edits' }] }, deps as never);
  assert.equal(shown[1]!.who, 'Agents');
  assert.ok(Array.isArray(shown[1]!.items) && shown[1]!.items.length > 0);
  resetAgentModeCancelForTests();
});

test('BSV spend review on the test network: money, TESTNET, the amount and the full address large, the numbers as rows', () => {
  const c = card();
  const d = spendReviewDialog(c, { caps: { perTxSats: 50000, perSessionSats: 100000, per24hSats: 200000 } });
  assert.deepEqual([d.tone, d.toneTag, d.who, d.amount, d.address, d.confirmAt, d.defaultId, d.cancelId, d.windowMessage], ['money', 'TESTNET', 'BSV \u203a spend review', '25,000 sat', c.payment.recipient, 1, 0, 0, '']);
  assert.deepEqual(d.buttons, ['Cancel', 'Approve this payment']);
  assert.ok(d.facts!.some((f) => f.label === 'Network fee' && /12 sat/.test(f.value)) && d.facts!.some((f) => f.label === 'Agent' && f.value === 'scout'));
  assert.ok(d.facts!.some((f) => f.label.startsWith('Purpose') && f.value === '"pay the API invoice #4471"'));
  assert.match(d.detail, /Recipient \(full address, check every character\):\n[mn]/, 'the system dialog text is unchanged');
  fits(d);
});

test('BSV on the main network: LIVE FUNDS, step counts from the card, the last check keeps the confirm button FIRST and Cancel the default', () => {
  const main = card({ network: 'main', networkLabel: 'LIVE FUNDS (main network)', outputs: [{ kind: 'payment', recipient: MAIN_A, sats: 25000, allowlisted: true }], requiredConfirmations: ['approve', 'live-funds'] });
  const d1 = spendReviewDialog(main, { armRemainingMs: 250_000 });
  const d2 = spendLiveDialog(main);
  assert.deepEqual([d1.toneTag, d1.who, d1.title], ['LIVE FUNDS', 'BSV \u203a spend review 1 of 2', 'LIVE FUNDS: approve a MAINNET payment?']);
  assert.deepEqual([d2.toneTag, d2.who, d2.confirmAt, d2.defaultId, d2.cancelId], ['LAST CHECK', 'BSV \u203a spend review 2 of 2', 0, 1, 1]);
  assert.deepEqual(d2.buttons, [`Send 25,000 sat to ...${main.payment.recipient.slice(-8)}`, 'Cancel']);
  assert.equal(d2.address, main.payment.recipient);
  assert.ok(d1.facts!.some((f) => f.label === 'Armed for one spend; time left' && f.value === '4:10'));
  fits(d1); fits(d2);
  const tainted = card({ network: 'main', networkLabel: 'LIVE FUNDS (main network)', outputs: [{ kind: 'payment', recipient: MAIN_A, sats: 25000, allowlisted: true }], requiredConfirmations: ['approve', 'live-funds', 'untrusted-content'] });
  assert.deepEqual([spendReviewDialog(tainted).who, spendLiveDialog(tainted).who, spendUntrustedDialog(tainted).who], ['BSV \u203a spend review 1 of 3', 'BSV \u203a spend review 2 of 3', 'BSV \u203a spend review 3 of 3']);
  const t2 = card({ requiredConfirmations: ['approve', 'untrusted-content'] });
  assert.deepEqual([spendReviewDialog(t2).who, spendUntrustedDialog(t2).who, spendUntrustedDialog(t2).toneTag], ['BSV \u203a spend review 1 of 2', 'BSV \u203a spend review 2 of 2', 'TESTNET']);
});

test('BSV resolve: three answers and no yes, so no button is coloured', () => {
  const d = spendResolveDialog({ requestId: 'a'.repeat(40), totalSats: 25012, agentId: 'scout', txid: 'b'.repeat(64), net: 'test' });
  assert.deepEqual([d.confirmAt, d.buttons.length, d.toneTag], [-1, 3, 'TESTNET']);
  assert.ok(d.facts!.some((f) => f.value === 'b'.repeat(64)));
  fits(d);
});

test('BSV policy dialogs: money tone with a tag that matches the network, and each one fits the window', () => {
  const facts = { caps: { perTxSats: 1000 }, nets: { main: { caps: { perTxSats: 100, perSessionSats: 200, per24hSats: 300, maxOutputs: 2, maxFeeSats: 50 }, allowlist: [] }, test: { caps: { perTxSats: 1000 }, allowlist: [] } }, spendTools: true };
  const a = MAIN_A;
  const cases = [
    bsvConfirmation({ kind: 'arm', minutes: 10 } as never, facts as never, 'Wallet check: ok'),
    bsvConfirmation({ kind: 'mainnet-enable' } as never, facts as never),
    bsvConfirmation({ kind: 'unfreeze' } as never, facts as never),
    bsvConfirmation({ kind: 'caps', net: 'test', caps: { perTxSats: 2000 } } as never, facts as never),
    bsvConfirmation({ kind: 'caps', net: 'main', caps: { perTxSats: 50 } } as never, facts as never),
    bsvConfirmation({ kind: 'allowlist', net: 'main', list: [a, a] } as never, facts as never),
    bsvConfirmation({ kind: 'connect', url: 'http://127.0.0.1:3321' } as never, facts as never),
  ];
  assert.deepEqual(cases.map((c) => [c.tone, c.toneTag]), [['money', 'LIVE FUNDS'], ['money', 'LIVE FUNDS'], ['money', 'BSV'], ['money', 'TESTNET'], ['money', 'LIVE FUNDS'], ['money', 'LIVE FUNDS'], ['money', 'BSV']]);
  for (const c of cases) { assert.ok(c.who?.startsWith('BSV \u203a ')); assert.equal(c.buttons.length, 2); fits({ title: c.title, message: c.message, detail: c.detail, buttons: [...c.buttons], defaultId: 0, cancelId: 0, tone: c.tone, toneTag: c.toneTag, who: c.who, facts: c.facts, items: c.items, windowDetail: c.windowDetail }); }
  assert.ok(cases[0]!.facts!.length === 5 && cases[0]!.facts![0]!.label === 'Per transaction (mainnet limit)');
  assert.match(cases[0]!.windowDetail!, /mainnet limits above/);
  assert.match(cases[0]!.detail, /mainnet limits below/, 'the system dialog keeps its own order and words');
});

test('a page that dies while it is being drawn goes to the fallback; every step is timed, so the lock is never held for ever', () => {
  assert.match(win, /else if \(phase === 'loading'\) pageDied\(/);
  assert.match(win, /await prepareConfirm\(\{[\s\S]*died, stepMs: LOAD_MS, totalMs: 2 \* LOAD_MS/);
  assert.match(win, /size: \(\) => settleConfirmFit\(/, 'the size measure is one of the timed steps');
  assert.doesNotMatch(win, /await settleConfirmFit|await wc\.executeJavaScript|await win\.loadFile/, 'no untimed wait on the page');
});
