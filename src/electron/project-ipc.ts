/**
 * Native confirmation for the two project changes that widen what agents can reach: a project's folder and its members.
 * The window asks over IPC; this code words a native dialog from facts it reads from the core itself (never from the window), and only
 * after "Confirm" calls the core with the native secret, which the window never has. Free of electron imports so it can be tested with fakes.
 */
import { dialogLine } from './provider-ipc.js';
import { CONFIRM_BUSY, orBusy, underLock } from './confirm-window-logic.js';
import type { ConfirmFact, ConfirmLock } from './confirm-window-logic.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';

export interface ProjectIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'PUT', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  confirm: ProviderIpcDeps['confirm'];
  /** The native folder chooser. Resolves the chosen path, or undefined when cancelled. */
  pickFolder(start?: string): Promise<string | undefined>;
}
interface OpenDialogLike { showOpenDialog(win: any, options: any): Promise<{ canceled: boolean; filePaths: string[] }> }
/**
 * The folder chooser. It is a system window the Legion page can ask for (before any question), so it never opens while a confirm card is open: it would
 * cover the card and take its mouse and keys. It takes the confirm lock while it is open, so the other way round holds too: a card asked meanwhile is
 * refused as busy instead of opening under the chooser. If the lock is taken, the flow ends with "a confirmation is already open".
 */
export function makePickFolder(dialog: OpenDialogLike, getWin: () => unknown, lock: ConfirmLock): (start?: string) => Promise<string | undefined> {
  return async (start) => {
    const w = getWin();
    if (!w) return undefined;
    const r = await underLock(lock, () => dialog.showOpenDialog(w, { title: 'Choose the project folder', defaultPath: start, properties: ['openDirectory', 'createDirectory'] }));
    return r.canceled ? undefined : r.filePaths[0];
  };
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

/** What each agent has in one project: runs in progress, open tasks, unfinished board items assigned to it, rooms it is in. */
export interface ProjectWork { live: Record<string, number>; open: Record<string, number>; board: Record<string, number>; rooms: Record<string, number> }

/** Reads the counts from the core. A part that cannot be read (no board, an older core) counts as nothing, never as an error. */
export async function workOf(deps: Pick<ProjectIpcDeps, 'call'>, id: string): Promise<ProjectWork> {
  const work: ProjectWork = { live: {}, open: {}, board: {}, rooms: {} };
  const add = (m: Record<string, number>, k: unknown) => { if (typeof k === 'string') m[k] = (m[k] ?? 0) + 1; };
  const impact = await deps.call('GET', `/api/projects/${id}/impact`).catch(() => undefined);
  const agents = impact?.status === 200 ? (impact.json as { agents?: Record<string, { live?: unknown; open?: unknown }> }).agents : undefined;
  for (const [a, c] of Object.entries(agents ?? {})) {
    if (typeof c?.live === 'number') work.live[a] = c.live;
    if (typeof c?.open === 'number') work.open[a] = c.open;
  }
  const board = await deps.call('GET', `/api/projects/${id}/board`).catch(() => undefined);
  const items = board?.status === 200 ? (board.json as { items?: unknown }).items : undefined;
  if (Array.isArray(items)) for (const it of items as Array<{ status?: unknown; assignee?: { kind?: unknown; id?: unknown } | null }>) {
    if (it?.status !== 'done' && it?.assignee?.kind === 'agent') add(work.board, it.assignee.id);
  }
  const rooms = await deps.call('GET', '/api/rooms').catch(() => undefined);
  if (rooms?.status === 200 && Array.isArray(rooms.json)) for (const r of rooms.json as Array<{ projectId?: unknown; members?: unknown }>) {
    if (r?.projectId === id && Array.isArray(r.members)) for (const m of r.members) add(work.rooms, m);
  }
  return work;
}

/** "1 run in progress, 4 open tasks, 2 board items, 1 room": only the parts that are not zero. Empty when there is nothing. */
export function countsLine(w: ProjectWork, agentId: string): string {
  const part = (n: number | undefined, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return [
    part(w.live[agentId], 'run in progress', 'runs in progress'), part(w.open[agentId], 'open task', 'open tasks'),
    part(w.board[agentId], 'board item', 'board items'), part(w.rooms[agentId], 'room', 'rooms'),
  ].filter(Boolean).join(', ');
}

let open = false;

export const projectChange = (raw: unknown, deps: ProjectIpcDeps): Promise<ProjectChangeResult> => orBusy(projectChangeRun(raw, deps), { ok: false, error: CONFIRM_BUSY });
async function projectChangeRun(raw: unknown, deps: ProjectIpcDeps): Promise<ProjectChangeResult> {
  const ch = parseProjectChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  const cur = await deps.call('GET', `/api/projects/${ch.id}`);
  if (!cur || cur.status !== 200) return { ok: false, error: cur?.status === 404 ? 'Unknown project.' : 'Legion could not reach its own core. Restart Legion.' };
  const proj = cur.json as { name?: unknown; folder?: unknown; members?: unknown };
  const name = dialogLine(proj.name, 60) || 'this project';
  const oldFolder = dialogLine(proj.folder, 200);
  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let body: unknown;
  // The folder questions show their folders as rows; the words around them stay a paragraph. `detail` is the same text whole, for the system dialog.
  let rows: ConfirmFact[] | undefined; let prose = '';
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
    if (removed.length) {
      const work = await workOf(deps, ch.id);
      const counted = removed.map((id) => { const n = countsLine(work, id); return n ? `${nameOf(id)} (${n})` : nameOf(id); });
      lines.push(`Removed: ${counted.join(', ')}. Runs in progress finish. Their next run on an existing task of this project has no project context.`);
    }
    title = 'Change project members?'; confirmLabel = 'Confirm change';
    message = `Change who works on "${name}"?`;
    detail = lines.join('\n\n');
    route = `/api/projects/${ch.id}/members`; body = { members: ch.members };
  } else if (ch.mode === 'default') {
    title = 'Use the default folder?'; confirmLabel = 'Use default folder';
    message = `Move "${name}" back to its default folder?`;
    prose = 'Agents that work on this project can read and write files in its folder. Files already there are not moved.';
    rows = [{ label: 'Now', value: oldFolder }];
    detail = `Now: ${oldFolder}\n\n${prose}`;
    route = `/api/projects/${ch.id}/folder`; body = { folder: null };
  } else {
    const picked = await deps.pickFolder(typeof proj.folder === 'string' ? proj.folder : undefined);
    if (!picked) return { ok: false, cancelled: true };
    title = 'Use this folder for the project?'; confirmLabel = 'Use this folder';
    message = `Set the folder of "${name}"?`;
    prose = 'Agents that are members of this project can read and write files in that folder when they work on its tasks. Pick a folder made for this project, not a folder that holds other things. Files already in the old folder are not moved.';
    rows = [{ label: 'New folder', value: dialogLine(picked, 300) }, { label: 'Now', value: oldFolder }];
    detail = `New folder: ${rows[0]!.value}\nNow: ${oldFolder}\n\n${prose}`;
    route = `/api/projects/${ch.id}/folder`; body = { folder: picked };
  }
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { if (!(await deps.confirm({ title, message, detail, confirmLabel, who: `Projects › ${name}`, ...(rows ? { facts: rows, windowDetail: prose } : {}) }))) return { ok: false, cancelled: true }; } finally { open = false; }
  const res = await deps.call('PUT', route, body, true);
  if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
  if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` };
  return { ok: true, view: res.json };
}
