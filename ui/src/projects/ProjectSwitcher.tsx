import { useState } from 'react';
import { useStore } from '../store';
import { NewProjectDialog } from './NewProjectDialog';
import { projectLabel, sortProjects } from './projectsLogic';
import { openProject, setProjectFilter } from './projectsStore';
import './projects.css';

/** The rail's project switcher: All, or one project. A native select, so it works with the keyboard and a screen reader as is. */
export function ProjectSwitcher() {
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.projectFilter);
  const view = useStore((s) => s.view);
  const [creating, setCreating] = useState(false);
  const sorted = sortProjects(projects);
  const active = sorted.filter((p) => p.status === 'active');
  const archived = sorted.filter((p) => p.status !== 'active');
  return (
    <div className="proj-switch">
      <label htmlFor="proj-select" className="proj-label">Project</label>
      <select id="proj-select" value={filter ?? ''} onChange={(e) => setProjectFilter(e.target.value || null)}>
        <option value="">All projects</option>
        {active.map((p) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
        {archived.length > 0 && <optgroup label="Archived">{archived.map((p) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}</optgroup>}
      </select>
      <div className="proj-actions">
        {filter && <button type="button" className="btn-ghost sm" onClick={() => openProject(filter)} aria-pressed={view === 'project'}>Project page</button>}
        <button type="button" className="btn-ghost sm" onClick={() => setCreating(true)}>New project</button>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
