import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_MODELS, groupModels, providerCreatorGroups, vendorName } from '../src/shared/model-groups.js';
import type { Catalog, CatalogModel } from '../src/shared/types.js';

const row = (value: string, displayName: string, resolvedModel?: string): CatalogModel =>
  ({ value, displayName, description: '', ...(resolvedModel ? { resolvedModel } : {}) });
const catalog = (...models: CatalogModel[]): Catalog => ({ commands: [], fetchedAt: '', models });

test('the fallback list is the four 5.x models by alias, and nothing older', () => {
  assert.deepEqual(FALLBACK_MODELS.map((m) => m.value), ['opus', 'sonnet', 'fable', 'haiku']);
  const g = groupModels(null);
  assert.equal(g.fallback, true);
  assert.deepEqual(g.current.map((m) => m.value), ['opus', 'sonnet', 'fable', 'haiku']);
  assert.deepEqual(g.older, []);
});

test('an unreadable catalog (error set, no models) falls back too', () => {
  const g = groupModels({ commands: [], fetchedAt: '', models: [], error: 'timed out' });
  assert.equal(g.fallback, true);
  assert.equal(g.current.length, 4);
});

test('current is every model of the newest major version (Fable included), newest first per family; older is everything lower', () => {
  const g = groupModels(catalog(
    row('default', 'Default (recommended)'),
    row('opus', 'Opus 4.7'), row('claude-opus-5-5', 'Opus 5.5'), row('claude-opus-5-1', 'Opus 5.1'),
    row('sonnet', 'Sonnet 5.5'), row('claude-sonnet-4-6', 'Sonnet 4.6'),
    row('claude-fable-5-1', 'Fable 5.1'),
    row('haiku', 'Haiku 5.5'), row('claude-haiku-3-5', 'Haiku 3.5'),
  ));
  assert.deepEqual(g.current.map((m) => m.displayName), ['Opus 5.5', 'Opus 5.1', 'Sonnet 5.5', 'Fable 5.1', 'Haiku 5.5']);
  assert.deepEqual(g.older.map((m) => m.displayName), ['Opus 4.7', 'Sonnet 4.6', 'Haiku 3.5']);
  assert.ok(!g.current.some((m: CatalogModel) => m.value === 'default'), 'the default row is dropped');
});

test('rows that resolve to the same model are merged; the first one wins', () => {
  const g = groupModels(catalog(row('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), row('claude-sonnet-5-5', 'Sonnet 5.5')));
  assert.equal(g.current.length, 1);
  assert.equal(g.current[0]!.value, 'sonnet');
});

test('a provider model with a vendor prefix is grouped under that vendor, with the provider in brackets', () => {
  assert.equal(vendorName('deepseek'), 'DeepSeek');
  assert.equal(vendorName('openai'), 'OpenAI');
  assert.equal(vendorName('meta-llama'), 'Meta');
  assert.equal(vendorName('x-ai'), 'xAI');
  assert.equal(vendorName('z-ai'), 'Z.ai');
  assert.equal(vendorName('moonshotai'), 'Moonshot');
  assert.equal(vendorName('acme'), 'Acme', 'an unknown vendor gets its own name, first letter capitalised');
  const groups = providerCreatorGroups([{ id: 'openrouter', label: 'OpenRouter', models: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-pro', 'x-ai/grok-9'] }]);
  assert.deepEqual(groups.map((g) => g.label), ['DeepSeek (OpenRouter)', 'xAI (OpenRouter)']);
  assert.deepEqual(groups[0]!.models, ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-pro']);
});

test('a model id without a slash groups under the provider label (Ollama, LM Studio, vLLM, OpenAI direct)', () => {
  const groups = providerCreatorGroups([{ id: 'ollama', label: 'Ollama (your computer)', models: ['llama3.2', 'qwen2.5:7b'] }]);
  assert.deepEqual(groups, [{ id: 'ollama', label: 'Ollama (your computer)', providerId: 'ollama', models: ['llama3.2', 'qwen2.5:7b'] }]);
});

test('about 450 ids across 20 vendors all land in a group, and the counts add up', () => {
  const vendors = Array.from({ length: 20 }, (_, i) => `vendor${String.fromCharCode(97 + i)}`);
  const ids = Array.from({ length: 450 }, (_, i) => `${vendors[i % 20]}/model-${i}`);
  const groups = providerCreatorGroups([{ id: 'openrouter', label: 'OpenRouter', models: ids }]);
  assert.equal(groups.length, 20);
  assert.equal(groups.reduce((n, g) => n + g.models.length, 0), 450);
});
