// test/gates-registry.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATES, NO_SANDBOX_LINE, PERMISSION_GATE_IDS, PRESETS, PRESET_LINES, gateValue, isPreset } from '../src/shared/gates-registry.js';
import type { GateSettings } from '../src/shared/gates-registry.js';

const app: GateSettings = { version: 1 };

test('every gate has a unique id, a family, plain copy and a value for every preset', () => {
  const ids = new Set<string>();
  for (const g of GATES) {
    assert.ok(!ids.has(g.id), `duplicate ${g.id}`); ids.add(g.id);
    assert.ok(['permission', 'qa', 'rail'].includes(g.family));
    const copy = g.family === 'rail' ? [g.label, g.protects] : [g.label, g.protects, g.ifOff];
    for (const s of copy) { assert.ok(s.length > 0, `empty copy in ${g.id}`); assert.ok(!s.includes('\u2014'), `em dash in ${g.id}`); }
    if (g.family === 'rail') assert.equal(g.defaults, 'always', `${g.id} is a rail`);
    else for (const p of PRESETS) assert.ok(typeof g.defaults === 'object' && p in g.defaults, `${g.id} lacks ${p}`);
  }
});

test('no gate is an expert switch: rails are always on and none has a switch', () => {
  assert.equal(GATES.some((g) => 'expert' in g), false);
});

test('an unknown gate id is on', () => {
  assert.equal(gateValue('no-such-gate', { app }), true);
});

test('rails are on whatever the preset or overrides say', () => {
  const project: GateSettings = { version: 1, preset: 'bypass', overrides: { 'rail-ceiling': false } as never };
  assert.equal(gateValue('rail-ceiling', { app, project }), true);
});

test('the project preset beats the app preset; an override beats both', () => {
  const appBypass: GateSettings = { version: 1, preset: 'bypass' };
  assert.equal(gateValue('github-write-card', { app: appBypass }), false);
  assert.equal(gateValue('github-write-card', { app: appBypass, project: { version: 1, preset: 'ask' } }), true);
  assert.equal(gateValue('github-write-card', { app, project: { version: 1, overrides: { 'github-write-card': false } } }), false);
});

test('Ask keeps every permission gate as 0.3.0 has it', () => {
  for (const g of GATES.filter((x) => x.family === 'permission')) {
    const v = gateValue(g.id, { app });
    assert.notEqual(v, false, `${g.id} is off in Ask`);
  }
});

test('isPreset accepts the four names and nothing else', () => {
  for (const p of PRESETS) assert.equal(isPreset(p), true);
  for (const v of ['', 'full', 'Ask', null, 3]) assert.equal(isPreset(v), false);
});

test('PRESET_LINES and NO_SANDBOX_LINE are plain: every preset has a line, no em dash, "your computer"', () => {
  for (const p of PRESETS) assert.ok(PRESET_LINES[p].length > 0, p);
  for (const s of [...Object.values(PRESET_LINES), NO_SANDBOX_LINE]) { assert.ok(!s.includes('\u2014'), s); assert.doesNotMatch(s, /this computer|this machine/i); }
  assert.match(NO_SANDBOX_LINE, /^Legion has no sandbox for commands on your computer\./);
});

test('PERMISSION_GATE_IDS is exactly the permission family', () => {
  assert.deepEqual([...PERMISSION_GATE_IDS], GATES.filter((g) => g.family === 'permission').map((g) => g.id));
  assert.ok(PERMISSION_GATE_IDS.includes('tool-cards')); assert.ok(!PERMISSION_GATE_IDS.includes('rail-shell-floor')); assert.ok(!PERMISSION_GATE_IDS.includes('qa-evidence'));
});

test('update consent is not part of any preset: Bypass changes agent cards only, never how Legion updates', () => {
  for (const p of PRESETS) assert.equal(gateValue('update-consent', { app: { version: 1, preset: p } }), true, p);
});
