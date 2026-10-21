import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { RpcError, RpcPeer } from '../src/core/acp/rpc.js';
import type { AcpEntry } from '../src/shared/acp-view.js';
import { startAgentProcess, type AgentProcess } from '../src/core/acp/process.js';

// The fake agent is what Tasks 5 and 6 test against: these tests pin the wire shapes it speaks.
const FAKE = fileURLToPath(new URL('./acp-fake-agent.js', import.meta.url));
const started: AgentProcess[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function run(mode: string, extra: string[] = []) {
  const e: AcpEntry = { id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE, '--mode', mode, ...extra], tested: false, enabled: true };
  const p = startAgentProcess(e, { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-') });
  started.push(p);
  const noise: string[] = [];
  const notes: Array<Record<string, any>> = [];
  const peer = new RpcPeer(p.io, { requestTimeoutMs: 15_000, onNoise: (l) => noise.push(l) });
  peer.onNotification('session/update', (params) => notes.push(params as Record<string, any>));
  const init = () => peer.request<Record<string, any>>('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const newSession = () => peer.request<{ sessionId: string }>('session/new', { cwd: process.cwd(), mcpServers: [] });
  const prompt = (sessionId: string, t = 'hi') => peer.request<Record<string, any>>('session/prompt', { sessionId, prompt: [{ type: 'text', text: t }] }, 15_000);
  return { p, peer, noise, notes, init, newSession, prompt };
}
const kinds = (notes: Array<Record<string, any>>) => notes.map((n) => n.update.sessionUpdate);

after(async () => {
  for (const p of started) p.killNow();
  await Promise.all(started.map((p) => Promise.race([p.exited, sleep(3000)])));
});

test('fake ok: initialize, session/new, two prompts with streamed updates and cumulative usage', async () => {
  const a = run('ok');
  const init = await a.init();
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.version, '0.0.1-fake');
  assert.equal(init.agentCapabilities.loadSession, true);
  const { sessionId } = await a.newSession();
  const r1 = await a.prompt(sessionId);
  assert.equal(r1.stopReason, 'end_turn');
  assert.deepEqual(r1.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  assert.deepEqual(kinds(a.notes), ['agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  assert.equal(a.notes[2]!.update.toolCallId, 'call_1');
  assert.deepEqual(a.notes[2]!.update.rawInput, { command: 'ls' });
  assert.ok(a.notes.every((n) => n.sessionId === sessionId));
  const r2 = await a.prompt(sessionId);
  assert.deepEqual(r2.usage, { inputTokens: 250, outputTokens: 60, totalTokens: 310 }, 'cumulative over the session');
  await a.p.stop();
});

test('fake permission: the request carries rawInput.command and the Hermes options; the answer ends the turn', async () => {
  const a = run('permission');
  await a.init();
  const { sessionId } = await a.newSession();
  let asked: Record<string, any> | undefined;
  a.peer.onRequest('session/request_permission', async (params) => { asked = params as Record<string, any>; return { outcome: { outcome: 'selected', optionId: 'allow_once' } }; });
  const r = await a.prompt(sessionId);
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(asked!.toolCall.kind, 'execute');
  assert.deepEqual(asked!.toolCall.rawInput, { command: 'rm -rf build', description: 'delete the build folder' });
  assert.deepEqual(asked!.options.map((o: any) => [o.optionId, o.kind]), [['allow_once', 'allow_once'], ['allow_session', 'allow_always'], ['allow_always', 'allow_always'], ['deny', 'reject_once']]);
  assert.equal(a.notes.at(-1)!.update.status, 'completed');

  const b = run('permission');
  await b.init();
  const sb = await b.newSession();
  b.peer.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' } }));
  const rb = await b.prompt(sb.sessionId);
  assert.equal(rb.stopReason, 'cancelled');
  assert.equal(b.notes.at(-1)!.update.status, 'failed');
  await a.p.stop(); await b.p.stop();
});

test('fake cancel: session/cancel ends the waiting turn as cancelled', async () => {
  const a = run('cancel');
  await a.init();
  const { sessionId } = await a.newSession();
  const turn = a.prompt(sessionId);
  while (!a.notes.length) await sleep(20);
  a.peer.notify('session/cancel', { sessionId });
  assert.equal((await turn).stopReason, 'cancelled');
  await a.p.stop();
});

test('fake hang: a prompt is never answered and cancel and a closed stdin do not stop it', async () => {
  const a = run('hang');
  await a.init();
  const { sessionId } = await a.newSession();
  let answered = false;
  void a.prompt(sessionId).then(() => { answered = true; }, () => undefined);
  a.peer.notify('session/cancel', { sessionId });
  await sleep(400);
  assert.equal(answered, false);
  await a.p.stop(300); // stdin closed, then killed
  assert.equal(answered, false);
});

test('fake crash: a prompt writes a traceback to stderr and exits 1', async () => {
  const a = run('crash');
  await a.init();
  const { sessionId } = await a.newSession();
  await assert.rejects(a.prompt(sessionId), /closed/);
  assert.equal((await a.p.exited).code, 1);
  assert.match(a.p.stderrTail(), /Traceback \(most recent call last\):\n {2}fake agent crashed on purpose/);
});

test('fake bad-version, no-policy and slow-init', async () => {
  const a = run('bad-version');
  assert.equal((await a.init()).protocolVersion, 99);
  await a.p.stop();

  const b = run('no-policy');
  await b.init();
  await assert.rejects(b.newSession(), (e) => e instanceof RpcError && /acp_policy_unavailable/.test(e.message));
  await b.p.stop();

  const c = run('slow-init', ['--delay', '700']);
  const t0 = Date.now();
  await c.init();
  assert.ok(Date.now() - t0 >= 650, 'initialize waited');
  await c.p.stop();
});

test('fake noise and split: non-JSON lines go to onNoise and split messages still parse', async () => {
  const a = run('noise');
  await a.init();
  const { sessionId } = await a.newSession();
  assert.equal((await a.prompt(sessionId)).stopReason, 'end_turn');
  assert.ok(a.noise.some((l) => /starting/.test(l)) && a.noise.some((l) => /banner/.test(l)), JSON.stringify(a.noise));
  await a.p.stop();
  assert.match(a.p.stderrTail(), /a log line on stderr/);

  const b = run('split');
  assert.equal((await b.init()).agentInfo.version, '0.0.1-fake');
  const sb = await b.newSession();
  assert.equal((await b.prompt(sb.sessionId)).stopReason, 'end_turn');
  assert.deepEqual(b.noise, []);
  await b.p.stop();
});

test('fake --log records the messages it receives (the MCP servers of session/new)', async () => {
  const log = join(tempDir('acp-log-'), 'in.log');
  const a = run('ok', ['--log', log]);
  await a.init();
  await a.peer.request('session/new', { cwd: process.cwd(), mcpServers: [{ name: 'legion', command: 'node', args: ['x'], env: [] }] });
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
  assert.deepEqual(lines.map((l) => l.method), ['initialize', 'session/new']);
  assert.equal(lines[1]!.params.mcpServers.length, 1);
  await a.p.stop();
});
