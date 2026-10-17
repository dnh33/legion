/**
 * BM25F over four fields: the name (the id's parts count as name tokens), the description, `when_to_use` and the headings.
 * Each field's term count is weighted and length-normalised first, then the sum is saturated once (BM25F).
 */
import { tokenize } from '../../kg/text.js';
import type { FinderDoc } from './doc.js';
import { B, FIELD_WEIGHTS, K1 } from './defaults.js';

export type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];

export interface IndexedDoc {
  id: string;
  tf: Record<Field, Map<string, number>>;
  len: Record<Field, number>;
}

export interface FinderIndex {
  /** Number of docs. */
  n: number;
  docs: IndexedDoc[];
  /** Mean token count per field, over every doc. */
  avgLen: Record<Field, number>;
  /** Number of docs that hold each token in any field. */
  df: Map<string, number>;
}

export interface ScoredHit {
  score: number;
  /** The query tokens that hit, in query order, each once. */
  matched: string[];
}

/** The tokens of each field. The name field also holds the id's parts, split on ':', '-' and '_'. */
function fieldTokens(d: FinderDoc): Record<Field, string[]> {
  const idParts = d.id.split(/[:\-_]/).flatMap((p) => tokenize(p));
  return {
    name: [...tokenize(d.name), ...idParts],
    description: tokenize(d.description),
    whenToUse: tokenize(d.whenToUse),
    headings: tokenize(d.headings),
  };
}

export function buildIndex(docs: FinderDoc[]): FinderIndex {
  const total: Record<Field, number> = { name: 0, description: 0, whenToUse: 0, headings: 0 };
  const df = new Map<string, number>();
  const indexed: IndexedDoc[] = [];
  for (const d of docs) {
    const toks = fieldTokens(d);
    const tf = {} as Record<Field, Map<string, number>>;
    const len = {} as Record<Field, number>;
    const seen = new Set<string>();
    for (const f of FIELDS) {
      const m = new Map<string, number>();
      for (const t of toks[f]) {
        m.set(t, (m.get(t) ?? 0) + 1);
        seen.add(t);
      }
      tf[f] = m;
      len[f] = toks[f].length;
      total[f] += toks[f].length;
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    indexed.push({ id: d.id, tf, len });
  }
  const avgLen = {} as Record<Field, number>;
  for (const f of FIELDS) avgLen[f] = docs.length > 0 ? total[f] / docs.length : 0;
  return { n: docs.length, docs: indexed, avgLen, df };
}

/** Scores every doc that holds at least one query token. Docs with no hit are left out. */
export function scoreIndex(ix: FinderIndex, query: string): Map<string, ScoredHit> {
  const out = new Map<string, ScoredHit>();
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return out;
  for (const d of ix.docs) {
    let score = 0;
    const matched: string[] = [];
    for (const t of terms) {
      let tfw = 0;
      for (const f of FIELDS) {
        const n = d.tf[f].get(t) ?? 0;
        if (n === 0) continue;
        const avg = ix.avgLen[f];
        const norm = avg > 0 ? 1 - B + B * (d.len[f] / avg) : 1;
        tfw += (FIELD_WEIGHTS[f] * n) / norm;
      }
      if (tfw === 0) continue;
      matched.push(t);
      const df = ix.df.get(t) ?? 0;
      // The +1 inside the log keeps IDF positive, even for a term that is in every doc.
      const idf = Math.log(1 + (ix.n - df + 0.5) / (df + 0.5));
      score += (idf * tfw) / (K1 + tfw);
    }
    if (score > 0) out.set(d.id, { score, matched });
  }
  return out;
}
