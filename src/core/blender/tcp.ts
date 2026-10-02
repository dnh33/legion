/**
 * Loopback TCP helpers for the Blender add-on socket: a quick "is anything listening" probe, and one JSON request per connection.
 * The host is checked to be loopback here too, on top of the config normalizer: a script must never leave this machine.
 */
import net from 'node:net';
import { isLoopbackHost } from '../../shared/blender.js';

/** The peer did not answer in time. The request may still be running on the other side. */
export class TimedOutError extends Error { readonly timedOut = true; }

function assertLoopback(host: string): void {
  if (!isLoopbackHost(host)) throw new Error(`Refusing to connect to ${host}: the Blender bridge only talks to this computer (127.0.0.1)`);
}

/** True when something accepts a TCP connection on host:port within timeoutMs. Never throws. */
export function tcpProbe(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isLoopbackHost(host)) { resolve(false); return; }
    const s = net.connect({ host, port });
    let done = false;
    const end = (v: boolean) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => end(false), timeoutMs);
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

/**
 * Sends one JSON object and waits for one JSON object back. The community add-on does not frame messages: the reply is complete as soon as
 * the bytes received so far parse as JSON, so that is how this reads it (a trailing newline is tolerated). `maxBytes` bounds memory.
 */
export function jsonRequest(host: string, port: number, payload: unknown, opts: { timeoutMs: number; maxBytes?: number }): Promise<unknown> {
  try { assertLoopback(host); } catch (e) { return Promise.reject(e); }
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    let buf = '';
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new TimedOutError(`Blender did not answer within ${Math.round(opts.timeoutMs / 1000)}s. Whatever was sent may STILL BE RUNNING in Blender; the connection was dropped but nothing was cancelled`)), opts.timeoutMs);
    s.setEncoding('utf8');
    s.once('connect', () => { s.write(JSON.stringify(payload)); });
    s.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > maxBytes) { finish(new Error('Blender sent a reply larger than the limit')); return; }
      const text = buf.trim();
      if (!text) return;
      try { finish(null, JSON.parse(text)); } catch { /* incomplete: wait for more */ }
    });
    s.once('error', (e: NodeJS.ErrnoException) => {
      finish(new Error(e.code === 'ECONNREFUSED' ? `Nothing is listening on ${host}:${port}. Start the add-on's server in Blender (3D View sidebar, BlenderMCP tab) or press Launch in Legion's Blender settings.` : `Blender socket error: ${e.message}`));
    });
    s.once('close', () => { if (!done) finish(new Error(buf.trim() ? 'Blender closed the connection in the middle of its reply' : 'Blender closed the connection without a reply')); });
  });
}
