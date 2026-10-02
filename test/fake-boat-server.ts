/** A stateful fake boat.dev REST server (real HTTP on 127.0.0.1) for the VM tests. Mirrors the error shapes seen in real use. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReq { method: string; path: string; body: any; auth: string }

export class FakeBoatServer {
  sandboxes = new Map<string, { state: string; type: string; name?: string }>();
  seq = 0;
  /** Free trial: any type other than 'default' is refused on create and resume. */
  trial = false;
  /** Operations the key may not do ('create' | 'resume' | 'stop' | 'commands' | 'files' | 'prompt' | 'list'): refused with api_key_action_forbidden before any lookup. */
  forbidden = new Set<string>();
  providerConfigured = true;
  /** Real boat.dev may answer provider_not_configured before it looks up the sandbox (true) or after (false). The probe must cope with both. */
  providerFirst = false;
  /** Put the bearer key into every error message (a hostile or sloppy server). */
  echoKey = false;
  requests: FakeReq[] = [];
  server!: Server;
  baseUrl = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const path = u.pathname.replace(/^\/api\/v1/, '');
        let body: any; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
        const auth = String(req.headers.authorization ?? '');
        this.requests.push({ method: req.method ?? 'GET', path, body, auth });
        const [status, json] = this.handle(req.method ?? 'GET', path, body, auth);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/v1`;
    return this;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }

  count(method: string, pathRe: RegExp): number { return this.requests.filter((r) => r.method === method && pathRe.test(r.path)).length; }

  private err(status: number, code: string, message: string, auth: string): [number, unknown] {
    const m = this.echoKey ? `${message} (key ${auth.replace(/^Bearer /, '')})` : message;
    return [status, { ok: false, status, code, message: m }];
  }
  private deny(op: string, auth: string): [number, unknown] | null {
    return this.forbidden.has(op) ? this.err(403, 'api_key_action_forbidden', `This API key cannot perform sandbox.${op}`, auth) : null;
  }

  private handle(method: string, path: string, body: any, auth: string): [number, unknown] {
    if (method === 'GET' && path === '/me') return [200, { ok: true, email: 'me@example.com' }];
    if (method === 'GET' && path === '/sandboxes') return this.deny('list', auth) ?? [200, { ok: true, sandboxes: [] }];
    if (method === 'POST' && path === '/sandboxes') {
      const d = this.deny('create', auth); if (d) return d;
      const type = body?.type ?? 'default';
      if (this.trial && type !== 'default') return this.err(403, 'trial_machine_class_not_allowed', `8 vCPU / 16 GB '${type}' not available during free trial`, auth);
      const id = `bx_${++this.seq}`;
      this.sandboxes.set(id, { state: 'ready', type });
      return [202, { ok: true, type: 'sandbox.created', created: { sandbox: { id, state: 'provisioning', type } } }];
    }
    const m = /^\/sandboxes\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!m) return this.err(404, 'not_found', 'no such route', auth);
    const id = m[1], rest = m[2] ?? '';
    const sb = this.sandboxes.get(id);
    const missing = () => this.err(404, 'not_found', `sandbox ${id} not found`, auth);
    if (method === 'GET' && rest === '') return sb ? [200, { ok: true, sandbox: { id, state: sb.state, type: sb.type, name: sb.name } }] : missing();
    if (method === 'PATCH' && rest === '') { if (!sb) return missing(); sb.name = body?.name ?? sb.name; return [200, { ok: true, sandbox: { id, state: sb.state, type: sb.type, name: sb.name } }]; }
    if (method === 'POST' && rest === 'stop') { const d = this.deny('stop', auth); if (d) return d; if (!sb) return missing(); sb.state = 'archived'; return [202, { ok: true }]; }
    if (method === 'POST' && rest === 'resume') {
      const d = this.deny('resume', auth); if (d) return d;
      if (!sb) return missing();
      const type = body?.type ?? sb.type;
      if (this.trial && type !== 'default') return this.err(403, 'trial_machine_class_not_allowed', `8 vCPU / 16 GB '${type}' not available during free trial`, auth);
      sb.state = 'ready'; sb.type = type; return [202, { ok: true }];
    }
    if (method === 'POST' && rest === 'commands') { const d = this.deny('commands', auth); if (d) return d; if (!sb) return missing(); return [200, { ok: true, success: true, exitCode: 0, stdout: 'hi', stderr: '' }]; }
    if (rest === 'files') { const d = this.deny('files', auth); if (d) return d; if (!sb) return missing(); return [200, { ok: true, content: 'x' }]; }
    if (method === 'POST' && rest === 'prompt') {
      const d = this.deny('prompt', auth); if (d) return d;
      if (this.providerFirst && !this.providerConfigured) return this.err(409, 'provider_not_configured', 'Prompting is locked until Claude is configured on the Agents page.', auth);
      if (!sb) return missing();
      if (!this.providerConfigured) return this.err(409, 'provider_not_configured', 'Prompting is locked until Claude is configured on the Agents page.', auth);
      return [202, { ok: true, promptId: 'p1', promptRun: { conversationId: 'c1' } }];
    }
    if (method === 'GET' && rest === 'prompts/p1') return [200, { ok: true, promptRun: { id: 'p1', status: 'finished', done: true, conversationId: 'c1' } }];
    if (method === 'GET' && rest === 'events') return [200, { ok: true, events: [{ type: 'response', taskId: 'p1', data: { content: 'all done' } }], pageInfo: { hasMore: false } }];
    return this.err(404, 'not_found', 'no such route', auth);
  }
}
