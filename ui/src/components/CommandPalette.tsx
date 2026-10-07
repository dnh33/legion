import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelSelected, closeOverlays, newTask, openDoctor, openEditor, openSettings, selectAgent, toggleMascotLab, toggleOps, toggleTheme, useStore, vmAction,
} from '../store';
import { vmIsLive } from '../util';
import { openBsvPanel, useBsv } from '../bsv/bsvStore';
import { openCi } from '../ci/ciStore';
import { TAKEOVER_EVENT } from '../mascot/Takeover';

interface Cmd { id: string; label: string; glyph?: string; hint?: string; run: () => void; group: string }

export function CommandPalette() {
  const agents = useStore((s) => s.agents);
  const agentId = useStore((s) => s.selectedAgentId);
  const vms = useStore((s) => s.vms);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const agent = agents.find((a) => a.id === agentId);
  const live = vmIsLive(vms[agentId]?.state);
  const boat = useStore((s) => s.boatConfigured);
  const bsvOn = useBsv((s) => s.enabled);
  const running = useStore((s) => s.tasks.some((t) => t.id === s.selectedTaskId && (t.status === 'running' || t.status === 'queued')));

  const cmds = useMemo<Cmd[]>(() => {
    const c: Cmd[] = [
      { id: 'new', group: 'Tasks', label: 'New task', hint: 'Ctrl N', run: newTask },
      ...agents.map((a, n): Cmd => ({ id: 'a-' + a.id, group: 'Switch agent', label: a.name, glyph: a.emoji || '\u25cf', hint: n < 9 ? `Alt ${n + 1}` : undefined, run: () => selectAgent(a.id) })),
    ];
    if (running) c.push({ id: 'stop', group: 'Tasks', label: 'Stop the running task', run: () => void cancelSelected() });
    // Start needs a boat.dev key; Stop stays available for a VM that is already live
    if (agent?.vm.enabled && (boat || live)) c.push({ id: 'vm', group: 'Computer', label: `${live ? 'Stop' : 'Start'} ${agent.name}’s VM`, run: () => void vmAction(agentId, live ? 'stop' : 'start') });
    c.push(
      { id: 'edit', group: 'Agents', label: `Edit ${agent?.name ?? 'agent'}`, run: () => openEditor(agentId) },
      { id: 'newagent', group: 'Agents', label: 'New agent…', run: () => openEditor(null) },
      { id: 'settings', group: 'App', label: 'Settings', hint: 'Ctrl ,', run: () => openSettings() },
      { id: 'boatkey', group: 'App', label: 'Add or change boat.dev key', run: () => openSettings('boat') },
      { id: 'doctor', group: 'App', label: 'Open Doctor (sign-in & setup checks)', run: openDoctor },
      { id: 'ci', group: 'App', label: 'CI panel (GitHub Actions runs for this repository)', run: openCi },
      ...(bsvOn ? [{ id: 'bsv', group: 'App', label: 'BSV panel (wallet, live funds, freeze, activity)', run: openBsvPanel }] : []),
      { id: 'model', group: 'App', label: 'Change model', hint: 'Ctrl M', run: () => window.dispatchEvent(new Event('legion:model-picker')) },
      { id: 'lab', group: 'App', label: 'Mascot Lab', hint: 'Ctrl Shift M', run: toggleMascotLab },
      { id: 'theme', group: 'App', label: 'Toggle theme', run: toggleTheme },
      { id: 'deus-vult', group: 'App', label: 'Deus vult', run: () => window.dispatchEvent(new Event(TAKEOVER_EVENT)) },
      { id: 'ops', group: 'App', label: 'Toggle Ops panel', hint: 'Ctrl .', run: toggleOps },
    );
    return c;
  }, [agents, agent, agentId, live, boat, running, bsvOn]);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return cmds.filter((c) => words.every((w) => (c.label + ' ' + c.group).toLowerCase().includes(w)));
  }, [cmds, q]);
  useEffect(() => setI(0), [q]);
  useEffect(() => { list.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [i]);

  const exec = (c?: Cmd) => { if (!c) return; closeOverlays(); setTimeout(c.run, 0); };

  return (
    <div className="scrim top" onMouseDown={(e) => { if (e.target === e.currentTarget) closeOverlays(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input data-autofocus autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command or agent name…" spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(shown.length - 1, n + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); exec(shown[i]); }
          }} aria-label="Command" />
        <div className="cmd-list scroll-cue" ref={list} role="listbox">
          {shown.length === 0 && <div className="cmd-empty">No matches</div>}
          {shown.map((c, n) => (
            <button key={c.id} role="option" aria-selected={n === i} className={`pal-row${n === i ? ' sel' : ''}`} onMouseMove={() => setI(n)} onClick={() => exec(c)}>
              <span className="cmd-group">{c.group}</span><span className="cmd-label">{c.glyph && <span className="avatar chip">{c.glyph}</span>}{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
