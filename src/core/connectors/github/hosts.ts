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
 * Client id of the "Legion (read)" GitHub App. PLACEHOLDER until the App is registered (design section 9): the device flow refuses to
 * start while this is not a real-looking id. A client id is public by design (it is not a secret).
 */
export const GITHUB_READ_APP_CLIENT_ID = 'unregistered';
/** GitHub App client ids look like `Iv1.0123456789abcdef` or `Iv23liXXXXXXXXXXXX`. */
export const looksLikeClientId = (id: unknown): id is string => typeof id === 'string' && /^Iv\d+\.?[A-Za-z0-9]{8,40}$/.test(id);
