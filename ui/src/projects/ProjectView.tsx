import { useEffect, useMemo, useState } from 'react';
import { PROJECT_LIMITS } from '../../../src/shared/projects';
import type { Project } from '../../../src/shared/projects';
import { ensureRoomList, openRoom, useRooms } from '../rooms/roomsStore';
import { newTask, selectAgent, selectTask, setView, useStore } from '../store';
import { assignRoom, changeMembers, chooseFolder, closeProjectPage, saveProject, setProjectFilter, useDefaultFolder } from './projectsStore';
import { assignableRooms, instructionsCounter, projectLabel, roomsOf, statusLine } from './projectsLogic';
import { BoardPanel } from './board/BoardPanel';
import './projects.css';

export function ProjectView() {
  const filter = useStore((s) => s.projectFilter);
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectFilter));
  if (!filter || !project) {
    return (
      <section className="proj-page" aria-label="Project">
        <p className="proj-empty">Pick a project in the rail, or create one.</p>
        <button type="button" className="btn" onClick={closeProjectPage}>Back to chat</button>
      </section>
    );
  }
  return <ProjectPage key={project.id} project={project} />;
}

function ProjectPage({ project }: { project: Project }) {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const rooms = useRooms((s) => s.rooms);
  useEffect(() => { ensureRoomList(); }, []);
  const [name, setName] = useState(project.name);
  const [text, setText] = useState(project.instructions);
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const [roomPick, setRoomPick] = useState('');
  // keep the editors in step with changes from elsewhere (another window, a confirmation) while nothing is being edited
  useEffect(() => { setName((n) => (n === project.name || !n.trim() ? project.name : n)); }, [project.name]);
  useEffect(() => { setText((t) => (t === project.instructions ? t : t)); }, [project.instructions]);

  const archived = project.status === 'archived';
  const inTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id && !t.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks, project.id]);
  const inRooms = roomsOf(rooms, project.id);
  const free = assignableRooms(rooms, project);
  const members = project.members.map((id) => agents.find((a) => a.id === id) ?? { id, name: id, emoji: '?' });
  const outside = agents.filter((a) => !project.members.includes(a.id));
  const counter = instructionsCounter(text);
  const nameDirty = name.trim() !== project.name;
  const textDirty = text.slice(0, PROJECT_LIMITS.instructionsChars) !== project.instructions;

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const startTask = () => {
    const first = project.members[0];
    if (!first) return;
    setProjectFilter(project.id);
    selectAgent(first);
    setView('chat');
    newTask();
  };

  return (
    <section className="proj-page" aria-labelledby="proj-title">
      <header className="proj-head">
        <div className="proj-headmain">
          <h2 id="proj-title">{project.name}</h2>
          <p className="muted-s" role="status">{statusLine(project, inTasks.length, inRooms.length)}</p>
        </div>
        <div className="proj-headact">
          <button type="button" className="btn" onClick={startTask} disabled={archived || members.length === 0} aria-describedby={members.length === 0 ? 'proj-nomem' : undefined}>New task in this project</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(() => saveProject(project.id, { status: archived ? 'active' : 'archived' }))}>{archived ? 'Unarchive' : 'Archive'}</button>
          <button type="button" className="btn-ghost" onClick={closeProjectPage}>Back to chat</button>
        </div>
      </header>
      {members.length === 0 && <p className="field-note" id="proj-nomem">Add a member to start a task in this project.</p>}
      {archived && <p className="proj-note" role="note">This project is archived. It starts no new tasks, and its tasks cannot be continued until you unarchive it. Nothing was deleted.</p>}

      <BoardPanel project={project} />
      <div className="proj-grid">
        <section className="card proj-card" aria-labelledby="proj-h-instr">
          <h3 id="proj-h-instr">Name and instructions</h3>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => saveProject(project.id, { ...(nameDirty ? { name: name.trim() } : {}), ...(textDirty ? { instructions: text } : {}) })); }}>
            <label>Name<input value={name} maxLength={PROJECT_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} /></label>
            <label>Instructions
              <textarea rows={8} value={text} aria-describedby="proj-count" onChange={(e) => setText(e.target.value)} />
              <span id="proj-count" className={`field-note${counter.over ? ' proj-over' : ''}`}>{counter.label}</span>
            </label>
            <p className="field-note">Added to every task in this project, after the agent&rsquo;s own instructions and labelled as the project&rsquo;s. They are context only: they cannot change what an agent is allowed to do.</p>
            <div><button type="submit" className="btn primary" disabled={busy || !name.trim() || (!nameDirty && !textDirty)}>Save</button></div>
          </form>
        </section>

        <section className="card proj-card" aria-labelledby="proj-h-folder">
          <h3 id="proj-h-folder">Folder</h3>
          <p><code className="proj-path">{project.folder}</code></p>
          <p className="field-note">Members can read and write files here when they work on this project&rsquo;s tasks. Changing it shows a confirmation in a separate window.</p>
          <div className="proj-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => chooseFolder(project.id))}>Choose folder&hellip;</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void run(() => useDefaultFolder(project.id))}>Use default folder</button>
          </div>
        </section>

        <section className="card proj-card" aria-labelledby="proj-h-members">
          <h3 id="proj-h-members">Members</h3>
          {members.length === 0 ? <p className="muted-s">No members yet.</p> : (
            <ul className="proj-list">
              {members.map((a) => (
                <li key={a.id}>
                  <span>{a.emoji} {a.name}</span>
                  <button type="button" className="btn-ghost sm" disabled={busy} aria-label={`Remove ${a.name} from this project`} onClick={() => void run(() => changeMembers(project.id, project.members.filter((m) => m !== a.id)))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          {outside.length > 0 && (
            <div className="proj-row">
              <label className="proj-inline"><span className="proj-lbl">Add an agent</span>
                <select value={add} onChange={(e) => setAdd(e.target.value)}>
                  <option value="">Choose an agent</option>
                  {outside.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
                </select>
              </label>
              <button type="button" className="btn" disabled={busy || !add || members.length >= PROJECT_LIMITS.members} onClick={() => void run(async () => { if (await changeMembers(project.id, [...project.members, add])) setAdd(''); })}>Add</button>
            </div>
          )}
          <p className="field-note">Adding or removing a member shows a confirmation in a separate window.</p>
        </section>

        <section className="card proj-card" aria-labelledby="proj-h-tasks">
          <h3 id="proj-h-tasks">Tasks</h3>
          {inTasks.length === 0 ? <p className="muted-s">No tasks yet. Start one from this page, or choose this project in the rail and write to an agent.</p> : (
            <ul className="proj-list">
              {inTasks.slice(0, 30).map((t) => (
                <li key={t.id}>
                  <button type="button" className="proj-link" onClick={() => { setView('chat'); selectTask(t.id); }}>{t.title}</button>
                  <span className="muted-s">{agents.find((a) => a.id === t.agentId)?.name ?? t.agentId}, {t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card proj-card" aria-labelledby="proj-h-rooms">
          <h3 id="proj-h-rooms">Rooms</h3>
          {inRooms.length === 0 ? <p className="muted-s">No rooms in this project.</p> : (
            <ul className="proj-list">
              {inRooms.map((r) => (
                <li key={r.id}>
                  <button type="button" className="proj-link" onClick={() => { setView('rooms'); openRoom(r.id); }}>{r.name}</button>
                  <button type="button" className="btn-ghost sm" disabled={busy} aria-label={`Take ${r.name} out of this project`} onClick={() => void run(() => assignRoom(r.id, null))}>Take out</button>
                </li>
              ))}
            </ul>
          )}
          {free.length > 0 && !archived && (
            <div className="proj-row">
              <label className="proj-inline"><span className="proj-lbl">Add a room</span>
                <select value={roomPick} onChange={(e) => setRoomPick(e.target.value)}>
                  <option value="">Choose a room</option>
                  {free.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <button type="button" className="btn" disabled={busy || !roomPick} onClick={() => void run(async () => { if (await assignRoom(roomPick, project.id)) setRoomPick(''); })}>Add</button>
            </div>
          )}
          <p className="field-note">Only rooms whose agents are all members of this project can join it.</p>
        </section>
      </div>
      <p className="muted-s proj-foot">Viewing {projectLabel(project)}. The rail and task lists show this project&rsquo;s agents and tasks until you choose All projects.</p>
    </section>
  );
}
