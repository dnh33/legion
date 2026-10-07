/**
 * Stream wrappers (plan-logging.md): every chunk written to stdout or stderr goes through the log redactor before it
 * reaches the stream, so a stray console.log, a Node warning or a crash trace is masked too.
 *
 * A secret can arrive split across two writes. Each stream therefore keeps a tail buffer: on every write the wrapper
 * redacts and emits everything up to the last newline of (tail + chunk) and holds the rest. If the held rest grows past
 * TAIL_CAP it emits all but the last TAIL_KEEP characters (still redacted) and holds those. A held tail is flushed
 * through the ORIGINAL write after FLUSH_MS (an unref'd timer, so it never keeps the process alive) and synchronously
 * when the process exits. The log sink writes with fs file descriptors, never through these streams.
 *
 * Limits: a secret split exactly at a cap-forced cut (a line over TAIL_CAP characters with no newline) can leave a short
 * prefix unmasked; a native crash (V8 fatal error, OOM) writes below these wrappers and is not masked.
 */
import { StringDecoder } from 'node:string_decoder';
import { redact } from './redact.js';

type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;
export interface WritableLike { write: (...args: never[]) => boolean }

export const TAIL_CAP = 8 * 1024;
export const TAIL_KEEP = 256;
export const FLUSH_MS = 50;

const WRAPPED = Symbol.for('legion.log.streamWrapped');

export interface WrapOptions {
  flushMs?: number;
  /** Register the synchronous flush on process exit. Default true; a test passes false. */
  onExit?: boolean;
}

/**
 * Wraps `write` on process.stdout and process.stderr (or the given streams). Idempotent per stream. Returns a function
 * that flushes every tail and restores the original writes.
 */
export function installStreamWrappers(streams: WritableLike[] = [process.stdout, process.stderr], opts: WrapOptions = {}): () => void {
  const flushMs = opts.flushMs ?? FLUSH_MS;
  const undo: Array<() => void> = [];
  const flushers: Array<() => void> = [];
  for (const s of streams) {
    const holder = s as unknown as Record<symbol, unknown> & { write: WriteFn };
    if (holder[WRAPPED]) continue;
    const original = holder.write;
    const decoder = new StringDecoder('utf8');
    let tail = '';
    let timer: NodeJS.Timeout | null = null;

    const flush = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!tail) return;
      const out = redact(tail);
      tail = '';
      try { original.call(s, out); } catch { /* a closed stream: nothing to do */ }
    };
    flushers.push(flush);
    const arm = (): void => {
      if (timer || !tail) return;
      timer = setTimeout(flush, flushMs);
      timer.unref();
    };

    const wrapped: WriteFn = function (this: unknown, chunk, encoding, cb) {
      const done = typeof encoding === 'function' ? encoding : cb;
      let text: string;
      // A Buffer is bytes: the encoding argument describes strings, so it is ignored for them (write(buf, 'hex') is legal).
      if (typeof chunk === 'string') text = chunk;
      else if (chunk instanceof Uint8Array) text = decoder.write(Buffer.from(chunk));
      else return original.call(s, chunk, encoding, cb); // not text or bytes: let the stream raise its own error
      const all = tail + text;
      const nl = all.lastIndexOf('\n');
      let emit = '';
      if (nl >= 0) { emit = all.slice(0, nl + 1); tail = all.slice(nl + 1); } else tail = all;
      if (tail.length > TAIL_CAP) { emit += tail.slice(0, tail.length - TAIL_KEEP); tail = tail.slice(tail.length - TAIL_KEEP); }
      if (timer && !tail) { clearTimeout(timer); timer = null; }
      arm();
      if (!emit) { if (typeof done === 'function') process.nextTick(done as () => void); return true; }
      return original.call(s, redact(emit), typeof done === 'function' ? done : undefined);
    };
    holder.write = wrapped;
    holder[WRAPPED] = true;
    undo.push(() => { holder.write = original; delete holder[WRAPPED]; });
  }
  const onExit = (): void => { for (const f of flushers) f(); };
  if (opts.onExit !== false) process.on('exit', onExit);
  return () => {
    if (opts.onExit !== false) process.off('exit', onExit);
    onExit();
    for (const u of undo) u();
  };
}
