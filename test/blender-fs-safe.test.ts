/** S8: file helpers that do not follow links. Real temp folders and real symbolic links (skipped on Windows, where creating links needs privileges). */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';
import { findLink, isInside, resolveFolder, safeWriteFile } from '../src/core/blender/fs-safe.js';
import { tmp } from './blender-helpers.js';

const links = process.platform !== 'win32';

test('resolveFolder: a missing folder resolves under its real parent; a file is not a folder', () => {
  const d = tmp();
  const r = resolveFolder(join(d, 'a', 'b'));
  assert.equal(r.ok, true);
  writeFileSync(join(d, 'f'), 'x');
  assert.equal(resolveFolder(join(d, 'f')).ok, false);
});

test('resolveFolder: a folder that is itself a link is refused, and so is a missing folder below a link that leaves the parent', { skip: !links }, () => {
  const d = tmp();
  const out = tmp('legion-out-');
  symlinkSync(out, join(d, 'ln'));
  const r = resolveFolder(join(d, 'ln'));
  assert.equal(r.ok, false);
  // a link in the middle is resolved to its real target (which isInside then rejects for a workspace check)
  const m = resolveFolder(join(d, 'ln', 'sub'));
  assert.equal(m.ok, true);
  if (m.ok) assert.equal(isInside(m.dir, d), false);
});

test('isInside: equal or below, never a sibling that shares a prefix', () => {
  // platform-native paths: isInside compares with the native separator (backslashes on Windows)
  const p = (...s: string[]): string => join(sep, ...s);
  assert.equal(isInside(p('a', 'b'), p('a', 'b')), true);
  assert.equal(isInside(p('a', 'b', 'c'), p('a', 'b')), true);
  assert.equal(isInside(p('a', 'bc'), p('a', 'b')), false);
  assert.equal(isInside(p('a'), p('a', 'b')), false);
});

test('findLink: finds a link nested in the folder, none in a clean folder', { skip: !links }, () => {
  const d = tmp();
  mkdirSync(join(d, 'x', 'y'), { recursive: true });
  assert.equal(findLink(d), null);
  symlinkSync(tmp('legion-out-'), join(d, 'x', 'y', 'planted'));
  assert.equal(findLink(d), join(d, 'x', 'y', 'planted'));
});

test('safeWriteFile: writes a new file, leaves no temp file, replaces an existing one', () => {
  const d = tmp();
  const p = safeWriteFile(join(d, 'out'), 'a.bin', Buffer.from('one'));
  assert.equal(readFileSync(p, 'utf8'), 'one');
  safeWriteFile(join(d, 'out'), 'a.bin', Buffer.from('two'));
  assert.equal(readFileSync(p, 'utf8'), 'two');
  assert.deepEqual(readdirSync(join(d, 'out')), ['a.bin']);
});

test('safeWriteFile: a link at the final name is REPLACED, the file it pointed to is untouched', { skip: !links }, () => {
  const d = tmp();
  const victim = join(tmp('legion-out-'), 'victim.txt');
  writeFileSync(victim, 'original');
  mkdirSync(join(d, 'out'));
  symlinkSync(victim, join(d, 'out', 'a.bin'));
  safeWriteFile(join(d, 'out'), 'a.bin', Buffer.from('new'));
  assert.equal(readFileSync(victim, 'utf8'), 'original');
  assert.equal(lstatSync(join(d, 'out', 'a.bin')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(d, 'out', 'a.bin'), 'utf8'), 'new');
});

test('safeWriteFile: a folder that is a link is refused, and nothing is written through it', { skip: !links }, () => {
  const d = tmp();
  const out = tmp('legion-out-');
  symlinkSync(out, join(d, 'ln'));
  assert.throws(() => safeWriteFile(join(d, 'ln'), 'a.bin', Buffer.from('x')), /symbolic link|refusing/);
  assert.deepEqual(readdirSync(out), []);
});

test('safeWriteFile: names with separators or a NUL are refused', () => {
  const d = tmp();
  for (const bad of ['../x', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => safeWriteFile(d, bad, Buffer.from('x')), /unsafe/, JSON.stringify(bad));
});
