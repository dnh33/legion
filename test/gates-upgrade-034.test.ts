// test/gates-upgrade-034.test.ts: a data folder shaped like 0.3.4 meets the keyed 0.3.5 start (final review C1).
// 0.3.4 never made gates-key.bin and never wrote a signed gates file. Electron's first keyed start must read as a first start (`new`), not as
// "the key was lost": own Full / Accept edits agents keep their mode, nothing is listed as changed outside, app-level saves work.
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
