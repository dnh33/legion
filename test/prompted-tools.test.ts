/**
 * Prompted tools (agent-shell plan W2): a provider model with no native tool calling is given the tools in its prompt
 * and calls them with a fenced block. The parser takes the blocks out of the text, a broken block becomes a call the
 * loop answers with a corrective error, and the history is rewritten so such a model never sees role "tool".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolBlocks, promptedMessages, renderToolCatalogue } from '../src/core/providers/prompted-tools.js';
import type { ChatMessage, ChatToolSpec } from '../src/core/providers/types.js';

const FENCE = '`'.repeat(3);
const spec = (name: string): ChatToolSpec => ({ type: 'function', function: { name, description: `does ${name}`, parameters: { type: 'object', properties: { path: { type: 'string' } } } } });

test('the catalogue names every tool with its description and schema, and states the one call format', () => {
  const t = renderToolCatalogue([spec('mcp__host__read_file'), spec('mcp__legion__todo_create')]);
  assert.match(t, /mcp__host__read_file/);
  assert.match(t, /does mcp__legion__todo_create/);
  assert.match(t, /"path"/);
  assert.ok(t.includes(`${FENCE}tool_call`), 'the contract shows the fence');
});

test('parse: blocks become calls with JSON-string arguments, and are taken out of the text', () => {
  const text = `I will read it.\n${FENCE}tool_call\n{"name": "mcp__host__read_file", "arguments": {"path": "a.txt"}}\n${FENCE}\nand then\n${FENCE}tool_call\n{"name":"mcp__legion__todo_create","arguments":{"subject":"x"}}\n${FENCE}`;
  const r = parseToolBlocks(text);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0]!.function.name, 'mcp__host__read_file');
  assert.deepEqual(JSON.parse(r.calls[0]!.function.arguments), { path: 'a.txt' });
  assert.equal(r.calls[1]!.function.name, 'mcp__legion__todo_create');
  assert.notEqual(r.calls[0]!.id, r.calls[1]!.id);
  assert.doesNotMatch(r.text, /tool_call/);
  assert.match(r.text, /I will read it\./);
});

test('parse: a broken block is still a call, whose arguments the loop refuses with a corrective error; no block, no call', () => {
  const broken = parseToolBlocks(`${FENCE}tool_call\n{"name": "mcp__host__shell", "arguments": {"command": "ls"\n${FENCE}`);
  assert.equal(broken.calls.length, 1);
  assert.equal(broken.calls[0]!.function.name, 'mcp__host__shell', 'the name is recovered when it can be');
  assert.throws(() => JSON.parse(broken.calls[0]!.function.arguments), 'the arguments are not JSON, so the loop answers with its own correction');
  assert.equal(parseToolBlocks('just an answer, with `code` and\n```js\nlet x = 1\n```').calls.length, 0, 'other fences are not calls');
});

test('history for a prompted model: the catalogue joins the system message, past calls become blocks and results become user text', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'You are Scout.' },
    { role: 'user', content: 'read a.txt' },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp__host__read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', content: 'hello', tool_call_id: 'call_1' },
  ];
  const out = promptedMessages(msgs, [spec('mcp__host__read_file')]);
  assert.match(out[0]!.content!, /^You are Scout\./);
  assert.match(out[0]!.content!, /mcp__host__read_file/);
  assert.ok(out.every((m) => m.role !== 'tool' && !m.tool_calls), 'no native tool fields reach the model');
  assert.ok(out[2]!.content!.includes(`${FENCE}tool_call`));
  assert.equal(out[3]!.role, 'user');
  assert.match(out[3]!.content!, /call_1/);
  assert.match(out[3]!.content!, /hello/);
});

test('END TO END: a model that refuses tools is given them in the prompt; its block runs the real tool through the same loop, and the next run goes prompted at once', async () => {
  const { startFake, replyText, jsonReply } = await import('./providers-fakes.js');
  const { setup, run } = await import('./providers-harness.js');
  const { TaskListStore } = await import('../src/core/task-list.js');
  const { join } = await import('node:path');
  let toolFieldRequests = 0;
  const f = await startFake((req, res) => {
    const body = req.body as any;
    if (body.tools) { toolFieldRequests++; jsonReply(res, 400, { error: { message: 'This model does not support tools' } }); return; }
    const all = JSON.stringify(body.messages);
    if ((body.messages as any[]).some((m) => m.role === 'user' && String(m.content).startsWith(FENCE + 'tool_result'))) { replyText(res, 'done'); return; }
    replyText(res, `Planning.\n${FENCE}tool_call\n{"name": "mcp__legion__todo_create", "arguments": {"subject": "from a prompted model"}}\n${FENCE}`);
  });
  try {
    const h = setup(f, { entry: { baseUrl: f.url + '/v1-prompted-a' } as never });
    const t = await run(h);
    assert.equal(t.status, 'done');
    assert.equal(toolFieldRequests, 1, 'one refused request, then prompted');
    const list = new TaskListStore(join(h.config.workspaceDir, '.task-lists')).load(t.id);
    assert.deepEqual(list.list().map((x) => x.subject), ['from a prompted model'], 'the block ran the real tool');
    const sent = f.requests.filter((r) => !(r.body as any).tools);
    assert.ok(sent.every((r) => !JSON.stringify((r.body as any).messages).includes('"role":"tool"')), 'no role tool reaches a prompted model');
    assert.match(t.result ?? '', /done/);
    assert.ok(h.events.some((e: any) => e.type === 'message' && /describ\w* the tools in the prompt/i.test(e.message?.text ?? '')), 'the owner is told');
    await run(h, 'again', { continueTaskId: t.id });
    assert.equal(toolFieldRequests, 1, 'remembered: the second run does not send the tools field again');
  } finally { await f.close(); }
});

test('OpenRouter\'s "no endpoints support tool use" (404) switches to prompted too', async () => {
  const { startFake, replyText, jsonReply } = await import('./providers-fakes.js');
  const { setup, run } = await import('./providers-harness.js');
  const f = await startFake((req, res) => {
    const body = req.body as any;
    if (body.tools) { jsonReply(res, 404, { error: { message: 'No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing' } }); return; }
    replyText(res, 'plain answer');
  });
  try {
    const h = setup(f, { entry: { baseUrl: f.url + '/v1-prompted-b' } as never });
    const t = await run(h);
    assert.equal(t.status, 'done', t.error);
    assert.ok(f.requests.some((r) => JSON.stringify((r.body as any).messages).includes('TOOLS.')), 'the retry carries the catalogue');
  } finally { await f.close(); }
});

test('OpenRouter metadata: a model whose supported_parameters lack "tools" is prompted from its first request; no metadata means native first', async () => {
  const { startFake, jsonReply } = await import('./providers-fakes.js');
  const { listModelIds, isPrompted } = await import('../src/core/providers/openai-compat.js');
  const f = await startFake((_r, res) => jsonReply(res, 200, { data: [
    { id: 'vendor/with-tools', supported_parameters: ['tools', 'tool_choice', 'temperature'] },
    { id: 'vendor/no-tools', supported_parameters: ['temperature', 'max_tokens'] },
    { id: 'vendor/unknown' },
  ] }));
  try {
    const entry = { kind: 'openai-compat', label: 'OR', baseUrl: f.url + '/or-meta', enabled: true, keyless: true } as never;
    const ids = await listModelIds({ entry });
    assert.deepEqual(ids, ['vendor/with-tools', 'vendor/no-tools', 'vendor/unknown']);
    assert.equal(isPrompted(entry, 'vendor/no-tools'), true);
    assert.equal(isPrompted(entry, 'vendor/with-tools'), false);
    assert.equal(isPrompted(entry, 'vendor/unknown'), false, 'no metadata: try native, the refusal probe decides');
  } finally { await f.close(); }
});

test('owner override per provider: "prompted" never sends the tools field; "native" never falls back to prompted text', async () => {
  const { startFake, replyText, jsonReply } = await import('./providers-fakes.js');
  const { chatTurn } = await import('../src/core/providers/openai-compat.js');
  const { normalizeEntry } = await import('../src/core/providers/config.js');
  const f = await startFake((req, res) => {
    if ((req.body as any).tools) { jsonReply(res, 400, { error: { message: 'tools are not supported' } }); return; }
    replyText(res, 'plain');
  });
  try {
    const tools = [{ type: 'function' as const, function: { name: 'x', description: '', parameters: {} } }];
    const base = { kind: 'openai-compat', label: 'T', enabled: true, keyless: true } as const;
    const p = await chatTurn({ entry: { ...base, baseUrl: f.url + '/ov-p', toolCalls: 'prompted' } as never }, { model: 'm1', messages: [{ role: 'system', content: 's' }], tools, onText: () => undefined });
    assert.equal(p.toolsPrompted, true);
    assert.equal(f.requests.length, 1, 'prompted from the first request: no refused tools field');
    const n = await chatTurn({ entry: { ...base, baseUrl: f.url + '/ov-n', toolCalls: 'native' } as never }, { model: 'm1', messages: [{ role: 'system', content: 's' }], tools, onText: () => undefined });
    assert.equal(n.toolsRefused, true, 'native only: the model answers without tools, as before');
    assert.equal(n.toolsPrompted, undefined);
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)!.body.messages), /TOOLS\./, 'no catalogue in the prompt');
    // the setting is validated like the other entry fields
    const ok = normalizeEntry('t', { baseUrl: f.url, keyless: true, toolCalls: 'prompted' });
    assert.equal('entry' in ok && ok.entry.toolCalls, 'prompted');
    assert.ok('reason' in normalizeEntry('t', { baseUrl: f.url, keyless: true, toolCalls: 'sometimes' }));
  } finally { await f.close(); }
});
