import { useMemo } from 'react';
import { openEditor, selectAgent, useStore } from '../store';
import { Icon } from './icons';
import { vmTone, vmLabel } from '../util';
import { Bust } from '../mascot/Bust';
import { ProjectSwitcher, openProjectMenu } from '../projects/ProjectSwitcher';
import { agentsFor, waitingElsewhere } from '../projects/projectsLogic';
import { railLine } from '../projects/page/pageLogic';
import { AgentBust } from '../projects/page/AgentBust';
import { hasBust } from '../mascot/busts';
import { useAllProposals } from '../projects/useProposals';
import { openAsk, openProjectBoard } from '../projects/projectsStore';
import { heldAgents } from '../chat/queue';
import { githubTag } from '../github/agentAccess';
import '../github/github-access.css';
import { ownerOfThread, useQueueState } from '../chat/queueStore';

/** The rail shows at most this many "needs you elsewhere" rows; the rest sit behind "N more" (which opens the project menu). */
const WAIT_CAP = 3;

export function AgentRail() {
  const agents = useStore((s) => s.agents);
  const sel = useStore((s) => s.selectedAgentId);
  const vms = useStore((s) => s.vms);
  const approvals = useStore((s) => s.approvals);
  const tasks = useStore((s) => s.tasks);
  const questions = useStore((s) => s.questions);
  const loaded = useStore((s) => s.loaded);
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.projectFilter);
  const view = useStore((s) => s.view);
  const proposals = useAllProposals();
  const shown = agentsFor(agents, projects, filter);
  const filterName = filter ? projects.find((p) => p.id === filter)?.name : undefined;
  // a paused queue shows on the agent too, not only inside its thread, so a message waiting on you is never out of sight
  const queues = useQueueState();
  const held = useMemo(() => heldAgents(queues, (k) => ownerOfThread(k, tasks)), [queues, tasks]);
  // anything waiting on the owner stays in sight whatever project is in view (decision B1): one click opens it in its own project
  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])), [agents]);
  const waiting = useMemo(() => waitingElsewhere(approvals, questions, tasks, projects, names, filter, proposals), [approvals, questions, tasks, projects, names, filter, proposals]);
  const lineFacts = useMemo(() => ({ tasks, projects, agents, approvals, questions, board: { items: [], inbox: proposals } }), [tasks, projects, agents, approvals, questions, proposals]);

  // one tab stop for the member list: Arrow keys move inside it
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button.agent'));
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[next]?.focus();
  };
  const tabStop = shown.some((a) => a.id === sel) ? sel : shown[0]?.id;

  return (
    <nav className="rail" aria-label="Agents">
      {view === 'project' && <a className="pg-skip" href="#pg-panel" onClick={(e) => { e.preventDefault(); document.getElementById('pg-panel')?.focus(); }}>Skip to project page</a>}
      <ProjectSwitcher />
      {waiting.length > 0 && (
        <section className="rail-waiting" data-testid="rail-waiting" aria-live="polite" aria-label="Needs you in other projects">
          <div className="rail-head"><span>Needs you in other projects ({waiting.length})</span></div>
          {waiting.slice(0, WAIT_CAP).map((row) => (
            <button key={row.id} type="button" className="rail-wait-row" title={row.label}
              onClick={() => { if (row.kind === 'proposal' && row.projectId) openProjectBoard(row.projectId); else openAsk({ taskId: row.taskId }); }}>
              <Icon name={row.kind === 'approval' ? 'shield' : 'help'} size={12} /><span>{row.label}</span>
            </button>
          ))}
          {waiting.length > WAIT_CAP && <button type="button" className="rail-wait-more" onClick={openProjectMenu}>{waiting.length - WAIT_CAP} more</button>}
        </section>
      )}
      <div className="rail-head"><span title={filterName ? `Members of ${filterName}` : undefined}>{filterName ? 'Members' : 'Agents'}</span></div>
      <div className="rail-list" onKeyDown={onListKey}>
        {!loaded && [0, 1, 2].map((i) => <div key={i} className="agent skeleton" />)}
        {loaded && filter && shown.length === 0 && <p className="muted-s" style={{ padding: '4px 8px' }}>No members yet. Open the project page to add some.</p>}
        {shown.map((a, i) => {
          const vm = vms[a.id];
          const tone = vm ? vmTone(vm.state) : 'off';
          const line = railLine(lineFacts, a.id, filter, a.description || a.model);
          const running = tasks.some((t) => t.agentId === a.id && (t.status === 'running' || t.status === 'queued'));
          const queuedHeld = line.tone !== 'attn' ? (held.get(a.id) ?? 0) : 0;
          const subText = queuedHeld > 0 ? (held.get(a.id) === 1 ? 'Queued message paused' : `${held.get(a.id)} queues paused`) : line.text;
          const full = queuedHeld > 0 ? subText : line.full;
          return (
            <button key={a.id} className={`agent${hasBust(a.id) ? ' bust-row' : ''}${a.id === sel ? ' sel' : ''}`} onClick={() => selectAgent(a.id)} aria-current={a.id === sel}
              tabIndex={a.id === tabStop ? 0 : -1} title={`${a.name}${i < 9 ? ` (Alt ${i + 1})` : ''}`}
              aria-label={`${a.name}. ${full}${line.runs >= 2 ? `. ${line.runs} live runs` : ''}`}>
              {hasBust(a.id)
                ? <span className={`avatar bust-avatar${running ? ' busy' : ''}`}><AgentBust agentId={a.id} size={34} runs={line.runs} /></span>
                : <span className={`avatar${running ? ' busy' : ''}`}>{a.emoji || '●'}{line.runs >= 2 && <span className="pg-rc" aria-hidden="true">{line.runs}</span>}</span>}
              <span className="agent-main">
                <span className="agent-name">{a.name}</span>
                <span className={`agent-sub${line.tone === 'attn' && !queuedHeld ? ' attn' : line.tone === 'work' && !queuedHeld ? ' also' : queuedHeld ? ' warn' : ''}`} title={full} data-testid="rail-subline">{subText}</span>
                {githubTag(a) && <span className="agent-gh" data-testid="rail-github-tag">{githubTag(a)}</span>}
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
