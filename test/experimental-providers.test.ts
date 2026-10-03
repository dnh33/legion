/** Providers ship in 0.2.0 (OpenRouter on by default); they stay off only if config.json sets features.providers = false. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultConfig, normalizeFeatures } from '../src/shared/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('providers are on by default and only the literal false turns them off', () => {
  assert.equal(defaultConfig().features.providers, true);
  for (const v of [undefined, null, {}, { providers: 'false' }, { providers: 0 }, { providers: [] }, 'yes', [], 5]) assert.equal(normalizeFeatures(v).providers, true, JSON.stringify(v));
  assert.equal(normalizeFeatures({ providers: false }).providers, false);
});

test('the core and the harness build neither the provider runtime nor its routes unless the switch is on', () => {
  for (const f of ['src/bin/legion-core.ts', 'scripts/harness/core-entry.mjs']) {
    const s = read(f);
    assert.match(s, /config\.features\.providers \? new ProviderRuntime\(/, `${f}: the runtime is behind the switch`);
    assert.match(s, /providerRuntime \? \[createProvidersModule\(/, `${f}: the routes are behind the runtime`);
    assert.match(s, /\.\.\.\(providerRuntime \? \{ providers: providerRuntime \} : \{\}\)/, `${f}: the engine gets no runtime without the switch`);
    assert.ok(!/new ProviderRuntime\(/.test(s.replace(/config\.features\.providers \? new ProviderRuntime\(/, '')), `${f}: no other place builds a runtime`);
  }
});

test('the Settings tab for providers shows only when the core serves the provider routes', () => {
  const s = read('ui/src/components/Settings.tsx');
  assert.match(s, /provView \? NAV : NAV\.filter\(\(n\) => n\.id !== 'providers'\)/);
});
