import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { initialPrompt } from '../src/core/input-channel.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, Task } from '../src/shared/types.js';

type Call = { agent: string; prompt: string; options: any; n: number };
type Script = (c: Call) => AsyncGenerator<any, void> | undefined;

const mkAgent = (id: string, name: string): AgentProfile => ({
  id, name, emoji: '*', description: `${name} does things`, systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [],
  createdAt: '', updatedAt: '',
});

let sidN = 0;
const ok = (text: string, sid: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, num_turns: 1, session_id: sid });

function setup(script: Script, maxConcurrent = 1) {
  const dir = cleanupTemp('legion-br-');
  const store = new Store(dir);
  for (const [id, name] of [['zealot', 'Zealot'], ['builder', 'Builder'], ['scout', 'Scout'], ['worker', 'Worker']]) store.upsertAgent(mkAgent(id!, name!));
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  const calls: Call[] = [];
  const queryFn = ((p: any) => {
    const agent = basename(p.options.cwd);
    const call: Call = { agent, prompt: initialPrompt(p.prompt), options: p.options, n: calls.filter((c) => c.agent === agent).length };
    calls.push(call);
    const sid = `sess-${++sidN}`;
    const custom = script(call);
    const gen = custom ?? (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sid };
      yield ok(`${agent} says: ${initialPrompt(p.prompt).split('\n').pop()}`, sid);
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const engine = new Engine({ store, bus, vms: {} as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, maxConcurrent });
  return { store, bus, engine, calls };
}

/** Invoke one of the agent's own in-process tools, exactly as the model would. */
async function callTool(options: any, name: string, args: any): Promise<{ isError?: boolean; text: string; json?: any }> {
  const t = options.mcpServers.legion.instance._registeredTools[name];
  const r = await t.handler(args, {});
  const text = r.content.map((c: any) => c.text).join('\n');
  let json: any; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { isError: r.isError, text, json };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const gated = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });

test('ask round-trip: result returned, pair thread stored with fromAgentId, header only in prompt, cap bypass with maxConcurrent 1', async () => {
  let asked: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    asked = await callTool(c.options, 'ask', { agent: 'builder', message: 'build it' });
    yield ok(`zealot got: ${asked.json.result}`, 'z1');
  })(), 1);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const done = await s.engine.waitFor(z.id, 5000);
  assert.equal(done.status, 'done');
  assert.equal(asked.isError, undefined);
  assert.equal(asked.json.status, 'done');
  assert.equal(asked.json.model, 'sonnet');
  assert.equal(asked.json.result, 'builder says: build it');
  assert.match(done.result!, /builder says: build it/);

  const bt = s.store.getTask(asked.json.taskId)!;
  assert.equal(bt.agentId, 'builder');
  assert.equal(bt.source, 'agent');
  assert.equal(bt.fromAgentId, 'zealot');
  assert.equal(bt.parentTaskId, z.id);
  assert.equal(bt.title, 'Zealot: build it');
  const msgs = s.store.listMessages(bt.id);
  assert.equal(msgs[0]!.role, 'user');
  assert.equal(msgs[0]!.text, 'build it');
  assert.equal(msgs[0]!.fromAgentId, 'zealot');
  const builderCall = s.calls.find((c) => c.agent === 'builder')!;
  assert.equal(builderCall.prompt, '[From Zealot (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]\nbuild it');
  assert.deepEqual(builderCall.options.disallowedTools, ['SendMessage', 'ListAgents']);
  assert.match(builderCall.options.systemPrompt.append, /mcp__legion__ask/);
});

test('pair thread is reused (session resumed) unless fresh', async () => {
  const ids: string[] = [];
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    ids.push((await callTool(c.options, 'ask', { agent: 'Builder', message: 'one' })).json.taskId);
    ids.push((await callTool(c.options, 'ask', { agent: 'builder', message: 'two' })).json.taskId);
    ids.push((await callTool(c.options, 'ask', { agent: 'builder', message: 'three', fresh: true })).json.taskId);
    yield ok('done', 'z1');
  })());
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[2], ids[0]);
  const bc = s.calls.filter((c) => c.agent === 'builder');
  assert.equal(bc[0]!.options.resume, undefined);
  assert.ok(bc[1]!.options.resume, 'second message resumes the thread session');
  assert.equal(bc[2]!.options.resume, undefined);
  assert.equal(s.store.listMessages(ids[0]!).filter((m) => m.role === 'user').length, 2);
});

test('agents tool: compact roster with status and thread flag', async () => {
  let text = '';
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    await callTool(c.options, 'ask', { agent: 'scout', message: 'hi' });
    text = (await callTool(c.options, 'agents', {})).text;
    yield ok('x', 'z1');
  })());
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(!lines.some((l) => l.startsWith('zealot')));
  assert.match(lines.find((l) => l.startsWith('scout'))!, /^scout \| Scout \| .* \| idle \| thread$/);
  assert.match(lines.find((l) => l.startsWith('builder'))!, /\| idle \| no-thread$/);
});

test('busy target thread: messages queue FIFO and each ask gets its own run result', async () => {
  const g = gated();
  const s = setup((c) => c.agent === 'builder' && c.n === 0 ? (async function* () { yield init('b1'); await g.p; yield ok('first', 'b1'); })() : undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  const t1 = s.engine.bridge.tell(z.id, 'builder', 'm1');
  await tick();
  assert.equal(s.store.getTask(t1.taskId)!.status, 'running');
  const p2 = s.engine.bridge.ask(z.id, 'builder', 'm2');
  const p3 = s.engine.bridge.ask(z.id, 'builder', 'm3');
  await tick();
  assert.equal(s.calls.filter((c) => c.agent === 'builder').length, 1, 'queued, not started');
  g.open();
  const [r2, r3] = await Promise.all([p2, p3]);
  assert.equal(r2.taskId, t1.taskId);
  assert.equal(r2.result, 'builder says: m2');
  assert.equal(r3.result, 'builder says: m3');
  assert.deepEqual(s.calls.filter((c) => c.agent === 'builder').map((c) => c.prompt.split('\n').pop()), ['m1', 'm2', 'm3']);
});

test('tell: reply is delivered into the caller task as a new user turn (caller idle), resuming its session', async () => {
  const s = setup(() => undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const zdone = await s.engine.waitFor(z.id, 3000);
  const { taskId } = s.engine.bridge.tell(z.id, 'scout', 'research x');
  await tick(150);
  const zmsgs = s.store.listMessages(z.id).filter((m) => m.role === 'user');
  assert.equal(zmsgs.length, 2);
  assert.equal(zmsgs[1]!.text, `[Reply from Scout · task ${taskId}] scout says: research x`);
  assert.equal(zmsgs[1]!.fromAgentId, 'scout');
  const zc = s.calls.filter((c) => c.agent === 'zealot');
  assert.equal(zc.length, 2);
  assert.equal(zc[1]!.options.resume, zdone.sessionId);
  assert.equal(zc[1]!.prompt, zmsgs[1]!.text, 'no header on replies');
  assert.equal(s.store.getTask(z.id)!.fromAgentId, undefined, 'reply does not rewrite the caller task origin');
  await s.engine.waitFor(z.id, 3000);
});

test('tell: if the caller is still running, the reply waits until it finishes (at most one reply)', async () => {
  const g = gated();
  const s = setup((c) => c.agent === 'zealot' && c.n === 0 ? (async function* () { yield init('z1'); await g.p; yield ok('zealot first', 'z1'); })() : undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await tick();
  s.engine.bridge.tell(z.id, 'scout', 'quick');
  await tick(100);
  assert.equal(s.calls.filter((c) => c.agent === 'scout').length, 1);
  assert.equal(s.calls.filter((c) => c.agent === 'zealot').length, 1, 'reply not delivered while caller runs');
  g.open();
  await tick(150);
  const zc = s.calls.filter((c) => c.agent === 'zealot');
  assert.equal(zc.length, 2);
  assert.match(zc[1]!.prompt, /^\[Reply from Scout · task /);
  await s.engine.waitFor(z.id, 3000);
  await tick(50);
  assert.equal(s.calls.filter((c) => c.agent === 'zealot').length, 2);
});

test('guards: self, unknown agent, depth, deadlock (ask) vs allowed (tell)', async () => {
  const s = setup(() => undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  await assert.rejects(s.engine.bridge.ask(z.id, 'zealot', 'me'), /yourself/);
  await assert.rejects(s.engine.bridge.ask(z.id, 'nobody', 'x'), /Unknown agent/);
  assert.throws(() => s.engine.bridge.tell(z.id, 'Zealot', 'me'), /yourself/);

  // depth: t1 zealot <- t2 builder <- t3 scout <- t4 worker (3 ancestors) cannot delegate further
  const mk = (id: string, agentId: string, parent?: string): Task => s.store.upsertTask({
    id, agentId, title: id, status: 'done', source: 'agent', parentTaskId: parent, requestedModel: 'auto', createdAt: '', updatedAt: '',
  });
  mk('t1', 'zealot'); mk('t2', 'builder', 't1'); mk('t3', 'scout', 't2'); mk('t4', 'worker', 't3');
  await assert.rejects(s.engine.bridge.ask('t4', 'zealot', 'x'), /delegation too deep/);
  assert.throws(() => s.engine.bridge.tell('t4', 'builder', 'x'), /delegation too deep/);
});

test('deadlock guard: builder (asked by a waiting zealot) cannot ask zealot back; tell is allowed', async () => {
  let back: any, tellBack: any;
  const s = setup((c) => {
    if (c.agent === 'zealot' && c.n === 0) return (async function* () {
      yield init('z1');
      await callTool(c.options, 'ask', { agent: 'builder', message: 'help' });
      yield ok('zealot done', 'z1');
    })();
    if (c.agent === 'builder' && c.n === 0) return (async function* () {
      yield init('b1');
      back = await callTool(c.options, 'ask', { agent: 'zealot', message: 'loop?' });
      tellBack = await callTool(c.options, 'tell', { agent: 'zealot', message: 'fyi' });
      yield ok('builder done', 'b1');
    })();
    return undefined;
  }, 1);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const done = await s.engine.waitFor(z.id, 5000);
  assert.equal(done.status, 'done');
  assert.equal(back.isError, true);
  assert.match(back.text, /would deadlock/);
  assert.equal(tellBack.isError, undefined);
  assert.ok(tellBack.json.taskId);
  await tick(200);
});

test('nested asks with maxConcurrent 1 do not deadlock (zealot -> builder -> scout)', async () => {
  let inner: any;
  const s = setup((c) => {
    if (c.agent === 'zealot') return (async function* () {
      yield init('z1');
      const r = await callTool(c.options, 'ask', { agent: 'builder', message: 'outer' });
      yield ok(`Z<${r.json.result}>`, 'z1');
    })();
    if (c.agent === 'builder') return (async function* () {
      yield init('b1');
      inner = await callTool(c.options, 'ask', { agent: 'scout', message: 'inner' });
      yield ok(`B<${inner.json.result}>`, 'b1');
    })();
    return undefined;
  }, 1);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const done = await s.engine.waitFor(z.id, 5000);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Z<B<scout says: inner>>');
  const scoutTask = s.store.getTask(inner.json.taskId)!;
  assert.equal(scoutTask.fromAgentId, 'builder');
});

test('ask result is cut to 4000 chars with a pointer to the full text; ask timeout returns running', async () => {
  const s = setup((c) => c.agent === 'builder' && c.prompt.endsWith('big') ? (async function* () { yield init('b1'); yield ok('x'.repeat(9000), 'b1'); })() : c.agent === 'builder' && c.prompt.endsWith('slow') ? (async function* () { yield init('b2'); await new Promise(() => undefined); })() : undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  const r = await s.engine.bridge.ask(z.id, 'builder', 'big') as any;
  assert.ok(r.result.length < 4400);
  assert.match(r.result, /\[truncated: 5000 more chars\. The full result is kept: call task_result with taskId "task_\w+" and resultId "1"/);
  assert.equal(r.truncated, true);
  const t = await s.engine.bridge.ask(z.id, 'scout', 'slow-not-builder');
  assert.equal(t.status, 'done');
  const slow = await s.engine.bridge.ask(z.id, 'builder', 'slow', { fresh: true, timeoutSeconds: 0.05 }) as any;
  assert.equal(slow.status, 'running');
  assert.match(slow.note, /Timed out/);
  s.engine.cancel(slow.taskId);
});

test('cancelling the caller cancels its pending asks', async () => {
  let builderTask = '';
  const s = setup((c) => {
    if (c.agent === 'zealot') return (async function* () { yield init('z1'); await callTool(c.options, 'ask', { agent: 'builder', message: 'long' }); yield ok('never', 'z1'); })();
    if (c.agent === 'builder') return (async function* () { yield init('b1'); await new Promise(() => undefined); })();
    return undefined;
  }, 1);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await tick(100);
  builderTask = s.store.listTasks(10, 'builder', true)[0]!.id;
  assert.equal(s.store.getTask(builderTask)!.status, 'running');
  assert.equal(s.engine.cancel(z.id), true);
  await tick(100);
  assert.equal(s.store.getTask(z.id)!.status, 'cancelled');
  assert.equal(s.store.getTask(builderTask)!.status, 'cancelled');
});

test('mascot note shows "Zealot → Builder" for bridge runs', async () => {
  const s = setup(() => undefined, 4);
  const notes: string[] = [];
  s.bus.on((e) => { if (e.type === 'mascot' && e.note) notes.push(e.note); });
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  await s.engine.bridge.ask(z.id, 'builder', 'hey');
  assert.ok(notes.includes('Zealot → Builder'), notes.join('|'));
});

test('tell ping-pong stops at the hop limit (<= 7 runs) with a clear error', async () => {
  const errors: string[] = [];
  const s = setup((c) => {
    if (c.prompt.split('\n').pop()!.startsWith('[Reply from')) return undefined; // replies do not tell again
    if (c.agent !== 'zealot' && c.agent !== 'builder') return undefined;
    const other = c.agent === 'zealot' ? 'builder' : 'zealot';
    return (async function* () {
      yield init(`s-${c.agent}-${c.n}`);
      const taskId = s.store.listTasks(50, c.agent, true).find((t) => t.status === 'running')!.id;
      const r = await callTool(c.options, 'tell', { agent: other, message: 'ping' });
      if (r.isError) errors.push(r.text);
      yield ok('pong', `s-${c.agent}-${c.n}`);
      void taskId;
    })();
  }, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'start', source: 'ui' });
  await s.engine.waitFor(z.id, 5000);
  await tick(600);
  const runs = s.calls.filter((c) => !c.prompt.split('\n').pop()!.startsWith('[Reply from'));
  assert.ok(runs.length <= 7, `ran ${runs.length} times`);
  assert.equal(runs.length, 7);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'Error: Bridge hop limit reached (6). Finish the work yourself or ask the user.');
  // a human continuing a task resets its hop
  const hopTask = s.store.listTasks(50, undefined, true).find((t) => (t.bridgeHop ?? 0) >= 5)!;
  s.engine.startTask({ agentId: hopTask.agentId, prompt: 'human here', source: 'ui', continueTaskId: hopTask.id });
  assert.equal(s.store.getTask(hopTask.id)!.bridgeHop, undefined);
  await tick(200);
});

test('rate limit: 30 deliveries per (caller, target) per 10 minutes', async () => {
  let t = 1_000_000;
  const s = setup(() => undefined, 4);
  (s.engine.bridge as any).now = () => t;
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  for (let i = 0; i < 30; i++) s.engine.bridge.tell(z.id, 'scout', `m${i}`);
  assert.throws(() => s.engine.bridge.tell(z.id, 'scout', 'one too many'), /Rate limit/);
  s.engine.bridge.tell(z.id, 'builder', 'other target is fine');
  t += 11 * 60_000;
  s.engine.bridge.tell(z.id, 'scout', 'window passed');
  await tick(300);
});

test('timeoutSeconds is clamped (NaN -> default, tiny -> 1s) and deleting a task cleans queues/waiters', async () => {
  const g = gated();
  const s = setup((c) => c.agent === 'builder' && c.n === 0 ? (async function* () { yield init('b1'); await g.p; yield ok('x', 'b1'); })() : undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  const first = s.engine.bridge.tell(z.id, 'builder', 'm1');
  await tick();
  const started = Date.now();
  const r = await s.engine.bridge.ask(z.id, 'builder', 'm2', { timeoutSeconds: 0.01 }) as any;
  assert.equal(r.status, 'running');
  assert.ok(Date.now() - started >= 900, 'clamped up to 1s');
  // ask with NaN timeout waits on the (default) timeout; delete the target thread to wake it
  const pending = s.engine.bridge.ask(z.id, 'builder', 'm3', { timeoutSeconds: NaN });
  await tick();
  s.engine.bridge.forget(first.taskId); // what the task.deleted event triggers
  await assert.rejects(pending, /deleted/);
  assert.equal((s.engine.bridge as any).queues.size, 0);
  g.open();
  await tick(100);
});

// ---- merged with the rooms module: approval ceiling and hidden agents ----
test('confused deputy: an ask from a stricter agent caps the target, even if the target runs in full mode', async () => {
  let asked: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    asked = await callTool(c.options, 'ask', { agent: 'builder', message: 'rm -rf it' });
    yield ok('done', 'z1');
  })(), 2);
  s.store.upsertAgent({ ...s.store.getAgent('zealot')!, approval: 'ask' });
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 5000);
  const bt = s.store.getTask(asked.json.taskId)!;
  assert.equal(bt.origin?.approvalCeiling, 'ask');
  assert.equal(bt.origin?.fromAgentId, 'zealot');
  const builderCall = s.calls.find((c) => c.agent === 'builder')!;
  assert.notEqual(builderCall.options.permissionMode, 'bypassPermissions');
  assert.equal(typeof builderCall.options.canUseTool, 'function');
});

test('ask from a full-mode agent leaves a full-mode target in bypass mode (no regression)', async () => {
  let asked: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    asked = await callTool(c.options, 'ask', { agent: 'builder', message: 'go' });
    yield ok('done', 'z1');
  })(), 2);
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(s.store.getTask(asked.json.taskId)!.origin?.approvalCeiling, 'full');
  assert.equal(s.calls.find((c) => c.agent === 'builder')!.options.permissionMode, 'bypassPermissions');
});

test('agents hidden by isVisible (BSV off) are neither listed nor reachable through ask/tell', async () => {
  let list = ''; let err: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    list = (await callTool(c.options, 'agents', {})).text;
    err = await callTool(c.options, 'ask', { agent: 'assayer', message: 'hi' });
    yield ok('x', 'z1');
  })());
  s.store.upsertAgent({ ...mkAgent('assayer', 'Assayer'), requires: 'bsv' });
  s.engine.bridge.isVisible = (a) => a.requires !== 'bsv';
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.ok(!list.includes('assayer'));
  assert.equal(err.isError, true);
  assert.match(err.text, /Unknown agent/);
});

test('tell: a reply from a run that failed carries its outcome in the header (the UI decides from it, never from the answer text)', async () => {
  const s = setup((c) => c.agent === 'scout' ? (async function* () { throw new Error('boom'); })() : undefined, 4);
  const z = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(z.id, 3000);
  const { taskId } = s.engine.bridge.tell(z.id, 'scout', 'research x');
  await tick(200);
  const reply = s.store.listMessages(z.id).filter((m) => m.role === 'user').at(-1)!;
  const head = `[Reply from Scout · task ${taskId} · `;
  assert.ok(reply.text.startsWith(head + 'error] ') || reply.text.startsWith(head + 'failed] '), reply.text);
});
