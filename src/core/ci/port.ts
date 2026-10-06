/**
 * The GitHub port the CI panel talks to. Members and types follow connectors design rev 6, section 4.3 (the connectors session owns the real
 * client). Release B builds against this type and a fake; the production wiring resolves the real client when it exists.
 * Errors are thrown as GhError-shaped objects, never with a URL, header or body inside.
 */

export interface Connection {
  auth: 'github-app' | 'pat' | 'anonymous';
  login?: string;
  expiresAt?: string;
  permissions?: Record<string, 'read' | 'write'>;
  scopes?: string[];
  rate: { limit: number; remaining: number; resetAt: string };
}

export interface GhResponse {
  status: number;
  json: unknown;
  etag?: string;
  /** 304 when If-None-Match matched. */
  notModified?: boolean;
  rate: { limit: number; remaining: number; resetAt: string };
}

export type GhError =
  | { kind: 'not-connected' }
  | { kind: 'auth-expired' }
  | { kind: 'forbidden'; needs?: 'write' | 'read' }
  | { kind: 'rate-limited'; resetAt: string }
  | { kind: 'not-found' }
  | { kind: 'logs-unavailable' }
  | { kind: 'network'; retryable: boolean };

export interface GhRequestInit { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown }

export type GhArea = 'contents' | 'issues' | 'pull_requests' | 'actions';

/**
 * `repo` ("owner/name", validated by validRepoString) is the REQUIRED trailing argument of logs, rerunFailed and cancel (decided with the
 * connectors session): an id alone cannot name a repository.
 */
export interface GitHubPort {
  connection(): Promise<Connection>;
  can(area: GhArea, level: 'read' | 'write'): 'yes' | 'no' | 'unknown';
  /** api.github.com only; `path` starts with `/`. */
  request(path: string, init?: GhRequestInit): Promise<GhResponse>;
  /** Never a URL. Refuses (logs-unavailable) while the storage host list is empty. */
  logs(jobId: number, repo: string): Promise<{ text: string; truncated: boolean }>;
  /** writes.ts: the CI module calls these from its two admin routes only. */
  rerunFailed(runId: number, repo: string): Promise<void>;
  cancel(runId: number, repo: string): Promise<void>;
}

const KINDS = new Set(['not-connected', 'auth-expired', 'forbidden', 'rate-limited', 'not-found', 'logs-unavailable', 'network']);
/** Narrows anything a client threw to a GhError. Anything else becomes a retryable network error (its text is dropped on purpose). */
export function asGhError(e: unknown): GhError {
  if (e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string' && KINDS.has((e as { kind: string }).kind)) {
    const k = e as GhError;
    if (k.kind === 'rate-limited') return { kind: 'rate-limited', resetAt: typeof k.resetAt === 'string' ? k.resetAt : new Date(Date.now() + 60_000).toISOString() };
    return k;
  }
  return { kind: 'network', retryable: true };
}
