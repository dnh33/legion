import { openEditor, selectAgent, useStore } from '../store';
import { Icon } from './icons';
import { vmTone, vmLabel } from '../util';

export function AgentRail() {
  const agents = useStore((s) => s.agents);
  const sel = useStore((s) => s.selectedAgentId);
  const vms = useStore((s) => s.vms);
  const approvals = useStore((s) => s.approvals);
  const tasks = useStore((s) => s.tasks);
  const loaded = useStore((s) => s.loaded);

  return (
    <nav className="rail" aria-label="Agents">
      <div className="rail-head"><span>Agents</span></div>
      <div className="rail-list">
        {!loaded && [0, 1, 2].map((i) => <div key={i} className="agent skeleton" />)}
        {agents.map((a, i) => {
          const vm = vms[a.id];
          const pending = approvals.filter((x) => x.agentId === a.id).length;
          const running = tasks.some((t) => t.agentId === a.id && (t.status === 'running' || t.status === 'queued'));
          const tone = vm ? vmTone(vm.state) : 'off';
          return (
            <button key={a.id} className={`agent${a.id === sel ? ' sel' : ''}`} onClick={() => selectAgent(a.id)} aria-current={a.id === sel} title={`${a.name}${i < 9 ? ` (Alt ${i + 1})` : ''}`}>
              <span className={`avatar${running ? ' busy' : ''}`}>{a.emoji || '●'}</span>
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
