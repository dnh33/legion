/** Rooms view (comms bridge UI): room list, transcript, composer, guards. State lives in ./roomsStore. */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { useStore } from '../store';
import { NewRoomDialog } from './NewRoomDialog';
import { RoomList } from './RoomList';
import { RoomPane } from './RoomPane';
import './rooms.css';
import { initRooms, loadRooms, setNewRoomOpen, setVisible, useRooms } from './roomsStore';

const NARROW = 760;

export function RoomsView() {
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const list = useRooms((s) => s.list);
  const listError = useRooms((s) => s.listError);
  const rooms = useRooms((s) => s.rooms);
  const selectedId = useRooms((s) => s.selectedId);
  const newRoomOpen = useRooms((s) => s.newRoomOpen);
  const conn = useRooms((s) => s.conn);
  const agents = useStore((s) => s.agents);
  const room = rooms.find((r) => r.id === selectedId);

  useEffect(() => { initRooms(); setVisible(true); return () => setVisible(false); }, []);
  useEffect(() => {
    const el = root.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e) setNarrow(e.contentRect.width < NARROW); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!narrow) setDrawer(false); }, [narrow]);
  // Narrow screens open on the list until a room is chosen.
  useEffect(() => { if (narrow && !room && list === 'ready' && rooms.length > 0) setDrawer(true); }, [narrow, room, list, rooms.length]);
  // "/" focuses search
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      e.preventDefault(); setDrawer(true);
      requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('.rm-search input')?.focus());
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  let main;
  if (list === 'idle' || (list === 'loading' && rooms.length === 0)) {
    main = <div className="rm-center"><div className="rm-state" aria-busy="true"><span className="spin" /><p>Loading rooms{'…'}</p></div></div>;
  } else if (list === 'error' && rooms.length === 0) {
    main = (
      <div className="rm-center">
        <div className="rm-state err" role="alert">
          <b>{conn === 'offline' ? 'Legion core is offline' : 'Couldn’t load rooms'}</b>
          <p>{listError}</p>
          <button type="button" className="btn" onClick={() => void loadRooms()}>Try again</button>
        </div>
      </div>
    );
  } else if (rooms.length === 0) {
    main = (
      <div className="rm-center">
        <div className="rm-state hero">
          <h3>No rooms yet</h3>
          <p>A room puts two to six of your agents in one conversation with you. They answer when addressed, hand work to each other, and stop on their own when a guard trips: hop limit, budget or a repeating loop.</p>
          <button type="button" className="btn primary" onClick={() => setNewRoomOpen(true)} disabled={agents.length < 2}><Icon name="plus" size={14} /> Create a room</button>
          {agents.length < 2 && <span className="muted-s">You need at least two agents first.</span>}
        </div>
      </div>
    );
  } else if (!room) {
    main = <div className="rm-center"><div className="rm-state"><b>Select a room</b><p>Pick a conversation from the list.</p>{narrow && <button type="button" className="btn" onClick={() => setDrawer(true)}>Show rooms</button>}</div></div>;
  } else {
    main = <RoomPane key={room.id} room={room} narrow={narrow} onList={() => setDrawer(true)} />;
  }

  return (
    <div ref={root} className={`rooms${narrow ? ' narrow' : ''}${drawer ? ' drawer-open' : ''}`}>
      {narrow && drawer && <div className="rm-scrim" onMouseDown={() => setDrawer(false)} aria-hidden="true" />}
      <RoomList onPicked={() => setDrawer(false)} />
      <section className="rm-main" aria-label="Room">{main}</section>
      {newRoomOpen && <NewRoomDialog />}
    </div>
  );
}
