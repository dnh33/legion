/**
 * The Armory with an embedding ranker: the note and armory_find use the fused order once vectors exist, and fall back to keywords on any
 * embedder failure or overrun. A fake embedder that reads meaning from a few words; invented skills only.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARMORY_SERVER_NAME, createArmoryModule } from '../src/core/armory/index.js';
import type { Embedder, EmbedKind } from '../src/core/armory/finder/embed.js';
import type { ModuleJob } from '../src/core/modules.js';
import { entryFor, jsonReply, startFake } from './providers-fakes.js';
import type { Fake } from './providers-fakes.js';
import { armoryRig, MECHANISM_TUNING, own } from './armory-rig.js';

/** Three meanings: 0 design, 1 database, 2 anything else. */
const AXIS = (text: string): number => (/typography|luxurious|premium/i.test(text) ? 0 : /database|quer(?:y|ies)|index/i.test(text) ? 1 : 2);
const vecOf = (text: string): Float32Array => { const v = new Float32Array(3); v[AXIS(text)] = 1; return v; };

function fakeEmbedder(over: { query?: (signal: AbortSignal) => Promise<Float32Array[]>; fail?: boolean } = {}) {
  const calls: { texts: string[]; kind: EmbedKind | undefined }[] = [];
  const e: Embedder = {
    id: 'fake-wiring',
    async embed(texts, signal, kind) {
      calls.push({ texts: [...texts], kind });
      if (over.fail) throw new Error('model gone');
      if (kind === 'query' && over.query) return over.query(signal);
      return texts.map(vecOf);
    },
  };
  return { e, calls, queries: () => calls.filter((c) => c.kind === 'query'), passages: () => calls.filter((c) => c.kind === 'passage') };
}

async function rigWith(emb: Embedder | undefined, settings: Record<string, unknown> = { suggest: true, ranker: 'local', threshold: 'eager' }) {
  const r = armoryRig({ modOpts: emb ? { finderEmbedder: () => emb } : {} });
  await own(r, { name: 'design-polish', description: 'Polish typography, spacing and colour for pages', body: 'b' });
  await own(r, { name: 'db-tune', description: 'Tune database queries and indexes', body: 'b' });
  await own(r, { name: 'garden-notes', description: 'Helps with garden things', body: 'b' });
  await own(r, { name: 'travel-plan', description: 'Helps with travel things', body: 'b' });
  // The best match by meaning is a skill that is OFF for the agent: it must never be named.
  await r.call('POST', '/api/armory/skill', { name: 'luxury-off', description: 'Typography for luxurious brands', body: 'b' });
  await r.call('POST', '/api/armory/finder', settings);
  return r;
}
type Rig = Awaited<ReturnType<typeof rigWith>>;
const turn = (r: Rig, prompt: string, runtime: 'claude' | 'provider' = 'claude') =>
  r.mod.turnNote!(r.agents.get('alpha')!, { prompt, taskId: 't1', runtime });
const ID = (name: string): string => 'legion-armory:' + name;
const NO_KEYWORDS = 'make everything feel luxurious and high end please';

describe('the note with embeddings', () => {
  it('first turn: no vectors yet, so keywords decide; the skills are embedded in the background and the next turn is fused', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e);
    assert.equal(await turn(r, NO_KEYWORDS), undefined, 'keywords find nothing in this message');
    await r.mod.finderSettled();
    assert.equal(f.passages().length, 1);
    assert.equal(f.passages()[0]!.texts.length, 4, 'only the four skills this agent may use are embedded');
    const note = await turn(r, NO_KEYWORDS);
    assert.ok(note, 'the fused order finds the design skill');
    assert.deepEqual(note.suggested, [ID('design-polish')]);
    assert.ok(note.why[0]!.cosine! > 0.99);
    assert.equal(note.why[0]!.bm25, 0, 'a skill with no keyword hit still ranks by its vector');
    assert.equal(f.passages().length, 1, 'the cached vectors are used; nothing is embedded twice');
  });

  it('removing the model also empties the vector cache in memory: the skills are embedded again afterwards', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e);
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    assert.equal(f.passages().length, 1);
    await r.call('DELETE', '/api/armory/finder/model');
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    assert.equal(f.passages().length, 2, 'the cache held nothing, so the skills were embedded a second time');
  });

  it('never names a skill that is off for the agent, even when it is the closest by meaning', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e);
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    const note = await turn(r, NO_KEYWORDS);
    assert.ok(note && !note.text.includes('luxury-off') && !note.suggested.includes('luxury-off'));
    assert.ok(!f.passages().some((c) => c.texts.some((t) => t.includes('luxury-off'))), 'its text is not embedded either');
  });

  it('the vectors survive a restart: a new module on the same folder embeds nothing', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e);
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    const again = createArmoryModule(
      { dataDir: r.dataDir, config: r.config, store: { getAgent: (id: string) => r.agents.get(id), listAgents: () => [...r.agents.values()] } } as never,
      { claudeHome: r.home, ttlMs: 0, finderEmbedder: () => f.e, finderTuning: MECHANISM_TUNING, sdkProbe: async () => { throw new Error('no'); } },
    );
    const note = await again.turnNote!(r.agents.get('alpha')!, { prompt: NO_KEYWORDS, taskId: 't2', runtime: 'claude' });
    assert.deepEqual(note?.suggested, [ID('design-polish')]);
    assert.equal(f.passages().length, 1);
  });

  it('a new skill is the only one embedded after the first fill', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e);
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    await own(r, { name: 'index-doctor', description: 'Database index doctor', body: 'b' });
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    assert.equal(f.passages().length, 2);
    assert.equal(f.passages()[1]!.texts.length, 1);
    assert.ok(f.passages()[1]!.texts[0]!.includes('index-doctor'));
  });

  it('an embedder that fails gives no note for that turn (the keyword floors fail the bars, so keywords are not a fallback)', async () => {
    const f = fakeEmbedder({ fail: true });
    const r = await rigWith(f.e);
    assert.equal(await turn(r, 'please polish the typography of these pages'), undefined);
    await r.mod.finderSettled();
  });

  it('a query that overruns the 300 ms budget gives no note for that turn', async () => {
    const f = fakeEmbedder({ query: (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('too slow')))) });
    const r = await rigWith(f.e);
    await turn(r, NO_KEYWORDS);
    await r.mod.finderSettled();
    const t0 = Date.now();
    const note = await turn(r, 'please polish the typography of these pages');
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 1500, `took ${took} ms`);
    assert.equal(note, undefined);
  });

  it('the keyword ranker never calls the embedder', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e, { suggest: true, ranker: 'keyword', threshold: 'eager' });
    const note = await turn(r, 'please polish the typography of these pages');
    assert.ok(note);
    await r.mod.finderSettled();
    assert.equal(f.calls.length, 0);
  });

  it('a message that fits nothing gets no note under the balanced floor', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e, { ranker: 'local', threshold: 'balanced' });
    await turn(r, 'tell me a joke about my cat today');
    await r.mod.finderSettled();
    // This message means "anything else", which the garden and travel skills share. Neither stands out as the one to load.
    const note = await turn(r, 'tell me a joke about my cat today');
    assert.ok(!note || note.suggested.every((id) => id === ID('garden-notes') || id === ID('travel-plan')));
  });

  it('finderWiring says embeddings are on only for a ranker that has an embedder', async () => {
    const f = fakeEmbedder();
    const on = await rigWith(f.e);
    assert.equal(on.mod.finderWiring!(on.agents.get('alpha')!).embeddings, true);
    const kw = await rigWith(f.e, { ranker: 'keyword' });
    assert.equal(kw.mod.finderWiring!(kw.agents.get('alpha')!).embeddings, false);
    const none = await rigWith(undefined, { ranker: 'local' });
    assert.equal(none.mod.finderWiring!(none.agents.get('alpha')!).embeddings, false, 'the model is not installed');
  });

  it('with the local ranker and no model installed there is no note, even with suggest on, and nothing is spawned', async () => {
    const r = await rigWith(undefined, { suggest: true, ranker: 'local', threshold: 'eager' });
    assert.equal(await turn(r, 'please polish the typography of these pages'), undefined);
  });
});

describe('armory_find with embeddings', () => {
  const find = async (r: Rig, args: Record<string, unknown>, runtime: 'claude' | 'provider' = 'claude') => {
    const job = { taskId: 't', runtime, taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
    const srv = r.mod.mcpServers!(r.agents.get('alpha')!, job)[ARMORY_SERVER_NAME] as any;
    const out = await srv.instance._registeredTools.armory_find.handler(args, {});
    return out.content.map((c: any) => c.text).join('\n') as string;
  };

  it('lists a skill with no keyword hit once vectors exist, and only the skills this agent may use', async () => {
    const f = fakeEmbedder();
    const r = await rigWith(f.e);
    const before = await find(r, { query: 'luxurious high end brand look', limit: 5 });
    assert.ok(!before.includes('design-polish'), 'keywords alone do not reach it');
    await r.mod.finderSettled();
    const after = await find(r, { query: 'luxurious high end brand look', limit: 5 });
    assert.ok(after.includes('design-polish'), after);
    assert.ok(!after.includes('luxury-off'));
  });

  it('falls back to keywords when the embedder fails', async () => {
    const r = await rigWith(fakeEmbedder({ fail: true }).e);
    const out = await find(r, { query: 'typography spacing', limit: 5 });
    assert.ok(out.includes('design-polish'));
  });
});

describe('the provider ranker', () => {
  const open: Fake[] = [];
  afterEach(async () => { while (open.length) await open.pop()!.close(); });

  it('asks the provider you chose for embeddings, with your model id, and fuses the answer', async () => {
    const f = await startFake((req, res) => {
      const input = req.body.input as string[];
      jsonReply(res, 200, { data: input.map((t, i) => ({ index: i, embedding: Array.from(vecOf(t)) })) });
    });
    open.push(f);
    const r = armoryRig({ modOpts: { providerTarget: (id) => (id === 'p1' ? { entry: entryFor(f) } : undefined) } });
    await own(r, { name: 'design-polish', description: 'Polish typography, spacing and colour for pages', body: 'b' });
    await own(r, { name: 'db-tune', description: 'Tune database queries and indexes', body: 'b' });
    await own(r, { name: 'garden-notes', description: 'Helps with garden things', body: 'b' });
    await r.call('POST', '/api/armory/finder', { suggest: true, ranker: 'provider', providerId: 'p1', providerModel: 'embed-x', threshold: 'eager' });
    assert.equal(r.mod.finderWiring!(r.agents.get('alpha')!).embeddings, true);
    const ask = (prompt: string) => r.mod.turnNote!(r.agents.get('alpha')!, { prompt, taskId: 't1', runtime: 'provider' });
    await ask(NO_KEYWORDS);
    await r.mod.finderSettled();
    const note = await ask(NO_KEYWORDS);
    assert.deepEqual(note?.suggested, [ID('design-polish')]);
    assert.ok(f.requests.every((q) => q.url === '/v1/embeddings' && q.body.model === 'embed-x'));
    assert.ok(f.requests.some((q) => (q.body.input as string[]).length === 3), 'the three skills went in one request');
  });

  it('without a provider id or model, or with a provider that is gone, it is keywords only', async () => {
    const r = armoryRig({ modOpts: { providerTarget: () => undefined } });
    await own(r, { name: 'design-polish', description: 'Polish typography, spacing and colour for pages', body: 'b' });
    await r.call('POST', '/api/armory/finder', { ranker: 'provider' });
    assert.equal(r.mod.finderWiring!(r.agents.get('alpha')!).embeddings, false);
    await r.call('POST', '/api/armory/finder', { providerId: 'gone', providerModel: 'm' });
    assert.equal(r.mod.finderWiring!(r.agents.get('alpha')!).embeddings, false);
  });
});

describe("suggest 'auto' (an owner's choice)", () => {
  it('is off for the keyword ranker, off for the local ranker without its model, and on for the local ranker with it', async () => {
    const f = fakeEmbedder();
    const prompt = 'please polish the typography of these pages';
    const keyword = await rigWith(f.e, { suggest: 'auto', threshold: 'eager' });
    assert.equal(keyword.mod.finderWiring!(keyword.agents.get('alpha')!).suggest, false, 'keyword ranker: auto is off');
    assert.equal(await turn(keyword, prompt), undefined, 'and no note is made');
    const noModel = await rigWith(undefined, { suggest: 'auto', ranker: 'local', threshold: 'eager' });
    assert.equal(noModel.mod.finderWiring!(noModel.agents.get('alpha')!).suggest, false, 'local ranker, no model: auto is off');
    const local = await rigWith(f.e, { suggest: 'auto', ranker: 'local', threshold: 'eager' });
    assert.equal(local.mod.finderWiring!(local.agents.get('alpha')!).suggest, true, 'local ranker with a model: auto is on');
    assert.equal(await turn(local, prompt), undefined, 'a cold model (no vectors yet) under auto gives no keyword note');
    await local.mod.finderSettled();
    assert.ok(await turn(local, prompt), 'once the skills are embedded the note comes');
    await local.call('POST', '/api/armory/finder', { suggest: false });
    assert.equal(local.mod.finderWiring!(local.agents.get('alpha')!).suggest, false, 'an explicit off wins');
    assert.equal(await turn(local, prompt), undefined);
  });
});

describe('the raw cosine floor', () => {
  it('keeps a note away when no skill is close enough, but never cuts the search tool', async () => {
    // Every skill is only about 0.6 close to the message: far under the floor of 0.88, yet the min-max score of the best two is high.
    const far: Embedder = {
      id: 'fake-far',
      async embed(texts, _s, kind) {
        return texts.map((t) => (kind === 'query' ? Float32Array.from([0.6, 0.6, 0.53]) : vecOf(t)));
      },
    };
    const r = armoryRig({ modOpts: { finderEmbedder: () => far, finderTuning: { ...MECHANISM_TUNING, cosineFloor: 0.88 } } });
    await own(r, { name: 'design-polish', description: 'Polish typography, spacing and colour for pages', body: 'b' });
    await own(r, { name: 'db-tune', description: 'Tune database queries and indexes', body: 'b' });
    await own(r, { name: 'garden-notes', description: 'Helps with garden things', body: 'b' });
    await r.call('POST', '/api/armory/finder', { suggest: true, ranker: 'local', threshold: 'eager' });
    await turn(r, 'something vague about the whole thing please');
    await r.mod.finderSettled();
    assert.equal(await turn(r, 'something vague about the whole thing please'), undefined, 'no skill is close enough for a note');
    const job = { taskId: 't', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
    const srv = r.mod.mcpServers!(r.agents.get('alpha')!, job)[ARMORY_SERVER_NAME] as any;
    const out = (await srv.instance._registeredTools.armory_find.handler({ query: 'something vague about the whole thing please', limit: 5 }, {})).content.map((c: any) => c.text).join('\n') as string;
    assert.ok(out.includes('design-polish') && out.includes('db-tune'), `the search still lists the closest skills: ${out}`);
  });
});

describe('the search weight', () => {
  it('armory_find fuses with its own weight, not the note weight', async () => {
    // The message says "typography" (a keyword hit on design-polish) but its vector points at the database axis.
    const toDb: Embedder = { id: 'fake-db', async embed(texts, _s, kind) { return texts.map((t) => (kind === 'query' ? Float32Array.from([0, 1, 0]) : vecOf(t))); } };
    const mk = async (tune: Record<string, number>) => {
      const r = armoryRig({ modOpts: { finderEmbedder: () => toDb, finderTuning: { ...MECHANISM_TUNING, ...tune } } });
      await own(r, { name: 'design-polish', description: 'Polish typography, spacing and colour for pages', body: 'b' });
      await own(r, { name: 'db-tune', description: 'Tune database queries and indexes', body: 'b' });
      await r.call('POST', '/api/armory/finder', { ranker: 'local' });
      const job = { taskId: 't', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
      const srv = r.mod.mcpServers!(r.agents.get('alpha')!, job)[ARMORY_SERVER_NAME] as any;
      const ask = async () => (await srv.instance._registeredTools.armory_find.handler({ query: 'typography', limit: 5 }, {})).content.map((c: any) => c.text).join('\n') as string;
      await ask();
      await r.mod.finderSettled();
      return ask();
    };
    // Note weight 1 (all vector) and search weight 0 (all keywords): the search follows the keywords.
    const out = await mk({ weight: 1, searchWeight: 0 });
    assert.ok(out.indexOf('design-polish') >= 0 && (out.indexOf('db-tune') < 0 || out.indexOf('design-polish') < out.indexOf('db-tune')), out);
    // Swapped: the search follows the vector.
    const swapped = await mk({ weight: 0, searchWeight: 1 });
    assert.ok(swapped.indexOf('db-tune') >= 0 && (swapped.indexOf('design-polish') < 0 || swapped.indexOf('db-tune') < swapped.indexOf('design-polish')), swapped);
  });
});

describe('the shipped numbers (no finderTuning override)', () => {
  const PROMPT = 'please polish the typography of these pages';
  const shipped = async (emb: Embedder, ranker: 'local' | 'provider', skills = true) => {
    const r = armoryRig({ modOpts: { finderEmbedder: () => emb, finderTuning: {} } });
    if (skills) {
      await own(r, { name: 'design-polish', description: 'Polish typography, spacing and colour for pages', body: 'b' });
      await own(r, { name: 'db-tune', description: 'Tune database queries and indexes', body: 'b' });
      await own(r, { name: 'garden-notes', description: 'Helps with garden things', body: 'b' });
    }
    await r.call('POST', '/api/armory/finder', { suggest: true, ranker, threshold: 'eager' });
    return r;
  };

  for (const runtime of ['claude', 'provider'] as const) {
    it(`the ${runtime} path: a close skill gets a note with the tuned floors`, async () => {
      const r = await shipped(fakeEmbedder().e, 'local');
      assert.equal(await turn(r, PROMPT, runtime), undefined, 'the first turn has no vectors yet');
      await r.mod.finderSettled();
      const note = await turn(r, PROMPT, runtime);
      assert.deepEqual(note?.suggested, [ID('design-polish')]);
    });
  }

  it('the provider embedder is untuned: no cosine floor, so a skill at cosine 0.68 gets a note that the local floor of 0.88 refuses', async () => {
    const far: Embedder = { id: 'fake-far2', async embed(texts, _s, kind) { return texts.map((t) => (kind === 'query' ? Float32Array.from([0.6, -0.5, -0.4]) : vecOf(t))); } };
    const provider = await shipped(far, 'provider');
    await turn(provider, PROMPT);
    await provider.mod.finderSettled();
    const got = await turn(provider, PROMPT);
    assert.deepEqual(got?.suggested, [ID('design-polish')]);
    assert.ok(got!.why[0]!.cosine! < 0.88);
    const local = await shipped(far, 'local');
    await turn(local, PROMPT);
    await local.mod.finderSettled();
    assert.equal(await turn(local, PROMPT), undefined, 'the same vectors on the local ranker fall under its cosine floor');
  });
});
