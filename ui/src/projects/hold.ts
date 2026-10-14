/**
 * The digest's hold (spec 3.2): an Allow-type answer typed in the digest is not sent at once. It waits on the client for a countdown
 * (5 s, 10 s when the ask is irreversible) with Undo and Send now.
 *
 * Safety property (spec 5.2): the hold lives only in memory. Nothing is sent until the countdown ends or Send now is pressed, so a
 * reload, a crash or a kill during the hold sends nothing, and the ask is still pending in the core. This module therefore touches no
 * storage and no network: the caller hands it the one `send` function.
 *
 * Pure and clock-free: the caller drives it with `tick(dtMs)`, so a test can step it exactly.
 */
import { clickOnly } from '../../../src/shared/approval-keys.js';

export const HOLD_MS = 5000;
export const HOLD_IRREVERSIBLE_MS = 10_000;
/** The second A on an irreversible ask must follow the first within this long. */
export const SECOND_A_MS = 2000;

/** 10 s for a certain level 3 ask (leaves your computer, deletes, spends); 5 s for everything else. */
export const holdMs = (c: { level: number; certain: boolean } | undefined): number => (c && c.level === 3 && c.certain ? HOLD_IRREVERSIBLE_MS : HOLD_MS);

export type HoldPhase = 'counting' | 'sent' | 'undone' | 'refused' | 'disposed';
export interface HoldView { phase: HoldPhase; totalMs: number; leftMs: number; paused: boolean; reason?: string }
export type SendResult = { ok: true } | { ok: false; reason?: string };

export interface Hold {
  view(): HoldView;
  /** Time passed. Counts down only while not paused; reaching zero sends once. */
  tick(dtMs: number): void;
  pointerEnter(): void;
  pointerLeave(): void;
  /** Keyboard focus is inside the row and `:focus-visible` matches. */
  focus(visible: boolean): void;
  undo(): void;
  sendNow(): void;
  /** The row is gone (or the window is): from now on nothing is ever sent. */
  dispose(): void;
}

export function createHold(o: { totalMs: number; send: () => Promise<SendResult>; onChange?: (v: HoldView) => void }): Hold {
  let phase: HoldPhase = 'counting';
  let left = Math.max(0, o.totalMs);
  let reason: string | undefined;
  let pointerOver = true;     // the click happened under the pointer
  let leftOnce = false;       // a pointer that never left does not freeze the countdown
  let focusVisible = false;
  let sentOnce = false;
  const paused = (): boolean => phase === 'counting' && (focusVisible || (leftOnce && pointerOver));
  const view = (): HoldView => ({ phase, totalMs: o.totalMs, leftMs: left, paused: paused(), ...(reason ? { reason } : {}) });
  const emit = (): void => { try { o.onChange?.(view()); } catch { /* a listener must not break the hold */ } };
  const fire = (): void => {
    if (phase !== 'counting' || sentOnce) return;
    sentOnce = true;
    phase = 'sent'; left = 0;
    emit();
    o.send().then((r) => {
      if (phase === 'disposed') return;
      if (!r.ok) { phase = 'refused'; reason = r.reason; emit(); }
    }, () => { if (phase !== 'disposed') { phase = 'refused'; reason = undefined; emit(); } });
  };
  return {
    view,
    tick(dt) {
      if (phase !== 'counting' || paused() || !(dt > 0)) return;
      left = Math.max(0, left - dt);
      if (left === 0) fire(); else emit();
    },
    pointerEnter() { pointerOver = true; emit(); },
    pointerLeave() { pointerOver = false; leftOnce = true; emit(); },
    focus(v) { focusVisible = v; emit(); },
    undo() { if (phase !== 'counting') return; phase = 'undone'; emit(); },
    sendNow() { fire(); },
    dispose() { if (phase === 'sent' || phase === 'refused') return; phase = 'disposed'; },
  };
}

/* ---------- keys in the digest ---------- */

export interface KeyAsk { id: string; toolName: string; level: number; certain: boolean }
/** The one thing pending between two key presses: the irreversible ask whose first A is waiting for its second. */
export interface KeyState { armed?: { id: string; at: number } }
export type KeyAction = { kind: 'allow'; id: string } | { kind: 'deny'; id: string } | { kind: 'arm'; id: string } | null;

/**
 * What a key does in the digest, with the thread's rule (`approval-keys.ts`): `armed` is true only when the row has been on screen and
 * the keyboard quiet for ARM_MS, so stray typing never answers. D denies. A allows a normal ask. A on an irreversible ask only arms it:
 * a second A within SECOND_A_MS allows. A never acts on a click-only card or on an ask whose effect is not certain (those rows offer
 * Open only). Any other key clears the arm.
 */
export function digestKey(ask: KeyAsk | undefined, key: string, armed: boolean, nowMs: number, st: KeyState): { action: KeyAction; state: KeyState } {
  const none = (state: KeyState = {}): { action: KeyAction; state: KeyState } => ({ action: null, state });
  if (!ask) return none();
  if (key === 'd' || key === 'D') return armed ? { action: { kind: 'deny', id: ask.id }, state: {} } : none();
  if (key !== 'a' && key !== 'A') return none();
  if (clickOnly(ask) || !ask.certain) return none();
  if (ask.level === 3) {
    if (st.armed && st.armed.id === ask.id && nowMs - st.armed.at <= SECOND_A_MS) return { action: { kind: 'allow', id: ask.id }, state: {} };
    return armed ? { action: { kind: 'arm', id: ask.id }, state: { armed: { id: ask.id, at: nowMs } } } : none();
  }
  return armed ? { action: { kind: 'allow', id: ask.id }, state: {} } : none();
}
