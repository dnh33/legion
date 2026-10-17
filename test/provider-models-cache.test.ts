import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRuntime } from '../src/core/providers/runtime.js';

// A local provider that lists its models on GET /v1/models. Each request is counted; `mode` decides the answer.
async function fakeProvider(ids: string[]) {
  const seen: string[] = [];
  const state = { mode: 'ok' as 'ok' | 'fail' };
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    if (state.mode === 'fail') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { seen, state, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const noKeys = { has: () => false, get: () => undefined, hint: () => '', all: () => [], status: () => ({ mode: 'plain', locked: false, reason: 'headless' }) } as any;
const entry = (baseUrl: string, over: Record<string, unknown> = {}) => ({
  kind: 'openai-compat', label: 'Local box', baseUrl, enabled: true, keyless: true, allowPrivateNetwork: true, models: ['configured-a'], ...over,
});
const runtimeFor = (entries: Record<string, unknown>, cacheFile: string) =>
  new ProviderRuntime({ config: { providers: { entries, maxTurns: 10, maxToolCallsPerTurn: 10 } as any }, keys: noKeys, cacheFile });
const modelsOf = (rt: ProviderRuntime, id: string) => rt.view().providers.find((p) => p.id === id)!;

test('the first picker open fetches an enabled provider list once; the configured models stay listed', async () => {
  const p = await fakeProvider(['vendor-x/model-1', 'vendor-x/model-2']);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'legion-pm-'));
    const rt = runtimeFor({ local: entry(p.baseUrl) }, join(dir, 'provider-models.json'));
    await rt.ensureModels();
    assert.equal(p.seen.filter((u) => u === '/v1/models').length, 1);
    const v = modelsOf(rt, 'local');
    assert.deepEqual(v.configuredModels, ['configured-a']);
    assert.deepEqual(v.models.sort(), ['configured-a', 'vendor-x/model-1', 'vendor-x/model-2']);
    assert.ok(v.modelsFetchedAt, 'the view says when the list was fetched');
    assert.equal(v.modelsError, undefined);
  } finally { await p.close(); }
});

test('within a day the cached list is used: no second request, and a new runtime reads the saved file without one', async () => {
  const p = await fakeProvider(['vendor-x/model-1']);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'legion-pm-'));
    const file = join(dir, 'provider-models.json');
    await runtimeFor({ local: entry(p.baseUrl) }, file).ensureModels();
    await runtimeFor({ local: entry(p.baseUrl) }, file).ensureModels();
    assert.equal(p.seen.filter((u) => u === '/v1/models').length, 1, 'one request across two runtimes');
    const again = runtimeFor({ local: entry(p.baseUrl) }, file);
    assert.ok(modelsOf(again, 'local').models.includes('vendor-x/model-1'), 'the saved ids are listed before any request');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers.local.ids.length, 1);
  } finally { await p.close(); }
});

test('a list older than a day is fetched again on the next open', async () => {
  const p = await fakeProvider(['vendor-x/fresh']);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'legion-pm-'));
    const file = join(dir, 'provider-models.json');
    writeFileSync(file, JSON.stringify({ providers: { local: { at: new Date(Date.now() - 25 * 3600_000).toISOString(), ids: ['vendor-x/old'] } } }));
    const rt = runtimeFor({ local: entry(p.baseUrl) }, file);
    await rt.ensureModels();
    assert.equal(p.seen.filter((u) => u === '/v1/models').length, 1);
    assert.ok(modelsOf(rt, 'local').models.includes('vendor-x/fresh'));
  } finally { await p.close(); }
});

test('a failed background fetch does not throw: the saved and configured models stay, with one quiet error line', async () => {
  const p = await fakeProvider([]);
  p.state.mode = 'fail';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'legion-pm-'));
    const file = join(dir, 'provider-models.json');
    writeFileSync(file, JSON.stringify({ providers: { local: { at: new Date(Date.now() - 48 * 3600_000).toISOString(), ids: ['vendor-x/saved'] } } }));
    const rt = runtimeFor({ local: entry(p.baseUrl) }, file);
    await rt.ensureModels();
    const v = modelsOf(rt, 'local');
    assert.ok(v.models.includes('vendor-x/saved') && v.models.includes('configured-a'));
    assert.ok(v.modelsError && v.modelsError.length > 0, 'the picker can say the refresh failed');
  } finally { await p.close(); }
});

test('a disabled provider, and a keyed provider with no key, are never fetched', async () => {
  const p = await fakeProvider(['vendor-x/never']);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'legion-pm-'));
    const rt = runtimeFor({
      off: entry(p.baseUrl, { enabled: false }),
      keyed: entry(p.baseUrl, { keyless: false }),
    }, join(dir, 'provider-models.json'));
    await rt.ensureModels();
    assert.equal(p.seen.length, 0, 'no request at all');
  } finally { await p.close(); }
});

test('Refresh models still forces a fetch, even within the day', async () => {
  const p = await fakeProvider(['vendor-x/one']);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'legion-pm-'));
    const rt = runtimeFor({ local: entry(p.baseUrl) }, join(dir, 'provider-models.json'));
    await rt.ensureModels();
    await rt.refreshModels('local');
    assert.equal(p.seen.filter((u) => u === '/v1/models').length, 2);
  } finally { await p.close(); }
});
