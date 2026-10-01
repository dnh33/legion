import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { modelLabel } from '../models';
import { createMascot, type MascotData, type MascotHandle } from './engine.js';
import relicData from './data/relic.json';
import iconUrl from '../art/relic-icon-64.png';
import { STATE_LABEL, useRelicState } from './useRelicState';
import './mascot.css';
import './relic.css';

const MIN_DWELL_MS = 1800;

export const QUIPS = [
  'The build is holy. The build is green.',
  'I do not guess. I grep.',
  'Merge with reverence.',
  'Verify, then ship. Then verify again.',
  'Zero warnings. Zero mercy.',
  'sudo, but with prayer.',
  'A failing test is a sermon waiting to be heard.',
  'Forgive us our unhandled exceptions.',
  'Tokens are finite. Discipline is not.',
  'Main is sacred. Branch in peace.',
  'I have read your logs. We must talk.',
  'Nothing ships unsealed.',
  'Patience. The linter is watching.',
  'Bless this diff.',
];

/**
 * The Relic: the owner's painted concept art (docs/art/relic.svg), split into layers by
 * scripts/build-mascot.py and animated by the shared engine. Nothing is redrawn here.
 */
export function RelicStage({ width = 200 }: { width?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const m = useRef<MascotHandle | null>(null);
  const { state, vm } = useRelicState(false);
  const rawNote = useStore((s) => s.mascot.note);
  const catalog = useStore((s) => s.catalog);
  // the core's note is router jargon ("Zealot on sonnet: prefix /sonnet"); show "Zealot · Sonnet 5.5"
  const nm = rawNote ? /^(.+?) on ([\w.:[\]-]+)(?::.*)?$/.exec(rawNote) : null;
  // while a bridge call (mcp__legion__ask/tell) is the newest thing in a running task: "Zealot → Builder"
  const bridge = useStore((s) => {
    for (const t of s.tasks) {
      if (t.status !== 'running') continue;
      const last = (s.messages[t.id] ?? []).at(-1);
      if (last?.role !== 'tool' || !/^mcp__legion__(ask|tell)$/.test(last.toolName ?? '')) continue;
      try {
        const to = (JSON.parse(last.text) as { agent?: string }).agent; if (!to) continue;
        const nameOf = (id: string) => s.agents.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase())?.name ?? id;
        return `${nameOf(t.agentId)} \u2192 ${nameOf(to)}`;
      } catch { /* ignore */ }
    }
    return null;
  });
  const note = bridge ?? (nm ? `${nm[1]} \u00b7 ${modelLabel(catalog, nm[2])}` : rawNote);

  useEffect(() => {
    if (!host.current) return;
    m.current = createMascot(host.current, relicData as MascotData, { quips: QUIPS, annoyedQuip: 'Stop poking. I am compiling.' });
    return () => { m.current?.destroy(); m.current = null; };
  }, []);
  // Hold each pose for a moment so rapid tool-call events don't make the Relic flicker between states.
  // Attention states (approval, error) and the user's own pokes switch at once.
  const shownAt = useRef(0);
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => {
    const urgent = state === 'awaiting' || state === 'error' || state === 'annoyed';
    const wait = urgent ? 0 : Math.max(0, MIN_DWELL_MS - (Date.now() - shownAt.current));
    clearTimeout(pending.current);
    pending.current = window.setTimeout(() => { m.current?.setState(state); shownAt.current = Date.now(); }, wait);
    return () => clearTimeout(pending.current);
  }, [state]);
  useEffect(() => { m.current?.setVm(vm); }, [vm]);

  return (
    <div className="relic-wrap">
      <div ref={host} style={{ width }} />
      <div className={`mood-label ml-${state}`}>
        <i />{STATE_LABEL[state]}
        {note && state !== 'sleeping' && state !== 'idle' ? <em> {'·'} {note}</em> : null}
        {vm && <span className="vm-tag">VM</span>}
      </div>
    </div>
  );
}

/** Title-bar mark: the Relic icon, rendered from the same art. */
export function RelicGlyph({ size = 22 }: { size?: number }) {
  return <img className="relic-glyph" src={iconUrl} width={size} height={size} alt="" draggable={false} />;
}
