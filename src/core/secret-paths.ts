/**
 * Which file paths hold secrets (gates PR 2): an agent that reads one of these may not then send anything out without asking.
 * Documented-shape files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) and public keys (`id_rsa.pub`) are left alone.
 * Matches by name or path segment, with either slash, in any case. A path check only: nothing here opens a file.
 */
const NAMES = /(^|[\\/])(\.env(\.(?!(example|sample|template|dist)$)[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)(?!\.pub$)[\w.-]*|credentials|[^\\/]+\.(pem|key|p12|pfx))$/i;
/** Whole directories of credentials, and exact files inside a dot-directory. */
const DIRS = /(^|[\\/])\.(ssh|aws|gnupg)[\\/]|(^|[\\/])\.docker[\\/]config\.json$|(^|[\\/])\.kube[\\/]config$/i;

export const isSecretPath = (p: string): boolean => NAMES.test(p) || DIRS.test(p);
