/**
 * The one seam for the page's view state (spec 3.1, 11.4): which tab and which lens. In memory only, no localStorage key, so the layouts
 * work can move it later without touching the components. Opening a project always lands on Overview.
 */
import { useSyncExternalStore } from 'react';
import type { TabKey } from './pageLogic';

export type Lens = 'state' | 'agent';
export interface PageState { tab: TabKey; lens: Lens; project: string | null }
let state: PageState = { tab: 'overview', lens: 'state', project: null };
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());
export const getPageState = (): PageState => state;
export function usePageState(): PageState { return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state); }
export function setTab(tab: TabKey): void { if (state.tab !== tab) { state = { ...state, tab }; emit(); } }
export function setLens(lens: Lens): void { if (state.lens !== lens) { state = { ...state, lens }; emit(); } }
/** A project was opened (or switched to): Overview, and the lens kept. */
export function enterProject(id: string): void { if (state.project !== id) { state = { ...state, project: id, tab: 'overview' }; emit(); } }
