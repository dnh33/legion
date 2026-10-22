/**
 * Legion's own tools for an agent host (Hermes): the per-run key, the loopback route behind it, the allow list, the per-call
 * enforcement and the stdio shim. Every test starts the real core server on a free port and stops what it started.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { gate } from '../src/core/admin.js';
import { addLegionSecret, buildAgentEnv, forgetLegionSecrets, registerLegionSecrets } from '../src/core/acp/process.js';
import { findRunGrant, issueRunToken, revokeAllRunTokens, shimServer } from '../src/core/acp/run-tokens.js';
import type { RunToken, RunToolsHost } from '../src/core/acp/run-tokens.js';
import { buildAgentToolsServer } from '../src/core/agent-tools.js';
import { clearRegisteredSecrets, redact, registerSecret, unregisterSecret } from '../src/core/log/redact.js';
import { RUN_TOOL_ALLOW, RUN_TOOL_WAIT_MAX_S, serverForRun } from '../src/core/acp/run-tools.js';
import { makeFakes, start, TEST_ADMIN, TOKEN } from './helpers-c.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const textOf = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves when `ready` is called; lets a test hold a tool open. */
function gateOf(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  return { wait, release };
}

interface RunFixture {
  task: string; agent: string; run: RunToken; host: RunToolsHost;
  noted: Array<{ name: string; id: string; input: unknown }>;
  authorized: Array<{ name: string; input: unknown }>;
  rows: Array<{ kind: 'call' | 'result'; name?: string; id: string; text?: string }>;
  bridgeCalls: string[];
  /** The timeoutSeconds each `ask` reached the tool with. */
  askTimeouts: unknown[];
  /** The signal tool (room_read, with `signalTool`): calls started, and calls that saw their signal abort. */
  sigStarted: number; sigAborted: number;
  hold?: { wait: Promise<void>; release: () => void };
  cancel(): void;
}

/** A run with the real `legion` tool server (vm tools on), a fake rooms server and two servers that must never be reachable. */
function makeRun(task: string, agent: string, o: { deny?: (name: string) => string | undefined; throws?: boolean; hold?: boolean; signalTool?: boolean; listText?: string; redact?: (text: string) => string } = {}): RunFixture {
  const fx = { task, agent, noted: [], authorized: [], rows: [], bridgeCalls: [], askTimeouts: [], sigStarted: 0, sigAborted: 0 } as unknown as RunFixture;
  if (o.hold) fx.hold = gateOf();
  const bridge = {
    list: () => [{ id: 'scout' }],
    ask: async (t: string, to: string, m: string, opts?: { timeoutSeconds?: number }) => { fx.bridgeCalls.push(`ask:${t}:${to}:${m}`); fx.askTimeouts.push(opts?.timeoutSeconds); if (fx.hold) await fx.hold.wait; return `answer from ${to}`; },
    tell: async (t: string, to: string, m: string) => { fx.bridgeCalls.push(`tell:${t}:${to}:${m}`); return `told ${to}`; },
    taskResult: async () => 'full text',
    resolveModel: async () => undefined,
  };
  const vms = { touch: () => undefined, ensureRunning: async () => { fx.bridgeCalls.push('vm_start'); return { state: 'running' }; }, usage: () => ({}), claudeAvailable: () => true, exec: async () => ({ exitCode: 0, stdout: 'ran', stderr: '' }) };
  const legion = buildAgentToolsServer({ agentId: agent, taskId: task, vms: vms as never, bridge: bridge as never, vmEnabled: true, claudeAvailable: true });
  const roomTools = ['bot_list', 'bot_send', 'room_post', 'room_read', 'room_list', 'handoff', 'room_create', 'room_add_member', 'room_remove_member', 'room_export'];
  const legionComms = createSdkMcpServer({ name: 'legion_comms', version: '1', tools: roomTools.map((n) => tool(n, `rooms: ${n}`, { x: z.string().optional() }, async (a, extra) => {
    fx.bridgeCalls.push(`${n}:${a.x ?? ''}`);
    if (o.signalTool && n === 'room_read') {
      const sig = (extra as { signal: AbortSignal }).signal;
      fx.sigStarted++;
      if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener('abort', () => r(), { once: true }));
      fx.sigAborted++;
      return ok('room_read cut');
    }
    return ok(n === 'room_list' && o.listText ? o.listText : `${n} done`);
  })) });
  const wallet = createSdkMcpServer({ name: 'legion_bsv', version: '1', tools: [tool('balance', 'wallet balance', {}, async () => { fx.bridgeCalls.push('balance'); return ok('1 BSV'); })] });
  const shell = createSdkMcpServer({ name: 'host', version: '1', tools: [tool('exec', 'run a command', { command: z.string() }, async (a) => { fx.bridgeCalls.push(`exec:${a.command}`); return ok('ran'); })] });
  const ac = new AbortController();
  let cancelled = false;
  fx.cancel = () => { cancelled = true; ac.abort(); };
  fx.host = {
    servers: { legion, legion_comms: legionComms, legion_bsv: wallet, host: shell } as never,
    authorize: async (name, input) => {
      fx.authorized.push({ name, input });
      if (o.throws) throw new Error('decider exploded');
      const why = o.deny?.(name);
      return why ? { allow: false, message: why } : { allow: true };
    },
    noteToolUse: (name, id, input) => { fx.noted.push({ name, id, input }); },
    onToolCall: (name, id) => { fx.rows.push({ kind: 'call', name, id }); },
    onToolResult: (id, text) => { fx.rows.push({ kind: 'result', id, text }); },
    onNotice: () => undefined,
    cancelled: () => cancelled,
    signal: ac.signal,
    ...(o.redact ? { redact: o.redact } : {}),
  };
  fx.run = issueRunToken(task, agent);
  fx.run.bind(fx.host);
  return fx;
}

const ALLOWED_LEGION = ['agents', 'ask', 'ask_user_question', 'task_result', 'tell'];
const ALLOWED_ROOMS = ['bot_list', 'bot_send', 'handoff', 'room_add_member', 'room_create', 'room_list', 'room_post', 'room_read', 'room_remove_member'];
const ALLOWED_ALL = [...ALLOWED_LEGION, ...ALLOWED_ROOMS].sort();

describe('acp tools route', () => {
  const f = makeFakes();
  let base = '';
  let port = 0;
  let stop: () => Promise<void>;
  const clients: Client[] = [];
  const open: RunFixture[] = [];

  before(async () => {
    registerLegionSecrets([TOKEN, TEST_ADMIN]);
    const s = await start(f.ctx);
    base = s.base; port = Number(new URL(s.base).port); stop = s.close;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
    for (const r of open.splice(0)) r.run.revoke();
  });
  after(async () => {
    revokeAllRunTokens();
    await stop();
    forgetLegionSecrets();
    clearRegisteredSecrets();
  });

  const run = (task: string, agent: string, o?: Parameters<typeof makeRun>[2]) => { const r = makeRun(task, agent, o); open.push(r); return r; };
  const url = () => new URL(base + '/mcp/run/legion');
  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(url(), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  }
  const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const post = (path: string, headers: Record<string, string>, body = INIT) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body });
  /** Raw request so Host and Origin can be forged (fetch refuses to set Host). */
  function raw(path: string, headers: Record<string, string>, method = 'POST', body = INIT): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject); r.write(body); r.end();
    });
  }

  describe('the key', () => {
    it('is 32 random bytes in hex, one per run, and a Legion secret (cleaned from an agent\'s environment, masked in logs) until it ends', () => {
      const a = run('t-a', 'zealot'); const b = run('t-b', 'scout');
      assert.match(a.run.token, /^[0-9a-f]{64}$/);
      assert.notEqual(a.run.token, b.run.token);
      assert.equal(redact(`x ${a.run.token} y`).includes(a.run.token), false);
      const env = (t: string) => buildAgentEnv({ base: { PATH: '/bin', NOTE_TEXT: `pre-${t}-post`, PLAIN: 'ok' }, stripSkipFlags: false });
      assert.equal(env(a.run.token).NOTE_TEXT, undefined, 'a variable holding the key never reaches the agent');
      assert.equal(env(a.run.token).PLAIN, 'ok');
      a.run.revoke();
      assert.equal(env(a.run.token).NOTE_TEXT, `pre-${a.run.token}-post`, 'a revoked key is no longer a live secret');
      assert.equal(env(b.run.token).NOTE_TEXT, undefined, 'the other run is untouched');
    });

    it('revoke is idempotent and removes only the key it issued', () => {
      const other = 'another-subsystem-secret-0123456789';
      addLegionSecret(other);
      const a = run('t-i', 'zealot');
      a.run.revoke(); a.run.revoke();
      assert.equal(redact(other).includes(other), false, 'a secret the run key did not issue is still registered');
      assert.equal(findRunGrant(a.run.token), undefined);
    });

    it('finds a live key only, by constant-time compare, and carries its task and agent', () => {
      const a = run('t-f', 'zealot');
      const g = findRunGrant(a.run.token);
      assert.ok(g);
      assert.equal(g.taskId, 't-f'); assert.equal(g.agentId, 'zealot');
      assert.equal(findRunGrant(a.run.token.slice(0, -1) + (a.run.token.endsWith('0') ? '1' : '0')), undefined);
      assert.equal(findRunGrant(''), undefined);
      assert.equal(findRunGrant(a.run.token + 'x'), undefined);
    });

    it('shimServer: the exact shape, key in env and never in argv', () => {
      const s = shimServer('abc123tokenvalue', 4747);
      assert.equal(s.name, 'legion');
      assert.equal(s.command, process.execPath);
      assert.equal(s.args.length, 1);
      assert.ok(isAbsolute(s.args[0]!) && /legion-acp-tools-stdio\.js$/.test(s.args[0]!), s.args[0]);
      assert.ok(existsSync(s.args[0]!), 'the compiled shim is where shimServer points');
      assert.deepEqual(s.env, [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'LEGION_RUN_URL', value: 'http://127.0.0.1:4747/mcp/run/legion' },
        { name: 'LEGION_RUN_TOKEN', value: 'abc123tokenvalue' },
      ]);
      assert.equal(JSON.stringify(s.args).includes('abc123tokenvalue'), false);
    });
  });

  describe('who gets in', () => {
    it('no key, a wrong key, a revoked key and a key for no host are all 401', async () => {
      const a = run('t-401', 'zealot');
      assert.equal((await post('/mcp/run/legion', {})).status, 401);
      assert.equal((await post('/mcp/run/legion', { Authorization: 'Bearer nope' })).status, 401);
      const flipped = a.run.token.slice(0, 63) + (a.run.token.endsWith('a') ? 'b' : 'a');
      assert.equal((await post('/mcp/run/legion', { Authorization: `Bearer ${flipped}` })).status, 401, 'one wrong character');
      const unbound = issueRunToken('t-unbound', 'zealot');
      assert.equal((await post('/mcp/run/legion', { Authorization: `Bearer ${unbound.token}` })).status, 401, 'a key with no run attached fails closed');
      unbound.revoke();
      assert.equal((await post('/mcp/run/legion', { Authorization: `Bearer ${a.run.token}` })).status, 200);
      a.run.revoke();
      const after = await post('/mcp/run/legion', { Authorization: `Bearer ${a.run.token}` });
      assert.equal(after.status, 401);
      assert.match(after.headers.get('www-authenticate') ?? '', /Bearer/);
    });

    it('the key is read from the Authorization header only, never from the address', async () => {
      const a = run('t-q', 'zealot');
      assert.equal((await post(`/mcp/run/legion?token=${a.run.token}`, {})).status, 401);
      assert.equal((await post(`/mcp/run/${a.run.token}/legion`, {})).status, 401);
    });

    it('the main authToken and the admin secret do not open the run route', async () => {
      run('t-main', 'zealot');
      assert.equal((await post('/mcp/run/legion', { Authorization: `Bearer ${TOKEN}` })).status, 401);
      assert.equal((await post('/mcp/run/legion', { Authorization: `Bearer ${TOKEN}`, 'X-Legion-Admin': TEST_ADMIN })).status, 401);
      assert.equal((await post('/mcp/run/legion', { 'X-Legion-Admin': TEST_ADMIN })).status, 401);
    });

    it('a run key does not open /mcp or /api', async () => {
      const a = run('t-cross', 'zealot');
      const h = { Authorization: `Bearer ${a.run.token}` };
      assert.equal((await post('/mcp', h)).status, 401);
      assert.equal((await fetch(base + '/api/state', { headers: h })).status, 401);
      assert.equal((await fetch(base + '/api/agents', { headers: h })).status, 401);
      assert.equal((await post('/api/tasks', h, JSON.stringify({ agentId: 'zealot', prompt: 'x' }))).status, 401);
      // control: the same routes still answer to the main token
      assert.equal((await fetch(base + '/api/agents', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    });

    it('the gate decides it: a run path is open to a run key only, whatever else is presented', () => {
      const g = { method: 'POST', path: '/mcp/run/legion', adminOk: false, bearerOk: false, hasSecret: true };
      assert.deepEqual(gate({ ...g, runOk: true }), { allow: true, admin: false });
      for (const extra of [{}, { adminOk: true }, { bearerOk: true }, { adminOk: true, bearerOk: true }]) {
        const d = gate({ ...g, ...extra });
        assert.equal(d.allow, false, JSON.stringify(extra));
      }
      assert.equal(gate({ ...g, path: '/mcp/run/other', adminOk: true }).allow, false);
      assert.equal(gate({ ...g, path: '/mcp/run/', adminOk: true }).allow, false);
      // a run key means nothing anywhere else
      assert.equal(gate({ method: 'POST', path: '/mcp', adminOk: false, bearerOk: false, hasSecret: true, runOk: true }).allow, false);
      assert.equal(gate({ method: 'GET', path: '/api/state', adminOk: false, bearerOk: false, hasSecret: true, runOk: true }).allow, false);
      assert.equal(gate({ method: 'POST', path: '/mcp', adminOk: false, bearerOk: true, hasSecret: true }).allow, true);
    });

    it('only POST to /mcp/run/legion; another name is 404 and another method is 405', async () => {
      const a = run('t-m', 'zealot');
      const h = { Authorization: `Bearer ${a.run.token}` };
      assert.equal((await post('/mcp/run/other', h)).status, 404);
      assert.equal((await post('/mcp/run/legion/extra', h)).status, 404);
      assert.equal((await fetch(base + '/mcp/run/legion', { method: 'GET', headers: h })).status, 405);
      assert.equal((await fetch(base + '/mcp/run/legion', { method: 'DELETE', headers: h })).status, 405);
    });

    it('the loopback guard still applies: a forged Host is 421, any Origin is refused', async () => {
      const a = run('t-g', 'zealot');
      const h = { Authorization: `Bearer ${a.run.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      assert.equal((await raw('/mcp/run/legion', { ...h, Host: 'evil.example' })).status, 421);
      assert.equal((await raw('/mcp/run/legion', { ...h, Host: `127.0.0.1:${port}` })).status, 200);
      assert.equal((await raw('/mcp/run/legion', { ...h, Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' })).status, 403);
      // an allowed browser origin is not enough either: the shim is not a browser
      assert.equal((await raw('/mcp/run/legion', { ...h, Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` })).status, 403);
      assert.equal((await raw('/mcp/run/legion', { ...h, Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 403);
      assert.equal((await raw('/mcp/run/legion', { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }, 'OPTIONS')).status, 403);
    });
  });

  describe('which tools', () => {
    it('lists the allow list under bare names and nothing else', async () => {
      const a = run('t-l', 'zealot');
      const c = await connect(a.run.token);
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, ALLOWED_ALL);
      for (const t of (await c.listTools()).tools) assert.ok((t.description ?? '').length > 5 && t.inputSchema, t.name);
    });

    it('the tools it hides exist underneath (the fixture is honest) and are refused by name', async () => {
      const a = run('t-h', 'zealot');
      // underneath: the same server really carries vm_exec, and the other servers really carry their tools
      const under = await import('@modelcontextprotocol/sdk/inMemory.js');
      const probe = buildAgentToolsServer({ agentId: 'zealot', taskId: 'probe', vms: { touch: () => undefined } as never, bridge: {} as never, vmEnabled: true, claudeAvailable: true });
      const [ct, st] = under.InMemoryTransport.createLinkedPair();
      await (probe.instance as unknown as { connect(t: unknown): Promise<void> }).connect(st);
      const pc = new Client({ name: 'probe', version: '0' }); await pc.connect(ct); clients.push(pc);
      assert.ok((await pc.listTools()).tools.some((t) => t.name === 'vm_exec'));

      const c = await connect(a.run.token);
      for (const name of ['vm_exec', 'vm_start', 'vm_claude', 'web_search', 'todo_create', 'balance', 'exec', 'room_export', 'legion_run', 'create_agent', 'mcp__legion__vm_exec', 'mcp__host__exec', '']) {
        const r = await c.callTool({ name, arguments: { command: 'whoami' } });
        assert.equal((r as { isError?: boolean }).isError, true, name);
        assert.match(textOf(r), /not a tool you have/, name);
      }
      assert.deepEqual(a.noted, [], 'a refused call is not noted as a tool use and never reaches the decision');
      assert.deepEqual(a.authorized, []);
      assert.deepEqual(a.bridgeCalls, [], 'no hidden tool ran');
      assert.ok(a.rows.some((r) => r.kind === 'result' && /not a tool you have/.test(r.text ?? '')), 'the refusal is in the thread');
    });
  });

  describe('every call', () => {
    it('is noted for taint, decided, run, and written as a call row and a result row under the full tool name', async () => {
      const a = run('t-c', 'zealot');
      const c = await connect(a.run.token);
      const r = await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'hello' } });
      assert.equal((r as { isError?: boolean }).isError, undefined);
      assert.equal(textOf(r), 'answer from scout');
      assert.deepEqual(a.bridgeCalls, ['ask:t-c:scout:hello'], 'the tool ran for its own task');
      assert.equal(a.noted.length, 1);
      assert.equal(a.noted[0]!.name, 'mcp__legion__ask');
      assert.deepEqual(a.noted[0]!.input, { agent: 'scout', message: 'hello', timeoutSeconds: 270 }, 'an ask with no wait gets the 270 s default');
      assert.deepEqual(a.authorized, [{ name: 'mcp__legion__ask', input: { agent: 'scout', message: 'hello', timeoutSeconds: 270 } }]);
      const call = a.rows.find((x) => x.kind === 'call')!;
      const res = a.rows.find((x) => x.kind === 'result')!;
      assert.equal(call.name, 'mcp__legion__ask');
      assert.equal(res.id, call.id, 'the result row answers the call row');
      assert.equal(res.text, 'answer from scout');

      await c.callTool({ name: 'room_post', arguments: { x: 'hi' } });
      assert.equal(a.noted[1]!.name, 'mcp__legion_comms__room_post');
      assert.equal(a.authorized[1]!.name, 'mcp__legion_comms__room_post');
    });

    it('gets a fresh call id each time, so taint is never skipped as a repeat', async () => {
      const a = run('t-id', 'zealot');
      const c = await connect(a.run.token);
      await c.callTool({ name: 'agents', arguments: {} });
      await c.callTool({ name: 'agents', arguments: {} });
      await c.callTool({ name: 'agents', arguments: {} });
      assert.equal(a.noted.length, 3);
      assert.equal(new Set(a.noted.map((n) => n.id)).size, 3);
    });

    it('a refusal by the decision is a tool error with its words, and the tool does not run', async () => {
      const a = run('t-d', 'zealot', { deny: (n) => (n.endsWith('__tell') ? 'The owner said no to tell.' : undefined) });
      const c = await connect(a.run.token);
      const r = await c.callTool({ name: 'tell', arguments: { agent: 'scout', message: 'x' } });
      assert.equal((r as { isError?: boolean }).isError, true);
      assert.equal(textOf(r), 'The owner said no to tell.');
      assert.deepEqual(a.bridgeCalls, []);
      assert.equal(a.noted.length, 1, 'taint still sees the attempt');
      assert.equal(a.rows.find((x) => x.kind === 'result')!.text, 'The owner said no to tell.');
      // the run goes on
      assert.equal(textOf(await c.callTool({ name: 'agents', arguments: {} })).includes('scout'), true);
    });

    it('a decision that throws fails closed: an error result, the tool does not run, the core stays up', async () => {
      const a = run('t-x', 'zealot', { throws: true });
      const c = await connect(a.run.token);
      const r = await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'x' } });
      assert.equal((r as { isError?: boolean }).isError, true);
      assert.deepEqual(a.bridgeCalls, []);
      assert.equal((await fetch(base + '/health')).status, 200);
    });

    it('a key for task A reaches only task A: B\'s host is never touched', async () => {
      const a = run('task-A', 'zealot'); const b = run('task-B', 'scout');
      const ca = await connect(a.run.token);
      await ca.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'from A' } });
      assert.deepEqual(a.bridgeCalls, ['ask:task-A:scout:from A']);
      assert.deepEqual(b.bridgeCalls, []); assert.deepEqual(b.noted, []); assert.deepEqual(b.rows, []);
      const cb = await connect(b.run.token);
      await cb.callTool({ name: 'tell', arguments: { agent: 'zealot', message: 'from B' } });
      assert.deepEqual(b.bridgeCalls, ['tell:task-B:zealot:from B']);
      assert.equal(a.bridgeCalls.length, 1);
      // a task or agent named in the request changes nothing
      const rowsOfB = b.rows.length;
      const r = await post('/mcp/run/legion', { Authorization: `Bearer ${a.run.token}`, 'X-Legion-Task': 'task-B', 'X-Legion-Agent': 'scout' });
      assert.equal(r.status, 200);
      assert.equal(b.rows.length, rowsOfB);
    });

    it('ending one run leaves another working', async () => {
      const a = run('t-end-a', 'zealot'); const b = run('t-end-b', 'scout');
      const cb = await connect(b.run.token);
      a.run.revoke();
      assert.equal(textOf(await cb.callTool({ name: 'agents', arguments: {} })).includes('scout'), true);
    });
  });

  describe('when the run ends', () => {
    it('revoking cuts a call that is waiting, and the key is dead after', async () => {
      const a = run('t-rev', 'zealot', { hold: true });
      const c = await connect(a.run.token);
      const pending = c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'slow' } });
      for (let i = 0; i < 100 && a.bridgeCalls.length === 0; i++) await sleep(20);
      assert.equal(a.bridgeCalls.length, 1, 'the call is in the tool');
      a.run.revoke();
      const settled = await Promise.race([pending.then((r) => ({ r }), (e) => ({ e })), sleep(5000).then(() => 'hung' as const)]);
      a.hold!.release();
      assert.notEqual(settled, 'hung', 'a revoked key does not leave a call waiting');
      assert.equal((settled as { r?: unknown }).r !== undefined && textOf((settled as { r: unknown }).r), 'This run has ended, so the call was cancelled.', 'the answer says the run ended');
      const dead = await post('/mcp/run/legion', { Authorization: `Bearer ${a.run.token}` });
      assert.equal(dead.status, 401);
    });

    it('a cancelled run cuts the call too', async () => {
      const a = run('t-can', 'zealot', { hold: true });
      const c = await connect(a.run.token);
      const pending = c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'slow' } });
      for (let i = 0; i < 100 && a.bridgeCalls.length === 0; i++) await sleep(20);
      a.cancel();
      a.hold!.release();
      const r = await Promise.race([pending, sleep(5000).then(() => 'hung' as const)]);
      assert.notEqual(r, 'hung');
      assert.equal((r as { isError?: boolean }).isError, true);
      assert.notEqual(textOf(r), 'answer from scout', 'a cancelled run gets no answer');
    });
  });

  describe('waits stay inside the agent host\'s own limit', () => {
    it('serves ask with a longest wait and a default of 270 s, and tells the agent what to use for long work', async () => {
      assert.equal(RUN_TOOL_WAIT_MAX_S, 270);
      const c = await connect(run('t-w1', 'zealot').run.token);
      const tools = (await c.listTools()).tools;
      const ask = tools.find((t) => t.name === 'ask')!;
      const p = (ask.inputSchema.properties as Record<string, { maximum?: number; default?: number }>).timeoutSeconds!;
      assert.equal(p.maximum, 270);
      assert.equal(p.default, 270);
      assert.match(ask.description ?? '', /for long work use tell, then task_result/i);
    });

    it('the tools that wait for a person say the agent host cuts the wait after about 5 minutes', async () => {
      const c = await connect(run('t-w2', 'zealot').run.token);
      const tools = (await c.listTools()).tools;
      for (const n of ['ask_user_question', 'room_create', 'room_add_member', 'room_remove_member']) {
        assert.match(tools.find((t) => t.name === n)!.description ?? '', /about 5 minutes/, n);
      }
      assert.doesNotMatch(tools.map((t) => t.description ?? '').join('\n'), /tool_timeout/);
    });

    it('an ask of 600 s reaches the tool as 270, 100 stays 100, and none becomes 270', async () => {
      const a = run('t-w3', 'zealot');
      const c = await connect(a.run.token);
      await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'a', timeoutSeconds: 600 } });
      await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'b', timeoutSeconds: 100 } });
      await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'c' } });
      await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'd', timeoutSeconds: -5 } });
      assert.deepEqual(a.askTimeouts, [270, 100, 270, 270]);
      assert.equal((a.noted[0]!.input as { timeoutSeconds: number }).timeoutSeconds, 270, 'the approval decision sees the wait the tool gets');
    });
  });

  describe('what the route promises about results and calls', () => {
    it('a call whose request goes away is cut', async () => {
      const a = run('t-gone', 'zealot', { signalTool: true });
      const req = request({ host: '127.0.0.1', port, path: '/mcp/run/legion', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${a.run.token}` } });
      req.on('error', () => undefined);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'room_read', arguments: {} } }));
      for (let i = 0; i < 150 && a.sigStarted === 0; i++) await sleep(20);
      assert.equal(a.sigStarted, 1, 'the call is in the tool');
      req.destroy();
      for (let i = 0; i < 150 && a.sigAborted === 0; i++) await sleep(20);
      assert.equal(a.sigAborted, 1, 'the tool saw its signal abort');
    });

    it('the request-gone signal of the route cuts a held call by itself (not only through the transport closing)', async () => {
      const a = run('t-gone2', 'zealot', { signalTool: true });
      const grant = findRunGrant(a.run.token)!;
      const gone = new AbortController();
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await serverForRun(grant, gone.signal).connect(st);
      const c = new Client({ name: 'direct', version: '0' });
      await c.connect(ct);
      clients.push(c);
      const held = c.callTool({ name: 'room_read', arguments: {} });
      held.catch(() => undefined);
      for (let i = 0; i < 150 && a.sigStarted === 0; i++) await sleep(20);
      assert.equal(a.sigStarted, 1, 'the call is in the tool');
      assert.equal(a.sigAborted, 0, 'nothing has cut it yet');
      gone.abort();
      for (let i = 0; i < 150 && a.sigAborted === 0; i++) await sleep(20);
      assert.equal(a.sigAborted, 1, 'the tool saw its signal abort');
    });

    it('sixteen calls at once is the limit; the seventeenth is told so and nothing runs', async () => {
      const a = run('t-cap', 'zealot', { signalTool: true });
      const c = await connect(a.run.token);
      const held = Array.from({ length: 16 }, () => { const p = c.callTool({ name: 'room_read', arguments: {} }); p.catch(() => undefined); return p; });
      for (let i = 0; i < 250 && a.sigStarted < 16; i++) await sleep(20);
      assert.equal(a.sigStarted, 16);
      const r = await c.callTool({ name: 'room_read', arguments: {} });
      assert.equal((r as { isError?: boolean }).isError, true);
      assert.match(textOf(r), /too many tool calls at once/);
      assert.equal(a.sigStarted, 16, 'the refused call did not reach the tool');
      a.run.revoke();
      await Promise.allSettled(held);
    });

    it('a result is redacted before it is stored or sent: a secret in it reaches neither the client nor the thread rows', async () => {
      const a = run('t-red', 'zealot', { listText: 'rooms: PRIVATE-room-key', redact: (t) => t.replaceAll('PRIVATE-room-key', '[hidden]') });
      const c = await connect(a.run.token);
      const r = await c.callTool({ name: 'room_list', arguments: {} });
      assert.equal(textOf(r), 'rooms: [hidden]');
      assert.equal(a.rows.find((x) => x.kind === 'result')!.text, 'rooms: [hidden]');
    });

    it('a host with no redact of its own still redacts a registered secret (fail closed)', async () => {
      const secret = 'plum-orchard-7731-registered';
      registerSecret(secret);
      try {
        const a = run('t-red2', 'zealot', { listText: `rooms: ${secret}` });
        const c = await connect(a.run.token);
        const r = await c.callTool({ name: 'room_list', arguments: {} });
        assert.equal(textOf(r).includes(secret), false);
        assert.equal(a.rows.find((x) => x.kind === 'result')!.text!.includes(secret), false);
        assert.match(textOf(r), /redacted/);
      } finally { unregisterSecret(secret); }
    });

    it('a bare tool name on two tool servers is served once, and the owner is told', async () => {
      const notes: string[] = [];
      const allow = RUN_TOOL_ALLOW as Record<string, readonly string[]>;
      const before = allow.legion_comms!;
      allow.legion_comms = [...before, 'agents'];
      try {
        const a = run('t-dup', 'zealot');
        a.host.servers.legion_comms = createSdkMcpServer({ name: 'legion_comms', version: '1', tools: [tool('agents', 'second agents', {}, async () => ok('from comms'))] }) as never;
        a.host.onNotice = (t) => { notes.push(t); };
        const c = await connect(a.run.token);
        const names = (await c.listTools()).tools.map((t) => t.name);
        assert.equal(names.filter((n) => n === 'agents').length, 1);
        assert.equal(notes.length, 1);
        assert.match(notes[0]!, /agents.*two Legion tool servers/);
      } finally { allow.legion_comms = before; }
    });
  });

  describe('the shim', () => {
    async function spawnShim(token: string, urlOverride?: string): Promise<Client> {
      const s = shimServer(token, port);
      const env = Object.fromEntries(s.env.map((e) => [e.name, e.value]));
      if (urlOverride !== undefined) env.LEGION_RUN_URL = urlOverride;
      const c = new Client({ name: 'hermes-stand-in', version: '0' });
      await Promise.race([
        c.connect(new StdioClientTransport({ command: s.command, args: s.args, env, stderr: 'pipe' })),
        sleep(20_000).then(() => { throw new Error('the shim did not answer in 20 s'); }),
      ]);
      clients.push(c);
      return c;
    }

    /** Runs the shim on its own (no MCP client) and waits for it to exit. */
    function runShim(s: ReturnType<typeof shimServer>, over: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
      const env: Record<string, string> = { ...Object.fromEntries(s.env.map((e) => [e.name, e.value])), ...over };
      for (const k of ['PATH', 'SystemRoot', 'SYSTEMROOT']) if (process.env[k]) env[k] = process.env[k]!;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [s.args[0]!], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let out = ''; let err = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        const timer = setTimeout(() => { child.kill(); reject(new Error('the shim did not exit in 20 s')); }, 20_000);
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
        child.stdin.end();
      });
    }

    it('lists the allow-listed tools over stdio and forwards a call to its own task', async () => {
      const a = run('t-shim', 'zealot');
      const c = await spawnShim(a.run.token);
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, ALLOWED_ALL);
      const r = await c.callTool({ name: 'ask', arguments: { agent: 'scout', message: 'through the shim' } });
      assert.equal(textOf(r), 'answer from scout');
      assert.deepEqual(a.bridgeCalls, ['ask:t-shim:scout:through the shim']);
      assert.equal(a.noted[0]!.name, 'mcp__legion__ask');
      const hidden = await c.callTool({ name: 'vm_exec', arguments: { command: 'x' } });
      assert.equal((hidden as { isError?: boolean }).isError, true);
    });

    it('cancelling a call at the client cuts it in the core and frees its slot: seventeen calls after sixteen abandoned ones still succeed', async () => {
      const a = run('t-shim-cancel', 'zealot', { signalTool: true });
      const c = await spawnShim(a.run.token);
      for (let i = 1; i <= 16; i++) {
        const ac = new AbortController();
        const p = c.callTool({ name: 'room_read', arguments: {} }, undefined, { signal: ac.signal });
        p.catch(() => undefined);
        for (let k = 0; k < 250 && a.sigStarted < i; k++) await sleep(20);
        assert.equal(a.sigStarted, i, `call ${i} is in the tool`);
        ac.abort();
        for (let k = 0; k < 250 && a.sigAborted < i; k++) await sleep(20);
        assert.equal(a.sigAborted, i, `call ${i} saw its signal abort`);
      }
      for (let i = 0; i < 17; i++) {
        const r = await c.callTool({ name: 'room_list', arguments: {} });
        assert.equal((r as { isError?: boolean }).isError, undefined, `call ${i + 1}: ${textOf(r)}`);
        assert.equal(textOf(r), 'room_list done');
      }
    });

    it('removes the run key from its own environment, and never writes it to stderr', async () => {
      const a = run('t-shim-env', 'zealot');
      const s = shimServer(a.run.token, port);
      const probe = fileURLToPath(new URL('./shim-env-probe.js', import.meta.url));
      const env = Object.fromEntries(s.env.map((e) => [e.name, e.value]));
      const t = new StdioClientTransport({ command: process.execPath, args: ['--import', pathToFileURL(probe).href, s.args[0]!], env, stderr: 'pipe' });
      let err = '';
      t.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
      const c = new Client({ name: 'hermes-stand-in', version: '0' });
      await c.connect(t);
      clients.push(c);
      for (let i = 0; i < 200 && !err.includes('[env-probe]'); i++) await sleep(20);
      assert.match(err, /\[env-probe\] LEGION_RUN_TOKEN is absent/);
      assert.equal(err.includes(a.run.token), false);
    });

    it('does not start with a dead key, and says nothing of the key', async () => {
      const a = run('t-shim-dead', 'zealot');
      a.run.revoke();
      const r = await runShim(shimServer(a.run.token, port), {});
      assert.equal(r.code, 1);
      assert.equal((r.out + r.err).includes(a.run.token), false);
      assert.match(r.err, /did not accept this run/);
    });

    describe('the address it will send the key to', () => {
      const hits: string[] = [];
      let listener: ReturnType<typeof createServer>;
      let lport = 0;
      before(async () => {
        listener = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = 401; res.end('no'); });
        await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
        lport = (listener.address() as AddressInfo).port;
      });
      after(async () => { await new Promise<void>((r) => listener.close(() => r())); });

      it('is only http://127.0.0.1:<port>/mcp/run/legion: any other address is refused before one byte is sent, and the key is never printed', async () => {
        const a = run('t-shim-url', 'zealot');
        const bad = [
          `http://127.0.0.1:${lport}/other`, `http://127.0.0.1:${lport}/mcp/run/legion/`, `http://127.0.0.1:${lport}/mcp/run/legion?x=1`,
          `http://user@127.0.0.1:${lport}/mcp/run/legion`, `https://127.0.0.1:${lport}/mcp/run/legion`, `http://localhost:${lport}/mcp/run/legion`,
          'http://127.0.0.1:0/mcp/run/legion', 'http://127.0.0.1:99999/mcp/run/legion', 'http://127.0.0.1:65536/mcp/run/legion', 'http://127.0.0.1:/mcp/run/legion', '',
        ];
        for (const u of bad) {
          const r = await runShim(shimServer(a.run.token, port), { LEGION_RUN_URL: u });
          assert.equal(r.code, 2, `refused: ${u || '(empty)'}`);
          assert.equal((r.out + r.err).includes(a.run.token), false, `the key stays out of the output: ${u}`);
        }
        assert.deepEqual(hits, [], 'nothing reached the listener');
        // control: the right shape for this listener does reach it, so the test above can fail
        const good = await runShim(shimServer(a.run.token, port), { LEGION_RUN_URL: `http://127.0.0.1:${lport}/mcp/run/legion` });
        assert.equal(good.code, 1, 'it tried, the listener said no');
        assert.ok(hits.length > 0, 'the control request reached the listener');
        assert.equal((good.out + good.err).includes(a.run.token), false);
      });
    });
  });
});
