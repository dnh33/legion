import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { BOARD_LIMITS } from '../../../../src/shared/board';
import type { BoardStatus, WorkItem } from '../../../../src/shared/board';
import type { Project } from '../../../../src/shared/projects';
import { Modal } from '../../components/Modal';
import { openRoom } from '../../rooms/roomsStore';
import { setView, useStore } from '../../store';
import { acceptItem, createItem, deleteItem, getBoardState, loadBoard, moveItem, openTask, patchItem, probeBoard, rejectItem, runItem, sayItem, setLeader, useBoard } from './boardStore';
import {
  applyFilters, assigneeKey, assigneeLabel, byColumn, cardLabel, columnLabel, COLUMNS, descCounter, dueState, dueText, FILTER_KEY, hasFilters, keyMove,
  labelsOf, moveAnnouncement, NO_FILTERS, parseAssignee, PRIORITY_LABEL, priorityMark, readFilters,
} from './boardLogic';
import type { Filters } from './boardLogic';
import './board.css';

type Tab = 'board' | 'list' | 'inbox';

/** The board of a project. Renders nothing at all unless the core answered the board probe (the experimental switch is on). */
export function BoardPanel({ project }: { project: Project }) {
  const enabled = useBoard((s) => s.enabled);
  useEffect(() => { void probeBoard(); }, []);
  if (enabled !== 'yes') return null;
  return <Board project={project} />;
}

function Board({ project }: { project: Project }) {
  const agents = useStore((s) => s.agents);
  const view = useBoard((s) => s.views[project.id]);
  const busy = useBoard((s) => s.busy);
  const announce = useBoard((s) => s.announce);
  const [tab, setTab] = useState<Tab>('board');
  const [filters, setFilters] = useState<Filters>(() => { try { return readFilters(localStorage.getItem(FILTER_KEY(project.id))); } catch { return NO_FILTERS; } });
  const [editing, setEditing] = useState<WorkItem | 'new' | null>(null);
  const focusId = useRef<string | null>(null);
  const archived = project.status === 'archived';
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;

  useEffect(() => {
    void loadBoard(project.id);
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => { if ((e as CustomEvent).detail === project.id) { clearTimeout(t); t = setTimeout(() => void loadBoard(project.id), 150); } };
    window.addEventListener('legion-board-updated', on);
    return () => { window.removeEventListener('legion-board-updated', on); clearTimeout(t); };
  }, [project.id]);
  useEffect(() => { try { localStorage.setItem(FILTER_KEY(project.id), JSON.stringify(filters)); } catch { /* convenience only */ } }, [filters, project.id]);
  // after a keyboard move the card sits in a new column (a new element): give it focus again
  useEffect(() => {
    if (!focusId.current) return;
    document.querySelector<HTMLElement>(`[data-card="${focusId.current}"] .bd-title`)?.focus();
    focusId.current = null;
  }, [view]);

  const all = view?.items ?? [];
  const shown = useMemo(() => applyFilters(all, filters), [all, filters]);
  const cols = useMemo(() => byColumn(shown), [shown]);
  const labels = useMemo(() => labelsOf(all), [all]);
  const inbox = view?.inbox ?? [];
  const members = project.members.map((id) => ({ id, name: name(id) }));
  const mv = (i: WorkItem, status: BoardStatus, index: number) => {
    const count = byColumn(all)[status].filter((x) => x.id !== i.id).length + 1;
    focusId.current = i.id;
    void moveItem(project.id, i.id, status, index, moveAnnouncement(i.title, status, index, count));
  };

  const onCardKey = (i: WorkItem) => (e: KeyboardEvent) => {
    if (!e.altKey || archived) return;
    const m = keyMove(all, i, e.key);
    if (!m) return;
    e.preventDefault();
    mv(i, m.status, m.index);
  };
  const onDrop = (status: BoardStatus, before?: WorkItem) => (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const it = all.find((x) => x.id === id);
    if (!it || archived) return;
    const col = byColumn(all)[status].filter((x) => x.id !== id);
    const index = before ? Math.max(0, col.findIndex((x) => x.id === before.id)) : col.length;
    mv(it, status, index);
  };

  return (
    <section className="bd" aria-labelledby="bd-h">
      <div className="bd-head">
        <h3 id="bd-h">Work items</h3>
        <div role="tablist" aria-label="Board views" className="bd-tabs">
          {([['board', 'Board'], ['list', 'List'], ['inbox', `Inbox${inbox.length ? ` (${inbox.length})` : ''}`]] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" id={`bd-tab-${k}`} aria-selected={tab === k} aria-controls="bd-panel" tabIndex={tab === k ? 0 : -1} className={`bd-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}
              onKeyDown={(e) => { const order: Tab[] = ['board', 'list', 'inbox']; const n = order.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0); if (e.key.startsWith('Arrow') && order[n]) { e.preventDefault(); setTab(order[n]!); document.getElementById(`bd-tab-${order[n]}`)?.focus(); } }}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn primary" disabled={archived || busy} onClick={() => setEditing('new')}>New item</button>
      </div>
      <div className="bd-leader">
        <label>Board leader
          <select value={view?.leader ?? ''} disabled={archived || busy || !view} aria-describedby="bd-leader-note" onChange={(e) => void setLeader(project.id, e.target.value || null)}>
            <option value="">None</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <span id="bd-leader-note" className="field-note">Member agents can create, edit, move, assign and label items and add notes. Only the leader can ask to delete one, and you approve each delete. Only you mark an item Done.</span>
      </div>
      {archived && <p className="proj-note" role="note">This project is archived, so its board is read-only.</p>}
      <p className="bd-sr" role="status" aria-live="polite">{announce}</p>

      {tab !== 'inbox' && (
        <form className="bd-filters" role="search" aria-label="Filter items" onSubmit={(e) => e.preventDefault()}>
          <label>Search<input type="search" value={filters.q} maxLength={80} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /></label>
          <label>Assignee
            <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
              <option value="all">Anyone</option><option value="owner">You</option><option value="agents">Any agent</option><option value="none">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>Priority
            <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value as Filters['priority'] })}>
              <option value="all">Any</option>{(['high', 'normal', 'low'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          {tab === 'list' && (
            <label>Status
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters['status'] })}>
                <option value="all">Any</option>{COLUMNS.map((s) => <option key={s} value={s}>{columnLabel(s)}</option>)}
              </select>
            </label>
          )}
          {labels.length > 0 && (
            <label>Label
              <select value={filters.label} onChange={(e) => setFilters({ ...filters, label: e.target.value })}>
                <option value="all">Any</option>{labels.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          {hasFilters(filters) && <button type="button" className="btn-ghost" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </form>
      )}

      <div id="bd-panel" role="tabpanel" aria-labelledby={`bd-tab-${tab}`}>
        {!view ? <p className="muted-s">Loading the board&hellip;</p> : tab === 'board' ? (
          <>
            <p className="field-note" id="bd-keys">Move a card: drag it, or focus it and press Alt plus an arrow key (left and right change column, up and down reorder). Enter opens it.</p>
            {all.length === 0 && <p className="muted-s">Nothing here yet. Add the first item, or let a member agent propose one: proposals wait in the Inbox for you.</p>}
            <div className="bd-cols">
              {COLUMNS.map((s) => (
                <section key={s} className={`bd-col bd-${s}`} aria-labelledby={`bd-col-${s}`} onDragOver={(e) => { if (!archived) e.preventDefault(); }} onDrop={onDrop(s)}>
                  <h4 id={`bd-col-${s}`}>{columnLabel(s)} <span className="bd-count" aria-label={`${cols[s].length} items`}>{cols[s].length}</span></h4>
                  <ul className="bd-cards">
                    {cols[s].map((i) => (
                      <li key={i.id} data-card={i.id} className={`bd-card${i.trust === 'untrusted' ? ' untrusted' : ''}`} draggable={!archived}
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.effectAllowed = 'move'; }} onDrop={(e) => { e.stopPropagation(); onDrop(s, i)(e); }}>
                        <button type="button" className="bd-title" aria-label={cardLabel(i, name)} aria-describedby="bd-keys" onClick={() => setEditing(i)} onKeyDown={onCardKey(i)}>{i.title}</button>
                        <div className="bd-meta" aria-hidden="true">
                          <span className={`bd-pri p-${i.priority}`}>{priorityMark(i.priority)}</span>
                          <span>{assigneeLabel(i.assignee, name)}</span>
                          {i.due && <span className={`bd-due d-${dueState(i.due)}`}>{dueText(i.due)}</span>}
                          {i.labels.map((l) => <span key={l} className="bd-label">{l}</span>)}
                          {i.trust === 'untrusted' && <span className="bd-warn">Not reviewed</span>}
                        </div>
                        <label className="bd-move">Move to
                          <select value={i.status} disabled={archived} aria-label={`Move ${i.title} to`} onChange={(e) => mv(i, e.target.value as BoardStatus, byColumn(all)[e.target.value as BoardStatus].length)}>
                            {COLUMNS.map((c) => <option key={c} value={c}>{columnLabel(c)}</option>)}
                          </select>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        ) : tab === 'list' ? (
          shown.length === 0 ? <p className="muted-s">{all.length ? 'No item matches these filters.' : 'No items yet.'}</p> : (
            <div className="bd-tablewrap">
              <table className="bd-table">
                <caption className="bd-sr">Work items</caption>
                <thead><tr><th scope="col">Item</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Assignee</th><th scope="col">Due</th></tr></thead>
                <tbody>
                  {[...shown].sort((a, b) => COLUMNS.indexOf(a.status) - COLUMNS.indexOf(b.status) || a.order - b.order).map((i) => (
                    <tr key={i.id}>
                      <th scope="row"><button type="button" className="proj-link" onClick={() => setEditing(i)}>{i.title}</button>{i.trust === 'untrusted' && <span className="bd-warn"> Not reviewed</span>}</th>
                      <td><select aria-label={`Status of ${i.title}`} value={i.status} disabled={archived} onChange={(e) => mv(i, e.target.value as BoardStatus, byColumn(all)[e.target.value as BoardStatus].length)}>{COLUMNS.map((c) => <option key={c} value={c}>{columnLabel(c)}</option>)}</select></td>
                      <td>{priorityMark(i.priority)}</td><td>{assigneeLabel(i.assignee, name)}</td><td className={`bd-due d-${dueState(i.due)}`}>{dueText(i.due) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <InboxList inbox={inbox} members={members} name={name} archived={archived} projectId={project.id} busy={busy} />
        )}
      </div>

      {editing && <ItemDialog key={editing === 'new' ? 'new' : editing.id} project={project} item={editing === 'new' ? null : (view?.items.find((x) => x.id === editing.id) ?? editing)} members={members} name={name} archived={archived} onClose={() => setEditing(null)} />}
    </section>
  );
}

function InboxList({ inbox, members, name, archived, projectId, busy }: { inbox: WorkItem[]; members: Array<{ id: string; name: string }>; name: (id: string) => string; archived: boolean; projectId: string; busy: boolean }) {
  const [pick, setPick] = useState<Record<string, string>>({});
  if (inbox.length === 0) return <p className="muted-s">The Inbox is empty. When a member agent proposes an item it waits here: nothing starts until you accept it.</p>;
  return (
    <ul className="bd-inbox">
      {inbox.map((i) => {
        const by = i.createdBy.kind === 'agent' ? name(i.createdBy.id) : 'an agent';
        const tainted = i.createdBy.kind === 'agent' && i.createdBy.tainted;
        const sel = pick[i.id] ?? (i.proposal?.suggestedAssignee ? `agent:${i.proposal.suggestedAssignee}` : '');
        return (
          <li key={i.id} className="bd-card untrusted">
            <p className="bd-title static">{i.title}</p>
            <p className="muted-s">Suggested by {by}. Not reviewed.{tainted ? ' Its run had read outside content (web, shell or other tools), so treat the text with extra care.' : ''}</p>
            {i.description && <p className="bd-desc">{i.description}</p>}
            <div className="bd-meta"><span className={`bd-pri p-${i.priority}`}>{priorityMark(i.priority)}</span>{i.labels.map((l) => <span key={l} className="bd-label">{l}</span>)}</div>
            <div className="proj-row">
              <label className="proj-inline">Assign to
                <select value={sel} onChange={(e) => setPick({ ...pick, [i.id]: e.target.value })}>
                  <option value="">Unassigned</option><option value="owner">You</option>{members.map((m) => <option key={m.id} value={`agent:${m.id}`}>{m.name}</option>)}
                </select>
              </label>
              <button type="button" className="btn" disabled={archived || busy} aria-label={`Accept ${i.title}`} onClick={() => void acceptItem(projectId, i.id, { assignee: parseAssignee(sel) }).then(() => sayItem(`${i.title} accepted to Backlog.`))}>Accept</button>
              <button type="button" className="btn-ghost danger" disabled={archived || busy} aria-label={`Reject ${i.title}`} onClick={() => void rejectItem(projectId, i.id).then(() => sayItem(`${i.title} rejected.`))}>Reject</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ItemDialog({ project, item, members, name, archived, onClose }: { project: Project; item: WorkItem | null; members: Array<{ id: string; name: string }>; name: (id: string) => string; archived: boolean; onClose: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [desc, setDesc] = useState(item?.description ?? '');
  const [status, setStatus] = useState<BoardStatus>(item?.status ?? 'backlog');
  const [assignee, setAssignee] = useState(item ? assigneeKey(item.assignee) : '');
  const [priority, setPriority] = useState(item?.priority ?? 'normal');
  const [due, setDue] = useState(item?.due ?? '');
  const [labels, setLabels] = useState(item?.labels.join(', ') ?? '');
  const [sure, setSure] = useState(false);
  const busy = useBoard((s) => s.busy);
  const counter = descCounter(desc);
  const labelList = labels.split(',').map((l) => l.trim()).filter(Boolean);
  const canRun = !!item && !item.proposal && !archived && item.assignee?.kind === 'agent' && project.members.includes(item.assignee.id) && !item.activeRun;
  const body = () => ({ title: title.trim(), description: desc.slice(0, BOARD_LIMITS.descriptionChars), status, assignee: parseAssignee(assignee), priority, due: due || null, labels: labelList });

  const save = async () => {
    const r = item ? await patchItem(project.id, item.id, body()) : await createItem(project.id, { ...body(), due: due || undefined });
    if (r) { sayItem(item ? 'Item saved.' : 'Item created.'); onClose(); }
  };
  return (
    <Modal title={item ? 'Work item' : 'New work item'} onClose={onClose} width={640}>
      <form className="form bd-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {item?.trust === 'untrusted' && !item.proposal && (
          <div className="proj-note" role="note">
            <strong>Written by an agent, not reviewed.</strong> Read the text below. Until you mark it reviewed, &ldquo;Run this item&rdquo; starts the run with the stricter &ldquo;ask&rdquo; approvals.
            <div><button type="button" className="btn sm" disabled={archived || busy} onClick={() => void patchItem(project.id, item.id, { trust: 'human' })}>Mark as reviewed</button></div>
          </div>
        )}
        <label>Title<input value={title} maxLength={BOARD_LIMITS.titleChars} required data-autofocus disabled={archived} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Description
          <textarea rows={6} value={desc} disabled={archived} aria-describedby="bd-dcount" onChange={(e) => setDesc(e.target.value)} />
          <span id="bd-dcount" className={`field-note${counter.over ? ' proj-over' : ''}`}>{counter.label}</span>
        </label>
        <div className="bd-grid">
          <label>Status<select value={status} disabled={archived || !!item?.proposal} onChange={(e) => setStatus(e.target.value as BoardStatus)}>{COLUMNS.map((c) => <option key={c} value={c}>{columnLabel(c)}</option>)}</select></label>
          <label>Assignee
            <select value={assignee} disabled={archived} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option><option value="owner">You</option>{members.map((m) => <option key={m.id} value={`agent:${m.id}`}>{m.name}</option>)}
            </select>
          </label>
          <label>Priority<select value={priority} disabled={archived} onChange={(e) => setPriority(e.target.value as typeof priority)}>{(['high', 'normal', 'low'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
          <label>Due date<input type="date" value={due} disabled={archived} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        <label>Labels<input value={labels} disabled={archived} aria-describedby="bd-lhelp" onChange={(e) => setLabels(e.target.value)} /><span id="bd-lhelp" className={`field-note${labelList.length > BOARD_LIMITS.labels ? ' proj-over' : ''}`}>Separate with commas. Up to {BOARD_LIMITS.labels}, letters, digits, spaces and hyphens.</span></label>

        {item && (
          <>
            {item.lastRun && <p className="muted-s">Last run {item.lastRun.status}{item.lastRun.tainted ? ' (it read outside content)' : ''}: {item.lastRun.preview || 'no text'}</p>}
            {(item.taskIds.length > 0 || item.roomIds.length > 0) && (
              <div>
                <h4 className="bd-h4">Linked work</h4>
                <ul className="proj-list">
                  {item.taskIds.map((t) => <li key={t}><button type="button" className="proj-link" onClick={() => { onClose(); openTask(t); }}>Open task {t.slice(-6)}</button></li>)}
                  {item.roomIds.map((r) => <li key={r}><button type="button" className="proj-link" onClick={() => { onClose(); setView('rooms'); openRoom(r); }}>Open room {r.slice(-6)}</button></li>)}
                </ul>
              </div>
            )}
            <div>
              <h4 className="bd-h4">Activity</h4>
              <ol className="bd-activity" aria-label="Activity trail">
                {[...item.activity].reverse().map((a, n) => (
                  <li key={n}><span className="muted-s">{new Date(a.at).toLocaleString()} &middot; {a.by.kind === 'owner' ? 'You' : a.by.kind === 'agent' ? `${name(a.by.id)}${a.by.tainted ? ' (run read outside content)' : ''}` : 'Legion'}</span> {a.text}</li>
                ))}
              </ol>
            </div>
          </>
        )}
        <div className="bd-actions">
          <button type="submit" className="btn primary" disabled={archived || busy || !title.trim() || counter.over || labelList.length > BOARD_LIMITS.labels}>{item ? 'Save' : 'Create'}</button>
          {item && !item.proposal && (
            <button type="button" className="btn" disabled={!canRun || busy} aria-describedby="bd-runnote" onClick={() => void runItem(project.id, item.id).then((ok) => { if (ok) onClose(); })}>Run this item</button>
          )}
          {item && (sure
            ? <button type="button" className="btn-ghost danger" disabled={archived || busy} onClick={() => void deleteItem(project.id, item.id).then(() => { sayItem('Item deleted.'); onClose(); })}>Really delete</button>
            : <button type="button" className="btn-ghost danger" disabled={archived || busy} onClick={() => setSure(true)}>Delete</button>)}
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
        {item && !item.proposal && <p className="field-note" id="bd-runnote">{canRun ? 'Runs the assigned agent once, with this item’s text and the project instructions, under its usual approvals. The item moves to Doing, then to Review when the run ends. Only you mark it Done.' : 'To run an item, assign it to a member agent first.'}</p>}
      </form>
    </Modal>
  );
}
