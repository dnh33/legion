/** The project page's GitHub repo line (spec 4.3): the repo, whether it is ticked, how many members have access, and two buttons that raise access for this project's members only. */
import { useEffect, useState } from 'react';
import type { Project } from '../../../src/shared/projects';
import { agentGithubLevel, githubAgentsFor, normRepo } from '../../../src/shared/github-area';
import { saveAgent, useStore } from '../store';
import { grantCopy, planProjectGrant, tickedRepoNames } from './agentAccess';
import type { GrantChange } from './agentAccess';
import { loadAreaRepos, loadWatchedRepo } from './areaApi';
import type { AreaRepos } from './areaApi';
import './github-access.css';

export function ProjectRepoLine({ project }: { project: Project }) {
  const agents = useStore((s) => s.agents);
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const [area, setArea] = useState<AreaRepos | null>(null);
  const [ask, setAsk] = useState<{ kind: 'read' | 'write'; changes: GrantChange[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { let live = true; void Promise.all([loadWatchedRepo(), loadAreaRepos()]).then(([r, a]) => { if (live) { setRepo(r); setArea(a); } }); return () => { live = false; }; }, [project.id]);
  if (repo === undefined) return null;
  if (repo === null) return <p className="lead">No GitHub repository found in this folder, so there is nothing to share with the agents yet.</p>;

  const members = agents.filter((a) => project.members.includes(a.id));
  const isTicked = area ? tickedRepoNames(area).map(normRepo).includes(normRepo(repo)) : false;
  const seen = githubAgentsFor(repo, members);
  const anyAccess = members.filter((a) => agentGithubLevel(a) !== 'none').length;
  const begin = (kind: 'read' | 'write'): void => { setNote(''); const { changes } = planProjectGrant(kind, repo, project.members, agents); if (changes.length === 0) setNote(grantCopy(kind, repo, 0).nothing); else setAsk({ kind, changes }); };
  const apply = async (): Promise<void> => {
    if (!ask) return;
    setBusy(true);
    let done = 0;
    for (const c of ask.changes) {
      const a = agents.find((x) => x.id === c.id);
      if (a && await saveAgent(a.id, { name: a.name, ...c.patch })) done++;
    }
    setBusy(false); setAsk(null);
    setNote(done === ask.changes.length ? `${done} ${done === 1 ? 'agent' : 'agents'} updated.` : `${done} of ${ask.changes.length} agents updated. The rest did not save.`);
  };
  const copy = ask ? grantCopy(ask.kind, repo, ask.changes.length) : null;
  return (
    <div className="pgh" data-testid="project-repo-line">
      <p className="lead">This project&rsquo;s folder is <span className="pgh-repo">{repo}</span>. {isTicked ? 'You ticked it in Legion.' : 'It is not ticked in Legion yet, so no agent can use it. Tick it in the GitHub area first.'} {members.length === 0 ? 'The project has no members.' : `${anyAccess} of ${members.length} members have GitHub access; ${seen.write.length} can write to it.`}</p>
      <div className="pgh-row">
        <button type="button" className="pg-btn" disabled={busy || members.length === 0 || !!ask} onClick={() => begin('read')}>Let this project&rsquo;s agents read it</button>
        <button type="button" className="pg-btn" disabled={busy || members.length === 0 || !isTicked || !!ask} title={isTicked ? undefined : 'Tick this repository in Legion first'} onClick={() => begin('write')}>Let them write</button>
      </div>
      {ask && copy?.confirm && (
        <div className="pg-sh-conf pg-confirm" role="group" aria-label={copy.confirm}>
          <p><b>{copy.confirm}</b></p>
          <div className="row">
            <button type="button" className="pg-btn" disabled={busy} onClick={() => void apply()}>Confirm</button>
            <button type="button" className="pg-btn ghost" disabled={busy} onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </div>
      )}
      {note && <p className="lead" role="status">{note}</p>}
    </div>
  );
}
