/** boat.dev REST client (fetch). Docs: https://boat.dev/docs */
import { randomUUID } from 'node:crypto';
import type { VmSize } from '../shared/types.js';
import { sleep } from '../shared/util.js';

export interface BoatSandbox { id: string; state: string; type?: string; name?: string; raw?: unknown }
export interface ExecResult { exitCode: number; stdout: string; stderr: string }

export class BoatError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly action?: string) { super(message); this.name = 'BoatError'; }
}

/** boat.dev error codes Legion gives a precise message for (seen in real use). */
export const BOAT_CODE = {
  keyActionForbidden: 'api_key_action_forbidden',
  trialMachineClass: 'trial_machine_class_not_allowed',
  providerNotConfigured: 'provider_not_configured',
} as const;

/** Why a probe call gave no verdict. Only `auth` says anything about the key; the others are about the network, the limiter or boat.dev. */
export type ProbeFailure = 'auth' | 'network' | 'rate_limit' | 'server' | 'other';
export function failureKind(e: unknown): ProbeFailure {
  if (!(e instanceof BoatError)) return 'other';
  if (e.status === 401) return 'auth';
  if (e.status === 0 || e.code === 'network') return 'network';
  if (e.status === 429) return 'rate_limit';
  if (e.status >= 500) return 'server';
  return 'other';
}

/** Outcome of probing what the API key may do. 'allowed' only means boat.dev did not refuse it. */
export type ProbeStatus = 'allowed' | 'forbidden' | 'unknown';
export interface BoatProbe {
  me: { ok: boolean; detail: string; kind?: ProbeFailure };
  ops: Array<{ op: string; status: ProbeStatus; action?: string; reason?: ProbeFailure }>;
  claude: 'configured' | 'not_configured' | 'unknown';
}

/** An id no sandbox can have: the action probes aim at it so they can never touch (or create) a real sandbox. */
const PROBE_SANDBOX_ID = 'bx_legion_probe_does_not_exist';

export interface BoatClientOptions { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch; pollMs?: number }

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const READY_STATES = new Set(['ready', 'idle', 'running']);
const PROMPT_TERMINAL = new Set(['finished', 'failed', 'interrupted']);

function isObj(x: unknown): x is Json { return typeof x === 'object' && x !== null && !Array.isArray(x); }

export class BoatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;

  constructor(opts: BoatClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.pollMs = opts.pollMs ?? 2000;
  }

  me(): Promise<unknown> { return this.req('GET', '/me'); }

  /** Cheap read: GET /sandboxes?limit=1. Used by the key probe, never creates anything. */
  async list(limit = 1): Promise<unknown> { return this.req('GET', '/sandboxes', { query: { limit: String(limit) } }); }

  /**
   * Finds out what this key is refused, without creating a real sandbox. boat.dev has no permission-introspection endpoint that we know of,
   * so: GET /me, a cheap list, then each action aimed at a sandbox id that cannot exist. A key without the action is refused with
   * api_key_action_forbidden before any lookup; a key with it gets "not found" (or similar), which counts as "not refused".
   * Never throws; every failure becomes 'unknown'.
   */
  async checkKey(): Promise<BoatProbe> {
    const out: BoatProbe = { me: { ok: false, detail: '' }, ops: [], claude: 'unknown' };
    const id = enc(PROBE_SANDBOX_ID);
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['list VMs', () => this.list(1)],
      ['stop', () => this.req('POST', `/sandboxes/${id}/stop`, { body: {}, timeoutMs: 15_000 })],
      ['resume', () => this.req('POST', `/sandboxes/${id}/resume`, { body: {}, timeoutMs: 15_000 })],
      ['run commands', () => this.req('POST', `/sandboxes/${id}/commands`, { body: { command: 'true', timeoutSeconds: 1 }, timeoutMs: 15_000 })],
      ['read and write files', () => this.req('GET', `/sandboxes/${id}/files`, { query: { path: '/', encoding: 'utf8' }, timeoutMs: 15_000 })],
      ['prompt Claude', () => this.req('POST', `/sandboxes/${id}/prompt`, { body: { provider: 'claude', prompt: 'probe', new: true }, timeoutMs: 15_000 })],
    ];
    const unknownRest = (from: number, reason: ProbeFailure) => { for (const [op] of steps.slice(from)) out.ops.push({ op, status: 'unknown', reason }); };
    try { await this.me(); out.me = { ok: true, detail: 'Connected' }; } catch (e) {
      const kind = failureKind(e);
      out.me = { ok: false, detail: e instanceof Error ? e.message : String(e), kind };
      // A rejected key, a dead network, a limiter or a server error: nothing more can be learned, and none of them (but the first) is about the key.
      if (kind === 'auth' || kind === 'network' || kind === 'rate_limit' || kind === 'server') { if (kind !== 'auth') unknownRest(0, kind); return out; }
    }
    for (let i = 0; i < steps.length; i++) {
      const [op, run] = steps[i]!;
      try { await run(); out.ops.push({ op, status: 'allowed' }); } catch (e) {
        if (e instanceof BoatError && e.code === BOAT_CODE.keyActionForbidden) { out.ops.push({ op, status: 'forbidden', ...(e.action ? { action: e.action } : {}) }); continue; }
        if (e instanceof BoatError && e.code === BOAT_CODE.providerNotConfigured && op === 'prompt Claude') { out.claude = 'not_configured'; out.ops.push({ op, status: 'allowed' }); continue; }
        const kind = failureKind(e);
        // 400/404/409/422 on the impossible id: boat.dev looked at the request and did not refuse the key. Anything else gives no verdict.
        if (e instanceof BoatError && kind === 'other' && [400, 404, 409, 422].includes(e.status)) { out.ops.push({ op, status: 'allowed' }); continue; }
        out.ops.push({ op, status: 'unknown', reason: kind });
        if (kind === 'rate_limit' || kind === 'auth') { unknownRest(i + 1, kind); break; } // stop hammering a limiter / a rejected key
      }
    }
    return out;
  }

  /** POST /sandboxes with Idempotency-Key header. */
  async create(p: { type?: VmSize; ttlSeconds?: number | null; env?: Record<string, string>; name?: string; idempotencyKey?: string }): Promise<BoatSandbox> {
    const body: Json = {};
    if (p.type) body.type = p.type;
    if (p.ttlSeconds !== undefined) body.ttlSeconds = p.ttlSeconds;
    if (p.env) body.env = p.env;
    const res = await this.req('POST', '/sandboxes', { body, headers: { 'Idempotency-Key': p.idempotencyKey ?? randomUUID() } });
    let sb = this.parseSandbox(res);
    if (p.name) {
      try { sb = { ...sb, ...(await this.update(sb.id, { name: p.name })), id: sb.id }; } catch { /* naming is cosmetic */ }
    }
    return sb;
  }

  async get(id: string): Promise<BoatSandbox> {
    return this.parseSandbox(await this.req('GET', `/sandboxes/${enc(id)}`));
  }

  async update(id: string, p: { name?: string; ttlSeconds?: number | null }): Promise<BoatSandbox> {
    return this.parseSandbox(await this.req('PATCH', `/sandboxes/${enc(id)}`, { body: p }));
  }

  async stop(id: string): Promise<void> { await this.req('POST', `/sandboxes/${enc(id)}/stop`, { body: {} }); }

  async resume(id: string, p?: { ttlSeconds?: number | null; type?: VmSize }): Promise<void> {
    await this.req('POST', `/sandboxes/${enc(id)}/resume`, { body: p ?? {} });
  }

  /** Polls get() until state is ready/idle/running; throws BoatError on 'error' or timeout. */
  async waitUntilReady(id: string, timeoutMs = 180_000): Promise<BoatSandbox> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sb = await this.get(id);
      if (READY_STATES.has(sb.state)) return sb;
      if (sb.state === 'error' || sb.state === 'cancelled') {
        const why = isObj(sb.raw) && typeof sb.raw.error === 'string' ? `: ${sb.raw.error}` : '';
        throw new BoatError(`boat.dev sandbox ${id} entered state '${sb.state}'${why}`, 500, 'sandbox_' + sb.state);
      }
      if (Date.now() >= deadline) throw new BoatError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for sandbox ${id} (last state '${sb.state}')`, 504, 'timeout');
      await sleep(this.pollMs);
    }
  }

  async exec(id: string, command: string, opts?: { cwd?: string; timeoutSeconds?: number }): Promise<ExecResult> {
    const body: Json = { command };
    if (opts?.cwd) body.cwd = opts.cwd;
    if (opts?.timeoutSeconds) body.timeoutSeconds = Math.max(1, Math.min(600, Math.round(opts.timeoutSeconds)));
    const res = await this.req('POST', `/sandboxes/${enc(id)}/commands`, { body, timeoutMs: ((body.timeoutSeconds as number | undefined) ?? 30) * 1000 + 30_000 });
    const r = pick(res, 'result') ?? res;
    const code = r.exitCode;
    return {
      exitCode: typeof code === 'number' ? code : (r.success === true ? 0 : -1),
      stdout: str(r.stdout),
      stderr: str(r.stderr),
    };
  }

  async readFile(id: string, path: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
    const res = await this.req('GET', `/sandboxes/${enc(id)}/files`, { query: { path, encoding } });
    return str(res.content);
  }

  async writeFile(id: string, path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
    await this.req('PUT', `/sandboxes/${enc(id)}/files`, { body: { path, content, encoding } });
  }

  /** Queue work for Claude Code inside the sandbox. provider is always 'claude'. */
  async prompt(id: string, p: { prompt: string; model?: string; conversationId?: string; new?: boolean }): Promise<{ promptId: string; conversationId?: string }> {
    const body: Json = { provider: 'claude', prompt: p.prompt };
    if (p.model) body.model = p.model;
    if (p.conversationId) body.conversationId = p.conversationId;
    else if (p.new) body.new = true;
    const res = await this.req('POST', `/sandboxes/${enc(id)}/prompt`, { body });
    const run = isObj(res.promptRun) ? res.promptRun : {};
    const promptId = res.promptId ?? run.promptId ?? run.id;
    if (typeof promptId !== 'string') throw new BoatError('boat.dev prompt response did not include a promptId', 502, 'bad_response');
    const conv = res.conversationId ?? run.conversationId;
    return { promptId, conversationId: typeof conv === 'string' ? conv : undefined };
  }

  /** Poll prompt status until terminal; collect final assistant text from events. */
  async waitForPrompt(id: string, promptId: string, timeoutMs = 20 * 60_000): Promise<{ status: string; text: string }> {
    const deadline = Date.now() + timeoutMs;
    let status = 'queued';
    let conversationId: string | undefined;
    for (;;) {
      const res = await this.req('GET', `/sandboxes/${enc(id)}/prompts/${enc(promptId)}`);
      const run = isObj(res.promptRun) ? res.promptRun : res;
      status = typeof run.status === 'string' ? run.status : status;
      if (typeof run.conversationId === 'string') conversationId = run.conversationId;
      if (PROMPT_TERMINAL.has(status) || run.done === true) break;
      if (Date.now() >= deadline) throw new BoatError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for prompt ${promptId} (status '${status}')`, 504, 'timeout');
      await sleep(this.pollMs);
    }
    const parts: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const query: Record<string, string> = { type: 'response', sort: 'asc', limit: '200' };
      if (conversationId) query.conversation = conversationId;
      if (cursor) query.cursor = cursor;
      const ev = await this.req('GET', `/sandboxes/${enc(id)}/events`, { query });
      const events: unknown[] = Array.isArray(ev.events) ? ev.events : [];
      for (const e of events) {
        if (!isObj(e) || (e.taskId !== promptId && e.promptId !== promptId)) continue;
        const d = e.data;
        if (!isObj(d) || d.is_streaming === true || d.is_reverted === true) continue;
        if (typeof d.content === 'string' && d.content.length > 0) parts.push(d.content);
      }
      const pi: Json = isObj(ev.pageInfo) ? ev.pageInfo : {};
      if (pi.hasMore === true && typeof pi.nextCursor === 'string' && pi.nextCursor !== cursor) cursor = pi.nextCursor;
      else break;
    }
    return { status, text: parts.join('\n\n').trim() };
  }

  async interrupt(id: string): Promise<void> { await this.req('POST', `/sandboxes/${enc(id)}/interrupt`, { body: {} }); }

  /** POST /sandboxes/{id}/desktop; polls while provisioning. Returns the URL. */
  async desktopUrl(id: string, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.req('POST', `/sandboxes/${enc(id)}/desktop`, { body: {} });
      if (res.provisioning !== true && typeof res.desktopUrl === 'string' && res.desktopUrl) return res.desktopUrl;
      if (res.provisioning !== true && !res.desktopUrl) throw new BoatError('boat.dev returned no desktop URL for this sandbox', 502, 'no_desktop_url');
      if (Date.now() >= deadline) throw new BoatError(`Timed out waiting for the desktop to be provisioned on ${id}`, 504, 'timeout');
      await sleep(this.pollMs);
    }
  }

  // ---- internals ----
  private parseSandbox(res: Json): BoatSandbox {
    // Defensive: sandbox may be at res.sandbox, res.sandbox.sandbox, res.created.sandbox, or top-level.
    const cands = [res.sandbox, isObj(res.created) ? res.created.sandbox : undefined, isObj(res.sandbox) ? res.sandbox.sandbox : undefined, res];
    for (const c of cands) {
      if (isObj(c) && typeof c.id === 'string' && (typeof c.state === 'string' || c !== res)) {
        return { id: c.id, state: typeof c.state === 'string' ? c.state : (typeof res.status === 'string' ? res.status : 'unknown'), type: typeof c.type === 'string' ? c.type : undefined, name: typeof c.name === 'string' ? c.name : undefined, raw: c };
      }
    }
    if (typeof res.id === 'string') return { id: res.id, state: typeof res.status === 'string' ? res.status : 'unknown', raw: res };
    throw new BoatError('boat.dev response did not contain a sandbox', 502, 'bad_response');
  }

  private async req(method: string, path: string, o: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Json> {
    let url = this.baseUrl + path;
    if (o.query) url += '?' + new URLSearchParams(o.query).toString();
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(o.headers ?? {}) };
    let body: string | undefined;
    if (o.body !== undefined) { body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; }
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
    } catch (e) {
      throw new BoatError(this.scrub(`Could not reach boat.dev (${method} ${path}): ${(e as Error).message}`), 0, 'network');
    }
    const raw = await resp.text();
    let json: Json = {};
    if (raw) { try { const p = JSON.parse(raw); if (isObj(p)) json = p; } catch { /* non-JSON */ } }
    if (!resp.ok || json.ok === false) {
      const status = resp.status || (typeof json.status === 'number' ? json.status : 500);
      const errObj = isObj(json.error) ? json.error : {};
      const code = typeof json.code === 'string' ? json.code : typeof errObj.code === 'string' ? errObj.code : undefined;
      const msg = (typeof json.message === 'string' && json.message) || (typeof errObj.message === 'string' && errObj.message) || (typeof json.error === 'string' && json.error) || raw.slice(0, 300) || resp.statusText || 'request failed';
      const clean = this.scrub(msg);
      throw new BoatError(explain(status, clean, code, method, path), status, code, code === BOAT_CODE.keyActionForbidden ? forbiddenAction(clean) : undefined);
    }
    return json;
  }

  /** Never let the API key leak through an error message (boat.dev could echo it back). */
  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('***') : text;
  }
}

/** "This API key cannot perform sandbox.resume" -> "sandbox.resume". */
export function forbiddenAction(msg: string): string | undefined {
  return /cannot (?:perform|do|call|use)\s+['"`]?([A-Za-z0-9_.:-]+)/i.exec(msg)?.[1];
}

const ACTION_LABELS: Record<string, string> = {
  create: 'create a VM', resume: 'resume a stopped VM', stop: 'stop a VM', get: 'read a VM', list: 'list VMs', update: 'rename or change a VM',
  commands: 'run commands', exec: 'run commands', command: 'run commands', files: 'read and write files', prompt: 'prompt Claude in a VM', desktop: 'open the desktop',
};
function actionLabel(action: string | undefined): string {
  if (!action) return 'do this';
  const tail = action.split('.').pop() ?? action;
  const label = ACTION_LABELS[tail];
  return label ? `${action} (${label})` : action;
}

function explain(status: number, msg: string, code: string | undefined, method: string, path: string): string {
  const tag = `${method} ${path} -> ${status}${code ? ' ' + code : ''}`;
  if (code === BOAT_CODE.keyActionForbidden) {
    return `This boat.dev API key cannot ${actionLabel(forbiddenAction(msg))}: create a full-access key in boat.dev and paste it in Settings \u2192 boat.dev. [${tag}] ${msg}`;
  }
  if (code === BOAT_CODE.trialMachineClass) {
    return `This boat.dev account is on a free trial, which does not allow that VM size. Use the Default size (or upgrade the plan on boat.dev). [${tag}] ${msg}`;
  }
  if (code === BOAT_CODE.providerNotConfigured) {
    return `Claude is not configured on boat.dev: open the Agents page in your boat.dev dashboard and connect Claude, then try again. [${tag}] ${msg}`;
  }
  if (status === 401) return `boat.dev API key rejected (401). Open Settings → boat.dev to check the key. [${tag}] ${msg}`;
  if (status === 402) return `boat.dev says this account cannot run sandboxes right now (402): check billing and usage limits on your boat.dev dashboard. [${tag}] ${msg}`;
  if (status === 403) return `boat.dev refused this request (403): a plan limit or a missing permission on the API key. [${tag}] ${msg}`;
  if (status === 429) return `boat.dev rate limit hit (429); try again shortly. [${tag}] ${msg}`;
  if (status === 404) return `boat.dev resource not found (404). [${tag}] ${msg}`;
  return `boat.dev error (${status}): ${msg} [${tag}]`;
}

const enc = encodeURIComponent;
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
function pick(o: Json, key: string): Json | undefined { return isObj(o[key]) ? (o[key] as Json) : undefined; }
