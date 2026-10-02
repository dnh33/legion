/** C18: the where-does-it-run table (claude/plan-blender-local-first.md 2.3), line by line, plus the "never a silent move to a looser place" rules. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode } from '../src/core/blender/guard.js';
import type { RequestedMode, RouteFacts } from '../src/core/blender/guard.js';
import type { BlenderMode } from '../src/shared/blender.js';

const F = (local: boolean, vm: boolean, vmNote = 'VM not configured: the boat.dev key is missing'): RouteFacts => ({ local, vm, vmNote });
const NO_LOCAL = 'Blender was not found on this computer.';
const NO_BOTH = 'No Blender on this computer and the cloud VM is not set up. Tell the user to install Blender or set boat.dev up in Settings.';
const VM_NOT_READY = 'The cloud VM is not ready: VM not configured: the boat.dev key is missing.';

test('table rows, auto', () => {
  assert.deepEqual(resolveMode('auto', undefined, F(true, true)), { mode: 'local' });
  assert.deepEqual(resolveMode('auto', undefined, F(true, false)), { mode: 'local' });
  assert.deepEqual(resolveMode('auto', undefined, F(false, true)), { mode: 'sandbox', note: 'Blender was not found on this computer, so the cloud VM was used.' });
  assert.deepEqual(resolveMode('auto', undefined, F(false, false)), { error: NO_BOTH });
  assert.deepEqual(resolveMode('auto', 'local', F(true, false)), { mode: 'local' });
  assert.deepEqual(resolveMode('auto', 'local', F(false, true)), { error: NO_LOCAL }, 'asked for local: never a silent VM');
  assert.deepEqual(resolveMode('auto', 'vm', F(false, true)), { mode: 'sandbox' });
  assert.deepEqual(resolveMode('auto', 'sandbox', F(true, true)), { mode: 'sandbox' }, 'sandbox is the alias of vm');
  assert.deepEqual(resolveMode('auto', 'vm', F(true, false)), { error: VM_NOT_READY });
  for (const l of [true, false]) for (const v of [true, false]) assert.deepEqual(resolveMode('auto', 'live', F(l, v)), { mode: 'live' });
});

test('table rows, local / vm / live settings', () => {
  for (const req of [undefined, 'local'] as const) {
    assert.deepEqual(resolveMode('local', req, F(true, true)), { mode: 'local' });
    assert.deepEqual(resolveMode('local', req, F(false, true)), { error: 'Blender was not found on this computer. Install it or set its location in Settings.' });
  }
  for (const req of ['vm', 'sandbox', 'live'] as const) for (const l of [true, false]) for (const v of [true, false]) {
    assert.deepEqual(resolveMode('local', req, F(l, v)), { error: 'Settings restrict scripts to Blender on this computer.' });
  }
  for (const req of [undefined, 'vm', 'sandbox'] as const) {
    assert.deepEqual(resolveMode('vm', req, F(true, true)), { mode: 'sandbox' });
    assert.deepEqual(resolveMode('vm', req, F(true, false)), { error: VM_NOT_READY }, 'vm setting never becomes local');
  }
  for (const req of ['local', 'live'] as const) for (const l of [true, false]) for (const v of [true, false]) {
    assert.deepEqual(resolveMode('vm', req, F(l, v)), { error: 'Settings restrict scripts to the cloud VM.' });
  }
  for (const req of [undefined, 'live'] as const) for (const l of [true, false]) for (const v of [true, false]) assert.deepEqual(resolveMode('live', req, F(l, v)), { mode: 'live' });
  for (const req of ['local', 'vm', 'sandbox'] as const) for (const l of [true, false]) for (const v of [true, false]) {
    assert.deepEqual(resolveMode('live', req, F(l, v)), { error: 'Settings restrict scripts to your open Blender.' });
  }
});

test('legacy off behaves exactly as live, for every request and every fact', () => {
  for (const req of [undefined, 'local', 'vm', 'sandbox', 'live'] as Array<RequestedMode | undefined>) for (const l of [true, false]) for (const v of [true, false]) {
    assert.deepEqual(resolveMode('off', req, F(l, v)), resolveMode('live', req, F(l, v)), `${req} ${l} ${v}`);
  }
});

test('no silent loosening: an ok answer is never looser than the setting or the request', () => {
  const modes: BlenderMode[] = ['auto', 'local', 'vm', 'live'];
  const reqs: Array<RequestedMode | undefined> = [undefined, 'local', 'vm', 'sandbox', 'live'];
  for (const m of modes) for (const req of reqs) for (const l of [true, false]) for (const v of [true, false]) {
    const r = resolveMode(m, req, F(l, v));
    if ('error' in r) { assert.ok(r.error.length > 10 && !/undefined|\[object/.test(r.error)); continue; }
    if (m === 'vm') assert.equal(r.mode, 'sandbox');
    if (m === 'local') assert.equal(r.mode, 'local');
    if (m === 'live') assert.equal(r.mode, 'live');
    // an explicit request is honoured exactly or refused, never swapped
    if (req) assert.equal(r.mode, req === 'vm' ? 'sandbox' : req);
    // live happens only when live was asked for (or is the setting): auto without a request never reaches the open Blender
    if (r.mode === 'live') assert.ok(req === 'live' || m === 'live');
    // the only automatic move: auto without a request, local impossible, VM possible
    if (m === 'auto' && !req && r.mode === 'sandbox') assert.equal(l, false);
    if (m === 'auto' && !req && l) assert.equal(r.mode, 'local');
  }
});

test('error texts are plain sentences for the agent', () => {
  const all: string[] = [];
  for (const m of ['auto', 'local', 'vm', 'live'] as BlenderMode[]) for (const req of [undefined, 'local', 'vm', 'live'] as Array<RequestedMode | undefined>) {
    const r = resolveMode(m, req, F(false, false));
    if ('error' in r) all.push(r.error);
  }
  assert.ok(all.length >= 6);
  for (const e of all) assert.match(e, /^[A-Z].*\.$/s);
  // a VM note that already ends in a full stop does not double it
  assert.deepEqual(resolveMode('vm', undefined, F(false, false, 'The Sculptor agent does not exist.')), { error: 'The cloud VM is not ready: The Sculptor agent does not exist.' });
});

test('L3: a setting this function does not know is a default-deny error, never "live"', () => {
  for (const req of [undefined, 'local', 'vm', 'live'] as const) {
    const r = resolveMode('sandboxed-typo' as unknown as BlenderMode, req, F(true, true));
    assert.ok('error' in r, `request ${req} must be refused, got ${JSON.stringify(r)}`);
  }
});

test('L4: the fallback to the VM says why local is impossible (not found vs older than 3.0)', () => {
  const old = resolveMode('auto', undefined, { local: false, vm: true, localNote: 'Blender 2.93.0 is too old for local runs (need 3.0.0 or newer).' });
  assert.deepEqual(old, { mode: 'sandbox', note: 'Blender 2.93.0 is too old for local runs (need 3.0.0 or newer), so the cloud VM was used.' });
  const none = resolveMode('auto', undefined, { local: false, vm: true, localNote: 'Blender was not found on this computer. Install it or set its location in Settings.' });
  assert.deepEqual(none, { mode: 'sandbox', note: 'Blender was not found on this computer, so the cloud VM was used.' });
});
