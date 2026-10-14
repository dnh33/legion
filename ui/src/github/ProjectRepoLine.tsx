/** The project page's GitHub repo line (spec 4.3): the project's own repo, whether it is turned on, how many members have access, and two buttons that raise access for this project's members only (one core call). */
import { useEffect, useState } from 'react';
import type { Project } from '../../../src/shared/projects';
import { agentGithubLevel, githubAgentsFor } from '../../../src/shared/github-area';
import { useStore } from '../store';
import { accessRefusal, grantCopy, planProjectGrant } from './agentAccess';
import { loadProjectRepo, putProjectAccess } from './areaApi';
import { projectRepoNotice } from './accessState';
import { openGithubArea } from './openArea';
import type { ProjectRepo } from './accessState';
import './github-access.css';

export function ProjectRepoLine({ project }: { project: Project }) {
  const agents = useStore((s) => s.agents);
  const [info, setInfo] = useState<ProjectRepo | null | undefined>(undefined);
  const [ask, setAsk] = useState<{ kind: 'read' | 'write'; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { let live = true; void loadProjectRepo(project.id).then((r) => { if (live) setInfo(r); }); return () => { live = false; }; }, [project.id, project.folder, n]);
  if (info === undefined) return null;
  if (info === null) return <p className="lead" role="alert" data-testid="project-repo-line">Legion could not reach GitHub to check this project&rsquo;s repository. <button type="button" className="gha-link" onClick={() => { setInfo(undefined); setN((x) => x + 1); }}>Try again</button></p>;
  const { text, offer } = projectRepoNotice(info);
  if (!offer || !info.repo) return <p className="lead" data-testid="project-repo-line">{text}</p>;
  const repo = info.repo;

  const members = agents.filter((a) => project.members.includes(a.id));
  const seen = githubAgentsFor(repo, members);
  const anyAccess = members.filter((a) => agentGithubLevel(a) !== 'none').length;
  const begin = (kind: 'read' | 'write'): void => { setNote(null); const { changes } = planProjectGrant(kind, repo, project.members, agents); if (changes.length === 0) setNote({ text: grantCopy(kind, repo, 0).nothing, bad: false }); else setAsk({ kind, count: changes.length }); };
  const apply = async (): Promise<void> => {
    if (!ask) return;
    setBusy(true);
    const r = await putProjectAccess(project.id, ask.kind);
    setBusy(false);
    // A refusal stays inline and the question stays open, so the owner can fix the cause and press Confirm again.
    if (!r.ok) { setNote({ text: accessRefusal(r.status, r.message), bad: true }); return; }
    setAsk(null);
    setNote({ text: `${r.agents} ${r.agents === 1 ? 'agent' : 'agents'} updated.`, bad: false });
  };
  const copy = ask ? grantCopy(ask.kind, repo, ask.count) : null;
  return (
    <div className="pgh" data-testid="project-repo-line">
      <p className="lead">This project&rsquo;s repository is <span className="pgh-repo">{repo}</span>. {text} {members.length === 0 ? 'The project has no members.' : `${anyAccess} of ${members.length} members can use GitHub; ${seen.write.length} can write to it.`}{!info.ticked && <> <button type="button" className="gha-link" onClick={() => openGithubArea(repo)}>Turn it on in the GitHub area</button></>}</p>
      <div className="pgh-row">
        <button type="button" className="pg-btn" disabled={busy || members.length === 0 || !!ask} onClick={() => begin('read')}>Let this project&rsquo;s agents read it</button>
        <button type="button" className="pg-btn" disabled={busy || members.length === 0 || !info.ticked || !!ask} onClick={() => begin('write')}>Let them write</button>
      </div>
      {ask && copy?.confirm && (
        <div className="pg-sh-conf pg-confirm" role="group" aria-label={copy.confirm}>
          <p><b>{copy.confirm}</b></p>
          <div className="row">
            <button type="button" className="pg-btn" disabled={busy} onClick={() => void apply()}>Confirm</button>
            <button type="button" className="pg-btn ghost" disabled={busy} onClick={() => { setAsk(null); setNote(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {note && <p className="lead" role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
    </div>
  );
}
