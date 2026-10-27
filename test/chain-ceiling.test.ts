/** 0.3.10: a run another agent started at full approval carries no ceiling into the modules (their cards follow the owner's switches); a limited run, or Strict, keeps it. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, waitDone } from './library-fakes.js';
import type { CoreModule, ModuleJob } from '../src/core/modules.js';
import type { RunMode } from '../src/shared/types.js';

async function ceilingSeen(approvalCeiling: RunMode, strict: boolean): Promise<{ ceiling: RunMode | undefined; seen: boolean }> {
  let job: ModuleJob | undefined;
  const mod: CoreModule = { id: 'probe', mcpServers: (_a, j) => { job = j; return {}; } };
  const s = setup(undefined as never, { modules: [mod], strict });
  const started = s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'agent', origin: { roomId: 'agent-bridge', fromAgentId: 'beta', hop: 1, approvalCeiling } } as never);
  await waitDone(s, started);
  return { ceiling: job?.ceiling, seen: job !== undefined };
}

test('a full-approval chain gives modules no ceiling', async () => {
  const r = await ceilingSeen('full', false);
  assert.equal(r.seen, true);
  assert.equal(r.ceiling, undefined);
});

test('a chain limited to Ask keeps its ceiling', async () => {
  assert.equal((await ceilingSeen('ask', false)).ceiling, 'ask');
});

test('Strict keeps the 0.3.9 rule: even a full-approval chain carries its ceiling', async () => {
  assert.equal((await ceilingSeen('full', true)).ceiling, 'full');
});
