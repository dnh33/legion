/** The short-list search hint: one static line in the system prompt, only on a Claude run whose skill list is short. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEARCH_HINT, SLIM_SEARCH_HINT } from '../src/core/armory/finder/defaults.js';
import { init, ok, setup, waitDone } from './library-fakes.js';
import { armoryRig, own } from './armory-rig.js';
import { replyText, startFake } from './providers-fakes.js';
import { run, setup as providerSetup } from './providers-harness.js';

const PROMPT = 'please export the invoices to pdf for accounting';

async function rig(finder: Record<string, unknown> = {}) {
  const r = armoryRig();
  for (const n of ['garden-notes', 'travel-plan', 'recipe-card']) await own(r, { name: n, description: `Helps with ${n} things`, body: 'b' });
  await r.call('POST', '/api/armory/finder', finder);
  return r;
}

async function claudeAppend(r: Awaited<ReturnType<typeof rig>>): Promise<string> {
  let append = '';
  const s = setup((c) => (async function* () { yield init('s' + c.n); append = (c.options as any).systemPrompt.append; yield ok('done', 's' + c.n); })(), { modules: [r.mod] });
  await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: PROMPT, source: 'ui' }));
  return append;
}

async function providerSystem(r: Awaited<ReturnType<typeof rig>>): Promise<string> {
  const f = await startFake((_q, res) => replyText(res, 'done'));
  try {
    const h = providerSetup(f, { agent: { id: 'alpha', approval: 'ask' } });
    h.engine.setModules([r.mod] as any);
    await run(h, PROMPT);
    return (f.requests[0]!.body.messages as any[]).find((m) => m.role === 'system')?.content ?? '';
  } finally { await f.close(); }
}

describe('the short-list search hint', () => {
  it('is the measured wording', () => {
    assert.equal(SLIM_SEARCH_HINT, 'Your skill list shows short descriptions. If no listed skill clearly fits, call armory_find with what you want to do before answering.');
  });

  it('slim on: the hint is in the append, and two runs give the same bytes', async () => {
    const r = await rig({ slimListing: true });
    const a = await claudeAppend(r);
    const b = await claudeAppend(r);
    assert.ok(a.includes(SLIM_SEARCH_HINT), 'hint present');
    assert.equal(a.split(SLIM_SEARCH_HINT).length, 2, 'once');
    assert.equal(a, b);
  });

  it('the default (full list, search on): the short search hint, once, never the short-list sentence, the same bytes each run', async () => {
    const r = await rig();
    const a = await claudeAppend(r);
    const b = await claudeAppend(r);
    assert.ok(a.includes(SEARCH_HINT), 'search hint present');
    assert.equal(a.split(SEARCH_HINT).length, 2, 'once');
    assert.ok(!a.includes('Your skill list shows short descriptions'), 'no claim of a short list on the full list');
    assert.equal(a, b);
  });

  it('search tool off: no hint of either kind, with or without the short list', async () => {
    for (const finder of [{ searchTool: false }, { slimListing: true, searchTool: false }]) {
      const a = await claudeAppend(await rig(finder));
      assert.ok(!a.includes(SEARCH_HINT) && !a.includes(SLIM_SEARCH_HINT), JSON.stringify(finder));
    }
  });

  it('an agent with skillFinder off gets no hint of either kind', async () => {
    const r = await rig({ slimListing: true });
    const alpha = r.agents.get('alpha')!;
    assert.ok(r.mod.preamble!(alpha).includes(SLIM_SEARCH_HINT), 'control: the same setting gives the hint');
    const off = r.mod.preamble!({ ...alpha, skillFinder: 'off' });
    assert.ok(!off.includes(SEARCH_HINT) && !off.includes(SLIM_SEARCH_HINT));
  });

  it('a provider run never gets the hint', async () => {
    const r = await rig({ slimListing: true });
    const sys = await providerSystem(r);
    assert.ok(!sys.includes(SLIM_SEARCH_HINT) && !sys.includes(SEARCH_HINT));
  });

  it('does not depend on the prompt', async () => {
    const r = await rig({ slimListing: true });
    const alpha = r.agents.get('alpha')!;
    const ctx = (prompt: string) => ({ prompt, taskId: 't', tainted: false, runtime: 'claude' as const });
    assert.equal(r.mod.preamble!(alpha, ctx('one')), r.mod.preamble!(alpha, ctx('something else entirely')));
  });

});
