import test from 'node:test';
import assert from 'node:assert/strict';
import { replyText, startFake } from './providers-fakes.js';
import { mkAgent, run, setup } from './providers-harness.js';

test('the agents tool shows each agent\'s model, marks provider agents, and a lead cannot move a provider agent with ask', async () => {
  const f = await startFake((_r, res) => replyText(res, 'executed'));
  try {
    const h = setup(f, { agent: { id: 'lead', name: 'Lead', model: 'opus' } });
    h.store.agents.set('exec', mkAgent({ id: 'exec', name: 'Executor', description: 'Runs commands in its VM', model: 'fake:test-model' }));
    h.store.agents.set('plain', mkAgent({ id: 'plain', name: 'Plain', model: 'auto' }));
    const lines = h.engine.bridge.list('lead').split('\n');
    assert.match(lines.find((l) => l.startsWith('exec'))!, /\| fake:test-model \(provider, not Claude\) \| idle \| no-thread$/);
    assert.match(lines.find((l) => l.startsWith('plain'))!, /\| auto \| idle \| no-thread$/);
    // the lead asks the executor by name: the run is on the provider, not Claude, and the answer comes back as text
    const t = h.engine.startTask({ agentId: 'lead', prompt: 'plan', source: 'ui' } as any);
    await h.engine.waitFor(t.id, 3000);
    const r = await h.engine.bridge.ask(t.id, 'Executor', 'run the steps');
    assert.equal(r.status, 'done'); assert.equal(r.result, 'executed'); assert.equal(r.model, 'fake:test-model');
    // a per-task Claude model on a provider agent is refused: ask cannot send the work to Claude
    await assert.rejects(h.engine.bridge.ask(t.id, 'Executor', 'again', { model: 'sonnet' }), /cannot change the provider/);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
