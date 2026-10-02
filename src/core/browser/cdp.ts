/**
 * Legion's CDP client: a WebSocket to 127.0.0.1 ONLY (the one file in the browser tool that opens a WebSocket). The address is checked before the
 * connect, only a fixed list of CDP method names can be sent, every command has a timeout, and a message bigger than the cap closes the socket.
 * Limit: the browser's CDP port has no password; any program on this computer can also connect to it while a run is open (plan section 6).
 */
import { BROWSER_LIMITS } from '../../shared/browser.js';

/** The ONLY CDP methods Legion sends. No download, upload, file chooser, cookie, emulation or browser-level command is on the list. */
export const CDP_METHODS: ReadonlySet<string> = new Set([
  'Target.createTarget', 'Target.attachToTarget', 'Target.closeTarget', 'Target.getTargets', 'Target.setDiscoverTargets',
  'Page.enable', 'Page.navigate', 'Runtime.evaluate', 'Network.enable', 'Browser.setDownloadBehavior', 'Fetch.enable', 'Fetch.disable', 'Fetch.continueRequest', 'Fetch.failRequest',
]);

export interface CdpEvent { method: string; params: any; sessionId?: string }
export interface CdpPort {
  send(method: string, params?: Record<string, unknown>, opts?: { sessionId?: string; timeoutMs?: number }): Promise<any>;
  onEvent(fn: (e: CdpEvent) => void): () => void;
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export class CdpError extends Error {
  constructor(message: string, public readonly code?: number) { super(message); this.name = 'CdpError'; }
}

/** Only ws://127.0.0.1:<port>[/path]. Not "localhost" (it may resolve elsewhere), not an IPv6 literal, not another host. */
export const isLoopbackWsUrl = (u: string): boolean => !u.includes('..') && /^ws:\/\/127\.0\.0\.1:[1-9]\d{1,4}(\/[A-Za-z0-9_\-./]*)?$/.test(u) && Number(/:(\d+)/.exec(u.slice(5))![1]) <= 65535;

export interface ConnectOptions { maxMessageBytes?: number; connectTimeoutMs?: number; defaultTimeoutMs?: number }

export function connectCdp(url: string, o: ConnectOptions = {}): Promise<CdpPort> {
  if (!isLoopbackWsUrl(url)) return Promise.reject(new CdpError('The browser address must be ws://127.0.0.1:<port>; Legion talks to a local browser only.'));
  const maxBytes = o.maxMessageBytes ?? BROWSER_LIMITS.cdpMessageBytes;
  const defTimeout = o.defaultTimeoutMs ?? BROWSER_LIMITS.cdpCommandMs;
  return new Promise<CdpPort>((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { reject(new CdpError(`Could not open the browser connection: ${e instanceof Error ? e.message : String(e)}`)); return; }
    let nextId = 1;
    let closed = false;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Set<(e: CdpEvent) => void>();
    const closers: Array<() => void> = [];
    const failAll = (msg: string) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new CdpError(msg)); } pending.clear(); };
    const shut = (msg: string) => {
      if (closed) return;
      closed = true;
      failAll(msg);
      try { ws.close(); } catch { /* already closed */ }
      for (const c of closers) { try { c(); } catch { /* advisory */ } }
    };
    const port: CdpPort = {
      get closed() { return closed; },
      send(method, params = {}, opts = {}) {
        if (!CDP_METHODS.has(method)) return Promise.reject(new CdpError(`Legion does not send the browser command ${method}.`));
        if (closed) return Promise.reject(new CdpError('The browser connection is closed.'));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new CdpError(`The browser did not answer ${method} in time.`)); }, opts.timeoutMs ?? defTimeout);
          pending.set(id, { resolve: res, reject: rej, timer });
          try { ws.send(JSON.stringify({ id, method, params, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) })); }
          catch (e) { clearTimeout(timer); pending.delete(id); rej(new CdpError(`Could not send ${method}: ${e instanceof Error ? e.message : String(e)}`)); }
        });
      },
      onEvent(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      onClose(fn) { closers.push(fn); },
      close() { shut('The browser connection was closed.'); },
    };
    const connectTimer = setTimeout(() => { shut('connect timeout'); reject(new CdpError('The browser did not accept a connection in time.')); }, o.connectTimeoutMs ?? 2000);
    ws.addEventListener('open', () => { clearTimeout(connectTimer); resolve(port); });
    ws.addEventListener('error', () => { if (!closed) { clearTimeout(connectTimer); shut('The browser connection was closed after an error.'); reject(new CdpError('Could not connect to the browser.')); } });
    ws.addEventListener('close', () => { clearTimeout(connectTimer); shut('The browser closed the connection.'); reject(new CdpError('The browser closed the connection.')); });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data;
      if (typeof data !== 'string') { shut('The browser sent a binary message.'); return; }
      if (data.length > maxBytes) { shut('The browser sent a message over the size limit.'); return; }
      let m: any;
      try { m = JSON.parse(data); } catch { shut('The browser sent malformed data.'); return; }
      if (!m || typeof m !== 'object') { shut('The browser sent malformed data.'); return; }
      if (typeof m.id === 'number') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new CdpError(typeof m.error.message === 'string' ? m.error.message.slice(0, 300) : 'browser error', typeof m.error.code === 'number' ? m.error.code : undefined));
        else p.resolve(m.result ?? {});
      } else if (typeof m.method === 'string') {
        for (const l of [...listeners]) { try { l({ method: m.method, params: m.params ?? {}, ...(typeof m.sessionId === 'string' ? { sessionId: m.sessionId } : {}) }); } catch { /* a listener must not break the socket */ } }
      }
    });
  });
}
