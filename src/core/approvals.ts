/** Human-in-the-loop tool approvals. */
import { BLENDER_EXEC_TOOL } from '../shared/blender.js';
import type { ApprovalMode, ApprovalRequest } from '../shared/types.js';
import { newId, nowIso } from '../shared/util.js';
import type { EventBus } from './bus.js';

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Legion's own in-process MCP servers: vm tools, the comms bridge, the knowledge graph and the guarded Blender bridge (it asks for its own approval inside the tool). */
export const LEGION_TOOL_PREFIXES = ['mcp__legion__', 'mcp__legion_comms__', 'mcp__legion_kg__', 'mcp__legion_blender__'];
const LEGION_TOOL_NAME = /^mcp__legion(?:_comms|_kg|_blender)?__[a-z][a-z0-9_]*$/;
/**
 * One of Legion's own in-process tools: the exact server name, then a plain tool name. A prefix test alone also matches
 * "mcp__legion__x__run", a tool of some other server that happens to be called "legion__x"; its tool part holds "__".
 */
export function isLegionTool(toolName: string): boolean {
  return LEGION_TOOL_NAME.test(toolName) && !toolName.split('__').slice(2).join('__').includes('__');
}

const MODE_RANK: Record<ApprovalMode, number> = { ask: 0, 'auto-edits': 1, full: 2 };
/** The stricter (less permissive) of two approval modes. */
export function stricterMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/** VM tools that burn billing or hand a whole task to another Claude inside the VM. A run capped by another party (an MCP client, or a bot woken by one) needs a card for these. */
const CAPPED_CARDED = new Set(['mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_cli', 'mcp__legion__vm_desktop']);
/** Legion's own tool that hands a task to another agent program in the VM: a card in every mode except full access (and for any capped run). */
const CARDED_UNLESS_FULL = new Set(['mcp__legion__vm_cli']);

/**
 * `capped`: the run has an approval ceiling from someone else (it came from an MCP client or was woken by another bot). Then vm_exec,
 * vm_claude and vm_desktop need a card even though they are Legion's own tools; everything else follows the mode as before.
 */
export function needsApproval(mode: ApprovalMode, toolName: string, opts: { capped?: boolean } = {}): boolean {
  if (opts.capped && CAPPED_CARDED.has(toolName)) return true;
  if (mode === 'full') return false;
  if (CARDED_UNLESS_FULL.has(toolName)) return true;
  if (READ_ONLY.has(toolName) || isLegionTool(toolName)) return false;
  if (EDIT_TOOLS.has(toolName)) return mode === 'ask';
  // Bash, other mcp__*, and unknown tools
  return true;
}

function compactJson(v: unknown, max: number): string {
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const cap = (s: string) => (s.length > 400 ? s.slice(0, 399) + '…' : s);
  if (toolName === 'Bash' && typeof input?.command === 'string') return cap(input.command);
  if ((toolName === 'Write' || toolName === 'Edit') && typeof input?.file_path === 'string') return cap(input.file_path);
  if (toolName === 'mcp__legion__vm_cli') {
    const i = input as { cli?: string; prompt?: string; mode?: string };
    return cap(`Run ${i.cli ?? 'a CLI'} (${i.mode ?? 'workspace-write'}) inside this agent's VM: ${String(i.prompt ?? '').replace(/\s+/g, ' ')}`);
  }
  if (toolName === 'LegionCliStart') {
    const i = input as { title?: string; command?: string; folder?: string; sandbox?: string };
    return cap(`${i.title ?? 'Start a CLI program'}: ${i.command ?? ''} | folder: ${i.folder ?? ''} | sandbox: ${i.sandbox ?? ''}. It runs its own shell and file tools outside Legion's approvals.`);
  }
  if (toolName === BLENDER_EXEC_TOOL && typeof input?.script === 'string') {
    const lines = input.script.split('\n');
    const first = lines.find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? '';
    return cap(`Blender script (${input.mode === 'live' ? 'LIVE' : 'sandbox'}, ${lines.length} lines): ${first}`);
  }
  return compactJson(input ?? {}, 400);
}

interface Pending { req: ApprovalRequest; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }

export class ApprovalBroker {
  private readonly items = new Map<string, Pending>();
  private readonly timeoutMs: number;
  constructor(private readonly bus: EventBus, opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  }

  request(
    taskId: string, agentId: string, toolName: string, input: Record<string, unknown>,
    origin?: ApprovalRequest['origin'],
    opts: { onTimeout?: () => void; /** A written-out card text (a room request), instead of the compact JSON of the input. */ summary?: string } = {},
  ): Promise<boolean> {
    const req: ApprovalRequest = {
      id: newId('apr'), taskId, agentId, toolName,
      summary: opts.summary ?? summarizeToolInput(toolName, input), input, at: nowIso(),
      ...(origin ? { origin } : {}),
    };
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => { try { opts.onTimeout?.(); } catch { /* advisory */ } this.settle(req.id, false); }, this.timeoutMs);
      this.items.set(req.id, { req, resolve: resolvePromise, timer });
      this.bus.emit({ type: 'approval.requested', approval: req });
    });
  }

  resolve(id: string, allow: boolean): boolean { return this.settle(id, allow); }

  cancelForTask(taskId: string): void {
    for (const [id, p] of [...this.items]) if (p.req.taskId === taskId) this.settle(id, false);
  }

  pending(): ApprovalRequest[] { return [...this.items.values()].map((p) => p.req); }

  private settle(id: string, allow: boolean): boolean {
    const p = this.items.get(id);
    if (!p) return false;
    this.items.delete(id);
    clearTimeout(p.timer);
    this.bus.emit({ type: 'approval.resolved', approvalId: id, allowed: allow });
    p.resolve(allow);
    return true;
  }
}
