/** Ranks the skills for one message: the BM25F score times an optional boost, then a floor, a sort and a cut to k. */
import { performance } from 'node:perf_hooks';
import { scoreIndex } from './bm25.js';
import type { FinderIndex } from './bm25.js';
import { cosine } from './embed.js';
import { BM25_MIN_SPREAD, COSINE_MIN_SPREAD, DEFAULT_K, FUSION_WEIGHT, RAW_COSINE_FLOOR } from './defaults.js';

export interface RankOpts {
  /** How many results to keep. Clamped to 1..5; NaN gives the default. */
  k: number;
  /** A result under this final score is dropped. */
  minScore: number;
  /** Past this many milliseconds the rank gives up. */
  deadlineMs: number;
  /** The most results the cut may keep (the rerank asks for more than the note shows). Default 5. */
  maxK?: number;
  /** Multiplies a skill's score. Default 1. */
  boost?: (id: string) => number;
  /** Monotonic clock in milliseconds. Default performance.now. */
  now?: () => number;
}

export interface Ranked {
  id: string;
  /** bm25 times boost, or the fused score times boost when embeddings ranked it. */
  score: number;
  bm25: number;
  /** The cosine to the message, only when embeddings ranked it. */
  cosine?: number;
  matched: string[];
  boost: number;
}

const MAX_K = 5;

export function rank(ix: FinderIndex, query: string, opts: RankOpts): { results: Ranked[]; timedOut: boolean } {
  if (query.trim() === '') return { results: [], timedOut: false };
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const overdue = (): boolean => now() - start > opts.deadlineMs;

  const hits = scoreIndex(ix, query);
  if (overdue()) return { results: [], timedOut: true };

  const ranked: Ranked[] = [];
  for (const [id, hit] of hits) {
    const raw = opts.boost?.(id) ?? 1;
    const boost = Number.isFinite(raw) ? raw : 1;
    if (overdue()) return { results: [], timedOut: true };
    const score = hit.score * boost;
    if (score > 0 && score >= opts.minScore) ranked.push({ id, score, bm25: hit.score, matched: hit.matched, boost });
  }

  // Plain comparisons, not localeCompare, so the order does not depend on the machine's locale.
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = Number.isFinite(opts.k) ? Math.min(opts.maxK ?? MAX_K, Math.max(1, Math.floor(opts.k))) : DEFAULT_K;
  return { results: ranked.slice(0, k), timedOut: false };
}

export interface FuseOpts extends RankOpts {
  /** Weight of the cosine in the fused score, 0 to 1. Default FUSION_WEIGHT. */
  weight?: number;
  /** The most results the cut may keep. Default 5; a search tool asks for more. */
  maxK?: number;
  /** A skill with a vector and a raw cosine under this is dropped. Default RAW_COSINE_FLOOR. */
  cosineFloor?: number;
}

/** (x - lo) / max(hi - lo, minSpread): min-max, except a narrow spread is not stretched, so a message that fits nothing stays low. */
const norm = (x: number, lo: number, hi: number, minSpread: number): number => (x - lo) / Math.max(hi - lo, minSpread);

/**
 * Ranks with embeddings: `score = w * cosineNorm + (1 - w) * bm25Norm`, both normalised to 0..1 over the candidates, then the boost,
 * the floor, a sort and a cut to k. A skill with no keyword hit still ranks by its cosine. A skill with no vector yet counts as the
 * lowest cosine. Returns null when fewer than two candidates have a vector (nothing to compare), so the caller uses `rank`.
 */
export function rankFused(
  ix: FinderIndex, query: string, queryVec: ArrayLike<number>, vecs: ReadonlyMap<string, ArrayLike<number>>, opts: FuseOpts,
): { results: Ranked[]; timedOut: boolean } | null {
  if (query.trim() === '') return { results: [], timedOut: false };
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const overdue = (): boolean => now() - start > opts.deadlineMs;
  const w = Number.isFinite(opts.weight) ? Math.min(1, Math.max(0, opts.weight!)) : FUSION_WEIGHT;
  const floor = Number.isFinite(opts.cosineFloor) ? opts.cosineFloor! : RAW_COSINE_FLOOR;

  const ids = ix.docs.map((d) => d.id);
  const cos = new Map<string, number>();
  for (const id of ids) { const v = vecs.get(id); if (v) cos.set(id, cosine(queryVec, v)); }
  if (cos.size < 2) return null;
  const hits = scoreIndex(ix, query);
  if (overdue()) return { results: [], timedOut: true };

  const cVals = [...cos.values()];
  const cLo = Math.min(...cVals); const cHi = Math.max(...cVals);
  let bHi = 0;
  for (const id of ids) bHi = Math.max(bHi, hits.get(id)?.score ?? 0);

  const ranked: Ranked[] = [];
  for (const id of ids) {
    const hit = hits.get(id);
    const c = cos.get(id);
    const cn = c === undefined ? 0 : norm(c, cLo, cHi, COSINE_MIN_SPREAD);
    const bn = hit ? norm(hit.score, 0, bHi, BM25_MIN_SPREAD) : 0;
    const raw = opts.boost?.(id) ?? 1;
    const boost = Number.isFinite(raw) ? raw : 1;
    if (overdue()) return { results: [], timedOut: true };
    const score = (w * cn + (1 - w) * bn) * boost;
    if (c !== undefined && c < floor) continue;
    if (score > 0 && score >= opts.minScore) ranked.push({ id, score, bm25: hit?.score ?? 0, ...(c !== undefined ? { cosine: c } : {}), matched: hit?.matched ?? [], boost });
  }
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = Number.isFinite(opts.k) ? Math.min(opts.maxK ?? MAX_K, Math.max(1, Math.floor(opts.k))) : DEFAULT_K;
  return { results: ranked.slice(0, k), timedOut: false };
}
