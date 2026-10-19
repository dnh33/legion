// The per-project "an agent changed a build or script file" flag (Task 27): a small store beside the gate files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { buildFingerprint, createBuildEdited } from '../src/core/gates-settings/build-edited.js';

const dir = () => join(tempDir('legion-buildedited-'), 'gates');
const file = (d: string) => join(d, 'build-edited.json');

test('no file: nothing is flagged; set and clear persist and survive a restart', () => {
  const d = dir();
  const a = createBuildEdited(d);
  assert.equal(a.has('proj_aaaaaaaaaaaa'), false);
  a.set('proj_aaaaaaaaaaaa');
  assert.equal(a.has('proj_aaaaaaaaaaaa'), true);
  assert.equal(a.has('proj_bbbbbbbbbbbb'), false);
  assert.deepEqual(JSON.parse(readFileSync(file(d), 'utf8')), { v: 1, projects: ['proj_aaaaaaaaaaaa'], prints: {} });
  assert.equal(createBuildEdited(d).has('proj_aaaaaaaaaaaa'), true, 'a new store on the same folder still flags it');
  a.clear('proj_aaaaaaaaaaaa');
  assert.equal(createBuildEdited(d).has('proj_aaaaaaaaaaaa'), false);
  assert.equal(existsSync(file(d) + '.tmp'), false, 'no temp file is left behind');
});

test('a file that exists but cannot be read flags every project, and an owner allow clears only that project', () => {
  for (const bad of ['{not json', '{"v":2,"projects":[]}', '[]', '{"v":1,"projects":"x"}']) {
    const d = dir(); mkdirSync(d, { recursive: true }); writeFileSync(file(d), bad);
    const s = createBuildEdited(d);
    assert.equal(s.has('proj_aaaaaaaaaaaa'), true, bad);
    assert.equal(s.has('proj_bbbbbbbbbbbb'), true, bad);
    assert.deepEqual(JSON.parse(readFileSync(file(d), 'utf8')), { v: 1, all: true, cleared: [], prints: {} }, 'the failed-closed state is written');
    s.clear('proj_aaaaaaaaaaaa');
    assert.equal(s.has('proj_aaaaaaaaaaaa'), false);
    assert.equal(s.has('proj_bbbbbbbbbbbb'), true);
    assert.equal(createBuildEdited(d).has('proj_aaaaaaaaaaaa'), false, 'the clear survives a restart');
    s.set('proj_aaaaaaaaaaaa');
    assert.equal(s.has('proj_aaaaaaaaaaaa'), true, 'a later build-file edit flags it again');
    assert.equal(createBuildEdited(d).has('proj_aaaaaaaaaaaa'), true);
  }
});

test('a write that fails keeps the flag in memory (fail closed, never throws)', () => {
  const d = join(tempDir('legion-buildedited-'), 'gates');
  mkdirSync(join(d, '..'), { recursive: true });
  writeFileSync(d, 'a file, not a folder'); // the folder cannot be created
  const s = createBuildEdited(d);
  assert.doesNotThrow(() => s.set('proj_aaaaaaaaaaaa'));
  assert.equal(s.has('proj_aaaaaaaaaaaa'), true);
});

const project = () => { const d = tempDir('legion-buildprint-'); mkdirSync(join(d, 'scripts', 'sub'), { recursive: true }); writeFileSync(join(d, 'package.json'), '{}'); writeFileSync(join(d, 'src.ts'), 'x'); return d; };

test('the fingerprint covers root build files and everything under scripts, and nothing else', () => {
  const d = project(); const a = buildFingerprint(d);
  assert.equal(buildFingerprint(d), a, 'stable');
  writeFileSync(join(d, 'src.ts'), 'a much longer source file'); writeFileSync(join(d, 'README.md'), 'x');
  mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'package.json'), '{}');
  assert.equal(buildFingerprint(d), a, 'source files, docs and nested package.json are outside it');
  writeFileSync(join(d, 'scripts', 'sub', 'b.js'), 'x'); const b = buildFingerprint(d); assert.notEqual(b, a, 'a new file under scripts');
  writeFileSync(join(d, 'package.json'), '{"a":1}'); const c = buildFingerprint(d); assert.notEqual(c, b, 'a changed root build file');
  rmSync(join(d, 'package.json')); assert.notEqual(buildFingerprint(d), c, 'a removed one');
  assert.equal(buildFingerprint(join(d, 'missing')), 'unreadable');
});

test('first sight is trusted; a later change flags; the owner allow takes the print from when the card opened', () => {
  const P = 'proj_aaaaaaaaaaaa';
  const d = project(); const s = createBuildEdited(dir());
  assert.equal(s.has(P, d), false, 'first sight: an existing package.json is the baseline, no flag');
  writeFileSync(join(d, 'scripts', 'x.js'), 'x');
  const c = s.check(P, d); assert.equal(c.flagged, true);
  writeFileSync(join(d, 'scripts', 'y.js'), 'during the card');
  s.clear(P, c.snap, d);
  assert.equal(s.has(P, d), true, 'an edit while the card was open keeps the project flagged');
  const c2 = s.check(P, d); s.clear(P, c2.snap, d);
  assert.equal(s.has(P, d), false);
  s.set(P); const c3 = s.check(P, d); s.set(P); s.clear(P, c3.snap, d);
  assert.equal(s.has(P), true, 'a build file named while the card was open keeps the token flag');
});

test('an older file without prints is valid and a lost write still flags after a restart', () => {
  const P = 'proj_aaaaaaaaaaaa';
  const g = dir(); mkdirSync(g, { recursive: true }); writeFileSync(file(g), JSON.stringify({ v: 1, projects: [] }));
  const d = project(); let fail = false;
  const io = { write(f: string, data: string) { if (fail) throw new Error('locked'); writeFileSync(f, data); } };
  const s = createBuildEdited(g, io);
  assert.equal(s.has(P, d), false); // baseline written
  fail = true;
  writeFileSync(join(d, 'package.json'), '{"changed":true}'); s.set(P); // this write is lost
  assert.equal(s.has(P), true, 'in memory');
  assert.equal(createBuildEdited(g).has(P, d), true, 'a new store: the token flag is lost but the baseline on disk is the old one');
  fail = false; s.has(P);
  assert.equal(JSON.parse(readFileSync(file(g), 'utf8')).projects[0], P, 'the lost write is retried on the next call');
});
