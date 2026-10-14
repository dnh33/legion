/**
 * UI sounds: the window's one place that makes a sound. soundLogic.ts decides; this file watches the app, batches what happens
 * together, and plays through the vendored runtime. It never fetches or decodes a file: the runtime synthesises each cue in the page.
 */
import { createUISFX } from './vendor/uisfx/index.js';
import type { UISFXPlayer, PackName, CueName } from './vendor/uisfx/index.js';
import { getState, subscribeStore, tapDecisions } from '../store';
import { getAway, initAway } from '../projects/awayStore';
import { CueGate, DEFAULT_SOUND_PREFS, cueFor, diffSnapshots, previewAllowed } from './soundLogic';
import type { SoundEvent, SoundPrefs, SoundSnapshot } from './soundLogic';
import { CUSTOM_PACKS, PREVIEW_SEQUENCE, packOrDefault } from './soundPacks';

/** Events that arrive within this window are one moment: ten runs finishing together make one cue. After a cue, the next one waits at least MIN_GAP_MS (120 ms) in soundLogic; the batch window itself is 250 ms. */
const BATCH_MS = 250;

let ctx: AudioContext | null = null;
let player: UISFXPlayer | null = null;
let previewPlayer: UISFXPlayer | null = null;
const gate = new CueGate();
const rendered = new Map<string, AudioBuffer>();

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

/** Current choice: what the core keeps (Settings, Sounds) with the quiet hours it shares with pop-ups. */
export function currentPrefs(): SoundPrefs {
  const app = getAway().view?.app;
  const s = app?.sounds;
  return {
    ...DEFAULT_SOUND_PREFS,
    ...(s ? { enabled: s.enabled, volume: s.volume, pack: packOrDefault(s.pack), events: s.events ?? {} } : {}),
    ...(app?.quiet ? { quiet: app.quiet } : {}),
  };
}

const customPack = (id: string) => CUSTOM_PACKS.find((p) => p.id === id);

/** Cues that happen often get a tiny pitch change (about 1 percent either way) so repeats do not sound mechanical; the urgent ones never do. */
const VARIED = new Set<string>(['complete', 'success', 'cancel', 'check', 'deselect', 'queued']);

function playCustom(packId: string, cue: string, volume: number): void {
  const pack = customPack(packId);
  const c = audio();
  if (!pack || !c) return;
  const key = `${packId}/${cue}/${c.sampleRate}`;
  let buf = rendered.get(key);
  if (!buf) {
    const r = pack.render(cue, c.sampleRate);
    if (!r) return;
    buf = c.createBuffer(2, r.left.length, r.sampleRate);
    buf.copyToChannel(r.left as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r.right as Float32Array<ArrayBuffer>, 1);
    rendered.set(key, buf);
  }
  void c.resume?.();
  const src = c.createBufferSource();
  const gain = c.createGain();
  src.buffer = buf; gain.gain.value = volume;
  if (VARIED.has(cue)) src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.02;
  src.connect(gain); gain.connect(c.destination);
  src.onended = () => { src.disconnect(); gain.disconnect(); };
  src.start();
}

function playNow(cue: string, pack: string, volume: number, p: UISFXPlayer | null): void {
  try {
    if (customPack(pack)) { playCustom(pack, cue, volume); return; }
    if (!p) return;
    p.setPack(pack as PackName); p.setVolume(volume);
    p.play(cue as CueName);
  } catch { /* a sound never breaks the app */ }
}

function makePlayer(): UISFXPlayer | null {
  const c = audio();
  // cooldownMs 0: the CueGate is the only rate limit, so two limiters cannot disagree. No `preferences`: the core keeps the choice, never localStorage.
  return c ? createUISFX({ context: c, cooldownMs: 0, pack: 'minimal' }) : null;
}
const mainPlayer = (): UISFXPlayer | null => (player ??= makePlayer());

/** Decide for one batch and play at most one cue. `focused` is read at the moment of the call. */
function emitCue(events: SoundEvent[]): void {
  const prefs = currentPrefs();
  const now = Date.now();
  const snd = cueFor(events, { now, focused: typeof document === 'undefined' || document.hasFocus(), prefs });
  if (!snd || !gate.admit(snd.cue, now)) return;
  playNow(snd.cue, packOrDefault(snd.pack), prefs.volume, mainPlayer());
}

let queue: SoundEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
/** Report something that happened. Events within BATCH_MS are decided together. */
export function soundEvent(e: SoundEvent): void {
  queue.push(e);
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; const batch = queue; queue = []; emitCue(batch); }, BATCH_MS);
}

let previewTimers: ReturnType<typeof setTimeout>[] = [];
/** The Settings preview: a short sequence in the given pack at the given volume. It ignores the master switch and quiet hours, because you asked for it. */
let lastPreview = -Infinity;
/** Play buttons start a sound at most once per PREVIEW_MIN_MS. */
const previewOk = (): boolean => { const now = Date.now(); if (!previewAllowed(lastPreview, now)) return false; lastPreview = now; return true; };

export function previewPack(pack: string, volume: number): void {
  if (!previewOk()) return;
  for (const t of previewTimers) clearTimeout(t);
  const c = audio();
  if (!c) return;
  void c.resume?.();
  previewPlayer ??= makePlayer();
  const id = packOrDefault(pack);
  previewTimers = PREVIEW_SEQUENCE.map(({ cue, at }) => setTimeout(() => playNow(cue, id, volume, previewPlayer), at));
}

/** One sound now, for a Settings row's Play button: exactly the pack and cue the row would play. */
export function previewSound(pack: string, cue: string, volume: number): void {
  if (!previewOk()) return;
  void audio()?.resume?.();
  previewPlayer ??= makePlayer();
  playNow(cue, packOrDefault(pack), volume, previewPlayer);
}

/** The sound of the Settings sounds switch itself (the shared switch listener skips it, so it plays whatever was just chosen). */
export function playFeedback(cue: string, volume: number, pack: string): void {
  void audio()?.resume?.();
  playNow(cue, packOrDefault(pack), volume, mainPlayer());
}

const snapshotOf = (): SoundSnapshot => {
  const s = getState();
  return {
    tasks: new Map(s.tasks.map((t) => [t.id, t.status])),
    asks: new Set([...s.approvals.map((a) => a.id), ...s.questions.map((q) => q.id), ...s.parked.map((p) => p.id)]),
  };
};

let started = false;
/** Called once at start-up. Watches the store for asks and run results, and the Settings switches a person flips. */
export function startSounds(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  initAway();
  // The browser lets sound start only after a real click or key: wake the audio engine on the first one.
  const wake = (): void => {
    document.removeEventListener('pointerdown', wake, true); document.removeEventListener('keydown', wake, true);
    const c = audio();
    if (c && c.state === 'suspended') void c.resume();
  };
  document.addEventListener('pointerdown', wake, true); document.addEventListener('keydown', wake, true);

  const seen = new Set<string>();
  let prev: SoundSnapshot | null = null;
  subscribeStore(() => {
    if (!getState().loaded) return;
    const next = snapshotOf();
    // The first snapshot after load is the baseline: what already waits makes no sound.
    const events = diffSnapshots(prev, next, seen);
    prev = next;
    for (const e of events) soundEvent(e);
  });
  tapDecisions((allow) => soundEvent({ type: allow ? 'allow' : 'deny' }));
}
