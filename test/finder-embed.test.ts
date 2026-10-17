/** Skill finder embeddings: cosine, the vector cache, the lazy passage batch and the fusion with keywords. A fake embedder, never a model. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildIndex } from '../src/core/armory/finder/bm25.js';
import type { FinderDoc } from '../src/core/armory/finder/doc.js';
import { cosine, createVectorCache, MAX_NEW_PASSAGES, passageText, passageVectors, vectorsPath } from '../src/core/armory/finder/embed.js';
import type { EmbedKind, Embedder } from '../src/core/armory/finder/embed.js';
import { rank, rankFused } from '../src/core/armory/finder/rank.js';
import { FUSED_THRESHOLDS, FUSION_WEIGHT, RAW_COSINE_FLOOR } from '../src/core/armory/finder/defaults.js';
import { tempDir } from './tmp-cleanup.js';

const doc = (id: string, description: string, over: Partial<FinderDoc> = {}): FinderDoc =>
  ({ id, name: id, description, whenToUse: '', headings: '', source: 'yours', thirdParty: false, ...over });

/** An embedder over a fixed table: a text maps to a unit vector. It counts what it was asked to embed. */
function fakeEmbedder(table: Record<string, number[]>, id = 'fake-1'): Embedder & { calls: { texts: string[]; kind: EmbedKind | undefined }[] } {
  const calls: { texts: string[]; kind: EmbedKind | undefined }[] = [];
  return {
    id, calls,
    async embed(texts, _signal, kind) {
      calls.push({ texts: [...texts], kind });
      return texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`no vector for ${t}`);
        const n = Math.hypot(...v);
        return Float32Array.from(v.map((x) => x / n));
      });
    },
  };
}
const sig = (): AbortSignal => new AbortController().signal;

describe('cosine', () => {
  it('is 1 for the same direction, 0 for a right angle, -1 for opposite, and 0 for a zero vector', () => {
    assert.ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-12);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.ok(Math.abs(cosine([1, 0], [-3, 0]) + 1) < 1e-12);
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });
});

describe('the vector cache', () => {
  it('keeps a vector across a reload, keyed by model id and text', () => {
    const dir = tempDir('finder-vec-');
    const a = createVectorCache(dir);
    a.set('m1', 'hello', Float32Array.from([0.5, -0.25, 1]));
    a.save();
    const b = createVectorCache(dir);
    assert.deepEqual([...b.get('m1', 'hello')!], [0.5, -0.25, 1]);
    assert.equal(b.get('m2', 'hello'), undefined, 'another model never reads it');
    assert.equal(b.get('m1', 'hello!'), undefined, 'another text is another key');
  });

  it('clear forgets the vectors and the unsaved change, so a later save does not bring the file back', () => {
    const dir = tempDir('finder-vec-');
    const c = createVectorCache(dir);
    c.set('m', 't', Float32Array.from([1]));
    c.save();
    assert.ok(existsSync(vectorsPath(dir)));
    c.set('m', 'u', Float32Array.from([2]));
    rmSync(vectorsPath(dir), { force: true }); // what removing the model does
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get('m', 't'), undefined);
    c.save();
    assert.equal(existsSync(vectorsPath(dir)), false, 'nothing is written back');
  });

  it('starts empty on a corrupt file, and a failed write does not throw', () => {
    const dir = tempDir('finder-vec-');
    mkdirSync(dirname(vectorsPath(dir)), { recursive: true });
    writeFileSync(vectorsPath(dir), '{not json', 'utf8');
    const c = createVectorCache(dir);
    assert.equal(c.size, 0);
    c.set('m', 't', Float32Array.from([1]));
    c.save();
    assert.equal(createVectorCache(dir).size, 1);
    const blocked = tempDir('finder-vec-blocked-');
    writeFileSync(`${blocked}/skill-finder`, 'a file where the folder should be');
    const d = createVectorCache(blocked);
    d.set('m', 't', Float32Array.from([1]));
    assert.doesNotThrow(() => d.save());
  });

  it('writes only when something changed', () => {
    const dir = tempDir('finder-vec-');
    const c = createVectorCache(dir);
    c.save();
    assert.equal(existsSync(vectorsPath(dir)), false);
    c.set('m', 't', Float32Array.from([1]));
    c.save();
    assert.equal(existsSync(vectorsPath(dir)), true);
  });

  it('is capped: the oldest vector goes first, and a vector that was read is kept', () => {
    const c = createVectorCache(tempDir('finder-vec-'), 3);
    for (const t of ['a', 'b', 'c']) c.set('m', t, Float32Array.from([1]));
    c.get('m', 'a');
    c.set('m', 'd', Float32Array.from([1]));
    assert.equal(c.size, 3);
    assert.equal(c.get('m', 'b'), undefined, 'b was the oldest unused');
    assert.ok(c.get('m', 'a') && c.get('m', 'c') && c.get('m', 'd'));
  });

  it('stores float32 as text on disk, not as a long number list', () => {
    const dir = tempDir('finder-vec-');
    const c = createVectorCache(dir);
    c.set('m', 't', new Float32Array(384).fill(0.01));
    c.save();
    const raw = JSON.parse(readFileSync(vectorsPath(dir), 'utf8')) as { vectors: Record<string, string> };
    assert.equal(Object.values(raw.vectors)[0]!.length, Math.ceil((384 * 4) / 3) * 4);
  });
});

describe('passageVectors', () => {
  const docs = [doc('a', 'make pages look premium'), doc('b', 'tune database queries'), doc('c', 'review security')];
  const table: Record<string, number[]> = {};
  docs.forEach((d, i) => { table[passageText(d)] = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]; });

  it('embeds each passage once and re-embeds only the one whose text changed', async () => {
    const cache = createVectorCache(tempDir('finder-vec-'));
    const e = fakeEmbedder(table);
    const first = await passageVectors(e, cache, docs, sig());
    assert.equal(first.size, 3);
    assert.equal(e.calls.length, 1);
    assert.equal(e.calls[0]!.kind, 'passage');
    assert.equal(e.calls[0]!.texts.length, 3);
    await passageVectors(e, cache, docs, sig());
    assert.equal(e.calls.length, 1, 'all cached: no second call');

    const changed = [docs[0]!, doc('b', 'tune database queries and indexes'), docs[2]!];
    const e2 = fakeEmbedder({ ...table, [passageText(changed[1]!)]: [0, 1, 1] });
    const next = await passageVectors(e2, cache, changed, sig());
    assert.equal(next.size, 3);
    assert.equal(e2.calls.length, 1);
    assert.deepEqual(e2.calls[0]!.texts, [passageText(changed[1]!)], 'only the changed passage');
  });

  it('a new model id re-embeds everything', async () => {
    const cache = createVectorCache(tempDir('finder-vec-'));
    await passageVectors(fakeEmbedder(table, 'm1'), cache, docs, sig());
    const e = fakeEmbedder(table, 'm2');
    await passageVectors(e, cache, docs, sig());
    assert.equal(e.calls[0]!.texts.length, 3);
  });

  it('embeds at most 64 new passages per call; the rest wait for the next call', async () => {
    const many = Array.from({ length: 100 }, (_, i) => doc(`s${i}`, `skill number ${i}`));
    const t: Record<string, number[]> = {};
    many.forEach((d, i) => { t[passageText(d)] = [1, i + 1]; });
    const cache = createVectorCache(tempDir('finder-vec-'));
    const e = fakeEmbedder(t);
    const one = await passageVectors(e, cache, many, sig());
    assert.equal(MAX_NEW_PASSAGES, 64);
    assert.equal(e.calls[0]!.texts.length, 64);
    assert.equal(one.size, 64);
    const two = await passageVectors(e, cache, many, sig());
    assert.equal(e.calls[1]!.texts.length, 36);
    assert.equal(two.size, 100);
  });

  it('an embedder failure rejects and caches nothing for that batch', async () => {
    const cache = createVectorCache(tempDir('finder-vec-'));
    const failing: Embedder = { id: 'x', embed: async () => { throw new Error('model gone'); } };
    await assert.rejects(passageVectors(failing, cache, docs, sig()), /model gone/);
    assert.equal(cache.size, 0);
  });

  it('a wrong number of vectors is an error', async () => {
    const bad: Embedder = { id: 'x', embed: async () => [Float32Array.from([1])] };
    await assert.rejects(passageVectors(bad, createVectorCache(tempDir('finder-vec-')), docs, sig()), /wrong number/);
  });
});

describe('rankFused', () => {
  // 2-d vectors: x = "visual design", y = "database".
  const docs = [
    doc('design', 'polish typography and spacing for pages'),
    doc('postgres', 'tune slow queries and indexes'),
    doc('security', 'find injection and leaked secrets'),
    doc('luxury', 'elegant high end brand look'),
  ];
  const vecs = new Map<string, number[]>([
    ['design', [1, 0]], ['postgres', [0, 1]], ['security', [-0.2, -1]], ['luxury', [0.9, 0.1]],
  ]);
  const ix = buildIndex(docs);
  const base = { k: 3, minScore: 0, deadlineMs: 1000 };

  it('a skill with no keyword hit still ranks by its cosine', () => {
    // The message shares no word with "luxury", but its vector points at design.
    const q = 'gør siden mere premium';
    assert.equal(rank(ix, q, base).results.length, 0, 'keywords alone find nothing');
    const r = rankFused(ix, q, [1, 0.05], vecs, base)!;
    assert.deepEqual(r.results.slice(0, 2).map((x) => x.id), ['design', 'luxury']);
    assert.equal(r.results[1]!.bm25, 0);
    assert.ok(r.results[1]!.cosine! > 0.9);
  });

  it('is w * cosineNorm + (1 - w) * bm25Norm, exactly', () => {
    const q = 'typography spacing';
    const r = rankFused(ix, q, [0.6, 0.8], vecs, { ...base, k: 5 })!;
    const cos = (id: string): number => cosine([0.6, 0.8], vecs.get(id)!);
    const all = [...vecs.keys()].map(cos);
    const lo = Math.min(...all); const hi = Math.max(...all);
    const design = r.results.find((x) => x.id === 'design')!;
    const cn = (cos('design') - lo) / Math.max(hi - lo, 0.05);
    const bn = design.bm25 / Math.max(design.bm25, 2);
    assert.ok(Math.abs(design.score - (FUSION_WEIGHT * cn + (1 - FUSION_WEIGHT) * bn)) < 1e-9, `${design.score} vs ${FUSION_WEIGHT * cn + (1 - FUSION_WEIGHT) * bn}`);
  });

  it('a keyword match can lift a skill over a slightly closer vector', () => {
    const q = 'typography';
    const r = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, weight: 0.2 })!;
    assert.equal(r.results[0]!.id, 'design');
    const noKeywords = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, weight: 1 })!;
    assert.equal(noKeywords.results[0]!.id, 'luxury', 'with all the weight on the vector, the closer vector wins');
  });

  it('a message that fits nothing stays under the balanced floor', () => {
    // Every cosine is within 0.02: the spread is not stretched, so nothing reaches 0.6.
    const flat = new Map<string, number[]>([['design', [1, 0.10]], ['postgres', [1, 0.12]], ['security', [1, 0.11]], ['luxury', [1, 0.13]]]);
    const r = rankFused(ix, 'unrelated words zzz', [1, 0.1], flat, { ...base, minScore: FUSED_THRESHOLDS.balanced })!;
    assert.deepEqual(r.results, []);
  });

  it('applies the usage boost and the floor', () => {
    const q = 'typography';
    const lifted = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, k: 5, boost: (id) => (id === 'postgres' ? 100 : 1) })!;
    assert.equal(lifted.results[0]!.id, 'postgres');
    const floored = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, minScore: 5 })!;
    assert.deepEqual(floored.results, []);
  });

  it('drops a skill whose raw cosine is under the floor, whatever its fused score', () => {
    // The message sits between design and postgres; min-max would give the closer one a full cosine score.
    const q = 'typography';
    const open = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, k: 5, cosineFloor: 0 })!;
    const best = open.results[0]!;
    assert.ok(best.cosine! > 0.7 && best.score > 0.5 && open.results.length === 3);
    const shut = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, k: 5, cosineFloor: 0.9 })!;
    assert.deepEqual(shut.results, [], 'a floor above every cosine leaves no result');
    const mid = rankFused(ix, q, [0.7, 0.7], vecs, { ...base, k: 5, cosineFloor: 0.75 })!;
    assert.deepEqual(mid.results.map((x) => x.id), ['luxury']);
  });

  it('the floor ignores a skill that has no vector yet, and defaults to RAW_COSINE_FLOOR', () => {
    const partial = new Map(vecs); partial.delete('security');
    const q = 'find injection leaked secrets';
    const r = rankFused(ix, q, [0.6, 0.8], partial, { ...base, k: 5, cosineFloor: 0.99 })!;
    assert.deepEqual(r.results.map((x) => x.id), ['security'], 'a keyword hit with no vector is not judged by a cosine it does not have');
    const dflt = rankFused(ix, 'typography', [0.7, 0.7], vecs, { ...base, k: 5 })!;
    const same = rankFused(ix, 'typography', [0.7, 0.7], vecs, { ...base, k: 5, cosineFloor: RAW_COSINE_FLOOR })!;
    assert.deepEqual(dflt.results, same.results);
  });

  it('returns null with fewer than two vectors, so the caller uses keywords', () => {
    assert.equal(rankFused(ix, 'typography', [1, 0], new Map([['design', [1, 0]]]), base), null);
    assert.equal(rankFused(ix, 'typography', [1, 0], new Map(), base), null);
  });

  it('a skill with no vector yet counts as the lowest cosine but can still win on keywords', () => {
    const partial = new Map<string, number[]>([['postgres', [0, 1]], ['security', [-0.2, -1]]]);
    const r = rankFused(ix, 'typography spacing', [0, 1], partial, { ...base, k: 5, weight: 0.3 })!;
    assert.equal(r.results.find((x) => x.id === 'design')!.cosine, undefined);
    assert.ok(r.results.some((x) => x.id === 'design'));
  });

  it('gives up past the deadline, and an empty message gives nothing', () => {
    let t = 0;
    const slow = rankFused(ix, 'typography', [1, 0], vecs, { ...base, deadlineMs: 5, now: () => (t += 10) })!;
    assert.equal(slow.timedOut, true);
    assert.deepEqual(rankFused(ix, '   ', [1, 0], vecs, base), { results: [], timedOut: false });
  });

  it('clamps k to 1..5', () => {
    assert.equal(rankFused(ix, 'typography', [1, 0], vecs, { ...base, k: 99 })!.results.length <= 4, true);
    assert.equal(rankFused(ix, 'typography', [1, 0], vecs, { ...base, k: 0 })!.results.length, 1);
  });
});
