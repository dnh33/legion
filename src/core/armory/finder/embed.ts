/**
 * Embeddings for the skill finder: the Embedder interface, cosine similarity, the text a skill is embedded as, and the vector cache.
 *
 * The cache is a file, <dataDir>/skill-finder/vectors.json. A vector is keyed by the model id plus the sha256 of the passage text, so
 * a skill whose text did not change is never embedded again, and a different model never reads another model's vectors. The file
 * is a cache: a missing or corrupt file starts empty, and a failed write is dropped without a throw.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FinderDoc } from './doc.js';

/** A message to rank is a 'query'; a skill's text is a 'passage'. Some models treat the two differently. */
export type EmbedKind = 'query' | 'passage';

export interface Embedder {
  /** Names the model, so cached vectors are never mixed between models. */
  readonly id: string;
  /** One unit-length vector per text, in order. Rejects when the model cannot answer; the finder then uses keywords for that turn. */
  embed(texts: string[], signal: AbortSignal, kind?: EmbedKind): Promise<Float32Array[]>;
}

/** The most passages embedded in one call. The rest wait for the next turn. */
export const MAX_NEW_PASSAGES = 64;
/** The most vectors the cache keeps. The oldest go first. */
export const MAX_CACHED_VECTORS = 5000;
/** Longest passage text, in characters. The model cuts it to 128 tokens anyway. */
const MAX_PASSAGE_CHARS = 1200;

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < n; i++) { const x = a[i]!; const y = b[i]!; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** The text a skill is embedded as: its name, what it does and when to use it. Headings stay out; they are noise for a sentence model. */
export function passageText(doc: Pick<FinderDoc, 'name' | 'description' | 'whenToUse'>): string {
  const parts = [doc.name, doc.description, doc.whenToUse].map((s) => s.trim()).filter(Boolean);
  return parts.join('. ').slice(0, MAX_PASSAGE_CHARS);
}

export const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface VectorCache {
  get(modelId: string, text: string): Float32Array | undefined;
  set(modelId: string, text: string, vec: Float32Array): void;
  /** Writes the file when something changed. Never throws. */
  save(): void;
  /** Forgets every vector in memory and drops any unsaved change, so a later save() cannot bring a deleted file back. */
  clear(): void;
  /** Counts the clears. A fill that began before a clear must not write after it. */
  readonly generation: number;
  readonly size: number;
}

export function vectorsPath(dataDir: string): string {
  return join(dataDir, 'skill-finder', 'vectors.json');
}

const toB64 = (v: Float32Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
function fromB64(s: string): Float32Array | undefined {
  const buf = Buffer.from(s, 'base64');
  if (buf.length === 0 || buf.length % 4 !== 0) return undefined;
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export function createVectorCache(dataDir: string, max = MAX_CACHED_VECTORS): VectorCache {
  const path = vectorsPath(dataDir);
  // Insertion order is age order: a hit moves the key to the end, so the oldest unused vector is the first key.
  const map = new Map<string, Float32Array>();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; vectors?: unknown };
    if (raw && raw.version === 1 && raw.vectors && typeof raw.vectors === 'object' && !Array.isArray(raw.vectors)) {
      for (const [k, v] of Object.entries(raw.vectors as Record<string, unknown>)) {
        if (typeof v !== 'string') continue;
        const vec = fromB64(v);
        if (vec) map.set(k, vec);
      }
    }
  } catch { /* a missing or corrupt cache starts empty */ }
  let dirty = false;
  let generation = 0;
  const key = (modelId: string, text: string): string => `${modelId}:${textHash(text)}`;
  return {
    get(modelId, text) {
      const k = key(modelId, text);
      const v = map.get(k);
      if (v) { map.delete(k); map.set(k, v); }
      return v;
    },
    set(modelId, text, vec) {
      const k = key(modelId, text);
      map.delete(k);
      map.set(k, vec);
      while (map.size > max) map.delete(map.keys().next().value as string);
      dirty = true;
    },
    save() {
      if (!dirty) return;
      dirty = false;
      const vectors: Record<string, string> = {};
      for (const [k, v] of map) vectors[k] = toB64(v);
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, JSON.stringify({ version: 1, vectors }), 'utf8');
        renameSync(tmp, path);
      } catch {
        try { rmSync(tmp, { force: true }); } catch { /* leave it */ }
      }
    },
    clear() { map.clear(); dirty = false; generation++; },
    get generation() { return generation; },
    get size() { return map.size; },
  };
}

type PassageDoc = Pick<FinderDoc, 'id' | 'name' | 'description' | 'whenToUse'>;

/** The vectors already in the cache for these docs, and the docs that have none. Reads nothing from the model. */
export function cachedPassages(modelId: string, cache: VectorCache, docs: readonly PassageDoc[]): { have: Map<string, Float32Array>; missing: PassageDoc[] } {
  const have = new Map<string, Float32Array>();
  const missing: PassageDoc[] = [];
  for (const d of docs) {
    const text = passageText(d);
    if (!text) continue;
    const hit = cache.get(modelId, text);
    if (hit) have.set(d.id, hit);
    else missing.push(d);
  }
  return { have, missing };
}

/**
 * The passage vectors for these docs. A vector in the cache is used as it is. The docs without one are embedded in one batch (at most
 * `limit` per call, the rest wait for a later turn) and cached. Any embedder failure rejects; the vectors found so far stay cached.
 */
export async function passageVectors(
  embedder: Embedder, cache: VectorCache, docs: readonly PassageDoc[], signal: AbortSignal, limit = MAX_NEW_PASSAGES,
): Promise<Map<string, Float32Array>> {
  const { have: out, missing } = cachedPassages(embedder.id, cache, docs);
  const batch = missing.slice(0, Math.max(0, limit));
  if (batch.length) {
    const generation = cache.generation;
    const vecs = await embedder.embed(batch.map(passageText), signal, 'passage');
    if (vecs.length !== batch.length) throw new Error('The embedder returned the wrong number of vectors.');
    // The cache was cleared while the batch was away (the model was removed): these vectors are for a model that is gone. Drop them.
    if (cache.generation !== generation) return out;
    batch.forEach((m, i) => { cache.set(embedder.id, passageText(m), vecs[i]!); out.set(m.id, vecs[i]!); });
    cache.save();
  }
  return out;
}
