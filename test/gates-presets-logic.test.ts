// test/gates-presets-logic.test.ts: the pure view model of the Gates page (Task 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATES, PRESET_LINES } from '../src/shared/gates-registry.js';
import { presetChoices, scopeSummary, permissionRows, qaRows, railRows, runsAsChip, MODE_LABEL, type GatesView } from '../ui/src/gates/presetsLogic.js';

const view = (over: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...over });

test('presetChoices has four rows, Ask first, only Ask is not looser', () => {
  const c = presetChoices();
  assert.deepEqual(c.map((x) => x.id), ['ask', 'accept-edits', 'smart', 'bypass']);
  assert.deepEqual(c.map((x) => x.label), ['Ask', 'Accept edits', 'Smart', 'Bypass']);
  assert.deepEqual(c.map((x) => x.looser), [false, true, true, true]);
  for (const x of c) assert.equal(x.line, PRESET_LINES[x.id]);
});

test('permissionRows covers every permission gate in the registry', () => {
  const ids = permissionRows(view()).map((r) => r.id);
  assert.deepEqual(ids, GATES.filter((g) => g.family === 'permission').map((g) => g.id));
  for (const id of ['protected-path-cards', 'secret-file-reads', 'env-scrub', 'web-reads']) assert.ok(ids.includes(id), id);
});

test('permissionRows marks an override and shows the preset default beside it', () => {
  const v = view({ app: { version: 1, preset: 'ask' }, projects: { p1: { version: 1, preset: 'smart', overrides: { 'tool-cards': false, 'goal-caps': { on: true, limit: 20 } } } } });
  const rows = permissionRows(v, 'p1');
  const tool = rows.find((r) => r.id === 'tool-cards')!;
  assert.equal(tool.overridden, true); assert.equal(tool.value, false); assert.equal(tool.presetDefault, true);
  assert.deepEqual(rows.find((r) => r.id === 'goal-caps')!.value, { on: true, limit: 20 });
  const plain = rows.find((r) => r.id === 'github-write-card')!;
  assert.equal(plain.overridden, false); assert.equal(plain.value, true);
  assert.ok(rows.every((r) => r.label && r.protects && r.ifOff));
  const app = permissionRows(v).find((r) => r.id === 'tool-cards')!;
  assert.equal(app.overridden, false);
});

test('scopeSummary: a project with no preset reads per-agent; a changed-outside project says so', () => {
  const v = view({
    app: { version: 1, preset: 'smart', overrides: { 'tool-cards': false } },
    projects: { a: { version: 1 }, b: { version: 1, preset: 'bypass', limit: false }, c: { version: 1, preset: 'ask' } },
    changedOutside: ['b'], unreadable: ['c'],
  });
  assert.deepEqual(scopeSummary(v, 'a'), { preset: 'per-agent', limit: false, overrides: 0, changedOutside: false, unreadable: false });
  assert.deepEqual(scopeSummary(v, 'b'), { preset: 'bypass', limit: false, overrides: 0, changedOutside: true, unreadable: false });
  assert.deepEqual(scopeSummary(v, 'c'), { preset: 'ask', limit: true, overrides: 0, changedOutside: false, unreadable: true });
  assert.deepEqual(scopeSummary(v), { preset: 'smart', limit: true, overrides: 1, changedOutside: false, unreadable: false });
  assert.equal(scopeSummary(v, 'missing').preset, 'per-agent');
});

test('qaRows lists every qa gate with its care levels', () => {
  const rows = qaRows();
  assert.deepEqual(rows.map((r) => r.id), GATES.filter((g) => g.family === 'qa').map((g) => g.id));
  for (const r of rows) assert.deepEqual([r.quick, r.normal, r.thorough], [true, true, true]);
});

test('railRows are the registry rails, with no expert key', () => {
  const rows = railRows();
  assert.equal(rows.length, GATES.filter((g) => g.family === 'rail').length);
  for (const r of rows) { assert.ok(!('expert' in r)); assert.deepEqual(Object.keys(r).sort(), ['id', 'label', 'protects']); }
});

test('MODE_LABEL names every run mode', () => {
  assert.equal(MODE_LABEL.ask, 'Ask'); assert.equal(MODE_LABEL['auto-edits'], 'Accept edits'); assert.equal(MODE_LABEL.smart, 'Smart'); assert.equal(MODE_LABEL.full, 'Bypass');
  assert.ok(MODE_LABEL['smart-edits']);
});

test('runsAsChip names the limit and the follow source', () => {
  assert.deepEqual(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', projectName: 'Shop', projectPreset: 'ask', limit: true }), { text: 'Runs as Ask', reason: 'Agent is Full, limited by project Shop' });
  assert.deepEqual(runsAsChip({ effective: 'full', agentMode: 'ask', source: 'project', projectName: 'Shop', projectPreset: 'bypass', limit: true }), { text: 'Runs as Bypass', reason: 'Following project Shop (Bypass)' });
  assert.deepEqual(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', ceiling: 'ask', limit: false }), { text: 'Runs as Ask', reason: 'Started by an outside app: asks' });
  assert.deepEqual(runsAsChip({ effective: 'auto-edits', agentMode: 'auto-edits', source: 'own', limit: false }), { text: 'Runs as Accept edits' });
  assert.deepEqual(runsAsChip({ effective: 'ask', agentMode: 'full', source: 'own', limit: false, lease: true }), { text: 'Runs as Ask', reason: 'Goal lease: no cards for this goal' });
});
