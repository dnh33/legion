/** Project board state and actions (a small external store, like ../projectsStore). Everything goes through the core; nothing here decides authority. */
import { useSyncExternalStore } from 'react';
import type { BoardMarshalStatus, BoardStatus, BoardView, MarshalConfig, WorkItem } from '../../../../src/shared/board';
import { api, ApiError } from '../../api';
import { selectTask, setView, toast } from '../../store';
import { moveLocal } from './boardLogic';

export interface BoardState {
  enabled: 'unknown' | 'yes' | 'no';
  views: Record<string, BoardView | undefined>;
  /** What the Marshal is doing on each project (picture, plain lines, written checks, config). */
  statuses: Record<string, BoardMarshalStatus | undefined>;
  busy: boolean;
  announce: string;
}
let state: BoardState = { enabled: 'unknown', views: {}, statuses: {}, busy: false, announce: '' };
const subs = new Set<() => void>();
const set = (p: Partial<BoardState> | ((s: BoardState) => Partial<BoardState>)): void => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; subs.forEach((f) => f()); };
/** Every proposal waiting in a loaded Inbox, read once (not a hook). */
export const currentProposals = (): WorkItem[] => Object.values(state.views).flatMap((v) => v?.inbox ?? []);
export function useBoard<T>(sel: (s: BoardState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => sel(state));
}
const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

let probing: Promise<void> | null = null;
/** `GET /api/board` answers 404 unless the board's config switch is on: then the window shows nothing of it. */
export function probeBoard(): Promise<void> {
  if (state.enabled !== 'unknown') return Promise.resolve();
  probing ??= api.boardProbe().then(() => set({ enabled: 'yes' }), () => set({ enabled: 'no' }));
  return probing;
}

export async function loadBoard(projectId: string): Promise<void> {
  try { const v = await api.boardView(projectId); set((s) => ({ views: { ...s.views, [projectId]: v } })); } catch (e) { toast(errText(e), 'error'); }
}

/** Loads a project's board unless it is loaded already (or the board is switched off), so a proposal can be found from its ids alone. */
export async function ensureBoard(projectId: string): Promise<void> {
  await probeBoard();
  if (state.enabled === 'yes' && state.views[projectId] === undefined) await loadBoard(projectId);
}

/** What the Marshal is doing on this project. Reloaded with the board: both are advisory copies of what the core holds. */
export async function loadMarshal(projectId: string): Promise<void> {
  try { const v = await api.boardStatus(projectId); set((s) => ({ statuses: { ...s.statuses, [projectId]: v } })); } catch (e) { toast(errText(e), 'error'); }
}

/** The item as the window's copy of the board has it now (after the last reload). */
export const currentItem = (projectId: string, id: string): WorkItem | undefined => state.views[projectId]?.items.find((x) => x.id === id);

async function act<T>(projectId: string, fn: () => Promise<T>): Promise<T | undefined> {
  set({ busy: true });
  try { const r = await fn(); await loadBoard(projectId); return r; } catch (e) { toast(errText(e), 'error'); await loadBoard(projectId); return undefined; } finally { set({ busy: false }); }
}

export const createItem = (pid: string, b: Record<string, unknown>) => act(pid, () => api.boardCreate(pid, b));
export const patchItem = (pid: string, id: string, b: Record<string, unknown>) => act(pid, () => api.boardPatch(pid, id, b));
export const deleteItem = (pid: string, id: string) => act(pid, () => api.boardDelete(pid, id));
export const acceptItem = (pid: string, id: string, b: Record<string, unknown>) => act(pid, () => api.boardAccept(pid, id, b));
export const setLeader = (pid: string, leader: string | null) => act(pid, () => api.boardLeader(pid, leader));
export const rejectItem = (pid: string, id: string) => act(pid, () => api.boardReject(pid, id));

/** Pointer and keyboard moves both end here: the card jumps at once, the core confirms (or the board reloads and the card snaps back). */
export async function moveItem(pid: string, id: string, status: BoardStatus, index: number, say?: string): Promise<void> {
  const cur = state.views[pid];
  if (cur) set((s) => ({ views: { ...s.views, [pid]: { ...cur, items: moveLocal(cur.items, id, status, index) } }, announce: say ?? s.announce }));
  await act(pid, () => api.boardMove(pid, id, status, index));
}

/** The owner's switch and bounds: stored on the board, applied to the running loop, then read back. */
export async function saveMarshal(projectId: string, cfg: MarshalConfig): Promise<MarshalConfig | undefined> {
  set({ busy: true });
  try { await api.boardMarshal(projectId, cfg); await loadMarshal(projectId); return cfg; }
  catch (e) { toast(errText(e), 'error'); await loadMarshal(projectId); return undefined; }
  finally { set({ busy: false }); }
}

/** The checks that decide one item: what the core stored (it has the last word), or undefined on a refusal. */
export async function saveChecks(projectId: string, itemId: string, checks: string[]): Promise<string[] | undefined> {
  set({ busy: true });
  try { const r = await api.boardDispatch(projectId, itemId, checks); await loadMarshal(projectId); return r.doneWhen; }
  catch (e) { toast(errText(e), 'error'); await loadMarshal(projectId); return undefined; }
  finally { set({ busy: false }); }
}

/** "Run this item": the owner's click. The core starts the run through the ordinary project path (same approval cards). */
export async function runItem(pid: string, id: string): Promise<boolean> {
  const r = await act(pid, () => api.boardRun(pid, id));
  if (!r) return false;
  toast(r.limited ? 'Started. The text was written by an agent and not reviewed, so this run asks before it acts.' : 'Started. The item moves to Review when the run ends.', 'info');
  return true;
}

export function openTask(taskId: string): void { setView('chat'); selectTask(taskId); }
export const sayItem = (text: string): void => set({ announce: text });
export type { WorkItem };
