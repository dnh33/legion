/** The OpenAI-compatible chat-completions adapter: one request per model turn, streamed. Used for OpenAI, OpenRouter, custom and local servers. */
import { providerRequest, ProviderHttpError } from './http.js';
import type { HttpLimits, ProviderTarget } from './http.js';
import type { ChatMessage, ChatToolCall, ChatToolSpec, TokenUsage } from './types.js';

export interface ChatTurnRequest {
  model: string;
  messages: ChatMessage[];
  tools: ChatToolSpec[];
  signal?: AbortSignal;
  limits?: Partial<HttpLimits>;
  onText: (delta: string) => void;
}
export interface ChatTurnResult {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
  /** Set when the endpoint refused tools and the turn was answered without them. */
  toolsRefused?: boolean;
}

const MAX_RETRY_AFTER_SEC = 20;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function usageOf(u: unknown): TokenUsage | undefined {
  if (!isObj(u)) return undefined;
  const i = num(u.prompt_tokens) ?? num(u.input_tokens);
  const o = num(u.completion_tokens) ?? num(u.output_tokens);
  return i === undefined && o === undefined ? undefined : { inputTokens: i ?? 0, outputTokens: o ?? 0 };
}

interface Acc { text: string; calls: Map<number, { id: string; name: string; args: string }>; finish?: string; usage?: TokenUsage }

function feed(acc: Acc, payload: unknown, onText: (d: string) => void): void {
  if (!isObj(payload)) return;
  if (payload.error !== undefined) {
    const e = payload.error;
    throw new ProviderHttpError('status', typeof e === 'string' ? e.slice(0, 300) : isObj(e) && typeof e.message === 'string' ? e.message.slice(0, 300) : 'The provider reported an error in its stream.');
  }
  const u = usageOf(payload.usage);
  if (u) acc.usage = u;
  const ch = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isObj(ch)) return;
  if (typeof ch.finish_reason === 'string') acc.finish = ch.finish_reason;
  const d = isObj(ch.delta) ? ch.delta : isObj(ch.message) ? ch.message : undefined;
  if (!d) return;
  if (typeof d.content === 'string' && d.content) { acc.text += d.content; onText(d.content); }
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) {
      if (!isObj(tc)) continue;
      const idx = typeof tc.index === 'number' ? tc.index : acc.calls.size;
      const cur = acc.calls.get(idx) ?? { id: '', name: '', args: '' };
      if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
      const fn = isObj(tc.function) ? tc.function : {};
      if (typeof fn.name === 'string') cur.name += fn.name;
      if (typeof fn.arguments === 'string') cur.args += fn.arguments;
      if (cur.args.length > 256 * 1024) throw new ProviderHttpError('too_large', 'A tool call from the model is larger than the limit.');
      acc.calls.set(idx, cur);
    }
  }
}

const refusedTools = (e: unknown): boolean => e instanceof ProviderHttpError && e.code === 'status' && e.status === 400 && /tool|function/i.test(e.message);
const refusedStreamOptions = (e: unknown): boolean => e instanceof ProviderHttpError && e.code === 'status' && e.status === 400 && /stream_options|include_usage/i.test(e.message);

/** One model turn. Retries once without `stream_options`, once without tools, and once after a 429 (waiting at most 20 s). */
export async function chatTurn(target: ProviderTarget, req: ChatTurnRequest): Promise<ChatTurnResult> {
  let withTools = req.tools.length > 0;
  let streamOptions = true;
  let waited = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
    if (streamOptions) body.stream_options = { include_usage: true };
    if (withTools) { body.tools = req.tools; body.tool_choice = 'auto'; }
    try {
      const r = await providerRequest(target, '/chat/completions', { method: 'POST', body, accept: 'any', signal: req.signal, limits: req.limits });
      const acc: Acc = { text: '', calls: new Map() };
      if (r.kind === 'json') {
        feed(acc, r.json, () => undefined); // a server that ignored `stream`: one body with choices[0].message
        if (acc.text) req.onText(acc.text);
      } else {
        for await (const data of r.events) {
          if (data.trim() === '[DONE]') break;
          let j: unknown;
          try { j = JSON.parse(data); } catch { throw new ProviderHttpError('format', 'The provider sent a stream line Legion could not read.'); }
          feed(acc, j, req.onText);
        }
      }
      const toolCalls: ChatToolCall[] = [...acc.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({
        id: c.id || `call_${i + 1}`, type: 'function' as const, function: { name: c.name, arguments: c.args },
      }));
      return { text: acc.text, toolCalls, ...(acc.finish ? { finishReason: acc.finish } : {}), ...(acc.usage ? { usage: acc.usage } : {}), ...(req.tools.length > 0 && !withTools ? { toolsRefused: true } : {}) };
    } catch (e) {
      if (streamOptions && refusedStreamOptions(e)) { streamOptions = false; continue; }
      if (withTools && refusedTools(e)) { withTools = false; continue; }
      if (e instanceof ProviderHttpError && e.code === 'status' && e.status === 429 && !waited) {
        waited = true;
        const ms = Math.min(MAX_RETRY_AFTER_SEC, e.retryAfterSec ?? 2) * 1000;
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, ms);
          req.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new ProviderHttpError('aborted', 'Cancelled.')); }, { once: true });
        });
        continue;
      }
      throw e;
    }
  }
  throw new ProviderHttpError('status', 'The provider kept refusing the request.');
}

/** `GET /models`: ids only, at most 500, owner-initiated. */
export async function listModelIds(target: ProviderTarget, limits?: Partial<HttpLimits>): Promise<string[]> {
  const r = await providerRequest(target, '/models', { method: 'GET', accept: 'json', limits: { maxBodyBytes: 1024 * 1024, ...limits } });
  if (r.kind !== 'json' || !isObj(r.json)) throw new ProviderHttpError('format', 'The provider did not return a model list.');
  const data = Array.isArray(r.json.data) ? r.json.data : Array.isArray(r.json.models) ? r.json.models : [];
  const ids = data.map((m) => (isObj(m) ? (typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : '') : typeof m === 'string' ? m : ''))
    .filter((s) => s.length > 0 && s.length <= 120 && !/\s/.test(s));
  return [...new Set(ids)].slice(0, 500);
}
