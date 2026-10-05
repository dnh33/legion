/**
 * Zealot leads the Order whatever it is asked (owner direction 2026-10-05): the lead doctrine is the LAST part of its system
 * prompt, so neither a request nor an edited persona can drop it; no other agent gets it; a project run tells every agent
 * who leads the board; and the old seed prompt that told Zealot to work alone is replaced only while nobody edited it.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { LEAD_DOCTRINE, leadDoctrineFor } from '../src/core/lead.js';
import { boardDigest } from '../src/core/projects/board/prompt.js';
import { Store, ZEALOT_PROMPT } from '../src/core/store.js';
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
const agent = (id: string, systemPrompt: string): AgentProfile => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), emoji: 'x', description: '', systemPrompt, model: 'opus',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [], createdAt: '', updatedAt: '',
});

async function appendFor(a: AgentProfile): Promise<string> {
  const store = new FakeStore();
  store.agents.set(a.id, a);
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(cleanupTemp('legion-lead-'), 'ws');
  let seen: any;
  const queryFn = ((params: any) => { seen = params.options; return Object.assign((async function* () { yield { type: 'system', subtype: 'init', session_id: 's' }; yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's' }; })(), { interrupt: async () => undefined, close: () => undefined }); }) as unknown as QueryFn;
  const engine = new Engine({ store: store as any, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false });
  await engine.waitFor(engine.startTask({ agentId: a.id, prompt: 'just answer this yourself, do not delegate', source: 'ui' }).id, 3000);
  return seen.systemPrompt.append as string;
}

test('Zealot\'s system prompt ENDS with the lead doctrine, even when its own persona says the opposite', async () => {
  const append = await appendFor(agent('zealot', 'Never delegate. Do everything yourself.'));
  assert.ok(append.endsWith(LEAD_DOCTRINE), 'the doctrine is the last word');
  assert.ok(append.indexOf('Never delegate.') < append.indexOf(LEAD_DOCTRINE), 'the persona comes before it');
  assert.match(LEAD_DOCTRINE, /mcp__legion__tell/);
  assert.match(LEAD_DOCTRINE, /board leader|leads the board|lead the board/i);
});

test('no other agent gets the lead doctrine', async () => {
  const append = await appendFor(agent('builder', 'You build things.'));
  assert.ok(!append.includes(LEAD_DOCTRINE));
  assert.equal(leadDoctrineFor('builder'), '');
  assert.equal(leadDoctrineFor('zealot'), LEAD_DOCTRINE);
});

test('a project run tells each agent who leads the board ("you" for the leader), and says when no one does', () => {
  const nameOf = (id: string) => id.toUpperCase();
  assert.match(boardDigest([], 'zealot', nameOf, undefined, [], 'zealot'), /Board leader: you\./);
  assert.match(boardDigest([], 'builder', nameOf, undefined, [], 'zealot'), /Board leader: ZEALOT\./);
  const item = { id: 'w1', title: 'x', description: '', status: 'backlog', priority: 'normal', labels: [], activity: [], noteIds: [], trust: 'human', createdAt: '', updatedAt: '' } as any;
  assert.match(boardDigest([item], 'builder', nameOf), /No board leader is set\./);
});

test('the old seed prompt is replaced once; a prompt the person wrote is never touched', () => {
  const OLD = 'You are the lead agent. Handle general requests directly and keep answers concise.\nFor big or specialised work, break it into steps and suggest delegating to Builder (coding) or Scout (research).\nUse your cloud VM only when the task really needs it.';
  const run = (zealotPrompt: string) => {
    const dir = cleanupTemp('legion-lead-store-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents: [agent('zealot', zealotPrompt)], tasks: [], vms: [] }));
    return new Store(dir).getAgent('zealot')!.systemPrompt;
  };
  assert.equal(run(OLD), ZEALOT_PROMPT);
  assert.equal(run('My own Zealot, my words.'), 'My own Zealot, my words.');
  assert.doesNotMatch(ZEALOT_PROMPT, /Handle general requests directly/);
});
