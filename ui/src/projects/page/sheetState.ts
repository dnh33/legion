/**
 * The side sheet's one piece of state (spec 3.3): what it shows and who opened it. In memory only (no browser storage). Drafts are kept
 * per sheet key for as long as the window lives, so closing a New task sheet with text in it loses nothing.
 */
import { useSyncExternalStore } from 'react';

export type SheetContent = { kind: 'task'; id: string } | { kind: 'new' };
interface SheetState { content: SheetContent | null; opener: HTMLElement | null }
let state: SheetState = { content: null, opener: null };
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());
export const getSheet = (): SheetState => state;
export function useSheet(): SheetState { return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state); }
export const sheetKey = (c: SheetContent): string => (c.kind === 'new' ? 'new' : `task:${c.id}`);

export function openSheet(content: SheetContent, opener: HTMLElement | null = document.activeElement as HTMLElement | null): void {

  // opening from inside the sheet itself keeps the original opener, so Esc still returns to the control that started it
  const keep = state.content && opener?.closest('[data-region="sheet"]') ? state.opener : opener;
  state = { content, opener: keep && keep.isConnected ? keep : state.opener };
  emit();
}
export function closeSheet(): void {
  const { opener } = state;
  state = { content: null, opener: null };
  emit();
  requestAnimationFrame(() => { if (opener?.isConnected) opener.focus(); else document.querySelector<HTMLElement>('[data-fk="new"]')?.focus(); });
}

const drafts = new Map<string, string>();
export const getDraft = (key: string): string => drafts.get(key) ?? '';
export function setDraft(key: string, text: string): void { if (text) drafts.set(key, text); else drafts.delete(key); }
