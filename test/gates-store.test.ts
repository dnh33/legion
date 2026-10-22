// test/gates-store.test.ts
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';

const dir = () => join(cleanupTemp('legion-gates-'), 'gates');
const P1 = 'proj_000000000001';
const GONE = 'proj_00000000dead';

test('no files: the app and every project read as Ask', () => {
  const s = new GatesStore(dir());
  assert.deepEqual(s.app(), { version: 1 });
  assert.deepEqual(s.project(P1), { version: 1 });
});

test('a damaged file reads as Ask, is kept aside and is listed as unreadable', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${P1}.json`), '{not json');
  writeFileSync(join(d, 'app.json'), JSON.stringify({ version: 1, preset: 'yolo', overrides: { 'no-such': false } }));
  const s = new GatesStore(d);
  assert.deepEqual(s.project(P1), { version: 1, preset: 'ask' });
  // the app file's damaged record also holds Claude's own checks off (a blank record would read as on)
  assert.deepEqual(s.app(), { version: 1, preset: 'ask', claudeOwnChecks: false });
  assert.ok(readdirSync(d).some((n) => n.startsWith(`${P1}.json.bad-`)), 'the damaged file is kept aside');
  assert.deepEqual(s.view([P1]).unreadable.sort(), ['app', P1]);
});

test('a file over 64 KB is treated as damaged', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${P1}.json`), JSON.stringify({ version: 1, pad: 'x'.repeat(70_000) }));
  assert.deepEqual(new GatesStore(d).project(P1), { version: 1, preset: 'ask' });
});

test('in this part only Ask is accepted; anything else is a 400 with a plain reason', () => {
  const s = new GatesStore(dir(), { allowed: ['ask'] });
  assert.deepEqual(s.patchProject(P1, { preset: 'ask' }), { version: 1, preset: 'ask' });
  assert.throws(() => s.patchProject(P1, { preset: 'bypass' }), (e: unknown) => e instanceof GatesError && e.status === 400 && /not available yet/.test(e.message));
  assert.throws(() => s.patchApp({ preset: 'nonsense' }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.throws(() => s.patchProject(P1, { overrides: { 'github-write-card': false } }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('a write lands on disk through tmp and rename, and a fresh store reads it back', async () => {
  const d = dir();
  const s = new GatesStore(d);
  s.patchProject(P1, { preset: 'ask' });
  await s.flush();
  assert.equal(JSON.parse(readFileSync(join(d, `${P1}.json`), 'utf8')).preset, 'ask');
  assert.ok(!readdirSync(d).some((n) => n.endsWith('.tmp')));
  assert.equal(new GatesStore(d).project(P1).preset, 'ask');
});

test('the core trusts memory: a file changed on disk is ignored until reload', async () => {
  const d = dir();
  const s = new GatesStore(d, { allowed: ['ask'] });
  s.patchProject(P1, { preset: 'ask' });
  await s.flush();
  writeFileSync(join(d, `${P1}.json`), JSON.stringify({ version: 1, preset: 'bypass' }));
  assert.equal(s.project(P1).preset, 'ask');
  s.reload();
  assert.deepEqual(s.project(P1), { version: 1, preset: 'ask' }, 'bypass is not allowed in this part, so the reloaded file is damaged and reads as Ask');
});

test('a missing file is blank, not Ask: no preset means no cap', () => {
  const s = new GatesStore(dir());
  assert.deepEqual(s.project(P1), { version: 1 });
  assert.deepEqual(s.app(), { version: 1 });
});

test('the default allowed presets are Ask only: bypass is refused without passing allowed', () => {
  const s = new GatesStore(dir());
  for (const preset of ['accept-edits', 'smart', 'bypass'] as const) {
    assert.throws(() => s.patchProject(P1, { preset }), (e: unknown) => e instanceof GatesError && e.status === 400, preset);
  }
});

test('prune drops files for projects that no longer exist', async () => {
  const d = dir();
  const s = new GatesStore(d);
  s.patchProject(GONE, { preset: 'ask' });
  await s.flush();
  s.prune([P1]);
  await s.flush();
  assert.equal(existsSync(join(d, `${GONE}.json`)), false);
});

test('limit is a project boolean; the app file cannot hold one', () => {
  const s = new GatesStore(dir());
  assert.deepEqual(s.patchProject(P1, { preset: 'ask', limit: true }), { version: 1, preset: 'ask', limit: true });
  assert.throws(() => s.patchProject(P1, { limit: 'yes' }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.throws(() => s.patchApp({ limit: true }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('a project id that is not a plain id is refused', () => {
  const s = new GatesStore(dir());
  assert.throws(() => s.patchProject('../app', { preset: 'ask' }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('a write that fails never throws: the value stays in memory and the next flush retries it', async () => {
  const d = dir();
  const s = new GatesStore(d);
  writeFileSync(d, 'a file where the folder should be'); // the folder cannot be created now
  assert.doesNotThrow(() => s.patchProject(P1, { preset: 'ask' }));
  await assert.doesNotReject(s.flush());
  assert.equal(s.project(P1).preset, 'ask');
  // the debounce timer fires the same write; a throw there would be an uncaught exception and fail the test
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(s.project(P1).preset, 'ask');
  rmSync(d, { force: true });
  await s.flush();
  assert.equal(JSON.parse(readFileSync(join(d, `${P1}.json`), 'utf8')).preset, 'ask', 'the failed write is retried on the next flush');
});

test('a saved change clears the damaged-file mark for that file', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${P1}.json`), '{not json');
  const s = new GatesStore(d);
  assert.deepEqual(s.view([P1]).unreadable, [P1]);
  s.patchProject(P1, { preset: 'ask' });
  assert.deepEqual(s.view([P1]).unreadable, []);
});

test('reload saves unsaved changes first, so it never undoes them', async () => {
  const d = dir();
  const s = new GatesStore(d);
  s.patchProject(P1, { preset: 'ask' });
  s.reload();
  assert.deepEqual(s.project(P1), { version: 1, preset: 'ask' });
  assert.equal(existsSync(join(d, `${P1}.json`)), true);
});

test('reload reads only files named for a project id', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'p_1.json'), '{not json');
  const s = new GatesStore(d);
  assert.deepEqual(s.view([]).unreadable, []);
  assert.ok(existsSync(join(d, 'p_1.json')), 'a name that is not a project id is left alone');
});

test('a damaged file is rewritten as Ask, so a restart keeps the cap', async () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${P1}.json`), '{not json');
  const s = new GatesStore(d);
  assert.deepEqual(s.project(P1), { version: 1, preset: 'ask' });
  await s.flush();
  assert.deepEqual(JSON.parse(readFileSync(join(d, `${P1}.json`), 'utf8')), { version: 1, preset: 'ask' }, 'the Ask record is on disk');
  assert.ok(readdirSync(d).some((n) => n.startsWith(`${P1}.json.bad-`)), 'the damaged original is kept aside');
  assert.deepEqual(new GatesStore(d).project(P1), { version: 1, preset: 'ask' }, 'a restart still reads Ask');
});
