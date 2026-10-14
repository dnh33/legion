/**
 * The addresses the GitHub client may reach, kept apart from client.ts on purpose: the tripwire (test/bsv-scan.ts) lets the one file that
 * uses the network name only loopback addresses in its own text, so every real address lives here, where nothing makes a request.
 */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_WEB_ORIGIN = 'https://github.com';
/** The only page Legion shows the owner for the device flow. A server-supplied address is never displayed instead. */
export const GITHUB_DEVICE_PAGE = 'https://github.com/login/device';

/**
 * Hosts a job-log redirect may point to (exact host names). Ships EMPTY, so every log fetch fails closed with `logs-unavailable`
 * until the real-PC check C-GH-2 has recorded the host names GitHub really redirects to and this list is filled in.
 */
export const GITHUB_LOG_STORAGE_HOSTS: readonly string[] = [];

/**
 * Client ids of the two registered GitHub Apps (a client id is public by design, not a secret). "Legion (read)": slug legion-read, App ID
 * 5314210. "Legion (write)": slug legion-write, App ID 5314282 (it also holds the narrow "Repository creation" permission; there is no third
 * App). The device flow refuses to start for any id that does not look like a real one (a placeholder such as `unregistered`).
 */
export const GITHUB_READ_APP_CLIENT_ID = 'Iv23liIt2yvFfWgPrZfK';
export const GITHUB_WRITE_APP_CLIENT_ID = 'Iv23li7s6igxaj3TZMa3';
export const GITHUB_APP_SLUGS: Record<'read' | 'write', string> = { read: 'legion-read', write: 'legion-write' };
/** GitHub App client ids look like `Iv1.0123456789abcdef` or `Iv23liXXXXXXXXXXXX`. */
export const looksLikeClientId = (id: unknown): id is string => typeof id === 'string' && /^Iv\d+\.?[A-Za-z0-9]{8,40}$/.test(id);
/** Where the owner installs an App on an account and picks its repositories. */
export const githubInstallUrl = (slug: string): string => `${GITHUB_WEB_ORIGIN}/apps/${slug}/installations/new`;
/** Where the owner sees every installed App, and where one installation's repository choice is edited. */
export const GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations';
export const githubInstallSettingsUrl = (inst: { id: number; account: { login: string; type: 'User' | 'Organization' } }): string =>
  inst.account.type === 'Organization'
    ? `${GITHUB_WEB_ORIGIN}/organizations/${encodeURIComponent(inst.account.login)}/settings/installations/${inst.id}`
    : `${GITHUB_INSTALLATIONS_URL}/${inst.id}`;
/** Where the owner revokes a grant at GitHub. Legion has no client secret, so it cannot revoke remotely (design 4.2 step 9, check C-GH-6). */
export const GITHUB_APPS_SETTINGS_URL = 'https://github.com/settings/applications';
