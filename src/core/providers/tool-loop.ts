/**
 * Legion's own tool loop for a model that has no Claude Code tools. It offers only the in-process Legion tool servers of the run
 * (connected over an in-memory transport pair: no socket, no process), and every call goes, in this order, through: the offered-name
 * check, the argument check, taint (noteToolUse), the approval decision (the same one Claude's canUseTool uses), then the tool.
 * The tool's own gates (BSV, Blender, kg, comms) live inside the tool and are not touched here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectExternal } from './external-mcp.js';
import { chatTurn } from './openai-compat.js';
import { makeStreamRedactor } from './stream-redact.js';
import type { ChatTurnResult } from './openai-compat.js';
import { ProviderHttpError } from './http.js';
import type { HttpLimits, ProviderTarget } from './http.js';
import type { ChatMessage, ChatToolSpec, ProviderHost, ProviderRunResult, TokenUsage } from './types.js';

export const MAX_ARG_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_CHARS = 12_000;
export const HISTORY_MAX_MESSAGES = 40;
export const HISTORY_MAX_CHARS = 60_000;
const FN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REPEAT_FAIL_LIMIT = 3;

interface Offered { client: Client; remote: string }
export interface ToolSet { offered: Map<string, Offered>; specs: ChatToolSpec[]; close(): Promise<void> }

type Connectable = { connect(t: unknown): Promise<void>; close?(): Promise<void> };

/** Connects a client to each in-process server and lists its tools as `mcp__<server>__<tool>` (the names every Legion module already knows). */
export const MAX_OFFERED_TOOLS = 128;

export async function connectTools(servers: ProviderHost['servers'], notice: (t: string) => void, external: NonNullable<ProviderHost['external']> = {}, signal?: AbortSignal): Promise<ToolSet> {
  const offered = new Map<string, Offered>();
  const specs: ChatToolSpec[] = [];
  const clients: Client[] = [];
  const servs: Connectable[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (cfg?.type !== 'sdk' || !cfg.instance) continue; // only in-process servers; nothing else is ever offered
    try {
      const inst = cfg.instance as unknown as Connectable;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await inst.connect(st);
      const client = new Client({ name: 'legion-provider-loop', version: '1' });
      await client.connect(ct);
      clients.push(client); servs.push(inst);
      const listed = await client.listTools();
      for (const t of listed.tools) {
        const name = `mcp__${serverName}__${t.name}`;
        if (!FN_NAME.test(name)) { notice(`Tool ${name} is not offered to this model (its name is not allowed).`); continue; }
        offered.set(name, { client, remote: t.name });
        specs.push({ type: 'function', function: { name, description: (t.description ?? '').slice(0, 1000), parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
      }
    } catch (e) {
      notice(`Tools of "${serverName}" are not available in this run: ${e instanceof Error ? e.message.slice(0, 160) : 'could not start'}.`);
    }
  }
  const closers: Array<() => Promise<void>> = [];
  for (const [serverName, cfg] of Object.entries(external)) {
    try {
      const conn = await connectExternal(serverName, cfg, signal ? { signal } : {});
      closers.push(() => conn.close());
      const listed = await conn.client.listTools();
      for (const t of listed.tools) {
        const name = `mcp__${serverName}__${t.name}`;
        if (!FN_NAME.test(name)) { notice(`Tool ${name.slice(0, 80)} is not offered to this model (its name is not allowed).`); continue; }
        if (specs.length >= MAX_OFFERED_TOOLS) { notice(`More than ${MAX_OFFERED_TOOLS} tools are available; the rest are not offered to this model.`); break; }
        offered.set(name, { client: conn.client, remote: t.name });
        specs.push({ type: 'function', function: { name, description: (t.description ?? '').slice(0, 1000), parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
      }
    } catch (e) {
      notice(`The MCP server "${serverName}" is not available in this run: ${e instanceof Error ? e.message.slice(0, 160) : 'could not start'}.`);
    }
  }
  return {
    offered, specs,
    async close() {
      for (const c of closers) { try { await c(); } catch { /* ignore */ } }
      for (const c of clients) { try { await c.close(); } catch { /* ignore */ } }
      for (const s of servs) { try { await s.close?.(); } catch { /* ignore */ } }
    },
  };
}

/** The stored task as chat messages: user and assistant text, and tool calls with their results (a call without a result is dropped). */
export function buildMessages(host: Pick<ProviderHost, 'stored' | 'prompt' | 'systemPrompt'>): ChatMessage[] {
  let lastUser = -1;
  for (let i = host.stored.length - 1; i >= 0; i--) if (host.stored[i]!.role === 'user') { lastUser = i; break; }
  const prior = lastUser >= 0 ? host.stored.slice(0, lastUser) : host.stored;
  const msgs: ChatMessage[] = [];
  const open = new Set<string>();
  for (const m of prior) {
    if (m.role === 'user' && m.text) msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant' && m.text) msgs.push({ role: 'assistant', content: m.text });
    else if (m.role === 'tool' && m.toolName && m.toolUseId && !m.resultFor) {
      let args = '{}';
      try { args = JSON.stringify(JSON.parse(m.text)); } catch { /* clipped when stored: the arguments are not needed again */ }
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: m.toolUseId, type: 'function', function: { name: m.toolName, arguments: args } }] });
      open.add(m.toolUseId);
    } else if (m.role === 'tool' && m.resultFor && open.has(m.resultFor)) {
      msgs.push({ role: 'tool', content: m.text, tool_call_id: m.resultFor });
      open.delete(m.resultFor);
    }
  }
  const kept = msgs.filter((m) => !(m.tool_calls && open.has(m.tool_calls[0]!.id)));
  // newest 40 messages and 60,000 characters; a result whose call was cut off is dropped with it
  let start = Math.max(0, kept.length - HISTORY_MAX_MESSAGES);
  let chars = 0;
  for (let i = kept.length - 1; i >= start; i--) {
    chars += (kept[i]!.content?.length ?? 0) + (kept[i]!.tool_calls ? 200 : 0);
    if (chars > HISTORY_MAX_CHARS) { start = i + 1; break; }
  }
  const tail = kept.slice(start);
  while (tail.length && (tail[0]!.role === 'tool' || tail[0]!.role === 'assistant')) tail.shift();
  return [{ role: 'system', content: host.systemPrompt }, ...tail, { role: 'user', content: host.prompt }];
}

const textOf = (r: { content?: unknown }): string => {
  const parts = Array.isArray(r.content) ? r.content : [];
  const out = parts.map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '[non-text content left out]'));
  return out.join('\n');
};
const clipText = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + `\n[truncated: first ${n} of ${s.length} chars]` : s);

export interface LoopOptions {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  limits?: Partial<HttpLimits>;
  /** Replaces `chatTurn` in tests only. */
  turn?: typeof chatTurn;
}

export async function runToolLoop(host: ProviderHost, target: ProviderTarget, model: string, opts: LoopOptions, redact: (s: string) => string, secrets: () => string[] = () => []): Promise<ProviderRunResult> {
  const turnFn = opts.turn ?? chatTurn;
  const res: ProviderRunResult = { subtype: 'success', isError: false, turns: 0, usageUnknown: false };
  let usage: TokenUsage | undefined;
  const addUsage = (r: ChatTurnResult) => {
    if (r.usage) usage = { inputTokens: (usage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + r.usage.outputTokens };
    else res.usageUnknown = true;
  };
  const tools = await connectTools(host.servers, host.onNotice, host.external, host.signal);
  const used = new Set<string>();
  const fails = new Map<string, number>();
  let noticedRefused = false;
  try {
    const messages = buildMessages(host);
    let lastText = '';
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
      res.turns = turn;
      const sr = makeStreamRedactor(host.onDelta, redact, secrets);
      let r: ChatTurnResult;
      try { r = await turnFn(target, { model, messages, tools: tools.specs, signal: host.signal, limits: opts.limits, onText: sr.push }); } finally { sr.flush(); }
      addUsage(r);
      if (r.toolsRefused && !noticedRefused) { noticedRefused = true; host.onNotice('This model did not accept tools: it can answer, but it cannot use Legion\'s tools.'); }
      const text = redact(r.text).trim();
      if (text) { host.onAssistantText(text); lastText = text; }
      if (r.toolCalls.length === 0) {
        if (!text) return { ...res, usage, isError: true, subtype: 'error_during_execution', errorText: 'The model returned an empty answer.' };
        if (r.finishReason === 'length') host.onNotice('The reply may be cut off: the model stopped at its output limit.');
        return { ...res, usage, resultText: text };
      }
      messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls.map((c, i) => ({ ...c, id: used.has(c.id) ? `${c.id}_${turn}_${i}` : c.id })) });
      const calls = messages[messages.length - 1]!.tool_calls!;
      for (const c of calls) used.add(c.id);
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        const name = call.function.name;
        let out: { text: string; isError: boolean };
        if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
        let input: Record<string, unknown> = {};
        let parseFailed = false;
        if (call.function.arguments.length > MAX_ARG_BYTES) { parseFailed = true; }
        else if (call.function.arguments.trim()) {
          try { const v = JSON.parse(call.function.arguments); if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown>; else parseFailed = true; } catch { parseFailed = true; }
        }
        host.onToolCall(name, call.id, input);
        const entry = tools.offered.get(name);
        if (i >= opts.maxToolCallsPerTurn) out = { text: `Error: too many tool calls in one turn (limit ${opts.maxToolCallsPerTurn}); this one was not run.`, isError: true };
        else if (!entry) out = { text: `Error: ${name.slice(0, 80)} is not a tool you have. Your tools are: ${[...tools.offered.keys()].slice(0, 40).join(', ') || 'none'}.`, isError: true };
        else if (parseFailed) out = { text: 'Error: the arguments were not a JSON object within the size limit; the tool was not run.', isError: true };
        else {
          host.noteToolUse(name, call.id, input);
          const decision = await host.authorize(name, input);
          if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
          if (!decision.allow) out = { text: decision.message || 'The user denied this action.', isError: true };
          else {
            try {
              const r = await entry.client.callTool({ name: entry.remote, arguments: input }, undefined, { signal: host.signal, timeout: 3_600_000 });
              out = { text: textOf(r as { content?: unknown }), isError: (r as { isError?: boolean }).isError === true };
            } catch (e) {
              if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
              out = { text: `Error: ${e instanceof Error ? e.message.slice(0, 300) : 'the tool failed'}`, isError: true };
            }
          }
        }
        const shown = redact(clipText(out.text, MAX_TOOL_RESULT_CHARS));
        host.onToolResult(call.id, shown);
        messages.push({ role: 'tool', content: shown || '(no output)', tool_call_id: call.id });
        const key = `${name}\n${call.function.arguments}`;
        if (out.isError) {
          const n = (fails.get(key) ?? 0) + 1; fails.set(key, n);
          if (n >= REPEAT_FAIL_LIMIT) return { ...res, usage, isError: true, subtype: 'error_during_execution', errorText: 'The model kept repeating a failing tool call, so Legion stopped the run.' };
        } else fails.delete(key);
      }
    }
    return { ...res, usage, isError: true, subtype: 'error_max_turns', errorText: `Stopped after ${opts.maxTurns} model turns without a final answer.`, ...(lastText ? { resultText: lastText } : {}) };
  } catch (e) {
    if (host.cancelled() || (e instanceof ProviderHttpError && e.code === 'aborted')) return { ...res, subtype: 'cancelled', usage };
    return { ...res, usage, isError: true, subtype: 'error_during_execution', errorText: redact(e instanceof Error ? e.message : String(e)).slice(0, 400) };
  } finally {
    await tools.close();
  }
}
