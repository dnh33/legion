import { useRef, type KeyboardEvent } from 'react';
import type { Room, RoomMessage } from '../../../src/shared/comms';
import { Icon } from '../components/icons';
import { useStore } from '../store';
import { relTime } from '../util';
import './rooms.css';
import { activeIn, isUnread, openRoom, PAUSE_LABEL, runSearch, selectRoom, setNewRoomOpen, useRooms } from './roomsStore';
import { agentName, clock, fmtCost, snippet } from './roomsUtil';
import { Stack } from './Stack';

function Row({ room, selected, onPick }: { room: Room; selected: boolean; onPick: () => void }) {
  const agents = useStore((s) => s.agents);
  const unread = useRooms((s) => isUnread(s, room));
  const live = useRooms((s) => s.live);
  const busy = activeIn(live, room).length > 0;
  const paused = room.paused;
  const names = room.members.map((m) => agentName(agents, m)).join(', ');
  const label = `${room.name}, ${room.kind === 'dm' ? 'direct message' : `${room.members.length} bots`}${paused ? `, paused: ${PAUSE_LABEL[paused.reason]}` : ''}${unread ? ', unread' : ''}${busy ? ', bots active' : ''}`;
  return (
    <button type="button" className={`rm-row${selected ? ' sel' : ''}${unread ? ' unread' : ''}`} onClick={onPick} aria-current={selected ? 'true' : undefined} aria-label={label}
      title={paused ? `${PAUSE_LABEL[paused.reason]}${paused.detail ? `: ${paused.detail}` : ''}` : names}>
      <Stack ids={room.members} size={24} />
      <span className="rm-row-main">
        <span className="rm-row-top">
          <span className="rm-row-name">{room.name}</span>
          {unread && <i className="rm-dot" aria-hidden="true" />}
          {busy && <i className="pip pip-busy" aria-hidden="true" />}
          {paused && <span className="rm-pill warn">{PAUSE_LABEL[paused.reason]}</span>}
        </span>
        <span className="rm-row-sub">
          <span className="rm-row-names">{names}</span>
          <span className="rm-row-cost">{fmtCost(room.costUsd)}</span>
          <span className="rm-row-when">{relTime(room.updatedAt)}</span>
        </span>
      </span>
    </button>
  );
}

function Hit({ m, room, q }: { m: RoomMessage; room?: Room; q: string }) {
  const agents = useStore((s) => s.agents);
  const who = m.from.kind === 'human' ? 'You' : m.from.kind === 'bot' ? agentName(agents, m.from.agentId) : 'System';
  const text = snippetAround(m.text, q);
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  return (
    <button type="button" className="rm-hit" onClick={() => openRoom(m.roomId, m.id)}>
      <span className="rm-hit-top"><b>{room?.name ?? 'Deleted room'}</b><span>{new Date(m.at).toLocaleDateString([], { day: 'numeric', month: 'short' })} {clock(m.at)}</span></span>
      <span className="rm-hit-text">
        <em>{who}</em>
        {i < 0 ? text : <>{text.slice(0, i)}<mark>{text.slice(i, i + q.trim().length)}</mark>{text.slice(i + q.trim().length)}</>}
      </span>
    </button>
  );
}

function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const i = flat.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0 || flat.length <= 110) return snippet(flat, 140);
  const start = Math.max(0, i - 40);
  return (start > 0 ? '…' : '') + flat.slice(start, start + 120) + (start + 120 < flat.length ? '…' : '');
}

export function RoomList({ onPicked }: { onPicked?: () => void }) {
  const rooms = useRooms((s) => s.rooms);
  const selectedId = useRooms((s) => s.selectedId);
  const list = useRooms((s) => s.list);
  const search = useRooms((s) => s.search);
  const agents = useStore((s) => s.agents);
  const nav = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const groups = rooms.filter((r) => r.kind === 'group');
  const dms = rooms.filter((r) => r.kind === 'dm');
  const canCreate = agents.length >= 2;

  const pick = (id: string) => { selectRoom(id); onPicked?.(); };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(nav.current?.querySelectorAll<HTMLElement>('.rm-row, .rm-hit') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (document.activeElement === input.current && e.key === 'ArrowUp') return;
    e.preventDefault();
    const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[n]?.focus();
  };

  const q = search?.q ?? '';
  const searching = !!search;
  const roomsById = new Map(rooms.map((r) => [r.id, r]));

  return (
    <aside className="rm-side" aria-label="Rooms" onKeyDown={onKey}>
      <div className="rm-side-head">
        <span>Rooms</span>
        <button type="button" className="icon-btn sm" onClick={() => setNewRoomOpen(true)} disabled={!canCreate} aria-label="New room" title={canCreate ? 'New room' : 'A room needs at least two agents'}><Icon name="plus" size={15} /></button>
      </div>
      <div className="rm-search">
        <Icon name="search" size={13} />
        <input ref={input} type="search" value={q} placeholder="Search all rooms" aria-label="Search all rooms" spellCheck={false}
          onChange={(e) => runSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); runSearch(''); } }} />
        {q && <button type="button" className="icon-btn sm" onClick={() => { runSearch(''); input.current?.focus(); }} aria-label="Clear search"><Icon name="x" size={12} /></button>}
      </div>
      <div className="rm-side-scroll" ref={nav}>
        {searching ? (
          <div className="rm-results" aria-live="polite">
            {search.error && <p className="err-s rm-pad">{search.error}</p>}
            {!search.error && !search.loading && search.rooms.length === 0 && search.messages.length === 0 && <p className="muted-s rm-pad">No rooms or messages match {'“'}{q.trim()}{'”'}.</p>}
            {search.rooms.length > 0 && <>
              <div className="rm-sec">Rooms</div>
              {search.rooms.map((r) => <Row key={r.id} room={r} selected={r.id === selectedId} onPick={() => pick(r.id)} />)}
            </>}
            {search.messages.length > 0 && <>
              <div className="rm-sec">Messages <span>{search.messages.length >= 50 ? 'latest 50' : search.messages.length}</span></div>
              {search.messages.map((m) => <Hit key={m.id} m={m} room={roomsById.get(m.roomId)} q={q} />)}
            </>}
            {search.loading && <p className="muted-s rm-pad"><span className="spin" /> Searching{'…'}</p>}
          </div>
        ) : list === 'loading' || list === 'idle' ? (
          <div className="rm-skel" aria-busy="true" aria-label="Loading rooms">{[0, 1, 2, 3].map((i) => <div key={i} className="rm-row skeleton" />)}</div>
        ) : rooms.length === 0 ? (
          <p className="muted-s rm-pad">No rooms yet.</p>
        ) : (
          <>
            {groups.length > 0 && <div className="rm-sec">Groups <span>{groups.length}</span></div>}
            {groups.map((r) => <Row key={r.id} room={r} selected={r.id === selectedId} onPick={() => pick(r.id)} />)}
            {dms.length > 0 && <div className="rm-sec">Direct messages <span>{dms.length}</span></div>}
            {dms.map((r) => <Row key={r.id} room={r} selected={r.id === selectedId} onPick={() => pick(r.id)} />)}
          </>
        )}
      </div>
      <button type="button" className="rail-new rm-new" onClick={() => setNewRoomOpen(true)} disabled={!canCreate}><Icon name="plus" size={14} /> New room</button>
    </aside>
  );
}
