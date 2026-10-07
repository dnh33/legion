/**
 * Stream wrappers (plan-logging.md): every chunk written to stdout or stderr goes through the log redactor first, so a
 * stray console.log, a Node warning or a crash trace is masked too. Exported for the core entry point; PR 1 does not
 * import it anywhere.
 *
 * Limits: a secret split across two chunks is not matched (each chunk is redacted on its own); a native crash (V8 fatal
 * error, OOM) writes below these wrappers and is not masked.
 */
import { redact } from './redact.js';

type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;
export interface WritableLike { write: (...args: never[]) => boolean }

const WRAPPED = Symbol.for('legion.log.streamWrapped');

/** Redacts one chunk. Text and byte chunks both become redacted text. */
export function redactChunk(chunk: unknown, _encoding?: unknown): unknown {
  if (typeof chunk === 'string') return redact(chunk);
  if (chunk instanceof Uint8Array) {
    // A Buffer is bytes: the encoding argument describes strings, so it is ignored here (write(buf, 'hex') is legal).
    return redact(Buffer.from(chunk).toString('utf8'));
  }
  return chunk;
}

/**
 * Wraps `write` on process.stdout and process.stderr (or the given streams). Idempotent per stream. Returns a function
 * that restores the original writes.
 */
export function installStreamWrappers(streams: WritableLike[] = [process.stdout, process.stderr]): () => void {
  const restores: Array<() => void> = [];
  for (const s of streams) {
    const holder = s as unknown as Record<symbol, unknown> & { write: WriteFn };
    if (holder[WRAPPED]) continue;
    const original = holder.write;
    const wrapped: WriteFn = function (this: unknown, chunk, encoding, cb) {
      const redacted = redactChunk(chunk, encoding);
      // A byte chunk was decoded to text, so its encoding argument no longer applies.
      if (redacted !== chunk && typeof chunk !== 'string') {
        return original.call(s, redacted, typeof encoding === 'function' ? encoding : cb);
      }
      return original.call(s, redacted, encoding, cb);
    };
    holder.write = wrapped;
    holder[WRAPPED] = true;
    restores.push(() => { holder.write = original; delete holder[WRAPPED]; });
  }
  return () => { for (const r of restores) r(); };
}
