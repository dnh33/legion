/** Human-in-the-loop tool approvals. */
import type { ApprovalMode, ApprovalRequest } from '../shared/types.js';
import { newId, nowIso } from '../shared/util.js';
import type { EventBus } from './bus.js';

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Legion's own in-process MCP servers: vm tools, the comms bridge and the knowledge graph. */
export const LEGION_TOOL_PREFIXES = ['mcp__legion__', 'mcp__legion_comms__', 'mcp__legion_kg__'];

const MODE_RANK: Record<ApprovalMode, number> = { ask: 0, 'auto-edits': 1, full: 2 };
/** The stricter (less permissive) of two approval modes. */
export function stricterMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

export function needsApproval(mode: ApprovalMode, toolName: string): boolean {
  if (mode === 'full') return false;
  if (READ_ONLY.has(toolName) || LEGION_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return false;
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
  ): Promise<boolean> {
    const req: ApprovalRequest = {
      id: newId('apr'), taskId, agentId, toolName,
      summary: summarizeToolInput(toolName, input), input, at: nowIso(),
      ...(origin ? { origin } : {}),
    };
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => this.settle(req.id, false), this.timeoutMs);
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
