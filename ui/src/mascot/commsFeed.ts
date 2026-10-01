/**
 * Latest room-communication state per agent (LegionEvent 'comms.state'), for the busts.
 * store.ts does not carry these events, so this module keeps ONE shared SSE subscription of its own,
 * opened with the first bust and closed with the last. If the store later forwards the event as
 *   window.dispatchEvent(new CustomEvent('legion:comms', { detail: event }))
 * that is honoured too (and the extra subscription can then be dropped).
 */
import { useSyncExternalStore } from 'react';
import type { LegionEvent } from '../../../src/shared/types';
import type { CommsState } from '../../../src/shared/comms';
import { subscribe } from '../api';

export interface CommsEntry { state: CommsState; at: number }
const map = new Map<string, CommsEntry>();
const listeners = new Set<() => void>();
let unsub: (() => void) | null = null;
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
  unsub = subscribe((e) => { if (e.type === 'comms.state') put(e); }, () => {});
}
function close() {
  if (--refs > 0) return;
  window.removeEventListener('legion:comms', onWindow);
  unsub?.(); unsub = null;
}
function sub(l: () => void) { open(); listeners.add(l); return () => { listeners.delete(l); close(); }; }

export function useComms(agentId: string): CommsEntry | undefined {
  return useSyncExternalStore(sub, () => map.get(agentId));
}
/** Test hook: feed a comms event without a core. */
export const __putComms = put;
