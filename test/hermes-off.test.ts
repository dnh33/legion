/**
 * W3 / R75: Hermes is off until the owner turns it on ("Offer Hermes", Settings, Agent hosts). While it is off, nothing starts it:
 * not the core start, not the model list, not the Doctor (with or without the probe flag), not the Settings page, not a warm-up and not a run.
 * A fake `hermes` (test/acp-fake-hermes.ts) is the only program on PATH and logs every call, so "zero" is counted, not assumed.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { BUILTIN_HERMES } from '../src/shared/acp-view.js';
import { defaultAcp, defaultConfig, migrateHermesOptIn, normalizeAcp } from '../src/shared/config.js';
import { agentDoctorRows } from '../src/core/acp/doctor-rows.js';
import { detectAgent, forgetDetections, lookupAgent, peekDetection, readAgentWaits, warmHermes } from '../src/core/acp/detect.js';
import { runDoctor } from '../src/core/doctor.js';
import { getCatalog } from '../src/core/catalog.js';
import { SettingsService } from '../src/core/settings.js';
import { EventBus } from '../src/core/bus.js';
import type { QueryFn } from '../src/core/engine.js';

const WIN = process.platform === 'win32';
const FAKE = fileURLToPath(new URL('./acp-fake-hermes.js', import.meta.url));
const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined) => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};
let binDir = '';
let emptyDir = '';
let log = '';
let dataDir = '';

before(() => {
  binDir = tempDir('hermes-off-bin-');
  emptyDir = tempDir('hermes-off-empty-');
  const fake = join(binDir, 'acp-fake-hermes.mjs');
  copyFileSync(FAKE, fake);
  if (WIN) writeFileSync(join(binDir, 'hermes.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else { writeFileSync(join(binDir, 'hermes'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(join(binDir, 'hermes'), 0o755); }
});
after(() => { forgetDetections(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
beforeEach(() => {
  forgetDetections();
  const state = tempDir('hermes-off-state-');
  dataDir = tempDir('hermes-off-data-');
  log = join(state, 'calls.log');
  writeFileSync(log, '');
  setEnv('PATH', binDir);
  setEnv('FAKE_HERMES_STATE', state);
  setEnv('FAKE_HERMES_LOG', log);
  setEnv('FAKE_HERMES_HANDSHAKE', '1');
});
const calls = (): string[][] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const hermesOff = () => defaultAcp().entries[0]!;

// ------------------------------------------------------------------ the default

test('R75: Hermes is off in a fresh config, and only an explicit true turns it on', () => {
  assert.equal(defaultAcp().entries[0]!.enabled, false);
  assert.equal(defaultConfig().acp.entries[0]!.enabled, false);
  assert.equal(normalizeAcp(undefined).entries[0]!.enabled, false);
  assert.equal(normalizeAcp({ entries: [{ id: 'hermes' }] }).entries[0]!.enabled, false, 'an entry with no "enabled" is off');
  assert.equal(normalizeAcp({ entries: [{ id: 'hermes', enabled: 'yes' }] }).entries[0]!.enabled, false);
  assert.equal(normalizeAcp({ entries: [{ id: 'hermes', enabled: true }] }).entries[0]!.enabled, true);
  assert.equal(normalizeAcp({ entries: [{ id: 'hermes', enabled: false }] }).entries[0]!.enabled, false);
});

// ------------------------------------------------------------------ migration: whoever already used Hermes keeps it

const cfgFile = (disk: unknown) => { const f = join(tempDir('hermes-off-cfg-'), 'config.json'); writeFileSync(f, JSON.stringify(disk)); return f; };
const onDisk = (f: string): any => JSON.parse(readFileSync(f, 'utf8'));

test('migration: an agent on Hermes, or the Contained switch, keeps Hermes on; the choice is written once; everyone else stays off', () => {
  const used = cfgFile({ port: 4747 });
  const config = defaultConfig();
  assert.equal(migrateHermesOptIn({ configPath: used, config, agentsUseHermes: true }), 'kept');
  assert.equal(config.acp.entries[0]!.enabled, true, 'the running config follows');
  assert.equal(onDisk(used).acp.entries.find((e: any) => e.id === 'hermes').enabled, true);
  assert.ok(onDisk(used).migrations.includes('acp-hermes-opt-in'));

  const contained = cfgFile({ acp: { entries: [{ id: 'hermes', contained: true }] } });
  const c2 = defaultConfig(); c2.acp = normalizeAcp({ entries: [{ id: 'hermes', contained: true }] });
  assert.equal(migrateHermesOptIn({ configPath: contained, config: c2, agentsUseHermes: false }), 'kept');
  assert.equal(c2.acp.entries[0]!.enabled, true);
  assert.equal(onDisk(contained).acp.entries[0].contained, true, 'the Contained choice is kept');

  const nobody = cfgFile({ port: 4747 });
  const c3 = defaultConfig();
  assert.equal(migrateHermesOptIn({ configPath: nobody, config: c3, agentsUseHermes: false }), 'off');
  assert.equal(c3.acp.entries[0]!.enabled, false);

  // done once: an owner who turned Hermes off afterwards is not switched back on at the next start
  const again = cfgFile({ migrations: ['acp-hermes-opt-in'], acp: { entries: [{ id: 'hermes', enabled: false }] } });
  const c4 = defaultConfig();
  assert.equal(migrateHermesOptIn({ configPath: again, config: c4, agentsUseHermes: true }), 'done');
  assert.equal(c4.acp.entries[0]!.enabled, false);
});

test('migration: an explicit choice in the file is never overridden', () => {
  const f = cfgFile({ acp: { entries: [{ id: 'hermes', enabled: false }] } });
  const config = defaultConfig(); config.acp = normalizeAcp({ entries: [{ id: 'hermes', enabled: false }] });
  assert.equal(migrateHermesOptIn({ configPath: f, config, agentsUseHermes: true }), 'explicit');
  assert.equal(config.acp.entries[0]!.enabled, false);
  assert.ok(onDisk(f).migrations.includes('acp-hermes-opt-in'));
});

// ------------------------------------------------------------------ nothing starts while it is off

const fakeQuery = (): QueryFn => ((_: unknown) => ({ supportedCommands: async () => [], supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }], accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined })) as unknown as QueryFn;
const cfg = () => { const c = defaultConfig(); c.workspaceDir = join(tempDir('hermes-off-ws-'), 'ws'); return c; };

test('R75: with Hermes off, the detection, the waits and the warm-ups start no process (zero fake-hermes calls)', async () => {
  const e = hermesOff();
  const deps = { dataDir };
  assert.equal(peekDetection(e).checked, false);
  assert.equal(peekDetection(e).found, false);
  const off = await detectAgent(e, deps);
  assert.equal(off.checked, false);
  assert.doesNotMatch(off.detail ?? '', /From the Hermes environment|pm install|Older than the oldest/, 'no start, so no start-failure or version wording');
  assert.equal((await detectAgent(e, { ...deps, force: true })).checked, false);
  await readAgentWaits(e, deps);
  await warmHermes(e, deps, { inUse: true, runStart: true });
  await warmHermes(e, deps, { inUse: true, runStart: false });
  assert.deepEqual(calls(), []);
});

test('R75: with Hermes off, the model list has no Hermes group and starts nothing', async () => {
  const c = await getCatalog({ config: cfg(), queryFn: fakeQuery(), hosts: { entries: () => [hermesOff()], dataDir } }, { force: true });
  assert.deepEqual(c.hosts ?? [], []);
  const bare = await getCatalog({ config: cfg(), queryFn: fakeQuery(), hosts: { dataDir } }, { force: true });
  assert.deepEqual(bare.hosts ?? [], [], 'no entries given: the shipped default is off too');
  assert.deepEqual(calls(), []);
});

test('R75: with Hermes off, the Doctor has no Hermes rows at all, with or without the probe flag, and starts nothing', async () => {
  for (const probeAgents of [false, true]) {
    const checks = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: fakeQuery(), agentHost: { dataDir, entries: () => [hermesOff()] }, probeAgents });
    assert.deepEqual(checks.filter((c) => c.id.startsWith('acp-')), [], `probeAgents=${probeAgents}`);
    assert.ok(checks.some((c) => c.id === 'workspace'), 'the other rows are still there');
  }
  const noEntries = await runDoctor({ config: cfg(), getBoat: () => null, queryFn: fakeQuery(), agentHost: { dataDir }, probeAgents: true });
  assert.deepEqual(noEntries.filter((c) => c.id.startsWith('acp-')), [], 'the config default is off');
  assert.deepEqual(await agentDoctorRows([hermesOff()], { dataDir }, { probe: true }), []);
  assert.deepEqual(calls(), []);
});

test('R75: the Settings page says "found" from a PATH lookup alone, or "missing", and starts nothing', () => {
  const file = join(tempDir('hermes-off-set-'), 'config.json');
  writeFileSync(file, JSON.stringify({ port: 4747 }));
  const svc = new SettingsService({ config: defaultConfig(), bus: new EventBus(), configPath: file, dataDir });
  const hermes = () => svc.view().acp.entries.find((e) => e.id === 'hermes')!;
  assert.equal(hermes().enabled, false);
  assert.equal(hermes().detection.state, 'found');
  assert.equal(hermes().detection.checked, false);
  assert.equal(lookupAgent(hermesOff()).found, true);
  forgetDetections();
  setEnv('PATH', emptyDir);
  assert.equal(hermes().detection.state, 'missing');
  assert.deepEqual(calls(), []);
});

test('R75: turning Hermes on is a plain save: the view then reads the quick check and the entry is offered', async () => {
  const file = join(tempDir('hermes-off-on-'), 'config.json');
  writeFileSync(file, JSON.stringify({ port: 4747 }));
  const config = defaultConfig();
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir });
  svc.patch({ acp: { entries: [{ id: 'hermes', enabled: true }] } });
  assert.equal(config.acp.entries[0]!.enabled, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).acp.entries.find((e: any) => e.id === 'hermes').enabled, true);
  const c = await getCatalog({ config: cfg(), queryFn: fakeQuery(), hosts: { entries: () => config.acp.entries, dataDir } }, { force: true });
  assert.deepEqual(c.hosts, [{ value: 'acp:hermes', label: 'Hermes', entryId: 'hermes' }]);
  assert.equal(existsSync(log), true);
});

test('R75: BUILTIN_HERMES stays the entry as it is when offered (the tests and the Doctor read it)', () => {
  assert.equal(BUILTIN_HERMES.enabled, true);
});
