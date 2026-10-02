/** Providers are built but not part of v0.2.0: they stay off unless config.json says experimental.providers = true. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultConfig, normalizeExperimental } from '../src/shared/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('the providers switch is off by default and only the literal true turns it on', () => {
  assert.equal(defaultConfig().experimental.providers, false);
  for (const v of [undefined, null, {}, { providers: 'true' }, { providers: 1 }, { providers: [] }, 'yes', [], 5]) assert.equal(normalizeExperimental(v).providers, false, JSON.stringify(v));
  assert.equal(normalizeExperimental({ providers: true }).providers, true);
});

test('the core and the harness build neither the provider runtime nor its routes unless the switch is on', () => {
  for (const f of ['src/bin/legion-core.ts', 'scripts/harness/core-entry.mjs']) {
    const s = read(f);
    assert.match(s, /config\.experimental\.providers \? new ProviderRuntime\(/, `${f}: the runtime is behind the switch`);
    assert.match(s, /providerRuntime \? \[createProvidersModule\(/, `${f}: the routes are behind the runtime`);
    assert.match(s, /\.\.\.\(providerRuntime \? \{ providers: providerRuntime \} : \{\}\)/, `${f}: the engine gets no runtime without the switch`);
    assert.ok(!/new ProviderRuntime\(/.test(s.replace(/config\.experimental\.providers \? new ProviderRuntime\(/, '')), `${f}: no other place builds a runtime`);
  }
});

test('the Settings tab for providers shows only when the core serves the provider routes', () => {
  const s = read('ui/src/components/Settings.tsx');
  assert.match(s, /provView \? NAV : NAV\.filter\(\(n\) => n\.id !== 'providers'\)/);
});
