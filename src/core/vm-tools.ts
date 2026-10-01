/** In-process SDK MCP server ("legion") giving an agent its vm_* tools. */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { VmManager } from './vm-manager.js';

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

export function buildVmToolsServer(agentId: string, vms: VmManager): McpSdkServerConfigWithInstance {
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
    () => run(async () => JSON.stringify(await vms.ensureRunning(agentId), null, 2)),
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
      return `exit code: ${r.exitCode}\n--- stdout ---\n${truncateTail(r.stdout ?? '')}\n--- stderr ---\n${truncateTail(r.stderr ?? '')}`;
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
      await vms.ensureRunning(agentId);
      return truncateTail(await vms.claude(agentId, args.prompt, { model: args.model }));
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
    () => run(async () => JSON.stringify(await vms.stop(agentId), null, 2), { touch: false }),
  );

  return createSdkMcpServer({
    name: 'legion',
    version: '0.1.0',
    tools: [vmStart, vmExec, vmWriteFile, vmReadFile, vmClaude, vmDesktop, vmStop],
  });
}
