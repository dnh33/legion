/** H2: the window's files are copied out of the install before the app quits, so no swap can pull them away from a running window. */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyWindowFiles, windowDir } from '../src/core/updater/window-files.js';

function install(skip: string[] = []): string {
  const root = tempDir('h2-winfiles-');
  const put = (rel: string, text: string): void => { if (skip.includes(rel)) return; mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('dist/src/electron/update-window-main.js', 'main'); put('dist/src/core/updater/journey.js', 'journey'); put('dist/src/core/updater/update-window-logic.js', 'logic');
  put('assets/update-window.html', '<html>'); put('assets/icon.png', 'png');
  return root;
}

test('H2 files: the window runs from .update/run/window, with the same folder shape so its imports resolve, and an ES module package file', () => {
  const root = install();
  const r = copyWindowFiles(root);
  assert.deepEqual(r, { ok: true });
  const w = windowDir(root);
  assert.equal(w, join(root, '.update', 'run', 'window'));
  assert.equal(readFileSync(join(w, 'dist', 'src', 'electron', 'update-window-main.js'), 'utf8'), 'main');
  assert.equal(readFileSync(join(w, 'dist', 'src', 'core', 'updater', 'journey.js'), 'utf8'), 'journey');
  assert.equal(readFileSync(join(w, 'update-window.html'), 'utf8'), '<html>');
  const pkg = JSON.parse(readFileSync(join(w, 'package.json'), 'utf8')) as { type: string; main: string; name: string };
  assert.deepEqual(pkg, { name: 'legion-update-window', version: '0.0.0', private: true, type: 'module', main: 'dist/src/electron/update-window-main.js' });
});

test('H2 files: copying again replaces the files (a new build brings a new window), and a missing source is named, never a crash', () => {
  const root = install();
  copyWindowFiles(root);
  writeFileSync(join(root, 'dist', 'src', 'electron', 'update-window-main.js'), 'main2');
  copyWindowFiles(root);
  assert.equal(readFileSync(join(windowDir(root), 'dist', 'src', 'electron', 'update-window-main.js'), 'utf8'), 'main2');
  const bad = install(['assets/update-window.html']);
  const r = copyWindowFiles(bad);
  assert.equal(r.ok, false);
  assert.deepEqual((r as { missing: string[] }).missing, ['assets/update-window.html']);
  assert.equal(existsSync(join(windowDir(bad), 'package.json')), false, 'a half set is not left behind as if it could run');
});
