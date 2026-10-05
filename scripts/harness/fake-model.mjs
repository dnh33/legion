/**
 * The scripted, deterministic stand-in for the Claude Agent SDK `query()`. No network, no Claude call.
 *
 * The engine passes `query({prompt, options})`; this returns an async generator of SDK-shaped messages built from a SCRIPT, and it plays the
 * part the Claude Code process plays between messages, so Legion's own gates run for real:
 *   1. PreToolUse hook (options.hooks) is called first (this is where Legion marks a run as tainted),
 *   2. options.canUseTool is called when the engine set one (not in bypass mode), and a denial is returned to the script,
 *   3. an in-process Legion tool (`mcp__<server>__<tool>`, e.g. mcp__legion_comms__room_create) is called through a real MCP client over an
 *      in-memory transport, so its input schema is validated like the real thing,
 *   4. any other tool (Bash, WebFetch, Write ...) is NOT executed: the script gets a fixed "simulated" text back.
 *
 * Script steps (plain JSON so scenarios can send them over IPC):
 *   {say: 'text'}                           an assistant text message
 *   {tool: 'Bash', input: {...}, as: 'k'}   a tool call; the outcome is stored under vars[k] and in the run log
 *   {wait: 50}                              sleep (ms)
 *   {result: 'text', costUsd?: 0.01, error?: true, subtype?: 'error_max_turns'}   the final result message (added automatically if the script has none); `subtype` overrides the error kind
 * Selection: scripts are registered with a matcher {agent?, promptIncludes?, once?=true}. First registered match wins; no match -> a default reply.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { basename } from 'node:path';

const SIMULATED = '[harness] tool not executed (the scripted model only runs Legion\'s own in-process tools)';

export function createFakeModel() {
  /** @type {Array<{match: {agent?: string, promptIncludes?: string, once?: boolean}, steps: any[], used: number}>} */
  const scripts = [];
  /** One entry per query() call, newest last. */
  const runs = [];
  let seq = 0;

  const pick = (agent, prompt) => {
    const i = scripts.findIndex((s) => (!s.match.agent || s.match.agent === agent) && (!s.match.promptIncludes || prompt.includes(s.match.promptIncludes)) && !(s.match.once !== false && s.used > 0));
    if (i < 0) return undefined;
    scripts[i].used += 1;
    return scripts[i];
  };

  async function* run(p, record) {
    const sid = `harness-sess-${++seq}`;
    const options = p.options ?? {};
    yield { type: 'system', subtype: 'init', session_id: sid, mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })) };
    const clients = new Map();
    const clientFor = async (server) => {
      if (clients.has(server)) return clients.get(server);
      const cfg = options.mcpServers?.[server];
      if (!cfg?.instance) return undefined;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cfg.instance.connect(st);
      const c = new Client({ name: 'harness-fake-model', version: '0.0.0' });
      await c.connect(ct);
      clients.set(server, c);
      return c;
    };
    const signal = options.abortController?.signal;
    let final;
    try {
      for (const step of record.steps) {
        if (typeof step.wait === 'number') { await new Promise((r) => setTimeout(r, step.wait)); continue; }
        if (typeof step.say === 'string') { yield { type: 'assistant', message: { content: [{ type: 'text', text: step.say }] } }; continue; }
        if (typeof step.result === 'string') { final = step; break; }
        if (typeof step.tool !== 'string') continue;
        const id = `tu_${sid}_${record.toolCalls.length + 1}`;
        const input = step.input ?? {};
        const entry = { tool: step.tool, input, decision: 'allow', text: '', isError: false };
        record.toolCalls.push(entry);
        for (const h of options.hooks?.PreToolUse ?? []) for (const fn of h.hooks ?? []) await fn({ hook_event_name: 'PreToolUse', tool_name: step.tool, tool_use_id: id, tool_input: input }, id, { signal });
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: step.tool, input }] } };
        let text = SIMULATED;
        let isError = false;
        if (typeof options.canUseTool === 'function') {
          const d = await options.canUseTool(step.tool, input, { signal, toolUseID: id });
          if (d?.behavior !== 'allow') { entry.decision = 'deny'; text = d?.message ?? 'denied'; isError = true; }
        }
        const m = /^mcp__([^_].*?)__(.+)$/.exec(step.tool);
        if (entry.decision === 'allow' && m && !(options.disallowedTools ?? []).includes(step.tool)) {
          const c = await clientFor(m[1]);
          if (c) {
            try {
              const r = await c.callTool({ name: m[2], arguments: input });
              text = (r.content ?? []).map((x) => x.text ?? '').join('\n');
              isError = r.isError === true;
            } catch (e) { text = String(e?.message ?? e); isError = true; }
          } else { text = `[harness] no in-process server "${m[1]}" for this agent`; isError = true; }
        }
        entry.text = text; entry.isError = isError;
        if (step.as) record.vars[step.as] = { decision: entry.decision, isError, text };
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } };
      }
    } finally {
      for (const c of clients.values()) await c.close().catch(() => undefined);
    }
    const text = final?.result ?? record.defaultReply;
    yield { type: 'result', subtype: final?.subtype ?? (final?.error ? 'error_during_execution' : 'success'), is_error: final?.error === true, result: text, total_cost_usd: final?.costUsd ?? 0, num_turns: 1, session_id: sid };
  }

  const queryFn = (p) => {
    const agent = basename(String(p.options?.cwd ?? ''));
    const prompt = String(p.prompt ?? '');
    const s = pick(agent, prompt);
    const record = { n: runs.length + 1, agent, prompt, scripted: !!s, steps: s?.steps ?? [], toolCalls: [], vars: {}, defaultReply: `[harness] ${agent} done`, permissionMode: p.options?.permissionMode ?? null, hasCanUseTool: typeof p.options?.canUseTool === 'function', servers: Object.keys(p.options?.mcpServers ?? {}) };
    runs.push(record);
    const gen = run(p, record);
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  };

  return {
    queryFn,
    addScript(match, steps) { scripts.push({ match: match ?? {}, steps: Array.isArray(steps) ? steps : [], used: 0 }); return scripts.length; },
    /** Plain-data copy of the run log (safe to send over IPC). */
    log() { return runs.map(({ n, agent, prompt, scripted, toolCalls, vars, permissionMode, hasCanUseTool, servers }) => ({ n, agent, prompt, scripted, toolCalls, vars, permissionMode, hasCanUseTool, servers })); },
    reset() { scripts.length = 0; runs.length = 0; },
  };
}
