/** Shapes the CI panel shares between the core (src/core/ci) and the UI (ui/src/ci). No secrets, no URLs except GitHub page links. */

export interface CiRun {
  id: number;
  workflow: string;
  branch: string;
  sha: string;
  title: string;
  status: string;
  conclusion: string | null;
  url: string;
  event: string;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  /** Null while the run is not finished. */
  durationMs: number | null;
}

export interface CiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** Read from the job name or labels; null when it says nothing. */
  os: 'windows' | 'linux' | 'macos' | null;
}

/** The same shape `github_ci_wait` returns (connectors design rev 6). */
export interface RunSummary {
  status: string;
  conclusion: string | null;
  url: string;
  failedJobs: Array<{ id: number; name: string; conclusion: string | null }>;
}

export interface CiProblem {
  kind: 'not-connected' | 'auth-expired' | 'forbidden' | 'rate-limited' | 'not-found' | 'network' | 'budget';
  resetAt?: string;
}

export interface CiCounts { success: number; failure: number; running: number }

export interface CiRateView { limit: number; remaining: number; resetAt: string }

export interface CiStateView {
  /** False when this build has no GitHub client yet. */
  available: boolean;
  repo: { owner: string; name: string; source: 'remote' | 'manual' } | null;
  branch: string | null;
  defaultBranch: string;
  connection: { auth: 'github-app' | 'pat' | 'anonymous'; login?: string; rate: CiRateView } | null;
  canWrite: 'yes' | 'no' | 'unknown';
  /** 'live' = polled while something runs; 'slow' = anonymous, refreshed on open, focus and the Refresh button. */
  live: 'live' | 'slow';
  problem: CiProblem | null;
  updatedAt: string | null;
}

export interface CiRunsView {
  runs: CiRun[];
  counts: CiCounts;
  /** True when the rows are older than the last attempt (an error, a pause or a spent budget). */
  stale: boolean;
  problem: CiProblem | null;
  updatedAt: string | null;
}

export interface CiJobsView { jobs: CiJob[]; summary: RunSummary | null; problem: CiProblem | null }

export type CiLogView =
  | { available: true; text: string; truncated: boolean; masked: boolean }
  | { available: false; reason: 'logs-unavailable' | 'expired' | 'problem'; problem?: CiProblem };

/** Body of the SSE event `ci.updated`: enough for the chip; the panel re-reads. */
export interface CiUpdateSummary { repo: string | null; branch: string | null; counts: CiCounts; running: boolean; problem: CiProblem | null; rev: number }

/** Heartbeat interval the UI uses, and how long the core trusts one. */
export const CI_HEARTBEAT_MS = 30_000;
export const CI_WATCH_TTL_MS = 75_000;
