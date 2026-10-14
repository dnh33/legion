import { useStore } from '../store';
import { acceptItem, rejectItem, sayItem } from '../projects/board/boardStore';
import { openInboxItem } from '../projects/projectsStore';
import { proposalsFor } from '../projects/railRoute';
import { useAllProposals } from '../projects/useProposals';
import { Icon } from './icons';

/**
 * A card for each board proposal the agent is waiting on you for, so the chat says why the rail says "Needs you".
 * Accept and Decline are the Inbox's own actions; Open on board shows the entry in its project.
 */
export function ProposalCards({ agentId }: { agentId: string }) {
  const all = useAllProposals();
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const mine = proposalsFor(agentId, all);
  if (mine.length === 0) return null;
  const who = agents.find((a) => a.id === agentId)?.name ?? 'The agent';
  return (
    <div className="proposal-cards" role="region" aria-label="Board proposals waiting for you">
      {mine.map((i) => {
        const project = projects.find((p) => p.id === i.projectId)?.name;
        const suggested = i.proposal?.suggestedAssignee;
        return (
          <div key={i.id} className="approval" tabIndex={0} role="group" aria-label={`Board proposal: ${i.title}`}>
            <div className="approval-head"><Icon name="help" size={14} /><span>Needs your OK</span><b className="approval-tool">board item</b></div>
            <pre className="approval-sum">{`${who} proposes a board item${project ? ` in ${project}` : ''}: ${i.title}`}</pre>
            <div className="approval-actions">
              <button className="btn primary" onClick={() => void acceptItem(i.projectId, i.id, { assignee: suggested ? { kind: 'agent', id: suggested } : null }).then(() => sayItem(`${i.title} accepted to Backlog.`))}>Accept</button>
              <button className="btn" onClick={() => void rejectItem(i.projectId, i.id).then(() => sayItem(`${i.title} declined.`))}>Decline</button>
              <button className="btn-ghost" onClick={() => openInboxItem(i.projectId, i.id)}>Open on board</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
