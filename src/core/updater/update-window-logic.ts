/**
 * The rules of the "Updating Legion" window, kept free of electron so they are tested: when the window closes, who holds the
 * single-instance lock, what the helper may tell it, and what it shows for a journey.
 *
 * Like journey.ts this runs outside the install (it is copied next to the window's files), so its only import is journey.ts.
 */
import { plainReason, type JourneyView } from './journey.js';

/** No window lives longer than this. A full update with a slow first start takes under 8 minutes; this is the hard stop for every other case. */
export const WINDOW_HARD_CAP_MS = 15 * 60_000;
/** After the helper says ok, the window shows every step checked for this long, then closes. */
export const WINDOW_DONE_SHOW_MS = 1500;
/** A failure stays until the person chooses; this is only the limit for a person who is away. */
export const WINDOW_FAIL_LINGER_MS = 5 * 60_000;
/** A helper that has been gone this long without a result left the window behind. */
export const WINDOW_ORPHAN_GRACE_MS = 3000;

export type WindowResult = 'ok' | 'failed' | 'rolled-back';
export interface WindowFinish { result: WindowResult; message?: string; at: number }
export interface WindowState { openedAt: number; /** How long the helper's process has been gone (0 while it is alive). */ helperDeadForMs: number; finish?: WindowFinish; choice?: 'retry' | 'close' }
export type WindowDecision = { close: false } | { close: true; reason: 'user-closed' | 'user-retry' | 'hard-cap' | 'done' | 'failed-linger' | 'orphan' };

/** Should the window close now? Checked a few times a second; every way out has a name so the log says why. */
export function windowDecision(s: WindowState, nowMs: number): WindowDecision {
  if (s.choice === 'retry') return { close: true, reason: 'user-retry' };
  if (s.choice === 'close') return { close: true, reason: 'user-closed' };
  if (nowMs - s.openedAt >= WINDOW_HARD_CAP_MS) return { close: true, reason: 'hard-cap' };
  if (s.finish) {
    const shown = nowMs - s.finish.at;
    if (s.finish.result === 'ok') return shown >= WINDOW_DONE_SHOW_MS ? { close: true, reason: 'done' } : { close: false };
    return shown >= WINDOW_FAIL_LINGER_MS ? { close: true, reason: 'failed-linger' } : { close: false };
  }
  if (s.helperDeadForMs >= WINDOW_ORPHAN_GRACE_MS) return { close: true, reason: 'orphan' };
  return { close: false };
}

/**
 * The single-instance lock. The window takes it under Legion's identity (same userData folder) as soon as the old app lets go, so a person who
 * reopens Legion lands in this window. Before the helper starts the new build it asks the window to let go, and the new build takes it.
 * After that the window never asks again: it would take the lock back from the build it is waiting for.
 */
export function lockAction(s: { held: boolean; released: boolean }, o: { releaseRequested: boolean; finished: boolean; /** The old app has exited. Asking earlier would make it bring its closing window forward. */ appGone: boolean }): 'request' | 'release' | 'none' {
  if (s.held) return o.releaseRequested ? 'release' : 'none';
  if (s.released || o.releaseRequested || o.finished || !o.appGone) return 'none';
  return 'request';
}

/** What the helper tells the window, one numbered line at a time in commands.jsonl. */
export interface WindowCommand { seq: number; cmd: 'release-lock' | 'finish'; result?: WindowResult; message?: string }
export function parseCommands(text: string): WindowCommand[] {
  const out: WindowCommand[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as Partial<WindowCommand>;
      if (!v || typeof v.seq !== 'number' || (v.cmd !== 'release-lock' && v.cmd !== 'finish')) continue;
      const c: WindowCommand = { seq: v.seq, cmd: v.cmd };
      if (v.result === 'ok' || v.result === 'failed' || v.result === 'rolled-back') c.result = v.result;
      if (typeof v.message === 'string') c.message = v.message;
      out.push(c);
    } catch { /* a damaged line is skipped */ }
  }
  return out;
}
export const pendingCommands = (text: string, handledSeq: number): WindowCommand[] => parseCommands(text).filter((c) => c.seq > handledSeq).sort((a, b) => a.seq - b.seq);

export type RowState = 'done' | 'active' | 'pending' | 'failed';
export interface WindowModel {
  title: string; subtitle: string;
  rows: Array<{ label: string; state: RowState }>;
  bar: { mode: 'sweep' } | { mode: 'pct'; pct: number } | { mode: 'full' } | { mode: 'none' };
  message?: string; buttons: string[]; tone: 'working' | 'ok' | 'failed'; footer: string;
}

/** What the window shows for a journey. `view` is null before the first step is written. The first four steps (download and checks) are one row: the app already showed them. */
export function windowModel(view: JourneyView | null, finish: WindowFinish | undefined): WindowModel {
  const result: WindowResult | 'running' = finish?.result ?? (view && view.result !== 'running' ? view.result : 'running');
  const rows: WindowModel['rows'] = [{ label: 'Downloaded and verified', state: 'done' }];
  const later = (view?.steps ?? []).filter((s) => s.n === '5' || Number(s.n) >= 5).filter((s) => s.state !== 'skipped');
  if (!later.length) {
    for (const [i, label] of ['Closing Legion', 'Installing', 'Starting the new version', 'Checking that it runs', 'Done'].entries()) rows.push({ label, state: i === 0 ? 'active' : 'pending' });
  } else {
    for (const s of later) rows.push({ label: s.label, state: s.state === 'skipped' ? 'pending' : s.state });
  }
  if (result === 'ok') for (const r of rows) r.state = 'done';
  // between two steps the helper is still working: the next step reads as under way, not as stalled
  if (result === 'running' && !rows.some((r) => r.state === 'active' || r.state === 'failed')) { const next = rows.find((r) => r.state === 'pending'); if (next) next.state = 'active'; }
  const tone: WindowModel['tone'] = result === 'ok' ? 'ok' : result === 'running' ? 'working' : 'failed';
  const title = result === 'ok' ? 'Legion is updated' : result === 'failed' ? 'The update did not finish' : result === 'rolled-back' ? 'Went back to the previous version' : 'Updating Legion';
  const active = view?.steps.find((s) => s.state === 'active');
  const bar: WindowModel['bar'] = result === 'ok' ? { mode: 'full' } : result !== 'running' ? { mode: 'none' } : active?.id === 'preparing' && view?.pct !== undefined ? { mode: 'pct', pct: Math.max(0, Math.min(100, Math.round(view.pct))) } : { mode: 'sweep' };
  const m: WindowModel = {
    title, subtitle: view?.from && view.to ? `${view.from} to ${view.to}` : '', rows, bar, buttons: result === 'failed' || result === 'rolled-back' ? ['Retry', 'Close'] : [], tone,
    footer: result === 'running' ? 'Legion opens by itself when it is ready.' : result === 'ok' ? 'Opening Legion.' : '',
  };
  if (result === 'failed' || result === 'rolled-back') { const why = plainReason(finish?.message ?? view?.reason); m.message = `${why.charAt(0).toUpperCase()}${why.slice(1)}. Your files are unchanged.`; }
  return m;
}

/**
 * What the app does about a failed update at its next start, given the window that showed it. A window still open owns the question (wait);
 * when it closed after the person pressed Retry, the app retries without asking again; after Close it stays quiet (Settings still shows the
 * record); with no answer (the window never ran, crashed, or timed out) the app asks, as it did before the window existed.
 */
export function noticeAfterWindow(w: { open: boolean; result?: { id?: string; choice?: string } | null }, journeyId: string | undefined): 'wait' | 'retry' | 'quiet' | 'ask' {
  if (w.open) return 'wait';
  if (!w.result || !journeyId || w.result.id !== journeyId) return 'ask';
  return w.result.choice === 'retry' ? 'retry' : w.result.choice === 'close' ? 'quiet' : 'ask';
}

/** What the small window a reopened Legion shows (the start gate) displays: the same look and steps, no buttons (a gate cannot retry), and its own title while it works. */
export function gateModel(view: JourneyView | null, toVersion: string | undefined): WindowModel {
  const m = windowModel(view, undefined);
  const working = m.tone === 'working';
  return { ...m, title: working ? 'Legion is finishing an update' : m.title, subtitle: m.subtitle || (toVersion ? `to ${toVersion}` : ''), buttons: [], footer: working ? 'It opens by itself.' : m.footer };
}
