/**
 * While Legion's confirm card is open, nothing the Legion page can reach may open a system dialog over it, and the page cannot steal the card's focus.
 * (Review round 2: M1 the folder chooser and Restart now, L1 the page-focus grab, L2 the mouse comment.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIRM_BUSY, ConfirmBusyError, deferFocus, underLock } from '../src/electron/confirm-window-logic.js';
import { makePickFolder, projectChange } from '../src/electron/project-ipc.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');
const win = read('src/electron/confirm-window.ts');
const main = read('src/electron/main.ts');
const upd = read('src/electron/updater-main.ts');

const fakeDialog = (reply: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: ['D:/proj/x'] }) => {
  const calls: unknown[][] = [];
  return { calls, showOpenDialog: async (...a: unknown[]) => { calls.push(a); return reply; } };
};
const winObj = { id: 'win' };
/** The confirm lock as main gives it: hold() fails while a card is open (or the lock is held). */
const fakeLock = (open = false) => { let held = open; return { get held() { return held; }, hold: () => { if (held) return false; held = true; return true; }, release: () => { held = false; } }; };

test('pickFolder: while a card is open the folder chooser is never opened, and the flow ends with the busy text', async () => {
  const d = fakeDialog();
  const lock = fakeLock(true);
  const pick = makePickFolder(d, () => winObj, lock);
  const asked: unknown[] = [];
  const deps = {
    async call(method: string, route: string) { return method === 'GET' ? { status: 200, json: route === '/api/agents' ? [] : { name: 'Shop', folder: 'C:/work/shop', members: [] } } : { status: 200, json: {} }; },
    async confirm(o: unknown) { asked.push(o); return true; },
    pickFolder: pick,
  };
  const r = await projectChange({ kind: 'folder', id: 'proj_0123456789ab', mode: 'pick' }, deps as never);
  assert.deepEqual(r, { ok: false, error: CONFIRM_BUSY });
  assert.equal(d.calls.length, 0, 'showOpenDialog was never called');
  assert.equal(asked.length, 0, 'no question was asked either');
  lock.release();
  assert.equal(await pick('C:/start'), 'D:/proj/x');
  assert.equal(d.calls.length, 1, 'with no card open the chooser opens as before');
  assert.equal(d.calls[0]![0], winObj);
  assert.deepEqual((d.calls[0]![1] as { properties: string[] }).properties, ['openDirectory', 'createDirectory']);
});

test('pickFolder: a cancelled chooser gives no folder; no Legion window gives no chooser', async () => {
  assert.equal(await makePickFolder(fakeDialog({ canceled: true, filePaths: [] }), () => winObj, fakeLock())(), undefined);
  const d = fakeDialog();
  assert.equal(await makePickFolder(d, () => null, fakeLock())(), undefined);
  assert.equal(d.calls.length, 0);
});

test('pickFolder: the chooser holds the confirm lock while it is open, so a card asked meanwhile is busy and never opens under it; freed after, also on error', async () => {
  const lock = fakeLock();
  let heldDuring: boolean | undefined;
  const d = { showOpenDialog: async () => { heldDuring = lock.held; return { canceled: false, filePaths: ['D:/p'] }; } };
  assert.equal(await makePickFolder(d, () => winObj, lock)(), 'D:/p');
  assert.equal(heldDuring, true, 'held while the chooser is open');
  assert.equal(lock.held, false, 'freed when it closes');
  const bad = { showOpenDialog: async () => { throw new Error('boom'); } };
  await assert.rejects(makePickFolder(bad, () => winObj, lock)());
  assert.equal(lock.held, false, 'freed after an error too');
});

test('underLock: a system dialog holds the confirm lock while it is open (a card asked meanwhile is busy, never under it) and frees it on every ending', async () => {
  const lock = fakeLock();
  let heldDuring: boolean | undefined;
  assert.equal(await underLock(lock, async () => { heldDuring = lock.held; return 7; }), 7);
  assert.equal(heldDuring, true);
  assert.equal(lock.held, false, 'freed when it closes');
  await assert.rejects(underLock(lock, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(lock.held, false, 'freed after an error');
});

test('underLock: refuses (busy) while a card is open, without showing anything; with wait it waits for the card instead, then holds', async () => {
  const lock = fakeLock(true);
  let shown = 0;
  await assert.rejects(underLock(lock, async () => { shown++; }), (e) => e instanceof ConfirmBusyError);
  assert.equal(shown, 0, 'nothing opened over the card');
  let slept = 0;
  const p = underLock(lock, async () => { shown++; return lock.held; }, { wait: true, sleep: async () => { slept++; if (slept === 3) lock.release(); } });
  assert.equal(await p, true, 'shown once the card is gone, holding the lock');
  assert.equal(slept, 3);
  assert.equal(shown, 1);
  assert.equal(lock.held, false);
});

test('deferFocus: the page gaining focus gives the card its focus on the next turn (inside the event Chromium would undo it), and an ended card never takes it', () => {
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  const clock = { set: (fn: () => void) => { const t = { fn: () => { t.live = false; fn(); }, live: true }; timers.push(t); return t as never; }, clear: (t: unknown) => { (t as { live: boolean }).live = false; } };
  let taken = 0;
  const d = deferFocus(() => { taken++; }, clock);
  const mainWc = new EventEmitter();
  mainWc.on('focus', d.onFocus);
  mainWc.emit('focus');
  assert.equal(taken, 0, 'not inside the focus event');
  assert.equal(timers.length, 1);
  for (const t of timers) if (t.live) t.fn();
  assert.equal(taken, 1, 'on the next turn');
  mainWc.emit('focus'); d.cancel();
  for (const t of timers) if (t.live) t.fn();
  assert.equal(taken, 1, 'cancelled at the end of the question: no late grab');
  mainWc.emit('focus'); mainWc.emit('focus');
  assert.equal(timers.filter((t) => t.live).length, 1, 'bursts of focus events make one grab');
});

test('the wiring: the page focus is deferred and cleared at the end, the window focus stays immediate, the comments tell the truth', () => {
  assert.match(win, /mainWc\.on\('focus', pageFocus\.onFocus\)/);
  assert.match(win, /mainWc\.removeListener\('focus', pageFocus\.onFocus\)/);
  assert.doesNotMatch(win, /mainWc\.on\('focus', takeFocus\)/, 'the old grab inside the event');
  assert.match(win, /main\.on\('focus', takeFocus\)/);
  assert.match(win, /const unguardMain[\s\S]*?pageFocus\.cancel\(\)/);
  assert.doesNotMatch(win, /dropped here as well/, 'before-mouse-event carries no wheel events, so the comment may not claim the mouse is dropped');
  assert.match(win, /wheel/i);
});

test('the wiring: every system dialog a card could meet holds the lock (the chooser and Restart now refuse; the notices and the core questions wait)', () => {
  const has = (src: string, s: string, why?: string) => assert.ok(src.includes(s), why ?? s);
  const fn = (src: string, head: string): string => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, src.indexOf('\n}\n', i)); };
  has(main, 'const confirmLock = { hold: holdConfirmWindow, release: releaseConfirmWindow };');
  has(main, 'makePickFolder(dialog, () => win, confirmLock)');
  assert.ok(!main.includes('dialog.showOpenDialog'), 'the chooser lives in the guarded factory');
  has(read('src/electron/project-ipc.ts'), 'underLock(lock, ');
  for (const old of ['waitUntilFree', 'cardOpen', 'cardFree']) assert.ok(!(main + upd).includes(old), `the old check-only wiring is gone: ${old}`);
  // updater-main imports nothing from the card (the pin in confirm-window-pins): the host hands it one guarded dialog
  has(main, 'underLock(confirmLock, show, o).catch((e: unknown) => { if (e instanceof ConfirmBusyError) return undefined; throw e; });');
  has(main, 'getWin: () => win, cardDialog,');
  const apply = fn(upd, 'async function applyNow');
  has(apply, 'const r = await h.cardDialog(() => ');
  has(apply, "if (!r) return { ok: false, error: 'A confirmation is already open. Answer it first.' };");
  const notice = fn(upd, 'export async function showOutcomeNotice');
  assert.equal(notice.split('h.cardDialog(').length - 1, 2, 'both notice dialogs hold the lock');
  assert.equal(notice.split('{ wait: true }').length - 1, 2, 'and wait for it');
  // each guarded call picks one of two dialog calls (with or without the Legion window), so there are exactly two per cardDialog and none outside
  for (const src of [apply, notice]) assert.equal(src.split('dialog.showMessageBox(').length - 1, 2 * (src.split('h.cardDialog(').length - 1), 'every dialog sits inside cardDialog');
  const ask = fn(main, 'async function askRestartForeignCore');
  has(ask, 'underLock(confirmLock, () => dialog.showMessageBox(');
  has(ask, '{ wait: true }');
  has(main, "void underLock(confirmLock, () => dialog.showMessageBox({ type: 'info', message: 'Legion Core was started outside this app.");
});
