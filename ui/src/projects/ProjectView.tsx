import { useStore } from '../store';
import { closeProjectPage } from './projectsStore';
import { ProjectFrame } from './page/ProjectPage';
import './projects.css';

/** The project page: the tabbed frame (header, meta line, tabs) of the project in view. Everything it shows lives in ./page/. */
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
  return <ProjectFrame key={project.id} project={project} />;
}
