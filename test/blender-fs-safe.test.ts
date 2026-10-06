/** S8: file helpers that do not follow links. Real temp folders and real links: symlinks on POSIX, junctions (directories) and hard links (files) on Windows, where a file symlink needs privilege. */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { findLink, isInside, resolveFolder, safeWriteFile } from '../src/core/blender/fs-safe.js';
import { checkScript } from '../src/core/blender/static-check.js';
import { tmp } from './blender-helpers.js';
import { fileLinkOrSkip, linkOrSkip } from './fs-links.js';

test('resolveFolder: a missing folder resolves under its real parent; a file is not a folder', () => {
  const d = tmp();
  const r = resolveFolder(join(d, 'a', 'b'));
  assert.equal(r.ok, true);
  writeFileSync(join(d, 'f'), 'x');
  assert.equal(resolveFolder(join(d, 'f')).ok, false);
});

// The OS temp folder is an 8.3 short name on a GitHub Windows runner (C:\Users\RUNNER~1\...), and so is a LEGION_HOME typed that way.
// Legion's own static check refuses "~" in a path, so a resolved folder must come back in its long form, or the export and asset folders it
// allows would be refused. Skipped where the temp path is already long (8.3 names off, or not Windows).
const shortTemp = process.platform === 'win32' && /~\d/.test(tmpdir()) ? false : 'the temp folder is not an 8.3 short name here';
test('resolveFolder: a Windows 8.3 short name comes back as the long real path, existing or not', { skip: shortTemp }, () => {
  const short = mkdtempSync(join(tmpdir(), 'legion-83-'));
  try {
    const long = realpathSync.native(short);
    assert.notEqual(long, short, 'the fixture must start from a short name');
    const r = resolveFolder(short);
    assert.equal(r.ok && r.dir, long);
    const m = resolveFolder(join(short, 'a', 'b'));
    assert.equal(m.ok && m.dir, join(long, 'a', 'b'));
    const dir = m.ok ? m.dir : '';
    assert.ok(!dir.includes('~'), 'no short-name segment is left');
    const s = `import bpy\nbpy.ops.export_scene.gltf(filepath=${JSON.stringify(join(dir, 'x.glb').split('\\').join('/'))})`;
    assert.equal(checkScript(s, { allowedDirs: [dir], live: true }).ok, true, 'a path inside the resolved folder passes the check');
  } finally { rmSync(short, { recursive: true, force: true }); }
});

test('resolveFolder: a folder that is itself a link is refused, and so is a missing folder below a link that leaves the parent', (t) => {
  const d = tmp();
  const out = tmp('legion-out-');
  if (!linkOrSkip(t, out, join(d, 'ln'), 'dir')) return;
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

test('findLink: finds a link nested in the folder, none in a clean folder', (t) => {
  const d = tmp();
  mkdirSync(join(d, 'x', 'y'), { recursive: true });
  assert.equal(findLink(d), null);
  if (!linkOrSkip(t, tmp('legion-out-'), join(d, 'x', 'y', 'planted'), 'dir')) return;
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

test('safeWriteFile: a link at the final name is REPLACED, the file it pointed to is untouched', (t) => {
  const d = tmp();
  const victim = join(tmp('legion-out-'), 'victim.txt');
  writeFileSync(victim, 'original');
  mkdirSync(join(d, 'out'));
  // a hard link where a file symlink is not allowed: the product replaces the name (temp + rename), so the victim is untouched either way
  if (!fileLinkOrSkip(t, victim, join(d, 'out', 'a.bin'))) return;
  safeWriteFile(join(d, 'out'), 'a.bin', Buffer.from('new'));
  assert.equal(readFileSync(victim, 'utf8'), 'original');
  assert.equal(lstatSync(join(d, 'out', 'a.bin')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(d, 'out', 'a.bin'), 'utf8'), 'new');
});

test('safeWriteFile: a folder that is a link is refused, and nothing is written through it', (t) => {
  const d = tmp();
  const out = tmp('legion-out-');
  if (!linkOrSkip(t, out, join(d, 'ln'), 'dir')) return;
  assert.throws(() => safeWriteFile(join(d, 'ln'), 'a.bin', Buffer.from('x')), /symbolic link|refusing/);
  assert.deepEqual(readdirSync(out), []);
});

test('safeWriteFile: names with separators or a NUL are refused', () => {
  const d = tmp();
  for (const bad of ['../x', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => safeWriteFile(d, bad, Buffer.from('x')), /unsafe/, JSON.stringify(bad));
});

test('L1: findLink fails CLOSED: hitting the entry or depth limit, or an unreadable folder, reports a place instead of "no link"', () => {
  const d = tmp();
  for (let i = 0; i < 6; i++) writeFileSync(join(d, `f${i}`), 'x');
  assert.equal(findLink(d, 4, 3) === null, false, 'entry limit hit');
  const deep = join(d, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  assert.equal(findLink(join(d, 'a'), 1, 3000) === null, false, 'depth limit hit');
  assert.equal(findLink(join(d, 'a'), 4, 3000), null, 'within the limits and clean: null');
});
