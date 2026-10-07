/** U1: upgrade migration. Builder's VM size 'large' (the old seed) is reset to 'default' once; never again, never over a later manual choice. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';

const ID = 'builder-vm-size-default-v1';
/** Every migration a state file records once it has been loaded (0.2.5-c added the Zealot prompt one after this one). */
const ALL = [ID, 'zealot-lead-prompt-v1', 'souls-codex-v1', 'roster-comms-lines-v1', 'lead-name-marshal-v1'];
/** A state.json as an older build wrote it: no `migrations` field, Builder (and Scout, for contrast) on 'large'. */
function oldState(dir: string): void {
  const st = new Store(cleanupTemp('legion-mig-seed-'));
  st.seedDefaults(join(dir, 'w'));
  const agents = st.listAgents().map((a) => (a.id === 'builder' || a.id === 'scout' ? { ...a, vm: { ...a.vm, size: 'large' as const } } : a));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, tasks: [], vms: [] }));
}
const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { agents: Array<{ id: string; vm: { size: string; enabled: boolean } }>; migrations?: string[] };

test('U1: an old state file with Builder on large is reset to default on upgrade, and only Builder', async () => {
  const dir = cleanupTemp('legion-mig-');
  oldState(dir);
  const s = new Store(dir);
  assert.equal(s.getAgent('builder')!.vm.size, 'default');
  assert.equal(s.getAgent('builder')!.vm.enabled, true, 'other VM settings are kept');
  assert.equal(s.getAgent('scout')!.vm.size, 'large', 'no other agent is touched');
  await s.flush();
  const d = onDisk(dir);
  assert.deepEqual(d.migrations, ALL);
  assert.equal(d.agents.find((a) => a.id === 'builder')!.vm.size, 'default');
});

test('U1: it never re-applies: a later manual choice of large survives every restart', async () => {
  const dir = cleanupTemp('legion-mig-');
  oldState(dir);
  const s1 = new Store(dir);
  await s1.flush();
  const b = s1.getAgent('builder')!;
  s1.upsertAgent({ ...b, vm: { ...b.vm, size: 'large' } }); // the user picks large again
  await s1.flush();
  const s2 = new Store(dir);
  assert.equal(s2.getAgent('builder')!.vm.size, 'large', 'not overridden');
  await s2.flush();
  assert.equal(new Store(dir).getAgent('builder')!.vm.size, 'large');
  assert.deepEqual(onDisk(dir).migrations, ALL);
});

test('U1: a fresh install records the migration without touching anything, so a later large is kept', async () => {
  const dir = cleanupTemp('legion-mig-');
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  assert.equal(s.getAgent('builder')!.vm.size, 'default');
  const b = s.getAgent('builder')!;
  s.upsertAgent({ ...b, vm: { ...b.vm, size: 'large' } });
  await s.flush();
  assert.deepEqual(onDisk(dir).migrations, ALL);
  assert.equal(new Store(dir).getAgent('builder')!.vm.size, 'large');
});

test('U1: a state already on default, or without a Builder, just gets the flag', async () => {
  const dir = cleanupTemp('legion-mig-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents: [], tasks: [], vms: [] }));
  const s = new Store(dir);
  assert.equal(s.getAgent('builder'), undefined);
  await s.flush();
  assert.deepEqual(onDisk(dir).migrations, ALL);
});

test('U1: an agent entry with no vm object does not crash the migration', async () => {
  const dir = cleanupTemp('legion-mig-');
  oldState(dir);
  const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { agents: Array<Record<string, unknown>> };
  delete raw.agents.find((a) => a.id === 'builder')!.vm;
  writeFileSync(join(dir, 'state.json'), JSON.stringify(raw));
  const s = new Store(dir);
  assert.ok(s.getAgent('builder'), 'the store loaded');
  await s.flush();
  assert.deepEqual(onDisk(dir).migrations, ALL);
});

/** Rename to the Marshal (2026-10-07): the old seeded name and the exact old soul move; a person's own name or prompt never does. */
function preRenameState(dir: string, patch: { name?: string; systemPrompt?: string }): string {
  const seed = new Store(cleanupTemp('legion-mig-seed-'));
  seed.seedDefaults(join(dir, 'w'));
  const OLD_SOUL = seed.getAgent('zealot')!.systemPrompt.replace('You are the Marshal, the lead', 'You are Zealot, the lead');
  const agents = seed.listAgents().map((a) => (a.id === 'zealot' ? { ...a, name: 'Zealot', systemPrompt: OLD_SOUL, ...patch } : a));
  const done = ALL.filter((m) => m !== 'lead-name-marshal-v1');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, tasks: [], vms: [], migrations: done }));
  return OLD_SOUL;
}

test('lead-name-marshal-v1: the seeded "Zealot" name and the exact old soul become the Marshal; the id stays', () => {
  const dir = cleanupTemp('legion-mig-');
  const old = preRenameState(dir, {});
  const z = new Store(dir).getAgent('zealot')!;
  assert.equal(z.name, 'Marshal');
  assert.notEqual(z.systemPrompt, old);
  assert.match(z.systemPrompt, /^You are the Marshal, the lead of the Order/);
});

test('lead-name-marshal-v1: a name or prompt the person wrote is never touched', () => {
  const dir = cleanupTemp('legion-mig-');
  preRenameState(dir, { name: 'Captain', systemPrompt: 'You are Zealot. My own words.' });
  const z = new Store(dir).getAgent('zealot')!;
  assert.equal(z.name, 'Captain');
  assert.equal(z.systemPrompt, 'You are Zealot. My own words.');
});
