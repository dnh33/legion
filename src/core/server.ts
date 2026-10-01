/** Local HTTP API + SSE + MCP endpoint. */
import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { redactConfig, VERSION } from '../shared/config.js';
import type {
  AgentProfile, ApprovalMode, DoctorCheck, LegionConfig, LegionEvent, Catalog, ModelChoice, StateSnapshot, VmSize,
} from '../shared/types.js';
import { nowIso, slugify } from '../shared/util.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import { EngineError } from './engine.js';
import type { Engine } from './engine.js';
import { buildLegionMcpServer } from './mcp-tools.js';
import type { Store } from './store.js';
import { VmError } from './vm-manager.js';
import type { VmManager } from './vm-manager.js';
import type { CoreModule } from './modules.js';

export interface CoreContext {
  config: LegionConfig; store: Store; bus: EventBus; engine: Engine; vms: VmManager; approvals: ApprovalBroker;
  boatConfigured: () => boolean;
  doctor: () => Promise<DoctorCheck[]>;
  /** Claude Code commands + models (cached; force = re-probe). */
  catalog: (force?: boolean) => Promise<Catalog>;
  /** Optional feature modules (comms bridge, knowledge graph, ...). */
  modules?: CoreModule[];
  /** True while the optional BSV Dev Kit toggle is on. Agents with `requires: 'bsv'` are hidden from lists while false/absent. */
  bsvEnabled?: () => boolean;
}

/** Thrown by handlers; mapped to `{error}` JSON. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

const MAX_BODY = 2 * 1024 * 1024;
export const MODEL_RE = /^[A-Za-z0-9._:\[\]-]+$/;
/** 'auto' or any non-empty string <= 80 chars of [A-Za-z0-9._:\[\]-] (alias or full model id). */
export function parseModel(v: unknown, field = 'model'): ModelChoice | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || v.length > 80 || !MODEL_RE.test(v)) {
    throw new HttpError(400, `${field} must be 'auto' or a model name (max 80 chars, letters, digits, . _ : [ ] -)`);
  }
  return v;
}
const APPROVALS: ApprovalMode[] = ['ask', 'auto-edits', 'full'];
const VM_SIZES: VmSize[] = ['small', 'default', 'large'];

const VM_STATUS: Record<VmError['code'], number> = {
  not_configured: 503, disabled: 400, not_running: 409, unknown_agent: 404, boat: 502,
};

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin === 'null' || origin === 'file://') return true;
  if (origin === 'http://localhost:5173') return true;
  return /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let dead = false;
    req.on('data', (c: Buffer) => {
      if (dead) return;
      size += c.length;
      if (size > MAX_BODY) { dead = true; reject(new HttpError(413, 'Request body too large (limit 2MB)')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', (e) => { if (!dead) reject(e); });
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, field: string, opts: { required?: boolean } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  if (opts.required && !v.trim()) throw new HttpError(400, `${field} is required`);
  return v;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

/** Validates the vm sub-object, returning a normalised partial. */
function parseVm(v: unknown): Partial<AgentProfile['vm']> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new HttpError(400, 'vm must be an object');
  const out: Partial<AgentProfile['vm']> = {};
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') throw new HttpError(400, 'vm.enabled must be a boolean');
    out.enabled = v.enabled;
  }
  const size = oneOf(v.size, 'vm.size', VM_SIZES);
  if (size) out.size = size;
  if (v.idleStopMinutes !== undefined) {
    if (typeof v.idleStopMinutes !== 'number' || !Number.isFinite(v.idleStopMinutes) || v.idleStopMinutes < 1 || v.idleStopMinutes > 1440) {
      throw new HttpError(400, 'vm.idleStopMinutes must be a number between 1 and 1440');
    }
    out.idleStopMinutes = Math.round(v.idleStopMinutes);
  }
  return out;
}

function parseMcpServers(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, 'mcpServers must be an array of strings');
  return v as string[];
}

/** Shared field validation for create + patch (only present fields returned). */
function parseAgentFields(b: Record<string, unknown>) {
  return {
    name: str(b.name, 'name'),
    emoji: str(b.emoji, 'emoji'),
    description: str(b.description, 'description'),
    systemPrompt: str(b.systemPrompt, 'systemPrompt'),
    cwd: str(b.cwd, 'cwd'),
    model: parseModel(b.model),
    approval: oneOf(b.approval, 'approval', APPROVALS),
    vm: parseVm(b.vm),
    mcpServers: parseMcpServers(b.mcpServers),
  };
}

export type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; body: unknown };
export type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; handler: Handler; status?: number }

/** Creates (does not listen) the HTTP server. Caller does server.listen(config.port, '127.0.0.1'). */
export function createServer(ctx: CoreContext): Server {
  const routes: Route[] = [];
  const route = (method: string, pattern: string, handler: Handler, status = 200) => {
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$');
    routes.push({ method, re, handler, status });
  };

  /** Agents gated behind an optional feature (the Assayer needs BSV mode) are hidden while it is off. Lookups by id still work. */
  const visible = (a: AgentProfile) => a.requires !== 'bsv' || ctx.bsvEnabled?.() === true;

  // ---- read-only -------------------------------------------------------
  route('GET', '/api/state', (): StateSnapshot => ({
    version: VERSION,
    agents: ctx.store.listAgents().filter(visible),
    tasks: ctx.store.listTasks(200),
    vms: ctx.store.listVms(),
    approvals: ctx.approvals.pending(),
    boatConfigured: ctx.boatConfigured(),
    auth: ctx.config.claude.auth,
  }));
  route('GET', '/api/config', () => redactConfig(ctx.config));
  route('GET', '/api/doctor', () => ctx.doctor());
  route('GET', '/api/catalog', ({ url }) => ctx.catalog(['1', 'true'].includes(url.searchParams.get('refresh') ?? '')));

  // ---- agents ----------------------------------------------------------
  route('GET', '/api/agents', () => ctx.store.listAgents().filter(visible));
  route('POST', '/api/agents', ({ body }) => {
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    const f = parseAgentFields(body);
    const name = (f.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name is required');
    const taken = new Set(ctx.store.listAgents().map((a) => a.id));
    const base = slugify(name);
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    const now = nowIso();
    const agent: AgentProfile = {
      id, name,
      emoji: f.emoji || '◆',
      description: f.description ?? '',
      systemPrompt: f.systemPrompt ?? '',
      model: f.model ?? 'auto',
      vm: { enabled: false, size: 'default', idleStopMinutes: 15, ...f.vm },
      approval: f.approval ?? 'ask',
      mcpServers: f.mcpServers ?? ['*'],
      ...(f.cwd ? { cwd: f.cwd } : {}),
      createdAt: now, updatedAt: now,
    };
    const saved = ctx.store.upsertAgent(agent);
    ctx.bus.emit({ type: 'agent.updated', agent: saved });
    return saved;
  }, 201);
  route('PATCH', '/api/agents/:id', ({ params, body }) => {
    const cur = ctx.store.getAgent(params[0]);
    if (!cur) throw new HttpError(404, `Unknown agent "${params[0]}"`);
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    const f = parseAgentFields(body);
    if (f.name !== undefined && !f.name.trim()) throw new HttpError(400, 'name must not be empty');
    const next: AgentProfile = {
      ...cur,
      ...(f.name !== undefined ? { name: f.name.trim() } : {}),
      ...(f.emoji !== undefined ? { emoji: f.emoji } : {}),
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.systemPrompt !== undefined ? { systemPrompt: f.systemPrompt } : {}),
      ...(f.model ? { model: f.model } : {}),
      ...(f.approval ? { approval: f.approval } : {}),
      ...(f.mcpServers ? { mcpServers: f.mcpServers } : {}),
      ...(f.cwd !== undefined ? { cwd: f.cwd || undefined } : {}),
      vm: { ...cur.vm, ...f.vm },
      id: cur.id, createdAt: cur.createdAt, updatedAt: nowIso(),
    };
    const saved = ctx.store.upsertAgent(next);
    ctx.bus.emit({ type: 'agent.updated', agent: saved });
    return saved;
  });
  route('DELETE', '/api/agents/:id', ({ params }) => {
    const id = params[0];
    if (id === 'zealot') throw new HttpError(400, 'The "zealot" agent cannot be deleted');
    if (!ctx.store.getAgent(id)) throw new HttpError(404, `Unknown agent "${id}"`);
    ctx.store.deleteAgent(id);
    ctx.bus.emit({ type: 'agent.deleted', agentId: id });
    return { ok: true };
  });

  // ---- tasks -----------------------------------------------------------
  route('POST', '/api/tasks', ({ body }) => {
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    const agentId = str(body.agentId, 'agentId', { required: true })!;
    const prompt = str(body.prompt, 'prompt', { required: true })!;
    const model = parseModel(body.model);
    const continueTaskId = str(body.continueTaskId, 'continueTaskId');
    return ctx.engine.startTask({ agentId, prompt, source: 'ui', model, continueTaskId });
  }, 201);
  route('GET', '/api/tasks/:id/wait', async ({ params, url }) => {
    const raw = url.searchParams.get('timeoutMs');
    let ms = raw === null ? 120000 : Number(raw);
    if (!Number.isFinite(ms) || ms < 0) ms = 120000;
    ms = Math.min(ms, 600000);
    if (!ctx.store.getTask(params[0])) throw new HttpError(404, `Unknown task "${params[0]}"`);
    return ctx.engine.waitFor(params[0], ms);
  });
  route('GET', '/api/tasks/:id', ({ params }) => {
    const task = ctx.store.getTask(params[0]);
    if (!task) throw new HttpError(404, `Unknown task "${params[0]}"`);
    return { task, messages: ctx.store.listMessages(task.id) };
  });
  route('POST', '/api/tasks/:id/cancel', ({ params }) => {
    if (!ctx.store.getTask(params[0])) throw new HttpError(404, `Unknown task "${params[0]}"`);
    return { ok: ctx.engine.cancel(params[0]) };
  });

  // ---- vms -------------------------------------------------------------
  route('GET', '/api/vms', () => ctx.store.listVms());
  route('POST', '/api/vms/:agentId/start', ({ params }) => ctx.vms.ensureRunning(params[0]));
  route('POST', '/api/vms/:agentId/stop', ({ params }) => ctx.vms.stop(params[0]));
  route('POST', '/api/vms/:agentId/exec', ({ params, body }) => {
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    const command = str(body.command, 'command', { required: true })!;
    const cwd = str(body.cwd, 'cwd');
    let timeoutSeconds: number | undefined;
    if (body.timeoutSeconds !== undefined) {
      if (typeof body.timeoutSeconds !== 'number' || !(body.timeoutSeconds > 0)) throw new HttpError(400, 'timeoutSeconds must be a positive number');
      timeoutSeconds = body.timeoutSeconds;
    }
    return ctx.vms.exec(params[0], command, { cwd, timeoutSeconds });
  });
  route('POST', '/api/vms/:agentId/desktop', async ({ params }) => ({ url: await ctx.vms.desktopUrl(params[0]) }));
  route('GET', '/api/vms/:agentId/screenshot', ({ params }) => ctx.vms.screenshot(params[0]));

  // ---- approvals -------------------------------------------------------
  route('GET', '/api/approvals', () => ctx.approvals.pending());
  route('POST', '/api/approvals/:id', ({ params, body }) => {
    if (!isObj(body) || typeof body.allow !== 'boolean') throw new HttpError(400, 'body {allow:boolean} required');
    return { ok: ctx.approvals.resolve(params[0], body.allow) };
  });

  // ---- feature modules ---------------------------------------------------
  for (const m of ctx.modules ?? []) m.routes?.(route);

  // ---- SSE + MCP (handle the response themselves) -----------------------
  const handleSse = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const off = ctx.bus.on((ev: LegionEvent) => {
      if (ev.type === 'agent.updated' && !visible(ev.agent)) return; // hidden agents must not leak through the event stream
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const hb = setInterval(() => { res.write(': hb\n\n'); }, 15000);
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(hb); off(); };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    const mcp = buildLegionMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  // ---- dispatcher ------------------------------------------------------
  const server = createHttpServer((req, res) => {
    void dispatch(req, res).catch((e) => fail(res, e));
  });

  function applyCors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (allowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id, mcp-protocol-version');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function fail(res: ServerResponse, e: unknown) {
    let status = 500;
    let message = e instanceof Error ? e.message : String(e);
    if (e instanceof HttpError) status = e.status;
    else if (e instanceof EngineError) status = e.status;
    else if (e instanceof VmError) status = VM_STATUS[e.code] ?? 500;
    if (status === 500) { try { process.stderr.write(`[legion-core] 500: ${e instanceof Error ? e.stack : message}\n`); } catch { /* ignore */ } }
    if (res.headersSent) { res.end(); return; }
    sendJson(res, status, { error: message });
  }

  function authorized(req: IncomingMessage, url: URL, allowQuery: boolean): boolean {
    const expected = ctx.config.authToken;
    let given = '';
    const h = req.headers.authorization;
    if (typeof h === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(h.trim());
      if (m) given = m[1];
    }
    if (!given && allowQuery) given = url.searchParams.get('token') ?? '';
    if (!given || !expected) return false;
    return safeEqual(given, expected);
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    applyCors(req, res);
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid });
      return;
    }

    const isSse = method === 'GET' && path === '/api/events';
    if (!authorized(req, url, isSse)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'Unauthorized: missing or invalid bearer token' });
      return;
    }

    if (isSse) { handleSse(req, res); return; }

    let body: unknown;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') body = await readBody(req);

    if (path === '/mcp') {
      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') throw new HttpError(405, 'Method not allowed');
      await handleMcp(req, res, body);
      return;
    }

    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = m.slice(1).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
      const out = await r.handler({ req, res, url, params, body });
      sendJson(res, r.status ?? 200, out);
      return;
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : `Not found: ${method} ${path}`);
  }

  return server;
}
