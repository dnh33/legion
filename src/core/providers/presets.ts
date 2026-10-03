/** Preset provider entries (data only; this file makes no request). Model ids are suggestions the owner can ignore. */
import type { ProviderEntry } from './types.js';

export interface ProviderPreset { id: string; entry: ProviderEntry; needsKey: boolean; note: string }

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', needsKey: true, note: 'OpenAI API (chat completions). Needs an API key from your OpenAI account.',
    entry: { kind: 'openai-compat', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: false, models: [] } },
  { id: 'openrouter', needsKey: true, note: 'OpenRouter, one key for many models. Model ids look like vendor/model. Suggested: deepseek/deepseek-v4.1-flash for reasoning (no screen/GUI) and google/gemini-3.8-flash for computer-use.',
    entry: { kind: 'openai-compat', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, models: ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.8-flash'] } },
  { id: 'ollama', needsKey: false, note: 'Ollama on this computer. No key. Start Ollama first.',
    entry: { kind: 'openai-compat', label: 'Ollama (this computer)', baseUrl: 'http://127.0.0.1:11434/v1', enabled: false, keyless: true, models: [] } },
  { id: 'lmstudio', needsKey: false, note: 'LM Studio local server on this computer. No key. Start its server first.',
    entry: { kind: 'openai-compat', label: 'LM Studio (this computer)', baseUrl: 'http://127.0.0.1:1234/v1', enabled: false, keyless: true, models: [] } },
  { id: 'vllm', needsKey: false, note: 'vLLM server on this computer. No key unless you started it with one.',
    entry: { kind: 'openai-compat', label: 'vLLM (this computer)', baseUrl: 'http://127.0.0.1:8000/v1', enabled: false, keyless: true, models: [] } },
];

export const PRESET_IDS: ReadonlySet<string> = new Set(PROVIDER_PRESETS.map((p) => p.id));
