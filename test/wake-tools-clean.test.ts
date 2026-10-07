/** ScheduleWakeup and PushNotification bring no outside text into a run, so they must not taint it; taint from elsewhere still stays. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { init, ok, setup, toolUse, waitDone } from './library-fakes.js';
import { taintsRun } from '../src/core/engine.js';

async function runTainted(tools: string[]): Promise<boolean> {
  const s = setup((c) => (async function* () {
    yield init('s1');
    for (const [i, t] of tools.entries()) yield toolUse(t, `tu_${i}`, {});
    yield ok('d', 's1');
  })());
  const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
  return t.tainted === true;
}

describe('wake and notify tools', () => {
  it('taintsRun says clean for both', () => {
    assert.equal(taintsRun('ScheduleWakeup'), false);
    assert.equal(taintsRun('PushNotification'), false);
  });

  it('a run that only schedules its wake and notifies stays clean', async () => {
    assert.equal(await runTainted(['ScheduleWakeup', 'PushNotification']), false);
    assert.equal(await runTainted(['ScheduleWakeup']), false);
    assert.equal(await runTainted(['PushNotification']), false);
  });

  it('taint from another tool persists even when the wake tools come after it', async () => {
    assert.equal(await runTainted(['WebFetch', 'ScheduleWakeup', 'PushNotification']), true);
  });
});
