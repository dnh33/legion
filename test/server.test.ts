import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { makeFakes, start, TOKEN } from './helpers-c.js';

describe('HTTP server', () => {
  const f = makeFakes();
  let base = '';
  let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
  after(async () => { await close(); });

  const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...H, ...(init.headers as any) } });

  it('/health needs no auth', async () => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.ok, true);
  });

  it('401 without / with wrong token', async () => {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    // ?token only for SSE
    assert.equal((await fetch(base + `/api/state?token=${TOKEN}`)).status, 401);
  });

  it('CORS preflight and headers', async () => {
    const r = await fetch(base + '/api/state', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const r2 = await fetch(base + '/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r2.headers.get('access-control-allow-origin'), null);
  });

  it('state, config (redacted), doctor', async () => {
    const s: any = await (await api('/api/state')).json();
    assert.equal(s.agents.length, 2);
    assert.equal(s.boatConfigured, true);
    assert.equal(s.auth, 'claude-login');
    const c: any = await (await api('/api/config')).json();
    assert.equal(c.authToken, '***');
    assert.equal(c.boat.apiKey, '***');
    const d: any = await (await api('/api/doctor')).json();
    assert.equal(d[0].id, 'node');
  });

  it('SSE receives a bus event (token via query)', async () => {
    const ac = new AbortController();
    const r = await fetch(base + `/api/events?token=${TOKEN}`, { signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    f.bus.emit({ type: 'mascot', mood: 'hacking' });
    const reader = r.body!.getReader();
    let buf = '';
    const dec = new TextDecoder();
    while (!buf.includes('"hacking"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    assert.match(buf, /data: \{"type":"mascot","mood":"hacking"\}/);
    ac.abort();
  });

  it('SSE rejects without token', async () => {
    assert.equal((await fetch(base + '/api/events')).status, 401);
  });

  it('/api/catalog (refresh flag) and model validation', async () => {
    assert.equal((await fetch(base + '/api/catalog')).status, 401);
    let c: any = await (await api('/api/catalog')).json();
    assert.equal(c.fetchedAt, 'cached');
    assert.equal(c.models[0].value, 'opus');
    c = await (await api('/api/catalog?refresh=1')).json();
    assert.equal(c.fetchedAt, 'forced');
    const ok = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Modelly', model: 'claude-opus-5-5[1m]' }) });
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as any).model, 'claude-opus-5-5[1m]');
    for (const m of ['', 'x'.repeat(81), 'a b', 5]) {
      assert.equal((await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Bad', model: m }) })).status, 400, String(m));
    }
    assert.equal((await api('/api/tasks', { method: 'POST', body: JSON.stringify({ agentId: 'zealot', prompt: 'hi', model: 'nope!' }) })).status, 400);
    assert.equal((await api('/api/tasks', { method: 'POST', body: JSON.stringify({ agentId: 'zealot', prompt: 'hi', model: 'haiku' }) })).status, 201);
  });
  it('agent CRUD', async () => {
    const events: any[] = [];
    const off = f.bus.on((e) => events.push(e));
    assert.equal((await api('/api/agents', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'X', model: 'bad model!' }) })).status, 400);
    const r = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Research Bot', vm: { enabled: true } }) });
    assert.equal(r.status, 201);
    const a: any = await r.json();
    assert.equal(a.id, 'research-bot');
    assert.equal(a.model, 'auto');
    assert.equal(a.approval, 'ask');
    assert.deepEqual(a.vm, { enabled: true, size: 'default', idleStopMinutes: 15 });
    assert.deepEqual(a.mcpServers, ['*']);
    const b: any = await (await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Research Bot' }) })).json();
    assert.equal(b.id, 'research-bot-2');
    const c: any = await (await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Research Bot' }) })).json();
    assert.equal(c.id, 'research-bot-3');

    const p = await api('/api/agents/research-bot', { method: 'PATCH', body: JSON.stringify({ model: 'opus', vm: { size: 'large' } }) });
    const pa: any = await p.json();
    assert.equal(pa.model, 'opus');
    assert.equal(pa.vm.size, 'large');
    assert.equal(pa.vm.enabled, true);
    assert.equal(pa.id, 'research-bot');
    assert.equal((await api('/api/agents/research-bot', { method: 'PATCH', body: JSON.stringify({ approval: 'bad' }) })).status, 400);
    assert.equal((await api('/api/agents/nope', { method: 'PATCH', body: '{}' })).status, 404);

    assert.equal((await api('/api/agents/zealot', { method: 'DELETE' })).status, 400);
    assert.equal((await api('/api/agents/nope', { method: 'DELETE' })).status, 404);
    assert.equal((await api('/api/agents/research-bot-3', { method: 'DELETE' })).status, 200);
    assert.ok(events.some((e) => e.type === 'agent.deleted' && e.agentId === 'research-bot-3'));
    assert.ok(events.some((e) => e.type === 'agent.updated' && e.agent.id === 'research-bot'));
    off();
    const list: any[] = await (await api('/api/agents')).json();
    assert.ok(!list.some((x) => x.id === 'research-bot-3'));
  });

  it('invalid JSON -> 400', async () => {
    assert.equal((await api('/api/agents', { method: 'POST', body: '{nope' })).status, 400);
  });

  it('tasks start/get/wait/cancel', async () => {
    assert.equal((await api('/api/tasks', { method: 'POST', body: JSON.stringify({ agentId: 'ghost', prompt: 'hi' }) })).status, 404);
    assert.equal((await api('/api/tasks', { method: 'POST', body: JSON.stringify({ agentId: 'zealot' }) })).status, 400);
    const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ agentId: 'zealot', prompt: 'hello' }) });
    assert.equal(r.status, 201);
    const t: any = await r.json();
    const w: any = await (await api(`/api/tasks/${t.id}/wait?timeoutMs=2000`)).json();
    assert.equal(w.status, 'done');
    const g: any = await (await api(`/api/tasks/${t.id}`)).json();
    assert.equal(g.task.result, 'echo: hello');
    assert.equal(g.messages.length, 1);
    assert.equal((await api('/api/tasks/zzz')).status, 404);
    const c: any = await (await api(`/api/tasks/${t.id}/cancel`, { method: 'POST' })).json();
    assert.deepEqual(c, { ok: true });
    assert.deepEqual(f.calls.cancel, [t.id]);
  });

  it('approvals endpoints', async () => {
    f.pending.push({ id: 'ap1', taskId: 't', agentId: 'zealot', toolName: 'Bash', summary: 'ls', input: {}, at: '' });
    const l: any[] = await (await api('/api/approvals')).json();
    assert.equal(l.length, 1);
    const r: any = await (await api('/api/approvals/ap1', { method: 'POST', body: JSON.stringify({ allow: true }) })).json();
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(f.calls.resolved, [['ap1', true]]);
    assert.equal((await api('/api/approvals/ap1', { method: 'POST', body: '{}' })).status, 400);
  });

  it('vm routes + VmError mapping', async () => {
    const vm = f.ctx.vms as any;
    const s: any = await (await api('/api/vms/zealot/start', { method: 'POST' })).json();
    assert.equal(s.state, 'running');
    const e: any = await (await api('/api/vms/zealot/exec', { method: 'POST', body: JSON.stringify({ command: 'ls' }) })).json();
    assert.equal(e.stdout, 'ran ls');
    assert.equal((await api('/api/vms/zealot/exec', { method: 'POST', body: '{}' })).status, 400);
    assert.deepEqual(await (await api('/api/vms/zealot/desktop', { method: 'POST' })).json(), { url: 'https://desk.example/x' });
    assert.equal((await api('/api/vms/zealot/screenshot')).status, 409);

    const { VmError } = await import('../src/core/vm-manager.js');
    const orig = vm.ensureRunning;
    const table: [string, number][] = [['not_configured', 503], ['disabled', 400], ['not_running', 409], ['unknown_agent', 404], ['boat', 502]];
    for (const [code, status] of table) {
      vm.ensureRunning = async () => { throw new VmError('x', code as any); };
      assert.equal((await api('/api/vms/zealot/start', { method: 'POST' })).status, status, code);
    }
    vm.ensureRunning = async () => { throw new Error('boom'); };
    assert.equal((await api('/api/vms/zealot/start', { method: 'POST' })).status, 500);
    vm.ensureRunning = orig;
  });

  it('404 / 405', async () => {
    assert.equal((await api('/api/nothing')).status, 404);
    assert.equal((await api('/api/state', { method: 'POST', body: '{}' })).status, 405);
  });
});
