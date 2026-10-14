/** The Tasks and Rooms tabs: the same lists as before, in the page's table and row styles. Spec 3.1. */
import { useMemo, useState } from 'react';
import type { Project } from '../../../../src/shared/projects';
import { ensureRoomList, openRoom, useRooms } from '../../rooms/roomsStore';
import { loadProjectTasks, setView } from '../../store';
import { assignRoom } from '../projectsStore';
import { assignableRooms, PROJECT_TASKS_FOLDED, roomOutOfProject, roomsOf, visibleTasks } from '../projectsLogic';
import { AgentBust } from './AgentBust';
import { ageText, asksOf, money, pageStatus, projectTasks, queueText, waitingTaskIds } from './pageLogic';
import type { PageFacts } from './pageLogic';
import { openTask } from './taskActions';

const CHIP: Record<string, [string, string]> = {
  working: ['working', 'Working'], waiting: ['waiting', 'Waiting on you'], queued: ['queued', 'Queued'], stopped: ['paused', 'Stopped'], failed: ['failed', 'Failed'], done: ['done', 'Done'], cancelled: ['done', 'Cancelled'],
};

export function TasksTab({ f, project }: { f: PageFacts; project: Project }) {
  const [all, setAll] = useState(false);
  const tasks = useMemo(() => projectTasks(f).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [f]);
  const waiting = useMemo(() => waitingTaskIds(asksOf(f)), [f]);
  if (!tasks.length) return <div className="pg-empty"><h2>No tasks yet</h2><p>Tasks you start here, and tasks agents start for you, show up in this list.</p></div>;
  const rows = visibleTasks(tasks, all);
  return (
    <div className="pg-inner">
      <table className="pg-tbl num">
        <thead><tr><th scope="col">Task</th><th scope="col">Agent</th><th scope="col">Status</th><th scope="col" className="r">Cost</th><th scope="col" className="r">Updated</th></tr></thead>
        <tbody>
          {rows.map((t) => {
            const st = pageStatus(t, waiting);
            const [cls, label] = CHIP[st] ?? ['done', st];
            return (
              <tr key={t.id}>
                <td className="title"><button type="button" className="lk" data-fk={`t:${t.id}`} title={t.title} onClick={() => openTask(t.id)}>{t.title}</button>{st === 'queued' && <span className="qline">{queueText(f, t)}</span>}</td>
                <td>{f.agents.find((a) => a.id === t.agentId)?.name ?? t.agentId}</td>
                <td><span className={`pg-chip ${cls}`}><i />{label}</span></td>
                <td className="r">{st === 'queued' ? '' : money(t.costUsd ?? 0)}</td>
                <td className="r">{ageText(f.nowMs, t.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tasks.length >= PROJECT_TASKS_FOLDED && (
        <button type="button" className="pg-more" aria-expanded={all} onClick={() => { if (!all) void loadProjectTasks(project.id, 100); setAll((v) => !v); }}>
          {all ? 'Show fewer' : 'Show all ' + tasks.length + (tasks.length === PROJECT_TASKS_FOLDED ? '+' : '')}
        </button>
      )}
    </div>
  );
}

export function RoomsTab({ f, project }: { f: PageFacts; project: Project }) {
  const rooms = useRooms((s) => s.rooms);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  ensureRoomList();
  const mine = roomsOf(rooms, project.id);
  const free = assignableRooms(rooms, project);
  const names = Object.fromEntries(f.agents.map((a) => [a.id, a.name]));
  const archived = project.status === 'archived';
  const run = async (fn: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <div className="pg-inner">
      {mine.length === 0 ? (
        <div className="pg-empty"><h2>No rooms in this project</h2><p>A room is a group chat of two or more agents. Agents only answer when you address them.</p></div>
      ) : (
        <div className="pg-list">
          {mine.map((r) => {
            const out = roomOutOfProject(r, [project], names);
            return (
              <div key={r.id} className="pg-item" style={{ gridTemplateColumns: '84px minmax(0,1fr) auto', padding: '12px 4px' }}>
                <span className="pg-stackb" aria-hidden="true">{r.members.slice(0, 3).map((m) => <AgentBust key={m} agentId={m} size={26} />)}</span>
                <div className="ti"><button type="button" className="lk" data-fk={`rm:${r.id}`} title={r.name} onClick={() => { setView('rooms'); openRoom(r.id); }}>{r.name}</button>
                  <div className="sub">{r.members.length} agents{out ? ', out of project (' + out + ')' : ''}</div></div>
                <div className="r">
                  <button type="button" className="pg-btn sm" aria-label={'Take ' + r.name + ' out of this project'} disabled={busy || archived} onClick={() => void run(() => assignRoom(r.id, null))}>Take out</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {free.length > 0 && !archived && (
        <div className="pg-tools" style={{ marginTop: 14 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)', fontSize: 12.5 }}>Add a room
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ height: 32, background: 'var(--surface)', border: '1px solid var(--control-line)', borderRadius: 'var(--r)', color: 'var(--text)', padding: '0 8px' }}>
              <option value="">Choose a room</option>{free.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <button type="button" className="pg-btn" disabled={busy || !pick} onClick={() => void run(async () => { if (await assignRoom(pick, project.id)) setPick(''); })}>Add</button>
        </div>
      )}
      <p className="pg-fnote">Only rooms whose agents are all members of this project can join it.</p>
    </div>
  );
}
