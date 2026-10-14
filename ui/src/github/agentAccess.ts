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
