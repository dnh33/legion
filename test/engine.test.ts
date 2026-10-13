import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { initialPrompt } from '../src/core/input-channel.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, describeWait } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine, EngineError } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { buildAgentToolsServer } from '../src/core/agent-tools.js';
import { defaultConfig } from '../src/shared/config.js';
import { BUDGET_LIMIT_PREFIX, CONTINUE_PROMPT, TURN_LIMIT_PREFIX } from '../src/shared/continue.js';
import type { AgentProfile, ChatMessage, LegionConfig, LegionEvent, Task } from '../src/shared/types.js';

// ---- fakes
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

const mkAgent = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: 'A', description: '', systemPrompt: 'Be nice.', model: 'auto',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'],
  createdAt: '', updatedAt: '', ...over,
});

type Script = (params: { prompt: any; options: any }, call: number) => AsyncGenerator<any, void>;

function setup(script: Script, opts: { agent?: Partial<AgentProfile>; config?: (c: LegionConfig) => void; boat?: boolean; maxConcurrent?: number; approvalTimeoutMs?: number } = {}) {
  const store = new FakeStore();
  const agent = mkAgent(opts.agent);
  store.agents.set(agent.id, agent);
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const config = defaultConfig();
  config.workspaceDir = join(cleanupTemp('legion-eng-'), 'ws');
  opts.config?.(config);
  const approvals = new ApprovalBroker(bus, { timeoutMs: opts.approvalTimeoutMs });
  const calls: { prompt: any; options: any }[] = [];
  const queryFn = ((params: any) => {
    calls.push({ ...params, prompt: initialPrompt(params.prompt), input: params.prompt });
    const gen = script(params, calls.length - 1);
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined, accountInfo: async () => ({}) });
  }) as unknown as QueryFn;
  const vms = { touch() {}, ensureRunning: async () => ({}) } as any;
  const engine = new Engine({
    store: store as any, bus, vms, approvals, config, queryFn,
    boatConfigured: () => opts.boat ?? false, maxConcurrent: opts.maxConcurrent,
  });
  return { store, bus, events, config, approvals, calls, engine, agent };
}

const init = (sid = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: sid });
const textAssistant = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const ok = (text: string, extra: any = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, num_turns: 2, session_id: 'sess-1', ...extra });
const err = (subtype: string, errors: string[] = []) => ({ type: 'result', subtype, is_error: true, errors, total_cost_usd: 0.02, num_turns: 3, session_id: 'sess-1' });

async function* happy(): AsyncGenerator<any, void> {
  yield init();
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } };
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } };
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo ' + 'x'.repeat(800) } }] } };
  yield ok('Hello there');
}

test('happy path: streaming, messages, task fields, options', async () => {
  const s = setup(() => happy());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'say hi', source: 'ui' });
  assert.equal(t.status, 'queued');
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Hello there');
  assert.equal(done.model, 'sonnet');
  assert.equal(done.sessionId, 'sess-1');
  assert.equal(done.costUsd, 0.01);
  assert.equal(done.turns, 2);
  const deltas = s.events.filter((e) => e.type === 'message.delta') as any[];
  assert.deepEqual(deltas.map((d) => d.text), ['Hel']);
  const msgs = s.store.listMessages(t.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2]!.toolName, 'Bash');
  assert.ok(msgs[2]!.text.length <= 500);
  const moods = s.events.filter((e) => e.type === 'mascot').map((e: any) => e.mood);
  assert.deepEqual(moods.slice(0, 3), ['thinking', 'hacking', 'success']);

  const o = s.calls[0]!.options;
  assert.equal(o.model, 'sonnet');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.maxTurns, s.config.claude.maxTurns);
  assert.equal(o.resume, undefined);
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
  assert.equal(o.canUseTool, undefined);
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(o.cwd, join(s.config.workspaceDir, 'a1'));
  assert.ok(existsSync(o.cwd));
  assert.equal(o.systemPrompt.preset, 'claude_code');
  assert.match(o.systemPrompt.append, /Alpha/);
  assert.match(o.systemPrompt.append, /Be nice\./);
  const append = o.systemPrompt.append as string;
  const facts = append.indexOf('What you can do right now:');
  const persona = append.indexOf('Be nice.');
  assert.ok(facts >= 0, 'capability block missing');
  assert.ok(persona > facts, 'capability block must come before the persona');
  const n = append.split('\n').length;
  assert.ok(n <= 18, `append is ${n} lines`);
});

test('startTask validation errors', () => {
  const s = setup(() => happy());
  assert.throws(() => s.engine.startTask({ agentId: 'nope', prompt: 'x', source: 'ui' }), (e: any) => e instanceof EngineError && e.status === 404);
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: '   ', source: 'ui' }), (e: any) => e.status === 400);
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui', continueTaskId: 'zz' }), (e: any) => e.status === 404);
});

test('auth env: claude-login deletes API key vars; api-key sets it', async () => {
  const saveKey = process.env.ANTHROPIC_API_KEY, saveTok = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
  try {
    const a = setup(() => happy());
    await a.engine.waitFor(a.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'cli' }).id, 3000);
    assert.equal('ANTHROPIC_API_KEY' in a.calls[0]!.options.env && a.calls[0]!.options.env.ANTHROPIC_API_KEY !== undefined, false);
    assert.equal(a.calls[0]!.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    // the child env is a plain-object copy of process.env: on Windows its key is "Path" (plain objects are case-sensitive, process.env is not)
    const pathKey = Object.keys(a.calls[0]!.options.env).find((k) => k.toUpperCase() === 'PATH');
    assert.equal(a.calls[0]!.options.env[pathKey ?? 'PATH'], process.env.PATH);

    const b = setup(() => happy(), { config: (c) => { c.claude.auth = 'api-key'; c.claude.apiKey = 'sk-config'; c.claude.executablePath = '/bin/claude'; c.claude.inheritClaudeCodeSettings = false; } });
    await b.engine.waitFor(b.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'cli' }).id, 3000);
    assert.equal(b.calls[0]!.options.env.ANTHROPIC_API_KEY, 'sk-config');
    assert.equal(b.calls[0]!.options.pathToClaudeCodeExecutable, '/bin/claude');
    assert.deepEqual(b.calls[0]!.options.settingSources, []);
  } finally {
    if (saveKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saveKey;
    if (saveTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saveTok;
  }
});

test('routing: auto hard prompt -> opus; /sonnet prefix stripped; agent model honored', async () => {
  const s = setup(() => happy());
  const t1 = s.engine.startTask({ agentId: 'a1', prompt: 'refactor and debug the architecture', source: 'ui' });
  await s.engine.waitFor(t1.id, 3000);
  assert.equal(s.calls[0]!.options.model, 'opus');
  const t2 = s.engine.startTask({ agentId: 'a1', prompt: '/sonnet refactor and debug the architecture', source: 'ui' });
  await s.engine.waitFor(t2.id, 3000);
  assert.equal(s.calls[1]!.options.model, 'sonnet');
  assert.equal(s.calls[1]!.prompt, 'refactor and debug the architecture');
  assert.equal(s.store.getTask(t2.id)!.model, 'sonnet');
});

test('escalation: sonnet error_during_execution -> opus rerun with resume + system message', async () => {
  const s = setup((_p, n) => (async function* () {
    yield init('sess-x');
    if (n === 0) yield err('error_during_execution', ['tool crashed']);
    else yield ok('fixed it');
  })(), { agent: { model: 'sonnet' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.escalated, true);
  assert.equal(done.model, 'opus');
  assert.equal(done.result, 'fixed it');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0]!.options.model, 'sonnet');
  assert.equal(s.calls[1]!.options.model, 'opus');
  assert.equal(s.calls[1]!.options.resume, 'sess-x');
  // the resumed session already holds "do it": sending it again makes the model start the task over
  assert.equal(s.calls[1]!.prompt, CONTINUE_PROMPT);
  assert.ok(Math.abs(done.costUsd! - 0.03) < 1e-9);
  const sys = s.store.listMessages(t.id).filter((m) => m.role === 'system');
  assert.equal(sys.length, 1);
  assert.match(sys[0]!.text, /^Sonnet could not finish this \(it stopped with an error\)\. Opus is taking over the same conversation\./);
  assert.match(sys[0]!.text, / Error: tool crashed$/, 'the underlying error stays, but last');
  assert.doesNotMatch(sys[0]!.text, /error_during_execution|Escalated/, 'no raw subtype code in the thread');
});

test('escalation before the session started re-sends the original prompt', async () => {
  // run 1 dies before init (no session got the prompt); run 2 must carry the task itself
  const s = setup((_p, n) => (async function* () {
    if (n === 0) { yield err('error_during_execution', ['spawn failed']); return; }
    yield init('sess-y'); yield ok('done');
  })(), { agent: { model: 'sonnet' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'ui' }).id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1]!.prompt, 'do it');
});

test('turn limit: task ends resumable with a plain message; Continue resumes the session, not the task', async () => {
  const s = setup((_p, n) => (async function* () {
    yield init('sess-t');
    if (n === 0) yield err('error_max_turns');
    else yield ok('finished');
  })(), { agent: { model: 'opus' }, config: (c) => { c.claude.maxTurns = 7; } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'big job', source: 'ui' });
  const stopped = await s.engine.waitFor(t.id, 3000);
  assert.equal(stopped.status, 'error');
  assert.equal(stopped.resumable, true);
  assert.ok(stopped.error!.startsWith(TURN_LIMIT_PREFIX));
  assert.match(stopped.error!, /7 turns this run/);
  // also read by MCP clients and other bots, which have no button to press
  assert.doesNotMatch(stopped.error!, /Press|button|Settings/);
  // the history keeps one short line (the full text is on the app's card), not the long error a second time
  assert.deepEqual(s.store.listMessages(t.id).filter((m) => m.role === 'system').map((m) => m.text), ['Paused at the turn limit (7 turns this run).']);
  // what the app's Continue button sends
  s.engine.startTask({ agentId: 'a1', prompt: CONTINUE_PROMPT, source: 'ui', continueTaskId: t.id });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.resumable, undefined);
  assert.equal(s.calls[1]!.options.resume, 'sess-t');
  assert.equal(s.calls[1]!.prompt, CONTINUE_PROMPT);
});

test('a turn-limit pause keeps the mascot calm (idle with a note), never "error"; a real failure still shows error', async () => {
  const s = setup((_p, n) => (async function* () { yield init(); yield n === 0 ? err('error_max_turns') : err('error_during_execution', ['Invalid API key']); })(), { agent: { model: 'opus' } });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'long', source: 'ui' }).id, 3000);
  const moods1 = s.events.filter((e: any) => e.type === 'mascot').map((e: any) => [e.mood, e.note]);
  assert.ok(!moods1.some(([m]) => m === 'error'), JSON.stringify(moods1));
  assert.ok(moods1.some(([m, n]) => m === 'idle' && n === 'paused at the turn limit'), JSON.stringify(moods1));
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'other', source: 'ui' }).id, 3000);
  assert.ok(s.events.filter((e: any) => e.type === 'mascot').some((e: any) => e.mood === 'error'), 'a real failure still shows the fault');
});

// The real SDK (0.3.285, Query.readMessages) yields the error result and THEN throws
// `Claude Code returned an error result: ...` (docs: a single-shot query() raises after an error result).
const sdkThrow = (text: string) => { throw new Error(`Claude Code returned an error result: ${text}`); };

test('real SDK shape: the throw that follows an error result does not turn a turn-limit pause into a failure', async () => {
  const s = setup(() => (async function* () { yield init('sess-real'); yield err('error_max_turns'); sdkThrow('Reached maximum number of turns'); })(), { agent: { model: 'opus' }, config: (c) => { c.claude.maxTurns = 9; } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'long', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'error');
  assert.ok(done.error!.startsWith(TURN_LIMIT_PREFIX), done.error);
  assert.equal(done.resumable, true);
  assert.deepEqual(s.store.listMessages(t.id).filter((m) => m.role === 'system').map((m) => m.text), ['Paused at the turn limit (9 turns this run).']);
  assert.ok(!s.events.some((e: any) => e.type === 'mascot' && e.mood === 'error'), 'no fault mascot for the pause');
});

test('real SDK shape: a Sonnet error result followed by the SDK throw still escalates to Opus, which continues', async () => {
  const s = setup((_p, n) => (async function* () {
    yield init('sess-esc');
    if (n === 0) { yield err('error_during_execution', ['tool crashed']); sdkThrow('tool crashed'); }
    yield ok('done on opus');
  })(), { agent: { model: 'sonnet' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'ui' }).id, 3000);
  assert.equal(s.calls.length, 2, 'the escalation ran');
  assert.equal(done.status, 'done');
  assert.equal(s.calls[1]!.prompt, CONTINUE_PROMPT);
});

test('sonnet at the turn limit pauses on sonnet: no Opus escalation, no second turn budget', async () => {
  const s = setup(() => (async function* () { yield init('sess-s'); yield err('error_max_turns'); })(), { agent: { model: 'sonnet' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'long job', source: 'ui' }).id, 3000);
  assert.equal(s.calls.length, 1);
  assert.equal(done.escalated, undefined);
  assert.equal(done.model, 'sonnet');
  assert.equal(done.resumable, true);
});

test('resumable is set when the session starts, so a run that throws mid-way can still be continued', async () => {
  const s = setup(() => (async function* () { yield init('sess-z'); yield textAssistant('half done'); throw new Error('stream reset'); })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'work', source: 'ui' });
  const failed = await s.engine.waitFor(t.id, 3000);
  assert.equal(failed.status, 'error');
  assert.equal(failed.resumable, true);
});

test('a failed escalation keeps the task continuable when the first run reached its session', async () => {
  const s = setup((_p, n) => (async function* () {
    if (n === 0) { yield init('sess-e'); yield err('error_during_execution', ['tool crashed']); return; }
    yield err('error_during_execution', ['spawn failed']);
  })(), { agent: { model: 'sonnet' } });
  const failed = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'work', source: 'ui' }).id, 3000);
  assert.equal(s.calls.length, 2);
  assert.equal(failed.status, 'error');
  assert.equal(failed.resumable, true);
});

test('a queued follow-up is not resumable until its own run starts (a restart before then must re-send it)', async () => {
  const s = setup((_p, n) => (async function* () { yield init('sess-q'); if (n === 0) yield err('error_max_turns'); else yield ok('x'); })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  assert.equal((await s.engine.waitFor(t.id, 3000)).resumable, true);
  const queued = s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  assert.equal(queued.resumable, undefined);
  await s.engine.waitFor(t.id, 3000);
});

test('/compact on a Claude task runs Claude Code\'s own /compact in that session, not Legion\'s provider summariser', async () => {
  const s = setup((_p, n) => (async function* () {
    yield init('sess-c');
    if (n === 1) yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 84210 } };
    yield ok(n === 0 ? 'worked' : '');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'long work', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const r = await s.engine.compactTaskNow(t.id, ' keep the API notes ');
  assert.deepEqual(r, { ok: true, detail: 'Claude Code is compacting this conversation.' });
  await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls[1]!.prompt, '/compact keep the API notes');
  assert.equal(s.calls[1]!.options.resume, 'sess-c');
  const sys = s.store.listMessages(t.id).filter((m) => m.role === 'system').map((m) => m.text);
  assert.deepEqual(sys, ['Claude Code compacted this conversation. It held about 84k tokens.']);
});

test('Claude Code compacting by itself is shown, so early instructions fading has a visible reason', async () => {
  const s = setup(() => (async function* () {
    yield init(); yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 190000 } }; yield ok('x');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const sys = s.store.listMessages(t.id).filter((m) => m.role === 'system').map((m) => m.text);
  assert.equal(sys.length, 1);
  assert.match(sys[0]!, /by itself.*190k tokens/);
});

test('/compact while the Claude task is running declines plainly and starts nothing', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () { yield init('sess-r'); await gate; yield ok('x'); })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  for (let i = 0; i < 50 && !s.store.getTask(t.id)?.sessionId; i++) await new Promise((r) => setTimeout(r, 5));
  const r = await s.engine.compactTaskNow(t.id);
  assert.deepEqual(r, { ok: false, detail: 'This task is still running. Compact it after it stops.' });
  release();
  await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls.length, 1);
});

test('live progress: turns count the run\'s own responses (not a subagent\'s), the tool is set on a call and cleared on its result', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-p');
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] } };
    yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } };
    // the same response arriving in a second message: still turn 1
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } };
    // a subagent's response is not one of the run's turns
    yield { type: 'assistant', parent_tool_use_id: 't2', message: { id: 'sub1', content: [{ type: 'text', text: 'sub' }] } };
    yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } };
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } };
    yield ok('done');
  })(), { agent: { model: 'opus' }, config: (c) => { c.claude.maxTurns = 50; } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const p = s.events.filter((e: any) => e.type === 'task.progress' && e.taskId === t.id).map((e: any) => e.progress);
  assert.ok(p.length >= 4, `progress events: ${p.length}`);
  assert.ok(p.every((x) => x.maxTurns === 50 && x.startedAt === p[0].startedAt));
  assert.deepEqual(p.map((x) => [x.turn, x.tool]), [[0, null], [1, 'Read'], [1, null], [1, 'Bash'], [1, null], [2, null]]);
});

// What the bundled CLI returns for a resume of a session it cannot find (an error result, before any init).
const missing = (sid: string) => err('error_during_execution', [`No conversation found with session ID: ${sid}`]);

test('a resumed session that no longer exists: the task starts a new conversation once, with the follow-up, and says so', async () => {
  const s = setup((_p, n) => (async function* () {
    if (n === 0) { yield init('sess-gone'); yield ok('first'); return; }
    if (n === 1) { yield missing('sess-gone'); return; }
    yield init('sess-new'); yield ok('fresh');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'build the thing', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  s.engine.startTask({ agentId: 'a1', prompt: 'now add tests', source: 'ui', continueTaskId: t.id });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.sessionId, 'sess-new');
  assert.equal(s.calls[1]!.options.resume, 'sess-gone');
  assert.equal(s.calls[2]!.options.resume, undefined, 'the new conversation does not resume the missing one');
  assert.equal(s.calls[2]!.prompt, 'now add tests');
  assert.ok(s.store.listMessages(t.id).some((m) => m.role === 'system' && /could not be found, so Claude is starting a new one/.test(m.text)));
});

test('Continue on a session that no longer exists re-sends the last real request, not the continue instruction', async () => {
  const s = setup((_p, n) => (async function* () {
    if (n === 0) { yield init('sess-gone'); yield err('error_max_turns'); return; }
    if (n === 1) { yield missing('sess-gone'); return; }
    yield init('sess-new'); yield ok('fresh');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'the original big job', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  s.engine.startTask({ agentId: 'a1', prompt: CONTINUE_PROMPT, source: 'ui', continueTaskId: t.id });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(s.calls[2]!.prompt, 'the original big job');
});

test('an ordinary failure before init on a resumed task does not start over (only a missing session does)', async () => {
  const s = setup((_p, n) => (async function* () {
    if (n === 0) { yield init('sess-1'); yield ok('first'); return; }
    yield err('error_during_execution', ['Invalid API key, please login']);
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'error');
  assert.equal(s.calls.length, 2);
  assert.equal(done.sessionId, 'sess-1', 'the session is kept: it was not the problem');
});

const progressOf = (s: { events: any[] }, id: string) => s.events.filter((e) => e.type === 'task.progress' && e.taskId === id).map((e) => e.progress);
const todoCall = (id: string, todos: unknown[], parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'mt' + id, content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] } });

test('a TodoWrite list reaches task.progress in full, clipped to 50 items of 200 characters, and the tool message is still stored', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ content: i === 0 ? 'x'.repeat(500) : `step ${i}`, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending', activeForm: `Doing ${i}` }));
  const s = setup(() => (async function* () {
    yield init('sess-todo');
    yield todoCall('td1', [{ content: 'one', status: 'in_progress', activeForm: 'Doing one' }]);
    yield todoCall('td2', many);
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const withTodos = progressOf(s, t.id).filter((p) => p.todos);
  assert.equal(withTodos.length, 2);
  assert.deepEqual(withTodos[0].todos, [{ content: 'one', status: 'in_progress', activeForm: 'Doing one' }]);
  const last = withTodos[1].todos;
  assert.equal(last.length, 50);
  assert.equal(last[0].content.length, 200);
  assert.ok(last[0].content.endsWith('…'));
  assert.deepEqual(last[3], { content: 'step 3', status: 'pending', activeForm: 'Doing 3' });
  assert.equal(last[2].status, 'in_progress');
  const stored = s.store.listMessages(t.id).filter((m: any) => m.toolName === 'TodoWrite');
  assert.equal(stored.length, 2);
  assert.ok(stored[1].text.length <= 500);
});

test('a subagent\'s TodoWrite is not the run\'s checklist', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-todo2');
    yield todoCall('td1', [{ content: 'mine', status: 'pending', activeForm: 'Mine' }]);
    yield todoCall('td2', [{ content: 'theirs', status: 'pending', activeForm: 'Theirs' }], 'task-1');
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm9', content: [{ type: 'text', text: 'next' }] } };
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const all = progressOf(s, t.id).filter((p) => p.todos).map((p) => p.todos.map((x: any) => x.content));
  assert.ok(all.length >= 1);
  assert.ok(all.every((l) => l.length === 1 && l[0] === 'mine'), JSON.stringify(all));
  assert.equal(progressOf(s, t.id).at(-1).todos[0].content, 'mine');
});

// Claude Code's task tools: the id of a new task arrives only in the result (tool_use_result.task.id), so the call and its result are paired.
const taskCall = (id: string, name: string, input: unknown, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'mk' + id, content: [{ type: 'tool_use', id, name, input }] } });
const taskResult = (id: string, structured: unknown, opts: { isError?: boolean; parent?: string | null } = {}) => ({
  type: 'user', parent_tool_use_id: opts.parent ?? null, tool_use_result: structured,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(opts.isError ? { is_error: true } : {}) }] },
});

test('Claude Code\'s TaskCreate/TaskUpdate drive the live checklist, with Claude Code\'s own ids; a delete takes the line away', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-tasks');
    yield taskCall('c1', 'TaskCreate', { subject: 'one', description: 'first', activeForm: 'Doing one' });
    yield taskResult('c1', { task: { id: '1', subject: 'one' } });
    yield taskCall('c2', 'TaskCreate', { subject: 'two', description: '' });
    yield taskResult('c2', { task: { id: '2', subject: 'two' } });
    yield taskCall('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' });
    yield taskResult('u1', { success: true, taskId: '1', updatedFields: ['status'] });
    yield taskCall('u2', 'TaskUpdate', { taskId: '2', status: 'deleted' });
    yield taskResult('u2', { success: true, taskId: '2', updatedFields: ['status'] });
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const lists = progressOf(s, t.id).filter((p) => p.todos).map((p) => p.todos);
  assert.deepEqual(lists[0], [{ content: 'one', status: 'pending', activeForm: 'Doing one' }]);
  assert.deepEqual(lists.at(-1), [{ content: 'one', status: 'in_progress', activeForm: 'Doing one' }]);
});

test('a refused task call (an error result, or success:false) leaves the checklist as it was; a subagent\'s task calls are not the run\'s', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-tasks2');
    yield taskCall('c1', 'TaskCreate', { subject: 'mine', description: '' });
    yield taskResult('c1', { task: { id: '1', subject: 'mine' } });
    yield taskCall('u1', 'TaskUpdate', { taskId: '1', status: 'completed' });
    yield taskResult('u1', { success: false, taskId: '1', updatedFields: [], error: 'nope' });
    yield taskCall('u2', 'TaskUpdate', { taskId: '1', status: 'completed' });
    yield taskResult('u2', undefined, { isError: true });
    yield taskCall('c2', 'TaskCreate', { subject: 'theirs', description: '' }, 'agent-1');
    yield taskResult('c2', { task: { id: '2', subject: 'theirs' } }, { parent: 'agent-1' });
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  assert.deepEqual(progressOf(s, t.id).filter((p) => p.todos).at(-1).todos, [{ content: 'mine', status: 'pending' }]);
});

test('a TaskList result replaces the mirrored checklist (Claude Code\'s own list is the truth on a Claude run)', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-tasks3');
    yield taskCall('c1', 'TaskCreate', { subject: 'stale', description: '' });
    yield taskResult('c1', { task: { id: '1', subject: 'stale' } });
    yield taskCall('l1', 'TaskList', {});
    yield taskResult('l1', { tasks: [{ id: '4', subject: 'real', status: 'in_progress', blockedBy: [] }, { id: '5', subject: 'next', status: 'pending', blockedBy: ['4'] }] });
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  assert.deepEqual(progressOf(s, t.id).filter((p) => p.todos).at(-1).todos, [{ content: 'real', status: 'in_progress' }, { content: 'next', status: 'pending' }]);
});

test('the checklist is kept per Legion task: a continued conversation shows its list from the start of the next run', async () => {
  let n = 0;
  const s = setup(() => (async function* () {
    n++;
    yield init('sess-tasks4');
    if (n === 1) {
      yield taskCall('c1', 'TaskCreate', { subject: 'carry me', description: '' });
      yield taskResult('c1', { task: { id: '1', subject: 'carry me' } });
    }
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const before = s.events.length;
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  const second = s.events.slice(before).filter((e: any) => e.type === 'task.progress' && e.taskId === t.id).map((e: any) => e.progress);
  assert.deepEqual(second.find((p: any) => p.todos)?.todos, [{ content: 'carry me', status: 'pending' }]);
});

test('a task list longer than the checklist limit shows its first 50 lines, like a TodoWrite list', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-tasks6');
    for (let i = 1; i <= 60; i++) {
      yield taskCall('c' + i, 'TaskCreate', { subject: 'step ' + i, description: '' });
      yield taskResult('c' + i, { task: { id: String(i), subject: 'step ' + i } });
    }
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const last = progressOf(s, t.id).filter((p) => p.todos).at(-1).todos;
  assert.equal(last.length, 50);
  assert.equal(last[49].content, 'step 50');
});

test('deleting a task deletes its task list: a new task never inherits it', async () => {
  const s = setup(() => (async function* () {
    yield init('sess-tasks5');
    yield taskCall('c1', 'TaskCreate', { subject: 'private', description: '' });
    yield taskResult('c1', { task: { id: '1', subject: 'private' } });
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const dir = join(s.config.workspaceDir, '.task-lists');
  assert.equal(readdirSync(dir).length, 1);
  s.bus.emit({ type: 'task.deleted', taskId: t.id });
  assert.deepEqual(readdirSync(dir), []);
});

const blockStart = (type: string, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_start', index: 0, content_block: { type, ...(type === 'thinking' ? { thinking: '' } : {}) } } });
const blockStop = (parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_stop', index: 0 } });

test('thinking is on from a thinking block\'s start to its stop, never for other blocks or a subagent, and no thinking text is stored', async () => {
  let atStop: unknown[] = [];   // what the run had sent by the time the block's stop was handled
  const s: ReturnType<typeof setup> = setup(() => (async function* () {
    yield init('sess-think');
    yield blockStart('text');
    yield blockStop();
    yield blockStart('thinking');
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET-THOUGHT' } } };
    yield blockStop();
    atStop = s.events.filter((e: any) => e.type === 'task.progress').map((e: any) => e.progress.thinking);
    yield blockStart('thinking', 'sub-1');
    yield blockStop('sub-1');
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  assert.deepEqual(atStop, [false, true, false]);   // off at the stop itself, not only at the run's end
  assert.deepEqual(progressOf(s, t.id).map((p) => p.thinking), [false, true, false]);
  assert.ok(!JSON.stringify([...s.store.listMessages(t.id), ...s.events]).includes('SECRET-THOUGHT'));
});

test('a thinking flag cannot stick: an assistant message clears it, and so does the end of the run', async () => {
  const a = setup(() => (async function* () {
    yield init('sess-think2');
    yield blockStart('thinking');
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } };
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  const ta = a.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await a.engine.waitFor(ta.id, 3000);
  const pa = progressOf(a, ta.id);
  assert.deepEqual(pa.map((p) => p.thinking), [false, true, false]);
  assert.equal(pa[2].turn, 1);   // cleared by the assistant message itself, not later

  // the stream just ends inside a thinking block (no stop, no assistant message): the run's end clears it
  const b = setup(() => (async function* () {
    yield init('sess-think3');
    yield blockStart('thinking');
  })(), { agent: { model: 'opus' } });
  const tb = b.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  await b.engine.waitFor(tb.id, 3000);
  assert.deepEqual(progressOf(b, tb.id).map((p) => p.thinking), [false, true, false]);
});

test('a window opened mid-run gets the live progress from the snapshot (turn, tool, checklist), and nothing once the run ends', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () {
    yield init('sess-snap');
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'tw', name: 'TodoWrite', input: { todos: [{ content: 'step one', status: 'in_progress', activeForm: 'Doing step one' }] } }, { type: 'tool_use', id: 'g1', name: 'Grep', input: {} }] } };
    await gate;
    yield ok('done');
  })(), { agent: { model: 'opus' }, config: (c) => { c.claude.maxTurns = 30; } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' });
  for (let i = 0; i < 100 && !s.engine.progressSnapshot()[t.id]?.turn; i++) await new Promise((r) => setTimeout(r, 5));
  const snap = s.engine.progressSnapshot()[t.id]!;
  assert.equal(snap.turn, 1);
  assert.equal(snap.maxTurns, 30);
  assert.equal(snap.tool, 'Grep');
  assert.deepEqual(snap.todos, [{ content: 'step one', status: 'in_progress', activeForm: 'Doing step one' }]);
  release();
  await s.engine.waitFor(t.id, 3000);
  assert.deepEqual(s.engine.progressSnapshot(), {});
});

test('a message sent while a Claude run works joins that run: one query, answered after the current step, then the run ends', async () => {
  let midRun!: () => void; const reached = new Promise<void>((r) => { midRun = r; });
  let sent!: () => void; const pushed = new Promise<void>((r) => { sent = r; });
  const s = setup((params) => (async function* () {
    // read the prompt stream the way the SDK does: one message, one answer, in order
    const it = (params.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
    yield init('sess-live');
    const first = await it.next();
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'a1', content: [{ type: 'text', text: `on it: ${first.value.message.content}` }] } };
    midRun();
    await pushed;
    yield ok('first answered');
    const second = await it.next();
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'a2', content: [{ type: 'text', text: `also: ${second.value.message.content}` }] } };
    yield ok('second answered');
    assert.equal((await it.next()).done, true, 'the engine closes the stream once every message has its answer');
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'build the page', source: 'ui' });
  await reached;
  const again = s.engine.startTask({ agentId: 'a1', prompt: 'and make it blue', source: 'ui', continueTaskId: t.id });
  assert.equal(again.id, t.id);
  sent();
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'second answered');
  assert.equal(s.calls.length, 1, 'one run, not a second one after the first');
  const rows = s.store.listMessages(t.id).filter((m) => m.role !== 'tool').map((m) => [m.role, m.text]);
  assert.deepEqual(rows, [['user', 'build the page'], ['assistant', 'on it: build the page'], ['user', 'and make it blue'], ['assistant', 'also: and make it blue']]);
});

test('a message folded into the current turn (one result answers both) still ends the run: the task does not stay running', async () => {
  let midRun!: () => void; const reached = new Promise<void>((r) => { midRun = r; });
  let sent!: () => void; const pushed = new Promise<void>((r) => { sent = r; });
  const s = setup((params) => (async function* () {
    // Claude Code delivers a message sent mid-turn into that same turn (a queued_command attachment) and writes ONE result
    // for both sends; queued_turn_count 0 says nothing else is waiting (SDK docs, SDKResultSuccess.queued_turn_count)
    const it = (params.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
    yield init('sess-fold');
    await it.next();
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'f1', content: [{ type: 'tool_use', id: 'fb', name: 'Bash', input: {} }] } };
    midRun();
    await pushed;
    await it.next();
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'f2', content: [{ type: 'text', text: 'did both' }] } };
    yield ok('both answered', { queued_turn_count: 0 });
    await it.next();
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'build the page', source: 'ui' });
  try {
    await reached;
    s.engine.startTask({ agentId: 'a1', prompt: 'and make it blue', source: 'ui', continueTaskId: t.id });
    sent();
    const done = await s.engine.waitFor(t.id, 1000);
    assert.equal(done.status, 'done', 'the run ends after the result that answered every message');
    assert.equal(done.result, 'both answered');
  } finally { s.engine.cancel(t.id); }
});

test('a result that says more sends are queued keeps the run open: a message sent then still joins it', async () => {
  let midRun!: () => void; const reached = new Promise<void>((r) => { midRun = r; });
  let sent!: () => void; const pushed = new Promise<void>((r) => { sent = r; });
  let firstDone!: () => void; const afterFirst = new Promise<void>((r) => { firstDone = r; });
  let sent3!: () => void; const pushed3 = new Promise<void>((r) => { sent3 = r; });
  const s = setup((params) => (async function* () {
    const it = (params.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
    yield init('sess-q');
    await it.next();
    midRun();
    await pushed;
    yield ok('first answered', { queued_turn_count: 1 });
    firstDone();
    await pushed3;
    const second = await it.next();
    const third = await it.next();
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'q2', content: [{ type: 'text', text: `also: ${second.value.message.content}, ${third.value.message.content}` }] } };
    yield ok('rest answered', { queued_turn_count: 0 });
    assert.equal((await it.next()).done, true);
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'build the page', source: 'ui' });
  try {
    await reached;
    s.engine.startTask({ agentId: 'a1', prompt: 'and make it blue', source: 'ui', continueTaskId: t.id });
    sent();
    await afterFirst;
    const joined = s.engine.startTask({ agentId: 'a1', prompt: 'and bigger', source: 'ui', continueTaskId: t.id });
    assert.equal(joined.id, t.id);
    sent3();
    const done = await s.engine.waitFor(t.id, 3000);
    assert.equal(done.status, 'done');
    assert.equal(done.result, 'rest answered');
    assert.equal(s.calls.length, 1, 'one run');
  } finally { sent3(); s.engine.cancel(t.id); }
});

test('only the person\'s own plain messages join a live run; bots, MCP clients and slash commands still get 409 (the app queues them)', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () { yield init('sess-g'); await gate; yield ok('x'); })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'work', source: 'ui' });
  for (let i = 0; i < 50 && s.store.getTask(t.id)?.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  for (const p of [
    { prompt: 'from a client', source: 'mcp' as const },
    { prompt: '/compact', source: 'ui' as const },
    { prompt: '/opus now', source: 'ui' as const },
  ]) assert.throws(() => s.engine.startTask({ agentId: 'a1', continueTaskId: t.id, ...p }), (e: any) => e instanceof EngineError && e.status === 409, p.prompt);
  release();
  await s.engine.waitFor(t.id, 3000);
  assert.equal(s.store.listMessages(t.id).filter((m) => m.role === 'user').length, 1, 'nothing refused was added to the thread');
});

test('a follow-up that fails before its own init is not resumable (the old session never saw it)', async () => {
  const s = setup((_p, n) => (async function* () {
    if (n === 0) { yield init('sess-old'); yield ok('first'); return; }
    yield err('error_during_execution', ['Invalid API key, please login']);
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  const failed = await s.engine.waitFor(t.id, 3000);
  assert.equal(failed.status, 'error');
  assert.equal(failed.sessionId, 'sess-old');
  assert.equal(failed.resumable, undefined);
});

test('escalation happens at most once; opus failure ends in error', async () => {
  const s = setup(() => (async function* () { yield init(); yield err('error_during_execution', ['boom']); })(), { agent: { model: 'sonnet' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls.length, 2);
  assert.equal(done.status, 'error');
  assert.match(done.error!, /boom/);
  assert.equal(s.events.filter((e: any) => e.type === 'mascot' && e.mood === 'error').length, 1);
});

test('auth/rate-limit errors do not escalate', async () => {
  const s = setup(() => (async function* () { yield init(); yield err('error_during_execution', ['Invalid API key, please login']); })(), { agent: { model: 'sonnet' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(s.calls.length, 1);
  assert.equal(done.status, 'error');
  assert.equal(done.escalated, undefined);
});

test('continue: same task, resume session, priorModel keeps opus', async () => {
  const s = setup(() => happy());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'refactor and debug the architecture', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  assert.throws(() => s.engine.startTask({ agentId: 'nope', prompt: 'x', source: 'ui', continueTaskId: t.id }), (e: any) => e.status === 404);
  const t2 = s.engine.startTask({ agentId: 'a1', prompt: 'thanks', source: 'ui', continueTaskId: t.id });
  assert.equal(t2.id, t.id);
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(s.calls[1]!.options.resume, 'sess-1');
  assert.equal(s.calls[1]!.options.model, 'opus');
  assert.equal(done.turns, 4);
  assert.equal(s.store.listMessages(t.id).filter((m) => m.role === 'user').length, 2);
});

test('continue while running -> 409', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () { yield init(); await gate; yield ok('x'); })());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  assert.throws(() => s.engine.startTask({ agentId: 'a1', prompt: 'y', source: 'ui', continueTaskId: t.id }), (e: any) => e.status === 409);
  release();
  await s.engine.waitFor(t.id, 3000);
});

/** A deny rule on a folder, by absolute path, for the gate tests below. */
const denyPaths = (paths: string[]) => (c: any) => { c.gates = { rules: [{ id: 'gr_t1', enabled: true, then: 'deny', label: 'no secrets', source: 'user', when: { paths } }], presetsVersion: 0 }; };
const hanging = () => (async function* () { yield init(); await new Promise<void>(() => undefined); })();

test('a path deny rule holds for a RELATIVE path too: the gate resolves it against the agent folder (ask mode, canUseTool)', async () => {
  let ws = '';
  const s = setup(hanging, { agent: { approval: 'ask' }, config: (c) => { ws = c.workspaceDir; denyPaths([join(c.workspaceDir, 'a1', 'secrets', '**').replace(/\\/g, '/')])(c); } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const use = s.calls[0]!.options.canUseTool;
  const sig = { signal: new AbortController().signal };
  for (const p of ['secrets/key.txt', 'x/../secrets/key.txt', join(ws, 'a1', 'secrets', 'key.txt')]) {
    assert.deepEqual(await use('Read', { file_path: p }, sig), { behavior: 'deny', message: 'Blocked by a gate rule (Settings -> Gates).' }, p);
  }
  s.engine.cancel(t.id);
  await s.engine.waitFor(t.id, 3000);
});

test('a path deny rule holds for a relative path in full mode too (the PreToolUse hook), and for a host tool against its own root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-gate-root-'));
  const s = setup(hanging, { agent: { approval: 'full', host: { enabled: true, rootDir: root } }, config: (c) => denyPaths([join(c.workspaceDir, 'a1', 'secrets', '**').replace(/\\/g, '/'), join(root, 'vault', '**').replace(/\\/g, '/')])(c) });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const hooks: any[] = s.calls[0]!.options.hooks.PreToolUse.filter((h: any) => h.matcher === '.*').flatMap((h: any) => h.hooks);
  assert.equal(hooks.length, 1);
  const ask = async (tool: string, input: unknown) => (await hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }))?.hookSpecificOutput?.permissionDecision ?? 'allow';
  assert.equal(await ask('Read', { file_path: 'secrets/key.txt' }), 'deny');
  assert.equal(await ask('Read', { file_path: 'src/a.ts' }), 'allow');
  // a host tool's relative path means a path under its root (resolveWithin), so the gate reads it the same way
  assert.equal(await ask('mcp__host__read_file', { path: 'vault/key.txt' }), 'deny');
  assert.equal(await ask('mcp__host__read_file', { path: 'src/a.ts' }), 'allow');
  s.engine.cancel(t.id);
  await s.engine.waitFor(t.id, 3000);
});

test('demoting a full-access agent to ask takes effect on the running run\'s next tool call (bypass mode re-reads the mode)', async () => {
  const s = setup(hanging, { agent: { approval: 'full' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.calls[0]!.options.permissionMode, 'bypassPermissions');
  const hook = s.calls[0]!.options.hooks.PreToolUse.filter((h: any) => h.matcher === '.*').flatMap((h: any) => h.hooks)[0];
  const decide = (tool: string, input: unknown) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
  // still full: no card, the call goes ahead
  assert.equal((await decide('Bash', { command: 'ls' }))?.hookSpecificOutput?.permissionDecision, undefined);
  assert.equal(s.approvals.pending().length, 0);
  // the owner demotes the agent while it works
  s.store.agents.set('a1', { ...s.store.getAgent('a1')!, approval: 'ask' });
  const pending = decide('Bash', { command: 'rm -rf build' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.approvals.pending().length, 1, 'the next call asks, as an ask agent\'s would');
  s.approvals.resolve(s.approvals.pending()[0]!.id, false);
  const out = await pending;
  assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(out?.hookSpecificOutput?.permissionDecisionReason ?? '', /denied/);
  // a read-only tool still needs no card in ask
  assert.equal((await decide('Read', { file_path: 'a.txt' }))?.hookSpecificOutput?.permissionDecision, undefined);
  // promoted again: no card
  s.store.agents.set('a1', { ...s.store.getAgent('a1')!, approval: 'full' });
  assert.equal((await decide('Bash', { command: 'ls' }))?.hookSpecificOutput?.permissionDecision, undefined);
  assert.equal(s.approvals.pending().length, 0);
  s.engine.cancel(t.id);
  await s.engine.waitFor(t.id, 3000);
});

test('the safety floor holds for Claude\'s own Bash and PowerShell in full mode: a catastrophic or hidden command is refused, an unreadable one gets a card', async () => {
  const s = setup(hanging, { agent: { approval: 'full', host: { enabled: true } } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const hook = s.calls[0]!.options.hooks.PreToolUse.filter((h: any) => h.matcher === '.*').flatMap((h: any) => h.hooks)[0];
  const decide = (tool: string, input: unknown) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
  // refused outright, no card: the floor holds in full access
  for (const [tool, command] of [['Bash', 'rm -rf /c'], ['Bash', 'rm -rf C:/'], ['PowerShell', 'Remove-Item -Recurse -Force C:\\'], ['Bash', 'echo cm0gLXJmIC9j | base64 -d | bash'], ['mcp__host__shell', 'powershell -enc ZQBjAGgAbwA=']] as const) {
    const out = await decide(tool, { command });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny', `${tool}: ${command}`);
    assert.match(out?.hookSpecificOutput?.permissionDecisionReason ?? '', /Refused/);
  }
  assert.equal(s.approvals.pending().length, 0, 'a refusal raises no card');
  // ordinary work still runs without a card in full
  assert.equal((await decide('Bash', { command: 'npm test 2>&1 | tail -5' }))?.hookSpecificOutput?.permissionDecision, undefined);
  // an unreadable command: a card, even in full, and no Remember on it
  const pending = decide('Bash', { command: 'bash -c "$(echo rm) -rf /c"' });
  await new Promise((r) => setTimeout(r, 10));
  const cards = s.approvals.pending();
  assert.equal(cards.length, 1, 'an unreadable command asks the owner, even in full');
  assert.equal(cards[0]!.noRemember, true);
  assert.match(cards[0]!.summary, /cannot read/i);
  s.approvals.resolve(cards[0]!.id, false);
  const out = await pending;
  assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny');
  // the agent is told not to try the same thing another way
  assert.match(out?.hookSpecificOutput?.permissionDecisionReason ?? '', /not approved[\s\S]*Do not retry/i);
  // approved: it runs
  const again = decide('mcp__host__shell', { command: 'x=ls; $x' });
  await new Promise((r) => setTimeout(r, 10));
  s.approvals.resolve(s.approvals.pending()[0]!.id, true);
  assert.equal((await again)?.hookSpecificOutput?.permissionDecision, undefined);
  s.engine.cancel(t.id);
  await s.engine.waitFor(t.id, 3000);
});

test('the safety floor holds on the ask path too (canUseTool): a catastrophic Bash command is refused without a card, an unreadable one gets one card', async () => {
  const s = setup(hanging, { agent: { approval: 'ask' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const use = s.calls[0]!.options.canUseTool;
  const sig = { signal: new AbortController().signal };
  const refused = await use('Bash', { command: 'rm -rf /c/Users' }, sig);
  assert.equal(refused.behavior, 'deny');
  assert.match(refused.message, /Refused/);
  assert.equal(s.approvals.pending().length, 0);
  const pending = use('Bash', { command: '{rm,-rf,/c}' }, sig);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.approvals.pending().length, 1, 'one card, not the shell card and then the ordinary one');
  assert.equal(s.approvals.pending()[0]!.noRemember, true);
  s.approvals.resolve(s.approvals.pending()[0]!.id, true);
  assert.equal((await pending).behavior, 'allow');
  s.engine.cancel(t.id);
  await s.engine.waitFor(t.id, 3000);
});

test('in full mode the hooks that can wait on a card allow at least the card\'s own wait (a hook timeout would stop the run instead)', async () => {
  const s = setup(hanging, { agent: { approval: 'full' }, approvalTimeoutMs: 600_000 });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  const carding = s.calls[0]!.options.hooks.PreToolUse.filter((h: any) => h.matcher === '.*' || h.matcher === 'WebFetch|WebSearch');
  assert.equal(carding.length, 2);
  for (const h of carding) assert.ok(typeof h.timeout === 'number' && h.timeout >= 600, `${h.matcher}: timeout ${h.timeout}`);
  s.engine.cancel(t.id);
  await s.engine.waitFor(t.id, 3000);
});

test('cancel: aborts run, status cancelled, pending approvals denied', async () => {
  const s = setup((p) => (async function* () {
    yield init();
    await new Promise<void>(() => undefined); // hangs forever; engine must stop waiting on abort
  })(), { agent: { approval: 'ask' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.engine.running(), [t.id]);
  const pending = s.calls[0]!.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
  assert.equal(s.approvals.pending().length, 1);
  assert.equal(s.engine.cancel(t.id), true);
  assert.deepEqual(await pending, { behavior: 'deny', message: 'The user denied this action.' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'cancelled');
  assert.equal(s.calls[0]!.options.abortController.signal.aborted, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.engine.running(), []);
  assert.equal(s.engine.cancel(t.id), false);
  assert.equal(s.engine.cancel('unknown'), false);
});

test('approvals via canUseTool: allow, deny, auto-allowed, timeout', async () => {
  const s = setup(() => happy(), { agent: { approval: 'auto-edits' }, approvalTimeoutMs: 40 });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  const o = s.calls[0]!.options;
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  const sig = { signal: new AbortController().signal };
  assert.deepEqual(await o.canUseTool('Edit', { file_path: '/x' }, sig), { behavior: 'allow', updatedInput: { file_path: '/x' } });
  assert.equal((await o.canUseTool('mcp__legion__vm_exec', {}, sig)).behavior, 'allow');

  const p = o.canUseTool('Bash', { command: 'ls' }, sig);
  assert.equal(s.approvals.pending()[0]!.summary, 'ls');
  s.approvals.resolve(s.approvals.pending()[0]!.id, true);
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: { command: 'ls' } });

  const d = o.canUseTool('Bash', { command: 'rm' }, sig);
  s.approvals.resolve(s.approvals.pending()[0]!.id, false);
  assert.deepEqual(await d, { behavior: 'deny', message: 'The user denied this action.' });

  assert.equal((await o.canUseTool('mcp__other__x', {}, sig)).behavior, 'deny'); // times out after 40ms
});

test('B4: an unanswered approval card is not reported to the model as a user denial', async () => {
  const s = setup(() => happy(), { agent: { approval: 'ask' }, approvalTimeoutMs: 40 });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  await new Promise((r) => setTimeout(r, 10)); // the run's cleanup cancels cards of its task; let it finish before we ask
  const o = s.calls[0]!.options;
  const sig = { signal: new AbortController().signal };
  const timedOut = await o.canUseTool('Bash', { command: 'ls' }, sig); // nobody answers: 40ms
  assert.equal(timedOut.behavior, 'deny');
  assert.equal(timedOut.message, 'No one answered the approval request within 1 second, so this action was not run. Ask again later or continue without it.');
  assert.doesNotMatch(timedOut.message, /user denied/);
  // a real denial still says so
  const d = o.canUseTool('Bash', { command: 'rm' }, sig);
  s.approvals.resolve(s.approvals.pending()[0]!.id, false);
  assert.equal((await d).message, 'The user denied this action.');
});

// The tool_use sets the mood to 'hacking' before canUseTool runs; a denied call never ran, so the Relic must not stay on "Executing".
function denyRun(timeoutMs?: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup((p) => (async function* () {
    yield init();
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'rm x' } }] } };
    await p.options.canUseTool('Bash', { command: 'rm x' }, { signal: new AbortController().signal });
    await gate; // the run goes on after the decision, as a real one would
    yield ok('done');
  })(), { agent: { approval: 'auto-edits' }, ...(timeoutMs ? { approvalTimeoutMs: timeoutMs } : {}) });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  const moods = () => s.events.filter((e: any) => e.type === 'mascot').map((e: any) => [e.mood, e.note]);
  const card = async () => { for (let i = 0; i < 100 && !s.approvals.pending().length; i++) await new Promise((r) => setTimeout(r, 5)); return s.approvals.pending()[0]!; };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { s, t, moods, card, settle, release };
}

test('mascot: a user Deny moves the mood off "hacking" while the run goes on; Allow leaves it', async () => {
  const d = denyRun();
  d.s.approvals.resolve((await d.card()).id, false);
  await d.settle();
  assert.deepEqual(d.moods().at(-1), ['thinking', 'Bash denied'], 'denied: no longer Executing');
  assert.ok(d.moods().some(([m]) => m === 'hacking'), 'the tool_use did set hacking first');
  d.release();
  assert.equal((await d.s.engine.waitFor(d.t.id, 3000)).status, 'done');

  const a = denyRun();
  a.s.approvals.resolve((await a.card()).id, true);
  await a.settle();
  assert.deepEqual(a.moods().at(-1), ['hacking', 'Bash'], 'allowed: still Executing');
  a.release();
  await a.s.engine.waitFor(a.t.id, 3000);
});

test('mascot: the timeout auto-deny moves the mood off "hacking" too', async () => {
  const d = denyRun(40);
  await d.card();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(d.moods().at(-1), ['thinking', 'Bash not answered']);
  d.release();
  await d.s.engine.waitFor(d.t.id, 3000);
});

test('mascot: cancelling a run with an open card ends on idle, not on the deny mood', async () => {
  const d = denyRun();
  await d.card();
  d.s.engine.cancel(d.t.id);
  await d.settle();
  assert.deepEqual(d.moods().at(-1), ['idle', 'cancelled']);
  d.release();
  await d.s.engine.waitFor(d.t.id, 3000);
});

test('B4: the timeout message names the real broker wait', async () => {
  const s = setup(() => happy(), { agent: { approval: 'ask' } }); // default broker timeout
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(s.approvals.timeoutWait, '10 minutes');
  assert.equal(describeWait(60_000), '1 minute');
  assert.equal(describeWait(150_000), '3 minutes');
  assert.equal(describeWait(5_000), '5 seconds');
});

test('concurrency cap and FIFO queue', async () => {
  const gates: (() => void)[] = [];
  const s = setup(() => (async function* () {
    yield init();
    await new Promise<void>((r) => gates.push(r));
    yield ok('x');
  })(), { maxConcurrent: 2 });
  const ids = [1, 2, 3].map((i) => s.engine.startTask({ agentId: 'a1', prompt: `p${i}`, source: 'ui' }).id);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.engine.running().length, 2);
  assert.equal(s.store.getTask(ids[2]!)!.status, 'queued');
  assert.equal(s.calls.length, 2);
  gates[0]!();
  await s.engine.waitFor(ids[0]!, 3000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2]!.prompt, 'p3');
  gates[1]!(); gates[2]!();
  for (const id of ids) assert.equal((await s.engine.waitFor(id, 3000)).status, 'done');
});

test('cancel after init leaves the task resumable (Continue picks up the session); cancel before init leaves it unset', async () => {
  const after = setup(() => (async function* () { yield init('sess-x'); await new Promise<void>(() => undefined); })());
  const a = after.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(after.engine.cancel(a.id), true);
  const doneA = await after.engine.waitFor(a.id, 3000);
  assert.equal(doneA.status, 'cancelled');
  assert.equal(doneA.sessionId, 'sess-x');
  assert.equal(doneA.resumable, true);
  const before = setup(() => (async function* () { await new Promise<void>(() => undefined); yield init('sess-y'); })());
  const b = before.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(before.engine.cancel(b.id), true);
  const doneB = await before.engine.waitFor(b.id, 3000);
  assert.equal(doneB.status, 'cancelled');
  assert.equal(doneB.sessionId, undefined);
  assert.equal(doneB.resumable, undefined);
});

test('cancelling a queued task removes it from the queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(() => (async function* () { yield init(); await gate; yield ok('x'); })(), { maxConcurrent: 1 });
  const a = s.engine.startTask({ agentId: 'a1', prompt: 'a', source: 'ui' });
  const b = s.engine.startTask({ agentId: 'a1', prompt: 'b', source: 'ui' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.engine.cancel(b.id), true);
  assert.equal(s.store.getTask(b.id)!.status, 'cancelled');
  release();
  await s.engine.waitFor(a.id, 3000);
  assert.equal(s.calls.length, 1);
});

test('thrown SDK error never crashes: task error + system message + mascot error', async () => {
  const s = setup(() => (async function* () { yield init(); throw new Error('spawn ENOENT'); })(), { agent: { model: 'opus' } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(done.status, 'error');
  assert.match(done.error!, /ENOENT/);
  assert.ok(s.store.msgs.some((m) => m.role === 'system' && /ENOENT/.test(m.text)));
  assert.ok(s.events.some((e: any) => e.type === 'mascot' && e.mood === 'error'));

  const s2 = setup(() => { throw new Error('sync boom'); }, { agent: { model: 'opus' } });
  const d2 = await s2.engine.waitFor(s2.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(d2.status, 'error');
});

test('waitFor times out with the current task', async () => {
  const s = setup(() => (async function* () { yield init(); await new Promise<void>(() => undefined); })());
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' });
  const cur = await s.engine.waitFor(t.id, 50);
  assert.ok(cur.status === 'running' || cur.status === 'queued');
  s.engine.cancel(t.id);
  await assert.rejects(s.engine.waitFor('nope', 10), (e: any) => e.status === 404);
});

test('mcpServers: config filtered per agent; legion vm server only when vm enabled + boat configured', async () => {
  const cfgFn = (c: LegionConfig) => {
    c.mcpServers = {
      one: { command: 'node', args: ['a.js'], env: { K: 'v' } },
      two: { type: 'http', url: 'http://x/mcp', headers: { A: 'b' } },
      three: { type: 'sse', url: 'http://y/sse' },
    };
  };
  const vm = { enabled: true, size: 'default' as const, idleStopMinutes: 15 };
  const all = setup(() => happy(), { config: cfgFn, boat: true, agent: { vm } });
  await all.engine.waitFor(all.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  const m = all.calls[0]!.options.mcpServers;
  assert.deepEqual(Object.keys(m).sort(), ['legion', 'one', 'three', 'two']);
  assert.equal(m.legion.type, 'sdk');
  assert.equal(m.legion.name, 'legion');
  assert.deepEqual(m.one, { type: 'stdio', command: 'node', args: ['a.js'], env: { K: 'v' } });
  assert.deepEqual(m.two, { type: 'http', url: 'http://x/mcp', headers: { A: 'b' } });

  const some = setup(() => happy(), { config: cfgFn, boat: false, agent: { vm, mcpServers: ['two'] } });
  await some.engine.waitFor(some.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.deepEqual(Object.keys(some.calls[0]!.options.mcpServers).sort(), ['legion', 'two']);
  assert.deepEqual(Object.keys((some.calls[0]!.options.mcpServers.legion.instance as any)._registeredTools).sort(), ['agents', 'ask', 'ask_user_question', 'task_result', 'tell']);
  assert.deepEqual(some.calls[0]!.options.disallowedTools, ['SendMessage', 'ListAgents', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']); // task list off by default for a non-lead agent
  assert.deepEqual(Object.keys((all.calls[0]!.options.mcpServers.legion.instance as any)._registeredTools).sort(), ['agents', 'ask', 'ask_user_question', 'task_result', 'tell', 'vm_claude', 'vm_desktop', 'vm_exec', 'vm_read_file', 'vm_start', 'vm_stop', 'vm_usage', 'vm_write_file']);
});

test('agent tools server builds with name legion', () => {
  const srv = buildAgentToolsServer({ agentId: 'a1', taskId: 't', vms: {} as any, vmEnabled: false, bridge: {} as any });
  assert.equal(srv.type, 'sdk');
  assert.equal(srv.name, 'legion');
  assert.ok(srv.instance);
});

test('local_command_output becomes an assistant message; unknown /commands sent verbatim; task.model is the value used', async () => {
  const s = setup(() => (async function* () {
    yield init();
    yield { type: 'system', subtype: 'local_command_output', content: 'Total cost: $0.00', session_id: 'sess-1' };
    yield { type: 'system', subtype: 'local_command_output', content: '   ', session_id: 'sess-1' };
    yield ok('');
  })(), { agent: { model: 'claude-opus-5-5[1m]' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: '/cost now', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(done.model, 'claude-opus-5-5[1m]');
  assert.equal(s.calls[0]!.prompt, '/cost now');
  assert.equal(s.calls[0]!.options.model, 'claude-opus-5-5[1m]');
  const msgs = s.store.listMessages(t.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', '/cost now'], ['assistant', 'Total cost: $0.00']]);
});

test('/model prefix sets model and is stripped; non-sonnet errors do not escalate', async () => {
  const s = setup(() => (async function* () { yield init(); yield err('error_max_turns'); })());
  const t = s.engine.startTask({ agentId: 'a1', prompt: '/model haiku do x', source: 'ui' });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.options.model, 'haiku');
  assert.equal(s.calls[0]!.prompt, 'do x');
  assert.equal(done.status, 'error');
});

import { clipToolResult } from '../src/core/engine.js';
test('clipToolResult keeps long JSON results parseable', () => {
  const raw = JSON.stringify({ taskId: 't1', status: 'done', result: 'x'.repeat(5000) });
  const out = clipToolResult(raw);
  const o = JSON.parse(out);
  assert.equal(o.taskId, 't1');
  assert.ok(o.result.length < 1500 && o.result.endsWith('…'));
  assert.ok(clipToolResult('y'.repeat(3000)).length === 1500);
});

// ---- module seam and bot-origin approval ceiling
test('modules: mcp servers and preamble are merged into the run options', async () => {
  const s = setup(() => happy());
  s.engine.setModules([{
    id: 'm',
    mcpServers: () => ({ legion_comms: { type: 'stdio', command: 'x' } as any }),
    preamble: () => 'COMMS PREAMBLE',
  }, { id: 'broken', mcpServers: () => { throw new Error('boom'); }, preamble: () => { throw new Error('boom'); } }]);
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'hi', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const o = s.calls[0]!.options;
  assert.ok(o.mcpServers.legion_comms);
  assert.match(o.systemPrompt.append, /COMMS PREAMBLE/);
});

test('modules: disallowedTools are added in every permission mode; a throwing module adds nothing', async () => {
  const s = setup(() => happy(), { agent: { approval: 'full' } });
  s.engine.setModules([
    { id: 'm', disallowedTools: (a) => (a.id === 'a1' ? ['mcp__blender'] : ['other']) },
    { id: 'broken', disallowedTools: () => { throw new Error('boom'); } },
  ]);
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'hi', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const o = s.calls[0]!.options;
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.deepEqual(o.disallowedTools, ['SendMessage', 'ListAgents', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'mcp__blender']);
});

test('bot-origin task: a full-approval agent is never run in bypass mode when the sender is stricter', async () => {
  const s = setup(() => happy(), { agent: { approval: 'full' } });
  const origin = { roomId: 'room_1', fromAgentId: 'scout', hop: 1, approvalCeiling: 'ask' as const };
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'do it', source: 'bot', origin });
  await s.engine.waitFor(t.id, 3000);
  const o = s.calls[0]!.options;
  assert.notEqual(o.permissionMode, 'bypassPermissions');
  assert.equal(typeof o.canUseTool, 'function');
  assert.equal(s.store.getTask(t.id)!.origin?.fromAgentId, 'scout');
  // Bash needs a card, and the card names the sender.
  const sig = { signal: new AbortController().signal };
  const p = o.canUseTool('Bash', { command: 'rm -rf x' }, sig);
  const [req] = s.approvals.pending();
  assert.deepEqual(req!.origin, { roomId: 'room_1', fromAgentId: 'scout', hop: 1 });
  s.approvals.resolve(req!.id, false);
  assert.equal((await p).behavior, 'deny');
});

test('bot-origin task with a full ceiling keeps the receiver bypass mode; human tasks are unchanged', async () => {
  const s = setup(() => happy(), { agent: { approval: 'full' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'bot', origin: { roomId: 'r', fromAgentId: 'builder', hop: 1, approvalCeiling: 'full' } });
  await s.engine.waitFor(t.id, 3000);
  assert.equal(s.calls[0]!.options.permissionMode, 'bypassPermissions');
});

// ---- spend limit (claude.maxBudgetUsd) and the context meter
test('spend limit: maxBudgetUsd is passed to the SDK when set, and absent when not', async () => {
  const withCap = setup(() => happy(), { config: (c) => { c.claude.maxBudgetUsd = 2.5; } });
  await withCap.engine.waitFor(withCap.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(withCap.calls[0]!.options.maxBudgetUsd, 2.5);
  const none = setup(() => happy());
  await none.engine.waitFor(none.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.ok(!('maxBudgetUsd' in none.calls[0]!.options), 'no cap configured, none passed');
  // a hand-edited bad value in config.json is no cap, not a crash or a zero budget
  const bad = setup(() => happy(), { config: (c) => { (c.claude as any).maxBudgetUsd = 'lots'; } });
  await bad.engine.waitFor(bad.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.ok(!('maxBudgetUsd' in bad.calls[0]!.options));
});

test('spend limit: error_max_budget_usd pauses like the turn limit (error, resumable, calm mascot, one short history line) and Continue resumes', async () => {
  const s = setup((_p, n) => (async function* () {
    yield init('sess-b');
    if (n === 0) yield err('error_max_budget_usd'); else yield ok('finished');
  })(), { agent: { model: 'opus' }, config: (c) => { c.claude.maxBudgetUsd = 5; } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'big job', source: 'ui' });
  const stopped = await s.engine.waitFor(t.id, 3000);
  assert.equal(stopped.status, 'error');
  assert.equal(stopped.resumable, true);
  assert.ok(stopped.error!.startsWith(BUDGET_LIMIT_PREFIX));
  assert.match(stopped.error!, /\(\$5 this run\)/);
  assert.doesNotMatch(stopped.error!, /Press|button|Settings/);
  assert.deepEqual(s.store.listMessages(t.id).filter((m) => m.role === 'system').map((m) => m.text), ['Paused at the spend limit ($5 this run).']);
  const moods = s.events.filter((e: any) => e.type === 'mascot').map((e: any) => [e.mood, e.note]);
  assert.ok(!moods.some(([m]) => m === 'error'), JSON.stringify(moods));
  assert.ok(moods.some(([m, n]) => m === 'idle' && n === 'paused at the spend limit'), JSON.stringify(moods));
  s.engine.startTask({ agentId: 'a1', prompt: CONTINUE_PROMPT, source: 'ui', continueTaskId: t.id });
  const done = await s.engine.waitFor(t.id, 3000);
  assert.equal(done.status, 'done');
  assert.equal(s.calls[1]!.options.resume, 'sess-b');
  assert.equal(s.calls[1]!.prompt, CONTINUE_PROMPT);
});

test('spend limit: sonnet at the spend limit pauses on sonnet, with no Opus escalation', async () => {
  const s = setup(() => (async function* () { yield init('sess-sb'); yield err('error_max_budget_usd'); })(), { agent: { model: 'sonnet' }, config: (c) => { c.claude.maxBudgetUsd = 0.5; } });
  const done = await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'long job', source: 'ui' }).id, 3000);
  assert.equal(s.calls.length, 1);
  assert.equal(done.escalated, undefined);
  assert.equal(done.model, 'sonnet');
  assert.equal(done.resumable, true);
  assert.match(done.error!, /\(\$0\.50 this run\)/);
});

test('context meter: task.progress carries the context after the latest top-level response, and a subagent does not move it', async () => {
  const withUsage = (id: string, usage: any, parent?: string) => ({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { id, usage, content: [{ type: 'text', text: 'ok' }] } });
  const s = setup(() => (async function* () {
    yield init();
    yield withUsage('m1', { input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, output_tokens: 999 });
    yield withUsage('sub', { input_tokens: 5, cache_read_input_tokens: 900_000 }, 'toolu_x');
    yield withUsage('m2', { input_tokens: 20, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_000 });
    yield ok('done');
  })(), { agent: { model: 'opus' } });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  const seen = s.events.filter((e: any) => e.type === 'task.progress').map((e: any) => e.progress.contextTokens);
  assert.deepEqual(seen, [undefined, 52_010, 84_020], 'first emit has none yet; then one per top-level response, never the subagent 900k');
});

test('task list on: the native Task tools are opted in (allowedTools); off: they and TodoWrite are disallowed', async () => {
  const on = setup(() => happy(), { agent: { taskList: 'on' } });
  await on.engine.waitFor(on.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) assert.ok(on.calls[0]!.options.allowedTools.includes(t), t);
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) assert.ok(!on.calls[0]!.options.disallowedTools.includes(t), t);
  const off = setup(() => happy(), { agent: { taskList: 'off' } });
  await off.engine.waitFor(off.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']) assert.ok(off.calls[0]!.options.disallowedTools.includes(t), t);
  assert.equal(off.calls[0]!.options.allowedTools, undefined);
});

// SessionStart, fired by the fake SDK the way the CLI fires it: at the start of the session, before the model's first turn.
const fireSessionStart = async (params: any, source: string): Promise<string | undefined> => {
  const hook = params.options.hooks?.SessionStart?.flatMap((m: any) => m.hooks)[0];
  const out = await hook?.({ hook_event_name: 'SessionStart', source, session_id: 's', transcript_path: '', cwd: '' }, undefined, { signal: new AbortController().signal });
  return out?.hookSpecificOutput?.additionalContext;
};

test('Claude run after a provider changed the list: it is handed over once, the flag clears, and the run\'s own mirror does not set it again', async () => {
  const { TaskList, TaskListStore } = await import('../src/core/task-list.js');
  const seen: Array<string | undefined> = [];
  let n = 0;
  const s = setup((params) => (async function* () {
    n++;
    yield init('sess-hand');
    if (n > 1) seen.push(await fireSessionStart(params, 'resume'));
    if (n === 2) {
      yield taskCall('c1', 'TaskCreate', { subject: 'mine too', description: '' });
      yield taskResult('c1', { task: { id: '2', subject: 'mine too' } });
    }
    yield ok('done');
  })(), { agent: { model: 'opus', taskList: 'on' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const store = new TaskListStore(join(s.config.workspaceDir, '.task-lists'));
  const l = new TaskList(); l.create({ subject: 'from the provider', description: '' }); l.handoverPending = true; store.save(t.id, l);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  assert.match(seen[0] ?? '', /make your own list match/);
  assert.match(seen[0] ?? '', /1\. from the provider \(pending\)/);
  assert.equal(store.load(t.id).handoverPending, false, 'cleared, and the mirrored TaskCreate after it did not write it back');
  s.engine.startTask({ agentId: 'a1', prompt: 'three', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  assert.equal(seen[1], undefined, 'once only');
});

test('after Claude compacts, the open tasks are shown again; an empty list adds nothing', async () => {
  const { TaskList, TaskListStore } = await import('../src/core/task-list.js');
  const seen: Array<string | undefined> = [];
  const s = setup((params) => (async function* () {
    yield init('sess-compact');
    seen.push(await fireSessionStart(params, 'compact'));
    yield ok('done');
  })(), { agent: { model: 'opus', taskList: 'on' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  assert.equal(seen[0], undefined, 'an empty list: no block at all');
  const store = new TaskListStore(join(s.config.workspaceDir, '.task-lists'));
  const l = new TaskList(); l.create({ subject: 'keep going', description: '' }); store.save(t.id, l);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  assert.match(seen[1] ?? '', /^\[Your task list for this conversation, kept by Legion\]\n- \[ \] 1\. keep going \(pending\)$/);
});

test('a Claude-only conversation (no flag, session resumed) gets no hand-over', async () => {
  const seen: Array<string | undefined> = [];
  let n = 0;
  const s = setup((params) => (async function* () {
    n++;
    yield init('sess-only');
    if (n === 1) {
      yield taskCall('c1', 'TaskCreate', { subject: 'claude made me', description: '' });
      yield taskResult('c1', { task: { id: '1', subject: 'claude made me' } });
    } else seen.push(await fireSessionStart(params, 'resume'));
    yield ok('done');
  })(), { agent: { model: 'opus', taskList: 'on' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], undefined, 'Claude\'s own list is already right; a hand-over would make it re-create its tasks');
});

test('task list off: no SessionStart hook is installed', async () => {
  const s = setup(() => happy(), { agent: { taskList: 'off' } });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui' }).id, 3000);
  assert.equal(s.calls[0]!.options.hooks.SessionStart, undefined);
});

test('a hand-over run that stops before it finishes leaves the provider\'s list as it was, flagged for the next Claude run', async () => {
  const { TaskList, TaskListStore } = await import('../src/core/task-list.js');
  let n = 0;
  const s = setup((params) => (async function* () {
    n++;
    yield init('sess-stop');
    if (n === 2) {
      await fireSessionStart(params, 'resume');
      // the hand-over's first step: Claude's own list, still empty, replaces the mirror
      yield taskCall('l1', 'TaskList', {});
      yield taskResult('l1', { tasks: [] });
      yield err('error_during_execution', ['the run broke']);
      return;
    }
    yield ok('done');
  })(), { agent: { model: 'opus', taskList: 'on' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const store = new TaskListStore(join(s.config.workspaceDir, '.task-lists'));
  const l = new TaskList(); l.create({ subject: 'from the provider', description: '' }); l.handoverPending = true; store.save(t.id, l);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  const end = await s.engine.waitFor(t.id, 3000);
  assert.equal(end.status, 'error');
  // waitFor answers when the status is saved; the run itself ends a moment later
  for (let i = 0; i < 100 && s.engine.running().includes(t.id); i++) await new Promise((r) => setTimeout(r, 10));
  const after = store.load(t.id);
  assert.deepEqual(after.list().map((x) => x.subject), ['from the provider'], 'the provider\'s tasks are not lost to an unfinished hand-over');
  assert.equal(after.handoverPending, true, 'handed over again next time');
});

test('a finished hand-over keeps the provider\'s done tasks on the checklist', async () => {
  const { TaskList, TaskListStore } = await import('../src/core/task-list.js');
  let n = 0;
  const s = setup((params) => (async function* () {
    n++;
    yield init('sess-keep');
    if (n === 2) {
      await fireSessionStart(params, 'resume');
      yield taskCall('l1', 'TaskList', {});
      yield taskResult('l1', { tasks: [] });
      yield taskCall('c1', 'TaskCreate', { subject: 'still open', description: '' });
      yield taskResult('c1', { task: { id: '1', subject: 'still open' } });
    }
    yield ok('done');
  })(), { agent: { model: 'opus', taskList: 'on' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const store = new TaskListStore(join(s.config.workspaceDir, '.task-lists'));
  const l = new TaskList();
  l.create({ subject: 'already done', description: '' }); l.create({ subject: 'still open', description: '' });
  l.update({ taskId: '1', status: 'completed' }); l.handoverPending = true; store.save(t.id, l);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  for (let i = 0; i < 100 && s.engine.running().includes(t.id); i++) await new Promise((r) => setTimeout(r, 10));
  const after = store.load(t.id);
  assert.deepEqual(after.list().map((x) => [x.subject, x.status]), [['still open', 'pending'], ['already done', 'completed']]);
  assert.equal(after.handoverPending, false);
});

test('a provider run that emptied the list still hands over (Claude empties its own) and the flag clears', async () => {
  const { TaskList, TaskListStore } = await import('../src/core/task-list.js');
  const seen: Array<string | undefined> = [];
  let n = 0;
  const s = setup((params) => (async function* () {
    n++;
    yield init('sess-empty');
    if (n === 2) seen.push(await fireSessionStart(params, 'resume'));
    yield ok('done');
  })(), { agent: { model: 'opus', taskList: 'on' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  await s.engine.waitFor(t.id, 3000);
  const store = new TaskListStore(join(s.config.workspaceDir, '.task-lists'));
  const l = new TaskList(); l.handoverPending = true; store.save(t.id, l);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  await s.engine.waitFor(t.id, 3000);
  for (let i = 0; i < 100 && s.engine.running().includes(t.id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(seen[0] ?? '', /empty/i);
  assert.equal(store.load(t.id).handoverPending, false);
});

test('cost: a resumed session\'s total_cost_usd is cumulative, so a task counts the new spend only (not the history again)', async () => {
  const res = (sid: string, total: number) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: total, num_turns: 1, session_id: sid });
  const plan: Array<[string, number]> = [['sess-c', 0.10], ['sess-c', 0.25], ['sess-d', 0.05]];
  let n = 0;
  const s = setup(() => (async function* () {
    const [sid, total] = plan[n++]!;
    yield init(sid);
    yield res(sid, total);
  })(), { agent: { model: 'opus' } });
  const t = s.engine.startTask({ agentId: 'a1', prompt: 'one', source: 'ui' });
  assert.equal((await s.engine.waitFor(t.id, 3000)).costUsd, 0.10);
  s.engine.startTask({ agentId: 'a1', prompt: 'two', source: 'ui', continueTaskId: t.id });
  const second = await s.engine.waitFor(t.id, 3000);
  assert.ok(Math.abs(second.costUsd! - 0.25) < 1e-9, `the resumed run added 0.15, not 0.25: ${second.costUsd}`);
  // a new session (the old one could not be resumed) starts its own count
  s.store.upsertTask({ ...s.store.getTask(t.id)!, sessionId: undefined } as never);
  s.engine.startTask({ agentId: 'a1', prompt: 'three', source: 'ui', continueTaskId: t.id });
  const third = await s.engine.waitFor(t.id, 3000);
  assert.ok(Math.abs(third.costUsd! - 0.30) < 1e-9, `a new session adds its own total: ${third.costUsd}`);
});
