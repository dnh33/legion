/** The rules of the Legion confirm card: what a question may ask, how an answer is read, how the card is laid over the Legion window. No electron. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_RE, ADDRESS_TAIL, bringForward, buildModel, CONFIRM_BUSY, ConfirmBusyError, createAnswerGate, LIMITS, nativeOptions, orBusy, overlayBounds, overlayZoom, pickTheme, prepareConfirm, resolveIds, syncOverlay, TONE_TAGS, type ConfirmOptions } from '../src/electron/confirm-window-logic.js';

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

test('overlay bounds: the whole content area of the Legion window, from its top left corner, whatever the window is doing', () => {
  assert.deepEqual(overlayBounds([1280, 820]), { x: 0, y: 0, width: 1280, height: 820 });
  assert.deepEqual(overlayBounds([960, 600]), { x: 0, y: 0, width: 960, height: 600 });
  assert.deepEqual(overlayBounds([1279.6, 819.2]), { x: 0, y: 0, width: 1280, height: 820 }, 'a fractional content area rounds up so no strip of the app stays uncovered');
  assert.deepEqual(overlayBounds([Number.NaN, -5]), { x: 0, y: 0, width: 1, height: 1 }, 'a bad size never gives a negative or empty view');
  assert.deepEqual(overlayBounds([]), { x: 0, y: 0, width: 1, height: 1 });
});

test('overlay zoom follows the Legion window, clamped; nonsense is 1', () => {
  assert.equal(overlayZoom(1.5), 1.5); assert.equal(overlayZoom(0.75), 0.75);
  assert.equal(overlayZoom(9), 3); assert.equal(overlayZoom(0.1), 0.5);
  assert.equal(overlayZoom(Number.NaN), 1); assert.equal(overlayZoom('2'), 1); assert.equal(overlayZoom(undefined), 1);
});

const fakeOverlay = (content: number[], zoom = 1) => {
  const main = { destroyed: false, content, zoom, isDestroyed() { return this.destroyed; }, getContentSize() { return this.content; }, getZoom() { return this.zoom; } };
  const view = { sets: 0, zooms: 0, b: { x: 0, y: 0, width: 1, height: 1 }, z: 1, getBounds() { return this.b; }, setBounds(r: typeof this.b) { this.sets++; this.b = r; }, getZoom() { return this.z; }, setZoom(z: number) { this.zooms++; this.z = z; } };
  return { main, view };
};

test('syncOverlay follows resize, maximize, restore and zoom, and does nothing when nothing changed', () => {
  const { main, view } = fakeOverlay([1280, 820], 1);
  assert.equal(syncOverlay(main, view), true);
  assert.deepEqual(view.b, { x: 0, y: 0, width: 1280, height: 820 });
  assert.equal(syncOverlay(main, view), false, 'nothing to change');
  main.content = [1920, 1040]; // maximized
  assert.equal(syncOverlay(main, view), true); assert.deepEqual(view.b, { x: 0, y: 0, width: 1920, height: 1040 });
  main.content = [960, 600]; // restored to the smallest the window can be
  assert.equal(syncOverlay(main, view), true); assert.deepEqual(view.b, { x: 0, y: 0, width: 960, height: 600 });
  main.zoom = 1.5;
  assert.equal(syncOverlay(main, view), true); assert.equal(view.z, 1.5); assert.equal(view.zooms, 1);
  assert.equal(syncOverlay(main, view), false); assert.equal(view.zooms, 1, 'the zoom is set only when it changed');
});

test('a destroyed Legion window is never touched by the overlay sync', () => {
  const { main, view } = fakeOverlay([1280, 820]);
  main.destroyed = true;
  assert.equal(syncOverlay(main, view), false);
  assert.equal(view.sets + view.zooms, 0);
});

const fakeWin = (o: { minimized?: boolean; visible?: boolean; destroyed?: boolean; stuck?: boolean }) => {
  const w = {
    calls: [] as string[], minimized: !!o.minimized, visible: o.visible !== false, destroyed: !!o.destroyed,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; }, isVisible() { return this.visible; },
    restore() { this.calls.push('restore'); if (!o.stuck) this.minimized = false; },
    show() { this.calls.push('show'); if (!o.stuck) this.visible = true; },
    focus() { this.calls.push('focus'); },
  };
  return w;
};

test('bringForward: a shown window is just focused; a minimized one is restored; a hidden one (the tray) is shown; then it is focused', () => {
  const a = fakeWin({}); assert.equal(bringForward(a), true); assert.deepEqual(a.calls, ['focus']);
  const b = fakeWin({ minimized: true }); assert.equal(bringForward(b), true); assert.deepEqual(b.calls, ['restore', 'focus']);
  const c = fakeWin({ visible: false }); assert.equal(bringForward(c), true); assert.deepEqual(c.calls, ['show', 'focus']);
  const d = fakeWin({ minimized: true, visible: false }); assert.equal(bringForward(d), true); assert.deepEqual(d.calls, ['restore', 'show', 'focus']);
});

test('bringForward: no window, a destroyed one, or one that cannot be shown is false (the system dialog takes over); a throw is false too', () => {
  assert.equal(bringForward(null), false); assert.equal(bringForward(undefined), false);
  assert.equal(bringForward(fakeWin({ destroyed: true })), false);
  assert.equal(bringForward(fakeWin({ minimized: true, stuck: true })), false);
  assert.equal(bringForward(fakeWin({ visible: false, stuck: true })), false);
  const boom = { ...fakeWin({}), show() { throw new Error('gone'); }, isVisible: () => false };
  assert.equal(bringForward(boom), false);
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
  load: async () => undefined, render: async () => undefined, died: never(), stepMs: 40, totalMs: 120, ...o,
});

test('opening: when every step answers, it is done', async () => {
  const order: string[] = [];
  await prepareConfirm(steps({ load: async () => { order.push('load'); }, render: async () => { order.push('render'); } }));
  assert.deepEqual(order, ['load', 'render']);
});

test('opening: a page that never loads or never draws ends in an error', async () => {
  await assert.rejects(prepareConfirm(steps({ load: never })), /loading the page took longer/);
  await assert.rejects(prepareConfirm(steps({ render: never })), /drawing the question took longer/);
});

test('opening: a page that dies while it is being drawn ends at once, whatever step it was in', async () => {
  let kill!: (e: Error) => void;
  const died = new Promise<never>((_, rej) => { kill = rej; });
  const t0 = Date.now();
  const run = prepareConfirm(steps({ died, render: never, stepMs: 5000, totalMs: 10_000 }));
  setTimeout(() => kill(new Error('the page stopped (crashed)')), 10);
  await assert.rejects(run, /the page stopped \(crashed\)/);
  assert.ok(Date.now() - t0 < 1000, 'it did not wait for a timeout');
});

test('opening: a watchdog ends the whole opening even when each step is within its own time', async () => {
  const slow = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
  await assert.rejects(prepareConfirm(steps({ load: slow(60), render: slow(70), stepMs: 2000, totalMs: 100 })), /opening the window took longer than 100 ms/);
});

test('opening: no timer is left running after it ends', async () => {
  const before = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await prepareConfirm(steps({ stepMs: 5000, totalMs: 10_000 }));
  await assert.rejects(prepareConfirm(steps({ render: never, stepMs: 20, totalMs: 10_000 })));
  const slow = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
  await assert.rejects(prepareConfirm(steps({ load: slow(40), render: slow(40), stepMs: 5000, totalMs: 60 })), /opening the window/);
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
  const run = prepareConfirm(steps({ died, load: () => new Promise<void>((r) => setTimeout(r, 60)), render: async () => { called.push('render'); }, stepMs: 5000, totalMs: 10_000 }));
  setTimeout(() => kill(new Error('the page stopped')), 10);
  await assert.rejects(run, /the page stopped/);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(called, [], 'render was never started on a dead page');
});
