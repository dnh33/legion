import type {
  SettingsView, SettingsPatch,
  AgentProfile, ApprovalRequest, Catalog, ChatMessage, DoctorCheck, LegionConfig, LegionEvent, ModelChoice, StateSnapshot, Task, VmRecord,
} from '../../src/shared/types';

declare global {
  interface Window {
    legion?: { baseUrl: string; token: string; admin?: string; platform: string; openExternal(url: string): void };
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
  testBoat: (apiKey?: string, baseUrl?: string) => request<{ ok: boolean; detail: string }>('POST', '/api/settings/boat/test', { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) }),
  patchTask: (id: string, b: { archived?: boolean; title?: string }) => request<Task>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, b),
  deleteTask: (id: string) => request<{ ok: true }>('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
  config: () => request<Partial<LegionConfig>>('GET', '/api/config'),
  catalog: (refresh = false) => request<Catalog>('GET', `/api/catalog${refresh ? '?refresh=1' : ''}`),
  doctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  createAgent: (a: NewAgent) => request<AgentProfile>('POST', '/api/agents', a),
  patchAgent: (id: string, a: Partial<AgentProfile>) => request<AgentProfile>('PATCH', `/api/agents/${encodeURIComponent(id)}`, a),
  deleteAgent: (id: string) => request<{ ok: true }>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  createTask: (b: { agentId: string; prompt: string; model?: ModelChoice; continueTaskId?: string }) => request<Task>('POST', '/api/tasks', b),
  getTask: (id: string) => request<{ task: Task; messages: ChatMessage[] }>('GET', `/api/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) => request<{ ok: boolean }>('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`),
  vms: () => request<VmRecord[]>('GET', '/api/vms'),
  startVm: (agentId: string) => request<VmRecord>('POST', `/api/vms/${encodeURIComponent(agentId)}/start`),
  stopVm: (agentId: string) => request<VmRecord>('POST', `/api/vms/${encodeURIComponent(agentId)}/stop`),
  exec: (agentId: string, command: string) =>
    request<{ exitCode: number; stdout: string; stderr: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/exec`, { command }),
  desktop: (agentId: string) => request<{ url: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/desktop`),
  screenshot: (agentId: string) => request<{ format: 'jpeg'; data: string }>('GET', `/api/vms/${encodeURIComponent(agentId)}/screenshot`),
  approvals: () => request<ApprovalRequest[]>('GET', '/api/approvals'),
  decide: (id: string, allow: boolean) => request<{ ok: boolean }>('POST', `/api/approvals/${encodeURIComponent(id)}`, { allow }),
};

export type ConnStatus = 'connecting' | 'online' | 'offline';

/** SSE subscription with exponential backoff reconnect. Returns an unsubscribe fn. */
export function subscribe(onEvent: (e: LegionEvent) => void, onStatus: (s: ConnStatus) => void): () => void {
  let es: EventSource | null = null;
  let ac: AbortController | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const retry = () => {
    if (closed) return;
    onStatus('offline');
    const delay = Math.min(10000, 500 * 2 ** attempt++);
    timer = window.setTimeout(connect, delay);
  };

  /**
   * In the app the stream is read with fetch so it can carry `X-Legion-Admin`: the core sends rooms, comms and settings events only to an
   * admin stream. A browser tab without an admin key falls back to EventSource, which cannot send headers and so keeps `?token=`
   * (the MCP-class token: it gets the task, agent and approval events but none of the admin-only ones).
   */
  const connectFetch = () => {
    ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${base}/api/events`, { headers: authHeaders(), signal: ac!.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        attempt = 0; onStatus('online');
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
            try { onEvent(JSON.parse(line.slice(5).trim()) as LegionEvent); } catch { /* ignore malformed */ }
          }
        }
      } catch { /* aborted or dropped: retry below */ }
      retry();
    })();
  };

  const connect = () => {
    if (closed) return;
    onStatus(attempt === 0 ? 'connecting' : 'offline');
    if (adminKey) { connectFetch(); return; }
    es = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => { attempt = 0; onStatus('online'); };
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as LegionEvent); } catch { /* ignore malformed */ }
    };
    es.onerror = () => { es?.close(); es = null; retry(); };
  };
  connect();
  return () => { closed = true; es?.close(); ac?.abort(); if (timer) clearTimeout(timer); };
}
