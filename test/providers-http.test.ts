import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRequest, ProviderHttpError, providerRequestsInFlight } from '../src/core/providers/http.js';
import type { ProviderTarget } from '../src/core/providers/http.js';
import { chatTurn, listModelIds } from '../src/core/providers/openai-compat.js';
import { chunk, entryFor, FAKE_KEY, jsonReply, replyText, sseHead, sseSend, startFake } from './providers-fakes.js';

const post = (t: ProviderTarget, opts: Partial<Parameters<typeof providerRequest>[2]> = {}) => providerRequest(t, '/chat/completions', { method: 'POST', body: { model: 'm', messages: [] }, accept: 'any', ...opts });
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'no error'; } catch (e) { return e instanceof ProviderHttpError ? e.code : `other:${String(e)}`; } };

test('C11 the key is sent as Bearer to the bound origin only; a keyless local provider sends no Authorization header', async () => {
  const f = await startFake((_r, res) => jsonReply(res, 200, { ok: true }));
  try {
    await providerRequest({ entry: entryFor(f, { keyless: false }), key: FAKE_KEY, keyOrigin: f.base }, '/models', { method: 'GET', accept: 'json' });
    assert.equal(f.requests[0]!.headers.authorization, `Bearer ${FAKE_KEY}`);
    await providerRequest({ entry: entryFor(f), }, '/models', { method: 'GET', accept: 'json' });
    assert.equal(f.requests[1]!.headers.authorization, undefined);
    // a key saved for another origin is never sent here
    assert.equal(await code(providerRequest({ entry: entryFor(f, { keyless: false }), key: FAKE_KEY, keyOrigin: 'https://other.example' }, '/models', { method: 'GET', accept: 'json' })), 'refused');
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('C7 refused before any network: no key on a keyed provider, a disabled provider, http to a non-local host, a bad path', async () => {
  const f = await startFake((_r, res) => jsonReply(res, 200, {}));
  try {
    assert.equal(await code(post({ entry: entryFor(f, { keyless: false }) })), 'refused', 'no key');
    assert.equal(await code(post({ entry: entryFor(f, { enabled: false }) })), 'refused', 'disabled');
    assert.equal(await code(post({ entry: { ...entryFor(f), baseUrl: 'http://example.com/v1', keyless: false }, key: FAKE_KEY, keyOrigin: 'http://example.com' })), 'refused', 'http remote');
    assert.equal(await code(providerRequest({ entry: entryFor(f) }, '/../etc', { method: 'GET', accept: 'json' })), 'refused', 'path');
    assert.equal(await code(providerRequest({ entry: entryFor(f) }, 'http://evil.example/x', { method: 'GET', accept: 'json' })), 'refused', 'a full URL is not a path');
    // keyless on a literal non-loopback address is not honoured
    assert.equal(await code(post({ entry: { ...entryFor(f), baseUrl: 'https://203.0.113.5/v1', keyless: true } })), 'refused');
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('C8 a redirect is never followed: the second server sees nothing and the key never leaves', async () => {
  const second = await startFake((_r, res) => jsonReply(res, 200, { leaked: true }));
  const first = await startFake((_r, res) => { res.writeHead(307, { Location: `${second.url}/chat/completions` }); res.end(); });
  try {
    const e = await post({ entry: entryFor(first, { keyless: false }), key: FAKE_KEY, keyOrigin: first.base }).catch((x) => x);
    assert.ok(e instanceof ProviderHttpError); assert.equal(e.code, 'redirect'); assert.equal(e.status, 307);
    assert.equal(second.requests.length, 0);
  } finally { await first.close(); await second.close(); }
});

test('C9 timeouts: no answer, a stalled stream and the whole-request limit end in bounded time; cancel aborts', async () => {
  const f = await startFake(async (r, res) => {
    if (r.url.endsWith('/hang')) return; // never answers
    sseHead(res); sseSend(res, chunk({ content: 'a' })); // then stalls
  });
  try {
    const t0 = Date.now();
    assert.equal(await code(providerRequest({ entry: entryFor(f) }, '/hang', { method: 'GET', accept: 'json', limits: { headerMs: 150 } })), 'timeout');
    const r = await post({ entry: entryFor(f) }, { limits: { idleMs: 150 } });
    assert.equal(r.kind, 'sse');
    const got: string[] = [];
    await assert.rejects(async () => { for await (const d of (r as { events: AsyncGenerator<string> }).events) got.push(d); }, (e: unknown) => e instanceof ProviderHttpError && e.code === 'timeout');
    assert.equal(got.length, 1);
    const r2 = await post({ entry: entryFor(f) }, { limits: { totalMs: 200, idleMs: 5000 } });
    await assert.rejects(async () => { for await (const _ of (r2 as { events: AsyncGenerator<string> }).events) { /* wait */ } });
    assert.ok(Date.now() - t0 < 5000, 'bounded');
    const ac = new AbortController();
    const p = providerRequest({ entry: entryFor(f) }, '/hang', { method: 'GET', accept: 'json', signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    assert.equal(await code(p), 'aborted');
    assert.equal(providerRequestsInFlight(), 0, 'every slot was released');
  } finally { await f.close(); }
});

test('C10 size caps: a huge JSON body, a huge stream, one huge line, an oversize request and a long model list all abort cleanly', async () => {
  const f = await startFake((r, res) => {
    if (r.url.endsWith('/big-json')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ x: 'a'.repeat(5000) })); return; }
    if (r.url.endsWith('/big-stream')) { sseHead(res); for (let i = 0; i < 50; i++) sseSend(res, chunk({ content: 'b'.repeat(100) })); res.end(); return; }
    if (r.url.endsWith('/big-line')) { sseHead(res); res.write('data: ' + 'c'.repeat(5000) + '\n\n'); res.end(); return; }
    if (r.url.endsWith('/models')) { jsonReply(res, 200, { data: Array.from({ length: 800 }, (_, i) => ({ id: `model-${i}` })) }); return; }
    jsonReply(res, 200, {});
  });
  try {
    const t = { entry: entryFor(f) };
    assert.equal(await code(providerRequest(t, '/big-json', { method: 'GET', accept: 'json', limits: { maxBodyBytes: 1000 } })), 'too_large');
    const s = await providerRequest(t, '/big-stream', { method: 'GET', accept: 'any', limits: { maxStreamBytes: 1000 } });
    await assert.rejects(async () => { for await (const _ of (s as { events: AsyncGenerator<string> }).events) { /* drain */ } }, (e: unknown) => e instanceof ProviderHttpError && e.code === 'too_large');
    const l = await providerRequest(t, '/big-line', { method: 'GET', accept: 'any', limits: { maxLineBytes: 1000 } });
    await assert.rejects(async () => { for await (const _ of (l as { events: AsyncGenerator<string> }).events) { /* drain */ } }, (e: unknown) => e instanceof ProviderHttpError && e.code === 'too_large');
    assert.equal(await code(providerRequest(t, '/x', { method: 'POST', body: { a: 'z'.repeat(3000) }, accept: 'json', limits: { maxRequestBytes: 1000 } })), 'too_large');
    assert.equal(f.requests.some((r) => r.url === '/v1/x'), false, 'an oversize request is never sent');
    assert.equal((await listModelIds(t)).length, 500, 'a model list is cut at 500 ids');
    assert.equal(providerRequestsInFlight(), 0);
  } finally { await f.close(); }
});

test('only JSON or an event stream is parsed; other content types and non-2xx answers are errors with the provider\'s own message', async () => {
  const f = await startFake((r, res) => {
    if (r.url.endsWith('/html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>'); return; }
    if (r.url.endsWith('/401')) { jsonReply(res, 401, { error: { message: 'Incorrect API key provided: sk-xx' } }); return; }
    if (r.url.endsWith('/bad')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{nope'); return; }
    jsonReply(res, 200, {});
  });
  try {
    const t = { entry: entryFor(f) };
    assert.equal(await code(providerRequest(t, '/html', { method: 'GET', accept: 'json' })), 'format');
    assert.equal(await code(providerRequest(t, '/bad', { method: 'GET', accept: 'json' })), 'format');
    const e = await providerRequest(t, '/401', { method: 'GET', accept: 'json' }).catch((x) => x);
    assert.equal(e.code, 'status'); assert.equal(e.status, 401); assert.match(e.message, /Incorrect API key/);
  } finally { await f.close(); }
});

test('at most four requests are in flight at once', async () => {
  let live = 0; let peak = 0;
  const f = await startFake(async (_r, res) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 60)); live--; jsonReply(res, 200, {}); });
  try {
    await Promise.all(Array.from({ length: 10 }, () => providerRequest({ entry: entryFor(f) }, '/models', { method: 'GET', accept: 'json' })));
    assert.ok(peak <= 4 && peak >= 2, `peak ${peak}`);
    assert.equal(providerRequestsInFlight(), 0);
  } finally { await f.close(); }
});

test('chatTurn: streamed text and usage, tool-call assembly, JSON fallback, stream_options and tools refusals, one 429 retry, [DONE]-less stream', async () => {
  let n = 0;
  const f = await startFake((r, res) => {
    const b = r.body ?? {};
    n++;
    if (r.url.includes('/stream-options/')) { if (b.stream_options) { jsonReply(res, 400, { error: { message: 'Unknown parameter: stream_options' } }); return; } replyText(res, 'ok'); return; }
    if (r.url.includes('/tools/')) { if (b.tools) { jsonReply(res, 400, { error: { message: 'tools is not supported by this model' } }); return; } replyText(res, 'plain'); return; }
    if (r.url.includes('/json/')) { jsonReply(res, 200, { choices: [{ message: { role: 'assistant', content: 'whole body' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }); return; }
    if (r.url.includes('/429/')) { if (n % 2 === 1) { jsonReply(res, 429, { error: { message: 'slow down' } }, { 'Retry-After': '0' }); return; } replyText(res, 'after wait'); return; }
    if (r.url.includes('/nodone/')) { sseHead(res); sseSend(res, chunk({ content: 'cut' })); res.end(); return; }
    replyText(res, 'Hello world', { prompt_tokens: 11, completion_tokens: 5 });
  });
  try {
    const mk = (path: string) => ({ ...entryFor(f), baseUrl: f.url + path });
    const deltas: string[] = [];
    const r = await chatTurn({ entry: mk('') }, { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (d) => deltas.push(d) });
    assert.equal(r.text, 'Hello world'); assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 5 }); assert.equal(deltas.join(''), 'Hello world');
    assert.equal(f.requests[0]!.body.stream_options.include_usage, true);
    assert.equal((await chatTurn({ entry: mk('/stream-options') }, { model: 'm', messages: [], tools: [], onText: () => undefined })).text, 'ok');
    const noTools = await chatTurn({ entry: mk('/tools') }, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'x', description: '', parameters: {} } }], onText: () => undefined });
    assert.equal(noTools.text, 'plain'); assert.equal(noTools.toolsRefused, true);
    const j = await chatTurn({ entry: mk('/json') }, { model: 'm', messages: [], tools: [], onText: () => undefined });
    assert.equal(j.text, 'whole body'); assert.deepEqual(j.usage, { inputTokens: 3, outputTokens: 4 });
    n = 0;
    assert.equal((await chatTurn({ entry: mk('/429') }, { model: 'm', messages: [], tools: [], onText: () => undefined })).text, 'after wait');
    assert.equal((await chatTurn({ entry: mk('/nodone') }, { model: 'm', messages: [], tools: [], onText: () => undefined })).text, 'cut');
  } finally { await f.close(); }
});

test('chatTurn: a mid-stream error object, broken stream JSON, and tool calls with missing ids', async () => {
  const f = await startFake((r, res) => {
    sseHead(res);
    if (r.url.includes('/err/')) { sseSend(res, chunk({ content: 'a' })); sseSend(res, { error: { message: 'upstream exploded' } }); res.end(); return; }
    if (r.url.includes('/junk/')) { sseSend(res, '{not json'); res.end(); return; }
    sseSend(res, chunk({ tool_calls: [{ index: 0, type: 'function', function: { name: 'one', arguments: '{}' } }, { index: 1, type: 'function', function: { name: 'two', arguments: '{}' } }] }));
    sseSend(res, '[DONE]'); res.end();
  });
  try {
    const mk = (path: string) => ({ ...entryFor(f), baseUrl: f.url + path });
    const run = (p: string) => chatTurn({ entry: mk(p) }, { model: 'm', messages: [], tools: [], onText: () => undefined });
    await assert.rejects(run('/err'), /upstream exploded/);
    await assert.rejects(run('/junk'), /could not read/);
    const r = await run('/ids');
    assert.deepEqual(r.toolCalls.map((c) => c.id), ['call_1', 'call_2']);
  } finally { await f.close(); }
});
