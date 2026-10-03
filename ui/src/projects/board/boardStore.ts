/** Project board state and actions (a small external store, like ../projectsStore). Everything goes through the core; nothing here decides authority. */
import { useSyncExternalStore } from 'react';
import type { BoardStatus, BoardView, WorkItem } from '../../../../src/shared/board';
import { api, ApiError } from '../../api';
import { selectTask, setView, toast } from '../../store';
import { moveLocal } from './boardLogic';

export interface BoardState { enabled: 'unknown' | 'yes' | 'no'; views: Record<string, BoardView | undefined>; busy: boolean; announce: string }
let state: BoardState = { enabled: 'unknown', views: {}, busy: false, announce: '' };
const subs = new Set<() => void>();
const set = (p: Partial<BoardState> | ((s: BoardState) => Partial<BoardState>)): void => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; subs.forEach((f) => f()); };
export function useBoard<T>(sel: (s: BoardState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => sel(state));
}
const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

let probing: Promise<void> | null = null;
/** `GET /api/board` answers 404 unless the board (features.projectBoard) is on: then the window shows nothing of it. */
export function probeBoard(): Promise<void> {
  if (state.enabled !== 'unknown') return Promise.resolve();
  probing ??= api.boardProbe().then(() => set({ enabled: 'yes' }), () => set({ enabled: 'no' }));
  return probing;
}

export async function loadBoard(projectId: string): Promise<void> {
  try { const v = await api.boardView(projectId); set((s) => ({ views: { ...s.views, [projectId]: v } })); } catch (e) { toast(errText(e), 'error'); }
}

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
