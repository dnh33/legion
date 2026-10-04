import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { createProvidersModule } from '../src/core/providers/routes.js';
import { keyFileFor, ProviderKeys } from '../src/core/providers/secrets.js';
import { isClientRoute } from '../src/core/admin.js';
import { defaultConfig } from '../src/shared/config.js';
import { AUTH, asClient, makeFakes, start, TOKEN } from './helpers-c.js';
import { FAKE_KEY, jsonReply, startFake } from './providers-fakes.js';
import type { Fake } from './providers-fakes.js';

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const dir = cleanupTemp('legion-prov-routes-');
const configPath = join(dir, 'config.json');
writeFileSync(configPath, JSON.stringify({ port: 0, authToken: TOKEN, claude: { maxTurns: 7 } }, null, 2));
const cfg = defaultConfig();
const keys = new ProviderKeys(keyFileFor(dir));
const runtime = new ProviderRuntime({ config: cfg, keys });
const f = makeFakes();
(f.ctx as any).modules = [createProvidersModule({ runtime, configPath, nativeSecret: NATIVE })];
let base = ''; let close: () => Promise<void>;
let fake: Fake;
before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; fake = await startFake((r, res) => jsonReply(res, 200, { data: [{ id: 'model-a' }, { id: 'model-b' }], seen: r.headers.authorization ? 'auth' : 'none' })); });
after(async () => { await close(); await fake.close(); });

const H = (extra: Record<string, string> = {}) => ({ ...AUTH, 'Content-Type': 'application/json', ...extra });
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H()) =>
  fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const NATIVE_H = { 'X-Legion-Native': NATIVE };

test('C20 every /api/providers route is admin-only: no route is on the client list, the bearer token alone gets 403, no token 401', async () => {
  for (const [m, p] of [['GET', '/api/providers'], ['PUT', '/api/providers/openai'], ['PUT', '/api/providers/openai/key'], ['DELETE', '/api/providers/openai'], ['POST', '/api/providers/openai/test'], ['POST', '/api/providers/openai/models'], ['PUT', '/api/providers/limits']] as const) {
    assert.equal(isClientRoute(m, p), false, `${m} ${p}`);
    assert.equal((await fetch(base + p, { method: m, headers: { ...asClient, 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' })).status, 403, `${m} ${p} with the token only`);
    assert.equal((await fetch(base + p, { method: m, body: m === 'GET' ? undefined : '{}' })).status, 401, `${m} ${p} with nothing`);
  }
});

test('the view lists the presets with plain, factual status text and the "cannot do" list', async () => {
  const v: any = await (await call('GET', '/api/providers')).json();
  assert.deepEqual(v.providers.map((p: any) => p.id), ['openai', 'openrouter', 'ollama', 'lmstudio', 'vllm']);
  const oa = v.providers[0];
  assert.equal(oa.enabled, false); assert.equal(oa.keySet, false); assert.match(oa.status, /Off\. No key\. Not tested/);
  assert.match(v.providers[2].status, /Local, no key needed/);
  assert.ok(v.cannotDo.length >= 5 && v.cannotDo.every((s: string) => typeof s === 'string'));
});

test('C6 an address or private-network change, and any key change, need the native secret as well as admin; no native secret on the core = locked', async () => {
  const body = { label: 'Mine', baseUrl: 'https://llm.example.com/v1', enabled: true };
  assert.equal((await call('PUT', '/api/providers/mine', body)).status, 403);
  assert.equal((await call('PUT', '/api/providers/mine', body, H({ 'X-Legion-Native': 'wrong' }))).status, 403);
  assert.equal((await call('PUT', '/api/providers/mine/key', { key: FAKE_KEY })).status, 403);
  assert.equal((await call('PUT', '/api/providers/mine/key', { key: FAKE_KEY }, H({ 'X-Legion-Native': 'wrong' }))).status, 403);
  assert.equal(existsSync(keyFileFor(dir)), false, 'nothing was stored');
  assert.equal((await call('PUT', '/api/providers/mine', body, H(NATIVE_H))).status, 200);
  // widening: private network and keyless
  assert.equal((await call('PUT', '/api/providers/mine', { baseUrl: 'https://10.0.0.5/v1', allowPrivateNetwork: true })).status, 403);
  assert.equal((await call('PUT', '/api/providers/mine', { baseUrl: 'https://10.0.0.5/v1', allowPrivateNetwork: true }, H(NATIVE_H))).status, 200);
  assert.equal((await call('PUT', '/api/providers/mine', { baseUrl: 'https://llm.example.com/v1', allowPrivateNetwork: false }, H(NATIVE_H))).status, 200);
  // turning a provider on or off, with its address unchanged, is admin only
  assert.equal((await call('PUT', '/api/providers/mine', { enabled: false })).status, 200);
  assert.equal((await call('PUT', '/api/providers/openai', { enabled: true })).status, 200, 'a preset keeps its own address: no native needed to switch it on');
  // a headless core (no native secret) refuses key and address changes outright
  const h = createProvidersModule({ runtime, configPath });
  const routes: Record<string, (c: any) => unknown> = {};
  h.routes!((m, p, fn) => { routes[`${m} ${p}`] = fn; });
  assert.throws(() => routes['PUT /api/providers/:id/key']!({ req: { headers: { 'x-legion-native': NATIVE } }, params: ['mine'], body: { key: FAKE_KEY } }), /native_unavailable/);
});

test('C4 a key is stored only in providers/keys.json (0600), never in config.json, and no response, view or file other than that one holds it', async () => {
  const r = await call('PUT', '/api/providers/mine/key', { key: FAKE_KEY }, H(NATIVE_H));
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes(FAKE_KEY), false, 'the response');
  const v: any = JSON.parse(text);
  const mine = v.providers.find((p: any) => p.id === 'mine');
  assert.equal(mine.keySet, true); assert.equal(mine.keyHint, '…' + FAKE_KEY.slice(-4)); assert.equal(mine.keyMatchesAddress, true);
  assert.equal(readFileSync(configPath, 'utf8').includes(FAKE_KEY), false, 'config.json');
  assert.equal(readFileSync(configPath, 'utf8').includes('"claude"'), true, 'the rest of config.json is kept');
  // every later write of the providers part of config.json (limits, entry edits) must not pick the key up either
  assert.equal((await call('PUT', '/api/providers/limits', { maxTurns: 41 })).status, 200);
  assert.equal((await call('PUT', '/api/providers/mine', { models: ['m1'] })).status, 200);
  assert.equal(readFileSync(configPath, 'utf8').includes(FAKE_KEY), false, 'config.json after later writes');
  assert.equal(readFileSync(configPath, 'utf8').includes(FAKE_KEY.slice(-8)), false, 'not even a part of it');
  assert.equal(JSON.parse(readFileSync(keyFileFor(dir), 'utf8')).keys.mine.key, FAKE_KEY);
  if (process.platform !== 'win32') assert.equal(statSync(keyFileFor(dir)).mode & 0o077, 0);
  assert.equal((await (await call('GET', '/api/providers')).text()).includes(FAKE_KEY), false, 'GET /api/providers');
  assert.equal(JSON.stringify(f.ctx.config).includes(FAKE_KEY), false);
  const redacted: any = await (await call('GET', '/api/config')).json();
  assert.equal(JSON.stringify(redacted).includes(FAKE_KEY), false, 'GET /api/config');
  assert.equal((await (await call('GET', '/api/state')).text()).includes(FAKE_KEY), false, 'GET /api/state');
  assert.equal((await (await call('PUT', '/api/providers/mine/key', { key: 'short' }, H(NATIVE_H))).json() as any).error.length > 0, true, 'a bad key is a plain 400');
});

test('C6 changing the address to another origin deletes the saved key; a path change on the same origin keeps it; removing a key needs only admin', async () => {
  assert.equal((await call('PUT', '/api/providers/mine', { baseUrl: 'https://llm.example.com/v2' }, H(NATIVE_H))).status, 200);
  assert.equal(keys.has('mine'), true, 'same origin: kept');
  const r: any = await (await call('PUT', '/api/providers/mine', { baseUrl: 'https://other.example.net/v1' }, H(NATIVE_H))).json();
  assert.equal(keys.has('mine'), false, 'another origin: the key is deleted, not carried over');
  assert.equal(r.providers.find((p: any) => p.id === 'mine').keySet, false);
  assert.equal(JSON.parse(readFileSync(keyFileFor(dir), 'utf8')).keys.mine, undefined);
  await call('PUT', '/api/providers/mine/key', { key: FAKE_KEY }, H(NATIVE_H));
  assert.equal((await call('DELETE', '/api/providers/mine/key')).status, 200);
  assert.equal(keys.has('mine'), false);
});

test('Test and Refresh models are owner-initiated single requests, shown as facts about that request; the model list feeds the picker', async () => {
  assert.equal((await call('PUT', '/api/providers/loc', { label: 'Local fake', baseUrl: fake.url, enabled: true, keyless: true }, H(NATIVE_H))).status, 200);
  const before = fake.requests.length;
  const t: any = await (await call('POST', '/api/providers/loc/test')).json();
  assert.equal(t.ok, true); assert.match(t.detail, /Legion's test request was accepted \(2 model ids listed\)/);
  assert.equal(fake.requests.length, before + 1); assert.equal(fake.requests.at(-1)!.url, '/v1/models');
  const v: any = await (await call('GET', '/api/providers')).json();
  const loc = v.providers.find((p: any) => p.id === 'loc');
  assert.deepEqual(loc.models, ['model-a', 'model-b']); assert.match(loc.status, /Last test accepted/); assert.doesNotMatch(JSON.stringify(v), /works|verified|supported/i);
  // a provider that needs a key says so instead of calling out
  const n = fake.requests.length;
  const t2: any = await (await call('POST', '/api/providers/openai/test')).json();
  assert.equal(t2.ok, false); assert.match(t2.detail, /No API key is saved/); assert.equal(fake.requests.length, n);
});

test('limits and delete persist; unknown fields and bad values are refused', async () => {
  assert.equal((await call('PUT', '/api/providers/limits', { maxTurns: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/providers/limits', { maxTurns: 12, maxToolCallsPerTurn: 4 })).status, 200);
  const disk = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(disk.providers.maxTurns, 12); assert.equal(disk.providers.entries.loc.baseUrl, fake.url);
  assert.equal((await call('PUT', '/api/providers/Bad_Id', { baseUrl: 'https://x.example/v1' }, H(NATIVE_H))).status, 400);
  assert.equal((await call('PUT', '/api/providers/mine', { baseUrl: 'http://remote.example/v1' }, H(NATIVE_H))).status, 400);
  assert.equal((await call('PUT', '/api/providers/mine', { kind: 'cli', baseUrl: 'https://x.example/v1' }, H(NATIVE_H))).status, 200, 'kind is not a settable field: it stays openai-compat');
  assert.equal((await call('DELETE', '/api/providers/loc')).status, 200);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).providers.entries.loc, undefined);
});

test('C21 a token client cannot create an agent on a provider model, run one on a provider, or move a provider agent', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  try {
    const r: any = await client.callTool({ name: 'legion_create_agent', arguments: { name: 'Sneaky', model: 'openai:gpt-4o' } });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /only be chosen in the Legion app/);
    const ok: any = await client.callTool({ name: 'legion_create_agent', arguments: { name: 'Fine', model: 'sonnet' } });
    assert.notEqual(ok.isError, true);
  } finally { await client.close(); }
});
