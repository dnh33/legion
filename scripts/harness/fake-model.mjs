/**
 * The scripted, deterministic stand-in for the Claude Agent SDK `query()`. No network, no Claude call.
 *
 * The engine passes `query({prompt, options})`; this returns an async generator of SDK-shaped messages built from a SCRIPT, and it plays the
 * part the Claude Code process plays between messages, so Legion's own gates run for real:
 *   1. PreToolUse hook (options.hooks) is called first (this is where Legion marks a run as tainted); its deny, ask or allow answer is honoured,
 *   2. Claude's own permission order decides next (see `decide` below); options.canUseTool is called ONLY for a call Claude itself would ask about,
 *      and a denial is returned to the script,
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

// Claude Code's tools that only read, and its tools that edit files (https://code.claude.com/docs/en/permissions "Permission system" table and
// https://code.claude.com/docs/en/permission-modes). Claude Code's built-in read-only shell commands (ls, cat ...) are not modelled: the scripts
// never rely on them.
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * What Claude Code decides about one tool call before canUseTool is asked, in the documented order. Returns {behavior:'allow'|'deny'|'ask', message?}.
 * 'ask' is the only answer that reaches options.canUseTool.
 * @param {{permissionMode?: string, allowedTools?: string[], disallowedTools?: string[]}} options
 * @param {string} tool
 * @param {{decision?: string, reason?: string}} hook the strongest PreToolUse answer for this call
 */
export function decide(options, tool, hook) {
  const mode = options.permissionMode ?? 'default';
  // 1. A PreToolUse hook that denies stops the call before any rule is read ("A hook that exits with code 2 stops the tool call before permission rules are evaluated").
  if (hook.decision === 'deny') return { behavior: 'deny', message: hook.reason ?? 'denied by a hook' };
  // 2. Deny rules block in every mode, bypassPermissions included (permission-modes: "Deny rules block in every mode"). A tool in disallowedTools is such a rule.
  if ((options.disallowedTools ?? []).includes(tool)) return { behavior: 'deny', message: `${tool} is not available` };
  // 3. A hook "ask" forces the prompt, and a hook "allow" skips it (permissions "Extend permissions with hooks"; plan mode is not modelled).
  if (hook.decision === 'ask') return { behavior: 'ask' };
  if (hook.decision === 'allow') return { behavior: 'allow' };
  // 4. bypassPermissions: "Everything" is allowed without a prompt (permission-modes table).
  if (mode === 'bypassPermissions') return { behavior: 'allow' };
  // 5. allowedTools: "auto-allowed without prompting for permission" (sdk.d.ts Options.allowedTools).
  if ((options.allowedTools ?? []).includes(tool)) return { behavior: 'allow' };
  // 6. Reads need no approval in default, acceptEdits and the other modes ("Read-only: Approval required: No"; the default row of permission-modes is "Reads only").
  if (READ_ONLY_TOOLS.has(tool)) return { behavior: 'allow' };
  // 7. acceptEdits: "Reads, file edits, and common filesystem commands" are allowed.
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return { behavior: 'allow' };
  // 8. Everything left (Bash, web tools, MCP tools, edits in default mode) prompts, which is the canUseTool call. In auto mode a classifier would try first and
  //    "prompt through canUseTool when it cannot decide"; the harness has no classifier, so it always cannot decide.
  return { behavior: 'ask' };
}

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
        // every hook runs; deny beats ask beats allow (a hook allow never overrides a deny or ask from another hook)
        const hook = { decision: undefined, reason: undefined };
        const rank = { deny: 3, ask: 2, allow: 1 };
        for (const h of options.hooks?.PreToolUse ?? []) for (const fn of h.hooks ?? []) {
          const out = await fn({ hook_event_name: 'PreToolUse', tool_name: step.tool, tool_use_id: id, tool_input: input }, id, { signal });
          const o = out?.hookSpecificOutput;
          if (o?.hookEventName === 'PreToolUse' && rank[o.permissionDecision] > (rank[hook.decision] ?? 0)) { hook.decision = o.permissionDecision; hook.reason = o.permissionDecisionReason; }
        }
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: step.tool, input }] } };
        let text = SIMULATED;
        let isError = false;
        let verdict = decide(options, step.tool, hook);
        if (verdict.behavior === 'ask') {
          // no canUseTool and no prompt surface: Claude Code cannot ask, so (as before) the harness lets the call through
          if (typeof options.canUseTool === 'function') {
            const d = await options.canUseTool(step.tool, input, { signal, toolUseID: id });
            verdict = d?.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: d?.message };
          } else verdict = { behavior: 'allow' };
        }
        if (verdict.behavior === 'deny') { entry.decision = 'deny'; text = verdict.message ?? 'denied'; isError = true; }
        const m = /^mcp__([^_].*?)__(.+)$/.exec(step.tool);
        if (entry.decision === 'allow' && m) {
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
    // the engine streams its prompt (an InputChannel); its first message is the request
    const prompt = typeof p.prompt === 'string' ? p.prompt : String(p.prompt?.initialText ?? '');
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
