import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { makeFakes, start, TOKEN, AUTH } from './helpers-c.js';

describe('HTTP server', () => {
  const f = makeFakes();
  let base = '';
  let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
  after(async () => { await close(); });

  const H = { ...AUTH, 'Content-Type': 'application/json' };
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
  it('task archive / rename / delete', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify({ agentId: 'zealot', prompt: 'keep me' }) })).json() as any;
    const id = created.id;
    assert.equal((await api(`/api/tasks/${id}`, { method: 'DELETE' })).status, 409, 'running task cannot be deleted');
    await (await api(`/api/tasks/${id}/wait?timeoutMs=2000`)).json();
    assert.equal((await api('/api/tasks/nope', { method: 'PATCH', body: '{"archived":true}' })).status, 404);
    assert.equal((await api(`/api/tasks/${id}`, { method: 'PATCH', body: '{}' })).status, 400);
    assert.equal((await api(`/api/tasks/${id}`, { method: 'PATCH', body: '{"archived":"yes"}' })).status, 400);
    assert.equal((await api(`/api/tasks/${id}`, { method: 'PATCH', body: '{"title":"  "}' })).status, 400);
    const events: any[] = [];
    const off = f.bus.on((e) => events.push(e));
    const p = await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true, title: ' Renamed ' }) });
    assert.equal(p.status, 200);
    const pt: any = await p.json();
    assert.equal(pt.archived, true);
    assert.equal(pt.title, 'Renamed');
    assert.ok(events.some((e) => e.type === 'task.updated' && e.task.id === id));
    let st: any = await (await api('/api/state')).json();
    assert.ok(!st.tasks.some((t: any) => t.id === id), 'archived hidden from state');
    st = await (await api('/api/state?archived=1')).json();
    assert.ok(st.tasks.some((t: any) => t.id === id));
    const un: any = await (await api(`/api/tasks/${id}`, { method: 'PATCH', body: '{"archived":false}' })).json();
    assert.equal(un.archived, undefined);
    assert.equal((await api(`/api/tasks/${id}`, { method: 'DELETE' })).status, 200);
    off();
    assert.ok(events.some((e) => e.type === 'task.deleted' && e.taskId === id));
    assert.equal((await api(`/api/tasks/${id}`)).status, 404);
    assert.equal((await api(`/api/tasks/${id}`, { method: 'DELETE' })).status, 404);
  });

  it('settings: GET is redacted; PATCH validates, writes config.json, applies live; boat test never stores', async () => {
    const before = await api('/api/settings');
    const raw = await before.text();
    assert.equal(before.status, 200);
    assert.ok(!raw.includes(TOKEN) && !raw.includes('authToken'), 'authToken never returned');
    assert.ok(!raw.includes('secret-key-abcd'), 'full key never returned');
    const v0: any = JSON.parse(raw);
    assert.equal(v0.boat.apiKeySet, true);
    assert.equal(v0.boat.apiKeyHint, '…abcd');
    assert.equal(v0.claude.apiKeySet, false);
    assert.equal(v0.configPath, f.configPath);

    for (const bad of [
      '[]', '{"claude":{"auth":"oauth"}}', '{"claude":{"maxTurns":0}}', '{"claude":{"maxTurns":1.5}}', '{"claude":{"apiKey":""}}',
      '{"claude":{"inheritClaudeCodeSettings":"yes"}}', '{"boat":{"baseUrl":"ftp://x"}}', '{"boat":{"apiKey":5}}',
      '{"mcpServers":{"legion":{"command":"x"}}}', '{"mcpServers":{"a b":{"command":"x"}}}', '{"mcpServers":{"a":{"command":""}}}',
      '{"mcpServers":{"a":{"type":"http","url":"nope"}}}', '{"mcpServers":{"a":{"command":"x","args":[1]}}}',
    ]) assert.equal((await api('/api/settings', { method: 'PATCH', body: bad })).status, 400, bad);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).boat.apiKey, 'secret-key-abcd', 'invalid patches write nothing');

    const events: any[] = [];
    const off = f.bus.on((e) => events.push(e));
    const r = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({
      claude: { auth: 'api-key', apiKey: 'sk-ant-zzzz1234', maxTurns: 12, executablePath: '/bin/claude' },
      boat: { apiKey: 'new-boat-key-9999', baseUrl: 'https://boat.test/api/v1/' },
      mcpServers: { gh: { type: 'http', url: 'https://x.test/mcp', headers: { A: 'b' } }, loc: { command: 'node', args: ['s.js'] } },
    }) });
    assert.equal(r.status, 200);
    const v: any = await r.json();
    assert.equal(v.claude.auth, 'api-key');
    assert.equal(v.claude.apiKeyHint, '…1234');
    assert.ok(!JSON.stringify(v).includes('sk-ant-zzzz1234'));
    assert.equal(v.boat.baseUrl, 'https://boat.test/api/v1');
    assert.deepEqual(Object.keys(v.mcpServers).sort(), ['gh', 'loc']);
    const disk = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(disk.authToken, TOKEN, 'unrelated keys preserved');
    assert.equal(disk.claude.apiKey, 'sk-ant-zzzz1234');
    assert.equal(disk.claude.maxTurns, 12);
    assert.equal(disk.boat.apiKey, 'new-boat-key-9999');
    assert.equal(f.ctx.config.claude.maxTurns, 12, 'applied live');
    assert.equal(f.ctx.config.boat.apiKey, 'new-boat-key-9999');
    assert.equal(f.boatChanges.length, 1);
    assert.ok(events.some((e) => e.type === 'settings.updated' && e.settings.claude.maxTurns === 12));
    assert.ok(!JSON.stringify(events).includes('sk-ant-zzzz1234'));

    // unrelated patch: no boat change callback; null clears keys
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ claude: { apiKey: null, executablePath: null } }) });
    assert.equal(f.boatChanges.length, 1);
    const d2 = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(d2.claude.apiKey, undefined);
    assert.equal(d2.claude.executablePath, undefined);
    assert.equal(((await (await api('/api/settings')).json()) as any).claude.apiKeySet, false);

    // MCP secrets are masked in the view and in settings.updated; masked values mean "keep existing"
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ mcpServers: {
      gh: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer supersecret-token-1234', Short: 'abc' } },
      loc: { command: 'node', env: { API_TOKEN: 'abcdefgh-5678' } },
    } }) });
    const mv: any = await (await api('/api/settings')).json();
    assert.deepEqual(mv.mcpServers.gh.headers, { Authorization: '••••1234', Short: '••••' });
    assert.deepEqual(mv.mcpServers.loc.env, { API_TOKEN: '••••5678' });
    assert.ok(!JSON.stringify(events).includes('supersecret'));
    const keep = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ mcpServers: {
      gh: { type: 'http', url: 'https://x.test/other', headers: mv.mcpServers.gh.headers },
      loc: { command: 'node', env: { API_TOKEN: '••••5678', NEW: 'plain-value-xyz' } },
    } }) });
    assert.equal(keep.status, 200);
    const d3 = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(d3.mcpServers.gh.headers.Authorization, 'Bearer supersecret-token-1234');
    assert.equal(d3.mcpServers.gh.headers.Short, 'abc');
    assert.equal(d3.mcpServers.gh.url, 'https://x.test/other');
    assert.equal(d3.mcpServers.loc.env.API_TOKEN, 'abcdefgh-5678');
    assert.equal(d3.mcpServers.loc.env.NEW, 'plain-value-xyz');
    assert.equal((await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ mcpServers: { fresh: { command: 'x', env: { K: '••••zzzz' } } } }) })).status, 400);

    // boat test: given key vs saved key; never stores
    assert.deepEqual(await (await api('/api/settings/boat/test', { method: 'POST', body: '{"apiKey":"bad"}' })).json(), { ok: false, detail: '401 unauthorized' });
    assert.equal((await api('/api/settings/boat/test', { method: 'POST', body: '{"apiKey":"k","baseUrl":"nope"}' })).status, 400);
    assert.equal(((await (await api('/api/settings/boat/test', { method: 'POST', body: '{"apiKey":"k","baseUrl":"https://other.test/api"}' })).json()) as any).ok, true);
    assert.equal(f.lastBoatBase(), 'https://other.test/api');
    const good: any = await (await api('/api/settings/boat/test', { method: 'POST', body: '{"apiKey":"good-key"}' })).json();
    assert.equal(good.ok, true);
    assert.match(good.detail, /me@x\.io/);
    assert.equal(f.ctx.config.boat.apiKey, 'new-boat-key-9999');
    assert.equal(((await (await api('/api/settings/boat/test', { method: 'POST', body: '{}' })).json()) as any).ok, true);
    // clearing the boat key turns boat off
    await api('/api/settings', { method: 'PATCH', body: '{"boat":{"apiKey":null}}' });
    assert.equal(f.boatChanges.length, 2);
    assert.equal(f.ctx.boatConfigured(), false);
    assert.equal(((await (await api('/api/settings/boat/test', { method: 'POST', body: '{}' })).json()) as any).ok, false);
    off();
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
    assert.match(b.id, /^research-bot-[a-z0-9]{4,8}$/, 'a collision gets a random suffix, never -2');
    const c: any = await (await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Research Bot' }) })).json();
    assert.match(c.id, /^research-bot-[a-z0-9]{4,8}$/);
    assert.notEqual(c.id, b.id);

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
    assert.equal((await api(`/api/agents/${c.id}`, { method: 'DELETE' })).status, 200);
    assert.ok(events.some((e) => e.type === 'agent.deleted' && e.agentId === c.id));
    assert.ok(events.some((e) => e.type === 'agent.updated' && e.agent.id === 'research-bot'));
    off();
    const list: any[] = await (await api('/api/agents')).json();
    assert.ok(!list.some((x) => x.id === c.id));
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
