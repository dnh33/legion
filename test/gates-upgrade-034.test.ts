// test/gates-upgrade-034.test.ts: a data folder shaped like 0.3.4 meets the keyed 0.3.5 start (final review C1).
// 0.3.4 never made gates-key.bin and never wrote a signed gates file. Electron's first keyed start must read as a first start (`new`), not as
// "the key was lost": own Full / Accept edits agents keep their mode, nothing is listed as changed outside, app-level saves work.
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import { GatesKeyring } from '../src/core/gates-settings/keyring.js';
import { gatesKeyFilePath, gatesKeyLine, gatesKeyState } from '../src/electron/connector-key.js';

const P1 = 'proj_aaaaaaaaaaaa';
const HEX = 'a1'.repeat(32);

/** A data folder as 0.3.4 leaves it: state.json (agents with modes), projects.json (p1 with both as members), optional gates files. */
function folder034(gates: 'none' | 'unsigned-app' | 'unsigned-app-and-ask-project'): string {
  const root = tempDir('legion-upg034-');
  writeFileSync(join(root, 'state.json'), JSON.stringify({ agents: [{ id: 'a_full', name: 'Full one', approval: 'full' }, { id: 'a_edits', name: 'Edits one', approval: 'auto-edits' }] }));
  writeFileSync(join(root, 'projects.json'), JSON.stringify({ projects: [{ id: P1, name: 'P', members: ['a_full', 'a_edits'], status: 'active' }] }));
  if (gates !== 'none') {
    mkdirSync(join(root, 'gates'));
    writeFileSync(join(root, 'gates', 'app.json'), JSON.stringify({ version: 1 }));
    if (gates === 'unsigned-app-and-ask-project') writeFileSync(join(root, 'gates', `${P1}.json`), JSON.stringify({ version: 1, preset: 'ask' }));
  }
  return root;
}

/** What Electron main does on the first keyed start: decide the state BEFORE the key file is made, then send the launch line. */
function startKeyed(root: string, hex: string = HEX) {
  const state = gatesKeyState(root);
  const ring = new GatesKeyring();
  assert.ok(ring.installLine(gatesKeyLine(hex, state).trim()));
  const core = createGatesCore({ dataDir: root, keyring: { get: () => ring.get(), state: () => ring.state() } });
  return { state, ring, core };
}

for (const variant of ['none', 'unsigned-app'] as const) {
  test(`C1 (${variant}): a 0.3.4 folder is a first keyed start: Full and Accept edits agents keep their mode, nothing is listed, app saves work`, () => {
    const root = folder034(variant);
    const { core } = startKeyed(root);
    const view = core.store.view([P1]);
    assert.deepEqual(view.changedOutside, [], 'no "changed outside" banner');
    assert.equal(view.app.preset, undefined, 'the app default is still "per agent"');
    assert.equal(core.store.project(P1).preset, undefined, 'the project has no preset');
    assert.equal(core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'full', 'own Full in a project stays Full');
    assert.equal(core.resolver.mode({ agentMode: 'auto-edits', source: 'own', startProjectId: P1 }), 'auto-edits', 'own Accept edits in a project stays Accept edits');
    assert.equal(core.resolver.mode({ agentMode: 'full', source: 'own' }), 'full');
    assert.doesNotThrow(() => core.store.patchApp({ noticeSeen: true }), 'the one-time notice can be saved');
    assert.doesNotThrow(() => core.store.patchApp({ preset: 'smart' }), 'a preset can be saved');
    assert.equal(core.store.app().preset, 'smart');
    assert.equal(core.store.app().noticeSeen, true);
  });
}

test('C1: an unsigned 0.3.4 Ask cap on a project keeps its 0.3.4 meaning (limit defaults on, so it caps its agents) and is not listed', () => {
  const capped = startKeyed(folder034('unsigned-app-and-ask-project')).core;
  assert.deepEqual(capped.store.view([P1]).changedOutside, []);
  assert.equal(capped.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'ask');
  assert.equal(capped.resolver.mode({ agentMode: 'auto-edits', source: 'own', startProjectId: P1 }), 'ask');
});

test('C1: the state the Electron code reports for a 0.3.4 folder is still a hint only: even a `lost` hint is read as new when gates/ has no signed file', () => {
  const root = folder034('unsigned-app');
  const ring = new GatesKeyring();
  ring.installLine(gatesKeyLine(HEX, 'lost').trim());
  const core = createGatesCore({ dataDir: root, keyring: { get: () => ring.get(), state: () => ring.state() } });
  assert.deepEqual(core.store.view([P1]).changedOutside, []);
  assert.equal(core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'full');
});

test('C1: after the first keyed start the files are signed and a second start (key now old) is still whole', async () => {
  const root = folder034('unsigned-app-and-ask-project');
  const first = startKeyed(root).core;
  first.store.patchApp({ noticeSeen: true });
  await first.store.flush();
  // the key file is there on the second start
  mkdirSync(join(root), { recursive: true });
  writeFileSync(gatesKeyFilePath(root), 'wrapped');
  const second = startKeyed(root);
  assert.equal(second.state, 'old');
  assert.deepEqual(second.core.store.view([P1]).changedOutside, []);
  assert.equal(second.core.store.app().noticeSeen, true);
  assert.equal(second.core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'ask');
});

test('C1 keeps its guard: a folder with a SIGNED app.json and no key file still reads lost', async () => {
  const root = folder034('none');
  const a = startKeyed(root).core;
  a.store.patchApp({ preset: 'smart' });
  await a.store.flush(); // now gates/app.json carries a signature
  // the key file is gone (the test never made one), so Electron makes a NEW key: the signed file no longer verifies
  const b = startKeyed(root, 'b2'.repeat(32));
  assert.equal(b.state, 'lost');
  assert.ok(b.core.store.view([P1]).changedOutside.includes('app'));
  assert.equal(b.core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'ask');
  assert.throws(() => b.core.store.patchApp({ noticeSeen: true }), /missing or were changed/);
});

test('C1 keeps its guard: a signed project file alone (app.json deleted) with no key file reads lost', async () => {
  const root = folder034('none');
  const a = startKeyed(root).core;
  a.store.patchProject(P1, { preset: 'ask' });
  await a.store.flush();
  rmSync(join(root, 'gates', 'app.json'));
  const b = startKeyed(root, 'b2'.repeat(32));
  assert.equal(b.state, 'lost');
  assert.ok(b.core.store.view([P1]).changedOutside.includes('app'));
});

// A system with no usable key store (Linux with no keyring, say): Electron sends `GATESKEY - unreadable` although no key file was ever made.
const startNoKeystore = (root: string) => {
  const ring = new GatesKeyring();
  assert.ok(ring.installLine(gatesKeyLine(undefined, 'unreadable').trim()));
  return createGatesCore({ dataDir: root, keyring: { get: () => ring.get(), state: () => ring.state() } });
};

test('C1 (no key store): a 0.3.4 folder with no key file and no signed gates file behaves as 0.3.4 did: modes unchanged, nothing listed, no false "could not be opened"', () => {
  for (const variant of ['none', 'unsigned-app'] as const) {
    const core = startNoKeystore(folder034(variant));
    assert.deepEqual(core.store.view([P1]).changedOutside, [], variant);
    assert.equal(core.store.view([P1]).keyUnreadable, false, variant);
    assert.equal(core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'full', variant);
    assert.equal(core.resolver.mode({ agentMode: 'auto-edits', source: 'own', startProjectId: P1 }), 'auto-edits', variant);
    assert.doesNotThrow(() => core.store.patchApp({ noticeSeen: true }), variant);
    assert.throws(() => core.store.patchApp({ preset: 'smart' }), /keystore/, `${variant}: only Ask can be stored without a key`);
  }
});

test('C1 (no key store) keeps its guards: a key file that is there and does not open, or a signed gates file, stays fail-closed', () => {
  const withKeyFile = folder034('none');
  writeFileSync(gatesKeyFilePath(withKeyFile), 'wrapped, cannot be opened');
  const a = startNoKeystore(withKeyFile);
  assert.equal(a.store.view([P1]).keyUnreadable, true);
  assert.ok(a.store.view([P1]).changedOutside.includes('app'));
  assert.equal(a.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'ask');
  const signed = folder034('none');
  mkdirSync(join(signed, 'gates'));
  writeFileSync(join(signed, 'gates', 'app.json'), JSON.stringify({ version: 1, gen: 1, sig: 'x' }));
  const b = startNoKeystore(signed);
  assert.equal(b.store.view([P1]).keyUnreadable, true);
  assert.equal(b.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'ask');
});

test('C1 limit, stated: key file AND every signed gates file gone reads as a first keyed start (the data-folder card in Full closes this door, M3)', async () => {
  const root = folder034('none');
  const a = startKeyed(root).core;
  a.store.patchProject(P1, { preset: 'ask' });
  await a.store.flush();
  rmSync(join(root, 'gates'), { recursive: true });
  const b = startKeyed(root, 'b2'.repeat(32));
  assert.equal(b.state, 'new');
  assert.deepEqual(b.core.store.view([P1]).changedOutside, []);
});

test('C1 window: a first keyed start that quits at once (nothing patched, nothing flushed) still leaves a folder the next start reads as whole', () => {
  for (const variant of ['none', 'unsigned-app', 'unsigned-app-and-ask-project'] as const) {
    const root = folder034(variant);
    startKeyed(root); // the first keyed start: no patch, no flush, the core goes away
    writeFileSync(gatesKeyFilePath(root), 'wrapped'); // main made the key file before it started the core
    const second = startKeyed(root);
    assert.equal(second.state, 'old', variant);
    assert.deepEqual(second.core.store.view([P1]).changedOutside, [], variant);
    const mode = variant === 'unsigned-app-and-ask-project' ? 'ask' : 'full';
    assert.equal(second.core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), mode, variant);
    assert.doesNotThrow(() => second.core.store.patchApp({ noticeSeen: true }), variant);
  }
});

// ---- fix round 2: the key file exists but the core never built the store (spawn failure, quick quit, Restart core) ----
import { ensureGatesKey } from '../src/electron/connector-key.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';
import { existsSync, readFileSync } from 'node:fs';

const fakeStore = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s: string) => Buffer.from(`enc:${s}`),
  decryptStringAsync: async (b: Buffer) => ({ result: b.toString().slice(4), shouldReEncrypt: false }),
};
const markerOf = (root: string): string => join(root, 'gates-key.unconfirmed');
const coreFor = (root: string, hex: string, state: ReturnType<typeof gatesKeyState>) => {
  const ring = new GatesKeyring();
  assert.ok(ring.installLine(gatesKeyLine(hex, state).trim()));
  return createGatesCore({ dataDir: root, keyring: { get: () => ring.get(), state: () => ring.state() } });
};

test('C1 window, as the reviewer ran it: Electron made gates-key.bin, no core started, the next start must not read lost', async () => {
  for (const variant of ['none', 'unsigned-app'] as const) {
    const root = folder034(variant);
    assert.equal(gatesKeyState(root), 'new');
    await ensureGatesKey(root, fakeStore, 'win32'); // main makes the key before it spawns the core; the core never builds the store
    const state = gatesKeyState(root);
    assert.equal(state, 'new', `${variant}: key file + marker + no signed file is still a first keyed start`);
    const hex = (await ensureGatesKey(root, fakeStore, 'win32'))!;
    const core = coreFor(root, hex, state);
    assert.deepEqual(core.store.view([P1]).changedOutside, [], variant);
    assert.equal(core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'full', variant);
    assert.doesNotThrow(() => core.store.patchApp({ noticeSeen: true }), variant);
    // the store signed what it found at once and took the marker away
    assert.equal(existsSync(markerOf(root)), false, `${variant}: the marker goes after the first signed write`);
    assert.equal(gatesKeyState(root), 'old');
  }
});

test('C1 window: the core itself reads key file + marker + no signed file as new, whatever the launch line said', async () => {
  const root = folder034('none');
  const hex = (await ensureGatesKey(root, fakeStore, 'win32'))!;
  const core = coreFor(root, hex, 'old');
  assert.deepEqual(core.store.view([P1]).changedOutside, []);
  assert.equal(core.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'full');
});

test('C1 window: a respawn in the same session sends new while gates/ has no signed file (the flag is the second layer)', async () => {
  const root = folder034('none');
  await ensureGatesKey(root, fakeStore, 'win32');
  rmSync(markerOf(root)); // the marker could not be written, or is gone
  assert.equal(gatesKeyState(root), 'old');
  assert.equal(gatesKeyState(root, { madeThisSession: true }), 'new');
  const main = readFileSync(join(process.cwd(), 'src/electron/main.ts'), 'utf8');
  assert.match(main, /madeThisSession/, 'main passes the session flag');
  // a signed file ends it
  const a = startKeyed(folder034('none'));
  a.core.store.patchApp({ preset: 'smart' });
  await a.core.store.flush();
});

test('C1 window: a marker next to a signed file never turns a lost or old folder into new', async () => {
  const root = folder034('none');
  const first = startKeyed(root);
  first.core.store.patchApp({ preset: 'smart' });
  await first.core.store.flush(); // signed
  writeFileSync(markerOf(root), 'x'); // an agent or a leftover
  assert.equal(gatesKeyState(root), 'lost', 'no key file, a signed file, a marker: lost');
  writeFileSync(gatesKeyFilePath(root), 'wrapped');
  assert.equal(gatesKeyState(root), 'old', 'key file, a signed file, a marker: old');
  assert.equal(gatesKeyState(root, { madeThisSession: true }), 'old', 'the session flag does not override a signed file');
  // the core agrees: a wrong key with a marker still reads lost
  const other = coreFor(root, 'c3'.repeat(32), 'old');
  assert.ok(other.store.view([P1]).changedOutside.includes('app'));
  assert.equal(other.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: P1 }), 'ask');
});

test('C1 window: the marker is in the protected set, and is made only with a new key in a folder with no signed file', async () => {
  assert.ok(dataFolderTargets(DATA_FOR_MARKER).some((t) => t.endsWith('gates-key.unconfirmed')));
  const root = folder034('none');
  await ensureGatesKey(root, fakeStore, 'win32');
  assert.equal(existsSync(markerOf(root)), true);
  const signed = folder034('none');
  mkdirSync(join(signed, 'gates'));
  writeFileSync(join(signed, 'gates', 'app.json'), JSON.stringify({ version: 1, gen: 1, sig: 'x' }));
  await ensureGatesKey(signed, fakeStore, 'win32'); // the key was lost and is made again
  assert.equal(existsSync(markerOf(signed)), false, 'no marker where a signed file already exists');
});
const DATA_FOR_MARKER = join(tmpdir(), 'legion-marker-probe');
