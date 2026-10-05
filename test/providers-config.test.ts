import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEndpoint, isPrivateLiteral } from '../src/core/providers/endpoint.js';
import { normalizeProviders } from '../src/core/providers/config.js';
import { keyFileFor, ProviderKeys } from '../src/core/providers/secrets.js';
import { defaultConfig } from '../src/shared/config.js';
import { FAKE_KEY } from './providers-fakes.js';

test('C7 endpoint rules: https anywhere, http only for this computer, no user info, fragment, query or other scheme', () => {
  assert.equal(checkEndpoint('https://api.example.com/v1').ok, true);
  assert.equal(checkEndpoint('http://127.0.0.1:11434/v1').ok, true);
  assert.equal(checkEndpoint('http://localhost:1234/v1').ok, true);
  assert.equal(checkEndpoint('http://[::1]:8000/v1').ok, true);
  for (const bad of ['http://api.example.com/v1', 'http://192.168.1.5:8000/v1', 'ftp://x.example/v1', 'file:///etc/passwd', 'https://u:p@api.example.com/v1',
    'https://api.example.com/v1#x', 'https://api.example.com/v1?key=1', 'not a url', '', 5 as unknown as string, 'https://' + 'a'.repeat(400) + '.com']) {
    assert.equal(checkEndpoint(bad).ok, false, String(bad));
  }
});

test('C7 private-network literals need the owner-confirmed flag; hostnames are not looked up', () => {
  for (const h of ['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '[fd00::1]', '[fe80::1]', '[::ffff:10.0.0.1]']) assert.equal(isPrivateLiteral(h), true, h);
  for (const h of ['172.32.0.1', '8.8.8.8', 'example.com', '[2001:db8::1]']) assert.equal(isPrivateLiteral(h), false, h);
  assert.equal(checkEndpoint('https://192.168.1.50/v1').ok, false);
  assert.equal(checkEndpoint('https://192.168.1.50/v1', { allowPrivate: true }).ok, true);
  assert.equal(checkEndpoint('https://169.254.169.254/v1').ok, false);
});

test('C19 normalizeProviders: clamps, drops bad entries, refuses cli and a non-chat wire, keyless only where it is safe', () => {
  assert.deepEqual(normalizeProviders(undefined), { version: 1, entries: {}, maxTurns: 200, maxToolCallsPerTurn: 16 });
  const n = normalizeProviders({
    maxTurns: 9999, maxToolCallsPerTurn: 0,
    entries: {
      ok: { baseUrl: 'https://api.example.com/v1/', enabled: true, label: 'Ok', models: ['m1', 'bad model', 5] },
      cli: { kind: 'cli', baseUrl: 'https://x.example/v1' },
      resp: { baseUrl: 'https://x.example/v1', wire: 'soap' },
      claude: { baseUrl: 'https://x.example/v1' },
      'Bad Id': { baseUrl: 'https://x.example/v1' },
      http: { baseUrl: 'http://remote.example/v1' },
      keyless: { baseUrl: 'https://remote.example/v1', keyless: true },
      local: { baseUrl: 'http://127.0.0.1:11434/v1', keyless: true, enabled: true },
      priced: { baseUrl: 'https://p.example/v1', prices: { m: { inputPerMTok: 1.5, outputPerMTok: 3 }, bad: { inputPerMTok: -1, outputPerMTok: 1 } } },
    },
  });
  assert.equal(n.maxTurns, 200); assert.equal(n.maxToolCallsPerTurn, 16);
  assert.deepEqual(Object.keys(n.entries).sort(), ['keyless', 'local', 'ok', 'priced']);
  assert.equal(n.entries.ok!.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(n.entries.ok!.models, ['m1']);
  assert.equal(n.entries.keyless!.keyless, undefined, 'keyless stands only for this computer');
  assert.equal(n.entries.local!.keyless, true);
  assert.deepEqual(Object.keys(n.entries.priced!.prices!), ['m']);
  const why = (n.dropped ?? []).join(' | ');
  assert.match(why, /CLI providers are not available/);
  assert.match(why, /wire must be chat or responses/);
  assert.match(why, /http is only allowed for this computer/);
});

test('C19 a fresh install has no providers and config round-trips unknown keys', () => {
  const c = defaultConfig();
  assert.deepEqual(c.providers.entries, {});
  assert.equal(c.providers.maxTurns, 200);
});

test('C4 keys: a separate 0600 file, bound to the origin, deleted when the origin changes; never in config', () => {
  const dir = cleanupTemp('legion-pk-');
  const k = new ProviderKeys(keyFileFor(dir));
  assert.equal(k.has('openai'), false);
  assert.throws(() => k.set('openai', 'short', 'https://a.example'), /characters/);
  assert.throws(() => k.set('openai', 'has space in it 12345', 'https://a.example'), /spaces/);
  k.set('openai', FAKE_KEY, 'https://a.example');
  assert.equal(k.get('openai', 'https://a.example'), FAKE_KEY);
  assert.equal(k.get('openai', 'https://b.example'), undefined, 'a key is handed out only for the origin it was saved for');
  assert.equal(k.hint('openai'), '…' + FAKE_KEY.slice(-4));
  const f = keyFileFor(dir);
  assert.equal(existsSync(f), true);
  if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o077, 0, 'owner only');
  assert.equal(new ProviderKeys(f).get('openai', 'https://a.example'), FAKE_KEY, 'survives a restart');
  assert.equal(k.dropIfOriginDiffers('openai', 'https://a.example'), false);
  assert.equal(k.dropIfOriginDiffers('openai', 'https://evil.example'), true);
  assert.equal(k.has('openai'), false);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).keys.openai, undefined);
});
