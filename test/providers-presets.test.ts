/**
 * OpenRouter is a shipping provider in 0.2.0: its preset is switched on and carries the two
 * model-role ids (reasoning without a GUI, and the computer-use/GUI seat). Every other preset
 * keeps the state it shipped with. No real provider is contacted.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PROVIDER_PRESETS } from '../src/core/providers/presets.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { defaultConfig } from '../src/shared/config.js';
import { memKeys } from './providers-fakes.js';

/** The two ids the owner's model map names: non-GUI reasoning, and computer-use (GUI). */
const REASONING = 'deepseek/deepseek-v4.1-flash';
const GUI = 'google/gemini-3.8-flash';

const preset = (id: string) => {
  const p = PROVIDER_PRESETS.find((x) => x.id === id);
  assert.ok(p, `${id} preset exists`);
  return p!;
};

test('OpenRouter ships on: the preset is enabled and offers the reasoning and computer-use models', () => {
  const p = preset('openrouter');
  assert.equal(p.entry.enabled, true, 'OpenRouter is a shipping provider, not one left switched off');
  assert.equal(p.entry.kind, 'openai-compat');
  assert.equal(p.entry.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(p.needsKey, true);
  assert.ok(p.entry.models?.includes(REASONING), 'the non-GUI reasoning model is offered');
  assert.ok(p.entry.models?.includes(GUI), 'the GUI/computer-use model is offered');
});

test('the preset note names both model roles, so Settings and the picker say what each model is for', () => {
  const note = preset('openrouter').note;
  assert.match(note, /reasoning/i);
  assert.match(note, /computer-use/i);
  assert.ok(note.includes(REASONING));
  assert.ok(note.includes(GUI));
});

test('only OpenRouter is switched on; every other preset keeps its shipped state and the preset set is unchanged', () => {
  assert.deepEqual(PROVIDER_PRESETS.map((p) => p.id), ['openai', 'openrouter', 'ollama', 'lmstudio', 'vllm']);
  for (const p of PROVIDER_PRESETS) {
    if (p.id === 'openrouter') continue;
    assert.equal(p.entry.enabled, false, `${p.id} is left exactly as it was (off)`);
  }
  assert.equal(preset('ollama').entry.keyless, true);
  assert.equal(preset('lmstudio').entry.keyless, true);
  assert.equal(preset('vllm').entry.keyless, true);
});

test('ProviderRuntime.view() exposes OpenRouter as on with both models, so the pickers offer openrouter:<id>', () => {
  const cfg = defaultConfig();
  const keys = memKeys(cleanupTemp('legion-prov-presets-'));
  const view = new ProviderRuntime({ config: cfg, keys }).view();
  const or = view.providers.find((p) => p.id === 'openrouter');
  assert.ok(or, 'OpenRouter is listed');
  assert.equal(or.enabled, true);
  assert.ok(or.models.includes(REASONING) && or.models.includes(GUI), 'both roles reach the picker source');
  // ui/src/providers/providersStore.ts providerModelGroups() offers only providers that are on with models.
  const offered = view.providers.filter((p) => p.enabled && p.models.length > 0).map((p) => p.id);
  assert.deepEqual(offered, ['openrouter'], 'OpenRouter is the only provider offered to the pickers');
});
