/** Pure view logic of the CI panel (no DOM, no CSS), shared by ui/src/ci and its tests. */
import type { CiProblem } from './ci.js';

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export type Tone = 'ok' | 'bad' | 'run' | 'idle';
/** One word and one tone for a run or job. The word always shows beside the colour. */
export function runLook(status: string, conclusion: string | null): { tone: Tone; word: string } {
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested') return { tone: 'run', word: 'Queued' };
  if (status !== 'completed') return { tone: 'run', word: 'Running' };
  if (conclusion === 'success') return { tone: 'ok', word: 'Passed' };
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return { tone: 'bad', word: 'Failed' };
  if (conclusion === 'action_required') return { tone: 'bad', word: 'Needs action' };
  if (conclusion === 'cancelled') return { tone: 'idle', word: 'Cancelled' };
  if (conclusion === 'skipped') return { tone: 'idle', word: 'Skipped' };
  return { tone: 'idle', word: 'Done' };
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const d = now - Date.parse(iso);
  if (!Number.isFinite(d) || d < 0) return '';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const clock = (iso?: string): string => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'later'; };

/** Plain sentence for each problem the core can report. */
export function problemText(p: CiProblem): string {
  switch (p.kind) {
    case 'not-connected': return 'This repository is private. Connect GitHub to see its runs.';
    case 'auth-expired': return 'Your GitHub sign-in has expired. Connect GitHub again.';
    case 'forbidden': return 'GitHub did not allow this request. Check the access in Settings, Connectors.';
    case 'rate-limited': return `GitHub is limiting requests. Updates resume at ${clock(p.resetAt)}.`;
    case 'budget': return `Paused to stay within GitHub's hourly limit. Updates resume at ${clock(p.resetAt)}.`;
    case 'not-found': return 'GitHub does not show this repository. Check the name, or connect GitHub if it is private.';
    default: return 'Could not reach GitHub. Showing the last answer.';
  }
}

/* ---------- float / dock geometry ---------- */
export type PanelMode = 'float' | 'dock';
export interface PanelGeometry { mode: PanelMode; x: number; y: number; w: number; h: number; dockW: number }
export const PANEL_MIN_W = 320;
export const PANEL_MIN_H = 260;
export const PANEL_TOP = 40; // the title bar

/** Keeps a geometry inside the window. A panel dragged off screen, or a window made smaller, never strands it. */
export function clampGeometry(g: PanelGeometry, vw: number, vh: number): PanelGeometry {
  const w = Math.min(Math.max(g.w, PANEL_MIN_W), Math.max(PANEL_MIN_W, vw - 16));
  const h = Math.min(Math.max(g.h, PANEL_MIN_H), Math.max(PANEL_MIN_H, vh - PANEL_TOP - 16));
  const dockW = Math.min(Math.max(g.dockW, PANEL_MIN_W), Math.max(PANEL_MIN_W, Math.floor(vw * 0.6)));
  return { ...g, w, h, dockW, x: Math.min(Math.max(g.x, 8), Math.max(8, vw - w - 8)), y: Math.min(Math.max(g.y, PANEL_TOP + 4), Math.max(PANEL_TOP + 4, vh - h - 8)) };
}
