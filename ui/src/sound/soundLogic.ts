/**
 * UI sounds: which cue plays for which event. Pure (no audio, no DOM), so it is tested without a speaker.
 *
 * Silent by design: typing, hover, ordinary clicks, navigation, streaming and progress never make a sound.
 * Only these do:
 *  - needs you: an approval or a question arrives (notification), a run finishes (complete), a run fails (error). These are the
 *    attention cues: they play even when Legion is in the background, because that is when they help.
 *  - your own click: Allow (success), Deny (cancel), a Settings switch (check / deselect), a run you start (queued, off by default).
 *    These play only while the window has focus: a sound for a click nobody made would be noise.
 * Master off, volume 0 and quiet hours (the same window as pop-ups) silence all of it.
 * prefers-reduced-motion does not mute: sound is not motion. The master switch is the control for people who do not want sound.
 */
import { isQuietAt } from '../../../src/shared/ask-clock.js';
import type { QuietView } from '../away/awayLogic.js';

export type Cue = 'notification' | 'complete' | 'error' | 'success' | 'cancel' | 'check' | 'deselect' | 'queued';

export type SoundEvent =
  | { type: 'ask' }
  | { type: 'run-done' }
  | { type: 'run-failed' }
  | { type: 'run-started' }
  | { type: 'allow' }
  | { type: 'deny' }
  | { type: 'switch'; on: boolean };

export interface SoundPrefs {
  enabled: boolean;
  /** 0 to 1. */
  volume: number;
  pack: string;
  quiet?: QuietView;
  /** The "run started" cue. Off by default: it is the chattiest one. */
  queuedCue: boolean;
}
export interface SoundCtx { now: number; focused: boolean; prefs: SoundPrefs }

/** Defaults for a person who never opened the setting. The core keeps the same values (src/core/away/store.ts). */
export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: true, volume: 0.6, pack: 'minimal', queuedCue: false };

/** Attention cues play without focus; the rest answer your own click. */
const ATTENTION = new Set<SoundEvent['type']>(['ask', 'run-done', 'run-failed']);
/** When several cues compete in one moment, the first in this list is the only one heard. Bad news beats good. */
const PRIORITY: readonly Cue[] = ['error', 'notification', 'cancel', 'success', 'complete', 'check', 'deselect', 'queued'];

function cueOf(e: SoundEvent, prefs: SoundPrefs): Cue | null {
  switch (e.type) {
    case 'ask': return 'notification';
    case 'run-done': return 'complete';
    case 'run-failed': return 'error';
    case 'allow': return 'success';
    case 'deny': return 'cancel';
    case 'switch': return e.on ? 'check' : 'deselect';
    case 'run-started': return prefs.queuedCue ? 'queued' : null;
  }
}

/** The one cue to play for a batch of events that happened together, or null for silence. */
export function cueFor(events: readonly SoundEvent[], ctx: SoundCtx): Cue | null {
  const { prefs } = ctx;
  if (!prefs.enabled || !(prefs.volume > 0)) return null;
  if (isQuietAt(ctx.now, prefs.quiet)) return null;
  let best: Cue | null = null;
  for (const e of events) {
    if (!ctx.focused && !ATTENTION.has(e.type)) continue;
    const c = cueOf(e, prefs);
    if (c && (best === null || PRIORITY.indexOf(c) < PRIORITY.indexOf(best))) best = c;
  }
  return best;
}

/** Per-cue cooldown in ms. The library has its own guard too; this one also keeps the choice of cue stable. */
export const COOLDOWN_MS: Record<Cue, number> = { notification: 2000, complete: 2000, error: 2000, queued: 1500, success: 150, cancel: 150, check: 80, deselect: 80 };
/** No two cues closer than this, whatever they are. */
export const MIN_GAP_MS = 120;

export class CueGate {
  private last = new Map<Cue, number>();
  private any = -Infinity;
  admit(cue: Cue, now: number): boolean {
    if (now - this.any < MIN_GAP_MS) return false;
    const at = this.last.get(cue);
    if (at !== undefined && now - at < COOLDOWN_MS[cue]) return false;
    this.last.set(cue, now);
    this.any = now;
    return true;
  }
}

/** What the director watches: run status by id and the ids of the asks that wait on you (approvals, questions, parked asks). */
export interface SoundSnapshot { tasks: ReadonlyMap<string, string>; asks: ReadonlySet<string> }

/**
 * Events between two snapshots. `prev` null (the first load) is silent. `seen` holds every ask already announced, so a refresh that
 * brings back an ask the window already knew stays quiet. A run that is new in `next` counts as started only while it is queued or running:
 * old tasks that a history page adds are done or failed already and make no sound.
 */
export function diffSnapshots(prev: SoundSnapshot | null, next: SoundSnapshot, seen: Set<string>): SoundEvent[] {
  const out: SoundEvent[] = [];
  const fresh: string[] = [];
  for (const id of next.asks) if (!seen.has(id)) fresh.push(id);
  for (const id of next.asks) seen.add(id);
  if (!prev) return out;
  if (fresh.length) out.push({ type: 'ask' });
  for (const [id, status] of next.tasks) {
    const before = prev.tasks.get(id);
    if (before === undefined) { if (status === 'queued' || status === 'running') out.push({ type: 'run-started' }); continue; }
    if (before !== 'queued' && before !== 'running') continue;
    if (status === 'done') out.push({ type: 'run-done' });
    else if (status === 'error') out.push({ type: 'run-failed' });
  }
  return out;
}
