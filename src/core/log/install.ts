/**
 * Side-effect module: installs the stream wrappers and the process-level error handlers when it is imported.
 * src/bin/legion-core.ts imports it FIRST, before any other module, so nothing the core loads can write to stdout or
 * stderr unredacted, and an early throw or rejection (before the logger exists) is printed through the redacted stream
 * instead of by Node's own printer (test/log-wiring.test.ts checks the import order and both early paths).
 *
 * Before the core hands over a logger (setFatalSink), a fatal error is written to stderr (redacted) and the process exits
 * with code 1, as Node would. After it, the error goes to the logger and the process stays up, as the core always did.
 * Importing it twice is harmless: a stream is wrapped once and the handlers are registered once.
 */
import { installStreamWrappers } from './stream-wrap.js';

installStreamWrappers();

type FatalSink = (event: string, error: unknown) => void;
let sink: FatalSink | undefined;

/** The core calls this once its logger exists: from then on a fatal error is logged and the process stays up. */
export function setFatalSink(fn: FatalSink): void { sink = fn; }

export function describeError(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

function onFatal(event: string, e: unknown): void {
  if (sink) { try { sink(event, e); return; } catch { /* fall through to the stream */ } }
  try { process.stderr.write(`[${new Date().toISOString()}] ${event} ${describeError(e)}\n`); } catch { /* nothing more to do */ }
  process.exit(1);
}

const KEY = Symbol.for('legion.log.fatalHandlers');
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[KEY]) {
  g[KEY] = true;
  process.on('uncaughtException', (e) => onFatal('process.uncaughtException', e));
  process.on('unhandledRejection', (e) => onFatal('process.unhandledRejection', e));
}
