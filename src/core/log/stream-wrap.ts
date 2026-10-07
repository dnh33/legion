/**
 * Stream wrappers (plan-logging.md): every chunk written to stdout or stderr goes through the log redactor before it
 * reaches the stream, so a stray console.log, a Node warning or a crash trace is masked too.
 *
 * A secret can arrive split across two writes. Each stream therefore keeps a tail buffer: on every write the wrapper
 * redacts and emits everything up to the last newline of (tail + chunk) and holds the rest. An open private-key block
 * (BEGIN ... PRIVATE KEY without its END yet) is held whole, so its body lines are redacted together with the markers.
 * If the held rest grows past TAIL_CAP the held text is REDACTED FIRST, and only then split: all but the last TAIL_KEEP
 * characters are emitted and the redacted remainder is held, so a token can never be cut into two raw pieces. A held tail
 * is flushed through the ORIGINAL write after FLUSH_MS (an unref'd timer, so it never keeps the process alive; an open
 * key block waits for its END or the cap) and synchronously when the process exits. write() and end() are both wrapped.
 * The log sink writes with fs file descriptors, never through these streams.
 *
 * Limits: a secret whose first characters were already emitted by a cap-forced cut (a line over TAIL_CAP characters with
 * no newline, the token arriving later than the cut) can leave its tail unmasked; a native crash (V8 fatal error, OOM)
 * writes below these wrappers and is not masked.
 */
import { StringDecoder } from 'node:string_decoder';
import { redact } from './redact.js';

type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;
type EndFn = (chunk?: unknown, encoding?: unknown, cb?: unknown) => unknown;
export interface WritableLike { write: (...args: never[]) => boolean }

export const TAIL_CAP = 8 * 1024;
export const TAIL_KEEP = 256;
export const FLUSH_MS = 50;

const WRAPPED = Symbol.for('legion.log.streamWrapped');
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Index of a private-key block that has begun and not ended in `text`, or -1. */
export function openKeyBlock(text: string): number {
  let at = -1;
  for (const m of text.matchAll(PEM_BEGIN)) at = m.index ?? -1;
  if (at < 0) return -1;
  return text.indexOf('-----END ', at) >= 0 ? -1 : at;
}

export interface WrapOptions {
  flushMs?: number;
  /** Register the synchronous flush on process exit. Default true; a test passes false. */
  onExit?: boolean;
}

/**
 * Wraps `write` and `end` on process.stdout and process.stderr (or the given streams). Idempotent per stream. Returns a
 * function that flushes every tail and restores the originals.
 */
export function installStreamWrappers(streams: WritableLike[] = [process.stdout, process.stderr], opts: WrapOptions = {}): () => void {
  const flushMs = opts.flushMs ?? FLUSH_MS;
  const undo: Array<() => void> = [];
  const flushers: Array<() => void> = [];
  for (const s of streams) {
    const holder = s as unknown as Record<symbol, unknown> & { write: WriteFn; end?: EndFn };
    if (holder[WRAPPED]) continue;
    const original = holder.write;
    const originalEnd = holder.end;
    const decoder = new StringDecoder('utf8');
    let tail = '';
    let timer: NodeJS.Timeout | null = null;

    const flush = (force: boolean): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!tail) return;
      if (!force && openKeyBlock(tail) >= 0) { arm(); return; }
      const out = redact(tail);
      tail = '';
      try { original.call(s, out); } catch { /* a closed stream: nothing to do */ }
    };
    flushers.push(() => flush(true));
    function arm(): void {
      if (timer || !tail) return;
      timer = setTimeout(() => flush(false), flushMs);
      timer.unref();
    }

    /** Takes text into the tail; returns what is ready to write (already redacted). */
    const take = (text: string): string => {
      const all = tail + text;
      let cut = all.lastIndexOf('\n') + 1;
      const key = openKeyBlock(all);
      if (key >= 0) cut = Math.min(cut, all.lastIndexOf('\n', key) + 1);
      let out = redact(all.slice(0, cut));
      tail = all.slice(cut);
      if (tail.length > TAIL_CAP) {
        const masked = redact(tail); // redact the whole held text BEFORE any cut
        const keep = Math.min(TAIL_KEEP, masked.length);
        out += masked.slice(0, masked.length - keep);
        tail = masked.slice(masked.length - keep);
      }
      if (timer && !tail) { clearTimeout(timer); timer = null; }
      arm();
      return out;
    };
    const decode = (chunk: unknown, encoding: unknown): string | undefined => {
      if (typeof chunk === 'string') {
        // a string in 'hex' or 'base64' is not the text it looks like: decode it to what the stream would have written
        if (typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8' && Buffer.isEncoding(encoding)) return decoder.write(Buffer.from(chunk, encoding));
        return chunk;
      }
      if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk)); // a Buffer is bytes: its encoding argument is ignored
      return undefined;
    };

    const wrapped: WriteFn = function (this: unknown, chunk, encoding, cb) {
      const done = typeof encoding === 'function' ? encoding : cb;
      const text = decode(chunk, encoding);
      if (text === undefined) return original.call(s, chunk, encoding, cb); // not text or bytes: let the stream raise its own error
      const out = take(text);
      if (!out) { if (typeof done === 'function') process.nextTick(done as () => void); return true; }
      return original.call(s, out, typeof done === 'function' ? done : undefined);
    };
    holder.write = wrapped;
    holder[WRAPPED] = true;
    let wrappedEnd: EndFn | undefined;
    if (typeof originalEnd === 'function') {
      wrappedEnd = function (this: unknown, chunk, encoding, cb) {
        const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
        const text = typeof chunk === 'function' ? undefined : decode(chunk, encoding);
        if (text) { const out = take(text); if (out) original.call(s, out); }
        flush(true);
        return originalEnd.call(s, typeof done === 'function' ? done : undefined);
      };
      holder.end = wrappedEnd;
    }
    undo.push(() => { holder.write = original; if (originalEnd) holder.end = originalEnd; delete holder[WRAPPED]; });
  }
  const onExit = (): void => { for (const f of flushers) f(); };
  if (opts.onExit !== false) process.on('exit', onExit);
  return () => {
    if (opts.onExit !== false) process.off('exit', onExit);
    onExit();
    for (const u of undo) u();
  };
}
