import { useEffect, useRef, useState } from 'react';
import { useStore, type RelicState } from '../store';

export const STATE_LABEL: Record<RelicState, string> = {
  idle: 'Standing vigil', listening: 'Listening', thinking: 'Deliberating', hacking: 'Executing',
  awaiting: 'Awaiting your word', victory: 'Victory', error: 'Fault detected', sleeping: 'Dormant', annoyed: 'Annoyed',
};

const SLEEP_MS = 5 * 60_000;

/** Derives the Relic's state from app state. Priority: lab override > annoyed > approvals > transient (victory/error) > typing > tool use/thinking > sleeping > idle. */
export function useRelicState(annoyed = false): { state: RelicState; vm: boolean } {
  const force = useStore((s) => s.mascotForce);
  const forceVm = useStore((s) => s.mascotVm);
  const pending = useStore((s) => s.approvals.length > 0);
  const mascot = useStore((s) => s.mascot);
  const running = useStore((s) => s.tasks.some((t) => t.status === 'running' || t.status === 'queued'));
  const vmState = useStore((s) => s.vms[s.selectedAgentId]?.state);

  const [transient, setTransient] = useState<'victory' | 'error' | null>(null);
  const [typing, setTyping] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const last = useRef(Date.now());
  const typingTimer = useRef<number | undefined>(undefined);

  // mascot events: transient poses + activity
  useEffect(() => {
    last.current = Date.now();
    setAsleep(false);
    let t: number | undefined;
    if (mascot.mood === 'success') { setTransient('victory'); t = window.setTimeout(() => setTransient(null), 3200); }
    else if (mascot.mood === 'error') { setTransient('error'); t = window.setTimeout(() => setTransient(null), 2000); }
    else setTransient(null);
    return () => { if (t) clearTimeout(t); };
  }, [mascot]);

  // typing in the composer + generic activity
  useEffect(() => {
    const onTyping = () => {
      last.current = Date.now(); setAsleep(false); setTyping(true);
      clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setTyping(false), 1600);
    };
    const bump = () => { last.current = Date.now(); setAsleep((a) => (a ? false : a)); };
    window.addEventListener('legion:typing', onTyping);
    window.addEventListener('keydown', bump);
    window.addEventListener('pointerdown', bump);
    return () => {
      window.removeEventListener('legion:typing', onTyping);
      window.removeEventListener('keydown', bump);
      window.removeEventListener('pointerdown', bump);
      clearTimeout(typingTimer.current);
    };
  }, []);

  // activity from work in flight keeps it awake; otherwise fall asleep after 5 min
  useEffect(() => { if (running || pending) { last.current = Date.now(); setAsleep(false); } }, [running, pending]);
  useEffect(() => {
    const id = window.setInterval(() => { if (Date.now() - last.current > SLEEP_MS) setAsleep(true); }, 5000);
    return () => clearInterval(id);
  }, []);

  let state: RelicState = 'idle';
  if (force) state = force;
  else if (annoyed) state = 'annoyed';
  else if (pending) state = 'awaiting';
  else if (transient) state = transient;
  else if (typing && !running) state = 'listening';
  else if (mascot.mood === 'hacking') state = 'hacking';
  else if (mascot.mood === 'thinking' || running) state = 'thinking';
  else if (mascot.mood === 'sleeping' || asleep) state = 'sleeping';

  const vm = forceVm ?? (vmState === 'running' || vmState === 'ready');
  return { state, vm };
}
