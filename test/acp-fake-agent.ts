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
 *   plan        like ok, with a plan update (two entries) before the first chunk
 *   foreign     like ok, with an update and a permission request for another session (sess_other) in the middle of the turn
 *   script      a prompt plays the steps in the JSON file named by --script (text, thought, tool, toolUpdate, plan, permission, wait, waitCancel, end),
 *               so a test can say exactly what the agent does in one turn. A permission step waits for the client's answer; the answer is in the --log.
 *   stream      a prompt streams --chunks chunks (default 15), one every --interval ms (default 100), to the session named by --to (default its own),
 *               then ends the turn; session/cancel stops the stream and ends the turn "cancelled"
 * Flags: --init-delay <ms> delays the initialize answer in any mode; --fail-resume <details> makes session/resume and session/load fail with those details; --fail-new <message> [--fail-code n] [--fail-in-data]  makes session/new fail (the message goes in error.data.details, with the message "Internal error", when --fail-in-data is given:
 *   the shape the Python ACP SDK gives an exception raised in a Hermes handler); --no-resume drops the resume capability.
 * --fail-set-model <message> / --fail-set-mode <message> make that call fail. --with-close advertises sessionCapabilities.close and answers session/close
 *   (Hermes advertises no close). --cancel-error makes the `cancel` and `stream` modes answer the open prompt with an error after session/cancel
 *   (Hermes admitted_turn_failed) instead of "cancelled".
 * --prompt-error [details] makes every session/prompt fail with an error (no cancel involved); the details default to "something broke".
 * session/resume and session/load answer {} for sess_fake_1 (load first replays one old message) and fail with details "not_found" for sess_missing.
 * --report writes { argv, env, cwd, pid, mode, daemonPid? } at start. --log appends every message the agent receives (one JSON per line).
 * --daemon starts a detached sleeper that must outlive this agent (the Hermes background service) and reports its PID as daemonPid.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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
const fail = (id: unknown, code: number, message: string, data?: unknown) => out({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const update = (u: Record<string, unknown>, sessionId = 'sess_fake_1') => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const text = (t: string) => ({ type: 'text', text: t });

let turns = 0;
let pendingPrompt: unknown; // the id of a prompt waiting for session/cancel
let scriptCancelled = false; // session/cancel arrived while a `script` prompt was running
let scriptCancelWaiter: (() => void) | undefined;
let streamStopped = false; // session/cancel arrived while a `stream` prompt was running
const answerCancelled = (id: unknown) => (argv.includes('--cancel-error') ? fail(id, -32603, 'Internal error', { details: 'admitted_turn_failed' }) : reply(id, { stopReason: 'cancelled' }));
const waiting = new Map<unknown, (msg: Record<string, unknown>) => void>(); // requests we sent, waiting for the client's answer

async function prompt(id: unknown): Promise<void> {
  turns += 1;
  if (argv.includes('--prompt-error')) { const given = opt('--prompt-error'); fail(id, -32603, 'Internal error', { details: given && !given.startsWith('--') ? given : 'something broke' }); return; }
  if (mode === 'hang') return;
  if (mode === 'crash') { process.stderr.write('Traceback (most recent call last):\n  fake agent crashed on purpose\n'); process.exit(1); }
  if (mode === 'overflow') out('x'.repeat(17 * 1024 * 1024));
  if (mode === 'cancel') {
    update({ sessionUpdate: 'agent_message_chunk', content: text('working') });
    pendingPrompt = id;
    return;
  }
  if (mode === 'stream') {
    const n = Number(opt('--chunks') ?? 15);
    const gap = Number(opt('--interval') ?? 100);
    const to = opt('--to') ?? 'sess_fake_1';
    for (let i = 0; i < n && !streamStopped; i += 1) {
      update({ sessionUpdate: 'agent_message_chunk', content: text(`chunk ${i} `) }, to);
      await sleep(gap);
    }
    if (streamStopped) answerCancelled(id); else reply(id, { stopReason: 'end_turn' });
    return;
  }
  if (mode === 'script') { await playScript(id); return; }
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
  if (mode === 'plan') update({ sessionUpdate: 'plan', entries: [{ content: 'read the code', priority: 'medium', status: 'completed' }, { content: 'fix it', priority: 'medium', status: 'in_progress' }] });
  if (mode === 'foreign') {
    update({ sessionUpdate: 'agent_message_chunk', content: text('LEAK') }, 'sess_other');
    waiting.set(9002, () => undefined);
    out({ jsonrpc: '2.0', id: 9002, method: 'session/request_permission', params: { sessionId: 'sess_other', toolCall: { toolCallId: 'perm-check-other', title: 'x', kind: 'execute', status: 'pending', rawInput: { command: 'echo other' } }, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
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

/** The `script` mode: one JSON array of steps, played in order. Anything after a `waitCancel` that was cancelled is skipped. */
async function playScript(id: unknown): Promise<void> {
  const steps = JSON.parse(readFileSync(opt('--script')!, 'utf8')) as Array<Record<string, any>>;
  let usage: Record<string, number> | undefined;
  let stopReason = 'end_turn';
  let permSeq = 9100;
  for (const st of steps) {
    if (scriptCancelled) break;
    switch (st.op) {
      case 'text': update({ sessionUpdate: 'agent_message_chunk', content: text(String(st.text)) }); break;
      case 'thought': update({ sessionUpdate: 'agent_thought_chunk', content: text(String(st.text)) }); break;
      case 'tool': update({ sessionUpdate: 'tool_call', toolCallId: st.id, title: st.title, kind: st.kind ?? 'other', status: 'pending', ...(st.rawInput ? { rawInput: st.rawInput } : {}), ...(st.content ? { content: [{ type: 'content', content: text(String(st.content)) }] } : {}) }); break;
      case 'toolUpdate': update({ sessionUpdate: 'tool_call_update', toolCallId: st.id, status: st.status ?? 'completed', ...(st.content ? { content: [{ type: 'content', content: text(String(st.content)) }] } : {}) }); break;
      case 'plan': update({ sessionUpdate: 'plan', entries: st.entries }); break;
      case 'wait': await Promise.race([sleep(Number(st.ms)), new Promise<void>((resolve) => { scriptCancelWaiter = resolve; })]); break;
      case 'permission': {
        const rid = permSeq++;
        const options = st.options ?? [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
          { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ];
        const asked = new Promise<Record<string, unknown>>((resolve) => {
          waiting.set(rid, resolve);
          out({ jsonrpc: '2.0', id: rid, method: 'session/request_permission', params: { sessionId: 'sess_fake_1', toolCall: { toolCallId: st.id, title: st.title, kind: st.kind ?? 'execute', status: 'pending', ...(st.rawInput ? { rawInput: st.rawInput } : {}), ...(st.content ? { content: st.content } : {}) }, options } });
        });
        if (st.async !== true) await asked; // async: true sends the request and goes on without waiting for the answer
        break;
      }
      case 'waitCancel': {
        await new Promise<void>((resolve) => { scriptCancelWaiter = resolve; if (scriptCancelled) resolve(); });
        break;
      }
      case 'end': stopReason = String(st.stopReason ?? 'end_turn'); if (st.usage) usage = st.usage; break;
      default: break;
    }
  }
  if (scriptCancelled) answerCancelled(id); else reply(id, { stopReason, ...(usage ? { usage } : {}) });
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const { id, method } = msg;
  if (method === undefined && id !== undefined && waiting.has(id)) { waiting.get(id)!(msg); waiting.delete(id); return; }
  switch (method) {
    case 'initialize':
      if (mode === 'slow-init') await sleep(Number(opt('--delay') ?? 1500));
      if (opt('--init-delay') !== undefined) await sleep(Number(opt('--init-delay')));
      if (mode === 'noise') out('Fake agent v0.0.0 starting (this line is not JSON)');
      reply(id, {
        protocolVersion: mode === 'bad-version' ? 99 : 1,
        agentCapabilities: { loadSession: true, ...(argv.includes('--no-resume') ? {} : { sessionCapabilities: { resume: {}, list: {}, fork: {}, ...(argv.includes('--with-close') ? { close: {} } : {}) } }), promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: 'fake-agent', title: 'Fake agent', version: '0.0.1-fake' },
        authMethods: [],
      });
      return;
    case 'session/new':
      if (mode === 'no-policy') { fail(id, -32603, 'acp_policy_unavailable'); return; }
      if (opt('--fail-new') !== undefined) {
        const message = opt('--fail-new')!;
        if (argv.includes('--fail-in-data')) fail(id, Number(opt('--fail-code') ?? -32603), 'Internal error', { details: message });
        else fail(id, Number(opt('--fail-code') ?? -32603), message);
        return;
      }
      reply(id, {
        sessionId: 'sess_fake_1',
        models: { availableModels: [{ modelId: 'prov:model-a', name: 'Model A' }, { modelId: 'prov:model-b', name: 'Model B' }], currentModelId: 'prov:model-a' },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept_edits', name: 'Accept Edits' }, { id: 'dont_ask', name: "Don't Ask" }] },
      });
      return;
    case 'session/resume':
    case 'session/load': {
      const sid = String((msg.params as Record<string, unknown> | undefined)?.sessionId);
      if (opt('--fail-resume') !== undefined) { fail(id, -32603, 'Internal error', { details: opt('--fail-resume') }); return; }
      if (sid === 'sess_missing') { fail(id, -32603, 'Internal error', { details: 'not_found' }); return; }
      if (method === 'session/load') update({ sessionUpdate: 'agent_message_chunk', content: text('old history') }, sid);
      reply(id, method === 'session/resume' ? { models: { availableModels: [{ modelId: 'prov:model-a', name: 'Model A' }], currentModelId: 'prov:model-a' } } : {});
      return;
    }
    case 'session/set_model':
    case 'session/set_mode': {
      const failure = opt(method === 'session/set_model' ? '--fail-set-model' : '--fail-set-mode');
      if (failure !== undefined) fail(id, -32603, failure);
      else reply(id, {});
      return;
    }
    case 'session/close':
      reply(id, {});
      return;
    case 'session/prompt':
      await prompt(id);
      return;
    case 'session/cancel':
      if (mode === 'cancel' && pendingPrompt !== undefined) { answerCancelled(pendingPrompt); pendingPrompt = undefined; }
      if (mode === 'stream') streamStopped = true;
      if (mode === 'script') { scriptCancelled = true; scriptCancelWaiter?.(); }
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
