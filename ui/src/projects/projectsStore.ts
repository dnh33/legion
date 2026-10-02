/** Projects UI actions on top of the main store (state lives in ../store.ts: `projects`, `projectFilter`, view 'project'). */
import type { Project } from '../../../src/shared/projects';
import { api, ApiError } from '../api';
import { getState, selectAgent, selectTask, setState, setView, toast } from '../store';
import { agentsFor, FILTER_KEY, resolveFilter } from './projectsLogic';

const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
function persist(id: string | null) { try { if (id) localStorage.setItem(FILTER_KEY, id); else localStorage.removeItem(FILTER_KEY); } catch { /* ignore */ } }

/** The window without the admin key (a browser tab) is refused: the list just stays empty and the switcher shows "All". */
export async function loadProjects(): Promise<void> {
  try {
    const projects = await api.projects();
    setState((s) => ({ projects, projectFilter: resolveFilter(projects, s.projectFilter) }));
  } catch { /* no admin access: no projects */ }
}
export const initProjects = (): void => { void loadProjects(); };

/** Chooses what the rail, the task tabs and Recent tasks show: null = All. Keeps the selected agent and task inside the choice. */
export function setProjectFilter(id: string | null): void {
  const s = getState();
  const next = resolveFilter(s.projects, id);
  persist(next);
  setState({ projectFilter: next });
  const list = agentsFor(getState().agents, getState().projects, next);
  if (next && list.length && !list.some((a) => a.id === getState().selectedAgentId)) selectAgent(list[0]!.id);
  else if (!getState().tasks.some((t) => t.id === getState().selectedTaskId && (next === null || t.projectId === next))) selectTask(null);
}

export function openProject(id: string): void {
  setProjectFilter(id);
  setView('project');
}
export const closeProjectPage = (): void => setView('chat');

export async function createProject(name: string, instructions: string): Promise<Project> {
  const p = await api.createProject({ name, ...(instructions.trim() ? { instructions } : {}) });
  setState((s) => (s.projects.some((x) => x.id === p.id) ? {} : { projects: [...s.projects, p] }));
  return p;
}

function put(p: Project): void { setState((s) => ({ projects: s.projects.some((x) => x.id === p.id) ? s.projects.map((x) => (x.id === p.id ? p : x)) : [...s.projects, p] })); }

export async function saveProject(id: string, patch: { name?: string; instructions?: string; status?: 'active' | 'archived' }): Promise<boolean> {
  try { put(await api.patchProject(id, patch)); return true; } catch (e) { toast(errText(e), 'error'); return false; }
}

/** The app's own native confirmation (main process) decides; this window never holds the secret that lets the core accept the change. */
async function viaMain(change: unknown): Promise<boolean> {
  const fn = window.legion?.projectChange;
  if (!fn) { toast('Open the Legion app to change a project’s folder or members.', 'error'); return false; }
  try {
    const r = await fn(change);
    if (r.ok) { if (r.view && typeof r.view === 'object') put(r.view as Project); return true; }
    if (!r.cancelled) toast(r.error || 'The change was not made.', 'error');
    return false;
  } catch (e) { toast(errText(e), 'error'); return false; }
}
export const changeMembers = (id: string, members: string[]): Promise<boolean> => viaMain({ kind: 'members', id, members });
export const chooseFolder = (id: string): Promise<boolean> => viaMain({ kind: 'folder', id, mode: 'pick' });
export const useDefaultFolder = (id: string): Promise<boolean> => viaMain({ kind: 'folder', id, mode: 'default' });

export async function assignRoom(roomId: string, projectId: string | null): Promise<boolean> {
  try { await api.patchRoomProject(roomId, projectId); return true; } catch (e) { toast(errText(e), 'error'); return false; }
}
