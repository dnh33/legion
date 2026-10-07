/** "Run this item" against the REAL engine: the ordinary project run path, the `ask` cap for unreviewed text, and the run-end hook (controls C8, C9). */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { initialPrompt } from '../src/core/input-channel.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { BoardStore, createBoardModule } from '../src/core/projects/board/index.js';
import { TaintedPaths } from '../src/core/tainted-paths.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, ChatMessage, Task } from '../src/shared/types.js';

class FakeStore {
  agents = new Map<string, AgentProfile>(); tasks = new Map<string, Task>(); msgs: ChatMessage[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  upsertTask(t: Task) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: ChatMessage) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}
const mkAgent = (id: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id, name: id.toUpperCase(), emoji: 'A', description: '', systemPrompt: '', model: 'auto', vm: { enabled: false, size: 'default', idleStopMinutes: 15 },
  approval: 'full', mcpServers: ['*'], createdAt: '', updatedAt: '', ...over,
});
async function* quick(): AsyncGenerator<any, void> {
  yield { type: 'system', subtype: 'init', session_id: 's1' };
  yield { type: 'result', subtype: 'success', is_error: false, result: 'Finished the work item.', total_cost_usd: 0.01, num_turns: 1, session_id: 's1' };
}
function setup() {
  const root = cleanupTemp('legion-board-run-');
  const store = new FakeStore(); store.agents.set('a2', mkAgent('a2'));
  const bus = new EventBus(); const config = defaultConfig(); config.workspaceDir = join(root, 'data', 'ws');
  const projects = new ProjectStore(join(root, 'data'), config.workspaceDir);
  const board = new BoardStore(join(root, 'data', 'board'), () => 0);
  const calls: any[] = [];
  const queryFn = ((params: any) => { calls.push({ ...params, prompt: initialPrompt(params.prompt), input: params.prompt }); return Object.assign(quick(), { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) }); }) as unknown as QueryFn;
  const engine = new Engine({ store: store as any, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, projects, taintedPaths: new TaintedPaths(join(root, 'tp.json')) });
  const mod = createBoardModule({ config, store: store as any, bus, engine, approvals: {} as any, dataDir: root, bsvEnabled: () => false }, { projects, board });
  engine.setModules([mod]);
  const routes = new Map<string, (c: any) => any>();
  mod.routes!((m, p, h) => { routes.set(`${m} ${p}`, h); });
  const proj = projects.setMembers(projects.create({ name: 'P' }).id, ['a2']);
  const post = (iid: string) => routes.get('POST /api/projects/:id/board/items/:iid/run')!({ params: [proj.id, iid], body: {}, req: {} });
  return { store, engine, board, proj, calls, post };
}
const settle = async (s: ReturnType<typeof setup>, id: string) => { await s.engine.waitFor(id, 3000); await new Promise((r) => setTimeout(r, 20)); };

test('C8 the owner\'s own item runs as an owner run: a `full` agent keeps its own mode; the project path and prompt are used', async () => {
  const s = setup();
  const i = s.board.create(s.proj, { title: 'Ship the page', description: 'Details here.', assignee: { kind: 'agent', id: 'a2' } });
  const r = s.post(i.id);
  await settle(s, r.task.id);
  const o = s.calls[0].options;
  assert.equal(o.permissionMode, 'bypassPermissions', 'the owner\'s agent setting is unchanged by the board');
  assert.match(String(o.systemPrompt.append), /<legion-project name="P">/, 'the ordinary project section is present');
  assert.match(String(s.calls[0].prompt), /Work item wi_[a-f0-9]{12} from the project board: Ship the page/);
  assert.equal(s.store.getTask(r.task.id)!.projectId, s.proj.id);
  assert.equal(s.store.getTask(r.task.id)!.tainted, undefined);
});

test('C8 text an agent wrote runs tainted under the `ask` ceiling until the owner marks it reviewed', async () => {
  const s = setup();
  const q = s.board.propose({ ...s.proj, members: ['a2'] }, 'a2', { title: 'Agent idea', description: 'Do things.' }, { tainted: false });
  s.board.accept(s.proj, q.id, { assignee: { kind: 'agent', id: 'a2' } });
  const r = s.post(q.id);
  await settle(s, r.task.id);
  const o = s.calls[0].options;
  assert.equal(o.permissionMode, 'default', 'a `full` agent runs with approval cards on unreviewed text');
  assert.equal(typeof o.canUseTool, 'function');
  const t = s.store.getTask(r.task.id)!;
  assert.equal(t.tainted, true); assert.equal(t.origin?.approvalCeiling, 'ask');
  assert.match(String(s.calls[0].prompt), /has not reviewed it/);
  // reviewed: back to the owner's own setting
  s.board.patch(s.proj, q.id, { trust: 'human', ifUpdatedAt: s.board.get(s.proj.id, q.id)!.updatedAt });
  const r2 = s.post(q.id);
  await settle(s, r2.task.id);
  assert.equal(s.calls[1].options.permissionMode, 'bypassPermissions');
});

test('C9 the engine calls the run-end hook: the item lands in Review with the result linked, never in Done', async () => {
  const s = setup();
  const i = s.board.create(s.proj, { title: 'x', assignee: { kind: 'agent', id: 'a2' } });
  const r = s.post(i.id);
  assert.equal(s.board.get(s.proj.id, i.id)!.status, 'doing');
  await settle(s, r.task.id);
  const after = s.board.get(s.proj.id, i.id)!;
  assert.equal(after.status, 'review'); assert.equal(after.activeRun, undefined);
  assert.match(after.lastRun!.preview, /Finished the work item/); assert.deepEqual(after.taskIds, [r.task.id]);
  assert.ok(!after.activity.some((a) => /→ done/.test(a.text)));
});
