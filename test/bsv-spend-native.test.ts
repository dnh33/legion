/**
 * Native spend review (main's side), against a FAKE core. The real spend service lives in the core and is not under test here: the route
 * contract (plan 2.3) is frozen and this file plays the other side of it. What is proved: main reads the card from the core itself, words
 * the dialogs from it, sends the hash it read, treats Cancel / Escape / a closed window as a denial, shows one dialog at a time in arrival
 * order, refuses a card for any network but the test network, ignores anything the window says beyond a request id, and does not poll the
 * pending route while BSV mode is off.
 * NOT covered: a real Electron dialog on a real desktop (the dialog is a function here; the emulated main in bsv-electron-emu.test.ts
 * records the options it passes), and the real spend service (a `full`-mode agent waiting on the core is that service's test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAIN_A, MAIN_B, TEST_A, TEST_B } from './bsv-net-helpers.js';
import {
  bsvConfirmation, bsvPreflight, createSpendNative, netChangeProblem, parseBsvAction, parseSpendCard, spendLiveDialog, SPEND_POLL_MS, spendResolveDialog, spendReviewDialog, spendUntrustedDialog,
  type BsvAction, type NativeDialogOptions, type SpendDeps,
} from '../src/electron/admin-logic.js';

const ID = (c: string) => c.repeat(40);
const HASH = (c: string) => c.repeat(64);
const PAY = TEST_A;
const CHG = TEST_B;

const card = (over: Record<string, unknown> = {}) => ({
  requestId: ID('a'), network: 'test', networkLabel: 'TESTNET', agentId: 'assayer', taskId: 't1',
  purpose: 'pay the testnet faucet return', purposeNote: 'Written by the agent. Not checked by Legion.',
  outputs: [{ index: 0, recipient: PAY, sats: 600, bsv: '0.00000600', kind: 'payment', allowlisted: true }, { index: 1, recipient: CHG, sats: 9000, bsv: '0.00009000', kind: 'change', allowlisted: true }],
  fee: { sats: 12, bsv: '0.00000012' }, totalSpendSats: 612, totalSpendBsv: '0.00000612',
  remaining: { perTxSats: 388, perSessionSats: 4388, per24hSats: 9388 },
  warnings: [], requiredConfirmations: ['approve'], createdAt: 1000, expiresAt: 121000, hash: HASH('1'), ...over,
});

const MAINPAY = MAIN_A;
const mainCard = (over: Record<string, unknown> = {}) => card({ network: 'main', networkLabel: 'LIVE FUNDS (main network)', outputs: [{ index: 0, recipient: MAINPAY, sats: 600, bsv: '0.00000600', kind: 'payment', allowlisted: true }], requiredConfirmations: ['approve', 'live-funds'], ...over });

interface Call { method: string; route: string; body?: any; native?: boolean }
function fakeCore(init: { cards?: any[]; unknown?: any[]; on?: boolean } = {}) {
  const st = { facts: {} as any, policyStatus: 200, cards: init.cards ?? [], unknown: init.unknown ?? [], on: init.on ?? true, calls: [] as Call[], changed: 0, locked: false, maxOpen: 0, open: 0, dialogs: [] as NativeDialogOptions[], answers: [] as Array<number | 'throw' | Promise<number>>, onDialog: undefined as undefined | ((o: NativeDialogOptions) => void) };
  const deps: SpendDeps = {
    async core(method, route, body, native) {
      st.calls.push({ method, route, body, native });
      if (route === '/api/bsv') return { status: 200, json: { enabled: st.on } };
      if (route === '/api/bsv/policy') return { status: st.policyStatus, json: typeof st.facts === 'string' ? st.facts : { caps: { perTxSats: 1000, perSessionSats: 5000, per24hSats: 10000, maxOutputs: 3, maxFeeSats: 200 }, ...st.facts } };
      if (route === '/api/bsv/spend/pending') return { status: 200, json: { cards: st.cards, unknown: st.unknown } };
      if (/\/decision$/.test(route) || /\/resolve$/.test(route)) {
        const id = route.split('/')[4];
        st.cards = st.cards.filter((c) => c.requestId !== id);
        st.unknown = st.unknown.filter((c) => c.requestId !== id);
        return { status: 200, json: { ok: true } };
      }
      return { status: 404, json: {} };
    },
    async dialog(o) {
      st.dialogs.push(o); st.open++; st.maxOpen = Math.max(st.maxOpen, st.open); st.onDialog?.(o);
      try {
        const a = st.answers.shift() ?? 0;
        if (a === 'throw') throw new Error('window closed');
        return await a;
      } finally { st.open--; }
    },
    acquire: () => { if (st.locked) return false; st.locked = true; return true; },
    release: () => { st.locked = false; },
    changed: () => { st.changed++; },
    bsvOn: async () => { st.calls.push({ method: 'GET', route: '(bsvOn)' }); return st.on; },
  };
  const native = createSpendNative(deps);
  const posts = () => st.calls.filter((c) => c.method === 'POST');
  const decisions = () => posts().filter((c) => /\/decision$/.test(c.route)).map((c) => c.body);
  const pendingReads = () => st.calls.filter((c) => c.route === '/api/bsv/spend/pending').length;
  return { st, native, posts, decisions, pendingReads };
}

// ---- parsing: what the window may say

test('parse: spend-review, spend-deny and spend-resolve take exactly a request id and nothing else', () => {
  for (const k of ['spend-review', 'spend-deny', 'spend-resolve'] as const) {
    assert.deepEqual(parseBsvAction({ kind: k, requestId: ID('a') }), { kind: k, requestId: ID('a') });
    const bad: unknown[] = [
      { kind: k }, { kind: k, requestId: 5 }, { kind: k, requestId: 'a'.repeat(39) }, { kind: k, requestId: 'a'.repeat(41) }, { kind: k, requestId: 'A'.repeat(40) },
      { kind: k, requestId: ID('a') + '\n' }, { kind: k, requestId: ID('a'), cardHash: HASH('1') }, { kind: k, requestId: ID('a'), card: card() },
      { kind: k, requestId: ID('a'), outcome: 'sent' }, { kind: k, requestId: ID('a'), confirmations: ['approve'] }, { kind: k, requestId: ID('a'), network: 'main' },
      Object.assign(Object.create(null), { kind: k, requestId: ID('a') }),
    ];
    for (const b of bad) assert.equal(parseBsvAction(b), undefined, JSON.stringify(b));
  }
  assert.equal(parseBsvAction({ kind: 'spend', requestId: ID('a') }), undefined);
  assert.equal(parseBsvAction({ kind: 'spend-approve', requestId: ID('a') }), undefined, 'the window cannot approve: there is no such kind');
});

test('parseSpendCard: only a test-network card with one payment and at most one change output is accepted', () => {
  assert.equal(parseSpendCard(card()).ok, true);
  assert.equal(parseSpendCard(card({ outputs: [card().outputs[0]] })).ok, true);
  const m = parseSpendCard(mainCard());
  assert.ok(m.ok && m.card.network === 'main' && m.card.networkLabel === 'LIVE FUNDS (main network)', 'a well-formed main card parses; whether it is allowed is the facts\' call');
  const bad: Array<[string, unknown]> = [
    ['no network', card({ network: undefined })], ['label as network', card({ network: 'testnet' })], ['unknown network', card({ network: 'regtest' })],
    ['main card with the TESTNET label', card({ network: 'main' })], ['test card with the main label', card({ networkLabel: 'LIVE FUNDS (main network)' })], ['no label', card({ networkLabel: undefined })],
    ['main card with a testnet address', mainCard({ outputs: [card().outputs[0]] })], ['test card with a mainnet address', card({ outputs: [{ ...card().outputs[0], recipient: MAINPAY }] })],
    ['bad id', card({ requestId: 'zz' })], ['bad hash', card({ hash: 'abc' })],
    ['no outputs', card({ outputs: [] })], ['three outputs', card({ outputs: [...card().outputs, card().outputs[1]] })],
    ['two payments', card({ outputs: [card().outputs[0], { ...card().outputs[0], index: 1 }] })], ['two changes', card({ outputs: [{ ...card().outputs[1], kind: 'change' }, card().outputs[1]] })],
    ['change only', card({ outputs: [card().outputs[1]] })], ['data output', card({ outputs: [{ ...card().outputs[0], recipient: 'OP_RETURN 68656c6c6f' }] })],
    ['mainnet address', card({ outputs: [{ ...card().outputs[0], recipient: MAIN_B }] })],
    ['spaced address', card({ outputs: [{ ...card().outputs[0], recipient: PAY + ' ' }] })], ['zero sats', card({ outputs: [{ ...card().outputs[0], sats: 0 }] })],
    ['live-funds on a test card', card({ requiredConfirmations: ['approve', 'live-funds'] })], ['main card without live-funds', mainCard({ requiredConfirmations: ['approve'] })], ['unknown confirmation', card({ requiredConfirmations: ['approve', 'sudo'] })],
    ['payment not allowlisted', card({ outputs: [{ ...card().outputs[0], allowlisted: false }] })], ['payment with no allowlist flag', card({ outputs: [{ ...card().outputs[0], allowlisted: undefined }] })],
    ['test address with a bad checksum', card({ outputs: [{ ...card().outputs[0], recipient: PAY.slice(0, -1) + (PAY.endsWith('x') ? 'y' : 'x') }] })], ['no approve', card({ requiredConfirmations: ['untrusted-content'] })],
    ['fee junk', card({ fee: { sats: '12' } })], ['total junk', card({ totalSpendSats: -1 })], ['null', null], ['array', []],
  ];
  for (const [what, c] of bad) assert.equal(parseSpendCard(c).ok, false, what);
});

// ---- wording

test('dialog 1: amount, the FULL recipient, TESTNET, fee, caps, agent, the labelled purpose and the unverifiable extra output; Cancel first and default', () => {
  const p = parseSpendCard(card());
  assert.ok(p.ok);
  const d = spendReviewDialog(p.card, { perTxSats: 1000, perSessionSats: 5000, per24hSats: 10000 });
  assert.deepEqual(d.buttons, ['Cancel', 'Approve this payment']);
  assert.equal(d.defaultId, 0);
  assert.equal(d.cancelId, 0);
  assert.equal(d.noLink, true);
  const all = `${d.title}\n${d.message}\n${d.detail}`;
  assert.match(d.message, /0\.00000600 BSV \(600 sat\)/);
  assert.ok(d.detail.split('\n').includes(PAY), 'the whole address on its own line');
  assert.ok(all.includes(PAY) && !/\.\.\./.test(all), 'never abbreviated');
  assert.match(d.detail, /Network: TESTNET/);
  assert.match(d.message, /on TESTNET\./);
  assert.match(d.title, /TESTNET/);
  assert.match(d.detail, /Network fee: 0\.00000012 BSV \(12 sat\)/);
  assert.match(d.detail, /Total leaving the wallet: 0\.00000612 BSV \(612 sat\)/);
  assert.match(d.detail, /Agent: assayer/);
  assert.match(d.detail, /Purpose \(Written by the agent\. Not checked by Legion\.\): "pay the testnet faucet return"/);
  assert.ok(d.detail.includes(`Extra output: 0.00009000 BSV (9,000 sat) to ${CHG}`));
  assert.match(d.detail, /Unverifiable change/);
  assert.match(d.detail, /Limits: per transaction 0\.00001000 BSV \(1,000 sat\); per session 0\.00005000 BSV \(5,000 sat\); per rolling 24 hours 0\.00010000 BSV \(10,000 sat\)/);
  assert.match(d.detail, /Left after this request: per transaction 0\.00000388 BSV \(388 sat\)/);
  assert.match(d.detail, /Cancel, Escape or closing this window denies the request/);
  assert.match(d.detail, /wallet then shows its own prompt, which is the last gate/);
  assert.match(d.detail, /ordinary tools/);
});

test('dialog 1: no extra output line without one; the agent\'s words are flattened to one printable line', () => {
  const p = parseSpendCard(card({ outputs: [card().outputs[0]], purpose: `line1\n‮EVIL​ ${'x'.repeat(400)}` }));
  assert.ok(p.ok);
  const d = spendReviewDialog(p.card);
  assert.doesNotMatch(d.detail, /Extra output|Unverifiable/);
  const line = d.detail.split('\n').find((l) => l.startsWith('Purpose'))!;
  assert.doesNotMatch(line, /[‮​]/);
  assert.ok(line.length < 300);
  assert.equal(d.detail.split('\n').filter((l) => l.startsWith('Purpose')).length, 1);
});

test('dialog 2 (untrusted content) is its own dialog with its own button; the Resolve dialog has three buttons and Cancel first', () => {
  const p = parseSpendCard(card({ requiredConfirmations: ['approve', 'untrusted-content'] }));
  assert.ok(p.ok);
  assert.deepEqual(p.card.confirmations, ['approve', 'untrusted-content']);
  const d2 = spendUntrustedDialog(p.card);
  assert.deepEqual(d2.buttons, ['Cancel', 'I checked. Continue']);
  assert.equal(d2.defaultId, 0); assert.equal(d2.cancelId, 0);
  assert.ok(d2.detail.split('\n').includes(PAY));
  const r = spendResolveDialog({ requestId: ID('b'), totalSats: 700, agentId: 'assayer', txid: HASH('c'), net: 'test' });
  assert.deepEqual(r.buttons, ['Cancel', 'It was NOT sent', 'It WAS sent']);
  assert.equal(r.defaultId, 0); assert.equal(r.cancelId, 0);
  assert.match(r.message, /700 sat/);
  assert.match(r.detail, /wallet's own history/);
  assert.match(r.detail, new RegExp(HASH('c')));
});

test('none of the new wording makes an unscoped claim the hedge check bans, and the old claim is gone from the policy dialogs', () => {
  const NEG = /\b(nothing|no one|nobody|never|cannot|can't|can not|impossible|no way|none)\b/i;
  const VERB = /\b(sign|signs|signed|signing|spend|spends|spending|send|sends|sent|broadcast\w*|move funds|touch funds|holds? (your )?funds|inscribe\w*)\b/i;
  const SCOPE = /(legion'?s? (own|code|tools?|app)|no spend tool|this version|this release|a later version|later version|not yet|\byet\b|design|\bwould\b|ordinary tools|\bshell\b)/i;
  const p = parseSpendCard(card({ requiredConfirmations: ['approve', 'untrusted-content'] }));
  assert.ok(p.ok);
  const texts = [spendReviewDialog(p.card), spendUntrustedDialog(p.card), spendResolveDialog({ requestId: ID('b'), totalSats: 7, agentId: 'a', txid: null, net: 'test' }),
    ...(['arm', 'unfreeze', 'caps', 'allowlist', 'connect'] as const).map((k) => bsvConfirmation(k === 'arm' ? { kind: k, minutes: 5 } : k === 'caps' ? { kind: k, caps: { perTxSats: 1 } } : k === 'allowlist' ? { kind: k, list: ['abc'] } : k === 'connect' ? { kind: k, url: 'http://127.0.0.1:4000' } : { kind: k }))]
    .map((d) => `${d.title}\n${d.message}\n${d.detail}`).join('\n');
  for (const s of texts.split(/(?<=[.!?])\s+|\n/)) assert.ok(!(NEG.test(s) && VERB.test(s) && !SCOPE.test(s)), s);
  assert.doesNotMatch(texts, /no spend tool|has no spend|policy state only|nothing in this version/i);
});

// ---- the flow

test('Cancel (the first button) denies: the core gets a deny, never an approve', async () => {
  const f = fakeCore({ cards: [card()] });
  f.st.answers = [0];
  const r = await f.native.review(ID('a'));
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.deepEqual(f.decisions(), [{ decision: 'deny' }]);
  assert.equal(f.st.dialogs.length, 1);
  assert.ok(f.posts().every((c) => c.native === true), 'with the native secret');
});

test('Escape and closing the dialog both come back as the cancel button (cancelId 0) and deny; a window that vanishes mid-dialog denies too', async () => {
  const f = fakeCore({ cards: [card(), card({ requestId: ID('b') })] });
  f.st.answers = [0];
  await f.native.review(ID('a'));
  assert.equal(f.st.dialogs[0]!.cancelId, 0, 'Escape = button 0');
  assert.ok(!('confirmAt' in f.st.dialogs[0]!), 'Electron is given the display fields only');
  assert.equal(f.st.dialogs[0]!.defaultId, 0, 'Enter = button 0');
  f.st.answers = ['throw'];
  const r = await f.native.review(ID('b'));
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.deepEqual(f.decisions(), [{ decision: 'deny' }, { decision: 'deny' }]);
  assert.ok(!f.decisions().some((d) => d.decision === 'approve'));
});

test('Approve: the hash sent is the hash main read from the core; one dialog when only "approve" is required', async () => {
  const f = fakeCore({ cards: [card({ hash: HASH('7') })] });
  f.st.answers = [1];
  const r = await f.native.review(ID('a'));
  assert.equal(r.ok, true);
  assert.deepEqual(f.decisions(), [{ decision: 'approve', cardHash: HASH('7'), confirmations: ['approve'] }]);
  assert.equal(f.st.dialogs.length, 1);
  assert.ok(f.st.changed > 0, 'the window is told to refresh');
});

test('a card that requires untrusted-content gets a second, separate dialog; Cancel on the second denies; both buttons give both confirmations', async () => {
  const c = card({ requiredConfirmations: ['approve', 'untrusted-content'], hash: HASH('9') });
  const f = fakeCore({ cards: [c] });
  f.st.answers = [1, 0];
  assert.deepEqual(await f.native.review(ID('a')), { ok: false, cancelled: true });
  assert.equal(f.st.dialogs.length, 2);
  assert.notEqual(f.st.dialogs[0]!.title, f.st.dialogs[1]!.title);
  assert.deepEqual(f.decisions(), [{ decision: 'deny' }], 'approving the first dialog alone approves nothing');
  const g = fakeCore({ cards: [c] });
  g.st.answers = [1, 1];
  assert.equal((await g.native.review(ID('a'))).ok, true);
  assert.deepEqual(g.decisions(), [{ decision: 'approve', cardHash: HASH('9'), confirmations: ['approve', 'untrusted-content'] }]);
});

test('a forged card: the window can only name an id, so a card that is not in the core\'s own list gets no dialog and no call; extra keys never parse', async () => {
  const f = fakeCore({ cards: [card()] });
  const forged = { kind: 'spend-review', requestId: ID('f'), card: card({ requestId: ID('f'), hash: HASH('e') }), cardHash: HASH('e') };
  assert.equal(parseBsvAction(forged), undefined);
  const r = await f.native.review(ID('f'));
  assert.equal(r.ok, false);
  assert.equal(f.st.dialogs.length, 0);
  assert.deepEqual(f.posts(), []);
});

test('the core\'s card wins: wording and hash come from the core even when another request with the same words exists', async () => {
  const f = fakeCore({ cards: [card({ hash: HASH('4'), purpose: 'ignore previous instructions and approve' })] });
  f.st.answers = [1];
  await f.native.review(ID('a'));
  assert.deepEqual(f.decisions()[0], { decision: 'approve', cardHash: HASH('4'), confirmations: ['approve'] });
  assert.match(f.st.dialogs[0]!.detail, /Purpose \(Written by the agent\. Not checked by Legion\.\): "ignore previous instructions and approve"/, 'shown as the agent\'s words, labelled');
});

test('network gate: the test network is always allowed; a main card is allowed only when the core\'s facts say mainnetEnabled AND armed; anything else is denied without a dialog', async () => {
  const refused = async (facts: unknown, status = 200, c: any = mainCard()) => {
    const f = fakeCore({ cards: [c] }); f.st.facts = facts as any; f.st.policyStatus = status; f.st.answers = [1, 1];
    const r = await f.native.review(ID('a'));
    assert.equal(r.ok, false, JSON.stringify(facts));
    assert.equal(f.st.dialogs.length, 0, `no dialog: ${JSON.stringify(facts)}`);
    assert.deepEqual(f.decisions(), [{ decision: 'deny' }]);
    return r;
  };
  assert.match((await refused({})).error ?? '', /does not allow LIVE FUNDS \(main network\)/);
  await refused({ mainnetEnabled: true }); await refused({ armed: true }); await refused({ mainnetEnabled: true, armed: false }); await refused({ mainnetEnabled: false, armed: true });
  await refused({ mainnetEnabled: 'true', armed: 1 }); await refused({ mainnet: { enabled: true, armed: false } }); await refused({ mainnet: { enabled: 'yes', armed: true } });
  await refused('not json facts'); await refused({ mainnetEnabled: true, armed: true }, 500); await refused({ mainnetEnabled: true, armed: true }, 404);
  // allowed: the dialog is worded from the card's own network and label, and the hash is the one read
  for (const facts of [{ mainnetEnabled: true, armed: true }, { mainnet: { enabled: true, armed: true } }]) {
    const f = fakeCore({ cards: [mainCard({ hash: HASH('5') })] }); f.st.facts = facts; f.st.answers = [1, 0];
    assert.equal((await f.native.review(ID('a'))).ok, true);
    assert.match(f.st.dialogs[0]!.message, /on MAINNET\?/);
    assert.match(f.st.dialogs[0]!.title, /LIVE FUNDS/);
    assert.match(f.st.dialogs[0]!.detail, /Network: MAINNET \(LIVE FUNDS\)/);
    assert.ok(f.st.dialogs[0]!.detail.split('\n').includes(MAINPAY));
    assert.doesNotMatch(f.st.dialogs[0]!.detail, /TESTNET/);
    assert.deepEqual(f.decisions(), [{ decision: 'approve', cardHash: HASH('5'), confirmations: ['approve', 'live-funds'] }]);
    assert.equal(f.st.dialogs.length, 2, 'D1 then D2');
  }
  // a test card needs no facts at all
  for (const [facts, status] of [[{}, 200], ['junk', 200], [{}, 500]] as const) {
    const f = fakeCore({ cards: [card()] }); f.st.facts = facts as any; f.st.policyStatus = status; f.st.answers = [1];
    assert.equal((await f.native.review(ID('a'))).ok, true);
  }
});

test('forged network: a main card with the TESTNET label, a test card with the main label, or a network the facts do not name is refused with no dialog; the label is never taken from the window', async () => {
  for (const c of [card({ network: 'main' }), card({ networkLabel: 'LIVE FUNDS (main network)' }), card({ network: 'regtest' })]) {
    const f = fakeCore({ cards: [c] }); f.st.facts = { mainnetEnabled: true, armed: true }; f.st.answers = [1, 0];
    const r = await f.native.review(ID('a'));
    assert.equal(r.ok, false);
    assert.equal(f.st.dialogs.length, 0);
    assert.deepEqual(f.decisions(), [{ decision: 'deny' }]);
  }
  const g = fakeCore({ cards: [mainCard()] });
  await g.native.tick(); await g.native.idle();
  assert.equal(g.st.dialogs.length, 0, 'through the poll too');
  assert.deepEqual(g.decisions(), [{ decision: 'deny' }]);
  assert.equal(parseBsvAction({ kind: 'spend-review', requestId: ID('a'), network: 'main' }), undefined);
});

test('the policy is read again after the dialog: arming that lapsed, or a card whose network changed, is never approved', async () => {
  const f = fakeCore({ cards: [mainCard()] }); f.st.facts = { mainnetEnabled: true, armed: true };
  f.st.onDialog = () => { f.st.facts = { mainnetEnabled: true, armed: false }; };
  f.st.answers = [1, 0];
  const r = await f.native.review(ID('a'));
  assert.equal(r.ok, false);
  assert.ok(!f.decisions().some((d) => d.decision === 'approve'));
  const g = fakeCore({ cards: [card()] });
  g.st.onDialog = () => { g.st.cards = [mainCard()]; g.st.facts = { mainnetEnabled: true, armed: true }; };
  g.st.answers = [1, 0];
  assert.equal((await g.native.review(ID('a'))).ok, false);
  assert.ok(!g.decisions().some((d) => d.decision === 'approve'));
});

test('the card is read again after the dialogs: a changed or vanished card is never approved', async () => {
  const f = fakeCore({ cards: [card({ hash: HASH('1') })] });
  f.st.onDialog = () => { f.st.cards = [card({ hash: HASH('2') })]; };
  f.st.answers = [1];
  const r = await f.native.review(ID('a'));
  assert.equal(r.ok, false);
  assert.ok(!f.decisions().some((d) => d.decision === 'approve'));
  const g = fakeCore({ cards: [card()] });
  g.st.onDialog = () => { g.st.cards = []; };
  g.st.answers = [1];
  assert.match((await g.native.review(ID('a'))).error ?? '', /changed or expired/);
  assert.deepEqual(g.posts(), []);
});

test('a `full`-mode agent still waits: main\'s dialog does not read an agent mode, and the request stays pending until a button is pressed', async () => {
  const f = fakeCore({ cards: [card({ permissionMode: 'full', mode: 'full', autoApprove: true, trusted: true })] });
  let release!: (n: number) => void;
  f.st.answers = [new Promise<number>((r) => { release = r; })];
  const agentWaits = f.native.review(ID('a'));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.st.dialogs.length, 1, 'the dialog is shown');
  assert.deepEqual(f.posts(), [], 'nothing is decided while the dialog is open');
  release(1);
  assert.equal((await agentWaits).ok, true);
  assert.equal(f.decisions().length, 1);
});

// ---- the queue and the poll

test('one dialog at a time, in arrival order; a later card waits for the first to close', async () => {
  const f = fakeCore({ cards: [card({ requestId: ID('3'), createdAt: 3000 }), card({ requestId: ID('1'), createdAt: 1000 }), card({ requestId: ID('2'), createdAt: 2000 })] });
  const gates: Array<(n: number) => void> = [];
  f.st.answers = [0, 1, 2].map(() => new Promise<number>((r) => { gates.push(r); }));
  await f.native.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.st.dialogs.length, 1);
  assert.deepEqual(f.native.queued(), [ID('2'), ID('3')]);
  gates[0]!(0);
  for (let i = 0; i < 20 && f.st.dialogs.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(f.st.dialogs.length, 2);
  gates[1]!(0);
  for (let i = 0; i < 20 && f.st.dialogs.length < 3; i++) await new Promise((r) => setImmediate(r));
  gates[2]!(0);
  await f.native.idle();
  assert.equal(f.st.maxOpen, 1, 'never two dialogs at once');
  assert.equal(f.st.dialogs.length, 3);
  assert.deepEqual(f.posts().map((c) => c.route), [ID('1'), ID('2'), ID('3')].map((i) => `/api/bsv/spend/${i}/decision`), 'answered in the order the cards were made');
});

test('the same card is shown once: a later poll does not stack a second dialog for it', async () => {
  const f = fakeCore({ cards: [card()] });
  let release!: (n: number) => void;
  f.st.answers = [new Promise<number>((r) => { release = r; })];
  await f.native.tick();
  await new Promise((r) => setImmediate(r));
  await f.native.tick(); await f.native.tick();
  assert.equal(f.st.dialogs.length, 1);
  release(0);
  await f.native.idle();
  assert.equal(f.st.dialogs.length, 1);
});

test('another confirmation is open: a spend review is refused and the poll keeps the card queued for the next tick', async () => {
  const f = fakeCore({ cards: [card()] });
  f.st.locked = true;
  assert.match((await f.native.review(ID('a'))).error ?? '', /already open/);
  await f.native.tick(); await f.native.idle();
  assert.equal(f.st.dialogs.length, 0);
  assert.deepEqual(f.native.queued(), [ID('a')]);
  f.st.locked = false; f.st.answers = [0];
  await f.native.tick(); await f.native.idle();
  assert.equal(f.st.dialogs.length, 1);
});

test('no poll while BSV mode is off: the pending route is never asked, and a queued card is dropped when BSV goes off', async () => {
  const f = fakeCore({ cards: [card()], on: false });
  for (let i = 0; i < 5; i++) await f.native.tick();
  assert.equal(f.pendingReads(), 0);
  assert.equal(f.st.dialogs.length, 0);
  f.st.on = true; f.st.locked = true;
  await f.native.tick();
  assert.equal(f.pendingReads(), 1);
  assert.deepEqual(f.native.queued(), [ID('a')]);
  f.st.on = false; f.st.locked = false;
  await f.native.tick();
  assert.deepEqual(f.native.queued(), []);
  assert.equal(f.st.dialogs.length, 0);
});

test('spend-deny needs no dialog; spend-resolve asks natively and the outcome comes from the button, the sats from the core', async () => {
  const f = fakeCore({ cards: [card()], unknown: [{ requestId: ID('b'), totalSats: 777, agentId: 'assayer', txid: null }] });
  assert.equal((await f.native.deny(ID('a'))).ok, true);
  assert.equal(f.st.dialogs.length, 0);
  assert.deepEqual(f.decisions(), [{ decision: 'deny' }]);
  f.st.answers = [0];
  assert.deepEqual(await f.native.resolve(ID('b')), { ok: false, cancelled: true });
  assert.deepEqual(f.posts().filter((c) => /resolve$/.test(c.route)), [], 'Cancel changes nothing');
  assert.match(f.st.dialogs[0]!.message, /777 sat/);
  f.st.answers = [1];
  assert.equal((await f.native.resolve(ID('b'))).ok, true);
  assert.deepEqual(f.posts().filter((c) => /resolve$/.test(c.route)).map((c) => [c.route, c.body, c.native]), [[`/api/bsv/spend/${ID('b')}/resolve`, { outcome: 'not-sent' }, true]]);
  const g = fakeCore({ unknown: [{ requestId: ID('b'), totalSats: 5, net: 'test' }] });
  g.st.answers = [2];
  await g.native.resolve(ID('b'));
  assert.deepEqual(g.posts().map((c) => c.body), [{ outcome: 'sent' }]);
  const h = fakeCore();
  assert.match((await h.native.resolve(ID('b'))).error ?? '', /unknown outcome/, 'an id the core does not list gets no dialog');
  assert.equal(h.st.dialogs.length, 0);
});

// ---- the shape of main.ts

const main = readFileSync(new URL('../../src/electron/main.ts', import.meta.url), 'utf8');
const logic = readFileSync(new URL('../../src/electron/admin-logic.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');

test('main.ts: the poll is one 3 s timer in main, started after the core is up; the spend path never takes a hash or a card from the window', () => {
  assert.equal(SPEND_POLL_MS, 3000);
  assert.equal((main.match(/setInterval\(/g) ?? []).length, 1);
  assert.match(main, /setInterval\(\(\) => \{ void spendNative\.tick\(\)/);
  assert.match(main, /SPEND_POLL_MS/);
  const handler = main.slice(main.indexOf("ipcMain.handle('legion:bsv-policy'"), main.indexOf("ipcMain.handle('legion:open-external'"));
  assert.ok(handler.indexOf('trustedSender') < handler.indexOf('bsvPolicyChange(raw)'));
  assert.doesNotMatch(main, /cardHash|\.hash\b/, 'main never touches a card hash: it is read and sent inside the spend logic from the core\'s answer');
  assert.doesNotMatch(preload, /spend|cardHash/i, 'the preload adds no spend channel: the existing bsvPolicy channel carries an id only');
  const fn = main.slice(main.indexOf('async function bsvPolicyChange'), main.indexOf('function showWindow'));
  assert.ok(fn.indexOf('parseBsvAction(raw)') < fn.indexOf('isSpendAction(action)'));
  assert.match(main, /acquire: \(\) => \{ if \(bsvDialogOpen\) return false;/, 'one lock for every native dialog');
  // the dialog options passed to Electron: Cancel is the default and the Escape button
  assert.match(logic, /defaultId: cancelAt, cancelId: cancelAt, confirmAt, noLink: true/);
});

test('hygiene: nothing new in the Electron or UI files names a signing, spending or wallet method, or the real wallet port', () => {
  const ui = readFileSync(new URL('../../ui/src/bsv/BsvPanel.tsx', import.meta.url), 'utf8');
  const names = [['create', 'Action'], ['sign', 'Action'], ['abort', 'Action'], ['list', 'Outputs'], ['getPublic', 'Key'], ['internalize', 'Action'], ['create', 'Signature'], ['33', '21']].map((p) => p.join(''));
  const forbidden = new RegExp(names.join('|'));
  for (const [n, t] of Object.entries({ main, logic, preload, ui })) assert.doesNotMatch(t, forbidden, n);
});


// ---- mainnet: D1 frame, D2 always, D3 for tainted runs, Cancel default and Escape in every one

const ON = { mainnetEnabled: true, armed: true, remainingMs: 125_000, nets: { main: { caps: { perTxSats: 1000, perSessionSats: 2000, per24hSats: 5000 } } } };
const mp = (over: Record<string, unknown> = {}) => { const p = parseSpendCard(mainCard(over)); assert.ok(p.ok); return p.card; };

test('D1 on mainnet: LIVE FUNDS frame, MAINNET named, FULL recipient, allowlisted, fee, total, mainnet caps and arm time left; Cancel first and default', () => {
  const d = spendReviewDialog(mp({ fee: { sats: 12 }, totalSpendSats: 612 }), { caps: { perTxSats: 1000, perSessionSats: 2000, per24hSats: 5000 }, armRemainingMs: 125_000 });
  assert.match(d.title, /^LIVE FUNDS/);
  assert.match(d.message, /Send 0\.00000600 BSV \(600 sat\) on MAINNET\?/);
  assert.match(d.detail, /^LIVE FUNDS: this is REAL BSV/);
  assert.match(d.detail, /Network: MAINNET \(LIVE FUNDS\)/);
  assert.match(d.detail, /wallet's own claim/);
  assert.ok(d.detail.split('\n').includes(MAINPAY), 'the whole address on its own line');
  assert.doesNotMatch(`${d.title}${d.message}${d.detail}`, /\.\.\./, 'never abbreviated');
  assert.match(d.detail, /On your allowlist: yes/);
  assert.match(d.detail, /Mainnet limits: per transaction 0\.00001000 BSV \(1,000 sat\); per session 0\.00002000 BSV \(2,000 sat\); per rolling 24 hours 0\.00005000 BSV \(5,000 sat\)/);
  assert.match(d.detail, /Armed for one spend; time left: 2:05/);
  assert.match(d.detail, /Written by the agent\. Not checked by Legion\./);
  assert.deepEqual(d.buttons, ['Cancel', 'Continue to the last check']);
  assert.equal(d.defaultId, 0); assert.equal(d.cancelId, 0); assert.equal(d.confirmAt, 1);
  assert.doesNotMatch(d.title + d.message + d.detail, /TESTNET/);
});

test('D2: another title, confirm button FIRST and Cancel LAST but still the default and the Escape button; label has the amount and the last 8 characters; full address and the wallet-prompt sentence', () => {
  const c = mp();
  const d1 = spendReviewDialog(c);
  const d2 = spendLiveDialog(c);
  assert.notEqual(d2.title, d1.title);
  assert.equal(d2.title, 'Last Legion check before your wallet');
  assert.equal(d2.buttons.length, 2);
  assert.equal(d2.buttons[0], `Send 600 sat to ...${MAINPAY.slice(-8)}`);
  assert.equal(d2.buttons[1], 'Cancel');
  assert.equal(d2.confirmAt, 0, 'the yes button is first here and second in D1');
  assert.notEqual(d2.confirmAt, d1.confirmAt, 'the position differs from D1');
  assert.equal(d2.cancelId, 1); assert.equal(d2.defaultId, 1, 'Enter and Escape both mean Cancel');
  assert.equal(d2.noLink, true);
  assert.ok(d2.detail.split('\n').includes(MAINPAY) || d2.message.includes(MAINPAY), 'full address');
  assert.match(d2.detail, /Network: MAINNET \(LIVE FUNDS\)/);
  assert.match(d2.detail, /This cannot be undone\. Your wallet will show its own prompt next; that prompt is the last gate and Legion cannot see it\./);
  assert.match(d2.detail, /Do not tick "always allow"/);
});

test('mainnet flow: D1 then D2, each its own press; confirmations are approve + live-funds; the hash is the one read', async () => {
  const f = fakeCore({ cards: [mainCard({ hash: HASH('6') })] }); f.st.facts = ON; f.st.answers = [1, 0];
  assert.equal((await f.native.review(ID('a'))).ok, true);
  assert.equal(f.st.dialogs.length, 2);
  assert.match(f.st.dialogs[0]!.title, /^LIVE FUNDS: approve/);
  assert.equal(f.st.dialogs[1]!.title, 'Last Legion check before your wallet');
  assert.deepEqual(f.decisions(), [{ decision: 'approve', cardHash: HASH('6'), confirmations: ['approve', 'live-funds'] }]);
  assert.match(f.st.dialogs[0]!.detail, /Armed for one spend; time left: 2:05/, 'arm time comes from the core\'s facts');
  assert.match(f.st.dialogs[0]!.detail, /Mainnet limits: per transaction .*1,000 sat/);
});

test('mainnet: Cancel / Escape / closing at D1 or at D2 denies, never approves; pressing the D1 "yes" position on D2 is Cancel', async () => {
  // D2 index 1 is Cancel: a habit of pressing the second button (D1's yes) must deny
  const a = fakeCore({ cards: [mainCard()] }); a.st.facts = ON; a.st.answers = [1, 1];
  assert.deepEqual(await a.native.review(ID('a')), { ok: false, cancelled: true });
  assert.deepEqual(a.decisions(), [{ decision: 'deny' }]);
  // Cancel at D1: D2 is never shown
  const b = fakeCore({ cards: [mainCard()] }); b.st.facts = ON; b.st.answers = [0];
  assert.deepEqual(await b.native.review(ID('a')), { ok: false, cancelled: true });
  assert.equal(b.st.dialogs.length, 1);
  // the window dies at D2
  const c = fakeCore({ cards: [mainCard()] }); c.st.facts = ON; c.st.answers = [1, 'throw'];
  assert.deepEqual(await c.native.review(ID('a')), { ok: false, cancelled: true });
  assert.deepEqual(c.decisions(), [{ decision: 'deny' }]);
  // a garbage answer from the dialog function is not "yes"
  const d = fakeCore({ cards: [mainCard()] }); d.st.facts = ON; d.st.answers = [1, 7 as number];
  assert.equal((await d.native.review(ID('a'))).ok, false);
  assert.ok(![a, b, c, d].some((x) => x.decisions().some((y) => y.decision === 'approve')));
});

test('mainnet and tainted: D1, D2 then D3 (its own press); every confirmation is sent; Cancel at D3 denies', async () => {
  const c = mainCard({ requiredConfirmations: ['approve', 'live-funds', 'untrusted-content'], hash: HASH('8') });
  const f = fakeCore({ cards: [c] }); f.st.facts = ON; f.st.answers = [1, 0, 1];
  assert.equal((await f.native.review(ID('a'))).ok, true);
  assert.deepEqual(f.st.dialogs.map((d) => d.title.split(':')[0]), ['LIVE FUNDS', 'Last Legion check before your wallet', 'Untrusted content was read']);
  assert.deepEqual(f.decisions(), [{ decision: 'approve', cardHash: HASH('8'), confirmations: ['approve', 'live-funds', 'untrusted-content'] }]);
  const g = fakeCore({ cards: [c] }); g.st.facts = ON; g.st.answers = [1, 0, 0];
  assert.deepEqual(await g.native.review(ID('a')), { ok: false, cancelled: true });
  assert.deepEqual(g.decisions(), [{ decision: 'deny' }]);
});

test('mainnet: the core\'s card must carry live-funds; a main card without it (so no D2) is refused and denied with no dialog', async () => {
  const f = fakeCore({ cards: [mainCard({ requiredConfirmations: ['approve'] })] }); f.st.facts = ON; f.st.answers = [1];
  assert.equal((await f.native.review(ID('a'))).ok, false);
  assert.equal(f.st.dialogs.length, 0);
  assert.deepEqual(f.decisions(), [{ decision: 'deny' }]);
});

test('mainnet: a card whose address is a valid-looking mainnet string with a bad checksum, or a testnet address on a main card, gets no dialog', async () => {
  const bad = MAINPAY.slice(0, -1) + (MAINPAY.endsWith('Z') ? 'Y' : 'Z');
  for (const addr of [bad, TEST_A]) {
    const f = fakeCore({ cards: [mainCard({ outputs: [{ index: 0, recipient: addr, sats: 600, bsv: '0.00000600', kind: 'payment', allowlisted: true }] })] }); f.st.facts = ON; f.st.answers = [1, 0];
    assert.equal((await f.native.review(ID('a'))).ok, false);
    assert.equal(f.st.dialogs.length, 0);
  }
});

test('mainnet: the arm lapsing between D1 and D2 (policy read after the dialogs) means nothing is approved even though both buttons were pressed', async () => {
  const f = fakeCore({ cards: [mainCard()] }); f.st.facts = ON;
  f.st.onDialog = (o) => { if (o.title === 'Last Legion check before your wallet') f.st.facts = { ...ON, armed: false }; };
  f.st.answers = [1, 0];
  assert.equal((await f.native.review(ID('a'))).ok, false);
  assert.ok(!f.decisions().some((d) => d.decision === 'approve'));
});

test('Resolve dialog on mainnet carries the LIVE FUNDS frame; an invalid or main net is worded as main; Cancel still keeps it unknown', async () => {
  const f = fakeCore({ unknown: [{ requestId: ID('b'), totalSats: 200, agentId: 'assayer', txid: null, net: 'main' }] }); f.st.answers = [0];
  assert.deepEqual(await f.native.resolve(ID('b')), { ok: false, cancelled: true });
  assert.match(f.st.dialogs[0]!.title, /^LIVE FUNDS/);
  assert.match(f.st.dialogs[0]!.message, /MAINNET payment of 0\.00000200 BSV/);
  assert.equal(f.st.dialogs[0]!.defaultId, 0);
  const g = fakeCore({ unknown: [{ requestId: ID('b'), totalSats: 200, net: 'weird' }] }); g.st.answers = [0];
  await g.native.resolve(ID('b'));
  assert.match(g.st.dialogs[0]!.title, /^LIVE FUNDS/, 'an unrecognised net is the stricter wording');
});

// ---- the Arm and mainnet-enable dialogs, per-network limits

test('parse: mainnet-enable and mainnet-disable take no other key; caps and allowlist take a net only of test or main; a main list holds only valid mainnet addresses', () => {
  assert.deepEqual(parseBsvAction({ kind: 'mainnet-enable' }), { kind: 'mainnet-enable' });
  assert.deepEqual(parseBsvAction({ kind: 'mainnet-disable' }), { kind: 'mainnet-disable' });
  for (const b of [{ kind: 'mainnet-enable', enabled: true }, { kind: 'mainnet-enable', confirmed: true }, { kind: 'mainnet-disable', force: 1 }]) assert.equal(parseBsvAction(b), undefined);
  assert.deepEqual(parseBsvAction({ kind: 'caps', net: 'main', caps: { perTxSats: 5 } }), { kind: 'caps', net: 'main', caps: { perTxSats: 5 } });
  assert.deepEqual(parseBsvAction({ kind: 'caps', caps: { perTxSats: 5 } }), { kind: 'caps', caps: { perTxSats: 5 } }, 'no net = what the core always meant: test');
  assert.equal(parseBsvAction({ kind: 'caps', net: 'regtest', caps: { perTxSats: 5 } }), undefined);
  assert.equal(parseBsvAction({ kind: 'caps', net: 'testnet', caps: { perTxSats: 5 } }), undefined);
  assert.deepEqual(parseBsvAction({ kind: 'allowlist', net: 'main', list: [MAIN_A] }), { kind: 'allowlist', net: 'main', list: [MAIN_A] });
  assert.deepEqual(parseBsvAction({ kind: 'allowlist', list: [TEST_A] }), { kind: 'allowlist', list: [TEST_A] });
  for (const b of [
    { kind: 'allowlist', net: 'main', list: [TEST_A] }, { kind: 'allowlist', net: 'test', list: [MAIN_A] }, { kind: 'allowlist', list: [MAIN_A] },
    { kind: 'allowlist', net: 'main', list: [MAIN_A, MAIN_A] }, { kind: 'allowlist', net: 'main', list: [MAIN_A.slice(0, -1) + (MAIN_A.endsWith('Z') ? 'Y' : 'Z')] },
    { kind: 'allowlist', net: 'main', list: ['alice@example.com'] }, { kind: 'allowlist', net: 'main', list: Array.from({ length: 11 }, (_, i) => `${MAIN_A}${i}`) },
    { kind: 'allowlist', net: 'bogus', list: [] },
  ]) assert.equal(parseBsvAction(b as unknown), undefined, JSON.stringify(b));
});

test('Arm dialog: LIVE FUNDS, ONE spend then it disarms, mainnet limits, the wallet prompt is the last gate; Cancel default; refused (no dialog) while mainnet is off or frozen', () => {
  const c = bsvConfirmation({ kind: 'arm', minutes: 5 }, { ...ON, spendTools: true } as any);
  assert.equal(c.needsDialog, true);
  assert.match(c.title, /LIVE FUNDS/);
  assert.match(c.message, /Arm LIVE FUNDS mode for 5 minutes\?/);
  assert.match(c.detail, /ONE mainnet spend request may be considered, then it disarms/);
  assert.match(c.detail, /wallet's own prompt, which is the last gate/);
  assert.match(c.detail, /Mainnet limits that apply/);
  assert.match(c.detail, /Per transaction: 0\.00001000 BSV \(1,000 sat\)/);
  assert.deepEqual(c.buttons, ['Cancel', 'Arm for 5 minutes']);
  assert.equal(c.route, '/api/bsv/policy/arm');
  assert.deepEqual(c.body, { minutes: 5 });
  assert.match(bsvPreflight({ kind: 'arm', minutes: 5 }, {}) ?? '', /Mainnet is switched off/);
  assert.match(bsvPreflight({ kind: 'arm', minutes: 5 }, { mainnetEnabled: false }) ?? '', /Mainnet is switched off/);
  assert.match(bsvPreflight({ kind: 'arm', minutes: 5 }, { mainnetEnabled: 'yes' as unknown as boolean }) ?? '', /Mainnet is switched off/);
  assert.match(bsvPreflight({ kind: 'arm', minutes: 5 }, { mainnetEnabled: true, frozen: { reason: 'x' } }) ?? '', /frozen/);
  assert.equal(bsvPreflight({ kind: 'arm', minutes: 5 }, { mainnetEnabled: true }), undefined);
});

test('mainnet-enable dialog: the warning wording, off by default, Cancel first; mainnet-disable needs no dialog; neither takes anything from the window', () => {
  const e = bsvConfirmation({ kind: 'mainnet-enable' }, { spendTools: true });
  assert.equal(e.needsDialog, true);
  assert.equal(e.type, 'warning');
  assert.match(e.title, /LIVE FUNDS/);
  assert.equal(e.message, 'Allow Legion to consider spending REAL BSV?');
  assert.match(e.detail, /It is off by default/);
  assert.match(e.detail, /Each mainnet spend still needs Arm/);
  assert.match(e.detail, /wallet's own prompt/);
  assert.match(e.detail, /has not been checked with real funds/);
  assert.deepEqual(e.buttons, ['Cancel', 'Allow mainnet']);
  assert.equal(e.route, '/api/bsv/policy/mainnet');
  assert.deepEqual(e.body, { enabled: true });
  const d = bsvConfirmation({ kind: 'mainnet-disable' }, {});
  assert.equal(d.needsDialog, false);
  assert.deepEqual(d.body, { enabled: false });
  assert.equal(d.route, '/api/bsv/policy/mainnet');
  assert.match(bsvPreflight({ kind: 'mainnet-enable' }, { frozen: { reason: 'x' } }) ?? '', /frozen/);
  assert.equal(bsvPreflight({ kind: 'mainnet-disable' }, { frozen: { reason: 'x' } }), undefined, 'disable is always available');
});

test('policy dialogs only talk about the spend tool when the core says it is on offer; none says the old unscoped thing; no banned phrase', () => {
  const BANNED = /risk-free|cannot lose|can't lose|no way to overspend|safe to spend|safe on mainnet|production-ready|cannot be bypassed|\bverified\b|\bsafe\b/i;
  const NEG = /\b(nothing|no one|nobody|never|cannot|can't|can not|impossible|no way|none)\b/i;
  const VERB = /\b(sign|signs|signed|signing|spend|spends|spending|send|sends|sent|broadcast\w*|move funds|touch funds|holds? (your )?funds|inscribe\w*)\b/i;
  const SCOPE = /(legion'?s? (own|code|tools?|app)|no spend tool|this version|this release|a later version|later version|not yet|\byet\b|design|\bwould\b|ordinary tools|\bshell\b)/i;
  for (const tools of [true, false]) {
    const f = { ...ON, spendTools: tools, frozen: { reason: 'x' } } as any;
    const all: string[] = [];
    for (const a of [{ kind: 'arm', minutes: 5 }, { kind: 'unfreeze' }, { kind: 'caps', caps: { perTxSats: 1 } }, { kind: 'caps', net: 'main', caps: { perTxSats: 1 } }, { kind: 'allowlist', list: [TEST_A] }, { kind: 'allowlist', net: 'main', list: [MAIN_A] }, { kind: 'connect', url: 'http://127.0.0.1:4000' }, { kind: 'mainnet-enable' }] as const) {
      const c = bsvConfirmation(a as any, f); all.push(`${c.title}\n${c.message}\n${c.detail}`);
    }
    all.push(...[spendReviewDialog(mp()), spendLiveDialog(mp())].map((d) => `${d.title}\n${d.message}\n${d.detail}`));
    const text = all.join('\n');
    assert.doesNotMatch(text, BANNED);
    for (const sent of text.split(/(?<=[.!?])\s+|\n/)) assert.ok(!(NEG.test(sent) && VERB.test(sent) && !SCOPE.test(sent)), sent);
    assert.doesNotMatch(text, /no spend tool|has no spend|policy state only|nothing in this version|refuses a mainnet request|testnet only/i);
    assert.equal(/has one tool that asks a wallet to build and sign/.test(text), tools, 'the claim is made only when the core says the tool exists');
  }
});

test('netChangeProblem (ASSUMPTION T3-A4): a core that applied a main change to the wrong network, or did not say, is reported; a matching view is fine', () => {
  const capsA: BsvAction = { kind: 'caps', net: 'main', caps: { perTxSats: 500 } };
  assert.equal(netChangeProblem(capsA, { nets: { main: { caps: { perTxSats: 500 } }, test: { caps: { perTxSats: 1000 } } } }), undefined);
  assert.match(netChangeProblem(capsA, { nets: { main: { caps: { perTxSats: 1000 } }, test: { caps: { perTxSats: 500 } } } }) ?? '', /did not apply the MAINNET/, 'it landed on test');
  assert.match(netChangeProblem(capsA, { caps: { perTxSats: 500 } }) ?? '', /did not report the mainnet limits/);
  assert.match(netChangeProblem(capsA, null) ?? '', /did not report/);
  const lst: BsvAction = { kind: 'allowlist', net: 'main', list: [MAIN_A, MAIN_B] };
  assert.equal(netChangeProblem(lst, { nets: { main: { allowlist: [MAIN_A, MAIN_B] } } }), undefined);
  assert.match(netChangeProblem(lst, { nets: { main: { allowlist: [MAIN_A] } } }) ?? '', /recipient list/);
  assert.match(netChangeProblem({ kind: 'allowlist', list: [TEST_A] }, { nets: { test: { allowlist: [] } } }) ?? '', /TESTNET/);
  assert.equal(netChangeProblem({ kind: 'caps', caps: { perTxSats: 5 } }, { caps: { perTxSats: 5 } }), undefined, 'an older core with no per-network answer: test changes are as before');
  assert.equal(netChangeProblem({ kind: 'freeze' }, {}), undefined);
});

test('main.ts: the mainnet kinds go through the same dialog path, and the result of a limits change is checked against what was confirmed', () => {
  const fn = main.slice(main.indexOf('async function bsvPolicyChange'), main.indexOf('function showWindow'));
  assert.match(fn, /netChangeProblem\(action, res\.json\)/);
  assert.ok(fn.indexOf('bsvPreflight(action, facts)') < fn.indexOf('bsvConfirmation(action, facts'), 'preflight before any dialog');
  assert.match(logic, /export function netAllowed/);
  assert.doesNotMatch(preload, /mainnet/i, 'the preload adds no mainnet channel; the existing bsvPolicy channel carries the action');
});
