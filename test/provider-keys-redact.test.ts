// test/provider-keys-redact.test.ts: provider and web search key values are known to the log redactor from the moment the core holds them (final review M4).
// The values are shaped like nothing a log rule knows (no sk- prefix), so only the exact-value registration can mask them.
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ProviderKeys } from '../src/core/providers/secrets.js';
import { clearRegisteredSecrets, redact } from '../src/core/log/redact.js';

const K1 = 'zq7Hk2Lw9PxmV4tRb8Ne5YcdSaQ1';
const K2 = 'Tavily0wT3stValueNotShapedLikeAnyRule99';

test('M4: a key set through the store is masked in a log line (provider key and web search key)', () => {
  clearRegisteredSecrets();
  const keys = new ProviderKeys(join(tempDir('legion-redact-'), 'providers', 'keys.json'));
  assert.equal(redact(`failed with ${K1} and ${K2}`).includes(K1), true, 'before: nothing masks a key of no known shape');
  keys.set('openrouter', K1, 'https://openrouter.ai');
  keys.set('web:tavily', K2, 'https://api.tavily.com');
  for (const k of [K1, K2]) {
    const out = redact(`request failed: Authorization ${k} (retry)`);
    assert.equal(out.includes(k), false, k);
  }
});

test('M4: a key loaded from disk at start is masked too', () => {
  clearRegisteredSecrets();
  const file = join(tempDir('legion-redact-'), 'providers', 'keys.json');
  new ProviderKeys(file).set('deepseek', K1, 'https://api.deepseek.com');
  clearRegisteredSecrets(); // a new process: nothing registered yet
  assert.equal(redact(`x ${K1} y`).includes(K1), true);
  new ProviderKeys(file); // load
  assert.equal(redact(`x ${K1} y`).includes(K1), false);
});
