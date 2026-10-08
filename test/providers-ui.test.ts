/** The provider UI's pure helpers, cut out of the TS source and run for real; plus checks that the key never takes a path other than the native bridge. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript-api';

const STORE = readFileSync(join(process.cwd(), 'ui/src/providers/providersStore.ts'), 'utf8');
const SECTION = readFileSync(join(process.cwd(), 'ui/src/providers/ProvidersSection.tsx'), 'utf8');

function helpers() {
  const a = STORE.indexOf('export const needsConfirmation'); const aEnd = STORE.indexOf('export function saveEntry');
  const b = STORE.indexOf('export function providerModelGroups');
  assert.ok(a > 0 && aEnd > a && b > aEnd);
  const code = (STORE.slice(a, aEnd) + STORE.slice(b)).replace(/export /g, '').replace(/state\.view/g, 'null');
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${js}\nreturn { needsConfirmation, providerModelGroups, providerModelLabel };`)() as {
    needsConfirmation: (p: Record<string, unknown>) => boolean;
    providerModelGroups: (v: any) => Array<{ id: string; label: string; models: string[] }>;
    providerModelLabel: (value: string | undefined, v?: any) => string | undefined;
  };
}

const VIEW = { providers: [
  { id: 'openai', label: 'OpenAI', enabled: true, models: ['gpt-a', 'gpt-b'] },
  { id: 'ollama', label: 'Ollama', enabled: false, models: ['llama'] },
  { id: 'empty', label: 'Empty', enabled: true, models: [] },
] };

test('only an address change, a private-network allowance or "no key" needs the native confirmation; enabling and model lists do not', () => {
  const h = helpers();
  assert.equal(h.needsConfirmation({ enabled: true }), false);
  assert.equal(h.needsConfirmation({ models: ['x'] }), false);
  assert.equal(h.needsConfirmation({ label: 'x' }), false);
  assert.equal(h.needsConfirmation({ baseUrl: 'https://x.example/v1' }), true);
  assert.equal(h.needsConfirmation({ allowPrivateNetwork: true }), true);
  assert.equal(h.needsConfirmation({ keyless: true }), true);
});

test('the pickers offer only providers that are on and have model ids; labels name the provider and the model', () => {
  const h = helpers();
  assert.deepEqual(h.providerModelGroups(VIEW), [{ id: 'openai', label: 'OpenAI', models: ['gpt-a', 'gpt-b'] }]);
  assert.deepEqual(h.providerModelGroups(null), []);
  assert.equal(h.providerModelLabel('openai:gpt-a', VIEW), 'OpenAI · gpt-a');
  assert.equal(h.providerModelLabel('sonnet', VIEW), undefined);
  assert.equal(h.providerModelLabel('arn:aws:bedrock:x', VIEW), undefined);
  assert.equal(h.providerModelLabel('nope:model', VIEW), undefined);
});

test('the key goes only through the native bridge: the store has no direct request carrying a key, and the form clears the field before sending', () => {
  assert.doesNotMatch(STORE, /request[^;]*\{\s*key\b/);
  assert.match(STORE, /bridge\(\{ kind: 'key', id, key \}\)/);
  assert.match(SECTION, /const k = key; setKey\(''\)/);
  assert.match(SECTION, /type="password"/);
  assert.doesNotMatch(SECTION + STORE, /localStorage|sessionStorage/, 'nothing about a provider is kept in browser storage');
});
