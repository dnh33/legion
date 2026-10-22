import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import type { AcpEntry } from '../src/shared/acp-view.js';
import { registerLegionSecrets, startAgentProcess, type AgentProcess } from '../src/core/acp/process.js';
import { RpcClosed, RpcError } from '../src/core/acp/rpc.js';
import { ACP_CANCEL_GRACE_MS, ACP_PERMISSION_PAUSE_CAP_MS, ACP_MAX_OPEN_PERMISSIONS, AcpRefusal, AcpSession, type AcpCallbacks, type AcpStdioServer } from '../src/core/acp/session.js';
import type { MappedPermission, MappedTool } from '../src/core/acp/map.js';

// The session driver against the fake agent. Wire shapes: https://agentclientprotocol.com (initialization, session-setup, prompt-turn,
// tool-calls, agent-plan); what Hermes sends: acp_adapter/server.py, gateway_server.py, permissions.py.
const FAKE = fileURLToPath(new URL('./acp-fake-agent.js', import.meta.url));
registerLegionSecrets([]);
const started: AgentProcess[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SHIM: AcpStdioServer = { name: 'legion', command: process.execPath, args: ['shim.js'], env: [{ name: 'LEGION_TOKEN', value: 't0k' }] };

after(async () => {
  for (const p of started) p.killNow();
  await Promise.all(started.map((p) => Promise.race([p.exited, sleep(3000)])));
});

function launch(mode: string, extra: string[] = []) {
  const log = join(tempDir('acp-log-'), 'in.log');
  const entry: AcpEntry = { id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE, '--mode', mode, '--log', log, ...extra], tested: false, enabled: true };
  const p = startAgentProcess(entry, { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-') });
  started.push(p);
  const msgs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : []);
  const methods = () => msgs().map((m) => m.method).filter(Boolean);
  return { p, msgs, methods };
}
type Init = Parameters<typeof AcpSession.open>[1];
const initOf = (over: Partial<Init> = {}): Init => ({ cwd: process.cwd(), mcpServers: [SHIM], watchdogMs: 60_000, ...over });
async function open(mode: string, over: Partial<Init> = {}, extra: string[] = []) {
  const h = launch(mode, extra);
  const session = await AcpSession.open(h.p, initOf(over));
  return { ...h, session };
}
function recorder(over: Partial<AcpCallbacks> = {}) {
  const r = { text: [] as string[], thought: [] as string[], starts: [] as MappedTool[], updates: [] as MappedTool[], plans: [] as unknown[], perms: [] as MappedPermission[], usage: [] as Array<{ input: number; output: number }> };
  const cb: AcpCallbacks = {
    onText: (d) => r.text.push(d), onThought: (d) => r.thought.push(d), onToolStart: (t) => r.starts.push(t), onToolUpdate: (t) => r.updates.push(t),
    onPlan: (i) => r.plans.push(i), onPermission: async (q) => { r.perms.push(q); return { optionId: q.options[0]!.optionId }; }, onUsage: (u) => r.usage.push(u), ...over,
  };
  return { r, cb };
}
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(20); }
}

// ---------------------------------------------------------------- open

test('open: initialize sends clientCapabilities without fs and terminal and reads agentInfo.version; session/new sends exactly the one shim server', async () => {
  const a = await open('ok');
  assert.equal(a.session.agentVersion, '0.0.1-fake');
  assert.equal(a.session.sessionId, 'sess_fake_1');
  assert.deepEqual(a.session.models, ['prov:model-a', 'prov:model-b']);
  const [init, nu] = a.msgs();
  assert.equal(init!.method, 'initialize');
  assert.equal(init!.params.protocolVersion, 1);
  assert.ok(!('fs' in init!.params.clientCapabilities) && !('terminal' in init!.params.clientCapabilities), JSON.stringify(init!.params.clientCapabilities));
  assert.equal(nu!.method, 'session/new');
  assert.deepEqual(nu!.params.mcpServers, [SHIM]);
  assert.equal(nu!.params.cwd, process.cwd());
  await a.p.stop();
});

test('open: a protocol version Legion cannot speak is AcpRefusal acp-version', async () => {
  const h = launch('bad-version');
  await assert.rejects(AcpSession.open(h.p, initOf()), (e) => e instanceof AcpRefusal && e.reason === 'acp-version' && /99/.test(e.message));
  await h.p.stop();
});

test('open: Hermes refusals map to a reason and keep Hermes\'s own message (plain message and the SDK form with error.data.details)', async () => {
  const cases: Array<[string, string[], AcpRefusal['reason'], RegExp]> = [
    ['no-policy', [], 'no-policy', /acp_policy_unavailable/],
    ['ok', ['--fail-new', 'acp_policy_unavailable', '--fail-in-data'], 'no-policy', /acp_policy_unavailable/],
    ['ok', ['--fail-new', 'windows_breakaway_unavailable', '--fail-in-data'], 'breakaway', /windows_breakaway_unavailable/],
    ['ok', ['--fail-new', 'windows_breakaway_unavailable'], 'breakaway', /windows_breakaway_unavailable/],
    ['ok', ['--fail-new', 'Gateway protocol mismatch; update/restart required'], 'protocol-mismatch', /Gateway protocol mismatch/],
    ['ok', ['--fail-new', 'gateway_protocol_mismatch', '--fail-in-data'], 'protocol-mismatch', /gateway_protocol_mismatch/],
    ['ok', ['--fail-new', 'Authentication required', '--fail-code', '-32000'], 'auth', /Authentication required/],
    ['ok', ['--fail-new', 'No LLM provider configured. Run `hermes setup`', '--fail-in-data'], 'auth', /hermes setup/],
  ];
  for (const [mode, extra, reason, msg] of cases) {
    const h = launch(mode, extra);
    await assert.rejects(AcpSession.open(h.p, initOf()), (e) => e instanceof AcpRefusal && e.reason === reason && msg.test(e.message), `${extra.join(' ')} -> ${reason}`);
    await h.p.stop();
  }
  // an error that is none of these stays a plain RPC error
  const h = launch('ok', ['--fail-new', 'something else broke']);
  await assert.rejects(AcpSession.open(h.p, initOf()), (e) => !(e instanceof AcpRefusal) && /something else broke/.test((e as Error).message));
  await h.p.stop();
});

test('open: a failure that closes the connection with the reason on stderr is still mapped (the daemon could not start)', async () => {
  const h = launch('ok');
  let tail = '';
  const stub = { ...h.p, io: h.p.io, stderrTail: () => tail } as AgentProcess;
  h.p.killNow();
  await h.p.exited;
  const opening = AcpSession.open(stub, initOf());
  tail = 'RuntimeStartError: windows_breakaway_unavailable\n'; // written after the call started
  await assert.rejects(opening, (e) => e instanceof AcpRefusal && e.reason === 'breakaway');
});

test('open: a refusal reason that was already on stderr before the call started is not read as the reason for this failure', async () => {
  const h = launch('ok');
  const old = 'RuntimeStartError: windows_breakaway_unavailable\nNo LLM provider configured. Run `hermes setup`\n';
  let tail = old;
  const stub = { ...h.p, io: h.p.io, stderrTail: () => tail } as AgentProcess;
  h.p.killNow();
  await h.p.exited;
  const opening = AcpSession.open(stub, initOf());
  tail = `${old}unrelated line after the call started\n`; // new output that names no reason
  await assert.rejects(opening, (e) => !(e instanceof AcpRefusal) && /not reading|closed/.test((e as Error).message));
  // a reason line that is new (the same text as an old one) still counts
  const again = AcpSession.open(stub, initOf());
  tail = `${tail}RuntimeStartError: windows_breakaway_unavailable\n`;
  await assert.rejects(again, (e) => e instanceof AcpRefusal && e.reason === 'breakaway');
});

test('open: resume uses session/resume when the agent offers it, resends the shim, keeps the id, and a missing id is AcpRefusal not-found', async () => {
  const a = await open('ok', { resumeId: 'sess_fake_1' });
  assert.deepEqual(a.methods(), ['initialize', 'session/resume']);
  const res = a.msgs()[1]!;
  assert.equal(res.params.sessionId, 'sess_fake_1');
  assert.deepEqual(res.params.mcpServers, [SHIM]);
  assert.equal(a.session.sessionId, 'sess_fake_1');
  await a.p.stop();

  const h = launch('ok');
  await assert.rejects(AcpSession.open(h.p, initOf({ resumeId: 'sess_missing' })), (e) => e instanceof AcpRefusal && e.reason === 'not-found');
  assert.ok(!h.methods().includes('session/new'), 'no silent new session');
  await h.p.stop();
});

test('open: without the resume capability session/load is used and the replayed history never reaches a callback', async () => {
  const a = await open('ok', { resumeId: 'sess_fake_1' }, ['--no-resume']);
  assert.deepEqual(a.methods(), ['initialize', 'session/load']);
  assert.deepEqual(a.msgs()[1]!.params.mcpServers, [SHIM]);
  const { r, cb } = recorder();
  await a.session.prompt('hi', cb);
  assert.ok(!r.text.join('').includes('old history'));
  await a.p.stop();
});

test('open: modelId calls session/set_model and mode calls session/set_mode (only when given)', async () => {
  const a = await open('ok', { modelId: 'prov:model-b', mode: 'accept_edits' });
  const m = a.msgs();
  assert.deepEqual(m.filter((x) => x.method === 'session/set_model').map((x) => x.params), [{ sessionId: 'sess_fake_1', modelId: 'prov:model-b' }]);
  assert.deepEqual(m.filter((x) => x.method === 'session/set_mode').map((x) => x.params), [{ sessionId: 'sess_fake_1', modeId: 'accept_edits' }]);
  await a.p.stop();
  const b = await open('ok');
  assert.ok(!b.methods().includes('session/set_model') && !b.methods().includes('session/set_mode'));
  await b.p.stop();
});

// ---------------------------------------------------------------- prompt

test('prompt: chunks, thoughts and tool calls reach the callbacks; the update inherits the start\'s tool name; usage deltas are 100 then 150', async () => {
  const a = await open('ok');
  const one = recorder();
  const end1 = await a.session.prompt('hi', one.cb);
  assert.equal(end1.stopReason, 'end_turn');
  assert.deepEqual(one.r.text, ['hello ', 'world']);
  assert.deepEqual(one.r.thought, ['thinking']);
  assert.equal(one.r.starts.length, 1);
  assert.equal(one.r.starts[0]!.toolName, 'Bash');
  assert.equal(one.r.starts[0]!.input.command, 'ls');
  assert.equal(one.r.updates.length, 1);
  assert.equal(one.r.updates[0]!.toolName, 'Bash');
  assert.equal(one.r.updates[0]!.status, 'completed');
  assert.deepEqual(one.r.usage, [{ input: 100, output: 20 }]);
  assert.deepEqual(end1.usage, { input: 100, output: 20 });
  assert.deepEqual(end1.cumulative, { input: 100, output: 20 }, 'the latest cumulative counters, for the caller to store');
  assert.equal(end1.baselineUnknown, undefined, 'a new session starts at 0: the baseline is known');
  const two = recorder();
  const end2 = await a.session.prompt('again', two.cb);
  assert.deepEqual(two.r.usage, [{ input: 150, output: 40 }]);
  assert.deepEqual(end2.usage, { input: 150, output: 40 });
  assert.deepEqual(end2.cumulative, { input: 250, output: 60 });
  const sent = a.msgs().filter((m) => m.method === 'session/prompt');
  assert.deepEqual(sent[0]!.params, { sessionId: 'sess_fake_1', prompt: [{ type: 'text', text: 'hi' }] });
  await a.p.stop();
});

test('prompt: a plan update becomes todo items for onPlan', async () => {
  const a = await open('plan');
  const { r, cb } = recorder();
  await a.session.prompt('hi', cb);
  assert.deepEqual(r.plans, [[{ content: 'read the code', status: 'completed' }, { content: 'fix it', status: 'in_progress' }]]);
  await a.p.stop();
});

test('prompt: a second prompt while a turn runs is refused', async () => {
  const a = await open('cancel');
  const { cb } = recorder();
  const turn = a.session.prompt('one', cb);
  await assert.rejects(a.session.prompt('two', cb), /already/);
  await a.session.cancel();
  assert.equal((await turn).stopReason, 'cancelled');
  await a.p.stop();
});

test('prompt: a crash rejects with the closed connection, not a stop reason', async () => {
  const a = await open('crash');
  await assert.rejects(a.session.prompt('hi', recorder().cb), (e) => e instanceof RpcClosed);
  await a.p.exited;
});

// ---------------------------------------------------------------- permission

test('permission: the request reaches onPermission as Bash with input.command from rawInput; the chosen optionId goes back verbatim', async () => {
  const a = await open('permission');
  const perms: MappedPermission[] = [];
  const { r, cb } = recorder({ onPermission: async (q) => { perms.push(q); return { optionId: 'allow_session' }; } });
  const end = await a.session.prompt('hi', cb);
  assert.equal(end.stopReason, 'end_turn');
  r.perms.push(...perms);
  assert.equal(r.perms.length, 1);
  assert.equal(r.perms[0]!.toolName, 'Bash');
  assert.equal(r.perms[0]!.input.command, 'rm -rf build');
  assert.equal(r.perms[0]!.requestId, 'perm-check-1');
  assert.deepEqual(r.perms[0]!.options.map((o) => [o.optionId, o.name, o.kind]), [['allow_once', 'Allow once', 'allow_once'], ['allow_session', 'Allow for session', 'allow_always'], ['allow_always', 'Allow always', 'allow_always'], ['deny', 'Deny', 'reject_once']]);
  const answer = a.msgs().find((m) => m.id === 9001)!;
  assert.deepEqual(answer.result, { outcome: { outcome: 'selected', optionId: 'allow_session' } });
  // the closing update for a card that never had a start does not reach onToolUpdate as a new tool
  assert.equal(r.starts.length, 0);
  await a.p.stop();
});

test('permission: a cancelled answer, an unknown optionId and a throwing callback are all answered cancelled', async () => {
  const picks: Array<AcpCallbacks['onPermission']> = [async () => ({ cancelled: true }), async () => ({ optionId: 'not-offered' }), async () => { throw new Error('card failed'); }];
  for (const pick of picks) {
    const a = await open('permission');
    const end = await a.session.prompt('hi', recorder({ onPermission: pick }).cb);
    assert.equal(end.stopReason, 'cancelled');
    assert.deepEqual(a.msgs().find((m) => m.id === 9001)!.result, { outcome: { outcome: 'cancelled' } });
    await a.p.stop();
  }
});

test('cancel: session/cancel is sent and the turn ends cancelled', async () => {
  const a = await open('cancel');
  const { r, cb } = recorder();
  const turn = a.session.prompt('hi', cb);
  await waitFor(() => r.text.length > 0);
  await a.session.cancel();
  assert.equal((await turn).stopReason, 'cancelled');
  assert.deepEqual(a.msgs().filter((m) => m.method === 'session/cancel').map((m) => m.params), [{ sessionId: 'sess_fake_1' }]);
  await a.session.cancel(); // no turn open: nothing to do, nothing thrown
  assert.equal(a.msgs().filter((m) => m.method === 'session/cancel').length, 1);
  await a.p.stop();
});

test('cancel: an open permission request is answered cancelled at once and the late answer of the card is dropped', async () => {
  const a = await open('permission');
  let release!: (v: { optionId: string }) => void;
  const seen: MappedPermission[] = [];
  const { cb } = recorder({ onPermission: (q) => { seen.push(q); return new Promise((res) => { release = res; }); } });
  const turn = a.session.prompt('hi', cb);
  await waitFor(() => seen.length === 1);
  await a.session.cancel();
  assert.equal((await turn).stopReason, 'cancelled');
  assert.deepEqual(a.msgs().find((m) => m.id === 9001)!.result, { outcome: { outcome: 'cancelled' } });
  release({ optionId: 'allow_once' }); // too late: must not throw or send a second reply
  await sleep(100);
  assert.equal(a.msgs().filter((m) => m.id === 9001).length, 1);
  await a.p.stop();
});

test('cancel: when the connection closes after cancel() the turn ends cancelled instead of throwing', async () => {
  const a = await open('hang', { cancelGraceMs: 60_000 });
  const turn = a.session.prompt('hi', recorder().cb);
  await sleep(100);
  await a.session.cancel();
  a.p.killNow();
  assert.equal((await turn).stopReason, 'cancelled');
});

test('cancel: an agent that ignores session/cancel is given the grace period, then the turn ends cancelled', async () => {
  assert.equal(ACP_CANCEL_GRACE_MS, 10_000);
  const a = await open('hang', { cancelGraceMs: 300 });
  const turn = a.session.prompt('hi', recorder().cb);
  await sleep(100);
  const t0 = Date.now();
  await a.session.cancel();
  assert.equal((await turn).stopReason, 'cancelled');
  assert.ok(Date.now() - t0 >= 250, 'waited for the grace period');
  a.p.killNow();
});

// ---------------------------------------------------------------- other sessions

test('a session/update and a permission request for another sessionId are ignored (the daemon is shared with other clients)', async () => {
  const a = await open('foreign');
  const { r, cb } = recorder();
  const end = await a.session.prompt('hi', cb);
  assert.equal(end.stopReason, 'end_turn');
  assert.ok(!r.text.join('').includes('LEAK'));
  assert.equal(r.perms.length, 0, 'no card for another session');
  assert.deepEqual(r.text, ['hello ', 'world']);
  await waitFor(() => a.msgs().some((m) => m.id === 9002)); // the agent logs Legion's answer a moment after the turn has ended
  assert.deepEqual(a.msgs().find((m) => m.id === 9002)!.result, { outcome: { outcome: 'cancelled' } });
  assert.ok(a.msgs().every((m) => m.params?.sessionId === undefined || m.params.sessionId === 'sess_fake_1'), 'Legion only ever names its own session');
  await a.p.stop();
});

// ---------------------------------------------------------------- watchdog

test('watchdog: no update for watchdogMs sends session/cancel and the turn ends watchdog (even though the agent answers cancelled)', async () => {
  const a = await open('cancel', { watchdogMs: 300 });
  const t0 = Date.now();
  const end = await a.session.prompt('hi', recorder().cb);
  assert.equal(end.stopReason, 'watchdog');
  assert.ok(Date.now() - t0 >= 250);
  assert.equal(a.msgs().filter((m) => m.method === 'session/cancel').length, 1);
  await a.p.stop();
});

test('watchdog: an agent that ignores the cancel is waited for the grace period only, then the turn ends watchdog', async () => {
  const a = await open('hang', { watchdogMs: 200, cancelGraceMs: 300 });
  const t0 = Date.now();
  const end = await a.session.prompt('hi', recorder().cb);
  assert.equal(end.stopReason, 'watchdog');
  assert.ok(Date.now() - t0 >= 450, `took ${Date.now() - t0} ms`);
  assert.equal(a.msgs().filter((m) => m.method === 'session/cancel').length, 1);
  a.p.killNow();
});

test('watchdog: an open permission request pauses it; the window restarts when the card is answered', async () => {
  const a = await open('permission', { watchdogMs: 200 });
  const { cb } = recorder({ onPermission: async () => { await sleep(700); return { optionId: 'allow_once' }; } });
  const end = await a.session.prompt('hi', cb);
  assert.equal(end.stopReason, 'end_turn');
  assert.ok(!a.methods().includes('session/cancel'));
  await a.p.stop();
});

test('watchdog: a slow turn that keeps updating is never cancelled (each own-session update restarts the window)', async () => {
  // 15 chunks, one every 100 ms: the stream lasts 1.5 s, well past the 400 ms window, but no gap is longer than the window
  const a = await open('stream', { watchdogMs: 400 }, ['--chunks', '15', '--interval', '100']);
  const { r, cb } = recorder();
  const t0 = Date.now();
  const end = await a.session.prompt('hi', cb);
  assert.equal(end.stopReason, 'end_turn');
  assert.ok(Date.now() - t0 > 1200, `the turn must outlast the window (${Date.now() - t0} ms)`);
  assert.equal(r.text.length, 15);
  assert.ok(!a.methods().includes('session/cancel'));
  await a.p.stop();
});

test('watchdog: updates for another sessionId do not restart the window (the turn is cancelled)', async () => {
  // the agent streams to sess_other every 100 ms for up to 10 s and stops at session/cancel
  const a = await open('stream', { watchdogMs: 400, cancelGraceMs: 5_000 }, ['--chunks', '100', '--interval', '100', '--to', 'sess_other']);
  const { r, cb } = recorder();
  const t0 = Date.now();
  const end = await a.session.prompt('hi', cb);
  const took = Date.now() - t0;
  assert.equal(end.stopReason, 'watchdog');
  assert.ok(took >= 350 && took < 3000, `took ${took} ms`);
  assert.deepEqual(r.text, [], 'nothing from the other session reached the callbacks');
  assert.equal(a.msgs().filter((m) => m.method === 'session/cancel').length, 1);
  await a.p.stop();
});

test('watchdog: an open permission request pauses it only up to the cap; after that the watchdog runs again and cancels the card', async () => {
  assert.equal(ACP_PERMISSION_PAUSE_CAP_MS, 305_000, 'Hermes denies a waiting approval itself after 300 s; the cap adds a small margin');
  const a = await open('permission', { watchdogMs: 200, permissionPauseCapMs: 400, cancelGraceMs: 5_000 });
  const { cb } = recorder({ onPermission: () => new Promise(() => undefined) }); // the card is never answered
  const t0 = Date.now();
  const end = await a.session.prompt('hi', cb);
  const took = Date.now() - t0;
  assert.equal(end.stopReason, 'watchdog');
  assert.ok(took >= 550 && took < 3000, `paused for the cap (400 ms), then one window (200 ms): took ${took} ms`);
  assert.equal(a.msgs().filter((m) => m.method === 'session/cancel').length, 1);
  assert.deepEqual(a.msgs().find((m) => m.id === 9001)!.result, { outcome: { outcome: 'cancelled' } });
  await a.p.stop();
});

// ---------------------------------------------------------------- an error answer after Legion's cancel

test('cancel: an error answer to the prompt after cancel() or after the watchdog ends the turn cancelled / watchdog, not a rejection', async () => {
  const a = await open('cancel', {}, ['--cancel-error']);
  const one = recorder();
  const turn = a.session.prompt('hi', one.cb);
  await waitFor(() => one.r.text.length > 0);
  await a.session.cancel();
  assert.equal((await turn).stopReason, 'cancelled');
  await a.p.stop();

  const b = await open('cancel', { watchdogMs: 300 }, ['--cancel-error']);
  assert.equal((await b.session.prompt('hi', recorder().cb)).stopReason, 'watchdog');
  assert.equal(b.msgs().filter((m) => m.method === 'session/cancel').length, 1);
  await b.p.stop();
});

test('prompt: an error answer when Legion did not cancel still rejects', async () => {
  const a = await open('ok', {}, ['--prompt-error']);
  await assert.rejects(a.session.prompt('hi', recorder().cb), (e) => e instanceof RpcError && /something broke|Internal error/.test(e.message + JSON.stringify(e.data)));
  await a.p.stop();
});

// ---------------------------------------------------------------- usage baseline

test('usage: a stored baseline makes the first resumed turn count only its own tokens; the turn end carries the cumulative counters', async () => {
  const a = await open('ok', { resumeId: 'sess_fake_1', usageBaseline: { input: 60, output: 10 } });
  const one = recorder();
  const end1 = await a.session.prompt('hi', one.cb); // the agent reports 100/20 cumulative
  assert.deepEqual(end1.usage, { input: 40, output: 10 });
  assert.deepEqual(one.r.usage, [{ input: 40, output: 10 }]);
  assert.deepEqual(end1.cumulative, { input: 100, output: 20 });
  assert.equal(end1.baselineUnknown, undefined);
  const end2 = await a.session.prompt('again', recorder().cb); // 250/60
  assert.deepEqual(end2.usage, { input: 150, output: 40 });
  assert.deepEqual(end2.cumulative, { input: 250, output: 60 });
  await a.p.stop();
});

test('usage: a resumed session without a baseline counts 0 for its first turn and says so; later turns count normally', async () => {
  const a = await open('ok', { resumeId: 'sess_fake_1' });
  const one = recorder();
  const end1 = await a.session.prompt('hi', one.cb);
  assert.deepEqual(end1.usage, { input: 0, output: 0 });
  assert.deepEqual(one.r.usage, [{ input: 0, output: 0 }]);
  assert.equal(end1.baselineUnknown, true);
  assert.deepEqual(end1.cumulative, { input: 100, output: 20 }, 'the caller stores this as the new baseline');
  const end2 = await a.session.prompt('again', recorder().cb);
  assert.deepEqual(end2.usage, { input: 150, output: 40 });
  assert.equal(end2.baselineUnknown, undefined);
  await a.p.stop();
});

// ---------------------------------------------------------------- a failed set_model / set_mode

test('open: a failed session/set_model closes the new session when the agent offers session/close, then throws', async () => {
  const h = launch('ok', ['--fail-set-model', 'model blew up', '--with-close']);
  await assert.rejects(AcpSession.open(h.p, initOf({ modelId: 'prov:model-b' })), /model blew up/);
  const m = h.msgs();
  assert.deepEqual(m.filter((x) => x.method === 'session/close').map((x) => x.params), [{ sessionId: 'sess_fake_1' }]);
  assert.equal(m.at(-1)!.method, 'session/close', 'the close comes after the failed call');
  await h.p.stop();

  const g = launch('ok', ['--fail-set-mode', 'mode blew up', '--with-close']);
  await assert.rejects(AcpSession.open(g.p, initOf({ mode: 'dont_ask' })), /mode blew up/);
  assert.deepEqual(g.methods().filter((x) => x === 'session/close'), ['session/close']);
  await g.p.stop();
});

test('open: a failed session/set_model without session/close in the agent\'s capabilities sends no close, and a resumed session is never closed', async () => {
  const h = launch('ok', ['--fail-set-model', 'model blew up']);
  await assert.rejects(AcpSession.open(h.p, initOf({ modelId: 'x' })), /model blew up/);
  assert.ok(!h.methods().includes('session/close'));
  await h.p.stop();

  const g = launch('ok', ['--fail-set-model', 'model blew up', '--with-close']);
  await assert.rejects(AcpSession.open(g.p, initOf({ modelId: 'x', resumeId: 'sess_fake_1' })), /model blew up/);
  assert.ok(!g.methods().includes('session/close'), 'the session existed before this call: it is not ours to close');
  await g.p.stop();
});

// ---------------------------------------------------------------- final wave: open requests are capped, a second request re-arms the watchdog

const scriptOf = (steps: unknown[]): string[] => { const f = join(tempDir('acp-script-'), 'script.json'); writeFileSync(f, JSON.stringify(steps)); return ['--script', f]; };
const ASK = (id: string) => ({ op: 'permission', id, title: `run ${id}`, kind: 'execute', rawInput: { command: 'ls' }, async: true });

test('F10: more than eight open permission requests at once: the extra ones get the agent\'s reject option at once, with one note per turn', async () => {
  assert.equal(ACP_MAX_OPEN_PERMISSIONS, 8);
  const steps = [...Array.from({ length: 12 }, (_, i) => ASK(`c${i}`)), { op: 'wait', ms: 700 }, { op: 'end', stopReason: 'end_turn' }];
  const a = await open('script', {}, scriptOf(steps));
  const notes: string[] = [];
  const { r, cb } = recorder({ onPermission: (q) => { r.perms.push(q); return new Promise(() => undefined); }, onNote: (t) => notes.push(t) });
  const end = await a.session.prompt('hi', cb);
  assert.equal(end.stopReason, 'end_turn');
  assert.equal(r.perms.length, 8, 'only eight reached the caller');
  const answers = a.msgs().filter((m) => m.result !== undefined && m.id >= 9100 && m.id < 9112);
  const rejected = answers.filter((m) => m.result.outcome.outcome === 'selected' && m.result.outcome.optionId === 'deny');
  assert.equal(rejected.length, 4, 'the other four were answered with Hermes\'s own reject option');
  assert.equal(notes.length, 1, 'one note, not one per request');
  assert.ok(!/[\u2013\u2014]/.test(notes[0]!));
  await a.p.stop();
});

test('a second permission request after the pause cap does not leave the turn without a watchdog', async () => {
  // request 1 at 0 ms pauses the watchdog until the cap (300 ms), the watchdog would fire at 500 ms; request 2 at 400 ms must re-arm it, so the turn still ends 'watchdog'
  const steps = [ASK('c1'), { op: 'wait', ms: 400 }, ASK('c2'), { op: 'waitCancel' }, { op: 'end', stopReason: 'cancelled' }];
  const a = await open('script', { watchdogMs: 200, permissionPauseCapMs: 300, cancelGraceMs: 400 }, scriptOf(steps));
  const { cb } = recorder({ onPermission: () => new Promise(() => undefined) });
  const t0 = Date.now();
  const end = await Promise.race([a.session.prompt('hi', cb), sleep(6000).then(() => ({ stopReason: 'never' as const }))]);
  assert.equal(end.stopReason, 'watchdog', `took ${Date.now() - t0} ms`);
  await a.p.stop();
});
