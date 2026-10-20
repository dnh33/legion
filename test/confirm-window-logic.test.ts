/** The rules of the Legion confirm window: what a question may ask, how an answer is read, how the window is sized. No electron. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_RE, ADDRESS_TAIL, buildModel, CONFIRM_BUSY, ConfirmBusyError, confirmFit, createAnswerGate, fitConfirm, LIMITS, nativeOptions, orBusy, pickTheme, prepareConfirm, resolveIds, settleConfirmFit, TONE_TAGS, type ConfirmOptions } from '../src/electron/confirm-window-logic.js';

const NONCE = 'a'.repeat(32);
const ctx = { nonce: NONCE, theme: 'dark' as const };
const base: ConfirmOptions = { title: 'Trust this folder?', message: 'Trust it?', detail: 'x', buttons: ['Cancel', 'Trust this folder'], defaultId: 0, cancelId: 0 };
const ok = (o: ConfirmOptions) => { const r = buildModel(o, ctx); assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; model: import('../src/electron/confirm-window-logic.js').ConfirmModel }).model; };
const bad = (o: ConfirmOptions, re?: RegExp) => { const r = buildModel(o, ctx); assert.equal(r.ok, false, 'should be refused'); if (re) assert.match((r as { reason: string }).reason, re); };
const BIDI = String.fromCharCode(0x202e); const ZW = String.fromCharCode(0x200b);

test('a plain question builds: Cancel default, the other button gets the tone colour', () => {
  const m = ok(base);
  assert.deepEqual([m.tone, m.toneTag, m.defaultIndex, m.cancelIndex, m.confirmAt], ['default', '', 0, 0, 1]);
  assert.equal(m.nonce, NONCE);
});

test('buttons: one to four, each a short non-empty text', () => {
  bad({ ...base, buttons: [] }, /1 to 4/);
  bad({ ...base, buttons: ['a', 'b', 'c', 'd', 'e'] }, /1 to 4/);
  ok({ ...base, buttons: ['OK'], defaultId: undefined, cancelId: undefined });
  ok({ ...base, buttons: ['a', 'b', 'c', 'd'], defaultId: 0, cancelId: 0 });
  bad({ ...base, buttons: ['Cancel', ' '] }, /empty/);
  bad({ ...base, buttons: ['Cancel', 'x'.repeat(LIMITS.button + 1)] }, /longer/);
  bad({ ...base, buttons: ['Cancel', 5 as unknown as string] }, /not a text/);
});

test('ids: defaultId and cancelId must be real buttons; unset ids follow Electron (cancel = the button labelled cancel or no, else 0)', () => {
  bad({ ...base, defaultId: 2 }); bad({ ...base, cancelId: -1 }); bad({ ...base, cancelId: 1.5 }); bad({ ...base, defaultId: '0' as unknown as number });
  assert.deepEqual(resolveIds({ buttons: ['Send 5 sat to ...Jd8K', 'Cancel'] }), { defaultIndex: 0, cancelIndex: 1 });
  assert.deepEqual(resolveIds({ buttons: ['Yes', 'No'] }), { defaultIndex: 0, cancelIndex: 1 });
  assert.deepEqual(resolveIds({ buttons: ['Later', 'Now'] }), { defaultIndex: 0, cancelIndex: 0 });
  assert.deepEqual(resolveIds({ buttons: ['A', 'B'], defaultId: 9, cancelId: 9 }), { defaultIndex: 0, cancelIndex: 0 }, 'a bad id is clamped, never an index outside the buttons');
});

test('the BSV last check: the confirm button is FIRST, Cancel is last and is both the default and Escape; the colour is on the first button', () => {
  const m = ok({ ...base, buttons: ['Send 25,000 sat to ...Jd8K', 'Cancel'], defaultId: 1, cancelId: 1, tone: 'money', toneTag: 'LAST CHECK', confirmAt: 0 });
  assert.deepEqual([m.defaultIndex, m.cancelIndex, m.confirmAt], [1, 1, 0]);
  // without confirmAt the same two buttons still colour the one that is not the cancel button
  assert.equal(ok({ ...base, buttons: ['Send', 'Cancel'], defaultId: 1, cancelId: 1 }).confirmAt, 0);
});

test('confirmAt: -1 colours nothing (three answers, no yes); out of range is refused; three buttons colour nothing by default', () => {
  assert.equal(ok({ ...base, buttons: ['Cancel', 'a', 'b'], confirmAt: -1 }).confirmAt, -1);
  assert.equal(ok({ ...base, buttons: ['Cancel', 'a', 'b'] }).confirmAt, -1);
  bad({ ...base, confirmAt: 2 }); bad({ ...base, confirmAt: -2 });
});

test('tone and tag: a whitelist, and a tag only with the tone it belongs to', () => {
  bad({ ...base, tone: 'loud' as unknown as 'danger' }, /unknown tone/);
  bad({ ...base, tone: 'danger', toneTag: 'LIVE FUNDS' }, /tag/);
  bad({ ...base, tone: 'money', toneTag: 'RESTARTS CORE' }, /tag/);
  bad({ ...base, tone: 'default', toneTag: 'BSV' }, /tag/);
  bad({ ...base, tone: 'money', toneTag: '<b>x</b>' }, /tag/);
  for (const [tone, tags] of Object.entries(TONE_TAGS)) for (const t of tags) assert.equal(ok({ ...base, tone: tone as 'danger', toneTag: t }).toneTag, t);
  assert.equal(ok({ ...base, tone: 'money' }).toneTag, 'BSV', 'money with no tag says BSV');
  assert.equal(ok({ ...base, tone: 'danger' }).toneTag, '');
});

test('a tag that the title repeats is not said twice ("LIVE FUNDS: approve ..." under the tag LIVE FUNDS)', () => {
  assert.equal(ok({ ...base, title: 'LIVE FUNDS: approve a MAINNET payment?', tone: 'money', toneTag: 'LIVE FUNDS' }).title, 'Approve a MAINNET payment?');
  assert.equal(ok({ ...base, title: 'Approve a TESTNET payment?', tone: 'money', toneTag: 'TESTNET' }).title, 'Approve a TESTNET payment?');
});

test('length caps refuse; they never cut a question', () => {
  bad({ ...base, title: 'x'.repeat(LIMITS.title + 1) }, /title/);
  bad({ ...base, message: 'x'.repeat(LIMITS.message + 1) }, /message/);
  bad({ ...base, detail: 'x'.repeat(LIMITS.detail + 1) }, /detail/);
  bad({ ...base, who: 'x'.repeat(LIMITS.who + 1) }, /who/);
  bad({ ...base, facts: Array.from({ length: LIMITS.facts + 1 }, () => ({ label: 'a', value: 'b' })) }, /facts/);
  bad({ ...base, facts: [{ label: 'a', value: 'x'.repeat(LIMITS.factValue + 1) }] }, /value/);
  bad({ ...base, items: Array.from({ length: LIMITS.items + 1 }, () => 'a') }, /items/);
  bad({ ...base, items: ['x'.repeat(LIMITS.item + 1)] }, /item/);
  bad({ ...base, amount: 'x'.repeat(LIMITS.amount + 1) }, /amount/);
  ok({ ...base, detail: 'x'.repeat(LIMITS.detail), items: Array.from({ length: LIMITS.items }, () => 'a') });
});

test('an address is plain letters and digits of a sensible length; anything else is refused', () => {
  const a = '1BvMxQ7hN2kpWd3c8TyLr5Ze9FaQm4Jd8K';
  assert.equal(ok({ ...base, address: a }).address, a);
  for (const x of ['', 'short', a + ' ', a.slice(0, 10) + '<i>' + a.slice(10), a + '\n', 'x'.repeat(65)]) { assert.equal(ADDRESS_RE.test(x), false); bad({ ...base, address: x }, /address/); }
});

test('control characters, bidi marks and zero-width marks are blanked; single-line fields lose their newlines; multi-line fields keep them', () => {
  const m = ok({ ...base, title: `Trust${BIDI} this${ZW} folder?\nnow`, detail: `a\r\nb${BIDI}c\n\nd`, who: 'Settings\nGates', facts: [{ label: 'L\n1', value: 'v\r\n2' }] });
  assert.equal(m.title, 'Trust  this  folder? now');
  assert.equal(m.detail, 'a\nb c\n\nd');
  assert.equal(m.who, 'Settings Gates');
  assert.deepEqual(m.facts, [{ label: 'L 1', value: 'v\n2' }]);
});

test('structure comes only from the explicit fields: a detail full of "Key: value" and "- x" lines stays one text, with no facts and no items', () => {
  const detail = 'Folder: D:\\work\\repo\n\n- .claude/settings.json runs a hook before every tool call\n- 3 skills can run scripts: a, b, c\n\nNote: Legion asks again';
  const m = ok({ ...base, detail });
  assert.equal(m.detail, detail);
  assert.deepEqual([m.facts, m.items], [[], []]);
  // and the same text given as items stays exactly its lines, not re-split
  const m2 = ok({ ...base, items: ['Key: value', '- x'], detail: '' });
  assert.deepEqual(m2.items, ['Key: value', '- x']);
});

test('windowMessage / windowDetail replace message / detail in the window only; the system dialog keeps them whole', () => {
  const o: ConfirmOptions = { ...base, message: 'M', detail: 'Now: C:\\old\n\nprose', facts: [{ label: 'Now', value: 'C:\\old' }], windowDetail: 'prose', windowMessage: '' };
  const m = ok(o);
  assert.deepEqual([m.message, m.detail], ['', 'prose']);
  const n = nativeOptions(o);
  assert.deepEqual([n.message, n.detail], ['M', 'Now: C:\\old\n\nprose']);
});

test('nativeOptions: only the fields Electron knows, ids resolved, noLink true', () => {
  const n = nativeOptions({ ...base, type: 'warning', tone: 'money', toneTag: 'LAST CHECK', who: 'x', amount: '5 sat', address: '1BvMxQ7hN2kpWd3c8TyLr5Ze9FaQm4Jd8K', facts: [{ label: 'a', value: 'b' }], items: ['i'], confirmAt: 1, windowDetail: 'w', buttons: ['Go', 'Cancel'], defaultId: 1, cancelId: undefined });
  assert.deepEqual(Object.keys(n).sort(), ['buttons', 'cancelId', 'defaultId', 'detail', 'message', 'noLink', 'title', 'type']);
  assert.deepEqual([n.defaultId, n.cancelId, n.noLink, n.type], [1, 1, true, 'warning']);
});

test('answers: only the right one-time id, a real button, once', () => {
  const g = createAnswerGate(NONCE, 2);
  assert.deepEqual(g.read('Legion'), { kind: 'other' });
  assert.deepEqual(g.read(undefined), { kind: 'other' });
  assert.deepEqual(g.read(42), { kind: 'other' });
  for (const t of ['legion-confirm:', 'legion-confirm:x:1', `legion-confirm:${NONCE.toUpperCase()}:1`, `legion-confirm:${NONCE}`, `legion-confirm:${NONCE}:`, `legion-confirm:${NONCE}:-1`, `legion-confirm:${NONCE}:1.5`, `legion-confirm:${NONCE}:001`, `legion-confirm:${NONCE}:1 `, `legion-confirm:${NONCE}:2`, `legion-confirm:${NONCE}:99`, `legion-confirm:${'b'.repeat(32)}:1`, `legion-confirm:${NONCE}:1:extra`]) {
    assert.equal(g.read(t).kind, 'refused', t);
  }
  assert.deepEqual(g.read(`legion-confirm:${NONCE}:1`), { kind: 'answer', index: 1 });
  // stale: the confirm is answered, a second answer (even a right one) is refused
  assert.equal(g.read(`legion-confirm:${NONCE}:0`).kind, 'refused');
  assert.equal(g.read(`legion-confirm:${NONCE}:1`).kind, 'refused');
});

test('a refused answer does not use up the gate: the real click after a garbage title still counts', () => {
  const g = createAnswerGate(NONCE, 2);
  assert.equal(g.read('legion-confirm:deadbeef:1').kind, 'refused');
  assert.deepEqual(g.read(`legion-confirm:${NONCE}:0`), { kind: 'answer', index: 0 });
});

test('size: 480 CSS pixels wide, as tall as the content, scaled by the zoom, never past the usable area', () => {
  const wa = { width: 1920, height: 1040 };
  assert.deepEqual(confirmFit({ contentHeight: 300, zoom: 1, workArea: wa }), { width: 480, height: 301 });
  assert.deepEqual(confirmFit({ contentHeight: 300, zoom: 1.5, workArea: wa }), { width: 720, height: 451 });
  assert.deepEqual(confirmFit({ contentHeight: 300, zoom: 0.75, workArea: wa }), { width: 360, height: 226 });
  assert.equal(confirmFit({ contentHeight: 5000, zoom: 1, workArea: { width: 1280, height: 720 } }).height, 720, 'never taller than the work area');
  assert.equal(confirmFit({ contentHeight: 300, zoom: 3, workArea: { width: 800, height: 600 } }).width, 800, 'never wider');
  assert.equal(confirmFit({ contentHeight: 10, zoom: 1, workArea: wa }).height, 150, 'a least height');
  assert.deepEqual(confirmFit({ contentHeight: Number.NaN, zoom: Number.NaN, workArea: wa }), { width: 480, height: 150 });
});

test('fitConfirm puts the window over its anchor and inside the screen; settle stops when the size holds', async () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  let b = { x: 0, y: 0, width: 480, height: 320 };
  const w = { isDestroyed: () => false, getBounds: () => b, setBounds: (r: typeof b) => { b = r; }, zoom: () => 1 };
  assert.equal(fitConfirm(w, 400, { x: 100, y: 100, width: 1280, height: 820 }, wa), true);
  assert.deepEqual(b, { x: 100 + 640 - 240, y: 100 + 410 - 200, width: 480, height: 401 });
  assert.equal(fitConfirm(w, 400, { x: 100, y: 100, width: 1280, height: 820 }, wa), false, 'nothing to change');
  // an anchor at the edge is pulled back inside
  b = { x: 0, y: 0, width: 480, height: 320 };
  fitConfirm(w, 400, { x: 1800, y: 1000, width: 100, height: 100 }, wa);
  assert.ok(b.x + b.width <= 1920 && b.y + b.height <= 1040);
  let rounds = 0; const heights = [500, 450, 450];
  await settleConfirmFit(w, async () => heights[rounds++]!, () => ({ x: 0, y: 0, width: 800, height: 600 }), () => wa, async () => undefined);
  assert.equal(rounds, 3, 'measured until the second 450 changed nothing');
  assert.equal(b.height, 451);
});

test('a destroyed window is never touched', async () => {
  let touched = 0;
  const w = { isDestroyed: () => true, getBounds: () => { touched++; return { x: 0, y: 0, width: 1, height: 1 }; }, setBounds: () => { touched++; }, zoom: () => 1 };
  assert.equal(fitConfirm(w, 300, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 800, height: 600 }), false);
  await settleConfirmFit(w, async () => 300, () => ({ x: 0, y: 0, width: 1, height: 1 }), () => ({ x: 0, y: 0, width: 800, height: 600 }), async () => undefined);
  assert.equal(touched, 0);
});

test('theme: only "light" or "dark" from the page counts; anything else follows the system', () => {
  assert.equal(pickTheme('light', true), 'light'); assert.equal(pickTheme('dark', false), 'dark');
  assert.equal(pickTheme('<script>', true), 'dark'); assert.equal(pickTheme(undefined, false), 'light'); assert.equal(pickTheme('LIGHT', true), 'dark'); assert.equal(pickTheme({}, true), 'dark');
});

// ---- a busy window is its own answer, never the person's Cancel ----

test('busy: a question that loses to an open one ends its flow with the "already open" error, not with a cancel', async () => {
  type R = { ok: boolean; error?: string; cancelled?: boolean };
  const lost: R = { ok: false, error: CONFIRM_BUSY };
  assert.equal(CONFIRM_BUSY, 'A confirmation is already open. Answer it first.');
  assert.deepEqual(await orBusy<R>(Promise.reject(new ConfirmBusyError()), lost), lost);
  assert.deepEqual(await orBusy<R>(Promise.resolve({ ok: true }), lost), { ok: true });
  assert.deepEqual(await orBusy<R>(Promise.resolve({ ok: false, cancelled: true }), lost), { ok: false, cancelled: true }, 'a real cancel stays a cancel');
  await assert.rejects(orBusy<R>(Promise.reject(new Error('boom')), lost), /boom/, 'any other failure is not swallowed');
});

// ---- the window can never hold the lock for good ----

const never = <T = never>(): Promise<T> => new Promise<T>(() => undefined);
const steps = (o: Partial<Parameters<typeof prepareConfirm>[0]> = {}): Parameters<typeof prepareConfirm>[0] => ({
  load: async () => undefined, render: async () => undefined, size: async () => undefined, died: never(), stepMs: 40, totalMs: 120, ...o,
});

test('opening: when every step answers, it is done', async () => {
  const order: string[] = [];
  await prepareConfirm(steps({ load: async () => { order.push('load'); }, render: async () => { order.push('render'); }, size: async () => { order.push('size'); } }));
  assert.deepEqual(order, ['load', 'render', 'size']);
});

test('opening: a size measure that never answers ends in an error (so the system dialog takes over), not in a hang', async () => {
  await assert.rejects(prepareConfirm(steps({ size: never })), /sizing the window took longer than 40 ms/);
});

test('opening: a page that never loads or never draws ends in an error', async () => {
  await assert.rejects(prepareConfirm(steps({ load: never })), /loading the page took longer/);
  await assert.rejects(prepareConfirm(steps({ render: never })), /drawing the question took longer/);
});

test('opening: a page that dies while it is being drawn ends at once, whatever step it was in', async () => {
  let kill!: (e: Error) => void;
  const died = new Promise<never>((_, rej) => { kill = rej; });
  const t0 = Date.now();
  const run = prepareConfirm(steps({ died, size: never, stepMs: 5000, totalMs: 10_000 }));
  setTimeout(() => kill(new Error('the page stopped (crashed)')), 10);
  await assert.rejects(run, /the page stopped \(crashed\)/);
  assert.ok(Date.now() - t0 < 1000, 'it did not wait for a timeout');
});

test('opening: a watchdog ends the whole opening even when each step is within its own time', async () => {
  const slow = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
  await assert.rejects(prepareConfirm(steps({ load: slow(60), render: slow(60), size: slow(60), stepMs: 2000, totalMs: 120 })), /opening the window took longer than 120 ms/);
});

test('opening: no timer is left running after it ends', async () => {
  const before = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await prepareConfirm(steps({ stepMs: 5000, totalMs: 10_000 }));
  await assert.rejects(prepareConfirm(steps({ size: never, stepMs: 20, totalMs: 10_000 })));
  const slow = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
  await assert.rejects(prepareConfirm(steps({ load: slow(40), render: slow(40), size: slow(40), stepMs: 5000, totalMs: 60 })), /opening the window/);
  await new Promise((r) => setTimeout(r, 150)); // the slow steps of the aborted opening have run out by now
  await new Promise((r) => setImmediate(r));
  const after = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.ok(after <= before, `timers left running: ${after - before}`);
});

test('address tail: one constant (8) is in every model that has an address, for the button and the marking alike', () => {
  assert.equal(ADDRESS_TAIL, 8);
  const a = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
  assert.equal(ok({ ...base, address: a }).addressTail, ADDRESS_TAIL);
  assert.equal(ok(base).addressTail, ADDRESS_TAIL, 'it is always there; the page marks only when there is an address');
});

test('opening: once the page has died (or the opening has failed) no later step is started on it', async () => {
  const called: string[] = [];
  let kill!: (e: Error) => void;
  const died = new Promise<never>((_, rej) => { kill = rej; });
  const run = prepareConfirm(steps({ died, load: () => new Promise<void>((r) => setTimeout(r, 60)), render: async () => { called.push('render'); }, size: async () => { called.push('size'); }, stepMs: 5000, totalMs: 10_000 }));
  setTimeout(() => kill(new Error('the page stopped')), 10);
  await assert.rejects(run, /the page stopped/);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(called, [], 'render and size were never started on a dead page');
});
