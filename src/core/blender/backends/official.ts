/**
 * Official Blender Lab MCP backend. Legion starts the server (a separate program, GPL-3.0-or-later, downloaded only when you press
 * Set up) as an MCP stdio client; the server reaches the Blender add-on over its own local socket. UNVERIFIED: the exact tool names and
 * argument names. They are config (advanced.official.tools), and at connect time they are matched against the server's real tool list:
 *   1. the configured name, when the server has a tool of that name;
 *   2. otherwise the first tool whose name matches a pattern for that role (command-line `_for_cli` variants are never picked);
 *   3. otherwise the role is unavailable and the call says so. If no execute tool is found the backend refuses to connect.
 * The execute tool is held in a private field and only exec() calls it; it is never listed to agents.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BlenderConfig, BlenderEntry } from '../../../shared/blender.js';
import type { BackendImage, BackendResult, BlenderBackend } from '../backend.js';
import { capText, fail, ok } from '../backend.js';

export interface McpToolInfo { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } }
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
  exec: /(execute|exec|run).*(python|code|script)|python|bpy/i,
  inspect: /(scene|object|datablock|inspect|info)/i,
  screenshot: /(screenshot|viewport)/i,
  docs: /(doc|manual|api).*(search|query|lookup)|search.*(doc|manual)|docs/i,
};

export type Role = keyof typeof PATTERNS;

/** Picks the server tool for a role. Pure; exported for tests. */
export function resolveTool(role: Role, tools: McpToolInfo[], configured: string): string | undefined {
  if (tools.some((t) => t.name === configured)) return configured;
  const cli = (n: string) => /_for_cli|cli$|^cli_|headless|batch/i.test(n);
  return tools.find((t) => !cli(t.name) && PATTERNS[role].test(t.name))?.name;
}

/** Which argument carries the main value: the configured name when the schema has it, else the only string property, else the configured name. */
export function resolveArg(tool: McpToolInfo | undefined, configured: string): string {
  const props = tool?.inputSchema?.properties;
  if (!props || configured in props) return configured;
  const strings = Object.entries(props).filter(([, v]) => v?.type === 'string').map(([k]) => k);
  const pref = strings.find((k) => /code|script|python|source|query|text|name/i.test(k));
  return pref ?? (strings.length === 1 ? strings[0]! : configured);
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
    if (e) return { command: e.command, args: e.args.map(sub), env: { ...adv.env, ...e.env } };
    return { command: adv.command, args: adv.args.map(sub), env: { ...adv.env } };
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
          exec, inspect: resolveTool('inspect', tools, t.inspect), screenshot: resolveTool('screenshot', tools, t.screenshot), docs: resolveTool('docs', tools, t.docs),
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
      return fail(`The Blender server did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private infoFor(role: Role): McpToolInfo | undefined { return this.tools.find((t) => t.name === this.names[role]); }

  async exec(script: string, opts: { timeoutMs?: number } = {}): Promise<BackendResult> {
    await this.connect();
    const arg = resolveArg(this.infoFor('exec'), this.cfg.advanced.official.tools.execArg);
    return this.call('exec', { [arg]: script }, opts.timeoutMs ?? 120_000);
  }
  async inspect(o: { object?: string }): Promise<BackendResult> {
    await this.connect();
    const tool = this.infoFor('inspect');
    const props = tool?.inputSchema?.properties ?? {};
    const nameArg = Object.keys(props).find((k) => /name|object/i.test(k));
    return this.call('inspect', o.object && nameArg ? { [nameArg]: o.object } : {}, 30_000);
  }
  async screenshot(o: { maxSize?: number }): Promise<BackendResult> {
    await this.connect();
    const props = this.infoFor('screenshot')?.inputSchema?.properties ?? {};
    const sizeArg = Object.keys(props).find((k) => /size|width/i.test(k));
    return this.call('screenshot', o.maxSize && sizeArg ? { [sizeArg]: o.maxSize } : {}, 60_000);
  }
  async docs(query: string): Promise<BackendResult> {
    await this.connect();
    const arg = resolveArg(this.infoFor('docs'), 'query');
    return this.call('docs', { [arg]: query }, 30_000);
  }
}

async function defaultConnect(launch: { command: string; args: string[]; env: Record<string, string> }): Promise<McpLike> {
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: { ...getDefaultEnvironment(), ...launch.env }, stderr: 'ignore' });
  const client = new Client({ name: 'legion-blender', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client as unknown as McpLike;
}
