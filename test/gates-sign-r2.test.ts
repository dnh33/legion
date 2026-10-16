// test/gates-sign-r2.test.ts: fix round 2 for signed gate files (folder-level delete and replay read as Ask, key state, N1 to N11)
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS } from '../src/shared/gates-registry.js';
import { GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import { GatesKeyring } from '../src/core/gates-settings/keyring.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import { gatesKeyFilePath, gatesKeyLine, gatesKeyState } from '../src/electron/connector-key.js';

const key = Buffer.alloc(32, 7);
const P = 'proj_aaaaaaaaaaaa';
const Q = 'proj_bbbbbbbbbbbb';
type KS = 'new' | 'old' | 'lost' | 'unreadable';
const signer = makeSigner(key)!;
const open = (dir: string, o: { keyState?: KS; keyless?: boolean } = {}) =>
  new GatesStore(dir, { allowed: PRESETS, ...(o.keyless ? {} : { signer }), ...(o.keyState ? { keyState: o.keyState } : {}) });
const modeFor = (root: string, agentMode: 'ask' | 'full', pid: string, keyState: KS = 'old') =>
  createGatesCore({ dataDir: root, keyring: { get: () => key, state: () => keyState } }).resolver.mode({ agentMode, source: 'own', startProjectId: pid });
/** P was Bypass (old copy kept), then tightened to Ask. */
async function setup() {
  const root = cleanupTemp('legion-gr2-'); const dir = join(root, 'gates');
  const s = open(dir); s.patchProject(P, { preset: 'bypass' }); await s.flush();
  const oldP = readFileSync(join(dir, `${P}.json`), 'utf8'); const oldApp = readFileSync(join(dir, 'app.json'), 'utf8');
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  return { root, dir, oldP, oldApp };
}

test('N1: app.json and a project file deleted: every project reads Ask and is listed, the agent is capped', async () => {
  const { root, dir } = await setup();
  assert.equal(modeFor(root, 'full', P), 'ask', 'before: the cap holds');
  rmSync(join(dir, 'app.json')); rmSync(join(dir, `${P}.json`));
  const t = open(dir, { keyState: 'old' });
  assert.equal(t.project(P).preset, 'ask');
  assert.equal(t.project(Q).preset, 'ask', 'a project that never had a file reads Ask too');
  assert.ok(t.view([P, Q]).changedOutside.includes('app') && t.view([P, Q]).changedOutside.includes(P) && t.view([P, Q]).changedOutside.includes(Q));
  assert.equal(modeFor(root, 'full', P), 'ask');
  assert.equal(modeFor(root, 'full', Q), 'ask');
});

test('N1b/N2: app.json deleted and the project file blanked or replaced by an old Bypass: Ask, listed, Bypass not applied', async () => {
  const a = await setup(); rmSync(join(a.dir, 'app.json')); writeFileSync(join(a.dir, `${P}.json`), '{"version":1}');
  assert.equal(modeFor(a.root, 'full', P), 'ask');
  const b = await setup(); rmSync(join(b.dir, 'app.json')); writeFileSync(join(b.dir, `${P}.json`), b.oldP);
  const t = open(b.dir, { keyState: 'old' });
  assert.equal(t.project(P).preset, 'ask');
  assert.ok(t.view([P]).changedOutside.includes(P));
  assert.equal(modeFor(b.root, 'full', P), 'ask');
});

test('N8c: the key was lost (new key, same folder): app.json does not verify, every project is Ask until the owner chooses', async () => {
  const { root, dir } = await setup();
  const t = new GatesStore(dir, { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 9))!, keyState: 'lost' });
  assert.equal(t.project(P).preset, 'ask');
  assert.ok(t.view([P]).changedOutside.includes('app'));
  rmSync(join(dir, 'app.json')); rmSync(join(dir, `${P}.json`));
  assert.equal(createGatesCore({ dataDir: root, keyring: { get: () => Buffer.alloc(32, 9), state: () => 'lost' } }).resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P }), 'ask');
});

test('a brand-new install (key state new, no files) is not a problem: nothing is listed', () => {
  const dir = join(cleanupTemp('legion-gr2-'), 'gates');
  const t = open(dir, { keyState: 'new' });
  assert.deepEqual(t.view([P]).changedOutside, []);
  assert.equal(t.project(P).preset, undefined);
});

test('N3: an app.json that does not verify does not let a replayed project file apply; Keep mine on app does not import its counter', async () => {
  const { root, dir, oldP } = await setup();
  const a = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')) as Record<string, unknown>; a.allowedHosts = ['x.com'];
  writeFileSync(join(dir, 'app.json'), JSON.stringify(a)); writeFileSync(join(dir, `${P}.json`), oldP);
  for (const ks of ['old', 'new'] as const) {
    const t = open(dir, { keyState: ks });
    assert.equal(t.project(P).preset, 'ask', `${ks}: the replayed Bypass is not applied`);
    assert.ok(t.view([P]).changedOutside.includes(P), `${ks}: listed`);
  }
  const t = open(dir, { keyState: 'old' });
  t.keepMine('app', [P, Q]); await t.flush();
  const u = open(dir, { keyState: 'old' });
  assert.equal(u.project(P).preset, 'ask');
  assert.equal(u.project(Q).preset, 'ask');
  assert.deepEqual(u.view([P, Q]).changedOutside, [], 'after Keep mine everything is Ask and nothing is waiting');
  assert.equal(modeFor(root, 'full', P), 'ask');
});

test('N4: an old signed app.json replayed alone is read as changed outside (its counter is below a project file)', async () => {
  const root = cleanupTemp('legion-gr2-'); const dir = join(root, 'gates');
  const s = open(dir); s.patchApp({ allowedHosts: ['evil.com'], preset: 'bypass' }); s.patchProject(P, { preset: 'ask' }); await s.flush();
  const oldApp = readFileSync(join(dir, 'app.json'), 'utf8');
  s.patchApp({ allowedHosts: [], preset: 'ask' }); s.patchProject(P, { preset: 'ask', limit: true }); await s.flush();
  writeFileSync(join(dir, 'app.json'), oldApp);
  const t = open(dir, { keyState: 'old' });
  assert.deepEqual(t.app().allowedHosts, undefined, 'the removed site is not approved again');
  assert.notEqual(t.app().preset, 'bypass');
  assert.ok(t.view([P]).changedOutside.includes('app'));
  assert.equal(createGatesCore({ dataDir: root, keyring: { get: () => key, state: () => 'old' } }).resolver.mode({ agentMode: 'ask', source: 'project', startProjectId: Q }), 'ask');
});

test('N5: with no key, a listed project file blanked reads Ask and is listed; a keyless app save keeps the list', async () => {
  const { dir } = await setup();
  writeFileSync(join(dir, `${P}.json`), '{"version":1}');
  const t = open(dir, { keyless: true });
  assert.equal(t.project(P).preset, 'ask');
  assert.ok(t.changedOutside().includes(P));
  const before = readFileSync(join(dir, 'app.json'), 'utf8');
  t.patchApp({ preset: 'ask' }); await t.flush();
  assert.equal(readFileSync(join(dir, 'app.json'), 'utf8'), before, 'the signed app.json with its list is not rewritten without a key');
});

test('N7: a project missing from projects.json keeps its cap file and its list entry through a start', async () => {
  const { root, dir } = await setup();
  createGatesCore({ dataDir: root, keyring: { get: () => key, state: () => 'old' }, projects: { list: () => [{ id: Q }] } as never });
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(readdirSync(dir).includes(`${P}.json`), 'the cap file is still there');
  assert.equal(modeFor(root, 'full', P), 'ask', 'put back, the cap still holds');
  assert.ok(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).files[P] !== undefined, 'and it is still listed');
});

test('N9: a file saved with a byte order mark is applied, not renamed aside', async () => {
  const dir = join(cleanupTemp('legion-gr2-'), 'gates'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${P}.json`), '﻿' + JSON.stringify({ version: 1, preset: 'ask' }));
  const t = open(dir, { keyless: true });
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.view([P]).unreadable, []);
  assert.equal(readdirSync(dir).some((n) => n.includes('.bad-')), false);
});

test('N11: Accept on a listed file with nothing on disk says what to do', async () => {
  const { dir } = await setup();
  rmSync(join(dir, `${P}.json`));
  const t = open(dir, { keyState: 'old' });
  assert.throws(() => t.accept(P), (e: Error) => /no file to apply/i.test(e.message) && /Keep mine/.test(e.message));
});

test('key state: the launch line carries new, old or lost; electron decides it before the key file is made', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(gatesKeyLine(hex, 'lost'), `GATESKEY ${hex} lost\n`);
  const kr = new GatesKeyring();
  assert.equal(kr.installLine(`GATESKEY ${hex} lost`), true);
  assert.equal(kr.state(), 'lost');
  const k2 = new GatesKeyring(); k2.installLine(`GATESKEY ${hex}`); assert.equal(k2.state(), 'old', 'a line with no state is treated as old (the safe one)');
  assert.equal(new GatesKeyring().installLine(`GATESKEY ${hex} fresh`), false);
  const root = cleanupTemp('legion-gr2-');
  assert.equal(gatesKeyState(root), 'new', 'an empty data folder');
  writeFileSync(join(root, 'projects.json'), '[]');
  assert.equal(gatesKeyState(root), 'lost', 'a data folder in use with no key file');
  writeFileSync(gatesKeyFilePath(root), 'x');
  assert.equal(gatesKeyState(root), 'old');
  const main = readFileSync(join(process.cwd(), 'src/electron/main.ts'), 'utf8');
  assert.ok(main.indexOf('gatesKeyState(dataDir())') > -1 && main.indexOf('gatesKeyState(dataDir())') < main.indexOf('ensureGatesKey(dataDir()'), 'decided before the key file is made');
  assert.match(main, /gatesKeyLine\(gatesKey, gatesState\)/);
  assert.equal(existsSync(root), true);
});

// ---- fix round 3 ----
const lostFolder = async () => { const a = await setup(); rmSync(join(a.dir, 'app.json')); rmSync(join(a.dir, `${P}.json`)); return a; };

test('N13: a project write while the list is lost does not write app.json: after a restart P is still Ask and listed (tighten Q, Keep mine on Q, Accept on P)', async () => {
  for (const how of ['tighten', 'keepQ', 'reload'] as const) {
    const { root, dir } = await lostFolder();
    const t = open(dir, { keyState: 'old' });
    if (how === 'tighten') t.patchProject(Q, { preset: 'ask' });
    else if (how === 'keepQ') t.keepMine(Q);
    else { t.patchProject(Q, { preset: 'ask' }); t.reload(); }
    await t.flush();
    assert.equal(existsSync(join(dir, 'app.json')), false, `${how}: app.json was not rewritten from a partial list`);
    const u = open(dir, { keyState: 'old' });
    assert.equal(u.project(P).preset, 'ask', how);
    assert.ok(u.view([P, Q]).changedOutside.includes(P), `${how}: P is still listed`);
    assert.equal(modeFor(root, 'full', P), 'ask', how);
  }
});

test('N14: a key file that does not open: every project reads Ask and is listed, even with app.json and P deleted or blanked', async () => {
  const { root, dir } = await setup();
  rmSync(join(dir, 'app.json')); writeFileSync(join(dir, `${P}.json`), '{"version":1}');
  const t = open(dir, { keyless: true, keyState: 'unreadable' });
  assert.equal(t.project(P).preset, 'ask');
  assert.equal(t.project(Q).preset, 'ask');
  const v = t.view([P, Q]);
  assert.ok(v.changedOutside.includes('app') && v.changedOutside.includes(P) && v.keyUnreadable);
  assert.equal(createGatesCore({ dataDir: root, keyring: { get: () => undefined, state: () => 'unreadable' } }).resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P }), 'ask');
  t.keepMine('app', [P, Q]);
  assert.equal(t.project(Q).preset, 'ask', 'Keep mine does not end it: nothing can be verified');
});

test('N14: the launch line GATESKEY - unreadable is its own state', () => {
  const k = new GatesKeyring();
  assert.equal(k.installLine(gatesKeyLine(undefined, 'unreadable')), true);
  assert.equal(k.state(), 'unreadable'); assert.equal(k.has(), false);
});
