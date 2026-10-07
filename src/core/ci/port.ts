/**
 * The GitHub port the CI panel talks to: exactly the four read members of the connectors client (src/core/connectors/github/client.ts),
 * typed from it. Writes are a separate, optional `GitHubWrites` (connectors writes.ts, slice 2): without it the panel is read-only.
 * Errors are thrown as the client's `GhError` (kind, needs, resetAt, retryable); never a URL, header or body inside.
 */
import type { Connection, GhArea, GhInit, GhResponse, GitHubClient } from '../connectors/github/client.js';

export type { Connection, GhArea, GhInit, GhResponse };

/** connection, can, request, logs: what the real client has today. `logs(jobId, repo)` takes "owner/name" (validated by validRepoString). */
export type GitHubPort = Pick<GitHubClient, 'connection' | 'can' | 'request' | 'logs'>;

/** writes.ts: the CI module calls these from its two admin routes only (a source test enforces it). Absent: no write is possible. */
export interface GitHubWrites {
  rerunFailed(runId: number, repo: string): Promise<void>;
  cancel(runId: number, repo: string): Promise<void>;
}

/** Plain shape of a client failure, as the CI module reads it. */
export type GhError =
  | { kind: 'not-connected' }
  | { kind: 'auth-expired' }
  | { kind: 'forbidden'; needs?: 'write' | 'read' }
  | { kind: 'rate-limited'; resetAt: string }
  | { kind: 'not-found' }
  | { kind: 'logs-unavailable' }
  | { kind: 'network'; retryable: boolean };

const KINDS = new Set(['not-connected', 'auth-expired', 'forbidden', 'rate-limited', 'not-found', 'logs-unavailable', 'network']);
/** Narrows anything a client threw to a GhError. Anything else becomes a retryable network error (its text is dropped on purpose). */
export function asGhError(e: unknown): GhError {
  if (e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string' && KINDS.has((e as { kind: string }).kind)) {
    const k = e as GhError;
    if (k.kind === 'rate-limited') return { kind: 'rate-limited', resetAt: typeof k.resetAt === 'string' && Number.isFinite(Date.parse(k.resetAt)) ? k.resetAt : new Date(Date.now() + 60_000).toISOString() };
    if (k.kind === 'network') return { kind: 'network', retryable: k.retryable !== false };
    if (k.kind === 'forbidden') return { kind: 'forbidden', ...(k.needs ? { needs: k.needs } : {}) };
    return { kind: k.kind } as GhError;
  }
  return { kind: 'network', retryable: true };
}
