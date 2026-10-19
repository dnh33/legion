// test/mode-readers.test.ts: one resolver answers every mode reader (engine, guards, UI); Smart is a real mode; a helper gets the helped project's cap
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup, mkAgent } from './away-rig.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { createBoardModule } from '../src/core/projects/board/index.js';
import { BoardStore } from '../src/core/projects/board/store.js';
import { EventBus } from '../src/core/bus.js';
import { tempDir } from './tmp-cleanup.js';
import { renderCapabilities } from '../src/core/agent-facts.js';
import { stricterMode, effectiveMode } from '../src/core/permission-mode.js';
import type { RunMode } from '../src/core/permission-mode.js';
import { buildCommsToolsServer } from '../src/core/comms/tools.js';
import { createCommsModule } from '../src/core/comms/index.js';
import { makeHarness } from './comms-fakes.test.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = () => (async function* () { yield { type: 'system', subtype: 'init', session_id: 's1' }; await new Promise<void>(() => undefined); })();

test('resolver: a bad source fails closed to ask', () => {
  const r = setup({ gatesCore: true });
  assert.equal(r.core!.resolver.mode({ agentMode: 'full', source: 'weird' as never }), 'ask');
  assert.equal(r.core!.resolver.mode({ agentMode: 'full', source: 'weird' as never, ceiling: 'auto-edits' }), 'ask');
  assert.equal(r.core!.resolver.baseline!({ agentMode: 'full', source: 'weird' as never }), 'ask');
});
test('resolver: no preset and no source gives exactly the agent own mode (0.3.0)', () => {
  const r = setup({ gatesCore: true });
  for (const m of ['ask', 'auto-edits', 'full'] as const) {
    assert.equal(r.core!.resolver.mode({ agentMode: m }), m);
    assert.equal(r.core!.resolver.mode({ agentMode: m, source: 'own', startProjectId: r.project.id }), m);
  }
});
test('resolver: a smart project gives smart to an agent that follows it, and limits an own-mode agent to it', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchProject(r.project.id, { preset: 'smart' });
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'project', startProjectId: r.project.id }), 'smart');
  assert.equal(r.core!.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: r.project.id }), 'smart');
  // Smart and Accept edits are not ordered: a cap that is neither looser than the agent's mode nor the other way round gives smart-edits (a card when either would)
  assert.equal(r.core!.resolver.mode({ agentMode: 'auto-edits', source: 'own', startProjectId: r.project.id }), 'smart-edits');
});
test('resolver: a bypass project gives full to an agent that follows it (the old mapping handed back the agent mode)', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchProject(r.project.id, { preset: 'bypass' });
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'project', startProjectId: r.project.id }), 'full');
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'own', startProjectId: r.project.id }), 'ask');
});
test('resolver: a smart app preset reaches an agent that follows it, with no project', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchApp({ preset: 'smart' });
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'project' }), 'smart');
  assert.equal(r.core!.resolver.baseline!({ agentMode: 'ask', source: 'project' }), 'ask', 'the baseline ignores presets');
});
test('resolver: gate() answers the project value for the start project, and there is no shell floor switch on the core', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  assert.equal(r.core!.gate('tool-cards', r.project.id), true);
  r.core!.store.patchProject(r.project.id, { preset: 'bypass' });
  assert.equal(r.core!.gate('tool-cards', r.project.id), false, 'the start project value reaches gate()');
  assert.equal(r.core!.gate('tool-cards', undefined), true, 'no start project means the app value');
  assert.equal('shellFloorOn' in r.core!, false);
});

test('runModeOf: a module asking by task gets the project cap, not the agent own mode', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', task.id), 'ask');
    assert.equal(r.engine.runModeOf('a1'), 'full', 'with no task there is no start project, so no cap');
    assert.equal(r.engine.runModeOf('nobody', task.id), undefined);
  } finally { r.engine.cancel(task.id); }
});
test('runModeOf: a smart project cap reaches the engine and the module readers as smart', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'smart' });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', task.id), 'smart');
  } finally { r.engine.cancel(task.id); }
});
test('runModeOf keeps the cap of the start project after the project is archived', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    (r.engine as unknown as { projects: ProjectStore }).projects.update(r.project.id, { status: 'archived' });
    assert.equal(r.engine.runModeOf('a1', task.id), 'ask');
  } finally { r.engine.cancel(task.id); }
});
test('runModeOf without a resolver is the stored agent mode (0.3.0)', async () => {
  const r = setup({ approval: 'auto-edits', script: idle });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', task.id), 'auto-edits');
    assert.equal(r.engine.runModeOf('nobody'), undefined);
  } finally { r.engine.cancel(task.id); }
});
test('a helper run for a project (outsideOf) gets the helped project cap', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  // a9 is not a member of the project; it helps from outside when a1 (in the project) delegates to it
  r.store.agents.set('a9', mkAgent('a9', 'full'));
  const caller = r.start('a1', 'go');
  try {
    await pause(120);
    const helper = r.start('a9', 'help', { source: 'bot', projectId: undefined, bridge: { fromAgentId: 'a1', parentTaskId: caller.id, hop: 0 } });
    await pause(120);
    assert.equal(r.store.getTask(helper.id)?.helpingProjectId, r.project.id, 'a9 helps from outside the project');
    assert.equal(r.engine.runModeOf('a9', helper.id), 'ask');
    r.engine.cancel(helper.id);
  } finally { r.engine.cancel(caller.id); }
});

const WIN = process.platform === 'win32';
const OUTSIDE = WIN ? 'C:/Windows/evil.txt' : '/etc/evil.txt';
type Can = (name: string, input: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>;
const sig = () => ({ signal: new AbortController().signal });
/** A scripted run: a prompt that names HELPME makes one Write decision (not awaited: a card waits for the owner); every other run idles. */
const writeOn = (file: string) => (params: { prompt: unknown; options: Record<string, unknown> }) => (async function* () {
  yield { type: 'system', subtype: 'init', session_id: 's1' };
  if (JSON.stringify(params.prompt).includes('HELPME')) { void (params.options.canUseTool as Can)('Write', { file_path: file, content: 'x' }, sig()); await pause(50); }
  await new Promise<void>(() => undefined);
})();

test('stricterMode: Smart and Accept edits are not ordered, so the stricter of the two is smart-edits (a card when either would)', () => {
  assert.equal(stricterMode('smart', 'auto-edits'), 'smart-edits');
  assert.equal(stricterMode('auto-edits', 'smart'), 'smart-edits');
  assert.equal(stricterMode('smart', 'full'), 'smart');
  assert.equal(stricterMode('smart', 'smart'), 'smart');
  assert.equal(effectiveMode({ agentMode: 'ask', source: 'project', appPreset: 'ask', project: { preset: 'smart', limit: true }, ceiling: 'auto-edits' }), 'smart-edits');
});

test('C1: a caller that follows an Ask app preset (stale stored full) starts a Full helper capped at Ask', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchApp({ preset: 'ask' });
  const a1 = r.store.agents.get('a1')!; a1.approvalSource = 'project'; a1.approval = 'full';
  r.store.agents.set('b9', mkAgent('b9', 'full'));
  const caller = r.start('a1', 'go', { projectId: undefined });
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', caller.id), 'ask', 'the resolver holds the caller at Ask');
    const helper = r.start('b9', 'help', { source: 'bot', projectId: undefined, bridge: { fromAgentId: 'a1', parentTaskId: caller.id, hop: 0 } });
    await pause(120);
    assert.equal(r.store.getTask(helper.id)?.origin?.approvalCeiling, 'ask');
    assert.equal(r.calls.at(-1)!.options.permissionMode, 'default', 'the helper runs on the normal path, with cards');
    r.engine.cancel(helper.id);
  } finally { r.engine.cancel(caller.id); }
});

test('C1b: a Smart caller hands a Full helper a Smart ceiling, not Accept edits', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchApp({ preset: 'smart' });
  const a1 = r.store.agents.get('a1')!; a1.approvalSource = 'project';
  r.store.agents.set('b9', mkAgent('b9', 'full'));
  const caller = r.start('a1', 'go', { projectId: undefined });
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', caller.id), 'smart');
    const helper = r.start('b9', 'help', { source: 'bot', projectId: undefined, bridge: { fromAgentId: 'a1', parentTaskId: caller.id, hop: 0 } });
    await pause(120);
    assert.equal(r.store.getTask(helper.id)?.origin?.approvalCeiling, 'smart');
    r.engine.cancel(helper.id);
  } finally { r.engine.cancel(caller.id); }
});

test('I1: a Smart run under an Accept-edits ceiling still cards an edit outside the project folder', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: writeOn(OUTSIDE) });
  r.core!.store.patchApp({ preset: 'smart' });
  r.store.agents.get('a1')!.approval = 'auto-edits';
  r.store.agents.set('b9', mkAgent('b9', 'full'));
  r.store.agents.get('b9')!.approvalSource = 'project';
  const caller = r.start('a1', 'go', { projectId: undefined });
  try {
    await pause(120);
    const helper = r.start('b9', 'HELPME', { source: 'bot', projectId: undefined, bridge: { fromAgentId: 'a1', parentTaskId: caller.id, hop: 0 } });
    await pause(300);
    assert.equal(r.store.getTask(helper.id)?.origin?.approvalCeiling, 'auto-edits');
    assert.equal(r.approvals.pending().filter((p) => p.taskId === helper.id).length, 1, 'the Write outside the project folder raised a card');
    r.engine.cancel(helper.id);
  } finally { r.engine.cancel(caller.id); }
});

test('I2: an agent that left the project between queue and start keeps the start cap, in the engine and in the module readers', async () => {
  const r = setup({ gatesCore: true, approval: 'full', maxConcurrent: 1, script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  const first = r.start('a1', 'one');
  await pause(120);
  const queued = r.start('a2', 'two');
  try {
    r.projects.setMembers(r.project.id, ['a1', 'a3']);
    r.engine.cancel(first.id);
    await pause(250);
    assert.equal(r.store.getTask(queued.id)?.status, 'running');
    assert.equal(r.engine.runModeOf('a2', queued.id), 'ask');
    assert.equal(r.calls.at(-1)!.options.permissionMode, 'default');
  } finally { r.engine.cancel(queued.id); }
});

test('I2b: a run that started with no project does not pick up a project preset mid-run', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.store.agents.get('a1')!.approvalSource = 'project';
  const task = r.start('a1', 'go', { projectId: undefined });
  try {
    await pause(120);
    const before = r.engine.runModeOf('a1', task.id);
    const t = r.store.tasks.get(task.id)!; t.projectId = r.project.id;
    r.core!.store.patchProject(r.project.id, { preset: 'bypass' });
    assert.equal(r.engine.runModeOf('a1', task.id), before, 'the start project (none) decides, not the live task');
  } finally { r.engine.cancel(task.id); }
});

test('I3: the engine judges a helper by the helped project cap (a Write is carded, not waved through)', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: writeOn(join(process.cwd(), 'inside.txt')) });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  r.store.agents.set('a9', mkAgent('a9', 'full'));
  // the caller started with no project (so it is Full and its ceiling is Full) and is in the project when it delegates: only the helped-project cap can hold the helper
  const caller = r.start('a1', 'go', { projectId: undefined });
  try {
    await pause(120);
    r.store.tasks.get(caller.id)!.projectId = r.project.id;
    assert.equal(r.engine.runModeOf('a1', caller.id), 'full');
    const helper = r.start('a9', 'HELPME', { source: 'bot', projectId: undefined, bridge: { fromAgentId: 'a1', parentTaskId: caller.id, hop: 0 } });
    await pause(300);
    assert.equal(r.store.getTask(helper.id)?.helpingProjectId, r.project.id);
    assert.equal(r.store.getTask(helper.id)?.origin?.approvalCeiling, 'full', 'the ceiling alone does not cap it');
    assert.equal(r.calls.at(-1)!.options.permissionMode, 'default');
    assert.equal(r.approvals.pending().filter((p) => p.taskId === helper.id).length, 1, 'the helper Write raised a card');
    r.engine.cancel(helper.id);
  } finally { r.engine.cancel(caller.id); }
});

async function commsTool(h: ReturnType<typeof makeHarness>, agentId: string, run: Parameters<typeof buildCommsToolsServer>[2]) {
  const server = buildCommsToolsServer(agentId, h.hub, run);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(b), client.connect(a)]);
  return client;
}
// the stub answers like the resolver: the run of task t1 sits in an Ask-capped project; with no task there is no project cap
const capByTask = (id: string, taskId?: string): RunMode | undefined => (taskId === 't1' ? 'ask' : id === 'a' ? 'full' : undefined);

test('C2: a Full agent in an Ask-capped project that DMs a Full bot wakes it capped at Ask', async () => {
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full']], hub: { runModeOf: capByTask } });
  const client = await commsTool(h, 'a', { taint: () => false, taskId: 't1' });
  const res: any = await client.callTool({ name: 'bot_send', arguments: { to: 'b', text: 'do the deploy' } });
  assert.equal(res.isError, undefined);
  assert.equal(h.engine.last('b').origin!.approvalCeiling, 'ask');
  await client.close();
});
test('C2b: room_post and handoff from an Ask-capped project run carry the cap too', async () => {
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full'], ['c', 'Gamma', 'full']], hub: { runModeOf: capByTask } });
  const room = h.room(['a', 'b', 'c'], { guards: { maxHops: 20 } });
  const client = await commsTool(h, 'a', { taint: () => false, taskId: 't1' });
  await client.callTool({ name: 'room_post', arguments: { room: room.id, text: '@Beta go' } });
  assert.equal(h.engine.last('b').origin!.approvalCeiling, 'ask');
  await client.callTool({ name: 'handoff', arguments: { room: room.id, to: 'c', summary: 'take over' } });
  assert.equal(h.engine.last('c').origin!.approvalCeiling, 'ask');
  await client.close();
});
test('N4: when the resolver throws, the comms module wakes a bot with an Ask ceiling, not the stored Full', async () => {
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full']] });
  const engine = Object.assign(h.engine, { runModeOf: (): RunMode => { throw new Error('resolver down'); } });
  const mod = createCommsModule({ engine: engine as never, store: h.store as never, bus: h.bus, config: {} as never, approvals: {} as never, dataDir: h.dir, bsvEnabled: () => false });
  try {
    const server = mod.mcpServers!(h.agents.get('a')!, { taint: () => false, taskId: 't1' } as never).legion_comms as never as { instance: { connect(t: unknown): Promise<void> } };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.instance.connect(b), client.connect(a)]);
    await client.callTool({ name: 'bot_send', arguments: { to: 'b', text: 'do the deploy' } });
    assert.equal(h.engine.last('b').origin!.approvalCeiling, 'ask');
    await client.close();
  } finally { mod.dispose?.(); }
});
test('hub: a Smart sender wakes a bot with a Smart ceiling, not Accept edits', () => {
  const h = makeHarness({ agents: [['a', 'Alpha', 'full'], ['b', 'Beta', 'full']], hub: { runModeOf: () => 'smart' } });
  h.hub.botSend('a', 'b', 'hello there');
  assert.equal(h.engine.last('b').origin!.approvalCeiling, 'smart');
});

test('the board guard asks the resolver for THIS task: a full agent in an Ask-capped task still gets a card', async () => {
  const root = tempDir('legion-mr-board-');
  const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
  let now = 0;
  const board = new BoardStore(join(root, 'data', 'board'), () => now);
  const P = projects.setMembers(projects.create({ name: 'P' }).id, ['scout']);
  board.setLeader(P, 'scout');
  const asked: Array<string | undefined> = [];
  const asks: unknown[][] = [];
  const engine = { runModeOf: (_id: string, taskId?: string): RunMode => { asked.push(taskId); return taskId === 'capped' ? 'ask' : 'full'; } };
  const approvals = { request: async (...a: unknown[]) => { asks.push(a); return false; } };
  const mod = createBoardModule({ config: {} as never, store: {} as never, bus: new EventBus(), engine: engine as never, approvals: approvals as never, dataDir: root, bsvEnabled: () => false }, { projects, board });
  now += 60 * 60_000; // a new leader only gets the delete tool after an hour
  for (const [taskId, cards] of [['free', 0], ['capped', 1]] as const) {
    const item = board.create(P, { title: 'x' + taskId });
    const cfg = mod.mcpServers!({ id: 'scout', name: 'scout', approval: 'full' } as never, { taskId, taint: () => false, projectId: P.id } as never).legion_board as never as { instance: { connect(t: unknown): Promise<void> } };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(b);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(a);
    asks.length = 0;
    const res = await c.callTool({ name: 'delete', arguments: { id: item.id } });
    assert.equal(asks.length, cards, `${taskId}: cards (${JSON.stringify(res.content)})`);
    await c.close();
  }
  assert.ok(asked.includes('capped') && asked.includes('free'), `the guard named the task: ${JSON.stringify(asked)}`);
});

test('N4: when the resolver throws, the board guard cards a stored-Full agent (it reads as Ask)', async () => {
  const root = tempDir('legion-mr-board-throw-');
  const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
  let now = 0;
  const board = new BoardStore(join(root, 'data', 'board'), () => now);
  const P = projects.setMembers(projects.create({ name: 'P' }).id, ['scout']);
  board.setLeader(P, 'scout');
  const asks: unknown[][] = [];
  const engine = { runModeOf: (): RunMode => { throw new Error('resolver down'); } };
  const approvals = { request: async (...a: unknown[]) => { asks.push(a); return false; } };
  const mod = createBoardModule({ config: {} as never, store: {} as never, bus: new EventBus(), engine: engine as never, approvals: approvals as never, dataDir: root, bsvEnabled: () => false }, { projects, board });
  now += 60 * 60_000;
  const item = board.create(P, { title: 'x' });
  const cfg = mod.mcpServers!({ id: 'scout', name: 'scout', approval: 'full' } as never, { taskId: 't1', taint: () => false, projectId: P.id } as never).legion_board as never as { instance: { connect(t: unknown): Promise<void> } };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(b);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(a);
  await c.callTool({ name: 'delete', arguments: { id: item.id } });
  assert.equal(asks.length, 1, 'a throwing resolver reads as Ask, not as the stored Full');
  await c.close();
});

test('agent facts say smart in the run mode, with what smart still asks for', () => {
  const a = mkAgent('a1', 'ask');
  const text = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'smart' });
  assert.match(text, /your mode is smart \(asks before anything that reaches the web, deletes, can't be undone, or that Legion can't classify; tests and builds run without asking, and the code they run can reach the web\)/);
  const plain = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false });
  assert.match(plain, /your mode is ask/);
});

test('agent facts name who set a mode that differs from the agent own: the project, or whoever woke it', () => {
  const a = mkAgent('a1', 'full');
  assert.match(renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'ask' }), /your mode is ask \(set by your project, not full\)/);
  assert.match(renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'ask', ceiling: 'ask' }), /your mode is ask \(capped from full by whoever woke you\)/);
});
