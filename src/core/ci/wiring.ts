/**
 * Production wiring for the CI module's GitHub port. The client belongs to the connectors work: this module never constructs it (token refresh
 * must go through one instance). It asks `getGitHubClient()` from `src/core/connectors/github/client.ts` on EVERY use, so a client created
 * after boot is picked up without a restart. Undefined, a missing module or an object that is not a GitHubPort all mean "unavailable": the
 * panel then says GitHub support arrives with Connectors. The import specifier is a string literal on purpose (the source tripwire refuses
 * computed ones). A module that exists but fails to load is logged once, by kind only.
 */
import type { GitHubPort } from './port.js';

const MEMBERS = ['connection', 'can', 'request', 'logs', 'rerunFailed', 'cancel'] as const;
export const isGitHubPort = (v: unknown): v is GitHubPort => !!v && typeof v === 'object' && MEMBERS.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');

type ClientModule = { getGitHubClient?: () => unknown };
/** A failed or missing module is tried again after this long. */
export const RETRY_IMPORT_MS = 10_000;

export interface GitHubResolver {
  /** Synchronous: the current client or undefined. Starts the import the first time, and again after a failure. */
  get(): GitHubPort | undefined;
  /** Resolves when the import in progress (if any) has finished. For tests. */
  settled(): Promise<void>;
}

export function createGitHubResolver(log: (m: string) => void = () => undefined, load: () => Promise<unknown> = defaultLoad, now: () => number = Date.now): GitHubResolver {
  let mod: ClientModule | undefined;
  let loading: Promise<void> | undefined;
  let failedAt = -Infinity;
  let logged = false;
  const start = (): void => {
    if (loading) return;
    loading = load().then((m) => { mod = (m ?? {}) as ClientModule; }, (e: unknown) => {
      failedAt = now();
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND' && !logged) {
        logged = true;
        log(`ci: the GitHub client module failed to load (${code ?? (e instanceof Error ? e.name : 'error')})`);
      }
    }).finally(() => { loading = undefined; });
  };
  start(); // looked for at boot, and again on use while it is missing
  return {
    get() {
      if (!mod) { if (now() - failedAt >= RETRY_IMPORT_MS) start(); return undefined; }
      let got: unknown;
      try { got = mod.getGitHubClient?.(); } catch { return undefined; }
      return isGitHubPort(got) ? got : undefined;
    },
    settled: () => loading ?? Promise.resolve(),
  };
}

// @ts-ignore the module does not exist until the connectors client lands
const defaultLoad = (): Promise<unknown> => import('../connectors/github/client.js');
