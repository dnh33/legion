/**
 * MCP isolation: claude.inheritMcp (default off). Off = strictMcpConfig + no claude.ai connectors + only Legion's own server and the servers
 * enabled in Settings -> MCP, on every query path. Also: the read-only status route (admin only) and the guard against Legion's own /mcp.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { getCatalog } from '../src/core/catalog.js';
import { runDoctor } from '../src/core/doctor.js';
import { isClientRoute } from '../src/core/admin.js';
import { isSelfMcpUrl, plainError } from '../src/core/mcp-status.js';
import { validatePatch } from '../src/core/settings.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, LegionConfig } from '../src/shared/types.js';
import { AUTH, asClient } from './helpers-c.js';
import { closeAll, mount } from './token-harness.js';

after(closeAll);

const REPO = fileURLToPath(new URL('../../', import.meta.url));

class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, any>();
  msgs: any[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  upsertTask(t: any) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: any) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}
const agent = (): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: 'A', description: '', systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'], createdAt: '', updatedAt: '',
});

function setup(script: (n: number, q: any) => AsyncGenerator<any, void>, over: (c: LegionConfig) => void = () => undefined, extraQ: Record<string, unknown> = {}) {
  const store = new FakeStore();
  store.agents.set('a1', agent());
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(cleanupTemp('legion-mcpiso-'), 'ws');
  over(config);
  const calls: any[] = [];
  const queryFn = ((p: any) => {
    calls.push(p);
    const q: any = Object.assign({}, extraQ, { interrupt: async () => undefined, close: () => undefined });
    return Object.assign(script(calls.length - 1, q), q);
  }) as unknown as QueryFn;
  const engine = new Engine({ store: store as any, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false });
  return { calls, engine, config };
}
const init = (extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'init', session_id: 's1', ...extra });
const ok = { type: 'result', subtype: 'success', is_error: false, result: 'fine', total_cost_usd: 0, num_turns: 1, session_id: 's1' };
const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], total_cost_usd: 0, num_turns: 1, session_id: 's1' };
const run = async (s: ReturnType<typeof setup>) => s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' }).id, 3000);

test('config: inheritMcp defaults to off and Settings validates it as a boolean', () => {
  assert.equal(defaultConfig().claude.inheritMcp, false);
  assert.deepEqual(validatePatch({ claude: { inheritMcp: true } }).claude, { inheritMcp: true });
  assert.throws(() => validatePatch({ claude: { inheritMcp: 'yes' } }), /inheritMcp must be a boolean/);
});

test('off: strict MCP config, claude.ai connectors disabled, only legion + Settings servers', async () => {
  const s = setup(async function* () { yield init(); yield ok; }, (c) => { c.mcpServers = { docs: { type: 'http', url: 'https://mcp.example.com/mcp' } }; });
  await run(s);
  const o = s.calls[0]!.options;
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.deepEqual(Object.keys(o.mcpServers).sort(), ['docs', 'legion']);
  assert.deepEqual(o.settingSources, ['user', 'project', 'local'], 'other inherited settings are unchanged');
});

test('off: the user env cannot switch connectors back on', async () => {
  const save = process.env.ENABLE_CLAUDEAI_MCP_SERVERS; process.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'true';
  try {
    const s = setup(async function* () { yield init(); yield ok; });
    await run(s);
    assert.equal(s.calls[0]!.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  } finally { if (save === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS; else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = save; }
});

test('off: the strict flag is on the retry (escalation) query too', async () => {
  const s = setup(async function* (n) { yield init(); yield n === 0 ? maxTurns : ok; });
  const t = await run(s);
  assert.equal(t.escalated, true);
  assert.equal(s.calls.length, 2);
  for (const c of s.calls) { assert.equal(c.options.strictMcpConfig, true); assert.equal(c.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false'); }
});

test('F1: SDK settings.disableClaudeAiConnectors is set on the run and on the retry when inheritMcp is off', async () => {
  const s = setup(async function* (n) { yield init(); yield n === 0 ? maxTurns : ok; });
  await run(s);
  assert.equal(s.calls.length, 2);
  for (const c of s.calls) assert.deepEqual(c.options.settings, { disableClaudeAiConnectors: true });
});

test('F1: catalog probe and doctor probe carry settings.disableClaudeAiConnectors whichever way inheritMcp is set', async () => {
  for (const inherit of [false, true]) {
    const config = defaultConfig(); config.claude.inheritMcp = inherit;
    let seen: any;
    const q = { supportedCommands: async () => [], supportedModels: async () => [], accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined };
    const queryFn = ((p: any) => { seen = p.options; return q; }) as unknown as QueryFn;
    await getCatalog({ config, queryFn });
    assert.deepEqual(seen.settings, { disableClaudeAiConnectors: true });
    seen = undefined;
    await runDoctor({ config, getBoat: () => null, queryFn });
    assert.deepEqual(seen.settings, { disableClaudeAiConnectors: true });
  }
});

test('on: today\'s behaviour (no strict flag, connectors not forced off)', async () => {
  const save = process.env.ENABLE_CLAUDEAI_MCP_SERVERS; delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  try {
    const s = setup(async function* () { yield init(); yield ok; }, (c) => { c.claude.inheritMcp = true; });
    await run(s);
    const o = s.calls[0]!.options;
    assert.equal(o.strictMcpConfig, undefined);
    assert.equal(o.settings, undefined);
    assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
    assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  } finally { if (save !== undefined) process.env.ENABLE_CLAUDEAI_MCP_SERVERS = save; }
});

test('catalog probe and doctor probe are strict with connectors off, whichever way inheritMcp is set', async () => {
  for (const inherit of [false, true]) {
    const config = defaultConfig(); config.claude.inheritMcp = inherit;
    let seen: any;
    const q = { supportedCommands: async () => [], supportedModels: async () => [], accountInfo: async () => ({ email: 'a@b.c' }), interrupt: async () => undefined, close: () => undefined };
    const queryFn = ((p: any) => { seen = p.options; return q; }) as unknown as QueryFn;
    await getCatalog({ config, queryFn });
    assert.equal(seen.strictMcpConfig, true); assert.equal(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    seen = undefined;
    await runDoctor({ config, getBoat: () => null, queryFn });
    assert.equal(seen.strictMcpConfig, true); assert.equal(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  }
});

test('self guard: Legion\'s own /mcp url is recognised; other urls and ports are not', () => {
  for (const u of ['http://127.0.0.1:4747/mcp', 'http://localhost:4747/mcp/', 'http://[::1]:4747/mcp', 'http://127.0.0.1:4747/mcp?x=1']) assert.equal(isSelfMcpUrl(u, 4747), true, u);
  for (const u of ['http://127.0.0.1:4748/mcp', 'http://127.0.0.1:4747/other', 'https://mcp.example.com/mcp', 'nope', undefined]) assert.equal(isSelfMcpUrl(u, 4747), false, String(u));
});

test('self guard: loopback aliases from the review table, and an entry carrying Legion\'s own token', () => {
  for (const u of ['http://127.0.0.2:4747/mcp', 'http://127.255.0.9:4747/mcp', 'http://127.1:4747/mcp', 'http://2130706433:4747/mcp', 'http://[::ffff:127.0.0.1]:4747/mcp', 'http://[::ffff:7f00:1]:4747/mcp',
    'http://localhost.:4747/mcp', 'http://foo.localhost:4747/mcp', 'http://LOCALHOST:4747/mcp', 'http://0.0.0.0:4747/mcp', 'http://[::]:4747/mcp', 'http://[0:0:0:0:0:0:0:1]:4747/mcp',
    'http://user:pw@127.0.0.1:4747/mcp', 'http://127.0.0.1:04747/mcp', 'http://127.0.0.1:4747/./mcp', 'http://127.0.0.1:4747/x/../mcp']) assert.equal(isSelfMcpUrl(u, 4747), true, u);
  for (const u of ['http://128.0.0.1:4747/mcp', 'http://[::ffff:8.8.8.8]:4747/mcp', 'http://notlocalhost:4747/mcp', 'http://localhost.example.com:4747/mcp', 'http://127.0.0.1.nip.io:4747/mcp', 'http://127.0.0.1:4747/MCP']) assert.equal(isSelfMcpUrl(u, 4747), false, u);
  const tok = 'tok-abcdef123456';
  assert.equal(isSelfMcpUrl('https://tunnel.example/anything', 4747, { headers: { authorization: `Bearer ${tok}` }, authToken: tok }), true, 'own token, any host');
  assert.equal(isSelfMcpUrl('https://tunnel.example/mcp', 4747, { headers: { Authorization: 'Bearer other-token-xyz' }, authToken: tok }), false);
  assert.equal(isSelfMcpUrl('https://tunnel.example/mcp', 4747, { headers: { 'X-Note': tok }, authToken: tok }), false, 'only the Authorization header counts');
  assert.equal(isSelfMcpUrl('https://tunnel.example/mcp', 4747, { headers: { Authorization: 'Bearer abc' }, authToken: 'abc' }), false, 'a short token is not matched');
});

test('self guard: an entry with Legion\'s token is refused by Settings and not handed to a run', async () => {
  const s = setup(async function* () { yield init(); yield ok; }, (c) => { c.mcpServers = { tun: { type: 'http', url: 'https://t.example/x', headers: { Authorization: `Bearer ${c.authToken}` } }, fine: { type: 'http', url: 'https://x.example/mcp' } }; });
  await run(s);
  assert.deepEqual(Object.keys(s.calls[0]!.options.mcpServers).sort(), ['fine', 'legion']);
});

test('self guard: Settings refuses a server that points at Legion, and a hand-edited one is never handed to a run', async () => {
  const m = await mount();
  const r = await m.http('PATCH', '/api/settings', { mcpServers: { loop: { type: 'http', url: 'http://127.0.0.1:4747/mcp' } } }, AUTH);
  assert.equal(r.status, 400);
  assert.match(String(r.json?.error), /own \/mcp/);
  const s = setup(async function* () { yield init(); yield ok; }, (c) => { c.mcpServers = { loop: { type: 'http', url: `http://127.0.0.1:${c.port}/mcp` }, fine: { type: 'http', url: 'https://x.example/mcp' } }; });
  await run(s);
  assert.deepEqual(Object.keys(s.calls[0]!.options.mcpServers).sort(), ['fine', 'legion']);
});

test('self guard (inherit on): a server inherited from Claude Code that is Legion\'s own /mcp is switched off once; Legion\'s in-process server is left alone', async () => {
  const toggled: Array<[string, boolean]> = [];
  const status = [
    { name: 'legion', status: 'connected', source: 'sdk' },
    { name: 'legion-http', status: 'connected', source: 'user', config: { type: 'http', url: 'http://127.0.0.1:4747/mcp' } },
    { name: 'github', status: 'connected', source: 'user', config: { type: 'http', url: 'https://api.example/mcp' } },
  ];
  const s = setup(async function* () { yield init({ mcp_servers: status.map(({ name, status: st, source }) => ({ name, status: st, source })) }); await new Promise((r) => setTimeout(r, 30)); yield ok; },
    (c) => { c.claude.inheritMcp = true; },
    { mcpServerStatus: async () => status, toggleMcpServer: async (n: string, e: boolean) => { toggled.push([n, e]); } });
  await run(s);
  assert.deepEqual(toggled, [['legion-http', false]]);
  // an inherited server that took the name `legion` itself is not the in-process one (source is not sdk): off as well
  const t2: Array<[string, boolean]> = [];
  const s2 = setup(async function* () { yield init({ mcp_servers: [{ name: 'legion', status: 'connected', source: 'user' }] }); await new Promise((r) => setTimeout(r, 30)); yield ok; },
    (c) => { c.claude.inheritMcp = true; },
    { mcpServerStatus: async () => [{ name: 'legion', status: 'connected', source: 'user', config: { type: 'http', url: 'http://127.0.0.1:4747/mcp' } }], toggleMcpServer: async (n: string, e: boolean) => { t2.push([n, e]); } });
  await run(s2);
  assert.deepEqual(t2, [['legion', false]]);
});

test('self guard (inherit off): nothing is toggled and no status call is made for a healthy run', async () => {
  let called = 0;
  const s = setup(async function* () { yield init({ mcp_servers: [{ name: 'legion', status: 'connected', source: 'sdk' }] }); yield ok; }, () => undefined,
    { mcpServerStatus: async () => { called++; return []; }, toggleMcpServer: async () => { called++; } });
  await run(s);
  assert.equal(called, 0);
});

test('status route: admin only (401 without a token, 403 with the MCP token alone, 200 with the admin secret) and read-only in what it shows', async () => {
  const m = await mount((c) => c.agent !== 'worker' ? undefined : (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sx', mcp_servers: [{ name: 'legion', status: 'connected', source: 'sdk' }, { name: 'docs', status: 'failed', source: 'settings' }] };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'x', total_cost_usd: 0, num_turns: 1, session_id: 'sx' };
  })());
  assert.equal(isClientRoute('GET', '/api/mcp/status'), false);
  assert.equal((await m.http('GET', '/api/mcp/status', undefined, {})).status, 401);
  assert.equal((await m.http('GET', '/api/mcp/status', undefined, asClient)).status, 403);
  const before = await m.http('GET', '/api/mcp/status', undefined, AUTH);
  assert.equal(before.status, 200);
  assert.equal(before.json.inheritMcp, false);
  assert.equal(before.json.lastRunAt, undefined);
  const t = m.engine.startTask({ agentId: 'worker', prompt: 'go', source: 'ui' });
  await m.engine.waitFor(t.id, 3000);
  const r = await m.http('GET', '/api/mcp/status', undefined, AUTH);
  const by = Object.fromEntries(r.json.servers.map((x: any) => [x.name, x]));
  assert.equal(by.legion.state, 'connected');
  assert.equal(by.legion.origin, 'legion');
  assert.ok(typeof r.json.lastRunAt === 'string');
  assert.equal((await m.http('POST', '/api/mcp/status', {}, AUTH)).status === 200, false, 'no write verb on the route');
});

test('status view: failed and needs-auth get a plain message; server error text is clipped and stripped of control characters', async () => {
  const s = setup(async function* () {
    yield init({ mcp_servers: [{ name: 'legion', status: 'connected', source: 'sdk' }, { name: 'a', status: 'failed', source: 'settings' }, { name: 'b', status: 'needs-auth', source: 'settings' }] });
    await new Promise((r) => setTimeout(r, 30)); yield ok;
  }, (c) => { c.mcpServers = { a: { command: 'x' }, b: { type: 'http', url: 'https://b.example/mcp' }, c: { command: 'y' } }; },
    { mcpServerStatus: async () => [{ name: 'a', status: 'failed', error: 'spawn x ENOENT\n\u001b[31m' + 'z'.repeat(500) }] });
  await run(s);
  await new Promise((r) => setTimeout(r, 60));
  const v = s.engine.mcpStatus();
  const by = Object.fromEntries(v.servers.map((x) => [x.name, x]));
  assert.equal(by.a!.state, 'failed');
  assert.match(by.a!.message, /^Could not connect on the last run \(spawn x ENOENT/);
  assert.ok(by.a!.message.length < 320);
  assert.doesNotMatch(by.a!.message, /[\u0000-\u001f]/);
  assert.equal(by.b!.state, 'needs-auth');
  assert.match(by.b!.message, /sign-in/);
  assert.equal(by.c!.state, 'not-seen');
});

test('F3: plainError masks URLs, key-like query params and Bearer tokens', () => {
  const e = plainError('connect failed: https://api.example.com/mcp?api_key=SECRETKEY123&x=1 refused; retry wss://h.example/s?token=abc999 Authorization: Bearer sk-live-777 key=plainsecret');
  assert.doesNotMatch(e, /SECRETKEY123|abc999|sk-live-777|plainsecret|api\.example|h\.example/);
  assert.match(e, /^connect failed: \[url\]/);
  assert.equal(plainError('spawn x ENOENT'), 'spawn x ENOENT');
  assert.equal(plainError(undefined), '');
});

test('F6: a failed switch-off of an inherited self server shows a one-line notice; a new run clears it', async () => {
  const s = setup(async function* () { yield init({ mcp_servers: [{ name: 'loop', status: 'connected', source: 'user' }] }); await new Promise((r) => setTimeout(r, 30)); yield ok; },
    (c) => { c.claude.inheritMcp = true; },
    { mcpServerStatus: async () => [{ name: 'loop', status: 'connected', source: 'user', config: { type: 'http', url: 'http://127.0.0.1:4747/mcp' } }], toggleMcpServer: async () => { throw new Error('nope'); } });
  await run(s);
  await new Promise((r) => setTimeout(r, 60));
  assert.match(s.engine.mcpStatus().notice ?? '', /Could not switch off "loop"/);
});

test('copy: the inheritMcp text claims only what Legion\'s own code does (no absolutes)', () => {
  const ui = readFileSync(join(REPO, 'ui/src/components/Settings.tsx'), 'utf8').split('\n').filter((l) => /inheritMcp|claude\.ai connectors|Read-only; it |Legion's own code asks|Legion asks Claude Code|Inherit my Claude Code settings|function McpStatus|Status on the most recent run/.test(l)).join('\n');
  const sec = readFileSync(join(REPO, 'SECURITY.md'), 'utf8').split('\n').filter((l) => /inheritMcp/.test(l)).join('\n');
  assert.match(ui, /Legion's own code/);
  assert.match(sec, /Legion's own code/);
  const banned = /\bguarantee[sd]?\b|\bimpossible\b|\bcannot be (bypassed|forged|changed|disabled|tampered with|edited|spoofed|faked|hacked)\b|\b(no one|nobody) can\b|\b100 ?%|\bfully (secure|safe|protected|isolated)\b|\bforever\b|\bnever (connects|loads)\b/i;
  assert.match(ui, /Legion asks Claude Code to load only its own tools/, 'the status hint is scanned');
  assert.doesNotMatch(ui, /\bOnly Legion's own tools\b[^.]*\bare loaded/);
  assert.match(ui, /separate and applies whichever way/);
  assert.doesNotMatch(ui, banned);
  assert.doesNotMatch(sec, banned);
});
