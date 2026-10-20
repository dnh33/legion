/**
 * While Legion's confirm card is open, nothing the Legion page can reach may open a system dialog over it, and the page cannot steal the card's focus.
 * (Review round 2: M1 the folder chooser and Restart now, L1 the page-focus grab, L2 the mouse comment.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIRM_BUSY, deferFocus, waitUntilFree } from '../src/electron/confirm-window-logic.js';
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

test('pickFolder: while a card is open the folder chooser is never opened, and the flow ends with the busy text', async () => {
  const d = fakeDialog();
  let allowed = false;
  const pick = makePickFolder(d, () => winObj, () => allowed);
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
  allowed = true;
  assert.equal(await pick('C:/start'), 'D:/proj/x');
  assert.equal(d.calls.length, 1, 'with no card open the chooser opens as before');
  assert.equal(d.calls[0]![0], winObj);
  assert.deepEqual((d.calls[0]![1] as { properties: string[] }).properties, ['openDirectory', 'createDirectory']);
});

test('pickFolder: a cancelled chooser gives no folder; no Legion window gives no chooser', async () => {
  assert.equal(await makePickFolder(fakeDialog({ canceled: true, filePaths: [] }), () => winObj, () => true)(), undefined);
  const d = fakeDialog();
  assert.equal(await makePickFolder(d, () => null, () => true)(), undefined);
  assert.equal(d.calls.length, 0);
});

test('waitUntilFree: returns at once when no card is open, and otherwise waits (no refusal) until it is gone', async () => {
  let slept = 0;
  await waitUntilFree(() => false, { sleep: async () => { slept++; } });
  assert.equal(slept, 0);
  const busy = [true, true, true, false];
  let i = 0;
  await waitUntilFree(() => busy[i++]!, { sleep: async () => { slept++; } });
  assert.equal(slept, 3);
  assert.equal(i, 4, 'asked again after each wait');
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

test('the system dialogs a page can reach are guarded: folder chooser and Restart now refuse while a card is open; the outcome notice and the core questions wait', () => {
  assert.match(win, /export const nativeDialogAllowed = \(\): boolean => !confirmWindowBusy\(\);/);
  assert.match(main, /makePickFolder\(dialog, \(\) => win, nativeDialogAllowed\)/);
  assert.doesNotMatch(main, /dialog\.showOpenDialog/, 'the chooser lives in the guarded factory');
  assert.match(read('src/electron/project-ipc.ts'), /showOpenDialog/);
  // updater-main keeps its own dialogs and imports nothing from the card (the pin in confirm-window-pins): the host hands it two functions
  assert.match(main, /cardOpen: \(\) => !nativeDialogAllowed\(\), cardFree: \(\) => waitUntilFree\(confirmWindowBusy\)/);
  const apply = /async function applyNow[\s\S]*?\n}\n/.exec(upd)![0];
  const gate = apply.indexOf('h.cardOpen()');
  assert.ok(gate > 0 && gate < apply.indexOf('dialog.showMessageBox(w, opts)'), 'refused before the dialog');
  assert.match(apply, /if \(dialogOpen \|\| h\.cardOpen\(\)\) return \{ ok: false, error: 'A confirmation is already open\. Answer it first\.' \};/, 'the existing busy text');
  const notice = /export async function showOutcomeNotice[\s\S]*?\n}\n/.exec(upd)![0];
  assert.equal((notice.match(/await h\.cardFree\(\);/g) ?? []).length, 2, 'both notice dialogs wait for a free card');
  for (const m of notice.matchAll(/await h\.cardFree\(\);/g)) assert.match(notice.slice(m.index!, m.index! + 500), /dialog\.showMessageBox/);
  const ensure = /async function askRestartForeignCore[\s\S]*?\n}\n/.exec(main)![0];
  assert.match(ensure, /await waitUntilFree\(confirmWindowBusy\);[^\n]*\n\s*const r = await dialog\.showMessageBox/);
  assert.match(main, /waitUntilFree\(confirmWindowBusy\)\.then\(\(\) => dialog\.showMessageBox\(\{ type: 'info', message: 'Legion Core was started outside this app\./);
});
