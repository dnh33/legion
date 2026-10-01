import type {
  SettingsView, SettingsPatch,
  AgentProfile, ApprovalRequest, Catalog, ChatMessage, DoctorCheck, LegionConfig, LegionEvent, ModelChoice, StateSnapshot, Task, VmRecord,
} from '../../src/shared/types';

declare global {
  interface Window {
    legion?: { baseUrl: string; token: string; platform: string; openExternal(url: string): void };
  }
}

const qs = new URLSearchParams(window.location.search);
export const base: string = (window.legion?.baseUrl ?? qs.get('base') ?? 'http://127.0.0.1:4747').replace(/\/$/, '');
export const token: string = window.legion?.token ?? qs.get('token') ?? '';
export const platform: string = window.legion?.platform ?? qs.get('platform') ?? 'web';

export function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.legion?.openExternal) window.legion.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export type NewAgent = Partial<AgentProfile> & { name: string };

export const api = {
  state: (archived = false) => req<StateSnapshot>('GET', `/api/state${archived ? '?archived=1' : ''}`),
  settings: () => req<SettingsView>('GET', '/api/settings'),
  patchSettings: (p: SettingsPatch) => req<SettingsView>('PATCH', '/api/settings', p),
  testBoat: (apiKey?: string, baseUrl?: string) => req<{ ok: boolean; detail: string }>('POST', '/api/settings/boat/test', { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) }),
  patchTask: (id: string, b: { archived?: boolean; title?: string }) => req<Task>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, b),
  deleteTask: (id: string) => req<{ ok: true }>('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
  config: () => req<Partial<LegionConfig>>('GET', '/api/config'),
  catalog: (refresh = false) => req<Catalog>('GET', `/api/catalog${refresh ? '?refresh=1' : ''}`),
  doctor: () => req<DoctorCheck[]>('GET', '/api/doctor'),
  createAgent: (a: NewAgent) => req<AgentProfile>('POST', '/api/agents', a),
  patchAgent: (id: string, a: Partial<AgentProfile>) => req<AgentProfile>('PATCH', `/api/agents/${encodeURIComponent(id)}`, a),
  deleteAgent: (id: string) => req<{ ok: true }>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  createTask: (b: { agentId: string; prompt: string; model?: ModelChoice; continueTaskId?: string }) => req<Task>('POST', '/api/tasks', b),
  getTask: (id: string) => req<{ task: Task; messages: ChatMessage[] }>('GET', `/api/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) => req<{ ok: boolean }>('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`),
  vms: () => req<VmRecord[]>('GET', '/api/vms'),
  startVm: (agentId: string) => req<VmRecord>('POST', `/api/vms/${encodeURIComponent(agentId)}/start`),
  stopVm: (agentId: string) => req<VmRecord>('POST', `/api/vms/${encodeURIComponent(agentId)}/stop`),
  exec: (agentId: string, command: string) =>
    req<{ exitCode: number; stdout: string; stderr: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/exec`, { command }),
  desktop: (agentId: string) => req<{ url: string }>('POST', `/api/vms/${encodeURIComponent(agentId)}/desktop`),
  screenshot: (agentId: string) => req<{ format: 'jpeg'; data: string }>('GET', `/api/vms/${encodeURIComponent(agentId)}/screenshot`),
  approvals: () => req<ApprovalRequest[]>('GET', '/api/approvals'),
  decide: (id: string, allow: boolean) => req<{ ok: boolean }>('POST', `/api/approvals/${encodeURIComponent(id)}`, { allow }),
};

export type ConnStatus = 'connecting' | 'online' | 'offline';

/** SSE subscription with exponential backoff reconnect. Returns an unsubscribe fn. */
export function subscribe(onEvent: (e: LegionEvent) => void, onStatus: (s: ConnStatus) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const connect = () => {
    if (closed) return;
    onStatus(attempt === 0 ? 'connecting' : 'offline');
    es = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => { attempt = 0; onStatus('online'); };
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as LegionEvent); } catch { /* ignore malformed */ }
    };
    es.onerror = () => {
      es?.close(); es = null;
      onStatus('offline');
      const delay = Math.min(10000, 500 * 2 ** attempt++);
      timer = window.setTimeout(connect, delay);
    };
  };
  connect();
  return () => { closed = true; es?.close(); if (timer) clearTimeout(timer); };
}
