/**
 * The sentences a gate change shows (fix round 2): every gate that gets looser is named, Bypass lists everything it turns off, the digest
 * binds the starting point, and a limit is only accepted on a gate that has one. The property test drives the real store.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import { GATES, PERMISSION_GATE_IDS, PRESETS, gateValue } from '../src/shared/gates-registry.js';
import type { GateSettings, GateValue, Preset } from '../src/shared/gates-registry.js';
import { parseGatesChange } from '../src/electron/gates-ipc.js';

const P1 = 'proj_000000000001';
const store = (): GatesStore => new GatesStore(join(cleanupTemp('legion-gates-desc-'), 'gates'), { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 9)), keyState: 'new' });
const label = (id: string): string => GATES.find((g) => g.id === id)!.label;
const LIMIT_IDS = PERMISSION_GATE_IDS.filter((id) => typeof gateValue(id, { app: { version: 1, preset: 'ask' } }) === 'object');

/** Written here on purpose, not imported from the store: the oracle must not share the code it checks. */
const gateLooser = (was: GateValue, now: GateValue): boolean => {
  if (now === false) return was !== false;
  if (typeof now === 'object') return typeof was === 'object' && now.limit > was.limit;
  return typeof was === 'object';
};
const RANK: Record<Preset, number> = { ask: 0, 'accept-edits': 1, smart: 2, bypass: 3 };
const cap = (x: GateSettings): number => (x.preset && x.limit !== false ? RANK[x.preset] : 4);
const capPreset = (x: GateSettings): Preset | undefined => (x.limit !== false ? x.preset : undefined);
const unordered = (a?: Preset, b?: Preset): boolean => (a === 'smart' && b === 'accept-edits') || (a === 'accept-edits' && b === 'smart');
const presetLooser = (a: GateSettings, b: GateSettings): boolean => (b.preset ? RANK[b.preset] : 0) > (a.preset ? RANK[a.preset] : 0) || unordered(a.preset, b.preset);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('property: over 2000 random changes every gate that gets looser is named, and a change that loosens nothing has no loosening line', () => {
  const rnd = mulberry32(20261016);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const presets: Array<Preset | null> = [null, 'ask', 'accept-edits', 'smart', 'bypass'];
  const randValue = (id: string): GateValue => {
    const r = rnd();
    if (LIMIT_IDS.includes(id) && r < 0.4) return { on: true, limit: 1 + Math.floor(rnd() * 30) };
    return r < 0.7;
  };
  const randOverrides = (): Record<string, GateValue> => {
    const ov: Record<string, GateValue> = {};
    for (const id of PERMISSION_GATE_IDS) if (rnd() < 0.3) ov[id] = randValue(id);
    return ov;
  };
  const s = store();
  let loosened = 0; let quiet = 0; let namedGates = 0;
  for (let i = 0; i < 2200; i++) {
    const appPreset = pick(['ask', 'accept-edits', 'smart', 'bypass'] as const);
    s.patchApp({ preset: appPreset });
    const start = pick(presets);
    s.patchProject(P1, { preset: start, limit: rnd() < 0.7, overrides: randOverrides() });
    const before = s.project(P1); const app = s.app();
    const patch: Record<string, unknown> = {};
    if (rnd() < 0.6) patch.preset = pick(presets);
    if (rnd() < 0.3) patch.limit = rnd() < 0.5;
    if (rnd() < 0.6) patch.overrides = rnd() < 0.5 ? {} : randOverrides();
    if (Object.keys(patch).length === 0) patch.preset = pick(presets);
    const pv = s.preview(P1, patch);
    s.patchProject(P1, patch);
    const after = s.project(P1);
    const ctx = (p: GateSettings) => ({ project: p, app });
    const looseIds = PERMISSION_GATE_IDS.filter((id) => gateLooser(gateValue(id, ctx(before)), gateValue(id, ctx(after))));
    for (const id of looseIds) {
      assert.ok(pv.loosening.some((l) => l.startsWith(`${label(id)}:`)), `run ${i}: ${id} got looser (${JSON.stringify(gateValue(id, ctx(before)))} to ${JSON.stringify(gateValue(id, ctx(after)))}) but is not named.\nbefore ${JSON.stringify(before)}\npatch ${JSON.stringify(patch)}\n${pv.loosening.join('\n')}`);
      namedGates++;
    }
    const other = presetLooser(before, after) || (after.limit === false && before.limit !== false) || cap(after) > cap(before) || unordered(capPreset(before), capPreset(after));
    if (looseIds.length > 0 || other) { loosened++; assert.equal(pv.loosens, true, `run ${i}: a loosening change must say so`); assert.ok(pv.loosening.length > 0); }
    else { quiet++; assert.equal(pv.loosens, false, `run ${i}: nothing loosened\n${JSON.stringify({ before, patch })}`); assert.deepEqual(pv.loosening, []); }
  }
  assert.ok(loosened > 800 && quiet > 200 && namedGates > 800, `the generator must cover both sides: ${loosened} loosening, ${quiet} quiet, ${namedGates} named gates`);
});

test('N1: Accept edits that drops an owner cap override names the cap raise', () => {
  const s = store();
  s.patchProject(P1, { preset: 'ask', overrides: { 'goal-caps': { on: true, limit: 3 }, 'attempt-caps': { on: true, limit: 1 } } });
  const pv = s.preview(P1, { preset: 'accept-edits', overrides: {} });
  assert.ok(pv.loosening.some((l) => /Limit the size of a goal: the limit goes from 3 to 12/.test(l)), pv.loosening.join('\n'));
  assert.ok(pv.loosening.some((l) => /Limit retries on one item: the limit goes from 1 to 4/.test(l)), pv.loosening.join('\n'));
});

test('N2: Ask to Bypass lists every consequence that loosens, one line each', () => {
  const s = store();
  const pv = s.preview(P1, { preset: 'bypass' });
  const text = pv.loosening.join('\n');
  assert.match(text, /No permission cards/);
  for (const id of ['tool-cards', 'github-write-card', 'module-cards', 'board-delete-card', 'digest-hold', 'gate-rules-ask']) assert.ok(pv.loosening.some((l) => l.startsWith(`${label(id)}: off.`)), `${id} is named`);
  assert.match(text, /Limit retries on one item: the limit goes from 4 to 8/);
  assert.match(text, /Limit the size of a goal: the limit goes from 12 to 24/);
  assert.match(text, /Your ask rules are skipped/);
});

test('N3: the digest covers the starting point and, for a project, the app settings', () => {
  const s = store();
  const patch = { preset: 'bypass', overrides: {} };
  s.patchProject(P1, { preset: 'ask' });
  const fromAsk = s.preview(P1, patch);
  s.patchProject(P1, { preset: 'accept-edits' });
  const fromAccept = s.preview(P1, patch);
  assert.notEqual(fromAsk.digest, fromAccept.digest, 'same result from a different start is a different change');
  // same project settings and result, different app settings: the app preset is part of what the change is judged under
  s.patchProject(P1, { preset: 'smart', limit: false });
  const underAsk = s.preview(P1, { preset: 'bypass' });
  s.patchApp({ preset: 'smart' });
  const underSmart = s.preview(P1, { preset: 'bypass' });
  assert.notEqual(underAsk.digest, underSmart.digest);
  assert.equal(s.preview(P1, { preset: 'bypass' }).digest, underSmart.digest, 'the same change twice gives the same digest');
});

test('N4: a limit is refused on a gate that has none, and accepted on one that has', () => {
  const s = store();
  assert.ok(LIMIT_IDS.includes('goal-caps') && LIMIT_IDS.includes('attempt-caps') && !LIMIT_IDS.includes('tool-cards'));
  for (const call of [() => s.preview(P1, { overrides: { 'tool-cards': { on: true, limit: 5 } } }), () => s.patchProject(P1, { overrides: { 'stall-ladder': { on: true, limit: 2 } } })]) {
    assert.throws(call, (e: unknown) => e instanceof GatesError && e.status === 400 && /has no limit/.test(e.message));
  }
  assert.doesNotThrow(() => s.patchProject(P1, { overrides: { 'goal-caps': { on: true, limit: 5 } } }));
  assert.equal(parseGatesChange({ kind: 'project', id: P1, patch: { overrides: { 'tool-cards': { on: true, limit: 5 } } } }), undefined);
  assert.ok(parseGatesChange({ kind: 'project', id: P1, patch: { overrides: { 'goal-caps': { on: true, limit: 5 } } } }));
});
