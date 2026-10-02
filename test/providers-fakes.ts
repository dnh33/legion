/** A scripted OpenAI-compatible server on 127.0.0.1 (random port) for the provider tests. No real provider is ever contacted. */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderKeys } from '../src/core/providers/secrets.js';
import type { ProviderEntry, ProvidersConfig } from '../src/core/providers/types.js';

/** Built from two pieces so no secret scanner matches a whole key-shaped literal in the repo. */
export const FAKE_KEY = 'sk-' + 'proj-FAKEKEY0123456789abcdef';
export const FAKE_KEY2 = 'sk-' + 'or-v1-FAKEOTHER9876543210zyxwv';

export interface FakeReq { method: string; url: string; headers: IncomingHttpHeaders; raw: string; body: any }
export type FakeHandler = (req: FakeReq, res: ServerResponse, n: number) => void | Promise<void>;
export interface Fake { url: string; base: string; port: number; requests: FakeReq[]; close(): Promise<void> }

export async function startFake(handler: FakeHandler): Promise<Fake> {
  const requests: FakeReq[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body: any; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const fr: FakeReq = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw, body };
    requests.push(fr);
    try { await handler(fr, res, requests.length - 1); } catch { try { res.destroy(); } catch { /* ignore */ } }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { url: `${base}/v1`, base, port, requests, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

export const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

export function sseHead(res: ServerResponse): void { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); }
export function sseSend(res: ServerResponse, obj: unknown): void { res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`); }

/** A streamed plain-text answer, with optional usage in the last chunk. */
export function replyText(res: ServerResponse, text: string, usage?: { prompt_tokens: number; completion_tokens: number }): void {
  sseHead(res);
  res.write(': keep-alive comment\n\n');
  const half = Math.ceil(text.length / 2);
  sseSend(res, chunk({ role: 'assistant', content: text.slice(0, half) }));
  sseSend(res, chunk({ content: text.slice(half) }, 'stop'));
  if (usage) sseSend(res, { id: 'c1', choices: [], usage });
  sseSend(res, '[DONE]');
  res.end();
}

/** A streamed answer that asks for tool calls (arguments are split across chunks like real servers do). */
export function replyTools(res: ServerResponse, calls: Array<{ id?: string; name: string; args: unknown }>, usage?: { prompt_tokens: number; completion_tokens: number }): void {
  sseHead(res);
  calls.forEach((c, i) => {
    const a = typeof c.args === 'string' ? c.args : JSON.stringify(c.args);
    sseSend(res, chunk({ tool_calls: [{ index: i, ...(c.id ? { id: c.id } : {}), type: 'function', function: { name: c.name, arguments: a.slice(0, 5) } }] }));
    sseSend(res, chunk({ tool_calls: [{ index: i, function: { arguments: a.slice(5) } }] }));
  });
  sseSend(res, chunk({}, 'tool_calls'));
  if (usage) sseSend(res, { id: 'c1', choices: [], usage });
  sseSend(res, '[DONE]');
  res.end();
}

export const jsonReply = (res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};

export const entryFor = (f: Fake, over: Partial<ProviderEntry> = {}): ProviderEntry => ({ kind: 'openai-compat', label: 'Fake', baseUrl: f.url, enabled: true, keyless: true, ...over });
export const provCfg = (entries: Record<string, ProviderEntry>): ProvidersConfig => ({ version: 1, entries, maxTurns: 40, maxToolCallsPerTurn: 16 });
export const memKeys = (dir: string): ProviderKeys => new ProviderKeys(`${dir}/providers/keys.json`);
