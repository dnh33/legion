// The per-project "an agent changed a build or script file" flag (Task 27): a small store beside the gate files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { createBuildEdited } from '../src/core/gates-settings/build-edited.js';

const dir = () => join(tempDir('legion-buildedited-'), 'gates');
const file = (d: string) => join(d, 'build-edited.json');

test('no file: nothing is flagged; set and clear persist and survive a restart', () => {
  const d = dir();
  const a = createBuildEdited(d);
  assert.equal(a.has('proj_aaaaaaaaaaaa'), false);
  a.set('proj_aaaaaaaaaaaa');
  assert.equal(a.has('proj_aaaaaaaaaaaa'), true);
  assert.equal(a.has('proj_bbbbbbbbbbbb'), false);
  assert.deepEqual(JSON.parse(readFileSync(file(d), 'utf8')), { v: 1, projects: ['proj_aaaaaaaaaaaa'] });
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
    assert.deepEqual(JSON.parse(readFileSync(file(d), 'utf8')), { v: 1, all: true, cleared: [] }, 'the failed-closed state is written');
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
