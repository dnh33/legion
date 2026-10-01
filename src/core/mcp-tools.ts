/** MCP server exposing Legion to Claude Code / Cowork. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { slugify, nowIso } from '../shared/util.js';
import { VERSION } from '../shared/config.js';
import type { AgentProfile, ChatMessage, Task } from '../shared/types.js';
import { EngineError } from './engine.js';
import type { CoreContext } from './server.js';
import { agentVisible as agentVisibleIn, taskVisible } from './visibility.js';
import { VmError } from './vm-manager.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const json = (v: unknown): ToolResult => ok(JSON.stringify(v, null, 2));

function errText(e: unknown): string {
  if (e instanceof EngineError) return `Error (${e.status}): ${e.message}`;
  if (e instanceof VmError) return `VM error (${e.code}): ${e.message}`;
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}

/** Wrap a handler so it never throws. */
function safe<A>(fn: (a: A) => Promise<ToolResult> | ToolResult): (a: A) => Promise<ToolResult> {
  return async (a: A) => {
    try { return await fn(a); } catch (e) { return fail(errText(e)); }
  };
}

/** Agents switched off by an optional feature (the Assayer needs BSV mode) do not exist for MCP callers while it is off. */
const agentVisible = (ctx: CoreContext, a: AgentProfile): boolean => agentVisibleIn(ctx, a);
/** A task of a hidden agent is "unknown", with exactly the text an id that never existed gets. */
const knownTask = (ctx: CoreContext, id: string) => { const t = ctx.store.getTask(id); return t && taskVisible(ctx, t) ? t : undefined; };
const visibleAgents = (ctx: CoreContext): AgentProfile[] => ctx.store.listAgents().filter((a) => agentVisible(ctx, a));

function findAgent(ctx: CoreContext, ref: string): AgentProfile | undefined {
  const agents = visibleAgents(ctx);
  const r = ref.trim();
  return agents.find((a) => a.id === r) ?? agents.find((a) => a.id.toLowerCase() === r.toLowerCase() || a.name.toLowerCase() === r.toLowerCase());
}

function needAgent(ctx: CoreContext, ref: string): AgentProfile {
  const a = findAgent(ctx, ref);
  if (!a) {
    const names = visibleAgents(ctx).map((x) => `${x.id} (${x.name})`).join(', ');
    throw new Error(`Unknown agent "${ref}". Available agents: ${names || 'none'}.`);
  }
  return a;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…[truncated]' : s);

function taskSummary(t: Task) {
  return {
    taskId: t.id, agent: t.agentId, status: t.status, model: t.model, requestedModel: t.requestedModel,
    escalated: t.escalated, costUsd: t.costUsd, turns: t.turns, title: t.title,
    result: t.result, error: t.error, updatedAt: t.updatedAt,
  };
}

function formatRun(t: Task, timedOut: boolean): ToolResult {
  const head = {
    taskId: t.id, agent: t.agentId, status: t.status, model: t.model, escalated: t.escalated,
    costUsd: t.costUsd, turns: t.turns,
  };
  if (t.status === 'queued' || t.status === 'running') {
    return ok(
      `${timedOut ? 'Timed out waiting' : 'Still in progress'} — the task keeps running in the background.\n` +
      `${JSON.stringify(head)}\nUse legion_status with taskId "${t.id}" to check progress, legion_continue to follow up once done, or legion_cancel to stop it.`,
    );
  }
  if (t.status === 'error') return { content: [{ type: 'text', text: `Task failed: ${t.error ?? 'unknown error'}\n${JSON.stringify(head)}` }], isError: true };
  if (t.status === 'cancelled') return ok(`Task was cancelled.\n${JSON.stringify(head)}`);
  return ok(`${t.result ?? '(no text result)'}\n\n---\n${JSON.stringify(head)}`);
}

async function runAndMaybeWait(ctx: CoreContext, t: Task, wait: boolean, timeoutSeconds: number): Promise<ToolResult> {
  if (!wait) {
    return ok(`Started. ${JSON.stringify({ taskId: t.id, agent: t.agentId, status: t.status })}\nPoll with legion_status, or continue with legion_continue once finished.`);
  }
  const final = await ctx.engine.waitFor(t.id, Math.max(1, timeoutSeconds) * 1000);
  return formatRun(final, final.status === 'queued' || final.status === 'running');
}

const modelParam = z.string().max(80).regex(/^[A-Za-z0-9._:\[\]-]+$/)
  .describe('"auto", an alias ("sonnet", "opus", ...) or a model value from legion_models.').optional();

export function buildLegionMcpServer(ctx: CoreContext): McpServer {
  const server = new McpServer({ name: 'legion', version: VERSION });

  server.registerTool('legion_list_agents', {
    title: 'List Legion agents',
    description:
      'List the agents available in Legion, the user\'s personal local multi-agent bot. Each agent is a Claude-powered worker with its own ' +
      'persona (system prompt), model policy (auto = Legion picks Sonnet or Opus per task; or fixed sonnet/opus), approval mode, working ' +
      'directory and optionally its own on-demand cloud VM (boat.dev) for risky, long-running, GUI or browser work. ' +
      'Returns id, name, description, model, approval mode and current VM state for each. Call this first to learn which agent to hand work to with legion_run.',
    annotations: { readOnlyHint: true },
  }, safe(async () => json(visibleAgents(ctx).map((a) => ({
    id: a.id, name: a.name, emoji: a.emoji, description: a.description, model: a.model, approval: a.approval,
    vm: { enabled: a.vm.enabled, size: a.vm.size, state: safeVmState(ctx, a.id) },
  })))));

  server.registerTool('legion_models', {
    title: 'List available Claude models',
    description:
      'List the Claude models the signed-in account can use (value, display name, description). Pass a value as the `model` argument of legion_run or legion_create_agent; ' +
      '"auto" (Legion picks Sonnet or Opus per task) is always valid too. Set refresh=true to re-probe instead of using the 10-minute cache.',
    inputSchema: { refresh: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, safe(async (a: { refresh?: boolean }) => {
    const c = await ctx.catalog(a.refresh ?? false);
    return json({
      auto: 'Legion routes between sonnet and opus per task and escalates sonnet -> opus on failure.',
      models: c.models, ...(c.error ? { error: c.error } : {}),
    });
  }));

  server.registerTool('legion_create_agent', {
    title: 'Create a Legion agent',
    description:
      'Create a new specialised agent in Legion. Give it a clear name, a one-line description, and a systemPrompt describing its role and rules. ' +
      'model: "auto" (default; Legion routes between Sonnet and Opus and escalates on failure), "sonnet" (fast/cheap), "opus" (strongest), or any model value from legion_models. ' +
      'vmEnabled: true lets the agent start its own cloud VM on demand (requires boat.dev configured in Legion). The new agent asks for approval before risky actions by default. Returns the created agent profile.',
    inputSchema: {
      name: z.string().min(1).describe('Display name, e.g. "Researcher". The id is derived from it.'),
      description: z.string().optional().describe('One line: what this agent is for.'),
      systemPrompt: z.string().optional().describe('Instructions appended to the agent\'s system prompt.'),
      model: modelParam,
      vmEnabled: z.boolean().optional().describe('Allow this agent to use an on-demand cloud VM.'),
    },
  }, safe(async (a: { name: string; description?: string; systemPrompt?: string; model?: string; vmEnabled?: boolean }) => {
    const taken = new Set(ctx.store.listAgents().map((x) => x.id));
    const base = slugify(a.name);
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    const now = nowIso();
    const agent: AgentProfile = {
      id, name: a.name.trim(), emoji: '◆', description: a.description ?? '', systemPrompt: a.systemPrompt ?? '',
      model: a.model ?? 'auto',
      vm: { enabled: a.vmEnabled ?? false, size: 'default', idleStopMinutes: 15 },
      approval: 'ask', mcpServers: ['*'], createdAt: now, updatedAt: now,
    };
    const saved = ctx.store.upsertAgent(agent);
    ctx.bus.emit({ type: 'agent.updated', agent: saved });
    return json(saved);
  }));

  server.registerTool('legion_run', {
    title: 'Run a task on a Legion agent',
    description:
      'Hand a task to a Legion agent (by id or name, case-insensitive) and get the result. The agent is a full Claude Code-style worker: it can read/write files in its ' +
      'workspace, run commands, use MCP tools, and (if enabled) spin up its own cloud VM. By default this call BLOCKS until the task finishes (up to timeoutSeconds, default 600) ' +
      'and returns the final answer plus taskId, model used and cost. If it times out the task keeps running; use the returned taskId with legion_status / legion_continue / legion_cancel. ' +
      'Set wait=false to fire-and-forget several tasks in parallel (max 4 run concurrently, the rest queue) and collect them later with legion_status. ' +
      'model overrides the agent default: "auto", "sonnet", "opus" or any value listed by legion_models (prefix the prompt with /opus, /sonnet or /model <value> also works). ' +
      'Note: agents with approval "ask"/"auto-edits" may pause waiting for the user to click Allow in the Legion app.',
    inputSchema: {
      agent: z.string().describe('Agent id or name (see legion_list_agents).'),
      prompt: z.string().min(1).describe('The full task. Be specific; the agent has no other context.'),
      model: modelParam,
      wait: z.boolean().optional().describe('Block until done (default true).'),
      timeoutSeconds: z.number().positive().max(3600).optional().describe('Max seconds to wait (default 600).'),
    },
  }, safe(async (a: { agent: string; prompt: string; model?: string; wait?: boolean; timeoutSeconds?: number }) => {
    const agent = needAgent(ctx, a.agent);
    const t = ctx.engine.startTask({ agentId: agent.id, prompt: a.prompt, source: 'mcp', model: a.model });
    return runAndMaybeWait(ctx, t, a.wait ?? true, a.timeoutSeconds ?? 600);
  }));

  server.registerTool('legion_continue', {
    title: 'Follow up on a Legion task',
    description:
      'Send a follow-up prompt to a finished task, resuming the same Claude session so the agent keeps full context (files, earlier reasoning). ' +
      'Use the taskId returned by legion_run. The task must not be still running (check legion_status). Blocks until done by default, like legion_run.',
    inputSchema: {
      taskId: z.string().describe('taskId from legion_run / legion_status.'),
      prompt: z.string().min(1),
      wait: z.boolean().optional(),
      timeoutSeconds: z.number().positive().max(3600).optional(),
    },
  }, safe(async (a: { taskId: string; prompt: string; wait?: boolean; timeoutSeconds?: number }) => {
    // a task of a hidden agent (the Assayer while BSV mode is off) cannot be resumed from here either
    const prev = knownTask(ctx, a.taskId);
    if (!prev) return fail(`Unknown task "${a.taskId}". Use legion_recent_tasks to list tasks.`);
    const t = ctx.engine.startTask({ agentId: prev.agentId, prompt: a.prompt, source: 'mcp', continueTaskId: prev.id });
    return runAndMaybeWait(ctx, t, a.wait ?? true, a.timeoutSeconds ?? 600);
  }));

  server.registerTool('legion_status', {
    title: 'Get task status',
    description:
      'Inspect a Legion task: status (queued | running | done | error | cancelled), model, cost, result/error and the last 20 messages (assistant text and tool calls, each truncated to 2000 chars). ' +
      'Use it to poll a task started with wait=false or one that timed out.',
    inputSchema: { taskId: z.string() },
    annotations: { readOnlyHint: true },
  }, safe(async (a: { taskId: string }) => {
    const t = knownTask(ctx, a.taskId);
    if (!t) return fail(`Unknown task "${a.taskId}".`);
    const msgs: ChatMessage[] = ctx.store.listMessages(t.id).slice(-20);
    return json({
      task: taskSummary(t),
      messages: msgs.map((m) => ({ role: m.role, toolName: m.toolName, at: m.at, text: clip(m.text, 2000) })),
    });
  }));

  server.registerTool('legion_cancel', {
    title: 'Cancel a task',
    description: 'Cancel a queued or running Legion task. Returns whether anything was cancelled (false if it had already finished).',
    inputSchema: { taskId: z.string() },
  }, safe(async (a: { taskId: string }) => {
    if (!knownTask(ctx, a.taskId)) return fail(`Unknown task "${a.taskId}".`);
    return ok(ctx.engine.cancel(a.taskId) ? `Cancelled ${a.taskId}.` : `Task ${a.taskId} was not running (nothing to cancel).`);
  }));

  server.registerTool('legion_vm', {
    title: 'Control an agent\'s cloud VM',
    description:
      'Manage the on-demand boat.dev cloud VM belonging to an agent (only agents with VM enabled; needs boat.dev configured in Legion). ' +
      'Actions: "status" (current state: none/provisioning/running/archived/…), "start" (create or resume and wait until ready; billing runs while it is up), ' +
      '"stop" (snapshot and stop; billing pauses), "exec" (run a shell `command` inside the VM, auto-starts it; returns exitCode/stdout/stderr), ' +
      '"desktop" (get a secret streaming URL for the VM\'s desktop — give it to the user, do not share). Legion also stops idle VMs automatically.',
    inputSchema: {
      agent: z.string().describe('Agent id or name.'),
      action: z.enum(['status', 'start', 'stop', 'exec', 'desktop']),
      command: z.string().optional().describe('Shell command; required for action "exec".'),
    },
  }, safe(async (a: { agent: string; action: 'status' | 'start' | 'stop' | 'exec' | 'desktop'; command?: string }) => {
    const agent = needAgent(ctx, a.agent);
    switch (a.action) {
      case 'status': return json(ctx.vms.status(agent.id));
      case 'start': return json(await ctx.vms.ensureRunning(agent.id));
      case 'stop': return json(await ctx.vms.stop(agent.id));
      case 'desktop': return ok(await ctx.vms.desktopUrl(agent.id));
      case 'exec': {
        if (!a.command) return fail('action "exec" requires a "command".');
        return json(await ctx.vms.exec(agent.id, a.command));
      }
    }
  }));

  server.registerTool('legion_recent_tasks', {
    title: 'List recent tasks',
    description: 'List the most recent Legion tasks (newest first) with id, agent, status, model and title. Use to find a taskId for legion_status / legion_continue.',
    inputSchema: { limit: z.number().int().positive().max(200).optional().describe('Default 10.') },
    annotations: { readOnlyHint: true },
  }, safe(async (a: { limit?: number }) => json(
    ctx.store.listTasks(200).filter((t) => taskVisible(ctx, t)).slice(0, a.limit ?? 10).map((t) => ({
      taskId: t.id, agent: t.agentId, status: t.status, model: t.model, title: t.title, updatedAt: t.updatedAt,
    })),
  )));

  return server;
}

function safeVmState(ctx: CoreContext, id: string): string {
  try { return ctx.vms.status(id).state; } catch { return 'unknown'; }
}
