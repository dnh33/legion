// The Gates page's data: the settings view from the core, refreshed when `gates.updated` arrives, and one way to change it.
// Every change goes through the app window's bridge (`window.legion.gatesChange`): main shows the native confirmation for anything
// that loosens, holds the secret the core demands, and sends the digest of what was shown. This window never holds the secret.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request, subscribe } from '../api';
import type { GatesView } from './presetsLogic';
import { applyViaBridge, runAction } from './gatesAction';
import type { GatesChangeRequest, GatesNote, GatesOutcome } from './gatesAction';
export { CANCELLED_NOTE } from './gatesAction';
export type { GatesChangeRequest, GatesNote, GatesOutcome } from './gatesAction';


const msg = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function useGatesView(): {
  view: GatesView | null; loadError: string | null; reload: () => Promise<void>;
  apply: (change: GatesChangeRequest) => Promise<GatesOutcome>;
} {
  const [view, setView] = useState<GatesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try { const v = await request<GatesView>('GET', '/api/gates/settings'); if (alive.current) { setView(v); setLoadError(null); } }
    catch (e) { if (alive.current) setLoadError(msg(e)); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    const off = subscribe((e) => { if (e.type === 'gates.updated') void reload(); }, () => {});
    return () => { alive.current = false; off(); };
  }, [reload]);

  const apply = useCallback((change: GatesChangeRequest): Promise<GatesOutcome> => applyViaBridge(window.legion?.gatesChange, change, reload), [reload]);

  return { view, loadError, reload, apply };
}

/** The core's saved dates per approved site (advisory): when each was last read, and when you approved it. One answer for both. Throws when the core cannot answer, so the page can say the dates are unknown instead of treating every site as never used. */
export async function loadWebHosts(): Promise<{ lastUsed: Record<string, string>; approvedAt: Record<string, string> }> {
  const r = await request<{ allowed: Array<{ host: string; lastUsed?: string; approvedAt?: string }> }>('GET', '/api/gates/web-hosts');
  const lastUsed: Record<string, string> = {}; const approvedAt: Record<string, string> = {};
  for (const h of r.allowed ?? []) { if (h.lastUsed) lastUsed[h.host] = h.lastUsed; if (h.approvedAt) approvedAt[h.host] = h.approvedAt; }
  return { lastUsed, approvedAt };
}

export interface ActivityRow { at: string; kind: string; text: string; taskId?: string; projectId?: string; agentId?: string }
export interface ActivityQuery { projectId?: string; taskId?: string; kinds?: string[]; limit?: number }
/** Newest first. The core answers up to 1000 lines. */
export async function loadActivity(q: ActivityQuery = {}): Promise<ActivityRow[]> {
  const sp = new URLSearchParams();
  if (q.projectId) sp.set('projectId', q.projectId);
  if (q.taskId) sp.set('taskId', q.taskId);
  if (q.kinds?.length) sp.set('kinds', q.kinds.join(','));
  if (q.limit) sp.set('limit', String(q.limit));
  const rows = await request<ActivityRow[]>('GET', `/api/activity${sp.size ? `?${sp}` : ''}`);
  return Array.isArray(rows) ? rows : [];
}

/** Read the settings files again (the Reload button for a file that could not be read). */
export async function reloadGatesFromDisk(): Promise<void> { await request('POST', '/api/gates/reload'); }

export const PENDING_TEXT = 'Waiting for you to confirm in the window';
/** One change at a time: `pending` is set while the native confirmation can be open, and `note` is the visible result (saved, cancelled, or the reason it failed). */
export function useGatesAction(apply: (c: GatesChangeRequest) => Promise<GatesOutcome>): { pending: boolean; note: GatesNote | null; run: (change: GatesChangeRequest, done: string) => Promise<boolean> } {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<GatesNote | null>(null);
  const run = useCallback(async (change: GatesChangeRequest, done: string): Promise<boolean> => {
    setPending(true); setNote(null);
    const r = await runAction(apply, change, done);
    setPending(false);
    setNote(r.note);
    return r.ok;
  }, [apply]);
  return { pending, note, run };
}
