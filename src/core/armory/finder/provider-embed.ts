/**
 * The skill finder's provider embedder: an Embedder that asks a model provider you configured for embeddings, through the same
 * client as every provider call (providerRequest: your saved key, the address you set, no redirects, size and time limits).
 *
 * It sends the text of your message, and the text of your skills (name, description, when to use), to that provider. Only the 'provider'
 * ranker uses it, and it is off unless you pick that ranker. A failure rejects, and the finder ranks that turn by keywords alone.
 */
import { providerRequest } from '../../providers/http.js';
import type { ProviderTarget } from '../../providers/http.js';
import { PROVIDER_EMBED_BACKOFF_MS } from './defaults.js';
import type { Embedder } from './embed.js';

type Request = typeof providerRequest;

export interface ProviderEmbedOpts {
  target: ProviderTarget;
  providerId: string;
  /** The embedding model id the provider offers (providerModel in the finder settings). */
  model: string;
  /** Tests pass a fake. */
  request?: Request;
  /** The clock for the back-off, in ms. Tests pass a fake. */
  now?: () => number;
  /** One line when a provider and model go into back-off. */
  log?: (m: string) => void;
  /** Default PROVIDER_EMBED_BACKOFF_MS. */
  backoffMs?: number;
}

/**
 * When each provider and model may be asked again. It lives here, not in the embedder, because the finder makes a new embedder for each
 * turn. A failed or wrong answer closes the door for the back-off: no query, and no passage batch, goes out until it is over. So a provider
 * that answers wrongly sees at most one batch of passages in each back-off period, not one per turn.
 */
const closedUntil = new Map<string, number>();
/** Opens every door again. For tests. */
export function resetProviderEmbedBackoff(): void { closedUntil.clear(); }

const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function createProviderEmbedder(o: ProviderEmbedOpts): Embedder {
  const request = o.request ?? providerRequest;
  const now = o.now ?? Date.now;
  const id = `provider:${o.providerId}:${o.model}`;
  const embedOnce: Embedder['embed'] = async (texts, signal) => {
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
  };
  return {
    id,
    async embed(texts, signal, kind) {
      if (texts.length === 0) return [];
      if (now() < (closedUntil.get(id) ?? 0)) throw new Error('The provider failed a moment ago; embeddings are not asked for again yet.');
      try {
        return await embedOnce(texts, signal, kind);
      } catch (e) {
        // A cancelled call is the caller's choice, not the provider's fault.
        if (!signal.aborted) {
          closedUntil.set(id, now() + (o.backoffMs ?? PROVIDER_EMBED_BACKOFF_MS));
          try { o.log?.('finder: the provider embeddings failed; they will not be asked for again for a while'); } catch { /* a log failure is not an embedding failure */ }
        }
        throw e;
      }
    },
  };
}
