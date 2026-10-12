/**
 * The gates CONFIG layer: the tolerant loader (normalizeGates, loadConfig) and the strict Settings PATCH path —
 * a malformed rule is a 400 naming the rule, never a matcher surprise at run time; a good rule survives to disk
 * and back.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { SettingsError, SettingsService, validatePatch } from '../src/core/settings.js';
import { DEFAULT_GATES, defaultConfig, normalizeGates } from '../src/shared/config.js';
import type { GateRule } from '../src/shared/types.js';

const good: GateRule = { id: 'gr_a1', enabled: true, then: 'deny', when: { agents: ['zealot'], commands: ['rm -rf *'] }, label: 'Zealot may never run rm -rf', source: 'user' };

test('normalizeGates: absent, empty and garbage all read as "no rules" (today’s behaviour)', () => {
  assert.deepEqual(normalizeGates(undefined), { rules: [], presetsVersion: 0 });
  assert.deepEqual(normalizeGates(null), DEFAULT_GATES);
  assert.deepEqual(normalizeGates('nope'), DEFAULT_GATES);
  assert.deepEqual(normalizeGates({ rules: 'not-an-array' }), DEFAULT_GATES);
  assert.deepEqual(defaultConfig().gates, DEFAULT_GATES, 'a fresh config ships with no rules');
});

test('normalizeGates keeps the good rules and drops the unparseable ones (tolerant load)', () => {
  const g = normalizeGates({
    presetsVersion: 2,
    rules: [
      good,
      { id: 'bad id', then: 'deny', when: {} },          // id outside the gr_ shape
      { id: 'gr_b2', then: 'explode', when: {} },        // not a verdict
      'not-an-object',
      { id: 'gr_c3', enabled: false, then: 'allow', when: { tools: ['shell'], contexts: ['capped', 'nonsense'] }, source: 'card' },
    ],
  });
  assert.equal(g.rules.length, 2, 'the two parseable rules survive');
  assert.equal(g.presetsVersion, 2);
  assert.deepEqual(g.rules[0], { ...good, enabled: true, label: 'Zealot may never run rm -rf', source: 'user' });
  const c = g.rules[1]!;
  assert.deepEqual(c, { id: 'gr_c3', enabled: false, then: 'allow', when: { tools: ['shell'], contexts: ['capped'] }, label: 'allow rule', source: 'card' }, 'an unknown context is dropped, the valid one stays');
});

test('normalizeGates strict (the PATCH path) throws with a message naming the rule', () => {
  assert.throws(() => normalizeGates({ rules: [{ id: 'x', then: 'deny' }] }, { strict: true }), /rules\[0\]\.id/);
  assert.throws(() => normalizeGates({ rules: [{ ...good, then: 'nope' }] }, { strict: true }), /rules\[0\]\.then/);
  assert.throws(() => normalizeGates({ rules: [{ ...good, when: { commands: 5 } }] }, { strict: true }), /rules\[0\]\.when\.commands/);
  assert.throws(() => normalizeGates({ rules: [{ ...good, when: { contexts: ['bogus'] } }] }, { strict: true }), /rules\[0\]\.when\.contexts/);
  assert.throws(() => normalizeGates({ presetsVersion: -1 }, { strict: true }), /presetsVersion/);
  assert.deepEqual(normalizeGates({ rules: [good] }, { strict: true }).rules.length, 1, 'a good rule passes strict unchanged');
});

function svc(disk: unknown = {}) {
  const dir = cleanupTemp('legion-gates-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(disk));
  const config = defaultConfig();
  // The same two steps loadConfig takes on a real start: the disk block, read tolerantly.
  const d = disk as { gates?: unknown };
  if (d && typeof d === 'object' && d.gates !== undefined) config.gates = normalizeGates(d.gates);
  const s = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: mkdtempSync(join(tmpdir(), 'legion-gd-')) });
  return { s, config, file };
}

test('PATCH gates: validated, applied live, and written to config.json (survives a restart)', () => {
  const { s, file } = svc();
  const view = s.patch({ gates: { rules: [good], presetsVersion: 1 } });
  assert.deepEqual(view.gates, { rules: [good], presetsVersion: 1 }, 'applied live');
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(disk.gates, { rules: [good], presetsVersion: 1 }, 'persisted: gates is in the apply() persistence list');
  // A fresh service built the way loadConfig would (file over defaults) shows the same rules.
  const { s: again } = svc({ gates: { rules: [good], presetsVersion: 1 } });
  assert.deepEqual(again.view().gates.rules.map((r) => r.id), ['gr_a1']);
});

test('PATCH gates: learn false is kept live and on disk, a patch without it keeps it, true turns it back on', () => {
  const { s, file } = svc();
  assert.equal(s.patch({ gates: { rules: [], learn: false } }).gates?.learn, false);
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { gates: { learn?: boolean } }).gates.learn, false);
  assert.equal(s.patch({ gates: { rules: [] } }).gates?.learn, false, 'an older writer that omits it cannot switch learning back on');
  assert.equal(s.patch({ gates: { rules: [], learn: true } }).gates?.learn, true);
});

test('PATCH gates: a malformed rule is a 400 and config.json is untouched', () => {
  const { s, file } = svc({ port: 4747, custom: 1 });
  const before = readFileSync(file, 'utf8');
  assert.throws(
    () => s.patch({ gates: { rules: [{ ...good, then: 'nuke' as GateRule['then'] }] } }),
    (e: unknown) => e instanceof SettingsError && e.status === 400 && /rules\[0\]\.then/.test((e as Error).message),
  );
  assert.equal(readFileSync(file, 'utf8'), before, 'nothing was written');
  assert.deepEqual(s.view().gates, DEFAULT_GATES, 'in-memory config unchanged too');
});

test('validatePatch passes a good gates block through and rejects a bad one before touching config', () => {
  const p = validatePatch({ gates: { rules: [good] } });
  assert.deepEqual(p.gates?.rules?.length, 1);
  assert.throws(() => validatePatch({ gates: { rules: [{ id: 'gr_x', enabled: 'yes', then: 'deny' }] } }), /enabled/);
});

test('a hand-edited config.json with one bad rule loads: the bad rule is dropped, the good one stays', () => {
  const dir = cleanupTemp('legion-gates-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ gates: { rules: [good, { id: 'gr_z', then: 'DENY', when: {} }] } }));
  const loaded = normalizeGates(JSON.parse(readFileSync(file, 'utf8')).gates);
  assert.deepEqual(loaded.rules.map((r) => r.id), ['gr_a1'], 'the malformed verdict never reaches a matcher');
});
