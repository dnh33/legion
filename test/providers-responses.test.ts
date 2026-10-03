import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviders } from '../src/core/providers/config.js';
import { toResponsesInput, chatTurn } from '../src/core/providers/openai-compat.js';
import { entryFor, jsonReply, rsText, rsTools, sseHead, sseSend, startFake } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';

test('wire: config accepts chat and responses, refuses anything else', () => {
  const n = normalizeProviders({ entries: { aa: { baseUrl: 'https://x.example/v1', wire: 'responses' }, bb: { baseUrl: 'https://x.example/v1', wire: 'chat' }, cc: { baseUrl: 'https://x.example/v1', wire: 'soap' } } });
  assert.equal(n.entries.aa!.wire, 'responses'); assert.equal(n.entries.bb!.wire, undefined); assert.equal(n.entries.cc, undefined);
  assert.match((n.dropped ?? []).join(), /wire must be chat or responses/);
});

test('toResponsesInput: system becomes instructions; tool calls and results become typed items', () => {
  const r = toResponsesInput([
    { role: 'system', content: 'S' }, { role: 'user', content: 'u' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', content: 'out', tool_call_id: 'c1' }, { role: 'assistant', content: 'done' },
  ]);
  assert.equal(r.instructions, 'S');
  assert.deepEqual(r.input, [{ role: 'user', content: 'u' }, { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'out' }, { role: 'assistant', content: 'done' }]);
});

test('a Responses run: /responses is called, tools are flat, store is false, text and usage come back, and a tool round trip works', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) rsTools(res, [{ call_id: 'k1', name: 'mcp__legion__agents', args: {} }], { input_tokens: 5, output_tokens: 2 }); else rsText(res, 'all done', { input_tokens: 9, output_tokens: 4 }); });
  try {
    const h = setup(f, { entry: { wire: 'responses' } });
    const t = await run(h);
    assert.equal(t.status, 'done'); assert.equal(t.result, 'all done');
    assert.deepEqual(t.tokenUsage, { inputTokens: 14, outputTokens: 6 });
    assert.equal(f.requests[0]!.url, '/v1/responses');
    const b = f.requests[0]!.body;
    assert.equal(b.store, false); assert.equal(b.stream, true); assert.match(b.instructions, /agent inside Legion/);
    assert.equal(b.tools[0].type, 'function'); assert.equal(b.tools[0].name, 'mcp__legion__agents'); assert.equal(b.tools[0].function, undefined);
    assert.equal(b.messages, undefined);
    const items = f.requests[1]!.body.input as any[];
    assert.deepEqual(items.map((i) => i.type ?? i.role), ['user', 'function_call', 'function_call_output']);
    assert.equal(items[1].call_id, 'k1'); assert.equal(items[2].call_id, 'k1'); assert.match(items[2].output, /./);
    assert.equal(h.claudeCalls.length, 0);
  } finally { await f.close(); }
});

test('Responses errors and fallbacks: a failed event, an error event, a one-body answer, an incomplete answer', async () => {
  const f = await startFake((r, res) => {
    if (r.url.includes('/failed/')) { sseHead(res); sseSend(res, { type: 'response.failed', response: { error: { message: 'model not available' } } }); res.end(); return; }
    if (r.url.includes('/err/')) { sseHead(res); sseSend(res, { type: 'error', message: 'rate cap hit' }); res.end(); return; }
    if (r.url.includes('/body/')) { jsonReply(res, 200, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'whole' }] }, { type: 'function_call', call_id: 'z', name: 'g', arguments: '{"a":1}' }], usage: { input_tokens: 1, output_tokens: 2 } }); return; }
    sseHead(res); sseSend(res, { type: 'response.output_text.delta', delta: 'cut' }); sseSend(res, { type: 'response.incomplete', response: {} }); res.end();
  });
  try {
    const go = (p: string) => chatTurn({ entry: entryFor(f, { wire: 'responses', baseUrl: f.url + p }) }, { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [], onText: () => undefined });
    await assert.rejects(go('/failed'), /model not available/);
    await assert.rejects(go('/err'), /rate cap hit/);
    const b = await go('/body');
    assert.equal(b.text, 'whole'); assert.equal(b.toolCalls[0]!.function.arguments, '{"a":1}'); assert.deepEqual(b.usage, { inputTokens: 1, outputTokens: 2 });
    assert.equal((await go('/inc')).finishReason, 'length');
  } finally { await f.close(); }
});
