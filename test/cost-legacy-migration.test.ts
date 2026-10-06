/** Tasks whose cost was written by the old code (which summed the SDK's cumulative session totals) are marked once, on upgrade. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';

const task = (id: string, extra: Record<string, unknown>) => ({ id, agentId: 'a1', title: 't', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: '', updatedAt: '', ...extra });

test('cost-legacy-v1: a Claude task with a recorded cost and no per-session record is marked as possibly over-counted, once', () => {
  const dir = cleanupTemp('legion-costmig-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents: [], vms: [], migrations: ['builder-vm-size-default-v1', 'zealot-lead-prompt-v1'], tasks: [
    task('claude', { sessionId: 's', costUsd: 66.42 }),
    task('free', { sessionId: 's', costUsd: 0 }),
    task('provider', { provider: 'openrouter', costUsd: 0.3 }),
    task('new', { sessionId: 's', costUsd: 0.2, costSession: { id: 's', total: 0.2, base: 0 } }),
  ] }));
  const s = new Store(dir);
  assert.equal(s.getTask('claude')!.costLegacy, true);
  assert.equal(s.getTask('free')!.costLegacy, undefined, 'nothing recorded, nothing to doubt');
  assert.equal(s.getTask('provider')!.costLegacy, undefined, 'provider runs were never summed from cumulative totals');
  assert.equal(s.getTask('new')!.costLegacy, undefined);
  assert.equal(s.getTask('claude')!.costUsd, 66.42, 'the figure is kept, only marked: the true one is not known to Legion');
});
