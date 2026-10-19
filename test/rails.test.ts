// test/rails.test.ts (spec test 5): every rail is on in every preset and has no switch; the shell floor is always on
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATES, PRESETS, gateValue } from '../src/shared/gates-registry.js';
import { GatesError } from '../src/core/gates-settings/index.js';
import { gatesRig, keyedStore } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import type { Preset } from '../src/shared/gates-registry.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'seeds') walk(p, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};

test('every rail is on in every preset and has no switch, not even an override', () => {
  const rails = GATES.filter((x) => x.family === 'rail');
  assert.ok(rails.length > 0);
  for (const g of rails) {
    assert.equal(g.defaults, 'always', g.id);
    for (const p of PRESETS) {
      const settings = { version: 1 as const, preset: p, overrides: { [g.id]: false } as never };
      assert.equal(gateValue(g.id, { app: settings, project: settings }), true, `${g.id} in ${p}`);
    }
  }
  assert.equal(GATES.some((g) => 'expert' in g), false, 'no gate is an expert switch');
  assert.ok(rails.some((g) => g.id === 'rail-shell-floor'), 'the shell floor is a rail like the others');
});

const PRESET_RIGS: Array<[string, Parameters<typeof gatesRig>[0]]> = [
  ['Ask', { preset: 'ask', follow: true }],
  ['Accept edits', { preset: 'accept-edits', follow: true }],
  ['Smart', { preset: 'smart', follow: true }],
  ['Bypass', { preset: 'bypass', follow: true }],
];
const WIPES = ['rm -rf /', 'rm -rf ~', 'bash -c "rm -rf ~"', 'sh -c \'rm -rf /\''];

test('shell floor: refuses catastrophic commands in Ask, Accept edits, Smart and Bypass, with no card', async () => {
  for (const [name, o] of PRESET_RIGS) {
    await using(o, async (r) => {
      for (const command of WIPES) {
        const d = await r.run('Bash', { command });
        assert.deepEqual([d.card, d.allow], [false, false], `${name}: ${command}`);
      }
    });
  }
});

test('shell floor: an unreadable command is refused in Bypass (as in 0.3.0) and cards in the other three', async () => {
  for (const [name, o] of PRESET_RIGS) {
    await using(o, async (r) => {
      const d = await r.run('Bash', { command: '$(echo rm) -rf build' });
      if (name === 'Bypass') { assert.deepEqual([d.card, d.allow], [false, false], name); assert.match(d.message ?? '', /cannot read/i); }
      else { assert.equal(d.card, true, name); assert.equal(d.noRemember, true, `${name}: no Remember`); }
    });
  }
});

test('the floor holds under the Claude path hooks too, in Bypass and in Ask', async () => {
  for (const [name, o] of [PRESET_RIGS[0]!, PRESET_RIGS[3]!]) {
    await using(o, async (r) => {
      const h = await r.hook('Bash', { command: 'rm -rf ~' });
      assert.equal(h.decision, 'deny', name);
    });
  }
});

test('no gate and no setting can turn the floor off', async () => {
  // the shell floor in a Bypass run is still the floor, and the store refuses an override on the rail
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.equal(r.core.gate('rail-shell-floor', r.project.id), true);
    assert.throws(() => r.core.store.patchProject(r.project.id, { overrides: { 'rail-shell-floor': false } }), (e) => e instanceof GatesError && e.status === 400);
    assert.equal((await r.run('Bash', { command: 'rm -rf ~' })).allow, false);
  });
  // the store refuses a switch for it, in every spelling it ever had
  const core = keyedStore();
  for (const body of [{ shellFloorOff: true }, { preset: 'ask', shellFloorOff: true }]) {
    assert.throws(() => core.store.patchApp(body), (e) => e instanceof GatesError && e.status === 400);
  }
  // and the engine has no reader for such a switch
  const src = walk(join(ROOT, 'src')).filter((f) => !f.includes('gates-settings'));
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    assert.equal(/shellFloorOn|shellFloorOff|floorOn\b/.test(text), false, `${f} reads a floor switch`);
  }
});

test('the engine reads gates by id, and only permission gates: no rail id is looked up', () => {
  const text = readFileSync(join(ROOT, 'src', 'core', 'engine.ts'), 'utf8');
  const ids = [...text.matchAll(/(?:gateOn\(job,|switchedOff\(|gates\??\.gate\()\s*'([a-z-]+)'/g)].map((m) => m[1]!);
  assert.ok(ids.includes('tool-cards') && ids.includes('gate-rules-ask'), `engine reads ${ids.join(', ')}`);
  for (const id of ids) assert.notEqual(GATES.find((g) => g.id === id)?.family, 'rail', id);
  void (null as unknown as Preset);
});
