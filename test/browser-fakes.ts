/**
 * Fakes for the browser tool tests: a fake CDP server (a hand-written WebSocket on 127.0.0.1 with a tiny fake DOM run through node:vm), a fake
 * DNS resolver and a fake download. Nothing here contacts the internet, the real Lightpanda, or any fixed local port.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import vm from 'node:vm';

export interface FakeElement {
  text?: string;
  href?: string;
  type?: string;
  name?: string;
  /** Clicking navigates here (like a link). */
  goes?: string;
  /** A button that navigates by script (no href). */
  clickGoes?: string;
  /** The element sits in a form that sends here. */
  formAction?: string;
}
export interface FakePage {
  title?: string;
  text?: string;
  links?: Array<{ text: string; href: string }>;
  redirectTo?: string;
  /** Subresource requests the page makes while loading. */
  subrequests?: string[];
  elements?: Record<string, FakeElement>;
  noLoadEvent?: boolean;
}

export interface FakeCdpOptions {
  pages: Record<string, FakePage>;
  /** Fetch.enable answers with an error (the build has no interception). */
  noFetch?: boolean;
  /** Target.createTarget opens an extra tab on every navigation (a popup). */
  popup?: boolean;
  /** A build that sends no Network or navigation events: only the final address can show where the page ended up. */
  quiet?: boolean;
  /** Every command is answered with this CDP error. */
  errorFor?: Record<string, string>;
  /** Replies with a message of this many bytes to Runtime.evaluate. */
  bigReply?: number;
  /** Replies with broken JSON to this method. */
  garbleFor?: string;
  /** Never replies to this method. */
  silentFor?: string;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text: string): Buffer {
  const p = Buffer.from(text, 'utf8');
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })();
  return Buffer.concat([head, p]);
}

function* readFrames(state: { buf: Buffer }): Generator<{ op: number; data: Buffer }> {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const op = b[0]! & 15;
    let len = b[1]! & 127;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = (b[1]! & 128) !== 0;
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    const mask = masked ? b.subarray(off, off + 4) : null;
    const data = Buffer.from(b.subarray(off + (masked ? 4 : 0), need));
    if (mask) for (let i = 0; i < data.length; i++) data[i]! ^= mask[i & 3]!;
    state.buf = b.subarray(need);
    yield { op, data };
  }
}

export interface FakeCdp {
  port: number;
  close(): Promise<void>;
  /** What the server saw. */
  sent: Array<{ method: string; params: any }>;
  connections: number;
  blocked: string[];
  state: { url: string; targets: number };
  setPages(p: Record<string, FakePage>): void;
}

export async function startFakeCdp(o: FakeCdpOptions, port = 0): Promise<FakeCdp> {
  let pages = o.pages;
  const sent: Array<{ method: string; params: any }> = [];
  const blocked: string[] = [];
  const state = { url: 'about:blank', targets: 0 };
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => { res.statusCode = 404; res.end(); });

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    sockets.add(socket); connections++;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const buf = { buf: Buffer.alloc(0) };
    let interception = false;
    const paused = new Map<string, () => void>();
    let reqN = 0;
    const send = (m: unknown) => { try { socket.write(frame(JSON.stringify(m))); } catch { /* closed */ } };
    const event = (method: string, params: unknown) => { if (o.quiet && /^(Network\.|Page\.frameNavigated)/.test(method)) return; send({ method, params, sessionId: 'S1' }); };
    const reply = (id: number, result: unknown) => send({ id, result });

    const dom = (): vm.Context => {
      const p = pages[state.url] ?? {};
      const els = p.elements ?? {};
      const mk = (sel: string, e: FakeElement) => ({
        innerText: e.text ?? '', textContent: e.text ?? '', href: e.href ?? '', type: e.type ?? '', name: e.name ?? '', id: '', value: '',
        form: e.formAction ? { action: e.formAction, requestSubmit: () => { void navigate(e.formAction!); } } : null, focus() { /* noop */ }, dispatchEvent() { return true; }, getAttribute() { return ''; },
        click: () => { const to = e.goes ?? e.clickGoes; if (to) void navigate(to); },
        closest: (s: string) => (s === 'a[href]' && e.href ? { href: e.goes ?? e.href } : null),
        _sel: sel,
      });
      return vm.createContext({
        location: { get href() { return state.url; } },
        document: {
          title: p.title ?? '',
          body: { innerText: p.text ?? '', textContent: p.text ?? '' },
          querySelector: (s: string) => (els[s] ? mk(s, els[s]!) : null),
          querySelectorAll: (s: string) => (s === 'a[href]' ? (p.links ?? []).map((l) => ({ textContent: l.text, href: l.href })) : []),
        },
        Event: class { constructor(public type: string) { /* noop */ } },
        JSON, Array, String,
      });
    };

    async function navigate(url: string): Promise<void> {
      let cur = url;
      for (let hop = 0; hop < 30; hop++) {
        state.url = cur;
        const page = pages[cur];
        event('Network.requestWillBeSent', { requestId: `r${++reqN}`, type: 'Document', request: { url: cur }, ...(hop > 0 ? { redirectResponse: { status: 302 } } : {}) });
        if (interception) {
          await new Promise<void>((resolve) => { const id = `p${reqN}`; paused.set(id, resolve); event('Fetch.requestPaused', { requestId: id, request: { url: cur }, resourceType: 'Document' }); });
        }
        if (!page?.redirectTo) break;
        cur = page.redirectTo;
        if (hop === 29) return;
      }
      const page = pages[cur] ?? {};
      for (const s of page.subrequests ?? []) {
        event('Network.requestWillBeSent', { requestId: `r${++reqN}`, type: 'Image', request: { url: s } });
        if (interception) await new Promise<void>((resolve) => { const id = `p${reqN}`; paused.set(id, resolve); event('Fetch.requestPaused', { requestId: id, request: { url: s }, resourceType: 'Image' }); });
      }
      if (o.popup) { state.targets++; send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: `X${state.targets}` } } }); }
      event('Page.frameNavigated', { frame: { id: 'F1', url: cur } });
      if (!page.noLoadEvent) event('Page.loadEventFired', { timestamp: 1 });
    }

    socket.on('data', (chunk: Buffer) => {
      buf.buf = Buffer.concat([buf.buf, chunk]);
      for (const f of readFrames(buf)) {
        if (f.op === 8) { socket.end(); return; }
        if (f.op !== 1) continue;
        const m = JSON.parse(f.data.toString('utf8')) as { id: number; method: string; params: any };
        sent.push({ method: m.method, params: m.params });
        if (o.silentFor === m.method) continue;
        if (o.garbleFor === m.method) { socket.write(frame('{not json')); continue; }
        const err = o.errorFor?.[m.method];
        if (err) { send({ id: m.id, error: { code: -32000, message: err } }); continue; }
        switch (m.method) {
          case 'Target.createTarget': state.targets++; reply(m.id, { targetId: 'T1' }); break;
          case 'Target.attachToTarget': reply(m.id, { sessionId: 'S1' }); break;
          case 'Target.getTargets': reply(m.id, { targetInfos: [] }); break;
          case 'Target.closeTarget': reply(m.id, { success: true }); break;
          case 'Fetch.enable': if (o.noFetch) send({ id: m.id, error: { code: -32601, message: 'Fetch.enable wasn\'t found' } }); else { interception = true; reply(m.id, {}); } break;
          case 'Fetch.continueRequest': { const r = paused.get(m.params.requestId); paused.delete(m.params.requestId); reply(m.id, {}); r?.(); break; }
          case 'Fetch.failRequest': { const r = paused.get(m.params.requestId); paused.delete(m.params.requestId); blocked.push(String(m.params.requestId)); reply(m.id, {}); r?.(); break; }
          case 'Page.navigate': {
            const url = String(m.params.url);
            if (url === 'about:blank') { state.url = url; reply(m.id, { frameId: 'F1' }); break; }
            reply(m.id, { frameId: 'F1' });
            void navigate(url);
            break;
          }
          case 'Runtime.evaluate': {
            try {
              const v = vm.runInContext(String(m.params.expression), dom(), { timeout: 1000 });
              const value = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
              if (o.bigReply) { reply(m.id, { result: { type: 'string', value: 'x'.repeat(o.bigReply) } }); break; }
              reply(m.id, { result: { type: typeof value, value } });
            } catch (e) { reply(m.id, { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: String(e) } } }); }
            break;
          }
          default: reply(m.id, {});
        }
      }
    });
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  return {
    port: actual, sent, blocked, state,
    get connections() { return connections; },
    setPages(p) { pages = p; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  } as FakeCdp;
}

/** A resolver from a table; an unknown host fails like a real lookup would. */
export const fakeResolver = (table: Record<string, string[]>) => async (host: string): Promise<string[]> => {
  const a = table[host.toLowerCase()];
  if (!a) throw new Error('ENOTFOUND');
  return a;
};
