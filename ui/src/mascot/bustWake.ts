/**
 * Pure wake/sleep gate for a resting bust (no DOM, so node tests import it).
 * still     the picture; no engine.
 * warming   pointer is on the bust: the engine is mounting, the still stays until the engine has painted a real frame.
 * live      the live bust is shown, the still is faded out.
 * sleeping  pointer left: the still fades back in over the live frame, and the engine goes only when it is fully back.
 */
export type WakePhase = 'still' | 'warming' | 'live' | 'sleeping';
export type WakeEvent = 'wake' | 'sleep' | 'painted' | 'faded';

export function wakeReduce(p: WakePhase, e: WakeEvent): WakePhase {
  switch (e) {
    case 'wake': return p === 'still' ? 'warming' : p === 'sleeping' ? 'live' : p;
    case 'sleep': return p === 'warming' ? 'still' : p === 'live' ? 'sleeping' : p;
    case 'painted': return p === 'warming' ? 'live' : p;
    case 'faded': return p === 'sleeping' ? 'still' : p;
  }
}

/** Zero engines at rest: only the three awake phases hold one. */
export const engineMounted = (p: WakePhase): boolean => p !== 'still';
/** The still is on screen (fully or cross-fading) in every phase except a settled live bust. */
export const stillVisible = (p: WakePhase): boolean => p !== 'live';
