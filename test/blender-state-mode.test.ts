import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlenderState } from '../src/core/blender/state.js';
import { effectiveMode } from '../src/shared/blender.js';

const rig = (blender: unknown) => {
  const dir = cleanupTemp('legion-bl-mode-');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ blender }));
  const raw = () => (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { blender: Record<string, unknown> }).blender;
  return { dir, raw, state: new BlenderState({ dataDir: dir, config: { blender } as never }) };
};

test('legacy configs: mode derived, no mode key written by unrelated saves, mirror written when a mode is saved', () => {
  for (const [legacy, want] of [['auto', 'auto'], ['off', 'live'], ['vm', 'vm']] as const) {
    const r = rig({ enabled: true, sandbox: legacy });
    assert.equal(effectiveMode(r.state.config), want);
    r.state.update({ port: 9999 });
    assert.equal('mode' in r.raw(), false, 'no mode key until the user saves one');
    assert.equal(r.raw().sandbox, legacy);
  }
});

test('saving a mode writes mode and mirrors sandbox (downgrade still opens)', () => {
  const r = rig({ enabled: true, sandbox: 'vm' });
  r.state.update({ mode: 'local' });
  assert.equal(r.raw().mode, 'local');
  assert.equal(r.raw().sandbox, 'auto');
  r.state.update({ mode: 'live' });
  assert.equal(r.raw().sandbox, 'off');
  r.state.update({ mode: 'vm' });
  assert.equal(r.raw().sandbox, 'vm');
  // an older UI tab still posts `sandbox`: mapped to a mode
  r.state.update({ sandbox: 'off' });
  assert.equal(r.raw().mode, 'live');
  assert.equal(r.raw().sandbox, 'off');
  assert.equal(effectiveMode(new BlenderState({ dataDir: r.dir, config: { blender: r.raw() } as never }).config), 'live');
});
