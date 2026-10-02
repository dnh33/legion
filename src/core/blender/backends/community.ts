/**
 * Community add-on backend (ahujasid blender-mcp, MIT): talks to the add-on's JSON socket directly, no MCP server in between.
 * Protocol (UNVERIFIED against the current upstream; command names are config, see advanced.community.commands):
 *   request  {"type": "<command>", "params": {...}}
 *   response {"status": "success", "result": ...} or {"status": "error", "message": "..."}
 */
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BlenderConfig } from '../../../shared/blender.js';
import type { BackendResult, BlenderBackend } from '../backend.js';
import { capText, fail, ok } from '../backend.js';
import { jsonRequest, tcpProbe } from '../tcp.js';

export interface CommunityDeps {
  /** Sends one request; the default is the loopback socket. Tests pass a fake. */
  request?: (host: string, port: number, payload: unknown, opts: { timeoutMs: number }) => Promise<unknown>;
  probe?: (host: string, port: number) => Promise<boolean>;
  /** Folder Blender can write a screenshot into (same machine). */
  tempDir?: string;
  readFile?: (path: string) => Promise<Buffer>;
  removeFile?: (path: string) => Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class CommunityBackend implements BlenderBackend {
  readonly kind = 'community' as const;
  private connected = false;
  private readonly req: NonNullable<CommunityDeps['request']>;
  private readonly probe: NonNullable<CommunityDeps['probe']>;
  private readonly temp: string;
  private readonly read: NonNullable<CommunityDeps['readFile']>;
  private readonly remove: NonNullable<CommunityDeps['removeFile']>;

  constructor(private readonly cfg: Pick<BlenderConfig, 'host' | 'port' | 'advanced'>, deps: CommunityDeps = {}) {
    this.req = deps.request ?? jsonRequest;
    this.probe = deps.probe ?? tcpProbe;
    this.temp = deps.tempDir ?? tmpdir();
    this.read = deps.readFile ?? ((p) => readFile(p));
    this.remove = deps.removeFile ?? ((p) => rm(p, { force: true }));
  }

  private get cmd() { return this.cfg.advanced.community.commands; }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!(await this.probe(this.cfg.host, this.cfg.port))) {
      throw new Error(`Cannot reach the Blender add-on at ${this.cfg.host}:${this.cfg.port}. Open Blender and start the add-on's server (3D View sidebar, BlenderMCP tab), or press Launch in Legion's Blender settings.`);
    }
    this.connected = true;
  }
  isConnected(): boolean { return this.connected; }
  async close(): Promise<void> { this.connected = false; }

  private async call(type: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; value: unknown; message: string }> {
    let raw: unknown;
    try { raw = await this.req(this.cfg.host, this.cfg.port, { type, params }, { timeoutMs }); } catch (e) {
      this.connected = false;
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (!isObj(raw)) return { ok: false, value: raw, message: 'Blender sent a reply Legion does not understand' };
    if (raw.status === 'error') return { ok: false, value: undefined, message: typeof raw.message === 'string' ? raw.message : 'Blender reported an error' };
    return { ok: true, value: 'result' in raw ? raw.result : raw, message: '' };
  }

  private asText(v: unknown): string {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2) ?? ''; } catch { return String(v); }
  }

  async exec(script: string, opts: { timeoutMs?: number } = {}): Promise<BackendResult> {
    await this.connect();
    const r = await this.call(this.cmd.exec, { code: script }, opts.timeoutMs ?? 120_000);
    if (!r.ok) return fail(capText(r.message));
    // upstream answers {"executed": true, "result": "<captured stdout>"}
    const v = r.value;
    return ok(capText(isObj(v) && typeof v.result === 'string' ? v.result : this.asText(v)));
  }

  async inspect(o: { object?: string }): Promise<BackendResult> {
    await this.connect();
    const r = o.object
      ? await this.call(this.cmd.objectInfo, { name: o.object }, 30_000)
      : await this.call(this.cmd.inspect, {}, 30_000);
    return r.ok ? ok(capText(this.asText(r.value))) : fail(capText(r.message));
  }

  async screenshot(o: { maxSize?: number }): Promise<BackendResult> {
    await this.connect();
    const file = join(this.temp, `legion-blender-shot-${randomBytes(6).toString('hex')}.png`);
    try {
      const r = await this.call(this.cmd.screenshot, { max_size: Math.min(2000, Math.max(64, o.maxSize ?? 800)), filepath: file, format: 'png' }, 45_000);
      if (!r.ok) return fail(capText(r.message));
      let data: Buffer;
      try { data = await this.read(file); } catch { return fail('Blender said it took a screenshot but the file could not be read'); }
      if (!data.length) return fail('The screenshot was empty');
      return ok(isObj(r.value) && typeof r.value.width === 'number' ? `viewport ${r.value.width}x${r.value.height}` : 'viewport screenshot', [{ mime: 'image/png', data: data.toString('base64') }]);
    } finally { await this.remove(file).catch(() => undefined); }
  }

  async docs(_query: string): Promise<BackendResult> {
    return fail('The community add-on has no documentation search. Use the official Blender Lab MCP backend (Blender 5.1+) for blender_docs.');
  }
}
