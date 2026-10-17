// test/web-provider-settings.test.ts : the web provider setting, its validation and its routes (task 28)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultConfig, validateWebSearchPatch } from '../src/core/web-search/index.js';
import { ProviderKeys } from '../src/core/providers/secrets.js';
import { loadConfig } from '../src/shared/config.js';
import { tempDir } from './tmp-cleanup.js';
import { getWebSearchSettings, webSearchRoutes } from './web-search-rig.js';

test('default config is builtin/builtin with a $0.01 cap and nothing acknowledged', () => {
  const c = defaultConfig().webSearch; assert.equal(c.search, 'builtin'); assert.equal(c.read, 'builtin'); assert.equal(c.tregMaxCostUsd, 0.01); assert.deepEqual(c.acknowledged, {});
});
test('a search-only provider cannot be set as the read provider', () => {
  assert.equal(validateWebSearchPatch({ read: 'brave' }).ok, false); assert.equal(validateWebSearchPatch({ read: 'searxng' }).ok, false); assert.equal(validateWebSearchPatch({ search: 'brave' }).ok, true);
});
test('enabling a provider needs the one-time acknowledgement; changing a SearXNG host asks again', () => {
  assert.equal(validateWebSearchPatch({ search: 'exa' }, defaultConfig().webSearch).needsNotice, 'exa');
  const acked = { ...defaultConfig().webSearch, acknowledged: { exa: '2026-10-16' } }; assert.equal(validateWebSearchPatch({ search: 'exa' }, acked).needsNotice, undefined);
  const sx = { ...defaultConfig().webSearch, searxng: { baseUrl: 'https://a.example.org' }, acknowledged: { searxng: '2026-10-16' } };
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'https://b.example.org' } }, sx).needsNotice, 'searxng');
  // clearing the address first must not skip the notice for the next host
  const cleared = { ...defaultConfig().webSearch, acknowledged: { searxng: '2026-10-16' } };
  assert.equal(validateWebSearchPatch({ search: 'searxng', searxng: { baseUrl: 'https://evil.example.net' } }, cleared).needsNotice, 'searxng');
});
test('SearXNG: a loopback or private address needs the native confirm flag; a user name in the URL is refused', () => {
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'http://192.168.1.5:8080' } }).needsNative, true);
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'https://u:p@searx.example.org' } }).ok, false);
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'ftp://x' } }).ok, false);
});
test('the treg cap must be 0.001..1', () => { for (const v of [0, -1, 2, Number.NaN]) assert.equal(validateWebSearchPatch({ tregMaxCostUsd: v }).ok, false, String(v)); assert.equal(validateWebSearchPatch({ tregMaxCostUsd: 0.05 }).ok, true); });
test('provider keys are origin-bound and never in config.json', () => {
  const dir = tempDir('legion-web-'); const keys = new ProviderKeys(join(dir, 'providers', 'keys.json'));
  keys.set('web:exa', 'k_test_12345', 'https://api.exa.ai');
  assert.equal(keys.get('web:exa', 'https://api.exa.ai'), 'k_test_12345'); assert.equal(keys.get('web:exa', 'https://evil.test'), undefined);
  assert.ok(!JSON.stringify(defaultConfig()).includes('k_test_12345')); assert.ok(readFileSync(join(dir, 'providers', 'keys.json'), 'utf8').includes('web:exa'));
  // with a data key (the app) the same key lives in keys.enc, and neither it nor its id is readable in any file
  const sealed = tempDir('legion-web-'); const sk = new ProviderKeys(join(sealed, 'providers', 'keys.json'), { dataKey: randomBytes(32) });
  sk.set('web:exa', 'k_test_12345', 'https://api.exa.ai');
  assert.equal(sk.get('web:exa', 'https://api.exa.ai'), 'k_test_12345'); assert.equal(sk.get('web:exa', 'https://evil.test'), undefined);
  assert.equal(existsSync(join(sealed, 'providers', 'keys.json')), false);
  const enc = readFileSync(join(sealed, 'providers', 'keys.enc')).toString('latin1');
  assert.ok(!enc.includes('k_test_12345') && !enc.includes('web:exa'));
});
test('the settings route returns a key hint (last 4) and never the key', async () => {
  const body = await getWebSearchSettings({ 'web:exa': 'k_test_12345' }); assert.equal(body.keys['web:exa'].hint, '…2345'); assert.ok(!JSON.stringify(body).includes('k_test_12345'));
});

// Added beyond the brief: the contract the Settings page builds on.
test('more validation: unknown settings, an unknown provider, a missing SearXNG address, a public http address, clearing the address', () => {
  assert.equal(validateWebSearchPatch({ acknowledged: { exa: 'x' } }).ok, false);
  assert.equal(validateWebSearchPatch({ search: 'bing' }).ok, false);
  assert.equal(validateWebSearchPatch({ search: 'searxng' }).ok, false, 'no address yet');
  assert.equal(validateWebSearchPatch({ search: 'searxng', searxng: { baseUrl: 'https://searx.example.org' } }).ok, true);
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'http://searx.example.org' } }).ok, false);
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'http://localhost:8080' } }).needsNative, true);
  assert.equal(validateWebSearchPatch({ searxng: { baseUrl: 'https://searx.example.org' } }).needsNative, undefined);
  assert.equal(validateWebSearchPatch({ searxng: null }).ok, true);
});

test('PATCH: the default needs no native header; enabling a provider needs the acknowledgement, and it is stored with the day', async () => {
  const w = webSearchRoutes();
  const refused = await w.call('PATCH', '/api/settings/web-search', { search: 'exa' }).catch((e: Error) => e);
  assert.ok(refused instanceof Error); assert.match(refused.message, /^notice_required: .*Exa/);
  assert.equal(w.config().search, 'builtin', 'nothing changed');
  const view = await w.call('PATCH', '/api/settings/web-search', { search: 'exa', acknowledge: 'exa' }) as { search: string; acknowledged: Record<string, string> };
  assert.equal(view.search, 'exa'); assert.match(view.acknowledged.exa!, /^\d{4}-\d{2}-\d{2}$/);
  const again = await w.call('PATCH', '/api/settings/web-search', { search: 'builtin' }) as { search: string }; assert.equal(again.search, 'builtin');
  const back = await w.call('PATCH', '/api/settings/web-search', { search: 'exa' }) as { search: string }; assert.equal(back.search, 'exa', 'already acknowledged: no notice again');
});
test('PATCH: an acknowledgement for another provider does not unlock this one; a bad body is a plain error', async () => {
  const w = webSearchRoutes();
  await assert.rejects(w.call('PATCH', '/api/settings/web-search', { search: 'exa', acknowledge: 'tavily' }), /notice_required/);
  await assert.rejects(w.call('PATCH', '/api/settings/web-search', { read: 'brave' }), /read/i);
  await assert.rejects(w.call('PATCH', '/api/settings/web-search', 'text'), /JSON object/);
});
test('PATCH: a private-network SearXNG address needs the native header; with it the flag is stored; a public address clears it', async () => {
  const w = webSearchRoutes({ native: 'n_secret' });
  await assert.rejects(w.call('PATCH', '/api/settings/web-search', { searxng: { baseUrl: 'http://192.168.1.5:8080' } }), /native_confirmation_required/);
  const v = await w.call('PATCH', '/api/settings/web-search', { searxng: { baseUrl: 'http://192.168.1.5:8080' } }, { 'x-legion-native': 'n_secret' }) as { searxng: { baseUrl: string; allowPrivateNetwork?: boolean } };
  assert.equal(v.searxng.allowPrivateNetwork, true);
  const pub = await w.call('PATCH', '/api/settings/web-search', { searxng: { baseUrl: 'https://searx.example.org' } }) as { searxng: { allowPrivateNetwork?: boolean } };
  assert.equal(pub.searxng.allowPrivateNetwork, undefined);
  const noNative = webSearchRoutes();
  await assert.rejects(noNative.call('PATCH', '/api/settings/web-search', { searxng: { baseUrl: 'http://localhost:8080' } }, { 'x-legion-native': 'anything' }), /native_unavailable/);
});
test('PATCH: the change is written to config.json (so it survives a restart) and is read back by loadConfig', async () => {
  const w = webSearchRoutes();
  writeFileSync(w.configPath, JSON.stringify({ port: 4747, authToken: 'x'.repeat(48), keepMe: true }));
  await w.call('PATCH', '/api/settings/web-search', { read: 'tavily', acknowledge: 'tavily', tregMaxCostUsd: 0.05 });
  const disk = JSON.parse(readFileSync(w.configPath, 'utf8')); assert.equal(disk.keepMe, true, 'the rest of the file is kept');
  assert.deepEqual({ read: disk.webSearch.read, search: disk.webSearch.search, cap: disk.webSearch.tregMaxCostUsd }, { read: 'tavily', search: 'builtin', cap: 0.05 });
  const prev = process.env.LEGION_HOME; process.env.LEGION_HOME = w.dir;
  try { const c = loadConfig(); assert.equal(c.webSearch.read, 'tavily'); assert.equal(c.webSearch.tregMaxCostUsd, 0.05); } finally { if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev; }
});
test('loadConfig: a hand-edited bad value falls back to the default (a search-only provider as the reader, a cap of 50)', () => {
  const w = webSearchRoutes();
  writeFileSync(w.configPath, JSON.stringify({ port: 4747, authToken: 'x'.repeat(48), webSearch: { search: 'nope', read: 'brave', tregMaxCostUsd: 50 } }));
  const prev = process.env.LEGION_HOME; process.env.LEGION_HOME = w.dir;
  try { const c = loadConfig(); assert.deepEqual([c.webSearch.search, c.webSearch.read, c.webSearch.tregMaxCostUsd], ['builtin', 'builtin', 1]); } finally { if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev; }
});
test('key route: needs the native header, stores the key under the fixed origin, returns the hint only; null clears it', async () => {
  const w = webSearchRoutes({ native: 'n_secret' });
  await assert.rejects(w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: 'k_test_12345' }), /native_confirmation_required/);
  const v = await w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: 'k_test_12345' }, { 'x-legion-native': 'n_secret' }) as { keys: Record<string, { set: boolean; hint?: string }> };
  assert.deepEqual(v.keys['web:exa'], { set: true, hint: '…2345' }); assert.ok(!JSON.stringify(v).includes('k_test_12345'));
  assert.equal(w.keys.get('web:exa', 'https://api.exa.ai'), 'k_test_12345'); assert.equal(w.keys.originOf('web:exa'), 'https://api.exa.ai');
  await assert.rejects(w.call('POST', '/api/settings/web-search/key', { provider: 'searxng', key: 'k_test_12345' }, { 'x-legion-native': 'n_secret' }), /no key/i);
  await assert.rejects(w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: 'short' }, { 'x-legion-native': 'n_secret' }), /characters/);
  const cleared = await w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: null }) as { keys: Record<string, { set: boolean }> };
  assert.equal(cleared.keys['web:exa']!.set, false); assert.equal(w.keys.has('web:exa'), false);
});
test('test route: reports the coded error text, never the key, and does not need the provider to be the picked one', async () => {
  const w = webSearchRoutes({ native: 'n_secret', fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch });
  await w.call('POST', '/api/settings/web-search/key', { provider: 'exa', key: 'k_test_12345' }, { 'x-legion-native': 'n_secret' });
  const r = await w.call('POST', '/api/settings/web-search/test', { provider: 'exa' }) as { ok: boolean; detail: string };
  assert.equal(r.ok, false); assert.match(r.detail, /key was refused/); assert.ok(!r.detail.includes('k_test_12345'));
  const none = await w.call('POST', '/api/settings/web-search/test', { provider: 'tavily' }) as { ok: boolean; detail: string };
  assert.equal(none.ok, false); assert.match(none.detail, /not set up/);
});
test('view: lists every provider with what it can do and whether it is ready, and says whether the app can confirm natively', async () => {
  const w = webSearchRoutes({ native: 'n_secret' });
  const v = await w.call('GET', '/api/settings/web-search') as { providers: Array<{ id: string; canRead: boolean; ready: boolean }>; nativeAvailable: boolean; tregMaxCostUsd: number; keyStore?: string };
  assert.deepEqual(v.providers.map((p) => p.id), ['treg', 'exa', 'tavily', 'brave', 'searxng']);
  assert.deepEqual(v.providers.filter((p) => p.canRead).map((p) => p.id), ['treg', 'exa', 'tavily']);
  assert.equal(v.providers.find((p) => p.id === 'exa')!.ready, false); assert.equal(v.nativeAvailable, true); assert.equal(v.tregMaxCostUsd, 0.01);
  assert.ok(!existsSync(join(w.dir, 'providers', 'keys.json')) && !existsSync(join(w.dir, 'providers', 'keys.enc')), 'nothing is stored until a key is saved');
  assert.match(String(v.keyStore), /encrypted/i, 'the view carries the one-line note on how keys are stored');
});
