import { useSyncExternalStore } from 'react';
import type {
  AgentProfile, ApprovalRequest, BoatHealthView, Catalog, SettingsPatch, SettingsView, ChatMessage, DoctorCheck, LegionEvent, MascotMood, ModelChoice, StateSnapshot, Task, VmRecord,
} from '../../src/shared/types';
import { api, subscribe, ApiError, type ConnStatus } from './api';

export type RelicState = 'idle' | 'listening' | 'thinking' | 'hacking' | 'awaiting' | 'victory' | 'error' | 'sleeping' | 'annoyed';

export type SettingsSection = 'claude' | 'boat' | 'mcp' | 'connections' | 'about';
export type TaskSrc = 'tab' | 'recent';
export interface TaskMenu { x: number; y: number; taskId: string; src: TaskSrc }

export interface Toast { id: number; text: string; kind: 'info' | 'error'; n: number }

export interface AppState {
  loaded: boolean;
  conn: ConnStatus;
  version: string;
  auth: StateSnapshot['auth'];
  boatConfigured: boolean;
  /** What is known about the boat.dev key and account (refused actions, trial limits, Claude setup, rates). */
  boatHealth: BoatHealthView | null;
  agents: AgentProfile[];
  tasks: Task[];
  vms: Record<string, VmRecord>;
  approvals: ApprovalRequest[];
  messages: Record<string, ChatMessage[]>;
  streaming: Record<string, string>;
  mascot: { mood: MascotMood; note?: string; at: number };
  doctor: DoctorCheck[] | null;
  doctorLoading: boolean;
  selectedAgentId: string;
  selectedTaskId: string | null;
  modelOverride: ModelChoice | null;
  opsOpen: boolean;
  theme: 'dark' | 'light';
  palette: boolean;
  doctorOpen: boolean;
  editor: null | { id: string | null };
  onboardingDismissed: boolean;
  toasts: Toast[];
  catalog: Catalog | null;
  catalogLoading: boolean;
  mascotLab: boolean;
  mascotForce: RelicState | null;
  mascotVm: boolean | null;
  settings: SettingsView | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  showClosed: boolean;
  taskMenu: TaskMenu | null;
  renaming: { id: string; src: TaskSrc } | null;
  /** Centre-column view. 'chat' is the task thread; 'rooms' = comms bridge; 'graph' = knowledge graph. */
  view: 'chat' | 'rooms' | 'graph';
}

function ls(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* ignore */ } }

const initialTheme = ((): 'dark' | 'light' => {
  const t = ls('legion.theme');
  if (t === 'light' || t === 'dark') return t;
  return 'dark';
})();

let state: AppState = {
  loaded: false, conn: 'connecting', version: '', auth: 'claude-login', boatConfigured: false, boatHealth: null,
  agents: [], tasks: [], vms: {}, approvals: [], messages: {}, streaming: {},
  mascot: { mood: 'idle', at: Date.now() }, doctor: null, doctorLoading: false,
  selectedAgentId: 'zealot', selectedTaskId: null, modelOverride: null,
  opsOpen: ls('legion.ops') !== '0', theme: initialTheme,
  palette: false, doctorOpen: false, editor: null,
  onboardingDismissed: ls('legion.onboarded') === '1', toasts: [],
  catalog: null, catalogLoading: false,
  mascotLab: false, mascotForce: null, mascotVm: null,
  settings: null, settingsOpen: false, settingsSection: 'claude', showClosed: false, taskMenu: null, renaming: null,
  view: 'chat',
};

const listeners = new Set<() => void>();
export function getState() { return state; }
export function setState(p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof p === 'function' ? p(state) : p;
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
function sub(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(sub, () => selector(state));
}

/* ---------- helpers ---------- */
let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = toastId++;
  // identical message → one toast with a count, timer restarted
  setState((s) => {
    const same = s.toasts.find((t) => t.text === text && t.kind === kind);
    return { toasts: [...s.toasts.filter((t) => t !== same), { id, text, kind, n: (same?.n ?? 0) + 1 }].slice(-4) };
  });
  window.setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3000);
}
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

function dedupeById<T extends { id: string }>(xs: T[]): T[] { const seen = new Set<string>(); return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))); }

function upsertTask(tasks: Task[], t: Task): Task[] {
  const i = tasks.findIndex((x) => x.id === t.id);
  if (i === -1) return [t, ...tasks];
  const next = tasks.slice(); next[i] = t; return next;
}

export function tasksForAgent(s: AppState, agentId: string) {
  return s.tasks.filter((t) => t.agentId === agentId && !t.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function pickTaskFor(agentId: string): string | null {
  const t = tasksForAgent(state, agentId)[0];
  return t ? t.id : null;
}

/* ---------- event handling ---------- */
/**
 * `message.delta` arrives at up to 50 a second. Every store write re-renders the thread, so the text is collected here and written ONCE per
 * animation frame (with a 100 ms timer as a backstop for a window whose rAF is throttled). Anything that finishes or resets a stream
 * (the final `message`, a terminal `task.updated`, `task.deleted`) writes the pending text first, so the order the core sent is kept.
 */
const pendingDelta: Record<string, string> = {};
let deltaRaf = 0;
let deltaTimer: ReturnType<typeof setTimeout> | undefined;
function flushDeltas() {
  if (deltaRaf) cancelAnimationFrame(deltaRaf);
  clearTimeout(deltaTimer);
  deltaRaf = 0; deltaTimer = undefined;
  const ids = Object.keys(pendingDelta);
  if (!ids.length) return;
  const add: Record<string, string> = {};
  for (const id of ids) { add[id] = pendingDelta[id]!; delete pendingDelta[id]; }
  setState((s) => {
    const streaming = { ...s.streaming };
    for (const id of ids) streaming[id] = (streaming[id] ?? '') + add[id];
    return { streaming };
  });
}
const flushDeltasFor = (taskId: string) => { if (pendingDelta[taskId] !== undefined) flushDeltas(); };

export function handleEvent(e: LegionEvent) {
  switch (e.type) {
    case 'task.updated': {
      if (e.task.status === 'done' || e.task.status === 'error' || e.task.status === 'cancelled') flushDeltasFor(e.task.id);
      const terminal = e.task.status === 'done' || e.task.status === 'error' || e.task.status === 'cancelled';
      setState((s) => {
        const streaming = terminal && s.streaming[e.task.id] ? { ...s.streaming, [e.task.id]: '' } : s.streaming;
        return { tasks: upsertTask(s.tasks, e.task), streaming };
      });
      if (e.task.archived && getState().selectedTaskId === e.task.id && !getState().showClosed) leaveTask(e.task.id);
      break;
    }
    case 'task.deleted': {
      const id = e.taskId;
      delete pendingDelta[id];
      const wasSel = getState().selectedTaskId === id;
      if (wasSel) leaveTask(id);
      setState((s) => { const { [id]: _m, ...messages } = s.messages; return { tasks: s.tasks.filter((t) => t.id !== id), messages }; });
      break;
    }
    case 'settings.updated':
      setState({ settings: e.settings, boatConfigured: e.settings.boat.apiKeySet, auth: e.settings.claude.auth });
      break;
    case 'message': {
      const m = e.message;
      if (m.role === 'assistant') flushDeltasFor(m.taskId);
      setState((s) => {
        const list = s.messages[m.taskId] ?? [];
        if (list.some((x) => x.id === m.id)) return {};
        let next = list;
        if (m.role === 'user') next = list.filter((x) => !(x.id.startsWith('tmp-') && x.text === m.text));
        next = [...next, m];
        const streaming = m.role === 'assistant' ? { ...s.streaming, [m.taskId]: '' } : s.streaming;
        return { messages: { ...s.messages, [m.taskId]: next }, streaming };
      });
      break;
    }
    case 'message.delta':
      pendingDelta[e.taskId] = (pendingDelta[e.taskId] ?? '') + e.text;
      if (!deltaRaf) { deltaRaf = requestAnimationFrame(flushDeltas); deltaTimer = setTimeout(flushDeltas, 100); }
      break;
    case 'vm.updated':
      setState((s) => ({ vms: { ...s.vms, [e.vm.agentId]: e.vm } }));
      break;
    case 'boat.health':
      setState({ boatHealth: e.health });
      break;
    case 'agent.updated':
      setState((s) => {
        const i = s.agents.findIndex((a) => a.id === e.agent.id);
        const agents = i === -1 ? [...s.agents, e.agent] : s.agents.map((a) => (a.id === e.agent.id ? e.agent : a));
        return { agents };
      });
      break;
    case 'agent.deleted':
      setState((s) => {
        const agents = s.agents.filter((a) => a.id !== e.agentId);
        const gone = s.selectedAgentId === e.agentId;
        return { agents, ...(gone ? { selectedAgentId: agents[0]?.id ?? 'zealot', selectedTaskId: null } : {}) };
      });
      break;
    case 'approval.requested':
      setState((s) => (s.approvals.some((a) => a.id === e.approval.id) ? {} : { approvals: [...s.approvals, e.approval] }));
      break;
    case 'approval.resolved':
      setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.approvalId) }));
      break;
    case 'comms.state':
      window.dispatchEvent(new CustomEvent('legion:comms', { detail: e }));
      break;
    case 'mascot':
      setState({ mascot: { mood: e.mood, note: e.note, at: Date.now() } });
      break;
  }
}

/* ---------- bootstrap ---------- */
export async function refresh() {
  try {
    const snap = await api.state(getState().showClosed);
    const vms: Record<string, VmRecord> = {};
    for (const v of snap.vms) vms[v.agentId] = v;
    setState((s) => {
      const sel = snap.agents.some((a) => a.id === s.selectedAgentId) ? s.selectedAgentId : (snap.agents[0]?.id ?? 'zealot');
      const first = !s.loaded;
      return {
        loaded: true, version: snap.version, auth: snap.auth, boatConfigured: snap.boatConfigured, boatHealth: snap.boat ?? s.boatHealth,
        agents: snap.agents, tasks: snap.tasks, vms, approvals: dedupeById(snap.approvals),
        selectedAgentId: sel,
        selectedTaskId: first ? null : s.selectedTaskId,
      };
    });
    if (snap.tasks.length && getState().selectedTaskId === null && !selectionTouched) {
      const id = pickTaskFor(getState().selectedAgentId);
      if (id) selectTask(id);
    }
  } catch (e) {
    setState({ loaded: true, conn: 'offline' });
    toast(errText(e), 'error');
  }
}

let selectionTouched = false;
let started = false;
export function init() {
  if (started) return;
  started = true;
  document.documentElement.dataset.theme = state.theme;
  let prev: ConnStatus = 'connecting';
  subscribe(handleEvent, (conn) => {
    setState({ conn });
    if (conn === 'online' && prev !== 'online') {
      { const c = getState().catalog; if (!c || c.error) void loadCatalog(true); }
      void refresh().then(() => { const t = getState().selectedTaskId; if (t) void loadTask(t, true); });
    }
    prev = conn;
  });
  void refresh();
  void runDoctor();
  void loadCatalog();
}

export async function runDoctor() {
  setState({ doctorLoading: true });
  try {
    const doctor = await api.doctor();
    setState({ doctor, doctorLoading: false });
  } catch (e) {
    setState({ doctorLoading: false });
    if (getState().conn === 'online') toast('Doctor failed: ' + errText(e), 'error');
  }
}

export async function loadTask(id: string, force = false) {
  if (!force && getState().messages[id]) return;
  try {
    const { task, messages } = await api.getTask(id);
    setState((s) => {
      const live = s.messages[id] ?? [];
      const ids = new Set(messages.map((m) => m.id));
      const merged = [...messages, ...live.filter((m) => !ids.has(m.id) && !m.id.startsWith('tmp-'))];
      return { messages: { ...s.messages, [id]: merged }, tasks: upsertTask(s.tasks, task) };
    });
  } catch (e) { toast(errText(e), 'error'); }
}

/* ---------- actions ---------- */
export function selectAgent(id: string) {
  selectionTouched = true;
  const taskId = pickTaskFor(id);
  setState({ selectedAgentId: id, selectedTaskId: taskId, modelOverride: null });
  if (taskId) void loadTask(taskId);
}
export function selectTask(id: string | null) {
  selectionTouched = true;
  if (id) {
    const t = getState().tasks.find((x) => x.id === id);
    setState({ selectedTaskId: id, ...(t ? { selectedAgentId: t.agentId } : {}) });
    void loadTask(id);
  } else setState({ selectedTaskId: null });
}
export function newTask() { selectTask(null); window.dispatchEvent(new Event('legion:focus-composer')); }
export function switchAgentByIndex(i: number) { const a = getState().agents[i]; if (a) selectAgent(a.id); }

const modelKey = (agentId: string) => `legion.model.${agentId}`;
export function storedModel(agentId: string): ModelChoice | null { return ls(modelKey(agentId)); }
export function effectiveModel(s: AppState): ModelChoice {
  if (s.modelOverride) return s.modelOverride;
  return storedModel(s.selectedAgentId) || (s.agents.find((a) => a.id === s.selectedAgentId)?.model ?? 'auto');
}
/** Picks the composer model for the current agent and remembers it (localStorage legion.model.<agentId>). */
export function setModelChoice(choice: ModelChoice) {
  lsSet(modelKey(getState().selectedAgentId), choice);
  setState({ modelOverride: choice });
}

/** Lazily fetches Claude Code's commands + models (cached server-side). Safe to call repeatedly. */
export async function loadCatalog(force = false) {
  const s = getState();
  if (s.catalogLoading) return;
  setState({ catalogLoading: true });
  try {
    const catalog = await api.catalog(force);
    setState({ catalog, catalogLoading: false });
  } catch (e) {
    setState({ catalog: { commands: [], models: [], fetchedAt: new Date().toISOString(), error: errText(e) }, catalogLoading: false });
  }
}

export async function sendPrompt(prompt: string): Promise<boolean> {
  const s = getState();
  const text = prompt.trim();
  if (!text) return false;
  const cont = s.selectedTaskId ? s.tasks.find((t) => t.id === s.selectedTaskId) : undefined;
  const body = { agentId: s.selectedAgentId, prompt: text, model: effectiveModel(s), ...(cont ? { continueTaskId: cont.id } : {}) };
  // optimistic echo for follow-ups (replaced when the real user message arrives)
  if (cont) {
    const tmp: ChatMessage = { id: 'tmp-' + Date.now(), taskId: cont.id, role: 'user', text, at: new Date().toISOString() };
    setState((st) => ({ messages: { ...st.messages, [cont.id]: [...(st.messages[cont.id] ?? []), tmp] } }));
  }
  try {
    const task = await api.createTask(body);
    setState((st) => ({
      tasks: upsertTask(st.tasks, task), selectedTaskId: task.id, selectedAgentId: task.agentId,
      messages: st.messages[task.id] ? st.messages : { ...st.messages, [task.id]: [] },
    }));
    if (!cont) void loadTask(task.id, true);
    return true;
  } catch (e) {
    if (cont) setState((st) => ({ messages: { ...st.messages, [cont.id]: (st.messages[cont.id] ?? []).filter((m) => !m.id.startsWith('tmp-')) } }));
    toast(errText(e), 'error');
    return false;
  }
}

export async function cancelSelected() {
  const id = getState().selectedTaskId;
  if (!id) return;
  try { await api.cancelTask(id); } catch (e) { toast(errText(e), 'error'); }
}

export async function decide(id: string, allow: boolean) {
  setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) })); // optimistic
  try { await api.decide(id, allow); } catch (e) { toast(errText(e), 'error'); void refresh(); }
}

export async function vmAction(agentId: string, action: 'start' | 'stop') {
  const cur = getState().vms[agentId];
  setState((s) => ({ vms: { ...s.vms, [agentId]: { ...(cur ?? { agentId, sandboxId: null, size: 'default', lastUsedAt: null, createdAt: null }), state: action === 'start' ? 'provisioning' : 'archiving' } } }));
  try {
    const res = action === 'start' ? await api.startVm(agentId) : await api.stopVm(agentId);
    const { stopped, message, usage: _usage, ...vm } = res as VmRecord & { stopped?: boolean; message?: string; usage?: unknown };
    setState((s) => ({ vms: { ...s.vms, [agentId]: vm } }));
    if (action === 'stop' && stopped === false && message) toast(message, 'info'); // e.g. "No sandbox to stop"
    if (action === 'start' && vm.notice) toast(vm.notice, 'info');
  } catch (e) {
    toast(errText(e), 'error');
    setState((s) => {
      const vms = { ...s.vms };
      if (cur) vms[agentId] = cur; else delete vms[agentId];
      return { vms };
    });
  }
}

export function toggleOps() { setState((s) => { lsSet('legion.ops', s.opsOpen ? '0' : '1'); return { opsOpen: !s.opsOpen }; }); }
export function toggleTheme() {
  setState((s) => {
    const theme = s.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme; lsSet('legion.theme', theme);
    return { theme };
  });
}
export function dismissOnboarding() { lsSet('legion.onboarded', '1'); setState({ onboardingDismissed: true }); }
export function closeOverlays() { setState({ palette: false, doctorOpen: false, editor: null }); }
export const openPalette = () => setState({ palette: true, doctorOpen: false, editor: null });
export const openDoctor = () => { setState({ doctorOpen: true, palette: false, editor: null }); void runDoctor(); };
export const openEditor = (id: string | null) => setState({ editor: { id }, palette: false, doctorOpen: false });

export async function saveAgent(id: string | null, a: Partial<AgentProfile> & { name: string }) {
  try {
    const saved = id ? await api.patchAgent(id, a) : await api.createAgent(a);
    handleEvent({ type: 'agent.updated', agent: saved });
    if (!id) selectAgent(saved.id);
    setState({ editor: null });
    return true;
  } catch (e) { toast(errText(e), 'error'); return false; }
}
export async function removeAgent(id: string) {
  try {
    await api.deleteAgent(id);
    handleEvent({ type: 'agent.deleted', agentId: id });
    setState({ editor: null });
  } catch (e) { toast(errText(e), 'error'); }
}

export const toggleMascotLab = () => setState((s) => ({ mascotLab: !s.mascotLab }));
export const forceMascot = (f: RelicState | null) => setState({ mascotForce: f });
export const forceMascotVm = (v: boolean | null) => setState({ mascotVm: v });

/* ---------- task management ---------- */
/** Moves selection off a task that was closed or deleted: next tab of the same agent, else the empty "New task" view. */
function leaveTask(id: string) {
  const t = getState().tasks.find((x) => x.id === id);
  const next = t ? tasksForAgent(getState(), t.agentId).find((x) => x.id !== id) : undefined;
  if (next) selectTask(next.id); else setState({ selectedTaskId: null });
}
export function openTaskMenu(x: number, y: number, taskId: string, src: TaskSrc = 'tab') { setState({ taskMenu: { x, y, taskId, src } }); }
export function closeTaskMenu() { if (getState().taskMenu) setState({ taskMenu: null }); }
export function startRename(taskId: string, src: TaskSrc = 'tab') { setState({ taskMenu: null, renaming: { id: taskId, src } }); }
export function stopRename() { setState({ renaming: null }); }

export async function archiveTask(id: string) {
  const prev = getState().tasks.find((t) => t.id === id); if (!prev) return;
  if (getState().selectedTaskId === id && !getState().showClosed) leaveTask(id);
  setState((s) => ({ tasks: upsertTask(s.tasks, { ...prev, archived: true }) }));
  try { await api.patchTask(id, { archived: true }); } catch (e) { setState((s) => ({ tasks: upsertTask(s.tasks, prev) })); toast(errText(e), 'error'); }
}
export async function reopenTask(id: string) {
  const prev = getState().tasks.find((t) => t.id === id); if (!prev) return;
  setState((s) => ({ tasks: upsertTask(s.tasks, { ...prev, archived: false }) }));
  try { await api.patchTask(id, { archived: false }); } catch (e) { setState((s) => ({ tasks: upsertTask(s.tasks, prev) })); toast(errText(e), 'error'); }
}
export async function closeOthers(id: string) {
  const keep = getState().tasks.find((t) => t.id === id); if (!keep) return;
  const others = tasksForAgent(getState(), keep.agentId).filter((t) => t.id !== id && t.status !== 'running' && t.status !== 'queued');
  await Promise.all(others.map((t) => archiveTask(t.id)));
  selectTask(id);
}
export async function renameTask(id: string, title: string) {
  const prev = getState().tasks.find((t) => t.id === id); stopRename();
  const t = title.trim(); if (!prev || !t || t === prev.title) return;
  setState((s) => ({ tasks: upsertTask(s.tasks, { ...prev, title: t }) }));
  try { await api.patchTask(id, { title: t }); } catch (e) { setState((s) => ({ tasks: upsertTask(s.tasks, prev) })); toast(errText(e), 'error'); }
}
export async function deleteTask(id: string) {
  try { await api.deleteTask(id); handleEvent({ type: 'task.deleted', taskId: id }); } catch (e) { toast(errText(e), 'error'); }
}
export async function stopTask(id: string) {
  try { await api.cancelTask(id); } catch (e) { toast(errText(e), 'error'); }
}
export async function setShowClosed(on: boolean) {
  setState({ showClosed: on });
  if (on) {
    try {
      const snap = await api.state(true);
      setState((s) => { const have = new Set(s.tasks.map((t) => t.id)); return { tasks: [...s.tasks, ...snap.tasks.filter((t) => t.archived && !have.has(t.id))] }; });
    } catch (e) { toast(errText(e), 'error'); setState({ showClosed: false }); }
  } else setState((s) => ({ tasks: s.tasks.filter((t) => !t.archived) }));
}

/* ---------- settings ---------- */
export async function loadSettings() {
  try { setState({ settings: await api.settings() }); } catch (e) { toast(errText(e), 'error'); }
}
export function openSettings(section?: SettingsSection) {
  setState({ settingsOpen: true, palette: false, doctorOpen: false, editor: null, ...(section ? { settingsSection: section } : {}) });
  void loadSettings();
}
export function setSettingsSection(settingsSection: SettingsSection) { setState({ settingsSection }); }
export function closeSettings() { setState({ settingsOpen: false }); }
export function toggleSettings() { if (getState().settingsOpen) closeSettings(); else openSettings(); }
/** PATCH /api/settings. Throws the server's message so the form can show it inline. */
export async function saveSettings(patch: SettingsPatch, quiet = false): Promise<SettingsView> {
  const view = await api.patchSettings(patch);
  setState({ settings: view, boatConfigured: view.boat.apiKeySet, auth: view.claude.auth });
  if (!quiet) toast('Saved');
  void runDoctor();
  return view;
}
export { errText };

export const setView = (view: AppState['view']) => setState({ view });

/** Re-probe what the boat.dev key may do (cheap reads; never creates a VM). The result also arrives as a boat.health event. */
export async function checkBoat(): Promise<BoatHealthView | null> {
  try { const h = await api.checkBoat(); setState({ boatHealth: h }); return h; } catch (e) { toast(errText(e), 'error'); return null; }
}
