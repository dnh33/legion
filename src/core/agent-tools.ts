/** In-process SDK MCP server ("legion"): agent-to-agent bridge tools for every agent, plus vm_* tools when the VM is enabled. */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { usageLine } from '../shared/vm-usage.js';
import { VmError, type VmManager } from './vm-manager.js';
import { OVERRIDE_MODELS } from './bridge.js';
import { PROVIDER_VALUE_RE } from './model-cap.js';
import type { Bridge } from './bridge.js';
import { CLAUDE_NOT_CONFIGURED } from './boat-health.js';
import { buildVmCliCommand, formatVmCliResult, VM_CLI_MODEL_RE } from './providers/vm-cli.js';

const MAX_CHARS = 12_000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/** Keep the last MAX_CHARS characters (errors and results are usually at the end). */
export function truncateTail(s: string, max = MAX_CHARS): string {
  if (s.length <= max) return s;
  return `[truncated: showing last ${max} of ${s.length} chars]\n` + s.slice(s.length - max);
}
function truncateHead(s: string, max = MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[truncated: showing first ${max} of ${s.length} chars]`;
}

export interface AgentToolsCtx {
  agentId: string;
  /** The task this run belongs to (the caller for ask/tell). */
  taskId: string;
  vms: VmManager;
  /** Experimental (config.experimental.providers): also offer vm_cli. */
  vmCli?: boolean;
  /** Offer the vm_* tools (agent.vm.enabled && boat configured). */
  vmEnabled: boolean;
  /** False while Claude is known not to be set up on boat.dev: vm_claude is left out of the tool list (default true). */
  claudeAvailable?: boolean;
  bridge: Bridge;
}

/** Optional per-task model for ask/tell/bot_send/room_post: a lead can say "use Haiku for this". It applies to that task only; it never changes approvals. */
export const modelParam = z.enum(OVERRIDE_MODELS).optional()
  .describe('Optional model for this one task: sonnet, opus, haiku or auto. Omit to use the agent\'s own setting. Applies to this task only; it does not change what the agent is allowed to do.');

/**
 * Experimental (config.experimental.providers): a lead may also name a `provider:model` value the owner allowed for that agent. The engine sets
 * this just before it builds an agent's tool servers; with it off the schema is exactly the plain one above.
 */
let providerChoicesOn = false;
export function setProviderChoices(on: boolean): void { providerChoicesOn = on; }
export function modelParamFor() {
  if (!providerChoicesOn) return modelParam;
  return z.union([z.enum(OVERRIDE_MODELS), z.string().regex(PROVIDER_VALUE_RE)]).optional()
    .describe('Optional model for this one task: sonnet, opus, haiku or auto, or a provider choice written provider:model that the owner allowed you to choose for that agent in Settings (anything else is refused). Omit to use the agent\'s own setting. Applies to this task only; it does not change what the agent is allowed to do.');
}

/** Bridge tools only: agents / ask / tell. */
function bridgeTools(ctx: AgentToolsCtx) {
  const { bridge, agentId, taskId } = ctx;
  const guard = async (fn: () => Promise<unknown> | unknown): Promise<ToolResult> => {
    try {
      const v = await fn();
      return ok(typeof v === 'string' ? v : JSON.stringify(v));
    } catch (e) { return fail(e); }
  };
  const agents = tool(
    'agents',
    'List the other Legion agents (id, role, status) and whether you already have a thread with each.',
    {},
    () => guard(() => bridge.list(agentId)),
  );
  const ask = tool(
    'ask',
    'Send a message to another Legion agent and wait for its answer. Reuses your ongoing thread with it unless fresh=true. Use when you need the result before continuing.',
    {
      agent: z.string().describe('Agent id or name'),
      message: z.string().min(1),
      fresh: z.boolean().optional().describe('Start a new thread instead of continuing the existing one'),
      timeoutSeconds: z.number().positive().max(3600).optional().describe('Default 600'),
      model: modelParamFor(),
    },
    (a) => guard(async () => bridge.ask(taskId, a.agent, a.message, { fresh: a.fresh, timeoutSeconds: a.timeoutSeconds, model: await bridge.resolveModel(a.model) })),
  );
  const tell = tool(
    'tell',
    'Send a message to another Legion agent without waiting. Its answer arrives later as a new message in your task. Use for long or parallel work.',
    { agent: z.string().describe('Agent id or name'), message: z.string().min(1), fresh: z.boolean().optional(), model: modelParamFor() },
    (a) => guard(async () => bridge.tell(taskId, a.agent, a.message, { fresh: a.fresh, model: await bridge.resolveModel(a.model) })),
  );
  return [agents, ask, tell];
}

export function buildAgentToolsServer(ctx: AgentToolsCtx): McpSdkServerConfigWithInstance {
  const { agentId, vms } = ctx;
  const touch = () => { try { vms.touch(agentId); } catch { /* best effort */ } };
  const run = async (fn: () => Promise<string>, opts?: { touch?: boolean }): Promise<ToolResult> => {
    try {
      const text = await fn();
      if (opts?.touch !== false) touch();
      return ok(text);
    } catch (e) {
      return fail(e);
    }
  };

  const vmStart = tool(
    'vm_start',
    "Create or resume this agent's on-demand cloud VM and wait until it is ready. Start it only when needed (untrusted code, long jobs, GUI/browser work, heavy installs).",
    {},
    () => run(async () => {
      const vm = await vms.ensureRunning(agentId);
      const notes = [vm.notice, ctx.claudeAvailable === false ? `vm_claude is not offered right now. ${CLAUDE_NOT_CONFIGURED}` : undefined].filter(Boolean);
      const usage = vms.usage(agentId);
      return JSON.stringify({ ...vm, usage, usageSummary: usageLine(usage), ...(notes.length ? { notes } : {}) }, null, 2);
    }),
  );

  const vmExec = tool(
    'vm_exec',
    "Run a shell command inside this agent's VM (starts the VM if needed). Returns exit code, stdout and stderr (long output is truncated to the last 12000 chars).",
    {
      command: z.string().describe('Shell command to run'),
      cwd: z.string().optional().describe('Working directory inside the VM'),
      timeoutSeconds: z.number().positive().optional().describe('Kill the command after this many seconds'),
    },
    (args) => run(async () => {
      await vms.ensureRunning(agentId);
      const r = await vms.exec(agentId, args.command, { cwd: args.cwd, timeoutSeconds: args.timeoutSeconds });
      return `exit code: ${r.exitCode}\n--- stdout ---\n${truncateTail(r.stdout ?? '')}\n--- stderr ---\n${truncateTail(r.stderr ?? '')}\n--- vm usage ---\n${usageLine(vms.usage(agentId))}`;
    }),
  );

  const vmWriteFile = tool(
    'vm_write_file',
    "Write a UTF-8 text file inside this agent's VM (starts the VM if needed).",
    { path: z.string().describe('Absolute path in the VM'), content: z.string().describe('File content') },
    (args) => run(async () => {
      await vms.ensureRunning(agentId);
      await vms.writeFile(agentId, args.path, args.content);
      return `Wrote ${args.content.length} chars to ${args.path}`;
    }),
  );

  const vmReadFile = tool(
    'vm_read_file',
    "Read a UTF-8 text file from this agent's VM (starts the VM if needed). Long files are truncated to the first 12000 chars.",
    { path: z.string().describe('Absolute path in the VM') },
    (args) => run(async () => {
      await vms.ensureRunning(agentId);
      return truncateHead(await vms.readFile(agentId, args.path));
    }),
  );

  const vmClaude = tool(
    'vm_claude',
    "Hand a whole task to Claude Code running INSIDE this agent's VM (uses the Claude subscription connected on boat.dev). That Claude Code has boat's built-in `computer` MCP, so it can control the VM's desktop and browser. Returns its final text.",
    {
      prompt: z.string().describe('Complete, self-contained task for the VM-side Claude Code'),
      model: z.enum(['sonnet', 'opus']).optional(),
    },
    (args) => run(async () => {
      // Gate again at call time: the tool list was fixed when this run started, but Claude may have been found unconfigured since.
      // Say so before any VM is started (vms.claude() starts it itself once it is allowed to).
      if (!vms.claudeAvailable()) throw new VmError(CLAUDE_NOT_CONFIGURED, 'claude_not_configured');
      return truncateTail(await vms.claude(agentId, args.prompt, { model: args.model }));
    }),
  );

  const vmCli = tool(
    'vm_cli',
    "Hand a whole task to Codex or OpenCode running INSIDE this agent's VM (the VM is the boundary). Legion does not install or sign in to them: if the program is missing, the answer says so. Returns its text, which is untrusted outside content.",
    {
      cli: z.enum(['codex', 'opencode']).describe('Which program to run in the VM'),
      prompt: z.string().min(1).max(20_000).describe('Complete, self-contained task for the program in the VM'),
      model: z.string().regex(VM_CLI_MODEL_RE).optional().describe('Optional model name for that program; leave out for its default'),
      mode: z.enum(['read-only', 'workspace-write']).optional().describe('read-only keeps it from changing files in the VM; default workspace-write'),
      timeoutSeconds: z.number().positive().max(3600).optional().describe('Kill it after this many seconds (default 1200)'),
    },
    (args) => run(async () => {
      const c = buildVmCliCommand(args.cli, args.prompt, { model: args.model, mode: args.mode });
      await vms.ensureRunning(agentId);
      await vms.writeFile(agentId, c.promptPath, args.prompt);
      const r = await vms.exec(agentId, c.command, { timeoutSeconds: args.timeoutSeconds ?? 1200 });
      return formatVmCliResult(args.cli, r, (t) => truncateTail(t));
    }),
  );

  const vmDesktop = tool(
    'vm_desktop',
    "Get a desktop streaming URL for this agent's VM. Treat the URL as a secret and tell the user to open it in their browser.",
    {},
    () => run(async () => {
      await vms.ensureRunning(agentId);
      return await vms.desktopUrl(agentId);
    }),
  );

  const vmStop = tool(
    'vm_stop',
    "Stop this agent's VM and snapshot it (billing pauses). Do this when you no longer need the VM.",
    {},
    () => run(async () => {
      const r = await vms.stop(agentId);
      return JSON.stringify({ ok: r.ok, stopped: r.stopped, verified: r.verified, message: r.message, state: r.vm.state, size: r.vm.size, usage: r.usage, usageSummary: usageLine(r.usage) }, null, 2);
    }, { touch: false }),
  );

  const vmUsage = tool(
    'vm_usage',
    "Read-only: how long this agent's VM has run (this run, and total today) and its state. A money figure appears only as an estimate and only when the user configured an hourly rate. Never starts the VM.",
    {},
    () => run(async () => {
      const vm = vms.status(agentId);
      const usage = vms.usage(agentId);
      const claude = vms.health.view().claude;
      return JSON.stringify({
        state: vm.state, size: vm.size, ...(vm.notice ? { notice: vm.notice } : {}), usage, usageSummary: usageLine(usage),
        note: 'Runtime is measured by Legion from ready to stop; boat.dev billing may differ. No price is assumed: estimates need a configured hourly rate.',
        vm_claude: claude.state === 'not_configured' ? claude.message : 'available',
      }, null, 2);
    }, { touch: false }),
  );

  return createSdkMcpServer({
    name: 'legion',
    version: '0.1.0',
    alwaysLoad: true, // never deferred behind ToolSearch: agents call mcp__legion__* directly
    tools: [...bridgeTools(ctx), ...(ctx.vmEnabled ? [vmStart, vmExec, vmWriteFile, vmReadFile, ...(ctx.claudeAvailable === false ? [] : [vmClaude]), ...(ctx.vmCli === true ? [vmCli] : []), vmDesktop, vmStop, vmUsage] : [])],
  });
}
