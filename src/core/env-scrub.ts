/**
 * Keys, tokens and passwords from the owner's environment are not passed to agent commands (gate `env-scrub`, on in every preset).
 * A name is secret-looking when the plan's pattern matches, when one `_`-separated word of it is a secret word (so TOKENIZERS_PARALLELISM
 * and KEYBOARD_LAYOUT stay), or when its value is a URL with a password in it. Variables that load code into a process (LD_PRELOAD,
 * NODE_OPTIONS, ...) are dropped the same way. The owner's keep list (`envKeep` in the signed app file) overrides both.
 */
export const SECRET_ENV = /(_TOKEN|_SECRET|_KEY)$|PASSWORD|PASSWD|(AUTHTOKEN|_PWD)$|^(GITHUB_TOKEN|GH_TOKEN)$/i;
const SECRET_WORDS = new Set(['TOKEN', 'SECRET', 'SECRETS', 'KEY', 'KEYS', 'APIKEY', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'CREDENTIALS', 'PAT', 'PASS', 'PASSPHRASE', 'AUTH', 'JWT', 'COOKIE']);
/** A URL with user:password@ in it, e.g. DATABASE_URL=postgres://u:p@host/db (the user part may be empty: redis://:pw@host). */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@/i;
/** A connection-string or query-string password: `Server=h;Password=x;`, `?pwd=x`. */
const VALUE_PASSWORD = /(?:^|[;&?\s])(?:password|pwd)\s*=/i;
/** git's config-by-environment set: dropping part of it (a KEY_n without its COUNT) makes every git command fail, so it stays whole. */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i;
/** Never removed, even when a rule matches (a proxy URL may carry a password; the tools need these to run at all). */
const NEVER_STRIP = new Set(['PATH', 'PATHEXT', 'PWD', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSH_AUTH_SOCK']);
/** Inherited variables that make a program load someone's code. An owner who needs one adds it to the keep list. */
const INJECTION = new Set(['LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONPATH', 'BASH_ENV', 'ENV', 'PERL5OPT', 'RUBYOPT', 'PROMPT_COMMAND', 'GIT_SSH_COMMAND', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'PERLLIB', 'PERL5LIB', 'RUBYLIB']);
/** The cloud logins the CLI needs when it talks to Bedrock, Vertex or Foundry. */
const PROVIDER = /^(AWS_|AZURE_|GOOGLE_|ANTHROPIC_|CLOUD_ML_)/i;

export interface ScrubOpts { keep?: readonly string[]; providerAuth?: boolean }

/** Keep entries match a name exactly (any case), or by prefix when they end in `*`. */
const kept = (name: string, keep: readonly string[]): boolean => {
  const n = name.toUpperCase();
  return keep.some((k) => (k.endsWith('*') ? n.startsWith(k.slice(0, -1).toUpperCase()) : n === k.toUpperCase()));
};

const secretLooking = (name: string, value: string | undefined): boolean =>
  SECRET_ENV.test(name) || name.toUpperCase().split('_').some((w) => SECRET_WORDS.has(w)) || (typeof value === 'string' && (URL_WITH_PASSWORD.test(value) || VALUE_PASSWORD.test(value)));
const injectionClass = (name: string): boolean => { const n = name.toUpperCase(); return INJECTION.has(n) || n.startsWith('DYLD_'); };

/** Is this variable held back from the commands an agent runs? The one rule behind both the scrub and the list of names Legion tells the run about. */
function heldBack(k: string, v: string | undefined, o: ScrubOpts): boolean {
  if (NEVER_STRIP.has(k.toUpperCase()) || GIT_CONFIG_ENV.test(k) || kept(k, o.keep ?? [])) return false;
  return injectionClass(k) || (secretLooking(k, v) && !(o.providerAuth && PROVIDER.test(k)));
}

export function scrubSecretEnv(env: Record<string, string | undefined>, o: ScrubOpts = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!heldBack(k, v, o)) out[k] = v;
  return out;
}

/** The NAMES `scrubSecretEnv` would hold back, sorted. Names only: a value never leaves this function. */
export function heldBackNames(env: Record<string, string | undefined>, o: ScrubOpts = {}): string[] {
  return Object.entries(env).filter(([k, v]) => heldBack(k, v, o)).map(([k]) => k).sort((x, y) => x.localeCompare(y));
}
