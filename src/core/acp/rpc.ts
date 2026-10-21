/**
 * A small line-delimited JSON-RPC 2.0 peer, the wire layer under the agent host (ACP over stdio).
 * One message per line, UTF-8, no raw newline inside a message (ACP transports page; JSON-RPC 2.0 spec).
 * Pure: it never spawns anything. The caller supplies an `RpcIo`; `lineSplitter` turns byte chunks into lines for it.
 */
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

export type RpcIo = {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
};

export type RpcOptions = {
  /** Default time a request may wait for its response. 0 or Infinity means no limit. */
  requestTimeoutMs?: number;
  /** Receives every line that is not a usable JSON-RPC message (a banner, a log line, a broken fragment). */
  onNoise?: (line: string) => void;
};

/** The far side answered with a JSON-RPC error. Handlers may also throw it to pick the code they reply with. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}
export class RpcTimeout extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} got no answer within ${timeoutMs} ms`);
    this.name = 'RpcTimeout';
  }
}
export class RpcClosed extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RpcClosed';
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const DEFAULT_TIMEOUT_MS = 30_000;

// Envelope shape only. Params and results stay `unknown`: each caller validates its own payloads.
const Envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

/** Feed byte or text chunks in, get whole lines out. Handles lines split over chunks, CRLF, blank lines and split UTF-8 characters. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string | Uint8Array) => void {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  return (chunk) => {
    tail += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let nl = tail.indexOf('\n');
    while (nl !== -1) {
      const line = tail.slice(0, nl).replace(/\r$/, '');
      tail = tail.slice(nl + 1);
      if (line.trim() !== '') onLine(line);
      nl = tail.indexOf('\n');
    }
  };
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | undefined };

export class RpcPeer {
  private nextId = 1;
  private closed: RpcClosed | undefined;
  private readonly pending = new Map<string | number, Pending>();
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private readonly defaultTimeoutMs: number;

  constructor(private readonly io: RpcIo, private readonly opts: RpcOptions = {}) {
    this.defaultTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    io.onLine((line) => this.receive(line));
    io.onClose(() => this.close('the connection closed'));
  }

  request<T>(method: string, params: unknown, timeoutMs: number = this.defaultTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => this.settle(id)?.reject(new RpcTimeout(method, timeoutMs)), timeoutMs)
        : undefined;
      // Registered before the write: an io may answer synchronously.
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.io.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        this.settle(id)?.reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  onRequest(method: string, h: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, h);
  }

  onNotification(method: string, h: (params: unknown) => void): void {
    this.notificationHandlers.set(method, h);
  }

  /** Reject every waiting request with `reason`. Safe to call twice. Later requests reject at once. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = new RpcClosed(reason);
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(this.closed);
  }

  private settle(id: string | number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    return p;
  }

  private send(msg: object): void {
    if (this.closed) return;
    try {
      this.io.write(JSON.stringify(msg)); // JSON.stringify escapes newlines inside strings, so this is one line.
    } catch {
      // The far side is gone; the close event rejects whatever is still waiting.
    }
  }

  private receive(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { this.opts.onNoise?.(line); return; }
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) { this.opts.onNoise?.(line); return; }
    const m = parsed.data;
    if (m.method !== undefined) {
      if (m.id === undefined || m.id === null) this.onNotificationMessage(m.method, m.params);
      else void this.onRequestMessage(m.id, m.method, m.params);
    } else if (m.id !== undefined && m.id !== null && (m.error !== undefined || 'result' in m)) {
      const p = this.settle(m.id); // An unknown id is a late answer to a request that already timed out.
      if (!p) return;
      if (m.error) p.reject(new RpcError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
    } else {
      this.opts.onNoise?.(line);
    }
  }

  private async onRequestMessage(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (e) {
      const error = e instanceof RpcError
        ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) }
        : { code: INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) };
      this.send({ jsonrpc: '2.0', id, error });
    }
  }

  private onNotificationMessage(method: string, params: unknown): void {
    try {
      this.notificationHandlers.get(method)?.(params); // No handler: ignore, as JSON-RPC says for notifications.
    } catch (e) {
      this.opts.onNoise?.(`handler for notification ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
