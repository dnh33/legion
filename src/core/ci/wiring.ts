/**
 * Production wiring for the CI module.
 *
 * Client: the real connectors client is imported statically; `resolveGitHub()` asks `getGitHubClient()` on EVERY use (the core creates the
 * single instance at startup, so token refresh goes through one object) and accepts it only when it has the four read members of GitHubPort.
 * Undefined means "unavailable": the panel then says GitHub support arrives with Connectors.
 *
 * Writes: `connectors/github/writes.ts` (slice 2) may not exist yet, so it is loaded lazily through a literal dynamic import (the source
 * tripwire refuses computed specifiers). A missing module means no writes: the panel shows "Connect with write access" and the re-run and
 * cancel routes refuse plainly. A module that exists but fails to load is logged once, by error code only, and tried again later.
 */
import { getGitHubClient } from '../connectors/github/client.js';
import type { GitHubPort, GitHubWrites } from './port.js';

const READ_MEMBERS = ['connection', 'can', 'request', 'logs'] as const;
export const isGitHubPort = (v: unknown): v is GitHubPort => !!v && typeof v === 'object' && READ_MEMBERS.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');
export const isGitHubWrites = (v: unknown): v is GitHubWrites => !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).rerunFailed === 'function' && typeof (v as Record<string, unknown>).cancel === 'function';

/** The core's single client, or undefined (before core start, or with no connectors). Safe to call on every use. */
export function resolveGitHub(get: () => unknown = getGitHubClient): GitHubPort | undefined {
  let got: unknown;
  try { got = get(); } catch { return undefined; }
  return isGitHubPort(got) ? got : undefined;
}

/** A failed or missing module is tried again after this long. */
export const RETRY_IMPORT_MS = 10_000;

export interface WritesResolver {
  /** Synchronous: the write members or undefined. Starts the import at creation, and again after a failure. */
  get(): GitHubWrites | undefined;
  /** Resolves when the import in progress (if any) has finished. For tests. */
  settled(): Promise<void>;
}

export function createWritesResolver(log: (m: string) => void = () => undefined, load: () => Promise<unknown> = defaultLoadWrites, now: () => number = Date.now): WritesResolver {
  let mod: unknown;
  let loading: Promise<void> | undefined;
  let failedAt = -Infinity;
  let logged = false;
  const start = (): void => {
    if (loading) return;
    loading = load().then((m) => { mod = m; }, (e: unknown) => {
      failedAt = now();
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND' && !logged) {
        logged = true;
        log(`ci: the GitHub writes module failed to load (${code ?? (e instanceof Error ? e.name : 'error')})`);
      }
    }).finally(() => { loading = undefined; });
  };
  start();
  return {
    get() {
      if (mod === undefined) { if (now() - failedAt >= RETRY_IMPORT_MS) start(); return undefined; }
      return isGitHubWrites(mod) ? mod : undefined;
    },
    settled: () => loading ?? Promise.resolve(),
  };
}

// @ts-ignore the module does not exist until connectors slice 2 lands
const defaultLoadWrites = (): Promise<unknown> => import('../connectors/github/writes.js');
