import { openEditor, selectAgent, useStore } from '../store';
import { Icon } from './icons';
import { vmTone, vmLabel } from '../util';
import { Bust } from '../mascot/Bust';
import { ProjectSwitcher } from '../projects/ProjectSwitcher';
import { agentsFor, inProject } from '../projects/projectsLogic';
import { hasBust } from '../mascot/busts';

export function AgentRail() {
  const agents = useStore((s) => s.agents);
  const sel = useStore((s) => s.selectedAgentId);
  const vms = useStore((s) => s.vms);
  const approvals = useStore((s) => s.approvals);
  const tasks = useStore((s) => s.tasks);
  const loaded = useStore((s) => s.loaded);
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.projectFilter);
  const shown = agentsFor(agents, projects, filter);
  const filterName = filter ? projects.find((p) => p.id === filter)?.name : undefined;

  return (
    <nav className="rail" aria-label="Agents">
      <ProjectSwitcher />
      <div className="rail-head"><span title={filterName ? `Members of ${filterName}` : undefined}>{filterName ? 'Members' : 'Agents'}</span></div>
      <div className="rail-list">
        {!loaded && [0, 1, 2].map((i) => <div key={i} className="agent skeleton" />)}
        {loaded && filter && shown.length === 0 && <p className="muted-s" style={{ padding: '4px 8px' }}>No members yet. Open the project page to add some.</p>}
        {shown.map((a, i) => {
          const vm = vms[a.id];
          const pending = approvals.filter((x) => x.agentId === a.id).length;
          const running = tasks.some((t) => t.agentId === a.id && inProject(t, filter) && (t.status === 'running' || t.status === 'queued'));
          const tone = vm ? vmTone(vm.state) : 'off';
          return (
            <button key={a.id} className={`agent${hasBust(a.id) ? ' bust-row' : ''}${a.id === sel ? ' sel' : ''}`} onClick={() => selectAgent(a.id)} aria-current={a.id === sel} title={`${a.name}${i < 9 ? ` (Alt ${i + 1})` : ''}`}>
              {hasBust(a.id)
                ? <span className={`avatar bust-avatar${running ? ' busy' : ''}`}><Bust agentId={a.id} size={44} /></span>
                : <span className={`avatar${running ? ' busy' : ''}`}>{a.emoji || '●'}</span>}
              <span className="agent-main">
                <span className="agent-name">{a.name}</span>
                {pending > 0
                  ? <span className="agent-sub warn"><Icon name="shield" size={11} /><span>{pending === 1 ? '1 needs your OK' : `${pending} need your OK`}</span></span>
                  : <span className="agent-sub">{a.description || a.model}</span>}
              </span>
              <span className="agent-meta">
                {a.vm.enabled && <i className={`pip pip-${tone}`} title={`VM: ${vm ? vmLabel[vm.state] : 'No VM'}`} />}
              </span>
            </button>
          );
        })}
      </div>
      <button className="rail-new" onClick={() => openEditor(null)}><Icon name="plus" size={14} /> New agent</button>
    </nav>
  );
}
