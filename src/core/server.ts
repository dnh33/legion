/** Local HTTP API + SSE + MCP endpoint. */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { redactConfig, VERSION } from '../shared/config.js';
import type {
  AgentProfile, ApprovalMode, DoctorCheck, LegionConfig, LegionEvent, Catalog, ModelChoice, StateSnapshot, Task, VmSize,
} from '../shared/types.js';
import { summariseUsage } from '../shared/usage-summary.js';
import { nowIso, slugify, uniqueAgentId } from '../shared/util.js';
import { ADMIN_HEADER, gate, healthProof, isAdminSecret, isHexNonce, isSsePath, safeEqual } from './admin.js';
import type { ApprovalBroker } from './approvals.js';
import type { EventBus } from './bus.js';
import { EngineError } from './engine.js';
import type { Engine } from './engine.js';
import { buildLegionMcpServer } from './mcp-tools.js';
import type { Store } from './store.js';
import { SettingsError } from './settings.js';
import type { SettingsService } from './settings.js';
import { VmError } from './vm-manager.js';
import type { VmManager } from './vm-manager.js';
import type { CoreModule } from './modules.js';
import { agentIdVisible, agentVisible, taskVisible } from './visibility.js';
import { pushSse } from './sse.js';
import { checkRequest, dropNonLoopback, originAllowed } from './net-guard.js';
import { publicBoatHealth } from './boat-health.js';
import type { ProjectStore } from './projects/store.js';
import type { BoardStore } from './projects/board/store.js';

export interface CoreContext {
  config: LegionConfig; store: Store; bus: EventBus; engine: Engine; vms: VmManager; approvals: ApprovalBroker;
  boatConfigured: () => boolean;
  doctor: () => Promise<DoctorCheck[]>;
  /** Claude Code commands + models (cached; force = re-probe). */
  catalog: (force?: boolean) => Promise<Catalog>;
  settings: SettingsService;
  /** Optional feature modules (comms bridge, knowledge graph, ...). */
  modules?: CoreModule[];
  /** True while the optional BSV Dev Kit toggle is on. Agents with `requires: 'bsv'` are hidden from lists while false/absent. */
  bsvEnabled?: () => boolean;
  /** Per-launch admin secret (memory only, handed over by the Electron main process over stdin). Absent: admin routes are closed to everyone. Never logged, never in /health. */
  adminSecret?: string;
  /** Projects (read-only here: the MCP tool `legion_projects` lists and gets them; every change goes through the projects module's admin routes). */
  projects?: ProjectStore;
  /** Project board (behind its config switch): read-only for token clients through `legion_board_read`. Absent: nothing board-related exists. */
  board?: BoardStore;
}

/** Thrown by handlers; mapped to `{error}` JSON. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

const MAX_BODY = 2 * 1024 * 1024;
export const MODEL_RE = /^[A-Za-z0-9._:\[\]\/-]+$/;
/** 'auto' or any non-empty string <= 80 chars of [A-Za-z0-9._:\[\]-] (alias or full model id). */
export function parseModel(v: unknown, field = 'model'): ModelChoice | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || v.length > 80 || !MODEL_RE.test(v)) {
    throw new HttpError(400, `${field} must be 'auto' or a model name (max 80 chars, letters, digits, . _ : / [ ] -)`);
  }
  return v;
}
const APPROVALS: ApprovalMode[] = ['ask', 'auto-edits', 'full'];
const VM_SIZES: VmSize[] = ['small', 'default', 'large'];

const VM_STATUS: Record<VmError['code'], number> = {
  not_configured: 503, disabled: 400, not_running: 409, unknown_agent: 404, boat: 502, claude_not_configured: 409,
};

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

/** A task as listed in /api/state: everything but the final assistant text. */
const withoutResult = (t: Task): Task => { if (t.result === undefined) return t; const { result: _result, ...rest } = t; return rest; };

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

function parseSkills(v: unknown): 'inherit' | string[] | undefined {
  if (v === undefined) return undefined;
  if (v === 'inherit') return 'inherit';
  if (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
    throw new HttpError(400, "skills must be 'inherit' or an array of skill ids (strings)");
  }
  return [...new Set((v as string[]).map((x) => x.trim()))];
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
    skills: parseSkills(b.skills),
  };
}

export type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; body: unknown };
export type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; handler: Handler; status?: number }

/** Creates (does not listen) the HTTP server. The caller listens with listenLoopback() from net-guard.ts (127.0.0.1 only). */
export function createServer(ctx: CoreContext): Server {
  const routes: Route[] = [];
  const route = (method: string, pattern: string, handler: Handler, status = 200) => {
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$');
    routes.push({ method, re, handler, status });
  };

  /** Agents gated behind an optional feature (the Assayer needs BSV mode) are hidden while it is off. Lookups by id still work. */
  const visible = (a: AgentProfile) => agentVisible(ctx, a);
  const taskShown = (t: Pick<Task, 'agentId'>) => taskVisible(ctx, t);
  /** A task of a hidden agent answers 404, exactly like an id that never existed. */
  const mustTask = (id: string): Task => {
    const t = ctx.store.getTask(id);
    if (!t || !taskShown(t)) throw new HttpError(404, `Unknown task "${id}"`);
    return t;
  };
  /** Running or driving a hidden agent (starting a task, its VM, its desktop) is refused like an unknown id, so the HTTP API matches the MCP tools. Reading, editing and stopping stay possible. */
  const mustBeRunnable = (agentId: string): void => {
    const a = ctx.store.getAgent(agentId);
    if (a && !visible(a)) throw new HttpError(404, `Unknown agent "${agentId}"`);
  };

  // ---- read-only -------------------------------------------------------
  /** True for the app window (it holds the admin secret); false for an MCP-class token. */
  const isAdminReq = (req: unknown): boolean => !!(req as { legionAdmin?: boolean }).legionAdmin;
  route('GET', '/api/state', ({ url, req }): StateSnapshot => ({
    version: VERSION,
    agents: ctx.store.listAgents().filter(visible),
    // the list leaves out each task's final text (up to 2 KB x 200): GET /api/tasks/:id has it, and task.updated events carry the whole task
    tasks: ctx.store.listTasks(200, undefined, ['1', 'true'].includes(url.searchParams.get('archived') ?? '')).filter(taskShown).map(withoutResult),
    vms: ctx.store.listVms().filter((v) => agentIdVisible(ctx, v.agentId)),
    approvals: ctx.approvals.pending().filter((a) => agentIdVisible(ctx, a.agentId)),
    boatConfigured: ctx.boatConfigured(),
    // A token-only client gets whether things work, never the user's prices or what the key was probed for.
    ...(ctx.vms.health ? { boat: isAdminReq(req) ? ctx.vms.health.view() : publicBoatHealth(ctx.vms.health.view()) } : {}),
    auth: ctx.config.claude.auth,
    // live progress of running runs, so a window opened mid-run shows the turn, tool and checklist at once (hidden agents' runs left out)
    progress: Object.fromEntries(Object.entries(ctx.engine.progressSnapshot?.() ?? {}).filter(([id]) => { const t = ctx.store.getTask(id); return !!t && taskShown(t); })),
  }));
  route('GET', '/api/config', () => redactConfig(ctx.config));
  route('GET', '/api/doctor', () => ctx.doctor());
  // Claude usage for the title-bar panel: summed from stored tasks (archived included), only those the caller may see.
  route('GET', '/api/usage', () => summariseUsage(ctx.store.listTasks(100000, undefined, true).filter(taskShown), Date.now()));
  // Admin only by default-deny (not in the client route list): server names and error text are the owner's business.
  route('GET', '/api/mcp/status', () => ctx.engine.mcpStatus());
  route('GET', '/api/catalog', ({ url }) => ctx.catalog(['1', 'true'].includes(url.searchParams.get('refresh') ?? '')));

  // ---- settings --------------------------------------------------------
  route('GET', '/api/settings', () => ctx.settings.view());
  route('PATCH', '/api/settings', ({ body }) => ctx.settings.patch(body));
  route('POST', '/api/settings/boat/test', ({ body }) => ctx.settings.testBoat(isObj(body) ? body.apiKey : undefined, isObj(body) ? body.baseUrl : undefined));
  // Restores the shipped compaction defaults. Admin-only by default-deny (not in admin.ts CLIENT_ROUTES), like every settings route.
  route('POST', '/api/settings/compaction/reset', () => ctx.settings.resetCompaction());

  // ---- agents ----------------------------------------------------------
  route('GET', '/api/agents', () => ctx.store.listAgents().filter(visible));
  route('POST', '/api/agents', ({ body }) => {
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    const f = parseAgentFields(body);
    const name = (f.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name is required');
    const taken = new Set(ctx.store.listAgents().map((a) => a.id));
    const base = slugify(name);
    const id = uniqueAgentId(base, taken);
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
      ...(f.skills ? { skills: f.skills } : {}),
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
      ...(f.skills ? { skills: f.skills } : {}),
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
    const gone = ctx.store.getAgent(id);
    if (!gone) throw new HttpError(404, `Unknown agent "${id}"`);
    const wasShown = visible(gone);
    ctx.store.deleteAgent(id);
    if (wasShown) ctx.bus.emit({ type: 'agent.deleted', agentId: id });
    return { ok: true };
  });

  // ---- tasks -----------------------------------------------------------
  route('POST', '/api/tasks', (c) => {
    const { body } = c;
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    const agentId = str(body.agentId, 'agentId', { required: true })!;
    mustBeRunnable(agentId);
    const prompt = str(body.prompt, 'prompt', { required: true })!;
    const model = parseModel(body.model);
    const continueTaskId = str(body.continueTaskId, 'continueTaskId');
    // Without the admin header this is an MCP-class client: source 'mcp', which the engine caps at the `ask` ceiling.
    const admin = !!(c.req as unknown as { legionAdmin?: boolean }).legionAdmin;
    // Only the app starts a task inside a project: a token client cannot put a run in a project (it can continue one, which keeps its project).
    const projectId = str(body.projectId, 'projectId');
    if (projectId !== undefined && !admin) throw new HttpError(403, 'admin_required: only the Legion app can start a task inside a project');
    return ctx.engine.startTask({ agentId, prompt, source: admin ? 'ui' : 'mcp', model, continueTaskId, ...(projectId ? { projectId } : {}) });
  }, 201);
  route('GET', '/api/tasks/:id/wait', async ({ params, url }) => {
    const raw = url.searchParams.get('timeoutMs');
    let ms = raw === null ? 120000 : Number(raw);
    if (!Number.isFinite(ms) || ms < 0) ms = 120000;
    ms = Math.min(ms, 600000);
    mustTask(params[0]);
    return ctx.engine.waitFor(params[0], ms);
  });
  route('GET', '/api/tasks/:id', ({ params }) => {
    const task = mustTask(params[0]);
    return { task, messages: ctx.store.listMessages(task.id) };
  });
  route('PATCH', '/api/tasks/:id', ({ params, body }) => {
    const cur = mustTask(params[0]);
    if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
    if (body.archived === undefined && body.title === undefined) throw new HttpError(400, 'archived or title required');
    const next = { ...cur };
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be a boolean');
      if (body.archived) next.archived = true; else delete next.archived;
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw new HttpError(400, 'title must be a non-empty string (max 200)');
      next.title = body.title.trim();
    }
    const saved = ctx.store.upsertTask(next);
    ctx.bus.emit({ type: 'task.updated', task: saved });
    return saved;
  });
  route('DELETE', '/api/tasks/:id', ({ params }) => {
    const cur = mustTask(params[0]);
    if (cur.status === 'queued' || cur.status === 'running') throw new HttpError(409, 'Task is running; cancel it first');
    ctx.store.deleteTask(cur.id);
    ctx.bus.emit({ type: 'task.deleted', taskId: cur.id });
    return { ok: true };
  });
  route('POST', '/api/tasks/:id/cancel', ({ params }) => {
    mustTask(params[0]);
    return { ok: ctx.engine.cancel(params[0]) };
  });

  /**
   * Compact this conversation now. `focus` is optional and tells the summary what to weight - the user gets to say
   * what matters before it is compressed away.
   *
   * Returns { ok, detail } rather than throwing on a decline: turning compaction off, a conversation too short to
   * compact, or a provider that will not answer are ordinary outcomes the UI shows, not failures.
   */
  route('POST', '/api/tasks/:id/compact', async ({ params, body }) => {
    mustTask(params[0]);
    const focus = isObj(body) ? str(body.focus, 'focus') : undefined;
    return ctx.engine.compactTaskNow(params[0], focus);
  });

  // ---- vms -------------------------------------------------------------
  route('GET', '/api/vms', () => ctx.store.listVms());
  route('POST', '/api/vms/:agentId/start', ({ params }) => { mustBeRunnable(params[0]); return ctx.vms.ensureRunning(params[0]); });
  /** The VmRecord (what the UI stores) plus `stopped`, `message` and `usage`. With no sandbox: 200, stopped:false, message "No sandbox to stop". */
  route('POST', '/api/vms/:agentId/stop', async ({ params }) => {
    const r: any = await ctx.vms.stop(params[0]);
    return r && typeof r === 'object' && r.vm ? { ...r.vm, stopped: r.stopped, verified: r.verified, message: r.message, usage: r.usage } : r;
  });
  route('GET', '/api/vms/:agentId/usage', ({ params }) => ctx.vms.usage(params[0]));
  /** Admin-only (not in CLIENT_ROUTES, so the gate answers a token-only caller 403): these show what the key was probed for and the user's prices. Re-probe = cheap reads and not-found probes; never creates a sandbox. */
  route('POST', '/api/boat/check', () => ctx.vms.health.probe());
  /** Lazy first look: probes only if this key was never probed (Settings, boat.dev calls it when opened); otherwise answers from the cache. */
  route('POST', '/api/boat/ensure', () => ctx.vms.health.ensure());
  route('GET', '/api/boat/health', () => ctx.vms.health.view());
  route('POST', '/api/vms/:agentId/exec', ({ params, body }) => {
    mustBeRunnable(params[0]);
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
  route('POST', '/api/vms/:agentId/desktop', async ({ params }) => { mustBeRunnable(params[0]); return { url: await ctx.vms.desktopUrl(params[0]) }; });
  route('GET', '/api/vms/:agentId/screenshot', ({ params }) => { mustBeRunnable(params[0]); return ctx.vms.screenshot(params[0]); });

  // ---- approvals -------------------------------------------------------
  route('GET', '/api/approvals', () => ctx.approvals.pending());
  route('POST', '/api/approvals/:id', ({ params, body }) => {
    if (!isObj(body) || typeof body.allow !== 'boolean') throw new HttpError(400, 'body {allow:boolean} required');
    return { ok: ctx.approvals.resolve(params[0], body.allow) };
  });

  // ---- feature modules ---------------------------------------------------
  for (const m of ctx.modules ?? []) m.routes?.(route);

  // ---- SSE + MCP (handle the response themselves) -----------------------
  /** False for an event that would show a hidden agent's task, message, approval, VM, room or comms state. */
  const eventShown = (ev: LegionEvent): boolean => {
    switch (ev.type) {
      case 'agent.updated': return visible(ev.agent);
      case 'agent.deleted': return agentIdVisible(ctx, ev.agentId);
      case 'task.updated': return taskShown(ev.task);
      case 'message': case 'message.delta': case 'task.progress': { const t = ctx.store.getTask(ev.type === 'message' ? ev.message.taskId : ev.taskId); return !t || taskShown(t); }
      case 'vm.updated': return agentIdVisible(ctx, ev.vm.agentId);
      case 'approval.requested': return agentIdVisible(ctx, ev.approval.agentId);
      case 'comms.state': return agentIdVisible(ctx, ev.agentId) && (!ev.peerId || agentIdVisible(ctx, ev.peerId));
      case 'room.updated': return ev.room.members.every((m) => agentIdVisible(ctx, m));
      case 'room.message': return (ev.message.from.kind !== 'bot' || agentIdVisible(ctx, ev.message.from.agentId)) && ev.message.to.every((m) => agentIdVisible(ctx, m));
      default: return true;
    }
  };

  /** Events only the app window (admin) may see: the human's rooms and their text, bot-to-bot state, and settings (key hints). A token-only stream drops them. */
  const adminOnlyEvent = (ev: LegionEvent): boolean => ev.type.startsWith('room.') || ev.type.startsWith('comms.') || ev.type.startsWith('settings.') || ev.type.startsWith('kg.') || ev.type.startsWith('blender.') || ev.type.startsWith('project.') || ev.type.startsWith('board.') || ev.type.startsWith('ci.');

  const handleSse = (req: IncomingMessage, res: ServerResponse, admin: boolean) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const off = ctx.bus.on((ev: LegionEvent) => {
      if (!eventShown(ev)) return; // hidden agents must not leak through the event stream
      if (!admin && adminOnlyEvent(ev)) return;
      pushSse(res, !admin && ev.type === 'boat.health' ? { type: 'boat.health', health: publicBoatHealth(ev.health) } : ev);
    });
    const hb = setInterval(() => { if (!res.writableNeedDrain) res.write(': hb\n\n'); }, 15000);
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
    // Loopback guard (src/core/net-guard.ts): remote address, Host and Origin, before CORS, auth and every route (/health, /mcp, SSE included).
    const g = checkRequest(req, listeningPort());
    if (!g.ok) {
      if (g.destroy) { req.socket.destroy(); return; }
      sendJson(res, g.status, { error: g.error });
      return;
    }
    void dispatch(req, res).catch((e) => fail(res, e));
  });

  server.on('connection', (sock) => { dropNonLoopback(sock); });
  function listeningPort(): number { const a = server.address(); return a && typeof a === 'object' ? a.port : -1; }

  function applyCors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin !== undefined && originAllowed(origin, listeningPort(), req.headers['user-agent'])) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Legion-Admin, mcp-session-id, mcp-protocol-version');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function fail(res: ServerResponse, e: unknown) {
    let status = 500;
    let message = e instanceof Error ? e.message : String(e);
    if (e instanceof HttpError) status = e.status;
    else if (e instanceof EngineError) status = e.status;
    else if (e instanceof SettingsError) status = e.status;
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
      // `admin` only says whether this core holds an admin secret (the app uses it to spot a foreign core); never the secret.
      // With `?nonce=<hex>` a core that holds the secret also answers HMAC(secret, nonce): the app's proof that this is its own core.
      const nonce = url.searchParams.get('nonce');
      const proof = ctx.adminSecret && isHexNonce(nonce) ? healthProof(ctx.adminSecret, nonce) : undefined;
      sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid, admin: !!ctx.adminSecret, ...(proof ? { proof } : {}) });
      return;
    }

    // Default-deny gate, BEFORE routing: unknown and unclassified paths get the same 403 as admin routes.
    const isSse = isSsePath(method, path);
    const adminOk = isAdminSecret(req.headers[ADMIN_HEADER], ctx.adminSecret);
    const decision = gate({ method, path, adminOk, bearerOk: adminOk || authorized(req, url, isSse), hasSecret: !!ctx.adminSecret });
    if (!decision.allow) {
      if (decision.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, decision.status, { error: decision.error });
      return;
    }
    (req as unknown as { legionAdmin?: boolean }).legionAdmin = decision.admin;

    if (isSse) { handleSse(req, res, decision.admin); return; }

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
