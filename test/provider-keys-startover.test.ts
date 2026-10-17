import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerChange, parseProviderChange } from '../src/electron/provider-ipc.js';
import type { ProviderIpcDeps } from '../src/electron/provider-ipc.js';
import { webSearchChange } from '../src/electron/web-search-ipc.js';
import type { WebSearchIpcDeps } from '../src/electron/web-search-ipc.js';
import { ensureProviderKey, providerKeyFilePath, setAsideProviderKey, type SafeStorageLike } from '../src/electron/connector-key.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { createProvidersModule } from '../src/core/providers/routes.js';
import { isClientRoute } from '../src/core/admin.js';
import { keyFileFor, ProviderKeys, sealedFileFor } from '../src/core/providers/secrets.js';
import { defaultConfig } from '../src/shared/config.js';
import { AUTH, makeFakes, start, TOKEN } from './helpers-c.js';
import { FAKE_KEY } from './providers-fakes.js';
import { webSearchRoutes } from './web-search-rig.js';
import { repoRoot } from './ps-helpers.js';
import { tempDir } from './tmp-cleanup.js';

const REFUSED = 'Your system key store did not unlock, so Legion cannot save keys safely right now. Restart Legion. If it keeps happening, start over with new keys in Settings.';
const BLOCKED_VIEW = { providers: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }], keyStoreState: 'blocked' };
const OK_VIEW = { providers: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }], keyStoreState: 'encrypted' };

function rig(views: Array<Record<string, unknown>>, over: { confirm?: boolean; startStatus?: number; restartError?: string | null; noStartOver?: boolean } = {}) {
  const log: string[] = [];
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  let gets = 0;
  const d: ProviderIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, body, native }); log.push(`${method} ${route}`);
      if (method === 'GET') return { status: 200, json: views[Math.min(gets++, views.length - 1)] };
      if (route === '/api/providers/keys/start-over') return { status: over.startStatus ?? 200, json: over.startStatus && over.startStatus !== 200 ? { error: 'refused by core' } : { ok: true } };
      return { status: 200, json: { ok: true } };
    },
    async confirm(o) { dialogs.push(o); log.push('confirm'); return over.confirm !== false; },
    ...(over.noStartOver ? {} : { startOver: { async setAsideKey() { log.push('setAsideKey'); }, async restartCore() { log.push('restartCore'); return over.restartError ?? null; } } }),
  };
  return { d, calls, dialogs, log };
}

// ------------------------------------------------------------------------------------------------ start over (main side)

test('R2 the window may ask to start over with a bare request; nothing else in it is read', () => {
  assert.deepEqual(parseProviderChange({ kind: 'start-over' }), { kind: 'start-over' });
  assert.deepEqual(parseProviderChange({ kind: 'start-over', id: 'x', path: '/etc' }), { kind: 'start-over' });
  assert.equal(parseProviderChange({ kind: 'start-over-now' }), undefined);
});

test('R2 start over: the core is asked first, then key.bin is set aside by main, then the core restarts; the dialog says renamed, not deleted, and restart', async () => {
  const { d, log, dialogs, calls } = rig([BLOCKED_VIEW, OK_VIEW]);
  const r = await providerChange({ kind: 'start-over' }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['GET /api/providers', 'confirm', 'POST /api/providers/keys/start-over', 'setAsideKey', 'restartCore', 'GET /api/providers']);
  assert.equal(calls.find((c) => c.method === 'POST')!.native, true, 'the core gets the native secret, only after Confirm');
  const t = `${dialogs[0]!.title} ${dialogs[0]!.message} ${dialogs[0]!.detail}`;
  assert.match(t, /start over/i); assert.match(t, /set aside|renamed/i); assert.match(t, /not deleted/i); assert.match(t, /restart/i); assert.match(t, /paste/i);
  assert.doesNotMatch(t, /[—–]/);
  assert.equal(dialogs[0]!.confirmLabel, 'Start over');
});

test('R2 start over is refused while the keys are not locked out: no dialog, nothing touched', async () => {
  const { d, log } = rig([OK_VIEW]);
  const r = await providerChange({ kind: 'start-over' }, d);
  assert.equal(r.ok, false);
  assert.match(r.error!, /nothing to start over/i);
  assert.deepEqual(log, ['GET /api/providers']);
});

test('R2 Cancel changes nothing', async () => {
  const { d, log } = rig([BLOCKED_VIEW], { confirm: false });
  const r = await providerChange({ kind: 'start-over' }, d);
  assert.equal(r.cancelled, true);
  assert.deepEqual(log, ['GET /api/providers', 'confirm']);
});

test('R2 when the core refuses, key.bin is not touched and the core is not restarted', async () => {
  const { d, log } = rig([BLOCKED_VIEW], { startStatus: 409 });
  const r = await providerChange({ kind: 'start-over' }, d);
  assert.equal(r.ok, false);
  assert.equal(log.includes('setAsideKey'), false);
  assert.equal(log.includes('restartCore'), false);
});

test('R2 a failed restart is reported; a core that comes back still locked out is reported too', async () => {
  const a = await providerChange({ kind: 'start-over' }, rig([BLOCKED_VIEW], { restartError: 'Core did not become ready' }).d);
  assert.equal(a.ok, false); assert.match(a.error!, /Core did not become ready/);
  const b = await providerChange({ kind: 'start-over' }, rig([BLOCKED_VIEW, BLOCKED_VIEW]).d);
  assert.equal(b.ok, false); assert.match(b.error!, /still/i);
});

test('R2 without the app hooks (no startOver deps) the request is refused', async () => {
  const r = await providerChange({ kind: 'start-over' }, rig([BLOCKED_VIEW], { noStartOver: true }).d);
  assert.equal(r.ok, false);
});

test('R2 saving a key while the key store is locked out is refused before any dialog, with the plain words (Providers and Web search)', async () => {
  const p = rig([BLOCKED_VIEW]);
  const r = await providerChange({ kind: 'key', id: 'openai', key: FAKE_KEY }, p.d);
  assert.deepEqual([r.ok, r.error], [false, REFUSED]);
  assert.deepEqual(p.log, ['GET /api/providers']);
  const calls: string[] = []; let dialogs = 0;
  const wd: WebSearchIpcDeps = {
    async call(method, route) { calls.push(`${method} ${route}`); return { status: 200, json: { providers: [{ id: 'exa', label: 'Exa' }], keyStoreState: 'blocked' } }; },
    async confirm() { dialogs++; return true; },
  };
  const w = await webSearchChange({ kind: 'key', provider: 'exa', key: 'k_test_12345' }, wd);
  assert.deepEqual([w.ok, w.error], [false, REFUSED]);
  assert.deepEqual(calls, ['GET /api/settings/web-search']);
  assert.equal(dialogs, 0);
});

// ------------------------------------------------------------------------------------------------ R4: the dialog says "encrypted" only when the core says so

test('R4 the key dialog says the key is encrypted with the system key store when the core reports encrypted; otherwise the wording is unchanged', async () => {
  const enc = rig([OK_VIEW]);
  await providerChange({ kind: 'key', id: 'openai', key: FAKE_KEY }, enc.d);
  assert.match(enc.dialogs[0]!.detail, /encrypted with your system key store/);
  assert.equal(JSON.stringify(enc.dialogs).includes(FAKE_KEY), false);
  const plain = rig([{ providers: OK_VIEW.providers, keyStoreState: 'plain' }]);
  await providerChange({ kind: 'key', id: 'openai', key: FAKE_KEY }, plain.d);
  assert.match(plain.dialogs[0]!.detail, /stored in its own file in your Legion data folder/);
  assert.doesNotMatch(plain.dialogs[0]!.detail, /encrypted/);
  const none = rig([{ providers: OK_VIEW.providers }]);
  await providerChange({ kind: 'key', id: 'openai', key: FAKE_KEY }, none.d);
  assert.doesNotMatch(none.dialogs[0]!.detail, /encrypted/, 'an older core: unchanged');
  const dialogs: Array<{ detail: string }> = [];
  const wd: WebSearchIpcDeps = {
    async call(method) { return method === 'GET' ? { status: 200, json: { providers: [{ id: 'exa', label: 'Exa' }], keyStoreState: 'encrypted' } } : { status: 200, json: {} }; },
    async confirm(o) { dialogs.push(o); return true; },
  };
  await webSearchChange({ kind: 'key', provider: 'exa', key: 'k_test_12345' }, wd);
  assert.match(dialogs[0]!.detail, /encrypted with your system key store/);
});

// ------------------------------------------------------------------------------------------------ main: key.bin is set aside, never deleted

function fakeStorage(): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (p) => Buffer.from('WRAP:' + Buffer.from(p).toString('hex')),
    decryptStringAsync: async (b) => { const t = b.toString(); if (!t.startsWith('WRAP:')) throw new Error('bad'); return { result: Buffer.from(t.slice(5), 'hex').toString(), shouldReEncrypt: false }; },
  };
}

test('R2 setAsideProviderKey: an unreadable key.bin is renamed (never deleted); one that unwraps or is absent is left alone; a new key follows', async () => {
  const dir = tempDir('legion-pkey-aside-');
  const ss = fakeStorage();
  assert.equal(await setAsideProviderKey(dir, ss, 'win32'), 'none');
  const hex = await ensureProviderKey(dir, ss, 'win32');
  const wrapped = readFileSync(providerKeyFilePath(dir));
  assert.equal(await setAsideProviderKey(dir, ss, 'win32'), 'kept', 'a key that unwraps is never touched');
  assert.deepEqual(readFileSync(providerKeyFilePath(dir)), wrapped);
  writeFileSync(providerKeyFilePath(dir), 'garbage');
  assert.equal(await setAsideProviderKey(dir, ss, 'win32'), 'set-aside');
  assert.equal(existsSync(providerKeyFilePath(dir)), false);
  const names = readdirSync(join(dir, 'providers')).filter((n) => n.startsWith('key.bin.unreadable-'));
  assert.equal(names.length, 1);
  assert.match(names[0]!, /^key\.bin\.unreadable-\d{4}-\d{2}-\d{2}$/);
  assert.equal(readFileSync(join(dir, 'providers', names[0]!), 'utf8'), 'garbage');
  const fresh = await ensureProviderKey(dir, ss, 'win32');
  assert.match(fresh!, /^[0-9a-f]{64}$/);
  assert.notEqual(fresh, hex);
  // a second unreadable file the same day does not overwrite the first
  writeFileSync(providerKeyFilePath(dir), 'garbage two');
  assert.equal(await setAsideProviderKey(dir, ss, 'win32'), 'set-aside');
  assert.equal(readdirSync(join(dir, 'providers')).filter((n) => n.startsWith('key.bin.unreadable-')).length, 2);
});

test('R2 main.ts passes start over its own two steps: set the key aside, restart the core quietly (a full restart, like the connector key)', () => {
  const main = readFileSync(join(repoRoot, 'src/electron/main.ts'), 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('legion:provider-change'"), main.indexOf("ipcMain.handle('legion:web-search-change'"));
  assert.match(h, /startOver: \{ setAsideKey: \(\) => setAsideProviderKey\(dataDir\(\), safeStorage\)\.then\(\(\) => undefined\), restartCore: restartCoreQuiet \}/);
});

// ------------------------------------------------------------------------------------------------ core routes

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const dir = tempDir('legion-prov-startover-');
mkdirSync(join(dir, 'providers'), { recursive: true });
const configPath = join(dir, 'config.json');
writeFileSync(configPath, JSON.stringify({ port: 0, authToken: TOKEN }, null, 2));
// a machine that can encrypt, whose keys.enc was sealed under a key that is now lost
new ProviderKeys(keyFileFor(dir), { dataKey: randomBytes(32) }).set('openai', FAKE_KEY, 'https://api.openai.com');
const sealedBefore = readFileSync(sealedFileFor(dir));
const keys = new ProviderKeys(keyFileFor(dir), { dataKey: randomBytes(32) });
const runtime = new ProviderRuntime({ config: defaultConfig(), keys });
const f = makeFakes();
(f.ctx as any).modules = [createProvidersModule({ runtime, configPath, nativeSecret: NATIVE })];
let base = ''; let close: () => Promise<void>;
before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
after(async () => { await close(); });
const H = (extra: Record<string, string> = {}) => ({ ...AUTH, 'Content-Type': 'application/json', ...extra });
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H()) => fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

test('R2 the view says the key store is locked out; saving or removing a key is refused with the plain words and changes nothing', async () => {
  const v: any = await (await call('GET', '/api/providers')).json();
  assert.equal(v.keyStoreState, 'blocked');
  assert.equal(v.keyStore, REFUSED);
  const put = await call('PUT', '/api/providers/openai/key', { key: FAKE_KEY }, H({ 'X-Legion-Native': NATIVE }));
  assert.equal(put.status, 400);
  assert.equal(((await put.json()) as any).error, REFUSED);
  const del = await call('DELETE', '/api/providers/openai/key');
  assert.equal(del.status, 200, 'removing a key that reads as not set is a no-op');
  assert.deepEqual(readFileSync(sealedFileFor(dir)), sealedBefore, 'keys.enc is exactly as it was');
  assert.equal(existsSync(keyFileFor(dir)), false, 'no plain keys.json on a machine that can encrypt');
});

test('R2 POST /api/providers/keys/start-over is admin only (never a client route) and needs the native secret', async () => {
  assert.equal(isClientRoute('POST', '/api/providers/keys/start-over'), false);
  assert.equal((await fetch(base + '/api/providers/keys/start-over', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call('POST', '/api/providers/keys/start-over', {})).status, 403);
  assert.equal((await call('POST', '/api/providers/keys/start-over', {}, H({ 'X-Legion-Native': 'wrong' }))).status, 403);
  assert.deepEqual(readFileSync(sealedFileFor(dir)), sealedBefore);
});

test('R2 with the native secret, start over sets keys.enc aside (renamed, kept); the core stays locked out until it restarts with a new key', async () => {
  const r = await call('POST', '/api/providers/keys/start-over', {}, H({ 'X-Legion-Native': NATIVE }));
  assert.equal(r.status, 200);
  assert.equal(existsSync(sealedFileFor(dir)), false);
  const names = readdirSync(join(dir, 'providers')).filter((n) => n.startsWith('keys.enc.unreadable-'));
  assert.equal(names.length, 1);
  assert.deepEqual(readFileSync(join(dir, 'providers', names[0]!)), sealedBefore);
  // still locked out until the core restarts with the new key
  assert.equal(((await (await call('GET', '/api/providers')).json()) as any).keyStoreState, 'blocked');
  // the restarted core (a new data key, no keys.enc) is clean and saves work
  const fresh = new ProviderKeys(keyFileFor(dir), { dataKey: randomBytes(32) });
  assert.equal(fresh.status().blocked, undefined);
  fresh.set('openai', FAKE_KEY, 'https://api.openai.com');
  assert.equal(fresh.get('openai', 'https://api.openai.com'), FAKE_KEY);
});

test('R2 start over on a core that is not locked out is a plain 409', async () => {
  const d2 = tempDir('legion-prov-startover2-');
  const ok = new ProviderKeys(keyFileFor(d2), { dataKey: randomBytes(32) });
  const rt = new ProviderRuntime({ config: defaultConfig(), keys: ok });
  const m = createProvidersModule({ runtime: rt, configPath: join(d2, 'config.json'), nativeSecret: NATIVE });
  const routes: Record<string, (c: any) => unknown> = {};
  m.routes!((method, p, fn) => { routes[`${method} ${p}`] = fn; });
  assert.throws(() => routes['POST /api/providers/keys/start-over']!({ req: { headers: { 'x-legion-native': NATIVE } }, params: [], body: {} }), /nothing to start over/i);
  assert.equal((rt.view() as any).keyStoreState, 'encrypted');
});

test('R2 Web search: while locked out the key route refuses with the same words and the view says blocked', async () => {
  const w = webSearchRoutes({ native: NATIVE, keys: new ProviderKeys(join(tempDir('legion-ws-blocked-'), 'providers', 'keys.json'), { noKey: 'unreadable' }) });
  const v: any = await w.call('GET', '/api/settings/web-search');
  assert.equal(v.keyStoreState, 'blocked');
  assert.equal(v.keyStore, REFUSED);
  await assert.rejects(() => w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: 'k_test_12345' }, { 'x-legion-native': NATIVE }), (e: Error) => e.message === REFUSED);
  await assert.doesNotReject(() => w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: null }), 'removing a key that is not there');
});

test('R2 the Providers section shows "Start over with new keys" only in the blocked state, through the bridge', () => {
  const ui = readFileSync(join(repoRoot, 'ui/src/providers/ProvidersSection.tsx'), 'utf8');
  assert.match(ui, /view\.keyStoreState === 'blocked'/);
  assert.match(ui, /Start over with new keys/);
  const store = readFileSync(join(repoRoot, 'ui/src/providers/providersStore.ts'), 'utf8');
  assert.match(store, /bridge\(\{ kind: 'start-over' \}\)/);
});
