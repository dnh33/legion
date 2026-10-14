/** Per-agent GitHub access (spec 4.3): the editor choice, the tag, and the project buttons. Pure, so the tests render nothing. */
import { agentGithubLevel, normRepo } from '../../../src/shared/github-area.js';
import type { GithubLevel } from '../../../src/shared/github-area.js';

export const WRITE_NOTE = 'Every write asks you first, even with Full access.';
export type AccessFields = { connectors?: string[]; githubWrite?: string[] };

/** What a saved agent carries for a chosen level. Read clears githubWrite; None clears both. */
export function accessPatch(level: GithubLevel, writeRepos: string[]): { connectors: string[]; githubWrite: string[] } {
  if (level === 'none') return { connectors: [], githubWrite: [] };
  return { connectors: ['github'], githubWrite: level === 'write' ? writeRepos : [] };
}

/** The most repos one agent may write to; the core refuses a longer list. */
export const GITHUB_WRITE_MAX = 100;

/** The repos the Write checklist offers: ticked in the GitHub area only. */
export const tickedRepoNames = (area: { repos: Array<{ fullName: string; ticked: boolean }> }): string[] => area.repos.filter((r) => r.ticked).map((r) => r.fullName);

/** The small tag on the agent row. Null at level none. */
export function githubTag(a: AccessFields): string | null {
  const lvl = agentGithubLevel(a);
  if (lvl === 'none') return null;
  if (lvl === 'read') return 'GitHub: read';
  const n = a.githubWrite?.length ?? 0;
  return `GitHub: write, ${n} ${n === 1 ? 'repo' : 'repos'}`;
}

export interface GrantChange { id: string; patch: { connectors: string[]; githubWrite?: string[] } }

/** The project buttons act on that project's members only. They raise access, never lower it, and skip agents that already have it. */
export function planProjectGrant(kind: 'read' | 'write', repo: string, memberIds: string[], agents: Array<AccessFields & { id: string }>): { changes: GrantChange[] } {
  const r = normRepo(repo);
  const changes: GrantChange[] = [];
  for (const a of agents) {
    if (!memberIds.includes(a.id)) continue;
    const lvl = agentGithubLevel(a);
    if (kind === 'read') { if (lvl === 'none') changes.push({ id: a.id, patch: { connectors: ['github'] } }); continue; }
    const have = lvl === 'write' ? a.githubWrite ?? [] : [];
    if (have.map(normRepo).includes(r)) continue;
    changes.push({ id: a.id, patch: { connectors: ['github'], githubWrite: [...have, r] } });
  }
  return { changes };
}

/** Words for the confirm step. `confirm` is null when nothing would change. */
export function grantCopy(kind: 'read' | 'write', repo: string, count: number): { confirm: string | null; nothing: string } {
  const who = `${count} ${count === 1 ? 'agent' : 'agents'}`;
  const nothing = kind === 'read' ? 'Every member can already read it.' : 'Every member can already write to it.';
  if (count === 0) return { confirm: null, nothing };
  return { confirm: kind === 'read' ? `Let ${who} read ${repo}?` : `Let ${who} write to ${repo}? Every write still asks you first.`, nothing };
}

/** Saved write repos that are not ticked. Only a list that really loaded can say so: loading, a failed read or a failed refresh proves nothing. */
export function unticked(a: { status: 'loading' | 'error' | 'ok'; view: { repos: Array<{ fullName: string; ticked: boolean }>; problem?: unknown } | null }, repos: string[]): string[] {
  if (a.status !== 'ok' || !a.view || a.view.problem) return [];
  const keys = new Set(tickedRepoNames(a.view).map(normRepo));
  return repos.filter((r) => !keys.has(normRepo(r)));
}

/** The core's refusals of the project access call, in words for the owner. */
export function accessRefusal(status: number, message: string): string {
  if (status === 0) return 'Legion could not be reached. Try again.';
  if (status === 409 && /too-many-ticked/.test(message)) return 'Too many repositories are turned on. Turn some off in the GitHub area first.';
  if (status === 409 && /turn this repo on/i.test(message)) return 'Turn this repo on in the GitHub area first.';
  if (status === 409 && /no github repository/i.test(message)) return 'This project’s folder has no GitHub repository.';
  return 'Legion could not save that. Try again.';
}
