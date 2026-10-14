/**
 * The Settings tab. Until the settings areas land (While you are away, Safety, Budget, Notifications), it keeps the cards the page had
 * before: name and instructions, folder and members, with the same native confirmations for folder and member changes.
 */
import { useEffect, useRef, useState } from 'react';
import { PROJECT_LIMITS } from '../../../../src/shared/projects';
import type { Project } from '../../../../src/shared/projects';
import { changeMembers, chooseFolder, saveProject, useDefaultFolder } from '../projectsStore';
import { followRemote, instructionsCounter } from '../projectsLogic';
import type { PageFacts } from './pageLogic';
import '../projects.css';

export function SettingsTab({ f, project }: { f: PageFacts; project: Project }) {
  const [name, setName] = useState(project.name);
  const [text, setText] = useState(project.instructions);
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const prev = useRef(project);
  useEffect(() => {
    setName((n) => (!n.trim() ? project.name : followRemote(n, prev.current.name, project.name)));
    setText((t) => followRemote(t, prev.current.instructions, project.instructions));
    prev.current = project;
  }, [project.name, project.instructions]); // eslint-disable-line react-hooks/exhaustive-deps
  const members = project.members.map((id) => f.agents.find((a) => a.id === id) ?? { id, name: id, emoji: '?' }) as Array<{ id: string; name: string; emoji?: string }>;
  const outside = f.agents.filter((a) => !project.members.includes(a.id));
  const counter = instructionsCounter(text);
  const nameDirty = name.trim() !== project.name;
  const textDirty = text.slice(0, PROJECT_LIMITS.instructionsChars) !== project.instructions;
  const run = async (fn: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <div className="pg-inner pg-settings">
      <div className="proj-grid">
        <section className="card proj-card" aria-labelledby="proj-h-instr">
          <h3 id="proj-h-instr">Name and instructions</h3>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => saveProject(project.id, { ...(nameDirty ? { name: name.trim() } : {}), ...(textDirty ? { instructions: text } : {}) })); }}>
            <label>Name<input id="pg-name" value={name} maxLength={PROJECT_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} /></label>
            <label>Instructions
              <textarea rows={8} value={text} aria-describedby="proj-count" onChange={(e) => setText(e.target.value)} />
              <span id="proj-count" className={'field-note' + (counter.over ? ' proj-over' : '')}>{counter.label}</span>
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
                  <button type="button" className="btn-ghost sm" disabled={busy} aria-label={'Remove ' + a.name + ' from this project'} onClick={() => void run(() => changeMembers(project.id, project.members.filter((m) => m !== a.id)))}>Remove</button>
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
      </div>
    </div>
  );
}
