/**
 * The host shell/file tools ("host" MCP server): let an agent run a command and read/write files on THIS machine, so
 * it can work here the way a coding agent does. Everything runs behind the engine's approval gate: the tool names are
 * deliberately NOT Legion's own (`mcp__legion__*` would pass for Legion's and skip the card), so `needsApproval`
 * raises a card before a call and `taintsRun` marks the run. `read_file`/`write_file`/`shell` are confined to a scope
 * root; the approval card is the human's check on what the command actually does.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ExecutionBackend } from './types.js';
import { clampExecLimits, type ExecLimits } from './limits.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

export interface HostToolsCtx {
  agentId: string;
  taskId: string;
  /** Where commands run and file paths must stay: the task workspace / repo root. */
  rootDir: string;
  backend: ExecutionBackend;
  /** Tunable limits (timeout, output window, write cap). Clamped to defaults when omitted. */
  limits?: ExecLimits;
}

/** Resolve `target` against `root`, and refuse anything that escapes it (lexical resolution, no symlink chase). */
export function resolveWithin(root: string, target: string): string {
  const r = resolve(root);
  const t = resolve(r, target);
  const inside = t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
  if (!inside) throw new Error(`Path "${target}" is outside the allowed root`);
  return t;
}

const tail = (s: string, max: number): string =>
  (s.length <= max ? s : `[truncated: last ${max} of ${s.length} chars]\n` + s.slice(-max));

export function buildHostToolsServer(ctx: HostToolsCtx): McpSdkServerConfigWithInstance {
  const limits = clampExecLimits(ctx.limits);
  const run = async (fn: () => Promise<string>): Promise<ToolResult> => {
    try { return ok(await fn()); } catch (e) { return fail(e); }
  };

  const shell = tool(
    'shell',
    'Run a shell command on this machine and return its exit code and output. A short timeout is enforced; the command is killed with its process tree if it overruns.',
    {
      command: z.string().min(1).describe('The shell command line'),
      cwd: z.string().optional().describe('Working directory (must stay inside the allowed root)'),
      timeoutSeconds: z.number().positive().max(3600).optional().describe(`Kill the command after this many seconds (default ${limits.timeoutSeconds})`),
    },
    (a) => run(async () => {
      const cwd = a.cwd === undefined ? ctx.rootDir : resolveWithin(ctx.rootDir, a.cwd);
      const r = await ctx.backend.execute({ cmd: a.command, cwd, timeoutMs: (a.timeoutSeconds ?? limits.timeoutSeconds) * 1000 });
      return `exit code: ${r.exit_code}${r.timedOut ? ' (timed out)' : ''}\n${tail(r.output, limits.maxOutputChars)}`;
    }),
  );

  const readFileTool = tool(
    'read_file',
    'Read a UTF-8 text file on this machine (within the allowed root). Long files are truncated.',
    { path: z.string().describe('File path (must stay inside the allowed root)') },
    (a) => run(async () => tail(await readFile(resolveWithin(ctx.rootDir, a.path), 'utf8'), limits.maxOutputChars)),
  );

  const writeFileTool = tool(
    'write_file',
    'Write a UTF-8 text file on this machine (within the allowed root). Overwrites the file.',
    {
      path: z.string().describe('File path (must stay inside the allowed root)'),
      content: z.string().describe('File content'),
    },
    (a) => run(async () => {
      if (a.content.length > limits.maxWriteChars) throw new Error(`Content is too large (${a.content.length} > ${limits.maxWriteChars} chars)`);
      const p = resolveWithin(ctx.rootDir, a.path);
      await writeFile(p, a.content, 'utf8');
      return `Wrote ${a.content.length} chars to ${p}`;
    }),
  );

  return createSdkMcpServer({
    name: 'host',
    version: '0.1.0',
    alwaysLoad: true, // never deferred behind ToolSearch: agents call these directly
    tools: [shell, readFileTool, writeFileTool],
  });
}
