import type { Project } from '../../src/shared/projects';
import type { BoardStatus, BoardView, WorkItem } from '../../src/shared/board';
import type {
  SettingsView, SettingsPatch, McpStatusView,
  AgentProfile, ApprovalRequest, BoatHealthView, Catalog, ChatMessage, DoctorCheck, LegionConfig, LegionEvent, ModelChoice, StateSnapshot, Task, VmRecord,
} from '../../src/shared/types';

declare global {
  interface Window {
    legion?: {
      baseUrl: string; token: string; admin?: string; platform: string; openExternal(url: string): void;
      /** BSV policy changes: main shows its own native confirmation and calls the core with a secret this window never holds. */
      bsvPolicy?(action: unknown): Promise<{ ok: boolean; error?: string; cancelled?: boolean; view?: unknown }>;
      providerChange?(change: unknown): Promise<{ ok: boolean; error?: string; cancelled?: boolean; view?: unknown }>;
      onBsvChanged?(cb: () => void): () => void;
      /** Project folder and member changes: main shows the native confirmation (and the folder chooser) and calls the core with a secret this window never holds. */
      projectChange?(change: unknown): Promise<{ ok: boolean; error?: string; cancelled?: boolean; view?: unknown }>;
    };
  }
}

const qs = new URLSearchParams(window.location.search);
export const base: string = (window.legion?.baseUrl ?? qs.get('base') ?? 'http://127.0.0.1:4747').replace(/\/$/, '');
export const token: string = window.legion?.token ?? qs.get('token') ?? '';
/**
 * Per-launch admin key, handed over by the Electron main process only when it is talking to its own core. Not available in a plain browser
 * (dev UI with `?token=`): that session is read-only (state, agents, tasks, events); every other route answers 403 admin_required.
 */
export const adminKey: string = window.legion?.admin ?? '';
export const platform: string = window.legion?.platform ?? qs.get('platform') ?? 'web';

export function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.legion?.openExternal) window.legion.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export class ApiError extends Error {
  status: number;
  /** Set for the two admin refusals, so the UI can tell them apart from an ordinary 403. */
  code?: 'admin_unavailable' | 'admin_required';
  constructor(status: number, message: string, code?: 'admin_unavailable' | 'admin_required') { super(message); this.status = status; this.code = code; }
}

/** Headers for every call to the core: the MCP-class bearer, plus the admin key when this window has one. One choke point (also used by raw fetches). */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(adminKey ? { 'X-Legion-Admin': adminKey } : {}), ...extra };
}

/** Plain words for a 403 from the admin gate (the server sends `admin_unavailable: ...` or `admin_required`). */
export function adminRefusal(status: number, serverMessage: string | undefined): { code: 'admin_unavailable' | 'admin_required'; message: string } | undefined {
  if (status !== 403 || !serverMessage) return undefined;
  if (serverMessage.startsWith('admin_unavailable')) {
    return { code: 'admin_unavailable', message: 'Open the Legion app to approve or change settings. This core was started outside the app, so those actions are locked; restart the core from the tray menu (Restart core).' };
  }
  if (serverMessage.startsWith('admin_required')) {
    return { code: 'admin_required', message: 'This window has no admin key for the core (it restarted, or this is a browser tab). Reload the Legion window, or restart the core from the tray menu.' };
  }
  return undefined;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach Legion core');
  }
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* ignore */ }
  if (!res.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
    const refusal = adminRefusal(res.status, msg);
    if (refusal) throw new ApiError(res.status, refusal.message, refusal.code);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export type NewAgent = Partial<AgentProfile> & { name: string };

export const api = {
  state: (archived = false) => request<StateSnapshot>('GET', `/api/state${archived ? '?archived=1' : ''}`),
  settings: () => request<SettingsView>('GET', '/api/settings'),
  patchSettings: (p: SettingsPatch) => request<SettingsView>('PATCH', '/api/settings', p),
  testBoat: (apiKey?: string, baseUrl?: string) => request<{ ok: boolean; detail: string; warnings?: string[] }>('POST', '/api/settings/boat/test', { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) }),
  patchTask: (id: string, b: { archived?: boolean; title?: string }) => request<Task>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, b),
  deleteTask: (id: string) => request<{ ok: true }>('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
  config: () => request<Partial<LegionConfig>>('GET', '/api/config'),
  catalog: (refresh = false) => request<Catalog>('GET', `/api/catalog${refresh ? '?refresh=1' : ''}`),
  doctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  mcpStatus: () => request<McpStatusView>('GET', '/api/mcp/status'),
  createAgent: (a: NewAgent) => request<AgentProfile>('POST', '/api/agents', a),
  patchAgent: (id: string, a: Partial<AgentProfile>) => request<AgentProfile>('PATCH', `/api/agents/${encodeURIComponent(id)}`, a),
  deleteAgent: (id: string) => request<{ ok: true }>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  projects: () => request<Project[]>('GET', '/api/projects'),
  createProject: (b: { name: string; instructions?: string }) => request<Project>('POST', '/api/projects', b),
  patchProject: (id: string, b: { name?: string; instructions?: string; status?: 'active' | 'archived' }) => request<Project>('PATCH', `/api/projects/${encodeURIComponent(id)}`, b),
  boardProbe: () => request<{ enabled: true }>('GET', '/api/board'),
  boardView: (pid: string) => request<BoardView>('GET', `/api/projects/${encodeURIComponent(pid)}/board`),
  boardLeader: (pid: string, leader: string | null) => request<BoardView>('PUT', `/api/projects/${encodeURIComponent(pid)}/board/leader`, { leader }),
  boardNote: (pid: string, id: string, b: { title: string; body: string }) => request<{ item: WorkItem; note: { id: string; title: string } }>('POST', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}/note`, b),
  boardNoteTitle: (pid: string, nid: string) => request<{ id: string; title: string }>('GET', `/api/projects/${encodeURIComponent(pid)}/board/notes/${encodeURIComponent(nid)}`),
  boardCreate: (pid: string, b: Record<string, unknown>) => request<WorkItem>('POST', `/api/projects/${encodeURIComponent(pid)}/board/items`, b),
  boardPatch: (pid: string, id: string, b: Record<string, unknown>) => request<WorkItem>('PATCH', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}`, b),
  boardMove: (pid: string, id: string, status: BoardStatus, index: number) => request<WorkItem>('POST', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}/move`, { status, index }),
  boardDelete: (pid: string, id: string) => request<{ ok: true }>('DELETE', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}`),
  boardAccept: (pid: string, id: string, b: Record<string, unknown>) => request<WorkItem>('POST', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}/accept`, b),
  boardReject: (pid: string, id: string) => request<{ ok: true }>('POST', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}/reject`, {}),
  boardRun: (pid: string, id: string) => request<{ item: WorkItem; limited: boolean }>('POST', `/api/projects/${encodeURIComponent(pid)}/board/items/${encodeURIComponent(id)}/run`, {}),
  patchRoomProject: (roomId: string, projectId: string | null) => request<unknown>('PATCH', `/api/rooms/${encodeURIComponent(roomId)}`, { projectId }),
  createTask: (b: { agentId: string; prompt: string; model?: ModelChoice; continueTaskId?: string; projectId?: string }) => request<Task>('POST', '/api/tasks', b),
  getTask: (id: string) => request<{ task: Task; messages: ChatMessage[] }>('GET', `/api/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) => request<{ ok: boolean }>('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`),
  vms: () => request<VmRecord[]>('GET', '/api/vms'),
  startVm: (agentId: string) => request<VmRecord>('POST', `/api/vms/${encodeURIComponent(agentId)}/start`),
  boatHealth: () => request<BoatHealthView>('GET', '/api/boat/health'),
  ensureBoat: () => request<BoatHealthView>('POST', '/api/boat/ensure'),
  checkBoat: () => request<BoatHealthView>('POST', '/api/boat/check'),
  stopVm: (agentId: string) => request<VmRecord & { stopped?: boolean; message?: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/stop`),
  exec: (agentId: string, command: string) =>
    request<{ exitCode: number; stdout: string; stderr: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/exec`, { command }),
  desktop: (agentId: string) => request<{ url: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/desktop`),
  screenshot: (agentId: string) => request<{ format: 'jpeg'; data: string }>('GET', `/api/vms/${encodeURIComponent(agentId)}/screenshot`),
  approvals: () => request<ApprovalRequest[]>('GET', '/api/approvals'),
  decide: (id: string, allow: boolean) => request<{ ok: boolean }>('POST', `/api/approvals/${encodeURIComponent(id)}`, { allow }),
};

export type ConnStatus = 'connecting' | 'online' | 'offline';

interface Listener { onEvent: (e: LegionEvent) => void; onStatus: (s: ConnStatus) => void }
const listeners = new Set<Listener>();
let status: ConnStatus = 'connecting';
/** Bumped on every start/stop of the shared stream so a late callback of an old connection can never touch the new one. */
let gen = 0;
let es: EventSource | null = null;
let ac: AbortController | null = null;
let attempt = 0;
let retryTimer: number | undefined;

function setStatus(s: ConnStatus) {
  status = s;
  for (const l of [...listeners]) { try { l.onStatus(s); } catch { /* a listener must not break the others */ } }
}
function dispatch(e: LegionEvent) {
  for (const l of [...listeners]) { try { l.onEvent(e); } catch { /* ignore a throwing listener */ } }
}

function startShared() {
  const my = ++gen;
  attempt = 0;
  const live = () => my === gen;

  const retry = () => {
    if (!live()) return;
    setStatus('offline');
    const delay = Math.min(10000, 500 * 2 ** attempt++);
    retryTimer = window.setTimeout(connect, delay);
  };

  /**
   * In the app the stream is read with fetch so it can carry `X-Legion-Admin`: the core sends rooms, comms and settings events only to an
   * admin stream. A browser tab without an admin key falls back to EventSource, which cannot send headers and so keeps `?token=`
   * (the MCP-class token: it gets the task, agent and approval events but none of the admin-only ones).
   */
  const connectFetch = () => {
    const ctl = new AbortController();
    ac = ctl;
    void (async () => {
      try {
        const res = await fetch(`${base}/api/events`, { headers: authHeaders(), signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        if (!live()) return;
        attempt = 0; setStatus('online');
        const rd = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            let ev: LegionEvent;
            try { ev = JSON.parse(line.slice(5).trim()) as LegionEvent; } catch { continue; /* ignore malformed */ }
            dispatch(ev);
          }
        }
      } catch { /* aborted or dropped: retry below */ }
      retry();
    })();
  };

  const connect = () => {
    if (!live()) return;
    setStatus(attempt === 0 ? 'connecting' : 'offline');
    if (adminKey) { connectFetch(); return; }
    const src = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
    es = src;
    src.onopen = () => { if (!live()) return; attempt = 0; setStatus('online'); };
    src.onmessage = (m) => {
      let ev: LegionEvent;
      try { ev = JSON.parse(m.data) as LegionEvent; } catch { return; /* ignore malformed */ }
      if (live()) dispatch(ev);
    };
    src.onerror = () => { src.close(); if (es === src) es = null; retry(); };
  };
  connect();
}

function stopShared() {
  gen++;
  es?.close(); es = null;
  ac?.abort(); ac = null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  status = 'connecting';
}

/**
 * SSE subscription with exponential backoff reconnect. Returns an unsubscribe fn.
 * Every caller shares ONE connection to the core (reference counted, opened by the first subscriber and closed with the last), and each
 * event is parsed once. Chromium allows 6 connections per host: with one stream per store (5 with the Lattice open) a single slow API call
 * left every other request waiting for the last socket. A caller that joins a stream that is already up gets the current status at once.
 */
export function subscribe(onEvent: (e: LegionEvent) => void, onStatus: (s: ConnStatus) => void): () => void {
  const l: Listener = { onEvent, onStatus };
  listeners.add(l);
  if (listeners.size === 1) startShared();
  else { try { onStatus(status); } catch { /* ignore */ } }
  return () => {
    if (!listeners.delete(l)) return;
    if (listeners.size === 0) stopShared();
  };
}
