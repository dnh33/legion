import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { isTicked, masterOn, readAllowlist, setMaster, setTicked } from '../src/core/connectors/github/allowlist.js';
import { tempDir } from './tmp-cleanup.js';

const file = (dir: string): string => join(dir, 'connectors', 'github-repos.json');

test('no file reads as the default: nothing ticked, agents on', () => {
  const dir = tempDir('legion-ghal-');
  assert.deepEqual(readAllowlist(dir), { v: 1, ticked: [], agentsEnabled: true });
  assert.equal(masterOn(dir), true);
  assert.equal(isTicked(dir, 'dnh33/legion'), false);
});

test('setTicked stores lower-case, de-duplicated names and ignores a .git suffix', () => {
  const dir = tempDir('legion-ghal-');
  setTicked(dir, 'Dnh33/Legion', true);
  setTicked(dir, 'dnh33/legion.git', true);
  setTicked(dir, 'DNH33/LEGION', true);
  assert.deepEqual(readAllowlist(dir).ticked, ['dnh33/legion']);
  assert.equal(isTicked(dir, 'Dnh33/Legion.git'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file(dir), 'utf8')), { v: 1, ticked: ['dnh33/legion'], agentsEnabled: true });
  setTicked(dir, 'Dnh33/Legion', false);
  assert.deepEqual(readAllowlist(dir).ticked, []);
  assert.equal(isTicked(dir, 'dnh33/legion'), false);
});

test('invalid names throw and write nothing', () => {
  const dir = tempDir('legion-ghal-');
  for (const bad of ['', 'nope', 'a/b/c', '../x', 'a/..', './b', 'a b/c', 'a/b?x=1']) {
    assert.throws(() => setTicked(dir, bad, true), /./, bad);
  }
  assert.equal(fs.existsSync(file(dir)), false);
  assert.equal(isTicked(dir, '../x'), false);
});

test('a corrupt file reads as empty (fail closed)', () => {
  const dir = tempDir('legion-ghal-');
  fs.mkdirSync(join(dir, 'connectors'), { recursive: true });
  for (const junk of ['{not json', '[]', '{"v":2,"ticked":["a/b"]}', '{"v":1,"ticked":"a/b"}', '{"v":1,"ticked":["a/b",7,"../x"],"agentsEnabled":true}']) {
    fs.writeFileSync(file(dir), junk);
    assert.equal(isTicked(dir, 'a/b'), false, junk);
    assert.deepEqual(readAllowlist(dir).ticked, [], junk);
  }
});

test('the master switch persists and keeps the ticks', () => {
  const dir = tempDir('legion-ghal-');
  setTicked(dir, 'a/b', true);
  assert.equal(setMaster(dir, false).agentsEnabled, false);
  assert.equal(masterOn(dir), false);
  assert.deepEqual(readAllowlist(dir), { v: 1, ticked: ['a/b'], agentsEnabled: false });
});

test('the cap is 500: the 501st is refused, an existing name still works', () => {
  const dir = tempDir('legion-ghal-');
  for (let i = 0; i < 500; i++) setTicked(dir, `o/r${i}`, true);
  assert.throws(() => setTicked(dir, 'o/r500', true));
  assert.equal(readAllowlist(dir).ticked.length, 500);
  assert.doesNotThrow(() => setTicked(dir, 'O/R0', true));
  assert.doesNotThrow(() => setTicked(dir, 'o/r1', false));
  assert.equal(readAllowlist(dir).ticked.length, 499);
});

test('the write is atomic: a failed rename leaves the old file intact and no temp file behind', () => {
  const dir = tempDir('legion-ghal-');
  setTicked(dir, 'a/b', true);
  const before = fs.readFileSync(file(dir), 'utf8');
  const m = mock.method(fs, 'renameSync', () => { throw new Error('rename failed'); });
  try {
    assert.throws(() => setTicked(dir, 'c/d', true), /rename failed/);
  } finally { m.mock.restore(); }
  assert.equal(fs.readFileSync(file(dir), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(join(dir, 'connectors')), ['github-repos.json']);
  assert.deepEqual(readAllowlist(dir).ticked, ['a/b']);
});
