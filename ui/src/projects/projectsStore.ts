/** Projects UI actions on top of the main store (state lives in ../store.ts: `projects`, `projectFilter`, view 'project'). */
import type { Project } from '../../../src/shared/projects';
import { api, ApiError } from '../api';
import { getState, selectAgent, selectTask, setState, setView, subscribeStore, toast } from '../store';
import { initAway } from './awayStore';
import { enterProject, setTab } from './page/pageState';
import { dropStaleReads } from './page/readsGrant';
import { ASK_QUEUE_MS, queuedAskStep, resolveAsk } from './openAsk';
import { askTarget, failBoardLoad, markBoardSettled, requestAsk, requestInbox } from './railRoute';
import type { RailTarget, RouteRow } from './railRoute';
import type { AskRef } from './openAsk';
import { agentsFor, archiveQuestion, boardItemsAssigned, FILTER_KEY, resolveFilter, unarchiveQuestion } from './projectsLogic';
import { closeSheet } from './page/sheetState';
import { currentProposals, refreshBoard } from './board/boardStore';

const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
function persist(id: string | null) { try { if (id) localStorage.setItem(FILTER_KEY, id); else localStorage.removeItem(FILTER_KEY); } catch { /* ignore */ } }

/** The window without the admin key (a browser tab) is refused: the list just stays empty and the switcher shows "All". */
let projectsSettled = false;
export async function loadProjects(): Promise<void> {
  try {
    const projects = await api.projects();
    setState((s) => ({ projects, projectFilter: resolveFilter(projects, s.projectFilter) }));
  } catch { /* no admin access: no projects */ } finally {
    projectsSettled = true;
    pumpQueuedAsk();
  }
}
export const initProjects = (): void => { void loadProjects(); initAway(); };

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
/** Opens a project's page on its Board tab (where its proposals wait). An open side sheet closes first, so focus is not left on an inert panel. */
export function openProjectBoard(id: string): void {
  closeSheet();
  enterProject(id);
  setTab('board');
  openProject(id);
}
/** The window can route an ask once its tasks, agents and projects have loaded (a failed load counts: nothing more is coming). */
const askReady = (): boolean => getState().loaded && projectsSettled;
let queued: { ref: AskRef; at: number } | null = null;
let queueTimer: ReturnType<typeof setTimeout> | undefined;
let queueUnsub: (() => void) | undefined;
function stopQueue(): void { queued = null; clearTimeout(queueTimer); queueUnsub?.(); queueUnsub = undefined; }
function pumpQueuedAsk(): void {
  const step = queuedAskStep(queued?.at ?? null, askReady(), Date.now());
  if (step === 'run' && queued) { const ref = queued.ref; stopQueue(); routeAsk(ref); }
  else if (step === 'expired') { stopQueue(); toast('Could not open that. Open the project and look in its Inbox.', 'error'); }
}
/** The one way to open an ask: a notification click and the tray item end here (the choice is `resolveAsk`, the destination `askTarget`). Before the window has loaded it waits, at most ASK_QUEUE_MS. */
export function openAsk(ref: AskRef): void {
  if (askReady()) { routeAsk(ref); return; }
  stopQueue();
  queued = { ref, at: Date.now() };
  queueUnsub = subscribeStore(() => { if (askReady()) setTimeout(pumpQueuedAsk, 0); });
  queueTimer = setTimeout(pumpQueuedAsk, ASK_QUEUE_MS + 50);
}
function routeAsk(ref: AskRef): void {
  const s = getState();
  const waiting = [...s.approvals, ...s.questions].map((a) => ({ taskId: a.taskId, projectId: s.tasks.find((t) => t.id === a.taskId)?.projectId ?? null, at: a.at }));
  const proposals = currentProposals().map((i) => ({ id: i.id, projectId: i.projectId, agentId: i.createdBy.kind === 'agent' ? i.createdBy.id : '', createdAt: i.createdAt }));
  const act = resolveAsk(ref, waiting, s.projects.map((p) => p.id), proposals);
  if (act.kind === 'thread') openAskTarget({ kind: 'thread', taskId: act.taskId, askId: '' });
  else if (act.kind === 'proposal') openAskTarget(askTarget({ kind: 'proposal', id: act.itemId, agentId: act.agentId, projectId: act.projectId }, s.tasks));
  else if (act.kind === 'project') openProject(act.projectId);
}
/** A rail row (agent or "other projects") opens what waits on you. */
export function openRailRow(row: RouteRow): boolean {
  const t = askTarget(row, getState().tasks);
  if (t.kind === 'none') return false;
  openAskTarget(t);
  return true;
}
/** A fresh board load for the request made at `at`: when it lands the request's TTL starts; when it fails the request is dropped and the owner told. */
function settleBoard(projectId: string, at: number): void {
  void refreshBoard(projectId).then((ok) => {
    if (ok) markBoardSettled(at);
    else if (failBoardLoad(at)) toast('Could not load the board for that project.', 'error');
  });
}
/** Applies the answer of `askTarget`. */
export function openAskTarget(t: RailTarget): void {
  if (t.kind === 'inbox') { const at = Date.now(); requestInbox(t.projectId, t.itemId, at); settleBoard(t.projectId, at); openProjectBoard(t.projectId); }
  else if (t.kind === 'thread') {
    const at = Date.now();
    requestAsk(t.taskId, t.askId, at, t.proposalProject);
    if (t.proposalProject) settleBoard(t.proposalProject, at);
    setView('chat'); selectTask(t.taskId);
  }
  else if (t.kind === 'newChat') {
    const at = Date.now();
    requestAsk(null, t.askId, at, t.proposalProject);
    settleBoard(t.proposalProject, at);
    setProjectFilter(t.projectId);
    selectAgent(t.agentId);
    selectTask(null);
    setView('chat');
  } else if (t.kind === 'project') openProject(t.projectId);
}
/** The proposal in its project's Inbox, entry in view (the card's "Open on board"). */
export const openInboxItem = (projectId: string, itemId: string): void => openAskTarget({ kind: 'inbox', projectId, itemId });
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

/** Unarchive after a question that says what comes back (it changes what every member's next run gets). */
export async function unarchiveProject(p: Project): Promise<boolean> {
  if (!window.confirm(unarchiveQuestion(p.name))) return false;
  return saveProject(p.id, { status: 'active' });
}

/** Archive after a question that says what it touches (council A9). Without the numbers (an older core) it still asks. */
export async function archiveProject(p: Project): Promise<boolean> {
  const n = { live: 0, open: 0, rooms: 0, board: 0 };
  try { for (const c of Object.values((await api.projectImpact(p.id)).agents)) { n.live += c.live; n.open += c.open; } } catch { /* asked without counts */ }
  try { n.rooms = (await api.roomsList()).filter((r) => r.projectId === p.id).length; } catch { /* asked without the room count */ }
  try { n.board = boardItemsAssigned((await api.boardView(p.id)).items); } catch { /* no board (or an older core): asked without the board count */ }
  if (!window.confirm(archiveQuestion(p.name, n))) return false;
  return saveProject(p.id, { status: 'archived' });
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
/** A changed folder ends the reads grant for the old one (it is not moved): see dropStaleReads. */
async function changeFolder(id: string, mode: 'pick' | 'default'): Promise<boolean> {
  const ok = await viaMain({ kind: 'folder', id, mode });
  const p = getState().projects.find((x) => x.id === id);
  if (ok && p) await dropStaleReads(p);
  return ok;
}
export const chooseFolder = (id: string): Promise<boolean> => changeFolder(id, 'pick');
export const useDefaultFolder = (id: string): Promise<boolean> => changeFolder(id, 'default');

export async function assignRoom(roomId: string, projectId: string | null): Promise<boolean> {
  try { await api.patchRoomProject(roomId, projectId); return true; } catch (e) { toast(errText(e), 'error'); return false; }
}
