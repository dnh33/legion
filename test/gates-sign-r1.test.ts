// test/gates-sign-r1.test.ts: fix round 1 for signed gate files (delete, blank, replay, cap removal, reload, own key)
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { PRESETS } from '../src/shared/gates-registry.js';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import { GatesKeyring } from '../src/core/gates-settings/keyring.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { ensureGatesKey, gatesKeyFilePath, gatesKeyLine, loadGatesKey, ensureConnectorKey, keyFilePath, type SafeStorageLike } from '../src/electron/connector-key.js';
import { readLaunchSecrets } from '../src/core/admin.js';
import { AUTH, makeFakes, start } from './helpers-c.js';

const key = Buffer.alloc(32, 7);
const P = 'proj_aaaaaaaaaaaa';
const Q = 'proj_bbbbbbbbbbbb';
const mk = () => {
  const dir = join(cleanupTemp('legion-gr1-'), 'gates');
  mkdirSync(dir, { recursive: true });
  const signer = makeSigner(key)!;
  return { dir, open: () => new GatesStore(dir, { allowed: PRESETS, signer }) };
};
const J = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;

test('C1: deleting a signed capped project file does not remove the cap: it reads Ask and is listed', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  rmSync(join(dir, `${P}.json`));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
});

test('C1: a signed project file replaced by an unsigned blank one reads Ask, is listed, and is not re-signed as genuine', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  const f = join(dir, `${P}.json`);
  writeFileSync(f, JSON.stringify({ version: 1 }));
  const t = open(); await t.flush();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
  assert.equal('sig' in J(f), false, 'the blank file was left alone, not signed');
});

test('C1: with a key, an unsigned project file with no cap (even if never listed) reads Ask and is listed', () => {
  const { dir, open } = mk(); open();
  writeFileSync(join(dir, `${P}.json`), JSON.stringify({ version: 1 }));
  writeFileSync(join(dir, `${Q}.json`), JSON.stringify({ version: 1, preset: 'smart', limit: false }));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside().sort(), [P, Q]);
});

test('C1: Keep mine on a deleted file writes the Ask file back signed; Accept has nothing on disk to apply', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  rmSync(join(dir, `${P}.json`));
  const t = open();
  assert.throws(() => t.accept(P), (e: unknown) => e instanceof GatesError && e.status === 404);
  t.keepMine(P); await t.flush();
  const u = open();
  assert.deepEqual(u.changedOutside(), []);
  assert.equal(u.project(P).preset, 'ask');
});

test('C1: a deleted project is dropped from the list by prune, so it is not flagged after a restart', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  s.prune([Q]); await s.flush();
  assert.equal(existsSync(join(dir, `${P}.json`)), false);
  assert.deepEqual(open().changedOutside(), []);
});

test('C1: an unsigned Ask file from before signing is still taken, and signed on the first save', async () => {
  const { dir, open } = mk(); open();
  const f = join(dir, `${P}.json`);
  writeFileSync(f, JSON.stringify({ version: 1, preset: 'ask' }));
  const t = open(); await t.flush();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), []);
  assert.match(String(J(f).sig), /^[0-9a-f]{64}$/);
});

test('I1: an older signed file copied back is listed as changed outside and does not apply', async () => {
  const { dir, open } = mk(); const s = open();
  const f = join(dir, `${P}.json`);
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  copyFileSync(f, join(dir, 'old-copy.txt'));
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  copyFileSync(join(dir, 'old-copy.txt'), f);
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
});

test('I1: the newest file still verifies after restarts and many saves; counters only go up', async () => {
  const { dir, open } = mk(); let s = open();
  for (const p of ['smart', 'ask', 'smart', 'accept-edits'] as const) { s.patchProject(P, { preset: p }); await s.flush(); s = open(); }
  assert.equal(s.project(P).preset, 'accept-edits');
  assert.deepEqual(s.changedOutside(), []);
  const gens = [J(join(dir, `${P}.json`)).gen as number];
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  gens.push(J(join(dir, `${P}.json`)).gen as number);
  assert.ok(gens[1]! > gens[0]!, 'the counter grew');
});

test('I1: project A file moved to project B does not verify', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  writeFileSync(join(dir, `${Q}.json`), readFileSync(join(dir, `${P}.json`)));
  const t = open();
  assert.equal(t.project(Q).preset, 'ask');
  assert.ok(t.changedOutside().includes(Q));
});

test('C2: removing a cap is a loosening; going from no cap to no cap is not', () => {
  const { open } = mk(); const s = open();
  assert.equal(s.isLoosening(P, { preset: null }), false, 'no cap to no cap');
  s.patchProject(P, { preset: 'ask' });
  assert.equal(s.isLoosening(P, { preset: null }), true, 'Ask to Per agent removes the cap');
  s.patchProject(P, { preset: 'bypass' });
  assert.equal(s.isLoosening(P, { preset: null }), true);
  assert.equal(s.isLoosening(P, { preset: 'ask' }), false);
  assert.equal(s.isLoosening(P, { limit: false }), true);
});

test('C2: with no key, removing a cap is refused', () => {
  const dir = join(cleanupTemp('legion-gr1-nk-'), 'gates');
  const s = new GatesStore(dir, { allowed: PRESETS });
  s.patchProject(P, { preset: 'ask' });
  assert.throws(() => s.patchProject(P, { preset: null }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.equal(s.project(P).preset, 'ask');
});

test('I2: app-level overrides are refused (a patch) and ignored (a file), with or without a key', () => {
  const { dir, open } = mk(); const s = open();
  assert.throws(() => s.patchApp({ overrides: { 'update-consent': false } }), (e: unknown) => e instanceof GatesError && e.status === 400);
  const nk = new GatesStore(join(cleanupTemp('legion-gr1-ao-'), 'gates'), { allowed: PRESETS });
  assert.throws(() => nk.patchApp({ overrides: { 'tool-cards': false } }), (e: unknown) => e instanceof GatesError && e.status === 400);
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ version: 1, overrides: { 'update-consent': false } }));
  assert.equal(open().app().overrides, undefined);
});

test('I3: Reload saves a change that is still waiting to be written, so it cannot undo a tightening', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  s.patchProject(P, { preset: 'ask' }); // not flushed yet
  s.reload();
  assert.equal(s.project(P).preset, 'ask');
  assert.equal(open().project(P).preset, 'ask');
  assert.deepEqual(s.changedOutside(), []);
  assert.ok(existsSync(join(dir, `${P}.json`)));
});

test('I3: when the change cannot be written, Reload is refused (409) and memory keeps the tighter value', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  mkdirSync(join(dir, `${P}.json.tmp`)); // the temp file cannot be created: every write fails
  s.patchProject(P, { preset: 'ask' });
  assert.throws(() => s.reload(), (e: unknown) => e instanceof GatesError && e.status === 409);
  assert.equal(s.project(P).preset, 'ask');
});

test('I3 over the route: an admin-only reload with an unsaved tightening is 409 and the project stays Ask', async () => {
  const data = join(cleanupTemp('legion-gr1-rt-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const p = projects.create({ name: 'Shop' });
  const f = makeFakes({ holdRuns: true });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir: data, projects, keyring: { get: () => key } });
  const mod = createGatesModule(deps, { projects, core, nativeSecret: 'n' });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  try {
    core.store.patchProject(p.id, { preset: 'bypass' }); await core.store.flush();
    mkdirSync(join(data, 'gates', `${p.id}.json.tmp`));
    core.store.patchProject(p.id, { preset: 'ask' });
    const res = await fetch(s.base + '/api/gates/reload', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 409);
    assert.equal(core.store.project(p.id).preset, 'ask');
    // C2 over the route: admin only cannot remove the cap
    const rm = await fetch(s.base + `/api/gates/projects/${p.id}`, { method: 'PATCH', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ preset: null }) });
    assert.equal(rm.status, 403);
    assert.equal(core.store.project(p.id).preset, 'ask');
  } finally { await mod.dispose?.(); await s.close(); }
});

// ----------------------------------------------------------------------------------------------- I5: a key of its own

const fakeStorage = (usable = true): SafeStorageLike => ({
  isAsyncEncryptionAvailable: async () => usable,
  encryptStringAsync: async (p) => Buffer.from('WRAP:' + p),
  decryptStringAsync: async (b) => ({ result: b.toString().slice(5), shouldReEncrypt: false }),
});

test('I5: the gates key is created without any connector, in its own file, and reloads the same', async () => {
  const dir = cleanupTemp('legion-gkey-');
  assert.equal(existsSync(keyFilePath(dir)), false);
  const hex = await ensureGatesKey(dir, fakeStorage(), 'win32');
  assert.match(hex!, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(gatesKeyFilePath(dir)), true);
  assert.equal(existsSync(keyFilePath(dir)), false, 'no connector key was made');
  assert.equal(await loadGatesKey(dir, fakeStorage(), 'win32'), hex);
  assert.equal(await ensureGatesKey(dir, fakeStorage(), 'win32'), hex, 'the same key, not a new one');
  const conn = await ensureConnectorKey(dir, fakeStorage(), 'win32');
  assert.notEqual(conn, hex, 'the two keys are different');
});

test('I5: with no usable keystore there is no gates key (fail closed: only Ask)', async () => {
  const dir = cleanupTemp('legion-gkey-');
  assert.equal(await ensureGatesKey(dir, fakeStorage(false), 'win32'), undefined);
  assert.equal(existsSync(gatesKeyFilePath(dir)), false);
  assert.equal(await ensureGatesKey(dir, fakeStorage(true), 'linux'), undefined, 'linux without a real backend');
});

test('I5: the core installs the gates key from its own launch line, and only that form', async () => {
  const hex = 'c'.repeat(64);
  assert.equal(gatesKeyLine(hex), `GATESKEY ${hex} old\n`);
  const kr = new GatesKeyring();
  assert.equal(kr.installLine('KEY ' + hex), false);
  assert.equal(kr.installLine('GATESKEY zz'), false);
  const s = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s, (l) => { kr.installLine(l); });
  s.write(`${'a'.repeat(64)}\n${'b'.repeat(64)}\n${gatesKeyLine(hex)}`);
  await p;
  assert.deepEqual(kr.get(), Buffer.from(hex, 'hex'));
  assert.equal(String(kr), '[GatesKeyring]');
});

test('I5: main.ts creates the gates key at launch and passes it as its own line; legion-core installs it', () => {
  const main = readFileSync(join(process.cwd(), 'src/electron/main.ts'), 'utf8');
  assert.match(main, /const gatesKey = await ensureGatesKey\(dataDir\(\), safeStorage\);/);
  assert.match(main, /gatesKeyLine\(gatesKey, gatesState\)/);
  const core = readFileSync(join(process.cwd(), 'src/bin/legion-core.ts'), 'utf8');
  assert.match(core, /keyring: gatesKeyring/);
});
