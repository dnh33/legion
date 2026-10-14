/** Preset provider entries (data only; this file makes no request). Model ids are suggestions the owner can ignore. */
import type { ProviderEntry } from './types.js';

export interface ProviderPreset { id: string; entry: ProviderEntry; needsKey: boolean; note: string }

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', needsKey: true, note: 'OpenAI API. Paste an API key from your OpenAI account below, then press Test. Press Refresh models to list the models your key can use. Runs are billed to that account.',
    entry: { kind: 'openai-compat', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: false, models: [] } },
  { id: 'openrouter', needsKey: true, note: 'OpenRouter, one key for many models. Model ids look like vendor/model. Suggested: xiaomi/mimo-v2.6-pro for reasoning and xiaomi/mimo-v2.6-flash for fast everyday work (no screen/GUI), and google/gemini-3.8-flash for computer-use. deepseek/deepseek-v4.1-flash is offered too.',
    entry: { kind: 'openai-compat', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.8-flash'] } },
  { id: 'ollama', needsKey: false, note: 'Ollama on your computer. No key. Start Ollama and pull a model first (ollama pull followed by a model name), then press Refresh models to list it. The first message after Ollama has been idle can take a while: it loads the model first.',
    entry: { kind: 'openai-compat', label: 'Ollama (your computer)', baseUrl: 'http://127.0.0.1:11434/v1', enabled: false, keyless: true, models: [] } },
  { id: 'lmstudio', needsKey: false, note: 'LM Studio on your computer. In LM Studio, open the Developer tab and start its local server. A model can be loaded there, or it loads on the first message, which takes a moment. No key unless you turned on API tokens in LM Studio; then paste one below. Then press Refresh models.',
    entry: { kind: 'openai-compat', label: 'LM Studio (your computer)', baseUrl: 'http://127.0.0.1:1234/v1', enabled: false, keyless: true, models: [] } },
  { id: 'vllm', needsKey: false, note: 'A vLLM server that you run. The address is the default one (port 8000); change it if yours differs. Paste a key below only if you started the server with one. For tool calls, start vLLM with --enable-auto-tool-choice and --tool-call-parser; without them Legion puts the tools in the prompt instead. Press Refresh models to list the model it serves.',
    entry: { kind: 'openai-compat', label: 'vLLM (your computer)', baseUrl: 'http://127.0.0.1:8000/v1', enabled: false, keyless: true, models: [] } },
];

export const PRESET_IDS: ReadonlySet<string> = new Set(PROVIDER_PRESETS.map((p) => p.id));
