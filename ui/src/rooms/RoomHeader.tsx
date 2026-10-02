import { useEffect, useRef, useState } from 'react';
import type { Room } from '../../../src/shared/comms';
import { ROOM_BUDGET_NOTE } from '../../../src/shared/providers-view';
import type { AgentProfile } from '../../../src/shared/types';
import { Icon } from '../components/icons';
import { Face } from './Stack';
import { toast } from '../store';
import './rooms.css';
import { activeIn, exportRoom, freezeRoom, PAUSE_LABEL, resumeRoom, setSettingsOpen, type LiveState } from './roomsStore';
import { fmtBudget, fmtCost, STRATEGY_INFO } from './roomsUtil';

function Meter({ label, value, max, text, title }: { label: string; value: number; max: number | null; text: string; title: string }) {
  const pct = max !== null && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct >= 100 ? 'full' : pct >= 70 ? 'hot' : '';
  return (
    <div className={`rm-meter ${tone}`} title={title} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max ?? undefined} aria-valuenow={max === null ? value : Math.min(value, max)} aria-valuetext={text}>
      <span className="rm-meter-l">{label}</span>
      <span className="rm-meter-bar"><i style={{ width: `${pct}%` }} /></span>
      <span className="rm-meter-v">{text}</span>
    </div>
  );
}

function ExportMenu({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); wrap.current?.querySelector<HTMLElement>('button')?.focus(); } };
    window.addEventListener('mousedown', down); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { if (open) wrap.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(); }, [open]);
  const go = async (f: 'md' | 'json') => {
    setOpen(false); setBusy(true);
    try { await exportRoom(roomId, f); toast(`Exported transcript as .${f}`); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    setBusy(false);
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div className="rm-menuwrap" ref={wrap}>
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} disabled={busy} title="Download the transcript">
        <Icon name="ext" size={13} /> Export
      </button>
      {open && (
        <div className="rm-menu" role="menu" aria-label="Export transcript" onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" onClick={() => void go('md')}>Markdown <span>.md</span></button>
          <button type="button" role="menuitem" onClick={() => void go('json')}>JSON <span>.json</span></button>
        </div>
      )}
    </div>
  );
}

export function RoomHeader({ room, agents, live, offline, narrow, onList }: {
  room: Room; agents: AgentProfile[]; live: Record<string, LiveState>; offline: boolean; narrow: boolean; onList: () => void;
}) {
  const nm = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const act = new Map(activeIn(live, room).map((a) => [a.agentId, a.state]));
  const [freezing, setFreezing] = useState(false);
  const paused = room.paused;
  const g = room.guards;
  return (
    <header className="rm-head">
      <div className="rm-head-top">
        {narrow && <button type="button" className="icon-btn" onClick={onList} aria-label="Show rooms list" title="Rooms"><Icon name="sidebar" size={16} /></button>}
        <div className="rm-title">
          <h1 title={room.name}>{room.name}</h1>
          <span className="rm-sub">
            {room.kind === 'dm' ? 'Direct message' : `${room.members.length} bots`} {'·'} {STRATEGY_INFO[room.strategy].label} {'·'} lead {nm(room.lead)}
            {room.createdBy && <span className="rm-pill" title="You approved this room. Only you can delete it.">created by {nm(room.createdBy)}</span>}
            {paused && <span className="rm-pill warn">{PAUSE_LABEL[paused.reason]}</span>}
          </span>
        </div>
        <span className="spacer" />
        <div className="rm-actions">
          {paused
            ? <button type="button" className="btn" onClick={() => void resumeRoom(room.id)} disabled={offline}><Icon name="play" size={13} /> Resume</button>
            : <button type="button" className="btn rm-freeze" onClick={() => { setFreezing(true); void freezeRoom(room.id).finally(() => setFreezing(false)); }} disabled={offline || freezing}
                title="Stop every bot in this room now. Running work is cancelled."><Icon name="stop" size={13} /> Freeze</button>}
          <ExportMenu roomId={room.id} />
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Room settings" title="Room settings"><Icon name="edit" size={15} /></button>
        </div>
      </div>
      <div className="rm-head-strip">
        <ul className="rm-chips" aria-label="Members">
          {room.members.map((id) => {
            const st = act.get(id);
            return (
              <li key={id} className={`rm-chip${st ? ' live' : ''}`} title={st ? `${nm(id)}: ${st}` : nm(id)}>
                <Face id={id} size={20} />
                <span>{nm(id)}</span>
                {room.lead === id && <em>lead</em>}
                {st && <i className="pip pip-busy" aria-label={st} />}
              </li>
            );
          })}
        </ul>
        <div className="rm-meters">
          <Meter label="Hops" value={room.hopsSinceHuman} max={g.maxHops} text={`${room.hopsSinceHuman}/${g.maxHops}`} title={`${room.hopsSinceHuman} of ${g.maxHops} bot-to-bot hops since your last message`} />
          <Meter label="Cost" value={room.costUsd} max={g.budgetUsd} text={g.budgetUsd === null ? `${fmtCost(room.costUsd)} · No limit` : `${fmtCost(room.costUsd)} / ${fmtBudget(g.budgetUsd)}`} title={g.budgetUsd === null ? `${fmtCost(room.costUsd)} spent; this room has no spend limit` : `${fmtCost(room.costUsd)} spent of the ${fmtBudget(g.budgetUsd)} room budget`} />
        </div>
        {g.budgetUsd !== null && <span className="rm-hint" data-testid="room-budget-note">{ROOM_BUDGET_NOTE}</span>}
      </div>
    </header>
  );
}
