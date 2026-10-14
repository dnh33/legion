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

export type EventKey = SoundEvent['type'];
/** What the owner changed for one event: `enabled` false is silent; `sound` plays that cue of that pack instead of the pack's own. */
export interface EventChoice { enabled?: boolean; sound?: { pack: string; cue: string } }

export interface SoundPrefs {
  enabled: boolean;
  /** 0 to 1. */
  volume: number;
  pack: string;
  quiet?: QuietView;
  /** Per-event changes. An event with no entry plays the pack's own cue (the "run started" event is off until its row is switched on). */
  events: Partial<Record<EventKey, EventChoice>>;
}
export interface SoundCtx { now: number; focused: boolean; prefs: SoundPrefs }
/** The sound to play: which event asked, and the pack and cue that answers it. */
export interface Sound { event: EventKey; pack: string; cue: string }

/** Defaults for a person who never opened the setting. The core keeps the same values (src/core/away/store.ts). */
export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: true, volume: 0.6, pack: 'forge', events: {} };

/** The events a person can set one by one, in the order Settings lists them, with the plain words for each. */
export const EVENT_ROWS: ReadonlyArray<{ key: EventKey; label: string; hint: string }> = [
  { key: 'ask', label: 'Something needs you', hint: 'An approval or a question arrives.' },
  { key: 'run-done', label: 'A run finished', hint: 'Many runs finishing together make one sound.' },
  { key: 'run-failed', label: 'A run failed', hint: 'A run stopped with an error.' },
  { key: 'allow', label: 'Allow sent', hint: 'You pressed Allow.' },
  { key: 'deny', label: 'Deny sent', hint: 'You pressed Deny.' },
  { key: 'switch', label: 'A setting switched', hint: 'You turned a switch in Settings on or off.' },
  { key: 'run-started', label: 'A run started or queued', hint: 'Off until you switch it on: it is the chattiest.' },
];
/** Is the event's sound on when the owner has not touched its row? */
export const eventDefaultOn = (k: EventKey): boolean => k !== 'run-started';

/** Attention events play without focus; the rest answer your own click. */
const ATTENTION = new Set<EventKey>(['ask', 'run-done', 'run-failed']);
/** When several events compete in one moment, the first in this list is the only one heard. Bad news beats good. */
const PRIORITY: readonly EventKey[] = ['run-failed', 'ask', 'deny', 'allow', 'run-done', 'switch', 'run-started'];

/** The pack's own cue for an event. */
export function defaultCue(e: SoundEvent): string {
  switch (e.type) {
    case 'ask': return 'notification';
    case 'run-done': return 'complete';
    case 'run-failed': return 'error';
    case 'allow': return 'success';
    case 'deny': return 'cancel';
    case 'switch': return e.on ? 'check' : 'deselect';
    case 'run-started': return 'queued';
  }
}

/** Which sound one event gives: the pack default, the owner's chosen sound, or null when its row is off. */
export function resolveEvent(e: SoundEvent, prefs: SoundPrefs): Sound | null {
  const c = prefs.events[e.type];
  if ((c?.enabled ?? eventDefaultOn(e.type)) === false) return null;
  if (c?.sound) return { event: e.type, pack: c.sound.pack, cue: c.sound.cue };
  return { event: e.type, pack: prefs.pack, cue: defaultCue(e) };
}

/**
 * A row's new choice after the owner changed it, or null when the row is back to its default (so the core keeps nothing for it).
 * `enabled` is stored only when it differs from the event's default; `sound` null returns to the pack's own cue.
 */
export function withChoice(key: EventKey, prev: EventChoice | undefined, change: { enabled?: boolean; sound?: { pack: string; cue: string } | null }): EventChoice | null {
  const enabled = 'enabled' in change ? change.enabled : prev?.enabled;
  const sound = 'sound' in change ? change.sound ?? undefined : prev?.sound;
  const out: EventChoice = {};
  if (enabled !== undefined && enabled !== eventDefaultOn(key)) out.enabled = enabled;
  if (sound) out.sound = { pack: sound.pack, cue: sound.cue };
  return out.enabled === undefined && !out.sound ? null : out;
}

/** The one sound to play for a batch of events that happened together, or null for silence. */
export function cueFor(events: readonly SoundEvent[], ctx: SoundCtx): Sound | null {
  const { prefs } = ctx;
  if (!prefs.enabled || !(prefs.volume > 0)) return null;
  if (isQuietAt(ctx.now, prefs.quiet)) return null;
  let best: Sound | null = null;
  for (const e of events) {
    if (!ctx.focused && !ATTENTION.has(e.type)) continue;
    const s = resolveEvent(e, prefs);
    if (s && (best === null || PRIORITY.indexOf(s.event) < PRIORITY.indexOf(best.event))) best = s;
  }
  return best;
}

/** Per-cue cooldown in ms. The library has its own guard too; this one also keeps the choice of cue stable. */
export const COOLDOWN_MS: Record<string, number> = { notification: 2000, complete: 2000, error: 2000, queued: 1500, success: 150, cancel: 150, check: 80, deselect: 80 };
/** No two cues closer than this, whatever they are. */
export const MIN_GAP_MS = 120;

export class CueGate {
  private last = new Map<string, number>();
  private any = -Infinity;
  admit(cue: string, now: number): boolean {
    if (now - this.any < MIN_GAP_MS) return false;
    const at = this.last.get(cue);
    if (at !== undefined && now - at < (COOLDOWN_MS[cue] ?? 1000)) return false;
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
