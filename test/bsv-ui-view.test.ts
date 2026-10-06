/**
 * The BSV UI's decisions (src/shared/bsv-view.ts), and source guards for the performance rules of the BSV UI:
 * no continuous animation, no timer faster than once a minute except the armed countdown, policy changes only through the app bridge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BSV_POLL_MS, MAINNET_ON_SENTENCE, MAINNET_SENTENCE, auditLine, formatCountdown, heightText, overlayModel, mainnetState, netRows, remainingMs, safeLine, shouldPoll, spendModel, walletHeadline,
  type AuditView, type PolicyView, type WalletView,
} from '../src/shared/bsv-view.js';
import type { WalletStatus } from '../src/core/bsv/wallet-probe.js';
import type { BsvPolicyView } from '../src/core/bsv/index.js';
import type { AuditEntry } from '../src/core/bsv/audit.js';

// compile-time: the shared view types accept what the core really sends
const _w = (x: WalletStatus): WalletView => x;
const _p = (x: BsvPolicyView): PolicyView => x;
const _a = (x: AuditEntry): AuditView => x;
void _w; void _p; void _a;

const NOW = 1_800_000_000_000;
const caps = { perTxSats: 1000, perSessionSats: 5000, per24hSats: 10000, maxOutputs: 3, maxFeeSats: 200 };
const policy = (over: Partial<PolicyView> = {}): PolicyView => ({
  frozen: null, armed: false, armedUntil: null, caps, hardCaps: caps, allowlist: [], usage: { sessionSats: 0, last24hSats: 0, reservedSats: 0 },
  pending: [], unknown: [], network: 'testnet', nativeAvailable: true, spendTools: false, armChoicesMinutes: [5, 15, 30, 60], audit: { ok: true, entries: 3 }, ...over,
});
const wallet = (over: Partial<WalletView> = {}): WalletView => ({
  probed: true, connected: true, reachable: true, authenticated: true, network: 'test', version: '1.2.3', height: 1234567, checkedAt: '2026-10-02T00:00:00.000Z', url: '127.0.0.1:45001', condition: 'testnet', message: 'm', ...over,
});
const model = (over: Partial<Parameters<typeof overlayModel>[0]> = {}) => overlayModel({ enabled: true, policy: policy(), wallet: wallet(), nodes: 157, knowledgeLoaded: true, now: NOW, ...over });

test('formatCountdown: whole seconds, rounded up, never negative', () => {
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(1), '00:01');
  assert.equal(formatCountdown(59_001), '01:00');
  assert.equal(formatCountdown(15 * 60_000), '15:00');
  assert.equal(formatCountdown(60 * 60_000), '1:00:00');
  assert.equal(formatCountdown(-5), '00:00');
  assert.equal(formatCountdown(NaN), '00:00');
  assert.equal(formatCountdown(Infinity), '00:00');
});

test('remainingMs: zero unless armed with a future end', () => {
  assert.equal(remainingMs(null, NOW), 0);
  assert.equal(remainingMs({ armed: false, armedUntil: NOW + 5000 }, NOW), 0);
  assert.equal(remainingMs({ armed: true, armedUntil: null }, NOW), 0);
  assert.equal(remainingMs({ armed: true, armedUntil: NOW - 1 }, NOW), 0);
  assert.equal(remainingMs({ armed: true, armedUntil: NOW + 5000 }, NOW), 5000);
});

test('heightText: a plain count only', () => {
  assert.equal(heightText(1234567), '1,234,567');
  assert.equal(heightText(0), '0');
  for (const x of [null, undefined, -1, 1.5, NaN, '5', Infinity, 2 ** 60]) assert.equal(heightText(x), '', String(x));
});

test('overlay: off when BSV mode is off, whatever the policy says', () => {
  const m = model({ enabled: false, policy: policy({ armed: true, armedUntil: NOW + 5000 }) });
  assert.deepEqual([m.mode, m.showFreeze, m.pill, m.tiers.length], ['off', false, null, 0]);
});

test('overlay: testnet shows the network and the block height only when a testnet wallet gave one, else the node count', () => {
  const a = model();
  assert.equal(a.mode, 'testnet');
  assert.deepEqual(a.tiers[0], ['TESTNET · knowledge mode', 'block 1,234,567']);
  assert.equal(a.pill, null);
  assert.equal(a.showFreeze, false);
  assert.deepEqual(model({ wallet: wallet({ condition: 'not-detected', reachable: false, height: null }) }).tiers[0], ['TESTNET · knowledge mode', '157 BSV notes']);
  assert.deepEqual(model({ wallet: null, knowledgeLoaded: false, nodes: null }).tiers[0], ['TESTNET · knowledge mode', 'BSV notes: unknown'], 'an unreadable count is unknown, not hidden and not 0');
  assert.deepEqual(model({ wallet: wallet({ condition: 'unknown-network', network: 'unknown' }) }).tiers[0], ['TESTNET · knowledge mode', '157 BSV notes'], 'no height from a wallet that did not say testnet');
  assert.equal(model().tiers.at(-1)![0], 'TESTNET', 'the shortest tier is still honest');
});

test('overlay: armed shows the amber state, the pill and the Freeze button; an expired arming does not', () => {
  const m = model({ policy: policy({ armed: true, armedUntil: NOW + 60_000 }) });
  assert.equal(m.mode, 'armed');
  assert.equal(m.showFreeze, true);
  assert.equal(m.pill?.kind, 'armed');
  assert.deepEqual(m.tiers[0], ['LIVE FUNDS ARMED', 'one mainnet spend']);
  const gone = model({ policy: policy({ armed: true, armedUntil: NOW - 1 }) });
  assert.equal(gone.mode, 'testnet');
  assert.equal(gone.showFreeze, false);
  assert.equal(gone.pill, null);
});

test('overlay: Freeze chain is visible whenever something is armed or pending, and never when frozen or idle', () => {
  const pend = model({ policy: policy({ pending: [{ requestId: 'r1', totalSats: 5 }] }) });
  assert.equal(pend.showFreeze, true);
  assert.equal(pend.pill?.kind, 'pending');
  const frozen = model({ policy: policy({ frozen: { reason: 'x' }, armed: true, armedUntil: NOW + 5000, pending: [{ requestId: 'r1', totalSats: 5 }] }) });
  assert.equal(frozen.mode, 'frozen');
  assert.equal(frozen.showFreeze, false);
  assert.equal(frozen.pill?.kind, 'frozen');
  assert.equal(model({ policy: null }).showFreeze, false);
  assert.equal(model().showFreeze, false);
});

test('overlay: a wallet on mainnet while Legion is on testnet is a warning with the exact sentence, not an armed state and not an amber frame', () => {
  const m = model({ wallet: wallet({ condition: 'mainnet-warning', network: 'main' }) });
  assert.equal(m.mode, 'testnet');
  assert.equal(m.mainnetWarning, true);
  assert.equal(m.pill?.kind, 'mainnet');
  assert.equal(m.pill?.text, 'The wallet is on MAINNET; Legion is in testnet knowledge mode; Legion will not use it.');
  assert.equal(m.showFreeze, false);
  assert.deepEqual(m.tiers[0], ['WALLET ON MAINNET', 'Legion stays on testnet']);
  // armed wins the pill, and the warning flag stays set so the panel still shows it
  const both = model({ wallet: wallet({ condition: 'mainnet-warning', network: 'main' }), policy: policy({ armed: true, armedUntil: NOW + 60_000 }) });
  assert.equal(both.mode, 'armed');
  assert.equal(both.mainnetWarning, true);
});

test('walletHeadline: honest wording for every condition, and the wallet\'s words are cleaned', () => {
  assert.match(walletHeadline(null, false), /off/);
  assert.match(walletHeadline(null, true), /Not connected.*has not contacted any wallet/);
  assert.match(walletHeadline(wallet({ probed: false, connected: false, condition: 'not-configured' }), true), /No wallet address is set.*press Connect.*contacts nothing/);
  assert.match(walletHeadline(wallet({ probed: false, connected: false, condition: 'not-connected' }), true), /Not connected.*until you press Connect/);
  assert.match(walletHeadline(wallet({ condition: 'mainnet-warning' }), true), /^MAINNET: The wallet is on MAINNET; Legion is in testnet knowledge mode; Legion will not use it\./);
  assert.match(walletHeadline(wallet(), true), /testnet wallet, version 1\.2\.3, block 1,234,567.*own claim/);
  assert.match(walletHeadline(wallet({ authenticated: false }), true), /not signed in/);
  assert.match(walletHeadline(wallet({ condition: 'unknown-network' }), true), /will not use it/);
  assert.match(walletHeadline(wallet({ condition: 'rejected-url' }), true), /not a loopback/);
  assert.match(walletHeadline(wallet({ condition: 'not-detected', reachable: false }), true), /No wallet answered/);
  const evil = walletHeadline(wallet({ version: `1.0${String.fromCharCode(10, 0x202e)}<script>alert(1)</script>` }), true);
  assert.ok(!evil.includes(String.fromCharCode(0x202e)) && !evil.includes('\n'));
});

test('audit lines: text from the log is one clean line, the time is ISO', () => {
  const e: AuditView = { seq: 7, ts: '2026-10-02T02:24:07.123Z', agent: `legion${String.fromCharCode(10)}forged line`, task: null, tool: 'policy', decision: 'frozen', reason: 'x'.repeat(500), fields: {} };
  const l = auditLine(e);
  assert.equal(l.when, '2026-10-02 02:24:07Z');
  assert.ok(!l.who.includes('\n'));
  assert.ok(l.why.length <= 240);
  assert.equal(l.what, 'policy: frozen');
  assert.equal(auditLine({ ...e, ts: 'not a date\u0000' }).when, 'not a date');
  assert.equal(safeLine(undefined), '');
  assert.equal(safeLine({}), '');
});

test('polling: only while visible AND focused, and never more than once a minute', () => {
  assert.equal(BSV_POLL_MS, 60_000);
  const base = { hidden: false, focused: true, lastPollAt: NOW - 61_000, now: NOW };
  assert.equal(shouldPoll(base), true);
  assert.equal(shouldPoll({ ...base, hidden: true }), false);
  assert.equal(shouldPoll({ ...base, focused: false }), false);
  assert.equal(shouldPoll({ ...base, lastPollAt: NOW - 59_000 }), false);
  assert.equal(shouldPoll({ ...base, lastPollAt: NOW }), false);
});

// ---------------------------------------------------------------- source guards (the performance and trust rules)

const UI = new URL('../../ui/src/bsv/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, UI), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('perf: the BSV stylesheet has no keyframes, no animation and nothing infinite', () => {
  const css = stripComments(read('bsv.css'));
  assert.doesNotMatch(css, /@keyframes|animation|infinite|steps\(/i);
  // the only transitions left are the short hover and toggle ones on the title-bar switch
  for (const m of css.matchAll(/([^{}]+)\{[^}]*transition[^}]*\}/g)) assert.match(m[1]!, /\.tb-bsv/, `transition outside the switch: ${m[1]}`);
});

test('perf: no requestAnimationFrame, no CSS animation class, and the only timers are the 60 s poll and the armed countdown', () => {
  const files = readdirSync(UI).filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.length >= 4);
  let intervals = 0;
  for (const f of files) {
    const src = stripComments(read(f));
    assert.doesNotMatch(src, /requestAnimationFrame|\.animate\(|animationName|setTimeout\(\s*\w+\s*,\s*\d{1,3}\s*\)\s*;?\s*\}\s*,\s*\d+/, f);
    for (const m of src.matchAll(/setInterval\(/g)) { intervals++; void m; }
  }
  assert.equal(intervals, 2, 'bsvStore (poll) and ChainOverlay (countdown) only');
  const store = stripComments(read('bsvStore.ts'));
  assert.match(store, /window\.setInterval\(\(\) => \{ if \(due\(\)\) void loadBsv\(\); \}, BSV_POLL_MS\)/);
  const overlay = stripComments(read('ChainOverlay.tsx'));
  assert.match(overlay, /window\.setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
  assert.match(overlay, /if \(!document\.hidden && document\.hasFocus\(\)\) id = window\.setInterval/, 'the countdown ticks only while visible and focused');
  assert.ok(!/<Countdown/.test(overlay.replace(/\{model\.pill\.kind === 'armed' && <Countdown until=\{policy\?\.armedUntil \?\? null\} \/>\}/, '')), 'the countdown is mounted only while armed');
});

test('trust: the UI changes policy only through the app bridge; it never names the native header or a policy-changing route', () => {
  const walk = (dir: URL, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(e.name + '/', dir), out); else if (/\.tsx?$/.test(e.name)) out.push(fileURLToPath(new URL(e.name, dir))); // not .pathname: that is "/D:/..." on Windows
    }
    return out;
  };
  for (const f of walk(new URL('../../ui/src/', import.meta.url))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    assert.doesNotMatch(src, /X-Legion-Native|x-legion-native/i, f);
    assert.doesNotMatch(src, /\/api\/bsv\/policy\/(arm|disarm|freeze|unfreeze|caps|allowlist)/, f);
  }
  assert.match(read('bsvStore.ts'), /window\.legion\?\.bsvPolicy/);
});

test('trust: the panel scopes its claims to Legion\'s own code, says testnet spends need a native dialog, and never offers a spend, send or sign button', () => {
  const panel = read('BsvPanel.tsx');
  assert.doesNotMatch(panel, /has no spend tool/);
  assert.match(panel, /Legion&apos;s own code|Legion\\'s own code/);
  assert.match(panel, /Review&hellip;/);
  assert.match(panel, /Resolve&hellip;/);
  assert.match(panel, /ordinary tools/);
  assert.doesNotMatch(stripComments(panel), />\s*(Send|Spend|Sign|Pay|Broadcast|Inscribe)\b/i);
});

const ID1 = 'a'.repeat(40);
const ID2 = 'b'.repeat(40);

test('spend view: spendTools is a boolean; pending and unknown requests are listed with a short id and the sats, never an address', () => {
  const on = spendModel(policy({ spendTools: true, pending: [{ requestId: ID1, totalSats: 612 }], unknown: [{ requestId: ID2, totalSats: 1000 }] }));
  assert.match(on.headline, /one tool that can ask your wallet to build and sign a payment: on the test network after your confirmation, and on the main network only while mainnet is switched on and armed/);
  assert.match(on.headline, /native confirmation/);
  assert.deepEqual(on.pending, [{ requestId: ID1, label: 'Request aaaaaaaa: 612 sat waiting for your answer' }]);
  assert.equal(on.unknown.length, 1);
  assert.match(on.unknown[0]!.label, /outcome unknown/);
  assert.match(on.unknown[0]!.label, /1,000 sat/);
  const off = spendModel(policy({ spendTools: false }));
  assert.match(off.headline, /not available/);
  assert.deepEqual([off.pending, off.unknown], [[], []]);
  for (const bad of [Number.NaN, -5, 1.5, Number.MAX_SAFE_INTEGER + 2]) assert.match(spendModel(policy({ pending: [{ requestId: ID1, totalSats: bad }] })).pending[0]!.label, /: 0 sat waiting/);
  assert.doesNotMatch(spendModel(policy({ pending: [{ requestId: 'x<script>'.padEnd(40, 'z'), totalSats: 1 }] })).pending[0]!.label, /[<>]/);
});

test('overlay: an unknown outcome shows its own pill (no Freeze button), and it ranks above a pending request', () => {
  const m = model({ policy: policy({ unknown: [{ requestId: ID2, totalSats: 5 }], pending: [{ requestId: ID1, totalSats: 5 }] }) });
  assert.equal(m.pill?.kind, 'unknown');
  assert.match(m.pill?.text ?? '', /1 request with an unknown outcome/);
  assert.equal(m.showFreeze, false);
  assert.equal(model({ policy: policy({ pending: [{ requestId: ID1, totalSats: 5 }] }) }).pill?.kind, 'pending');
  assert.equal(model({ policy: policy({ frozen: { reason: 'x' }, unknown: [{ requestId: ID2, totalSats: 5 }] }) }).pill?.kind, 'frozen');
});

test('perf: the spend section adds no timer, no animation and no request of its own; requests are named to main by id only', () => {
  const whole = stripComments(read('BsvPanel.tsx'));
  const panel = whole.slice(whole.indexOf('function SpendSection'), whole.indexOf('function LimitsSection'));
  assert.ok(panel.length > 500);
  assert.doesNotMatch(panel, /setInterval|setTimeout|requestAnimationFrame|useEffect/);
  assert.doesNotMatch(panel, /request<[^>]*>\('(GET|POST)', '\/api\/bsv\/spend/);
  assert.match(panel, /changePolicy\(\{ kind: 'spend-review', requestId: r\.requestId \}\)/);
  assert.match(panel, /changePolicy\(\{ kind: 'spend-deny', requestId: r\.requestId \}\)/);
  assert.match(panel, /changePolicy\(\{ kind: 'spend-resolve', requestId: r\.requestId \}\)/);
  assert.doesNotMatch(panel, /cardHash|X-Legion/);
  for (const f of readdirSync(UI).filter((n) => /\.tsx?$/.test(n))) assert.doesNotMatch(stripComments(read(f)), /\/api\/bsv\/spend\//, `${f}: the window never calls the spend routes`);
});

test('mainnet view state: absent means off; both fields must be exactly true to read as armed; nothing is built on it yet', () => {
  assert.deepEqual(mainnetState(null), { enabled: false, armed: false });
  assert.deepEqual(mainnetState(policy()), { enabled: false, armed: false });
  assert.deepEqual(mainnetState(policy({ mainnet: { enabled: false, armed: true } })), { enabled: false, armed: false });
  assert.deepEqual(mainnetState(policy({ mainnet: { enabled: true, armed: false } })), { enabled: true, armed: false });
  assert.deepEqual(mainnetState(policy({ mainnet: { enabled: true, armed: true } })), { enabled: true, armed: true });
  assert.deepEqual(mainnetState(policy({ mainnet: { enabled: 'yes', armed: true } as never })), { enabled: false, armed: false });
  assert.doesNotMatch(readFileSync(new URL('../../src/shared/bsv-view.ts', import.meta.url), 'utf8'), /network: 'testnet'/, 'the view type no longer hard-codes the network');
});

test('mainnet state from the core\'s own shape: mainnetEnabled exactly true; armed needs the switch on; a conflicting nested field cannot turn it on', () => {
  assert.deepEqual(mainnetState(policy({ mainnetEnabled: true, armed: true })), { enabled: true, armed: true });
  assert.deepEqual(mainnetState(policy({ mainnetEnabled: true, armed: false })), { enabled: true, armed: false });
  assert.deepEqual(mainnetState(policy({ mainnetEnabled: false, armed: true })), { enabled: false, armed: false }, 'armed without the switch reads as off');
  assert.deepEqual(mainnetState(policy({ mainnetEnabled: 'true' as never, armed: true })), { enabled: false, armed: false });
  assert.deepEqual(mainnetState(policy({ mainnetEnabled: false, mainnet: { enabled: true, armed: true } })), { enabled: false, armed: false });
});

test('netRows: the test row always; a main row only when the core reports mainnet limits; the two never share numbers', () => {
  const a = netRows(policy());
  assert.deepEqual(a.map((r) => r.net), ['test'], 'an older core: no invented mainnet row');
  const mc = { ...caps, perTxSats: 7 };
  const b = netRows(policy({ nets: { test: { caps, allowlist: ['t'] }, main: { caps: mc, allowlist: [] } } }));
  assert.deepEqual(b.map((r) => [r.net, r.label, r.caps.perTxSats]), [['test', 'TESTNET', caps.perTxSats], ['main', 'MAINNET (LIVE FUNDS)', 7]]);
  assert.deepEqual(b[0]!.allowlist, ['t']); assert.deepEqual(b[1]!.allowlist, []);
});

test('overlay: mainnet switched on but not armed shows MAINNET ON; a wallet on mainnet with the switch on does not say Legion will not use it; with the switch off the old sentence stays', () => {
  const on = model({ policy: policy({ mainnetEnabled: true }) });
  assert.deepEqual(on.tiers[0], ['MAINNET ON', 'not armed']);
  assert.equal(on.showFreeze, false);
  const w = wallet({ condition: 'mainnet-warning', network: 'main' });
  assert.equal(model({ wallet: w, policy: policy({ mainnetEnabled: true }) }).pill?.text, MAINNET_ON_SENTENCE);
  assert.equal(model({ wallet: w, policy: policy() }).pill?.text, MAINNET_SENTENCE);
  assert.doesNotMatch(MAINNET_ON_SENTENCE, /will not use it|cannot|safe|verified/i);
  assert.match(MAINNET_ON_SENTENCE, /Each spend still needs Arm and your confirmations; whether the wallet asks too depends on the wallet/);
});

test('panel: the mainnet switch is off by default in wording, the arm control is disabled without it, and the panel never sends a native header', () => {
  const panel = readFileSync(new URL('../../ui/src/bsv/BsvPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /Mainnet is switched OFF \(the default\)/);
  assert.match(panel, /!p\.frozen \|\| !mn\.enabled/, 'Arm needs the switch');
  assert.match(panel, /kind: 'mainnet-enable'/); assert.match(panel, /kind: 'mainnet-disable'/);
  assert.doesNotMatch(panel, /X-Legion-Native|nativeSecret|\/api\/bsv\/policy/, 'every change goes through the app bridge');
  assert.doesNotMatch(panel, /\bsafe\b|verified with|cannot be bypassed|risk-free|production-ready/i); // ("Log verified" is the audit chain, not funds)
  assert.match(panel, /has not been checked with real funds/);
});

test('spend: a request the wallet has not answered yet is listed as waiting for the wallet, with Cancel (the native Deny path)', () => {
  const m = spendModel({ spendTools: true, pending: [], waiting: [{ requestId: 'abcdef0123456789abcdef', totalSats: 620, network: 'test' }], unknown: [] });
  assert.equal(m.waiting.length, 1);
  assert.match(m.waiting[0]!.label, /620 sat, waiting for your wallet\. It may be asking you for a spending grant: answer it there, or cancel here\./);
  assert.deepEqual(spendModel({ spendTools: true, pending: [], unknown: [] }).waiting, [], 'an older core without the field shows no rows');
  const panel = stripComments(read('BsvPanel.tsx'));
  assert.match(panel, /m\.waiting\.map\(\(r\) => \([\s\S]{0,300}data-spend-waiting=\{r\.requestId\}[\s\S]{0,300}changePolicy\(\{ kind: 'spend-deny', requestId: r\.requestId \}\)\}>Cancel<\/button>/);
});
