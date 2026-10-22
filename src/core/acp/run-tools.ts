/**
 * What answers behind a run key: Legion's own tools for one run of an agent host, as an MCP server.
 *
 * The run's in-process tool servers are connected once (connectTools, over an in-memory pair) and kept until the key ends. Each
 * HTTP request gets its own small MCP server in front of them, so no tool server is ever bound to a second transport. That server
 * serves the allow list below and nothing else: a tool that is not on it is not listed and is refused by name. Every call then goes
 * through the same steps as a call on a model provider (callWithEnforcement: taint, the approval decision, the tool), writes a call
 * row and a result row on the task, and ends with the run: a revoked key or a cancelled run cuts a call that is still waiting.
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { callWithEnforcement, clipText, connectTools, MAX_TOOL_RESULT_CHARS } from '../providers/tool-loop.js';
import type { Offered, ToolSet } from '../providers/tool-loop.js';
import { redact as logRedact } from '../log/redact.js';
import type { RunGrant, RunToolsHost } from './run-tokens.js';

/**
 * The only tools an agent host can reach, by tool server and tool name. Default deny: a tool added to a server later is not served
 * until it is named here. Not on it, on purpose: vm_*, web_*, todo_*, the host shell and file tools, the BSV, connector, house,
 * armory, browser, board, knowledge and blender servers, and anything that creates an agent or starts a run.
 */
export const RUN_TOOL_ALLOW: Readonly<Record<string, readonly string[]>> = {
  legion: ['agents', 'ask', 'tell', 'task_result', 'ask_user_question'],
  // rooms
  legion_comms: ['bot_list', 'bot_send', 'room_post', 'room_read', 'room_list', 'handoff', 'room_create', 'room_add_member', 'room_remove_member'],
};

/**
 * The longest a served tool may wait for a person or another agent, in seconds. The agent host ends an MCP tool call at 300 s by
 * default (hermes-agent tools/mcp_tool_common.py:41, _DEFAULT_TOOL_TIMEOUT), so a wait that is allowed to run longer is cut on its
 * side while it keeps running on ours. 270 leaves the call room to answer inside that limit.
 */
export const RUN_TOOL_WAIT_MAX_S = 270;

/** Calls in flight on one key at once. An agent that runs tools in parallel stays well under it. */
const MAX_IN_FLIGHT = 16;

/** Tools that wait for the owner's answer and have no wait setting to clamp: the served description says the host cuts the wait. */
const WAITS_FOR_A_PERSON: ReadonlySet<string> = new Set(['ask_user_question', 'room_create', 'room_add_member', 'room_remove_member']);
const HOST_CUTS_NOTE = ' Your agent host cuts any tool call after about 5 minutes, so the answer has to come within that time.';
const ASK_LONG_WORK_NOTE = ' For long work use tell, then task_result.';

/** The wait an `ask` may have: the given number of seconds up to the ceiling, and the ceiling when none (or a bad value) is given. */
const clampWait = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, RUN_TOOL_WAIT_MAX_S) : RUN_TOOL_WAIT_MAX_S);

/** What this route shows an agent host for a tool: the tool's own text and schema, with the wait limits of this route added. */
function shownTool(remote: string, description: string, schema: Tool['inputSchema']): { description: string; inputSchema: Tool['inputSchema'] } {
  if (remote === 'ask') {
    const props = { ...((schema.properties ?? {}) as Record<string, Record<string, unknown>>) };
    props.timeoutSeconds = { ...(props.timeoutSeconds ?? { type: 'number' }), maximum: RUN_TOOL_WAIT_MAX_S, default: RUN_TOOL_WAIT_MAX_S, description: `Seconds to wait for the answer. Default and longest ${RUN_TOOL_WAIT_MAX_S}.` };
    return { description: description + ASK_LONG_WORK_NOTE, inputSchema: { ...schema, properties: props } };
  }
  return { description: WAITS_FOR_A_PERSON.has(remote) ? description + HOST_CUTS_NOTE : description, inputSchema: schema };
}

/** Calls waiting on one key, by the request id the shim used, so a cancel from the host can reach the one it names. */
const waiting = new WeakMap<RunGrant, Map<string, Set<AbortController>>>();

interface Served { list: Tool[]; byName: Map<string, { full: string; entry: Offered }>; set: ToolSet }
const served = new WeakMap<RunGrant, Promise<Served>>();
const inFlight = new WeakMap<RunGrant, number>();

const errorResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

async function servedFor(grant: RunGrant, host: RunToolsHost): Promise<Served> {
  const cached = served.get(grant);
  if (cached) return cached;
  const p = (async (): Promise<Served> => {
    const servers: RunToolsHost['servers'] = {};
    for (const name of Object.keys(RUN_TOOL_ALLOW)) { const s = host.servers[name]; if (s) servers[name] = s; }
    const set = await connectTools(servers, host.onNotice);
    const specs = new Map(set.specs.map((s) => [s.function.name, s.function]));
    const byName = new Map<string, { full: string; entry: Offered }>();
    const list: Tool[] = [];
    for (const [full, entry] of set.offered) {
      const m = /^mcp__([a-z_]+?)__(.+)$/.exec(full);
      const server = m?.[1] ?? '';
      if (!m || !RUN_TOOL_ALLOW[server]?.includes(entry.remote)) continue;
      if (byName.has(entry.remote)) { host.onNotice(`The tool ${entry.remote} exists on two Legion tool servers; only the first is offered to this agent.`); continue; }
      byName.set(entry.remote, { full, entry });
      const spec = specs.get(full);
      list.push({ name: entry.remote, ...shownTool(entry.remote, spec?.description ?? '', (spec?.parameters as Tool['inputSchema'] | undefined) ?? { type: 'object', properties: {} }) });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { list, byName, set };
  })();
  served.set(grant, p);
  p.catch(() => { if (served.get(grant) === p) served.delete(grant); });
  // the tools live exactly as long as the key
  grant.onRevoke(() => { void p.then((s) => s.set.close(), () => undefined); });
  return p;
}

/**
 * The MCP server for one request. `requestGone` aborts when the shim's connection closes; the run's own end arrives through the grant.
 * With no run attached the server lists nothing and refuses every call (the route has already turned such a key away).
 */
export function serverForRun(grant: RunGrant, requestGone: AbortSignal): Server {
  const server = new Server({ name: 'legion', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const host = grant.host();
    if (!host) return { tools: [] };
    return { tools: (await servedFor(grant, host)).list };
  });
  // The shim sends one request per call and closes none of them when the host cancels; the cancel arrives as a notification on
  // its own request, to a server that has never seen the call. So it is matched on the key's table, not on this server.
  server.setNotificationHandler(CancelledNotificationSchema, (n) => {
    for (const ac of waiting.get(grant)?.get(String(n.params.requestId)) ?? []) ac.abort();
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const host = grant.host();
    const bare = String(req.params.name ?? '');
    if (!host) return errorResult('This run has ended, so its Legion tools are no longer available.');
    const rt = await servedFor(grant, host);
    const found = rt.byName.get(bare);
    const id = `acp-${randomUUID()}`; // a fresh id per call: taint is noted once per id
    let input = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (bare === 'ask') input = { ...input, timeoutSeconds: clampWait(input.timeoutSeconds) }; // before the decision sees it
    const label = found?.full ?? `mcp__legion__${bare.slice(0, 64)}`;
    host.onToolCall(label, id, input);
    const redact = host.redact ?? logRedact; // never identity: a host that forgets still masks the registered secrets
    const finish = (r: { text: string; isError: boolean }) => {
      const shown = redact(clipText(r.text, MAX_TOOL_RESULT_CHARS));
      host.onToolResult(id, shown);
      return { content: [{ type: 'text' as const, text: shown || '(no output)' }], ...(r.isError ? { isError: true } : {}) };
    };
    if (!found) return finish({ text: `Error: ${bare.slice(0, 80)} is not a tool you have. Your tools are: ${[...rt.byName.keys()].join(', ') || 'none'}.`, isError: true });
    const busy = inFlight.get(grant) ?? 0;
    if (busy >= MAX_IN_FLIGHT) return finish({ text: `Error: too many tool calls at once (limit ${MAX_IN_FLIGHT}); this one was not run.`, isError: true });
    inFlight.set(grant, busy + 1);
    const cancelled = new AbortController();
    const table = waiting.get(grant) ?? new Map<string, Set<AbortController>>();
    waiting.set(grant, table);
    const rid = String(extra.requestId);
    table.set(rid, (table.get(rid) ?? new Set()).add(cancelled));
    try {
      const signal = AbortSignal.any([host.signal, grant.signal, requestGone, extra.signal, cancelled.signal]);
      const call = {
        noteToolUse: (n: string, i: string, x: unknown) => host.noteToolUse(n, i, x), authorize: (n: string, x: Record<string, unknown>) => host.authorize(n, x), signal,
        cancelled: () => grant.signal.aborted || host.cancelled(),
      };
      let done: { text: string; isError: boolean; cancelled?: true };
      try { done = await callWithEnforcement(call, found.entry, found.full, id, input); }
      catch { done = { text: 'Error: this call could not be approved, so it was not run.', isError: true }; } // a decision that fails is a refusal
      if (done.cancelled) return finish({ text: 'This run has ended, so the call was cancelled.', isError: true });
      return finish(done);
    } finally {
      table.get(rid)?.delete(cancelled);
      if (table.get(rid)?.size === 0) table.delete(rid);
      inFlight.set(grant, (inFlight.get(grant) ?? 1) - 1);
    }
  });
  return server;
}
