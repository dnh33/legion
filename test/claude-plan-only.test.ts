/**
 * Claude login = your Claude plan only. claude.allowApiBilling (default off): the child env and the flag settings blank every API key
 * source, and a run whose init message reports an API key source stops before any model turn.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine, buildChildEnv, connectorSettings, planOnlySettings } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { runDoctor } from '../src/core/doctor.js';
import { validatePatch } from '../src/core/settings.js';
import { explainClaudeError } from '../src/shared/claude-errors.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile, LegionConfig } from '../src/shared/types.js';

// The Doctor reads the Claude Code settings the runs load: an empty temp folder, never the real one.
process.env.CLAUDE_CONFIG_DIR = cleanupTemp('legion-plan-home-');

const BLOCKED = (src: string) => `This run did not start: Claude Code would bill Anthropic API credits (key source: ${src}), and Legion's Claude login uses your Claude plan only. To use your plan: run claude in a terminal, type /logout, then /login and choose your Claude account. If you mean to pay with API credits, turn on Settings -> Claude -> Allow API credit billing.`;

function cfg(over: (c: LegionConfig) => void = () => undefined) {
  const c = defaultConfig();
  c.workspaceDir = join(cleanupTemp('legion-plan-'), 'ws');
  over(c);
  return c;
}
function withEnv<T>(vals: Record<string, string>, fn: () => T): T {
  const save: Record<string, string | undefined> = {};
  for (const k of Object.keys(vals)) { save[k] = process.env[k]; process.env[k] = vals[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vals)) { if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k]; } }
}

test('buildChildEnv: plan only blanks both key variables, even when the process has real-looking ones', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake-shell', ANTHROPIC_AUTH_TOKEN: 'tok-fake-shell' }, () => {
    const env = buildChildEnv(cfg());
    assert.equal(env.ANTHROPIC_API_KEY, '');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, '');
    assert.ok('ANTHROPIC_API_KEY' in env && 'ANTHROPIC_AUTH_TOKEN' in env);
    const probe = buildChildEnv(cfg(), { probe: true });
    assert.equal(probe.ANTHROPIC_API_KEY, ''); assert.equal(probe.ANTHROPIC_AUTH_TOKEN, '');
  });
});

test('buildChildEnv: allowApiBilling deletes them (the old behaviour); api-key mode sets the key', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake-shell', ANTHROPIC_AUTH_TOKEN: 'tok-fake-shell' }, () => {
    const env = buildChildEnv(cfg((c) => { c.claude.allowApiBilling = true; }));
    assert.equal('ANTHROPIC_API_KEY' in env, false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
    const k = buildChildEnv(cfg((c) => { c.claude.auth = 'api-key'; c.claude.apiKey = 'sk-config'; }));
    assert.equal(k.ANTHROPIC_API_KEY, 'sk-config');
  });
});

test('planOnlySettings: blanks keys and the helper; absent in api-key mode and with allowApiBilling', () => {
  assert.deepEqual(planOnlySettings(cfg()), { env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }, apiKeyHelper: '' });
  assert.deepEqual(planOnlySettings(cfg((c) => { c.claude.allowApiBilling = false; })), { env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }, apiKeyHelper: '' });
  assert.deepEqual(planOnlySettings(cfg((c) => { c.claude.allowApiBilling = true; })), {});
  assert.deepEqual(planOnlySettings(cfg((c) => { c.claude.auth = 'api-key'; c.claude.apiKey = 'k'; })), {});
});

test('planOnlySettings merges over the existing flag settings and keeps every one of them', () => {
  const merged = planOnlySettings(cfg(), { ...connectorSettings(cfg()).settings, disableSkillShellExecution: true });
  assert.deepEqual(merged, { disableClaudeAiConnectors: true, disableSkillShellExecution: true, env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }, apiKeyHelper: '' });
  const allowed = planOnlySettings(cfg((c) => { c.claude.allowApiBilling = true; }), { disableSkillShellExecution: true });
  assert.deepEqual(allowed, { disableSkillShellExecution: true });
});

test('settings: allowApiBilling is a boolean, nothing else', () => {
  assert.deepEqual(validatePatch({ claude: { allowApiBilling: true } }).claude, { allowApiBilling: true });
  assert.deepEqual(validatePatch({ claude: { allowApiBilling: false } }).claude, { allowApiBilling: false });
  for (const bad of ['yes', 1, null, {}]) assert.throws(() => validatePatch({ claude: { allowApiBilling: bad } }), /allowApiBilling must be a boolean/);
  assert.equal(defaultConfig().claude.allowApiBilling, undefined);
});

// ---- engine
class FakeStore {
  agents = new Map<string, AgentProfile>();
  tasks = new Map<string, any>();
  msgs: any[] = [];
  getAgent(id: string) { return this.agents.get(id); }
  upsertTask(t: any) { const c = { ...t }; this.tasks.set(t.id, c); return c; }
  getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : undefined; }
  addMessage(m: any) { this.msgs.push(m); return m; }
  listMessages(id: string) { return this.msgs.filter((m) => m.taskId === id); }
}
const agent = (): AgentProfile => ({
  id: 'a1', name: 'Alpha', emoji: 'A', description: '', systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: ['*'], createdAt: '', updatedAt: '',
});
function setup(script: (n: number) => AsyncGenerator<any, void>, over: (c: LegionConfig) => void = () => undefined, account: (() => Promise<unknown>) | null = async () => ({ apiKeySource: 'none' }), accountCheckMs?: number) {
  const store = new FakeStore();
  store.agents.set('a1', agent());
  const bus = new EventBus();
  const config = cfg(over);
  const calls: any[] = [];
  let closed = 0;
  let pulled = 0;
  const order: string[] = [];
  let accountCalls = 0;
  const queryFn = ((p: any) => {
    calls.push(p);
    const gen = script(calls.length - 1);
    const q: any = { interrupt: async () => undefined, close: () => { closed++; } };
    if (account) q.accountInfo = async () => { accountCalls++; const r = await account(); order.push('account'); return r; };
    // what the SDK does: read the prompt stream at once and write each message to the CLI
    void (async () => { for await (const _m of p.prompt) order.push('message'); })().catch(() => undefined);
    // counts the messages the engine really took from the stream
    const wrapped = (async function* () { for await (const m of gen) { pulled++; yield m; } })();
    return Object.assign(wrapped, q);
  }) as unknown as QueryFn;
  const engine = new Engine({ store: store as any, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, ...(accountCheckMs ? { accountCheckMs } : {}) });
  return { order, accountN: () => accountCalls, calls, engine, store, config, closedN: () => closed, pulledN: () => pulled };
}
const init = (apiKeySource?: string) => ({ type: 'system', subtype: 'init', session_id: 's1', ...(apiKeySource !== undefined ? { apiKeySource } : {}) });
const ok = { type: 'result', subtype: 'success', is_error: false, result: 'fine', total_cost_usd: 0, num_turns: 1, session_id: 's1' };
const assistant = { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] }, session_id: 's1' };
const run = async (s: ReturnType<typeof setup>) => s.engine.waitFor(s.engine.startTask({ agentId: 'a1', prompt: 'go', source: 'ui' }).id, 3000);

test('engine: the run options carry the plan-only settings next to the existing flags', async () => {
  const s = setup(async function* () { yield init('none'); yield ok; });
  await run(s);
  assert.deepEqual(s.calls[0].options.settings, { disableClaudeAiConnectors: true, disableSkillShellExecution: true, env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }, apiKeyHelper: '' });
  assert.equal(s.calls[0].options.env.ANTHROPIC_API_KEY, '');
});

test('engine: init reports an API key source -> the run does not start, exact text, no model turn, no escalation', async () => {
  const s = setup(async function* () { yield init('/login managed key'); yield assistant; yield ok; });
  const t = await run(s);
  assert.equal(t.status, 'error');
  assert.equal(t.error, BLOCKED('/login managed key'));
  assert.equal(s.calls.length, 1, 'no Sonnet to Opus retry');
  assert.equal(s.pulledN(), 1, 'nothing after init was taken from the stream');
  assert.equal(s.closedN() >= 1, true, 'the query was closed');
  assert.equal(s.store.listMessages(t.id).some((m) => m.role === 'system' && m.text === `Error: ${BLOCKED('/login managed key')}`), true);
  assert.equal(s.store.listMessages(t.id).some((m) => m.role === 'assistant'), false);
});

test('engine: init says none (or says nothing) -> the run goes on', async () => {
  for (const src of ['none', undefined]) {
    const s = setup(async function* () { yield init(src); yield ok; });
    const t = await run(s);
    assert.equal(t.status, 'done', String(src));
  }
});

test('engine: allowApiBilling on -> an API key source runs', async () => {
  const s = setup(async function* () { yield init('/login managed key'); yield ok; }, (c) => { c.claude.allowApiBilling = true; });
  const t = await run(s);
  assert.equal(t.status, 'done');
  assert.equal(s.calls[0].options.settings.apiKeyHelper, undefined);
  assert.equal(s.calls[0].options.settings.env, undefined);
});

test('engine: api-key mode with an API key source runs (the owner chose API billing)', async () => {
  const s = setup(async function* () { yield init('ANTHROPIC_API_KEY'); yield ok; }, (c) => { c.claude.auth = 'api-key'; c.claude.apiKey = 'sk-config'; });
  assert.equal((await run(s)).status, 'done');
});

// ---- doctor
const fakeQuery = (info: unknown, seen?: { opts?: any }): QueryFn =>
  ((params: any) => { if (seen) seen.opts = params.options; return { accountInfo: async () => info, interrupt: async () => undefined, close: () => undefined }; }) as unknown as QueryFn;
const claudeCheck = async (config: LegionConfig, info: unknown, seen?: { opts?: any }) =>
  (await runDoctor({ config, getBoat: () => null, queryFn: fakeQuery(info, seen) })).find((x) => x.id === 'claude')!;
function withSettingsJson<T>(body: object, fn: () => Promise<T>): Promise<T> {
  const dir = cleanupTemp('legion-plan-doc-');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(body));
  const save = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = dir;
  return fn().finally(() => { process.env.CLAUDE_CONFIG_DIR = save; });
}

test('doctor: plan only + API key source -> not ok, runs will not start, fix names /logout and the switch', async () => {
  const seen: { opts?: any } = {};
  const c = await claudeCheck(cfg(), { email: 'a@b.c', apiKeySource: '/login managed key' }, seen);
  assert.equal(c.ok, false);
  assert.equal(c.detail, 'Runs would bill API credits (key source: /login managed key), so Legion will not start them');
  assert.match(c.fix!, /\/logout, then \/login/);
  assert.match(c.fix!, /Or turn on Settings -> Claude -> Allow API credit billing\.$/);
  assert.deepEqual(seen.opts.settings.env, { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' });
  assert.equal(seen.opts.settings.apiKeyHelper, '');
  assert.equal(seen.opts.settings.disableClaudeAiConnectors, true);
});

test('doctor: plan only + source none -> ok, and a key in settings.json no longer fails it (those keys are blanked)', async () => {
  await withSettingsJson({ env: { ANTHROPIC_API_KEY: 'sk-secret-value' } }, async () => {
    const c = await claudeCheck(cfg(), { email: 'a@b.c', subscriptionType: 'max', apiKeySource: 'none' });
    assert.equal(c.ok, true);
    assert.doesNotMatch(JSON.stringify(c), /sk-secret-value/);
    assert.doesNotMatch(c.detail, /ANTHROPIC_API_KEY/);
  });
});

test('doctor: allowApiBilling + API key source -> ok true, says so; settings.json key names stay as information', async () => {
  const allow = (x: LegionConfig) => { x.claude.allowApiBilling = true; };
  const c = await claudeCheck(cfg(allow), { email: 'a@b.c', apiKeySource: '/login managed key' });
  assert.equal(c.ok, true);
  assert.match(c.detail, /Signed in; runs bill API credits \(key source: \/login managed key\), as you allowed in Settings/);
  await withSettingsJson({ env: { ANTHROPIC_API_KEY: 'sk-secret-value' } }, async () => {
    const d = await claudeCheck(cfg(allow), { email: 'a@b.c', subscriptionType: 'max', apiKeySource: 'none' });
    assert.equal(d.ok, true);
    assert.match(d.detail, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(JSON.stringify(d), /sk-secret-value/);
  });
});

test('doctor: with allowApiBilling the probe settings do not blank the keys', async () => {
  const seen: { opts?: any } = {};
  await claudeCheck(cfg((x) => { x.claude.allowApiBilling = true; }), { email: 'a@b.c' }, seen);
  assert.equal(seen.opts.settings.env, undefined);
  assert.equal(seen.opts.settings.apiKeyHelper, undefined);
});

test('explainClaudeError: the claude-login text ends with the switch sentence', () => {
  const t = explainClaudeError('Credit balance is too low', 'claude-login')!;
  assert.match(t, /Or, to pay with API credits on purpose, turn on Settings -> Claude -> Allow API credit billing\.$/);
  assert.doesNotMatch(explainClaudeError('Credit balance is too low', 'api-key')!, /Allow API credit billing/);
});

// ---- the account check holds the first message
test('plan only: the first message is written only after accountInfo resolved', async () => {
  const s = setup(async function* () { yield init('none'); yield ok; }, undefined, async () => { await new Promise((r) => setTimeout(r, 30)); return { apiKeySource: 'none' }; });
  const t = await run(s);
  assert.equal(t.status, 'done');
  assert.deepEqual(s.order, ['account', 'message']);
});

test('plan only: accountInfo reports a key source -> no message is ever written, exact text, no escalation', async () => {
  const s = setup(async function* () { yield init('none'); yield ok; }, undefined, async () => ({ apiKeySource: '/login managed key' }));
  const t = await run(s);
  assert.equal(t.status, 'error');
  assert.equal(t.error, BLOCKED('/login managed key'));
  assert.equal(s.calls.length, 1);
  // give the fake's prompt reader time to record a message a closed channel might still deliver
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.order, ['account']);
});

test('plan only: the account check fails or times out -> fails closed, no message written, no escalation', async () => {
  const text = 'This run did not start: Legion could not confirm that Claude Code will use your Claude plan (the account check did not answer). Try again. If it keeps happening, open Help -> Doctor.';
  for (const account of [async () => { throw new Error('boom'); }, () => new Promise<unknown>(() => undefined)]) {
    const s = setup(async function* () { yield init('none'); yield ok; }, undefined, account, 40);
    const t = await run(s);
    assert.equal(t.status, 'error');
    assert.equal(t.error, text);
    assert.equal(s.calls.length, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.order.includes('message'), false);
  }
});

test('allowApiBilling and api-key mode: accountInfo is not called and the message goes out at once', async () => {
  for (const over of [(c: LegionConfig) => { c.claude.allowApiBilling = true; }, (c: LegionConfig) => { c.claude.auth = 'api-key'; c.claude.apiKey = 'sk-config'; }]) {
    const s = setup(async function* () { yield init('ANTHROPIC_API_KEY'); yield ok; }, over, async () => ({ apiKeySource: 'ANTHROPIC_API_KEY' }));
    assert.equal((await run(s)).status, 'done');
    assert.equal(s.accountN(), 0);
    assert.deepEqual(s.order, ['message']);
  }
});

test('explainClaudeError: with API billing allowed it does not suggest turning the switch on', () => {
  const t = explainClaudeError('Credit balance is too low', 'claude-login', true)!;
  assert.doesNotMatch(t, /Allow API credit billing/);
  assert.match(t, /add credits in the Claude Console/);
});
