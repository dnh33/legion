// The Gates page's data: the settings view from the core, refreshed when `gates.updated` arrives, and one way to change it.
// Every change goes through the app window's bridge (`window.legion.gatesChange`): main shows the native confirmation for anything
// that loosens, holds the secret the core demands, and sends the digest of what was shown. This window never holds the secret.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request, subscribe } from '../api';
import type { GatesView } from './presetsLogic';

export type GatesChangeRequest =
  | { kind: 'app'; patch: Record<string, unknown> }
  | { kind: 'project'; id: string; patch: Record<string, unknown> }
  | { kind: 'accept'; name: string }
  | { kind: 'keep'; name: string };

export type GatesOutcome = { state: 'ok' } | { state: 'cancelled' } | { state: 'error'; message: string };

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

  const apply = useCallback(async (change: GatesChangeRequest): Promise<GatesOutcome> => {
    const bridge = window.legion?.gatesChange;
    if (!bridge) return { state: 'error', message: 'Changing gate settings needs the Legion app window, which shows a confirmation. Open the app to do this.' };
    try {
      const r = await bridge(change);
      if (r.cancelled) return { state: 'cancelled' };
      if (!r.ok) return { state: 'error', message: r.error ?? 'The change was not made.' };
      await reload();
      return { state: 'ok' };
    } catch (e) { return { state: 'error', message: msg(e) }; }
  }, [reload]);

  return { view, loadError, reload, apply };
}

/** The core's saved "last read" date per approved site (advisory). An older core without the route answers with nothing. */
export async function loadWebHosts(): Promise<Record<string, string>> {
  try {
    const r = await request<{ allowed: Array<{ host: string; lastUsed?: string }> }>('GET', '/api/gates/web-hosts');
    const out: Record<string, string> = {};
    for (const h of r.allowed ?? []) if (h.lastUsed) out[h.host] = h.lastUsed;
    return out;
  } catch { return {}; }
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

export interface GatesNote { tone: 'ok' | 'info' | 'error'; text: string }
export const PENDING_TEXT = 'Waiting for you to confirm in the window';
/** One change at a time: `pending` is set while the native confirmation can be open, and `note` is the visible result (saved, cancelled, or the reason it failed). */
export function useGatesAction(apply: (c: GatesChangeRequest) => Promise<GatesOutcome>): { pending: boolean; note: GatesNote | null; run: (change: GatesChangeRequest, done: string) => Promise<boolean> } {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<GatesNote | null>(null);
  const run = useCallback(async (change: GatesChangeRequest, done: string): Promise<boolean> => {
    setPending(true); setNote(null);
    const r = await apply(change);
    setPending(false);
    if (r.state === 'ok') setNote({ tone: 'ok', text: done });
    else if (r.state === 'cancelled') setNote({ tone: 'info', text: 'Cancelled. Nothing changed.' });
    else setNote({ tone: 'error', text: r.message });
    return r.state === 'ok';
  }, [apply]);
  return { pending, note, run };
}
