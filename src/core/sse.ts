/**
 * Writing one event to a server-sent-events stream with backpressure. A reader that stops reading (a frozen or hidden renderer)
 * must not make the core buffer without bound: message deltas are dropped while the socket is not draining, and a stream with
 * more than SSE_MAX_BUFFER bytes queued is destroyed (the client reconnects and refreshes, as it does after any drop).
 */
import type { LegionEvent } from '../shared/types.js';

export const SSE_MAX_BUFFER = 4_000_000;

export interface SseSink { write(chunk: string): boolean; destroy(error?: Error): unknown; writableNeedDrain?: boolean; writableLength?: number }

export function pushSse(res: SseSink, ev: LegionEvent): 'sent' | 'dropped' | 'destroyed' {
  if ((res.writableLength ?? 0) > SSE_MAX_BUFFER) { res.destroy(); return 'destroyed'; }
  // transient events: the next one replaces this one, so a slow client loses nothing it needs
  if (res.writableNeedDrain && (ev.type === 'message.delta' || ev.type === 'task.progress')) return 'dropped';
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
  return 'sent';
}
