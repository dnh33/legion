/**
 * Taskbar pinning (src/electron/taskbar.ts): the window's relaunch details start this install again, and only Legion's own
 * shortcuts for this install get the shared id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ID, needsId, windowDetails } from '../src/electron/taskbar.js';

const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\Legion\\node_modules\\electron\\dist\\electron.exe';
const DIR = 'C:\\Users\\u\\AppData\\Local\\Programs\\Legion';

test('the window carries the id and a relaunch command that starts this install, with its icon', () => {
  assert.deepEqual(windowDetails(EXE, DIR), {
    appId: 'dev.legion.app',
    appIconPath: `${DIR}\\assets\\icon.ico`,
    relaunchCommand: `"${EXE}" "${DIR}"`,
    relaunchDisplayName: 'Legion',
  });
});

test('setup\'s shortcut (no id) for this install gets the id; case, quotes and a trailing backslash do not matter', () => {
  assert.equal(needsId({ target: EXE, args: `"${DIR}"` }, EXE, DIR), true);
  assert.equal(needsId({ target: EXE.toUpperCase(), args: `"${DIR}\\"` }, EXE, DIR), true);
  assert.equal(needsId({ target: EXE, args: DIR, appUserModelId: 'something.else' }, EXE, DIR), true);
});

test('a shortcut that already has the id, another app, or another Legion install is left alone', () => {
  assert.equal(needsId({ target: EXE, args: `"${DIR}"`, appUserModelId: APP_ID }, EXE, DIR), false);
  assert.equal(needsId({ target: 'C:\\Windows\\notepad.exe', args: '' }, EXE, DIR), false);
  assert.equal(needsId({ target: EXE, args: '"D:\\Legion"' }, EXE, DIR), false);
  assert.equal(needsId({ target: EXE }, EXE, DIR), false, 'bare electron.exe opens nothing: not ours to mark');
});
