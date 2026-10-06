/** Human-in-the-loop tool approvals. */
import { BLENDER_EXEC_TOOL } from '../shared/blender.js';
import { BROWSER_SERVER_NAME, BROWSER_TOOLS } from '../shared/browser.js';
import type { ApprovalMode, ApprovalRequest } from '../shared/types.js';
import { newId, nowIso } from '../shared/util.js';
import type { EventBus } from './bus.js';

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Legion's own in-process MCP servers: vm tools, the comms bridge, the knowledge graph, the project board, the house context layer and the guarded Blender bridge (it asks for its own approval inside the tool). */
export const LEGION_TOOL_PREFIXES = ['mcp__legion__', 'mcp__legion_comms__', 'mcp__legion_kg__', 'mcp__legion_board__', 'mcp__legion_house__', 'mcp__legion_armory__', 'mcp__legion_blender__'];
const LEGION_TOOL_NAME = new RegExp(`^(?:${LEGION_TOOL_PREFIXES.join('|')})[a-z][a-z0-9_]*$`);
/**
 * One of Legion's own in-process tools: the exact server name, then a plain tool name. A prefix test alone also matches
 * "mcp__legion__x__run", a tool of some other server that happens to be called "legion__x"; its tool part holds "__".
 */
export function isLegionTool(toolName: string): boolean {
  return LEGION_TOOL_NAME.test(toolName) && !toolName.split('__').slice(2).join('__').includes('__');
}

/**
 * The browser tool's own tools (exact names). The module asks its own cards (first page, new site, script) with the page URL in them, so the generic
 * per-call card is not added on top. Deliberately NOT part of isLegionTool: the engine still taints the run on the first call.
 */
const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(BROWSER_TOOLS.map((t) => `mcp__${BROWSER_SERVER_NAME}__${t}`));

const MODE_RANK: Record<ApprovalMode, number> = { ask: 0, 'auto-edits': 1, full: 2 };
/** The stricter (less permissive) of two approval modes. */
export function stricterMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/** VM tools that burn billing or hand a whole task to another Claude inside the VM. A run capped by another party (an MCP client, or a bot woken by one) needs a card for these. */
const CAPPED_CARDED = new Set(['mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop']);

/**
 * The mode a guard must judge by, and the one place that decides whether a guard shows a card at all.
 *
 * OWNER RULE (2026-10-04): **one rule, no exceptions — in `full` a guard never shows a card.** Every guard in
 * Legion goes through here, so a new guard cannot forget the mode the way four of them did (Blender exec and
 * asset, the comms room tools and the project board all asked unconditionally, so a full-access bot still got a
 * "Needs your OK" card; the browser module already did this correctly and was the proof the pattern was known).
 *
 * `modeOf` re-reads the store on EVERY call, so switching an agent from `ask` to `full` mid-task takes effect on
 * its next guarded call. A snapshot taken at run start would keep carding a bot the owner has just promoted.
 * `ceiling` (a run started by an MCP client or another bot) always wins over the agent's own setting — the
 * confused-deputy guard — so a promoted-but-capped run still asks.
 */
export interface GuardDecision {
  /** False when the run is `full` and uncapped: the caller must NOT ask, and must go straight to the action. */
  needsCard: boolean;
  /** The mode actually in force, for the reason a card was or was not shown. */
  mode: ApprovalMode;
}

/** Reads the agent's live approval mode from the store. Returns undefined when the agent is gone. */
export type ModeOf = (agentId: string) => ApprovalMode | undefined;

/**
 * The one function a guard calls instead of asking on its own. `ask` is called only when a card is genuinely
 * required; a guard that skips this and calls `broker.request` directly is the bug this exists to prevent.
 *
 * `summary`/`input`/`origin`/`onTimeout` are forwarded untouched, so the card the owner sees is unchanged.
 */
export async function guardAsk(
  opts: {
    ceiling?: ApprovalMode;
    /** The live store read. Omit only where no store is reachable; the agent's own setting is then used. */
    modeOf?: ModeOf;
    agentId: string;
    /** The agent's setting as it stood when the run started. Used only if `modeOf` cannot answer. */
    fallbackMode: ApprovalMode;
    /** Shows the card and resolves with the owner's answer. Never called in `full`. */
    ask: () => Promise<boolean>;
  },
): Promise<boolean> {
  const live = opts.modeOf?.(opts.agentId);
  const base = live ?? opts.fallbackMode;
  const effective = opts.ceiling ? stricterMode(base, opts.ceiling) : base;
  if (decideGuard(effective).needsCard) return opts.ask();
  return true;
}

/** The pure half of `guardAsk`, split out so it can be asserted directly. `full` never cards. */
export function decideGuard(mode: ApprovalMode): GuardDecision {
  return { needsCard: mode !== 'full', mode };
}

/**
 * `capped`: the run has an approval ceiling from someone else (it came from an MCP client or was woken by another bot). Then vm_exec,
 * vm_claude and vm_desktop need a card even though they are Legion's own tools; everything else follows the mode as before.
 */
export function needsApproval(mode: ApprovalMode, toolName: string, opts: { capped?: boolean } = {}): boolean {
  if (opts.capped && CAPPED_CARDED.has(toolName)) return true;
  if (BROWSER_TOOL_NAMES.has(toolName)) return false;
  if (mode === 'full') return false;
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
  if (toolName === BLENDER_EXEC_TOOL && typeof input?.script === 'string') {
    const lines = input.script.split('\n');
    const first = lines.find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? '';
    return cap(`Blender script (${input.mode === 'live' ? 'LIVE' : 'sandbox'}, ${lines.length} lines): ${first}`);
  }
  return compactJson(input ?? {}, 400);
}

/** The wait as plain words for a message to the model or the owner: "10 minutes", "1 minute", "5 seconds". */
export function describeWait(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.round(secs / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

interface Pending { req: ApprovalRequest; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }

export class ApprovalBroker {
  private readonly items = new Map<string, Pending>();
  private readonly timeoutMs: number;
  /** How long a card waits for an answer before it is denied, in words ("10 minutes"). For messages that explain a timeout. */
  get timeoutWait(): string { return describeWait(this.timeoutMs); }
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
