import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast, useStore } from '../store';
import { acceptItem, rejectItem, sayItem, useBoard } from '../projects/board/boardStore';
import { actionNotice, actionState, descriptionNeedsMore, proposalNote } from '../projects/proposalCard';
import { openInboxItem } from '../projects/projectsStore';
import { canTakeFocus, clearAskRequest, getAskRequest, proposalFocusPlan, proposalsForThread, subscribeFocus } from '../projects/railRoute';
import { useAllProposals } from '../projects/useProposals';
import { Icon } from './icons';

/**
 * A card for each board proposal the agent waits on you for, shown in the chat the rail click opens (the agent's newest chat in that
 * project), so the chat says why the rail says "Needs you". Accept and Reject are the Inbox's own actions; Open on board shows the entry.
 */
export function ProposalCards({ agentId, taskId }: { agentId: string; taskId: string | null }) {
  const all = useAllProposals();
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const busy = useBoard((s) => s.busy);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const archived = new Set(projects.filter((p) => p.status === 'archived').map((p) => p.id));
  const mine = proposalsForThread(agentId, taskId, tasks, all, archived);
  // opened from a click that named one of these cards: bring it into view and focus it, once
  const req = useSyncExternalStore(subscribeFocus, getAskRequest);
  const boardLoaded = req?.boardAt !== undefined; // the fresh load for this click finished
  const plan = proposalFocusPlan(req, taskId, mine.map((i) => i.id), all.map((i) => i.id), boardLoaded);
  useEffect(() => {
    if (plan === 'show' && req) {
      const el = document.querySelector<HTMLElement>(`[data-proposal-id="${CSS.escape(req.askId)}"]`);
      el?.scrollIntoView?.({ block: 'nearest' });
      if (canTakeFocus(document.activeElement as HTMLElement | null)) el?.focus({ preventScroll: true });
      clearAskRequest();
    } else if (plan === 'gone') {
      toast('That proposal was already handled.', 'info');
      clearAskRequest();
    }
  }, [plan, req]);
  if (mine.length === 0) return null;
  const who = agents.find((a) => a.id === agentId)?.name ?? 'The agent';
  const st = actionState({ archived: false, busy });
  return (
    <div className="proposal-cards" role="region" aria-label="Board proposals waiting for you">
      {mine.map((i) => {
        const project = projects.find((p) => p.id === i.projectId)?.name;
        const suggested = i.proposal?.suggestedAssignee;
        const tainted = i.createdBy.kind === 'agent' && !!i.createdBy.tainted;
        const long = descriptionNeedsMore(i.description);
        return (
          <div key={i.id} className="approval" tabIndex={0} role="group" data-proposal-id={i.id} aria-label={`Board proposal: ${i.title}`}>
            <div className="approval-head"><Icon name="inbox" size={14} /><span>Needs your OK</span><b className="approval-tool">board item</b></div>
            <p className="proposal-title">{who} proposes a board item{project ? ` in ${project}` : ''}: <b>{i.title}</b></p>
            <p className="muted-s">{proposalNote(who, tainted)}</p>
            {i.description && (
              <>
                <p className={`proposal-desc${more[i.id] ? ' open' : ''}`}>{i.description}</p>
                {long && <button type="button" className="link-btn" aria-expanded={!!more[i.id]} onClick={() => setMore({ ...more, [i.id]: !more[i.id] })}>{more[i.id] ? 'Less' : 'More'}</button>}
              </>
            )}
            <div className="approval-actions">
              <button className="btn primary" disabled={st.disabled} title={st.reason} onClick={() => void acceptItem(i.projectId, i.id, { assignee: suggested ? { kind: 'agent', id: suggested } : null }).then((r) => { const t = actionNotice(r, `${i.title} accepted to Backlog.`); if (t) { sayItem(t); toast(t, 'info'); } })}>Accept</button>
              <button className="btn" disabled={st.disabled} title={st.reason} onClick={() => void rejectItem(i.projectId, i.id).then((r) => { const t = actionNotice(r, `${i.title} rejected.`); if (t) { sayItem(t); toast(t, 'info'); } })}>Reject</button>
              <button className="btn-ghost" onClick={() => openInboxItem(i.projectId, i.id)}>Open on board</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
