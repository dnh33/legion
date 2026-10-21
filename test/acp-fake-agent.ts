/**
 * A stand-in ACP agent, run as `node dist/test/acp-fake-agent.js --mode <mode> [--report <file>] [--log <file>] [--delay <ms>] [--daemon]`.
 * Never a real agent. It speaks ACP v1 over stdio, one JSON message per line:
 *   initialize, session/new (and session/load, session/set_model, session/set_mode), session/prompt, session/cancel.
 * Wire shapes: https://agentclientprotocol.com (initialization, session-setup, prompt-turn, tool-calls, schema). Keys are camelCase on the wire
 * (rawInput, toolCallId, optionId, stopReason). The permission request copies the shape of the Hermes adapter (acp_adapter/permissions.py:54-64):
 * a tool_call update of kind "execute" carrying rawInput { command, description }, with the options allow_once, allow_session (kind allow_always),
 * allow_always, deny (kind reject_once).
 *
 * Modes:
 *   ok          a prompt streams a thought, text, a tool call and an update, then ends the turn; usage is session-cumulative (100/20, then 250/60)
 *   permission  a prompt first asks permission for a command and ends the turn by the answer ("cancelled" answer -> stopReason cancelled)
 *   cancel      a prompt streams one chunk, then waits for session/cancel and ends the turn "cancelled"
 *   hang        a prompt is never answered, session/cancel and the closing of stdin are ignored (only a kill stops it)
 *   crash       a prompt writes a traceback to stderr and exits with code 1
 *   bad-version initialize answers protocolVersion 99
 *   no-policy   session/new fails with the message acp_policy_unavailable (as the Hermes gateway server does)
 *   slow-init   initialize is answered after --delay ms (default 1500)
 *   noise       non-JSON lines on stdout (banner, warning) between the messages, and a line on stderr
 *   split       every message is written in three pieces with pauses between them
 *   overflow    a prompt first writes one 17 MiB line, then behaves like ok
 * --report writes { argv, env, cwd, pid, mode, daemonPid? } at start. --log appends every message the agent receives (one JSON per line).
 * --daemon starts a detached sleeper that must outlive this agent (the Hermes background service) and reports its PID as daemonPid.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const mode = opt('--mode') ?? 'ok';
const reportFile = opt('--report');
const logFile = opt('--log');

const report: Record<string, unknown> = { argv, env: process.env, cwd: process.cwd(), pid: process.pid, mode };
const writeReport = () => { if (reportFile) writeFileSync(reportFile, JSON.stringify(report)); };
if (argv.includes('--daemon')) {
  const d = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  d.unref();
  report.daemonPid = d.pid;
}
writeReport();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let chain: Promise<void> = Promise.resolve();
/** Write one message (or raw line). Messages keep their order; in split mode each goes out in three pieces. */
function out(msg: unknown): void {
  const text = (typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n';
  chain = chain.then(async () => {
    if (mode !== 'split' || typeof msg === 'string') { process.stdout.write(text); return; }
    const third = Math.ceil(text.length / 3);
    for (let i = 0; i < text.length; i += third) { process.stdout.write(text.slice(i, i + third)); await sleep(15); }
  });
}
const reply = (id: unknown, result: unknown) => out({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => out({ jsonrpc: '2.0', id, error: { code, message } });
const update = (u: Record<string, unknown>) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_fake_1', update: u } });
const text = (t: string) => ({ type: 'text', text: t });

let turns = 0;
let pendingPrompt: unknown; // the id of a prompt waiting for session/cancel
const waiting = new Map<unknown, (msg: Record<string, unknown>) => void>(); // requests we sent, waiting for the client's answer

async function prompt(id: unknown): Promise<void> {
  turns += 1;
  if (mode === 'hang') return;
  if (mode === 'crash') { process.stderr.write('Traceback (most recent call last):\n  fake agent crashed on purpose\n'); process.exit(1); }
  if (mode === 'overflow') out('x'.repeat(17 * 1024 * 1024));
  if (mode === 'cancel') {
    update({ sessionUpdate: 'agent_message_chunk', content: text('working') });
    pendingPrompt = id;
    return;
  }
  if (mode === 'permission') {
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(9001, resolve);
      out({
        jsonrpc: '2.0', id: 9001, method: 'session/request_permission',
        params: {
          sessionId: 'sess_fake_1',
          toolCall: {
            toolCallId: 'perm-check-1', title: 'delete the build folder: rm -rf build', kind: 'execute', status: 'pending',
            content: [{ type: 'content', content: text('delete the build folder\n$ rm -rf build') }],
            rawInput: { command: 'rm -rf build', description: 'delete the build folder' },
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
            { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    });
    const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    const allowed = outcome?.outcome === 'selected' && String(outcome.optionId).startsWith('allow');
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'perm-check-1', status: allowed ? 'completed' : 'failed' });
    reply(id, { stopReason: outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' });
    return;
  }
  update({ sessionUpdate: 'agent_thought_chunk', content: text('thinking') });
  if (mode === 'noise') { out('WARNING: fake agent banner, not JSON'); process.stderr.write('fake agent: a log line on stderr\n'); }
  update({ sessionUpdate: 'agent_message_chunk', content: text('hello ') });
  update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'List files', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: text('world') });
  // Usage is cumulative over the session, as in the Hermes adapter (acp_adapter/server.py:995-1003); there is no cost.
  const usage = turns === 1 ? { inputTokens: 100, outputTokens: 20, totalTokens: 120 } : { inputTokens: 250, outputTokens: 60, totalTokens: 310 };
  reply(id, { stopReason: 'end_turn', usage });
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const { id, method } = msg;
  if (method === undefined && id !== undefined && waiting.has(id)) { waiting.get(id)!(msg); waiting.delete(id); return; }
  switch (method) {
    case 'initialize':
      if (mode === 'slow-init') await sleep(Number(opt('--delay') ?? 1500));
      if (mode === 'noise') out('Fake agent v0.0.0 starting (this line is not JSON)');
      reply(id, {
        protocolVersion: mode === 'bad-version' ? 99 : 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: 'fake-agent', title: 'Fake agent', version: '0.0.1-fake' },
        authMethods: [],
      });
      return;
    case 'session/new':
      if (mode === 'no-policy') { fail(id, -32603, 'acp_policy_unavailable'); return; }
      reply(id, { sessionId: 'sess_fake_1' });
      return;
    case 'session/load':
    case 'session/set_model':
    case 'session/set_mode':
      reply(id, {});
      return;
    case 'session/prompt':
      await prompt(id);
      return;
    case 'session/cancel':
      if (mode === 'cancel' && pendingPrompt !== undefined) { reply(pendingPrompt, { stopReason: 'cancelled' }); pendingPrompt = undefined; }
      return;
    default:
      if (id !== undefined && method !== undefined) fail(id, -32601, `Method not found: ${String(method)}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => {
  buf += d;
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    if (logFile) appendFileSync(logFile, line + '\n');
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    void handle(parsed);
  }
});
process.stdin.on('error', () => undefined);
// The Hermes viewer leaves when its client closes stdin. `hang` does not: it stands for an agent that has to be killed.
if (mode === 'hang') { process.stdin.on('end', () => undefined); setInterval(() => undefined, 1000); }
else process.stdin.on('end', () => process.exit(0));
