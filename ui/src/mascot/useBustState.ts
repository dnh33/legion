import { useEffect, useRef, useState } from 'react';
import { useStore, type RelicState } from '../store';
import { useComms } from './commsFeed';
import { latestFinished } from './finished';
import { lastToolAt } from './toolActivity';

/** Attention states switch at once; everything else waits out the minimum dwell. */
const INSTANT = new Set<RelicState>(['awaiting', 'error', 'victory']);
export const MIN_DWELL_MS = 1800;
const VICTORY_MS = 3200;
const ERROR_MS = 5000;
const TOOL_MS = 6000;       // a tool message this recent means the agent is typing: hacking
const COMMS_STALE_MS = 90_000; // a comms state with no 'idle' after it is dropped
const SLEEP_MS = 5 * 60_000;

export interface BustSignals {
  pending: boolean; running: boolean;
  /** "status|updatedAt" of the agent's latest finished task */
  finished: string;
  toolAt: string;
  comms: { state: string; at: number } | undefined;
  vmState: string | undefined; vmEnabled: boolean; lastActive: string;
}

/** Pure: which state the signals call for right now. Exported for tests. */
export function deriveBustState(g: BustSignals, t: number): RelicState {
  if (g.pending) return 'awaiting';
  const [fs, fu] = g.finished.split('|');
  const fAge = fu ? t - Date.parse(fu) : Infinity;
  if (fs === 'error' && fAge < ERROR_MS) return 'error';
  if (fs === 'done' && fAge < VICTORY_MS && !g.running) return 'victory';
  if (g.running) return g.toolAt && t - Date.parse(g.toolAt) < TOOL_MS ? 'hacking' : 'thinking';
  const c = g.comms;
  if (c && t - c.at < COMMS_STALE_MS) {
    if (c.state === 'speaking') return 'hacking';
    if (c.state === 'waiting-bot') return 'thinking';
    if (c.state === 'listening' || c.state === 'queued') return 'listening';
  }
  if (g.vmEnabled && g.vmState === 'archived') {
    const last = Math.max(g.lastActive ? Date.parse(g.lastActive) : 0, 0);
    if (!last || t - last > SLEEP_MS) return 'sleeping';
  }
  return 'idle';
}

/** Next moment (absolute, ms since epoch) at which deriveBustState could change by itself (a window expiring); Infinity when none. */
function nextDeadline(g: BustSignals, t: number): number {
  const ds: number[] = [];
  const [, fu] = g.finished.split('|');
  if (fu) { ds.push(Date.parse(fu) + VICTORY_MS, Date.parse(fu) + ERROR_MS); }
  if (g.toolAt) ds.push(Date.parse(g.toolAt) + TOOL_MS);
  if (g.comms) ds.push(g.comms.at + COMMS_STALE_MS);
  if (g.vmEnabled && g.vmState === 'archived' && g.lastActive) ds.push(Date.parse(g.lastActive) + SLEEP_MS);
  const future = ds.filter((d) => d > t);
  return future.length ? Math.min(...future) + 30 : Infinity;
}

/**
 * Per-agent bust state from the store: approvals -> awaiting, task error -> error, task just done -> victory,
 * running task -> thinking (hacking while tool calls stream in), room traffic (comms.state), archived VM + long
 * idle -> sleeping. Non-attention changes respect a 1.8 s minimum dwell. All selectors return primitives,
 * so 13 busts re-render only when their own agent changes.
 */
export function useBustState(agentId: string, enabled = true): { state: RelicState; vm: boolean } {
  const pending = useStore((s) => s.approvals.some((a) => a.agentId === agentId));
  const running = useStore((s) => s.tasks.some((t) => t.agentId === agentId && (t.status === 'running' || t.status === 'queued')));
  const finished = useStore((s) => latestFinished(s.tasks, agentId));
  const lastActive = useStore((s) => {
    let bt = '';
    for (const t of s.tasks) if (t.agentId === agentId && t.updatedAt > bt) bt = t.updatedAt;
    const v = s.vms[agentId]?.lastUsedAt ?? '';
    return v > bt ? v : bt;
  });
  const toolAt = useStore((s) => {
    const t = s.tasks.find((x) => x.agentId === agentId && x.status === 'running');
    // a denied call (and its denial result) is not work: no "Executing" right after Deny
    return t ? lastToolAt(s.messages[t.id], s.denials[t.id]) : '';
  });
  const vmState = useStore((s) => s.vms[agentId]?.state);
  const vmEnabled = useStore((s) => s.agents.find((a) => a.id === agentId)?.vm.enabled ?? false);
  const comms = useComms(agentId);

  const sig: BustSignals = { pending, running, finished, toolAt, comms, vmState, vmEnabled, lastActive };
  const [, bump] = useState(0);
  // wake when a transient window (victory, error, tool, comms, sleep) runs out
  // (keyed on the absolute deadline: the timer is re-armed when the deadline moves, not on every render of every bust)
  const deadline = enabled ? nextDeadline(sig, Date.now()) : Infinity;
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const id = window.setTimeout(() => bump((n) => n + 1), Math.min(Math.max(0, deadline - Date.now()), 2 ** 30));
    return () => clearTimeout(id);
  }, [deadline]);

  const target = enabled ? deriveBustState(sig, Date.now()) : 'idle';
  const [shown, setShown] = useState<RelicState>(target);
  const since = useRef(Date.now());
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    if (!enabled || target === shown) return;
    const wait = INSTANT.has(target) ? 0 : since.current + MIN_DWELL_MS - Date.now();
    if (wait <= 0) { since.current = Date.now(); setShown(target); return; }
    const id = window.setTimeout(() => { since.current = Date.now(); setShown(latest.current); }, wait);
    return () => clearTimeout(id);
  }, [target, shown, enabled]);

  const vm = vmState === 'running' || vmState === 'ready';
  return { state: shown, vm };
}
