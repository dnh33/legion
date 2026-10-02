import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineError } from '../src/core/engine.js';
import { jsonReply, replyText, replyTools, sseHead, sseSend, chunk, startFake } from './providers-fakes.js';
import { run, setup, until } from './providers-harness.js';

test('C1 a Claude agent runs on Claude and never touches a provider, even with one configured', async () => {
  const f = await startFake((_r, res) => replyText(res, 'provider'));
  try {
    const h = setup(f, { agent: { model: 'sonnet' } });
    const t = await run(h);
    assert.equal(t.status, 'done'); assert.equal(t.result, 'claude says hi');
    assert.equal(h.claudeCalls.length, 1); assert.equal(f.requests.length, 0);
    assert.equal(t.provider, undefined);
    // a model value that merely contains a colon but names no provider is the Claude path as before
    const h2 = setup(f, { agent: { model: 'arn:aws:bedrock:us-east-1:123:inference-profile/x' } });
    await run(h2); assert.equal(h2.claudeCalls.length, 1); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('a provider run: streamed answer, usage recorded, cost left unknown without owner prices, no Claude call', async () => {
  const f = await startFake((_r, res) => replyText(res, 'Hello from the fake', { prompt_tokens: 12, completion_tokens: 7 }));
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'done'); assert.equal(t.result, 'Hello from the fake');
    assert.equal(t.provider, 'fake'); assert.equal(t.model, 'fake:test-model');
    assert.deepEqual(t.tokenUsage, { inputTokens: 12, outputTokens: 7 });
    assert.equal(t.costUsd, undefined, 'no price, no cost: unknown stays unknown');
    assert.equal(h.claudeCalls.length, 0);
    assert.equal(f.requests[0]!.body.model, 'test-model');
    assert.match(f.requests[0]!.body.messages[0].content, /You are Alpha, an agent inside Legion/);
    assert.match(f.requests[0]!.body.messages[0].content, /through Fake\. You have only the tools listed/);
    assert.deepEqual(h.store.listMessages(t.id).map((m) => m.role), ['user', 'assistant']);
    assert.ok(h.events.some((e) => e.type === 'message.delta'), 'text streams as deltas');
    assert.ok(h.events.some((e) => e.type === 'mascot' && e.mood === 'success'));
  } finally { await f.close(); }
});

test('C18 cost comes only from prices the owner entered; a response without token counts is recorded as unknown', async () => {
  const f = await startFake((r, res) => (r.body.model === 'nousage' ? replyText(res, 'x') : replyText(res, 'y', { prompt_tokens: 1_000_000, completion_tokens: 500_000 })));
  try {
    const h = setup(f, { entry: { prices: { priced: { inputPerMTok: 2, outputPerMTok: 8 } } }, agent: { model: 'fake:priced' } });
    const t = await run(h);
    assert.equal(t.costUsd, 6);
    const h2 = setup(f, { agent: { model: 'fake:nousage' } });
    const t2 = await run(h2);
    assert.equal(t2.tokenUsage?.unknown, true); assert.equal(t2.costUsd, undefined);
    const h3 = setup(f, { entry: { prices: { nousage: { inputPerMTok: 2, outputPerMTok: 8 } } }, agent: { model: 'fake:nousage' } });
    assert.equal((await run(h3)).costUsd, undefined, 'a price without token counts gives no cost');
  } finally { await f.close(); }
});

test('C2 a provider failure is the task\'s error: no fallback to Claude, no escalation, the provider message is shown', async () => {
  const f = await startFake((_r, res) => jsonReply(res, 500, { error: { message: 'model overloaded' } }));
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'error'); assert.match(t.error ?? '', /model overloaded/);
    assert.equal(h.claudeCalls.length, 0);
    assert.equal(h.store.listMessages(t.id).some((m) => /Escalated/.test(m.text)), false);
    assert.ok(h.events.some((e) => e.type === 'mascot' && e.mood === 'error'));
  } finally { await f.close(); }
});

test('C19 a deleted or disabled provider stops the run before any request and says what to fix', async () => {
  const f = await startFake((_r, res) => replyText(res, 'x'));
  try {
    const gone = setup(f, { noEntry: true, agent: { model: 'openai:gpt-test' } });
    const t = await run(gone);
    assert.equal(t.status, 'error'); assert.match(t.error ?? '', /not set up any more/);
    assert.equal(gone.claudeCalls.length, 0); assert.equal(f.requests.length, 0);
    const off = setup(f, { entry: { enabled: false } });
    const t2 = await run(off);
    assert.match(t2.error ?? '', /turned off/); assert.equal(f.requests.length, 0);
    const nokey = setup(f, { entry: { keyless: false } });
    const t3 = await run(nokey);
    assert.match(t3.error ?? '', /No API key is saved/); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('C3 a bot or token client cannot move a provider agent to Claude or to another model, nor a Claude agent onto a provider', async () => {
  const f = await startFake((_r, res) => replyText(res, 'from provider'));
  try {
    const h = setup(f);
    // a bot's per-task override on a provider agent is refused
    assert.throws(() => h.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui', model: 'sonnet', modelOverrideBy: 'bot' } as any), (e: unknown) => e instanceof EngineError && e.status === 400);
    assert.throws(() => h.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui', model: 'auto', modelOverrideBy: 'bot' } as any), EngineError);
    // a token client may not name a model on a provider agent (even a Claude alias), nor a provider on a Claude agent
    assert.throws(() => h.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'mcp', model: 'opus' } as any), /only be chosen in the Legion app/);
    const c = setup(f, { agent: { model: 'sonnet' } });
    assert.throws(() => c.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'mcp', model: 'fake:test-model' } as any), /only be chosen in the Legion app/);
    // a /opus prefix in a message that came through a chain (origin set) is clamped to the agent's own provider setting
    const t = await run(h, '/opus please', { origin: { roomId: 'r', fromAgentId: 'bot', hop: 1, approvalCeiling: 'ask' } });
    assert.equal(t.status, 'done'); assert.equal(h.claudeCalls.length, 0); assert.equal(t.model, 'fake:test-model');
    // and a /model prefix naming a provider, in a bot's message to a Claude agent, never reaches the provider
    const before = f.requests.length;
    const t2 = await run(c, '/model fake:test-model please', { origin: { roomId: 'r', fromAgentId: 'bot', hop: 1, approvalCeiling: 'ask' } });
    assert.equal(t2.status, 'done'); assert.equal(c.claudeCalls.length, 1); assert.equal(f.requests.length, before);
    // the owner typing it in the app is the owner's own choice
    const t3 = await run(c, '/model fake:test-model please');
    assert.equal(t3.provider, 'fake');
  } finally { await f.close(); }
});

test('C17 cancel aborts the provider request and nothing runs after it', async () => {
  let closed = false;
  const f = await startFake((_r, res) => { sseHead(res); sseSend(res, chunk({ content: 'partial' })); res.on('close', () => { closed = true; }); });
  try {
    const h = setup(f);
    const t = h.engine.startTask({ agentId: 'a1', prompt: 'slow', source: 'ui' } as any);
    await until(() => f.requests.length === 1);
    await until(() => h.events.some((e) => e.type === 'message.delta'));
    assert.equal(h.engine.cancel(t.id), true);
    const done = await h.engine.waitFor(t.id, 3000);
    assert.equal(done.status, 'cancelled');
    await until(() => closed);
    assert.equal(h.claudeCalls.length, 0);
  } finally { await f.close(); }
});

test('history: a continued task sends the earlier messages, with tool calls paired to their results', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'c1', name: 'mcp__legion__agents', args: {} }]); else replyText(res, n === 2 ? 'first answer' : 'second answer'); });
  try {
    const h = setup(f);
    const t1 = await run(h, 'first question');
    assert.equal(t1.result, 'first answer');
    const again = h.engine.startTask({ agentId: 'a1', prompt: 'second question', source: 'ui', continueTaskId: t1.id } as any);
    const t2 = await h.engine.waitFor(again.id, 5000);
    assert.equal(t2.result, 'second answer');
    const last = f.requests[f.requests.length - 1]!.body.messages as any[];
    const roles = last.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    assert.equal(last[1].content, 'first question'); assert.equal(last[2].tool_calls[0].id, 'c1'); assert.equal(last[3].tool_call_id, 'c1');
    assert.equal(last[5].content, 'second question');
  } finally { await f.close(); }
});
