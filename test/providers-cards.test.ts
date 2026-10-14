import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS } from '../src/core/providers/presets.js';
import { keyFieldFor, visibleCards } from '../ui/src/providers/cards.js';

// G: OpenAI, Ollama, LM Studio and vLLM are real choices in Settings, not a "Next release" teaser.

const view = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, enabled: false, needsKey: false, keySet: false, ...over });

test('every provider the core lists gets a card, switched on or not', () => {
  const ps = PROVIDER_PRESETS.map((p) => view(p.id, { enabled: p.entry.enabled })) as any[];
  assert.deepEqual(visibleCards(ps).map((p) => p.id), ['openai', 'openrouter', 'ollama', 'lmstudio', 'vllm']);
});

test('a provider that needs a key always shows the key field; a local one marks it optional', () => {
  assert.deepEqual(keyFieldFor(view('openai', { needsKey: true }) as any), { show: true, label: 'API key', optional: false });
  assert.deepEqual(keyFieldFor(view('vllm') as any), { show: true, label: 'API key (only if your server asks for one)', optional: true });
  assert.equal(keyFieldFor(view('ollama', { keySet: true }) as any).show, true);
});

test('the notes say what the person must run or paste, in plain words', () => {
  const note = (id: string) => PROVIDER_PRESETS.find((p) => p.id === id)!.note;
  assert.match(note('openai'), /Paste an API key/);
  assert.match(note('ollama'), /Start Ollama/);
  assert.match(note('ollama'), /pull a model/);
  assert.match(note('lmstudio'), /start its local server/);
  assert.match(note('lmstudio'), /API tokens/);
  assert.match(note('vllm'), /--enable-auto-tool-choice and --tool-call-parser/);
  assert.match(note('ollama'), /first message .* can take a while/);
  assert.match(note('vllm'), /server that you run/);
  assert.match(note('vllm'), /only if you started the server with one/);
  for (const p of PROVIDER_PRESETS) assert.doesNotMatch(p.note, /this (computer|machine)|—/, p.id);
});
