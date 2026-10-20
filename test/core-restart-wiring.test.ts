/** Pins for how main.ts wires the core restart: the signal, the gates, the session end, the IPC and the stubs. The decisions are tested in core-restart-logic.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './ps-helpers.js';

const src = (p: string): string => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');
const main = src('src/electron/main.ts');
const updater = src('src/electron/updater-main.ts');
const preload = src('src/electron/preload.cjs');
const stub = src('test/electron-emu/stub-electron.mjs');

/** The text from `start` to the first line that is just `}` at the same indent as the start line. */
function block(text: string, start: string): string {
  const i = text.indexOf(start);
  assert.ok(i >= 0, `not found: ${start}`);
  const indent = /^ */.exec(text.slice(text.lastIndexOf('\n', i) + 1))![0];
  const end = text.indexOf(`\n${indent}}`, i);
  return text.slice(i, end + indent.length + 2);
}

test('signal: the exit handler reads coreProc before it clears it, and only a proven child restarts', () => {
  const h = block(main, "child.on('exit', (code, signal) =>");
  const intended = h.indexOf('const intended = coreProc !== child');
  const clear = h.indexOf('coreProc = null');
  assert.ok(intended >= 0 && clear > intended, 'intended is computed before coreProc is cleared');
  assert.match(h, /provenChild === child/);
  assert.match(h, /void onCoreCrash\(/);
  assert.match(h, /intended/);
});

test('signal: a child counts as proven only where it proved it holds our secret', () => {
  const ens = block(main, 'async function ensureCore()');
  assert.equal((ens.match(/provenChild = /g) ?? []).length, 2, 'the adopt path and the spawn path');
  assert.match(ens, /if \(mine\) \{ pinned = \{ port, token: readConfig\(\)\.token \}; rendererAdmin = mine; provenChild = coreProc;/);
});

test('signal: killCore, the one stop that main asks for, clears coreProc before the exit', () => {
  const k = block(main, 'async function killCore()');
  assert.ok(k.indexOf('coreProc = null') < k.indexOf("c.once('exit'"));
  assert.match(main, /stopCore: killCore/);
});

test('crash handler: logs, decides with every fact, waits, re-checks, restarts through restartCoreQuiet', () => {
  const f = block(main, 'async function onCoreCrash(');
  assert.match(f, /crashes\.register\(\)/);
  assert.match(f, /exitLine\(/);
  assert.match(f, /decideRestart\(/);
  assert.match(f, /await sleep\(RESTART_DELAY_MS\)/);
  assert.match(f, /coreProc/, 'a core started during the wait (tray Restart) stops the second restart');
  assert.match(f, /await restartCoreQuiet\(\)/);
  assert.match(f, /noteStopped\('limit'\)/);
  assert.match(f, /noteStopped\('failed'\)/);
  assert.match(f, /noteRestarted\(\)/);
  assert.ok(f.indexOf('noteRestarted()') < f.indexOf('await restartCoreQuiet()'), 'the notice is set before the reload that fetches it');
  for (const fact of ['quitting', 'updateBusy(', 'sessionEnding', 'restartSwitchOn()', 'booting']) assert.ok(f.includes(fact), `uses ${fact}`);
});

test('updates: the host exports applying and the live swap marker as one answer, and the crash handler uses it', () => {
  assert.match(updater, /export function updateBusy\(installDir: string\): boolean/);
  const u = block(updater, 'export function updateBusy(');
  assert.match(u, /applying/);
  assert.match(u, /isUpdateInProgress\(/);
  assert.ok(!/staged/.test(u), 'a staged update waiting for idle is normal and must not switch the restart off');
  assert.match(main, /updateBusy\(root\)/);
});

test('session end: its own flag, never quitting; windows events and the power monitor', () => {
  const m = block(main, 'function markSessionEnding(');
  assert.ok(!/quitting/.test(m), 'a logoff another app cancels must not hide the window for good');
  assert.match(m, /sessionEnding = true/);
  assert.match(m, /setTimeout\(/, 'a cancelled logoff clears the flag again');
  assert.match(main, /win\.on\('query-session-end'/);
  assert.match(main, /win\.on\('session-end'/);
  assert.match(main, /powerMonitor\.on\('shutdown'/);
  assert.match(main, /import \{[^}]*powerMonitor[^}]*\} from 'electron'/);
});

test('the electron stub used by the emulation exports powerMonitor', () => {
  assert.match(stub, /export const powerMonitor = \{ on\(\) \{\} \}/);
});

test('IPC: the three channels check the sender like the other legion: handlers', () => {
  for (const ch of ['legion:core-restart-state', 'legion:core-restart-now', 'legion:core-restart-option']) {
    const h = block(main, `ipcMain.handle('${ch}'`);
    assert.match(h, /trustedSender\(frameUrl, uiUrl\)/, ch);
    assert.match(h, /sender !== win\.webContents/, ch);
  }
});

test('manual restart: the tray and the banner button share one path that forgets the crashes and the stopped state', () => {
  const r = block(main, 'async function manualRestart(');
  assert.match(r, /crashes\.reset\(\)/);
  assert.match(r, /clearStopped\(\)/);
  assert.match(r, /restartCoreQuiet\(\)/);
  assert.match(block(main, 'async function restartCore()'), /manualRestart\(\)/);
  assert.match(block(main, "ipcMain.handle('legion:core-restart-now'"), /manualRestart\(\)/);
});

test('the option lives in app-settings.json in the data folder, read by main with no core', () => {
  assert.match(main, /app-settings\.json/);
  const r = block(main, 'function restartSwitchOn()');
  assert.match(r, /restartEnabled\(/);
  assert.ok(!/ownCoreCall/.test(r));
});

test('logging: the child pid at spawn, every exit and every decision go to app.log', () => {
  assert.match(block(main, 'function appLog('), /app\.log/);
  assert.match(main, /appLog\('info', 'core-spawn', \{ pid:/);
  assert.match(block(main, 'async function onCoreCrash('), /appLog\(/);
});

test('preload: the window can read the state, hear changes, restart the core and flip the option', () => {
  for (const ch of ['legion:core-restart-state', 'legion:core-restart-now', 'legion:core-restart-option', 'legion:core-restart-changed']) assert.ok(preload.includes(ch), ch);
  for (const fn of ['coreRestartState', 'onCoreRestartChanged', 'restartCoreNow', 'coreRestartOption']) assert.match(preload, new RegExp(`${fn}\\(`), fn);
});
