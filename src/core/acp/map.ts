/**
 * Maps what an ACP agent sends about tools, permissions and plans onto the shapes the rest of Legion already speaks.
 * Pure. Wire shapes (camelCase): https://agentclientprotocol.com tool-calls, agent-plan. What Hermes really sends:
 * acp_adapter/tools.py (kinds, titles "<tool>: <preview>", rawInput only for unknown tools), permissions.py (rawInput {command, description}),
 * edit_approval.py (rawInput {tool, arguments{path,...}} and a diff content item).
 */
import type { TodoItem } from '../../shared/types.js';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** One tool call (or an update of it) in Legion's terms. */
export interface MappedTool {
  toolCallId: string;
  /** Legion's name for the tool (Bash, Write, Read, WebFetch) or the agent's own tool name. */
  toolName: string;
  /** The agent's own ToolKind (execute, edit, read, ...). */
  kind: string;
  title: string;
  input: Record<string, unknown>;
  status?: ToolStatus;
  /** The text content of the call so far, clipped to TEXT_CAP. */
  text?: string;
}

export interface MappedPermission {
  /** The tool call id Hermes gives the request (`perm-check-N`, `edit-approval-N`); unique per request. */
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string;
  /** The agent's own options, verbatim. Never decide anything from `kind`: Hermes sends "Allow for session" as allow_always. */
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** An edit request's diff, for the card. */
  diff?: { path: string; oldText: string | null; newText: string };
  /** The text content of the request, clipped to TEXT_CAP. */
  text?: string;
}

export const TEXT_CAP = 16_000;

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | undefined => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : undefined);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);
const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'failed'];

/** The agent's tool name: an explicit `name`, else the title up to its first ": " (Hermes titles are "<tool>: <preview>"), else the title. */
function rawName(u: Rec): string {
  const name = str(u.name);
  if (name) return name;
  const title = str(u.title) ?? '';
  const i = title.indexOf(': ');
  return (i > 0 ? title.slice(0, i) : title) || 'tool';
}

/** The arguments the agent gave: rawInput itself, or its `arguments` object (Hermes edit requests wrap them). */
function argsOf(raw: Rec | undefined): Rec {
  if (!raw) return {};
  return rec(raw.arguments) ?? raw;
}

function diffOf(content: unknown): MappedPermission['diff'] {
  if (!Array.isArray(content)) return undefined;
  for (const c of content) {
    const d = rec(c);
    if (d && d.type === 'diff' && str(d.path) !== undefined && typeof d.newText === 'string') {
      return { path: d.path as string, oldText: typeof d.oldText === 'string' ? d.oldText : null, newText: d.newText };
    }
  }
  return undefined;
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    const item = rec(c);
    const inner = item && item.type === 'content' ? rec(item.content) : undefined;
    if (inner && inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text);
  }
  if (!parts.length) return undefined;
  const all = parts.join('\n');
  return all.length > TEXT_CAP ? all.slice(0, TEXT_CAP) : all;
}

function firstLocation(u: Rec): string | undefined {
  return Array.isArray(u.locations) ? str(rec(u.locations[0])?.path) : undefined;
}

/** Legion's tool name and input for one call or request. */
function describe(u: Rec): { toolName: string; input: Record<string, unknown> } {
  const kind = str(u.kind) ?? 'other';
  const raw = rec(u.rawInput);
  const args = argsOf(raw);
  switch (kind) {
    case 'execute': {
      const command = str(args.command);
      return { toolName: 'Bash', input: command !== undefined ? { ...args, command } : { ...args } };
    }
    case 'edit': {
      const path = str(args.path) ?? str(args.file_path) ?? diffOf(u.content)?.path ?? firstLocation(u);
      return { toolName: 'Write', input: path !== undefined ? { ...args, file_path: path } : { ...args } };
    }
    case 'read': {
      const path = str(args.path) ?? str(args.file_path) ?? firstLocation(u);
      return { toolName: 'Read', input: path !== undefined ? { ...args, file_path: path } : { ...args } };
    }
    case 'fetch': {
      const url = str(args.url);
      return { toolName: 'WebFetch', input: url !== undefined ? { ...args, url } : { ...args } };
    }
    default:
      return { toolName: rawName(u), input: raw ? { ...raw } : {} };
  }
}

/**
 * A `tool_call` or `tool_call_update` update. An update names only what changed (often just a status, or a kind without a title),
 * so it is merged over the earlier mapping of the same call (`prev`). Undefined when there is no toolCallId.
 */
export function mapToolCall(update: unknown, prev?: MappedTool): MappedTool | undefined {
  const u = rec(update);
  const id = u ? str(u.toolCallId) : undefined;
  if (!u || id === undefined) return undefined;
  const merged: Rec = { ...u };
  const hasWhat = str(u.kind) !== undefined || str(u.title) !== undefined || u.rawInput != null || str(u.name) !== undefined;
  const status = typeof u.status === 'string' && STATUSES.includes(u.status) ? (u.status as ToolStatus) : prev?.status;
  const text = textOf(u.content) ?? prev?.text;
  if (prev && !hasWhat) {
    return { ...prev, ...(status ? { status } : {}), ...(text !== undefined ? { text } : {}) };
  }
  // A start, or an update that names a kind, title or input: map it fresh, but keep what the earlier mapping knew and this one lacks.
  const d = describe(merged);
  const input = prev && u.rawInput == null ? prev.input : d.input;
  const toolName = prev && str(u.kind) === undefined && str(u.name) === undefined ? prev.toolName : d.toolName;
  return {
    toolCallId: id, toolName, kind: str(u.kind) ?? prev?.kind ?? 'other', title: str(u.title) ?? prev?.title ?? toolName, input,
    ...(status ? { status } : {}), ...(text !== undefined ? { text } : {}),
  };
}

/** A `session/request_permission` request's params. Undefined when it has no tool call id: a request Legion cannot tell apart is never invented. */
export function mapPermission(params: unknown): MappedPermission | undefined {
  const p = rec(params);
  const call = rec(p?.toolCall);
  const requestId = call ? str(call.toolCallId) : undefined;
  if (!p || !call || requestId === undefined || !Array.isArray(p.options)) return undefined;
  const options: MappedPermission['options'] = [];
  for (const o of p.options) {
    const r = rec(o);
    const optionId = r ? str(r.optionId) : undefined;
    if (r && optionId !== undefined && typeof r.name === 'string' && typeof r.kind === 'string') options.push({ optionId, name: r.name, kind: r.kind });
  }
  const d = describe(call);
  const diff = diffOf(call.content);
  const text = textOf(call.content);
  return {
    requestId, toolName: d.toolName, input: d.input, title: str(call.title) ?? d.toolName, options,
    ...(diff ? { diff } : {}), ...(text !== undefined ? { text } : {}),
  };
}

/** A `plan` update's entries as todo items. Each plan update replaces the whole list. */
export function mapPlan(entries: unknown): TodoItem[] {
  if (!Array.isArray(entries)) return [];
  const items: TodoItem[] = [];
  for (const e of entries) {
    const r = rec(e);
    const content = r ? str(r.content) : undefined;
    if (!r || content === undefined) continue;
    const status = r.status === 'completed' || r.status === 'in_progress' ? r.status : 'pending';
    items.push({ content, status });
  }
  return items;
}
