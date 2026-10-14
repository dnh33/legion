/**
 * A typed stand-in for the area routes (design 6.4, amendment 13), used until they are merged. The store reaches it only while USE_MOCK is true.
 * `?ghstate=<scenario>` in the page address picks a starting state, so every state of design 5.4 can be looked at.
 */
import type { CiRun } from '../../../src/shared/ci';
import type { GithubRepoRow } from '../../../src/shared/github-area';
import type { AreaAgent, GithubActivity, GithubAreaData, GithubProjectUse, GithubRepoDetail } from './types';

export type MockScenario = 'ready' | 'loading' | 'not-registered' | 'not-connected' | 'signing-in' | 'nothing-installed' | 'none-ticked' | 'all-repos' | 'auth-ended' | 'rate-limited' | 'offline' | 'writes-on';

const SETTINGS = 'https://github.com/settings/installations/48210331';
const mkRow = (name: string, o: Partial<GithubRepoRow> = {}): GithubRepoRow => ({ fullName: `dnh33/${name}`, private: true, installedRead: true, installedWrite: true, ticked: false, htmlUrl: `https://github.com/dnh33/${name}`, installationSettingsUrl: SETTINGS, ...o });

const REPOS = (): GithubRepoRow[] => [
  mkRow('legion', { ticked: true }),
  mkRow('whole-skein', { ticked: true }),
  mkRow('shoplift', { ticked: true, installedWrite: false }),
  mkRow('aetherkeep'),
  mkRow('curio-theme', { private: false }),
  mkRow('lumina'),
  mkRow('dotfiles', { private: false, installedWrite: false }),
  mkRow('wp-migrat1on-test'),
  mkRow('a-repo-with-a-really-long-name-for-the-wrapping-check-in-narrow-panels'),
];

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const run = (id: number, o: Partial<CiRun>): CiRun => ({ id, workflow: 'CI', branch: 'main', sha: 'a1b2c3d', title: 'Update the docs', status: 'completed', conclusion: 'success', url: `https://github.com/dnh33/legion/actions/runs/${id}`, event: 'push', attempt: 1, createdAt: ago(30), startedAt: ago(30), updatedAt: ago(26), durationMs: 214_000, ...o });

export const MOCK_AGENTS: AreaAgent[] = [
  { id: 'builder', name: 'Builder', connectors: ['github'], githubWrite: ['dnh33/legion'] },
  { id: 'reviewer', name: 'Reviewer', connectors: ['github'] },
  { id: 'scout', name: 'Scout', connectors: ['github'] },
  { id: 'writer', name: 'Writer', connectors: [] },
];

const PROJECTS: Record<string, GithubProjectUse[]> = {
  'dnh33/legion': [{ id: 'proj_0000000000a1', name: 'Legion', agentIds: ['builder', 'reviewer'] }],
  'dnh33/whole-skein': [{ id: 'proj_0000000000a2', name: 'Whole Skein', agentIds: ['scout', 'writer'] }],
  'dnh33/shoplift': [{ id: 'proj_0000000000a3', name: 'SHOPLIFT', agentIds: ['scout'] }],
};

const RUNS: Record<string, { runs: CiRun[]; failed: Record<number, string[]> }> = {
  'dnh33/legion': {
    runs: [
      run(9301, { title: 'github: a GitHub area behind a title-bar icon', branch: 'feat/0.3.0-github-u6', conclusion: 'failure', createdAt: ago(12), startedAt: ago(12), durationMs: 402_000 }),
      run(9300, { title: 'github: the repos you turn on in Legion', status: 'in_progress', conclusion: null, createdAt: ago(3), startedAt: ago(3), durationMs: null }),
      run(9299, { title: 'What\'s new tips after an update', conclusion: 'success' }),
    ],
    failed: { 9301: ['Tests (windows-latest)', 'Typecheck'] },
  },
  'dnh33/whole-skein': { runs: [run(417, { title: 'Fix the cart drawer on narrow screens', url: 'https://github.com/dnh33/whole-skein/actions/runs/417' })], failed: {} },
};

const ACTIVITY = (): GithubActivity[] => [
  { id: 'x1', at: ago(9), agent: 'Builder', kind: 'pull-request', repo: 'dnh33/legion', title: '#141 github: a GitHub area behind a title-bar icon', url: 'https://github.com/dnh33/legion/pull/141' },
  { id: 'x2', at: ago(40), agent: 'Reviewer', kind: 'comment', repo: 'dnh33/legion', title: '#139 github: the repos you turn on in Legion', url: 'https://github.com/dnh33/legion/pull/139' },
  { id: 'x3', at: ago(95), agent: 'Builder', kind: 'rerun', repo: 'dnh33/legion', title: 'CI run on feat/0.3.0-github-u3', url: 'https://github.com/dnh33/legion/actions/runs/9288' },
  { id: 'x4', at: ago(60 * 20), agent: 'Scout', kind: 'issue', repo: 'dnh33/whole-skein', title: '#58 The size guide overflows on phones', url: 'https://github.com/dnh33/whole-skein/issues/58' },
  { id: 'x5', at: ago(60 * 50), agent: 'Scout', kind: 'comment', repo: 'dnh33/shoplift', title: '#12 Collection import is slow', url: 'https://github.com/dnh33/shoplift/issues/12' },
];

const OFF = { read: false, write: false, create: false };

export function mockView(scenario: MockScenario): GithubAreaData {
  const base: GithubAreaData = {
    registered: { read: true, write: true, create: false }, signedIn: { read: true, write: false, create: false }, login: 'dnh33',
    agentsEnabled: true, selection: 'selected', repos: REPOS(), truncated: false, rate: { remaining: 4812, resetAt: new Date(Date.now() + 38 * 60_000).toISOString() },
    activity: ACTIVITY(), orgs: ['legion-labs'],
  };
  switch (scenario) {
    case 'writes-on': return { ...base, signedIn: { read: true, write: true, create: false } };
    case 'not-registered': return { ...base, registered: OFF, signedIn: OFF, repos: [], activity: [], rate: undefined, login: undefined };
    case 'not-connected': case 'signing-in': return { ...base, signedIn: OFF, repos: [], activity: [], rate: undefined, login: undefined };
    case 'nothing-installed': return { ...base, repos: [], activity: [] };
    case 'none-ticked': return { ...base, repos: REPOS().map((r) => ({ ...r, ticked: false })), activity: [] };
    case 'all-repos': return { ...base, selection: 'all' };
    case 'auth-ended': return { ...base, signedIn: OFF, problem: { kind: 'auth-expired' } };
    case 'rate-limited': return { ...base, problem: { kind: 'rate-limited', resetAt: new Date(Date.now() + 22 * 60_000).toISOString() } };
    case 'offline': return { ...base, problem: { kind: 'network' } };
    default: return base;
  }
}

export const mockScenario = (): MockScenario => {
  try { const v = new URLSearchParams(location.search).get('ghstate'); if (v) return v as MockScenario; } catch { /* no address */ }
  return 'ready';
};

export function mockDetail(repo: string): GithubRepoDetail {
  const r = RUNS[repo];
  return {
    projects: PROJECTS[repo] ?? [],
    ci: r ? { runs: r.runs.map((x) => ({ ...x })), failed: { ...r.failed }, problem: null, source: 'here' } : { runs: [], failed: {}, problem: null, source: repo === 'dnh33/aetherkeep' ? 'watch-needed' : 'here' },
  };
}
