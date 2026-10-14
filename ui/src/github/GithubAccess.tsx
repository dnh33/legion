/** The Connectors fieldset's GitHub choice (spec 4.3): None / Read / Read and write, and under Write the ticked repos to tick per agent. Nothing is on until the owner clicks. */
import { normRepo } from '../../../src/shared/github-area';
import type { GithubLevel } from '../../../src/shared/github-area';
import { tickedRepoNames, WRITE_NOTE } from './agentAccess';
import type { AreaRepos } from './areaApi';
import './github-access.css';

const LEVELS: Array<{ id: GithubLevel; label: string; help: string }> = [
  { id: 'none', label: 'None', help: 'This agent cannot see GitHub.' },
  { id: 'read', label: 'Read', help: 'Repositories, issues, pull requests and CI, for every repo you ticked.' },
  { id: 'write', label: 'Read and write', help: 'Also comment, open issues and pull requests, review, and re-run CI, on the repos you pick below.' },
];

export function GithubAccess({ level, onLevel, repos, onRepos, area }: { level: GithubLevel; onLevel: (l: GithubLevel) => void; repos: string[]; onRepos: (r: string[]) => void; area: AreaRepos | null }) {
  const ticked = area ? tickedRepoNames(area) : [];
  const tickedKeys = new Set(ticked.map(normRepo));
  // A repo this agent may write to but that is no longer ticked stays in the list, flagged: the next write there is refused.
  const stale = repos.filter((r) => !tickedKeys.has(normRepo(r)));
  const has = (r: string): boolean => repos.some((x) => normRepo(x) === normRepo(r));
  const flip = (r: string): void => onRepos(has(r) ? repos.filter((x) => normRepo(x) !== normRepo(r)) : [...repos, r]);
  return (
    <div className="gha" role="radiogroup" aria-labelledby="gha-label">
      <span id="gha-label" className="gha-label">GitHub</span>
      <div className="gha-seg">
        {LEVELS.map((l) => (
          <label key={l.id} className={'gha-opt' + (level === l.id ? ' on' : '')}>
            <input type="radio" name="gha-level" checked={level === l.id} onChange={() => onLevel(l.id)} />
            <span>{l.label}</span>
          </label>
        ))}
      </div>
      <span className="field-note">{LEVELS.find((l) => l.id === level)!.help} Connect GitHub first in Settings, GitHub. A run started from Claude Code or another MCP client never gets connectors.</span>
      {level === 'write' && (
        <div className="gha-write" role="group" aria-label="Repositories this agent may write to">
          {ticked.length === 0 && stale.length === 0 && <span className="field-note">No repositories are ticked yet. Tick the ones Legion may use in the GitHub area, then pick them here.</span>}
          {ticked.map((r) => <label key={r} className="check-row"><input type="checkbox" checked={has(r)} onChange={() => flip(r)} /> <span className="gha-repo">{r}</span></label>)}
          {stale.map((r) => <label key={r} className="check-row"><input type="checkbox" checked onChange={() => flip(r)} /> <span className="gha-repo">{r}</span> <span className="field-note">Not ticked in Legion, so writes here are refused.</span></label>)}
          {repos.length === 0 && ticked.length > 0 && <span className="field-note">Pick at least one repository, or this agent stays on Read.</span>}
          <span className="field-note">{WRITE_NOTE}</span>
        </div>
      )}
    </div>
  );
}
