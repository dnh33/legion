import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { BackgroundTasks } from '../src/core/background-tasks.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, LegionEvent, Task } from '../src/shared/types.js';

// BUG-7: a run closed its input as soon as the lead answered, and Claude Code's background subagents died with it.
// The fake below plays Claude Code's side: with the input stream still open the background tasks finish and report; when the
// stream ends while they still run, they are stopped (task_notification "stopped"), as the real CLI does.

class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, Task>();
  msgs: ChatMessage[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  upsertTask(t: Task) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: ChatMessage) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}

const agent: AgentProfile = {
  id: 'zealot', name: 'Zealot', emoji: 'Z', description: '', systemPrompt: '', model: 'opus',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'], createdAt: '', updatedAt: '',
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 5 && !cond(); i++) await tick(5);
  assert.ok(cond(), 'condition not reached in time');
}

type TaskSpec = { id: string; type?: string; description: string; ambient?: boolean };
/** Set by a test: the fake emits a background agent's own message (parent_tool_use_id set) just before it reports. */
const chatter = { on: false };
interface Rig { finish(id: string): void; log: string[]; stoppedByClose: string[]; inputClosed(): boolean; stopped: string[] }

function setup(tasksToStart: TaskSpec[], opts: { level?: boolean; background?: { stallMs?: number; graceMs?: number; maxHeldMs?: number; now?: () => number }; quietAfterReports?: boolean } = {}) {
  const store = new FakeStore();
  store.agents.set(agent.id, agent);
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const config = defaultConfig();
  config.workspaceDir = join(cleanupTemp('legion-bg-'), 'ws');
  const rig: Rig = { finish: () => undefined, log: [], stoppedByClose: [], inputClosed: () => false, stopped: [] };
  let calls = 0;
  const queryFn = ((params: any) => {
    calls++;
    const gen = (async function* () {
      const it = (params.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
      const mailbox: Array<{ kind: 'user'; text: string } | { kind: 'finished'; id: string } | { kind: 'closed' }> = [];
      let wake: (() => void) | undefined;
      const push = (m: (typeof mailbox)[number]) => { mailbox.push(m); wake?.(); };
      const running = new Set<string>();
      let reported = 0;
      rig.finish = (id) => { if (running.has(id)) push({ kind: 'finished', id }); };
      void (async () => { for (;;) { const n = await it.next(); if (n.done) { rig.inputClosed = () => true; push({ kind: 'closed' }); return; } push({ kind: 'user', text: String(n.value.message.content) }); } })();
      const level = () => ({ type: 'system', subtype: 'background_tasks_changed', tasks: [...running].map((id) => { const t = tasksToStart.find((x) => x.id === id)!; return { task_id: id, task_type: t.type ?? 'local_agent', description: t.description, ...(t.ambient ? { ambient: true } : {}) }; }) });
      yield { type: 'system', subtype: 'init', session_id: 'sess-bg' };
      let started = false;
      for (;;) {
        while (!mailbox.length) await new Promise<void>((r) => { wake = r; });
        const m = mailbox.shift()!;
        if (m.kind === 'user' && !started) {
          started = true;
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'starting the agents' }] } };
          for (const t of tasksToStart) {
            running.add(t.id);
            yield { type: 'system', subtype: 'task_started', task_id: t.id, description: t.description, task_type: t.type ?? 'local_agent', is_backgrounded: true, ...(t.ambient ? { ambient: true } : {}) };
          }
          if (opts.level) yield level();
          yield { type: 'result', subtype: 'success', is_error: false, result: 'started', total_cost_usd: 0, num_turns: 1, session_id: 'sess-bg', queued_turn_count: 0 };
        } else if (m.kind === 'user') {
          rig.log.push(`user:${m.text}`);
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: `m-${rig.log.length}`, content: [{ type: 'text', text: `ack: ${m.text}` }] } };
          yield { type: 'result', subtype: 'success', is_error: false, result: `ack: ${m.text}`, total_cost_usd: 0, num_turns: 1, session_id: 'sess-bg', queued_turn_count: 0 };
        } else if (m.kind === 'finished') {
          running.delete(m.id);
          reported++;
          if (chatter.on) yield { type: 'assistant', parent_tool_use_id: `tu-${m.id}`, message: { id: `sub-${m.id}`, content: [{ type: 'text', text: 'subagent output' }] } };
          yield { type: 'system', subtype: 'task_notification', task_id: m.id, status: 'completed', output_file: '', summary: `${m.id} done` };
          if (opts.level) yield level();
          if (running.size === 0 && !opts.quietAfterReports) {
            // the model takes the notifications and reports
            yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm-final', content: [{ type: 'text', text: `all ${reported} reported` }] } };
            yield { type: 'result', subtype: 'success', is_error: false, result: `all ${reported} reported`, total_cost_usd: 0, num_turns: 1, session_id: 'sess-bg', queued_turn_count: 0 };
          }
        } else {
          // the input stream ended: Claude Code kills what still runs and exits
          for (const id of running) { rig.stoppedByClose.push(id); yield { type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', output_file: '', summary: "I've stopped as you asked" }; }
          return;
        }
      }
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}), stopTask: async (id: string) => { rig.stopped.push(id); } });
  }) as unknown as QueryFn;
  const engine = new Engine({
    store: store as any, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(bus), config, queryFn,
    boatConfigured: () => false, ...(opts.background ? { background: opts.background } : {}),
  });
  return { store, engine, events, rig, calls: () => calls };
}

const TWO: TaskSpec[] = [{ id: 'bgA', description: 'build the page' }, { id: 'bgB', description: 'write the tests' }];
const sys = (s: ReturnType<typeof setup>, id: string) => s.store.listMessages(id).filter((m) => m.role === 'system').map((m) => m.text);

for (const level of [true, false]) {
  test(`lead starts 2 background tasks, answers an unrelated message: both still finish and report (${level ? 'level signal' : 'edge messages'})`, async () => {
    const s = setup(TWO, { level });
    const t = s.engine.startTask({ agentId: 'zealot', prompt: 'run the two builders', source: 'ui' });
    await until(() => sys(s, t.id).some((x) => /Waiting for 2 background agents/.test(x)));
    assert.equal(s.engine.progressSnapshot()[t.id]?.background, 2, 'the app is told how many it waits on');
    // the lead answers something unrelated (its own result closes the input in the old code)
    const again = s.engine.startTask({ agentId: 'zealot', prompt: 'unrelated question', source: 'ui', continueTaskId: t.id });
    assert.equal(again.id, t.id);
    await until(() => s.rig.log.includes('user:unrelated question'));
    await until(() => s.store.listMessages(t.id).some((m) => m.text === 'ack: unrelated question'));
    assert.equal(s.store.getTask(t.id)!.status, 'running', 'the run stays open while the agents work');
    assert.equal(s.rig.inputClosed(), false, 'the input stays open');
    s.rig.finish('bgA');
    await tick(40);
    assert.equal(s.store.getTask(t.id)!.status, 'running', 'one still works');
    assert.equal(s.engine.progressSnapshot()[t.id]?.background, 1);
    s.rig.finish('bgB');
    const done = await s.engine.waitFor(t.id, 3000);
    assert.equal(done.status, 'done');
    assert.equal(done.result, 'all 2 reported');
    assert.deepEqual(s.rig.stoppedByClose, [], 'nothing was killed by a close');
    assert.equal(s.calls(), 1, 'one Claude run for all of it');
    assert.equal(s.engine.progressSnapshot()[t.id], undefined);
  });
}

test('a run with no background agents still ends at its result', async () => {
  const s = setup([]);
  const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'started');
});

test('a background shell, an ambient watcher and an mcp task are not waited on', async () => {
  const s = setup([{ id: 'sh', type: 'local_bash', description: 'dev server' }, { id: 'w', type: 'local_agent', description: 'watcher', ambient: true }, { id: 'm', type: 'mcp_task', description: 'x' }], { level: true });
  const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
});

test('Stop cancels a run that waits on background agents at once', async () => {
  const s = setup(TWO, { level: true });
  const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await until(() => sys(s, t.id).some((x) => /Waiting for 2 background agents/.test(x)));
  assert.equal(s.engine.cancel(t.id), true);
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'cancelled');
});

test('no message from the background agents for the cap: Legion says so and closes the run', async () => {
  const s = setup(TWO, { level: true, background: { stallMs: 120, graceMs: 50 } });
  const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.ok(sys(s, t.id).some((x) => /stopped waiting for 2 background agents/.test(x)), sys(s, t.id).join('|'));
  assert.deepEqual(s.rig.stoppedByClose.sort(), ['bgA', 'bgB']);
});

test('the last agent reports but the model never answers the notice: the run closes after the grace time', async () => {
  const s = setup([TWO[0]!], { level: true, background: { stallMs: 5000, graceMs: 80 }, quietAfterReports: true });
  const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await until(() => sys(s, t.id).some((x) => /Waiting for 1 background agent /.test(x)));
  s.rig.finish('bgA');
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.deepEqual(s.rig.stoppedByClose, []);
});

test("a background agent's own messages are not the model answering: a model that never answers the last notice still ends the run after the grace time", async () => {
  chatter.on = true;
  try {
    const s = setup([TWO[0]!], { level: true, background: { stallMs: 5000, graceMs: 80 }, quietAfterReports: true });
    const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
    await until(() => sys(s, t.id).some((x) => /Waiting for 1 background agent /.test(x)));
    s.rig.finish('bgA');
    const done = await s.engine.waitFor(t.id, 3000);
    assert.equal(done.status, 'done');
  } finally { chatter.on = false; }
});

test('BackgroundTasks: edges before the first level message, the level alone after it', () => {
  const b = new BackgroundTasks();
  const start = (id: string, extra: object = {}) => ({ type: 'system', subtype: 'task_started', task_id: id, description: id, task_type: 'local_agent', is_backgrounded: true, ...extra });
  assert.equal(b.note(start('a')), true);
  assert.equal(b.note(start('f', { is_backgrounded: false })), false, 'a foreground task is not background work');
  assert.equal(b.note({ type: 'system', subtype: 'task_updated', task_id: 'f', patch: { is_backgrounded: true } }), true, 'moved to the background');
  assert.equal(b.count, 2);
  assert.equal(b.note({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' }), true);
  assert.equal(b.count, 1);
  // the level replaces the set, and from then on edges are ignored
  assert.equal(b.note({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'x', task_type: 'local_agent', description: 'x' }, { task_id: 'y', task_type: 'local_agent', description: 'y' }] }), true);
  assert.equal(b.count, 2);
  b.note({ type: 'system', subtype: 'task_notification', task_id: 'x', status: 'completed' });
  assert.equal(b.count, 2, 'after a level message only the level counts');
  b.note({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(b.count, 0);
  assert.equal(b.note({ type: 'assistant' }), false);
});

test('the app words what it waits on, and what stopping would cost', async () => {
  const { backgroundLabel, stopWarning } = await import('../ui/src/chat/background.js');
  assert.equal(backgroundLabel(1), 'waiting on 1 background agent');
  assert.equal(backgroundLabel(3), 'waiting on 3 background agents');
  assert.match(stopWarning(2), /2 background agents are still working.*ends them too/);
  assert.match(stopWarning(1), /1 background agent is still working.*ends it too/);
});

test('the held phase has a wall-clock cap that heartbeats cannot extend: the agents are stopped, the owner is told, the row shows the time', async () => {
  let now = 1_800_000_000_000;
  const s = setup(TWO, { level: true, background: { stallMs: 1e12, graceMs: 1e12, maxHeldMs: 2 * 60 * 60_000, now: () => now } });
  const t = s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' });
  await until(() => sys(s, t.id).some((x) => /Waiting for 2 background agents/.test(x)));
  const p = s.engine.progressSnapshot()[t.id]!;
  assert.equal(p.background, 2);
  assert.equal(p.backgroundStopsAt, new Date(now + 2 * 60 * 60_000).toISOString());
  now += 2 * 60 * 60_000 + 1000;
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.ok(sys(s, t.id).some((x) => /stopped waiting for background agents after 120 minutes; the 2 still running were stopped/.test(x)), sys(s, t.id).join('|'));
  assert.deepEqual(s.rig.stopped.sort(), ['bgA', 'bgB']);
});

test('the working row names the time it stops waiting; stopping fails closed when the dialog cannot be shown', async () => {
  const { backgroundLabel, askToStop } = await import('../ui/src/chat/background.js');
  assert.match(backgroundLabel(2, new Date(2026, 9, 7, 14, 5).toISOString()), /^waiting on 2 background agents · stops at 14:05$/);
  assert.equal(askToStop(2, () => { throw new Error('no dialog'); }), false);
  assert.equal(askToStop(2, () => false), false);
  assert.equal(askToStop(2, () => true), true);
  assert.equal(askToStop(0, () => { throw new Error('unused'); }), true);
});
