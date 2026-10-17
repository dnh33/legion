/**
 * The skill finder's provider embedder: an Embedder that asks a model provider you configured for embeddings, through the same
 * client as every provider call (providerRequest: your saved key, the address you set, no redirects, size and time limits).
 *
 * It sends the text of your message, and the text of your skills (name, description, when to use), to that provider. Only the 'provider'
 * ranker uses it, and it is off unless you pick that ranker. A failure rejects, and the finder ranks that turn by keywords alone.
 */
import { providerRequest } from '../../providers/http.js';
import type { ProviderTarget } from '../../providers/http.js';
import type { Embedder } from './embed.js';

type Request = typeof providerRequest;

export interface ProviderEmbedOpts {
  target: ProviderTarget;
  providerId: string;
  /** The embedding model id the provider offers (providerModel in the finder settings). */
  model: string;
  /** Tests pass a fake. */
  request?: Request;
}

const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function createProviderEmbedder(o: ProviderEmbedOpts): Embedder {
  const request = o.request ?? providerRequest;
  return {
    id: `provider:${o.providerId}:${o.model}`,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const res = await request(o.target, '/embeddings', {
        method: 'POST', body: { model: o.model, input: texts }, accept: 'json', signal,
        limits: { headerMs: 10_000, totalMs: 30_000, idleMs: 10_000 },
      });
      if (res.kind !== 'json') throw new Error('The provider answered with a stream where embeddings were expected.');
      const data = (res.json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data) || data.length !== texts.length) throw new Error('The provider sent the wrong number of embeddings.');
      // The answer may carry an index per item; use it when every item has one, else keep the order.
      const items = data as { embedding?: unknown; index?: unknown }[];
      const ordered = items.every((d) => typeof d?.index === 'number') ? [...items].sort((a, b) => (a.index as number) - (b.index as number)) : items;
      let dim = 0;
      return ordered.map((d) => {
        if (!isNumbers(d?.embedding)) throw new Error('The provider sent an embedding Legion could not read.');
        if (dim && d.embedding.length !== dim) throw new Error('The provider sent embeddings of different sizes.');
        dim = d.embedding.length;
        const norm = Math.hypot(...d.embedding) || 1;
        return Float32Array.from(d.embedding, (x) => x / norm);
      });
    },
  };
}
