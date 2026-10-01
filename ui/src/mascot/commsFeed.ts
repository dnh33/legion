/**
 * Latest room-communication state per agent (LegionEvent 'comms.state'), for the busts.
 * store.ts forwards every 'comms.state' event it receives as
 *   window.dispatchEvent(new CustomEvent('legion:comms', { detail: event }))
 * and this module listens for that, so it needs no stream of its own (the app has ONE shared SSE connection, see api.ts).
 */
import { useSyncExternalStore } from 'react';
import type { LegionEvent } from '../../../src/shared/types';
import type { CommsState } from '../../../src/shared/comms';

export interface CommsEntry { state: CommsState; at: number }
const map = new Map<string, CommsEntry>();
const listeners = new Set<() => void>();
let refs = 0;

function put(e: { agentId: string; state: CommsState }) {
  const prev = map.get(e.agentId);
  if (prev && prev.state === e.state) return;
  map.set(e.agentId, { state: e.state, at: Date.now() });
  listeners.forEach((l) => l());
}
const onWindow = (ev: Event) => { const d = (ev as CustomEvent<LegionEvent>).detail; if (d && d.type === 'comms.state') put(d); };

function open() {
  if (refs++ > 0) return;
  window.addEventListener('legion:comms', onWindow);
}
function close() {
  if (--refs > 0) return;
  window.removeEventListener('legion:comms', onWindow);
}
function sub(l: () => void) { open(); listeners.add(l); return () => { listeners.delete(l); close(); }; }

export function useComms(agentId: string): CommsEntry | undefined {
  return useSyncExternalStore(sub, () => map.get(agentId));
}
/** Test hook: feed a comms event without a core. */
export const __putComms = put;
