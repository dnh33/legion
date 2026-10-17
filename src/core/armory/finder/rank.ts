/** Ranks the skills for one message: the BM25F score times an optional boost, then a floor, a sort and a cut to k. */
import { scoreIndex } from './bm25.js';
import type { FinderIndex } from './bm25.js';
import { DEFAULT_K } from './defaults.js';

export interface RankOpts {
  /** How many results to keep. Clamped to 1..5; NaN gives the default. */
  k: number;
  /** A result under this final score is dropped. */
  minScore: number;
  /** Past this many milliseconds the rank gives up. */
  deadlineMs: number;
  /** Multiplies a skill's score. Default 1. */
  boost?: (id: string) => number;
  /** Clock in milliseconds. Default Date.now. */
  now?: () => number;
}

export interface Ranked {
  id: string;
  /** bm25 times boost. */
  score: number;
  bm25: number;
  matched: string[];
  boost: number;
}

const MAX_K = 5;

export function rank(ix: FinderIndex, query: string, opts: RankOpts): { results: Ranked[]; timedOut: boolean } {
  if (query.trim() === '') return { results: [], timedOut: false };
  const now = opts.now ?? (() => Date.now());
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
  const k = Number.isFinite(opts.k) ? Math.min(MAX_K, Math.max(1, Math.floor(opts.k))) : DEFAULT_K;
  return { results: ranked.slice(0, k), timedOut: false };
}
