// Built-in docs hosts: web reads on these hosts are trusted without asking.
// A typed const, not JSON: JSON under src/shared is not copied to dist.
export const DOCS_HOSTS: readonly string[] = [
  'developer.mozilla.org',
  'docs.python.org',
  'docs.github.com',
  'docs.stripe.com',
  'learn.microsoft.com',
  'nodejs.org',
  'react.dev',
];

// The set of trusted docs hosts. Tests pass their own list.
export function loadDocsHosts(list: readonly string[] = DOCS_HOSTS): ReadonlySet<string> {
  return new Set(list.map((h) => h.toLowerCase().replace(/\.$/, '')));
}
