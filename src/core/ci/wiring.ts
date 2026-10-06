/**
 * Production wiring for the CI module's GitHub port. The client belongs to the connectors work: this module never constructs it (token refresh
 * must go through one instance). It calls `getGitHubClient()` from `src/core/connectors/github/client.ts`, which returns the core's single
 * instance or undefined. Undefined, a missing module or an object that is not a GitHubPort all mean "unavailable": the panel then says GitHub
 * support arrives with Connectors. The import specifier is a string literal on purpose (the source tripwire refuses computed ones).
 */
import type { GitHubPort } from './port.js';

const MEMBERS = ['connection', 'can', 'request', 'logs', 'rerunFailed', 'cancel'] as const;
export const isGitHubPort = (v: unknown): v is GitHubPort => !!v && typeof v === 'object' && MEMBERS.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');

export async function resolveGitHub(log: (m: string) => void = () => undefined): Promise<GitHubPort | undefined> {
  try {
    // @ts-ignore the module does not exist until the connectors client lands
    const mod = (await import('../connectors/github/client.js')) as { getGitHubClient?: () => unknown };
    const got = mod.getGitHubClient?.();
    if (got === undefined) return undefined;
    if (isGitHubPort(got)) return got;
    log('ci: the GitHub client does not match the port, the CI panel stays unavailable');
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') log(`ci: the GitHub client could not be loaded (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`);
  }
  return undefined;
}
