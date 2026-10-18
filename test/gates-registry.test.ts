// test/gates-registry.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATES, NO_SANDBOX_LINE, PERMISSION_GATE_IDS, PRESETS, PRESET_LINES, gateShown, gateValue, isPreset } from '../src/shared/gates-registry.js';
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
  // the owner's ruling: his own Claude Code allow rules still skip the plain Ask card, and the line says so
  assert.equal(PRESET_LINES.ask, 'Every action asks, except read-only commands and what your own Claude Code allow rules allow.');
});

test('PERMISSION_GATE_IDS is exactly the permission family that ships', () => {
  assert.deepEqual([...PERMISSION_GATE_IDS], GATES.filter((g) => g.family === 'permission' && gateShown(g)).map((g) => g.id));
  assert.ok(PERMISSION_GATE_IDS.includes('tool-cards')); assert.ok(!PERMISSION_GATE_IDS.includes('rail-shell-floor')); assert.ok(!PERMISSION_GATE_IDS.includes('qa-evidence'));
});

test('there is no update-consent gate: automatic installs stay the Updates panel setting', () => {
  assert.ok(!GATES.some((g) => g.id === 'update-consent'));
});

test('the rail rows read as sentences: possessives are written out', () => {
  const text = (id: string): string => { const g = GATES.find((x) => x.id === id)!; return `${g.label} | ${g.protects}`; };
  assert.match(text('rail-ceiling'), /cannot borrow an agent’s rights/);
  assert.match(text('rail-signed-updates'), /only when Legion’s release key signed it/);
  assert.match(text('rail-protected-paths'), /^Agents cannot edit Legion’s own settings/);
  assert.match(text('qa-goal-checks'), /The goal’s own checks run/);
  for (const g of GATES) for (const s of [g.label, g.protects]) assert.ok(!/(Legion|goal|agent) (own|release|rights)/.test(s), `a missing apostrophe in ${g.id}: ${s}`);
});
