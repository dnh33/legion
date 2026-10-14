/** The GitHub area's shared contract (UI and core import it; written first so the units can build in parallel). Design 6.5. */
import type { AgentProfile } from './types.js';

export type GithubApp = 'read' | 'write' | 'create';
export interface GithubRepoRow { fullName: string; private: boolean; installedRead: boolean; installedWrite: boolean; ticked: boolean; htmlUrl: string; installationSettingsUrl: string }
export interface GithubAreaView {
  registered: Record<GithubApp, boolean>; signedIn: Record<GithubApp, boolean>; login?: string;
  agentsEnabled: boolean; selection: 'selected' | 'all' | 'unknown'; repos: GithubRepoRow[]; truncated: boolean;
  rate?: { remaining: number; resetAt: string };
  problem?: { kind: 'not-connected' | 'auth-expired' | 'rate-limited' | 'network'; resetAt?: string };
}
export type GithubLevel = 'none' | 'read' | 'write';
export const CREATE_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const normRepo = (s: string): string => s.trim().replace(/\.git$/i, '').toLowerCase();
export function validCreateName(n: string): boolean { return CREATE_REPO_NAME_RE.test(n) && n !== '.' && n !== '..'; }
export function agentGithubLevel(a: { connectors?: string[]; githubWrite?: string[] }): GithubLevel {
  if (!a.connectors?.includes('github')) return 'none';
  return a.githubWrite && a.githubWrite.length > 0 ? 'write' : 'read';
}
export function githubAgentsFor(repo: string, agents: Pick<AgentProfile, 'id' | 'connectors' | 'githubWrite'>[]): { read: string[]; write: string[] } {
  const r = normRepo(repo); const read: string[] = []; const write: string[] = [];
  for (const a of agents) {
    const lvl = agentGithubLevel(a); if (lvl === 'none') continue;
    if (lvl === 'write' && (a.githubWrite ?? []).map(normRepo).includes(r)) write.push(a.id); else read.push(a.id);
  }
  return { read, write };
}
