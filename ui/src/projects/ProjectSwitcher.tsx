import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveAsks } from '../../../src/shared/attention';
import { useStore } from '../store';
import { Menu } from './page/Menu';
import { useAllProposals } from './useProposals';
import { PIcon } from './page/PIcon';
import { NewProjectDialog } from './NewProjectDialog';
import { projectLabel } from './projectsLogic';
import { projectMenu } from './page/pageLogic';
import { openProject, setProjectFilter } from './projectsStore';
import './projects.css';
import './page/page.css';

const OPEN_EVENT = 'legion:project-menu';
/** The rail's "N more" opens the project menu. */
export const openProjectMenu = (): void => { window.dispatchEvent(new Event(OPEN_EVENT)); };

/**
 * The rail's project control (spec 3.5): a menu button with the project's name and a dot when asks wait in other projects. The menu
 * lists All projects, the active projects and the archived ones, each with how many asks wait in it.
 */
export function ProjectSwitcher() {
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.projectFilter);
  const view = useStore((s) => s.view);
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const tasks = useStore((s) => s.tasks);
  const proposals = useAllProposals();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { const on = (): void => setOpen(true); window.addEventListener(OPEN_EVENT, on); return () => window.removeEventListener(OPEN_EVENT, on); }, []);
  const asks = useMemo(() => deriveAsks({ approvals, questions, tasks, proposals }), [approvals, questions, tasks, proposals]);
  const menu = useMemo(() => projectMenu(projects, asks, filter), [projects, asks, filter]);
  const current = filter ? projects.find((p) => p.id === filter) : undefined;
  const label = current ? projectLabel(current) : 'All projects';
  return (
    <div className="proj-switch">
      <div className="proj-label" id="proj-label">Project</div>
      <button ref={btn} type="button" className="pg-proj" id="proj-select" aria-haspopup="menu" aria-expanded={open} aria-labelledby="proj-label proj-select-name"
        aria-describedby={menu.elsewhere ? 'proj-else' : undefined} title={`Shows ${label}. Pick a project to filter the rail and the tasks.`} onClick={() => setOpen((v) => !v)}>
        <span className="pn" id="proj-select-name">{label}</span>
        {menu.elsewhere > 0 && <span className="else" id="proj-else" title="Waiting in other projects. Opens the project list." aria-label={`${menu.elsewhere} ${menu.elsewhere === 1 ? 'ask' : 'asks'} waiting in other projects`}><i aria-hidden="true" /><span aria-hidden="true">{menu.elsewhere} waiting elsewhere</span></span>}
        <PIcon name="chev" size={12} />
      </button>
      {open && (
        <Menu anchor={btn} label="Project" onClose={() => setOpen(false)} minWidth={240}>
          {menu.rows.map((r) => (
            <button key={r.id ?? 'all'} type="button" role="menuitemradio" aria-checked={r.current} onClick={() => { setOpen(false); setProjectFilter(r.id); }}>
              <span className="mm"><b>{r.label}</b></span>
              {r.needYou > 0 && <span className="else"><i aria-hidden="true" />{r.needYou} {r.needYou === 1 ? 'needs' : 'need'} you</span>}
              {r.current && <PIcon name="check" size={14} className="ck" />}
            </button>
          ))}
        </Menu>
      )}
      <div className="proj-actions">
        {filter && <button type="button" className="btn-ghost sm" onClick={() => openProject(filter)} aria-pressed={view === 'project'}>Project page</button>}
        <button type="button" className="btn-ghost sm" onClick={() => setCreating(true)}>New project</button>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
