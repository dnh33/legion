/** The Library: the Lattice (graph), the Inbox of notes waiting for the owner, and the Activity list with Undo. */
import { useEffect } from 'react';
import { GraphView } from '../graph/GraphView';
import { getG, refreshFromServer } from '../graph/graphStore';
import { Activity } from './Activity';
import { Inbox } from './Inbox';
import { loadActivity, loadInbox, setSub, useL, type Sub } from './libraryStore';
import './library.css';

const TABS: Array<{ id: Sub; label: string }> = [{ id: 'lattice', label: 'Lattice' }, { id: 'inbox', label: 'Inbox' }, { id: 'activity', label: 'Activity' }];

export function LibraryView() {
  const sub = useL((s) => s.sub);
  const pending = useL((s) => s.inbox?.length ?? 0);

  // the Lattice is unmounted while another sub-tab is open: read what changed when it comes back
  useEffect(() => { if (sub === 'lattice' && getG().stats) refreshFromServer(); }, [sub]);
  useEffect(() => { if (sub === 'inbox') void loadInbox(true); if (sub === 'activity') void loadActivity(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.id === sub);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setSub(next.id);
    requestAnimationFrame(() => document.getElementById(`lib-tab-${next.id}`)?.focus());
  };

  return (
    <section className="lib" aria-label="Library">
      <div className="lib-bar" role="tablist" aria-label="Library sections" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button key={t.id} id={`lib-tab-${t.id}`} role="tab" aria-selected={sub === t.id} aria-controls="lib-panel" tabIndex={sub === t.id ? 0 : -1}
            className={`lib-tab${sub === t.id ? ' on' : ''}`} onClick={() => setSub(t.id)}>
            {t.label}
            {t.id === 'inbox' && pending > 0 && <b className="lib-pend" aria-label={`${pending} waiting`}>{pending}</b>}
          </button>
        ))}
        <span className="spacer" />
        {pending > 0 && sub !== 'inbox' && <button className="lib-bar-note" onClick={() => setSub('inbox')}>{pending} note{pending === 1 ? '' : 's'} waiting for you</button>}
      </div>
      <div className="lib-body" id="lib-panel" role="tabpanel" aria-labelledby={`lib-tab-${sub}`}>
        {sub === 'lattice' && <GraphView />}
        {sub === 'inbox' && <Inbox />}
        {sub === 'activity' && <Activity />}
      </div>
    </section>
  );
}
