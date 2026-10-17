// The chips on a run header: how the run asks ("Runs as Ask", with the reason on hover and for screen readers) and how much of the web it read.
// Both come from what the engine recorded when the run started and as it read (Task.runsAs, Task.web); a run with nothing to say shows nothing.
import type { AgentProfile, Task } from '../../../src/shared/types';
import type { Project } from '../../../src/shared/projects';
import { useStore } from '../store';
import { runChips } from './agentFollowLogic';
import type { GatesView } from './presetsLogic';
import { useGatesView } from './useGatesView';
import './gates.css';

export function RunChips({ task, agent, projects, view }: { task?: Task; agent?: AgentProfile; projects: readonly Project[]; view: GatesView | null }) {
  const c = runChips(task, agent, projects, view);
  if (!c.runsAs && !c.web) return null;
  return (
    <>
      {c.runsAs && (
        <span className={`chip-pill runs-as${c.runsAs.full ? ' ap-full' : ''}`} title={c.runsAs.reason ?? 'How this run asks'}>
          {c.runsAs.text}
          {c.runsAs.reason && <span className="sr-only">. {c.runsAs.reason}</span>}
        </span>
      )}
      {c.web && <span className="chip-pill web-chip" title="Pages this run read on the web, and sites you approved for it. Only counts are kept.">{c.web}</span>}
    </>
  );
}

/** The chips in the thread header: reads the projects and the gate settings itself. */
export function RunChipsLive({ task, agent }: { task?: Task; agent?: AgentProfile }) {
  const projects = useStore((s) => s.projects);
  const { view } = useGatesView();
  return <RunChips task={task} agent={agent} projects={projects} view={view} />;
}
