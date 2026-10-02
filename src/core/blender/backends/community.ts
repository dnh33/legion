/**
 * Community add-on backend (ahujasid blender-mcp, MIT): talks to the add-on's JSON socket directly, no MCP server in between.
 * Protocol (command names are config, see advanced.community.commands; shape checked against the upstream addon.py):
 *   request  {"type": "<command>", "params": {...}}
 *   response {"status": "success", "result": ...} or {"status": "error", "message": "..."}
 *
 * THE KNOWN LIMIT, stated plainly: this add-on's socket has no password. Any program on this computer that can reach 127.0.0.1:<port> can
 * send it code while the add-on's server is running, and Legion's approval card does not stand in front of that. The upstream add-on has no
 * token to share, so Legion cannot add one from outside. What Legion does instead: it holds no standing connection (a connection exists only
 * while a call is running); before every code run it checks that the listener really is the expected add-on (an identity check, see
 * looksLikeAddon: a stand-in that answers with something else is refused); and the official stdio backend (Blender 5.1+) is preferred in
 * Auto mode. It does NOT stop a local program from using the socket itself. See docs/BLENDER.md and SECURITY.md.
 */
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BlenderConfig } from '../../../shared/blender.js';
import type { BackendResult, BlenderBackend } from '../backend.js';
import { capText, fail, ok } from '../backend.js';
import { jsonRequest, tcpProbe } from '../tcp.js';
import type { TimedOutError } from '../tcp.js';

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

/** The upstream get_scene_info answers {"name": ..., "object_count": N, "objects": [...], "materials_count": N}. Anything else is not the add-on we expect. */
export function looksLikeAddon(value: unknown): boolean {
  return isObj(value) && typeof value.object_count === 'number' && Array.isArray(value.objects);
}

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

  /** Checks that something accepts connections. A connection to the add-on lives only while a call is running (see lease). */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!(await this.probe(this.cfg.host, this.cfg.port))) {
      throw new Error(`Cannot reach the Blender add-on at ${this.cfg.host}:${this.cfg.port}. Open Blender and start the add-on's server (3D View sidebar, BlenderMCP tab), or press Launch in Legion's Blender settings.`);
    }
    this.connected = true;
  }
  /** True only while a call is running: there is no standing connection. */
  isConnected(): boolean { return this.connected; }
  async close(): Promise<void> { this.connected = false; }

  /** One call's worth of connection: reachable, then identified, and closed again when the call ends. */
  private async lease<T>(identify: boolean, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.connect();
    try {
      if (identify) await this.identify(timeoutMs);
      return await fn();
    } finally { this.connected = false; }
  }

  /** Refuses to send code to a listener that does not answer like the add-on (a stand-in on the same port). */
  private async identify(timeoutMs: number): Promise<void> {
    const r = await this.call(this.cmd.inspect, {}, Math.min(8000, timeoutMs));
    if (!r.ok || !looksLikeAddon(r.value)) {
      throw new Error(`Whatever is listening on ${this.cfg.host}:${this.cfg.port} did not identify itself as the Blender add-on (its scene reply had an unexpected shape), so no code was sent to it. Close other programs using that port, or restart Blender's add-on server.`);
    }
  }

  private async call(type: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; value: unknown; message: string; timedOut?: boolean }> {
    let raw: unknown;
    try { raw = await this.req(this.cfg.host, this.cfg.port, { type, params }, { timeoutMs }); } catch (e) {
      this.connected = false;
      if ((e as Partial<TimedOutError> | undefined)?.timedOut === true) return { ok: false, value: undefined, message: e instanceof Error ? e.message : String(e), timedOut: true };
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
    const t = opts.timeoutMs ?? 120_000;
    return this.lease(true, t, async () => {
      const r = await this.call(this.cmd.exec, { code: script }, t);
      if (!r.ok) return fail(capText(r.message), r.timedOut === true);
      // upstream answers {"executed": true, "result": "<captured stdout>"}
      const v = r.value;
      return ok(capText(isObj(v) && typeof v.result === 'string' ? v.result : this.asText(v)));
    });
  }

  async inspect(o: { object?: string }): Promise<BackendResult> {
    return this.lease(false, 30_000, async () => {
      const r = o.object
        ? await this.call(this.cmd.objectInfo, { name: o.object }, 30_000)
        : await this.call(this.cmd.inspect, {}, 30_000);
      if (!r.ok) return fail(capText(r.message), r.timedOut === true);
      // a scene reply is also the identity check; an object reply has no fixed shape to check
      if (!o.object && !looksLikeAddon(r.value)) return fail('The listener on the add-on port answered with something that is not the Blender add-on\'s scene reply; it was ignored.');
      return ok(capText(this.asText(r.value)));
    });
  }

  async screenshot(o: { maxSize?: number }): Promise<BackendResult> {
    return this.lease(true, 45_000, async () => {
      const file = join(this.temp, `legion-blender-shot-${randomBytes(6).toString('hex')}.png`);
      try {
        const r = await this.call(this.cmd.screenshot, { max_size: Math.min(2000, Math.max(64, o.maxSize ?? 800)), filepath: file, format: 'png' }, 45_000);
        if (!r.ok) return fail(capText(r.message), r.timedOut === true);
        let data: Buffer;
        try { data = await this.read(file); } catch { return fail('Blender said it took a screenshot but the file could not be read'); }
        if (!data.length) return fail('The screenshot was empty');
        return ok(isObj(r.value) && typeof r.value.width === 'number' ? `viewport ${r.value.width}x${r.value.height}` : 'viewport screenshot', [{ mime: 'image/png', data: data.toString('base64') }]);
      } finally { await this.remove(file).catch(() => undefined); }
    });
  }

  async docs(_query: string): Promise<BackendResult> {
    return fail('The community add-on has no documentation search. Use the official Blender Lab MCP backend (Blender 5.1+) for blender_docs.');
  }
}
