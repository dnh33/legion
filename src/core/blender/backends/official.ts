/**
 * Official Blender Lab MCP backend. Legion starts the server (a separate program, GPL-3.0-or-later, downloaded only when you press
 * Set up) as an MCP stdio client; the server reaches the Blender add-on over its own local socket (which, like the community add-on's, has no
 * password in the v1.0.3 source: see docs/BLENDER.md). Tool names are config (advanced.official.tools; the defaults are the v1.0.3 names) and
 * at connect time they are matched against the server's real tool list:
 *   - the exec tool: the configured name, else the first non-CLI tool whose name looks like "execute ... code" and that the server does not
 *     mark read-only. If none is found the backend refuses to connect. It is held in a private field, only exec() calls it, and it is never
 *     listed to agents.
 *   - the tools that run WITHOUT an approval card (inspect, object detail, screenshot, docs): only the exact configured name, or a pattern
 *     match that the server itself marks readOnlyHint. Never the exec tool, never a tool whose arguments take code. Otherwise the role is
 *     unavailable and the call says so; a wrong guess can no longer turn a code tool into a card-free one.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BlenderConfig, BlenderEntry } from '../../../shared/blender.js';
import type { BackendImage, BackendResult, BlenderBackend } from '../backend.js';
import { capText, fail, ok, PYTHON_UTF8_ENV } from '../backend.js';

export interface McpToolInfo { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } }
/** The part of the MCP SDK Client this backend uses; tests pass a fake. */
export interface McpLike {
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(p: { name: string; arguments?: Record<string, unknown> }, schema?: unknown, opts?: { timeout?: number }): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

export interface OfficialDeps {
  /** Starts the server and returns a connected client. The default spawns the command from config through the SDK's stdio transport. */
  connectClient?: (launch: { command: string; args: string[]; env: Record<string, string> }) => Promise<McpLike>;
}

const PATTERNS = {
  exec: /^(execute|exec|run)[a-z_]*(python|code|script)/i,
  inspect: /(scene|object|datablock|inspect|summary)/i,
  objectInfo: /(object).*(detail|info|summary)|(detail|info).*(object)/i,
  screenshot: /(screenshot|viewport)/i,
  docs: /(doc|manual|api).*(search|query|lookup)|search.*(doc|manual)/i,
};

export type Role = keyof typeof PATTERNS;

const isCli = (n: string): boolean => /_for_cli|cli$|^cli_|headless|batch/i.test(n);
/** A string argument that carries code or a command: a tool with one is never a card-free tool. */
const CODE_ARG = /^(code|script|python|source|expression|command|cmd|statement)$/i;
const takesCode = (t: McpToolInfo): boolean => Object.entries(t.inputSchema?.properties ?? {}).some(([k, v]) => CODE_ARG.test(k) && (v?.type === undefined || v.type === 'string'));

/** Picks the server tool for a role. Pure; exported for tests. `execName` is the tool chosen for exec (a card-free role may never be that tool). */
export function resolveTool(role: Role, tools: McpToolInfo[], configured: string, execName?: string): string | undefined {
  if (role === 'exec') {
    if (tools.some((t) => t.name === configured)) return configured;
    return tools.find((t) => !isCli(t.name) && PATTERNS.exec.test(t.name) && t.annotations?.readOnlyHint !== true)?.name;
  }
  const usable = (t: McpToolInfo): boolean => t.name !== execName && !isCli(t.name) && !takesCode(t);
  const exact = tools.find((t) => t.name === configured);
  if (exact) return usable(exact) ? exact.name : undefined;
  return tools.find((t) => usable(t) && t.annotations?.readOnlyHint === true && PATTERNS[role].test(t.name))?.name;
}

/**
 * Which argument carries the main value: the configured name when the schema has it, else a string property that fits the ROLE, else the only
 * string property, else the configured name. For the card-free roles a code-like argument is never preferred.
 */
export function resolveArg(tool: McpToolInfo | undefined, configured: string, role: Role = 'exec'): string {
  const props = tool?.inputSchema?.properties;
  if (!props || configured in props) return configured;
  const strings = Object.entries(props).filter(([, v]) => v?.type === 'string').map(([k]) => k);
  const pref = strings.find((k) => (role === 'exec' ? /code|script|python|source/i : /query|search|text|name|term|identifier|object/i).test(k) && (role === 'exec' || !CODE_ARG.test(k)));
  if (pref) return pref;
  const only = strings.length === 1 ? strings[0]! : undefined;
  return only && (role === 'exec' || !CODE_ARG.test(only)) ? only : configured;
}

function contentToResult(res: { content?: unknown; isError?: boolean }): BackendResult {
  const parts = Array.isArray(res.content) ? res.content : [];
  const texts: string[] = [];
  const images: BackendImage[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text);
    else if (o.type === 'image' && typeof o.data === 'string') images.push({ mime: typeof o.mimeType === 'string' ? o.mimeType : 'image/png', data: o.data });
  }
  const text = capText(texts.join('\n'));
  return res.isError ? { ok: false, text: text || 'The Blender server reported an error', images } : { ok: true, text, images };
}

export class OfficialBackend implements BlenderBackend {
  readonly kind = 'official' as const;
  private client: McpLike | null = null;
  private tools: McpToolInfo[] = [];
  private names: Partial<Record<Role, string>> = {};
  private connecting: Promise<void> | null = null;

  constructor(private readonly cfg: Pick<BlenderConfig, 'host' | 'port' | 'entry' | 'advanced'>, private readonly deps: OfficialDeps = {}) {}

  private launch(): { command: string; args: string[]; env: Record<string, string> } {
    const e: BlenderEntry | undefined = this.cfg.entry;
    const adv = this.cfg.advanced.official;
    const sub = (s: string) => s.replace(/\{serverDir\}/g, e?.serverDir ?? '').replace(/\{host\}/g, this.cfg.host).replace(/\{port\}/g, String(this.cfg.port));
    const subEnv = (m: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, sub(v)]));
    if (e) return { command: e.command, args: e.args.map(sub), env: { ...subEnv(adv.env), ...subEnv(e.env) } };
    return { command: adv.command, args: adv.args.map(sub), env: subEnv(adv.env) };
  }

  connect(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= (async () => {
      try {
        const launch = this.launch();
        const client = this.deps.connectClient
          ? await this.deps.connectClient(launch)
          : await defaultConnect(launch);
        const { tools } = await client.listTools();
        const t = this.cfg.advanced.official.tools;
        const exec = resolveTool('exec', tools, t.exec);
        if (!exec) { await client.close().catch(() => undefined); throw new Error(`The Blender MCP server started but offers no code-execution tool. Tools it offers: ${tools.map((x) => x.name).join(', ') || 'none'}. Check advanced.official.tools in config.json.`); }
        this.tools = tools;
        this.names = {
          exec,
          inspect: resolveTool('inspect', tools, t.inspect, exec), objectInfo: resolveTool('objectInfo', tools, t.objectInfo, exec),
          screenshot: resolveTool('screenshot', tools, t.screenshot, exec), docs: resolveTool('docs', tools, t.docs, exec),
        };
        this.client = client;
      } finally { this.connecting = null; }
    })();
    return this.connecting;
  }

  isConnected(): boolean { return this.client !== null; }
  toolNames(): string[] { return this.tools.map((t) => t.name); }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => undefined);
  }

  private async call(role: Role, args: Record<string, unknown>, timeoutMs: number): Promise<BackendResult> {
    await this.connect();
    const name = this.names[role];
    if (!name) return fail(`The Blender server has no tool for "${role}" (looked for "${this.cfg.advanced.official.tools[role]}" and for names like it). Set advanced.official.tools.${role} in config.json.`);
    try {
      return contentToResult(await this.client!.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }));
    } catch (e) {
      // a dead server must reconnect on the next call
      await this.close();
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = (e as { code?: unknown } | undefined)?.code === -32001 || /timed out|timeout/i.test(msg);
      return fail(timedOut
        ? `The Blender server did not answer in time (${msg}). What was sent may STILL BE RUNNING in Blender; nothing was cancelled.`
        : `The Blender server did not answer: ${msg}`, timedOut);
    }
  }

  private infoFor(role: Role): McpToolInfo | undefined { return this.tools.find((t) => t.name === this.names[role]); }

  async exec(script: string, opts: { timeoutMs?: number } = {}): Promise<BackendResult> {
    await this.connect();
    const arg = resolveArg(this.infoFor('exec'), this.cfg.advanced.official.tools.execArg, 'exec');
    return this.call('exec', { [arg]: script }, opts.timeoutMs ?? 120_000);
  }
  async inspect(o: { object?: string }): Promise<BackendResult> {
    await this.connect();
    if (o.object && this.names.objectInfo) {
      const arg = resolveArg(this.infoFor('objectInfo'), 'name', 'objectInfo');
      return this.call('objectInfo', { [arg]: o.object }, 30_000);
    }
    const props = this.infoFor('inspect')?.inputSchema?.properties ?? {};
    const nameArg = Object.keys(props).find((k) => /name|object/i.test(k) && !CODE_ARG.test(k));
    return this.call('inspect', o.object && nameArg ? { [nameArg]: o.object } : {}, 30_000);
  }
  async screenshot(o: { maxSize?: number }): Promise<BackendResult> {
    await this.connect();
    const props = this.infoFor('screenshot')?.inputSchema?.properties ?? {};
    // a size in pixels only; v1.0.3's argument is size_limit_in_bytes, which is not pixels and is left at its default
    const sizeArg = Object.keys(props).find((k) => /size|width/i.test(k) && !/byte/i.test(k));
    return this.call('screenshot', o.maxSize && sizeArg ? { [sizeArg]: o.maxSize } : {}, 60_000);
  }
  async docs(query: string): Promise<BackendResult> {
    await this.connect();
    const arg = resolveArg(this.infoFor('docs'), 'query', 'docs');
    return this.call('docs', { [arg]: query }, 30_000);
  }
}

/** The environment of the MCP server process: the SDK's safe defaults, the configured variables, then UTF-8 for Python (not overridable). */
export function serverEnv(launchEnv: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...launchEnv, ...PYTHON_UTF8_ENV };
}

async function defaultConnect(launch: { command: string; args: string[]; env: Record<string, string> }): Promise<McpLike> {
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: serverEnv(launch.env), stderr: 'ignore' });
  const client = new Client({ name: 'legion-blender', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client as unknown as McpLike;
}
