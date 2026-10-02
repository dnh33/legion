/**
 * Native confirmation for the two project changes that widen what agents can reach: a project's folder and its members.
 * The window asks over IPC; this code words a native dialog from facts it reads from the core itself (never from the window), and only
 * after "Confirm" calls the core with the native secret, which the window never has. Free of electron imports so it can be tested with fakes.
 */
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';

export interface ProjectIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'PUT', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  confirm: ProviderIpcDeps['confirm'];
  /** The native folder chooser. Resolves the chosen path, or undefined when cancelled. */
  pickFolder(start?: string): Promise<string | undefined>;
}
export type ProjectChange =
  | { kind: 'members'; id: string; members: string[] }
  | { kind: 'folder'; id: string; mode: 'pick' | 'default' };
export interface ProjectChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }

const ID_RE = /^proj_[a-f0-9]{12}$/;
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Strict parse of what the window sent; anything else is refused. */
export function parseProjectChange(raw: unknown): ProjectChange | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return undefined;
  if (r.kind === 'members') {
    if (!Array.isArray(r.members) || r.members.length > 24 || r.members.some((m) => typeof m !== 'string' || !AGENT_RE.test(m))) return undefined;
    return { kind: 'members', id: r.id, members: [...new Set(r.members as string[])] };
  }
  if (r.kind === 'folder' && (r.mode === 'pick' || r.mode === 'default')) return { kind: 'folder', id: r.id, mode: r.mode };
  return undefined;
}

let open = false;

export async function projectChange(raw: unknown, deps: ProjectIpcDeps): Promise<ProjectChangeResult> {
  const ch = parseProjectChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  const cur = await deps.call('GET', `/api/projects/${ch.id}`);
  if (!cur || cur.status !== 200) return { ok: false, error: cur?.status === 404 ? 'Unknown project.' : 'Legion could not reach its own core. Restart Legion.' };
  const proj = cur.json as { name?: unknown; folder?: unknown; members?: unknown };
  const name = dialogLine(proj.name, 60) || 'this project';
  const oldFolder = dialogLine(proj.folder, 200);
  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let body: unknown;
  if (ch.kind === 'members') {
    const agents = await deps.call('GET', '/api/agents');
    const nameOf = (id: string): string => {
      const a = Array.isArray(agents?.json) ? (agents!.json as Array<{ id?: unknown; name?: unknown }>).find((x) => x.id === id) : undefined;
      return dialogLine(a?.name, 40) || id;
    };
    const before = new Set(Array.isArray(proj.members) ? (proj.members as unknown[]).filter((m): m is string => typeof m === 'string') : []);
    const after = new Set(ch.members);
    const added = [...after].filter((m) => !before.has(m));
    const removed = [...before].filter((m) => !after.has(m));
    if (!added.length && !removed.length) return { ok: true, view: cur.json };
    const lines: string[] = [];
    if (added.length) lines.push(`Added: ${added.map(nameOf).join(', ')}. They will get this project's instructions and notes, and can read and write files in its folder (${oldFolder}) when they work on its tasks.`);
    if (removed.length) lines.push(`Removed: ${removed.map(nameOf).join(', ')}. Their next run on an existing task of this project has no project context.`);
    title = 'Change project members?'; confirmLabel = 'Confirm change';
    message = `Change who works on "${name}"?`;
    detail = lines.join('\n\n');
    route = `/api/projects/${ch.id}/members`; body = { members: ch.members };
  } else if (ch.mode === 'default') {
    title = 'Use the default folder?'; confirmLabel = 'Use default folder';
    message = `Move "${name}" back to its default folder?`;
    detail = `Now: ${oldFolder}\n\nAgents that work on this project can read and write files in its folder. Files already there are not moved.`;
    route = `/api/projects/${ch.id}/folder`; body = { folder: null };
  } else {
    const picked = await deps.pickFolder(typeof proj.folder === 'string' ? proj.folder : undefined);
    if (!picked) return { ok: false, cancelled: true };
    title = 'Use this folder for the project?'; confirmLabel = 'Use this folder';
    message = `Set the folder of "${name}"?`;
    detail = `New folder: ${dialogLine(picked, 300)}\nNow: ${oldFolder}\n\nAgents that are members of this project can read and write files in that folder when they work on its tasks. Pick a folder made for this project, not a folder that holds other things. Files already in the old folder are not moved.`;
    route = `/api/projects/${ch.id}/folder`; body = { folder: picked };
  }
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { if (!(await deps.confirm({ title, message, detail, confirmLabel }))) return { ok: false, cancelled: true }; } finally { open = false; }
  const res = await deps.call('PUT', route, body, true);
  if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
  if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` };
  return { ok: true, view: res.json };
}
