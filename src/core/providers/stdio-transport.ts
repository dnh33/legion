/**
 * The stdio transport Legion uses for an MCP server the owner allowed for provider runs. It replaces the MCP SDK's own stdio transport
 * (which starts the child itself and stops only the one process): this one starts it through proc.ts with a scrubbed environment, drops
 * the child's stderr, and on close stops the whole process tree by PID. It starts no process itself.
 */
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { scrubbedEnv, spawnStdio, stdioMcpEnvAllow } from './proc.js';
import type { Platform, StdioProc } from './proc.js';

export interface StdioServerParams {
  command: string; args?: string[]; env?: Record<string, string>;
  /** Tests only. */
  source?: Record<string, string | undefined>; platform?: Platform;
}

export class ScrubbedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (m: JSONRPCMessage) => void;
  private proc?: StdioProc;
  private readonly buf = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });
  private closed = false;
  constructor(private readonly p: StdioServerParams) {}

  /** The pid of the server process (undefined before start). Exposed so tests and the run end can check the tree is gone. */
  get pid(): number | undefined { return this.proc?.pid; }

  start(): Promise<void> {
    if (this.proc) return Promise.reject(new Error('already started'));
    const platform = this.p.platform ?? process.platform;
    const env = scrubbedEnv(this.p.source ?? process.env, stdioMcpEnvAllow(platform), this.p.env ?? {}, platform);
    return new Promise<void>((resolve, reject) => {
      let proc: StdioProc;
      try { proc = spawnStdio(this.p.command, this.p.args ?? [], { env, platform }); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return; }
      this.proc = proc;
      let started = false;
      proc.stdout.on('data', (c: Buffer) => {
        try { this.buf.append(c); for (;;) { const m = this.buf.readMessage(); if (!m) break; this.onmessage?.(m); } } catch (e) { this.onerror?.(e instanceof Error ? e : new Error(String(e))); }
      });
      proc.stdin.on('error', (e) => this.onerror?.(e));
      void proc.exited.then((r) => {
        if (!started) { started = true; reject(new Error(r.error ?? `the server ended at once (exit ${r.code ?? r.signal})`)); }
        this.proc = undefined; this.closed = true; this.onclose?.();
      });
      // 'spawn' is not exposed by the wrapper: a live pid means the OS accepted the program
      setImmediate(() => { if (!started && proc.pid) { started = true; resolve(); } });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.proc || this.closed) { reject(new Error('the server is not running')); return; }
      if (this.proc.stdin.write(serializeMessage(message))) resolve(); else this.proc.stdin.once('drain', () => resolve());
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.buf.clear();
    if (proc) { try { proc.stdin.end(); } catch { /* ignore */ } await proc.kill(); }
    this.proc = undefined;
  }
}
