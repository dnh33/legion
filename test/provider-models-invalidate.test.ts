import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { createProvidersModule } from '../src/core/providers/routes.js';
import { NATIVE_HEADER } from '../src/core/admin.js';

async function fakeProvider(ids: string[]) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const entry = (baseUrl: string, over: Record<string, unknown> = {}) => ({
  kind: 'openai-compat', label: 'Local box', baseUrl, enabled: true, keyless: true, allowPrivateNetwork: true, models: [], ...over,
});
const keysWith = (has: boolean) => {
  const keys: any = {
    has: () => has, get: () => (has ? 'sk-test' : undefined), hint: () => 'sk-…', all: () => [],
    status: () => ({ mode: 'plain', locked: false, reason: 'headless' }), set: () => undefined, remove: () => undefined, dropIfOriginDiffers: () => undefined,
  };
  return keys;
};
const dirFile = () => { const d = mkdtempSync(join(tmpdir(), 'legion-pm-inv-')); return { dir: d, file: join(d, 'provider-models.json') }; };
const runtimeFor = (entries: Record<string, unknown>, file: string, keys = keysWith(false)) =>
  new ProviderRuntime({ config: { providers: { entries, maxTurns: 10, maxToolCallsPerTurn: 10 } as any }, keys, cacheFile: file });
const idsOf = (rt: ProviderRuntime, id: string) => rt.view().providers.find((p) => p.id === id)!.models;

/** The providers module's routes, by "METHOD /path". */
function routesFor(rt: ProviderRuntime, configPath: string) {
  const map = new Map<string, (c: any) => unknown>();
  const mod = createProvidersModule({ runtime: rt, configPath, nativeSecret: 'native-secret' });
  mod.routes!((method, path, handler) => { map.set(`${method} ${path}`, handler as any); });

  return (key: string, c: any) => { const h = map.get(key); if (!h) throw new Error(`no route ${key}`); return h(c); };
}
const native = { headers: { [NATIVE_HEADER]: 'native-secret' } };

test('changing a provider address drops its saved list: the old host ids are not shown and not kept on disk', async () => {
  const a = await fakeProvider(['old-host/model']);
  const b = await fakeProvider(['new-host/model']);
  try {
    const { dir, file } = dirFile();
    const configPath = join(dir, 'config.json');
    const rt = runtimeFor({ local: entry(a.baseUrl) }, file);
    await rt.refreshModels('local');
    assert.ok(idsOf(rt, 'local').includes('old-host/model'));
    routesFor(rt, configPath)('PUT /api/providers/:id', { req: native, params: ['local'], body: { baseUrl: b.baseUrl } });
    assert.equal(idsOf(rt, 'local').includes('old-host/model'), false, 'the old list is gone from the view');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers.local, undefined, 'and from the saved file');
    rmSync(dir, { recursive: true, force: true });
  } finally { await a.close(); await b.close(); }
});

test('saving a new key drops the saved list, and removing a key does too', async () => {
  const a = await fakeProvider(['keyed/model']);
  try {
    const { dir, file } = dirFile();
    const configPath = join(dir, 'config.json');
    const keys = keysWith(true);
    const rt = runtimeFor({ local: entry(a.baseUrl, { keyless: false }) }, file, keys);
    await rt.refreshModels('local');
    const route = routesFor(rt, configPath);
    route('PUT /api/providers/:id/key', { req: native, params: ['local'], body: { key: 'sk-new-key-value' } });
    assert.equal(idsOf(rt, 'local').includes('keyed/model'), false, 'key saved: list dropped');
    await rt.refreshModels('local');
    route('DELETE /api/providers/:id/key', { params: ['local'] });
    assert.equal(idsOf(rt, 'local').includes('keyed/model'), false, 'key removed: list dropped');
    rmSync(dir, { recursive: true, force: true });
  } finally { await a.close(); }
});

test('an in-flight fetch that started before an address change does not put the old list back', async () => {
  const a = await fakeProvider(['late/model']);
  try {
    const { dir, file } = dirFile();
    const rt = runtimeFor({ local: entry(a.baseUrl) }, file);
    const pending = rt.refreshModels('local').catch(() => undefined);
    rt.forgetModels('local');
    await pending;
    assert.equal(idsOf(rt, 'local').includes('late/model'), false);
    rmSync(dir, { recursive: true, force: true });
  } finally { await a.close(); }
});

test('the saved file is written through a temp file: a failed write leaves the last good file, and no temp file is left behind', async () => {
  const a = await fakeProvider(['first/model']);
  try {
    const { dir, file } = dirFile();
    const rt = runtimeFor({ local: entry(a.baseUrl) }, file);
    await rt.refreshModels('local');
    assert.equal(existsSync(`${file}.tmp`), false, 'the temp file is renamed onto the real one');
    const good = readFileSync(file, 'utf8');
    assert.ok(JSON.parse(good).providers.local.ids.includes('first/model'));

    // A directory where the temp file must go makes the write fail; the saved file must stay as it was.
    mkdirSync(`${file}.tmp`);
    const b = await fakeProvider(['second/model']);
    try {
      const rt2 = runtimeFor({ local: entry(b.baseUrl) }, file);
      await rt2.refreshModels('local');
      assert.equal(readFileSync(file, 'utf8'), good, 'the last good file is untouched');
    } finally { await b.close(); }
    rmSync(dir, { recursive: true, force: true });
  } finally { await a.close(); }
});
