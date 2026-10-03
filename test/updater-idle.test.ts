/** C13, C14: the exact definition of idle. One case per busy reason; unreadable means busy; the quiet period and the boot grace. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task, VmRecord } from '../src/shared/types.js';
import { computeBusy, QuietClock, type BusyInputs } from '../src/core/updater/idle.js';
import { BOOT_GRACE_MS, QUIET_MS } from '../src/core/updater/config.js';

const task = (status: Task['status']): Task => ({ id: `t-${status}`, agentId: 'a', status } as Task);
const vm = (state: VmRecord['state']): VmRecord => ({ agentId: 'a', state } as VmRecord);
const calm = (): BusyInputs => ({ tasks: () => [task('done'), task('error'), task('cancelled')], running: () => [], approvals: () => [], vms: () => [vm('running'), vm('idle'), vm('ready'), vm('archived'), vm('none'), vm('error')], probes: new Map(), updaterBusy: () => false });
const T0 = 1_000_000;
const later = T0 + BOOT_GRACE_MS + 1;
const reasons = (i: BusyInputs, now = later) => computeBusy(i, now, T0);

test('C13: nothing running (finished tasks, billing-only VMs) is idle', async () => { assert.deepEqual(await reasons(calm()), []); });
test('C13: a queued or a running task is busy', async () => {
  for (const s of ['queued', 'running'] as const) assert.match((await reasons({ ...calm(), tasks: () => [task('done'), task(s)] }))[0]!, /1 task/);
});
test('C13: an engine run, a pending approval, a VM provisioning/archiving, the updater itself: each is busy', async () => {
  assert.match((await reasons({ ...calm(), running: () => ['t1'] }))[0]!, /agent run/);
  assert.match((await reasons({ ...calm(), approvals: () => [{}] }))[0]!, /approval/);
  for (const s of ['provisioning', 'archiving'] as const) assert.match((await reasons({ ...calm(), vms: () => [vm(s)] }))[0]!, /VM operation/);
  assert.match((await reasons({ ...calm(), updaterBusy: () => true }))[0]!, /update is being prepared/);
});
test('C13: registered probes (sync, async) are busy when true; a throwing or rejecting probe is busy too', async () => {
  const p = new Map<string, () => boolean | Promise<boolean>>([['a Blender download is running', () => true], ['ok', () => false], ['async busy', async () => true], ['boom', () => { throw new Error('x'); }], ['reject', async () => { throw new Error('x'); }]]);
  const r = await reasons({ ...calm(), probes: p });
  assert.deepEqual(r, ['a Blender download is running', 'async busy', 'boom could not be read', 'reject could not be read']);
});
test('C13: an unreadable source (a throw) is busy, never idle', async () => {
  const boom = () => { throw new Error('x'); };
  for (const k of ['tasks', 'running', 'approvals', 'vms', 'updaterBusy'] as const) {
    const r = await reasons({ ...calm(), [k]: boom } as BusyInputs);
    assert.equal(r.length, 1, k);
    assert.match(r[0]!, /could not be read/);
  }
});
test('C14: the core is busy for BOOT_GRACE_MS after it starts', async () => {
  assert.match((await reasons(calm(), T0 + BOOT_GRACE_MS - 1))[0]!, /just started/);
  assert.deepEqual(await reasons(calm(), T0 + BOOT_GRACE_MS), []);
});
test('C14: idle needs QUIET_MS without a busy sample; any busy sample restarts the clock', () => {
  const c = new QuietClock(T0);
  assert.equal(c.isQuiet(T0 + QUIET_MS - 1), false);
  assert.equal(c.isQuiet(T0 + QUIET_MS), true);
  c.sample(['busy'], T0 + 50_000);
  assert.equal(c.isQuiet(T0 + 50_000 + QUIET_MS - 1), false);
  assert.equal(c.isQuiet(T0 + 50_000 + QUIET_MS), true);
  c.sample([], T0 + 200_000);
  assert.equal(c.quietMs(T0 + 200_000), 150_000);
});
